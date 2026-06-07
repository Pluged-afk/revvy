import sql from "./db.js";

// One-time provisioning endpoint: creates the profiles table if it doesn't
// exist. Hit it once after deploy (GET /api/init-db), then you can ignore it.
export default async function handler(req, res) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS profiles (
        id                   TEXT PRIMARY KEY,
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
    await sql`CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (email)`;
    await sql`CREATE INDEX IF NOT EXISTS profiles_stripe_cust_idx ON profiles (stripe_customer_id)`;
    return res.status(200).json({ ok: true, message: "profiles table ready" });
  } catch (e) {
    console.error("[init-db]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
