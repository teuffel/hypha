(ns frontend.db.dangling-parent-serialization-test
  (:require [cljs.test :refer [deftest is]]
            [datascript.core :as d]
            [frontend.worker.pipeline :as worker-pipeline]
            [logseq.common.util :as common-util]
            [logseq.db :as ldb]
            [logseq.db.common.initial-data :as common-initial-data]
            [logseq.db.test.helper :as db-test]))

(defn- transit-roundtrip [x]
  (ldb/read-transit-str (ldb/write-transit-str x)))

(deftest dangling-block-parent-does-not-crash-renderer-mirror-transact
  ;; Regression: a block whose :block/parent points at a since-deleted block is a
  ;; dangling ref. (:block/parent entity) materializes to nil, so the worker block
  ;; serialization used to emit `:block/parent nil`. The renderer mirror transacts
  ;; that map via raw `d/transact!`, which rejected the nil ("Cannot store nil as a
  ;; value") and white-paged the page. entity->map now strips nil-valued attrs.
  (let [conn (db-test/create-conn-with-blocks
              {:pages-and-blocks [{:page {:block/title "ProjPage"}
                                   :blocks [{:block/title "qb"}]}]})
        qb (db-test/find-block-by-content @conn "qb")]
    (ldb/register-transact-pipeline-fn! worker-pipeline/transact-pipeline)
    (try
      ;; tag with #Query so the pipeline creates a :logseq.property/query value block
      (ldb/transact! conn [[:db/add (:db/id qb) :block/tags :logseq.class/Query]])
      (let [qv-id (:db/id (:logseq.property/query (d/entity @conn (:db/id qb))))]
        (is (some? qv-id) "query value block created")
        ;; make the value block's :block/parent dangling (target eid does not exist)
        (ldb/transact! conn [[:db/retract qv-id :block/parent]
                             [:db/add qv-id :block/parent 999999]])
        (is (nil? (:block/parent (d/entity @conn qv-id)))
            "dangling :block/parent materializes to nil")
        ;; worker serialization (the owner nests the query value), then transit, like the real fetch
        (let [owner-ser (-> (common-initial-data/get-block-and-children @conn (:db/id qb) {:children? true})
                            transit-roundtrip)
              owner-block (:block owner-ser)
              query-value (:logseq.property/query owner-block)]
          (is (not (contains? query-value :block/parent))
              "serialized query value must not carry a nil :block/parent")
          ;; renderer mirror transact, exactly like frontend.db.async/<get-block
          (let [fresh (d/create-conn (d/schema @conn))
                tx (->> (cons owner-block (:children owner-ser))
                        common-util/fast-remove-nils
                        (remove empty?))]
            (is (some? (d/transact! fresh tx))
                "renderer mirror transact succeeds instead of crashing on nil :block/parent"))))
      (finally
        (ldb/register-transact-pipeline-fn! identity)))))
