import { eq, desc, and, sql, inArray, isNull, or, like, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  InsertUser, users,
  adSubmissions, InsertAdSubmission, AdSubmission,
  advertisers, InsertAdvertiser,
  reviews, InsertReview,
  policies, InsertPolicy,
  policyViolations, InsertPolicyViolation,
  approvalChains, InsertApprovalChain,
  approvalSteps, InsertApprovalStep,
  notifications, InsertNotification,
  auditLog, InsertAuditLogEntry,
  categoryBlocks, InsertCategoryBlock,
  integrations, InsertIntegration,
  frameAnalyses, InsertFrameAnalysis,
} from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── Users ───────────────────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  type TextField = (typeof textFields)[number];
  const assignNullable = (field: TextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };
  textFields.forEach(assignNullable);
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  if (user.platformRole !== undefined) { values.platformRole = user.platformRole; updateSet.platformRole = user.platformRole; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  await db.insert(users).values(values).onConflictDoNothing();
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(
    sql`LOWER(${users.email}) = LOWER(${email})`
  ).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function updateUserPlatformRole(userId: number, platformRole: "viewer" | "reviewer" | "moderator" | "admin") {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ platformRole }).where(eq(users.id, userId));
}

// ─── Advertisers ─────────────────────────────────────────────────────────────
export async function createAdvertiser(data: InsertAdvertiser) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(advertisers).values(data).returning({ id: advertisers.id });
  return result[0].id;
}

export async function getAdvertisers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(advertisers).orderBy(desc(advertisers.createdAt));
}

export async function getAdvertiserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(advertisers).where(eq(advertisers.id, id)).limit(1);
  return result[0];
}

export async function updateAdvertiser(id: number, data: Partial<InsertAdvertiser>) {
  const db = await getDb();
  if (!db) return;
  await db.update(advertisers).set(data).where(eq(advertisers.id, id));
}

// ─── Ad Submissions ──────────────────────────────────────────────────────────
export async function createAdSubmission(data: InsertAdSubmission) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(adSubmissions).values(data).returning({ id: adSubmissions.id });
  return result[0].id;
}

export async function getAdSubmissions(filters?: {
  status?: string;
  priority?: string;
  assignedTo?: number;
  format?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters?.status) conditions.push(eq(adSubmissions.status, filters.status as any));
  if (filters?.priority) conditions.push(eq(adSubmissions.priority, filters.priority as any));
  if (filters?.assignedTo) conditions.push(eq(adSubmissions.assignedTo, filters.assignedTo));
  if (filters?.format) conditions.push(eq(adSubmissions.format, filters.format as any));
  if (filters?.search) conditions.push(like(adSubmissions.title, `%${filters.search}%`));

  const query = db.select().from(adSubmissions);
  if (conditions.length > 0) {
    return query.where(and(...conditions)).orderBy(desc(adSubmissions.createdAt)).limit(filters?.limit ?? 50).offset(filters?.offset ?? 0);
  }
  return query.orderBy(desc(adSubmissions.createdAt)).limit(filters?.limit ?? 50).offset(filters?.offset ?? 0);
}

export async function getAdSubmissionById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(adSubmissions).where(eq(adSubmissions.id, id)).limit(1);
  return result[0];
}

export async function updateAdSubmission(id: number, data: Partial<InsertAdSubmission>) {
  const db = await getDb();
  if (!db) return;
  await db.update(adSubmissions).set(data).where(eq(adSubmissions.id, id));
}

export async function getAdSubmissionCounts() {
  const db = await getDb();
  if (!db) return {};
  const results = await db.select({
    status: adSubmissions.status,
    count: count(),
  }).from(adSubmissions).groupBy(adSubmissions.status);
  const counts: Record<string, number> = {};
  results.forEach(r => { counts[r.status] = r.count; });
  return counts;
}

// ─── Reviews ─────────────────────────────────────────────────────────────────
export async function createReview(data: InsertReview) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(reviews).values(data).returning({ id: reviews.id });
  return result[0].id;
}

export async function getReviewsForAd(adSubmissionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reviews).where(eq(reviews.adSubmissionId, adSubmissionId)).orderBy(desc(reviews.createdAt));
}

export async function getReviewsByReviewer(reviewerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reviews).where(eq(reviews.reviewerId, reviewerId)).orderBy(desc(reviews.createdAt));
}

export async function getReviewStats() {
  const db = await getDb();
  if (!db) return { total: 0, today: 0 };
  const [totalResult] = await db.select({ count: count() }).from(reviews);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [todayResult] = await db.select({ count: count() }).from(reviews).where(
    sql`${reviews.createdAt} >= ${today}`
  );
  return { total: totalResult.count, today: todayResult.count };
}

// ─── Policies ────────────────────────────────────────────────────────────────
export async function createPolicy(data: InsertPolicy) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(policies).values(data).returning({ id: policies.id });
  return result[0].id;
}

export async function getPolicies(activeOnly = false) {
  const db = await getDb();
  if (!db) return [];
  if (activeOnly) {
    return db.select().from(policies).where(eq(policies.isActive, true)).orderBy(desc(policies.createdAt));
  }
  return db.select().from(policies).orderBy(desc(policies.createdAt));
}

export async function getPolicyById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(policies).where(eq(policies.id, id)).limit(1);
  return result[0];
}

export async function updatePolicy(id: number, data: Partial<InsertPolicy>) {
  const db = await getDb();
  if (!db) return;
  await db.update(policies).set(data).where(eq(policies.id, id));
}

export async function deletePolicy(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(policies).where(eq(policies.id, id));
}

// ─── Policy Violations ───────────────────────────────────────────────────────
export async function createPolicyViolation(data: InsertPolicyViolation) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(policyViolations).values(data).returning({ id: policyViolations.id });
  return result[0].id;
}

export async function getViolationsForAd(adSubmissionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(policyViolations).where(eq(policyViolations.adSubmissionId, adSubmissionId)).orderBy(desc(policyViolations.createdAt));
}

export async function updateViolation(id: number, data: Partial<InsertPolicyViolation>) {
  const db = await getDb();
  if (!db) return;
  await db.update(policyViolations).set(data).where(eq(policyViolations.id, id));
}

export async function getViolationStats() {
  const db = await getDb();
  if (!db) return { total: 0, open: 0 };
  const [totalResult] = await db.select({ count: count() }).from(policyViolations);
  const [openResult] = await db.select({ count: count() }).from(policyViolations).where(eq(policyViolations.status, "open"));
  return { total: totalResult.count, open: openResult.count };
}

// ─── Approval Chains ─────────────────────────────────────────────────────────
export async function createApprovalChain(data: InsertApprovalChain) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(approvalChains).values(data).returning({ id: approvalChains.id });
  return result[0].id;
}

export async function getApprovalChains() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(approvalChains).orderBy(desc(approvalChains.createdAt));
}

export async function getDefaultApprovalChain() {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(approvalChains).where(eq(approvalChains.isDefault, true)).limit(1);
  return result[0];
}

export async function updateApprovalChain(id: number, data: Partial<InsertApprovalChain>) {
  const db = await getDb();
  if (!db) return;
  await db.update(approvalChains).set(data).where(eq(approvalChains.id, id));
}

// ─── Approval Steps ──────────────────────────────────────────────────────────
export async function createApprovalStep(data: InsertApprovalStep) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(approvalSteps).values(data).returning({ id: approvalSteps.id });
  return result[0].id;
}

export async function getApprovalStepsForAd(adSubmissionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(approvalSteps).where(eq(approvalSteps.adSubmissionId, adSubmissionId)).orderBy(approvalSteps.stepNumber);
}

export async function updateApprovalStep(id: number, data: Partial<InsertApprovalStep>) {
  const db = await getDb();
  if (!db) return;
  await db.update(approvalSteps).set(data).where(eq(approvalSteps.id, id));
}

// ─── Notifications ───────────────────────────────────────────────────────────
export async function createNotification(data: InsertNotification) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(notifications).values(data).returning({ id: notifications.id });
  return result[0].id;
}

export async function getNotificationsForUser(userId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
}

export async function markNotificationRead(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(notifications).set({ isRead: true }).where(eq(notifications.id, id));
}

export async function markAllNotificationsRead(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(notifications).set({ isRead: true }).where(
    and(eq(notifications.userId, userId), eq(notifications.isRead, false))
  );
}

export async function getUnreadNotificationCount(userId: number) {
  const db = await getDb();
  if (!db) return 0;
  const [result] = await db.select({ count: count() }).from(notifications).where(
    and(eq(notifications.userId, userId), eq(notifications.isRead, false))
  );
  return result.count;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────
export async function createAuditEntry(data: InsertAuditLogEntry) {
  const db = await getDb();
  if (!db) return;
  await db.insert(auditLog).values(data);
}

export async function getAuditLog(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
}

// ─── Category Blocks ─────────────────────────────────────────────────────────
export async function createCategoryBlock(data: InsertCategoryBlock) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(categoryBlocks).values(data).returning({ id: categoryBlocks.id });
  return result[0].id;
}

export async function getCategoryBlocks() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(categoryBlocks).orderBy(desc(categoryBlocks.createdAt));
}

export async function deleteCategoryBlock(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(categoryBlocks).where(eq(categoryBlocks.id, id));
}

// ─── Integrations ────────────────────────────────────────────────────────────
export async function createIntegration(data: InsertIntegration) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(integrations).values(data).returning({ id: integrations.id });
  return result[0].id;
}

export async function getIntegrations() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(integrations).orderBy(desc(integrations.createdAt));
}

export async function updateIntegration(id: number, data: Partial<InsertIntegration>) {
  const db = await getDb();
  if (!db) return;
  await db.update(integrations).set(data).where(eq(integrations.id, id));
}

export async function deleteIntegration(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(integrations).where(eq(integrations.id, id));
}

// ─── Dashboard Analytics ─────────────────────────────────────────────────────
export async function getDashboardStats() {
  const db = await getDb();
  if (!db) return { totalAds: 0, pendingReview: 0, approved: 0, rejected: 0, violations: 0, avgAiScore: 0 };

  const [totalAds] = await db.select({ count: count() }).from(adSubmissions);
  const [pendingReview] = await db.select({ count: count() }).from(adSubmissions).where(
    inArray(adSubmissions.status, ["submitted", "ai_screening", "in_review", "escalated"])
  );
  const [approved] = await db.select({ count: count() }).from(adSubmissions).where(eq(adSubmissions.status, "approved"));
  const [rejected] = await db.select({ count: count() }).from(adSubmissions).where(eq(adSubmissions.status, "rejected"));
  const [violations] = await db.select({ count: count() }).from(policyViolations).where(eq(policyViolations.status, "open"));
  const [avgScore] = await db.select({ avg: sql<number>`COALESCE(AVG(${adSubmissions.aiScore}), 0)` }).from(adSubmissions);

  return {
    totalAds: totalAds.count,
    pendingReview: pendingReview.count,
    approved: approved.count,
    rejected: rejected.count,
    violations: violations.count,
    avgAiScore: Math.round(avgScore.avg || 0),
  };
}

export async function getRecentActivity(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
}

// ─── Frame Analyses ─────────────────────────────────────────────────────────
export async function createFrameAnalysis(data: InsertFrameAnalysis) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(frameAnalyses).values(data).returning({ id: frameAnalyses.id });
  return result[0].id;
}

export async function getFrameAnalysisForAd(adSubmissionId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(frameAnalyses)
    .where(eq(frameAnalyses.adSubmissionId, adSubmissionId))
    .orderBy(desc(frameAnalyses.createdAt))
    .limit(1);
  return result[0];
}

export async function getFrameAnalysesForAd(adSubmissionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(frameAnalyses)
    .where(eq(frameAnalyses.adSubmissionId, adSubmissionId))
    .orderBy(desc(frameAnalyses.createdAt));
}

export async function updateFrameAnalysis(id: number, data: Partial<InsertFrameAnalysis>) {
  const db = await getDb();
  if (!db) return;
  await db.update(frameAnalyses).set(data).where(eq(frameAnalyses.id, id));
}
