-- Sales table: records every completed payment from Square
CREATE TABLE IF NOT EXISTS sales (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL DEFAULT 'item',  -- 'item' or 'gift_certificate'
  amount numeric NOT NULL,            -- dollar amount
  customer_email text,
  customer_name text,
  item_id text,                       -- inventory item ID (for items) or gift code (for gift certs)
  item_title text,
  gift_code text,                     -- GIFT-XXXX-XXXX if gift cert
  discount_code text,                 -- discount code used, if any
  discount_amount numeric,            -- discount dollar amount
  square_payment_id text,             -- Square payment ID for dedup
  note text,                          -- raw Square payment note
  created_at timestamptz DEFAULT now()
);

-- Index for querying sales by date
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at DESC);

-- Index for dedup on Square payment ID
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_square_payment_id ON sales(square_payment_id);

-- Enable RLS
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;

-- Allow anon to insert (from worker webhook)
CREATE POLICY "Allow anon insert" ON sales FOR INSERT TO anon WITH CHECK (true);

-- Allow anon to select (for admin panel)
CREATE POLICY "Allow anon select" ON sales FOR SELECT TO anon USING (true);
