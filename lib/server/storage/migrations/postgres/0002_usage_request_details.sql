ALTER TABLE "codebuddy2api"."usage_events" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "codebuddy2api"."usage_events" ADD COLUMN "prompt_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "codebuddy2api"."usage_events" ADD COLUMN "completion_chars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_events_conversation_occurred_at_idx" ON "codebuddy2api"."usage_events" USING btree ("conversation_id","occurred_at");
