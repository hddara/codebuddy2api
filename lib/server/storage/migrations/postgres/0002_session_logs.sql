CREATE TABLE "codebuddy2api"."sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"title" text,
	"source_route" text NOT NULL,
	"access_key_id" text,
	"credential_filename" text,
	"model" text,
	"external_ref" text,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"encryption_mode" text
);
--> statement-breakpoint
CREATE TABLE "codebuddy2api"."session_turns" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"role" text NOT NULL,
	"content_text" text,
	"content_raw" text,
	"tool_calls" text,
	"reasoning" text,
	"context_json" text,
	"usage_json" text,
	"model" text,
	"route" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"encryption_mode" text
);
--> statement-breakpoint
CREATE INDEX "sessions_updated_at_idx" ON "codebuddy2api"."sessions" USING btree ("updated_at","session_id");--> statement-breakpoint
CREATE INDEX "sessions_access_key_updated_idx" ON "codebuddy2api"."sessions" USING btree ("access_key_id","updated_at","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_session_idx" ON "codebuddy2api"."session_turns" USING btree ("session_id","turn_index");
