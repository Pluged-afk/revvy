// Revyy service worker: shows notifications reliably (registration.showNotification
// works on browsers where the `new Notification()` constructor throws, e.g.
// Android Chrome) and handles clicks + future Web Push messages.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
