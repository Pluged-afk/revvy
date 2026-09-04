// Content script on revyy.app. When the popup stashed an article, move it into
// the page's localStorage under "revyy_import" (the shape the app already
// imports) and fire the "revyy-import" event the app listens for. Runs on every
// revyy.app load but no-ops unless something is pending, so there's no loop.
try {
  chrome.storage.local.get("revyy_pending", (data) => {
    const p = data && data.revyy_pending;
    if (!p || !p.text) return;
    try {
      localStorage.setItem("revyy_import", JSON.stringify({ text: p.text }));
      chrome.storage.local.remove("revyy_pending");
      // If the app is already mounted, this event triggers the import; if not,
      // the app's own on-mount check picks up the localStorage key.
      window.dispatchEvent(new CustomEvent("revyy-import"));
    } catch { /* ignore */ }
  });
} catch { /* not on revyy.app or storage unavailable */ }
