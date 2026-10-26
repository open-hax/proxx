(ns proxx.http.native-ollama
  "Ollama-native routes (/api/chat, /api/generate, /api/embed, /api/embeddings)
  (src/routes/native-ollama.ts). Each is a translation: native request ->
  OpenAI request injected into the host app -> OpenAI response translated back
  when it is the JSON shape we expect, passed through untouched otherwise.
  Pure over wire data; the injection and the clock are the edge's."
  (:require [clojure.string :as str]
            [proxx.compat.ollama-native :as native]
            [proxx.jsval :as jv]))

(defn has-model-prefix? [model prefixes]
  (let [m (jv/lower model)]
    (boolean (some #(and (seq %) (str/starts-with? m (jv/lower %))) prefixes))))

(defn- native-ollama-model-prefix [prefixes]
  (or (some #(when (re-matches #"(?i)ollama(?:/|:)" (jv/trim %)) %) prefixes) "ollama/"))

(defn with-provider-scope
  "Put the model under the ollama provider prefix unless it already has one."
  [body prefixes]
  (let [model (let [m (get body "model")] (if (string? m) (jv/trim m) ""))]
    (if (or (empty? model) (has-model-prefix? model prefixes))
      body
      (assoc body "model" (str (native-ollama-model-prefix prefixes) model)))))

(def ^:private chat-completions "/v1/chat/completions")
(def ^:private embeddings "/v1/embeddings")

(def endpoints
  "native path -> how to bridge it. `:guard` is the field a translatable
  response must carry as an array."
  {"/api/chat" {:upstream chat-completions :guard "choices"
                :request (fn [body _] (native/native-chat->openai-request body))
                :response native/chat-completion->native-chat}
   "/api/generate" {:upstream chat-completions :guard "choices"
                    :request (fn [body _] (native/native-generate->chat-request body))
                    :response native/chat-completion->native-generate}
   "/api/embed" {:upstream embeddings :guard "data"
                 :request (fn [body prefixes] (native/native-embed->openai-request (with-provider-scope body prefixes)))
                 :response (fn [parsed _] (native/openai-embeddings->native-embed parsed))}
   "/api/embeddings" {:upstream embeddings :guard "data"
                      :request (fn [body prefixes] (native/native-embed->openai-request (with-provider-scope body prefixes)))
                      :response (fn [parsed _] (native/openai-embeddings->native-embeddings parsed))}})

(defn bridge-request
  "{:url :payload} to inject for a native request body."
  [path body prefixes]
  (let [{:keys [upstream request]} (get endpoints path)
        body (or (jv/rec body) {})]
    {:url upstream :payload (request body prefixes)}))

(defn copyable-headers
  "Injected response headers worth copying: defined, and not content-length (the
  translated body has its own)."
  [headers]
  (into {} (remove (fn [[k v]] (or (nil? v) (= "content-length" (str/lower-case k))))) headers))

(defn response-body
  "What to send for the injected `{:headers :text}` response: the translated
  native body when it is a JSON object carrying the guard array, else the text."
  [path {:keys [headers text]} parsed now-iso]
  (let [{:keys [guard response]} (get endpoints path)
        content-type (str (let [ct (get headers "content-type")] (if (nil? ct) "application/json" ct)))]
    (if (and (str/includes? (str/lower-case content-type) "application/json")
             (map? parsed)
             (sequential? (get parsed guard)))
      (response parsed now-iso)
      text)))
