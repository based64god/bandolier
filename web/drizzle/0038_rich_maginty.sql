CREATE TABLE "credential_usage" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"last_used_at" timestamp NOT NULL,
	CONSTRAINT "credential_usage_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "credential_usage" ADD CONSTRAINT "credential_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;