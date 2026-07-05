CREATE TABLE "cluster_deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"cluster_name" text NOT NULL,
	"region" text NOT NULL,
	"node_size" text NOT NULL,
	"min_nodes" integer NOT NULL,
	"max_nodes" integer NOT NULL,
	"spaces_enabled" boolean NOT NULL,
	"cluster_id" text,
	"k8s_version" text,
	"bucket_name" text,
	"spaces_access_key_id" text,
	"spaces_secret_access_key" text,
	"do_token" text,
	"spaces_access_id" text,
	"spaces_secret_key" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_deployment" ADD CONSTRAINT "cluster_deployment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_deployment_user_id_idx" ON "cluster_deployment" USING btree ("user_id");