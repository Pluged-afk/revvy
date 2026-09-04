# Revyy "Quiz this page" browser extension

A tiny Chrome/Edge (Manifest V3) extension: while reading any article, click it to
turn the page into a Revyy quiz.

## How it works
1. The popup extracts the article's text from the active tab (`article` → `main`
   → `body`, capped at 20k chars) and stashes it in `chrome.storage.local`.
2. It opens (or focuses) `https://revyy.app/app`.
3. `bridge.js` (a content script on revyy.app) copies the stashed text into the
   page's `localStorage["revyy_import"]` and dispatches the `revyy-import` event.
4. The Revyy app already listens for that: it drops the text into the "Text" tab
   of the create screen so you just pick your options and hit **Generate quiz**.

No API keys, no backend changes — it rides the app's existing import hook. You do
need to be signed in on revyy.app to generate.

## Load it (unpacked, for testing)
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension/` folder.
4. Pin it, open any article, click the icon, then **Make a quiz from this page**.

## Files
- `manifest.json` — MV3 manifest (activeTab + scripting + storage; host access to revyy.app only).
- `popup.html` / `popup.js` — the button + page-text extraction + handoff.
- `bridge.js` — content script on revyy.app that feeds the text into the app.

## Before publishing to the Chrome Web Store
- Add `icons` (16/48/128 px) to the manifest and an `action.default_icon`.
- Optionally support more sites/PDF pages and a "choose question count" control.
