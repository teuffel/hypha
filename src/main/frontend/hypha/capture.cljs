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
  the precondition itself is polled below."
  []
  (and (some? (state/get-current-repo))
       (not (:db/restoring? @state/state))))

(def ^:private ready-poll-interval-ms 250)
(def ^:private ready-timeout-ms 60000)

(defn- <wait-for-graph!
  "Resolve true once `graph-ready?`, or false if it stays false for
  `ready-timeout-ms`. The timeout keeps a captured URL from leaking into a
  session that never opens a graph (fresh login, no graph downloaded yet)."
  []
  (let [deadline (+ (js/Date.now) ready-timeout-ms)
        result (p/deferred)]
    (letfn [(poll []
              (cond
                (graph-ready?) (p/resolve! result true)
                (> (js/Date.now) deadline) (p/resolve! result false)
                :else (js/setTimeout poll ready-poll-interval-ms)))]
      (poll))
    result))

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

;; `frontend.quick-capture` schedules its block insert on a 100 ms timeout
;; that it does not return, so two dispatches in a row would race for the
;; same page. Waiting this out between clips serialises them.
(def ^:private inter-clip-delay-ms 300)

(defn ^:no-doc <dispatch-clip-default
  "Hand one set of capture args to upstream quick capture."
  [args]
  (state/pub-event! [:editor/quick-capture (clj->js args)])
  (p/delay inter-clip-delay-ms))

(defn <drain-inbox!
  "Insert every pending clip, then ack them. Resolves the number drained.

  Ack happens only after dispatch, so a browser that dies mid-drain
  replays clips on the next boot instead of losing them. Any failure
  leaves the inbox untouched and resolves 0 — the clips are the user's
  only copy, so retrying next boot beats surfacing an error here.

  The three-arg form injects the HTTP calls and the dispatch for tests."
  ([]
   (<drain-inbox! <fetch-pending-default <ack-clips-default <dispatch-clip-default))
  ([<fetch <ack <dispatch]
   (-> (<chan->promise (<fetch))
       (p/then (fn [resp]
                 (if (not= 200 (:status resp))
                   (do (log/info :hypha/capture-inbox-fetch-failed
                                 {:status (:status resp)})
                       0)
                   (let [clips (get-in resp [:body :clips])]
                     (if (empty? clips)
                       0
                       (-> (reduce (fn [chain clip]
                                     (p/then chain
                                             (fn [_] (<dispatch (clip->capture-args clip)))))
                                   (p/resolved nil)
                                   clips)
                           (p/then (fn [_] (<chan->promise (<ack (mapv :id clips)))))
                           (p/then (fn [_] (count clips)))))))))
       (p/catch (fn [e]
                  (log/error :hypha/capture-inbox-drain-failed {:error e})
                  0)))))

(defn <start!
  "Boot entry point: file a share-target/bookmarklet capture from the URL
  and drain the clipper inbox.

  URL params are stripped immediately — before the graph is even ready —
  so a reload cannot replay the capture. Both paths then share one wait
  for the graph, because both insert blocks.

  On an ordinary boot there are no URL params and the inbox is empty, so
  this costs one request once the graph is up."
  []
  (let [args (parse-capture-params js/window.location.search)]
    (when args
      (.replaceState js/window.history nil ""
                     (strip-capture-params js/window.location.href)))
    (-> (<wait-for-graph!)
        (p/then (fn [ready?]
                  (if ready?
                    (p/do (when args (<dispatch-clip-default args))
                          (<drain-inbox!))
                    ;; No graph within the timeout. Only worth reporting
                    ;; when something was actually waiting to be filed.
                    (when args
                      (log/warn :hypha/capture-dropped
                                {:reason "no graph ready before timeout"}))))))))
