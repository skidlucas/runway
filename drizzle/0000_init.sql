CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'checking' NOT NULL,
	`off_budget` integer DEFAULT false NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`in_forecast` integer DEFAULT true NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`last_reconciled_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`source` text NOT NULL,
	`unit_price` real,
	`automatic` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_valuations_asset_date_idx` ON `asset_valuations` (`asset_id`,`date`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_liability` integer DEFAULT false NOT NULL,
	`subtitle` text,
	`purchase_amount` integer,
	`purchase_date` text,
	`declared_amount` integer,
	`declared_date` text,
	`retained` text DEFAULT 'estimated' NOT NULL,
	`source` text NOT NULL,
	`notes` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_months` (
	`month` text PRIMARY KEY NOT NULL,
	`buffered` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`month` text NOT NULL,
	`category_id` text NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`carryover` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`month`, `category_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `categories_group_idx` ON `categories` (`group_id`);--> statement-breakpoint
CREATE TABLE `category_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transfer_account_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payees_name_idx` ON `payees` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `payees_transfer_idx` ON `payees` (`transfer_account_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`conditions_op` text DEFAULT 'and' NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`payee_id` text,
	`account_id` text NOT NULL,
	`category_id` text,
	`amount` integer NOT NULL,
	`recurrence` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`next_date` text NOT NULL,
	`auto_post` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedules_next_idx` ON `schedules` (`next_date`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`payee_id` text,
	`category_id` text,
	`notes` text,
	`cleared` integer DEFAULT false NOT NULL,
	`reconciled` integer DEFAULT false NOT NULL,
	`transfer_id` text,
	`is_parent` integer DEFAULT false NOT NULL,
	`parent_id` text,
	`imported_id` text,
	`imported_payee` text,
	`schedule_id` text,
	`starting_balance` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tx_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `tx_date_category_idx` ON `transactions` (`date`,`category_id`);--> statement-breakpoint
CREATE INDEX `tx_payee_idx` ON `transactions` (`payee_id`);--> statement-breakpoint
CREATE INDEX `tx_parent_idx` ON `transactions` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tx_imported_idx` ON `transactions` (`imported_id`);