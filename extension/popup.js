// Revyy "Quiz this page" popup. Extracts the readable text of the current tab,
// stashes it, and opens Revyy, which already knows how to import it (the app
// reads localStorage "revyy_import" + listens for a "revyy-import" event; the
// bridge content script moves the stashed text into that key on revyy.app).
const REVYY_URL = "https://revyy.app/app?import=ext";

// Runs IN the article page to pull out its main text.
function extractArticle() {
  const pick = document.querySelector("article") || document.querySelector("main") || document.body;
  const title = (document.title || "").trim();
  let text = (pick && pick.innerText) || (document.body && document.body.innerText) || "";
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: text.slice(0, 20000), url: location.href };
}

const btn = document.getElementById("go");
const msg = document.getElementById("msg");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  msg.textContent = "Reading the page…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { msg.textContent = "No active tab."; btn.disabled = false; return; }
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractArticle });
    const result = results && results[0] && results[0].result;
    if (!result || (result.text || "").trim().length < 40) {
      msg.textContent = "Couldn't find enough text on this page.";
      btn.disabled = false;
      return;
    }
    const payload = { text: `${result.title}\n\n${result.text}`.trim(), source: result.url };
    await chrome.storage.local.set({ revyy_pending: payload });

    // Reuse an open Revyy tab if there is one, else open a fresh one.
    const existing = await chrome.tabs.query({ url: "https://revyy.app/*" });
    if (existing && existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true, url: REVYY_URL });
      if (existing[0].windowId != null) { try { await chrome.windows.update(existing[0].windowId, { focused: true }); } catch { /* ignore */ } }
    } else {
      await chrome.tabs.create({ url: REVYY_URL });
    }
    msg.textContent = "Opening Revyy…";
    setTimeout(() => window.close(), 400);
  } catch (e) {
    msg.textContent = "Something went wrong. Try again.";
    btn.disabled = false;
  }
});
