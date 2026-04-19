(ns proxx.e2e.router-test
  (:require [cljs.test :refer-macros [deftest is testing async]]
            [proxx.e2e.fake-upstream :as upstream]
            [proxx.ledger.emitter :as emitter]))

(defn make-provider [id port]
  {:provider-id id
   :account-id  (str id "-account-a")
   :model-id    "gpt-4o"
   :base-url    (str "http://127.0.0.1:" port)
   :path        "/v1/chat/completions"})

(defn make-request
  ([] (make-request {}))
  ([{:keys [messages] :or {messages [{:role "user" :content "hello"}]}}]
   {:model "gpt-4o" :messages messages}))

(defn event-types [ledger-atom]
  (set (map :event-type @ledger-atom)))

;; ── 1. Happy path ───────────────────────────────────────────────────────────

(deftest happy-path
  (async done
    (upstream/with-server [:success]
      (fn [port _]
        (let [ledger (atom [])
              ctx    {:providers  [(make-provider "openai" port)]
                      :ledger     ledger
                      :session-id "sess-1"
                      :harness-id "test-harness"
                      :cache-key  "ck-1"}]
          (-> (emitter/route! ctx (make-request))
              (.then (fn [result]
                       (testing "success outcome" (is (= :success (:outcome result))))
                       (testing "session-start emitted" (is (contains? (event-types ledger) :session-start)))
                       (testing "no cooldown" (is (not (contains? (event-types ledger) :account-cooldown-initiated))))
                       (done)))
              (.catch (fn [e] (is (nil? (str e))) (done)))))))))

;; ── 2. 429 → cooldown ──────────────────────────────────────────────────────────

(deftest rate-limit-triggers-cooldown
  (async done
    (upstream/with-server [:rate-limited]
      (fn [port _]
        (let [ledger (atom [])
              ctx    {:providers  [(make-provider "openai" port)]
                      :ledger     ledger
                      :session-id "sess-2"
                      :harness-id "test-harness"
                      :cache-key  "ck-2"}]
          (-> (emitter/route! ctx (make-request))
              (.then (fn [result]
                       (testing "rate-limited outcome" (is (= :rate-limited (:outcome result))))
                       (testing "cooldown emitted" (is (contains? (event-types ledger) :account-cooldown-initiated)))
                       (testing "reason quota-short"
                         (let [ev (first (filter #(= :account-cooldown-initiated (:event-type %)) @ledger))]
                           (is (= :quota-short (:reason ev)))))
                       (done)))
              (.catch (fn [e] (is (nil? (str e))) (done)))))))))

;; ── 3. Ollama silent quota ─────────────────────────────────────────────────────

(deftest ollama-silent-quota-detected
  (async done
    (upstream/with-server [:ollama-silent-quota]
      (fn [port _]
        (let [ledger (atom [])
              ctx    {:providers  [(make-provider "ollama" port)]
                      :ledger     ledger
                      :session-id "sess-3"
                      :harness-id "test-harness"
                      :cache-key  "ck-3"}]
          (-> (emitter/route! ctx (make-request))
              (.then (fn [result]
                       (testing "quota-exhausted-in-body outcome"
                         (is (= :quota-exhausted-in-body (:outcome result))))
                       (testing "empty-provider-response emitted"
                         (is (contains? (event-types ledger) :empty-provider-response)))
                       (testing "raw-body preserved"
                         (let [ev (first (filter #(= :empty-provider-response (:event-type %)) @ledger))]
                           (is (string? (:raw-body ev)))))
                       (done)))
              (.catch (fn [e] (is (nil? (str e))) (done)))))))))

;; ── 4. Fallover A→B ────────────────────────────────────────────────────────────

(deftest fallover-to-provider-b
  (async done
    (upstream/with-server [:rate-limited]
      (fn [port-a _]
        (upstream/with-server [:provider-b-success]
          (fn [port-b _]
            (let [ledger (atom [])
                  pa     (make-provider "openai" port-a)
                  pb     (assoc (make-provider "anthropic" port-b)
                                :account-id "anthropic-account-a"
                                :model-id   "gpt-4o-mini")
                  ctx    {:providers  [pa pb]
                          :ledger     ledger
                          :session-id "sess-4"
                          :harness-id "test-harness"
                          :cache-key  "ck-4"}]
              (-> (emitter/route! ctx (make-request))
                  (.then (fn [result]
                           (testing "success outcome" (is (= :success (:outcome result))))
                           (testing "cooldown on A" (is (contains? (event-types ledger) :account-cooldown-initiated)))
                           (testing "account-changed emitted" (is (contains? (event-types ledger) :session-account-changed)))
                           (testing "provider-id is B" (is (= "anthropic" (:provider-id result))))
                           (done)))
                  (.catch (fn [e] (is (nil? (str e))) (done))))))))))
)

;; ── 5. Context overflow ──────────────────────────────────────────────────────────

(deftest context-overflow-detected
  (async done
    (upstream/with-server [:context-overflow]
      (fn [port _]
        (let [ledger (atom [])
              ctx    {:providers  [(make-provider "openai" port)]
                      :ledger     ledger
                      :session-id "sess-5"
                      :harness-id "test-harness"
                      :cache-key  "ck-5"}]
          (-> (emitter/route! ctx (make-request))
              (.then (fn [_]
                       (testing "context-overflow-detected emitted"
                         (is (contains? (event-types ledger) :context-overflow-detected)))
                       (testing "soft-truncation signal"
                         (let [ev (first (filter #(= :context-overflow-detected (:event-type %)) @ledger))]
                           (is (= :soft-truncation (:overflow-signal ev)))))
                       (testing "tokens-in recorded"
                         (let [ev (first (filter #(= :context-overflow-detected (:event-type %)) @ledger))]
                           (is (pos? (:tokens-in ev 0)))))
                       (done)))
              (.catch (fn [e] (is (nil? (str e))) (done)))))))))

;; ── 6. Session churn ────────────────────────────────────────────────────────────

(deftest session-churn-detected
  (async done
    (upstream/with-server [:success :success]
      (fn [port _]
        (let [ledger    (atom [])
              ctx       {:providers  [(make-provider "openai" port)]
                         :ledger     ledger
                         :session-id "sess-6"
                         :harness-id "test-harness"
                         :cache-key  "ck-6"}
              long-req  (make-request {:messages (vec (repeat 20 {:role "user" :content "msg"}))})
              short-req (make-request {:messages (vec (repeat 5  {:role "user" :content "msg"}))})]
          (-> (emitter/route! ctx long-req)
              (.then (fn [_] (emitter/route! ctx short-req)))
              (.then (fn [_]
                       (testing "churn emitted"
                         (is (contains? (event-types ledger) :session-churn-detected)))
                       (testing "message counts"
                         (let [ev (first (filter #(= :session-churn-detected (:event-type %)) @ledger))]
                           (is (= 20 (:message-count-before ev)))
                           (is (= 5  (:message-count-after ev)))))
                       (done)))
              (.catch (fn [e] (is (nil? (str e))) (done)))))))))
