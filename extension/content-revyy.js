// Runs on revyy.app at document_start. If the popup stashed a captured page in
// chrome.storage.local, hand it to the web app via localStorage (key
// "revyy_import") and fire a "revyy-import" event in case the app already
// mounted. The app re-reads localStorage on that event, so we don't rely on the
// cross-world event detail surviving. Cleared after read so it fires once.
(function () {
  try {
    chrome.storage.local.get("revyy_pending", (data) => {
      const p = data && data.revyy_pending;
      if (!p || !p.text) return;
      try { localStorage.setItem("revyy_import", JSON.stringify(p)); } catch (e) { /* storage blocked */ }
      try { chrome.storage.local.remove("revyy_pending"); } catch (e) { /* ignore */ }
      const nudge = () => { try { window.dispatchEvent(new CustomEvent("revyy-import")); } catch (e) { /* ignore */ } };
      nudge();
      // The SPA may mount a beat later; nudge again once the DOM is ready.
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", nudge, { once: true });
    });
  } catch (e) { /* not in extension context */ }
})();
