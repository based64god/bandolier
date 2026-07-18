ALTER TABLE "credential_usage" ADD COLUMN "auth_kind" text DEFAULT 'api_key' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_usage" ADD COLUMN "window_started_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_usage" ADD COLUMN "window_runs" integer DEFAULT 0 NOT NULL;