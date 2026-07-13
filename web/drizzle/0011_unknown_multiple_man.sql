CREATE TABLE "acp_frame" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"direction" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "acp_frame_job_dir_idx" ON "acp_frame" USING btree ("job_name","direction");