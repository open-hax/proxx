(ns proxx.runtime.ollama
  "JS edge for Ollama compat (src/lib/ollama-compat.ts) and the reasoning-trace
  check it depends on (src/lib/openai/request-handling.ts). Domain errors are
  rethrown as plain Errors; the stream reader loop (bytes in, SSE strings out)
  lives here, the decisions in proxx.compat.ollama."
  (:require [clojure.string :as str]
            [proxx.compat.ollama :as ollama]
            [proxx.compat.reasoning :as reasoning]))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn should-use-ollama-upstream-js [model prefixes]
  (ollama/should-use-ollama-upstream? model (js->clj prefixes)))

(defn chat-request-to-ollama-request-js [body model-prefixes]
  (try
    (clj->js (ollama/chat-request->ollama-request (js->clj body) (js->clj model-prefixes)))
    (catch :default e (rethrow-as-error e))))

(defn request-has-explicit-num-ctx-js [body]
  (try (ollama/explicit-num-ctx? (js->clj body))
       (catch :default e (rethrow-as-error e))))

(defn ollama-to-chat-completion-js [response-body fallback-model]
  (try
    (clj->js (ollama/ollama->chat-completion (js->clj response-body) fallback-model (js/Date.now)))
    (catch :default e (rethrow-as-error e))))

(defn request-wants-reasoning-trace-js [body]
  (reasoning/wants-reasoning-trace? (js->clj body)))

(defn ^:async stream-ollama-ndjson-to-chat-completion-sse-js
  "Read an Ollama NDJSON byte stream and write OpenAI chat-completion SSE strings
  through `write-fn`, ending with `[DONE]` exactly once."
  [body fallback-model write-fn]
  (let [reader (js-invoke body "getReader")
        decoder (js/TextDecoder.)
        ctx {:stream-id (str "chatcmpl_ollama_" (js/Date.now))
             :fallback-model fallback-model
             :now-ms (js/Date.now)}
        feed (fn [state line]
               (let [{:keys [state events]} (ollama/process-line state line (assoc ctx :now-ms (js/Date.now)))]
                 (run! write-fn events)
                 state))]
    (let [final
          (try
            (loop [state ollama/initial-stream-state buffer ""]
              (let [result (await (js-invoke reader "read"))
                    done? (aget result "done")
                    text (js-invoke decoder "decode" (aget result "value") #js {:stream (not done?)})
                    [lines remainder] (ollama/split-lines (str buffer text))
                    state (reduce feed state lines)]
                (if done?
                  (if (str/blank? remainder) state (feed state remainder))
                  (recur state remainder))))
            (finally (js-invoke reader "releaseLock")))]
      (when-not (:sent-done? final)
        (write-fn ollama/done-event)))))
