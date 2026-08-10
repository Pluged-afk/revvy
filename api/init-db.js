import sql from "./db.js";

// One-time provisioning: creates the profiles table and ensures the
// clerk_user_id column exists. Protected by INIT_DB_SECRET so it can't be
// triggered anonymously, run: GET /api/init-db?secret=<INIT_DB_SECRET>.
// Returns 404 without the secret so the endpoint isn't discoverable.
export default async function handler(req, res) {
  const secret = process.env.INIT_DB_SECRET;
  const provided = (req.query && req.query.secret) || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return res.status(404).json({ error: "Not found" });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS profiles (
        id                   TEXT PRIMARY KEY,
        clerk_user_id        TEXT UNIQUE,
        email                TEXT UNIQUE,
        is_pro               BOOLEAN DEFAULT FALSE,
        stripe_customer_id   TEXT,
        subscription_id      TEXT,
        subscription_status  TEXT,
        subscription_plan    TEXT,
        current_period_end   TIMESTAMP,
        cancel_at_period_end BOOLEAN DEFAULT FALSE,
        created_at           TIMESTAMP DEFAULT NOW()
      )`;
    // Backfill for tables created before clerk_user_id existed.
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE`;
    await sql`UPDATE profiles SET clerk_user_id = id WHERE clerk_user_id IS NULL`;
    // Question-limit / monetization columns.
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS questions_used_today INTEGER DEFAULT 0`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_reset_date DATE`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bonus_questions_remaining INTEGER DEFAULT 0`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ad_watches_today INTEGER DEFAULT 0`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_ad_reset_date DATE`;
    // Mock-exam daily cap (Pro-only, account-tied).
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mocks_used_today INTEGER DEFAULT 0`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_mock_reset_date DATE`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_clerk_idx ON profiles (clerk_user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (email)`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_stripe_cust_idx ON profiles (stripe_customer_id)`;

    // Server-synced study data: one JSON blob per user holding the spaced-
    // repetition deck, lifetime stats + streak, exam date, and study plans.
    // Kept as a single row so cross-device sync is one read / one write.
    await sql`
      CREATE TABLE IF NOT EXISTS study_data (
        clerk_user_id TEXT PRIMARY KEY,
        data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    // Publicly-shareable quizzes ("share-a-quiz") + their friend leaderboards.
    await sql`
      CREATE TABLE IF NOT EXISTS shared_quizzes (
        id         TEXT PRIMARY KEY,
        data       JSONB       NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    return res.status(200).json({ ok: true, message: "profiles + study_data + shared_quizzes tables ready" });
  } catch (e) {
    console.error("[init-db]", e.message);
    return res.status(500).json({ error: "Initialization failed." });
  }
}
