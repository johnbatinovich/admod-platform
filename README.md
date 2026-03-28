# AdMod — AI-Powered Broadcast Ad Moderation Platform

AdMod automates Standards & Practices (S&P) ad clearance for broadcast media companies. It performs **real frame-by-frame video analysis** using ffmpeg extraction and AI vision models, assessing every second of an ad spot against **FCC broadcast regulations** and **IAB digital advertising standards**.

## What It Does

- **Frame-by-frame extraction** — Uses ffmpeg to extract actual JPEG frames at 1-second intervals from any video (uploads, YouTube, Vimeo, direct URLs via yt-dlp)
- **FCC compliance scoring** — 5 regulatory categories (Content Standards, Disclosure & Transparency, Prohibited Practices, Children's Protections, Product-Specific) with 20 individual rules
- **IAB compliance scoring** — 6 standards categories (Content Taxonomy/GARM, Creative Standards/LEAN, Truthfulness, Privacy, Accessibility, Sector-Specific) with 18 individual rules
- **Exact frame identification** — When a violation is found, the system identifies the specific frame and timestamp, with a clickable thumbnail in the UI
- **Multi-stage approval workflow** — Models the real S&P process (script → rough cut → slated final) with role-based review chains
- **Policy engine** — Configurable rules with built-in FCC/IAB templates, plus custom policies per client
- **Audit trail** — Full logging of every screening, review decision, and violation resolution

## Architecture

```
Client (React + Tailwind + shadcn/ui)
  ↓ tRPC
Server (Express + TypeScript)
  ├── AI Moderation Engine (OpenAI GPT-4o / Anthropic Claude)
  ├── Frame Extraction Pipeline (ffmpeg + yt-dlp)
  ├── FCC/IAB Compliance Frameworks (38 rules, 11 categories)
  ├── S3 Storage (AWS S3 / Cloudflare R2 / MinIO)
  └── Database (MySQL via Drizzle ORM)
```

## Prerequisites

- **Node.js** 20+
- **pnpm** 10+
- **ffmpeg** and **ffprobe** (for frame extraction)
- **yt-dlp** (for YouTube/Vimeo video download)
- **MySQL** 8+ (or PlanetScale, AWS RDS)
- **S3-compatible storage** (AWS S3, Cloudflare R2, MinIO)
- **OpenAI API key** (GPT-4o for vision analysis) or **Anthropic API key**

### Install system dependencies

```bash
# macOS
brew install ffmpeg yt-dlp

# Ubuntu/Debian
sudo apt install ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp
```

## Setup

```bash
# Clone and install
git clone <repo-url> admod-platform
cd admod-platform
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your database, API keys, S3 credentials

# Run database migrations
pnpm run db:push

# Start development server
pnpm run dev
```

The first boot creates an admin user from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.

## Configuration

See `.env.example` for all available options. The key settings:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL connection string |
| `JWT_SECRET` | Secret for signing session tokens |
| `LLM_PROVIDER` | `openai` or `anthropic` |
| `OPENAI_API_KEY` | For GPT-4o vision analysis |
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_ACCESS_KEY_ID` | S3 access key |
| `S3_SECRET_ACCESS_KEY` | S3 secret key |
| `S3_BUCKET` | Bucket name for uploads and frames |

## Docker Deployment

```bash
docker build -t admod .
docker run -p 3000:3000 --env-file .env admod
```

The Docker image includes ffmpeg and yt-dlp pre-installed.

## How Frame Analysis Works

1. **Video ingestion** — Accepts uploads (MP4, MOV, WebM) or URLs (YouTube, Vimeo, direct)
2. **Download** — For URLs, yt-dlp downloads the video; for uploads, fetches from S3
3. **Probe** — ffprobe extracts metadata (duration, resolution, FPS, codec)
4. **Extract** — ffmpeg generates JPEG frames at the configured interval (default: 1/second)
5. **Upload** — Each frame JPEG is uploaded to S3 with a unique key
6. **Analyze** — Frame batches (5 at a time) are sent to the vision model with the full FCC/IAB compliance ruleset
7. **Score** — Each frame receives a safety score (0-100), severity classification, and specific rule violations with IDs
8. **Report** — Results are stored in the database and displayed in the frame timeline viewer

For a 30-second spot, this produces 30 individually analyzed frames, each with its own compliance assessment.

## FCC/IAB Compliance Coverage

### FCC Rules (Broadcast)
- **Content Standards** — Obscenity (18 U.S.C. § 1464), indecency safe harbor (47 CFR § 73.3999), profanity, violence
- **Disclosure** — Sponsorship ID (47 CFR § 73.1212), visual/audio disclosure legibility, political ad disclosure
- **Prohibited Practices** — Subliminal messaging, tobacco ban (15 U.S.C. § 1335), lottery restrictions, fake EAS tones, CALM Act loudness
- **Children's Protections** — CTA ad limits (47 CFR § 73.670), host selling, COPPA
- **Product-Specific** — Alcohol, pharmaceutical DTC (FDA fair balance), financial disclosures

### IAB Rules (Digital)
- **Content Taxonomy** — IAB v3.0 classification, GARM Brand Safety Floor, GARM Suitability Tiers
- **Creative Standards** — Ad quality (fake UI detection), LEAN principles, VAST/VPAID
- **Truthfulness** — FTC § 5 substantiation, endorsement disclosure (16 CFR 255), native ad labeling, price transparency
- **Privacy** — TCF 2.2 compliance, sensitive category targeting
- **Accessibility** — WCAG 2.1 AA contrast, photosensitivity (WCAG 2.3.1), inclusive representation
- **Sector-Specific** — Health claims, cryptocurrency, gambling, cannabis/CBD

## API

All endpoints are tRPC procedures under `/api/trpc`. Key endpoints:

- `ads.create` — Submit a new ad for review
- `ads.runAiScreening` — Run AI screening with FCC/IAB compliance scoring
- `ads.runFrameAnalysis` — Run frame-by-frame analysis with ffmpeg extraction
- `policies.seedTemplates` — Load built-in FCC/IAB policy templates
- `reviews.submit` — Submit a human review decision

## License

MIT
