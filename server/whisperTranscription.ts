/**
 * OpenAI Whisper Transcription
 *
 * Extracts the audio track from a video file (S3 key or local path) using
 * ffmpeg, then sends it to OpenAI's Whisper API with segment-level timestamps.
 * Returns a structured transcript suitable for alignment with Gemini findings.
 *
 * Uses raw fetch (no openai npm package) consistent with the rest of the codebase.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { nanoid } from "nanoid";
import { ENV } from "./_core/env";
import { storageDownloadBuffer } from "./storage";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Transcribed text for this segment */
  text: string;
}

export interface WhisperTranscriptResult {
  /** All timestamped segments */
  segments: TranscriptSegment[];
  /** Full transcript concatenated */
  fullText: string;
  /** Language Whisper detected (e.g. "en") */
  language: string;
  /** Total audio duration in seconds */
  durationSeconds: number;
}

export interface WhisperInput {
  /** S3/R2 object key — downloaded to temp file before transcription */
  fileKey?: string | null;
  /** Local filesystem path to a video file */
  localPath?: string | null;
  /** Ad title for log messages */
  adTitle?: string;
}

// ─── Audio extraction ─────────────────────────────────────────────────────────

async function extractAudio(videoPath: string, outDir: string): Promise<string> {
  const outFile = path.join(outDir, "audio.mp3");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-vn",          // no video
    "-ac", "1",     // mono
    "-ar", "16000", // 16 kHz — Whisper's native rate
    "-b:a", "64k",  // small file, adequate for speech
    "-f", "mp3",
    outFile,
  ], { timeout: 120_000 });
  return outFile;
}

// ─── Whisper API call via fetch ───────────────────────────────────────────────

async function callWhisper(audioPath: string): Promise<WhisperTranscriptResult> {
  if (!ENV.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set. Required for Whisper transcription.");
  }

  const audioBuffer = fs.readFileSync(audioPath);
  const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });

  const form = new FormData();
  form.append("file", audioBlob, "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.openaiApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "(no body)");
    throw new Error(`Whisper API failed: HTTP ${res.status} — ${errorText}`);
  }

  const raw = (await res.json()) as any;
  const rawSegments: any[] = raw.segments ?? [];

  const segments: TranscriptSegment[] = rawSegments.map((s: any) => ({
    start: typeof s.start === "number" ? s.start : 0,
    end: typeof s.end === "number" ? s.end : 0,
    text: String(s.text ?? "").trim(),
  }));

  return {
    segments,
    fullText: (raw.text ?? segments.map((s) => s.text).join(" ")).trim(),
    language: raw.language ?? "unknown",
    durationSeconds: raw.duration ?? (segments.length > 0 ? segments[segments.length - 1].end : 0),
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function transcribeVideoAudio(
  input: WhisperInput,
): Promise<WhisperTranscriptResult> {
  const { fileKey, localPath, adTitle = "unknown" } = input;

  if (!fileKey && !localPath) {
    throw new Error("WhisperInput requires at least one of: fileKey or localPath");
  }

  const tempDir = path.join(os.tmpdir(), `whisper-${nanoid(8)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    let videoPath: string;

    if (fileKey) {
      console.log(`[Whisper] S3 download: "${adTitle}" key=${fileKey}`);
      const buffer = await storageDownloadBuffer(fileKey);
      if (!buffer || buffer.length === 0) {
        throw new Error(`S3 download returned empty buffer for key "${fileKey}"`);
      }
      videoPath = path.join(tempDir, "video.mp4");
      fs.writeFileSync(videoPath, buffer);
    } else {
      // localPath already exists on disk — use it directly
      videoPath = localPath!;
    }

    console.log(`[Whisper] Extracting audio from "${adTitle}"…`);
    const audioPath = await extractAudio(videoPath, tempDir);
    const audioSize = fs.statSync(audioPath).size;
    console.log(`[Whisper] Audio extracted: ${(audioSize / 1024).toFixed(0)} KB`);

    console.log(`[Whisper] Sending to Whisper API…`);
    const result = await callWhisper(audioPath);
    console.log(
      `[Whisper] Transcription complete: ${result.segments.length} segments, ` +
      `${result.durationSeconds.toFixed(1)}s, lang=${result.language}`,
    );

    return result;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}
