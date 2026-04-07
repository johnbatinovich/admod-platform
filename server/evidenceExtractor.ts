/**
 * Evidence Extractor
 *
 * Normalizes raw AI output from any provider (Gemini, OpenAI, Whisper, frame analysis)
 * into a unified, structured evidence format. This is "Phase 1" of the two-phase pipeline:
 *
 *   Phase 1: AI extracts evidence   (what's in the ad)
 *   Phase 2: Rules engine evaluates (given the evidence, which rules apply)
 *
 * Evidence is persisted so the rules engine can re-run on the same evidence
 * without calling any LLM again.
 */

import { nanoid } from "nanoid";
import type { GeminiAnalysisResult } from "./geminiVideoAnalysis";
import type { AiAnalysisResult } from "./aiModeration";
import type { FrameAnalysisResult } from "./frameAnalysis";
import type { WhisperTranscriptResult } from "./whisperTranscription";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type EvidenceType =
  | "detected_text"        // On-screen text, supers, crawls, OCR output
  | "detected_category"    // Content category label (alcohol, tobacco, pharma, etc.)
  | "transcript_segment"   // Timestamped speech from Whisper or AI transcript
  | "scene_description"    // AI description of a visual scene or moment
  | "audio_event"          // Audio event detected (disclaimer, music, EAS tone, etc.)
  | "disclaimer_detected"  // Disclosure or legal disclaimer language identified
  | "brand_detected";      // Brand name or logo detected

export type EvidenceSource = "gemini" | "openai" | "whisper" | "ffprobe" | "manual";

export interface ExtractedEvidence {
  id: string;
  type: EvidenceType;
  /** Normalized content — category name, text snippet, or description */
  content: string;
  /** Seconds into the ad where this evidence appears */
  timestampStart?: number;
  timestampEnd?: number;
  /** Which AI provider produced this evidence */
  source: EvidenceSource;
  /** Provider's confidence in this observation (0–100) */
  confidence: number;
  /** Additional provider-specific fields */
  metadata?: Record<string, unknown>;
}

export interface EvidenceExtractionInput {
  geminiResult?: GeminiAnalysisResult | null;
  aiModerationResult?: AiAnalysisResult | null;
  frameResult?: FrameAnalysisResult | null;
  whisperResult?: WhisperTranscriptResult | null;
}

// ─── Disclaimer detection ─────────────────────────────────────────────────────

const DISCLAIMER_PHRASES = [
  "paid for by",
  "authorized by",
  "sponsored by",
  "this is a paid advertisement",
  "i approve this message",
  "side effects",
  "ask your doctor",
  "talk to your doctor",
  "consult your doctor",
  "important safety information",
  "see full prescribing information",
  "results may vary",
  "individual results may vary",
  "past performance",
  "not a guarantee",
  "drink responsibly",
  "please drink responsibly",
  "enjoy responsibly",
  "must be 21",
  "must be 18",
  "21 and over",
  "18 and over",
  "gamble responsibly",
  "gambling helpline",
  "problem gambling",
  "1-800-gambler",
  "terms and conditions apply",
  "see website for details",
  "not evaluated by the fda",
  "these statements have not been evaluated",
  "not fdic insured",
  "investment risk",
  "you may lose",
  "not financial advice",
];

function isDisclaimerText(text: string): boolean {
  const lower = text.toLowerCase();
  return DISCLAIMER_PHRASES.some(phrase => lower.includes(phrase));
}

// ─── Category normalisation ───────────────────────────────────────────────────

/** Maps keyword patterns to normalised category names consumed by the rules engine */
const CATEGORY_KEYWORD_MAP: [string[], string][] = [
  [["alcohol", "beer", "wine", "spirits", "liquor", "vodka", "whiskey", "bourbon", "rum", "gin", "drinking", "hard seltzer", "cider"], "alcohol"],
  [["tobacco", "cigarette", "cigar", "vaping", "e-cigarette", "nicotine", "vape", "smokeless tobacco"], "tobacco"],
  [["cannabis", "marijuana", "hemp", "cbd", "thc", "weed"], "cannabis"],
  [["gambling", "casino", "betting", "lottery", "sweepstakes", "sports betting", "wager", "poker", "slots", "sportsbook"], "gambling"],
  [["pharma", "pharmaceutical", "prescription", "medication", "drug", "pill", "tablet", "dosage", "treatment", "otc", "clinical"], "pharma"],
  [["supplement", "dietary supplement", "vitamin", "probiotic", "weight loss", "weight-loss"], "supplement"],
  [["financial", "investment", "credit", "loan", "mortgage", "insurance", "securities", "bonds", "annuity", "stock"], "financial"],
  [["cryptocurrency", "crypto", "bitcoin", "nft", "blockchain", "token", "defi", "ethereum", "digital asset"], "financial"],
  [["children", "kids", "minors", "coppa", "child", "toddler", "preschool", "k-12"], "children"],
  [["political", "election", "ballot", "candidate", "campaign", "vote", "congress", "senate", "president", "advocacy", "referendum", "issue ad"], "political"],
  [["firearms", "gun", "weapon", "ammunition", "rifle", "handgun"], "weapons"],
  [["adult", "nudity", "explicit", "sexual", "erotic"], "adult_content"],
];

function normalizeCategory(raw: string): string {
  const lower = raw.toLowerCase();
  for (const [keywords, category] of CATEGORY_KEYWORD_MAP) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return lower.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

// ─── Per-source extractors ─────────────────────────────────────────────────────

function extractFromWhisper(whisper: WhisperTranscriptResult): ExtractedEvidence[] {
  const result: ExtractedEvidence[] = [];

  for (const seg of whisper.segments) {
    const text = seg.text.trim();
    if (!text) continue;

    const type: EvidenceType = isDisclaimerText(text) ? "disclaimer_detected" : "transcript_segment";
    result.push({
      id: nanoid(),
      type,
      content: text,
      timestampStart: seg.start,
      timestampEnd: seg.end,
      source: "whisper",
      confidence: 95,
      metadata: { language: whisper.language },
    });
  }

  return result;
}

/** Gemini finding ruleId → normalised category (only the rules that map to known categories) */
const GEMINI_RULE_TO_CATEGORY: Record<string, string> = {
  "fcc-ps-001": "alcohol",
  "fcc-ps-002": "pharma",
  "fcc-ps-003": "financial",
  "fcc-pp-002": "tobacco",
  "fcc-pp-003": "gambling",
  "fcc-ch-001": "children",
  "fcc-ch-002": "children",
  "fcc-ch-003": "children",
  "fcc-dt-004": "political",
  "fcc-cs-003": "profanity",
  "fcc-cs-001": "obscenity",
  "fcc-cs-002": "indecency",
  "iab-ss-002": "financial",
  "iab-ss-003": "gambling",
  "iab-ss-001": "supplement",
  "iab-ss-004": "cannabis",
};

function extractFromGemini(gemini: GeminiAnalysisResult): ExtractedEvidence[] {
  const result: ExtractedEvidence[] = [];

  for (const finding of gemini.findings) {
    const mappedCategory = GEMINI_RULE_TO_CATEGORY[finding.ruleId];
    if (mappedCategory) {
      result.push({
        id: nanoid(),
        type: "detected_category",
        content: mappedCategory,
        timestampStart: finding.timestampSeconds ?? undefined,
        source: "gemini",
        confidence: finding.confidence,
        metadata: {
          ruleId: finding.ruleId,
          ruleName: finding.ruleName,
          severity: finding.severity,
          description: finding.description,
        },
      });
    } else {
      // General finding — classify as audio event or scene description
      const descLower = finding.description.toLowerCase();
      const isAudio =
        finding.ruleId.startsWith("fcc-dt") ||
        descLower.includes("audio") ||
        descLower.includes("spoken") ||
        descLower.includes("voice") ||
        descLower.includes("loudness") ||
        descLower.includes("disclaimer");
      result.push({
        id: nanoid(),
        type: isAudio ? "audio_event" : "scene_description",
        content: finding.description,
        timestampStart: finding.timestampSeconds ?? undefined,
        source: "gemini",
        confidence: finding.confidence,
        metadata: {
          ruleId: finding.ruleId,
          ruleName: finding.ruleName,
          severity: finding.severity,
        },
      });
    }
  }

  for (const av of gemini.audioViolations ?? []) {
    result.push({
      id: nanoid(),
      type: "audio_event",
      content: av,
      source: "gemini",
      confidence: 80,
      metadata: { violationType: "audio_violation" },
    });
  }

  if (gemini.complianceSummary) {
    result.push({
      id: nanoid(),
      type: "scene_description",
      content: gemini.complianceSummary,
      source: "gemini",
      confidence: 90,
      metadata: { sourceField: "complianceSummary" },
    });
  }

  return result;
}

function extractFromAiModeration(ai: AiAnalysisResult): ExtractedEvidence[] {
  const result: ExtractedEvidence[] = [];

  for (const cat of ai.contentCategories ?? []) {
    result.push({
      id: nanoid(),
      type: "detected_category",
      content: normalizeCategory(cat),
      source: "openai",
      confidence: 80,
      metadata: { rawCategory: cat },
    });
  }

  for (const v of ai.violations ?? []) {
    if (v.policyArea) {
      result.push({
        id: nanoid(),
        type: "detected_category",
        content: normalizeCategory(v.policyArea),
        source: "openai",
        confidence: v.confidence ?? 70,
        metadata: {
          policyArea: v.policyArea,
          severity: v.severity,
          description: v.description,
        },
      });
    }
  }

  for (const item of [...(ai.flaggableContent ?? []), ...(ai.objectionalContent ?? [])]) {
    const rawType = typeof item === "string" ? item : (item as any).type ?? "";
    const rawDesc = typeof item === "string" ? item : (item as any).description ?? "";
    result.push({
      id: nanoid(),
      type: "detected_category",
      content: normalizeCategory(rawType || rawDesc),
      source: "openai",
      confidence: 75,
      metadata: { rawContent: rawType, description: rawDesc },
    });
  }

  return result;
}

function extractFromFrames(frames: FrameAnalysisResult): ExtractedEvidence[] {
  const result: ExtractedEvidence[] = [];

  for (const frame of frames.frames) {
    for (const issue of frame.issues) {
      if (issue.policyArea) {
        result.push({
          id: nanoid(),
          type: "detected_category",
          content: normalizeCategory(issue.policyArea),
          timestampStart: frame.timestampSeconds ?? undefined,
          source: "openai",
          confidence: issue.confidence ?? 70,
          metadata: {
            policyArea: issue.policyArea,
            severity: issue.severity,
            description: issue.description,
            frameIndex: frame.frameIndex,
          },
        });
      }
      if (issue.description) {
        result.push({
          id: nanoid(),
          type: "scene_description",
          content: issue.description,
          timestampStart: frame.timestampSeconds ?? undefined,
          source: "openai",
          confidence: issue.confidence ?? 70,
          metadata: { category: issue.category, severity: issue.severity },
        });
      }
    }
  }

  return result;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Normalises raw output from all AI providers into a deduplicated evidence array.
 * detected_category evidence is merged by category name — the highest-confidence
 * observation for each category wins.
 */
export function extractEvidence(input: EvidenceExtractionInput): ExtractedEvidence[] {
  const all: ExtractedEvidence[] = [];

  if (input.whisperResult) all.push(...extractFromWhisper(input.whisperResult));
  if (input.aiModerationResult) all.push(...extractFromAiModeration(input.aiModerationResult));
  if (input.geminiResult) all.push(...extractFromGemini(input.geminiResult));
  if (input.frameResult) all.push(...extractFromFrames(input.frameResult));

  // Deduplicate detected_category — one entry per category, highest confidence wins
  const categoryMap = new Map<string, ExtractedEvidence>();
  const other: ExtractedEvidence[] = [];

  for (const ev of all) {
    if (ev.type !== "detected_category") {
      other.push(ev);
      continue;
    }
    const existing = categoryMap.get(ev.content);
    if (!existing || ev.confidence > existing.confidence) {
      categoryMap.set(ev.content, ev);
    }
  }

  return [...Array.from(categoryMap.values()), ...other];
}
