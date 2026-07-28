(ns frontend.handler.search-test
  (:require [cljs.test :refer [deftest is testing]]
            [frontend.handler.search :as search-handler]))

(deftest highlight-matching-query
  (testing "no query matches"
    (is (= "mentions nothing"
           (search-handler/highlight-matching-query "mentions nothing" ["foo" "bar"]))))

  (testing "no queries"
    (is (= "mentions foo here"
           (search-handler/highlight-matching-query "mentions foo here" nil))))

  (testing "the page title is highlighted"
    (is (some #(= [:mark.p-0.rounded-none "foo"] %)
              (search-handler/highlight-matching-query "mentions foo here" ["foo" "bar"]))))

  (testing "an alias title is highlighted too"
    (is (some #(= [:mark.p-0.rounded-none "bar"] %)
              (search-handler/highlight-matching-query "mentions bar here" ["foo" "bar"])))))
