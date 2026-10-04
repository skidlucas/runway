CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL,
	`locked_until` integer NOT NULL
);
--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'loginGuard';
