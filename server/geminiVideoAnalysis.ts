/**
 * Gemini 2.5 Pro Native Video Analysis Provider
 *
 * Analyzes video ads using Gemini's multimodal understanding of the raw
 * video+audio stream. Unlike the frame-extraction pipeline, Gemini sees
 * the full temporal context, hears spoken words and disclaimer cadence,
 * reads on-screen text, and detects audio-only violations that sampling misses.
 *
 * Supported video sources:
 *   - S3/R2 uploads (downloaded → Gemini Files API)
 *   - YouTube URLs   (passed directly — no download needed)
 *   - Direct URLs    (downloaded → Gemini Files API)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  FCC_FRAMEWORK,
  IAB_FRAMEWORK,
  generateCompliancePrompt,
} from "./complianceFrameworks";
import { ENV } from "./_core/env";
import { storageDownloadBuffer } from "./storage";

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.5-pro";
/** Practical upload cap: Gemini Files API supports up to 2 GB but large files
 *  slow analysis significantly. 500 MB covers any broadcast spot. */
const MAX_FILE_BYTES = 500 * 1024 * 1024;
/** How long to wait for Gemini to finish processing the uploaded file. */
const FILE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to allow for the generateContent call itself. */
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

// ─── Zod schemas (validate ALL LLM output before use) ────────────────────────

const GeminiFindingSchema = z.object({
  timestampSeconds: z.number().nullable().catch(null),
  ruleId: z.string(),
  ruleName: z.string(),
  severity: z.enum(["info", "warning", "critical", "blocking"]),
  description: z.string(),
  recommendation: z.string(),
  confidence: z.number().int().min(0).max(100),
});

const GeminiResponseSchema = z.object({
  findings: z.array(GeminiFindingSchema).catch([]),
  overallFccScore: z.number().int().min(0).max(100),
  overallIabScore: z.number().int().min(0).max(100),
  complianceSummary: z.string(),
  audioViolations: z.array(z.string()).catch([]),
  requiredActions: z.array(z.string()).catch([]),
});

// ─── Public types ─────────────────────────────────────────────────────────────

export type GeminiVideoFinding = z.infer<typeof GeminiFindingSchema>;

export type GeminiAnalysisResult = z.infer<typeof GeminiResponseSchema> & {
  /** Exact model ID that produced this result */
  modelVersion: string;
  /** ISO timestamp when analysis completed */
  analyzedAt: string;
  /** How the video was supplied to Gemini */
  sourceType: "file_upload" | "youtube" | "url";
  /** Wall-clock ms from call to return */
  durationMs: number;
};

export interface GeminiAnalysisInput {
  /** S3/R2 object key — downloaded to a temp file then uploaded to Gemini Files API */
  fileKey?: string | null;
  /** Public or presigned video URL; YouTube URLs are passed directly without downloading */
  sourceUrl?: string | null;
  /** "youtube" | "vimeo" | "direct" | null — governs whether to pass URL or download first */
  videoProvider?: string | null;
  /** MIME type of the video file (defaults to video/mp4) */
  mimeType?: string | null;
  /** Ad title used only for log messages */
  adTitle?: string;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(): string {
  const rulesSection = generateCompliancePrompt([FCC_FRAMEWORK, IAB_FRAMEWORK]);

  return `You are an expert broadcast advertising compliance analyst with deep knowledge of FCC regulations, FTC rules, and IAB digital advertising standards.

${rulesSection}

ANALYSIS INSTRUCTIONS — read every instruction carefully before analyzing:

1. Watch the COMPLETE video from start to finish. Do not skip any segment.
2. Listen to ALL audio: spoken words, music, sound effects, and especially legal disclaimers.
3. Read ALL on-screen text including fine print, supers, and crawls.
4. For each compliance concern, record:
   - timestampSeconds: the moment the issue occurs (null if not time-specific)
   - ruleId: the exact ID from the frameworks above (e.g. "fcc-dt-003", "iab-tr-001")
   - severity: "info" | "warning" | "critical" | "blocking"
   - confidence: 0–100 integer (your certainty this is actually a violation)
5. Pay particular attention to audio-only signals that frame sampling would miss:
   - Spoken disclaimers: pace, volume relative to main audio, clarity
   - CALM Act (fcc-pp-005): audio loudness vs. surrounding programme level
   - Profanity or indecent language anywhere in the audio track
   - Pharmaceutical DTC "major statement" — must be spoken, not just displayed
6. For visual disclosures (fcc-dt-002):
   - Fine print must be on screen ≥ 4 seconds and readable at normal viewing distance
   - Contrast ratio must be sufficient; coloured text on similar background fails
7. Do NOT fabricate violations. If the ad is compliant in a category, say so implicitly
   by not including findings for it — do not invent issues to appear thorough.
8. Return ONLY a single valid JSON object with this exact structure and no other text:

{
  "findings": [
    {
      "timestampSeconds": 27.5,
      "ruleId": "fcc-dt-003",
      "ruleName": "Audio Disclosure Clarity",
      "severity": "warning",
      "description": "Legal disclaimer at 0:27 is read at an estimated 220 words-per-minute, making it incomprehensible.",
      "recommendation": "Re-record the disclaimer at ≤130 wpm and ensure it is not obscured by background music.",
      "confidence": 88
    }
  ],
  "overallFccScore": 76,
  "overallIabScore": 82,
  "complianceSummary": "One audio disclosure clarity issue found. Visual disclosures are adequate. No blocking violations.",
  "audioViolations": ["Excessively fast-spoken disclaimer at 0:27–0:30"],
  "requiredActions": ["Re-record legal disclaimer at a slower, understandable pace"]
}

If the ad is fully compliant, return findings: [], scores near 100, and a summary stating so.`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const sentinel = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Gemini: ${label} timed out after ${(ms / 1000).toFixed(0)}s`)),
      ms,
    )
  );
  return Promise.race([promise, sentinel]);
}

function getClient(): GoogleGenAI {
  if (!ENV.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to .env to enable Gemini analysis.");
  }
  return new GoogleGenAI({ apiKey: ENV.geminiApiKey });
}

// ─── Gemini Files API upload ──────────────────────────────────────────────────

/**
 * Upload a local video file to the Gemini Files API and wait until it is ACTIVE.
 * Returns the file URI for use in generateContent requests.
 */
async function uploadToGeminiFiles(
  ai: GoogleGenAI,
  localPath: string,
  mimeType: string,
  displayName: string,
): Promise<string> {
  console.log(`[Gemini] Uploading to Files API: ${displayName} (${mimeType})`);
  const t0 = Date.now();

  let file = await ai.files.upload({
    file: localPath,
    config: { mimeType, displayName },
  });
  console.log(`[Gemini] Upload queued: name=${file.name} state=${file.state}`);

  // Poll until ACTIVE or FAILED
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
  while (file.state === "PROCESSING") {
    if (Date.now() > deadline) {
      throw new Error(
        `Gemini file processing timed out after ${FILE_POLL_TIMEOUT_MS / 1000}s for: ${file.name}`,
      );
    }
    await sleep(3_000);
    file = await ai.files.get({ name: file.name! });
    console.log(`[Gemini] File state: ${file.state}`);
  }

  if (file.state === "FAILED") {
    throw new Error(`Gemini Files API rejected the upload: ${file.name}`);
  }

  console.log(`[Gemini] File ACTIVE in ${Date.now() - t0}ms — uri=${file.uri}`);
  return file.uri!;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyzeVideoWithGemini(
  input: GeminiAnalysisInput,
): Promise<GeminiAnalysisResult> {
  const {
    fileKey,
    sourceUrl,
    videoProvider,
    mimeType: rawMimeType,
    adTitle = "unknown",
  } = input;
  const mimeType = rawMimeType || "video/mp4";
  const t0 = Date.now();
  const ai = getClient();
  const prompt = buildPrompt();

  let fileUri: string;
  let sourceType: GeminiAnalysisResult["sourceType"];
  let tempDir: string | null = null;

  try {
    // ── Resolve video source ──────────────────────────────────────────────────

    if (videoProvider === "youtube" && sourceUrl) {
      // Gemini natively understands YouTube URLs — no download or Files API needed.
      console.log(`[Gemini] YouTube direct mode: "${adTitle}" — ${sourceUrl}`);
      fileUri = sourceUrl;
      sourceType = "youtube";

    } else if (fileKey) {
      // Private S3/R2 file: download buffer → write temp → Files API upload
      console.log(`[Gemini] S3 download mode: "${adTitle}" — key=${fileKey}`);
      const buffer = await storageDownloadBuffer(fileKey);
      if (!buffer || buffer.length === 0) {
        throw new Error(`S3 download returned empty buffer for key "${fileKey}"`);
      }
      if (buffer.length > MAX_FILE_BYTES) {
        throw new Error(
          `Video too large for Gemini: ${(buffer.length / 1024 / 1024).toFixed(0)} MB ` +
          `(limit: ${MAX_FILE_BYTES / 1024 / 1024} MB)`,
        );
      }
      tempDir = path.join(os.tmpdir(), `gemini-${nanoid(8)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, "video.mp4");
      fs.writeFileSync(tempFile, buffer);
      console.log(
        `[Gemini] Wrote ${(buffer.length / 1024 / 1024).toFixed(1)} MB to ${tempFile}`,
      );
      fileUri = await uploadToGeminiFiles(ai, tempFile, mimeType, `ad-${nanoid(6)}.mp4`);
      sourceType = "file_upload";

    } else if (sourceUrl) {
      // Public/presigned URL: download first (Gemini can't reach presigned S3 URLs)
      console.log(`[Gemini] URL download mode: "${adTitle}" — ${sourceUrl.slice(0, 80)}...`);
      const res = await fetch(sourceUrl);
      if (!res.ok) {
        throw new Error(`Failed to download video for Gemini: HTTP ${res.status}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_FILE_BYTES) {
        throw new Error(
          `Video too large for Gemini: ${(buffer.length / 1024 / 1024).toFixed(0)} MB ` +
          `(limit: ${MAX_FILE_BYTES / 1024 / 1024} MB)`,
        );
      }
      tempDir = path.join(os.tmpdir(), `gemini-${nanoid(8)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, "video.mp4");
      fs.writeFileSync(tempFile, buffer);
      fileUri = await uploadToGeminiFiles(ai, tempFile, mimeType, `ad-${nanoid(6)}.mp4`);
      sourceType = "url";

    } else {
      throw new Error(
        "GeminiAnalysisInput requires at least one of: fileKey or sourceUrl",
      );
    }

    // ── Run compliance analysis ────────────────────────────────────────────────

    console.log(
      `[Gemini] Generating compliance analysis: "${adTitle}" ` +
      `(model=${GEMINI_MODEL} sourceType=${sourceType})`,
    );

    const response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { fileData: { fileUri, mimeType: sourceType === "youtube" ? "video/mp4" : mimeType } },
              { text: prompt },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
        },
      }),
      GENERATION_TIMEOUT_MS,
      "generateContent",
    );

    const rawText = response.text ?? "";
    const elapsedMs = Date.now() - t0;
    console.log(`[Gemini] Response: ${rawText.length} chars in ${elapsedMs}ms`);

    // ── Validate with Zod — never trust raw LLM JSON ─────────────────────────

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(
        `Gemini returned non-JSON output (first 300 chars): ${rawText.slice(0, 300)}`,
      );
    }

    const validated = GeminiResponseSchema.parse(parsed);
    console.log(
      `[Gemini] Analysis complete: ${validated.findings.length} findings, ` +
      `FCC=${validated.overallFccScore} IAB=${validated.overallIabScore}`,
    );

    return {
      ...validated,
      modelVersion: GEMINI_MODEL,
      analyzedAt: new Date().toISOString(),
      sourceType,
      durationMs: elapsedMs,
    };

  } finally {
    // Always clean up temp files, even on error
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  }
}
