FROM node:20-slim AS base

# Install ffmpeg, ffprobe, and yt-dlp for frame extraction
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

# ─── Dependencies ────────────────────────────────────────────────────────
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile

# ─── Build ───────────────────────────────────────────────────────────────
COPY . .
RUN pnpm run build

# ─── Production ──────────────────────────────────────────────────────────
FROM node:20-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/dist ./dist

# Create frame extraction temp directory
RUN mkdir -p /tmp/admod-frames && chmod 777 /tmp/admod-frames

ENV NODE_ENV=production
ENV PORT=3000
ENV FRAME_EXTRACT_DIR=/tmp/admod-frames

EXPOSE 3000

CMD ["node", "dist/index.js"]
