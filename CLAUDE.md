# CLAUDE.md — AdMod Platform

## Project Overview

AdMod is an AI-powered broadcast ad moderation platform that automates Standards & Practices (S&P) ad clearance for media companies. It performs native multimodal video+audio analysis using AI vision models, assessing ads against FCC broadcast regulations and IAB digital advertising standards.

## Tech Stack

- **Frontend:** React 19 + Vite 7 + Tailwind 4 + shadcn/ui + tRPC client
- **Backend:** Express + tRPC v11 + TypeScript (ESM)
- **Database:** PostgreSQL via Drizzle ORM (schema in `drizzle/schema.ts`)
- **AI Providers:**
  - Google Gemini 2.5 Pro — primary native video+audio analysis (`@google/genai` SDK)
  - OpenAI GPT-4o — supplemental text analysis and structured output
  - OpenAI Whisper — dedicated ASR/transcript intelligence
  - Anthropic Claude — alternative LLM provider
- **Storage:** S3-compatible (AWS S3 / Cloudflare R2 / MinIO)
- **Media Tools:** ffmpeg (audio extraction, thumbnails, metadata), yt-dlp (video download)
- **Package Manager:** pnpm 10

## Key Commands

```bash
pnpm install          # Install dependencies
pnpm run dev          # Start dev server (tsx watch)
pnpm run build        # Production build (vite + esbuild)
pnpm run start        # Start production server
pnpm run check        # TypeScript type check
pnpm run test         # Run vitest tests
pnpm run db:push      # Generate and run Drizzle migrations
```

## Project Structure

```
server/
├── _core/
│   ├── index.ts          # Express server entry point
│   ├── auth.ts           # JWT auth + Google OAuth + admin bootstrap
│   ├── env.ts            # Environment config
│   ├── llm.ts            # Multi-provider LLM abstraction (OpenAI/Anthropic)
│   ├── trpc.ts           # tRPC router + auth middleware
│   ├── context.ts        # tRPC context creation
│   ├── cookies.ts        # Cookie config
│   └── vite.ts           # Vite dev middleware
├── providers/
│   ├── gemini.ts         # Google Gemini Files API + native video analysis
│   └── whisper.ts        # OpenAI Whisper ASR integration
├── routers.ts            # All tRPC procedure definitions (48+ endpoints)
├── db.ts                 # Database access functions
├── nativeVideoAnalysis.ts # Orchestrates Gemini + Whisper pipeline
├── aiReviewPipeline.ts   # 3-stage agentic review pipeline
├── aiModeration.ts       # AI content analysis + structured compliance scoring
├── frameAnalysis.ts      # Frame-by-frame analysis (legacy, now supplemental)
├── frameExtraction.ts    # ffmpeg frame extraction (now used for targeted extraction only)
├── audioExtraction.ts    # ffmpeg audio extraction for Whisper
├── transcriptAnalysis.ts # Processes Whisper output
├── evidencePackage.ts    # Assembles reviewer-ready evidence packages
├── complianceFrameworks.ts # FCC (20 rules) + IAB (18 rules) compliance definitions
├── storage.ts            # S3-compatible object storage
└── videoUrlParser.ts     # YouTube/Vimeo URL parsing

client/src/
├── pages/               # Route components
│   ├── AdDetail.tsx     # Main ad detail view (compliance, frames, transcript, evidence)
│   ├── AdSubmissions.tsx
│   ├── NewAd.tsx        # Ad submission form
│   ├── ReviewQueue.tsx
│   └── ...
├── components/          # Shared components + shadcn/ui
└── lib/                 # tRPC client, utils

drizzle/
├── schema.ts            # Full database schema (11+ tables)
└── migrations/          # SQL migration files

shared/                  # Shared types and constants
```

## Architecture: AI Analysis Pipeline

### Three-Stage Agentic Review Pipeline (`aiReviewPipeline.ts`)

**Stage 1 — Native Video Analysis (always runs for video content):**
- Upload video to Gemini Files API or pass YouTube URL directly
- Gemini 2.5 Pro analyzes full video+audio natively (scene understanding, OCR, audio events, compliance signals)
- Whisper produces parallel word-level transcript
- Results fused into unified evidence timeline

**Stage 2 — Deep Compliance Analysis (conditional):**
- Full FCC/IAB structured compliance scoring via `analyzeAdContent()`
- Triggered when: Stage 1 flags issues, regulated content detected, or video score < 80

**Stage 3 — Decision & Report (always runs):**
- Synthesizes all findings, generates moderator brief
- Applies confidence-based routing: auto-approve (≥85% confidence, clean), needs_review (default), auto-reject (≥90% confidence, blocking violations)

### Evidence Package Model

Every analysis produces a structured evidence package with:
- Timestamped findings linked to specific policy rules (FCC-XX-XXX / IAB-XX-XXX)
- Word-level transcript segments
- On-screen text / OCR timeline
- Brand/logo detections
- Disclosure timing analysis
- Claims extraction
- Content safety signals

## Important Rules

1. **NEVER use `exec()` with string interpolation for shell commands.** Always use `execFile()` or `spawn()` with argument arrays to prevent command injection.

2. **NEVER synthesize passing compliance scores when analysis hasn't run.** If analysis is skipped or fails, set `score: null` and `status: "skipped"` or `status: "failed"`.

3. **All database queries must be tenant-scoped** (when multi-tenancy is implemented). Never return data across organization boundaries.

4. **Gemini video analysis is the PRIMARY analysis path.** Frame-based analysis (frameAnalysis.ts) is a FALLBACK for when Gemini is unavailable. Do not default to frame extraction.

5. **Whisper transcripts are SEPARATE evidence artifacts.** Store them in the `transcript_segments` table, not embedded in JSON columns.

6. **Use Zod to validate ALL LLM responses** before persisting to database. Never trust raw JSON.parse() output from any model.

## Environment Variables

See `.env.example` for the full list. Key ones:
- `DATABASE_URL` — PostgreSQL connection string
- `GEMINI_API_KEY` — Google AI Studio key for Gemini 2.5 Pro
- `OPENAI_API_KEY` — For Whisper ASR and GPT-4o
- `ANTHROPIC_API_KEY` — Alternative LLM provider
- `S3_*` — Object storage credentials
- `JWT_SECRET` — Auth token signing

## Testing

Tests are in `server/*.test.ts` using vitest. Run with `pnpm run test`.
Focus test coverage on: compliance score calculation, routing decision logic, video URL parsing, transcript processing, and evidence assembly.
