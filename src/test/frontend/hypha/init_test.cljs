(ns frontend.hypha.init-test
  (:require [cljs.test :refer [is]]
            [frontend.handler.db-based.rtc-flows :as rtc-flows]
            [frontend.handler.db-based.sync :as rtc-handler]
            [frontend.hypha.init :as hypha-init]
            [frontend.state :as state]
            [frontend.test.helper :as test-helper :include-macros true
             :refer [deftest-async]]
            [promesa.core :as p]))

(deftest-async login-starts-sync-once-the-remote-graphs-are-known
  ;; The login trigger fires before GET /graphs returns, so the current graph
  ;; is not in :rtc/graphs yet and the sync start is skipped. Nothing else
  ;; starts it afterwards: the graph fetch after login must trigger it.
  (let [repo "logseq_db_hypha-init-test"
        orig-repo (state/get-current-repo)
        orig-graphs (state/get-state :rtc/graphs)
        started (atom [])]
    (state/set-current-repo! repo)
    (-> (p/with-redefs [hypha-init/<push-auth-to-db-worker! (fn [] (p/resolved nil))
                        rtc-handler/<get-remote-graphs
                        (fn []
                          (state/set-state! :rtc/graphs [{:url repo}])
                          (p/resolved [{:url repo}]))
                        rtc-flows/trigger-rtc-start (fn [r] (swap! started conj r))]
          (#'hypha-init/<fetch-remote-graphs-after-login!))
        (p/then (fn [_]
                  (is (= [repo] @started))))
        (p/finally (fn []
                     (state/set-current-repo! orig-repo)
                     (state/set-state! :rtc/graphs orig-graphs))))))

(deftest-async login-does-not-start-sync-for-a-local-only-graph
  (let [repo "logseq_db_hypha-init-local"
        orig-repo (state/get-current-repo)
        orig-graphs (state/get-state :rtc/graphs)
        started (atom [])]
    (state/set-current-repo! repo)
    (-> (p/with-redefs [hypha-init/<push-auth-to-db-worker! (fn [] (p/resolved nil))
                        rtc-handler/<get-remote-graphs
                        (fn []
                          (state/set-state! :rtc/graphs [{:url "logseq_db_other"}])
                          (p/resolved [{:url "logseq_db_other"}]))
                        rtc-flows/trigger-rtc-start (fn [r] (swap! started conj r))]
          (#'hypha-init/<fetch-remote-graphs-after-login!))
        (p/then (fn [_]
                  (is (empty? @started))))
        (p/finally (fn []
                     (state/set-current-repo! orig-repo)
                     (state/set-state! :rtc/graphs orig-graphs))))))
