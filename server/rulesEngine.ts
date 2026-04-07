/**
 * Rules Engine
 *
 * Deterministic policy evaluation engine. NEVER calls an LLM.
 *
 * Takes structured evidence extracted by evidenceExtractor.ts and evaluates
 * each piece against FCC/IAB policy rules using pure logic:
 * keyword matching, presence/absence checks, timing checks.
 *
 * All findings carry confidence=100 because the logic is deterministic.
 * The same evidence always produces the same findings — re-runnable without
 * calling any AI provider.
 *
 * Rules evaluated:
 *   FCC: fcc-pp-002, fcc-cs-003, fcc-dt-004, fcc-ch-001, fcc-ps-002,
 *        fcc-ps-001, fcc-pp-003, fcc-ps-003
 *   IAB: iab-ss-001, iab-ss-002, iab-ss-003
 *
 * Rules that require AI understanding (nuanced visual/audio analysis) are NOT
 * evaluated here — they remain in the AI assessment layer.
 */

import type { ExtractedEvidence } from "./evidenceExtractor";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FindingStatus = "pass" | "fail" | "warning" | "not_evaluated";

export interface RuleFinding {
  ruleId: string;
  ruleName: string;
  framework: "FCC" | "IAB";
  status: FindingStatus;
  /** Always 100 — deterministic logic, not probabilistic AI */
  confidence: 100;
  severity: "info" | "warning" | "critical" | "blocking";
  description: string;
  /** IDs of evidence items that triggered or resolved this finding */
  evidenceIds: string[];
  recommendation?: string;
}

interface EvalContext {
  evidence: ExtractedEvidence[];
  transcriptText: string;
  transcriptSegments: ExtractedEvidence[];
  disclaimers: ExtractedEvidence[];
}

// ─── Context helpers ──────────────────────────────────────────────────────────

function buildContext(evidence: ExtractedEvidence[]): EvalContext {
  return {
    evidence,
    transcriptText: evidence
      .filter(e => e.type === "transcript_segment" || e.type === "disclaimer_detected")
      .map(e => e.content)
      .join(" "),
    transcriptSegments: evidence.filter(
      e => e.type === "transcript_segment" || e.type === "disclaimer_detected",
    ),
    disclaimers: evidence.filter(e => e.type === "disclaimer_detected"),
  };
}

/** Returns IDs of detected_category evidence matching any of the given category names */
function categoryIds(ctx: EvalContext, ...cats: string[]): string[] {
  return ctx.evidence
    .filter(e => e.type === "detected_category" && cats.includes(e.content))
    .map(e => e.id);
}

/** Returns IDs of transcript/disclaimer evidence that contains any of the given phrases */
function phraseIds(ctx: EvalContext, ...phrases: string[]): string[] {
  const matched: string[] = [];
  for (const seg of ctx.transcriptSegments) {
    const lower = seg.content.toLowerCase();
    if (phrases.some(p => lower.includes(p))) matched.push(seg.id);
  }
  for (const d of ctx.disclaimers) {
    const lower = d.content.toLowerCase();
    if (phrases.some(p => lower.includes(p)) && !matched.includes(d.id)) matched.push(d.id);
  }
  return matched;
}

/** True if the concatenated transcript contains any of the given phrases */
function transcriptHas(ctx: EvalContext, ...phrases: string[]): boolean {
  const lower = ctx.transcriptText.toLowerCase();
  return phrases.some(p => lower.includes(p));
}

// ─── Rule evaluators ──────────────────────────────────────────────────────────

function evalTobaccoBan(ctx: EvalContext): RuleFinding {
  const ids = categoryIds(ctx, "tobacco");
  return {
    ruleId: "fcc-pp-002",
    ruleName: "Tobacco Advertising Ban",
    framework: "FCC",
    status: ids.length > 0 ? "fail" : "pass",
    confidence: 100,
    severity: "blocking",
    description: ids.length > 0
      ? "Tobacco product advertising detected. Federal law (15 U.S.C. § 1335) prohibits cigarette and smokeless tobacco advertising on broadcast media."
      : "No tobacco advertising detected.",
    evidenceIds: ids,
    recommendation: ids.length > 0
      ? "Remove all tobacco product references. Tobacco advertising is prohibited on broadcast television and radio."
      : undefined,
  };
}

function evalProfanity(ctx: EvalContext): RuleFinding {
  const PROFANITY = [
    "\\bfuck\\b", "\\bfucking\\b", "\\bfucker\\b", "\\bmotherfucker\\b",
    "\\bshit\\b", "\\bbullshit\\b", "\\bcunt\\b", "\\basshole\\b",
    "\\bbitch\\b", "\\bbastard\\b", "\\bgolddamn\\b", "\\bgoddamn\\b",
    "\\bcock\\b(?!roach|pit|ney|tail)", "\\bdick\\b(?! )", "\\bpussy\\b",
    "\\bnigger\\b", "\\bnigga\\b", "\\bfaggot\\b", "\\bfag\\b", "\\bwhore\\b",
  ];

  const lower = ctx.transcriptText.toLowerCase();
  const hit = PROFANITY.find(p => new RegExp(p, "i").test(lower));

  if (!hit) {
    return {
      ruleId: "fcc-cs-003",
      ruleName: "Profanity Prohibition",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "blocking",
      description: "No FCC-prohibited profanity detected in transcript.",
      evidenceIds: [],
    };
  }

  const ids = ctx.transcriptSegments
    .filter(s => PROFANITY.some(p => new RegExp(p, "i").test(s.content)))
    .map(s => s.id);

  const word = hit.replace(/\\b/g, "").replace(/\(.+\)/, "").trim();
  return {
    ruleId: "fcc-cs-003",
    ruleName: "Profanity Prohibition",
    framework: "FCC",
    status: "fail",
    confidence: 100,
    severity: "blocking",
    description: `FCC-prohibited profanity detected in audio transcript (e.g. "${word}"). Broadcast of profanity is prohibited under FCC enforcement policy and may result in fines.`,
    evidenceIds: ids,
    recommendation: "Remove or bleep all profane language before broadcast.",
  };
}

function evalPoliticalDisclosure(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "political");
  if (catIds.length === 0) {
    return {
      ruleId: "fcc-dt-004",
      ruleName: "Political Advertising Disclosure",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "blocking",
      description: "No political advertising content detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "paid for by", "authorized by", "approved by",
    "i approve this message", "this is a paid political advertisement",
  );

  return {
    ruleId: "fcc-dt-004",
    ruleName: "Political Advertising Disclosure",
    framework: "FCC",
    status: discIds.length > 0 ? "pass" : "fail",
    confidence: 100,
    severity: "blocking",
    description: discIds.length > 0
      ? "Political advertising detected with required 'paid for by' disclosure."
      : "Political advertising detected without the required 'paid for by' or 'authorized by' disclosure.",
    evidenceIds: [...catIds, ...discIds],
    recommendation: discIds.length === 0
      ? "Add a clearly spoken and displayed 'Paid for by [Committee Name]' disclosure. Required for all political advertising under FCC rules."
      : undefined,
  };
}

function evalChildrensContent(ctx: EvalContext): RuleFinding {
  const childIds = categoryIds(ctx, "children");
  if (childIds.length === 0) {
    return {
      ruleId: "fcc-ch-001",
      ruleName: "Children's Advertising Limits",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "blocking",
      description: "Ad does not appear to target children.",
      evidenceIds: [],
    };
  }

  const restrictedIds = categoryIds(ctx, "alcohol", "tobacco", "gambling", "cannabis", "weapons", "adult_content");

  return {
    ruleId: "fcc-ch-001",
    ruleName: "Children's Advertising Limits",
    framework: "FCC",
    status: restrictedIds.length > 0 ? "fail" : "pass",
    confidence: 100,
    severity: "blocking",
    description: restrictedIds.length > 0
      ? "Children's advertising detected alongside age-restricted content (alcohol/tobacco/gambling). This combination is prohibited."
      : "Children's advertising detected with no age-restricted content.",
    evidenceIds: [...childIds, ...restrictedIds],
    recommendation: restrictedIds.length > 0
      ? "Remove all age-restricted content from ads targeting children."
      : undefined,
  };
}

function evalPharmaDTC(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "pharma");
  if (catIds.length === 0) {
    return {
      ruleId: "fcc-ps-002",
      ruleName: "Pharmaceutical DTC Major Statement",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "critical",
      description: "No pharmaceutical DTC content detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "side effects", "ask your doctor", "talk to your doctor",
    "consult your doctor", "important safety information",
    "see full prescribing information", "may cause", "not for everyone",
  );

  return {
    ruleId: "fcc-ps-002",
    ruleName: "Pharmaceutical DTC Major Statement",
    framework: "FCC",
    status: discIds.length > 0 ? "pass" : "fail",
    confidence: 100,
    severity: "critical",
    description: discIds.length > 0
      ? "Pharmaceutical DTC advertising detected with required major statement present."
      : "Pharmaceutical DTC advertising detected without required major statement (side effects, ask your doctor, etc.).",
    evidenceIds: [...catIds, ...discIds],
    recommendation: discIds.length === 0
      ? "Add a spoken major statement listing significant risks. It must be audible and understandable — not displayed only as fine print."
      : undefined,
  };
}

function evalAlcohol(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "alcohol");
  if (catIds.length === 0) {
    return {
      ruleId: "fcc-ps-001",
      ruleName: "Alcohol Advertising Standards",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "warning",
      description: "No alcohol advertising detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "drink responsibly", "please drink responsibly", "enjoy responsibly",
    "must be 21", "must be 18", "21+", "18+", "21 and over", "18 and over",
  );

  return {
    ruleId: "fcc-ps-001",
    ruleName: "Alcohol Advertising Standards",
    framework: "FCC",
    status: discIds.length > 0 ? "pass" : "warning",
    confidence: 100,
    severity: "warning",
    description: discIds.length > 0
      ? "Alcohol advertising detected with responsible drinking disclaimer present."
      : "Alcohol advertising detected without a responsible drinking disclaimer (\"drink responsibly\" or age restriction).",
    evidenceIds: [...catIds, ...discIds],
    recommendation: discIds.length === 0
      ? "Add a 'Drink Responsibly' message and/or '21+' age restriction to the ad."
      : undefined,
  };
}

function evalGambling(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "gambling");
  if (catIds.length === 0) {
    return {
      ruleId: "fcc-pp-003",
      ruleName: "Gambling Advertising Restrictions",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "critical",
      description: "No gambling content detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "gamble responsibly", "gambling helpline", "problem gambling",
    "1-800-gambler", "must be 21", "21+", "must be 18", "18+",
    "if you have a gambling problem", "help is available",
  );

  return {
    ruleId: "fcc-pp-003",
    ruleName: "Gambling Advertising Restrictions",
    framework: "FCC",
    status: discIds.length > 0 ? "pass" : "warning",
    confidence: 100,
    severity: "critical",
    description: discIds.length > 0
      ? "Gambling advertising with responsible gaming disclaimer and age restriction present."
      : "Gambling advertising detected without required responsible gaming disclaimer.",
    evidenceIds: [...catIds, ...discIds],
    recommendation: discIds.length === 0
      ? "Add a responsible gaming message (e.g., 'Gamble responsibly. 1-800-GAMBLER') and a 21+ age restriction."
      : undefined,
  };
}

function evalFinancialDisclosures(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "financial");
  if (catIds.length === 0) {
    return {
      ruleId: "fcc-ps-003",
      ruleName: "Financial Advertising Disclosures",
      framework: "FCC",
      status: "pass",
      confidence: 100,
      severity: "critical",
      description: "No financial advertising content detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "results may vary", "past performance", "not a guarantee",
    "may lose", "investment risk", "not fdic insured",
    "terms and conditions", "see website for details",
    "annual percentage", "apr", "subject to credit",
  );

  return {
    ruleId: "fcc-ps-003",
    ruleName: "Financial Advertising Disclosures",
    framework: "FCC",
    status: discIds.length > 0 ? "pass" : "warning",
    confidence: 100,
    severity: "critical",
    description: discIds.length > 0
      ? "Financial advertising detected with standard risk disclaimers present."
      : "Financial advertising detected without standard risk disclaimers (APR, risk warnings, regulatory disclosures).",
    evidenceIds: [...catIds, ...discIds],
    recommendation: discIds.length === 0
      ? "Add FTC/SEC-required disclaimers: APR rates, investment risk warnings, and applicable regulatory disclosures."
      : undefined,
  };
}

// ── IAB rules ─────────────────────────────────────────────────────────────────

function evalHealthClaims(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "supplement", "pharma");
  if (catIds.length === 0) {
    return {
      ruleId: "iab-ss-001",
      ruleName: "Health & Wellness Claims",
      framework: "IAB",
      status: "pass",
      confidence: 100,
      severity: "critical",
      description: "No health/wellness product advertising detected.",
      evidenceIds: [],
    };
  }

  const hasMiracleClaims = transcriptHas(ctx,
    "miracle", "guaranteed results", "guaranteed weight loss",
    "fda approved", "clinically proven to cure",
  );
  const discIds = phraseIds(ctx,
    "individual results may vary", "results may vary",
    "not evaluated by the fda", "these statements have not been evaluated",
    "consult a physician", "ask your doctor",
  );

  if (hasMiracleClaims && discIds.length === 0) {
    return {
      ruleId: "iab-ss-001",
      ruleName: "Health & Wellness Claims",
      framework: "IAB",
      status: "warning",
      confidence: 100,
      severity: "critical",
      description: "Health/wellness advertising contains potentially unsubstantiated claims without adequate disclaimers.",
      evidenceIds: catIds,
      recommendation: "Add FTC-required disclaimers: 'Results may vary. These statements have not been evaluated by the FDA.' Remove unsubstantiated guarantee language.",
    };
  }

  return {
    ruleId: "iab-ss-001",
    ruleName: "Health & Wellness Claims",
    framework: "IAB",
    status: "pass",
    confidence: 100,
    severity: "critical",
    description: "Health/wellness advertising detected; no obviously unsubstantiated miracle claims found.",
    evidenceIds: catIds,
  };
}

function evalCryptoDisclaimer(ctx: EvalContext): RuleFinding {
  // Look specifically for crypto-related keywords in evidence metadata
  const cryptoEvidence = ctx.evidence.filter(e => {
    const text = [
      e.content,
      (e.metadata?.rawCategory as string) ?? "",
      (e.metadata?.rawContent as string) ?? "",
      (e.metadata?.description as string) ?? "",
    ].join(" ").toLowerCase();
    return (
      text.includes("crypto") ||
      text.includes("bitcoin") ||
      text.includes("nft") ||
      text.includes("blockchain") ||
      text.includes("digital asset") ||
      text.includes("token")
    );
  });

  if (cryptoEvidence.length === 0) {
    return {
      ruleId: "iab-ss-002",
      ruleName: "Cryptocurrency & Digital Asset Advertising",
      framework: "IAB",
      status: "pass",
      confidence: 100,
      severity: "critical",
      description: "No cryptocurrency or digital asset advertising detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "crypto is volatile", "you may lose", "investment risk",
    "not financial advice", "past performance", "results may vary",
    "not a guarantee", "high risk",
  );

  return {
    ruleId: "iab-ss-002",
    ruleName: "Cryptocurrency & Digital Asset Advertising",
    framework: "IAB",
    status: discIds.length > 0 ? "pass" : "warning",
    confidence: 100,
    severity: "critical",
    description: discIds.length > 0
      ? "Cryptocurrency advertising detected with required risk disclaimer present."
      : "Cryptocurrency/digital asset advertising detected without required risk disclaimers.",
    evidenceIds: [...cryptoEvidence.map(e => e.id), ...discIds],
    recommendation: discIds.length === 0
      ? "Add crypto risk disclaimers: 'Cryptocurrency is highly volatile. You may lose your entire investment. This is not financial advice.'"
      : undefined,
  };
}

function evalIABGambling(ctx: EvalContext): RuleFinding {
  const catIds = categoryIds(ctx, "gambling");
  if (catIds.length === 0) {
    return {
      ruleId: "iab-ss-003",
      ruleName: "Real Money Gaming / Gambling",
      framework: "IAB",
      status: "pass",
      confidence: 100,
      severity: "critical",
      description: "No gambling/gaming content detected.",
      evidenceIds: [],
    };
  }

  const discIds = phraseIds(ctx,
    "gamble responsibly", "gambling helpline", "problem gambling",
    "1-800-gambler", "must be 21", "21+", "must be 18", "18+",
    "if you have a gambling problem", "help is available",
  );

  return {
    ruleId: "iab-ss-003",
    ruleName: "Real Money Gaming / Gambling",
    framework: "IAB",
    status: discIds.length > 0 ? "pass" : "warning",
    confidence: 100,
    severity: "critical",
    description: discIds.length > 0
      ? "Gambling advertising with responsible gaming messaging and age restriction present."
      : "Gambling/gaming advertising detected without responsible gaming disclosure and age restriction.",
    evidenceIds: [...catIds, ...discIds],
    recommendation: discIds.length === 0
      ? "Add age restriction (21+), a responsible gaming hotline (1-800-GAMBLER), and a 'Gamble Responsibly' message."
      : undefined,
  };
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Evaluates all deterministic policy rules against the provided evidence.
 * Returns one finding per rule — pass, fail, warning, or not_evaluated.
 *
 * confidence is always 100. The same evidence always produces the same findings.
 */
export function evaluateRules(evidence: ExtractedEvidence[]): RuleFinding[] {
  const ctx = buildContext(evidence);

  return [
    // FCC — severity order: blocking violations first
    evalTobaccoBan(ctx),
    evalProfanity(ctx),
    evalPoliticalDisclosure(ctx),
    evalChildrensContent(ctx),
    evalPharmaDTC(ctx),
    evalAlcohol(ctx),
    evalGambling(ctx),
    evalFinancialDisclosures(ctx),
    // IAB
    evalHealthClaims(ctx),
    evalCryptoDisclaimer(ctx),
    evalIABGambling(ctx),
  ];
}

/**
 * Compact summary of rule findings for logging and clearance score computation.
 */
export function summarizeFindings(findings: RuleFinding[]): {
  failCount: number;
  warningCount: number;
  passCount: number;
  blockingViolations: string[];
} {
  return {
    failCount: findings.filter(f => f.status === "fail").length,
    warningCount: findings.filter(f => f.status === "warning").length,
    passCount: findings.filter(f => f.status === "pass").length,
    blockingViolations: findings
      .filter(f => f.status === "fail" && f.severity === "blocking")
      .map(f => f.ruleId),
  };
}
