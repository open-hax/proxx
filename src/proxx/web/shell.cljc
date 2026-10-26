(ns proxx.web.shell
  "App shell state: proxy token entry, fast-mode switch, theme, onboarding."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(defn init
  "`stored` is the localStorage mirror; `token` the saved proxy token."
  [stored token]
  {:token-input token
   :saved-token token
   :show-saved? false
   :fast-mode? false
   :fast-saving? false
   :fast-message nil
   ;; the onboarded flag is the bare string "true" (raw, not JSON)
   :show-onboarding? (and (not= (get stored storage/ls-onboarded) "true")
                          (str/blank? token))})

(defn theme [db] (st/stored db storage/ls-theme "monokai" storage/validate-theme))

(defn start [_db] [(fx/http (api/get-proxy-ui-settings) [:shell/settings-loaded] [:shell/settings-failed])])

(defn- shell-assoc [db & kvs] (apply update db :shell assoc kvs))

(defn- token-input [db [_ v]] [(shell-assoc db :token-input v) []])

(defn- save-token [db _]
  (let [t (str/trim (get-in db [:shell :token-input]))]
    [(shell-assoc db :saved-token t :show-saved? true)
     [[:token/save t] (fx/dispatch-later 2000 [:shell/hide-saved])]]))

(defn- hide-saved [db _] [(shell-assoc db :show-saved? false) []])

(defn- settings-loaded [db [_ settings]] [(shell-assoc db :fast-mode? (boolean (:fastMode settings))) []])
(defn- settings-failed [db [_ message]] [(shell-assoc db :fast-message message) []])

(defn- fast-toggle [db [_ next-value]]
  [(shell-assoc db :fast-mode? next-value :fast-saving? true :fast-message nil)
   [(fx/http (api/save-proxy-ui-settings {:fastMode next-value})
             [:shell/fast-saved] [:shell/fast-failed next-value])]])

(defn- fast-saved [db [_ saved]]
  (let [on? (boolean (:fastMode saved))]
    [(shell-assoc db :fast-mode? on? :fast-saving? false
                  :fast-message (if on?
                                  "Fast mode enabled for the current tenant."
                                  "Fast mode disabled for the current tenant."))
     []]))

(defn- fast-failed [db [_ attempted message]]
  [(shell-assoc db :fast-mode? (not attempted) :fast-saving? false :fast-message message) []])

(defn- set-theme [db [_ v]]
  (st/set-stored db storage/ls-theme (or (storage/validate-theme v) "monokai")))

(defn- dismiss-onboarding [db _]
  (let [t (str/trim (get-in db [:shell :token-input]))
        db' (cond-> (-> (shell-assoc db :show-onboarding? false)
                        (assoc-in [:stored storage/ls-onboarded] "true"))
              (seq t) (shell-assoc :saved-token t))]
    [db' (cond-> [[:storage/write-raw storage/ls-onboarded "true"]]
           (seq t) (conj [:token/save t]))]))

(defn- close-onboarding [db _] [(shell-assoc db :show-onboarding? false) []])

(def handlers
  {:shell/token-input token-input
   :shell/save-token save-token
   :shell/hide-saved hide-saved
   :shell/settings-loaded settings-loaded
   :shell/settings-failed settings-failed
   :shell/fast-toggle fast-toggle
   :shell/fast-saved fast-saved
   :shell/fast-failed fast-failed
   :shell/set-theme set-theme
   :shell/dismiss-onboarding dismiss-onboarding
   :shell/close-onboarding close-onboarding})

(defn view-model [db]
  (let [{:keys [token-input saved-token show-saved?] :as s} (:shell db)
        unsaved? (not= (str/trim token-input) (str/trim saved-token))
        stored? (not (str/blank? saved-token))]
    (assoc s
           :theme (theme db)
           :unsaved? unsaved?
           :hint (cond
                   show-saved? "Token saved in browser storage."
                   stored? (if unsaved? "Unsaved changes." "Token is stored for this browser.")
                   :else "No token set (works only if proxy allows unauthenticated access).")
           :onboarding-cta (if (seq (str/trim token-input)) "Save & Continue" "Skip for now"))))
