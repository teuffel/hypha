(ns frontend.hypha.asset-cache
  "Phase 1.6.1 — LRU eviction for the Logseq asset cache.

  Asset binaries live in a LightningFS IndexedDB store (`logseq`,
  mounted at `memory:///`) at `/<graph-name>/assets/<uuid>.<ext>`.
  Stock Logseq has no eviction mechanism: `asset-delete!` is only
  triggered by `:remove-asset` ops from the server tx stream, which
  means the cache grows monotonically. Over years of personal-cloud
  use the IndexedDB quota will fill up and the next asset write fails
  with `QuotaExceededError`.

  This namespace runs a 30-second background tick in the frontend
  (not the worker) that:

    1. Reads `navigator.storage.estimate()` for overall browser-storage
       usage. The estimate covers IDB + OPFS + Cache-API + ServiceWorker
       as one pool, so freeing IDB-backed asset files reduces it
       monotonically.
    2. If usage / quota > 80%, asks the db-worker which assets the
       server holds (`:thread-api/db-sync-evictable-asset-files`: synced
       graph, remote metadata, no pending asset op), stats their local
       copies via `window.pfs`, sorts by mtime ascending (LRU surrogate;
       assets are write-once), and deletes oldest-first until usage
       drops to the 60% target.

  Assets of local-only graphs and assets that were never uploaded are
  never candidates: the local copy is the only one. The trigger is the
  overall quota, which OPFS SQLite usually dominates, so a pass may free
  nothing; the tick then backs off instead of re-checking every 30 s.

  Evicted assets get re-downloaded on demand the next time a block
  renders them, via the existing VA1 lazy-load path (`asset-cp` asks for
  the asset, and `request-asset-download!` in
  `worker/sync/assets.cljs` refetches it once no local copy is left).
  The user sees a brief progress spinner, then the asset. Acceptable
  trade-off vs. unbounded cache growth.

  Lives under `frontend.hypha` to avoid an upstream patch. A future
  Phase 2 may consolidate this into `worker/sync/assets.cljs` as a
  synchronous pre-download hook; until then the reactive 30-second
  tick is sufficient for typical quotas (GB-range filesystems vs.
  MB-scale individual assets — one tick easily catches a 100 MB
  upload mid-flight).

  See `docs/hypha/phase-1.6.1-asset-cache.md` for design rationale and
  `docs/hypha/asset-lazy-loading.md` §2 for the VA2 finding this
  addresses.

  Public surface:
    start!         — idempotent; called once from frontend.hypha.init/start!
    <evict-until!  — pure-ish helper; exposed for unit testing
    <evict-pass!   — one check-and-evict pass with injected deps; exposed
                     for unit testing"
  (:require [frontend.state :as state]
            [lambdaisland.glogi :as log]
            [logseq.common.config :as common-config]
            [promesa.core :as p]))

(def ^:private ^:const evict-trigger-percent 0.8)
(def ^:private ^:const evict-target-percent 0.6)
(def ^:private ^:const tick-ms 30000)
(def ^:private ^:const nothing-freed-backoff-ms (* 10 60 1000))

(defn- <storage-estimate
  "Returns a promise of {:usage :quota} or nil when the Storage API
  is unavailable (older browsers, publishing builds)."
  []
  (when (and (exists? js/navigator)
             (some-> js/navigator .-storage .-estimate))
    (-> (.estimate (.-storage js/navigator))
        (p/then (fn [^js est]
                  {:usage (.-usage est)
                   :quota (.-quota est)}))
        (p/catch (constantly nil)))))

(defn- <stat-file
  "Returns {:path :mtime :size} for a file path, or nil on error
  or for non-file entries (directories etc.)."
  [^js pfs fpath]
  (-> (.stat pfs fpath)
      (p/then (fn [^js s]
                (when (= (.-type s) "file")
                  {:path fpath
                   :mtime (or (.-mtimeMs s) 0)
                   :size (or (.-size s) 0)})))
      (p/catch (constantly nil))))

(defn- asset-path
  "LightningFS path of an asset's local copy:
  `/<graph-name>/<local-assets-dir>/<uuid>.<ext>`."
  [{:keys [repo file-name]}]
  (str "/" (common-config/strip-leading-db-version-prefix repo)
       "/" common-config/local-assets-dir
       "/" file-name))

(defn- <evictable-asset-files
  "Asset-file metadata of the local copies the worker reports as safe to
  evict. Assets without a local copy (not downloaded yet) drop out at the
  stat."
  [^js pfs]
  (p/let [assets (state/<invoke-db-worker :thread-api/db-sync-evictable-asset-files)
          files (p/all (map #(<stat-file pfs (asset-path %)) assets))]
    (vec (remove nil? files))))

(defn- <try-unlink!
  "Resolves to the byte size freed by deleting `path` — either `size`
  on success or `0` on failure (logged but swallowed)."
  [^js pfs path size]
  (-> (.unlink pfs path)
      (p/then (fn [_]
                (log/info :hypha/asset-cache-evicted {:path path :size size})
                size))
      (p/catch (fn [e]
                 (log/warn :hypha/asset-cache-evict-failed
                           {:path path :error e})
                 0))))

(defn <evict-until!
  "Deletes asset files in mtime-ascending order until cumulative freed
  bytes reach `target-bytes-to-free`. Returns the actual bytes freed.

  Failures on individual `unlink` calls are logged and skipped — the
  loop continues with the next file. Exposed for unit testing;
  production callers go through `<evict-pass!`."
  [^js pfs files target-bytes-to-free]
  (let [sorted (sort-by :mtime files)]
    (p/loop [remaining sorted
             freed 0]
      (if (or (empty? remaining) (>= freed target-bytes-to-free))
        freed
        (let [{:keys [path size]} (first remaining)]
          (p/let [delta (<try-unlink! pfs path size)]
            (p/recur (rest remaining) (+ freed delta))))))))

(defn <evict-pass!
  "Single check-and-evict pass. Resolves the bytes freed, or nil when
  usage is below the trigger threshold or the Storage API is unavailable.

  `<estimate` resolves {:usage :quota}; `<files` resolves the evictable
  asset-file metadata for `pfs`. Exposed for unit testing."
  [^js pfs <estimate <files]
  (p/let [{:keys [usage quota]} (<estimate)]
    (when (and quota
               (pos? quota)
               (> (/ usage quota) evict-trigger-percent))
      (let [bytes-to-free (- usage (* quota evict-target-percent))]
        (p/let [files (<files pfs)
                freed (<evict-until! pfs files bytes-to-free)]
          (log/info :hypha/asset-cache-eviction-done
                    {:quota quota
                     :usage usage
                     :freed freed
                     :target-bytes-to-free bytes-to-free})
          freed)))))

(defonce ^:private *started? (atom false))
(defonce ^:private *running? (atom false))
(defonce ^:private *idle-until (atom 0))

(defn- tick!
  "Runs one pass unless the previous one is still in flight, a pass that
  freed nothing put the tick on backoff, or `window.pfs` / the db-worker
  are not up yet."
  []
  (let [pfs (some-> js/globalThis .-window .-pfs)]
    (when (and pfs
               @state/*db-worker
               (not @*running?)
               (>= (js/Date.now) @*idle-until))
      (reset! *running? true)
      (-> (<evict-pass! pfs <storage-estimate <evictable-asset-files)
          (p/then (fn [freed]
                    (when (and (some? freed) (zero? freed))
                      (reset! *idle-until (+ (js/Date.now) nothing-freed-backoff-ms)))))
          (p/catch (fn [e]
                     (log/warn :hypha/asset-cache-tick-failed
                               {:error e})))
          (p/finally (fn []
                       (reset! *running? false)))))))

(defn start!
  "Idempotent: starts the background eviction tick exactly once per
  session. Safe to call multiple times (re-calls no-op). The interval
  ID is intentionally not retained — the tick lives for the lifetime
  of the page and is cleared by the browser on unload."
  []
  (when (compare-and-set! *started? false true)
    (js/setInterval tick! tick-ms)))
