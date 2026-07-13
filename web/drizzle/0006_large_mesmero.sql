CREATE TABLE "github_installation" (
	"repo_full_name" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
