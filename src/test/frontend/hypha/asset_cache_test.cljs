(ns frontend.hypha.asset-cache-test
  "Unit tests for the Hypha Phase-1.6.1 asset cache eviction algorithm.

  Covers the testable core: `<evict-until!` sorts by mtime ascending,
  stops at the byte target, and continues past unlink failures.

  `<maybe-evict!` depends on `navigator.storage.estimate()`, which is
  unavailable in Node — that wrapper is exercised manually via the
  Phase-1.6.1 sign-off browser smoke."
  (:require [cljs.test :refer [is]]
            [frontend.hypha.asset-cache :as asset-cache]
            [frontend.test.helper :as test-helper :include-macros true
             :refer [deftest-async]]
            [promesa.core :as p]))

(defn- success-pfs
  "Stub pfs whose .unlink resolves immediately and records each call."
  [calls]
  #js {:unlink (fn [path]
                 (swap! calls conj path)
                 (p/resolved nil))})

(deftest-async evict-until-deletes-oldest-first-and-stops-at-target
  (let [calls (atom [])
        pfs (success-pfs calls)
        files [{:path "/g/assets/newest.png" :mtime 30 :size 100}
               {:path "/g/assets/oldest.png" :mtime 10 :size 200}
               {:path "/g/assets/middle.png" :mtime 20 :size 150}]]
    (-> (asset-cache/<evict-until! pfs files 250)
        (p/then (fn [freed]
                  (is (= ["/g/assets/oldest.png" "/g/assets/middle.png"] @calls)
                      "deletes oldest mtime first, then next, in mtime ascending order")
                  (is (= 350 freed)
                      "stops once cumulative freed bytes (200+150) reach/exceed target (250)"))))))

(deftest-async evict-until-stops-when-target-exceeded-by-first-file
  (let [calls (atom [])
        pfs (success-pfs calls)
        files [{:path "/g/assets/single-big.png" :mtime 1 :size 500}]]
    (-> (asset-cache/<evict-until! pfs files 100)
        (p/then (fn [freed]
                  (is (= ["/g/assets/single-big.png"] @calls)
                      "single delete already meets target")
                  (is (= 500 freed)))))))

(deftest-async evict-until-keeps-going-when-unlink-fails
  (let [calls (atom [])
        pfs #js {:unlink (fn [path]
                           (swap! calls conj path)
                           (if (= path "/g/assets/locked.png")
                             (p/rejected (js/Error. "EACCES"))
                             (p/resolved nil)))}
        files [{:path "/g/assets/locked.png" :mtime 1 :size 999}
               {:path "/g/assets/free.png"   :mtime 2 :size 100}]]
    (-> (asset-cache/<evict-until! pfs files 50)
        (p/then (fn [freed]
                  (is (= ["/g/assets/locked.png" "/g/assets/free.png"] @calls)
                      "loop advances past the failed unlink")
                  (is (= 100 freed)
                      "failed unlink does not count toward freed bytes"))))))

(deftest-async evict-until-no-op-on-empty-list
  (let [calls (atom [])
        pfs (success-pfs calls)]
    (-> (asset-cache/<evict-until! pfs [] 1000)
        (p/then (fn [freed]
                  (is (= [] @calls))
                  (is (= 0 freed)))))))
