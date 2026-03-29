ALTER TABLE "policy_violations" ALTER COLUMN "policyId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "reviewerId" DROP NOT NULL;--> statement-breakpoint
UPDATE "policy_violations" SET "policyId" = NULL WHERE "policyId" = 0;--> statement-breakpoint
ALTER TABLE "ad_submissions" ADD CONSTRAINT "ad_submissions_advertiserId_advertisers_id_fk" FOREIGN KEY ("advertiserId") REFERENCES "public"."advertisers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_submissions" ADD CONSTRAINT "ad_submissions_assignedTo_users_id_fk" FOREIGN KEY ("assignedTo") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_submissions" ADD CONSTRAINT "ad_submissions_submittedBy_users_id_fk" FOREIGN KEY ("submittedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_adSubmissionId_ad_submissions_id_fk" FOREIGN KEY ("adSubmissionId") REFERENCES "public"."ad_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approvalChainId_approval_chains_id_fk" FOREIGN KEY ("approvalChainId") REFERENCES "public"."approval_chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decidedBy_users_id_fk" FOREIGN KEY ("decidedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_blocks" ADD CONSTRAINT "category_blocks_advertiserId_advertisers_id_fk" FOREIGN KEY ("advertiserId") REFERENCES "public"."advertisers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_blocks" ADD CONSTRAINT "category_blocks_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_analyses" ADD CONSTRAINT "frame_analyses_adSubmissionId_ad_submissions_id_fk" FOREIGN KEY ("adSubmissionId") REFERENCES "public"."ad_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_analyses" ADD CONSTRAINT "frame_analyses_triggeredBy_users_id_fk" FOREIGN KEY ("triggeredBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_relatedAdId_ad_submissions_id_fk" FOREIGN KEY ("relatedAdId") REFERENCES "public"."ad_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_adSubmissionId_ad_submissions_id_fk" FOREIGN KEY ("adSubmissionId") REFERENCES "public"."ad_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_policyId_policies_id_fk" FOREIGN KEY ("policyId") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_resolvedBy_users_id_fk" FOREIGN KEY ("resolvedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_adSubmissionId_ad_submissions_id_fk" FOREIGN KEY ("adSubmissionId") REFERENCES "public"."ad_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewerId_users_id_fk" FOREIGN KEY ("reviewerId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ad_submissions_status" ON "ad_submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ad_submissions_advertiser_id" ON "ad_submissions" USING btree ("advertiserId");--> statement-breakpoint
CREATE INDEX "idx_ad_submissions_submitted_by" ON "ad_submissions" USING btree ("submittedBy");--> statement-breakpoint
CREATE INDEX "idx_approval_steps_ad_submission_id" ON "approval_steps" USING btree ("adSubmissionId");--> statement-breakpoint
CREATE INDEX "idx_approval_steps_status" ON "approval_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entity" ON "audit_log" USING btree ("entityType","entityId");--> statement-breakpoint
CREATE INDEX "idx_audit_log_user_id" ON "audit_log" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_frame_analyses_ad_submission_id" ON "frame_analyses" USING btree ("adSubmissionId");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_id_is_read" ON "notifications" USING btree ("userId","isRead");--> statement-breakpoint
CREATE INDEX "idx_policy_violations_ad_submission_id" ON "policy_violations" USING btree ("adSubmissionId");--> statement-breakpoint
CREATE INDEX "idx_policy_violations_status" ON "policy_violations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_reviews_ad_submission_id" ON "reviews" USING btree ("adSubmissionId");--> statement-breakpoint
CREATE INDEX "idx_reviews_reviewer_id" ON "reviews" USING btree ("reviewerId");