(ns proxx.web.pages.images
  "Images page: request construction, response shaping, state transitions."
  (:require [clojure.string :as str]
            [proxx.json :as json]
            [proxx.web.api :as api]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(def default-model "gpt-image-1")
(def default-prompt "A studio photo of a cat astronaut, 35mm, ultra-detailed.")

(defn model [db] (st/stored db storage/ls-images-model default-model storage/validate-string))
(defn prompt [db] (st/stored db storage/ls-images-prompt default-prompt storage/validate-string))

(defn init [] {:urls [] :raw "" :sending? false :error nil})

(defn request-body [model prompt]
  {:model model :prompt prompt :response_format "b64_json"})

(defn extract-images
  "Image sources in an images/generations payload: base64 -> data URL, else url."
  [payload]
  (let [data (when (map? payload) (get payload "data"))]
    (into []
          (keep (fn [item]
                  (when (map? item)
                    (let [b64 (let [v (get item "b64_json")] (if (string? v) (str/trim v) ""))
                          url (let [v (get item "url")] (if (string? v) (str/trim v) ""))]
                      (cond (seq b64) (str "data:image/png;base64," b64)
                            (seq url) url)))))
          (when (sequential? data) data))))

(defn pretty-json [payload]
  #?(:cljs (js/JSON.stringify (clj->js payload) nil 2) :clj (pr-str payload)))

(defn- model-changed [db [_ v]] (st/set-stored db storage/ls-images-model v))
(defn- prompt-changed [db [_ v]] (st/set-stored db storage/ls-images-prompt v))

(defn- submit [db _]
  (let [p (str/trim (prompt db))
        m (str/trim (model db))
        {:keys [sending?]} (st/page-slice db :images)]
    (if (or sending? (str/blank? p) (str/blank? m))
      [db []]
      [(st/update-page db :images assoc :sending? true :error nil :urls [] :raw "")
       [(fx/http (api/run-image-generation (request-body m p)) [:images/done] [:images/failed])]])))

(defn- done [db [_ payload]]
  [(st/update-page db :images assoc :sending? false :raw (pretty-json payload) :urls (extract-images payload)) []])

(defn- failed [db [_ message]]
  [(st/update-page db :images assoc :sending? false :error message) []])

(def page
  {:init init
   :handlers {:images/model-changed model-changed
              :images/prompt-changed prompt-changed
              :images/submit submit
              :images/done done
              :images/failed failed}})

(defn view-model [db]
  (let [{:keys [urls raw sending? error]} (st/page-slice db :images)]
    {:model (model db) :prompt (prompt db) :urls urls :raw raw :sending? sending? :error error
     :button-label (if sending? "Generating…" "Generate")
     :no-data? (and (not sending?) (nil? error) (empty? urls) (seq raw) true)
     :waiting? (and sending? (empty? raw))}))
