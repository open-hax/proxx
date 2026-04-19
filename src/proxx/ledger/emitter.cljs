(ns proxx.ledger.emitter
  (:require [proxx.ledger.projector :as proj]))

(defn- now-ms [] (.getTime (js/Date.)))
(defn- new-event-id [] (str (random-uuid)))

(defn- append! [ledger-atom event]
  (let [stamped (merge {:event-id (new-event-id) :ts (now-ms)} event)]
    (swap! ledger-atom conj stamped)
    stamped))

;; ── HTTP ───────────────────────────────────────────────────────────────────

(defn- fetch-completion [{:keys [base-url path]} payload]
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
       (let [chunks (atom [])
             req    (.request
                     http opts
                     (fn [res]
                       (.on res "data" #(swap! chunks conj %))
                       (.on res "end"
                            (fn []
                              (resolve {:status   (.-statusCode res)
                                        :headers  (js->clj (.-headers res))
                                        :body-str (.join (into-array @chunks) "")})))))]
         (.on req "error" reject)
         (.write req body-str)
         (.end req))))))

;; ── Classification ────────────────────────────────────────────────────────────

(def ^:private quota-patterns
  [#"rate limit" #"quota" #"too many requests" #"insufficient_quota"])

(defn- quota-body? [s]
  (boolean (some #(re-find % (.toLowerCase s)) quota-patterns)))

(defn- parse-json [s]
  (try (js->clj (js/JSON.parse s) :keywordize-keys true)
       (catch :default _ nil)))

(defn- classify [{:keys [status body-str]}]
  (cond
    (= status 429)    {:outcome :rate-limited}
    (empty? body-str) {:outcome :empty-response}
    :else
    (let [parsed (parse-json body-str)]
      (cond
        (nil? parsed)           {:outcome :unrecognized-schema}
        (quota-body? body-str)  {:outcome :quota-exhausted-in-body :parsed parsed}
        (and (:choices parsed)
             (= "length" (-> parsed :choices first :finish_reason)))
        {:outcome :success :parsed parsed :overflow? true
         :tokens-in (-> parsed :usage :prompt_tokens)}
        (:choices parsed)       {:outcome :success :parsed parsed}
        :else                   {:outcome :unrecognized-schema :parsed parsed}))))

;; ── Churn ───────────────────────────────────────────────────────────────────

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

;; ── Attempt ─────────────────────────────────────────────────────────────────

(defn- attempt! [ledger-atom provider session-id request]
  (-> (fetch-completion provider request)
      (.then
       (fn [resp]
         (let [{:keys [outcome parsed overflow? tokens-in]} (classify resp)
               base {:provider-id (:provider-id provider)
                     :account-id  (:account-id provider)
                     :model-id    (:model-id provider)
                     :session-id  session-id}]
           (case outcome
             :success
             (do
               (when overflow?
                 (append! ledger-atom
                          (merge base {:event-type      :context-overflow-detected
                                       :tokens-in       (or tokens-in 0)
                                       :overflow-signal :soft-truncation})))
               (merge base {:outcome :success :parsed parsed}))

             :rate-limited
             (let [ra  (some-> (get-in resp [:headers "retry-after"]) js/parseInt)
                   cu  (+ (now-ms) (* (or ra 1800) 1000))]
               (append! ledger-atom
                        (merge base {:event-type     :account-cooldown-initiated
                                     :reason         :quota-short
                                     :cooldown-until cu}))
               (merge base {:outcome :rate-limited}))

             (:quota-exhausted-in-body :empty-response)
             (do
               (append! ledger-atom
                        (merge base {:event-type  :empty-provider-response
                                     :http-status (:status resp)
                                     :raw-body    (:body-str resp)
                                     :outcome     outcome}))
               (merge base {:outcome outcome}))

             :unrecognized-schema
             (do
               (append! ledger-atom
                        (merge base {:event-type      :unrecognized-response-schema
                                     :http-status     (:status resp)
                                     :raw-body        (:body-str resp)
                                     :expected-schema :openai-chat}))
               (merge base {:outcome :unrecognized-schema}))

             (merge base {:outcome outcome}))))))))

;; ── Public ───────────────────────────────────────────────────────────────────

(defonce ^:private session-states (atom {}))

(defn route! [{:keys [providers ledger session-id harness-id cache-key]} req]
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

    (let [pvec (vec providers)]
      (letfn [(try-next [idx]
                (if (>= idx (count pvec))
                  (js/Promise.resolve {:outcome :all-strategies-exhausted})
                  (let [p (nth pvec idx)]
                    (-> (attempt! ledger p session-id req)
                        (.then
                         (fn [result]
                           (if (= :success (:outcome result))
                             result
                             (let [ni (inc idx)]
                               (when (< ni (count pvec))
                                 (let [np (nth pvec ni)]
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
                                             :epoch-id-after   (str (random-uuid))})))
                               (try-next ni))))))))]
        (try-next 0)))))
