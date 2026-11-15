(ns frontend.hypha.auth-test
  "HYPHA-PATCH-012: Hypha JWT refresh tests.

  Verifies that <refresh-hypha-id-token! correctly maps the cljs-http
  response shape to state writes plus return value, and that the refresh
  loop is idempotent."
  (:require [cljs.test :refer [is]]
            [cljs.core.async :as async]
            [frontend.hypha.auth :as hypha-auth]
            [frontend.state :as state]
            [frontend.test.helper :as test-helper :include-macros true
             :refer [deftest-async]]
            [promesa.core :as p]))

(defn- async-resp
  [resp]
  (let [ch (async/chan 1)]
    (async/put! ch resp)
    ch))

(deftest-async refresh-hypha-id-token-writes-state-on-200-with-id-token
  (let [orig-token (state/get-auth-id-token)
        stub-fetch (fn [] (async-resp {:status 200
                                       :body {:id-token "fresh-jwt"}}))]
    (state/set-auth-id-token nil)
    (-> (hypha-auth/<refresh-hypha-id-token! stub-fetch)
        (p/then (fn [result]
                  (is (= "fresh-jwt" result))
                  (is (= "fresh-jwt" (state/get-auth-id-token)))
                  (state/set-auth-id-token orig-token))))))

(deftest-async refresh-hypha-id-token-resolves-nil-on-session-loss
  (let [orig-token (state/get-auth-id-token)
        statuses (atom [401 403])
        stub-fetch (fn [] (async-resp {:status (first @statuses)
                                       :body {:error "no_session"}}))]
    (state/set-auth-id-token "pre-existing")
    (p/let [on-401 (hypha-auth/<refresh-hypha-id-token! stub-fetch)
            _ (swap! statuses rest)
            on-403 (hypha-auth/<refresh-hypha-id-token! stub-fetch)]
      (is (nil? on-401)
          "401 → resolves nil; caller decides whether to surface login")
      (is (nil? on-403))
      (is (= "pre-existing" (state/get-auth-id-token))
          "session loss must not clear the existing token")
      (state/set-auth-id-token orig-token))))

(defn- <refresh-outcome
  [resp]
  (-> (hypha-auth/<refresh-hypha-id-token! (fn [] (async-resp resp)))
      (p/then (fn [v] {:resolved v}))
      (p/catch (fn [e] {:rejected (ex-data e)}))))

(deftest-async refresh-hypha-id-token-rejects-when-session-state-is-unknown
  (let [orig-token (state/get-auth-id-token)]
    (state/set-auth-id-token "pre-existing")
    (p/let [offline (<refresh-outcome {:status 0 :error-text "net::ERR_INTERNET_DISCONNECTED"})
            server-error (<refresh-outcome {:status 502 :body "bad gateway"})
            missing-token (<refresh-outcome {:status 200 :body {}})]
      (is (= {:rejected {:code :hypha-refresh-failed :status 0}} offline)
          "offline is not a session loss")
      (is (= {:rejected {:code :hypha-refresh-failed :status 502}} server-error))
      (is (= {:rejected {:code :hypha-refresh-failed :status 200}} missing-token))
      (is (= "pre-existing" (state/get-auth-id-token)))
      (state/set-auth-id-token orig-token))))

(deftest-async start-refresh-loop-is-idempotent
  (let [intervals-set (atom 0)
        orig-set-interval js/setInterval
        orig-clear-interval js/clearInterval]
    (set! js/setInterval (fn [_f _ms]
                           (swap! intervals-set inc)
                           :stub-handle))
    (set! js/clearInterval (fn [_h] nil))
    (hypha-auth/stop-refresh-loop!)
    (hypha-auth/start-refresh-loop!)
    (hypha-auth/start-refresh-loop!)
    (hypha-auth/start-refresh-loop!)
    (is (= 1 @intervals-set)
        "atom-guarded handle prevents duplicate setInterval calls")
    (hypha-auth/stop-refresh-loop!)
    (set! js/setInterval orig-set-interval)
    (set! js/clearInterval orig-clear-interval)
    (p/resolved nil)))

(defn- jwt-for-sub
  [sub n]
  (str "h." (js/btoa (js/JSON.stringify #js {:sub sub :n n})) ".s"))

(deftest-async refresh-hypha-id-token-keeps-the-session-of-the-same-user
  (let [orig-token (state/get-auth-id-token)
        orig-graphs (state/get-state :rtc/graphs)
        first-token (jwt-for-sub "user-1" 1)
        graphs [{:graph-uuid "g1"}]]
    (state/set-auth-id-token nil)
    (-> (p/let [_ (hypha-auth/<refresh-hypha-id-token!
                   (fn [] (async-resp {:status 200 :body {:id-token first-token}})))
                _ (state/set-state! :rtc/graphs graphs)
                _ (hypha-auth/<refresh-hypha-id-token!
                   (fn [] (async-resp {:status 200 :body {:id-token (jwt-for-sub "user-1" 2)}})))]
          (is (= graphs (state/get-state :rtc/graphs))
              "a re-minted token of the same user is not a user switch"))
        (p/finally (fn []
                     (state/set-auth-id-token orig-token)
                     (state/set-state! :rtc/graphs orig-graphs))))))
