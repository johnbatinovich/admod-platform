import {
  analyzeAdContent,
  generateModerationSuggestion,
  type AiAnalysisResult,
  type ComplianceCategoryScore,
} from "./aiModeration";
import { runFrameAnalysis, type FrameFinding, type FrameAnalysisResult } from "./frameAnalysis";
import { FCC_FRAMEWORK, IAB_FRAMEWORK } from "./complianceFrameworks";
import { extractEvidence, type ExtractedEvidence } from "./evidenceExtractor";
import { evaluateRules, summarizeFindings, type RuleFinding } from "./rulesEngine";
import { transcribeVideoAudio, type WhisperTranscriptResult } from "./whisperTranscription";
import { getAdvertiserById } from "./db";
import { ENV } from "./_core/env";
import type { Policy, AdSubmission } from "../drizzle/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentRoutingDecision = "auto_approve" | "auto_reject" | "needs_review";

export interface RoutingResult {
  decision: AgentRoutingDecision;
  reason: string;
  confidence: number;
  stagesCompleted: number[];
  skippedDeepAnalysis: boolean;
}

export interface UnifiedReviewResult extends AiAnalysisResult {
  // Frame analysis data (from Stage 1)
  frameFindings: FrameFinding[];
  totalFramesAnalyzed: number;
  analysisIntervalSeconds: number;
  overallVideoScore: number;
  flaggedFrameCount: number;
  frameSummary: string;
  worstTimestamp: string | null;
  worstIssue: string | null;
  // Auto-generated moderator guidance (from Stage 3)
  moderatorBrief: string;
  // Pipeline metadata
  deepAnalysisTriggered: boolean;
  // Single synthesised score — null when Stage 2 was skipped (not fabricated)
  clearanceScore: number | null;
  // Agentic routing decision (from Stage 3)
  routingDecision: AgentRoutingDecision;
  routingReason: string;
  routingConfidence: number;
  stagesCompleted: number[];
  skippedDeepAnalysis: boolean;
  // Phase 2: deterministic policy evaluation
  evidence: ExtractedEvidence[];
  policyFindings: RuleFinding[];
  // Whisper audio transcript (null when Whisper didn't run or failed)
  whisperTranscript: WhisperTranscriptResult | null;
}

export type ReviewStage =
  | "stage1_running"
  | "stage2_running"
  | "stage3_running";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REGULATED_CATEGORIES = [
  // Substance / age-gated
  "alcohol", "beer", "wine", "spirits", "liquor",
  "tobacco", "cigarette", "vaping", "e-cigarette", "vape",
  "cannabis", "marijuana", "hemp", "cbd",
  // Wagering
  "gambling", "casino", "betting", "lottery", "sweepstakes", "sports betting",
  // Healthcare / pharma
  "pharma", "pharmaceutical", "prescription", "drug", "medication", "otc",
  "supplement", "dietary supplement", "clinical trial",
  // Weapons
  "firearms", "weapons", "gun", "ammunition", "knife",
  // Adult / sensitive content
  "adult", "nudity", "explicit", "sexual",
  // Political / advocacy
  "political", "election", "ballot", "candidate", "campaign", "advocacy",
  "issue advocacy", "psa",
  // Financial / regulated services
  "financial", "investment", "credit", "loan", "mortgage", "insurance",
  // Children
  "children", "kids", "minors", "coppa",
];

// ─── Agentic Routing ──────────────────────────────────────────────────────────

/**
 * Determines the ad's fate based on BOTH recommendation AND confidence score.
 * Overrides the raw AI recommendation when confidence is too low or high enough
 * to act autonomously.
 */
function computeRoutingDecision(
  baseResult: AiAnalysisResult,
  deepTriggered: boolean,
  stagesRun: number[],
): RoutingResult {
  const conf = baseResult.confidence ?? 0;
  const hasBlocking = baseResult.violations.some(v => v.severity === "blocking");
  const hasCritical = baseResult.violations.some(
    v => v.severity === "critical" || v.severity === "blocking",
  );

  // Low-confidence: force human review regardless of raw recommendation
  if (conf < 60) {
    return {
      decision: "needs_review",
      reason: `Low AI confidence (${conf}%) — forcing full human review chain regardless of recommendation.`,
      confidence: conf,
      stagesCompleted: stagesRun,
      skippedDeepAnalysis: !deepTriggered,
    };
  }

  // High-confidence auto-approve: REQUIRES Stage 2 deep analysis to have run.
  // A quick visual scan alone is never sufficient — regulated content (pharma, alcohol,
  // firearms, etc.) could have been missed. Without Stage 2, the max decision is needs_review.
  if (conf >= 85 && baseResult.recommendation === "auto_approve" && !hasCritical) {
    if (!deepTriggered) {
      return {
        decision: "needs_review",
        reason: "Quick scan passed but deep compliance analysis was not performed. Auto-approval requires Stage 2 — routing to human review.",
        confidence: conf,
        stagesCompleted: stagesRun,
        skippedDeepAnalysis: true,
      };
    }
    return {
      decision: "auto_approve",
      reason: `High confidence (${conf}%) with clean content, no critical findings, and full FCC/IAB compliance analysis completed — auto-approved.`,
      confidence: conf,
      stagesCompleted: stagesRun,
      skippedDeepAnalysis: false,
    };
  }

  // High-confidence auto-reject: blocking violations confirmed with high certainty
  if (conf >= 90 && baseResult.recommendation === "auto_reject" && hasBlocking) {
    return {
      decision: "auto_reject",
      reason: `High confidence (${conf}%) with confirmed blocking violations — auto-rejected without human review.`,
      confidence: conf,
      stagesCompleted: stagesRun,
      skippedDeepAnalysis: !deepTriggered,
    };
  }

  // Default: route to human review chain
  const reasons: string[] = [];
  if (conf < 85) reasons.push(`confidence below auto-approve threshold (${conf}%)`);
  if (baseResult.recommendation === "needs_review") reasons.push("AI flagged for human review");
  if (hasCritical && baseResult.recommendation !== "auto_reject") {
    reasons.push("critical or blocking findings require human sign-off");
  }

  return {
    decision: "needs_review",
    reason: `Routed to approval chain: ${reasons.join("; ")}.`,
    confidence: conf,
    stagesCompleted: stagesRun,
    skippedDeepAnalysis: !deepTriggered,
  };
}

function requiresDeepAnalysis(stage1: FrameAnalysisResult): boolean {
  if (stage1.overallVideoScore < 80) return true;
  // Any critical/blocking issue forces deep analysis
  for (const frame of stage1.frames) {
    for (const issue of frame.issues) {
      if (issue.severity === "critical" || issue.severity === "blocking") return true;
      const text = `${issue.category} ${issue.policyArea} ${issue.description ?? ""}`.toLowerCase();
      if (REGULATED_CATEGORIES.some(cat => text.includes(cat))) return true;
    }
  }
  return false;
}

function isRegulatedContent(ad: { title: string; description?: string | null; targetAudience?: string | null }): boolean {
  const text = `${ad.title} ${ad.description ?? ""} ${ad.targetAudience ?? ""}`.toLowerCase();
  return REGULATED_CATEGORIES.some(cat => text.includes(cat));
}

/**
 * Returns skipped compliance scores for all FCC/IAB categories.
 * Used when Stage 2 deep analysis is skipped (quick scan passed, no regulated content).
 * score: null makes it clear these were NOT evaluated — they are not 100/100 passes.
 */
function buildSkippedComplianceScores(): ComplianceCategoryScore[] {
  const SKIP_REASON = "Quick scan passed with no flagged content — full compliance analysis not triggered";
  return [
    ...FCC_FRAMEWORK.categories.map(cat => ({
      categoryId: cat.id, categoryName: cat.name, framework: "FCC",
      score: null, status: "skipped" as const, findings: [], skippedReason: SKIP_REASON,
    })),
    ...IAB_FRAMEWORK.categories.map(cat => ({
      categoryId: cat.id, categoryName: cat.name, framework: "IAB",
      score: null, status: "skipped" as const, findings: [], skippedReason: SKIP_REASON,
    })),
  ];
}

/**
 * Single synthesised clearance score — the one number shown to reviewers.
 * Returns null when Stage 2 deep analysis was skipped — fabricating a passing
 * number from a quick scan alone would be dishonest and create compliance liability.
 *
 * Formula (only when stage2Completed === true):
 *  1. Start with min(overallScore, overallVideoScore) — most conservative of the two.
 *  2. If any compliance category failed, cap at 49 (amber/red boundary).
 *  3. If any compliance category warned and score is above 79, cap at 79.
 */
function computeClearanceScore(
  overallScore: number,
  overallVideoScore: number | null,
  complianceScores: ComplianceCategoryScore[] | undefined,
  stage2Completed: boolean,
): number | null {
  if (!stage2Completed) return null;
  let score = Math.min(overallScore, overallVideoScore ?? overallScore);
  if (complianceScores) {
    if (complianceScores.some(c => c.status === "fail")) {
      score = Math.min(score, 49);
    } else if (complianceScores.some(c => c.status === "warning") && score > 79) {
      score = 79;
    }
  }
  return Math.round(score);
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

/**
 * Three-stage unified AI review pipeline.
 *
 * Stage 1 — Quick Scan (always runs):
 *   Frame extraction + lightweight vision analysis using sparse keyframes,
 *   detail:low, and compact compliance prompt. Identifies obvious flags and
 *   regulated content.
 *
 * Stage 2 — Deep Analysis (conditional):
 *   Full FCC/IAB compliance scoring via analyzeAdContent. Skipped when
 *   Stage 1 is fully clean and no regulated categories are detected.
 *   Runs in PARALLEL with Stage 1 when regulated content is detected from
 *   ad metadata — saves 30-60s for pharma/alcohol/political ads.
 *
 * Stage 3 — Decision & Report (always runs):
 *   Synthesises findings, generates the moderator brief, produces final result.
 *   Moderator brief and deterministic evidence/routing run in parallel.
 */
export async function runUnifiedAiReview(
  ad: AdSubmission,
  policies: Policy[],
  onStageChange: (stage: ReviewStage) => Promise<void>,
): Promise<UnifiedReviewResult> {
  const pipelineStart = Date.now();
  const isVisual =
    ad.format === "video" ||
    ad.format === "image" ||
    ["youtube", "vimeo", "direct_url"].includes(ad.sourceType ?? "");

  const stagesRun: number[] = [];

  // ── Pre-flight: resolve advertiser context and regulated status ──────────
  // These checks are synchronous or fast DB queries that don't require video download.
  // Results are passed to Stage 2 so it has richer context for compliance analysis.
  const regulatedByContent = isRegulatedContent(ad);

  let advertiserName: string | null = null;
  let advertiserIndustry: string | null = null;
  if (ad.advertiserId) {
    const advertiser = await getAdvertiserById(ad.advertiserId);
    if (advertiser) {
      advertiserName = advertiser.name;
      advertiserIndustry = advertiser.industry ?? null;
    }
  }
  // Fall back to advertiser detected during upload-time creative analysis
  const existingAnalysis = ad.aiAnalysis as Record<string, any> | null;
  if (!advertiserName && existingAnalysis?.detectedAdvertiser?.name) {
    advertiserName = existingAnalysis.detectedAdvertiser.name;
    advertiserIndustry = existingAnalysis.detectedAdvertiser.industry ?? null;
  }
  if (advertiserName) {
    console.log(`[UnifiedReview] Advertiser context: "${advertiserName}" (${advertiserIndustry ?? "industry unknown"})`);
  }

  // Whisper is available for video uploads only (not YouTube/Vimeo — no local file)
  const canRunWhisper = !!(ad.fileKey && ENV.openaiApiKey &&
    (ad.format === "video" || ad.sourceType === "upload"));

  let stage1Result: FrameAnalysisResult | null = null;
  let whisperResult: WhisperTranscriptResult | null = null;
  let aiResult: AiAnalysisResult | null = null;
  let runDeep = false;

  const adInput = {
    adId: ad.id,
    title: ad.title,
    description: ad.description,
    format: ad.format,
    fileUrl: ad.fileUrl,
    fileKey: ad.fileKey,
    sourceType: ad.sourceType,
    sourceUrl: ad.sourceUrl,
    videoProvider: ad.videoProvider,
    videoId: ad.videoId,
    thumbnailUrl: ad.thumbnailUrl,
    videoDuration: ad.videoDuration,
    targetAudience: ad.targetAudience,
  };

  // Helper — Whisper transcription (non-fatal: failure just means no transcript)
  const runWhisper = async (): Promise<WhisperTranscriptResult | null> => {
    if (!canRunWhisper) return null;
    try {
      console.log(`[UnifiedReview] Whisper starting in parallel — key=${ad.fileKey}`);
      const result = await transcribeVideoAudio({ fileKey: ad.fileKey!, adTitle: ad.title });
      console.log(`[UnifiedReview] Whisper complete in ${Date.now() - pipelineStart}ms — lang=${result.language} duration=${result.durationSeconds.toFixed(1)}s`);
      return result;
    } catch (err) {
      console.warn(`[UnifiedReview] Whisper failed (non-fatal — proceeding without transcript):`, (err as Error).message);
      return null;
    }
  };

  await onStageChange("stage1_running");
  stagesRun.push(1);

  if (regulatedByContent && isVisual) {
    // ── PARALLEL PATH: regulated visual content ──────────────────────────────
    // Stage 2 WILL run regardless — regulated content always needs deep compliance.
    // Run Stage 1 + Whisper in parallel so Stage 2 gets the transcript.
    console.log(
      `[UnifiedReview] Regulated content detected — ` +
      `running Stage 1 + Whisper in parallel for "${ad.title}"`,
    );
    runDeep = true;

    const [stage1Done, whisperDone] = await Promise.all([
      runFrameAnalysis(adInput, policies),
      runWhisper(),
    ]);

    stage1Result = stage1Done;
    whisperResult = whisperDone;
    console.log(
      `[UnifiedReview] Stage 1 + Whisper complete in ${Date.now() - pipelineStart}ms: ` +
      `score=${stage1Result.overallVideoScore} flagged=${stage1Result.flaggedFrameCount} ` +
      `transcript=${whisperResult ? `${whisperResult.segments.length} segments` : "none"}`,
    );

    // Stage 2 runs with the transcript and advertiser context
    await onStageChange("stage2_running");
    stagesRun.push(2);
    console.log(`[UnifiedReview] Stage 2 starting — regulated content deep compliance analysis`);
    aiResult = await analyzeAdContent(ad, policies, {
      transcript: whisperResult?.fullText ?? null,
      detectedAdvertiserName: advertiserName,
      detectedAdvertiserIndustry: advertiserIndustry,
      whisperLanguage: whisperResult?.language ?? null,
    });
    console.log(
      `[UnifiedReview] Stage 2 complete in ${Date.now() - pipelineStart}ms: ` +
      `score=${aiResult.overallScore} recommendation=${aiResult.recommendation}`,
    );

  } else {
    // ── SEQUENTIAL PATH: non-regulated or non-visual content ─────────────────
    // Run Stage 1 + Whisper in parallel; Stage 2 fires afterwards only if needed.
    console.log(`[UnifiedReview] Stage 1 starting for ad ${ad.id} (${ad.title})`);

    if (isVisual) {
      const [stage1Done, whisperDone] = await Promise.all([
        runFrameAnalysis(adInput, policies),
        runWhisper(),
      ]);
      stage1Result = stage1Done;
      whisperResult = whisperDone;
      console.log(
        `[UnifiedReview] Stage 1 + Whisper complete in ${Date.now() - pipelineStart}ms: ` +
        `score=${stage1Result.overallVideoScore} flagged=${stage1Result.flaggedFrameCount} ` +
        `transcript=${whisperResult ? `${whisperResult.segments.length} segments` : "none"}`,
      );
    } else {
      console.log(`[UnifiedReview] Stage 1 skipped — non-visual content (format=${ad.format})`);
    }

    // Non-visual content and content with Stage 1 issues both trigger Stage 2.
    runDeep = !stage1Result || requiresDeepAnalysis(stage1Result);

    if (runDeep) {
      await onStageChange("stage2_running");
      stagesRun.push(2);
      console.log(
        `[UnifiedReview] Stage 2 starting — ` +
        (stage1Result
          ? `triggered by Stage 1: score=${stage1Result.overallVideoScore} flagged=${stage1Result.flaggedFrameCount}`
          : "non-visual content always gets deep analysis"),
      );
      aiResult = await analyzeAdContent(ad, policies, {
        transcript: whisperResult?.fullText ?? null,
        detectedAdvertiserName: advertiserName,
        detectedAdvertiserIndustry: advertiserIndustry,
        whisperLanguage: whisperResult?.language ?? null,
      });
      console.log(
        `[UnifiedReview] Stage 2 complete in ${Date.now() - pipelineStart}ms: ` +
        `score=${aiResult.overallScore} recommendation=${aiResult.recommendation}`,
      );
    } else {
      console.log(
        `[UnifiedReview] Stage 2 skipped — Stage 1 clean ` +
        `(score=${stage1Result!.overallVideoScore}, no regulated content)`,
      );
    }
  }

  // ─── Stage 3: Decision & Report ─────────────────────────────────────────
  await onStageChange("stage3_running");
  stagesRun.push(3);
  console.log(`[UnifiedReview] Stage 3 starting — synthesising results`);

  // Build base AiAnalysisResult from Stage 2 output (or synthesise from Stage 1)
  let baseResult: AiAnalysisResult;
  if (aiResult) {
    baseResult = aiResult;
  } else {
    // Stage 2 was skipped — synthesise a clean compliance result from Stage 1 frames
    const violations = (stage1Result?.frames ?? []).flatMap(f =>
      f.issues.map(issue => ({
        policyArea: issue.policyArea,
        severity: issue.severity,
        description: issue.description,
        confidence: issue.confidence,
      })),
    );
    const score = stage1Result?.overallVideoScore ?? 100;

    baseResult = {
      overallScore: score,
      brandSafetyScore: score,
      contentCategories: [],
      violations,
      summary: stage1Result?.summary ?? "Content passed quick scan with no issues detected.",
      // Stage 1 only — never auto_approve without Stage 2, regardless of score.
      // Setting needs_review here is belt-and-suspenders; computeRoutingDecision
      // enforces the same rule via the deepTriggered guard.
      recommendation: "needs_review",
      confidence: 60,
      details: {},
      complianceScores: buildSkippedComplianceScores(),
      overallFccScore: undefined,
      overallIabScore: undefined,
      complianceSummary: "Quick scan passed — full FCC/IAB compliance analysis was not run. Trigger a manual AI review to perform a full compliance check.",
      highestRiskArea: undefined,
      requiredActions: [],
      detectedAdvertiser: undefined,
      detectedLanguages: undefined,
      isPoliticalAd: false,
      politicalDetails: undefined,
      objectionalContent: [],
      flaggableContent: [],
      audienceDemographics: undefined,
    };
  }

  // Run the moderator brief (LLM call) and the deterministic evidence/routing pipeline
  // in PARALLEL — the brief doesn't affect scoring or routing, so there's no dependency.
  const [moderatorBrief, stage3Results] = await Promise.all([
    generateModerationSuggestion(
      { title: ad.title, description: ad.description ?? null, format: ad.format, aiAnalysis: baseResult as any },
      baseResult.violations.map(v => ({ description: v.description, severity: v.severity })),
    ),
    Promise.resolve().then(() => {
      // Phase 2: Deterministic policy evaluation — no LLM calls, re-runnable.
      const evidence = extractEvidence({
        aiModerationResult: aiResult ?? undefined,
        frameResult: stage1Result ?? undefined,
      });
      const policyFindings = evaluateRules(evidence);
      const { failCount, warningCount, blockingViolations } = summarizeFindings(policyFindings);
      console.log(
        `[UnifiedReview] Phase 2 complete: evidence=${evidence.length} ` +
        `policy_findings=${policyFindings.length} fails=${failCount} warnings=${warningCount} ` +
        `blocking=${blockingViolations.join(",") || "none"}`,
      );
      // clearanceScore is null when Stage 2 was skipped — never fabricate a number.
      const clearanceScore = computeClearanceScore(
        baseResult.overallScore,
        stage1Result?.overallVideoScore ?? null,
        baseResult.complianceScores,
        runDeep,
      );
      const routing = computeRoutingDecision(baseResult, runDeep, stagesRun);
      return { evidence, policyFindings, clearanceScore, routing };
    }),
  ]);

  const { evidence, policyFindings, clearanceScore, routing } = stage3Results;
  console.log(
    `[UnifiedReview] Stage 3 complete in ${Date.now() - pipelineStart}ms — ` +
    `routing=${routing.decision} confidence=${routing.confidence}`,
  );
  console.log(
    `[UnifiedReview] Pipeline complete in ${Date.now() - pipelineStart}ms total — ` +
    `stages=[${routing.stagesCompleted.join(",")}] clearance=${clearanceScore ?? "null (Stage 2 skipped)"}`,
  );

  return {
    ...baseResult,
    // Frame findings
    frameFindings: stage1Result?.frames ?? [],
    totalFramesAnalyzed: stage1Result?.totalFramesAnalyzed ?? 0,
    analysisIntervalSeconds: stage1Result?.analysisIntervalSeconds ?? 0,
    overallVideoScore: stage1Result?.overallVideoScore ?? baseResult.overallScore,
    flaggedFrameCount: stage1Result?.flaggedFrameCount ?? 0,
    frameSummary: stage1Result?.summary ?? "",
    worstTimestamp: stage1Result?.worstTimestamp ?? null,
    worstIssue: stage1Result?.worstIssue ?? null,
    // Moderator guidance
    moderatorBrief,
    // Metadata
    deepAnalysisTriggered: runDeep,
    // Single synthesised score
    clearanceScore,
    // Agentic routing
    routingDecision: routing.decision,
    routingReason: routing.reason,
    routingConfidence: routing.confidence,
    stagesCompleted: routing.stagesCompleted,
    skippedDeepAnalysis: routing.skippedDeepAnalysis,
    // Phase 2 deterministic policy evaluation
    evidence,
    policyFindings,
    // Whisper transcript (null if Whisper didn't run or failed)
    whisperTranscript: whisperResult,
  };
}
