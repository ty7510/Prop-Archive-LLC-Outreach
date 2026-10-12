CREATE TABLE "activity_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"event" text NOT NULL,
	"lead_id" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_send_at" text,
	"started_at" text NOT NULL,
	"ended_at" text,
	"run" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"kind" text NOT NULL,
	"detail" jsonb,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"merged" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"at" text NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"persona" text DEFAULT 'unknown' NOT NULL,
	"icp_score" integer DEFAULT 0 NOT NULL,
	"owner_kind" text DEFAULT 'unknown' NOT NULL,
	"full_name" text,
	"first_name" text,
	"last_name" text,
	"company" text,
	"email" text,
	"email_status" text DEFAULT 'unknown' NOT NULL,
	"phone" text,
	"phone_type" text DEFAULT 'unknown' NOT NULL,
	"linkedin_url" text,
	"instagram_url" text,
	"website" text,
	"mailing_street" text,
	"mailing_city" text,
	"mailing_state" text,
	"mailing_zip" text,
	"mailing_verified" boolean DEFAULT false NOT NULL,
	"property_count" integer DEFAULT 0 NOT NULL,
	"unit_count" integer DEFAULT 0 NOT NULL,
	"zips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '{"email":false,"mail":false,"linkedin":false,"instagram":false,"call":false}'::jsonb NOT NULL,
	"enrichment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"last_contacted_at" text,
	"last_replied_at" text,
	"next_action_at" text,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"enrollment_id" text,
	"step_id" text,
	"channel" text NOT NULL,
	"direction" text DEFAULT 'out' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject" text,
	"body" text DEFAULT '' NOT NULL,
	"to_address" text,
	"provider" text,
	"provider_message_id" text,
	"scheduled_at" text,
	"sent_at" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"classification" text,
	"raw" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"address" text,
	"zip" text,
	"category" text,
	"units" integer,
	"sale_date" text,
	"sale_price" integer,
	"market_value" integer,
	"opa_account" text,
	"license_num" text,
	"license_issue_date" text,
	"license_expiry" text,
	"source" text DEFAULT 'opa' NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"lead_id" text,
	"credits" integer DEFAULT 1 NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"channel" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"persona" text DEFAULT 'any' NOT NULL,
	"trigger" text DEFAULT 'any' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "suppression" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_step_id_sequence_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_at_idx" ON "activity_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_lead_sequence_uq" ON "enrollments" USING btree ("lead_id","sequence_id");--> statement-breakpoint
CREATE INDEX "enrollments_status_next_idx" ON "enrollments" USING btree ("status","next_send_at");--> statement-breakpoint
CREATE INDEX "events_lead_id_idx" ON "events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "events_kind_at_idx" ON "events" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_unsubscribe_token_uq" ON "leads" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_dedupe_key_uq" ON "leads" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_persona_idx" ON "leads" USING btree ("persona");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key_uq" ON "messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_lead_id_idx" ON "messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "messages_status_channel_idx" ON "messages" USING btree ("status","channel");--> statement-breakpoint
CREATE INDEX "messages_provider_message_id_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "properties_lead_id_idx" ON "properties" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "properties_opa_account_idx" ON "properties" USING btree ("opa_account");--> statement-breakpoint
CREATE INDEX "provider_usage_provider_at_idx" ON "provider_usage" USING btree ("provider","at");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_steps_seq_index_uq" ON "sequence_steps" USING btree ("sequence_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_kind_value_uq" ON "suppression" USING btree ("kind","value");