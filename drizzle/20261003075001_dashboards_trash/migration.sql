CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`widgets` text NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transaction_trash` (
	`undo_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`row` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transaction_trash_undo_idx` ON `transaction_trash` (`undo_id`);--> statement-breakpoint
CREATE INDEX `transaction_trash_deleted_idx` ON `transaction_trash` (`deleted_at`);--> statement-breakpoint
ALTER TABLE `asset_valuations` ADD `as_of` text;