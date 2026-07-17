ALTER TABLE "repo_webhook_config" ADD COLUMN "review_pull_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "reviewed_pr_url" text;