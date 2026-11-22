(ns frontend.hypha.plugin-init
  "Hypha plugin-system bootstrap. Runs at namespace-load time (before
  `frontend.handler/start!` is invoked) so that the Logseq plugin subsystem
  picks up Hypha's shims and proxy redirects on its first marketplace fetch.

  Three side effects:

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

  3. `install-plugin-asset-rewrite!` (Phase 1.6.2) wraps
     `window.LSPlugin.PluginLocal.prototype._resolveResourceFullUrl` so
     web-plugin iframe entry URLs go through hypha-server's
     `/plugin-cdn/assets/*` proxy instead of the R2 bucket directly. Under
     hypha-server's required COEP=credentialless, the R2 bucket's missing
     CORP/CORS headers block every plugin iframe load, causing recurring
     `handshake Timeout` errors every 8 s.

     That proxy lives on a SEPARATE origin (own port or hostname) from the
     app, so plugin code stays cross-origin exactly as in upstream Logseq
     and cannot read the Hypha session. See `plugin-origin` below.

  See `docs/hypha/phase-1.5-plugin-marketplace.md` §§ 2.2 + 2.3 for steps
  1+2, and `docs/hypha/phase-1.6.2-plugin-iframe-corp.md` for step 3."
  (:require [clojure.string :as string]
            [frontend.hypha.config :as hypha-config]
            ;; Required for its side effect: installs the console log
            ;; handler, which must exist before `_on-load` below logs.
            [frontend.log]
            [lambdaisland.glogi :as log]))

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
  (log/warn :hypha/window-apis-no-op
            {:method method-name
             :reason "no native filesystem in Hypha web mode"}))

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
;; (3) Plugin-iframe entry URL rewrite (Phase 1.6.2)

(def ^:private plugin-assets-prefix
  "https://pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev/")

(defn- meta-content
  "Content of `<meta name=...>` in the document head, or nil when absent/blank."
  [meta-name]
  (let [v (some-> (.querySelector js/document (str "meta[name=\"" meta-name "\"]"))
                  (.getAttribute "content"))]
    (when-not (string/blank? v) v)))

(defn- plugin-origin
  "Origin of hypha-server's plugin-assets listener, or nil when it is unknown
  or unsafe.

  hypha-server injects one of two meta tags into index.html (statics.ts):

      <meta name=\"hypha-plugin-origin\" content=\"https://plugins.example.com\">
      <meta name=\"hypha-plugin-port\"   content=\"3010\">

  The port form is combined with the protocol + hostname the app itself was
  loaded from, so localhost/LAN setups need no configuration.

  SECURITY: plugin iframes run third-party code. They MUST NOT share the
  app's origin, or that code can read `/auth/session` (cookie → JWT) and the
  app window directly. A candidate equal to `window.location.origin` is
  therefore rejected — the plugin then fails to load instead of loading
  unsandboxed."
  []
  (let [^js loc (.-location js/window)
        candidate (or (meta-content "hypha-plugin-origin")
                      (when-let [port (meta-content "hypha-plugin-port")]
                        (str (.-protocol loc) "//" (.-hostname loc) ":" port)))
        origin (when candidate
                 (try (.-origin (js/URL. candidate))
                      (catch :default _ nil)))]
    (when (and (string? origin)
               (not= origin "null")
               (not= origin (.-origin loc)))
      origin)))

(defonce ^:private *warned-no-plugin-origin? (atom false))

(defn- rewrite-plugin-asset-url
  "Rewrite a web-plugin iframe entry URL from the upstream R2 bucket to
  hypha-server's plugin-assets origin (a SEPARATE origin from the app — see
  `plugin-origin`). Non-R2 URLs pass through unchanged.

  The result is an absolute URL: `LSPlugin.caller.ts` feeds the value
  straight into `new URL(pl.options.entry!)`, and Postmate derives the
  iframe's expected postMessage origin from it.

  When no usable plugin origin is known the R2 URL is returned unchanged.
  COEP then blocks the iframe (handshake timeout) — a visible failure, and
  the safe one: never fall back to the app's own origin."
  [url]
  (if (and (string? url) (string/starts-with? url plugin-assets-prefix))
    (if-let [origin (plugin-origin)]
      (str origin "/plugin-cdn/assets/" (subs url (count plugin-assets-prefix)))
      (do
        (when (compare-and-set! *warned-no-plugin-origin? false true)
          (js/console.warn
           (str "[hypha] no separate plugin-assets origin configured "
                "(hypha-plugin-origin / hypha-plugin-port meta tag missing or "
                "equal to the app origin); web plugins will not load. "
                "See docs/hypha/operations.md → Plugin origin.")))
        url))
    url))

(defn install-plugin-asset-rewrite!
  "Wrap `window.LSPlugin.PluginLocal.prototype._resolveResourceFullUrl` so
  web-plugin iframe URLs flow through `/plugin-cdn/assets/*` on
  hypha-server's separate plugin-assets origin (which injects
  `cross-origin-resource-policy: cross-origin`) instead of going directly
  to `pub-80f42b85b62c40219354a834fcf2bbfa.r2.dev` (which sends neither
  CORP nor CORS headers and so gets blocked by COEP=credentialless).

  Idempotent via the `__hyphaWrapped` flag on the wrapper.

  Ordering: `lsplugin.core.js` is loaded with `defer` before `main.js`
  in `resources/index.html`, so `window.LSPlugin.PluginLocal` is populated
  by the time this cljs namespace's `_on-load` fires. If the global is
  somehow missing (publishing build, stripped bundle, future upstream
  rename) we log a single warning and skip — the original blocking
  behavior at least remains observable rather than silently no-opping."
  []
  (let [^js proto (some-> js/window .-LSPlugin .-PluginLocal .-prototype)]
    (if proto
      (let [^js orig (.-_resolveResourceFullUrl proto)]
        (when (and orig (not (.-__hyphaWrapped orig)))
          (let [wrapped (fn [file-path local-root]
                          (this-as this
                            (rewrite-plugin-asset-url
                             (.call orig this file-path local-root))))]
            (set! (.-__hyphaWrapped wrapped) true)
            (set! (.-_resolveResourceFullUrl proto) wrapped))))
      (log/warn :hypha/plugin-asset-rewrite-skipped
                {:reason "window.LSPlugin.PluginLocal not available at plugin-init time"}))))

;; ---------------------------------------------------------------------------
;; Entry point + namespace-load-time wiring

(defn setup!
  "Idempotent: install all three shims. Safe to call from a REPL during dev.

  Runs at namespace-load time, where an escaping exception would abort
  loading the app. A shim that fails to install costs the plugin system,
  not the boot, so the failure is logged instead."
  []
  (try
    (install-fetch-redirect!)
    (install-window-apis!)
    (install-plugin-asset-rewrite!)
    (catch :default e
      (log/error :hypha/plugin-init-failed {:error e}))))

(defonce ^:private ^{:doc "Fires on namespace load. The `frontend.hypha.init`
  ns requires this ns, and `frontend.handler` in turn requires hypha.init,
  so the side effect lands before `frontend.handler/start!` is ever called —
  which is the ordering constraint that makes the upstream-zero approach
  work (see ns docstring)."}
  _on-load
  (when hypha-config/hypha-mode?
    (setup!)
    true))
