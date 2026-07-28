# Install Hypha as an app + Quick capture

Two small things that make a self-hosted Hypha feel like a real app:
installing it to your homescreen or dock, and throwing a link into
today's journal without opening the app first.

Both work against your own instance only — nothing here talks to any
third-party service.

## Install Hypha as an app

Hypha serves a web app manifest at `/manifest.webmanifest`, so browsers
offer a proper install (standalone window, own icon, no browser chrome)
instead of a plain bookmark.

- **Android / Chrome**: open your instance, menu → *Install app* (or *Add
  to Home screen*).
- **Desktop Chrome / Edge**: the install icon appears at the right end of
  the address bar.
- **iOS / Safari**: Share → *Add to Home Screen*. Safari ignores most of
  the manifest but does honour the standalone display.

Once installed, the in-app back/forward buttons appear automatically —
an installed window has no browser toolbar to fall back on.

## Quick capture

### From the Android share sheet

After installing, Hypha shows up as a share target. Share a page from any
app → pick Hypha → the app opens and the link lands in today's journal.

### From the desktop, via bookmarklet

Create a bookmark whose URL is the snippet below, replacing
`YOUR-HYPHA-HOST` with your instance. Clicking it on any page captures the
page title, its URL, and whatever text you have selected.

```js
javascript:(()=>{const u=new URL('https://YOUR-HYPHA-HOST/');u.searchParams.set('hypha-title',document.title);u.searchParams.set('hypha-url',location.href);const s=String(getSelection());if(s)u.searchParams.set('hypha-text',s);open(u,'_blank');})()
```

### What actually happens

Both paths do the same thing: they open Hypha with the captured fields as
query params.

| Param | Content |
|---|---|
| `hypha-title` | page title |
| `hypha-url` | page URL |
| `hypha-text` | selected text (optional) |

On boot Hypha reads those params, removes them from the URL (so a reload
cannot capture twice), waits for your graph to finish loading, and then
hands them to Logseq's built-in quick capture. Formatting and target page
therefore follow the stock config in your graph:

```clojure
:quick-capture-templates {:text "**{time}** [[quick capture]]: {text} {url}"}
:quick-capture-options   {:insert-today?  true
                          :redirect-page? false}
```

If no graph is open within 60 seconds of the capture (for example a fresh
login that still has to download the graph), the capture is dropped and a
warning is logged to the console rather than silently misfiled.

## Verifying it works

```bash
# manifest is served and declares the share target
curl -s https://YOUR-HYPHA-HOST/manifest.webmanifest | jq '.share_target'

# index.html links the manifest (this is injected at serve time)
curl -s https://YOUR-HYPHA-HOST/ | grep -o '<link rel="manifest"[^>]*>'
```

Manual smoke for the capture path itself, since it needs a live graph:

1. Open your instance and let a graph finish loading.
2. Visit `https://YOUR-HYPHA-HOST/?hypha-title=Test&hypha-url=https://example.com`.
3. Today's journal gets a new block containing the link, and the address
   bar no longer shows the `hypha-*` params.

## Clipping with Hypha closed (Firefox / Thunderbird add-ons)

The bookmarklet and the share target both work by *opening Hypha*. That is
fine on a phone, awkward on a desktop, and impossible from Thunderbird — a
mail client cannot host Hypha, which needs OPFS and SharedArrayBuffer
behind COEP.

So there is a second route: the add-ons in [`hypha-clipper/`](../../hypha-clipper/README.md)
POST to a **capture inbox** on hypha-server, and Hypha drains it on its next
boot. Clip while Hypha is closed; the blocks appear when you next open it.

The inbox never writes the graph — it is a mailbox on disk under
`HYPHA_DATA_DIR`. The browser still does the actual insert, through the same
quick-capture path as everything else.

```
POST /capture         { title?, text?, url? }   → 201 { id }
GET  /capture/pending                           → 200 { clips: [...] }
POST /capture/ack     { ids: [...] }            → 200 { remaining }
```

Auth is a JWT in `Authorization: Bearer`, obtained by POSTing the access
code to `/auth/login` — the same credential and endpoint the web app uses.
Clips are acked only *after* the blocks are inserted, so a browser that dies
mid-drain replays them instead of losing them.

Setup and usage: [`hypha-clipper/README.md`](../../hypha-clipper/README.md).

## Where this lives in the code

- `hypha-server/src/routes/manifest.ts` — manifest + `share_target`
  declaration (`CAPTURE_PARAMS` is the param-name contract).
- `hypha-server/src/statics.ts` — injects the `<link rel="manifest">` into
  index.html at serve time, so `resources/index.html` stays untouched.
- `src/main/frontend/hypha/capture.cljs` — parses the params, drains the
  capture inbox, and dispatches upstream's `:editor/quick-capture` event.
- `hypha-server/src/capture-inbox.ts` + `src/routes/capture.ts` — the inbox
  and its API.
- `hypha-clipper/` — the Firefox and Thunderbird add-ons.
- Tests: `hypha-server/test/pwa.test.ts`,
  `hypha-server/test/capture.test.ts`,
  `hypha-clipper/test/`,
  `src/test/frontend/hypha/capture_test.cljs`.
