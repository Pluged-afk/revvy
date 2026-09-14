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
- `manifest.json` — MV3 manifest (activeTab + scripting + storage; host access to revyy.app only; icons 16/48/128 wired for the toolbar + store).
- `popup.html` / `popup.js` — the button + page-text extraction + handoff.
- `bridge.js` — content script on revyy.app that feeds the text into the app.
- `icon16/48/128.png` — the toolbar and store icons (regenerate with `node _geticon.mjs`).

## Publish it to the Chrome Web Store
The extension is publish-ready (valid MV3 manifest, icons wired, verified end
to end against revyy.app's import hook). To ship it to real users:
1. Zip the contents of this `extension/` folder (the files, not the folder itself).
2. Create a Chrome Web Store developer account (one-time $5 fee) at
   https://chrome.google.com/webstore/devconsole and click **New item**.
3. Upload the zip, fill in the listing (screenshots, description, a privacy note
   saying it only reads the active tab's text when you click it and sends it to
   revyy.app), and submit for review.
- Edge users can install the same package via the Microsoft Partner Center.
- Ideas for later: support PDF pages and a "choose question count" control.
