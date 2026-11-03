(ns proxx.runtime.routes.native-ollama
  "Ollama-native API routes: inject the translated OpenAI request into the host
  app (`deps.injectNativeBridge`) and translate the answer back."
  (:require [proxx.http.native-ollama :as native-ollama]
            [proxx.http.request :as http-request]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

(defn- parse-json [text]
  (:value (http-request/parse-json-if-possible #(interop/js->data (js/JSON.parse %)) text)))

(defn- route [^js deps path]
  {:method :post :path path
   :handler
   (fn ^:async native-route [{:keys [body ^js raw]}]
     (let [prefixes (vec (interop/js->data (.-ollamaModelPrefixes ^js (.-config deps))))
           {:keys [url payload]} (native-ollama/bridge-request path body prefixes)
           ^js injected (await ((.-injectNativeBridge deps) url (clj->js payload) (.-headers raw)))
           text (.-body injected)
           headers (interop/js->data (.-headers injected))]
       {:status (.-statusCode injected)
        :headers (native-ollama/copyable-headers headers)
        :body (native-ollama/response-body path {:headers headers :text text}
                                           (parse-json (if (nil? text) "null" text))
                                           (.toISOString (js/Date.)))}))})

(defn register-native-ollama-routes-js [app ^js deps]
  (ring/register! app (mapv #(route deps %) (keys native-ollama/endpoints))))
