(ns frontend.hypha.init
  "Hypha runtime initialization, called from the app boot sequence.

  Called by Patch #2 in `frontend.handler` immediately after
  `restore-tokens-from-localstorage`, but only when
  `frontend.hypha.config/hypha-mode?` is true.

  `start!` is the public entry point. It

  1. Points the db-sync client at the same origin the app was served from
     (via `frontend.config/set-custom-sync-server-url!`).
  2. Calls GET `/auth/session` to exchange the HttpOnly Hypha session cookie
     for a fresh JWT; on success, the JWT is placed into
     `state/state[:auth/id-token]` and `flows/*current-login-user` so the rest
     of the app sees an authenticated user.
  3. On 401 it dispatches `[:user/login]`, which Patch #1 in
     `handler/events/ui.cljs` routes to the Hypha access-code login modal.

  Phase-1.6 (M9.1) addition: after a successful JWT set, fire a
  non-blocking <get-remote-graphs to populate :rtc/graphs. Stock-Logseq
  does this via the [:user/fetch-info-and-graphs] event dispatched from
  user-handler/login-callback; Hypha bypasses that event because (a)
  Patches #1+#2 are intentionally minimal and never publish it, and (b)
  the upstream handler's first step is <user-info against the hardcoded
  api.logseq.com/file-sync/user_info endpoint, which doesn't exist on
  hypha-server and would bail the whole pipeline before ever reaching
  <get-remote-graphs. Direct call from set-hypha-id-token! is the clean
  path: every successful Hypha auth triggers the listing, nothing else
  is needed.

  See `docs/hypha/phase-1-plan.md` section 4.6 for the auth flow and
  `docs/hypha/phase-1.6-cross-device.md` §4 M9 for the cross-device
  trigger rationale."
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [<! go]]
            [frontend.config :as config]
            [frontend.flows :as flows]
            [frontend.handler.db-based.sync :as rtc-handler]
            [frontend.handler.user :as user-handler]
            [frontend.hypha.asset-cache :as asset-cache]
            [frontend.hypha.auth :as hypha-auth]
            [frontend.hypha.capture :as capture]
            ;; Required for its side-effecting defonce: the plugin-init ns
            ;; patches `window.fetch` and installs the `window.apis` shim at
            ;; namespace-load time, which lands before frontend.handler/start!
            ;; runs and so before frontend.handler.plugin/setup! gets a chance
            ;; to install its own bare EventEmitter3.
            [frontend.hypha.plugin-init]
            [frontend.state :as state]
            [lambdaisland.glogi :as log]
            [promesa.core :as p]))

(defn- <wait-for-db-worker-ready!
  "Resolve once @state/*db-worker is truthy. Mirrors the pattern in
  `frontend.handler.db-based.sync/<wait-for-db-worker-ready!` (private)
  but kept in this Hypha namespace to avoid an upstream patch."
  []
  (if @state/*db-worker
    (p/resolved true)
    (let [ready (p/deferred)
          watch-key (keyword "frontend.hypha.init"
                             (str "wait-db-worker-" (random-uuid)))]
      (add-watch state/*db-worker watch-key
                 (fn [_ _ _ worker]
                   (when worker
                     (remove-watch state/*db-worker watch-key)
                     (p/resolve! ready true))))
      ;; Race: worker may have become ready between the initial check and
      ;; add-watch above. Re-check and resolve eagerly if so.
      (when @state/*db-worker
        (remove-watch state/*db-worker watch-key)
        (p/resolve! ready true))
      ready)))

(defn- <push-auth-to-db-worker!
  "Push :auth/id-token + :auth/access-token into the db-worker state.

  Stock Logseq's :rtc/sync-app-state event (`handler/events/rtc.cljs:88`)
  gates this push on :git/current-repo being non-nil — which only happens
  AFTER a graph has been loaded. Hypha's M9.1 auto-fetch fires
  IMMEDIATELY after login, before any graph exists. Without an explicit
  push here, the worker has no :auth/id-token; <ensure-user-rsa-keys-on-server!
  → worker → <resolve-user-uuid → <resolve-ws-token sees an empty token,
  falls into the refresh path, and throws 'worker auth refresh requires
  refresh token' (which Hypha never has).

  See docs/hypha/phase-1.6-cross-device.md V10-finding for the full trace."
  []
  (-> (<wait-for-db-worker-ready!)
      (p/then (fn [_]
                (state/<invoke-db-worker
                 :thread-api/sync-app-state
                 (select-keys @state/state
                              [:auth/id-token :auth/access-token]))))))

(defn- <fetch-remote-graphs-after-login!
  "Phase-1.6 M9.1 — non-blocking auto-fetch of the user's remote graphs.

  Fires after every successful Hypha auth (cookie-session restore or
  fresh access-code login). Failures log but do not surface to the user
  — the multi-graph picker's manual refresh button remains as a fallback.

  Pushes auth state to the db-worker FIRST (Phase-1.6 V10 fix) so that
  worker-side code reached by <get-remote-graphs (notably crypt/
  <resolve-user-uuid) sees a valid :auth/id-token. Without that push,
  the worker fails with 'worker auth refresh requires refresh token'
  because Hypha's auth model has no refresh-token."
  []
  (-> (p/do
        (<push-auth-to-db-worker!)
        (rtc-handler/<get-remote-graphs))
      (p/catch (fn [e]
                 (log/error :hypha/initial-graph-fetch-failed
                            {:error e})))))

(defn set-hypha-id-token!
  "Phase-1 token setter: in-memory only.

  Unlike `frontend.handler.user/set-tokens!` we do not persist anything to
  localStorage. The HttpOnly session cookie is the only persistent auth
  material; the JWT lives in memory exclusively and is re-minted on every
  app boot via `/auth/session`.

  Phase-1.6: fires <fetch-remote-graphs-after-login! as a side-effect so
  Browser B's freshly-authenticated session sees its remote graphs in the
  picker without further clicks."
  [id-token]
  (state/set-auth-id-token id-token)
  (some->> (user-handler/parse-jwt id-token)
           (reset! flows/*current-login-user))
  (<fetch-remote-graphs-after-login!))

(defn- <fetch-session
  "GET /auth/session — returns the cljs-http response map."
  []
  (http/get "/auth/session" {:with-credentials? true}))



(defn start!
  "Hypha-mode app-boot entry point.

  Idempotent: callable multiple times. Returns nil (the side-effects are the
  point).

  Phase 1.6.1: also kicks off the LRU asset-cache eviction background tick
  via `asset-cache/start!`. Runs independent of login state — the cache
  needs guarding even when the user is logged out.

  Quick capture: `capture/<start!` consumes any `hypha-*` share params on
  the boot URL and drains the clipper inbox. It is fired here rather than
  after login because it strips the params from the URL immediately and
  then waits for the graph on its own."
  []
  (config/set-custom-sync-server-url! js/window.location.origin)
  (asset-cache/start!)
  (hypha-auth/start-refresh-loop!)
  (capture/<start!)
  (go
    (let [resp (<! (<fetch-session))]
      (cond
        (= 200 (:status resp))
        (when-let [id-token (get-in resp [:body :id-token])]
          (set-hypha-id-token! id-token))

        :else
        (state/pub-event! [:user/login]))))
  nil)
