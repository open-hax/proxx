(ns proxx.runtime.ollama-cloud-probe
  "JS edge for src/lib/ollama-cloud-probe.ts: finds the account, calls Ollama
  Cloud with a timeout and returns the result built by proxx.ollama.cloud-probe."
  (:require [proxx.compat.ollama :as ollama]
            [proxx.jsval :as jv]
            [proxx.ollama.cloud-probe :as probe]
            [proxx.runtime.interop :as interop]))

(defn- ^:async find-account [^js credential-store provider-id account-id]
  (let [providers (await (.listProviders credential-store true))
        ^js provider (.find providers (fn [^js p] (= provider-id (.-id p))))]
    (when provider
      (.find (.-accounts provider) (fn [^js a] (and (= account-id (.-id a)) (= "api_key" (.-authType a))))))))

(defn- thrown-message [e]
  (cond (some? (ex-data e)) (ex-message e)
        (instance? js/Error e) (.-message e)
        :else (str e)))

(defn ^:async probe-ollama-cloud-account-js
  [credential-store ^js options]
  (let [fetch-fn (or (.-fetchFn options) js/fetch)
        tested-at (.toISOString (js/Date.))
        model (probe/probe-model (.-model options))
        provider-id (.-providerId options)
        ^js account (await (find-account credential-store provider-id (.-accountId options)))]
    (when-not account
      (throw (js/Error. (str "Ollama Cloud account not found: " (.-accountId options)))))
    (let [view (interop/js->data account)
          api-key (some-> (.-secret account) jv/trim)
          result (fn [message status code] (clj->js (probe/error-result provider-id view tested-at model message status code)))]
      (if-not (seq api-key)
        (result "Missing API key." 401 "missing_api_key")
        (let [controller (js/AbortController.)
              timeout (js/setTimeout #(.abort controller) probe/timeout-ms)]
          (try
            (let [^js response (await (fetch-fn (probe/endpoint (.-baseUrl options))
                                                #js {:method "POST"
                                                     :headers (clj->js (probe/request-headers api-key))
                                                     :body (js/JSON.stringify (clj->js (probe/probe-payload model)))
                                                     :signal (.-signal controller)}))
                  text (await (.text response))]
              (if-not (.-ok response)
                (result (probe/error-message (.-status response) text) (.-status response) (probe/error-code text))
                (let [payload (try {:value (if (pos? (count text)) (js/JSON.parse text) #js {})}
                                   (catch :default e {:invalid (thrown-message e)}))]
                  (if-let [message (:invalid payload)]
                    (result (str "Invalid Ollama Cloud response: " message) (.-status response) nil)
                    (try
                      (let [completion (ollama/ollama->chat-completion (interop/js->data (:value payload)) model (js/Date.now))]
                        (clj->js (probe/ok-result provider-id view tested-at model (probe/completion-text completion)
                                                  (.-status response))))
                      (catch :default e (result (thrown-message e) (.-status response) nil)))))))
            (catch :default e
              (result (if (and (instance? js/Error e) (= "AbortError" (.-name e)))
                        "Ollama Cloud probe timed out."
                        (thrown-message e))
                      nil nil))
            (finally (js/clearTimeout timeout))))))))
