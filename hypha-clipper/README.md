# Hypha Clipper

Firefox and Thunderbird add-ons that send pages and mails to your Hypha
instance.

Clips do not land in the graph directly. Your graph lives in the browser
profile that runs Hypha (OPFS, synced over RTC), so an add-on cannot write
it. Instead the add-ons POST to Hypha's **capture inbox**, and Hypha drains
that inbox the next time you open it. Clip with Hypha closed; the blocks are
there when you come back.

## Layout

```
shared/      capture client, clip builders, settings, options page
firefox/     manifest + background page
thunderbird/ manifest + background page
build.mjs    copies shared/ into each flavour → dist/
test/        node:test suites for the shared logic
```

WebExtension manifests cannot reference files outside the add-on root, so
`build.mjs` copies `shared/` into each flavour rather than importing across
directories.

## Build and install

```bash
node build.mjs
```

**Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on →
pick `dist/firefox/manifest.json`.

**Thunderbird**: Add-ons Manager → gear icon → Debug Add-ons → Load
Temporary Add-on → pick `dist/thunderbird/manifest.json`.

Temporary add-ons disappear on restart. For a permanent install, zip the
flavour directory and sign it, or run an unbranded/developer build that
allows unsigned add-ons.

## Configure

Open the add-on's options and set:

- **Server URL** — where you open Hypha, e.g. `https://hypha.example.com`
- **Access code** — your instance access code

The code is kept in `storage.local` (this profile only, never synced to a
Mozilla account) and exchanged for a short-lived JWT via `/auth/login`,
exactly like the web app. Hypha regenerates its signing keys on restart, so
the add-on silently re-logs in when a token stops being accepted.

## Clipping

**Firefox** — toolbar button, right-click → *Clip to Hypha* (page or
selection), or `Ctrl+Shift+Y`. Sends title, URL and any selected text.

**Thunderbird** — the *Clip to Hypha* button in the message-display
toolbar. Sends subject, sender, date, and the Message-ID as a `mid:` link.
Thunderbird resolves `mid:` links; from a browser they need an OS protocol
handler, but the id remains searchable in Thunderbird either way.

## Tests

```bash
node --test test/*.test.js
```

Covered: the access-code login, token reuse, the single 401 retry, error
surfacing, and clip construction. The browser glue (menus, buttons,
notifications) is not covered — it only proves itself in a real
Firefox/Thunderbird.

Server side: `hypha-server/test/capture.test.ts`.
Drain side: `src/test/frontend/hypha/capture_test.cljs`.
