// Web Push subscription helpers for closed-app study reminders. The VAPID public
// key comes from build-time env; when it isn't configured the whole feature
// reports itself unsupported, so nothing renders or throws before setup. All the
// server round-trips go through the app's existing authed poster (socialApi), so
// a subscription is always tied to the signed-in user.
const VAPID_PUBLIC = (import.meta.env.VITE_VAPID_PUBLIC_KEY || "").trim();

export function pushConfigured() { return VAPID_PUBLIC.length > 0; }

export function pushSupported() {
  try {
    return pushConfigured() && "serviceWorker" in navigator && "PushManager" in window &&
      "Notification" in window && typeof Notification.requestPermission === "function";
  } catch { return false; }
}

// Has this browser already granted permission AND holds a live subscription?
export async function pushState() {
  if (!pushSupported()) return { supported: false, subscribed: false, blocked: false };
  const blocked = Notification.permission === "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, subscribed: !!sub, blocked };
  } catch { return { supported: true, subscribed: false, blocked }; }
}

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Request permission, subscribe via the service worker, and register the
// subscription with the server. `api` = (action, payload) => Promise (socialApi).
// Returns { ok } or { ok:false, reason } so the UI can explain a decline.
export async function enablePush(api) {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: perm === "denied" ? "blocked" : "dismissed" };
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) });
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return { ok: false, reason: "unsupported" };
    const r = await api("pushSubscribe", { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    if (r && r.error) return { ok: false, reason: "server" };
    return { ok: true };
  } catch { return { ok: false, reason: "error" }; }
}

// Drop the browser subscription and tell the server to forget it. Best-effort.
export async function disablePush(api) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await api("pushUnsubscribe", { endpoint });
    }
  } catch { /* best effort */ }
  return { ok: true };
}
