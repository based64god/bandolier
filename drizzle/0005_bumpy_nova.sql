CREATE TABLE "user_gemini_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "gemini_api_key" text;--> statement-breakpoint
ALTER TABLE "user_gemini_credentials" ADD CONSTRAINT "user_gemini_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;