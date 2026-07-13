ALTER TABLE "repo_webhook_config" ADD COLUMN "artifacts_s3_bucket" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "artifacts_s3_region" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "artifacts_s3_endpoint" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "artifacts_access_key_id" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "artifacts_secret_access_key" text;