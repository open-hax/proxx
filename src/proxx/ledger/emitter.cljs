(ns proxx.ledger.emitter
  (:require [proxx.ledger.projector :as proj]))

;; ── Internals ─────────────────────────────────────────────────────────────

(defn- now-ms [] (.getTime (js/Date.)))

(defn- new-event-id [] (str (random-uuid)))

(defn- append!
  "Stamps event-id + ts and conj's onto ledger atom."
  [ledger-atom event]
  (let [stamped (merge {:event-id (new-event-id) :ts (now-ms)} event)]
    (swap! ledger-atom conj stamped)
    stamped))

;; ── HTTP helpers ───────────────────────────────────────────────────────────

(defn- fetch-completion
  "POSTs request to provider. Returns Promise<{:status :headers :body-str}>."
  [{:keys [base-url path]} payload]
  (let [http     (js/require "http")
        url-mod  (js/require "url")
        parsed   (.parse url-mod base-url)
        body-str (js/JSON.stringify (clj->js payload))
        opts     #js {:hostname (.-hostname parsed)
                      :port     (or (.-port parsed) 80)
                      :path     path
                      :method   "POST"
                      :headers  #js {"content-type"   "application/json"
                                     "content-length" (.-length (js/Buffer.from body-str))}}]
    (js/Promise.
     (fn [resolve reject]
       (let [req (.request http opts
                           (fn [res]
                             (let [chunks (atom [])]
                               (.on res "data" #(swap! chunks conj %))
                               (.on res "end"
                                    (fn []
                                      (resolve {:status   (.-statusCode res)
                                                :headers  (js->clj (.-headers res))
                                                :body-str (.join (into-array @chunks) "")}))))))]
         (.on req "error" reject)
         (.write req body-str)
         (.end req))))))

;; ── Response classification ─────────────────────────────────────────────────────

(def ^:private quota-body-patterns
  [#"rate limit" #"quota" #"too many requests" #"insufficient_quota"])

(defn- quota-signal-in-body? [body-str]
  (let [lower (.toLowerCase body-str)]
    (boolean (some #(re-find % lower) quota-body-patterns))))

(defn- parse-json [s]
  (try (js->clj (js/JSON.parse s) :keywordize-keys true)
       (catch :default _ nil)))

(defn- classify-response
  "Returns {:outcome kw :parsed map-or-nil :overflow-signal kw-or-nil}."
  [{:keys [status body-str]}]
  (cond
    (= status 429)
    {:outcome :rate-limited}

    (empty? body-str)
    {:outcome :empty-response}

    :else
    (let [parsed (parse-json body-str)]
      (cond
        (nil? parsed)
        {:outcome :unrecognized-schema}

        (quota-signal-in-body? body-str)
        {:outcome :quota-exhausted-in-body :parsed parsed}

        ;; OpenAI-compatible shape check
        (and (:choices parsed)
             (= "length" (-> parsed :choices first :finish_reason)))
        {:outcome     :success
         :parsed      parsed
         :overflow?   true
         :tokens-in   (-> parsed :usage :prompt_tokens)}

        (:choices parsed)
        {:outcome :success :parsed parsed}

        ;; Non-empty JSON but not a recognisable provider schema
        :else
        {:outcome :unrecognized-schema :parsed parsed}))))

;; ── Churn detection ────────────────────────────────────────────────────────────

(defn- detect-churn!
  "Compares message count in new request against last-seen count for session.
   Emits :session-churn-detected if count dropped. Mutates session-state atom."
  [ledger-atom session-state session-id messages]
  (let [prev-count (:last-message-count @session-state)
        curr-count (count messages)]
    (swap! session-state assoc :last-message-count curr-count)
    (when (and prev-count (< curr-count prev-count))
      (append! ledger-atom
               {:event-type            :session-churn-detected
                :session-id            session-id
                :churn-type            :compaction
                :message-count-before  prev-count
                :message-count-after   curr-count
                :prefix-similarity-after (proj/prefix-similarity prev-count curr-count)}))))

;; ── Single-provider attempt ─────────────────────────────────────────────────────

(defn- attempt!
  "Fires one HTTP request at provider, classifies response, appends ledger events.
   Returns Promise<result-map> where result-map has :outcome and provider fields."
  [ledger-atom provider session-id request]
  (-> (fetch-completion provider request)
      (.then
       (fn [resp]
         (let [{:keys [outcome parsed overflow? tokens-in]} (classify-response resp)
               base {:provider-id (:provider-id provider)
                     :account-id  (:account-id provider)
                     :model-id    (:model-id provider)
                     :session-id  session-id}]
           (case outcome
             :success
             (do
               (when overflow?
                 (append! ledger-atom
                          (merge base
                                 {:event-type        :context-overflow-detected
                                  :tokens-in         (or tokens-in 0)
                                  :overflow-signal   :soft-truncation})))
               (merge base {:outcome :success :parsed parsed}))

             :rate-limited
             (let [retry-after (some-> (get-in resp [:headers "retry-after"])
                                       js/parseInt)
                   cooldown-until (+ (now-ms) (* (or retry-after 1800) 1000))]
               (append! ledger-atom
                        (merge base
                               {:event-type          :account-cooldown-initiated
                                :reason              :quota-short
                                :cooldown-until      cooldown-until}))
               (merge base {:outcome :rate-limited}))

             (:quota-exhausted-in-body :empty-response)
             (do
               (append! ledger-atom
                        (merge base
                               {:event-type  :empty-provider-response
                                :http-status (:status resp)
                                :raw-body    (:body-str resp)
                                :outcome     outcome}))
               (merge base {:outcome outcome}))

             :unrecognized-schema
             (do
               (append! ledger-atom
                        (merge base
                               {:event-type      :unrecognized-response-schema
                                :http-status     (:status resp)
                                :raw-body        (:body-str resp)
                                :expected-schema :openai-chat}))
               (merge base {:outcome :unrecognized-schema}))

             ;; fallthrough
             (merge base {:outcome outcome})))))))

;; ── Public API ─────────────────────────────────────────────────────────────────

;; Per-session mutable state (message-count cursor only; ledger is the truth store).
(defonce ^:private session-states (atom {}))

(defn route!
  "Routes a chat-completion request across the provider list.

   ctx  - {:providers [{:provider-id :account-id :model-id :base-url :path}]
            :ledger    atom  ; append-only event log
            :session-id str
            :harness-id str
            :cache-key  str}
   req  - {:model str :messages vec}

   Returns Promise<result-map>:
     {:outcome kw :provider-id str :account-id str :model-id str ...}"
  [{:keys [providers ledger session-id harness-id cache-key]} req]
  (let [messages       (:messages req [])
        s-state        (get (swap! session-states update session-id #(or % (atom {})))
                             session-id)
        first-request? (nil? (:last-message-count @s-state))]

    ;; Emit session-start on first ever request for this cache-key
    (when first-request?
      (when-let [p (first providers)]
        (append! ledger
                 {:event-type        :session-start
                  :session-id        session-id
                  :harness-id        (or harness-id "unknown")
                  :harness-cache-key (or cache-key session-id)
                  :derived-cache-key (or cache-key session-id)
                  :provider-id       (:provider-id p)
                  :account-id        (:account-id p)
                  :model-id          (:model-id p)})))

    ;; Churn detection (no-op on first request)
    (detect-churn! ledger s-state session-id messages)

    ;; Try providers in order, falling over on non-success
    (let [providers-vec (vec providers)]
      (letfn [(try-next [idx prev-result]
                (if (>= idx (count providers-vec))
                  ;; All providers exhausted
                  (js/Promise.resolve
                   (or prev-result {:outcome :all-strategies-exhausted}))
                  (let [provider (nth providers-vec idx)]
                    (-> (attempt! ledger provider session-id req)
                        (.then
                         (fn [result]
                           (if (= :success (:outcome result))
                             result
                             ;; Emit account-changed if we're switching providers
                             (let [next-idx (inc idx)]
                               (when (< next-idx (count providers-vec))
                                 (let [next-p (nth providers-vec next-idx)]
                                   (append! ledger
                                            {:event-type       :session-account-changed
                                             :session-id       session-id
                                             :provider-id      (:provider-id provider)
                                             :account-id       (:account-id provider)
                                             :model-id         (:model-id provider)
                                             :from-account-id  (:account-id provider)
                                             :to-account-id    (:account-id next-p)
                                             :from-provider-id (:provider-id provider)
                                             :to-provider-id   (:provider-id next-p)
                                             :reason           (:outcome result)
                                             :epoch-id-before  (proj/current-epoch @ledger
                                                                                    {:session-id  session-id
                                                                                     :provider-id (:provider-id provider)
                                                                                     :account-id  (:account-id provider)
                                                                                     :model-id    (:model-id provider)})
                                             :epoch-id-after   (str (random-uuid))})))
                               (try-next next-idx result))))))))]
        (try-next 0 nil)))))
