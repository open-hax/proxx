(ns proxx.runtime.embeddings
  "JS edge for the embedding backends: fetch with a timeout, decisions in
  proxx.embeddings.providers."
  (:require [proxx.embeddings.providers :as providers]
            [proxx.runtime.interop :as interop]))

(defn load-embeddings-config-js []
  (let [env (reduce (fn [m k] (assoc m k (aget js/process.env k))) {} (js/Object.keys js/process.env))]
    (clj->js (providers/embeddings-config env))))

(defn- ^:async embed [provider cfg req]
  (let [cfg-data (interop/js->data cfg)
        req-data (interop/js->data req)
        {:keys [url headers body]} (providers/request provider cfg-data req-data)
        ^js res (await (js/fetch url #js {:method "POST" :headers (clj->js headers)
                                          :body (js/JSON.stringify (clj->js body))
                                          :signal (js/AbortSignal.timeout (providers/timeout-ms cfg-data req-data))}))]
    (when-not (.-ok res)
      (throw (js/Error. (providers/error-message provider (.-status res) (await (.text res))))))
    (let [data (interop/js->data (await (.json res)))]
      (try (clj->js (providers/response provider req-data data))
           (catch :default e (throw (if (ex-data e) (js/TypeError. (ex-message e)) e)))))))

(defn embed-with-ollama-js [cfg req] (embed "ollama" cfg req))
(defn embed-with-hf-cloud-js [cfg req] (embed "huggingface-cloud" cfg req))
(defn embed-with-tei-js [cfg req] (embed "tei" cfg req))
(defn embed-with-ovm-npu-js [cfg req] (embed "ovm-npu" cfg req))
