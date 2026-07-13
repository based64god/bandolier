CREATE TABLE "pending_agent_run" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"requested_by_login" text NOT NULL,
	"approval_comment_id" text,
	"payload" text NOT NULL,
	"resolved_at" timestamp,
	"resolution" text,
	"resolved_by_login" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pending_agent_run_repo_issue_idx" ON "pending_agent_run" USING btree ("repo_full_name","issue_number");--> statement-breakpoint
CREATE INDEX "pending_agent_run_comment_idx" ON "pending_agent_run" USING btree ("approval_comment_id");