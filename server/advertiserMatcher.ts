/**
 * Advertiser Matcher
 *
 * Four-level pipeline for matching a detected advertiser name against the
 * existing advertiser database. Levels run in order and return on first match.
 *
 * Level 1 — Exact (case-insensitive)    confidence: "exact"
 * Level 2 — Normalized suffix-stripped  confidence: "high"
 * Level 3 — Containment                 confidence: "medium"
 * Level 4 — LLM fuzzy (optional)        confidence: "medium"
 */

import * as db from "./db";
import { invokeLLM } from "./_core/llm";

export interface AdvertiserMatch {
  existingId: number;
  existingName: string;
  confidence: "exact" | "high" | "medium";
  matchReason: string;
}

// ─── Name Normalizer ──────────────────────────────────────────────────────────

const SUFFIX_PATTERNS = [
  "holdings",
  "international",
  "intl",
  "company",
  "group",
  "corp",
  "inc",
  "llc",
  "ltd",
  "co",
  "the",
  "lp",
];

/**
 * Strip legal suffixes, symbols, and punctuation from an advertiser name so
 * "The Home Depot, Inc." and "Home Depot" normalize to the same string.
 */
export function normalizeAdvertiserName(name: string): string {
  let n = name.toLowerCase();
  // Remove trademark / copyright symbols
  n = n.replace(/[®™©]/g, "");
  // Remove punctuation (keep alphanumeric and spaces)
  n = n.replace(/[^a-z0-9\s]/g, " ");
  // Remove legal suffixes as whole words (longest first to avoid partial removal)
  for (const suffix of SUFFIX_PATTERNS) {
    n = n.replace(new RegExp(`\\b${suffix}\\b`, "g"), " ");
  }
  // Collapse whitespace
  n = n.replace(/\s+/g, " ").trim();
  return n;
}

// ─── Matching Pipeline ────────────────────────────────────────────────────────

export async function matchAdvertiser(
  detectedName: string,
): Promise<AdvertiserMatch | null> {
  if (!detectedName.trim()) return null;

  const allAdvertisers = await db.getAdvertisers();
  if (allAdvertisers.length === 0) return null;

  const detectedLower = detectedName.trim().toLowerCase();
  const detectedNorm = normalizeAdvertiserName(detectedName);

  // ── Level 1: Exact match (case-insensitive) ────────────────────────────────
  const exact = allAdvertisers.find(a => a.name.toLowerCase() === detectedLower);
  if (exact) {
    console.log(`[AdvertiserMatcher] L1 exact: "${detectedName}" → "${exact.name}" (id=${exact.id})`);
    return {
      existingId: exact.id,
      existingName: exact.name,
      confidence: "exact",
      matchReason: "Exact name match",
    };
  }

  // ── Level 2: Normalized match ──────────────────────────────────────────────
  if (detectedNorm.length >= 2) {
    const normalized = allAdvertisers.find(a => {
      const aNorm = a.normalizedName ?? normalizeAdvertiserName(a.name);
      return aNorm === detectedNorm && detectedNorm.length > 0;
    });
    if (normalized) {
      console.log(`[AdvertiserMatcher] L2 normalized: "${detectedName}" → "${normalized.name}" (id=${normalized.id})`);
      return {
        existingId: normalized.id,
        existingName: normalized.name,
        confidence: "high",
        matchReason: `Normalized match: "${detectedNorm}" → "${normalizeAdvertiserName(normalized.name)}"`,
      };
    }
  }

  // ── Level 3: Containment match ─────────────────────────────────────────────
  if (detectedNorm.length >= 4) {
    const contained = allAdvertisers.find(a => {
      const aNorm = a.normalizedName ?? normalizeAdvertiserName(a.name);
      if (aNorm.length < 4) return false;
      return aNorm.includes(detectedNorm) || detectedNorm.includes(aNorm);
    });
    if (contained) {
      console.log(`[AdvertiserMatcher] L3 containment: "${detectedName}" → "${contained.name}" (id=${contained.id})`);
      return {
        existingId: contained.id,
        existingName: contained.name,
        confidence: "medium",
        matchReason: `Containment match: "${detectedName}" ↔ "${contained.name}"`,
      };
    }
  }

  // ── Level 4: LLM fuzzy match (only when advertiser count < 500) ───────────
  if (allAdvertisers.length < 500) {
    try {
      const listText = allAdvertisers
        .map(a => `- ID ${a.id}: ${a.name}`)
        .join("\n");

      const llmResult = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You are an entity resolution system. Return ONLY a JSON object with no markdown fencing.",
          },
          {
            role: "user",
            content: `You are an entity resolution system. Given a detected advertiser name and a list of existing advertisers, determine if the detected name refers to any existing advertiser.

Detected name: "${detectedName}"

Existing advertisers:
${listText}

If the detected name matches an existing advertiser (same company, subsidiary, alternate name, abbreviation, or known alias), return:
{"match": true, "existingId": <id>, "reason": "explanation"}

If no match exists, return:
{"match": false}

Examples of matches: "McDonald's" matches "McDonalds", "Coca-Cola" matches "Coke", "JPMorgan Chase" matches "JP Morgan", "FedEx" matches "Federal Express", "Meta" matches "Facebook".
Examples of non-matches: "Apple" (tech) should NOT match "Apple Records" (music) if both exist separately.

Return valid JSON only.`,
          },
        ],
        responseFormat: { type: "json_object" },
        maxTokens: 150,
      });

      const raw = llmResult.choices[0]?.message?.content;
      if (typeof raw === "string") {
        const parsed = JSON.parse(raw);
        if (parsed.match === true && typeof parsed.existingId === "number") {
          const matched = allAdvertisers.find(a => a.id === parsed.existingId);
          if (matched) {
            console.log(`[AdvertiserMatcher] L4 LLM: "${detectedName}" → "${matched.name}" (id=${matched.id}) reason="${parsed.reason}"`);
            return {
              existingId: matched.id,
              existingName: matched.name,
              confidence: "medium",
              matchReason: parsed.reason ?? "LLM entity resolution",
            };
          }
        }
      }
    } catch (err) {
      console.warn("[AdvertiserMatcher] L4 LLM match failed:", err);
    }
  }

  return null;
}
