import { invokeLLM } from "./_core/llm";
import type { AdSubmission, Policy } from "../drizzle/schema";
import {
  FCC_FRAMEWORK,
  IAB_FRAMEWORK,
  generateMediumCompliancePrompt,
  getComplianceScoringSchema,
} from "./complianceFrameworks";

// ─── Compliance Score Types ─────────────────────────────────────────────────

export interface ComplianceCategoryScore {
  categoryId: string;
  categoryName: string;
  framework: string;
  score: number | null;
  status: "pass" | "warning" | "fail" | "skipped";
  findings: ComplianceFindingResult[];
  skippedReason?: string;
}

export interface ComplianceFindingResult {
  ruleId: string;
  ruleName: string;
  severity: "info" | "warning" | "critical" | "blocking";
  description: string;
  recommendation: string;
  confidence: number;
}

// ─── New Content Intelligence Types ─────────────────────────────────────────

export interface DetectedAdvertiser {
  name: string;       // empty string if unidentifiable
  confidence: number; // 0-100
  industry: string;   // e.g. "Alcohol & Beverages", empty if unknown
}

export interface DetectedLanguage {
  language: string;   // e.g. "English", "Spanish"
  confidence: number; // 0-100
  script: string;     // e.g. "Latin", "Arabic", "Cyrillic"
}

export interface ObjectionalContentItem {
  type: string;         // e.g. "alcohol", "tobacco", "gambling", "adult_content", "violence"
  description: string;  // specific description of what was found
  severity: "info" | "warning" | "critical" | "blocking";
  confidence: number;   // 0-100
  fccRelevant: boolean; // triggers FCC rules
  iabRelevant: boolean; // triggers IAB brand-safety rules
}

export interface FlaggableContentItem {
  type: string;        // e.g. "suggestive_clothing", "profanity", "firearms", "dangerous_activity"
  description: string; // specific description e.g. "Woman in low-cut top"
  severity: "info" | "warning" | "critical" | "blocking";
  confidence: number;  // 0-100
  timestamp: string;   // video timestamp e.g. "0:15", empty string if N/A
}

export interface RecommendedSegment {
  segment: string;       // e.g. "Adults 21+", "College Students"
  reasoning: string;     // why this segment aligns
  geographies: string[]; // specific countries/regions, empty = global
}

export interface LookalikeAdvertiser {
  name: string;       // e.g. "Miller Lite"
  similarity: string; // why they are similar
  industry: string;
}

export interface BlockedAudience {
  segment: string;    // e.g. "Children under 18", "Muslim-majority countries"
  reason: string;     // e.g. "Alcohol content is religiously prohibited"
  severity: "recommended" | "required" | "legal";
  legalBasis: string; // e.g. "FCC §73.4", "IAB GARM", empty string if none
}

export interface AudienceDemographics {
  recommended: RecommendedSegment[];
  lookalikAdvertisers: LookalikeAdvertiser[];
  blockedAudiences: BlockedAudience[];
}

// ─── Main Analysis Result ────────────────────────────────────────────────────

export interface AiAnalysisResult {
  overallScore: number;       // 0-100, higher = safer
  brandSafetyScore: number;   // 0-100
  contentCategories: string[];
  violations: AiViolation[];
  summary: string;
  recommendation: "auto_approve" | "needs_review" | "auto_reject";
  confidence: number;         // 0-100
  details: {
    textAnalysis?: { sentiment: string; tone: string; flaggedPhrases: string[] };
    visualAnalysis?: { description: string; flaggedElements: string[] };
    complianceCheck?: { frameworks: string[]; issues: string[] };
  };
  // FCC/IAB compliance scoring
  complianceScores?: ComplianceCategoryScore[];
  overallFccScore?: number;
  overallIabScore?: number;
  complianceSummary?: string;
  highestRiskArea?: string;
  requiredActions?: string[];
  // Content intelligence
  detectedAdvertiser?: DetectedAdvertiser;
  detectedLanguages?: DetectedLanguage[];
  isPoliticalAd?: boolean;
  politicalDetails?: {
    party: string;
    candidate: string;
    issue: string;
    jurisdiction: string;
  };
  objectionalContent?: ObjectionalContentItem[];
  flaggableContent?: FlaggableContentItem[];
  audienceDemographics?: AudienceDemographics;
}

export interface AiViolation {
  policyArea: string;
  severity: "info" | "warning" | "critical" | "blocking";
  description: string;
  confidence: number;
}

// ─── Compliance Score Reconciliation ─────────────────────────────────────────
// Post-processing step: ensures the score and status for every compliance
// category are derived from its actual findings. The LLM sometimes returns
// scores/statuses that are inconsistent with the findings array (e.g. a
// Warning score with zero findings). This function is the authoritative
// source of truth — findings drive score, never the other way around.

// Phrases that indicate a finding describes the *absence* of an issue.
// The LLM sometimes generates "No X found" entries in the findings array
// even for fully-compliant categories — these should not penalise the score.
const PHANTOM_FINDING_PATTERNS = [
  /no\s+issues?\s+found/i,
  /no\s+violations?\s+found/i,
  /no\s+concerns?\s+found/i,
  /not\s+found/i,
  /none\s+found/i,
  /fully\s+compliant/i,
  /no\s+brand\s+safety/i,
  /no\s+problems?\s+detected/i,
  /no\s+issues?\s+detected/i,
  /no\s+violations?\s+detected/i,
];

function isPhantomFinding(finding: { description: string }): boolean {
  return PHANTOM_FINDING_PATTERNS.some(re => re.test(finding.description));
}

function reconcileComplianceScores<T extends {
  findings: Array<{ severity: "info" | "warning" | "critical" | "blocking"; description: string }>;
  score: number | null;
  status: "pass" | "warning" | "fail" | "skipped";
}>(scores: T[]): T[] {
  return scores.map(cat => {
    const allFindings = cat.findings || [];

    // Strip phantom findings (LLM-generated "no issues found" entries)
    const realFindings = allFindings.filter(f => !isPhantomFinding(f));

    if (realFindings.length === 0) {
      // Zero real findings → definitively compliant
      return { ...cat, score: 100, status: "pass" as const };
    }

    const has = (sev: string) => realFindings.some(f => f.severity === sev);
    const count = realFindings.length;

    let score: number | null;
    let status: "pass" | "warning" | "fail" | "skipped";

    if (has("blocking")) {
      status = "fail";
      score = 0;
    } else if (has("critical")) {
      status = "fail";
      // Cap at 49; additional findings push lower
      score = Math.max(10, 49 - (count - 1) * 8);
    } else if (has("warning")) {
      status = "warning";
      // Cap at 79; additional findings push lower
      score = Math.max(50, 79 - (count - 1) * 8);
    } else {
      // info findings only — cap at 90, still passes
      status = "pass";
      score = Math.max(82, 90 - (count - 1) * 3);
    }

    return { ...cat, score, status };
  });
}

// ─── Image Fetch Utility ─────────────────────────────────────────────────────

/**
 * Fetch an image from a URL and return it as a base64 data URL.
 * This lets us pass images to OpenAI without OpenAI needing to make outbound
 * HTTP requests to private R2/S3 buckets (which would 403).
 *
 * Returns null on any failure — callers should fall back to text-only analysis.
 */
async function fetchToBase64(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url; // already a data URL
  try {
    console.log(`[AiModeration] Fetching image for base64 encoding: ${url.slice(0, 100)}...`);
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[AiModeration] Image fetch failed: HTTP ${response.status} ${response.statusText} — ${url.slice(0, 100)}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      console.warn(`[AiModeration] Image fetch returned empty body — ${url.slice(0, 100)}`);
      return null;
    }
    // Derive mime type from URL path (before any query string)
    const path = url.split("?")[0].toLowerCase();
    const mimeType = path.endsWith(".png") ? "image/png"
      : path.endsWith(".webp") ? "image/webp"
      : path.endsWith(".gif") ? "image/gif"
      : "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    console.log(`[AiModeration] Image encoded: ${(buffer.length / 1024).toFixed(0)}KB → base64 (${mimeType})`);
    return dataUrl;
  } catch (err) {
    console.warn(`[AiModeration] Image fetch threw:`, err);
    return null;
  }
}

// ─── Analysis Function ───────────────────────────────────────────────────────

export interface AnalyzeAdContext {
  /** Full transcript from Whisper — used as primary signal for language/content */
  transcript?: string | null;
  /** Advertiser name resolved from DB or prior creative analysis */
  detectedAdvertiserName?: string | null;
  /** Advertiser industry resolved from DB or prior creative analysis */
  detectedAdvertiserIndustry?: string | null;
  /** Language code detected by Whisper (e.g. "en") */
  whisperLanguage?: string | null;
}

export async function analyzeAdContent(
  ad: Pick<AdSubmission, "title" | "description" | "format" | "fileUrl" | "targetAudience" | "metadata"> & {
    sourceType?: string | null;
    sourceUrl?: string | null;
    videoProvider?: string | null;
    videoId?: string | null;
    embedUrl?: string | null;
    thumbnailUrl?: string | null;
    videoDuration?: string | null;
    videoAuthor?: string | null;
  },
  activePolicies: Pick<Policy, "name" | "category" | "rules" | "severity">[],
  context?: AnalyzeAdContext,
): Promise<AiAnalysisResult> {
  const policyContext = activePolicies.map(p =>
    `- ${p.name} (${p.category}, severity: ${p.severity}): ${JSON.stringify(p.rules)}`
  ).join("\n");

  const compliancePrompt = generateMediumCompliancePrompt([FCC_FRAMEWORK, IAB_FRAMEWORK]);
  const complianceSchema = getComplianceScoringSchema();

  const messages: Parameters<typeof invokeLLM>[0]["messages"] = [
    {
      role: "system",
      content: `You are an expert ad moderation AI agent for a media company. Your job is to analyze advertising content for policy compliance, brand safety, content standards, and audience suitability.

You MUST evaluate the ad against TWO regulatory bodies:

1. FCC BROADCAST ADVERTISING RULES — Federal Communications Commission regulations governing what can air on broadcast TV and radio. Legally binding with enforcement penalties.
2. IAB ADVERTISING STANDARDS — Interactive Advertising Bureau guidelines for brand safety (GARM framework), creative quality (LEAN principles), truthfulness, privacy, accessibility, and sector-specific rules.

${compliancePrompt}

Additionally, evaluate against these custom active policies:
${policyContext || "No additional custom policies configured."}

Your analysis must produce ALL of the following:

A. GENERAL MODERATION: overall score, brand safety score, violations, summary, recommendation.

B. FCC/IAB COMPLIANCE: per-category scores for every FCC and IAB category (0-100, pass/warning/fail, findings with rule IDs and recommendations).

C. ADVERTISER IDENTIFICATION:
   - Identify the brand or company from logos, slogans, voice-overs, visual identity, and context.
   - Identify the industry (e.g. "Alcohol & Beverages", "Automotive", "Pharmaceuticals", "Finance").
   - Return empty string for name/industry if not identifiable.

D. LANGUAGE DETECTION:
   - List every language spoken or written in the ad (spoken dialogue, on-screen text, voice-over).
   - Include script type (Latin, Cyrillic, Arabic, Devanagari, etc.).
   - Always include at least one entry; default to English if nothing else is detectable.

E. POLITICAL AD DETECTION:
   - Determine if this is a political ad (promotes a candidate, party, policy position, ballot measure, or issue campaign).
   - If political, identify party, candidate name, issue, and jurisdiction (e.g. "US Federal", "UK National", "California State") where detectable. Use empty string for unknown fields.

F. OBJECTIONABLE CONTENT FLAGS:
   - Identify ALL regulated or sensitive categories present: alcohol, tobacco/vaping, gambling, adult/sexual content, violence, weapons/firearms, illegal drugs, prescription medications.
   - Mark whether each item is FCC-relevant and/or IAB-relevant.

G. FLAGGABLE CONTENT (specific items requiring human review):
   - Identify specific flaggable visual or audio elements: suggestive clothing (e.g. low-cut top, revealing swimwear), implied nudity, profanity/swear words, slurs, hate speech, dangerous activities, graphic violence, gross content, discriminatory imagery.
   - For video content, include approximate timestamp where possible.
   - Only list items actually present — do not invent flags.

H. AUDIENCE TARGETING INTELLIGENCE:
   - RECOMMENDED SEGMENTS: Which specific demographic and psychographic segments best align with this ad's content, messaging, and product? Include relevant geographies where applicable.
   - LOOKALIKE ADVERTISERS: Name 2-5 real, well-known brands that are similar to the advertiser detected (same industry, comparable positioning, similar audience). If advertiser is unknown, suggest based on product/service type.
   - BLOCKED AUDIENCES: Audiences that must NEVER or should NOT see this ad, with reasons and legal/regulatory basis:
     * Alcohol ads: MUST block underage audiences (<21 in USA, <18 in most countries); MUST block Muslim-majority markets (Saudi Arabia, Iran, Pakistan, Indonesia, etc.) where consumption is religiously prohibited or legally banned; SHOULD block regions with strict advertising restrictions (e.g. Norway, France).
     * Gambling ads: MUST block minors; MUST block jurisdictions where gambling is illegal; SHOULD block problem-gambling vulnerable audiences.
     * Tobacco/vaping: MUST block minors; MUST block many international markets with blanket bans.
     * Pharmaceutical/DTC drugs: MUST flag as restricted in most markets outside USA/NZ; SHOULD require age/condition gating.
     * Political ads: flag jurisdiction-specific restrictions on ad timing or placement.
     * Adult/sexual content: MUST block minors; restrict to appropriate platforms only.
     * Violence: restrict based on severity.

Be thorough. Err on the side of flagging potential issues — false positives are preferable to missed violations.

CRITICAL SCORING RULES — YOU MUST FOLLOW THESE WITHOUT EXCEPTION:
1. The score for each compliance category MUST be derived from and consistent with the findings you list for that category. Never return a low score with no supporting findings.
2. If you list no findings for a category, OR if your only findings say something like "no issues found" or "no violations detected", the score MUST be 80 or above and the status MUST be "pass".
3. Do NOT add placeholder findings such as "No brand safety floor issues found" or "No violations detected" — if there are no issues, leave the findings array empty.
4. Scores and findings are validated post-response. Any category with an empty findings array will be forced to score=100/status=pass regardless of what you output. Any category with only "info" findings will be capped at score=90. Contradictions between your score and your findings will always be resolved in favour of the findings.`
    },
    {
      role: "user",
      content: `Analyze this ad submission:

Title: ${ad.title}
Format: ${ad.format}
Description: ${ad.description || "N/A"}
Target Audience: ${ad.targetAudience || "General"}
${ad.sourceType && ad.sourceType !== "upload" ? `Source: ${ad.sourceType} video` : ""}
${ad.sourceUrl ? `Source URL: ${ad.sourceUrl}` : ""}
${ad.videoProvider ? `Video Provider: ${ad.videoProvider}` : ""}
${ad.videoAuthor ? `Video Author: ${ad.videoAuthor}` : ""}
${ad.videoDuration ? `Duration: ${ad.videoDuration}` : ""}
${ad.fileUrl ? `File URL: ${ad.fileUrl}` : ""}
${ad.metadata ? `Metadata: ${JSON.stringify(ad.metadata)}` : ""}
${context?.detectedAdvertiserName ? `\nKnown Advertiser: ${context.detectedAdvertiserName}${context.detectedAdvertiserIndustry ? ` — Industry: ${context.detectedAdvertiserIndustry}` : ""}` : ""}
${context?.whisperLanguage ? `Detected Language (Whisper ASR): ${context.whisperLanguage}` : ""}
${context?.transcript ? `\nAudio Transcript (Whisper ASR — use as primary signal for spoken content, disclaimers, and claims):\n${context.transcript.slice(0, 3000)}` : ""}

Provide your complete analysis as a JSON object.`
    }
  ];

  // Include visual asset for visual analysis.
  // Images are fetched server-side and converted to base64 data URLs so OpenAI never
  // needs to make outbound requests to our private R2 bucket (which would 403).
  const thumbnailForAnalysis = ad.thumbnailUrl || (ad.fileUrl && (ad.format === "image" || ad.format === "video") ? ad.fileUrl : null);
  if (thumbnailForAnalysis) {
    const videoContext = ad.sourceType && ad.sourceType !== "upload"
      ? `\nSource: ${ad.sourceType} video\n${ad.sourceUrl ? `Source URL: ${ad.sourceUrl}` : ""}\n${ad.videoAuthor ? `Author: ${ad.videoAuthor}` : ""}\n${ad.videoDuration ? `Duration: ${ad.videoDuration}` : ""}`
      : "";
    const userText = `Analyze this ad submission:

Title: ${ad.title}
Format: ${ad.format}
Description: ${ad.description || "N/A"}
Target Audience: ${ad.targetAudience || "General"}${videoContext}
${ad.metadata ? `Metadata: ${JSON.stringify(ad.metadata)}` : ""}
${context?.detectedAdvertiserName ? `\nKnown Advertiser: ${context.detectedAdvertiserName}${context.detectedAdvertiserIndustry ? ` — Industry: ${context.detectedAdvertiserIndustry}` : ""}` : ""}
${context?.whisperLanguage ? `Detected Language (Whisper ASR): ${context.whisperLanguage}` : ""}
${context?.transcript ? `\nAudio Transcript (Whisper ASR — use as primary signal for spoken content, disclaimers, and claims):\n${context.transcript.slice(0, 3000)}` : ""}

Provide your complete analysis as a JSON object.`;

    const imageDataUrl = await fetchToBase64(thumbnailForAnalysis);
    if (imageDataUrl) {
      messages[1] = {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      };
    } else {
      // Image unavailable — proceed with text-only analysis
      console.warn(`[AiModeration] Proceeding without image for ad "${ad.title}" (thumbnail fetch failed)`);
      messages[1] = { role: "user", content: userText };
    }
  }

  console.log(`[AiModeration] analyzeAdContent called: title="${ad.title}" format=${ad.format} sourceType=${ad.sourceType ?? "upload"} hasFileUrl=${!!ad.fileUrl} hasThumbnail=${!!ad.thumbnailUrl} policies=${activePolicies.length}`);

  // ─── JSON Schema ──────────────────────────────────────────────────────────

  const contentIntelligenceSchema = {
    detectedAdvertiser: {
      type: "object",
      description: "Identified brand/advertiser from the ad content",
      properties: {
        name: { type: "string", description: "Brand name, empty string if unidentifiable" },
        confidence: { type: "integer", description: "0-100 confidence in identification" },
        industry: { type: "string", description: "Industry category e.g. 'Alcohol & Beverages', empty if unknown" }
      },
      required: ["name", "confidence", "industry"],
      additionalProperties: false
    },
    detectedLanguages: {
      type: "array",
      description: "All languages spoken or written in the ad",
      items: {
        type: "object",
        properties: {
          language: { type: "string", description: "Language name e.g. 'English', 'Spanish'" },
          confidence: { type: "integer", description: "0-100 confidence" },
          script: { type: "string", description: "Script type e.g. 'Latin', 'Arabic', 'Cyrillic'" }
        },
        required: ["language", "confidence", "script"],
        additionalProperties: false
      }
    },
    isPoliticalAd: {
      type: "boolean",
      description: "True if this is a political ad (candidate, party, policy, ballot measure)"
    },
    politicalDetails: {
      type: "object",
      description: "Details if this is a political ad; use empty strings for unknown fields",
      properties: {
        party: { type: "string" },
        candidate: { type: "string" },
        issue: { type: "string" },
        jurisdiction: { type: "string" }
      },
      required: ["party", "candidate", "issue", "jurisdiction"],
      additionalProperties: false
    },
    objectionalContent: {
      type: "array",
      description: "Regulated/sensitive content categories detected in the ad",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "e.g. 'alcohol', 'tobacco', 'gambling', 'adult_content', 'violence', 'prescription_drugs'" },
          description: { type: "string", description: "Specific description of what was found" },
          severity: { type: "string", enum: ["info", "warning", "critical", "blocking"] },
          confidence: { type: "integer", description: "0-100" },
          fccRelevant: { type: "boolean" },
          iabRelevant: { type: "boolean" }
        },
        required: ["type", "description", "severity", "confidence", "fccRelevant", "iabRelevant"],
        additionalProperties: false
      }
    },
    flaggableContent: {
      type: "array",
      description: "Specific content items requiring human review",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "e.g. 'suggestive_clothing', 'profanity', 'implied_nudity', 'hate_speech', 'dangerous_activity', 'firearms'" },
          description: { type: "string", description: "Specific description e.g. 'Woman in low-cut top'" },
          severity: { type: "string", enum: ["info", "warning", "critical", "blocking"] },
          confidence: { type: "integer", description: "0-100" },
          timestamp: { type: "string", description: "Video timestamp e.g. '0:15', empty string if N/A" }
        },
        required: ["type", "description", "severity", "confidence", "timestamp"],
        additionalProperties: false
      }
    },
    audienceDemographics: {
      type: "object",
      description: "Audience targeting intelligence",
      properties: {
        recommended: {
          type: "array",
          description: "Demographic and psychographic segments that align with this ad",
          items: {
            type: "object",
            properties: {
              segment: { type: "string", description: "e.g. 'Adults 21+', 'College Students', 'Parents of young children'" },
              reasoning: { type: "string", description: "Why this segment aligns with this ad" },
              geographies: { type: "array", items: { type: "string" }, description: "Relevant countries/regions; empty array = global" }
            },
            required: ["segment", "reasoning", "geographies"],
            additionalProperties: false
          }
        },
        lookalikAdvertisers: {
          type: "array",
          description: "Real, well-known brands similar to the detected advertiser",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Brand name e.g. 'Miller Lite'" },
              similarity: { type: "string", description: "Why this brand is a lookalike" },
              industry: { type: "string" }
            },
            required: ["name", "similarity", "industry"],
            additionalProperties: false
          }
        },
        blockedAudiences: {
          type: "array",
          description: "Audiences that must never or should not see this ad",
          items: {
            type: "object",
            properties: {
              segment: { type: "string", description: "e.g. 'Children under 18', 'Muslim-majority countries (Saudi Arabia, Iran, Indonesia)', 'Problem gambling populations'" },
              reason: { type: "string", description: "Why this audience must not see the ad" },
              severity: { type: "string", enum: ["recommended", "required", "legal"], description: "recommended=best practice, required=policy mandate, legal=law/regulation" },
              legalBasis: { type: "string", description: "Legal/regulatory basis e.g. 'FCC §73.4', 'COPPA', 'EU Directive 2003/33/EC'; empty string if none" }
            },
            required: ["segment", "reason", "severity", "legalBasis"],
            additionalProperties: false
          }
        }
      },
      required: ["recommended", "lookalikAdvertisers", "blockedAudiences"],
      additionalProperties: false
    }
  };

  try {
    const result = await invokeLLM({
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ad_analysis_full",
          strict: true,
          schema: {
            type: "object",
            properties: {
              overallScore: { type: "integer", description: "Overall safety/compliance score 0-100" },
              brandSafetyScore: { type: "integer", description: "Brand safety score 0-100" },
              contentCategories: { type: "array", items: { type: "string" }, description: "IAB content categories detected" },
              violations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    policyArea: { type: "string" },
                    severity: { type: "string", enum: ["info", "warning", "critical", "blocking"] },
                    description: { type: "string" },
                    confidence: { type: "integer" }
                  },
                  required: ["policyArea", "severity", "description", "confidence"],
                  additionalProperties: false
                }
              },
              summary: { type: "string", description: "Brief summary of the overall analysis" },
              recommendation: { type: "string", enum: ["auto_approve", "needs_review", "auto_reject"] },
              confidence: { type: "integer", description: "Overall confidence in the analysis 0-100" },
              textAnalysis: {
                type: "object",
                properties: {
                  sentiment: { type: "string" },
                  tone: { type: "string" },
                  flaggedPhrases: { type: "array", items: { type: "string" } }
                },
                required: ["sentiment", "tone", "flaggedPhrases"],
                additionalProperties: false
              },
              complianceCheck: {
                type: "object",
                properties: {
                  frameworks: { type: "array", items: { type: "string" } },
                  issues: { type: "array", items: { type: "string" } }
                },
                required: ["frameworks", "issues"],
                additionalProperties: false
              },
              // FCC/IAB structured compliance scoring
              ...complianceSchema.properties,
              // Content intelligence
              ...contentIntelligenceSchema,
            },
            required: [
              "overallScore", "brandSafetyScore", "contentCategories", "violations",
              "summary", "recommendation", "confidence", "textAnalysis", "complianceCheck",
              "complianceScores", "overallFccScore", "overallIabScore",
              "complianceSummary", "highestRiskArea", "requiredActions",
              "detectedAdvertiser", "detectedLanguages", "isPoliticalAd", "politicalDetails",
              "objectionalContent", "flaggableContent", "audienceDemographics"
            ],
            additionalProperties: false
          }
        }
      }
    });

    const content = result.choices[0]?.message?.content;
    console.log(`[AiModeration] LLM responded: finish_reason=${result.choices[0]?.finish_reason} content_length=${typeof content === "string" ? content.length : "non-string"}`);
    if (!content || typeof content !== "string") {
      console.error(`[AiModeration] Empty/non-string content from LLM. Full result: ${JSON.stringify(result).slice(0, 1000)}`);
      throw new Error("No content in LLM response");
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      console.error(`[AiModeration] JSON.parse failed. Content (first 500 chars): ${content.slice(0, 500)}`);
      throw parseErr;
    }
    console.log(`[AiModeration] Parsed response: overallScore=${parsed.overallScore} brandSafety=${parsed.brandSafetyScore} recommendation=${parsed.recommendation} complianceScores=${parsed.complianceScores?.length ?? 0}`);

    // Reconcile compliance scores so findings always drive score/status
    const reconciledScores = reconcileComplianceScores(parsed.complianceScores || []) as ComplianceCategoryScore[];
    const fccCategories = reconciledScores.filter((c: any) => c.framework === "FCC");
    const iabCategories = reconciledScores.filter((c: any) => c.framework === "IAB");
    const overallFccScore = fccCategories.length > 0
      ? Math.round(fccCategories.reduce((s: number, c: any) => s + c.score, 0) / fccCategories.length)
      : parsed.overallFccScore;
    const overallIabScore = iabCategories.length > 0
      ? Math.round(iabCategories.reduce((s: number, c: any) => s + c.score, 0) / iabCategories.length)
      : parsed.overallIabScore;

    return {
      overallScore: parsed.overallScore,
      brandSafetyScore: parsed.brandSafetyScore,
      contentCategories: parsed.contentCategories,
      violations: parsed.violations,
      summary: parsed.summary,
      recommendation: parsed.recommendation,
      confidence: parsed.confidence,
      details: {
        textAnalysis: parsed.textAnalysis,
        complianceCheck: parsed.complianceCheck,
      },
      // FCC/IAB compliance (reconciled)
      complianceScores: reconciledScores,
      overallFccScore,
      overallIabScore,
      complianceSummary: parsed.complianceSummary,
      highestRiskArea: parsed.highestRiskArea,
      requiredActions: parsed.requiredActions,
      // Content intelligence
      detectedAdvertiser: parsed.detectedAdvertiser,
      detectedLanguages: parsed.detectedLanguages,
      isPoliticalAd: parsed.isPoliticalAd,
      politicalDetails: parsed.politicalDetails,
      objectionalContent: parsed.objectionalContent,
      flaggableContent: parsed.flaggableContent,
      audienceDemographics: parsed.audienceDemographics,
    };
  } catch (error) {
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("[AiModeration] ❌ analyzeAdContent FAILED");
    console.error("[AiModeration] Error type:", (error as any)?.constructor?.name);
    console.error("[AiModeration] Error message:", (error as Error)?.message);
    if ((error as any)?.stack) console.error("[AiModeration] Stack:", (error as Error).stack);
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    // Re-throw so callers can handle the failure without writing fake scores to the DB.
    throw error;
  }
}

export async function generateModerationSuggestion(
  ad: Pick<AdSubmission, "title" | "description" | "format" | "aiAnalysis">,
  violations: { description: string | null; severity: string }[]
): Promise<string> {
  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are an expert ad moderation assistant. Provide a concise, actionable recommendation for the human moderator reviewing this ad. Be specific about what needs attention and suggest concrete next steps. Reference specific FCC or IAB compliance rules when applicable."
        },
        {
          role: "user",
          content: `Ad: "${ad.title}" (${ad.format})
Description: ${ad.description || "N/A"}
AI Analysis: ${JSON.stringify(ad.aiAnalysis)}
Violations Found: ${violations.map(v => `[${v.severity}] ${v.description}`).join("; ") || "None"}

What should the moderator focus on?`
        }
      ]
    });

    return result.choices[0]?.message?.content as string || "Review the ad content and AI analysis results carefully.";
  } catch {
    return "Review the ad content and AI analysis results carefully.";
  }
}
