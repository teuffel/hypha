(ns frontend.worker.sync.auth
  "Auth and endpoint helpers for db sync."
  (:require [clojure.string :as string]
            [frontend.worker-common.util :as worker-util]
            [frontend.worker.state :as worker-state]
            [frontend.worker.sync.util :as sync-util]
            [frontend.worker.ui-request :as ui-request]
            [logseq.common.util :as common-util]
            [promesa.core :as p]))

(defn ws-base-url
  [db-sync-config]
  (:ws-url db-sync-config))

(defn http-base-url
  [db-sync-config]
  (or (:http-base db-sync-config)
      (when-let [ws-url (ws-base-url db-sync-config)]
        (let [base (cond
                     (string/starts-with? ws-url "wss://")
                     (str "https://" (subs ws-url (count "wss://")))

                     (string/starts-with? ws-url "ws://")
                     (str "http://" (subs ws-url (count "ws://")))

                     :else ws-url)]
          (string/replace base #"/sync/%s$" "")))))

(defn id-token-expired?
  [token]
  (if-not (string? token)
    true
    (try
      (let [exp-ms (some-> token worker-util/parse-jwt :exp (* 1000))]
        (or (not (number? exp-ms))
            (<= exp-ms (common-util/time-ms))))
      (catch :default _
        true))))

(defn <refresh-id&access-token
  "HYPHA-PATCH-012: worker-side token refresh.

  Hypha always runs against a hypha-server, whose session lives in an
  HttpOnly cookie. The worker cannot call /auth/session itself (no
  document cookies in a Web Worker context). It asks the main thread via
  a ui-request; the main thread runs
  `frontend.hypha.auth/<refresh-hypha-id-token!` which reads the session
  cookie and returns a fresh JWT.

  Stock Logseq refreshed against the Cognito OAuth endpoint here. That
  branch was unreachable in Hypha (it was selected by a missing
  `:http-base`, which is always set) and is gone."
  []
  (p/let [resp (ui-request/<request :hypha-refresh-id-token nil
                                     {:hint "Hypha JWT refresh"})
          id-token (:id-token resp)]
    (when-not (seq id-token)
      (throw (ex-info "hypha worker auth refresh returned empty id-token"
                      {:code :hypha-refresh-empty-id-token})))
    {:id-token id-token
     :access-token nil}))

(defn <resolve-ws-token
  []
  (let [token (sync-util/auth-token)
        token-expired? (id-token-expired? token)]
    (if (and (not (sync-util/cli-node-owner?)) token-expired?)
      (p/let [{:keys [id-token access-token]} (<refresh-id&access-token)]
        (when-not (seq id-token)
          (throw (ex-info "worker auth refresh returned empty id-token"
                          {:code :auth-refresh-empty-id-token})))
        (worker-state/set-new-state!
         (cond-> {:auth/id-token id-token}
           (seq access-token) (assoc :auth/access-token access-token)))
        id-token)
      (p/resolved token))))

(defn get-user-uuid
  [id-token]
  (some-> id-token
          worker-util/parse-jwt
          :sub))

(defn auth-headers
  [token]
  (when-let [token* token]
    {"authorization" (str "Bearer " token*)}))

(defn with-auth-headers
  [auth-headers-f opts]
  (if-let [auth (auth-headers-f)]
    (assoc opts :headers (merge (or (:headers opts) {}) auth))
    opts))
