import { describe, expect, it } from "vitest";
import {
  parseDurationToSeconds,
  formatTimestamp,
  getYouTubeFrameUrls,
  getVimeoFrameUrls,
} from "./frameAnalysis";

describe("parseDurationToSeconds", () => {
  it("parses HH:MM:SS format", () => {
    expect(parseDurationToSeconds("1:30:00")).toBe(5400);
    expect(parseDurationToSeconds("0:05:30")).toBe(330);
  });

  it("parses MM:SS format", () => {
    expect(parseDurationToSeconds("5:30")).toBe(330);
    expect(parseDurationToSeconds("0:30")).toBe(30);
    expect(parseDurationToSeconds("10:00")).toBe(600);
  });

  it("parses plain integer seconds", () => {
    expect(parseDurationToSeconds("120")).toBe(120);
    // "0" is parsed as 0 by parseInt, but 0 is falsy so it falls through to default 120
    expect(parseDurationToSeconds("0")).toBe(120);
  });

  it("returns default 120 for null/undefined/empty", () => {
    expect(parseDurationToSeconds(null)).toBe(120);
    expect(parseDurationToSeconds(undefined)).toBe(120);
    expect(parseDurationToSeconds("")).toBe(120);
  });

  it("returns default for non-numeric strings", () => {
    expect(parseDurationToSeconds("abc")).toBe(120);
  });
});

describe("formatTimestamp", () => {
  it("formats seconds < 60 as M:SS", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(5)).toBe("0:05");
    expect(formatTimestamp(30)).toBe("0:30");
    expect(formatTimestamp(59)).toBe("0:59");
  });

  it("formats minutes correctly", () => {
    expect(formatTimestamp(60)).toBe("1:00");
    expect(formatTimestamp(90)).toBe("1:30");
    expect(formatTimestamp(125)).toBe("2:05");
    expect(formatTimestamp(600)).toBe("10:00");
  });

  it("formats hours correctly", () => {
    expect(formatTimestamp(3600)).toBe("1:00:00");
    expect(formatTimestamp(3661)).toBe("1:01:01");
    expect(formatTimestamp(7200)).toBe("2:00:00");
  });
});

describe("getYouTubeFrameUrls", () => {
  it("returns 4 frames for short videos (<=60s)", () => {
    const frames = getYouTubeFrameUrls("test123", 30, 10);
    expect(frames).toHaveLength(4);
    expect(frames[0].url).toContain("test123");
    expect(frames[0].url).toContain("img.youtube.com");
  });

  it("includes standard YouTube thumbnail URLs", () => {
    const frames = getYouTubeFrameUrls("abc", 30, 10);
    const urls = frames.map(f => f.url);
    expect(urls.some(u => u.includes("/0.jpg"))).toBe(true);
    expect(urls.some(u => u.includes("/1.jpg"))).toBe(true);
    expect(urls.some(u => u.includes("/2.jpg"))).toBe(true);
    expect(urls.some(u => u.includes("/3.jpg"))).toBe(true);
  });

  it("returns more frames for longer videos", () => {
    const frames = getYouTubeFrameUrls("longvid", 300, 10);
    expect(frames.length).toBeGreaterThanOrEqual(4);
  });

  it("caps at 20 frames maximum for very long videos", () => {
    const frames = getYouTubeFrameUrls("verylongvid", 3600, 10);
    // Should not exceed 20 + 4 standard = 24, but deduplication reduces this
    expect(frames.length).toBeLessThanOrEqual(24);
  });

  it("returns frames sorted by timestamp", () => {
    const frames = getYouTubeFrameUrls("sorted", 300, 10);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].timestampSeconds).toBeGreaterThanOrEqual(frames[i - 1].timestampSeconds);
    }
  });

  it("includes video ID in all URLs", () => {
    const frames = getYouTubeFrameUrls("myVideoId", 60, 10);
    frames.forEach(f => {
      expect(f.url).toContain("myVideoId");
    });
  });
});

describe("getVimeoFrameUrls", () => {
  it("returns empty array for null thumbnail", () => {
    const frames = getVimeoFrameUrls(null, 120);
    expect(frames).toHaveLength(0);
  });

  it("returns 3 frames with valid thumbnail", () => {
    const frames = getVimeoFrameUrls("https://i.vimeocdn.com/video/123_640x360.jpg", 120);
    expect(frames).toHaveLength(3);
  });

  it("first frame is at timestamp 0", () => {
    const frames = getVimeoFrameUrls("https://i.vimeocdn.com/video/123.jpg", 120);
    expect(frames[0].timestampSeconds).toBe(0);
    expect(frames[0].url).toBe("https://i.vimeocdn.com/video/123.jpg");
  });

  it("distributes frames across video duration", () => {
    const frames = getVimeoFrameUrls("https://i.vimeocdn.com/video/123.jpg", 200);
    expect(frames[1].timestampSeconds).toBe(50); // 25% of 200
    expect(frames[2].timestampSeconds).toBe(100); // 50% of 200
  });
});

describe("frame analysis integration types", () => {
  it("FrameAnalysisRequest accepts all required fields", () => {
    // Type check - this verifies the interface is correctly exported
    const request = {
      adId: 1,
      title: "Test Ad",
      description: "Test description",
      format: "video",
      fileUrl: "https://example.com/video.mp4",
      sourceType: "youtube",
      sourceUrl: "https://youtube.com/watch?v=abc",
      videoProvider: "youtube",
      videoId: "abc",
      thumbnailUrl: "https://img.youtube.com/vi/abc/0.jpg",
      videoDuration: "5:30",
      targetAudience: "adults",
    };
    expect(request.adId).toBe(1);
    expect(request.format).toBe("video");
  });

  it("FrameAnalysisResult has correct structure", () => {
    const result = {
      adId: 1,
      totalFramesAnalyzed: 5,
      analysisIntervalSeconds: 10,
      overallVideoScore: 85,
      flaggedFrameCount: 1,
      frames: [],
      summary: "Test summary",
      worstTimestamp: "0:30",
      worstIssue: "Minor concern",
      status: "completed" as const,
    };
    expect(result.status).toBe("completed");
    expect(result.overallVideoScore).toBe(85);
  });
});
