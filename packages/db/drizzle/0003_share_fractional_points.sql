ALTER TABLE "loyalty_accounts" ALTER COLUMN "share_points_balance" TYPE numeric(16,1) USING "share_points_balance"::numeric(16,1);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ALTER COLUMN "delta" TYPE numeric(16,1) USING "delta"::numeric(16,1);
