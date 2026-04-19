(ns proxx.e2e.fixtures)

;; ── OpenAI-compatible success response ───────────────────────────────────────

(def openai-success-body
  {:id      "chatcmpl-test-001"
   :object  "chat.completion"
   :model   "gpt-4o"
   :choices [{:index         0
              :message       {:role "assistant" :content "Hello from fake upstream."}
              :finish_reason "stop"}]
   :usage   {:prompt_tokens 10 :completion_tokens 5 :total_tokens 15}})

;; ── 429 rate-limit response ───────────────────────────────────────────────────
;; Includes Retry-After header (set in fake-upstream server config).

(def openai-429-body
  {:error {:message "Rate limit reached for model gpt-4o."
           :type    "requests"
           :code    "rate_limit_exceeded"}})

;; ── Ollama-style silent quota exhaustion ──────────────────────────────────────
;; HTTP 200 but the body signals quota exhaustion in plain text / JSON.

(def ollama-quota-body-json
  {:error "rate limit exceeded"})

(def ollama-quota-body-text
  "rate limit exceeded")

;; ── Empty body (connection closed / zero-byte response) ──────────────────────

(def empty-body "")

;; ── Context overflow: response that signals truncation ───────────────────────
;; Some providers return a finish_reason of "length" with zero content.

(def openai-overflow-body
  {:id      "chatcmpl-test-overflow"
   :object  "chat.completion"
   :model   "gpt-4o"
   :choices [{:index         0
              :message       {:role "assistant" :content ""}
              :finish_reason "length"}]
   :usage   {:prompt_tokens 128000 :completion_tokens 0 :total_tokens 128000}})

;; ── Unrecognized schema (valid JSON but not OpenAI shape) ────────────────────

(def unrecognized-body
  {:status "ok" :result "something proprietary"})

;; ── Provider B success (used in fallover scenario) ───────────────────────────

(def provider-b-success-body
  {:id      "chatcmpl-test-002"
   :object  "chat.completion"
   :model   "gpt-4o-mini"
   :choices [{:index         0
              :message       {:role "assistant" :content "Hello from provider B."}
              :finish_reason "stop"}]
   :usage   {:prompt_tokens 10 :completion_tokens 5 :total_tokens 15}})

;; ── Fixture descriptors ───────────────────────────────────────────────────────
;; Each descriptor drives fake-upstream/make-server configuration.
;; :status     HTTP status code
;; :headers    extra response headers map
;; :body       response body (map → JSON-encoded, string → sent as-is)
;; :body-delay optional ms delay before responding (latency simulation)

(def scenarios
  {:success
   {:status  200
    :headers {"content-type" "application/json"}
    :body    openai-success-body}

   :rate-limited
   {:status  429
    :headers {"content-type" "application/json"
              "retry-after"  "30"}
    :body    openai-429-body}

   :ollama-silent-quota
   {:status  200
    :headers {"content-type" "application/json"}
    :body    ollama-quota-body-json}

   :empty-response
   {:status  200
    :headers {"content-type" "application/json"}
    :body    empty-body}

   :context-overflow
   {:status  200
    :headers {"content-type" "application/json"}
    :body    openai-overflow-body}

   :unrecognized-schema
   {:status  200
    :headers {"content-type" "application/json"}
    :body    unrecognized-body}

   :provider-b-success
   {:status  200
    :headers {"content-type" "application/json"}
    :body    provider-b-success-body}})
