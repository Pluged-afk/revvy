// Revyy service worker. Two jobs:
//  1. PWA: a small offline shell + fast static assets so Revyy is installable
//     and opens offline. Navigations are network-first (always the fresh app);
//     the API is never cached; cross-origin (Clerk, Stripe, fonts, ads) is left
//     completely untouched.
//  2. Notifications: registration.showNotification works on browsers where the
//     `new Notification()` constructor throws (e.g. Android Chrome), plus click
//     handling and future Web Push.
const CACHE = "revyy-v2";
const SHELL = "/app";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => { try { const c = await caches.open(CACHE); await c.add(SHELL); } catch { /* offline at install: fine */ } })());
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;   // never touch Clerk/Stripe/fonts/ads
  if (url.pathname.startsWith("/api/")) return;        // never cache the API

  if (req.mode === "navigate") {
    // Always try the network first so a launch gets the freshest app; fall back
    // to the cached shell only when offline.
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match(SHELL)) || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }

  // Same-origin static assets (hashed, immutable): stale-while-revalidate.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => { if (res && res.ok && res.type === "basic") cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || new Response("", { status: 504 });
  })());
});

// ── Notifications ──
// Focus an open Revyy tab when a notification is clicked, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/app";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes("revyy.app") || c.url.includes("localhost")) { try { await c.focus(); return; } catch { /* ignore */ } }
    }
    try { await self.clients.openWindow(target); } catch { /* ignore */ }
  })());
});

// Web Push (used once a backend sends daily reminders with VAPID keys).
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || "Revyy", {
    body: d.body || "Time to study.",
    tag: d.tag || "revyy",
    data: { url: d.url || "/app" },
  }));
});
