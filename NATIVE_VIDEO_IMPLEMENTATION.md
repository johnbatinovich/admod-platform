# AdMod: Native Video AI + Audio Analysis Implementation Guide

## For use with Claude Code

**Date:** March 31, 2026
**Stack:** Gemini 2.5 Pro (native video) + OpenAI Whisper (dedicated ASR)

---

## Part 1: Setup — Get Your API Keys (Do This First, ~10 minutes)

### Step 1: Get a Google AI Studio API Key

You do NOT need a full Google Cloud project. Google AI Studio gives you direct API access.

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Choose **"Create API key in new project"** (Google auto-creates a lightweight GCP project)
5. Copy the key — it starts with `AIza...`
6. **Test it immediately** in your terminal:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent" \
  -H "x-goog-api-key: YOUR_KEY_HERE" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{"contents": [{"parts":[{"text": "Say hello"}]}]}' 2>/dev/null | jq .
```

If you get a JSON response with `candidates`, you're good.

### Step 2: Add to Your .env

Add these new variables to your `.env` file:

```env
# ─── Gemini (Native Video AI) ────────────────────────────────────
GEMINI_API_KEY="AIza..."
GEMINI_MODEL="gemini-2.5-pro"

# ─── OpenAI Whisper (Dedicated ASR) ──────────────────────────────
# You already have OPENAI_API_KEY — Whisper uses the same key
# OPENAI_API_KEY="sk-..."   (already set)
WHISPER_MODEL="whisper-1"
```

### Step 3: Install the Google GenAI SDK

```bash
cd admod-platform
pnpm add @google/genai
```

That's it for setup. The rest is code.

---

## Part 2: Architecture — What You're Building

### Current Pipeline (Frame-Based)
```
Video → yt-dlp download → ffmpeg frame extraction → JPEG frames to S3 →
GPT-4o vision on each frame → aggregate scores → route
```

### New Pipeline (Native Video AI)
```
Video → Upload to Gemini Files API → Gemini 2.5 Pro analyzes full video+audio natively →
Whisper produces parallel time-aligned transcript → Fused evidence timeline →
Policy reasoning → Evidence package → Route
```

### Key Design Decisions

1. **Gemini is the primary analysis engine.** It processes the raw video file with audio natively — no frame extraction needed for the main analysis path.

2. **Whisper runs in parallel** as a dedicated transcript path. Even though Gemini can transcribe, a dedicated ASR gives you word-level timestamps, higher accuracy, and a separate evidence artifact for the audit trail.

3. **FFmpeg is demoted to a utility.** It's still used for: extracting audio tracks for Whisper, generating thumbnails for UI display, reading technical metadata via ffprobe, and targeted high-res frame extraction when the AI agent needs to read fine print.

4. **The existing LLM abstraction (`llm.ts`) is NOT used for Gemini.** Gemini's native video API is fundamentally different from chat completions — it accepts file references, not message arrays. You'll build a new `gemini.ts` provider alongside the existing `llm.ts`.

### New Files to Create

```
server/
├── providers/
│   ├── gemini.ts           # Gemini Files API + native video analysis
│   └── whisper.ts          # OpenAI Whisper ASR integration
├── nativeVideoAnalysis.ts  # Orchestrates Gemini + Whisper + evidence fusion
├── transcriptAnalysis.ts   # Processes Whisper output, builds transcript timeline
├── evidencePackage.ts      # Assembles timestamped evidence packages
├── audioExtraction.ts      # Uses ffmpeg to extract audio tracks for Whisper
└── (existing files remain — aiModeration.ts, frameAnalysis.ts, etc.)
```

### New Database Tables

```sql
-- Transcript segments from ASR
CREATE TABLE transcript_segments (
  id SERIAL PRIMARY KEY,
  ad_submission_id INTEGER NOT NULL REFERENCES ad_submissions(id) ON DELETE CASCADE,
  analysis_id INTEGER REFERENCES frame_analyses(id) ON DELETE CASCADE,
  start_time_ms INTEGER NOT NULL,
  end_time_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  confidence REAL,
  language VARCHAR(16),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Evidence items (timestamped findings from any source)
CREATE TABLE evidence_items (
  id SERIAL PRIMARY KEY,
  ad_submission_id INTEGER NOT NULL REFERENCES ad_submissions(id) ON DELETE CASCADE,
  analysis_id INTEGER REFERENCES frame_analyses(id) ON DELETE CASCADE,
  source VARCHAR(32) NOT NULL,     -- 'gemini_video', 'whisper_asr', 'ocr', 'ffmpeg_frame'
  evidence_type VARCHAR(64) NOT NULL, -- 'violation', 'disclosure', 'claim', 'brand', 'audio_event'
  start_time_ms INTEGER,
  end_time_ms INTEGER,
  content JSONB NOT NULL,           -- structured evidence data
  severity VARCHAR(16),
  rule_id VARCHAR(64),              -- links to specific FCC/IAB rule
  confidence REAL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_evidence_items_ad ON evidence_items(ad_submission_id);
CREATE INDEX idx_evidence_items_type ON evidence_items(evidence_type);
```

---

## Part 3: Implementation Spec for Claude Code

### Task 1: Gemini Provider (`server/providers/gemini.ts`)

**What it does:** Wraps the Google GenAI SDK for video file upload, processing, and structured analysis.

**Key behaviors:**
- Upload video files to Gemini Files API (supports up to 2GB)
- Poll for file processing completion (videos take time to tokenize server-side)
- Send video + compliance prompt → receive structured JSON analysis
- Support YouTube URLs directly (Gemini can accept YouTube URLs as `file_data`)
- Support video clipping (analyze specific time ranges)
- Handle retries for rate limits and transient errors

**SDK Pattern (JavaScript/TypeScript):**

```typescript
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Upload a video file
const uploadedFile = await ai.files.upload({
  file: "/path/to/video.mp4",
  config: { mimeType: "video/mp4" },
});

// Or for YouTube URLs — pass directly, no upload needed
const youtubeContents = [
  { fileData: { fileUri: "https://www.youtube.com/watch?v=VIDEO_ID" } },
  { text: "Your compliance analysis prompt here" },
];

// Analyze with structured output
const response = await ai.models.generateContent({
  model: "gemini-2.5-pro",
  contents: createUserContent([
    createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
    "Your compliance analysis prompt here",
  ]),
});
```

**Structured output approach:** Gemini supports JSON schema output via `responseMimeType: "application/json"` with a `responseSchema`. Use this for the compliance analysis response.

**The compliance prompt should ask Gemini to return:**
- Scene-by-scene summary with timestamps (MM:SS)
- Audio transcription with timestamps
- On-screen text / OCR with timestamps (text content, position, duration)
- Brand/logo detections with timestamps
- Content safety signals (nudity, violence, alcohol, tobacco, etc.)
- Disclosure/disclaimer detection (text, duration on screen, legibility assessment)
- Claims extraction (health claims, financial claims, savings claims, superlatives)
- Overall content classification (IAB content taxonomy)

### Task 2: Whisper ASR Provider (`server/providers/whisper.ts`)

**What it does:** Extracts audio from video, sends to OpenAI Whisper API, returns word-level transcript.

**Key behaviors:**
- Accept a video file path or S3 key
- Use ffmpeg to extract audio track as WAV/MP3
- Send audio to OpenAI Whisper API with `timestamp_granularities: ["word", "segment"]`
- Return structured transcript with word-level timing
- Handle long audio by chunking if needed (Whisper has a 25MB file limit)

**API Pattern:**

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(audioFilePath),
  model: "whisper-1",
  response_format: "verbose_json",
  timestamp_granularities: ["word", "segment"],
  language: "en", // optional — auto-detects if omitted
});

// Returns: { text, words: [{ word, start, end }], segments: [{ text, start, end }] }
```

### Task 3: Audio Extraction Utility (`server/audioExtraction.ts`)

**What it does:** Uses ffmpeg to extract audio tracks from video files for Whisper processing.

**Key behaviors:**
- Extract audio as WAV (16kHz mono — optimal for Whisper)
- Handle videos from: local file paths, S3 keys (download first), and URLs
- Chunk long audio files into <25MB segments for Whisper's file size limit
- Clean up temp files after processing

**ffmpeg command:**
```bash
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 output.wav
```

**CRITICAL:** Use `execFile()` or `spawn()` with argument arrays — NOT `exec()` with string interpolation. This fixes the command injection vulnerability (SEC-07).

### Task 4: Native Video Analysis Orchestrator (`server/nativeVideoAnalysis.ts`)

**What it does:** Orchestrates the full native video analysis pipeline, running Gemini and Whisper in parallel, then fusing results.

**Pipeline flow:**

```
1. Receive ad submission (video file or URL)
2. IN PARALLEL:
   a. Upload video to Gemini Files API → run compliance analysis
   b. Extract audio via ffmpeg → send to Whisper → get transcript
3. FUSE: Merge Gemini's timestamped findings with Whisper's word-level transcript
4. BUILD: Create unified evidence timeline
5. EVALUATE: Apply deterministic rules on extracted evidence
   (e.g., "disclosure must be on screen >= 3 seconds")
6. ASSEMBLE: Generate evidence package for reviewer
7. SCORE: Calculate compliance scores per FCC/IAB category
8. ROUTE: Apply confidence-based routing decision
```

**Key design:**
- Steps 2a and 2b run concurrently via `Promise.all()`
- The Gemini analysis IS the primary compliance engine — it replaces the old frame-by-frame GPT-4o vision calls
- The Whisper transcript is a parallel evidence artifact that enables transcript-specific checks
- The existing `complianceFrameworks.ts` rules and prompts are reused, but the prompt is restructured for native video context

### Task 5: Evidence Package Builder (`server/evidencePackage.ts`)

**What it does:** Assembles a reviewer-ready evidence package from all analysis sources.

**Evidence package structure:**

```typescript
interface EvidencePackage {
  adSubmissionId: number;
  analysisVersion: number;

  // Unified timeline — all findings merged chronologically
  timeline: TimelineEvent[];

  // Transcript
  transcript: TranscriptSegment[];
  transcriptLanguage: string;

  // On-screen text / OCR
  ocrFindings: OcrFinding[];

  // Compliance findings by category
  fccFindings: ComplianceFinding[];
  iabFindings: ComplianceFinding[];

  // Content intelligence
  detectedAdvertiser: { name: string; confidence: number; industry: string };
  detectedBrands: BrandDetection[];
  claimsExtracted: ClaimExtraction[];
  disclosures: DisclosureAnalysis[];

  // Scores
  overallScore: number;
  fccScore: number;
  iabScore: number;
  brandSafetyScore: number;

  // Routing
  routingDecision: "auto_approve" | "needs_review" | "auto_reject";
  routingReason: string;
  routingConfidence: number;
}
```

### Task 6: Integration Points — Where New Code Connects to Existing Code

**In `aiReviewPipeline.ts`:**
- The existing 3-stage pipeline structure STAYS. Stage 1 changes from "frame extraction + GPT-4o vision" to "native video analysis via Gemini + Whisper."
- Stage 2 (deep analysis) can still use the existing `analyzeAdContent()` for text-only or supplemental analysis.
- Stage 3 (routing decision) reuses existing `computeRoutingDecision()` logic.

**In `routers.ts`:**
- The `ads.create` auto-analysis path calls the new pipeline instead of `performAutoAnalysis()`.
- The manual `ads.runAiScreening` and `ads.runFrameAnalysis` endpoints get new sister endpoints for the native video path, or the existing ones are updated to use the new pipeline.

**In the frontend (`AdDetail.tsx`):**
- The frame timeline viewer is supplemented with a transcript viewer panel.
- Evidence items are displayed with timestamp-linked playback (click a finding → video jumps to that moment).

---

## Part 4: Claude Code Session Plan

### Session 1: Foundation (~2-3 hours)

Open Claude Code in the admod-platform directory and give it this prompt:

```
Read the full codebase structure, then:

1. Install @google/genai SDK: pnpm add @google/genai
2. Add GEMINI_API_KEY and GEMINI_MODEL to server/_core/env.ts
3. Update .env.example with the new Gemini and Whisper config variables
4. Create server/providers/gemini.ts:
   - Export a function uploadVideoToGemini(filePath: string, mimeType: string)
     that uses the Google GenAI SDK Files API to upload a video and wait for processing
   - Export a function analyzeVideoWithGemini(fileUri: string, mimeType: string, compliancePrompt: string)
     that sends the video to Gemini 2.5 Pro with a structured output schema
     for ad compliance analysis
   - Export a function analyzeYoutubeWithGemini(youtubeUrl: string, compliancePrompt: string)
     that passes a YouTube URL directly to Gemini (no download needed)
   - Include retry logic for rate limits (429) and transient errors (500/503)
   - Use the existing retry pattern from server/_core/llm.ts as reference
5. Create server/providers/whisper.ts:
   - Export a function transcribeAudio(audioFilePath: string)
     that sends an audio file to OpenAI Whisper API
     with response_format: "verbose_json" and timestamp_granularities: ["word", "segment"]
   - Return typed TranscriptResult with segments and word-level timing
6. Create server/audioExtraction.ts:
   - Export a function extractAudioFromVideo(videoPath: string, outputPath: string)
     that uses ffmpeg to extract audio as 16kHz mono WAV
   - CRITICAL: Use execFile() or spawn() with argument arrays, NOT exec() with string interpolation
   - Use the existing frameExtraction.ts as reference for ffmpeg patterns,
     but fix the command injection vulnerability
   - Handle cleanup of temp files
```

### Session 2: Pipeline Orchestration (~2-3 hours)

```
Now build the native video analysis orchestrator.

1. Create server/nativeVideoAnalysis.ts:
   - Import from providers/gemini.ts, providers/whisper.ts, audioExtraction.ts
   - Export async function runNativeVideoAnalysis(ad, policies)
   - The function should:
     a. Determine the video source (upload file key, YouTube URL, Vimeo URL, direct URL)
     b. For uploaded files: download from S3, upload to Gemini Files API
     c. For YouTube URLs: pass directly to Gemini (no download needed)
     d. For other URLs: download via yt-dlp first, then upload to Gemini
     e. Run Gemini analysis and Whisper transcription IN PARALLEL via Promise.all()
     f. Fuse the results into a unified evidence timeline
     g. Calculate compliance scores using the existing complianceFrameworks.ts scoring logic
     h. Return a NativeVideoAnalysisResult that is compatible with UnifiedReviewResult

2. Build the Gemini compliance prompt:
   - Use the existing FCC/IAB rules from complianceFrameworks.ts
   - Structure the prompt to ask for timestamped findings across all 11 categories
   - Request structured JSON output with the same schema structure as analyzeAdContent()
   - ALSO ask for: scene descriptions, on-screen text with timing, brand/logo detections,
     audio events, disclosure timing, claims extraction
   - The prompt should reference specific FCC/IAB rule IDs

3. Wire into the existing pipeline:
   - Update aiReviewPipeline.ts to use runNativeVideoAnalysis() as Stage 1
     when the ad is a video (format === "video" or has a video URL)
   - Keep the existing frame-based pipeline as a fallback for when Gemini is unavailable
   - Stage 2 and Stage 3 continue to work as-is
```

### Session 3: Database Schema + Evidence Model (~1-2 hours)

```
Add the transcript and evidence data model.

1. Add to drizzle/schema.ts:
   - transcriptSegments table (adSubmissionId, analysisId, startTimeMs, endTimeMs,
     text, speaker, confidence, language, createdAt)
   - evidenceItems table (adSubmissionId, analysisId, source, evidenceType,
     startTimeMs, endTimeMs, content as jsonb, severity, ruleId, confidence, createdAt)
   - Add proper indexes on adSubmissionId and evidenceType

2. Add DB functions to server/db.ts:
   - createTranscriptSegments(segments[]) — bulk insert
   - getTranscriptForAd(adSubmissionId)
   - createEvidenceItems(items[]) — bulk insert
   - getEvidenceForAd(adSubmissionId)

3. Generate and review the migration:
   - Run: pnpm run db:push
   - Review the generated SQL migration before applying

4. Update the analysis pipeline to persist transcript segments and evidence items
   to these new tables after each analysis run
```

### Session 4: Frontend — Transcript Viewer (~2-3 hours)

```
Add a transcript viewer and evidence panel to the ad detail page.

1. Add a new tRPC endpoint: ads.getTranscript (returns transcript segments for an ad)
2. Add a new tRPC endpoint: ads.getEvidence (returns evidence items for an ad)

3. In AdDetail.tsx (or ideally, extract into new components):
   - Create a TranscriptPanel component that displays the time-aligned transcript
   - Each segment should be clickable (clicking jumps to that timestamp if video is playing)
   - Highlight segments that have associated violations
   - Show speaker labels if available

4. Create an EvidencePanel component:
   - Display evidence items grouped by type (violations, disclosures, claims, brands)
   - Each item shows: timestamp, source (Gemini/Whisper/OCR), severity, description,
     related policy rule ID
   - Clicking an evidence item highlights the corresponding transcript segment
     and jumps the video to that timestamp

5. Update the existing ComplianceCategoryCard to link findings to evidence items
   when available (show "View Evidence" links that scroll to the evidence panel)
```

---

## Part 5: Testing Your Integration

### Manual Test Workflow

1. Start the dev server: `pnpm run dev`
2. Log in as admin
3. Submit a new ad with a YouTube URL (use a real ad — search "TV commercial 2025" on YouTube)
4. Watch the server logs — you should see:
   - `[Gemini] Uploading video...` or `[Gemini] Analyzing YouTube URL...`
   - `[Whisper] Extracting audio...`
   - `[Whisper] Transcribing...`
   - `[NativeVideo] Fusing results...`
   - `[UnifiedReview] Stage 1 complete: ...`
5. Check the ad detail page — you should see:
   - Compliance scores (from Gemini analysis, not frame-based)
   - A transcript panel with time-aligned text
   - Evidence items with timestamps

### Automated Test Ideas

```typescript
// server/nativeVideoAnalysis.test.ts

describe("Native Video Analysis", () => {
  it("should analyze a short video and return compliance scores", async () => {
    // Use a known-safe test video (create a 10-second test clip)
    const result = await runNativeVideoAnalysis(mockAd, mockPolicies);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(result.transcript).toBeDefined();
    expect(result.evidenceItems.length).toBeGreaterThanOrEqual(0);
  });

  it("should handle YouTube URLs without downloading", async () => {
    const mockYoutubeAd = { ...mockAd, sourceType: "url", sourceUrl: "https://www.youtube.com/watch?v=..." };
    const result = await runNativeVideoAnalysis(mockYoutubeAd, mockPolicies);
    expect(result.overallScore).toBeDefined();
  });

  it("should produce transcript segments with timestamps", async () => {
    const result = await runNativeVideoAnalysis(mockAd, mockPolicies);
    for (const seg of result.transcript) {
      expect(seg.startTimeMs).toBeLessThan(seg.endTimeMs);
      expect(seg.text.length).toBeGreaterThan(0);
    }
  });

  it("should never auto-approve without full analysis", async () => {
    // Ensure the false-confidence bug (AI-01) is fixed
    const result = await runNativeVideoAnalysis(mockAd, mockPolicies);
    if (result.routingDecision === "auto_approve") {
      expect(result.routingConfidence).toBeGreaterThanOrEqual(85);
      expect(result.deepAnalysisTriggered).toBe(true); // Stage 2 must have run
    }
  });
});
```

---

## Part 6: Cost Estimates

| Operation | Cost | Notes |
|-----------|------|-------|
| Gemini 2.5 Pro input | $1.25/1M tokens | Video: 1 sec ≈ 263 tokens. 30-sec ad ≈ 7,890 tokens ≈ $0.01 |
| Gemini 2.5 Pro output | $10.00/1M tokens | Structured JSON response ~2K tokens ≈ $0.02 |
| Whisper API | $0.006/minute | 30-sec ad ≈ $0.003 |
| **Total per 30-sec ad** | **~$0.03** | **vs. current: ~$0.45 for 30 GPT-4o vision frames** |

The native video approach is roughly **15x cheaper** than the current frame-by-frame pipeline while being significantly more capable (audio, temporal context, OCR).

---

## Summary: What to Tell Claude Code

When you open Claude Code, start with:

> "I'm building native video AI analysis for the AdMod ad moderation platform. Read the implementation spec at NATIVE_VIDEO_IMPLEMENTATION.md in the repo root, then start with Session 1: install the Google GenAI SDK, add env config, and build the Gemini and Whisper providers."

Then progress through Sessions 2, 3, and 4 in order. Each session builds on the previous one.
