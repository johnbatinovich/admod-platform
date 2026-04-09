import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { storagePut, storageGetSignedUrl, deriveKeyFromStorageUrl, storageDownloadBuffer } from "./storage";
import { analyzeAdContent, generateModerationSuggestion } from "./aiModeration";
import { parseVideoUrl, detectVideoProvider, isVideoUrl } from "./videoUrlParser";
import { runFrameAnalysis } from "./frameAnalysis";
import { runUnifiedAiReview } from "./aiReviewPipeline";
import { analyzeVideoWithGemini } from "./geminiVideoAnalysis";
import { transcribeVideoAudio } from "./whisperTranscription";
import { getDefaultPolicySeedData } from "./complianceFrameworks";
import { invokeLLM } from "./_core/llm";
import { extractSingleFrame } from "./frameExtraction";
import { matchAdvertiser, normalizeAdvertiserName } from "./advertiserMatcher";
import { nanoid } from "nanoid";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

// ─── AI Review Result Saver (preserves run history) ──────────────────────────
// Before overwriting aiAnalysis, stashes the previous result in previousRuns[].
// This gives reviewers a full audit trail without requiring a schema change.

async function saveAiReviewResult(
  adId: number,
  result: Record<string, unknown>,
  scores: { aiScore: number | null; brandSafetyScore: number },
): Promise<void> {
  const current = await db.getAdSubmissionById(adId);
  const existing = (current?.aiAnalysis ?? {}) as Record<string, unknown>;

  // Don't archive stage-progress markers or error stubs — only real completed results
  const isRealResult = existing && existing.clearanceScore != null;
  const previousRuns: unknown[] = Array.isArray(existing.previousRuns)
    ? existing.previousRuns
    : [];

  if (isRealResult) {
    const { previousRuns: _, ...existingWithoutHistory } = existing;
    previousRuns.push({
      ...existingWithoutHistory,
      archivedAt: new Date().toISOString(),
    });
  }

  const runNumber = previousRuns.length + 1;

  await db.updateAdSubmission(adId, {
    aiScore: scores.aiScore,
    brandSafetyScore: scores.brandSafetyScore,
    aiAnalysis: {
      ...result,
      runNumber,
      ranAt: new Date().toISOString(),
      previousRuns,
    } as any,
  });
}

// ─── Approval Chain Assignment ───────────────────────────────────────────────
// After AI review, routes the ad through the default approval chain when the
// recommendation is "needs_review". auto_approve/auto_reject skip the chain.

async function applyChainAssignment(
  adId: number,
  adTitle: string,
  recommendation: "auto_approve" | "needs_review" | "auto_reject",
): Promise<void> {
  if (recommendation === "auto_approve") {
    await db.updateAdSubmission(adId, { status: "approved" });
    return;
  }
  if (recommendation === "auto_reject") {
    await db.updateAdSubmission(adId, { status: "rejected" });
    return;
  }

  // needs_review: assign default chain if one exists
  const defaultChain = await db.getDefaultApprovalChain();
  if (!defaultChain || !Array.isArray(defaultChain.steps) || (defaultChain.steps as any[]).length === 0) {
    await db.updateAdSubmission(adId, { status: "in_review" });
    return;
  }

  const chainSteps = defaultChain.steps as Array<{ step: number; name: string; role: string }>;

  // Create one approvalStep row per template step
  for (const s of chainSteps) {
    await db.createApprovalStep({
      adSubmissionId: adId,
      approvalChainId: defaultChain.id,
      stepNumber: s.step,
      stepName: s.name,
      requiredRole: s.role,
      status: "pending",
    });
  }

  await db.updateAdSubmission(adId, { status: "in_review", currentApprovalStep: 1 });

  // Notify users who can handle step 1
  const firstStep = chainSteps.find(s => s.step === 1);
  if (firstStep) {
    const allUsers = await db.getAllUsers();
    const eligible = allUsers.filter(
      u => u.platformRole === firstStep.role || u.platformRole === "admin" || u.role === "admin"
    );
    for (const reviewer of eligible) {
      await db.createNotification({
        userId: reviewer.id,
        type: "review_assigned",
        title: "Review Assigned",
        message: `"${adTitle}" needs ${firstStep.name} (Step 1 of ${chainSteps.length} in ${defaultChain.name}).`,
        relatedAdId: adId,
      });
    }
  }
}

// ─── Background Auto-Analysis ───────────────────────────────────────────────
// Triggered automatically when a new ad is submitted.

async function performAutoAnalysis(adId: number, triggeredByUserId: number): Promise<void> {
  const ad = await db.getAdSubmissionById(adId);
  if (!ad) return;

  // Resolve presigned URLs for private R2 files
  let resolvedFileUrl = ad.fileUrl;
  let resolvedThumbnailUrl = ad.thumbnailUrl;
  if (ad.sourceType === "upload" && ad.fileKey) {
    const { url } = await storageGetSignedUrl(ad.fileKey, 7200);
    resolvedFileUrl = url;
    if (!resolvedThumbnailUrl) resolvedThumbnailUrl = url;
  }
  if (resolvedThumbnailUrl) {
    const thumbKey = deriveKeyFromStorageUrl(resolvedThumbnailUrl);
    if (thumbKey) {
      const { url } = await storageGetSignedUrl(thumbKey, 7200);
      resolvedThumbnailUrl = url;
    }
  }

  const activePolicies = await db.getPolicies(true);
  const adForReview = { ...ad, fileUrl: resolvedFileUrl, thumbnailUrl: resolvedThumbnailUrl };

  // Create frame analysis record (stage progress visible via getFrameAnalysis poll)
  const analysisId = await db.createFrameAnalysis({
    adSubmissionId: adId,
    status: "running",
    triggeredBy: triggeredByUserId,
    startedAt: new Date(),
  });

  await db.updateAdSubmission(adId, {
    status: "ai_screening",
    aiAnalysis: { reviewStage: "stage1_running" } as any,
  });

  try {
    const result = await runUnifiedAiReview(
      adForReview,
      activePolicies,
      async (stage) => {
        await db.updateAdSubmission(adId, { aiAnalysis: { reviewStage: stage } as any });
      },
    );

    await db.updateFrameAnalysis(analysisId, {
      totalFramesAnalyzed: result.totalFramesAnalyzed,
      analysisIntervalSeconds: result.analysisIntervalSeconds,
      overallVideoScore: result.overallVideoScore,
      flaggedFrameCount: result.flaggedFrameCount,
      frames: result.frameFindings as any,
      summary: result.frameSummary,
      worstTimestamp: result.worstTimestamp,
      worstIssue: result.worstIssue,
      status: "completed",
      completedAt: new Date(),
    });

    await saveAiReviewResult(adId, result as unknown as Record<string, unknown>, {
      aiScore: result.clearanceScore,
      brandSafetyScore: result.brandSafetyScore,
    });

    // Route through approval chain (or auto-approve/reject) based on agentic routing decision
    await applyChainAssignment(adId, ad.title, result.routingDecision);

    await db.createAuditEntry({
      userId: triggeredByUserId,
      action: "ai_agent_routing",
      entityType: "ad_submission",
      entityId: adId,
      details: {
        clearanceScore: result.clearanceScore,
        routingDecision: result.routingDecision,
        routingReason: result.routingReason,
        routingConfidence: result.routingConfidence,
        stagesCompleted: result.stagesCompleted,
        skippedDeepAnalysis: result.skippedDeepAnalysis,
        recommendation: result.recommendation,
      },
    });

    for (const violation of result.violations) {
      const matchingPolicy = activePolicies.find(p =>
        p.name.toLowerCase().includes(violation.policyArea.toLowerCase()) ||
        p.category === violation.policyArea
      );
      await db.createPolicyViolation({
        adSubmissionId: adId,
        policyId: matchingPolicy?.id ?? null,
        severity: violation.severity,
        description: violation.description,
        detectedBy: "ai",
      });
    }

    for (const frame of result.frameFindings) {
      for (const issue of frame.issues) {
        if (issue.severity === "critical" || issue.severity === "blocking") {
          const matchingPolicy = activePolicies.find(p =>
            p.name.toLowerCase().includes(issue.policyArea.toLowerCase()) ||
            p.category === issue.policyArea
          );
          await db.createPolicyViolation({
            adSubmissionId: adId,
            policyId: matchingPolicy?.id ?? null,
            severity: issue.severity === "blocking" ? "critical" : issue.severity,
            description: `[Frame at ${frame.timestampFormatted}] ${issue.description}`,
            detectedBy: "ai",
          });
        }
      }
    }

    await db.createAuditEntry({
      userId: triggeredByUserId,
      action: "auto_ai_review",
      entityType: "ad_submission",
      entityId: adId,
      details: { score: result.overallScore, recommendation: result.recommendation, autoTriggered: true, deepAnalysis: result.deepAnalysisTriggered },
    });

    await db.createNotification({
      userId: triggeredByUserId,
      type: "ai_screening_complete",
      title: "Auto AI Review Complete",
      message: `Analysis of "${ad.title}" complete. Score: ${result.overallScore}/100. Recommendation: ${result.recommendation.replace(/_/g, " ")}.`,
      relatedAdId: adId,
    });
  } catch (err) {
    const errorMessage = (err as Error)?.message ?? "Unknown error";
    console.error(`[AutoAnalysis] Unified review failed for ad ${adId}: ${errorMessage}`);
    await db.updateFrameAnalysis(analysisId, {
      status: "failed",
      summary: `Analysis failed: ${errorMessage}`,
      completedAt: new Date(),
    }).catch(() => {});
    await db.updateAdSubmission(adId, {
      status: "ai_failed",
      aiAnalysis: { error: true, errorMessage } as any,
    });
    await db.createNotification({
      userId: triggeredByUserId,
      type: "ai_screening_complete",
      title: "AI Review Failed",
      message: `Automated review of "${ad.title}" encountered an error: ${errorMessage}`,
      relatedAdId: adId,
    }).catch(() => {});
  }
}

// ─── Moderator procedure (reviewer, moderator, or admin) ────────────────────
const moderatorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const role = ctx.user.platformRole as string;
  if (!["reviewer", "moderator", "admin"].includes(role) && ctx.user.role !== "admin") {
    throw new Error("Insufficient permissions. Requires reviewer, moderator, or admin role.");
  }
  return next({ ctx });
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Dashboard ───────────────────────────────────────────────────────────
  dashboard: router({
    stats: protectedProcedure.query(async () => {
      return db.getDashboardStats();
    }),
    recentActivity: protectedProcedure.query(async () => {
      return db.getRecentActivity(20);
    }),
    adCounts: protectedProcedure.query(async () => {
      return db.getAdSubmissionCounts();
    }),
    agentActivity: protectedProcedure.query(async () => {
      return db.getAgentActivity(10);
    }),
    autoStats: protectedProcedure.query(async () => {
      return db.getAutoStats();
    }),
  }),

  // ─── Users / Team Management ─────────────────────────────────────────────
  users: router({
    list: adminProcedure.query(async () => {
      return db.getAllUsers();
    }),
    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), platformRole: z.enum(["viewer", "reviewer", "moderator", "admin"]) }))
      .mutation(async ({ input, ctx }) => {
        await db.updateUserPlatformRole(input.userId, input.platformRole);
        await db.createAuditEntry({
          userId: ctx.user.id,
          action: "update_role",
          entityType: "user",
          entityId: input.userId,
          details: { newRole: input.platformRole },
        });
        return { success: true };
      }),
  }),

  // ─── Advertisers ─────────────────────────────────────────────────────────
  advertisers: router({
    list: protectedProcedure.query(async () => {
      return db.getAdvertisers();
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getAdvertiserById(input.id);
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1),
        contactEmail: z.string().email().optional(),
        contactPhone: z.string().optional(),
        industry: z.string().optional(),
        website: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await db.createAdvertiser({
          ...input,
          normalizedName: normalizeAdvertiserName(input.name) || null,
          createdBy: ctx.user.id,
        });
        await db.createAuditEntry({
          userId: ctx.user.id, action: "create_advertiser",
          entityType: "advertiser", entityId: id, details: { name: input.name },
        });
        return { id };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        contactEmail: z.string().email().optional(),
        contactPhone: z.string().optional(),
        industry: z.string().optional(),
        website: z.string().optional(),
        verificationStatus: z.enum(["pending", "verified", "rejected", "suspended"]).optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        const updateData = data.name
          ? { ...data, normalizedName: normalizeAdvertiserName(data.name) || null }
          : data;
        await db.updateAdvertiser(id, updateData);
        await db.createAuditEntry({
          userId: ctx.user.id, action: "update_advertiser",
          entityType: "advertiser", entityId: id, details: data,
        });
        return { success: true };
      }),
  }),

  // ─── Ad Submissions ─────────────────────────────────────────────────────
  ads: router({
    list: protectedProcedure
      .input(z.object({
        status: z.string().optional(),
        priority: z.string().optional(),
        format: z.string().optional(),
        search: z.string().optional(),
        assignedTo: z.number().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional())
      .query(async ({ input }) => {
        return db.getAdSubmissions(input);
      }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const ad = await db.getAdSubmissionById(input.id);
        if (!ad) throw new Error("Ad not found");
        const reviews = await db.getReviewsForAd(input.id);
        const violations = await db.getViolationsForAd(input.id);
        const rawSteps = await db.getApprovalStepsForAd(input.id);
        // Enrich steps with the deciding user's email for display in the UI
        const allUsers = rawSteps.some(s => s.decidedBy != null) ? await db.getAllUsers() : [];
        const approvalSteps = rawSteps.map(s => ({
          ...s,
          decidedByEmail: allUsers.find(u => u.id === s.decidedBy)?.email ?? null,
        }));
        return { ...ad, reviews, violations, approvalSteps };
      }),
    // Parse video URL and extract metadata
    parseVideoUrl: protectedProcedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        if (!isVideoUrl(input.url)) {
          throw new Error("URL is not a recognized video source. Supported: YouTube, Vimeo, or direct video links.");
        }
        const metadata = await parseVideoUrl(input.url);
        return metadata;
      }),
    create: protectedProcedure
      .input(z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        advertiserId: z.number().optional(),
        advertiserName: z.string().optional(), // text input value — used for auto-match/create
        format: z.enum(["video", "image", "audio", "text", "rich_media"]),
        // Source type
        sourceType: z.enum(["upload", "youtube", "vimeo", "direct_url"]).optional(),
        sourceUrl: z.string().optional(),
        // File upload fields
        fileUrl: z.string().optional(),
        fileKey: z.string().optional(),
        fileName: z.string().optional(),
        fileMimeType: z.string().optional(),
        fileSizeBytes: z.number().optional(),
        // Video provider fields
        videoProvider: z.string().optional(),
        videoId: z.string().optional(),
        embedUrl: z.string().optional(),
        thumbnailUrl: z.string().optional(),
        videoDuration: z.string().optional(),
        videoAuthor: z.string().optional(),
        // Other fields
        targetAudience: z.string().optional(),
        targetPlatforms: z.array(z.string()).optional(),
        scheduledStart: z.string().optional(),
        scheduledEnd: z.string().optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // ── Resolve advertiser: match existing or create new ─────────────────
        let finalAdvertiserId = input.advertiserId;

        if (!finalAdvertiserId && input.advertiserName?.trim()) {
          const rawName = input.advertiserName.trim();
          // Full 4-level match (LLM enabled) as a final safety check
          const match = await matchAdvertiser(rawName);
          if (match) {
            finalAdvertiserId = match.existingId;
          } else {
            // Create a new advertiser record
            const normalized = normalizeAdvertiserName(rawName);
            const newAdvId = await db.createAdvertiser({
              name: rawName,
              normalizedName: normalized || null,
              verificationStatus: "pending",
              createdBy: ctx.user.id,
            });
            finalAdvertiserId = newAdvId;
          }
        }

        const { advertiserName: _drop, ...restInput } = input;
        const id = await db.createAdSubmission({
          ...restInput,
          advertiserId: finalAdvertiserId,
          sourceType: input.sourceType || "upload",
          targetPlatforms: input.targetPlatforms || [],
          scheduledStart: input.scheduledStart ? new Date(input.scheduledStart) : undefined,
          scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : undefined,
          status: "submitted",
          submittedBy: ctx.user.id,
          submittedAt: new Date(),
        });
        await db.createAuditEntry({
          userId: ctx.user.id, action: "create_ad",
          entityType: "ad_submission", entityId: id, details: { title: input.title },
        });
        // Create notification for admins/moderators
        await db.createNotification({
          userId: ctx.user.id,
          type: "ad_submitted",
          title: "New Ad Submitted",
          message: `Ad "${input.title}" has been submitted for review.`,
          relatedAdId: id,
        });

        // Fire off automatic frame analysis + AI screening in the background
        const userId = ctx.user.id;
        setImmediate(() => {
          performAutoAnalysis(id, userId).catch(err =>
            console.error(`[AutoAnalysis] Failed for ad ${id}:`, err)
          );
        });

        return { id };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["draft", "submitted", "ai_screening", "ai_failed", "in_review", "escalated", "changes_requested", "approved", "rejected", "published", "archived"]).optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        assignedTo: z.number().nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        await db.updateAdSubmission(id, data);
        await db.createAuditEntry({
          userId: ctx.user.id, action: "update_ad",
          entityType: "ad_submission", entityId: id, details: data,
        });
        if (data.status) {
          const ad = await db.getAdSubmissionById(id);
          if (ad?.submittedBy) {
            await db.createNotification({
              userId: ad.submittedBy,
              type: "status_change",
              title: "Ad Status Updated",
              message: `Ad "${ad.title}" status changed to ${data.status}.`,
              relatedAdId: id,
            });
          }
        }
        return { success: true };
      }),
    uploadFile: protectedProcedure
      .input(z.object({
        fileName: z.string(),
        fileBase64: z.string(),
        mimeType: z.string(),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const key = `ads/${nanoid()}/${input.fileName}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        return { url, key, fileName: input.fileName, mimeType: input.mimeType, size: buffer.length };
      }),
    // Get a short-lived presigned URL for a stored file
    getSignedUrl: protectedProcedure
      .input(z.object({ fileKey: z.string() }))
      .query(async ({ input }) => {
        const { url } = await storageGetSignedUrl(input.fileKey, 3600);
        return { url };
      }),
    // ── Creative Analysis — pre-populates submission form via vision AI + Whisper ──
    analyzeCreative: protectedProcedure
      .input(z.object({
        fileKey: z.string(),
        mimeType: z.string(),
        originalFilename: z.string(),
        videoUrl: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { fileKey, mimeType, originalFilename } = input;

        // ── Deterministic format detection ──────────────────────────────────
        const detectedFormat: "video" | "image" | "audio" | "text" | "rich_media" =
          mimeType.startsWith("video/") ? "video"
          : mimeType.startsWith("image/") ? "image"
          : mimeType.startsWith("audio/") ? "audio"
          : mimeType === "text/plain" ? "text"
          : "rich_media";

        // ── Title fallback from filename ─────────────────────────────────────
        const fallbackTitle = originalFilename
          .replace(/\.[^.]+$/, "")
          .replace(/[-_]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        type AnalysisResult = {
          suggestedTitle: string | null;
          suggestedDescription: string;
          detectedFormat: typeof detectedFormat;
          detectedAdvertiser: { name: string; existingId: number | null; confidence: string | null; matchReason: string | null; aiDetectedName: string } | null;
          suggestedTargetAudience: string | null;
          contentCategories: string[];
          analysisMethod: string;
        };

        const fallback: AnalysisResult = {
          suggestedTitle: fallbackTitle,
          suggestedDescription: "",
          detectedFormat,
          detectedAdvertiser: null,
          suggestedTargetAudience: null,
          contentCategories: [],
          analysisMethod: "filename-only",
        };

        // Non-visual formats: skip vision entirely
        if (detectedFormat !== "video" && detectedFormat !== "image") {
          return fallback;
        }

        let imageBase64: string | null = null;
        let transcript: string | null = null;
        let analysisMethod = "frame-only";

        const tempDir = path.join(os.tmpdir(), `analyze-${nanoid(8)}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
          if (detectedFormat === "image") {
            const buffer = await storageDownloadBuffer(fileKey);
            imageBase64 = `data:${mimeType};base64,${buffer.toString("base64")}`;
          } else {
            // Video: download, extract first frame + transcribe audio
            const videoPath = path.join(tempDir, "video.mp4");
            const buffer = await storageDownloadBuffer(fileKey);
            fs.writeFileSync(videoPath, buffer);

            // Frame extraction
            const framePath = path.join(tempDir, "frame.jpg");
            try {
              await extractSingleFrame(videoPath, 1, framePath);
              const frameBuffer = fs.readFileSync(framePath);
              imageBase64 = `data:image/jpeg;base64,${frameBuffer.toString("base64")}`;
            } catch (err) {
              console.warn("[analyzeCreative] Frame extraction failed:", err);
            }

            // Whisper transcription (best-effort, uses existing module)
            try {
              const whisperResult = await transcribeVideoAudio({ localPath: videoPath, adTitle: originalFilename });
              if (whisperResult.fullText && whisperResult.fullText.trim().length > 10) {
                transcript = whisperResult.fullText;
                analysisMethod = "frame+audio";
              }
            } catch (err) {
              console.warn("[analyzeCreative] Whisper failed, proceeding frame-only:", err);
            }
          }

          if (!imageBase64) return fallback;

          // ── Vision API call ─────────────────────────────────────────────────
          let analysisPrompt = `Analyze this advertisement creative. `;
          if (transcript) {
            analysisPrompt += `You have a frame from the video AND a transcript of its audio.\n\nTRANSCRIPT:\n${transcript}\n\nBased on BOTH the visual content and the transcript, return a JSON object. IMPORTANT: Prioritize information from the transcript over visual guesses. If the speaker mentions a product name, company, or specific claims, use those — don't guess based on the visual setting alone.`;
          } else {
            analysisPrompt += `Return a JSON object based on what you see.`;
          }
          analysisPrompt += `\n\nReturn ONLY a JSON object (no markdown, no backticks) with these fields:\n{\n  "title": "short descriptive title using brand/product name if identifiable",\n  "description": "1-2 sentence description of what the ad is promoting and its key message",\n  "advertiser": "brand or company name if identifiable, or null",\n  "targetAudience": "inferred target demographic, or null",\n  "contentCategories": ["category1", "category2"]\n}`;

          const llmResult = await invokeLLM({
            messages: [
              { role: "system", content: "You are an ad classification system. Return ONLY valid JSON. No markdown, no backticks, no explanation." },
              {
                role: "user",
                content: [
                  { type: "text", text: analysisPrompt },
                  { type: "image_url", image_url: { url: imageBase64, detail: "high" as const } },
                ],
              },
            ],
            maxTokens: 500,
          });

          const responseText = typeof llmResult.choices[0]?.message?.content === "string"
            ? llmResult.choices[0].message.content : "";
          const cleaned = responseText.replace(/```json\s*/g, "").replace(/```/g, "").trim();

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            console.warn("[analyzeCreative] Failed to parse LLM JSON:", cleaned);
            return { ...fallback, analysisMethod };
          }

          // ── Advertiser matching ─────────────────────────────────────────────
          type DetectedAdvertiser = AnalysisResult["detectedAdvertiser"];
          let detectedAdvertiser: DetectedAdvertiser = null;
          if (typeof parsed.advertiser === "string" && parsed.advertiser) {
            const aiDetectedName = parsed.advertiser;
            const match = await matchAdvertiser(aiDetectedName);
            if (match) {
              detectedAdvertiser = {
                name: match.existingName,
                existingId: match.existingId,
                confidence: match.confidence,
                matchReason: match.matchReason,
                aiDetectedName,
              };
            } else {
              detectedAdvertiser = { name: aiDetectedName, existingId: null, confidence: null, matchReason: null, aiDetectedName };
            }
          }

          return {
            suggestedTitle: typeof parsed.title === "string" ? parsed.title : fallbackTitle,
            suggestedDescription: typeof parsed.description === "string" ? parsed.description : "",
            detectedFormat,
            detectedAdvertiser,
            suggestedTargetAudience: typeof parsed.targetAudience === "string" ? parsed.targetAudience : null,
            contentCategories: Array.isArray(parsed.contentCategories) ? parsed.contentCategories.filter((c): c is string => typeof c === "string") : [],
            analysisMethod,
          };
        } catch (err) {
          console.warn("[analyzeCreative] Unexpected error, returning fallback:", err);
          return fallback;
        } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
      }),
    // ── Lightweight advertiser match — L1-L3 only, no LLM, fast (called on blur) ──
    checkAdvertiserMatch: protectedProcedure
      .input(z.object({ name: z.string() }))
      .query(async ({ input }) => {
        const name = input.name.trim();
        if (!name) return { match: null };

        const allAdvertisers = await db.getAdvertisers();
        const inputLower = name.toLowerCase();
        const inputNorm = normalizeAdvertiserName(name);

        // L1: exact
        for (const adv of allAdvertisers) {
          if (adv.name.toLowerCase() === inputLower) {
            return { match: { existingId: adv.id, existingName: adv.name, confidence: "exact" as const, matchReason: "Exact name match" } };
          }
        }
        // L2: normalized
        for (const adv of allAdvertisers) {
          const advNorm = adv.normalizedName ?? normalizeAdvertiserName(adv.name);
          if (advNorm === inputNorm && inputNorm.length > 0) {
            return { match: { existingId: adv.id, existingName: adv.name, confidence: "high" as const, matchReason: "Normalized match" } };
          }
        }
        // L3: containment (>= 4 chars)
        if (inputNorm.length >= 4) {
          for (const adv of allAdvertisers) {
            const advNorm = adv.normalizedName ?? normalizeAdvertiserName(adv.name);
            const shorter = inputNorm.length <= advNorm.length ? inputNorm : advNorm;
            const longer = inputNorm.length <= advNorm.length ? advNorm : inputNorm;
            if (shorter.length >= 4 && longer.includes(shorter)) {
              return { match: { existingId: adv.id, existingName: adv.name, confidence: "medium" as const, matchReason: "Containment match" } };
            }
          }
        }
        return { match: null };
      }),
    // ── Full advertiser match including LLM — called before submit ────────────
    matchAdvertiserFull: protectedProcedure
      .input(z.object({ name: z.string() }))
      .mutation(async ({ input }) => {
        if (!input.name.trim()) return { match: null };
        const match = await matchAdvertiser(input.name.trim());
        if (!match) return { match: null };
        return {
          match: {
            existingId: match.existingId,
            existingName: match.existingName,
            confidence: match.confidence,
            matchReason: match.matchReason,
          },
        };
      }),
    // ── Unified AI Review (replaces runAiScreening + runFrameAnalysis + getAiSuggestion) ──
    runAiReview: moderatorProcedure
      .input(z.object({ adId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const ad = await db.getAdSubmissionById(input.adId);
        if (!ad) throw new Error("Ad not found");

        const analysisId = await db.createFrameAnalysis({
          adSubmissionId: input.adId,
          status: "running",
          triggeredBy: ctx.user.id,
          startedAt: new Date(),
        });

        await db.updateAdSubmission(input.adId, {
          status: "ai_screening",
          aiAnalysis: { reviewStage: "stage1_running" } as any,
        });

        const userId = ctx.user.id;
        const adId = input.adId;

        setImmediate(async () => {
          try {
            let resolvedFileUrl = ad.fileUrl;
            let resolvedThumbnailUrl = ad.thumbnailUrl;
            if (ad.sourceType === "upload" && ad.fileKey) {
              const { url } = await storageGetSignedUrl(ad.fileKey, 7200);
              resolvedFileUrl = url;
              if (!resolvedThumbnailUrl) resolvedThumbnailUrl = url;
            }
            if (resolvedThumbnailUrl) {
              const thumbKey = deriveKeyFromStorageUrl(resolvedThumbnailUrl);
              if (thumbKey) {
                const { url } = await storageGetSignedUrl(thumbKey, 7200);
                resolvedThumbnailUrl = url;
              }
            }

            const activePolicies = await db.getPolicies(true);
            const adForReview = { ...ad, fileUrl: resolvedFileUrl, thumbnailUrl: resolvedThumbnailUrl };

            const result = await runUnifiedAiReview(
              adForReview,
              activePolicies,
              async (stage) => {
                await db.updateAdSubmission(adId, { aiAnalysis: { reviewStage: stage } as any });
              },
            );

            await db.updateFrameAnalysis(analysisId, {
              totalFramesAnalyzed: result.totalFramesAnalyzed,
              analysisIntervalSeconds: result.analysisIntervalSeconds,
              overallVideoScore: result.overallVideoScore,
              flaggedFrameCount: result.flaggedFrameCount,
              frames: result.frameFindings as any,
              summary: result.frameSummary,
              worstTimestamp: result.worstTimestamp,
              worstIssue: result.worstIssue,
              status: "completed",
              completedAt: new Date(),
            });

            await saveAiReviewResult(adId, result as unknown as Record<string, unknown>, {
              aiScore: result.clearanceScore,
              brandSafetyScore: result.brandSafetyScore,
            });

            // Route through approval chain (or auto-approve/reject) based on agentic routing decision
            await applyChainAssignment(adId, ad.title, result.routingDecision);

            await db.createAuditEntry({
              userId,
              action: "ai_agent_routing",
              entityType: "ad_submission",
              entityId: adId,
              details: {
                clearanceScore: result.clearanceScore,
                routingDecision: result.routingDecision,
                routingReason: result.routingReason,
                routingConfidence: result.routingConfidence,
                stagesCompleted: result.stagesCompleted,
                skippedDeepAnalysis: result.skippedDeepAnalysis,
                recommendation: result.recommendation,
              },
            });

            for (const violation of result.violations) {
              const matchingPolicy = activePolicies.find(p =>
                p.name.toLowerCase().includes(violation.policyArea.toLowerCase()) ||
                p.category === violation.policyArea
              );
              await db.createPolicyViolation({
                adSubmissionId: adId,
                policyId: matchingPolicy?.id ?? null,
                severity: violation.severity,
                description: violation.description,
                detectedBy: "ai",
              });
            }

            for (const frame of result.frameFindings) {
              for (const issue of frame.issues) {
                if (issue.severity === "critical" || issue.severity === "blocking") {
                  const matchingPolicy = activePolicies.find(p =>
                    p.name.toLowerCase().includes(issue.policyArea.toLowerCase()) ||
                    p.category === issue.policyArea
                  );
                  await db.createPolicyViolation({
                    adSubmissionId: adId,
                    policyId: matchingPolicy?.id ?? null,
                    severity: issue.severity === "blocking" ? "critical" : issue.severity,
                    description: `[Frame at ${frame.timestampFormatted}] ${issue.description}`,
                    detectedBy: "ai",
                  });
                }
              }
            }

            await db.createAuditEntry({
              userId, action: "ai_review_complete",
              entityType: "ad_submission", entityId: adId,
              details: { score: result.overallScore, recommendation: result.recommendation, deepAnalysis: result.deepAnalysisTriggered },
            });

            await db.createNotification({
              userId,
              type: "ai_screening_complete",
              title: "AI Review Complete",
              message: `Review of "${ad.title}" complete. Score: ${result.overallScore}/100. Recommendation: ${result.recommendation.replace(/_/g, " ")}.`,
              relatedAdId: adId,
            });
          } catch (err) {
            const errorMessage = (err as Error)?.message ?? "Unknown error";
            console.error(`[runAiReview] Background job failed for ad ${adId}: ${errorMessage}`, err);
            await db.updateFrameAnalysis(analysisId, {
              status: "failed",
              summary: `Analysis failed: ${errorMessage}`,
              completedAt: new Date(),
            }).catch(() => {});
            await db.updateAdSubmission(adId, {
              status: "ai_failed",
              aiAnalysis: { error: true, errorMessage } as any,
            }).catch(() => {});
            await db.createNotification({
              userId,
              type: "ai_screening_complete",
              title: "AI Review Failed",
              message: `Review of "${ad.title}" encountered an error: ${errorMessage}`,
              relatedAdId: adId,
            }).catch(() => {});
          }
        });

        return { analysisId, status: "running" as const };
      }),

    // ── Batch Ad Creation ────────────────────────────────────────────────────
    createBatch: protectedProcedure
      .input(z.object({
        ads: z.array(z.object({
          title: z.string().min(1),
          format: z.enum(["video", "image", "audio", "text", "rich_media"]),
          fileUrl: z.string().optional(),
          fileKey: z.string().optional(),
          fileName: z.string().optional(),
          fileMimeType: z.string().optional(),
          fileSizeBytes: z.number().optional(),
          sourceType: z.enum(["upload", "youtube", "vimeo", "direct_url"]).optional(),
          description: z.string().optional(),
          priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        })).min(1).max(20),
      }))
      .mutation(async ({ input, ctx }) => {
        const ids: number[] = [];
        for (const adInput of input.ads) {
          const id = await db.createAdSubmission({
            ...adInput,
            sourceType: adInput.sourceType ?? "upload",
            targetPlatforms: [],
            status: "submitted",
            submittedBy: ctx.user.id,
            submittedAt: new Date(),
          });
          ids.push(id);
          await db.createAuditEntry({
            userId: ctx.user.id, action: "create_ad",
            entityType: "ad_submission", entityId: id,
            details: { title: adInput.title, batch: true },
          });
        }
        // Analyse each ad sequentially so we don't slam the LLM API with N concurrent vision calls
        const userId = ctx.user.id;
        setImmediate(async () => {
          for (const id of ids) {
            await performAutoAnalysis(id, userId).catch(err =>
              console.error(`[BatchAnalysis] Failed for ad ${id}:`, err)
            );
          }
        });
        return { ids, count: ids.length };
      }),

    // ── Demo Data Seeder (admin-only) ────────────────────────────────────────
    seedDemoData: adminProcedure.mutation(async ({ ctx }) => {
      const uid = ctx.user.id;
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

      // 1. Seed compliance policies + default chain if absent
      const existingPolicies = await db.getPolicies();
      if (existingPolicies.length === 0) {
        const templates = getDefaultPolicySeedData();
        for (const t of templates) await db.createPolicy({ ...t, createdBy: uid });
      }
      let defaultChain = await db.getDefaultApprovalChain();
      if (!defaultChain) {
        await db.createApprovalChain({
          name: "Standard S&P Review",
          description: "Three-stage Standards & Practices review for broadcast ad clearance.",
          isDefault: true, isActive: true,
          steps: [
            { step: 1, name: "Initial Screening", role: "reviewer" },
            { step: 2, name: "S&P Review", role: "moderator" },
            { step: 3, name: "Final Clearance", role: "admin" },
          ],
          createdBy: uid,
        });
        defaultChain = await db.getDefaultApprovalChain();
      }

      // 2. Helper — shared frame analysis fields for demo ads
      const frameBase = {
        frameFindings: [], totalFramesAnalyzed: 6, analysisIntervalSeconds: 5,
        flaggedFrameCount: 0, frameSummary: "", worstTimestamp: null, worstIssue: null,
      };

      // 3. Demo ads definition
      type DemoViolation = { severity: string; description: string; detectedBy: string };
      type DemoStep = { stepNumber: number; stepName: string; requiredRole: string; status: string; decidedBy?: number | null; decidedAt?: Date | null; comments?: string | null };
      type DemoAd = {
        fields: any;
        aiAnalysis: any;
        violations?: DemoViolation[];
        approvalSteps?: DemoStep[];
      };

      const demoAds: DemoAd[] = [
        // ── 1. Clean travel ad — auto-approved ──────────────────────────────
        {
          fields: {
            title: "Summer Beach Getaway", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/beach-getaway.mp4",
            description: "30-second broadcast spot promoting Sandals Resorts Caribbean vacation packages. Target: Adults 25-54.",
            targetAudience: "Adults 25-54", priority: "normal" as const, status: "approved" as const,
            aiScore: 95, brandSafetyScore: 97, submittedBy: uid, submittedAt: ago(14),
          },
          aiAnalysis: {
            ...frameBase, overallScore: 95, brandSafetyScore: 97, confidence: 92,
            recommendation: "auto_approve", summary: "Clean travel advertisement with no compliance issues. Standard vacation destination promotion targeting adults.",
            contentCategories: ["Travel", "Lifestyle", "Tourism"],
            moderatorBrief: "Standard travel ad cleared for broadcast. No age-gating, disclaimers, or regulated content detected. Imagery and messaging align with FCC broadcast standards.",
            routingDecision: "auto_approve", routingConfidence: 92, stagesCompleted: [1, 2, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: true,
            routingReason: "High confidence (92%) with clean content and no critical findings — auto-approved without human review.",
            violations: [], objectionalContent: [], flaggableContent: [],
            complianceScores: [], overallFccScore: 98, overallIabScore: 97,
            complianceSummary: "All FCC broadcast and IAB advertising standards met. No regulated content categories detected.",
            isPoliticalAd: false, detectedAdvertiser: { name: "Sandals Resorts", industry: "Travel & Hospitality", confidence: 87 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
            requiredActions: [], highestRiskArea: null,
          },
        },
        // ── 2. Alcohol ad — in_review, partially through chain ───────────────
        {
          fields: {
            title: "Bud Light Game Day", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/bud-light-gameday.mp4",
            description: "60-second beer advertisement targeting sports fans during football season. Features stadium imagery and group consumption.",
            targetAudience: "Sports fans 21+", priority: "normal" as const, status: "in_review" as const,
            aiScore: 62, brandSafetyScore: 68, submittedBy: uid, submittedAt: ago(8),
            currentApprovalStep: 2,
          },
          aiAnalysis: {
            ...frameBase, overallScore: 62, brandSafetyScore: 68, confidence: 74,
            recommendation: "needs_review", summary: "Alcohol advertisement requires age-gating compliance review. Visible consumption imagery and implied audience includes sports fans which may include minors.",
            contentCategories: ["Alcohol", "Sports", "Entertainment"],
            moderatorBrief: "Alcohol ad flagged for mandatory age-gating verification. FCC requires explicit 21+ targeting confirmation and responsible drinking disclaimer. Step 1 screening passed — currently awaiting S&P Review.",
            routingDecision: "needs_review", routingConfidence: 74, stagesCompleted: [1, 2, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: true,
            routingReason: "Routed to approval chain: confidence below auto-approve threshold (74%); AI flagged for human review.",
            violations: [
              { policyArea: "alcohol", severity: "warning", description: "Age-gating disclaimer absent. FCC requires clear 21+ targeting language for alcohol advertisements.", confidence: 85 },
              { policyArea: "brand_safety", severity: "info", description: "Sports context may reach under-21 viewers — confirm demographic targeting restrictions are applied.", confidence: 72 },
            ],
            objectionalContent: [
              { type: "alcohol", severity: "warning", description: "Visible alcohol consumption throughout ad. Requires responsible drinking messaging per IAB standards.", confidence: 91, fccRelevant: true, iabRelevant: true },
            ],
            flaggableContent: [], complianceScores: [], overallFccScore: 64, overallIabScore: 70,
            complianceSummary: "Age-restricted product advertisement. Requires verified 21+ demographic targeting and responsible consumption messaging before clearance.",
            highestRiskArea: "Age-gating compliance for alcohol advertising",
            requiredActions: ["Add 21+ age-gating to ad targeting parameters", "Include 'Please drink responsibly' end card", "Confirm sports broadcast slot does not air during youth programming"],
            isPoliticalAd: false, detectedAdvertiser: { name: "Anheuser-Busch / Bud Light", industry: "Alcohol & Beverage", confidence: 96 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
          },
          approvalSteps: defaultChain ? [
            { stepNumber: 1, stepName: "Initial Screening", requiredRole: "reviewer", status: "approved", decidedBy: uid, decidedAt: ago(3), comments: "Age-gating disclaimer missing but ad is otherwise compliant. Escalating to S&P for final determination." },
            { stepNumber: 2, stepName: "S&P Review", requiredRole: "moderator", status: "pending", decidedBy: null, decidedAt: null, comments: null },
            { stepNumber: 3, stepName: "Final Clearance", requiredRole: "admin", status: "pending", decidedBy: null, decidedAt: null, comments: null },
          ] : undefined,
        },
        // ── 3. Pharma DTC — in_review, fair balance violations ────────────────
        {
          fields: {
            title: "Pfizer Xeljanz DTC", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/pfizer-xeljanz.mp4",
            description: "Direct-to-consumer pharmaceutical advertisement for Xeljanz (tofacitinib) rheumatoid arthritis treatment. 60-second broadcast spot.",
            targetAudience: "Adults 40+ with chronic conditions", priority: "high" as const, status: "in_review" as const,
            aiScore: 58, brandSafetyScore: 55, submittedBy: uid, submittedAt: ago(5),
            currentApprovalStep: 1,
          },
          aiAnalysis: {
            ...frameBase, overallScore: 58, brandSafetyScore: 55, confidence: 71,
            recommendation: "needs_review", summary: "Pharmaceutical DTC advertisement with incomplete fair balance disclosure. Side effect recitation does not meet FDA/FCC broadcast standards for duration and prominence.",
            contentCategories: ["Pharmaceutical", "Healthcare", "DTC Advertising"],
            moderatorBrief: "Pharma DTC ad requires fair balance audit before clearance. Side effect audio appears truncated at ~18 seconds — FDA guidelines require equal time for major risks. Recommend legal review of disclosure language.",
            routingDecision: "needs_review", routingConfidence: 71, stagesCompleted: [1, 2, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: true,
            routingReason: "Routed to approval chain: confidence below auto-approve threshold (71%); AI flagged for human review.",
            violations: [
              { policyArea: "pharmaceutical", severity: "critical", description: "Fair balance disclosure is insufficient. FDA requires major risks be presented with equal prominence to benefits in broadcast DTC ads.", confidence: 83 },
              { policyArea: "legal_compliance", severity: "warning", description: "\"Ask your doctor\" call-to-action present but toll-free number and website URL not audibly stated as required.", confidence: 76 },
            ],
            objectionalContent: [
              { type: "pharmaceutical", severity: "critical", description: "Prescription drug DTC advertisement. FDA and FCC impose strict fair balance requirements for broadcast.", confidence: 95, fccRelevant: true, iabRelevant: false },
            ],
            flaggableContent: [], complianceScores: [], overallFccScore: 52, overallIabScore: 71,
            complianceSummary: "Pharmaceutical DTC advertisement fails FDA fair balance standards. Major risk disclosure audio is too brief and insufficiently prominent relative to benefit claims.",
            highestRiskArea: "FDA fair balance compliance for prescription drug DTC advertising",
            requiredActions: [
              "Extend side effect disclosure to match benefit messaging duration",
              "Include audible toll-free number (1-800-XXX-XXXX) in closing",
              "Add website URL to closing card per FDA DTC guidelines",
              "Submit to legal/regulatory team for FDA compliance review",
            ],
            isPoliticalAd: false, detectedAdvertiser: { name: "Pfizer Inc.", industry: "Pharmaceutical", confidence: 94 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
          },
          violations: [
            { severity: "critical", description: "Fair balance disclosure insufficient — side effect audio truncated at 18s, does not meet FDA equal-prominence standard.", detectedBy: "ai" },
            { severity: "warning", description: "Missing required toll-free number and website URL in DTC closing per FDA Guidance for Industry.", detectedBy: "ai" },
          ],
          approvalSteps: defaultChain ? [
            { stepNumber: 1, stepName: "Initial Screening", requiredRole: "reviewer", status: "pending", decidedBy: null, decidedAt: null, comments: null },
            { stepNumber: 2, stepName: "S&P Review", requiredRole: "moderator", status: "pending", decidedBy: null, decidedAt: null, comments: null },
            { stepNumber: 3, stepName: "Final Clearance", requiredRole: "admin", status: "pending", decidedBy: null, decidedAt: null, comments: null },
          ] : undefined,
        },
        // ── 4. Gambling — auto-rejected, multiple blocking violations ──────────
        {
          fields: {
            title: "DraftKings Bonus Offer", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/draftkings-bonus.mp4",
            description: "Online sports betting promotion offering $1,000 bonus to new users. Targets sports viewers.",
            targetAudience: "Sports fans 18+", priority: "high" as const, status: "rejected" as const,
            aiScore: 35, brandSafetyScore: 30, submittedBy: uid, submittedAt: ago(12),
          },
          aiAnalysis: {
            ...frameBase, overallScore: 35, brandSafetyScore: 30, confidence: 91,
            recommendation: "auto_reject",
            summary: "Online gambling advertisement with multiple blocking violations. Missing mandatory responsible gambling disclosures and contains misleading bonus claim language that violates FTC guidelines.",
            contentCategories: ["Gambling", "Sports Betting", "Financial Promotion"],
            moderatorBrief: "Auto-rejected: blocking violations detected with high confidence. $1,000 bonus claim constitutes a financial promotion subject to FTC disclosure rules. No responsible gambling hotline (1-800-GAMBLER) present. Ad cannot air in its current form.",
            routingDecision: "auto_reject", routingConfidence: 91, stagesCompleted: [1, 2, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: true,
            routingReason: "High confidence (91%) with confirmed blocking violations — auto-rejected without human review.",
            violations: [
              { policyArea: "gambling", severity: "blocking", description: "No responsible gambling disclosure present. FCC mandates 1-800-GAMBLER or equivalent helpline reference in all gambling advertisements.", confidence: 96 },
              { policyArea: "legal_compliance", severity: "blocking", description: "$1,000 'bonus' claim is a financial promotion. FTC requires clear disclosure of wagering requirements and rollover conditions.", confidence: 89 },
              { policyArea: "brand_safety", severity: "critical", description: "Promotional messaging implies near-certain wins ('Get Your $1K'). Misleading probability implication violates IAB Gambling Advertising Standards.", confidence: 84 },
            ],
            objectionalContent: [
              { type: "gambling", severity: "blocking", description: "Online sports betting promotion. Multiple mandatory disclosures absent.", confidence: 97, fccRelevant: true, iabRelevant: true },
            ],
            flaggableContent: [], complianceScores: [], overallFccScore: 28, overallIabScore: 40,
            complianceSummary: "BLOCKING: Gambling advertisement fails FCC responsible gambling standards and FTC financial promotion disclosure requirements. Cannot be cleared without remediation.",
            highestRiskArea: "Responsible gambling disclosure and FTC financial promotion compliance",
            requiredActions: [
              "Add 1-800-GAMBLER hotline reference prominently in ad",
              "Disclose full terms of $1,000 bonus offer including wagering requirements",
              "Remove or qualify implied win-probability language",
              "Obtain network legal pre-clearance before resubmission",
            ],
            isPoliticalAd: false, detectedAdvertiser: { name: "DraftKings Inc.", industry: "Online Sports Betting", confidence: 98 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
          },
          violations: [
            { severity: "blocking", description: "Missing mandatory responsible gambling disclosure (1-800-GAMBLER) — FCC requirement for all gambling ads.", detectedBy: "ai" },
            { severity: "blocking", description: "Financial promotion ($1,000 bonus) without FTC-required terms and conditions disclosure.", detectedBy: "ai" },
            { severity: "critical", description: "Misleading win-probability implication in promotional language violates IAB Gambling Advertising Standards.", detectedBy: "ai" },
          ],
        },
        // ── 5. Clean automotive — auto-approved ──────────────────────────────
        {
          fields: {
            title: "Toyota RAV4 Adventure", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/toyota-rav4.mp4",
            description: "30-second broadcast spot for 2025 Toyota RAV4 Hybrid. Off-road adventure lifestyle imagery with safety feature highlights.",
            targetAudience: "Adults 30-55, outdoor enthusiasts", priority: "normal" as const, status: "approved" as const,
            aiScore: 97, brandSafetyScore: 98, submittedBy: uid, submittedAt: ago(20),
          },
          aiAnalysis: {
            ...frameBase, overallScore: 97, brandSafetyScore: 98, confidence: 95,
            recommendation: "auto_approve", summary: "Clean automotive advertisement with full compliance. Standard disclaimer for professional driver/closed course present. No regulated content detected.",
            contentCategories: ["Automotive", "Lifestyle", "Technology"],
            moderatorBrief: "Automotive ad cleared for broadcast. Professional driver disclaimer visible. No safety claim issues, no misleading pricing (no price shown), standard lifestyle imagery. Fast-track approved.",
            routingDecision: "auto_approve", routingConfidence: 95, stagesCompleted: [1, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: false,
            routingReason: "High confidence (95%) with clean content and no critical findings — auto-approved without human review.",
            violations: [], objectionalContent: [], flaggableContent: [],
            complianceScores: [], overallFccScore: 99, overallIabScore: 98,
            complianceSummary: "Full compliance with FCC broadcast and IAB automotive advertising standards. Professional driver disclaimer present and legible.",
            isPoliticalAd: false, detectedAdvertiser: { name: "Toyota Motor Corporation", industry: "Automotive", confidence: 99 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
            requiredActions: [], highestRiskArea: null,
          },
        },
        // ── 6. Political PAC — in_review, disclosure required ────────────────
        {
          fields: {
            title: "Campaign for Change PAC", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/campaign-for-change.mp4",
            description: "60-second political issue advertisement from Campaign for Change PAC. Addresses federal education policy.",
            targetAudience: "Registered voters 25+", priority: "urgent" as const, status: "in_review" as const,
            aiScore: 71, brandSafetyScore: 65, submittedBy: uid, submittedAt: ago(3),
            currentApprovalStep: 1,
          },
          aiAnalysis: {
            ...frameBase, overallScore: 71, brandSafetyScore: 65, confidence: 78,
            recommendation: "needs_review", summary: "Political issue advertisement from registered PAC. Missing required 'paid for by' disclosure language per FCC political advertising rules. Content is issue advocacy, not candidate endorsement.",
            contentCategories: ["Political", "Issue Advocacy", "Government Policy"],
            moderatorBrief: "Political PAC ad requires disclosure verification before broadcast. FCC §315 mandates on-screen 'Paid for by Campaign for Change PAC' text for minimum duration. Verify PAC registration and station political file documentation is complete.",
            routingDecision: "needs_review", routingConfidence: 78, stagesCompleted: [1, 2, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: true,
            routingReason: "Routed to approval chain: confidence below auto-approve threshold (78%); AI flagged for human review.",
            violations: [
              { policyArea: "political", severity: "critical", description: "FCC §315 'Paid for by' disclosure not present or insufficiently prominent. Required for all political advertising on broadcast.", confidence: 88 },
              { policyArea: "political", severity: "warning", description: "Station political file documentation required — verify FEC registration number and OEMC filing status.", confidence: 75 },
            ],
            objectionalContent: [
              { type: "political", severity: "critical", description: "Political advertising from PAC. FCC §315 and FEC disclosure requirements apply.", confidence: 94, fccRelevant: true, iabRelevant: false },
            ],
            flaggableContent: [], complianceScores: [], overallFccScore: 68, overallIabScore: 80,
            complianceSummary: "Political advertising subject to enhanced FCC and FEC disclosure requirements. 'Paid for by' sponsorship ID is missing or non-compliant with minimum display duration (4 seconds).",
            highestRiskArea: "FCC §315 political advertising sponsorship identification",
            requiredActions: [
              "Add 'Paid for by Campaign for Change PAC' disclosure — minimum 4-second on-screen display",
              "Confirm PAC FEC registration number for station political file",
              "Document in station political advertising file per FCC recordkeeping rules",
              "Legal pre-clearance required for political advertising per station policy",
            ],
            isPoliticalAd: true,
            politicalDetails: { candidate: null, party: null, issue: "Federal Education Policy", jurisdiction: "Federal", sponsor: "Campaign for Change PAC" },
            detectedAdvertiser: { name: "Campaign for Change PAC", industry: "Political / Issue Advocacy", confidence: 91 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
          },
          violations: [
            { severity: "critical", description: "FCC §315 sponsorship identification missing — 'Paid for by Campaign for Change PAC' not displayed for required minimum duration.", detectedBy: "ai" },
          ],
          approvalSteps: defaultChain ? [
            { stepNumber: 1, stepName: "Initial Screening", requiredRole: "reviewer", status: "pending", decidedBy: null, decidedAt: null, comments: null },
            { stepNumber: 2, stepName: "S&P Review", requiredRole: "moderator", status: "pending", decidedBy: null, decidedAt: null, comments: null },
            { stepNumber: 3, stepName: "Final Clearance", requiredRole: "admin", status: "pending", decidedBy: null, decidedAt: null, comments: null },
          ] : undefined,
        },
        // ── 7. Vaping — auto-rejected, tobacco ban ───────────────────────────
        {
          fields: {
            title: "Juul Vaping Lifestyle", format: "video" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/juul-lifestyle.mp4",
            description: "Lifestyle brand advertisement for Juul e-cigarettes featuring young adults in social settings.",
            targetAudience: "Adults 21+", priority: "high" as const, status: "rejected" as const,
            aiScore: 12, brandSafetyScore: 8, submittedBy: uid, submittedAt: ago(18),
          },
          aiAnalysis: {
            ...frameBase, overallScore: 12, brandSafetyScore: 8, confidence: 97,
            recommendation: "auto_reject", summary: "E-cigarette/vaping advertisement in violation of network tobacco advertising ban. Product is explicitly banned from broadcast advertising under NAB guidelines and most network standards. Multiple blocking violations.",
            contentCategories: ["Tobacco", "Vaping", "Lifestyle"],
            moderatorBrief: "AUTO-REJECTED: Vaping/e-cigarette advertisement violates network-wide tobacco advertising prohibition. Juul is classified as a tobacco product under FDA regulations. This category is categorically blocked from broadcast. Do not clear under any circumstances without executive approval.",
            routingDecision: "auto_reject", routingConfidence: 97, stagesCompleted: [1, 2, 3], skippedDeepAnalysis: false, deepAnalysisTriggered: true,
            routingReason: "High confidence (97%) with confirmed blocking violations — auto-rejected without human review.",
            violations: [
              { policyArea: "tobacco", severity: "blocking", description: "E-cigarette/vaping product advertisement. Network tobacco advertising ban applies — Juul classified as FDA-regulated tobacco product.", confidence: 98 },
              { policyArea: "brand_safety", severity: "blocking", description: "Product targets young adults in lifestyle context. FDA has specifically cited Juul marketing as appealing to minors.", confidence: 94 },
              { policyArea: "legal_compliance", severity: "critical", description: "No FDA-required nicotine addiction warning present in advertisement.", confidence: 92 },
            ],
            objectionalContent: [
              { type: "tobacco", severity: "blocking", description: "Vaping/e-cigarette product (Juul). FDA-regulated tobacco product — network advertising ban applies.", confidence: 98, fccRelevant: true, iabRelevant: true },
              { type: "vaping", severity: "blocking", description: "E-cigarette use depicted in aspirational lifestyle context targeting young adults.", confidence: 95, fccRelevant: true, iabRelevant: true },
            ],
            flaggableContent: [], complianceScores: [], overallFccScore: 5, overallIabScore: 15,
            complianceSummary: "REJECTED: Vaping advertisement violates categorical network tobacco ban and FDA advertising regulations. Cannot be cleared.",
            highestRiskArea: "Network tobacco advertising prohibition and FDA e-cigarette regulations",
            requiredActions: ["Ad cannot be modified to meet standards — categorical ban applies", "Advise advertiser that vaping/tobacco advertising is not accepted on this network"],
            isPoliticalAd: false, detectedAdvertiser: { name: "Juul Labs Inc.", industry: "Tobacco / E-Cigarettes", confidence: 99 },
            detectedLanguages: [{ language: "English", script: "Latin", confidence: 99 }],
          },
          violations: [
            { severity: "blocking", description: "Network tobacco advertising ban — Juul is an FDA-regulated tobacco product. Categorical prohibition applies.", detectedBy: "ai" },
            { severity: "blocking", description: "Youth-appealing lifestyle marketing for nicotine product. FDA has cited Juul for marketing to minors.", detectedBy: "ai" },
            { severity: "critical", description: "Missing FDA-mandated nicotine addiction warning in advertisement.", detectedBy: "ai" },
          ],
        },
        // ── 8. Disney+ entertainment — submitted, pending analysis ────────────
        {
          fields: {
            title: "Disney+ Streaming Promo", format: "image" as const, sourceType: "upload" as const,
            fileUrl: "https://example.com/demo/disney-plus-promo.jpg",
            description: "Full-page digital display ad promoting Disney+ annual subscription. Features Marvel, Star Wars, and Disney content library.",
            targetAudience: "Families, entertainment fans 18-45", priority: "normal" as const, status: "submitted" as const,
            aiScore: null, brandSafetyScore: null, submittedBy: uid, submittedAt: ago(1),
          },
          aiAnalysis: null,
        },
      ];

      // 4. Insert ads, violations, and approval steps
      const createdIds: number[] = [];
      for (const demo of demoAds) {
        const { violations, approvalSteps, aiAnalysis, ...rest } = demo;
        const id = await db.createAdSubmission({ ...rest.fields, targetPlatforms: [] });
        createdIds.push(id);

        if (aiAnalysis !== null) {
          await db.updateAdSubmission(id, { aiAnalysis: aiAnalysis as any });
        }

        for (const v of violations ?? []) {
          await db.createPolicyViolation({
            adSubmissionId: id, policyId: null,
            severity: v.severity as any, description: v.description, detectedBy: v.detectedBy as any,
          });
        }

        if (approvalSteps && defaultChain) {
          for (const s of approvalSteps) {
            await db.createApprovalStep({
              adSubmissionId: id, approvalChainId: defaultChain.id,
              stepNumber: s.stepNumber, stepName: s.stepName, requiredRole: s.requiredRole,
              status: s.status as any,
              decidedBy: s.decidedBy ?? null, decidedAt: s.decidedAt ?? null,
              comments: s.comments ?? null,
            });
          }
        }

        await db.createAuditEntry({
          userId: uid, action: "create_ad", entityType: "ad_submission", entityId: id,
          details: { title: rest.fields.title, demo: true },
        });
      }

      await db.createAuditEntry({
        userId: uid, action: "seed_demo_data", entityType: "ad_submission",
        details: { count: createdIds.length, ids: createdIds },
      });

      return { count: createdIds.length, ids: createdIds };
    }),

    // @deprecated — use runAiReview
    runAiScreening: moderatorProcedure
      .input(z.object({ adId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        console.warn(`[DEPRECATED] runAiScreening called for ad ${input.adId} — use runAiReview instead`);
        const ad = await db.getAdSubmissionById(input.adId);
        if (!ad) throw new Error("Ad not found");

        await db.updateAdSubmission(input.adId, { status: "ai_screening" });

        const userId = ctx.user.id;
        const adId = input.adId;

        // Fire-and-forget: heavy LLM work runs in background; client polls for completion
        setImmediate(async () => {
          try {
            let adForAnalysis: typeof ad = ad;
            let resolvedThumbnailUrl = ad.thumbnailUrl;

            if (ad.sourceType === "upload" && ad.fileKey) {
              const { url } = await storageGetSignedUrl(ad.fileKey, 3600);
              if (!resolvedThumbnailUrl) resolvedThumbnailUrl = url;
              adForAnalysis = { ...ad, fileUrl: url, thumbnailUrl: resolvedThumbnailUrl };
            }

            // Resolve thumbnail presigned URL if it's a private R2 URL
            if (resolvedThumbnailUrl) {
              const thumbKey = deriveKeyFromStorageUrl(resolvedThumbnailUrl);
              if (thumbKey) {
                const { url } = await storageGetSignedUrl(thumbKey, 3600);
                resolvedThumbnailUrl = url;
              }
            }
            adForAnalysis = { ...adForAnalysis, thumbnailUrl: resolvedThumbnailUrl };

            const activePolicies = await db.getPolicies(true);
            const analysis = await analyzeAdContent(adForAnalysis, activePolicies);

            await db.updateAdSubmission(adId, {
              aiScore: analysis.overallScore,
              brandSafetyScore: analysis.brandSafetyScore,
              aiAnalysis: analysis as any,
              status: analysis.recommendation === "auto_reject" ? "rejected"
                : analysis.recommendation === "auto_approve" ? "approved"
                : "in_review",
            });

            for (const violation of analysis.violations) {
              const matchingPolicy = activePolicies.find(p =>
                p.name.toLowerCase().includes(violation.policyArea.toLowerCase()) ||
                p.category === violation.policyArea
              );
              await db.createPolicyViolation({
                adSubmissionId: adId,
                policyId: matchingPolicy?.id ?? null,
                severity: violation.severity,
                description: violation.description,
                detectedBy: "ai",
              });
            }

            await db.createAuditEntry({
              userId, action: "ai_screening",
              entityType: "ad_submission", entityId: adId,
              details: { score: analysis.overallScore, recommendation: analysis.recommendation },
            });

            await db.createNotification({
              userId,
              type: "ai_screening_complete",
              title: "AI Screening Complete",
              message: `AI analysis for "${ad.title}" complete. Score: ${analysis.overallScore}/100. Recommendation: ${analysis.recommendation}.`,
              relatedAdId: adId,
            });
          } catch (err) {
            const errorMessage = (err as Error)?.message ?? "Unknown error";
            console.error(`[runAiScreening] Background job failed for ad ${adId}: ${errorMessage}`, err);
            // Revert status to submitted; store error in aiAnalysis so the UI can surface it.
            // Critically: do NOT write any aiScore or brandSafetyScore — no fake scores.
            await db.updateAdSubmission(adId, {
              status: "submitted",
              aiAnalysis: { error: true, errorMessage } as any,
            }).catch(() => {});
          }
        });

        return { status: "running" as const };
      }),
    // @deprecated — moderator brief is now auto-generated in runAiReview Stage 3
    getAiSuggestion: moderatorProcedure
      .input(z.object({ adId: z.number() }))
      .mutation(async ({ input }) => {
        console.warn(`[DEPRECATED] getAiSuggestion called for ad ${input.adId} — moderator brief is now part of runAiReview`);
        const ad = await db.getAdSubmissionById(input.adId);
        if (!ad) throw new Error("Ad not found");
        const violations = await db.getViolationsForAd(input.adId);
        const suggestion = await generateModerationSuggestion(ad, violations);
        return { suggestion };
      }),
    // @deprecated — frame analysis is now Stage 1 of runAiReview
    runFrameAnalysis: moderatorProcedure
      .input(z.object({
        adId: z.number(),
        intervalSeconds: z.number().min(1).max(60).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        console.warn(`[DEPRECATED] runFrameAnalysis called for ad ${input.adId} — use runAiReview instead`);
        const ad = await db.getAdSubmissionById(input.adId);
        if (!ad) throw new Error("Ad not found");

        // Create the record BEFORE returning so client can poll it immediately
        const analysisId = await db.createFrameAnalysis({
          adSubmissionId: input.adId,
          status: "running",
          triggeredBy: ctx.user.id,
          startedAt: new Date(),
        });

        await db.createAuditEntry({
          userId: ctx.user.id, action: "frame_analysis_started",
          entityType: "ad_submission", entityId: input.adId,
          details: { analysisId, intervalSeconds: input.intervalSeconds || 1 },
        });

        const intervalSeconds = input.intervalSeconds || 1;
        const userId = ctx.user.id;
        const adId = input.adId;

        // Fire-and-forget: video download + ffmpeg extraction + LLM vision runs in background
        setImmediate(async () => {
          try {
            let resolvedFileUrl = ad.fileUrl;
            if (ad.sourceType === "upload" && ad.fileKey) {
              const { url } = await storageGetSignedUrl(ad.fileKey, 3600);
              resolvedFileUrl = url;
            }

            const activePolicies = await db.getPolicies(true);
            const result = await runFrameAnalysis(
              {
                adId: ad.id,
                title: ad.title,
                description: ad.description,
                format: ad.format,
                fileUrl: resolvedFileUrl,
                fileKey: ad.fileKey,
                sourceType: ad.sourceType,
                sourceUrl: ad.sourceUrl,
                videoProvider: ad.videoProvider,
                videoId: ad.videoId,
                thumbnailUrl: ad.thumbnailUrl,
                videoDuration: ad.videoDuration,
                targetAudience: ad.targetAudience,
              },
              activePolicies,
              intervalSeconds
            );

            await db.updateFrameAnalysis(analysisId, {
              totalFramesAnalyzed: result.totalFramesAnalyzed,
              analysisIntervalSeconds: result.analysisIntervalSeconds,
              overallVideoScore: result.overallVideoScore,
              flaggedFrameCount: result.flaggedFrameCount,
              frames: result.frames as any,
              summary: result.summary,
              worstTimestamp: result.worstTimestamp,
              worstIssue: result.worstIssue,
              status: result.status,
              completedAt: new Date(),
            });

            // Update the parent ad record so the Info panel reflects the frame analysis score.
            // Only write when the analysis actually completed (not partial/failed with fallback 50s).
            if (result.status === "completed" && result.totalFramesAnalyzed > 0) {
              await db.updateAdSubmission(adId, {
                aiScore: result.overallVideoScore,
                brandSafetyScore: result.overallVideoScore,
              });
              console.log(`[runFrameAnalysis] Updated ad ${adId} scores → aiScore=${result.overallVideoScore} brandSafetyScore=${result.overallVideoScore}`);
            }

            for (const frame of result.frames) {
              for (const issue of frame.issues) {
                if (issue.severity === "critical" || issue.severity === "blocking") {
                  const matchingPolicy = activePolicies.find(p =>
                    p.name.toLowerCase().includes(issue.policyArea.toLowerCase()) ||
                    p.category === issue.policyArea
                  );
                  await db.createPolicyViolation({
                    adSubmissionId: adId,
                    policyId: matchingPolicy?.id ?? null,
                    severity: issue.severity === "blocking" ? "critical" : issue.severity,
                    description: `[Frame at ${frame.timestampFormatted}] ${issue.description}`,
                    detectedBy: "ai",
                  });
                }
              }
            }

            await db.createNotification({
              userId,
              type: "ai_screening_complete",
              title: "Frame Analysis Complete",
              message: `Frame-by-frame analysis for "${ad.title}" complete. Analyzed ${result.totalFramesAnalyzed} frames. ${result.flaggedFrameCount} flagged.`,
              relatedAdId: adId,
            });
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : "Unknown error";
            console.error(`[runFrameAnalysis] Background job failed for ad ${adId}:`, errMsg);
            await db.updateFrameAnalysis(analysisId, {
              status: "failed",
              summary: `Analysis failed: ${errMsg}`,
              completedAt: new Date(),
            }).catch(() => {});
          }
        });

        // Return immediately — client polls getFrameAnalysis for completion
        return { analysisId, status: "running" as const };
      }),
    getFrameAnalysis: protectedProcedure
      .input(z.object({ adId: z.number() }))
      .query(async ({ input }) => {
        return db.getFrameAnalysisForAd(input.adId);
      }),
    getFrameAnalyses: protectedProcedure
      .input(z.object({ adId: z.number() }))
      .query(async ({ input }) => {
        return db.getFrameAnalysesForAd(input.adId);
      }),

    // ── Gemini Native Video Analysis ─────────────────────────────────────────
    // Sends the raw video (or YouTube URL) to Gemini 2.5 Pro for multimodal
    // compliance analysis. Catches audio violations, spoken disclaimer issues,
    // and temporal patterns that frame sampling misses.
    // Results are stored alongside (not replacing) any existing aiAnalysis data.
    runGeminiAnalysis: moderatorProcedure
      .input(z.object({ adId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const ad = await db.getAdSubmissionById(input.adId);
        if (!ad) throw new Error("Ad not found");
        if (ad.format !== "video") {
          throw new Error("Gemini analysis is only available for video ads");
        }

        // Create a frame-analysis record so the client can poll for completion
        // via ads.getFrameAnalysis — totalFramesAnalyzed will be 0 (no discrete frames)
        const analysisId = await db.createFrameAnalysis({
          adSubmissionId: input.adId,
          status: "running",
          triggeredBy: ctx.user.id,
          startedAt: new Date(),
        });

        const userId = ctx.user.id;
        const adId = input.adId;
        const adTitle = ad.title;

        setImmediate(async () => {
          // Run Whisper in parallel with Gemini — saves transcript even if Gemini fails
          const whisperInput = ad.videoProvider !== "youtube" && ad.fileKey
            ? { fileKey: ad.fileKey, adTitle }
            : null;
          const whisperPromise = whisperInput
            ? transcribeVideoAudio(whisperInput).catch((err: Error) => {
                console.warn(`[Whisper] Transcription failed (non-fatal): ${err.message}`);
                return null;
              })
            : Promise.resolve(null);

          try {
            const [result, transcript] = await Promise.all([
              analyzeVideoWithGemini({
                fileKey: ad.fileKey,
                sourceUrl: ad.sourceUrl || ad.fileUrl,
                videoProvider: ad.videoProvider,
                mimeType: ad.fileMimeType,
                adTitle,
              }),
              whisperPromise,
            ]);

            const findingCount = result.findings.length;
            const overallScore = Math.round(
              (result.overallFccScore + result.overallIabScore) / 2,
            );
            const worstFinding = result.findings.find(
              f => f.severity === "blocking" || f.severity === "critical",
            );

            await db.updateFrameAnalysis(analysisId, {
              // Gemini processes natively — no discrete frame count
              totalFramesAnalyzed: 0,
              analysisIntervalSeconds: 0,
              overallVideoScore: overallScore,
              flaggedFrameCount: findingCount,
              frames: result.findings as any,
              summary: result.complianceSummary,
              worstTimestamp: worstFinding?.timestampSeconds != null
                ? String(worstFinding.timestampSeconds)
                : null,
              worstIssue: worstFinding?.description ?? null,
              status: "completed",
              completedAt: new Date(),
            });

            // Merge Gemini + Whisper results into aiAnalysis without clobbering existing data
            const freshAd = await db.getAdSubmissionById(adId);
            const existingAnalysis =
              (freshAd?.aiAnalysis as Record<string, unknown>) ?? {};
            await db.updateAdSubmission(adId, {
              aiAnalysis: {
                ...existingAnalysis,
                geminiAnalysis: result,
                geminiScore: overallScore,
                ...(transcript ? { whisperTranscript: transcript } : {}),
              } as any,
            });

            // Record blocking/critical findings as policy violations
            const activePolicies = await db.getPolicies(true);
            for (const finding of result.findings) {
              if (finding.severity !== "blocking" && finding.severity !== "critical") continue;
              const matchingPolicy = activePolicies.find(p =>
                p.name.toLowerCase().includes(finding.ruleName.toLowerCase())
              );
              await db.createPolicyViolation({
                adSubmissionId: adId,
                policyId: matchingPolicy?.id ?? null,
                severity: finding.severity === "blocking" ? "critical" : finding.severity,
                description: `[Gemini${finding.timestampSeconds != null ? ` @${finding.timestampSeconds}s` : ""}] ${finding.description}`,
                detectedBy: "ai",
              });
            }

            await db.createAuditEntry({
              userId,
              action: "gemini_analysis_complete",
              entityType: "ad_submission",
              entityId: adId,
              details: {
                fccScore: result.overallFccScore,
                iabScore: result.overallIabScore,
                findingCount,
                blockingCount: result.findings.filter(f => f.severity === "blocking").length,
                criticalCount: result.findings.filter(f => f.severity === "critical").length,
                sourceType: result.sourceType,
                durationMs: result.durationMs,
              },
            });

            await db.createNotification({
              userId,
              type: "ai_screening_complete",
              title: "Gemini Analysis Complete",
              message:
                `Gemini analysis of "${adTitle}" complete. ` +
                `FCC: ${result.overallFccScore}/100, IAB: ${result.overallIabScore}/100. ` +
                `${findingCount} finding${findingCount !== 1 ? "s" : ""}.`,
              relatedAdId: adId,
            });

          } catch (err) {
            const errorMessage = (err as Error)?.message ?? "Unknown error";
            console.error(`[runGeminiAnalysis] Failed for ad ${adId}: ${errorMessage}`);

            await db.updateFrameAnalysis(analysisId, {
              status: "failed",
              summary: `Gemini analysis failed: ${errorMessage}`,
              completedAt: new Date(),
            }).catch(() => {});

            // Save Whisper transcript even when Gemini fails
            const transcriptOnFailure = await whisperPromise;
            if (transcriptOnFailure) {
              const freshAd = await db.getAdSubmissionById(adId).catch(() => null);
              const existingAnalysis = (freshAd?.aiAnalysis as Record<string, unknown>) ?? {};
              await db.updateAdSubmission(adId, {
                aiAnalysis: { ...existingAnalysis, whisperTranscript: transcriptOnFailure } as any,
              }).catch(() => {});
              console.log(`[Whisper] Transcript saved to ad ${adId} despite Gemini failure`);
            }

            await db.createNotification({
              userId,
              type: "ai_screening_complete",
              title: "Gemini Analysis Failed",
              message: `Gemini analysis of "${adTitle}" failed: ${errorMessage}`,
              relatedAdId: adId,
            }).catch(() => {});
          }
        });

        return { analysisId, status: "running" as const };
      }),
  }),

  // ─── Reviews ─────────────────────────────────────────────────────────────
  reviews: router({
    forAd: protectedProcedure
      .input(z.object({ adSubmissionId: z.number() }))
      .query(async ({ input }) => {
        return db.getReviewsForAd(input.adSubmissionId);
      }),
    myReviews: protectedProcedure.query(async ({ ctx }) => {
      return db.getReviewsByReviewer(ctx.user.id);
    }),
    submit: moderatorProcedure
      .input(z.object({
        adSubmissionId: z.number(),
        decision: z.enum(["approve", "reject", "request_changes", "escalate"]),
        comments: z.string().optional(),
        annotations: z.any().optional(),
        violationsFound: z.any().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const ad = await db.getAdSubmissionById(input.adSubmissionId);
        const currentStep = ad?.currentApprovalStep ?? 0;

        const id = await db.createReview({
          ...input,
          reviewerId: ctx.user.id,
          approvalStep: currentStep,
          reviewStartedAt: new Date(),
          reviewCompletedAt: new Date(),
        });

        // Create violations if reported
        if (input.violationsFound && Array.isArray(input.violationsFound)) {
          for (const v of input.violationsFound) {
            await db.createPolicyViolation({
              adSubmissionId: input.adSubmissionId,
              policyId: v.policyId || null,
              severity: v.severity || "warning",
              description: v.description || "",
              detectedBy: "human",
            });
          }
        }

        // ── Approval chain advancement ────────────────────────────────────
        if (currentStep > 0 && (input.decision === "approve" || input.decision === "reject")) {
          const steps = await db.getApprovalStepsForAd(input.adSubmissionId);
          const currentStepRecord = steps.find(s => s.stepNumber === currentStep);
          if (currentStepRecord) {
            await db.updateApprovalStep(currentStepRecord.id, {
              status: input.decision === "approve" ? "approved" : "rejected",
              decidedBy: ctx.user.id,
              decidedAt: new Date(),
              comments: input.comments ?? null,
            });
          }

          if (input.decision === "approve") {
            const nextStep = steps.find(s => s.stepNumber > currentStep && s.status === "pending");
            if (nextStep) {
              // Advance to next step — ad stays in_review
              await db.updateAdSubmission(input.adSubmissionId, {
                status: "in_review",
                currentApprovalStep: nextStep.stepNumber,
              });
              // Notify users eligible for the next step
              const allUsers = await db.getAllUsers();
              const eligible = allUsers.filter(
                u => u.platformRole === nextStep.requiredRole || u.platformRole === "admin" || u.role === "admin"
              );
              for (const reviewer of eligible) {
                await db.createNotification({
                  userId: reviewer.id,
                  type: "review_assigned",
                  title: "Review Assigned",
                  message: `"${ad?.title}" advanced to ${nextStep.stepName} (Step ${nextStep.stepNumber}).`,
                  relatedAdId: input.adSubmissionId,
                });
              }
            } else {
              // Final step approved → fully approved
              await db.updateAdSubmission(input.adSubmissionId, { status: "approved" });
            }
          } else {
            // Rejected at any step → immediate rejection
            await db.updateAdSubmission(input.adSubmissionId, { status: "rejected" });
          }
        } else {
          // Not in a chain, or request_changes/escalate — use direct status map
          const statusMap: Record<string, string> = {
            approve: "approved",
            reject: "rejected",
            request_changes: "changes_requested",
            escalate: "escalated",
          };
          await db.updateAdSubmission(input.adSubmissionId, {
            status: statusMap[input.decision] as any,
          });
        }

        // Notify the submitter of the outcome
        if (ad?.submittedBy) {
          await db.createNotification({
            userId: ad.submittedBy,
            type: "review_completed",
            title: `Review ${input.decision}`,
            message: `Your ad "${ad.title}" has been ${input.decision === "approve" ? "approved" : input.decision}d. ${input.comments || ""}`,
            relatedAdId: input.adSubmissionId,
          });
        }

        await db.createAuditEntry({
          userId: ctx.user.id, action: "submit_review",
          entityType: "review", entityId: id,
          details: { adId: input.adSubmissionId, decision: input.decision, approvalStep: currentStep },
        });

        return { id };
      }),
    stats: protectedProcedure.query(async () => {
      return db.getReviewStats();
    }),
  }),

  // ─── Policies ────────────────────────────────────────────────────────────
  policies: router({
    list: protectedProcedure
      .input(z.object({ activeOnly: z.boolean().optional() }).optional())
      .query(async ({ input }) => {
        return db.getPolicies(input?.activeOnly);
      }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getPolicyById(input.id);
      }),
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        category: z.enum(["content_standards", "brand_safety", "legal_compliance", "industry_specific", "platform_rules", "custom"]),
        complianceFramework: z.string().optional(),
        rules: z.any().optional(),
        severity: z.enum(["info", "warning", "critical", "blocking"]).optional(),
        isTemplate: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await db.createPolicy({ ...input, createdBy: ctx.user.id });
        await db.createAuditEntry({
          userId: ctx.user.id, action: "create_policy",
          entityType: "policy", entityId: id, details: { name: input.name },
        });
        return { id };
      }),
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        rules: z.any().optional(),
        severity: z.enum(["info", "warning", "critical", "blocking"]).optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        await db.updatePolicy(id, data);
        await db.createAuditEntry({
          userId: ctx.user.id, action: "update_policy",
          entityType: "policy", entityId: id, details: data,
        });
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.deletePolicy(input.id);
        await db.createAuditEntry({
          userId: ctx.user.id, action: "delete_policy",
          entityType: "policy", entityId: input.id,
        });
        return { success: true };
      }),
    seedTemplates: adminProcedure.mutation(async ({ ctx }) => {
      const templates = getDefaultPolicySeedData();
      const ids = [];
      for (const t of templates) {
        const id = await db.createPolicy({ ...t, createdBy: ctx.user.id });
        ids.push(id);
      }

      // Seed the default approval chain if none exists
      const existingDefault = await db.getDefaultApprovalChain();
      let defaultChainCreated = false;
      if (!existingDefault) {
        await db.createApprovalChain({
          name: "Standard S&P Review",
          description: "Three-stage Standards & Practices review for broadcast ad clearance. Ads recommended for human review by the AI agent are routed through this chain automatically.",
          isDefault: true,
          isActive: true,
          steps: [
            { step: 1, name: "Initial Screening", role: "reviewer" },
            { step: 2, name: "S&P Review", role: "moderator" },
            { step: 3, name: "Final Clearance", role: "admin" },
          ],
          createdBy: ctx.user.id,
        });
        defaultChainCreated = true;
        console.log("[seedTemplates] Created default approval chain: Standard S&P Review");
      }

      await db.createAuditEntry({
        userId: ctx.user.id, action: "seed_compliance_templates",
        entityType: "policy", details: { count: ids.length, frameworks: ["FCC", "IAB"], defaultChainCreated },
      });
      return { count: ids.length, ids, defaultChainCreated };
    }),
  }),

  // ─── Violations ──────────────────────────────────────────────────────────
  violations: router({
    forAd: protectedProcedure
      .input(z.object({ adSubmissionId: z.number() }))
      .query(async ({ input }) => {
        return db.getViolationsForAd(input.adSubmissionId);
      }),
    resolve: moderatorProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["resolved", "dismissed", "overridden"]),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateViolation(input.id, {
          status: input.status,
          resolvedBy: ctx.user.id,
          resolvedAt: new Date(),
        });
        return { success: true };
      }),
    stats: protectedProcedure.query(async () => {
      return db.getViolationStats();
    }),
  }),

  // ─── Approval Chains ────────────────────────────────────────────────────
  approvalChains: router({
    list: protectedProcedure.query(async () => {
      return db.getApprovalChains();
    }),
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        steps: z.any(),
        isDefault: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await db.createApprovalChain({ ...input, createdBy: ctx.user.id });
        return { id };
      }),
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        steps: z.any().optional(),
        isDefault: z.boolean().optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateApprovalChain(id, data);
        return { success: true };
      }),
    // Initialize approval steps for an ad
    initForAd: moderatorProcedure
      .input(z.object({ adId: z.number(), chainId: z.number().optional() }))
      .mutation(async ({ input }) => {
        let chain;
        if (input.chainId) {
          const chains = await db.getApprovalChains();
          chain = chains.find(c => c.id === input.chainId);
        } else {
          chain = await db.getDefaultApprovalChain();
        }
        if (!chain || !chain.steps) throw new Error("No approval chain found");
        const steps = chain.steps as any[];
        for (const step of steps) {
          await db.createApprovalStep({
            adSubmissionId: input.adId,
            approvalChainId: chain.id,
            stepNumber: step.step,
            stepName: step.name,
            requiredRole: step.role,
          });
        }
        await db.updateAdSubmission(input.adId, { currentApprovalStep: 1 });
        return { success: true, stepsCreated: steps.length };
      }),
    // Decide on an approval step
    decideStep: moderatorProcedure
      .input(z.object({
        stepId: z.number(),
        decision: z.enum(["approved", "rejected"]),
        comments: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateApprovalStep(input.stepId, {
          status: input.decision,
          decidedBy: ctx.user.id,
          decidedAt: new Date(),
          comments: input.comments,
        });
        return { success: true };
      }),
  }),

  // ─── Notifications ───────────────────────────────────────────────────────
  notifications: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getNotificationsForUser(ctx.user.id);
    }),
    unreadCount: protectedProcedure.query(async ({ ctx }) => {
      return db.getUnreadNotificationCount(ctx.user.id);
    }),
    markRead: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.markNotificationRead(input.id);
        return { success: true };
      }),
    markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
      await db.markAllNotificationsRead(ctx.user.id);
      return { success: true };
    }),
  }),

  // ─── Category Blocks (Brand Safety) ──────────────────────────────────────
  categoryBlocks: router({
    list: protectedProcedure.query(async () => {
      return db.getCategoryBlocks();
    }),
    create: adminProcedure
      .input(z.object({
        category: z.string().min(1),
        advertiserId: z.number().optional(),
        reason: z.string().optional(),
        isGlobal: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await db.createCategoryBlock({ ...input, createdBy: ctx.user.id });
        return { id };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteCategoryBlock(input.id);
        return { success: true };
      }),
  }),

  // ─── Integrations ───────────────────────────────────────────────────────
  integrations: router({
    list: adminProcedure.query(async () => {
      return db.getIntegrations();
    }),
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        type: z.enum(["ad_platform", "cms", "analytics", "webhook", "custom"]),
        config: z.any().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await db.createIntegration({ ...input, createdBy: ctx.user.id });
        return { id };
      }),
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        config: z.any().optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateIntegration(id, data);
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteIntegration(input.id);
        return { success: true };
      }),
  }),

  // ─── Audit Log ───────────────────────────────────────────────────────────
  audit: router({
    list: adminProcedure
      .input(z.object({ limit: z.number().optional() }).optional())
      .query(async ({ input }) => {
        return db.getAuditLog(input?.limit ?? 100);
      }),
  }),
});

export type AppRouter = typeof appRouter;

// ─── Compliance Template Data ────────────────────────────────────────────────
function getComplianceTemplates() {
  return [
    {
      name: "FCC Broadcast Standards",
      description: "Federal Communications Commission broadcast advertising standards including rules on indecency, obscenity, and children's programming.",
      category: "legal_compliance" as const,
      complianceFramework: "FCC",
      severity: "critical" as const,
      isTemplate: true,
      isActive: true,
      rules: {
        checks: [
          "No obscene content",
          "No indecent content during restricted hours (6AM-10PM)",
          "Children's programming ad limits (10.5 min/hr weekends, 12 min/hr weekdays)",
          "Station identification requirements",
          "Political advertising equal time rules",
          "Sponsorship identification",
        ]
      },
    },
    {
      name: "FTC Advertising Guidelines",
      description: "Federal Trade Commission guidelines on truthful advertising, endorsements, and disclosures.",
      category: "legal_compliance" as const,
      complianceFramework: "FTC",
      severity: "critical" as const,
      isTemplate: true,
      isActive: true,
      rules: {
        checks: [
          "No deceptive or misleading claims",
          "Substantiation for all claims",
          "Clear and conspicuous disclosures",
          "Endorsement and testimonial guidelines",
          "Native advertising disclosure requirements",
          "Health and safety claim verification",
          "Environmental marketing claims (Green Guides)",
        ]
      },
    },
    {
      name: "GDPR Data Privacy",
      description: "General Data Protection Regulation requirements for advertising that involves personal data processing.",
      category: "legal_compliance" as const,
      complianceFramework: "GDPR",
      severity: "blocking" as const,
      isTemplate: true,
      isActive: true,
      rules: {
        checks: [
          "Lawful basis for data processing in ad targeting",
          "Consent requirements for personalized advertising",
          "Data minimization in ad creative",
          "Right to object to direct marketing",
          "Privacy notice requirements",
          "Cross-border data transfer compliance",
          "Children's data protection (under 16)",
        ]
      },
    },
    {
      name: "CCPA Consumer Privacy",
      description: "California Consumer Privacy Act requirements for advertising and data usage.",
      category: "legal_compliance" as const,
      complianceFramework: "CCPA",
      severity: "critical" as const,
      isTemplate: true,
      isActive: true,
      rules: {
        checks: [
          "Do Not Sell opt-out compliance",
          "Consumer data disclosure requirements",
          "Financial incentive program disclosures",
          "Service provider restrictions",
          "Minors' data sale restrictions (under 16)",
        ]
      },
    },
    {
      name: "Brand Safety Standards",
      description: "Industry-standard brand safety checks to protect advertiser reputation and audience trust.",
      category: "brand_safety" as const,
      severity: "warning" as const,
      isTemplate: true,
      isActive: true,
      rules: {
        checks: [
          "No hate speech or discrimination",
          "No graphic violence",
          "No adult/sexual content",
          "No illegal activity promotion",
          "No terrorism or extremism",
          "No misinformation or fake news",
          "Content-context alignment verification",
          "Competitive separation enforcement",
        ]
      },
    },
    {
      name: "Content Quality Standards",
      description: "General content quality and production standards for advertising materials.",
      category: "content_standards" as const,
      severity: "warning" as const,
      isTemplate: true,
      isActive: true,
      rules: {
        checks: [
          "Technical quality requirements (resolution, audio levels)",
          "Grammar and spelling accuracy",
          "Appropriate use of trademarks and logos",
          "Accurate pricing and offer details",
          "Expiration dates and time-limited offers clarity",
          "Contact information accuracy",
          "Accessibility requirements (captions, alt text)",
        ]
      },
    },
  ];
}
