ALTER TABLE `usage_events` ADD `conversation_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `prompt_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `completion_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_events_conversation_occurred_at_idx` ON `usage_events` (`conversation_id`,`occurred_at`);
