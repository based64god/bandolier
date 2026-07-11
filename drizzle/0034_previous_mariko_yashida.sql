CREATE TABLE "repo_custom_provider_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"provider" text NOT NULL,
	"api_key" text,
	"api_base" text,
	"extra_env" text,
	"models" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "repo_custom_provider_credentials_repo_full_name_provider_unique" UNIQUE("repo_full_name","provider")
);
