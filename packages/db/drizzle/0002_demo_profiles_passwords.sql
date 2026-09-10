ALTER TABLE "customers" ADD COLUMN "password_hash" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "demo_profile_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_history" ADD COLUMN "seat_preference" varchar(8);
--> statement-breakpoint
ALTER TABLE "purchase_history" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;
