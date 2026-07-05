ALTER TABLE "repo_webhook_config" ADD COLUMN "resume_on_ci_failure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "ci_resume_sha" text;