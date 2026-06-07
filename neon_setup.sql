-- ───────────────────────────────────────────────────────────────
-- Revyy — run once against your Neon database (or hit /api/init-db).
-- Profiles are keyed by the Clerk user id; clerk_user_id mirrors it.
-- ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  id                   TEXT PRIMARY KEY,            -- Clerk user id
  clerk_user_id        TEXT UNIQUE,                 -- mirrors id (explicit)
  email                TEXT UNIQUE,
  is_pro               BOOLEAN DEFAULT FALSE,
  stripe_customer_id   TEXT,
  subscription_id      TEXT,
  subscription_status  TEXT,
  subscription_plan    TEXT,                        -- 'monthly' | 'yearly'
  current_period_end   TIMESTAMP,                   -- next billing date
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMP DEFAULT NOW()
);

-- If the table predates clerk_user_id:
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE;
UPDATE profiles SET clerk_user_id = id WHERE clerk_user_id IS NULL;

CREATE INDEX IF NOT EXISTS profiles_clerk_idx       ON profiles (clerk_user_id);
CREATE INDEX IF NOT EXISTS profiles_email_idx       ON profiles (email);
CREATE INDEX IF NOT EXISTS profiles_stripe_cust_idx ON profiles (stripe_customer_id);
