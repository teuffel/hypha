(ns frontend.hypha.plugin-init
  "Hypha plugin-system bootstrap. Runs at namespace-load time (before
  `frontend.handler/start!` is invoked) so that the Logseq plugin subsystem
  picks up Hypha's shims and proxy redirects on its first marketplace fetch.

  Two side effects:

  1. `install-fetch-redirect!` monkey-patches `js/window.fetch` with a
     prefix-based URL rewriter:

         https://raw.githubusercontent.com/logseq/marketplace/master/... → /plugin-market/...
         https://plugins.logseq.io/r2/...                                → /plugin-cdn/r2/...

     All Logseq marketplace traffic flows through `window.fetch` (verified
     V2 2026-05-27: `util/fetch` uses `js/fetch`, `handler.common.plugin`
     uses `js/window.fetch` — both share the same global binding). Prefix
     filter is the only requirement; non-marketplace fetches pass through
     unmodified. The wrapper is idempotent via the `__hyphaWrapped` flag.

  2. `install-window-apis!` installs an `EventEmitter3`-based stub on
     `js/window.apis` with browser-equivalent implementations for the
     `window.apis.*` methods Logseq's web-mode plugin code reaches for.
     Doing this BEFORE `frontend.handler.plugin/setup-global-apis-for-web!`
     runs means the upstream nil-check skips its bare EventEmitter3 setup
     (the EventEmitter3 surface is preserved here so `addListener`/`emit`
     still work for plugin IPC).

  See `docs/hypha/phase-1.5-plugin-marketplace.md` sections 2.2 + 2.3."
  (:require [clojure.string :as string]
            [frontend.hypha.config :as hypha-config]))

;; ---------------------------------------------------------------------------
;; (1) window.fetch redirect

(def ^:private marketplace-prefix
  "https://raw.githubusercontent.com/logseq/marketplace/master/")

(def ^:private cdn-prefix
  "https://plugins.logseq.io/r2/")

(defn- rewrite-url
  "Returns the rewritten URL when one of the two marketplace prefixes match,
  else the original URL unchanged. String-only — Request objects pass through."
  [url]
  (if-not (string? url)
    url
    (cond
      (string/starts-with? url marketplace-prefix)
      (str "/plugin-market/" (subs url (count marketplace-prefix)))

      (string/starts-with? url cdn-prefix)
      (str "/plugin-cdn/r2/" (subs url (count cdn-prefix)))

      :else url)))

(defn install-fetch-redirect!
  "Wrap `js/window.fetch` so marketplace + R2 URLs hit the Hypha-server proxy
  routes instead of going straight to GitHub / Cloudflare. Idempotent."
  []
  (let [^js orig (.-fetch js/window)]
    (when-not (.-__hyphaWrapped orig)
      (let [wrapped (fn [url & args]
                      ;; to-array (not clj->js) so JS init objects (e.g.
                      ;; { body: <ReadableStream>, signal: <AbortSignal> })
                      ;; pass through by reference without being recursively
                      ;; converted, which would break streams + signals.
                      (.apply orig js/window
                              (to-array (cons (rewrite-url url) args))))]
        (set! (.-__hyphaWrapped wrapped) true)
        (set! (.-fetch js/window) wrapped)))))

;; ---------------------------------------------------------------------------
;; (2) window.apis stubs
;;
;; The upstream web shim is a bare `new EventEmitter3()` — listener wiring
;; works but every platform method (openExternal, openPath, ...) is missing,
;; so plugins that call them get a no-op + timeout into the "plugin took too
;; long to load" warning. Hypha replaces this with an EventEmitter3 that
;; also exposes the platform methods, mapped to browser-native equivalents
;; or silent no-ops where no equivalent exists.

(defn- noop [& _args] nil)

(defn- resolved-promise
  "Returns a JS Promise resolved with the given value."
  [v]
  (.resolve js/Promise v))

(defn- stub-open-external
  [url]
  (when (string? url)
    (.open js/window url "_blank" "noopener,noreferrer")))

(defn- stub-check-for-updates
  ([] (resolved-promise #js {:hasUpdate false}))
  ([_force?] (resolved-promise #js {:hasUpdate false})))

(defn- stub-http-fetch-json
  "Mirror of electron's `httpFetchJSON` IPC. Goes through the now-patched
  `js/window.fetch`, so marketplace URLs still get redirected."
  [url]
  (-> (js/window.fetch url)
      (.then (fn [^js resp] (.json resp)))))

(defn- stub-relaunch [] (.. js/window -location reload))

(defn- stub-set-zoom-level [_level]
  ;; Browser zoom is keyboard/UA-controlled; CSS-zoom via `document.body.style.zoom`
  ;; is non-standard and fights user settings. Silent no-op.
  nil)

(defn- stub-set-updates-callback [_cb]
  ;; Hypha does not push update notifications. Silent no-op.
  nil)

(defn- stub-no-filesystem
  "Shared stub for methods that require a native filesystem we don't have."
  [method-name & _args]
  (js/console.warn (str "[hypha] window.apis." method-name
                        " is a no-op in Hypha web mode (no native filesystem).")))

(defn install-window-apis!
  "Install Hypha's `window.apis` shim — an EventEmitter3 with extra method
  properties for the platform calls Logseq plugin code reaches for.

  Runs only if `window.apis` is still unset; subsequent invocations are
  no-ops. This must execute BEFORE `frontend.handler.plugin/setup!` does
  its `(nil? js/window.apis)` check (~ line 152), otherwise the upstream
  bare-EventEmitter3 shim wins and the platform methods stay missing."
  []
  (when (nil? js/window.apis)
    (let [^js apis (js/window.EventEmitter3.)]
      ;; Platform navigation
      (set! (.-openExternal apis) stub-open-external)
      (set! (.-openPath apis) (fn [path] (stub-no-filesystem "openPath" path)))
      (set! (.-showItemInFolder apis)
            (fn [path] (stub-no-filesystem "showItemInFolder" path)))

      ;; App lifecycle
      (set! (.-relaunch apis) stub-relaunch)
      (set! (.-checkForUpdate apis) stub-check-for-updates)
      (set! (.-checkForUpdates apis) stub-check-for-updates)
      (set! (.-setUpdatesCallback apis) stub-set-updates-callback)

      ;; Window chrome
      (set! (.-setZoomLevel apis) stub-set-zoom-level)
      (set! (.-toggleMaxOrMinActiveWindow apis) noop)

      ;; Network — used by handler.plugin for marketplace fetches when the
      ;; HTTP-proxy toggle is enabled in settings.
      (set! (.-httpFetchJSON apis) stub-http-fetch-json)

      ;; File output — publish-export + plugin asset writes. No web equivalent.
      (set! (.-writeFileBytes apis)
            (fn [path _bytes] (stub-no-filesystem "writeFileBytes" path)))
      (set! (.-exportPublishAssets apis)
            (fn [& args] (apply stub-no-filesystem "exportPublishAssets" args)))

      (set! (.-apis js/window) apis))))

;; ---------------------------------------------------------------------------
;; Entry point + namespace-load-time wiring

(defn setup!
  "Idempotent: install both shims. Safe to call from a REPL during dev."
  []
  (install-fetch-redirect!)
  (install-window-apis!))

(defonce ^:private ^{:doc "Fires on namespace load. The `frontend.hypha.init`
  ns requires this ns, and `frontend.handler` in turn requires hypha.init,
  so the side effect lands before `frontend.handler/start!` is ever called —
  which is the ordering constraint that makes the upstream-zero approach
  work (see ns docstring)."}
  _on-load
  (when hypha-config/hypha-mode?
    (setup!)
    true))
