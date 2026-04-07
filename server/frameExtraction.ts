/**
 * Frame Extraction Pipeline
 * 
 * Uses ffmpeg to extract actual frames from video files at configurable intervals.
 * Supports:
 * - Uploaded video files (MP4, MOV, WebM, AVI, ProRes)
 * - Downloaded videos from URLs (YouTube, Vimeo, direct via yt-dlp)
 * 
 * Each frame is saved as a JPEG, uploaded to S3, and its URL is returned
 * for AI vision analysis.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { storagePut, storageGetSignedUrl, storageDownloadBuffer } from "./storage";
import { nanoid } from "nanoid";

const execFileAsync = promisify(execFile);

// ─── Configuration ──────────────────────────────────────────────────────

const FRAME_DIR = process.env.FRAME_EXTRACT_DIR || "/tmp/admod-frames";
const MAX_FRAMES = parseInt(process.env.MAX_FRAMES_PER_VIDEO || "120");
const FRAME_QUALITY = process.env.FRAME_QUALITY || "2";

// ─── Types ──────────────────────────────────────────────────────────────

export interface ExtractedFrame {
  /** Absolute path to the frame JPEG on disk */
  localPath: string;
  /** Public URL after upload to S3 */
  url: string;
  /** S3 key */
  key: string;
  /** Timestamp in seconds from video start */
  timestampSeconds: number;
  /** Formatted timestamp (M:SS or H:MM:SS) */
  timestampFormatted: string;
  /** Frame index (0-based) */
  frameIndex: number;
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
}

export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  format: string;
  fileSize: number;
  hasAudio: boolean;
  audioCodec: string | null;
}

export interface FrameExtractionResult {
  frames: ExtractedFrame[];
  probe: VideoProbeResult;
  totalFramesExtracted: number;
  intervalSeconds: number;
  /** Path to the local video file (for cleanup) */
  localVideoPath: string | null;
  /**
   * Local disk paths of the extracted JPEG files, available until the job
   * directory is cleaned up. Used to read base64 data before S3 round-trips.
   * Only populated when frames were extracted via ffmpeg (upload/url paths).
   */
  localFramePaths: { path: string; timestampSeconds: number }[];
  /** Job directory that must be cleaned up after the caller is done with local files */
  jobDir: string | null;
}

// ─── Utilities ──────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Generate a unique working directory for this extraction job
 */
function createJobDir(): string {
  const jobId = nanoid(12);
  const jobDir = path.join(FRAME_DIR, `job-${jobId}`);
  ensureDir(jobDir);
  return jobDir;
}

/**
 * Clean up a job directory and all its contents
 */
export function cleanupJobDir(jobDir: string): void {
  try {
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[FrameExtraction] Failed to clean up ${jobDir}:`, err);
  }
}

/**
 * Read extracted JPEG frames from disk and return them as base64 data URLs.
 *
 * Call this BEFORE cleanupJobDir() to avoid S3 round-trips in the analysis path.
 * The returned data URLs are passed directly to the vision model.
 */
export function readFramesAsBase64(
  localFrames: { path: string; timestampSeconds: number }[],
): { base64DataUrl: string; timestampSeconds: number }[] {
  return localFrames.map(frame => {
    const buf = fs.readFileSync(frame.path);
    return {
      base64DataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
      timestampSeconds: frame.timestampSeconds,
    };
  });
}

// ─── Video Probing ──────────────────────────────────────────────────────

/**
 * Use ffprobe to get video metadata: duration, resolution, fps, codecs.
 */
export async function probeVideo(videoPath: string): Promise<VideoProbeResult> {
  console.log(`[FrameExtraction] ffprobe probing: ${videoPath}`);
  const t0 = Date.now();
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ]);
  console.log(`[FrameExtraction] ffprobe done in ${Date.now() - t0}ms`);

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((s: any) => s.codec_type === "video");
  const audioStream = data.streams?.find((s: any) => s.codec_type === "audio");
  const format = data.format || {};

  if (!videoStream) {
    throw new Error("No video stream found in file");
  }

  // Parse FPS from r_frame_rate (e.g., "30000/1001" or "30/1")
  let fps = 30;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    fps = den ? num / den : num;
  }

  return {
    durationSeconds: parseFloat(format.duration || videoStream.duration || "0"),
    width: videoStream.width || 1920,
    height: videoStream.height || 1080,
    fps: Math.round(fps * 100) / 100,
    codec: videoStream.codec_name || "unknown",
    format: format.format_name || "unknown",
    fileSize: parseInt(format.size || "0"),
    hasAudio: !!audioStream,
    audioCodec: audioStream?.codec_name || null,
  };
}

// ─── Frame Extraction ───────────────────────────────────────────────────

/**
 * Extract frames from a local video file at the specified interval.
 * 
 * Uses ffmpeg's fps filter for precise frame extraction.
 * For a 30-second video at 1-second intervals, this extracts exactly 30 frames.
 * 
 * @param videoPath - Absolute path to the video file
 * @param intervalSeconds - Time between frames (1 = every second, 0.5 = every half second)
 * @param outputDir - Directory to write frame JPEGs into
 * @returns Array of local frame file paths with timestamps
 */
export async function extractFramesFromFile(
  videoPath: string,
  intervalSeconds: number = 1,
  outputDir?: string,
): Promise<{ localFrames: { path: string; timestampSeconds: number }[]; probe: VideoProbeResult }> {
  const probe = await probeVideo(videoPath);
  const jobDir = outputDir || createJobDir();
  ensureDir(jobDir);

  // Calculate how many frames we'll extract
  const totalPossibleFrames = Math.ceil(probe.durationSeconds / intervalSeconds);
  const framesToExtract = Math.min(totalPossibleFrames, MAX_FRAMES);
  
  // Adjust interval if we'd exceed MAX_FRAMES
  const effectiveInterval = framesToExtract < totalPossibleFrames
    ? probe.durationSeconds / framesToExtract
    : intervalSeconds;

  console.log(`[FrameExtraction] Extracting ${framesToExtract} frames from ${probe.durationSeconds.toFixed(1)}s video (every ${effectiveInterval.toFixed(2)}s)`);

  // ffmpeg command: extract frames at the specified fps rate
  const fpsRate = 1 / effectiveInterval;
  const ffmpegCmd = ["ffmpeg", "-i", videoPath, "-vf", `fps=${fpsRate}`, "-q:v", FRAME_QUALITY, "-frames:v", String(framesToExtract), "-y", path.join(jobDir, "frame_%05d.jpg")];
  console.log(`[FrameExtraction] ffmpeg extracting ${framesToExtract} frames at ${fpsRate.toFixed(4)}fps: ${ffmpegCmd.join(" ")}`);
  const t1 = Date.now();
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", `fps=${fpsRate}`,
    "-q:v", FRAME_QUALITY,
    "-frames:v", String(framesToExtract),
    "-y",
    path.join(jobDir, "frame_%05d.jpg"),
  ], {
    timeout: Math.round(Math.max(30_000, probe.durationSeconds * 2_000)),
  });
  console.log(`[FrameExtraction] ffmpeg done in ${Date.now() - t1}ms`);

  // Read extracted frame files and calculate timestamps
  const frameFiles = fs.readdirSync(jobDir)
    .filter(f => f.startsWith("frame_") && f.endsWith(".jpg"))
    .sort();

  const localFrames = frameFiles.map((file, index) => ({
    path: path.join(jobDir, file),
    timestampSeconds: Math.round(index * effectiveInterval * 100) / 100,
  }));

  console.log(`[FrameExtraction] Extracted ${localFrames.length} frames to ${jobDir}`);

  return { localFrames, probe };
}

// ─── Video Download ─────────────────────────────────────────────────────

/**
 * Check if yt-dlp is available on the system.
 */
async function isYtDlpAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["yt-dlp"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a video from a URL using yt-dlp (supports YouTube, Vimeo, and 1000+ sites).
 * Falls back to direct HTTP download for direct video URLs.
 * 
 * @returns Path to the downloaded video file
 */
export async function downloadVideo(
  url: string,
  outputDir: string,
  provider?: "youtube" | "vimeo" | "direct" | "unknown",
): Promise<string> {
  const outputPath = path.join(outputDir, "source_video.mp4");

  if (provider === "direct" || !(await isYtDlpAvailable())) {
    // Direct HTTP download
    console.log(`[FrameExtraction] Direct HTTP downloading: ${url.slice(0, 120)}...`);
    const t3 = Date.now();
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[FrameExtraction] Direct download failed: HTTP ${response.status} ${response.statusText} for ${url.slice(0, 120)}`);
      throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    console.log(`[FrameExtraction] Direct download done in ${Date.now() - t3}ms — ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${outputPath}`);
    return outputPath;
  }

  // Use yt-dlp for YouTube, Vimeo, and other supported sites
  console.log(`[FrameExtraction] yt-dlp downloading: ${url}`);
  const t2 = Date.now();
  try {
    await execFileAsync("yt-dlp", [
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--socket-timeout", "30",
      "--max-filesize", "500M",
      "-o", outputPath,
      url,
    ], { timeout: 180_000 });
    console.log(`[FrameExtraction] yt-dlp done in ${Date.now() - t2}ms`);
  } catch (err: any) {
    console.error(`[FrameExtraction] yt-dlp failed after ${Date.now() - t2}ms: ${err.message}`);
    // If yt-dlp fails, try direct download as fallback
    console.warn(`[FrameExtraction] Falling back to direct HTTP download`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Both yt-dlp and direct download failed for: ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Download produced no output file for: ${url}`);
  }

  const stat = fs.statSync(outputPath);
  console.log(`[FrameExtraction] Downloaded ${(stat.size / 1024 / 1024).toFixed(1)}MB to ${outputPath}`);
  return outputPath;
}

/**
 * Download a video file directly from R2/S3 storage using the AWS SDK.
 * Bypasses HTTP/presigned-URL entirely — works for private buckets with no public URL.
 *
 * @param fileKey - The S3/R2 object key (e.g. "uploads/ad-4/video.mp4")
 * @param outputDir - Directory to write the downloaded file into
 * @returns Absolute path to the downloaded file
 */
export async function downloadVideoFromKey(fileKey: string, outputDir: string): Promise<string> {
  const outputPath = path.join(outputDir, "source_video.mp4");
  console.log(`[FrameExtraction] SDK download: key="${fileKey}" → ${outputPath}`);
  const t = Date.now();

  const buffer = await storageDownloadBuffer(fileKey);
  if (!buffer || buffer.length === 0) {
    throw new Error(`storageDownloadBuffer returned empty buffer for key "${fileKey}"`);
  }

  fs.writeFileSync(outputPath, buffer);
  console.log(`[FrameExtraction] SDK download done in ${Date.now() - t}ms — ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${outputPath}`);
  return outputPath;
}

// ─── Upload Frames to S3 ───────────────────────────────────────────────

/**
 * Upload extracted frame JPEGs to S3 and return public URLs.
 * 
 * @param localFrames - Array of { path, timestampSeconds } from extraction
 * @param adId - Ad submission ID (for organizing in S3)
 * @param probe - Video probe result for dimensions
 * @returns Array of ExtractedFrame with S3 URLs
 */
export async function uploadFramesToStorage(
  localFrames: { path: string; timestampSeconds: number }[],
  adId: number,
  probe: VideoProbeResult,
): Promise<ExtractedFrame[]> {
  const batchId = nanoid(8);
  const uploadedFrames: ExtractedFrame[] = [];

  console.log(`[FrameExtraction] Uploading ${localFrames.length} frames to storage (batch size 10)...`);
  const uploadStart = Date.now();

  // Upload in parallel batches of 10 to avoid overwhelming S3
  const BATCH_SIZE = 10;
  for (let i = 0; i < localFrames.length; i += BATCH_SIZE) {
    const batch = localFrames.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (frame, batchIdx) => {
        const idx = i + batchIdx;
        const fileData = fs.readFileSync(frame.path);
        const s3Key = `frames/ad-${adId}/${batchId}/frame_${String(idx).padStart(5, "0")}.jpg`;

        console.log(`[FrameExtraction] Uploading frame ${idx + 1}/${localFrames.length} → ${s3Key}`);
        const { key } = await storagePut(s3Key, fileData, "image/jpeg");
        // Generate a presigned URL (1 hour) so OpenAI's vision API can fetch the frame
        const { url } = await storageGetSignedUrl(key, 3600);
        console.log(`[FrameExtraction] Frame ${idx + 1} uploaded → presigned URL generated`);

        return {
          localPath: frame.path,
          url,
          key,
          timestampSeconds: frame.timestampSeconds,
          timestampFormatted: formatTimestamp(frame.timestampSeconds),
          frameIndex: idx,
          width: probe.width,
          height: probe.height,
        } satisfies ExtractedFrame;
      })
    );
    uploadedFrames.push(...results);
  }

  console.log(`[FrameExtraction] Uploaded ${uploadedFrames.length} frames in ${Date.now() - uploadStart}ms`);
  return uploadedFrames;
}

// ─── Main Pipeline Entry Points ─────────────────────────────────────────

/**
 * Full pipeline for uploaded video files:
 * 1. Download the video (via SDK key if available, otherwise HTTP fetch)
 * 2. Probe the video for metadata
 * 3. Extract frames at the specified interval
 * 4. Upload frames to S3
 * 5. Return frame URLs for AI analysis
 * 6. Clean up local temp files
 *
 * @param fileUrl   - Public or presigned URL (used only if fileKey is absent)
 * @param adId      - Ad submission ID
 * @param intervalSeconds - Seconds between extracted frames
 * @param fileKey   - R2/S3 object key; when provided the file is downloaded via
 *                    the AWS SDK, bypassing any URL authentication issues.
 */
/**
 * Phase 1 of the upload pipeline: download + ffmpeg extraction only.
 *
 * Returns local frame paths and the job directory WITHOUT cleaning up, so the
 * caller can read frames as base64 before the S3 upload. The caller is
 * responsible for calling cleanupJobDir(result.jobDir) when done.
 *
 * Phase 2 (S3 upload) is handled separately by uploadFramesToStorage() so it
 * doesn't block the LLM analysis path.
 */
export async function extractFramesFromUpload(
  fileUrl: string,
  adId: number,
  intervalSeconds: number = 1,
  fileKey?: string | null,
): Promise<FrameExtractionResult> {
  ensureDir(FRAME_DIR);
  console.log(`[FrameExtraction] extractFramesFromUpload start: adId=${adId} fileKey=${fileKey ?? "(none)"} fileUrl=${fileUrl.slice(0, 80)}... intervalSeconds=${intervalSeconds}`);

  const jobDir = createJobDir();
  console.log(`[FrameExtraction] Job directory created: ${jobDir}`);

  try {
    // ── Step 1: Download video to local temp ──────────────────────────
    let videoPath: string;
    if (fileKey) {
      console.log(`[FrameExtraction] Step 1: Downloading via AWS SDK (fileKey="${fileKey}")`);
      videoPath = await downloadVideoFromKey(fileKey, jobDir);
    } else {
      console.log(`[FrameExtraction] Step 1: Downloading via HTTP fetch (no fileKey stored)`);
      videoPath = await downloadVideo(fileUrl, jobDir, "direct");
    }

    const stat = fs.statSync(videoPath);
    console.log(`[FrameExtraction] Step 1 complete: file at ${videoPath} size=${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    if (stat.size === 0) throw new Error(`Downloaded video file is empty: ${videoPath}`);

    // ── Step 2: Extract frames with ffmpeg ────────────────────────────
    console.log(`[FrameExtraction] Step 2: Extracting frames from ${videoPath}`);
    const { localFrames, probe } = await extractFramesFromFile(videoPath, intervalSeconds, jobDir);
    console.log(`[FrameExtraction] Step 2 complete: ${localFrames.length} frames extracted, duration=${probe.durationSeconds.toFixed(1)}s`);

    // Return WITHOUT uploading and WITHOUT cleanup — caller handles both.
    // Populate frames with placeholder URLs; the caller fills in real S3 URLs
    // after the async upload completes.
    const placeholderFrames: ExtractedFrame[] = localFrames.map((f, idx) => ({
      localPath: f.path,
      url: "",   // filled in after S3 upload
      key: "",   // filled in after S3 upload
      timestampSeconds: f.timestampSeconds,
      timestampFormatted: formatTimestamp(f.timestampSeconds),
      frameIndex: idx,
      width: probe.width,
      height: probe.height,
    }));

    return {
      frames: placeholderFrames,
      probe,
      totalFramesExtracted: localFrames.length,
      intervalSeconds,
      localVideoPath: videoPath,
      localFramePaths: localFrames,
      jobDir,
    };
  } catch (err) {
    // On failure clean up immediately since caller won't get a jobDir to clean
    cleanupJobDir(jobDir);
    throw err;
  }
}

/**
 * Full pipeline for YouTube/Vimeo/URL-based videos:
 * 1. Download the video using yt-dlp
 * 2. Probe for metadata
 * 3. Extract frames
 * 4. Upload to S3
 * 5. Clean up local temp files
 */
export async function extractFramesFromUrl(
  sourceUrl: string,
  adId: number,
  provider: "youtube" | "vimeo" | "direct" | "unknown" = "unknown",
  intervalSeconds: number = 1,
): Promise<FrameExtractionResult> {
  const jobDir = createJobDir();

  try {
    const videoPath = await downloadVideo(sourceUrl, jobDir, provider);
    const { localFrames, probe } = await extractFramesFromFile(videoPath, intervalSeconds, jobDir);

    // For URL-based videos the same local-first approach applies: return local
    // frame paths so the caller can read base64 before cleanup.
    const placeholderFrames: ExtractedFrame[] = localFrames.map((f, idx) => ({
      localPath: f.path,
      url: "",
      key: "",
      timestampSeconds: f.timestampSeconds,
      timestampFormatted: formatTimestamp(f.timestampSeconds),
      frameIndex: idx,
      width: probe.width,
      height: probe.height,
    }));

    return {
      frames: placeholderFrames,
      probe,
      totalFramesExtracted: localFrames.length,
      intervalSeconds,
      localVideoPath: videoPath,
      localFramePaths: localFrames,
      jobDir,
    };
  } catch (err) {
    cleanupJobDir(jobDir);
    throw err;
  }
}

/**
 * Extract a single frame at a specific timestamp (for re-analysis or thumbnail generation).
 */
export async function extractSingleFrame(
  videoPath: string,
  timestampSeconds: number,
  outputPath: string,
): Promise<string> {
  await execFileAsync("ffmpeg", [
    "-ss", String(timestampSeconds),
    "-i", videoPath,
    "-vframes", "1",
    "-q:v", FRAME_QUALITY,
    "-y",
    outputPath,
  ]);
  return outputPath;
}
