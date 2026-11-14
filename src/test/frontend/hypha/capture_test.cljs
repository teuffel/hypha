(ns frontend.hypha.capture-test
  "Quick capture: URL query-param contract.

  The share target declared in hypha-server's web manifest and the desktop
  bookmarklet both hand Hypha the captured page through `hypha-*` query
  params. These tests pin that contract plus the URL cleanup that keeps a
  reload from capturing the same page twice.

  Parking and the inbox drain are tested against an in-memory store and
  injected HTTP/dispatch fns. The surrounding glue (waiting for the
  graph, dispatching :editor/quick-capture) needs a live graph and is
  covered by the manual smoke in docs/hypha/quick-capture.md."
  (:require [cljs.core.async :as async]
            [cljs.test :refer [deftest is testing]]
            [clojure.string :as string]
            [frontend.hypha.capture :as capture]
            [frontend.state :as state]
            [frontend.test.helper :as test-helper :include-macros true
             :refer [deftest-async]]
            [promesa.core :as p]))

(deftest parse-capture-params-returns-nil-without-capture-params
  (testing "no query string at all"
    (is (nil? (capture/parse-capture-params "")))
    (is (nil? (capture/parse-capture-params nil))))

  (testing "query string that carries nothing of ours"
    (is (nil? (capture/parse-capture-params "?foo=1&bar=2")))))

(deftest parse-capture-params-maps-share-fields-to-quick-capture-args
  (testing "all three fields"
    (is (= {:title "Some Article"
            :content "the selected sentence"
            :url "https://example.com/a"}
           (capture/parse-capture-params
            (str "?hypha-title=Some%20Article"
                 "&hypha-text=the%20selected%20sentence"
                 "&hypha-url=https%3A%2F%2Fexample.com%2Fa")))))

  (testing "url alone is enough — Android often shares only a link"
    (is (= {:url "https://example.com/a"}
           (capture/parse-capture-params "?hypha-url=https%3A%2F%2Fexample.com%2Fa"))))

  (testing "text alone is enough — a plain selection with no source page"
    (is (= {:content "just a thought"}
           (capture/parse-capture-params "?hypha-text=just%20a%20thought")))))

(deftest parse-capture-params-drops-blank-fields
  (testing "share sheets routinely send empty strings for absent fields"
    (is (= {:title "Only a title"}
           (capture/parse-capture-params "?hypha-title=Only%20a%20title&hypha-text=&hypha-url=")))
    (is (nil? (capture/parse-capture-params "?hypha-title=&hypha-text=&hypha-url=")))))

(deftest parse-capture-params-ignores-unrelated-params
  (is (= {:title "T"}
         (capture/parse-capture-params "?utm_source=x&hypha-title=T&ref=y"))))

(deftest strip-capture-params-removes-only-our-params
  (let [stripped (capture/strip-capture-params
                  "https://hypha.test/?keep=1&hypha-title=T&hypha-url=https%3A%2F%2Fe.com#/page/foo")]
    (testing "capture params are gone so a reload cannot re-capture"
      (is (not (string/includes? stripped "hypha-title")))
      (is (not (string/includes? stripped "hypha-url"))))

    (testing "everything else survives"
      (is (string/includes? stripped "keep=1"))
      (is (string/includes? stripped "#/page/foo"))
      (is (string/starts-with? stripped "https://hypha.test/")))))

(deftest strip-capture-params-leaves-untouched-urls-alone
  (is (= "https://hypha.test/#/page/foo"
         (capture/strip-capture-params "https://hypha.test/#/page/foo"))))

;; ---------------------------------------------------------------------------
;; Capture inbox drain (Firefox / Thunderbird clippers)

(defn- async-resp
  [resp]
  (let [ch (async/chan 1)]
    (async/put! ch resp)
    ch))

(deftest clip->capture-args-maps-the-server-shape
  (testing "server `text` is quick-capture's `content`; bookkeeping fields are dropped"
    (is (= {:title "Subject" :content "body line" :url "https://example.com"}
           (capture/clip->capture-args {:id "abc"
                                        :capturedAt 1234
                                        :title "Subject"
                                        :text "body line"
                                        :url "https://example.com"}))))

  (testing "absent and blank fields are omitted rather than passed as empty strings"
    (is (= {:url "https://example.com"}
           (capture/clip->capture-args {:id "abc" :title "" :url "https://example.com"})))))

(defn- memory-store
  "In-memory stand-in for `capture/local-store`. Values round-trip through
  JSON like the real one."
  ([] (memory-store (atom {})))
  ([*data]
   {:read (fn [k]
            (some-> (get @*data k) js/JSON.parse (js->clj :keywordize-keys true)))
    :write! (fn [k v]
              (swap! *data assoc k (js/JSON.stringify (clj->js v))))}))

(defn- fake-inbox
  "Stand-in for hypha-server's capture inbox: `:fetch` lists what is
  pending, `:ack` answers with the next of `ack-statuses` (200 once they
  run out) and, like the server, removes the acked clips only on 200.
  `:acks` records every ack call as `[status ids]`."
  ([clips] (fake-inbox clips []))
  ([clips ack-statuses]
   (let [*pending (atom (vec clips))
         *statuses (atom ack-statuses)
         *acks (atom [])]
     {:fetch (fn [] (async-resp {:status 200 :body {:clips @*pending}}))
      :ack (fn [ids]
             (let [status (or (first @*statuses) 200)]
               (swap! *statuses rest)
               (swap! *acks conj [status ids])
               (when (= 200 status)
                 (swap! *pending (fn [pending] (vec (remove (comp (set ids) :id) pending)))))
               (async-resp {:status status :body {:remaining (count @*pending)}})))
      :acks *acks
      :pending *pending})))

(defn- recording-dispatch
  "Dispatch stub that records what it inserted and rejects for titles in
  `failing-titles`."
  ([*dispatched] (recording-dispatch *dispatched #{}))
  ([*dispatched failing-titles]
   (fn [args]
     (if (contains? failing-titles (:title args))
       (p/rejected (ex-info "insert failed" {}))
       (do (swap! *dispatched conj args)
           (p/resolved nil))))))

(deftest-async drain-inbox-does-nothing-when-the-inbox-is-empty
  (let [{:keys [fetch ack acks]} (fake-inbox [])
        dispatched (atom [])]
    (-> (capture/<drain-inbox! fetch ack (recording-dispatch dispatched) (memory-store))
        (p/then (fn [drained]
                  (is (= {:inserted 0 :failed 0} drained))
                  (is (= [] @dispatched))
                  (is (= [] @acks)
                      "an empty inbox must not cost an ack round-trip"))))))

(deftest-async drain-inbox-dispatches-in-order-then-acks-every-id
  (let [{:keys [fetch ack acks]} (fake-inbox [{:id "c1" :url "https://example.com/1"}
                                              {:id "c2" :title "Second"}])
        dispatched (atom [])]
    (-> (capture/<drain-inbox! fetch ack (recording-dispatch dispatched) (memory-store))
        (p/then (fn [drained]
                  (is (= {:inserted 2 :failed 0} drained))
                  (is (= [{:url "https://example.com/1"} {:title "Second"}] @dispatched)
                      "clips are inserted oldest-first, one at a time")
                  (is (= [[200 ["c1" "c2"]]] @acks)
                      "ack happens only after the blocks were dispatched"))))))

(deftest-async drain-inbox-waits-for-each-insert-before-the-next-and-the-ack
  (let [{:keys [fetch ack acks]} (fake-inbox [{:id "c1" :title "First"}
                                              {:id "c2" :title "Second"}])
        events (atom [])
        first-insert (p/deferred)
        dispatch (fn [args]
                   (swap! events conj [:dispatch (:title args)])
                   (if (= "First" (:title args))
                     first-insert
                     (p/resolved nil)))
        drain (capture/<drain-inbox! fetch ack dispatch (memory-store))]
    (p/let [_ (p/delay 20)
            before @events
            acks-before @acks
            _ (p/resolve! first-insert nil)
            _ drain]
      (is (= [[:dispatch "First"]] before)
          "the second clip is not dispatched while the first insert is pending")
      (is (= [] acks-before) "nothing is acked while an insert is pending")
      (is (= [[:dispatch "First"] [:dispatch "Second"]] @events))
      (is (= [[200 ["c1" "c2"]]] @acks)))))

(deftest-async drain-inbox-skips-ack-when-the-fetch-fails
  (let [acked (atom :never-called)
        dispatched (atom [])]
    (-> (capture/<drain-inbox!
         (fn [] (async-resp {:status 401 :body {:error "unauthorized"}}))
         (fn [ids] (reset! acked ids) (async-resp {:status 200 :body {:remaining 0}}))
         (recording-dispatch dispatched)
         (memory-store))
        (p/then (fn [drained]
                  (is (= {:inserted 0 :failed 0} drained))
                  (is (= [] @dispatched))
                  (is (= :never-called @acked)
                      "a failed fetch must leave the inbox untouched for the next boot"))))))

(deftest-async drain-inbox-keeps-a-failed-clip-without-holding-up-the-others
  (let [{:keys [fetch ack acks pending]} (fake-inbox [{:id "c1" :title "First"}
                                                      {:id "c2" :title "Broken"}
                                                      {:id "c3" :title "Third"}])
        store (memory-store)
        dispatched (atom [])]
    (p/let [first-drain (capture/<drain-inbox! fetch ack (recording-dispatch dispatched #{"Broken"}) store)
            pending-after-first @pending
            retry-drain (capture/<drain-inbox! fetch ack (recording-dispatch dispatched) store)]
      (is (= {:inserted 2 :failed 1} first-drain))
      (is (= [[200 ["c1" "c3"]] [200 ["c2"]]] @acks)
          "only clips that are in the graph are acked")
      (is (= [{:id "c2" :title "Broken"}] pending-after-first)
          "the failed clip is the user's only copy and stays in the inbox")
      (is (= {:inserted 1 :failed 0} retry-drain))
      (is (= [{:title "First"} {:title "Third"} {:title "Broken"}] @dispatched)
          "nothing is inserted twice")
      (is (= [] @pending)))))

(deftest-async drain-inbox-retries-a-failed-ack-without-duplicating-clips
  (let [{:keys [fetch ack acks pending]} (fake-inbox [{:id "c1" :title "First"}] [500])
        dispatched (atom [])
        store (memory-store)
        dispatch (recording-dispatch dispatched)]
    (p/let [first-drain (capture/<drain-inbox! fetch ack dispatch store)
            second-drain (capture/<drain-inbox! fetch ack dispatch store)]
      (is (= {:inserted 1 :failed 0} first-drain))
      (is (= {:inserted 0 :failed 0} second-drain)
          "the server still lists the clip, but it is already in the graph")
      (is (= [{:title "First"}] @dispatched) "no duplicate block")
      (is (= [[500 ["c1"]] [200 ["c1"]]] @acks) "the ack is retried until the server takes it")
      (is (= [] @pending)))))

;; ---------------------------------------------------------------------------
;; The production dispatch

(defn- pub-event-like-the-event-loop
  "What `state/pub-event!` hands back for a handler that returned
  `handler-promise`: `frontend.handler.events/run!` resolves the deferred
  with the handler's promise as its value, and promesa does not adopt it."
  [handler-promise]
  (let [d (p/deferred)]
    (p/resolve! d handler-promise)
    d))

(deftest-async dispatch-clip-default-settles-with-the-insert
  ;; Pending dispatches are never bound with p/let here: that would wait for
  ;; the very insert the test resolves later.
  (let [original-pub-event! state/pub-event!
        inserts (atom [])
        published (atom [])
        _ (set! state/pub-event! (fn [[event-key args]]
                                   (swap! published conj [event-key (js->clj args :keywordize-keys true)])
                                   (let [insert (p/deferred)]
                                     (swap! inserts conj insert)
                                     (pub-event-like-the-event-loop insert))))
        first-dispatch (capture/<dispatch-clip-default {:title "First"})
        first-settled? (atom false)]
    (p/finally first-dispatch (fn [_ _] (reset! first-settled? true)))
    (-> (p/let [_ (p/delay 20)
                settled-before-insert? @first-settled?
                _ (p/resolve! (first @inserts) {:block/uuid "b1"})
                resolved first-dispatch
                outcome-of (fn [title settle!]
                             (let [outcome (-> (capture/<dispatch-clip-default {:title title})
                                               (p/then (fn [_] :resolved))
                                               (p/catch (fn [e] (ex-message e))))]
                               (p/let [_ (p/delay 20)]
                                 (settle! (last @inserts))
                                 outcome)))
                failed (outcome-of "Second" #(p/reject! % (ex-info "insert failed" {})))
                nothing-inserted (outcome-of "Third" #(p/resolve! % nil))]
          (is (false? settled-before-insert?)
              "the event deferred resolving is not the insert finishing")
          (is (= {:block/uuid "b1"} resolved))
          (is (= [[:editor/quick-capture {:title "First" :append true}]
                  [:editor/quick-capture {:title "Second" :append true}]
                  [:editor/quick-capture {:title "Third" :append true}]]
                 @published)
              "a capture never goes into the block being edited")
          (is (= "insert failed" failed)
              "a failed insert must reach the caller, or the clip would be acked")
          (is (= "quick capture inserted no block" nothing-inserted)
              "quick capture resolves without inserting on some paths"))
        (p/finally (fn [_ _]
                     (set! state/pub-event! original-pub-event!))))))

(deftest clear-local-storage-keeps-captures-test
  (let [had? (.call (.-hasOwnProperty (.-prototype js/Object)) js/globalThis "localStorage")
        previous (.-localStorage js/globalThis)
        data (atom {"hypha/capture-parked" "[{\"title\":\"t\"}]"
                    "hypha/capture-inserted-clip-ids" "[\"c1\"]"
                    "git/current-repo" "logseq_db_x"})]
    (js/Object.defineProperty js/globalThis "localStorage"
                              #js {:value #js {:getItem (fn [k] (get @data k))
                                               :setItem (fn [k v] (swap! data assoc k v))
                                               :clear (fn [] (reset! data {}))}
                                   :configurable true
                                   :writable true})
    (try
      (capture/clear-local-storage-keeping-captures!)
      (is (= {"hypha/capture-parked" "[{\"title\":\"t\"}]"
              "hypha/capture-inserted-clip-ids" "[\"c1\"]"}
             @data)
          "logout clears everything except captures that are not in the graph yet")
      (finally
        (if had?
          (js/Object.defineProperty js/globalThis "localStorage"
                                    #js {:value previous :configurable true :writable true})
          (js/Reflect.deleteProperty js/globalThis "localStorage"))))))

;; ---------------------------------------------------------------------------
;; Parked share-target / bookmarklet captures

(deftest-async deliver-parked-files-captures-in-order-and-empties-the-store
  (let [data (atom {})
        store (memory-store data)
        dispatched (atom [])
        dispatch (recording-dispatch dispatched)]
    (capture/park-capture! store {:title "First" :url "https://example.com/1"})
    (capture/park-capture! store {:content "Second"})
    (p/let [first-run (capture/<deliver-parked! store dispatch)
            second-run (capture/<deliver-parked! store dispatch)]
      (is (= {:delivered 2 :failed 0} first-run))
      (is (= {:delivered 0 :failed 0} second-run))
      (is (= [{:title "First" :url "https://example.com/1"} {:content "Second"}] @dispatched)
          "each capture is filed exactly once")
      (is (= ["[]"] (vals @data))))))

(deftest-async deliver-parked-keeps-a-failed-capture-without-holding-up-the-others
  (let [store (memory-store)
        dispatched (atom [])]
    (capture/park-capture! store {:title "Broken"})
    (capture/park-capture! store {:title "Second"})
    (p/let [first-run (capture/<deliver-parked! store (recording-dispatch dispatched #{"Broken"}))
            retry-run (capture/<deliver-parked! store (recording-dispatch dispatched))]
      (is (= {:delivered 1 :failed 1} first-run))
      (is (= {:delivered 1 :failed 0} retry-run))
      (is (= [{:title "Second"} {:title "Broken"}] @dispatched)
          "the capture behind the failing one is filed, and the failing one survives for a retry"))))
