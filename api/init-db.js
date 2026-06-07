import sql from "./db.js";

// One-time provisioning: creates the profiles table and ensures the
// clerk_user_id column exists. Hit GET /api/init-db once after deploy.
export default async function handler(req, res) {
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
    await sql`CREATE INDEX IF NOT EXISTS profiles_clerk_idx ON profiles (clerk_user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (email)`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_stripe_cust_idx ON profiles (stripe_customer_id)`;
    return res.status(200).json({ ok: true, message: "profiles table ready (with clerk_user_id)" });
  } catch (e) {
    console.error("[init-db]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
