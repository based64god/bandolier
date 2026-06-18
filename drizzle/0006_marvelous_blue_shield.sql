CREATE TABLE "session_thread" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"session_id" text NOT NULL,
	"pvc_name" text,
	"namespace" text,
	"access_mode" text,
	"latest_job_name" text,
	"claude_cli_version" text,
	"last_used_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "session_thread_repo_idx" ON "session_thread" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "task_run_thread_idx" ON "task_run" USING btree ("thread_id");