DROP INDEX `tx_payee_idx`;--> statement-breakpoint
CREATE INDEX `tx_category_order_idx` ON `transactions` (`category_id`,`date`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tx_payee_date_idx` ON `transactions` (`payee_id`,`date`);