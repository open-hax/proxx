(ns proxx.strategy.context
  "Derive the facts a request is routed by from the routing state, the request
  surface and the proxy configuration: which provider id the request is for,
  whether the client wants a stream and how long one attempt may take, and whether
  the request is OpenAI-prefixed. Pure; the model rewrite for `auto:*` and the
  hosted-OpenAI-family test are supplied by the caller."
  (:require [proxx.compat.reasoning :as reasoning]))

(defn derive-facts
  "`in`: `{:surface \"chat\"|\"responses-passthrough\"|\"images-passthrough\"
  :routing {:factory-prefixed :open-ai-prefixed :explicit-ollama :local-ollama}
  :request-body :hosted-openai-family? :config {:request-timeout-ms
  :stream-bootstrap-timeout-ms :upstream-provider-id :openai-provider-id}}`."
  [{:keys [surface routing request-body hosted-openai-family? config]}]
  (let [chat? (= "chat" surface)
        responses? (= "responses-passthrough" surface)
        images? (= "images-passthrough" surface)
        {:keys [factory-prefixed open-ai-prefixed explicit-ollama local-ollama]} routing
        {:keys [request-timeout-ms stream-bootstrap-timeout-ms upstream-provider-id openai-provider-id]} config
        stream? (if images? false (= true (get request-body "stream")))]
    {:route-provider-id (cond factory-prefixed "factory"
                              open-ai-prefixed openai-provider-id
                              (and chat? (or explicit-ollama local-ollama)) "ollama"
                              :else upstream-provider-id)
     :client-wants-stream stream?
     :needs-reasoning-trace (boolean (and chat? (reasoning/wants-reasoning-trace? request-body)))
     :upstream-attempt-timeout-ms (if stream? (min request-timeout-ms stream-bootstrap-timeout-ms) request-timeout-ms)
     :explicit-ollama (boolean (and chat? explicit-ollama))
     :local-ollama (boolean (and chat? local-ollama))
     :open-ai-prefixed (boolean (if responses?
                                  (or open-ai-prefixed
                                      (and (not factory-prefixed) (= upstream-provider-id openai-provider-id) hosted-openai-family?))
                                  open-ai-prefixed))
     :responses-passthrough responses?
     :images-passthrough images?}))
