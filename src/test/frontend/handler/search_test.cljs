(ns frontend.handler.search-test
  (:require [cljs.test :refer [async deftest is testing]]
            [clojure.string :as string]
            [frontend.handler.search :as search-handler]
            [frontend.search :as search]
            [frontend.state :as state]
            [promesa.core :as p]))

(deftest search-resolves-string-page-filter-through-worker-test
  (async done
    (let [worker-call (atom nil)
          block-search-call (atom nil)
          state-update (atom nil)]
      (-> (p/with-redefs [state/<invoke-db-worker
                          (fn [& args]
                            (reset! worker-call args)
                            (p/resolved {:db/id 42}))
                          search/block-search
                          (fn [repo q opts]
                            (reset! block-search-call {:repo repo
                                                       :q q
                                                       :opts opts})
                            (p/resolved [{:block/uuid "block-1"}]))
                          search/file-search
                          (fn [_q]
                            (p/resolved ["file.md"]))
                          state/swap-state!
                          (fn [_f & args]
                            (reset! state-update args)
                            nil)]
            (search-handler/search "logseq_db_test" "needle" {:page-db-id "page-name"
                                                              :limit 5}))
          (.then (fn [result]
                   (is (= [:thread-api/pull "logseq_db_test" [:db/id] [:block/name "page-name"]]
                          @worker-call))
                   (is (= {:repo "logseq_db_test"
                           :q "needle"
                           :opts {:page-db-id "page-name"
                                  :limit 5
                                  :page "42"}}
                          @block-search-call))
                   (is (= [:search/result {:blocks [{:block/uuid "block-1"}]
                                            :has-more? false}]
                          @state-update))
                   (is (= {:blocks [{:block/uuid "block-1"}]
                           :has-more? false}
                          result))
                   (done)))
          (.catch (fn [error]
                    (is false (str error))
                    (done)))))))

(defn- marked-texts
  "Texts inside :mark elements of highlighted hiccup, whatever their attrs."
  [hiccup]
  (->> (tree-seq vector? seq hiccup)
       (filter #(and (vector? %)
                     (keyword? (first %))
                     (string/starts-with? (name (first %)) "mark")))
       (map last)))

(deftest highlight-matching-query
  (testing "no query matches"
    (is (= "mentions nothing"
           (search-handler/highlight-matching-query "mentions nothing" ["foo" "bar"]))))

  (testing "no queries"
    (is (= "mentions foo here"
           (search-handler/highlight-matching-query "mentions foo here" nil))))

  (testing "the page title is highlighted"
    (is (= ["foo"]
           (marked-texts (search-handler/highlight-matching-query "mentions foo here" ["foo" "bar"])))))

  (testing "an alias title is highlighted too"
    (is (= ["bar"]
           (marked-texts (search-handler/highlight-matching-query "mentions bar here" ["foo" "bar"]))))))
