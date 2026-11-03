(ns proxx.runtime.routes.websearch
  "POST /api/tools/websearch. The handler injects /v1/responses attempts through
  the host app and falls back to Exa; every decision is in proxx.http.websearch."
  (:require [proxx.http.request :as http-request]
            [proxx.http.websearch :as ws]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

(defn- parse-json [text]
  (:value (http-request/parse-json-if-possible #(interop/js->data (js/JSON.parse %)) text)))

(defn- ^:async inject-attempt [^js app headers payload]
  (let [^js res (await (.inject app (clj->js {:method "POST" :url "/v1/responses" :headers headers :payload payload})))
        text (.-body res)]
    {:status (.-statusCode res) :text text :parsed (parse-json text)}))

(defn- ^:async run-attempts
  "Try each (model, domain placement) until one answers. Returns
  {:response r} or {:last-error e}."
  [^js app ^js log facts headers models]
  (loop [attempts (ws/attempt-order models)
         last-error nil]
    (if (empty? attempts)
      {:last-error last-error}
      (let [[model in-tool?] (first attempts)
            res (await (inject-attempt app headers (ws/responses-payload facts model in-tool?)))
            verdict (ws/attempt-verdict res model (:num-results facts))]
        (case (:kind verdict)
          :answer {:response (:response verdict)}
          :failed (recur (rest attempts) (:last-error verdict))
          :empty (do (.warn log #js {:model model :includeDomainsInTool in-tool?}
                            "OpenAI web_search returned empty output, falling back to Exa")
                     (recur (rest attempts) (:last-error verdict))))))))

(defn- ^:async exa-search [query num-results]
  (let [controller (js/AbortController.)
        timeout (js/setTimeout #(.abort controller) ws/exa-timeout-ms)]
    (try
      (let [^js response (await (js/fetch ws/exa-url
                                          #js {:method "POST"
                                               :headers (clj->js ws/exa-headers)
                                               :body (js/JSON.stringify (clj->js (ws/exa-request query num-results)))
                                               :signal (.-signal controller)}))]
        (js/clearTimeout timeout)
        (when-not (.-ok response)
          (throw (js/Error. (str "Exa search error (" (.-status response) "): " (await (.text response))))))
        (ws/exa-parse-event-stream (await (.text response)) #(interop/js->data (js/JSON.parse %))))
      (finally (js/clearTimeout timeout)))))

(defn- thrown-message
  "What the handler reports for a thrown value: an Error's message, else the value."
  [e]
  (cond (some? (ex-data e)) (ex-message e)
        (instance? js/Error e) (.-message e)
        :else e))

(defn- env [name] (aget js/process.env name))

(defn routes
  "deps: {:app host-fastify :config {:proxy-auth-token-fn f}}; the token is read
  per request."
  [{:keys [^js app proxy-auth-token-fn]}]
  [{:method :post :path "/api/tools/websearch"
    :handler
    (fn ^:async websearch [{:keys [body ^js raw]}]
      (let [{:keys [error query num-results] :as facts} (ws/parse-request body)]
        (if error
          error
          (let [models (ws/candidate-models (:requested-model facts) (env "OPEN_HAX_WEBSEARCH_FALLBACK_MODEL"))
                {:keys [response last-error]}
                (await (run-attempts app (.-log raw) facts (ws/request-headers (proxy-auth-token-fn)) models))]
            (if response
              {:body response}
              (let [exa (when (not= "false" (env "OPEN_HAX_WEBSEARCH_EXA_FALLBACK"))
                          (try {:answer (ws/exa-response (await (exa-search query num-results)) num-results)}
                               (catch :default e {:last-error (thrown-message e)})))]
                (if-let [answer (:answer exa)]
                  {:body answer}
                  (ws/failure-response (if exa (:last-error exa) last-error)))))))))}])

(defn register-websearch-routes-js [app ^js deps]
  (ring/register! app (routes {:app (.-app deps)
                               :proxy-auth-token-fn #(.-proxyAuthToken ^js (.-config deps))})))
