import { describe, expect, it } from "vitest";
import { detectVideoProvider, getEmbedUrl, getThumbnailUrl, isVideoUrl } from "./videoUrlParser";

describe("videoUrlParser", () => {
  describe("detectVideoProvider", () => {
    it("detects standard YouTube watch URLs", () => {
      const result = detectVideoProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.provider).toBe("youtube");
      expect(result.videoId).toBe("dQw4w9WgXcQ");
    });

    it("detects YouTube short URLs (youtu.be)", () => {
      const result = detectVideoProvider("https://youtu.be/dQw4w9WgXcQ");
      expect(result.provider).toBe("youtube");
      expect(result.videoId).toBe("dQw4w9WgXcQ");
    });

    it("detects YouTube embed URLs", () => {
      const result = detectVideoProvider("https://www.youtube.com/embed/dQw4w9WgXcQ");
      expect(result.provider).toBe("youtube");
      expect(result.videoId).toBe("dQw4w9WgXcQ");
    });

    it("detects YouTube Shorts URLs", () => {
      const result = detectVideoProvider("https://www.youtube.com/shorts/dQw4w9WgXcQ");
      expect(result.provider).toBe("youtube");
      expect(result.videoId).toBe("dQw4w9WgXcQ");
    });

    it("detects standard Vimeo URLs", () => {
      const result = detectVideoProvider("https://vimeo.com/123456789");
      expect(result.provider).toBe("vimeo");
      expect(result.videoId).toBe("123456789");
    });

    it("detects Vimeo player embed URLs", () => {
      const result = detectVideoProvider("https://player.vimeo.com/video/123456789");
      expect(result.provider).toBe("vimeo");
      expect(result.videoId).toBe("123456789");
    });

    it("detects direct video URLs (.mp4)", () => {
      const result = detectVideoProvider("https://example.com/video.mp4");
      expect(result.provider).toBe("direct");
      expect(result.videoId).toBe("");
    });

    it("detects direct video URLs (.webm)", () => {
      const result = detectVideoProvider("https://example.com/video.webm");
      expect(result.provider).toBe("direct");
    });

    it("returns unknown for non-video URLs", () => {
      const result = detectVideoProvider("https://example.com/page");
      expect(result.provider).toBe("unknown");
    });

    it("returns unknown for empty strings", () => {
      const result = detectVideoProvider("");
      expect(result.provider).toBe("unknown");
    });

    it("handles YouTube URLs without www", () => {
      const result = detectVideoProvider("https://youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.provider).toBe("youtube");
      expect(result.videoId).toBe("dQw4w9WgXcQ");
    });

    it("handles YouTube URLs with extra parameters", () => {
      const result = detectVideoProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120");
      expect(result.provider).toBe("youtube");
      expect(result.videoId).toBe("dQw4w9WgXcQ");
    });
  });

  describe("getEmbedUrl", () => {
    it("generates YouTube embed URL", () => {
      expect(getEmbedUrl("youtube", "dQw4w9WgXcQ")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    });

    it("generates Vimeo embed URL", () => {
      expect(getEmbedUrl("vimeo", "123456789")).toBe("https://player.vimeo.com/video/123456789");
    });

    it("returns empty string for direct URLs", () => {
      expect(getEmbedUrl("direct", "")).toBe("");
    });

    it("returns empty string for unknown providers", () => {
      expect(getEmbedUrl("unknown", "")).toBe("");
    });
  });

  describe("getThumbnailUrl", () => {
    it("generates YouTube thumbnail URL", () => {
      expect(getThumbnailUrl("youtube", "dQw4w9WgXcQ")).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    });

    it("returns empty for Vimeo (requires API)", () => {
      expect(getThumbnailUrl("vimeo", "123456789")).toBe("");
    });

    it("returns empty for direct URLs", () => {
      expect(getThumbnailUrl("direct", "")).toBe("");
    });
  });

  describe("isVideoUrl", () => {
    it("returns true for YouTube URLs", () => {
      expect(isVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    });

    it("returns true for Vimeo URLs", () => {
      expect(isVideoUrl("https://vimeo.com/123456789")).toBe(true);
    });

    it("returns true for direct video URLs", () => {
      expect(isVideoUrl("https://example.com/video.mp4")).toBe(true);
    });

    it("returns false for non-video URLs", () => {
      expect(isVideoUrl("https://example.com/page")).toBe(false);
    });

    it("returns false for empty strings", () => {
      expect(isVideoUrl("")).toBe(false);
    });
  });
});
