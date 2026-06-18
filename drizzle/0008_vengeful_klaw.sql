CREATE TABLE "pending_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"issue_number" text NOT NULL,
	"issue_url" text NOT NULL,
	"issue_title" text NOT NULL,
	"issue_body" text,
	"issue_labels" text DEFAULT '[]' NOT NULL,
	"clone_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"requested_by_github_id" text NOT NULL,
	"requested_by_login" text NOT NULL,
	"comment_id" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pending_approval_repo_issue_idx" ON "pending_approval" USING btree ("repo_full_name","issue_number");