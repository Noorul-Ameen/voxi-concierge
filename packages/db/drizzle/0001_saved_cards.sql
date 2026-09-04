ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "saved_cards" jsonb DEFAULT '[]'::jsonb;
