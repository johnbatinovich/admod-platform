import {
  analyzeAdContent,
  generateModerationSuggestion,
  type AiAnalysisResult,
  type ComplianceCategoryScore,
} from "./aiModeration";
import { runFrameAnalysis, type FrameFinding, type FrameAnalysisResult } from "./frameAnalysis";
import { FCC_FRAMEWORK, IAB_FRAMEWORK } from "./complianceFrameworks";
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
  // Agentic routing decision (from Stage 3)
  routingDecision: AgentRoutingDecision;
  routingReason: string;
  routingConfidence: number;
  stagesCompleted: number[];
  skippedDeepAnalysis: boolean;
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

  // High-confidence auto-approve: clean content, no critical/blocking findings
  if (conf >= 85 && baseResult.recommendation === "auto_approve" && !hasCritical) {
    return {
      decision: "auto_approve",
      reason: `High confidence (${conf}%) with clean content and no critical findings — auto-approved without human review.`,
      confidence: conf,
      stagesCompleted: stagesRun,
      skippedDeepAnalysis: !deepTriggered,
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
 *
 * Stage 3 — Decision & Report (always runs):
 *   Synthesises findings, generates the moderator brief, produces final result.
 */
export async function runUnifiedAiReview(
  ad: AdSubmission,
  policies: Policy[],
  onStageChange: (stage: ReviewStage) => Promise<void>,
): Promise<UnifiedReviewResult> {
  const isVisual =
    ad.format === "video" ||
    ad.format === "image" ||
    ["youtube", "vimeo", "direct_url"].includes(ad.sourceType ?? "");

  const stagesRun: number[] = [];

  // ─── Stage 1: Quick Scan ────────────────────────────────────────────────
  await onStageChange("stage1_running");
  stagesRun.push(1);
  console.log(`[UnifiedReview] Stage 1 starting for ad ${ad.id} (${ad.title})`);

  let stage1Result: FrameAnalysisResult | null = null;
  if (isVisual) {
    stage1Result = await runFrameAnalysis(
      {
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
      },
      policies,
      // no intervalSeconds — uses adaptive default from video duration
    );
    console.log(
      `[UnifiedReview] Stage 1 complete: score=${stage1Result.overallVideoScore} ` +
      `flagged=${stage1Result.flaggedFrameCount} frames=${stage1Result.totalFramesAnalyzed}`,
    );
  } else {
    console.log(`[UnifiedReview] Stage 1 skipped — non-visual content (format=${ad.format})`);
  }

  // ─── Stage 2: Deep Analysis (conditional) ───────────────────────────────
  // Always run deep analysis for regulated content categories, even if Stage 1 looks clean.
  const regulatedByContent = isRegulatedContent(ad);
  const runDeep = !stage1Result || requiresDeepAnalysis(stage1Result) || regulatedByContent;
  let aiResult: AiAnalysisResult | null = null;

  if (runDeep) {
    await onStageChange("stage2_running");
    stagesRun.push(2);
    console.log(
      `[UnifiedReview] Stage 2 starting — ` +
      (regulatedByContent ? "regulated content detected in ad metadata" :
       stage1Result
        ? `triggered by score=${stage1Result.overallVideoScore} flagged=${stage1Result.flaggedFrameCount}`
        : "non-visual content always gets deep analysis"),
    );
    aiResult = await analyzeAdContent(ad, policies);
    console.log(
      `[UnifiedReview] Stage 2 complete: score=${aiResult.overallScore} ` +
      `recommendation=${aiResult.recommendation}`,
    );
  } else {
    console.log(
      `[UnifiedReview] Stage 2 skipped — Stage 1 clean ` +
      `(score=${stage1Result!.overallVideoScore}, no regulated content)`,
    );
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
      recommendation: score >= 90 ? "auto_approve" : "needs_review",
      confidence: 85,
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

  // Generate moderator brief from synthesised results
  const moderatorBrief = await generateModerationSuggestion(
    { title: ad.title, description: ad.description ?? null, format: ad.format, aiAnalysis: baseResult as any },
    baseResult.violations.map(v => ({ description: v.description, severity: v.severity })),
  );

  // Compute agentic routing decision based on confidence + recommendation
  const routing = computeRoutingDecision(baseResult, runDeep, stagesRun);
  console.log(
    `[UnifiedReview] Stage 3 complete — routing=${routing.decision} ` +
    `confidence=${routing.confidence} reason="${routing.reason}"`,
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
    // Agentic routing
    routingDecision: routing.decision,
    routingReason: routing.reason,
    routingConfidence: routing.confidence,
    stagesCompleted: routing.stagesCompleted,
    skippedDeepAnalysis: routing.skippedDeepAnalysis,
  };
}
