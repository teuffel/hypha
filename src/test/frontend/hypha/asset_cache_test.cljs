(ns frontend.hypha.asset-cache-test
  "Unit tests for the Hypha Phase-1.6.1 asset cache eviction algorithm.

  Covers the testable core: `<evict-until!` sorts by mtime ascending,
  stops at the byte target, and continues past unlink failures;
  `<evict-pass!` only runs above the quota threshold and only touches the
  files it is handed as evictable.

  Which assets are evictable is decided in the worker, see
  `frontend.worker.sync.assets-test`."
  (:require [cljs.test :refer [deftest is]]
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

(deftest asset-path-matches-the-storage-layer
  ;; frontend.worker.platform.browser stores assets under the URL-encoded
  ;; graph name; see frontend.worker.platform-browser-test.
  (is (= "/Lambda%20RTC/assets/69fb07e1-852f-4896-9d30-761843368fdb.png"
         (asset-cache/asset-path {:repo "logseq_db_Lambda RTC"
                                  :file-name "69fb07e1-852f-4896-9d30-761843368fdb.png"})))
  (is (= "/teuffel.io/assets/x.pdf"
         (asset-cache/asset-path {:repo "logseq_db_teuffel.io" :file-name "x.pdf"}))))

(defn- estimate-of
  [usage quota]
  (fn [] (p/resolved {:usage usage :quota quota})))

(deftest-async evict-pass-frees-nothing-when-no-asset-is-evictable
  (let [calls (atom [])
        pfs (success-pfs calls)]
    ;; 90% used, but every asset on disk belongs to a local-only graph or
    ;; was never uploaded, so the worker reports no candidates.
    (-> (asset-cache/<evict-pass! pfs (estimate-of 900 1000) (fn [_pfs] (p/resolved [])))
        (p/then (fn [freed]
                  (is (= 0 freed))
                  (is (= [] @calls) "nothing is unlinked"))))))

(deftest-async evict-pass-evicts-only-the-files-it-is-given
  (let [calls (atom [])
        pfs (success-pfs calls)
        files [{:path "/g/assets/uploaded.png" :mtime 1 :size 400}]]
    (-> (asset-cache/<evict-pass! pfs (estimate-of 900 1000) (fn [_pfs] (p/resolved files)))
        (p/then (fn [freed]
                  (is (= 400 freed))
                  (is (= ["/g/assets/uploaded.png"] @calls)))))))

(deftest-async evict-pass-skips-enumeration-below-threshold
  (let [calls (atom [])
        files-requested? (atom false)
        pfs (success-pfs calls)]
    (-> (asset-cache/<evict-pass! pfs (estimate-of 500 1000) (fn [_pfs]
                                                               (reset! files-requested? true)
                                                               (p/resolved [])))
        (p/then (fn [freed]
                  (is (nil? freed))
                  (is (false? @files-requested?))
                  (is (= [] @calls)))))))
