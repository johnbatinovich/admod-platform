import {
  serial,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
  json,
  bigint,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:           serial("id").primaryKey(),
  openId:       varchar("openId", { length: 64 }).notNull().unique(),
  name:         text("name"),
  email:        varchar("email", { length: 320 }),
  loginMethod:  varchar("loginMethod", { length: 64 }),
  role:         varchar("role", { length: 32 }).default("user").notNull(),
  platformRole: varchar("platformRole", { length: 32 }).default("viewer").notNull(),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
  updatedAt:    timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Advertisers ──────────────────────────────────────────────────────────────

export const advertisers = pgTable("advertisers", {
  id:                 serial("id").primaryKey(),
  name:               varchar("name", { length: 255 }).notNull(),
  contactEmail:       varchar("contactEmail", { length: 320 }),
  contactPhone:       varchar("contactPhone", { length: 64 }),
  industry:           varchar("industry", { length: 128 }),
  website:            varchar("website", { length: 512 }),
  verificationStatus: varchar("verificationStatus", { length: 32 }).default("pending").notNull(),
  riskScore:          integer("riskScore").default(0),
  notes:              text("notes"),
  createdBy:          integer("createdBy"),
  createdAt:          timestamp("createdAt").defaultNow().notNull(),
  updatedAt:          timestamp("updatedAt").defaultNow().notNull(),
});
export type Advertiser = typeof advertisers.$inferSelect;
export type InsertAdvertiser = typeof advertisers.$inferInsert;

// ─── Ad Submissions ───────────────────────────────────────────────────────────

export const adSubmissions = pgTable("ad_submissions", {
  id:                  serial("id").primaryKey(),
  title:               varchar("title", { length: 512 }).notNull(),
  description:         text("description"),
  advertiserId:        integer("advertiserId").references(() => advertisers.id, { onDelete: "set null" }),
  format:              varchar("format", { length: 32 }).notNull(),
  sourceType:          varchar("sourceType", { length: 32 }).default("upload").notNull(),
  sourceUrl:           varchar("sourceUrl", { length: 2048 }),
  fileUrl:             varchar("fileUrl", { length: 1024 }),
  fileKey:             varchar("fileKey", { length: 512 }),
  fileName:            varchar("fileName", { length: 512 }),
  fileMimeType:        varchar("fileMimeType", { length: 128 }),
  fileSizeBytes:       bigint("fileSizeBytes", { mode: "number" }),
  videoProvider:       varchar("videoProvider", { length: 32 }),
  videoId:             varchar("videoId", { length: 64 }),
  embedUrl:            varchar("embedUrl", { length: 1024 }),
  thumbnailUrl:        varchar("thumbnailUrl", { length: 1024 }),
  videoDuration:       varchar("videoDuration", { length: 32 }),
  videoAuthor:         varchar("videoAuthor", { length: 255 }),
  metadata:            json("metadata"),
  targetAudience:      varchar("targetAudience", { length: 512 }),
  targetPlatforms:     json("targetPlatforms"),
  scheduledStart:      timestamp("scheduledStart"),
  scheduledEnd:        timestamp("scheduledEnd"),
  status:              varchar("status", { length: 32 }).default("draft").notNull(),
  priority:            varchar("priority", { length: 16 }).default("normal").notNull(),
  aiScore:             integer("aiScore"),
  aiAnalysis:          json("aiAnalysis"),
  brandSafetyScore:    integer("brandSafetyScore"),
  assignedTo:          integer("assignedTo").references(() => users.id, { onDelete: "set null" }),
  currentApprovalStep: integer("currentApprovalStep").default(0),
  submittedBy:         integer("submittedBy").references(() => users.id, { onDelete: "set null" }),
  submittedAt:         timestamp("submittedAt"),
  createdAt:           timestamp("createdAt").defaultNow().notNull(),
  updatedAt:           timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_ad_submissions_status").on(table.status),
  index("idx_ad_submissions_advertiser_id").on(table.advertiserId),
  index("idx_ad_submissions_submitted_by").on(table.submittedBy),
]);
export type AdSubmission = typeof adSubmissions.$inferSelect;
export type InsertAdSubmission = typeof adSubmissions.$inferInsert;

// ─── Reviews ──────────────────────────────────────────────────────────────────

export const reviews = pgTable("reviews", {
  id:                 serial("id").primaryKey(),
  // reviewerId is nullable so the FK can use SET NULL when a user is deleted
  adSubmissionId:     integer("adSubmissionId").notNull().references(() => adSubmissions.id, { onDelete: "cascade" }),
  reviewerId:         integer("reviewerId").references(() => users.id, { onDelete: "set null" }),
  decision:           varchar("decision", { length: 32 }).notNull(),
  comments:           text("comments"),
  annotations:        json("annotations"),
  violationsFound:    json("violationsFound"),
  approvalStep:       integer("approvalStep").default(0),
  reviewStartedAt:    timestamp("reviewStartedAt"),
  reviewCompletedAt:  timestamp("reviewCompletedAt"),
  createdAt:          timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_reviews_ad_submission_id").on(table.adSubmissionId),
  index("idx_reviews_reviewer_id").on(table.reviewerId),
]);
export type Review = typeof reviews.$inferSelect;
export type InsertReview = typeof reviews.$inferInsert;

// ─── Policies ─────────────────────────────────────────────────────────────────

export const policies = pgTable("policies", {
  id:                 serial("id").primaryKey(),
  name:               varchar("name", { length: 255 }).notNull(),
  description:        text("description"),
  category:           varchar("category", { length: 64 }).notNull(),
  complianceFramework: varchar("complianceFramework", { length: 64 }),
  rules:              json("rules"),
  severity:           varchar("severity", { length: 16 }).default("warning").notNull(),
  isActive:           boolean("isActive").default(true).notNull(),
  isTemplate:         boolean("isTemplate").default(false).notNull(),
  version:            integer("version").default(1).notNull(),
  createdBy:          integer("createdBy"),
  createdAt:          timestamp("createdAt").defaultNow().notNull(),
  updatedAt:          timestamp("updatedAt").defaultNow().notNull(),
});
export type Policy = typeof policies.$inferSelect;
export type InsertPolicy = typeof policies.$inferInsert;

// ─── Policy Violations ────────────────────────────────────────────────────────

export const policyViolations = pgTable("policy_violations", {
  id:             serial("id").primaryKey(),
  adSubmissionId: integer("adSubmissionId").notNull().references(() => adSubmissions.id, { onDelete: "cascade" }),
  // policyId is nullable so the FK can use SET NULL when a policy is deleted
  policyId:       integer("policyId").references(() => policies.id, { onDelete: "set null" }),
  severity:       varchar("severity", { length: 16 }).notNull(),
  description:    text("description"),
  detectedBy:     varchar("detectedBy", { length: 16 }).notNull(),
  status:         varchar("status", { length: 16 }).default("open").notNull(),
  resolvedBy:     integer("resolvedBy").references(() => users.id, { onDelete: "set null" }),
  resolvedAt:     timestamp("resolvedAt"),
  createdAt:      timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_policy_violations_ad_submission_id").on(table.adSubmissionId),
  index("idx_policy_violations_status").on(table.status),
]);
export type PolicyViolation = typeof policyViolations.$inferSelect;
export type InsertPolicyViolation = typeof policyViolations.$inferInsert;

// ─── Approval Chains ──────────────────────────────────────────────────────────

export const approvalChains = pgTable("approval_chains", {
  id:          serial("id").primaryKey(),
  name:        varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  steps:       json("steps"),
  isDefault:   boolean("isDefault").default(false).notNull(),
  isActive:    boolean("isActive").default(true).notNull(),
  createdBy:   integer("createdBy"),
  createdAt:   timestamp("createdAt").defaultNow().notNull(),
  updatedAt:   timestamp("updatedAt").defaultNow().notNull(),
});
export type ApprovalChain = typeof approvalChains.$inferSelect;
export type InsertApprovalChain = typeof approvalChains.$inferInsert;

// ─── Approval Steps ───────────────────────────────────────────────────────────

export const approvalSteps = pgTable("approval_steps", {
  id:               serial("id").primaryKey(),
  adSubmissionId:   integer("adSubmissionId").notNull().references(() => adSubmissions.id, { onDelete: "cascade" }),
  approvalChainId:  integer("approvalChainId").notNull().references(() => approvalChains.id, { onDelete: "cascade" }),
  stepNumber:       integer("stepNumber").notNull(),
  stepName:         varchar("stepName", { length: 255 }),
  requiredRole:     varchar("requiredRole", { length: 32 }).notNull(),
  status:           varchar("status", { length: 16 }).default("pending").notNull(),
  decidedBy:        integer("decidedBy").references(() => users.id, { onDelete: "set null" }),
  decidedAt:        timestamp("decidedAt"),
  comments:         text("comments"),
  createdAt:        timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_approval_steps_ad_submission_id").on(table.adSubmissionId),
  index("idx_approval_steps_status").on(table.status),
]);
export type ApprovalStep = typeof approvalSteps.$inferSelect;
export type InsertApprovalStep = typeof approvalSteps.$inferInsert;

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable("notifications", {
  id:           serial("id").primaryKey(),
  userId:       integer("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  type:         varchar("type", { length: 64 }).notNull(),
  title:        varchar("title", { length: 512 }).notNull(),
  message:      text("message"),
  relatedAdId:  integer("relatedAdId").references(() => adSubmissions.id, { onDelete: "set null" }),
  isRead:       boolean("isRead").default(false).notNull(),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_notifications_user_id_is_read").on(table.userId, table.isRead),
]);
export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;

// ─── Audit Log ────────────────────────────────────────────────────────────────

export const auditLog = pgTable("audit_log", {
  id:         serial("id").primaryKey(),
  userId:     integer("userId").references(() => users.id, { onDelete: "set null" }),
  action:     varchar("action", { length: 128 }).notNull(),
  entityType: varchar("entityType", { length: 64 }).notNull(),
  entityId:   integer("entityId"),
  details:    json("details"),
  ipAddress:  varchar("ipAddress", { length: 64 }),
  createdAt:  timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_audit_log_entity").on(table.entityType, table.entityId),
  index("idx_audit_log_user_id").on(table.userId),
]);
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type InsertAuditLogEntry = typeof auditLog.$inferInsert;

// ─── Category Blocks ──────────────────────────────────────────────────────────

export const categoryBlocks = pgTable("category_blocks", {
  id:           serial("id").primaryKey(),
  advertiserId: integer("advertiserId").references(() => advertisers.id, { onDelete: "set null" }),
  category:     varchar("category", { length: 128 }).notNull(),
  reason:       text("reason"),
  isGlobal:     boolean("isGlobal").default(false).notNull(),
  createdBy:    integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
});
export type CategoryBlock = typeof categoryBlocks.$inferSelect;
export type InsertCategoryBlock = typeof categoryBlocks.$inferInsert;

// ─── Frame Analyses ───────────────────────────────────────────────────────────

export const frameAnalyses = pgTable("frame_analyses", {
  id:                      serial("id").primaryKey(),
  adSubmissionId:          integer("adSubmissionId").notNull().references(() => adSubmissions.id, { onDelete: "cascade" }),
  totalFramesAnalyzed:     integer("totalFramesAnalyzed").default(0).notNull(),
  analysisIntervalSeconds: integer("analysisIntervalSeconds").default(10).notNull(),
  overallVideoScore:       integer("overallVideoScore"),
  flaggedFrameCount:       integer("flaggedFrameCount").default(0).notNull(),
  frames:                  json("frames"),
  summary:                 text("summary"),
  worstTimestamp:          varchar("worstTimestamp", { length: 32 }),
  worstIssue:              text("worstIssue"),
  status:                  varchar("status", { length: 16 }).default("pending").notNull(),
  triggeredBy:             integer("triggeredBy").references(() => users.id, { onDelete: "set null" }),
  startedAt:               timestamp("startedAt"),
  completedAt:             timestamp("completedAt"),
  createdAt:               timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_frame_analyses_ad_submission_id").on(table.adSubmissionId),
]);
export type FrameAnalysis = typeof frameAnalyses.$inferSelect;
export type InsertFrameAnalysis = typeof frameAnalyses.$inferInsert;

// ─── Integrations ─────────────────────────────────────────────────────────────

export const integrations = pgTable("integrations", {
  id:          serial("id").primaryKey(),
  name:        varchar("name", { length: 255 }).notNull(),
  type:        varchar("type", { length: 32 }).notNull(),
  config:      json("config"),
  isActive:    boolean("isActive").default(true).notNull(),
  lastSyncAt:  timestamp("lastSyncAt"),
  createdBy:   integer("createdBy"),
  createdAt:   timestamp("createdAt").defaultNow().notNull(),
  updatedAt:   timestamp("updatedAt").defaultNow().notNull(),
});
export type Integration = typeof integrations.$inferSelect;
export type InsertIntegration = typeof integrations.$inferInsert;
