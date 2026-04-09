ALTER TABLE "advertisers" ADD COLUMN "normalized_name" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_advertisers_normalized_name" ON "advertisers" USING btree ("normalized_name");