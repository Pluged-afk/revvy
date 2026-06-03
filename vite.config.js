import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Dev-only: emulate Vercel serverless functions so everything under /api/*
// works with `npm run dev` too (plain Vite does not serve the api/ folder).
// Server secrets stay here — they are never sent to the client.
function devApi() {
  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next()
        const name = req.url.split('?')[0].replace(/^\/api\//, '').replace(/\/+$/, '')
        console.log('[dev-api] →', req.method, '/api/' + name)
        // Shim the Express/Vercel-style helpers the handlers expect.
        res.status = (code) => { res.statusCode = code; return res }
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(obj))
        }
        // Resolve against the real project root (the bundled config runs from
        // a temp dir, so a relative './api/…' specifier would not resolve).
        const fileUrl = pathToFileURL(path.resolve(process.cwd(), 'api', `${name}.js`)).href
        import(/* @vite-ignore */ fileUrl)
          .then(({ default: handler }) => handler(req, res))
          .catch((e) => {
            console.error(`[dev-api] /api/${name} threw:`, e)
            res.statusCode = (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(e?.message || '')) ? 404 : 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: e.message || 'Dev API error' }))
          })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env (all keys, including non-VITE server secrets) and hand the
  // server-only ones to this Node process for the dev middleware above.
  // NOTE: only assign when a value exists — assigning `undefined` to
  // process.env coerces it to the string "undefined" (which is truthy).
  const env = loadEnv(mode, process.cwd(), '')
  // Set when defined; otherwise CLEAR it, so a stale value can't linger in a
  // reused dev process and masquerade as a configured (but invalid) key.
  const setEnv = (key, value) => { if (value) process.env[key] = value; else delete process.env[key] }
  setEnv('SUPABASE_URL', env.SUPABASE_URL || env.VITE_SUPABASE_URL)
  setEnv('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY)
  setEnv('SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY)
  setEnv('STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY)
  setEnv('STRIPE_WEBHOOK_SECRET', env.STRIPE_WEBHOOK_SECRET)

  // Startup diagnostic — printed to the terminal running `npm run dev`.
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  console.log(
    `\n[revvy] env from ${process.cwd()}\\.env\n` +
    `        SUPABASE_URL .............. ${process.env.SUPABASE_URL ? 'loaded' : 'MISSING'}\n` +
    `        SUPABASE_ANON_KEY ......... ${process.env.SUPABASE_ANON_KEY ? 'loaded' : 'MISSING'}\n` +
    `        SUPABASE_SERVICE_ROLE_KEY . ${k ? `loaded (${k.slice(0, 10)}…, len ${k.length})` : 'MISSING — delete will not work'}\n`
  )

  return {
    plugins: [react(), devApi()],
  }
})
