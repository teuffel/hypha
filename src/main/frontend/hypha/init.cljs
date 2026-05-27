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

  See `docs/hypha/phase-1-plan.md` section 4.6 for the full auth flow."
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [<! go]]
            [frontend.config :as config]
            [frontend.flows :as flows]
            [frontend.handler.user :as user-handler]
            [frontend.state :as state]))

(defn set-hypha-id-token!
  "Phase-1 token setter: in-memory only.

  Unlike `frontend.handler.user/set-tokens!` we do not persist anything to
  localStorage. The HttpOnly session cookie is the only persistent auth
  material; the JWT lives in memory exclusively and is re-minted on every
  app boot via `/auth/session`."
  [id-token]
  (state/set-auth-id-token id-token)
  (some->> (user-handler/parse-jwt id-token)
           (reset! flows/*current-login-user)))

(defn- <fetch-session
  "GET /auth/session — returns the cljs-http response map."
  []
  (http/get "/auth/session" {:with-credentials? true}))

(defn start!
  "Hypha-mode app-boot entry point.

  Idempotent: callable multiple times. Returns nil (the side-effects are the
  point)."
  []
  (config/set-custom-sync-server-url! js/window.location.origin)
  (go
    (let [resp (<! (<fetch-session))]
      (cond
        (= 200 (:status resp))
        (when-let [id-token (get-in resp [:body :id-token])]
          (set-hypha-id-token! id-token))

        :else
        (state/pub-event! [:user/login]))))
  nil)
