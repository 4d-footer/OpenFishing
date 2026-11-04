CREATE TABLE `water_gauge` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`river` text,
	`state` text,
	`lat` real,
	`lng` real,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `water_gauge_user_site_idx` ON `water_gauge` (`user_id`,`site_id`);