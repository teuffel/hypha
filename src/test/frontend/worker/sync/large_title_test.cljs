(ns frontend.worker.sync.large-title-test
  (:require [cljs.test :refer [deftest is testing]]
            [datascript.core :as d]
            [datascript.db :as ddb]
            [frontend.worker.sync.large-title :as sync-large-title]
            [logseq.db.frontend.schema :as db-schema]))

(def ^:private large-title-obj {:asset-uuid "asset-1" :asset-type "txt"})

(defn- db-with-unindexed-large-title
  "A graph that got its large-title-object datom before the attribute was
  marked :db/index true: the schema says indexed, :avet never saw the datom."
  []
  (let [conn (d/create-conn (dissoc db-schema/schema sync-large-title/large-title-object-attr))]
    (d/transact! conn [{:db/id 100
                        :block/uuid (random-uuid)
                        sync-large-title/large-title-object-attr large-title-obj}])
    (ddb/with-schema @conn db-schema/schema)))

(deftest large-title-lookups-find-datoms-that-predate-the-index-test
  (let [db (db-with-unindexed-large-title)]
    (testing "precondition: the value index does not know the datom"
      (is (empty? (d/datoms db :avet sync-large-title/large-title-object-attr))))
    (testing "resolving an object to its block"
      (is (= 100 (#'sync-large-title/find-large-title-object-eid db large-title-obj))))
    (testing "rehydrating every large title of a graph"
      (let [calls (atom [])]
        (sync-large-title/rehydrate-large-titles-from-db!
         "repo" "graph-1"
         {:get-conn-f (fn [_repo] (atom db))
          :rehydrate-large-titles!-f (fn [repo opts] (swap! calls conj [repo opts]))})
        (is (= [["repo" {:tx-data [[:db/add 100 sync-large-title/large-title-object-attr large-title-obj]]
                         :graph-id "graph-1"}]]
               @calls))))))
