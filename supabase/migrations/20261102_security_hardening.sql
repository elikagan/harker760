-- Apply in two steps (see PR). Step 1 is safe any time; step 2 only after the
-- new worker (with SUPABASE_SERVICE_KEY) and the new site are live.

-- ── Step 1: gift certificate columns (website gift purchases need these) ──
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS is_gift_certificate boolean NOT NULL DEFAULT false;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS purchaser_name text;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS recipient_name text;
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS purchaser_email text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS item_id text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS discount_code text;

-- ── Step 2: public (anon) key may only record page views and email sign-ups ──
DROP POLICY IF EXISTS "Allow anon insert" ON sales;
DROP POLICY IF EXISTS "Allow anon select" ON sales;
DROP POLICY IF EXISTS "Allow anon delete" ON sales;
DROP POLICY IF EXISTS "Allow anon update" ON sales;
DROP POLICY IF EXISTS anon_read_discounts ON discount_codes;
-- events: anon_insert_events stays. emails: anon_insert_emails stays.
