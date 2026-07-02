ALTER TABLE "task_run" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "cache_read_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "cache_creation_input_tokens" integer;