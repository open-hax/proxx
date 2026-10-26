(ns proxx.ollama.cloud-probe
  "Live probe of an Ollama Cloud account (src/lib/ollama-cloud-probe.ts): the
  request it sends, how an error answer is read, and the shape of the result.
  Pure over wire data; the HTTP call, timeout and clock are the edge's."
  (:require [clojure.string :as str]
            [proxx.json :as json]
            [proxx.jsval :as jv]))

(def timeout-ms 30000)
(def default-model "gemma4:31b")
(def expected-text "hello")

(defn- omap [& kvs]
  (apply array-map (into [] (comp (partition-all 2) (remove (fn [[_ v]] (nil? v))) cat) kvs)))

(defn- try-parse [text]
  (try {:value (json/parse text)} (catch #?(:clj Exception :cljs :default) _ nil)))

(defn- record [x] (cond (map? x) x (sequential? x) {}))

(defn error-message
  "A short human message for a failed probe answer: the provider's own message
  (message, error.message, detail), else the text (truncated), else \"HTTP <status>\"."
  [status text]
  (let [trimmed (jv/trim text)]
    (if (empty? trimmed)
      (str "HTTP " status)
      (let [parsed (:value (try-parse trimmed))
            p (record parsed)
            error (record (get p "error"))
            message (when p
                      (jv/first-non-nil (jv/as-string (get p "message"))
                                        (when error (jv/as-string (get error "message")))
                                        (jv/as-string (get p "detail"))))]
        (cond
          (and message (seq (jv/trim message))) (jv/trim message)
          (> (count trimmed) 160) (str (subs trimmed 0 157) "...")
          :else trimmed)))))

(defn error-code
  "The lower-cased error code in an error answer, or nil."
  [text]
  (let [trimmed (jv/trim text)]
    (when (seq trimmed)
      (when-let [{:keys [value]} (try-parse trimmed)]
        (when-let [p (record value)]
          (let [error (record (get p "error"))
                code (some-> (jv/first-non-nil (when error (jv/as-string (get error "code")))
                                               (jv/as-string (get p "code")))
                             jv/trim jv/lower)]
            (when (seq code) code)))))))

(defn probe-payload [model]
  (array-map "model" model
             "messages" [(array-map "role" "user" "content" "Reply with exactly hello.")]
             "stream" false
             "think" false))

(defn completion-text
  "The trimmed assistant text of the first choice, or \"\"."
  [completion]
  (let [choice (first (get completion "choices"))
        message (when (map? choice) (get choice "message"))
        content (when (map? message) (jv/as-string (get message "content")))]
    (if content (jv/trim content) "")))

(defn- identity-fields [provider-id account]
  ["providerId" provider-id
   "accountId" (get account "id")
   "displayName" (get account "displayName")
   "email" (get account "email")
   "planType" (get account "planType")
   "chatgptAccountId" (get account "chatgptAccountId")])

(defn error-result
  [provider-id account tested-at model message upstream-status code]
  (apply omap (concat (identity-fields provider-id account)
                      ["testedAt" tested-at "model" model "expectedText" expected-text
                       "status" "error" "ok" false "matchesExpectedOutput" false
                       "upstreamStatus" upstream-status "errorCode" code "message" message])))

(defn ok-result
  [provider-id account tested-at model output-text upstream-status]
  (let [matches? (= (str/lower-case output-text) expected-text)
        message (cond matches? (str "Live — replied with " (json/write (if (seq output-text) output-text expected-text)) ".")
                      (seq output-text) (str "Live — replied with " (json/write output-text) ".")
                      :else "Live — request completed without assistant text.")]
    (apply omap (concat (identity-fields provider-id account)
                        ["testedAt" tested-at "model" model "expectedText" expected-text
                         "status" "ok" "ok" true "matchesExpectedOutput" matches?
                         "outputText" (when (seq output-text) output-text)
                         "upstreamStatus" upstream-status "message" message]))))

(defn endpoint [base-url] (str (str/replace base-url #"/+$" "") "/api/chat"))

(defn request-headers [api-key]
  (array-map "authorization" (str "Bearer " api-key) "accept" "application/json" "content-type" "application/json"))

(defn probe-model [model]
  (let [m (when (string? model) (jv/trim model))]
    (if (seq m) m default-model)))
