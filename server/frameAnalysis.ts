import { invokeLLM } from "./_core/llm";
import type { Policy } from "../drizzle/schema";
import {
  FCC_FRAMEWORK,
  IAB_FRAMEWORK,
  generateCompliancePrompt,
  generateCompactCompliancePrompt,
} from "./complianceFrameworks";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FrameAnalysisRequest {
  adId: number;
  title: string;
  description?: string | null;
  format: string;
  fileUrl?: string | null;
  /** R2/S3 object key for uploaded files — used for direct SDK download */
  fileKey?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  videoProvider?: string | null;
  videoId?: string | null;
  thumbnailUrl?: string | null;
  videoDuration?: string | null;
  targetAudience?: string | null;
}

export interface FrameFinding {
  frameIndex: number;
  timestampSeconds: number;
  timestampFormatted: string;
  thumbnailUrl: string;
  score: number; // 0-100, higher = safer
  severity: "safe" | "info" | "warning" | "critical" | "blocking";
  issues: FrameIssue[];
  description: string;
}

export interface FrameIssue {
  category: string;
  description: string;
  severity: "info" | "warning" | "critical" | "blocking";
  confidence: number;
  policyArea: string;
}

export interface FrameAnalysisResult {
  adId: number;
  totalFramesAnalyzed: number;
  analysisIntervalSeconds: number;
  overallVideoScore: number;
  flaggedFrameCount: number;
  frames: FrameFinding[];
  summary: string;
  worstTimestamp: string | null;
  worstIssue: string | null;
  status: "completed" | "partial" | "failed";
}

// ─── YouTube Frame Extraction ───────────────────────────────────────────────

/**
 * YouTube provides frame-level thumbnails at specific timestamps via storyboard API.
 * Standard thumbnails: 0.jpg (120x90), 1.jpg, 2.jpg, 3.jpg (auto-selected frames at ~25%, ~50%, ~75%)
 * HQ: hqdefault.jpg, mqdefault.jpg, sddefault.jpg, maxresdefault.jpg (all at ~0s)
 *
 * LIMITATION: YouTube's public API only provides 4 auto-generated thumbnails at fixed positions.
 * For true per-second analysis, the video must be downloaded and processed server-side,
 * or the LLM must watch the video directly. For YouTube, we maximize thumbnail coverage
 * and supplement with LLM video understanding when available.
 *
 * For per-second analysis of YouTube content, we generate synthetic timestamp entries
 * that the LLM will map to its closest available visual analysis of the video.
 */
function getYouTubeFrameUrls(videoId: string, durationSeconds: number, intervalSeconds: number): { url: string; timestampSeconds: number }[] {
  const frames: { url: string; timestampSeconds: number }[] = [];

  // Standard YouTube thumbnails at fixed positions
  const standardThumbs = [
    { url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, timestampSeconds: 0 },
    { url: `https://img.youtube.com/vi/${videoId}/0.jpg`, timestampSeconds: 0 },
    { url: `https://img.youtube.com/vi/${videoId}/1.jpg`, timestampSeconds: Math.floor(durationSeconds * 0.25) },
    { url: `https://img.youtube.com/vi/${videoId}/2.jpg`, timestampSeconds: Math.floor(durationSeconds * 0.5) },
    { url: `https://img.youtube.com/vi/${videoId}/3.jpg`, timestampSeconds: Math.floor(durationSeconds * 0.75) },
    { url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, timestampSeconds: Math.floor(durationSeconds * 0.1) },
    { url: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`, timestampSeconds: Math.floor(durationSeconds * 0.3) },
    { url: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`, timestampSeconds: Math.floor(durationSeconds * 0.6) },
  ];

  // Deduplicate by URL
  const seen = new Set<string>();
  for (const thumb of standardThumbs) {
    if (!seen.has(thumb.url)) {
      seen.add(thumb.url);
      frames.push(thumb);
    }
  }

  // For per-second analysis, we generate frame entries at every interval.
  // Each maps to the nearest available thumbnail URL for visual reference,
  // but the AI prompt instructs the model to analyze the video content at each timestamp.
  const numFrames = Math.min(Math.ceil(durationSeconds / intervalSeconds), 60); // Cap at 60 frames per batch
  for (let i = 0; i < numFrames; i++) {
    const ts = Math.round((i / numFrames) * durationSeconds);
    // Find the closest standard thumbnail to this timestamp
    const closestThumb = standardThumbs.reduce((closest, thumb) =>
      Math.abs(thumb.timestampSeconds - ts) < Math.abs(closest.timestampSeconds - ts) ? thumb : closest
    );
    if (!frames.some(f => f.timestampSeconds === ts)) {
      frames.push({ url: closestThumb.url, timestampSeconds: ts });
    }
  }

  return frames.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
}

/**
 * For Vimeo, we use the thumbnail from oEmbed and the video URL for analysis.
 */
function getVimeoFrameUrls(thumbnailUrl: string | null, durationSeconds: number): { url: string; timestampSeconds: number }[] {
  if (!thumbnailUrl) return [];
  // Vimeo oEmbed only gives one thumbnail, but we can modify the size
  // Vimeo thumbnails support size modification: append _WIDTHxHEIGHT
  return [
    { url: thumbnailUrl, timestampSeconds: 0 },
    { url: thumbnailUrl.replace(/(_\d+x\d+)?(\.\w+)$/, "_640x360$2"), timestampSeconds: Math.floor(durationSeconds * 0.25) },
    { url: thumbnailUrl.replace(/(_\d+x\d+)?(\.\w+)$/, "_960x540$2"), timestampSeconds: Math.floor(durationSeconds * 0.5) },
  ];
}

// ─── Duration Parsing ───────────────────────────────────────────────────────

function parseDurationToSeconds(duration: string | null | undefined): number {
  if (!duration) return 120; // Default 2 minutes if unknown
  const parts = duration.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseInt(duration) || 120;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── Image Fetch Utility ─────────────────────────────────────────────────────

/**
 * Fetch an image URL and return it as a base64 data URL so the vision model
 * never needs to make outbound requests to private R2/S3 buckets.
 * Returns null on failure — caller skips the frame.
 */
async function fetchToBase64(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[FrameAnalysis] Image fetch failed: HTTP ${response.status} — ${url.slice(0, 100)}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
    const path = url.split("?")[0].toLowerCase();
    const mimeType = path.endsWith(".png") ? "image/png"
      : path.endsWith(".webp") ? "image/webp"
      : "image/jpeg";
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn(`[FrameAnalysis] Image fetch threw for ${url.slice(0, 100)}:`, err);
    return null;
  }
}

// ─── AI Vision Analysis ─────────────────────────────────────────────────────

async function analyzeFrameBatch(
  frames: { url: string; timestampSeconds: number }[],
  adContext: { title: string; description?: string | null; targetAudience?: string | null },
  policies: Pick<Policy, "name" | "category" | "rules" | "severity">[]
): Promise<FrameFinding[]> {
  const policyContext = policies.map(p =>
    `- ${p.name} (${p.category}, severity: ${p.severity}): ${JSON.stringify(p.rules)}`
  ).join("\n");

  // Use the compact prompt for frame analysis — full prompt is reserved for AI screening
  const compliancePrompt = generateCompactCompliancePrompt([FCC_FRAMEWORK, IAB_FRAMEWORK]);

  // Fetch all frame images server-side and encode as base64 data URLs.
  // This prevents OpenAI from needing to fetch private R2 URLs (which would 403).
  console.log(`[FrameAnalysis] Fetching ${frames.length} frame images for base64 encoding`);
  const base64Results = await Promise.all(frames.map(f => fetchToBase64(f.url)));
  const framesWithData = frames
    .map((f, i) => ({ ...f, dataUrl: base64Results[i] }))
    .filter(f => f.dataUrl !== null) as { url: string; timestampSeconds: number; dataUrl: string }[];

  if (framesWithData.length === 0) {
    throw new Error("All frame image fetches failed — cannot perform vision analysis");
  }
  if (framesWithData.length < frames.length) {
    console.warn(`[FrameAnalysis] ${frames.length - framesWithData.length} frame(s) could not be fetched and will be skipped`);
  }

  // Build multimodal message with all successfully-fetched frames
  const imageContents = framesWithData.map(frame => ({
    type: "image_url" as const,
    image_url: { url: frame.dataUrl, detail: "low" as const },
  }));

  const frameDescriptions = framesWithData.map((f, i) =>
    `Frame ${i + 1}: timestamp ${formatTimestamp(f.timestampSeconds)} (${f.timestampSeconds}s)`
  ).join("\n");

  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a video ad compliance reviewer. Analyze each frame for FCC/IAB policy violations. Flag real issues only — do not invent findings.

${compliancePrompt}
${policyContext ? `\nCustom policies:\n${policyContext}` : ""}
For each frame return: score (0–100, higher=safer), severity, brief description, and any issues with rule IDs. Safe frames get score 90–100 and empty issues array.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze these ${frames.length} frames from the video ad "${adContext.title}".
${adContext.description ? `Description: ${adContext.description}` : ""}
${adContext.targetAudience ? `Target Audience: ${adContext.targetAudience}` : ""}

Frame timestamps:
${frameDescriptions}

Analyze each frame and return structured results.`
            },
            ...imageContents
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "frame_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              frames: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    frameIndex: { type: "integer", description: "0-based index of the frame in the batch" },
                    score: { type: "integer", description: "Safety score 0-100" },
                    severity: { type: "string", enum: ["safe", "info", "warning", "critical", "blocking"] },
                    description: { type: "string", description: "Brief description of what is visible in this frame" },
                    issues: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          category: { type: "string", description: "Issue category (e.g., nudity, violence, misleading, trademark)" },
                          description: { type: "string", description: "Specific description of the issue" },
                          severity: { type: "string", enum: ["info", "warning", "critical", "blocking"] },
                          confidence: { type: "integer", description: "Confidence in this finding 0-100" },
                          policyArea: { type: "string", description: "Which policy area this violates" }
                        },
                        required: ["category", "description", "severity", "confidence", "policyArea"],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ["frameIndex", "score", "severity", "description", "issues"],
                  additionalProperties: false
                }
              },
              summary: { type: "string", description: "Overall summary of the frame-by-frame analysis" }
            },
            required: ["frames", "summary"],
            additionalProperties: false
          }
        }
      }
    });

    const content = result.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No content in LLM response");
    }

    const parsed = JSON.parse(content);

    // Map parsed results back to FrameFinding objects with timestamps
    return parsed.frames.map((f: any, idx: number) => {
      const frameInfo = framesWithData[f.frameIndex] || framesWithData[idx] || framesWithData[0];
      return {
        frameIndex: f.frameIndex,
        timestampSeconds: frameInfo.timestampSeconds,
        timestampFormatted: formatTimestamp(frameInfo.timestampSeconds),
        thumbnailUrl: frameInfo.url,
        score: f.score,
        severity: f.severity,
        issues: f.issues || [],
        description: f.description,
      } satisfies FrameFinding;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[FrameAnalysis] Batch analysis failed: ${msg}`);
    // Re-throw so the caller (batch loop) can apply retry logic
    throw error;
  }
}

/**
 * For uploaded video files, use the LLM's native video understanding.
 * The LLM can process video/mp4 files directly via file_url content type.
 */
async function analyzeUploadedVideo(
  fileUrl: string,
  adContext: { title: string; description?: string | null; targetAudience?: string | null },
  policies: Pick<Policy, "name" | "category" | "rules" | "severity">[]
): Promise<{ frames: FrameFinding[]; summary: string }> {
  const policyContext = policies.map(p =>
    `- ${p.name} (${p.category}, severity: ${p.severity}): ${JSON.stringify(p.rules)}`
  ).join("\n");

  // Generate FCC/IAB compliance context
  const compliancePrompt = generateCompliancePrompt([FCC_FRAMEWORK, IAB_FRAMEWORK]);

  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert video ad moderation AI performing TRUE FRAME-BY-FRAME analysis of a video advertisement.

CRITICAL INSTRUCTION: You must analyze this video at PER-SECOND granularity. For EVERY SECOND of the video, provide a frame finding. If the video is 30 seconds, you must return at least 30 frame entries. If it is 15 seconds, return at least 15. Do NOT skip seconds or summarize — every single second must be individually assessed.

For each second of the video, report:
1. The exact timestamp in seconds (0, 1, 2, 3... through the end of the video)
2. A safety/compliance score (0-100)
3. A severity classification
4. What is visually happening at that exact moment
5. Any FCC or IAB policy violations detected

REGULATORY FRAMEWORKS TO ASSESS AGAINST:

FCC BROADCAST COMPLIANCE (legally binding):
- Obscenity (18 U.S.C. § 1464) — sexually explicit content prohibited at all times
- Indecency (47 CFR § 73.3999) — patently offensive sexual/excretory content restricted to safe harbor
- Profanity — profane language/gestures in any visible text, signage, or lip-readable speech
- Violence/Gore — graphic violence, blood, injury, death, animal cruelty
- Subliminal messaging (FCC 1974 Public Notice) — single-frame insertions, sub-threshold content
- Tobacco ban (15 U.S.C. § 1335) — any tobacco/e-cigarette branding, logos, or imagery
- Emergency simulation (47 CFR § 73.1217) — fake EAS tones, simulated emergency alerts
- Disclosure legibility — fine print must be readable size, adequate contrast, on-screen ≥4 seconds
- Sponsorship ID (47 CFR § 73.1212) — sponsor identity must be clearly disclosed
- Children's protection — content appropriateness for child audiences
- CALM Act (47 CFR § 76.607) — audio loudness consistency

IAB DIGITAL ADVERTISING COMPLIANCE:
- GARM Brand Safety Floor — arms, hate speech, illegal drugs, terrorism, piracy imagery
- Ad creative quality — no fake UI elements, system notification spoofing, deceptive buttons
- LEAN principles — no seizure-inducing flashing >3Hz, non-invasive animation
- Truthfulness — no misleading demonstrations, deceptive before/after, unsubstantiated claims
- Photosensitivity (WCAG 2.3.1) — no rapid flashing, strobing, high-contrast transitions >3/sec
- Accessibility — text overlays must meet WCAG 4.5:1 contrast ratio minimum
- Inclusive representation — no harmful stereotypes or discriminatory imagery
- Native ad disclosure — 'Ad'/'Sponsored' label if content appears editorial

${compliancePrompt}

Custom policies:
${policyContext || "Use general advertising standards."}

REMEMBER: Return a finding for EVERY SECOND of the video. Completeness is mandatory.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this video ad "${adContext.title}" at per-second granularity.
${adContext.description ? `Description: ${adContext.description}` : ""}
${adContext.targetAudience ? `Target Audience: ${adContext.targetAudience}` : ""}

You MUST provide a finding for every single second from 0 through the end of the video.`
            },
            {
              type: "file_url",
              file_url: {
                url: fileUrl,
                mime_type: "video/mp4"
              }
            }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "video_frame_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              frames: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    timestampSeconds: { type: "integer", description: "Timestamp in seconds from video start" },
                    score: { type: "integer", description: "Safety score 0-100" },
                    severity: { type: "string", enum: ["safe", "info", "warning", "critical", "blocking"] },
                    description: { type: "string", description: "What is happening at this moment in the video" },
                    issues: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          category: { type: "string" },
                          description: { type: "string" },
                          severity: { type: "string", enum: ["info", "warning", "critical", "blocking"] },
                          confidence: { type: "integer" },
                          policyArea: { type: "string" }
                        },
                        required: ["category", "description", "severity", "confidence", "policyArea"],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ["timestampSeconds", "score", "severity", "description", "issues"],
                  additionalProperties: false
                }
              },
              summary: { type: "string", description: "Overall summary of the video analysis" }
            },
            required: ["frames", "summary"],
            additionalProperties: false
          }
        }
      }
    });

    const content = result.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No content in LLM response");
    }

    const parsed = JSON.parse(content);

    const frameFindingsFromVideo: FrameFinding[] = parsed.frames.map((f: any, idx: number) => ({
      frameIndex: idx,
      timestampSeconds: f.timestampSeconds,
      timestampFormatted: formatTimestamp(f.timestampSeconds),
      thumbnailUrl: "", // No individual frame URLs for uploaded videos
      score: f.score,
      severity: f.severity,
      issues: f.issues || [],
      description: f.description,
    }));

    return { frames: frameFindingsFromVideo, summary: parsed.summary };
  } catch (error) {
    console.error("[FrameAnalysis] Video analysis failed:", error);
    return {
      frames: [{
        frameIndex: 0,
        timestampSeconds: 0,
        timestampFormatted: "0:00",
        thumbnailUrl: "",
        score: 50,
        severity: "info",
        issues: [],
        description: "Video analysis could not be completed. Manual review required.",
      }],
      summary: "Video analysis failed. Manual review required."
    };
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

import {
  extractFramesFromUpload,
  extractFramesFromUrl,
  uploadFramesToStorage,
  readFramesAsBase64,
  cleanupJobDir,
  type FrameExtractionResult,
} from "./frameExtraction";

/**
 * Run frame-by-frame analysis using REAL frame extraction.
 * 
 * Pipeline:
 * 1. Download video (from S3 for uploads, yt-dlp for YouTube/Vimeo)
 * 2. Extract actual frames with ffmpeg at the specified interval
 * 3. Upload frame JPEGs to S3
 * 4. Send real frame images to vision model for FCC/IAB compliance analysis
 * 5. Return per-frame findings with exact timestamps and frame URLs
 */
/**
 * Derive a sensible default frame interval from video duration.
 * - < 120s  → every 1s  (1fps — up to 120 frames, covers broadcast spots in full detail)
 * - 120-300s → every 2s
 * - > 300s  → every 5s
 */
function defaultIntervalForDuration(durationSeconds: number): number {
  if (durationSeconds < 120) return 1;
  if (durationSeconds <= 300) return 2;
  return 5;
}

export async function runFrameAnalysis(
  ad: FrameAnalysisRequest,
  policies: Pick<Policy, "name" | "category" | "rules" | "severity">[],
  intervalSeconds?: number
): Promise<FrameAnalysisResult> {
  // Resolve interval: use caller's override if provided, else derive from duration
  const durationSeconds = parseDurationToSeconds(ad.videoDuration);
  const resolvedInterval = intervalSeconds ?? defaultIntervalForDuration(durationSeconds);

  let allFrames: FrameFinding[] = [];
  let summary = "";
  let extractionResult: FrameExtractionResult | null = null;

  try {
    // ─── Step 1: Extract real frames using ffmpeg ─────────────────────
    if (ad.sourceType === "youtube" && ad.sourceUrl) {
      console.log(`[FrameAnalysis] Extracting frames from YouTube: ${ad.sourceUrl}`);
      extractionResult = await extractFramesFromUrl(
        ad.sourceUrl, ad.adId, "youtube", resolvedInterval
      );
    } else if (ad.sourceType === "vimeo" && ad.sourceUrl) {
      console.log(`[FrameAnalysis] Extracting frames from Vimeo: ${ad.sourceUrl}`);
      extractionResult = await extractFramesFromUrl(
        ad.sourceUrl, ad.adId, "vimeo", resolvedInterval
      );
    } else if (ad.sourceType === "direct_url" && ad.sourceUrl) {
      console.log(`[FrameAnalysis] Extracting frames from URL: ${ad.sourceUrl}`);
      extractionResult = await extractFramesFromUrl(
        ad.sourceUrl, ad.adId, "direct", resolvedInterval
      );
    } else if (ad.fileUrl && ad.format === "video") {
      console.log(`[FrameAnalysis] Extracting frames from upload: fileKey=${ad.fileKey ?? "(none)"} fileUrl=${(ad.fileUrl ?? "").slice(0, 80)}... interval=${resolvedInterval}s`);
      extractionResult = await extractFramesFromUpload(
        ad.fileUrl, ad.adId, resolvedInterval, ad.fileKey
      );
    } else if (ad.fileUrl && ad.format === "image") {
      // Single image: analyze as one frame (no ffmpeg needed)
      allFrames = await analyzeFrameBatch(
        [{ url: ad.fileUrl, timestampSeconds: 0 }],
        { title: ad.title, description: ad.description, targetAudience: ad.targetAudience },
        policies
      );
      summary = "Analyzed single image frame.";

      const flaggedFrames = allFrames.filter(f => f.severity !== "safe" && f.issues.length > 0);
      const avgScore = allFrames.length > 0
        ? Math.round(allFrames.reduce((sum, f) => sum + f.score, 0) / allFrames.length)
        : 50;
      const worstFrame = allFrames[0] || { score: 100, timestampFormatted: null, description: null };

      return {
        adId: ad.adId,
        totalFramesAnalyzed: allFrames.length,
        analysisIntervalSeconds: resolvedInterval,
        overallVideoScore: avgScore,
        flaggedFrameCount: flaggedFrames.length,
        frames: allFrames,
        summary,
        worstTimestamp: worstFrame?.timestampFormatted || null,
        worstIssue: worstFrame?.issues?.[0]?.description || null,
        status: "completed",
      };
    } else {
      return {
        adId: ad.adId,
        totalFramesAnalyzed: 0,
        analysisIntervalSeconds: resolvedInterval,
        overallVideoScore: 50,
        flaggedFrameCount: 0,
        frames: [],
        summary: "No visual content available for frame analysis.",
        worstTimestamp: null,
        worstIssue: null,
        status: "failed",
      };
    }

    // ─── Step 2: Analyze extracted frames with vision model ──────────
    if (extractionResult && extractionResult.frames.length > 0) {
      console.log(`[FrameAnalysis] Analyzing ${extractionResult.frames.length} extracted frames`);

      // Read frames as base64 directly from disk — avoids the S3 HTTP round-trip
      // that was the primary failure point (presigned URL issues, network latency).
      // This must happen BEFORE cleanupJobDir().
      let frameUrls: { url: string; timestampSeconds: number }[];
      if (extractionResult.localFramePaths.length > 0) {
        console.log(`[FrameAnalysis] Reading ${extractionResult.localFramePaths.length} frames from disk as base64`);
        const base64Frames = readFramesAsBase64(extractionResult.localFramePaths);
        frameUrls = base64Frames.map(f => ({ url: f.base64DataUrl, timestampSeconds: f.timestampSeconds }));
        console.log(`[FrameAnalysis] Base64 encoding complete — ${frameUrls.length} frames ready for analysis`);

        // Fire S3 upload in the background (for UI thumbnails). Does NOT block analysis.
        uploadFramesToStorage(extractionResult.localFramePaths, ad.adId, extractionResult.probe)
          .then(uploaded => {
            // Patch the S3 URLs back into extractionResult.frames for the caller
            uploaded.forEach((f, i) => {
              if (extractionResult!.frames[i]) {
                extractionResult!.frames[i].url = f.url;
                extractionResult!.frames[i].key = f.key;
              }
            });
            console.log(`[FrameAnalysis] Background S3 upload complete: ${uploaded.length} frames`);
          })
          .catch(err => console.error(`[FrameAnalysis] Background S3 upload failed (non-fatal):`, err))
          .finally(() => {
            // Clean up the job directory only after upload is done (or failed)
            if (extractionResult!.jobDir) {
              cleanupJobDir(extractionResult!.jobDir);
              console.log(`[FrameAnalysis] Job directory cleaned up: ${extractionResult!.jobDir}`);
            }
          });
      } else {
        // YouTube/thumbnail path: already have public URLs, no disk files
        frameUrls = extractionResult.frames.map(f => ({
          url: f.url,
          timestampSeconds: f.timestampSeconds,
        }));
      }

      // Process in batches of 10 frames. No inter-batch delay — with adaptive intervals
      // a 30s ad produces ~6 frames total (1 batch). Delay is added only on 429 retry.
      const batchSize = 10;
      for (let i = 0; i < frameUrls.length; i += batchSize) {

        const batch = frameUrls.slice(i, i + batchSize);
        const batchCtx = { title: ad.title, description: ad.description, targetAudience: ad.targetAudience };

        let batchResults: FrameFinding[];
        try {
          batchResults = await analyzeFrameBatch(batch, batchCtx, policies);
        } catch (batchErr) {
          const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
          console.error(`[FrameAnalysis] Batch ${Math.floor(i / batchSize) + 1} failed: ${errMsg} — using fallback scores`);
          batchResults = batch.map((frame, batchIdx) => ({
            frameIndex: i + batchIdx,
            timestampSeconds: frame.timestampSeconds,
            timestampFormatted: formatTimestamp(frame.timestampSeconds),
            thumbnailUrl: frame.url,
            score: 50,
            severity: "info" as const,
            issues: [],
            description: `Frame analysis failed: ${errMsg}`,
          }));
        }

        // Ensure each frame result has the correct timestamp.
        // Use the S3 URL for thumbnailUrl only if it's already been populated
        // (S3 upload may still be in progress); fall back to whatever the batch set.
        const enrichedResults = batchResults.map((finding, batchIdx) => {
          const sourceFrame = extractionResult!.frames[i + batchIdx];
          const s3Url = sourceFrame?.url || "";
          return {
            ...finding,
            thumbnailUrl: s3Url || finding.thumbnailUrl,
            timestampSeconds: sourceFrame?.timestampSeconds ?? finding.timestampSeconds,
            timestampFormatted: formatTimestamp(sourceFrame?.timestampSeconds ?? finding.timestampSeconds),
          };
        });

        allFrames.push(...enrichedResults);
        console.log(`[FrameAnalysis] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(frameUrls.length / batchSize)} complete — ${allFrames.length}/${frameUrls.length} frames processed`);
      }

      const probe = extractionResult.probe;
      summary = `Analyzed ${allFrames.length} frames from ${probe.durationSeconds.toFixed(1)}s video ` +
        `(${probe.width}x${probe.height}, ${probe.codec}) at ${resolvedInterval}s intervals using ffmpeg extraction.`;
    }

    // ─── Step 3: Calculate aggregate scores ──────────────────────────
    const flaggedFrames = allFrames.filter(f => f.severity !== "safe" && f.issues.length > 0);
    const avgScore = allFrames.length > 0
      ? Math.round(allFrames.reduce((sum, f) => sum + f.score, 0) / allFrames.length)
      : 50;

    const worstFrame = allFrames.reduce((worst, f) =>
      f.score < worst.score ? f : worst, allFrames[0] || { score: 100, timestampFormatted: null, issues: [] });

    return {
      adId: ad.adId,
      totalFramesAnalyzed: allFrames.length,
      analysisIntervalSeconds: resolvedInterval,
      overallVideoScore: avgScore,
      flaggedFrameCount: flaggedFrames.length,
      frames: allFrames,
      summary: summary + (flaggedFrames.length > 0
        ? ` Found ${flaggedFrames.length} frames with potential issues.`
        : " No issues detected across analyzed frames."),
      worstTimestamp: worstFrame?.timestampFormatted || null,
      worstIssue: worstFrame?.issues?.[0]?.description || null,
      status: "completed",
    };
  } catch (error) {
    console.error("[FrameAnalysis] Analysis failed:", error);
    return {
      adId: ad.adId,
      totalFramesAnalyzed: allFrames.length,
      analysisIntervalSeconds: resolvedInterval,
      overallVideoScore: 50,
      flaggedFrameCount: 0,
      frames: allFrames,
      summary: `Frame analysis failed: ${error instanceof Error ? error.message : "Unknown error"}. Manual review recommended.`,
      worstTimestamp: null,
      worstIssue: null,
      status: "partial",
    };
  }
}

// ─── Exported Utilities ─────────────────────────────────────────────────────

export { parseDurationToSeconds, formatTimestamp, getYouTubeFrameUrls, getVimeoFrameUrls };
