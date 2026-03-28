import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { storagePut, storageGetSignedUrl, deriveKeyFromStorageUrl } from "./storage";
import { analyzeAdContent, generateModerationSuggestion } from "./aiModeration";
import { parseVideoUrl, detectVideoProvider, isVideoUrl } from "./videoUrlParser";
import { runFrameAnalysis } from "./frameAnalysis";
import { getDefaultPolicySeedData } from "./complianceFrameworks";
import { nanoid } from "nanoid";

// ─── Background Auto-Analysis ───────────────────────────────────────────────
// Triggered automatically when a new ad is submitted. Runs frame analysis
// (for visual content) and AI screening in sequence, without blocking the
// create response.

async function performAutoAnalysis(adId: number, triggeredByUserId: number): Promise<void> {
  const ad = await db.getAdSubmissionById(adId);
  if (!ad) return;

  // Resolve presigned URLs for private R2 files (video + thumbnail)
  let resolvedFileUrl = ad.fileUrl;
  let resolvedThumbnailUrl = ad.thumbnailUrl;
  if (ad.sourceType === "upload" && ad.fileKey) {
    const { url } = await storageGetSignedUrl(ad.fileKey, 7200);
    resolvedFileUrl = url;
    if (!resolvedThumbnailUrl) resolvedThumbnailUrl = url;
  }
  // Resolve thumbnail separately if it has its own R2 key (uploaded thumbs are private too)
  if (resolvedThumbnailUrl) {
    const thumbKey = deriveKeyFromStorageUrl(resolvedThumbnailUrl);
    if (thumbKey) {
      const { url } = await storageGetSignedUrl(thumbKey, 7200);
      resolvedThumbnailUrl = url;
      console.log(`[AutoAnalysis] Resolved thumbnail to presigned URL for ad ${adId}`);
    }
  }

  const activePolicies = await db.getPolicies(true);

  // Mark as ai_screening
  await db.updateAdSubmission(adId, { status: "ai_screening" });

  // ── Frame analysis for visual content ──────────────────────────────────
  const isVisual = ad.format === "video" || ad.format === "image" ||
    ["youtube", "vimeo", "direct_url"].includes(ad.sourceType ?? "");

  if (isVisual) {
    const analysisId = await db.createFrameAnalysis({
      adSubmissionId: adId,
      status: "running",
      triggeredBy: triggeredByUserId,
      startedAt: new Date(),
    });
    try {
      const frameResult = await runFrameAnalysis(
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
          thumbnailUrl: resolvedThumbnailUrl,
          videoDuration: ad.videoDuration,
          targetAudience: ad.targetAudience,
        },
        activePolicies,
        1
      );
      await db.updateFrameAnalysis(analysisId, {
        totalFramesAnalyzed: frameResult.totalFramesAnalyzed,
        analysisIntervalSeconds: frameResult.analysisIntervalSeconds,
        overallVideoScore: frameResult.overallVideoScore,
        flaggedFrameCount: frameResult.flaggedFrameCount,
        frames: frameResult.frames as any,
        summary: frameResult.summary,
        worstTimestamp: frameResult.worstTimestamp,
        worstIssue: frameResult.worstIssue,
        status: frameResult.status,
        completedAt: new Date(),
      });
      for (const frame of frameResult.frames) {
        for (const issue of frame.issues) {
          if (issue.severity === "critical" || issue.severity === "blocking") {
            const matchingPolicy = activePolicies.find(p =>
              p.name.toLowerCase().includes(issue.policyArea.toLowerCase()) ||
              p.category === issue.policyArea
            );
            await db.createPolicyViolation({
              adSubmissionId: adId,
              policyId: matchingPolicy?.id ?? 0,
              severity: issue.severity === "blocking" ? "critical" : issue.severity,
              description: `[Frame at ${frame.timestampFormatted}] ${issue.description}`,
              detectedBy: "ai",
            });
          }
        }
      }
    } catch (err) {
      console.error(`[AutoAnalysis] Frame analysis failed for ad ${adId}:`, err);
      await db.updateFrameAnalysis(analysisId, { status: "failed", completedAt: new Date() });
    }
  }

  // ── AI content screening ────────────────────────────────────────────────
  const adForAnalysis = { ...ad, fileUrl: resolvedFileUrl, thumbnailUrl: resolvedThumbnailUrl };
  let analysis;
  try {
    analysis = await analyzeAdContent(adForAnalysis, activePolicies);
  } catch (err) {
    const errorMessage = (err as Error)?.message ?? "Unknown error";
    console.error(`[AutoAnalysis] AI screening failed for ad ${adId}: ${errorMessage}`);
    // Revert status to submitted so the user can retry; do NOT write fake scores
    await db.updateAdSubmission(adId, {
      status: "submitted",
      aiAnalysis: { error: true, errorMessage } as any,
    });
    return;
  }

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
      policyId: matchingPolicy?.id ?? 0,
      severity: violation.severity,
      description: violation.description,
      detectedBy: "ai",
    });
  }

  await db.createAuditEntry({
    userId: triggeredByUserId,
    action: "auto_ai_screening",
    entityType: "ad_submission",
    entityId: adId,
    details: { score: analysis.overallScore, recommendation: analysis.recommendation, autoTriggered: true },
  });

  await db.createNotification({
    userId: triggeredByUserId,
    type: "ai_screening_complete",
    title: "Auto AI Analysis Complete",
    message: `Analysis of "${ad.title}" complete. Score: ${analysis.overallScore}/100. Recommendation: ${analysis.recommendation.replace(/_/g, " ")}.`,
    relatedAdId: adId,
  });
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
        const id = await db.createAdvertiser({ ...input, createdBy: ctx.user.id });
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
        await db.updateAdvertiser(id, data);
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
        const approvalSteps = await db.getApprovalStepsForAd(input.id);
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
        const id = await db.createAdSubmission({
          ...input,
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
        status: z.enum(["draft", "submitted", "ai_screening", "in_review", "escalated", "changes_requested", "approved", "rejected", "published", "archived"]).optional(),
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
    // AI screening — returns immediately, runs analysis in background
    runAiScreening: moderatorProcedure
      .input(z.object({ adId: z.number() }))
      .mutation(async ({ input, ctx }) => {
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
                policyId: matchingPolicy?.id ?? 0,
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
    // Get AI suggestion for moderator
    getAiSuggestion: moderatorProcedure
      .input(z.object({ adId: z.number() }))
      .mutation(async ({ input }) => {
        const ad = await db.getAdSubmissionById(input.adId);
        if (!ad) throw new Error("Ad not found");
        const violations = await db.getViolationsForAd(input.adId);
        const suggestion = await generateModerationSuggestion(ad, violations);
        return { suggestion };
      }),
    // Frame-by-frame analysis — returns immediately, runs extraction/analysis in background
    runFrameAnalysis: moderatorProcedure
      .input(z.object({
        adId: z.number(),
        intervalSeconds: z.number().min(1).max(60).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
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
                    policyId: matchingPolicy?.id ?? 0,
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
        const id = await db.createReview({
          ...input,
          reviewerId: ctx.user.id,
          reviewStartedAt: new Date(),
          reviewCompletedAt: new Date(),
        });

        // Update ad status based on decision
        const statusMap: Record<string, string> = {
          approve: "approved",
          reject: "rejected",
          request_changes: "changes_requested",
          escalate: "escalated",
        };
        await db.updateAdSubmission(input.adSubmissionId, {
          status: statusMap[input.decision] as any,
        });

        // Create violations if reported
        if (input.violationsFound && Array.isArray(input.violationsFound)) {
          for (const v of input.violationsFound) {
            await db.createPolicyViolation({
              adSubmissionId: input.adSubmissionId,
              policyId: v.policyId || 0,
              severity: v.severity || "warning",
              description: v.description || "",
              detectedBy: "human",
            });
          }
        }

        const ad = await db.getAdSubmissionById(input.adSubmissionId);
        if (ad?.submittedBy) {
          await db.createNotification({
            userId: ad.submittedBy,
            type: "review_completed",
            title: `Review ${input.decision}`,
            message: `Your ad "${ad.title}" has been ${input.decision}ed. ${input.comments || ""}`,
            relatedAdId: input.adSubmissionId,
          });
        }

        await db.createAuditEntry({
          userId: ctx.user.id, action: "submit_review",
          entityType: "review", entityId: id,
          details: { adId: input.adSubmissionId, decision: input.decision },
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
      await db.createAuditEntry({
        userId: ctx.user.id, action: "seed_compliance_templates",
        entityType: "policy", details: { count: ids.length, frameworks: ["FCC", "IAB"] },
      });
      return { count: ids.length, ids };
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
