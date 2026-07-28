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
    2. If usage / quota > 80%, enumerates asset files across every
       LightningFS graph root via `window.pfs`, sorts by mtime
       ascending (LRU surrogate; assets are write-once), and deletes
       oldest-first until usage drops to the 60% target.

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
    <evict-until!  — pure-ish helper; exposed for unit testing"
  (:require [lambdaisland.glogi :as log]
            [logseq.common.config :as common-config]
            [promesa.core :as p]))

(def ^:private ^:const evict-trigger-percent 0.8)
(def ^:private ^:const evict-target-percent 0.6)
(def ^:private ^:const tick-ms 30000)

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

(defn- <list-assets-under
  "Returns asset-file metadata under `<graph-root>/<local-assets-dir>`.
  Yields [] when the directory is absent."
  [^js pfs graph-root]
  (let [assets-dir (str graph-root "/" common-config/local-assets-dir)]
    (-> (p/let [^js entries (.readdir pfs assets-dir)
                files (p/all (map (fn [name']
                                    (<stat-file pfs (str assets-dir "/" name')))
                                  (array-seq entries)))]
          (vec (remove nil? files)))
        (p/catch (constantly [])))))

(defn- <all-asset-files
  "Enumerates asset files across every top-level graph dir visible to
  `window.pfs`. LightningFS uses one IDB database (`logseq`) with a
  Unix-style layout; graph roots are direct children of `/`."
  [^js pfs]
  (-> (p/let [^js entries (.readdir pfs "/")
              graph-roots (map #(str "/" %) (array-seq entries))
              per-graph (p/all (map (partial <list-assets-under pfs) graph-roots))]
        (vec (mapcat identity per-graph)))
      (p/catch (constantly []))))

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
  production callers should use the private `<maybe-evict!`."
  [^js pfs files target-bytes-to-free]
  (let [sorted (sort-by :mtime files)]
    (p/loop [remaining sorted
             freed 0]
      (if (or (empty? remaining) (>= freed target-bytes-to-free))
        freed
        (let [{:keys [path size]} (first remaining)]
          (p/let [delta (<try-unlink! pfs path size)]
            (p/recur (rest remaining) (+ freed delta))))))))

(defn- <maybe-evict!
  "Single check-and-evict pass. No-op when quota is comfortably below
  the trigger threshold or when `window.pfs` is not installed yet."
  []
  (p/let [estimate (<storage-estimate)]
    (when-let [{:keys [usage quota]} estimate]
      (when (and (pos? quota)
                 (> (/ usage quota) evict-trigger-percent))
        (let [target-usage (* quota evict-target-percent)
              bytes-to-free (- usage target-usage)
              pfs (some-> js/globalThis .-window .-pfs)]
          (when pfs
            (p/let [files (<all-asset-files pfs)
                    freed (<evict-until! pfs files bytes-to-free)]
              (log/info :hypha/asset-cache-eviction-done
                        {:quota quota
                         :usage usage
                         :freed freed
                         :target-bytes-to-free bytes-to-free}))))))))

(defonce ^:private *started? (atom false))

(defn start!
  "Idempotent: starts the background eviction tick exactly once per
  session. Safe to call multiple times (re-calls no-op). The interval
  ID is intentionally not retained — the tick lives for the lifetime
  of the page and is cleared by the browser on unload."
  []
  (when (compare-and-set! *started? false true)
    (let [tick (fn []
                 (-> (<maybe-evict!)
                     (p/catch (fn [e]
                                (log/warn :hypha/asset-cache-tick-failed
                                          {:error e})))))]
      (js/setInterval tick tick-ms))))
