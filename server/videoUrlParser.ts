import axios from "axios";

export type VideoProvider = "youtube" | "vimeo" | "direct" | "unknown";

export interface VideoMetadata {
  provider: VideoProvider;
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  embedUrl: string;
  authorName: string;
  authorUrl: string;
  providerUrl: string;
  width: number;
  height: number;
}

// ─── URL Parsing ────────────────────────────────────────────────────────────

const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];

const VIMEO_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/,
  /(?:https?:\/\/)?player\.vimeo\.com\/video\/(\d+)/,
];

export function detectVideoProvider(url: string): { provider: VideoProvider; videoId: string } {
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) {
      return { provider: "youtube", videoId: match[1] };
    }
  }

  for (const pattern of VIMEO_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) {
      return { provider: "vimeo", videoId: match[1] };
    }
  }

  // Check if it's a direct video URL
  const videoExtensions = [".mp4", ".webm", ".ogg", ".mov", ".avi"];
  const lowerUrl = url.toLowerCase();
  if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
    return { provider: "direct", videoId: "" };
  }

  return { provider: "unknown", videoId: "" };
}

export function getEmbedUrl(provider: VideoProvider, videoId: string): string {
  switch (provider) {
    case "youtube":
      return `https://www.youtube.com/embed/${videoId}`;
    case "vimeo":
      return `https://player.vimeo.com/video/${videoId}`;
    default:
      return "";
  }
}

export function getThumbnailUrl(provider: VideoProvider, videoId: string): string {
  switch (provider) {
    case "youtube":
      return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    case "vimeo":
      // Vimeo thumbnails require API call, return empty for now
      return "";
    default:
      return "";
  }
}

// ─── oEmbed Metadata Fetching ───────────────────────────────────────────────

async function fetchYouTubeOEmbed(videoId: string): Promise<Partial<VideoMetadata>> {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return {
      provider: "youtube",
      videoId,
      title: data.title || "",
      description: "",
      thumbnailUrl: data.thumbnail_url || getThumbnailUrl("youtube", videoId),
      duration: "",
      embedUrl: getEmbedUrl("youtube", videoId),
      authorName: data.author_name || "",
      authorUrl: data.author_url || "",
      providerUrl: "https://www.youtube.com",
      width: data.width || 1280,
      height: data.height || 720,
    };
  } catch (error) {
    console.error("[VideoParser] YouTube oEmbed failed:", error);
    return {
      provider: "youtube",
      videoId,
      title: "",
      description: "",
      thumbnailUrl: getThumbnailUrl("youtube", videoId),
      duration: "",
      embedUrl: getEmbedUrl("youtube", videoId),
      authorName: "",
      authorUrl: "",
      providerUrl: "https://www.youtube.com",
      width: 1280,
      height: 720,
    };
  }
}

async function fetchVimeoOEmbed(videoId: string): Promise<Partial<VideoMetadata>> {
  try {
    const url = `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return {
      provider: "vimeo",
      videoId,
      title: data.title || "",
      description: data.description || "",
      thumbnailUrl: data.thumbnail_url || "",
      duration: data.duration ? formatDuration(data.duration) : "",
      embedUrl: getEmbedUrl("vimeo", videoId),
      authorName: data.author_name || "",
      authorUrl: data.author_url || "",
      providerUrl: "https://vimeo.com",
      width: data.width || 1280,
      height: data.height || 720,
    };
  } catch (error) {
    console.error("[VideoParser] Vimeo oEmbed failed:", error);
    return {
      provider: "vimeo",
      videoId,
      title: "",
      description: "",
      thumbnailUrl: "",
      duration: "",
      embedUrl: getEmbedUrl("vimeo", videoId),
      authorName: "",
      authorUrl: "",
      providerUrl: "https://vimeo.com",
      width: 1280,
      height: 720,
    };
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function parseVideoUrl(url: string): Promise<VideoMetadata> {
  const { provider, videoId } = detectVideoProvider(url);

  const defaults: VideoMetadata = {
    provider,
    videoId,
    title: "",
    description: "",
    thumbnailUrl: "",
    duration: "",
    embedUrl: getEmbedUrl(provider, videoId),
    authorName: "",
    authorUrl: "",
    providerUrl: "",
    width: 1280,
    height: 720,
  };

  if (provider === "youtube") {
    const oEmbed = await fetchYouTubeOEmbed(videoId);
    return { ...defaults, ...oEmbed } as VideoMetadata;
  }

  if (provider === "vimeo") {
    const oEmbed = await fetchVimeoOEmbed(videoId);
    return { ...defaults, ...oEmbed } as VideoMetadata;
  }

  // Direct video URL - no metadata extraction possible
  if (provider === "direct") {
    return {
      ...defaults,
      title: url.split("/").pop()?.split("?")[0] || "Direct Video",
      embedUrl: url,
    };
  }

  return defaults;
}

export function isVideoUrl(url: string): boolean {
  const { provider } = detectVideoProvider(url);
  return provider !== "unknown";
}
