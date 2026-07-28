# Logseq Codebase Overview

This document helps you understand more about how Logseq works. To contribute, read the [README](https://github.com/logseq/logseq) first.

## Tech Stack

### Clojure/ClojureScript

Nowadays compile-to-js are common practice. With the advent of web assembly, you can use almost any language to write browser apps. The Logseq app mostly uses Clojure.

Simply put, Clojure is a dynamic typing functional programming language, with Lisp's syntax, running on the JVM. ClojureScript is just Clojure compiling to JavaScript.

Clojure is easy to learn, you can pick it up pretty quickly following the [official guide](https://clojure.org/guides/learn/syntax).

Logseq chose ClojureScript not only because of all the [benefits](https://clojure.org/about/rationale) of the language itself but also because of its awesome ecosystem, such as the [DataScript](https://github.com/tonsky/datascript) library. More on that later.

### Build Tools

Shadow-cljs is a tool that helps compiling the ClojureScript code to JavaScript. In addition, it supports more handy features like live reload, code splitting, REPL, etc.

For other tasks like bundling static resources and building the desktop app, which is not covered by shadow-cljs, Logseq uses the good old [Gulp](https://gulpjs.com).

### React & Rum

[React](https://reactjs.org/) is a library for building data-driven UI declaratively. Comparing to the imperative ways (such as DOM manipulation or using jQuery), it's simpler and easier to code correctly.

[Rum](https://github.com/tonsky/rum) is a React wrapper in ClojureScript. More than just providing the familiar React APIs, Rum adds many Clojure flavors to React, especially on the state management part. As a result, if you have experience with React, read Rum's [README](https://github.com/tonsky/rum) before diving into the code.

### DataScript

[DataScript](https://github.com/tonsky/datascript) is an in-memory database that implements the [Datalog](https://en.wikipedia.org/wiki/Datalog) logic programming language. Datalog is very different from and much more expressive than the more common SQL and NoSQL query languages. Many users have implemented interesting features on top of Logseq just by utilizing the rich query language. Get started with Datalog with this [tutorial](http://www.learndatalogtoday.org/)

## Important Directories and Files

This is overview of this repository's most important directories and files.

- Config files are located at the root directory. `package.json` contains the JavaScript dependencies while `deps.edn` contains their ClojureScript counterparts. `shadow-cljs.edn` and `gulpfile.js` contain all the build scripts.

- `resources/` and `public` contain all the static assets

- `src/` is where most of the code is located.

  - `src/electron/` contains code specific to the Electron desktop app.

  - `src/test/` contains all the cljs tests.

  - `src/resources/` is a directory and Clojure(Script) resource classpath and includes language translations.

  - `src/main/frontend/` contains code that powers the Logseq editor. Directories and files inside are organized by features or functions. Some notable directories:
    - `src/main/frontend/components/` contains all the UI components.
    - `src/main/frontend/handler/` contains system component like code.
    - `src/main/frontend/worker/` contains code for the separate worker asset.
    - `src/main/frontend/common/` contains common code shared by the worker asset and the frontend.
  - `src/main/logseq/` contains the api used by plugins.
  - `src/main/mobile/` contains code for new mobile app.
  - `src/dev-cljs/` contains some development utilities.

- `deps/` contains ClojureScript dependencies or libraries used by the frontend.
  - `deps/graph-parser/` is a library that parses a Logseq graph and saves it to a database.

- `packages/` contains JavaScript dependencies used by the frontend
  - `packages/ui/` - The frontend's component system based on shadcn
- `scripts` - Dev scripts
- `clj-e2e/` - end to end clj frontend tests
- `android/` -  Android app
- `ios/` - iOS app

## Data Flow

### Application State

Most of Logseq's application state is divided into two parts. Document-related state (all your pages, blocks, and contents) is stored in DataScript. UI-related state (such as the current editing block) is kept in Clojure's [atom](https://clojure.org/reference/atoms). We then use Rum's reactive component to subscribe to these states. React efficiently re-renders after state changes.

### When the App Starts

Logseq loads files from your computer or the cloud, depending on your usage. The files are then parsed (and might be decrypted) and stored in DataScript. Other UI-related states are initialized. React components render for the first time. Event handlers are registered.

### When you Type Something in the Document

It's the typical flow of an event-driven GUI application. Various handlers (which are just functions) are listening for events like drag and drop, edit, format, and so on. When you start typing, the handler for editing blocks is called. It does three things:

- Save your work to the disk or the cloud, so you won't lose them in case of an emergent power off.
- Update the UI state.
- Run transactions to update the DataScript database. Since other parts of the app may use data that are affected by the change, we need to rebuild the database query cache.

After the change changes, React will dutifully refresh the screen.

## Architecture

Logseq has undergone a heavy refactoring, results in a much more robust and clear architecture. Read [this article](https://docs.logseq.com/#/page/The%20Refactoring%20Of%20Logseq) written by the main contributor to the refactoring for a detailed tour.

---

## Hypha Fork Layer

Everything above describes upstream Logseq and is preserved verbatim for clean upstream-sync merges. This repository is [Hypha](HYPHA.md), a self-hostable single-user fork. Hypha keeps the upstream tree intact and adds a thin layer on top. If you are orienting yourself in the Hypha-specific code, here is where it lives:

- `HYPHA.md` — fork landing page (what Hypha adds, quick start, doc map).
- `HYPHA_PATCHES.md` — per-line inventory of every upstream-Logseq line Hypha modifies, with rationale and a structural-break grep. Start here before touching upstream code.
- `src/main/frontend/hypha/` — the browser-side Hypha layer (additive ClojureScript). Notable namespaces:
  - `init.cljs` — bootstraps the Hypha layer at app start.
  - `plugin_init.cljs` — runtime monkey-patch that rewrites plugin asset URLs through the Hypha CORP proxy (no upstream `LSPlugin.core` patch).
  - `asset_cache.cljs` — background LRU eviction of cached asset binaries via `navigator.storage.estimate` + IndexedDB cleanup.
  - `capture.cljs` — quick capture from the PWA share target / bookmarklet: parses the `hypha-*` URL params and dispatches upstream's `:editor/quick-capture`.
- `hypha-server/` — the TypeScript reverse-proxy that fronts the upstream `db-sync` node-adapter on port 3030: access-code auth + JWT/JWKS, plugin-marketplace caching, plugin-asset CORP injection, and pass-through of `/sync/`, `/graphs/`, `/assets/`, `/e2ee/` routes. Tests live in `hypha-server/test/`.
- `docs/hypha/` — operator and architecture docs (self-hosting, operations, phase plans).
- `bin/hypha-*` — build entry points (`bin/hypha-build`, `--release` for production).
- `docker-compose.hypha.yml` — single-container deploy; data bind-mounted to `./data/`.

Upstream Logseq surgical patches are intentionally capped (self-imposed 20-patch soft limit, currently 9/20); beyond ~50 % the interception strategy would be refactored rather than extended. See [`HYPHA_PATCHES.md`](HYPHA_PATCHES.md) for the current inventory and `.github/scripts/hypha-patch-anchors.sh` for the break-detection checks.
