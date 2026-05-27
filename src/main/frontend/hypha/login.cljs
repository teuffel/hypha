(ns frontend.hypha.login
  "Hypha access-code login modal.

  Opened by Patch #1 in `frontend.handler.events.ui` when `:user/login` is
  dispatched in Hypha mode. Replaces the Cognito modal from
  `frontend.components.user.login` for self-hosted setups.

  Flow:
    - User types the access code into a single input.
    - Submit → POST /auth/login with `{ \"code\": <code> }`.
    - 200 → store the returned JWT in memory via
      `frontend.hypha.init/set-hypha-id-token!`, close the modal.
    - 401 → show an inline error, keep the modal open.
    - Network/other → show an inline error, keep the modal open.

  See `docs/hypha/phase-1-plan.md` section 4.6 step 1."
  (:require [cljs-http.client :as http]
            [cljs.core.async :refer [<! go]]
            [clojure.string :as string]
            [frontend.context.i18n :refer [t]]
            [frontend.hypha.init :as hypha-init]
            [logseq.shui.ui :as shui]
            [rum.core :as rum]))

(defn- <login
  "POST /auth/login with the supplied access code. Returns the cljs-http
   response map."
  [code]
  (http/post "/auth/login"
             {:json-params {:code code}
              :with-credentials? true}))

(rum/defcs modal-inner < (rum/local "" ::code)
                         (rum/local nil ::error)
                         (rum/local false ::submitting?)
  [state]
  (let [*code (::code state)
        *error (::error state)
        *submitting? (::submitting? state)
        submit!
        (fn submit! []
          (when-not (or @*submitting? (string/blank? @*code))
            (reset! *submitting? true)
            (reset! *error nil)
            (go
              (let [resp (<! (<login @*code))]
                (reset! *submitting? false)
                (cond
                  (= 200 (:status resp))
                  (when-let [id-token (get-in resp [:body :id-token])]
                    (hypha-init/set-hypha-id-token! id-token)
                    (shui/dialog-close!))

                  (= 401 (:status resp))
                  (reset! *error (t :hypha.login/invalid-code))

                  :else
                  (reset! *error (t :hypha.login/network-error)))))))]
    [:form.cp__hypha-login.flex.flex-col.gap-3.p-2
     {:on-submit (fn [e]
                   (.preventDefault e)
                   (submit!))}
     (shui/input
      {:type "password"
       :autoFocus true
       :disabled @*submitting?
       :value @*code
       :on-change #(reset! *code (.. % -target -value))
       :placeholder (t :hypha.login/access-code-placeholder)})
     (when @*error
       [:div.text-sm.text-error @*error])
     (shui/button
      {:type "submit"
       :disabled (or @*submitting? (string/blank? @*code))}
      (t :ui/login))]))

(defn open-login-modal!
  "Public entry point invoked by Patch #1."
  []
  (shui/dialog-open!
   (fn [_close] (modal-inner))
   {:label :hypha-login
    :title (t :ui/login)}))
