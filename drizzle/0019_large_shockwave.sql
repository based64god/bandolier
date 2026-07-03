ALTER TABLE "user_anthropic_credentials" ALTER COLUMN "api_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_openai_credentials" ALTER COLUMN "api_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_anthropic_credentials" ADD COLUMN "oauth_token" text;--> statement-breakpoint
ALTER TABLE "user_openai_credentials" ADD COLUMN "codex_auth_json" text;