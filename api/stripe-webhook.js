import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Stripe webhook: keeps Supabase `profiles.is_pro` in sync with subscription state.
// Requires raw body for signature verification, so body parsing is disabled.
export const config = { api: { bodyParser: false } };

const ACTIVE = ["active", "trialing"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
    return res.status(500).json({ error: "Server missing Stripe secrets." });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify signature against the raw body.
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Update is_pro by Supabase user id (preferred) or by Stripe customer id.
  const setPro = async ({ userId, customerId, isPro }) => {
    const patch = { is_pro: isPro };
    if (customerId) patch.stripe_customer_id = customerId;
    if (userId) {
      await admin.from("profiles").update(patch).eq("id", userId);
    } else if (customerId) {
      await admin.from("profiles").update({ is_pro: isPro }).eq("stripe_customer_id", customerId);
    }
    console.log(`[stripe-webhook] ${event.type}: is_pro=${isPro} user=${userId || "?"} cust=${customerId || "?"}`);
  };

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        await setPro({
          userId: sub.metadata?.userId,
          customerId: sub.customer,
          isPro: ACTIVE.includes(sub.status),
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await setPro({ userId: sub.metadata?.userId, customerId: sub.customer, isPro: false });
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        await setPro({ customerId: inv.customer, isPro: false });
        break;
      }
      default:
        // ignore other events
        break;
    }
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return res.status(500).json({ error: "Webhook handler failed." });
  }

  return res.status(200).json({ received: true });
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
