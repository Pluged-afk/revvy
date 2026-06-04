# Revyy

Turn any material into a quiz — instantly. Upload a PDF, paste notes, or take a
photo and Revyy builds a study quiz in seconds using AI.

## Stack

- **React 19 + Vite** — SPA, React Router
- **Supabase** — auth (email/password + Google) and the `profiles` table
- **Stripe** — subscriptions (monthly/yearly, 7-day trial), webhook, customer portal
- **EmailJS** — contact form
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
VITE_SUPABASE_URL=            # frontend
VITE_SUPABASE_ANON_KEY=       # frontend (publishable key)
SUPABASE_SERVICE_ROLE_KEY=    # server only — secret
STRIPE_SECRET_KEY=            # server only — secret
STRIPE_WEBHOOK_SECRET=        # server only — secret
VITE_STRIPE_PUBLISHABLE_KEY=
VITE_STRIPE_MONTHLY_PRICE=
VITE_STRIPE_YEARLY_PRICE=
```

On Vercel, set the same variables in **Project → Settings → Environment Variables**.

## Database

Run [`supabase_setup.sql`](./supabase_setup.sql) once in the Supabase SQL editor
to create the `profiles` table (Pro status, Stripe IDs, trial) and its policies.

## Routes

`/` home · `/features` · `/pricing` · `/about` · `/contact` · `/privacy` ·
`/terms` · `/login` · `/signup` · `/reset-password` · `/auth/callback` ·
`/app` (the quiz app — requires sign-in)

## Testing payments

Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC.
