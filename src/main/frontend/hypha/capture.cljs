(ns frontend.hypha.capture
  "Quick capture from the PWA share target and the desktop bookmarklet.

  Both entry points hand Hypha the captured page the same way: they
  navigate to the app's start URL with `hypha-*` query params attached
  (see `hypha-server/src/routes/manifest.ts` for the share-target
  declaration and docs/hypha/quick-capture.md for the bookmarklet).

  The Firefox and Thunderbird clippers cannot navigate anything, so they
  POST to hypha-server's capture inbox instead; this namespace drains that
  inbox on boot (`<drain-inbox!`).

  Capture stays entirely client-side on purpose. The graph lives in the
  browser's OPFS and only reaches the server through RTC sync, so a
  server-side capture endpoint would have to write through the sync
  pipeline. Instead this namespace parses the params and hands them to
  upstream Logseq's existing `:editor/quick-capture` event, which already
  owns template rendering, the target-page rules and the journal fallback
  (`frontend.quick-capture`).

  Called from `frontend.hypha.init/start!`, so it only ever runs in
  Hypha mode."
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [<! go]]
            [clojure.string :as string]
            [frontend.context.i18n :refer [t]]
            [frontend.handler.notification :as notification]
            [frontend.state :as state]
            [lambdaisland.glogi :as log]
            [promesa.core :as p]))

(def ^:private capture-params
  "Query-param name → key expected by `frontend.quick-capture/quick-capture`.

  The `hypha-` prefix keeps these clear of any query param upstream
  Logseq reads. Mirrors CAPTURE_PARAMS in
  hypha-server/src/routes/manifest.ts — change both together."
  {"hypha-title" :title
   "hypha-text" :content
   "hypha-url" :url})

(defn parse-capture-params
  "Extract quick-capture args from a URL query string.

  Returns nil when the query string holds none of our params, so callers
  can use it as the \"is this a capture navigation?\" test. Blank values
  are dropped: share sheets routinely send empty strings for fields the
  source app did not provide."
  [search]
  (when-not (string/blank? search)
    (let [params (js/URLSearchParams. search)]
      (not-empty
       (reduce (fn [acc [param k]]
                 (let [value (.get params param)]
                   (if (string/blank? value)
                     acc
                     (assoc acc k value))))
               {}
               capture-params)))))

(defn strip-capture-params
  "Remove the `hypha-*` params from `href`, leaving the rest of the URL intact.

  Without this a reload (or restoring the tab) would capture the same
  page again."
  [href]
  (let [url (js/URL. href)]
    (doseq [param (keys capture-params)]
      (.delete (.-searchParams url) param))
    (.-href url)))

(defn- graph-ready?
  "True once a graph is active and its DB has finished restoring.

  `frontend.quick-capture` creates the target page and inserts a block, so
  both need a loaded graph. There is no single ready-flag to watch: the
  boot sequence runs auth → remote-graph list → download → DB restore, so
  the precondition itself is polled below.

  `:db/restoring?` starts out nil and turns false only after a restore has
  finished, so nil must not count as restored: on a returning session
  `:git/current-repo` is set from localStorage before anything is loaded."
  []
  (and (some? (state/get-current-repo))
       (false? (:db/restoring? @state/state))))

(defn- signed-in?
  "The capture inbox needs a token, and the session is restored
  asynchronously on boot."
  []
  (some? (state/get-auth-id-token)))

(def ^:private ready-poll-interval-ms 250)
(def ^:private ready-timeout-ms 60000)
(def ^:private late-ready-poll-interval-ms 2000)

(defn- <wait-until!
  "Resolve true once `(ready?)` holds, or false if it stays false for
  `timeout-ms`. Without `timeout-ms` it waits for as long as it takes."
  [ready? poll-interval-ms timeout-ms]
  (let [deadline (when timeout-ms (+ (js/Date.now) timeout-ms))
        result (p/deferred)]
    (letfn [(poll []
              (cond
                (ready?) (p/resolve! result true)
                (and deadline (> (js/Date.now) deadline)) (p/resolve! result false)
                :else (js/setTimeout poll poll-interval-ms)))]
      (poll))
    result))

;; ---------------------------------------------------------------------------
;; Local bookkeeping. A capture must survive until its block is in the
;; graph, and a clip must not be inserted twice when its ack got lost. Both
;; need state that outlives the tab.

(def ^:private parked-key "hypha/capture-parked")
(def ^:private inserted-clip-ids-key "hypha/capture-inserted-clip-ids")

(def ^:no-doc local-store
  "localStorage as the `{:read :write!}` pair the fns below take. Tests
  pass an in-memory one.

  A value that does not parse reads as nil: it cannot be recovered, and
  failing every later read would block all captures behind it."
  {:read (fn [k]
           (when-let [raw (.getItem js/localStorage k)]
             (try
               (js->clj (js/JSON.parse raw) :keywordize-keys true)
               (catch :default e
                 (log/error :hypha/capture-store-corrupt {:key k :error e})
                 nil))))
   :write! (fn [k v]
             (.setItem js/localStorage k (js/JSON.stringify (clj->js v))))})

(defn- read-vec
  [store k]
  (vec ((:read store) k)))

(defn park-capture!
  "Persist a share-target/bookmarklet capture until `<deliver-parked!` has
  filed it. Its URL params are stripped right away, so this is the only
  copy."
  [store args]
  ((:write! store) parked-key (conj (read-vec store parked-key) args)))

(defn- unpark-capture!
  "Drop one parked copy of `args`."
  [store args]
  (let [[before from-match] (split-with #(not= args %) (read-vec store parked-key))]
    ((:write! store) parked-key (vec (concat before (rest from-match))))))

(defn <deliver-parked!
  "File every parked capture, oldest first. Resolves `{:delivered :failed}`.

  A capture leaves the store only after `<dispatch` resolved for it. One
  that fails stays parked for the next boot and does not hold up the ones
  behind it."
  [store <dispatch]
  (p/loop [pending (read-vec store parked-key)
           delivered 0
           failed 0]
    (if-let [args (first pending)]
      (p/let [inserted? (-> (<dispatch args)
                            (p/then (constantly true))
                            (p/catch (fn [e]
                                       (log/error :hypha/capture-parked-insert-failed {:error e})
                                       false)))]
        (when inserted?
          (unpark-capture! store args))
        (p/recur (rest pending)
                 (if inserted? (inc delivered) delivered)
                 (if inserted? failed (inc failed))))
      {:delivered delivered :failed failed})))

;; ---------------------------------------------------------------------------
;; Capture inbox — clips posted by the Firefox / Thunderbird extensions.
;;
;; The extensions cannot write the graph (it lives in this browser's OPFS),
;; so they POST to hypha-server's inbox and we drain it here on boot. See
;; hypha-server/src/capture-inbox.ts.

(defn clip->capture-args
  "Map one inbox clip onto the args `frontend.quick-capture` expects.

  The server's `text` is quick capture's `content`; `id`/`capturedAt` are
  bookkeeping and stay out. Blank fields are dropped so the capture
  template does not render empty placeholders."
  [clip]
  (cond-> {}
    (not (string/blank? (:title clip))) (assoc :title (:title clip))
    (not (string/blank? (:text clip))) (assoc :content (:text clip))
    (not (string/blank? (:url clip))) (assoc :url (:url clip))))

(defn- <chan->promise
  "Bridge a cljs-http response channel into a promesa promise."
  [ch]
  (let [result (p/deferred)]
    (go (p/resolve! result (<! ch)))
    result))

(defn ^:no-doc <fetch-pending-default
  "Production GET /capture/pending. Split out so tests can inject a stub
  without going through cljs-http's macro-expanded XHR path."
  []
  (http/get "/capture/pending" {:oauth-token (state/get-auth-id-token)}))

(defn ^:no-doc <ack-clips-default
  "Production POST /capture/ack."
  [ids]
  (http/post "/capture/ack" {:json-params {:ids ids}
                             :oauth-token (state/get-auth-id-token)}))

(defn ^:no-doc <dispatch-clip-default
  "Hand one set of capture args to upstream quick capture. Resolves with
  the inserted block and rejects when nothing was inserted.

  `state/pub-event!` resolves as soon as the handler has returned, with the
  handler's promise as its value (promesa does not adopt it). Binding that
  value a second time is what waits for the insert.

  Quick capture also resolves on paths that insert nothing (no journal
  title, a missing or recycled target page), so the result is checked.
  `:append` keeps it from typing the capture into a block the user happens
  to be editing: a capture always becomes its own block."
  [args]
  (p/let [insert-promise (state/pub-event! [:editor/quick-capture (clj->js (assoc args :append true))])
          block insert-promise]
    (if (:block/uuid block)
      block
      (throw (ex-info "quick capture inserted no block" {:args args})))))

(defn <drain-inbox!
  "Insert every pending clip, then ack the inserted ones. Resolves
  `{:inserted :failed}`.

  A clip is acked only after its block was inserted, so a browser that
  dies mid-drain replays clips on the next boot instead of losing them.
  Inserted clip ids are remembered until the server confirmed the ack
  with a 200, so a failed ack (401, 5xx, offline) is retried on the next
  drain without inserting the clips again.

  A clip whose insert fails stays in the inbox for the next boot. It does
  not hold up the clips behind it, and they are acked without it.

  The four-arg form injects the HTTP calls, the dispatch and the store
  for tests."
  ([]
   (<drain-inbox! <fetch-pending-default <ack-clips-default <dispatch-clip-default local-store))
  ([<fetch <ack <dispatch store]
   (-> (p/let [resp (<chan->promise (<fetch))]
         (if (not= 200 (:status resp))
           (do (log/info :hypha/capture-inbox-fetch-failed
                         {:status (:status resp)})
               {:inserted 0 :failed 0})
           (let [clips (get-in resp [:body :clips])
                 clip-ids (set (map :id clips))
                 ;; Ids the server no longer lists are done; drop them.
                 inserted-ids (filterv clip-ids (read-vec store inserted-clip-ids-key))
                 new-clips (remove (comp (set inserted-ids) :id) clips)]
             ((:write! store) inserted-clip-ids-key inserted-ids)
             (p/let [failed (p/loop [remaining new-clips
                                     failed 0]
                              (if-let [clip (first remaining)]
                                (p/let [inserted? (-> (<dispatch (clip->capture-args clip))
                                                      (p/then (constantly true))
                                                      (p/catch (fn [e]
                                                                 (log/error :hypha/capture-clip-insert-failed
                                                                            {:id (:id clip) :error e})
                                                                 false)))]
                                  (when inserted?
                                    ((:write! store) inserted-clip-ids-key
                                                     (conj (read-vec store inserted-clip-ids-key) (:id clip))))
                                  (p/recur (rest remaining) (if inserted? failed (inc failed))))
                                failed))
                     ids-to-ack (read-vec store inserted-clip-ids-key)
                     ack-resp (when (seq ids-to-ack)
                                (<chan->promise (<ack ids-to-ack)))]
               (cond
                 (nil? ack-resp)
                 nil

                 (= 200 (:status ack-resp))
                 ((:write! store) inserted-clip-ids-key
                                  (vec (remove (set ids-to-ack) (read-vec store inserted-clip-ids-key))))

                 :else
                 (log/warn :hypha/capture-inbox-ack-failed
                           {:status (:status ack-resp)}))
               {:inserted (- (count new-clips) failed) :failed failed}))))
       (p/catch (fn [e]
                  (log/error :hypha/capture-inbox-drain-failed {:error e})
                  {:inserted 0 :failed 0})))))

(defn- <with-capture-lock
  "Run `<f` while holding a lock shared by all tabs of this origin.
  Delivery and drain read and rewrite the same localStorage lists and the
  same server inbox; two tabs booting together would otherwise insert the
  same clip twice or drop a parked capture."
  [<f]
  (if-let [locks (some-> js/navigator .-locks)]
    (.request locks "hypha-capture" (fn [_lock] (<f)))
    (<f)))

(defn <start!
  "Boot entry point: file a share-target/bookmarklet capture from the URL
  and drain the clipper inbox.

  URL params are stripped immediately — before the graph is even ready —
  so a reload cannot replay the capture. The capture is parked in
  localStorage instead and filed once a graph is ready, in this session
  or a later one. Parked captures only need the graph; the inbox also
  needs the session, which is restored asynchronously.

  On an ordinary boot there are no URL params and the inbox is empty, so
  this costs one request once the graph is up."
  []
  (let [args (parse-capture-params js/window.location.search)
        _ (when args
            (.replaceState js/window.history nil ""
                           (strip-capture-params js/window.location.href)))
        ;; This runs inside app boot, where a throw would abort it. If
        ;; localStorage refuses the capture (quota, disabled), keep it in
        ;; memory for this session at least.
        unparked-args (when args
                        (try
                          (park-capture! local-store args)
                          nil
                          (catch :default e
                            (log/error :hypha/capture-park-failed {:error e})
                            args)))]
    (-> (p/let [ready? (<wait-until! graph-ready? ready-poll-interval-ms ready-timeout-ms)
                _ (when-not ready?
                    ;; Fresh login or a graph that is still downloading. Tell
                    ;; the user their capture is not lost, then keep waiting.
                    (when (or unparked-args (seq (read-vec local-store parked-key)))
                      (log/warn :hypha/capture-parked {:reason "no graph ready before timeout"})
                      (notification/show! (t :hypha.capture/waiting-for-graph) :warning))
                    (<wait-until! graph-ready? late-ready-poll-interval-ms nil))
                unparked-failed (if unparked-args
                                  (-> (<dispatch-clip-default unparked-args)
                                      (p/then (constantly 0))
                                      (p/catch (fn [e]
                                                 (log/error :hypha/capture-unparked-insert-failed {:error e})
                                                 1)))
                                  0)
                _ (<wait-until! signed-in? late-ready-poll-interval-ms nil)
                {:keys [parked drained]} (<with-capture-lock
                                          #(p/let [parked (<deliver-parked! local-store <dispatch-clip-default)
                                                   drained (<drain-inbox!)]
                                             {:parked parked :drained drained}))]
          (when (pos? (+ unparked-failed (:failed parked) (:failed drained)))
            (notification/show! (t :hypha.capture/insert-failed) :warning)))
        (p/catch (fn [e]
                   (log/error :hypha/capture-start-failed {:error e}))))))
