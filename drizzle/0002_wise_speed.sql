CREATE TABLE "user_openai_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_openai_credentials" ADD CONSTRAINT "user_openai_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;