(ns frontend.hypha.capture-test
  "Quick capture: URL query-param contract.

  The share target declared in hypha-server's web manifest and the desktop
  bookmarklet both hand Hypha the captured page through `hypha-*` query
  params. These tests pin that contract plus the URL cleanup that keeps a
  reload from capturing the same page twice.

  The surrounding glue (waiting for the graph, dispatching
  :editor/quick-capture) needs a live graph and is covered by the manual
  smoke in docs/hypha/quick-capture.md."
  (:require [cljs.core.async :as async]
            [cljs.test :refer [deftest is testing]]
            [clojure.string :as string]
            [frontend.hypha.capture :as capture]
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

(deftest-async drain-inbox-does-nothing-when-the-inbox-is-empty
  (let [acked (atom :never-called)
        dispatched (atom [])]
    (-> (capture/<drain-inbox!
         (fn [] (async-resp {:status 200 :body {:clips []}}))
         (fn [ids] (reset! acked ids) (async-resp {:status 200 :body {:remaining 0}}))
         (fn [args] (swap! dispatched conj args) (p/resolved nil)))
        (p/then (fn [drained]
                  (is (= 0 drained))
                  (is (= [] @dispatched))
                  (is (= :never-called @acked)
                      "an empty inbox must not cost an ack round-trip"))))))

(deftest-async drain-inbox-dispatches-in-order-then-acks-every-id
  (let [acked (atom nil)
        dispatched (atom [])]
    (-> (capture/<drain-inbox!
         (fn [] (async-resp {:status 200
                             :body {:clips [{:id "c1" :url "https://example.com/1"}
                                            {:id "c2" :title "Second"}]}}))
         (fn [ids] (reset! acked ids) (async-resp {:status 200 :body {:remaining 0}}))
         (fn [args] (swap! dispatched conj args) (p/resolved nil)))
        (p/then (fn [drained]
                  (is (= 2 drained))
                  (is (= [{:url "https://example.com/1"} {:title "Second"}] @dispatched)
                      "clips are inserted oldest-first, one at a time")
                  (is (= ["c1" "c2"] @acked)
                      "ack happens only after the blocks were dispatched"))))))

(deftest-async drain-inbox-skips-ack-when-the-fetch-fails
  (let [acked (atom :never-called)
        dispatched (atom [])]
    (-> (capture/<drain-inbox!
         (fn [] (async-resp {:status 401 :body {:error "unauthorized"}}))
         (fn [ids] (reset! acked ids) (async-resp {:status 200 :body {:remaining 0}}))
         (fn [args] (swap! dispatched conj args) (p/resolved nil)))
        (p/then (fn [drained]
                  (is (= 0 drained))
                  (is (= [] @dispatched))
                  (is (= :never-called @acked)
                      "a failed fetch must leave the inbox untouched for the next boot"))))))
