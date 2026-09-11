ALTER TABLE "loyalty_ledger" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN "remaining_value_cents" integer;
