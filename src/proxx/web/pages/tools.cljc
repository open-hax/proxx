(ns proxx.web.pages.tools
  "Tools + MCP page: state transitions and view-model (pure)."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(def default-model "gpt-5.3-codex")

(defn model [db] (st/stored db storage/ls-tools-model default-model storage/validate-string))

(defn effective-model
  "Trimmed model, or the default when blank."
  [db]
  (let [m (str/trim (model db))] (if (str/blank? m) default-model m)))

(defn init [] {:tools [] :servers [] :error nil})

(defn- refresh-fx [db]
  (let [m (effective-model db)]
    [(fx/http-all [(api/list-tool-seeds m) (api/list-mcp-seeds)]
                  [:tools/loaded m] [:tools/failed m])]))

(defn enter [db] [db (refresh-fx db)])

(defn- model-changed [db [_ value]]
  (let [[db' fx*] (st/set-stored db storage/ls-tools-model value)]
    [db' (into fx* (refresh-fx db'))]))

(defn- submit [db _] [(st/assoc-page db :tools :error nil) (refresh-fx db)])

(defn- loaded [db [_ for-model [tools servers]]]
  ;; Ignore responses for a model the user has since edited away from.
  (if (= for-model (effective-model db))
    [(st/update-page db :tools assoc :tools tools :servers servers) []]
    [db []]))

(defn- failed [db [_ for-model message]]
  (if (= for-model (effective-model db))
    [(st/assoc-page db :tools :error message) []]
    [db []]))

(def page
  {:init init
   :enter enter
   :handlers {:tools/model-changed model-changed
              :tools/submit submit
              :tools/loaded loaded
              :tools/failed failed}})

(defn view-model [db]
  (let [{:keys [tools servers error]} (st/page-slice db :tools)]
    {:model (model db)
     :error error
     :tools (mapv (fn [{:keys [id description enabled]}]
                    {:id id :description description
                     :card-variant (if enabled "default" "outlined")
                     :badge-variant (if enabled "success" "warning")
                     :badge-text (if enabled "enabled" "disabled")})
                  tools)
     :servers (mapv (fn [{:keys [id script cwd port sourceFile running]}]
                      {:id id
                       :badge-variant (if running "success" "default")
                       :badge-text (if running "running" "seeded")
                       :cwd-line (str "cwd: " (or cwd "(none)"))
                       :script-line (str "script: " script)
                       :port-line (when (number? port) (str "port: " port))
                       :source-file sourceFile})
                    servers)}))
