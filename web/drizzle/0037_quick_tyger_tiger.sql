ALTER TABLE "repo_webhook_config" ADD COLUMN "review_model" text;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "review_as_user" boolean;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "posted_review_id" text;