(ns frontend.worker.sync.assets-test
  (:require [cljs.test :refer [async deftest is testing]]
            [datascript.core :as d]
            [frontend.common.crypt :as crypt]
            [frontend.worker.platform :as platform]
            [frontend.worker.shared-service :as shared-service]
            [frontend.worker.state :as worker-state]
            [frontend.worker.sync.assets :as sync-assets]
            [frontend.worker.sync.client-op :as client-op]
            [logseq.db :as ldb]
            [logseq.db.frontend.schema :as db-schema]
            [promesa.core :as p]))

(defn- asset-conn
  [asset-uuid]
  (let [conn (d/create-conn db-schema/schema)]
    (ldb/transact! conn [{:block/uuid asset-uuid
                          :logseq.property.asset/type "png"
                          :logseq.property.asset/checksum "sha-256-value"
                          :logseq.property.asset/remote-metadata {:checksum "sha-256-value"
                                                                  :type "png"}}])
    conn))

(defn- execute-enqueued-asset-task!
  [task]
  (if (fn? task)
    (task)
    (p/resolved nil)))

(deftest request-asset-download-skips-existing-local-asset-test
  (async done
         (let [repo "asset-download-repo"
               graph-id "graph-1"
               asset-uuid (random-uuid)
               conn (asset-conn asset-uuid)
               download-calls (atom [])
               asset-stat-calls (atom [])
               enqueued-task (atom nil)
               broadcast-calls (atom [])]
           (-> (p/with-redefs [worker-state/get-datascript-conn (fn [_repo]
                                                                  conn)
                               platform/current (fn [] {})
                               platform/asset-stat (fn [_platform repo' file-name]
                                                     (swap! asset-stat-calls conj [repo' file-name])
                                                     (p/resolved {:size 10}))
                               sync-assets/download-remote-asset! (fn [& args]
                                                                    (swap! download-calls conj args)
                                                                    (p/resolved nil))]
                 (sync-assets/request-asset-download!
                  repo
                  asset-uuid
                  {:current-client-f (fn [_repo]
                                       {:graph-id graph-id})
                   :enqueue-asset-task-f (fn [_client task]
                                           (reset! enqueued-task task)
                                           (execute-enqueued-asset-task! task))
                   :broadcast-rtc-state!-f (fn [& args]
                                             (swap! broadcast-calls conj args))}))
               (p/then (fn [_]
                         (is (= [[repo (str asset-uuid ".png")]] @asset-stat-calls))
                         (is (fn? @enqueued-task))
                         (is (= [] @download-calls))
                         (is (= [] @broadcast-calls))))
               (p/catch (fn [error]
                          (is false (str "unexpected error: " error))))
               (p/finally done)))))

(deftest request-asset-download-downloads-missing-local-asset-test
  (async done
         (let [repo "asset-download-repo"
               graph-id "graph-1"
               asset-uuid (random-uuid)
               conn (asset-conn asset-uuid)
               download-calls (atom [])
               asset-stat-calls (atom [])
               broadcast-calls (atom [])]
           (-> (p/with-redefs [worker-state/get-datascript-conn (fn [_repo]
                                                                  conn)
                               platform/current (fn [] {})
                               platform/asset-stat (fn [_platform repo' file-name]
                                                     (swap! asset-stat-calls conj [repo' file-name])
                                                     (p/resolved nil))
                               sync-assets/download-remote-asset! (fn [& args]
                                                                    (swap! download-calls conj args)
                                                                    (p/resolved nil))]
                 (sync-assets/request-asset-download!
                  repo
                  asset-uuid
                  {:current-client-f (fn [_repo]
                                       {:graph-id graph-id})
                   :enqueue-asset-task-f (fn [_client task]
                                           (execute-enqueued-asset-task! task))
                   :broadcast-rtc-state!-f (fn [& args]
                                             (swap! broadcast-calls conj args))}))
               (p/then (fn [_]
                         (is (= [[repo (str asset-uuid ".png")]] @asset-stat-calls))
                         (is (= [[repo graph-id asset-uuid "png"]] @download-calls))
                         (is (= 1 (count @broadcast-calls)))))
               (p/catch (fn [error]
                          (is false (str "unexpected error: " error))))
               (p/finally done)))))

(deftest request-asset-download-propagates-and-logs-download-failure-test
  (async done
         (let [repo "asset-download-repo"
               graph-id "graph-1"
               asset-uuid (random-uuid)
               conn (asset-conn asset-uuid)
               download-error (ex-info "download failed" {:type :rtc.exception/download-asset-failed})
               log-calls (atom [])]
           (-> (p/with-redefs [worker-state/get-datascript-conn (fn [_repo]
                                                                  conn)
                               platform/current (fn [] {})
                               platform/asset-stat (fn [_platform _repo _file-name]
                                                     (p/resolved nil))
                               sync-assets/download-remote-asset! (fn [& _args]
                                                                    (p/rejected download-error))
                               sync-assets/log-request-asset-download-failed!
                               (fn [repo' asset-uuid' error']
                                 (swap! log-calls conj [repo' asset-uuid' error']))]
                 (sync-assets/request-asset-download!
                  repo
                  asset-uuid
                  {:current-client-f (fn [_repo]
                                       {:graph-id graph-id})
                   :enqueue-asset-task-f (fn [_client task]
                                           (execute-enqueued-asset-task! task))
                   :broadcast-rtc-state!-f (fn [& _args] nil)}))
               (p/then (fn [_]
                         (is false "expected download failure to reject")))
               (p/catch (fn [error]
                          (is (= download-error error))
                          (is (= [[repo asset-uuid download-error]] @log-calls))))
               (p/finally done)))))

(deftest upload-remote-asset-serializes-resolved-encrypted-payload-test
  (async done
         (let [repo "asset-upload-repo"
               graph-id "graph-1"
               asset-uuid (random-uuid)
               checksum "sha-256-value"
               asset-bytes (js/Uint8Array. #js [1 2 3])
               encrypted-payload {:cipher "encrypted-payload"}
               expected-body (ldb/write-transit-str encrypted-payload)
               fetch-call* (atom nil)
               encrypt-input* (atom nil)
               original-fetch js/fetch
               db-sync-config @worker-state/*db-sync-config]
           (reset! worker-state/*db-sync-config
                   {:http-base "https://sync.example.test"})
           (set! js/fetch
                 (fn [url opts]
                   (reset! fetch-call*
                           {:url url
                            :body (.-body opts)})
                   (p/resolved #js {:ok true
                                     :status 200})))
           (-> (p/with-redefs [sync-assets/graph-aes-key
                               (fn [_repo _graph-id _fail-fast-f]
                                 (p/resolved "aes-key"))
                               platform/current
                               (fn [] {})
                               platform/asset-read-bytes!
                               (fn [_platform _repo _file-name]
                                 (p/resolved asset-bytes))
                               crypt/<encrypt-uint8array
                               (fn [_aes-key payload]
                                 (reset! encrypt-input* payload)
                                 (p/resolved encrypted-payload))
                               shared-service/broadcast-to-clients!
                               (fn [& _] nil)]
                 (sync-assets/upload-remote-asset!
                  repo graph-id asset-uuid "png" checksum))
               (p/then
                (fn [_]
                  (is (instance? js/Uint8Array @encrypt-input*))
                  (is (= expected-body (:body @fetch-call*)))))
               (p/catch
                (fn [error]
                  (is false (str "unexpected error: " error))))
               (p/finally
                 (fn []
                   (set! js/fetch original-fetch)
                   (reset! worker-state/*db-sync-config db-sync-config)
                   (done)))))))

(defn- graph-conn
  "Conn with one asset per `assets` entry ({:uuid :uploaded?}) and the
  given `graph-remote?` kv."
  [graph-remote? assets]
  (let [conn (d/create-conn db-schema/schema)]
    (ldb/transact! conn (cond-> (mapv (fn [{:keys [uuid uploaded?]}]
                                        (cond-> {:block/uuid uuid
                                                 :logseq.property.asset/type "png"
                                                 :logseq.property.asset/checksum "sha-256-value"}
                                          uploaded?
                                          (assoc :logseq.property.asset/remote-metadata
                                                 {:checksum "sha-256-value" :type "png"})))
                                      assets)
                          graph-remote?
                          (conj (ldb/kv :logseq.kv/graph-remote? true))))
    conn))

(deftest evictable-asset-files-only-lists-assets-the-server-holds-test
  (let [uploaded (random-uuid)
        pending (random-uuid)
        never-uploaded (random-uuid)
        local-graph-asset (random-uuid)
        conns {"logseq_db_synced" (graph-conn true [{:uuid uploaded :uploaded? true}
                                                    {:uuid pending :uploaded? true}
                                                    {:uuid never-uploaded :uploaded? false}])
               "logseq_db_local" (graph-conn false [{:uuid local-graph-asset :uploaded? true}])}
        prev-conns @worker-state/*datascript-conns
        prev-client @worker-state/*db-sync-client]
    (reset! worker-state/*datascript-conns conns)
    (try
      (with-redefs [client-op/get-all-asset-ops (fn [repo]
                                                  (when (= "logseq_db_synced" repo)
                                                    [{:block/uuid pending
                                                      :update-asset [:update-asset 1 {:block-uuid pending}]}]))]
        (reset! worker-state/*db-sync-client {:repo "logseq_db_synced" :ws-state (atom :open)})
        (is (= [{:repo "logseq_db_synced"
                 :file-name (str uploaded ".png")}]
               (sync-assets/evictable-asset-files)))
        (testing "remote flags alone are not enough: they survive deleting the remote graph"
          (reset! worker-state/*db-sync-client {:repo "logseq_db_synced" :ws-state (atom :closed)})
          (is (= [] (sync-assets/evictable-asset-files)))
          (reset! worker-state/*db-sync-client nil)
          (is (= [] (sync-assets/evictable-asset-files)))))
      (finally
        (reset! worker-state/*datascript-conns prev-conns)
        (reset! worker-state/*db-sync-client prev-client)))))
