ALTER TABLE "repo_webhook_config" ADD COLUMN "kubeconfig" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "anthropic_api_key" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "aws_access_key_id" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "aws_secret_access_key" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "aws_session_token" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "aws_region" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "prefer_repo_credentials" boolean DEFAULT false NOT NULL;