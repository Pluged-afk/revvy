// Revyy extension popup. On open it reads the active tab (readable text +
// any selection), previews it, and, on click, stashes it in
// chrome.storage.local and opens revyy.app, where the content script hands it
// to the app. No page content ever leaves the browser except to Revyy itself.

const REVYY_URL = "https://revyy.app/app";
const el = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Runs in the page: pull the main readable text + any current selection.
function extractFromPage() {
  const sel = ((window.getSelection && window.getSelection().toString()) || "").trim();
  const main = document.querySelector("article") || document.querySelector("main") || document.body;
  const text = ((main && main.innerText) || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { selection: sel, text, title: document.title || "", url: location.href };
}

let captured = null;

function fail(msg) {
  el("preview").textContent = msg;
  el("srcLabel").textContent = "Can't capture";
  el("go").disabled = true;
}

async function init() {
  const tab = await activeTab();
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension|https:\/\/chrome\.google\.com):/.test(tab.url || "")) {
    return fail("Open a normal web page (article, notes, docs) to quiz it.");
  }
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractFromPage });
  } catch {
    return fail("Couldn't read this page. Try reloading it.");
  }
  captured = res && res.result;
  if (!captured) return fail("Couldn't read this page.");

  const useSel = captured.selection && captured.selection.length > 40;
  const src = (useSel ? captured.selection : captured.text) || "";
  if (src.trim().length < 40) return fail("Not enough text on this page to make a quiz.");

  captured._use = src.trim().slice(0, 20000);
  el("srcLabel").textContent = useSel ? "Selected text" : "Whole page";
  el("preview").textContent = src.replace(/\s+/g, " ").trim().slice(0, 240) + (src.length > 240 ? "…" : "");
  el("go").disabled = false;
}

el("go").addEventListener("click", async () => {
  if (!captured || !captured._use) return;
  el("go").disabled = true;
  el("status").textContent = "Opening Revyy…";
  await chrome.storage.local.set({
    revyy_pending: {
      text: captured._use,
      title: captured.title || "",
      url: captured.url || "",
      count: Number(el("count").value) || 10,
      qtype: el("type").value || "mcq",
      at: Date.now(),
    },
  });
  await chrome.tabs.create({ url: REVYY_URL });
  window.close();
});

init();
