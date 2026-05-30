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

(deftest-async refresh-hypha-id-token-resolves-nil-on-non-200
  (let [orig-token (state/get-auth-id-token)
        stub-fetch (fn [] (async-resp {:status 401
                                       :body {:error "unauthorized"}}))]
    (state/set-auth-id-token "pre-existing")
    (-> (hypha-auth/<refresh-hypha-id-token! stub-fetch)
        (p/then (fn [result]
                  (is (nil? result)
                      "401 → resolves nil; caller decides whether to surface login")
                  (is (= "pre-existing" (state/get-auth-id-token))
                      "401 must not clear the existing token")
                  (state/set-auth-id-token orig-token))))))

(deftest-async refresh-hypha-id-token-resolves-nil-when-body-missing-id-token
  (let [orig-token (state/get-auth-id-token)
        stub-fetch (fn [] (async-resp {:status 200
                                       :body {}}))]
    (state/set-auth-id-token nil)
    (-> (hypha-auth/<refresh-hypha-id-token! stub-fetch)
        (p/then (fn [result]
                  (is (nil? result)
                      "200 without id-token → treat as session-lost")
                  (is (nil? (state/get-auth-id-token)))
                  (state/set-auth-id-token orig-token))))))

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
