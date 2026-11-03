(ns proxx.runtime.ollama-native
  "JS edge for src/lib/ollama-native.ts: JS in, JS out, the clock and digest
  source supplied here."
  (:require [proxx.compat.ollama-native :as native]
            [proxx.runtime.interop :as interop]))

(defn- now-iso [] (.toISOString (js/Date.)))

(defn- in [x] (interop/js->data x))

(defn native-chat-to-openai-request-js [body] (clj->js (native/native-chat->openai-request (in body))))
(defn native-generate-to-chat-request-js [body] (clj->js (native/native-generate->chat-request (in body))))
(defn chat-completion-to-native-chat-js [response] (clj->js (native/chat-completion->native-chat (in response) (now-iso))))
(defn chat-completion-to-native-generate-js [response] (clj->js (native/chat-completion->native-generate (in response) (now-iso))))
(defn native-embed-to-openai-request-js [body] (clj->js (native/native-embed->openai-request (in body))))
(defn native-embed-to-ollama-request-js [body default-num-ctx]
  (clj->js (native/native-embed->ollama-request (in body) (when (number? default-num-ctx) default-num-ctx))))
(defn openai-embeddings-to-native-embed-js [response] (clj->js (native/openai-embeddings->native-embed (in response))))
(defn openai-embeddings-to-native-embeddings-js [response] (clj->js (native/openai-embeddings->native-embeddings (in response))))
(defn native-embed-response-to-openai-embeddings-js [response model]
  (clj->js (native/native-embed-response->openai-embeddings (in response) model)))

(defn model-ids-to-native-tags-js [model-ids new-digest]
  (clj->js (native/model-ids->native-tags (in model-ids) (now-iso) new-digest)))
