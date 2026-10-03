DROP INDEX `tx_account_date_idx`;--> statement-breakpoint
DROP INDEX `tx_parent_idx`;--> statement-breakpoint
CREATE INDEX `tx_account_order_idx` ON `transactions` (`account_id`,`date`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tx_order_idx` ON `transactions` (`date`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tx_transfer_idx` ON `transactions` (`transfer_id`) WHERE transfer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tx_schedule_idx` ON `transactions` (`schedule_id`) WHERE schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tx_parent_idx` ON `transactions` (`parent_id`) WHERE parent_id IS NOT NULL;