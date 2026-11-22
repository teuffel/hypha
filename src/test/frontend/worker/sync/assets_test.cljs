(ns frontend.worker.sync.assets-test
  (:require [cljs.test :refer [async deftest is testing]]
            [datascript.core :as d]
            [frontend.common.crypt :as crypt]
            [frontend.worker.platform :as platform]
            [frontend.worker.shared-service :as shared-service]
            [frontend.worker.state :as worker-state]
            [frontend.worker.sync :as db-sync]
            [frontend.worker.sync.assets :as sync-assets]
            [frontend.worker.sync.client-op :as client-op]
            [frontend.worker.sync.presence :as sync-presence]
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

(deftest request-asset-download-failure-does-not-block-later-downloads-test
  (async done
         (let [repo "asset-download-repo"
               graph-id "graph-1"
               missing-uuid (random-uuid)
               ok-uuid (random-uuid)
               conn (asset-conn missing-uuid)
               _ (ldb/transact! conn [{:block/uuid ok-uuid
                                       :logseq.property.asset/type "png"
                                       :logseq.property.asset/remote-metadata {:type "png"}}])
               client {:repo repo
                       :graph-id graph-id
                       :asset-queue (atom (p/resolved nil))}
               download-calls (atom [])]
           (-> (p/with-redefs [worker-state/*db-sync-client (atom client)
                               worker-state/get-datascript-conn (fn [_repo] conn)
                               platform/current (fn [] {})
                               platform/asset-stat (fn [& _args] (p/resolved nil))
                               client-op/remove-asset-op (fn [& _args] nil)
                               shared-service/broadcast-to-clients! (fn [& _args] nil)
                               sync-presence/rtc-state-payload (fn [& _args] {})
                               sync-assets/log-request-asset-download-failed! (fn [& _args] nil)
                               sync-assets/download-remote-asset!
                               (fn [_repo _graph-id asset-uuid _asset-type]
                                 (swap! download-calls conj asset-uuid)
                                 (if (= missing-uuid asset-uuid)
                                   (p/rejected (ex-info "download asset failed"
                                                        {:type :rtc.exception/download-asset-failed
                                                         :data {:status 404}}))
                                   (p/resolved nil)))]
                 (p/let [first-result (-> (db-sync/request-asset-download! repo missing-uuid)
                                          (p/then (fn [_] {:error nil}))
                                          (p/catch (fn [e] {:error e})))
                         _ (-> (db-sync/request-asset-download! repo ok-uuid)
                               (p/catch (fn [_] nil)))]
                   (is (= 404 (-> first-result :error ex-data :data :status))
                       "the failing download must still reject for its own caller")
                   (is (= [missing-uuid ok-uuid] @download-calls)
                       "a 404 on one asset must not stop later queued downloads")))
               (p/catch (fn [error]
                          (is false (str "unexpected error: " error))))
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
(deftest upload-remote-asset-records-missing-local-file-test
  (async done
         (let [repo "asset-upload-repo"
               graph-id "graph-1"
               asset-uuid (random-uuid)
               checksum "sha-256-value"
               missing-file (str "assets/" asset-uuid ".pdf")
               read-error (js/Error. "ENOENT: no such file or directory")
               original-fetch js/fetch
               db-sync-config @worker-state/*db-sync-config
               fetch-called? (atom false)
               broadcasts (atom [])]
           (reset! worker-state/*db-sync-config
                   {:http-base "https://sync.example.test"})
           (set! js/fetch
                 (fn [& _args]
                   (reset! fetch-called? true)
                   (p/resolved #js {:ok true
                                     :status 200})))
           (-> (p/with-redefs [sync-assets/graph-aes-key
                               (fn [_repo _graph-id _fail-fast-f]
                                 (p/resolved nil))
                               platform/current
                               (fn [] {})
                               platform/asset-read-bytes!
                               (fn [_platform _repo _file-name]
                                 (p/rejected read-error))
                               shared-service/broadcast-to-clients!
                               (fn [event payload]
                                 (swap! broadcasts conj [event payload]))]
                 (sync-assets/clear-missing-asset-upload-files! repo)
                 (sync-assets/upload-remote-asset!
                  repo graph-id asset-uuid "pdf" checksum))
               (p/then
                (fn [_]
                  (is false "expected missing local file to reject")))
               (p/catch
                (fn [error]
                  (is (= :rtc.exception/read-asset-failed (:type (ex-data error))))
                  (is (false? @fetch-called?))
                  (is (= [] @broadcasts))
                  (is (= [{:asset-id (str asset-uuid)
                           :asset-type "pdf"
                           :file missing-file}]
                         (sync-assets/get-missing-asset-upload-files repo)))))
               (p/finally
                 (fn []
                   (set! js/fetch original-fetch)
                   (reset! worker-state/*db-sync-config db-sync-config)
                   (sync-assets/clear-missing-asset-upload-files! repo)
                   (done)))))))

(deftest download-missing-remote-assets-downloads-only-missing-sync-assets-test
  (async done
         (let [repo "asset-prefetch-repo"
               graph-id "graph-1"
               missing-uuid (random-uuid)
               existing-uuid (random-uuid)
               local-uuid (random-uuid)
               external-uuid (random-uuid)
               conn (d/create-conn db-schema/schema)
               stat-calls (atom [])
               download-calls (atom [])]
           (ldb/transact!
            conn
            [{:db/ident :logseq.class/Asset}
             {:block/uuid missing-uuid
              :block/tags #{:logseq.class/Asset}
              :logseq.property.asset/type "png"
              :logseq.property.asset/checksum "missing-checksum"
              :logseq.property.asset/remote-metadata {:checksum "missing-checksum"
                                                      :type "png"}}
             {:block/uuid existing-uuid
              :block/tags #{:logseq.class/Asset}
              :logseq.property.asset/type "pdf"
              :logseq.property.asset/checksum "existing-checksum"
              :logseq.property.asset/remote-metadata {:checksum "existing-checksum"
                                                      :type "pdf"}}
             {:block/uuid local-uuid
              :block/tags #{:logseq.class/Asset}
              :logseq.property.asset/type "jpg"
              :logseq.property.asset/checksum "local-checksum"}
             {:block/uuid external-uuid
              :block/tags #{:logseq.class/Asset}
              :logseq.property.asset/type "gif"
              :logseq.property.asset/checksum "external-checksum"
              :logseq.property.asset/remote-metadata {:checksum "external-checksum"
                                                      :type "gif"}
              :logseq.property.asset/external-url "https://example.com/asset.gif"}])
           (-> (p/with-redefs [worker-state/get-datascript-conn (fn [_repo]
                                                                  conn)
                               platform/current (fn [] {})
                               platform/asset-stat
                               (fn [_platform repo' file-name]
                                 (swap! stat-calls conj [repo' file-name])
                                 (p/resolved (when (= file-name (str existing-uuid ".pdf"))
                                               {:size 10})))
                               sync-assets/download-remote-asset!
                               (fn [& args]
                                 (swap! download-calls conj args)
                                 (p/resolved nil))]
                 (sync-assets/download-missing-remote-assets! repo graph-id))
               (p/then (fn [result]
                         (is (= {:total 2
                                 :downloaded 1
                                 :skipped-existing 1
                                 :failed 0}
                                result))
                         (is (= #{[repo (str existing-uuid ".pdf")]
                                  [repo (str missing-uuid ".png")]}
                                (set @stat-calls)))
                         (is (= [[repo graph-id missing-uuid "png"]]
                                @download-calls))))
               (p/catch (fn [error]
                          (is false (str "unexpected error: " error))))
               (p/finally done)))))

(deftest download-remote-assets-if-missing-continues-past-failures-test
  (async done
         (let [repo "asset-prefetch-repo"
               graph-id "graph-1"
               failed-uuid (random-uuid)
               ok-uuid (random-uuid)
               candidates [{:asset-uuid failed-uuid
                            :asset-type "png"}
                           {:asset-uuid ok-uuid
                            :asset-type "png"}]
               download-calls (atom [])
               log-calls (atom [])]
           (-> (p/with-redefs [platform/current (fn [] {})
                               platform/asset-stat
                               (fn [& _args]
                                 (p/resolved nil))
                               sync-assets/log-request-asset-download-failed!
                               (fn [repo' asset-uuid' error']
                                 (swap! log-calls conj [repo' asset-uuid' error']))
                               sync-assets/download-remote-asset!
                               (fn [_repo _graph-id asset-uuid _asset-type]
                                 (swap! download-calls conj asset-uuid)
                                 (if (= failed-uuid asset-uuid)
                                   (p/rejected (ex-info "download asset failed"
                                                        {:type :rtc.exception/download-asset-failed
                                                         :data {:status 404}}))
                                   (p/resolved nil)))]
                 (sync-assets/download-remote-assets-if-missing!
                  repo graph-id candidates))
               (p/then (fn [result]
                         (is (= #{failed-uuid ok-uuid} (set @download-calls))
                             "a failed download must not stop the remaining assets")
                         (is (= {:total 2
                                 :downloaded 1
                                 :skipped-existing 0
                                 :failed 1}
                                result))
                         (is (= 1 (count @log-calls)))
                         (is (= repo (first (first @log-calls))))
                         (is (= failed-uuid (second (first @log-calls))))))
               (p/catch (fn [error]
                          (is false (str "unexpected error: " error))))
               (p/finally done)))))

(deftest download-remote-assets-if-missing-bounds-download-concurrency-test
  (async done
         (let [repo "asset-prefetch-repo"
               graph-id "graph-1"
               candidates (mapv (fn [_]
                                   {:asset-uuid (random-uuid)
                                    :asset-type "png"})
                                 (range 12))
               active-downloads (atom 0)
               max-active-downloads (atom 0)
               download-calls (atom [])]
           (-> (p/with-redefs [platform/current (fn [] {})
                               platform/asset-stat
                               (fn [_platform _repo _file-name]
                                 (p/resolved nil))
                               sync-assets/download-remote-asset!
                               (fn [repo' graph-id' asset-uuid asset-type]
                                 (swap! download-calls conj [repo' graph-id' asset-uuid asset-type])
                                 (let [active (swap! active-downloads inc)]
                                   (swap! max-active-downloads max active))
                                 (p/let [_ (p/delay 20)]
                                   (swap! active-downloads dec)
                                   nil))]
                 (sync-assets/download-remote-assets-if-missing!
                  repo graph-id candidates))
               (p/then (fn [result]
                         (is (= {:total 12
                                 :downloaded 12
                                 :skipped-existing 0
                                 :failed 0}
                                result))
                         (is (= 12 (count @download-calls)))
                         (is (= 10 @max-active-downloads))))
               (p/catch (fn [error]
                          (is false (str "unexpected error: " error))))
               (p/finally done)))))

(defn- fake-xhr-ctor
  "XMLHttpRequest stand-in whose `send` runs `behavior` on the instance."
  [behavior]
  (fn []
    (this-as ^js xhr
      (set! (.-upload xhr) #js {})
      (set! (.-open xhr) (fn [& _] nil))
      (set! (.-setRequestHeader xhr) (fn [& _] nil))
      (set! (.-send xhr) (fn [_payload] (behavior xhr)))
      xhr)))

(defn- xhr-progress!
  [^js xhr loaded total]
  ((.. xhr -upload -onprogress) #js {:lengthComputable true :loaded loaded :total total}))

(defn- <upload-with-fake-xhr
  [behavior broadcasts]
  (let [db-sync-config @worker-state/*db-sync-config]
    (reset! worker-state/*db-sync-config {:http-base "https://sync.example.test"})
    (aset js/globalThis "XMLHttpRequest" (fake-xhr-ctor behavior))
    (-> (p/with-redefs [sync-assets/graph-aes-key (fn [_repo _graph-id _fail-fast-f]
                                                    (p/resolved nil))
                        platform/current (fn [] {})
                        platform/asset-read-bytes! (fn [_platform _repo _file-name]
                                                     (p/resolved (js/Uint8Array. 100)))
                        shared-service/broadcast-to-clients!
                        (fn [event payload]
                          (when (= :rtc-asset-upload-download-progress event)
                            (swap! broadcasts conj (select-keys (:progress payload) [:loaded :total]))))]
          (sync-assets/upload-remote-asset! "xhr-repo" "graph-1" (random-uuid) "png" "sha-256-value"))
        (p/finally
          (fn []
            (js-delete js/globalThis "XMLHttpRequest")
            (reset! worker-state/*db-sync-config db-sync-config))))))

(deftest upload-remote-asset-reports-xhr-progress-test
  (async done
         (let [broadcasts (atom [])]
           (-> (<upload-with-fake-xhr
                (fn [^js xhr]
                  (xhr-progress! xhr 25 100)
                  (xhr-progress! xhr 25 100)
                  (xhr-progress! xhr 50 100)
                  (xhr-progress! xhr 100 100)
                  (set! (.-status xhr) 200)
                  ((.-onload xhr)))
                broadcasts)
               (p/then
                (fn [_]
                  (is (= [{:loaded 0 :total 100}
                          {:loaded 25 :total 100}
                          {:loaded 50 :total 100}
                          {:loaded 100 :total 100}
                          {:loaded 100 :total 100}]
                         @broadcasts)
                      "progress climbs once per whole percent, then completes")))
               (p/catch (fn [error] (is false (str "unexpected error: " error))))
               (p/finally done)))))

(deftest upload-remote-asset-closes-progress-on-network-error-test
  (async done
         (let [broadcasts (atom [])]
           (-> (<upload-with-fake-xhr
                (fn [^js xhr]
                  (xhr-progress! xhr 50 100)
                  ((.-onerror xhr)))
                broadcasts)
               (p/then (fn [_] (is false "expected the upload to reject")))
               (p/catch
                (fn [error]
                  (is (= :rtc.exception/upload-asset-failed (:type (ex-data error))))
                  (is (= {:loaded 100 :total 100} (last @broadcasts))
                      "a failed upload must not leave the bar at its last percent")))
               (p/finally done)))))

(deftest upload-remote-asset-rejects-on-xhr-error-status-test
  (async done
         (let [broadcasts (atom [])]
           (-> (<upload-with-fake-xhr
                (fn [^js xhr]
                  (set! (.-status xhr) 401)
                  ((.-onload xhr)))
                broadcasts)
               (p/then (fn [_] (is false "expected the upload to reject")))
               (p/catch
                (fn [error]
                  (is (= :rtc.exception/upload-asset-failed (:type (ex-data error))))
                  (is (= {:status 401} (:data (ex-data error))))
                  (is (= {:loaded 100 :total 100} (last @broadcasts)))))
               (p/finally done)))))
