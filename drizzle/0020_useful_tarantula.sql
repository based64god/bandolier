CREATE TABLE "user_compute" (
	"user_id" text PRIMARY KEY NOT NULL,
	"cpu" text,
	"memory" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "compute_cpu" text;--> statement-breakpoint
ALTER TABLE "repo_webhook_config" ADD COLUMN "compute_memory" text;--> statement-breakpoint
ALTER TABLE "user_compute" ADD CONSTRAINT "user_compute_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;