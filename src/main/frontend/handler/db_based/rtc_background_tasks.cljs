(ns frontend.handler.db-based.rtc-background-tasks
  "Background tasks related to RTC"
  (:require [cljs-time.core :as t]
            [frontend.common.missionary :as c.m]
            [frontend.config :as config]
            [frontend.db :as db]
            [frontend.handler.db-based.rtc-flows :as rtc-flows]
            [frontend.handler.db-based.sync :as rtc-handler]
            [frontend.state :as state]
            [lambdaisland.glogi :as log]
            [logseq.common.util :as common-util]
            [logseq.db :as ldb]
            [missionary.core :as m])
  (:import [missionary Cancelled]))

(defn- run-background-task-when-not-publishing
  [key' task]
  (when-not config/publishing?
    (c.m/run-background-task key' task)))

(run-background-task-when-not-publishing
 ;; try to restart rtc-loop when possible,
 ;; triggered by `rtc-flows/rtc-try-restart-flow`
 ::restart-rtc-to-reconnect
 (m/reduce
  (constantly nil)
  (m/ap
    (let [{:keys [graph-uuid t]} (m/?> rtc-flows/rtc-try-restart-flow)]
      (when (and graph-uuid t
                 (= graph-uuid (ldb/get-graph-rtc-uuid (db/get-db)))
                 (> 5000 (- (common-util/time-ms) t)))
        (log/info :trying-to-restart-rtc graph-uuid :t (t/now))
        (c.m/<? (rtc-handler/<rtc-start! (state/get-current-repo) :stop-before-start? false)))))))

(run-background-task-when-not-publishing
 ;; stop rtc when [user-logout]
 ::stop-rtc-if-needed
 (m/reduce
  (constantly nil)
  (m/ap
    (m/?> rtc-flows/logout-flow)
    (log/info :try-to-stop-rtc-if-needed :logout)
    (c.m/<? (rtc-handler/<rtc-stop!)))))

(run-background-task-when-not-publishing
 ;; auto-start rtc when [user-login graph-switch]
 ::auto-start-rtc-if-possible
 (m/reduce
  (constantly nil)
  (m/ap
    (let [[start-reason repo] (m/?> rtc-flows/trigger-start-rtc-flow)]
      (log/info :try-to-start-rtc [start-reason repo])
      ;; HYPHA-PATCH-024: one failed start (expired token while offline, a
      ;; lost session) must not end this task: it is the only thing that
      ;; starts sync on later logins, graph switches and reconnects.
      (try
        (c.m/<? (rtc-handler/<rtc-start! (or repo (state/get-current-repo))))
        (catch Cancelled e
          (throw e))
        (catch :default e
          (log/error :rtc-start-failed {:start-reason start-reason :repo repo :error e})))))))
