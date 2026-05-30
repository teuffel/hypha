(ns frontend.hypha.auth
  "Hypha JWT refresh — HYPHA-PATCH-012.

  Stock Logseq uses Cognito OAuth: a refresh-token plus /oauth2/token mints
  a fresh id-token whenever the current one nears expiry. Hypha has no
  refresh-token (Patch #3); the only persistent auth material is the
  HttpOnly session cookie. So Hypha re-mints the JWT by re-calling
  /auth/session, which validates the cookie server-side and returns a
  fresh id-token.

  This namespace is the single token-refresh entry point for Hypha-mode.
  Both the frontend (frontend.handler.user/<refresh-id-token&access-token)
  and the db-worker (via the :hypha-refresh-id-token ui-request) route
  through `<refresh-hypha-id-token!`. The periodic loop
  (`start-refresh-loop!`) re-mints proactively while the cookie is still
  valid, preventing the Phase-1.6.2 silent-RTC-stop user story.

  Layered below `frontend.handler.user` and `frontend.hypha.init` so both
  can require it without forming a cycle."
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [<! go]]
            [frontend.state :as state]
            [lambdaisland.glogi :as log]
            [promesa.core :as p]))

(defn- parse-jwt-exp-ms
  "Extract the exp claim (seconds) from a JWT payload and convert to ms.
  Returns nil on any parse failure or missing claim."
  [token]
  (when (string? token)
    (try
      (let [parts (.split token ".")
            payload-b64 (aget parts 1)]
        (when (string? payload-b64)
          (let [padded (str payload-b64
                            (case (mod (.-length payload-b64) 4)
                              2 "=="
                              3 "="
                              ""))
                json-str (js/atob (-> padded
                                      (.replace (js/RegExp. "-" "g") "+")
                                      (.replace (js/RegExp. "_" "g") "/")))
                payload (js->clj (js/JSON.parse json-str) :keywordize-keys true)
                exp (:exp payload)]
            (when (number? exp)
              (* exp 1000)))))
      (catch :default _
        nil))))

(defn ^:no-doc <fetch-session-default
  "Production /auth/session call. Wrapped so callers can pass a stub
  fetch-fn for testing without touching cljs-http's macro-expanded XHR
  path. Use `<refresh-hypha-id-token!` in production."
  []
  (http/get "/auth/session" {:with-credentials? true}))

(defn <refresh-hypha-id-token!
  "Re-mint the id-token via /auth/session. Returns a promesa promise that
  resolves to the fresh id-token string on success, or nil when the
  session is no longer valid (cookie expired/cleared). On nil the caller
  is responsible for surfacing the login UI; we do not pub-event here so
  background callers can decide quietly.

  Optional `fetch-fn` overrides the /auth/session call (tests only)."
  ([]
   (<refresh-hypha-id-token! <fetch-session-default))
  ([fetch-fn]
   (let [deferred (p/deferred)]
     (go
       (let [resp (<! (fetch-fn))]
         (cond
           (and (= 200 (:status resp))
                (some? (get-in resp [:body :id-token])))
           (let [id-token (get-in resp [:body :id-token])]
             (state/set-auth-id-token id-token)
             (p/resolve! deferred id-token))

           :else
           (do
             (log/info :hypha/refresh-failed {:status (:status resp)})
             (p/resolve! deferred nil)))))
     deferred)))

;; Tick the refresh check every 5 minutes; refresh when remaining TTL is
;; below REFRESH-MARGIN-MS (15 minutes). The margin gives downstream code
;; that snapshots the token (e.g. RTC WebSocket handshake) time to finish
;; before expiry.
(def ^:private refresh-tick-ms (* 5 60 1000))
(def ^:private refresh-margin-ms (* 15 60 1000))

(defonce ^:private *refresh-loop-handle (atom nil))

(defn- token-needs-refresh?
  "True when the in-state id-token expires within REFRESH-MARGIN-MS or
  when there is no id-token yet."
  []
  (let [token (state/get-auth-id-token)]
    (if-not (seq token)
      true
      (let [exp-ms (parse-jwt-exp-ms token)
            now-ms (.getTime (js/Date.))]
        (or (nil? exp-ms)
            (< (- exp-ms now-ms) refresh-margin-ms))))))

(defn start-refresh-loop!
  "Start the periodic JWT-refresh tick. Idempotent: subsequent calls
  while the loop already runs are no-ops."
  []
  (when (nil? @*refresh-loop-handle)
    (let [handle (js/setInterval
                  (fn []
                    (when (token-needs-refresh?)
                      (-> (<refresh-hypha-id-token!)
                          (p/catch (fn [e]
                                     (log/warn :hypha/refresh-loop-tick-failed
                                               {:error e}))))))
                  refresh-tick-ms)]
      (reset! *refresh-loop-handle handle))))

(defn stop-refresh-loop!
  "Stop the periodic JWT-refresh tick. Used for test cleanup and the
  logout flow; production code calls this rarely."
  []
  (when-let [handle @*refresh-loop-handle]
    (js/clearInterval handle)
    (reset! *refresh-loop-handle nil)))
