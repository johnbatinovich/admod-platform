CREATE TABLE "ad_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"advertiserId" integer,
	"format" varchar(32) NOT NULL,
	"sourceType" varchar(32) DEFAULT 'upload' NOT NULL,
	"sourceUrl" varchar(2048),
	"fileUrl" varchar(1024),
	"fileKey" varchar(512),
	"fileName" varchar(512),
	"fileMimeType" varchar(128),
	"fileSizeBytes" bigint,
	"videoProvider" varchar(32),
	"videoId" varchar(64),
	"embedUrl" varchar(1024),
	"thumbnailUrl" varchar(1024),
	"videoDuration" varchar(32),
	"videoAuthor" varchar(255),
	"metadata" json,
	"targetAudience" varchar(512),
	"targetPlatforms" json,
	"scheduledStart" timestamp,
	"scheduledEnd" timestamp,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"priority" varchar(16) DEFAULT 'normal' NOT NULL,
	"aiScore" integer,
	"aiAnalysis" json,
	"brandSafetyScore" integer,
	"assignedTo" integer,
	"currentApprovalStep" integer DEFAULT 0,
	"submittedBy" integer,
	"submittedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advertisers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contactEmail" varchar(320),
	"contactPhone" varchar(64),
	"industry" varchar(128),
	"website" varchar(512),
	"verificationStatus" varchar(32) DEFAULT 'pending' NOT NULL,
	"riskScore" integer DEFAULT 0,
	"notes" text,
	"createdBy" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_chains" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"steps" json,
	"isDefault" boolean DEFAULT false NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdBy" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"adSubmissionId" integer NOT NULL,
	"approvalChainId" integer NOT NULL,
	"stepNumber" integer NOT NULL,
	"stepName" varchar(255),
	"requiredRole" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decidedBy" integer,
	"decidedAt" timestamp,
	"comments" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer,
	"action" varchar(128) NOT NULL,
	"entityType" varchar(64) NOT NULL,
	"entityId" integer,
	"details" json,
	"ipAddress" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"advertiserId" integer,
	"category" varchar(128) NOT NULL,
	"reason" text,
	"isGlobal" boolean DEFAULT false NOT NULL,
	"createdBy" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frame_analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"adSubmissionId" integer NOT NULL,
	"totalFramesAnalyzed" integer DEFAULT 0 NOT NULL,
	"analysisIntervalSeconds" integer DEFAULT 10 NOT NULL,
	"overallVideoScore" integer,
	"flaggedFrameCount" integer DEFAULT 0 NOT NULL,
	"frames" json,
	"summary" text,
	"worstTimestamp" varchar(32),
	"worstIssue" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"triggeredBy" integer,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(32) NOT NULL,
	"config" json,
	"isActive" boolean DEFAULT true NOT NULL,
	"lastSyncAt" timestamp,
	"createdBy" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"type" varchar(64) NOT NULL,
	"title" varchar(512) NOT NULL,
	"message" text,
	"relatedAdId" integer,
	"isRead" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(64) NOT NULL,
	"complianceFramework" varchar(64),
	"rules" json,
	"severity" varchar(16) DEFAULT 'warning' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"isTemplate" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"createdBy" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_violations" (
	"id" serial PRIMARY KEY NOT NULL,
	"adSubmissionId" integer NOT NULL,
	"policyId" integer NOT NULL,
	"severity" varchar(16) NOT NULL,
	"description" text,
	"detectedBy" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"resolvedBy" integer,
	"resolvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"adSubmissionId" integer NOT NULL,
	"reviewerId" integer NOT NULL,
	"decision" varchar(32) NOT NULL,
	"comments" text,
	"annotations" json,
	"violationsFound" json,
	"approvalStep" integer DEFAULT 0,
	"reviewStartedAt" timestamp,
	"reviewCompletedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" varchar(32) DEFAULT 'user' NOT NULL,
	"platformRole" varchar(32) DEFAULT 'viewer' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
