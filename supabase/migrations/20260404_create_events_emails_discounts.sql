-- Events table for analytics
CREATE TABLE IF NOT EXISTS events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  event text NOT NULL,
  item_id text,
  session_id text,
  referrer text,
  utm_source text,
  ua_mobile boolean,
  path text,
  duration integer
);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_insert_events ON events FOR INSERT TO anon WITH CHECK (true);

-- Emails table for email collection
CREATE TABLE IF NOT EXISTS emails (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  email text NOT NULL,
  source text
);
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_insert_emails ON emails FOR INSERT TO anon WITH CHECK (true);

-- Discount codes table
CREATE TABLE IF NOT EXISTS discount_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  code text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'percent',
  value numeric NOT NULL DEFAULT 10,
  is_active boolean DEFAULT true,
  max_uses integer,
  used_count integer DEFAULT 0
);
ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_discounts ON discount_codes FOR SELECT TO anon USING (is_active = true);

-- Seed welcome discount
INSERT INTO discount_codes (code, type, value, is_active) VALUES ('WELCOME10', 'percent', 10, true) ON CONFLICT DO NOTHING;
