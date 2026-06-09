(ns frontend.components.graph-rebind
  "HYPHA-PATCH-013: name-collision resolve dialog.

  Opens when a user tries to upload a local-only graph whose name is
  already taken by a remote graph (typically because they signed into a
  fresh browser, created/imported a local copy, and tried to push it
  back to a cloud server that already has it). Offers a single
  data-preserving action — bind this local graph to the existing
  remote — plus cancel. No upload happens; the rebind only writes the
  KV identity bindings, then RTC's normal merge logic reconciles the
  client_ops with the server.

  Lives in its own namespace to keep `components/repo.cljs` from
  growing further and to make the patch surface clear."
  (:require [clojure.string :as string]
            [frontend.context.i18n :refer [t]]
            [frontend.handler.db-based.sync :as rtc-handler]
            [frontend.handler.notification :as notification]
            [lambdaisland.glogi :as log]
            [logseq.shui.ui :as shui]
            [promesa.core :as p]
            [io.factorhouse.hsx.core :as hsx]))

(defn- format-remote-updated-at
  [updated-at]
  (when (number? updated-at)
    (try
      (.toLocaleString (js/Date. updated-at))
      (catch :default _ nil))))

(defn- short-graph-id
  [graph-id]
  (when (string? graph-id)
    (subs graph-id 0 (min 8 (count graph-id)))))

(hsx/defc graph-already-exists-dialog
  [{:keys [repo graph-name remote-graph-id remote-graph-e2ee? remote-updated-at]}]
  (let [updated-at-str (format-remote-updated-at remote-updated-at)
        short-id (short-graph-id remote-graph-id)]
    [:div.p-2.flex.flex-col.gap-4
     [:div.text-xl.font-medium (t :graph.rebind/title)]
     [:div.text-sm.opacity-80 (t :graph.rebind/desc graph-name)]
     [:div.text-xs.opacity-70.flex.flex-col.gap-1.bg-gray-02.rounded.p-2
      [:div (str (t :graph.rebind/remote-id-label) " " (or short-id "—") "…")]
      (when updated-at-str
        [:div (str (t :graph.rebind/remote-updated-at-label) " " updated-at-str)])
      [:div (str (t :graph.rebind/remote-e2ee-label) " "
                 (if remote-graph-e2ee?
                   (t :graph.rebind/remote-e2ee-on)
                   (t :graph.rebind/remote-e2ee-off)))]]
     [:div.flex.flex-row.gap-2.justify-end
      (shui/button
       {:variant :outline
        :on-click #(shui/dialog-close!)}
       (t :ui/cancel))
      (shui/button
       {:variant :default
        :on-click
        (fn []
          (shui/dialog-close!)
          (-> (rtc-handler/<rtc-rebind-to-remote!
               repo remote-graph-id (boolean remote-graph-e2ee?))
              (p/then (fn [_]
                        (notification/show!
                         (t :graph.rebind/success graph-name)
                         :success)))
              (p/catch (fn [e]
                         (log/error :graph.rebind/failed
                                    {:repo repo
                                     :remote-graph-id remote-graph-id
                                     :error e})
                         (notification/show!
                          (t :graph.rebind/error
                             (or (some-> e ex-message)
                                 (str e)))
                          :error)))))}
       (t :graph.rebind/connect-action))]
     (when (and (string? remote-graph-id)
                (not (string/blank? remote-graph-id)))
       [:div.text-xs.opacity-50 (t :graph.rebind/footer-hint)])]))
