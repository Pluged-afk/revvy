# Revyy

Turn any material into a quiz — instantly. Upload a PDF, paste notes, or take a
photo and Revyy builds a study quiz in seconds using AI.

## Stack

- **React 19 + Vite** — SPA, React Router
- **Supabase** — auth (email/password + Google) and the `profiles` table
- **Stripe** — subscriptions (monthly/yearly, 7-day trial), webhook, customer portal
- **Resend** — contact form + inbound email forwarding (`/api/contact`, `/api/inbound-email`)
- Vercel serverless functions under `/api`

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run dev` serves the `/api/*` functions via a Vite middleware, so checkout,
the webhook, the portal, and account deletion all work locally.

## Environment variables (`.env`, not committed)

```
VITE_CLERK_PUBLISHABLE_KEY=   # frontend (Clerk)
VITE_STRIPE_PUBLISHABLE_KEY=
VITE_STRIPE_MONTHLY_PRICE=
VITE_STRIPE_YEARLY_PRICE=
CLERK_SECRET_KEY=             # server only — secret
DATABASE_URL=                 # server only — Neon connection string
STRIPE_SECRET_KEY=            # server only — secret
STRIPE_WEBHOOK_SECRET=        # server only — secret
ANTHROPIC_API_KEY=            # server only — secret (quiz generation proxy)
```

On Vercel, set the same variables in **Project → Settings → Environment Variables**.

## Auth & Database

Authentication is handled by **Clerk** (`@clerk/clerk-react`). Profiles live in
**Neon** (Postgres). Run [`neon_setup.sql`](./neon_setup.sql) once against your
Neon database — or hit `GET /api/init-db` after deploy — to create the
`profiles` table (Pro status + Stripe IDs).

## Routes

`/` home · `/features` · `/pricing` · `/about` · `/contact` · `/privacy` ·
`/terms` · `/login` · `/signup` (Clerk) ·
`/app` (the quiz app — requires sign-in)

## Testing payments

Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC.
