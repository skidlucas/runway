CREATE TABLE `coin_prices` (
	`coin_id` text NOT NULL,
	`date` text NOT NULL,
	`price` real NOT NULL,
	CONSTRAINT `coin_prices_pk` PRIMARY KEY(`coin_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `coins` (
	`id` text PRIMARY KEY,
	`trend_date` text,
	`change_24h` real,
	`change_7d` real,
	`sparkline` text,
	`history_date` text
);
