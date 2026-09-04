// Notifications that actually fire. The old code called `new Notification(...)`,
// which throws on several browsers (notably Android Chrome) and only ran while a
// tab was open for a plan. This routes through a service worker's
// showNotification (broadly supported) with a constructor fallback, and exposes
// a permission helper. Closed-app delivery still needs Web Push (VAPID + a
// backend cron) — the service worker's `push` handler is ready for that.

let regPromise = null;
export function ensureSW() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!regPromise) regPromise = navigator.serviceWorker.register("/sw.js").then((r) => r).catch(() => null);
  return regPromise;
}

export function notifPermission() {
  return (typeof Notification === "undefined") ? "unsupported" : Notification.permission;
}

// Ask for permission (once) and register the worker. Returns the final state.
export async function enableNotifications() {
  if (typeof Notification === "undefined") return "unsupported";
  let perm = Notification.permission;
  if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { /* ignore */ } }
  if (perm === "granted") await ensureSW();
  return perm;
}

// Show a notification now (best-effort). No-ops without permission.
export async function notify(title, body, opts = {}) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const options = { body, tag: opts.tag || "revyy", data: { url: opts.url || "/app" }, ...opts };
  try {
    const reg = await ensureSW();
    if (reg && reg.showNotification) { await reg.showNotification(title, options); return true; }
  } catch { /* fall through to the constructor */ }
  try { new Notification(title, options); return true; } catch { return false; }
}

// Fire at most once per calendar day per key (so nudges never spam). Uses
// localStorage; returns true if it fired.
export async function notifyOncePerDay(key, title, body, opts = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const lsKey = `revyy_notif_${key}`;
  try { if (localStorage.getItem(lsKey) === day) return false; } catch { /* ignore */ }
  const ok = await notify(title, body, opts);
  if (ok) { try { localStorage.setItem(lsKey, day); } catch { /* ignore */ } }
  return ok;
}
