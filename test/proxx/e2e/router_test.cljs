(ns proxx.e2e.router-test
  (:require [cljs.test :refer-macros [deftest is testing async]]
            [proxx.e2e.fake-upstream :as upstream]
            ;; These namespaces DO NOT EXIST YET — that's the point.
            ;; Each test below is RED until the emitter is implemented.
            [proxx.ledger.emitter :as emitter]
            [proxx.ledger.projector :as proj]))

;; ── Test helpers ──────────────────────────────────────────────────────────────

(defn make-provider
  "Minimal provider config pointing at a fake upstream port."
  [id port]
  {:provider-id id
   :account-id  (str id "-account-a")
   :model-id    "gpt-4o"
   :base-url    (str "http://127.0.0.1:" port)
   :path        "/v1/chat/completions"})

(defn make-request
  "Minimal chat completion request payload."
  [& [{:keys [messages] :or {messages [{:role "user" :content "hello"}]}}]]
  {:model    "gpt-4o"
   :messages messages})

(defn ledger-event-types
  "Extract :event-type seq from a ledger atom."
  [ledger-atom]
  (mapv :event-type @ledger-atom))

;; ── 1. Happy path ─────────────────────────────────────────────────────────────
;; A single successful round-trip should:
;;   - emit :session-start
;;   - emit a request record with :outcome :success
;;   - leave no cooldown events

(deftest happy-path
  (async done
    (upstream/with-server
      [:success]
      (fn [port _requests]
        (let [ledger   (atom [])
              provider (make-provider "openai" port)
              req      (make-request)]
          (-> (emitter/route! {:providers [provider]
                               :ledger    ledger
                               :session-id "sess-1"
                               :harness-id "test-harness"
                               :cache-key  "ck-1"}
                              req)
              (.then (fn [result]
                       (testing "returns a result map"
                         (is (map? result)))
                       (testing "ledger contains session-start"
                         (is (some #{:session-start} (ledger-event-types ledger))))
                       (testing "ledger contains no cooldown events"
                         (is (not (some #{:account-cooldown-initiated} (ledger-event-types ledger)))))
                       (testing "result outcome is success"
                         (is (= :success (:outcome result))))
                       (done)))
              (.catch (fn [err] (is (nil? (str err))) (done)))))))
  nil)

;; ── 2. 429 rate-limit → cooldown initiated ────────────────────────────────────
;; Provider returns 429.  Router should:
;;   - emit :account-cooldown-initiated with reason :quota-short
;;   - result outcome should be :rate-limited

(deftest rate-limit-triggers-cooldown
  (async done
    (upstream/with-server
      [:rate-limited]
      (fn [port _requests]
        (let [ledger   (atom [])
              provider (make-provider "openai" port)
              req      (make-request)]
          (-> (emitter/route! {:providers  [provider]
                               :ledger     ledger
                               :session-id "sess-2"
                               :harness-id "test-harness"
                               :cache-key  "ck-2"}
                              req)
              (.then (fn [result]
                       (testing "outcome is rate-limited"
                         (is (= :rate-limited (:outcome result))))
                       (testing "cooldown event emitted"
                         (is (some #{:account-cooldown-initiated} (ledger-event-types ledger))))
                       (testing "cooldown reason is quota-short"
                         (let [ev (first (filter #(= :account-cooldown-initiated (:event-type %)) @ledger))]
                           (is (= :quota-short (:reason ev)))))
                       (done)))
              (.catch (fn [err] (is (nil? (str err))) (done)))))))
  nil)

;; ── 3. Ollama silent quota (200 + error body) ─────────────────────────────────
;; Provider returns 200 but body contains quota exhaustion signal.
;; Router should:
;;   - emit :empty-provider-response with :outcome :quota-exhausted-in-body
;;   - NOT treat this as a success

(deftest ollama-silent-quota-detected
  (async done
    (upstream/with-server
      [:ollama-silent-quota]
      (fn [port _requests]
        (let [ledger   (atom [])
              provider (make-provider "ollama" port)
              req      (make-request)]
          (-> (emitter/route! {:providers  [provider]
                               :ledger     ledger
                               :session-id "sess-3"
                               :harness-id "test-harness"
                               :cache-key  "ck-3"}
                              req)
              (.then (fn [result]
                       (testing "outcome is quota-exhausted-in-body"
                         (is (= :quota-exhausted-in-body (:outcome result))))
                       (testing "empty-provider-response event emitted"
                         (is (some #{:empty-provider-response} (ledger-event-types ledger))))
                       (testing "raw-body is preserved on the event"
                         (let [ev (first (filter #(= :empty-provider-response (:event-type %)) @ledger))]
                           (is (string? (:raw-body ev)))))
                       (done)))
              (.catch (fn [err] (is (nil? (str err))) (done)))))))
  nil)

;; ── 4. Fallover: provider A 429 → provider B success ─────────────────────────
;; With two providers, A returns 429 and B returns 200.
;; Router should:
;;   - attempt A, get rate-limited
;;   - emit :account-cooldown-initiated for A
;;   - fall over to B, succeed
;;   - emit :session-account-changed
;;   - final outcome :success

(deftest fallover-to-provider-b
  (async done
    (upstream/with-server
      [:rate-limited]
      (fn [port-a _]
        (upstream/with-server
          [:provider-b-success]
          (fn [port-b _requests]
            (let [ledger     (atom [])
                  provider-a (make-provider "openai" port-a)
                  provider-b (assoc (make-provider "anthropic" port-b)
                                    :account-id "anthropic-account-a"
                                    :model-id   "gpt-4o-mini")
                  req        (make-request)]
              (-> (emitter/route! {:providers  [provider-a provider-b]
                                   :ledger     ledger
                                   :session-id "sess-4"
                                   :harness-id "test-harness"
                                   :cache-key  "ck-4"}
                                  req)
                  (.then (fn [result]
                           (testing "final outcome is success"
                             (is (= :success (:outcome result))))
                           (testing "cooldown emitted for provider A"
                             (is (some #{:account-cooldown-initiated} (ledger-event-types ledger))))
                           (testing "session-account-changed emitted"
                             (is (some #{:session-account-changed} (ledger-event-types ledger))))
                           (testing "successful provider is B"
                             (is (= "anthropic" (:provider-id result))))
                           (done)))
                  (.catch (fn [err] (is (nil? (str err))) (done))))))))
      nil)))

;; ── 5. Context overflow detected ─────────────────────────────────────────────
;; Provider returns finish_reason "length" at max token usage.
;; Router should:
;;   - emit :context-overflow-detected
;;   - record tokens-in

(deftest context-overflow-detected
  (async done
    (upstream/with-server
      [:context-overflow]
      (fn [port _requests]
        (let [ledger   (atom [])
              provider (make-provider "openai" port)
              req      (make-request)]
          (-> (emitter/route! {:providers  [provider]
                               :ledger     ledger
                               :session-id "sess-5"
                               :harness-id "test-harness"
                               :cache-key  "ck-5"}
                              req)
              (.then (fn [_result]
                       (testing "context-overflow-detected event emitted"
                         (is (some #{:context-overflow-detected} (ledger-event-types ledger))))
                       (testing "overflow-signal is :soft-truncation"
                         (let [ev (first (filter #(= :context-overflow-detected (:event-type %)) @ledger))]
                           (is (= :soft-truncation (:overflow-signal ev)))))
                       (testing "tokens-in recorded"
                         (let [ev (first (filter #(= :context-overflow-detected (:event-type %)) @ledger))]
                           (is (pos? (:tokens-in ev 0)))))
                       (done)))
              (.catch (fn [err] (is (nil? (str err))) (done)))))))
  nil)

;; ── 6. Session churn detected ─────────────────────────────────────────────────
;; Second request for the same session has fewer messages (compaction).
;; Router should:
;;   - emit :session-churn-detected on the second call
;;   - record message counts before/after

(deftest session-churn-detected
  (async done
    (upstream/with-server
      [:success :success]
      (fn [port _requests]
        (let [ledger   (atom [])
              provider (make-provider "openai" port)
              ctx      {:providers  [provider]
                        :ledger     ledger
                        :session-id "sess-6"
                        :harness-id "test-harness"
                        :cache-key  "ck-6"}
              long-req  (make-request {:messages (vec (repeat 20 {:role "user" :content "msg"}))})
              short-req (make-request {:messages (vec (repeat 5  {:role "user" :content "msg"}))})] ; compacted
          (-> (emitter/route! ctx long-req)
              (.then (fn [_] (emitter/route! ctx short-req)))
              (.then (fn [_]
                       (testing "churn event emitted on second request"
                         (is (some #{:session-churn-detected} (ledger-event-types ledger))))
                       (testing "message counts recorded"
                         (let [ev (first (filter #(= :session-churn-detected (:event-type %)) @ledger))]
                           (is (= 20 (:message-count-before ev)))
                           (is (= 5  (:message-count-after ev)))))
                       (done)))
              (.catch (fn [err] (is (nil? (str err))) (done)))))))
  nil)
