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
  -- Question-limit / monetization
  questions_used_today      INTEGER DEFAULT 0,
  last_reset_date           DATE,
  bonus_questions_remaining INTEGER DEFAULT 0,   -- from packs; never resets
  ad_watches_today          INTEGER DEFAULT 0,
  last_ad_reset_date        DATE,
  created_at           TIMESTAMP DEFAULT NOW()
);

-- If the table predates clerk_user_id:
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE;
UPDATE profiles SET clerk_user_id = id WHERE clerk_user_id IS NULL;

-- If the table predates the question-limit columns:
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS questions_used_today      INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_reset_date           DATE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bonus_questions_remaining INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ad_watches_today          INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_ad_reset_date        DATE;

CREATE INDEX IF NOT EXISTS profiles_clerk_idx       ON profiles (clerk_user_id);
CREATE INDEX IF NOT EXISTS profiles_email_idx       ON profiles (email);
CREATE INDEX IF NOT EXISTS profiles_stripe_cust_idx ON profiles (stripe_customer_id);
