(ns proxx.ledger.emitter
  (:require-macros [proxx.macros :refer [defn-async p-let]])
  (:require [proxx.ledger.projector :as proj]))

;; ── Primitives ──────────────────────────────────────────────────────────────

(defn- now-ms [] (.getTime (js/Date.)))
(defn- new-event-id [] (str (random-uuid)))

(defn- append! [ledger-atom event]
  (let [stamped (merge {:event-id (new-event-id) :ts (now-ms)} event)]
    (swap! ledger-atom conj stamped)
    stamped))

;; ── HTTP ───────────────────────────────────────────────────────────────────

(defn-async fetch-completion [{:keys [base-url path]} payload]
  (js/Promise.
   (fn [resolve reject]
     (let [http     (js/require "http")
           url-mod  (js/require "url")
           parsed   (.parse url-mod base-url)
           body-str (js/JSON.stringify (clj->js payload))
           opts     #js {:hostname (.-hostname parsed)
                         :port     (or (.-port parsed) 80)
                         :path     path
                         :method   "POST"
                         :headers  #js {"content-type"   "application/json"
                                        "content-length" (.-length (js/Buffer.from body-str))}}
           chunks   (atom [])
           req      (.request http opts
                              (fn [res]
                                (.on res "data" #(swap! chunks conj %))
                                (.on res "end"
                                     (fn []
                                       (resolve {:status   (.-statusCode res)
                                                 :headers  (js->clj (.-headers res))
                                                 :body-str (.join (into-array @chunks) "")})))))]
       (.on req "error" reject)
       (.write req body-str)
       (.end req)))))

;; ── Classification (pure) ─────────────────────────────────────────────────────

(def ^:private quota-patterns
  [#"rate limit" #"quota" #"too many requests" #"insufficient_quota"])

(defn- quota-body? [s]
  (boolean (some #(re-find % (.toLowerCase s)) quota-patterns)))

(defn- parse-json [s]
  (try (js->clj (js/JSON.parse s) :keywordize-keys true)
       (catch :default _ nil)))

(defn classify-response
  "Pure. Returns {:outcome kw :parsed? :overflow? :tokens-in}."
  [{:keys [status body-str]}]
  (cond
    (= status 429)    {:outcome :rate-limited}
    (empty? body-str) {:outcome :empty-response}
    :else
    (let [parsed (parse-json body-str)]
      (cond
        (nil? parsed)          {:outcome :unrecognized-schema}
        (quota-body? body-str) {:outcome :quota-exhausted-in-body :parsed parsed}
        (and (:choices parsed)
             (= "length" (-> parsed :choices first :finish_reason)))
        {:outcome :success :parsed parsed
         :overflow? true :tokens-in (-> parsed :usage :prompt_tokens)}
        (:choices parsed)      {:outcome :success :parsed parsed}
        :else                  {:outcome :unrecognized-schema :parsed parsed}))))

;; ── Outcome handlers (pure — no IO, no Promise) ────────────────────────────────

(defn- handle-success [ledger-atom base parsed overflow? tokens-in]
  (when overflow?
    (append! ledger-atom
             (merge base {:event-type      :context-overflow-detected
                          :tokens-in       (or tokens-in 0)
                          :overflow-signal :soft-truncation})))
  (merge base {:outcome :success :parsed parsed}))

(defn- handle-rate-limited [ledger-atom base resp]
  (let [ra (some-> (get-in resp [:headers "retry-after"]) js/parseInt)
        cu (+ (now-ms) (* (or ra 1800) 1000))]
    (append! ledger-atom
             (merge base {:event-type     :account-cooldown-initiated
                          :reason         :quota-short
                          :cooldown-until cu}))
    (merge base {:outcome :rate-limited})))

(defn- handle-empty [ledger-atom base resp outcome]
  (append! ledger-atom
           (merge base {:event-type  :empty-provider-response
                        :http-status (:status resp)
                        :raw-body    (:body-str resp)
                        :outcome     outcome}))
  (merge base {:outcome outcome}))

(defn- handle-unrecognized [ledger-atom base resp]
  (append! ledger-atom
           (merge base {:event-type      :unrecognized-response-schema
                        :http-status     (:status resp)
                        :raw-body        (:body-str resp)
                        :expected-schema :openai-chat}))
  (merge base {:outcome :unrecognized-schema}))

;; ── Attempt (async shell — IO + dispatch only) ────────────────────────────────

(defn-async attempt [ledger-atom provider session-id request]
  (p-let [resp (fetch-completion provider request)]
    (let [{:keys [outcome parsed overflow? tokens-in]} (classify-response resp)
          base {:provider-id (:provider-id provider)
                :account-id  (:account-id provider)
                :model-id    (:model-id provider)
                :session-id  session-id}]
      (case outcome
        :success
        (handle-success ledger-atom base parsed overflow? tokens-in)
        :rate-limited
        (handle-rate-limited ledger-atom base resp)
        (:quota-exhausted-in-body :empty-response)
        (handle-empty ledger-atom base resp outcome)
        :unrecognized-schema
        (handle-unrecognized ledger-atom base resp)
        (merge base {:outcome outcome})))))

;; ── Churn detection ───────────────────────────────────────────────────────────

(defn- detect-churn! [ledger-atom s-state session-id messages]
  (let [prev (get @s-state :last-message-count)
        curr (count messages)]
    (swap! s-state assoc :last-message-count curr)
    (when (and prev (< curr prev))
      (append! ledger-atom
               {:event-type              :session-churn-detected
                :session-id              session-id
                :churn-type              :compaction
                :message-count-before    prev
                :message-count-after     curr
                :prefix-similarity-after (proj/prefix-similarity prev curr)}))))

;; ── Fallover loop ───────────────────────────────────────────────────────────

(defn- emit-account-changed! [ledger session-id p np result]
  (append! ledger
           {:event-type       :session-account-changed
            :session-id       session-id
            :provider-id      (:provider-id p)
            :account-id       (:account-id p)
            :model-id         (:model-id p)
            :from-account-id  (:account-id p)
            :to-account-id    (:account-id np)
            :from-provider-id (:provider-id p)
            :to-provider-id   (:provider-id np)
            :reason           (:outcome result)
            :epoch-id-before  (proj/current-epoch
                               @ledger
                               {:session-id  session-id
                                :provider-id (:provider-id p)
                                :account-id  (:account-id p)
                                :model-id    (:model-id p)})
            :epoch-id-after   (str (random-uuid))}))

(defn-async try-providers [ledger pvec session-id req idx]
  (if (>= idx (count pvec))
    {:outcome :all-strategies-exhausted}
    (p-let [result (attempt ledger (nth pvec idx) session-id req)]
      (if (= :success (:outcome result))
        result
        (let [ni (inc idx)]
          (when (< ni (count pvec))
            (emit-account-changed! ledger session-id (nth pvec idx) (nth pvec ni) result))
          (try-providers ledger pvec session-id req ni))))))

;; ── Public API ─────────────────────────────────────────────────────────────────

(defonce ^:private session-states (atom {}))

(defn-async route! [{:keys [providers ledger session-id harness-id cache-key]} req]
  (let [messages (:messages req [])
        s-state  (get (swap! session-states update session-id #(or % (atom {})))
                      session-id)
        first?   (nil? (get @s-state :last-message-count))]
    (when first?
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
    (detect-churn! ledger s-state session-id messages)
    (try-providers ledger (vec providers) session-id req 0)))
