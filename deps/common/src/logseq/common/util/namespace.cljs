(ns logseq.common.util.namespace
  "Util fns for namespace and parent features"
  (:require [clojure.string :as string]
            [logseq.common.util :as common-util]))

;; Only used by DB graphs
(defonce parent-char "/")
(defonce parent-re #"/")
;; Used by DB and file graphs
(defonce namespace-char "/")

;; HYPHA-PATCH (literal-slash titles): build flag set true by Hypha builds via
;; --config-merge '{:closure-defines {logseq.common.util.namespace/HYPHA-LITERAL-SLASH true}}'.
;; When true, "/" is a LITERAL character in page titles and namespaces are never
;; derived by splitting a title string; hierarchy is created only via the
;; explicit :block/parent relation. This neutralizes title->namespace splitting
;; AND [[ref]] prefix-expansion in one place, because namespace-page? is the
;; central predicate both rely on. Default false keeps stock Logseq unchanged.
(goog-define HYPHA-LITERAL-SLASH false)
(defonce literal-slash?
  HYPHA-LITERAL-SLASH)

(defn namespace-page?
  "Used by DB and file graphs"
  [page-name]
  (and (not literal-slash?)
       (string? page-name)
       (string/includes? page-name namespace-char)
       (not= (string/trim page-name) namespace-char)
       (not (string/starts-with? page-name "../"))
       (not (string/starts-with? page-name "./"))
       (not (common-util/url? page-name))))

(defn get-last-part
  "Get last part of a namespace page"
  [page-name]
  (if (namespace-page? page-name)
    (last (string/split page-name parent-char))
    page-name))
