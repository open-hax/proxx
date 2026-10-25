(ns proxx.strategy.shared-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.policy.loader :as loader]
            [proxx.schema :as schema]
            [proxx.strategy.diagnostics :as diag]
            [proxx.strategy.payload :as payload]
            [proxx.strategy.routing :as routing]
            [proxx.strategy.usage :as usage]))

(def ^:private policy
  (routing/policy-from-contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")))

(deftest attempt-policy-contract-is-valid
  (is (some? (schema/validate :proxx/policy-contract policy)))
  (is (= #{502 503 504} (get-in policy [:attempt/retry-same-credential :statuses]))))

;; --- usage -------------------------------------------------------------------

(deftest usage-from-sse
  (testing "chat SSE: last usage chunk wins; missing cache info normalises to 0"
    (is (= {:prompt-tokens 3 :completion-tokens 4 :total-tokens 7 :cached-prompt-tokens 0}
           (usage/counts-from-sse-text "data: {\"usage\":{\"prompt_tokens\":1}}\n\ndata: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\ndata: [DONE]\n" "chat_completions" "m" 0)))
    (is (= {} (usage/counts-from-sse-text "data: [DONE]\n" "chat_completions" "m" 0))))
  (testing "anthropic: input from message_start, output from message_delta"
    (is (= {:prompt-tokens 10 :completion-tokens 5 :total-tokens 15 :cached-prompt-tokens 2}
           (usage/counts-from-sse-text
            (str "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":2}}}\n\n"
                 "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n")
            "messages" "m" 0))))
  (testing "ollama ndjson needs a done line with both counters"
    (is (= {:prompt-tokens 2 :completion-tokens 3 :total-tokens 5}
           (usage/counts-from-sse-text "{\"done\":false}\n{\"done\":true,\"prompt_eval_count\":2,\"eval_count\":3}\n" "ollama_chat" "m" 0)))
    (is (= {} (usage/counts-from-sse-text "{\"done\":true,\"eval_count\":3}\n" "ollama_chat" "m" 0))))
  (testing "gemini: last JSON payload's usageMetadata"
    (is (= {:prompt-tokens 1 :completion-tokens 2 :total-tokens 3}
           (usage/counts-from-sse-text "data: {\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":2,\"totalTokenCount\":3}}\n" "gemini_chat" "m" 0)))))

(deftest usage-patch-and-streams
  (is (nil? (usage/usage-patch {} {:completed-at 10 :attempt-started-at 0})))
  (let [patch (usage/usage-patch {:completion-tokens 100 :cached-prompt-tokens 5}
                                 {:stream? true :completed-at 2000 :first-content-at 1000 :attempt-started-at 0 :image-cost 0})]
    (is (= 100 (:tps patch)) "decode time runs from first content")
    (is (= 50 (:end-to-end-tps patch)))
    (is (= 1000 (:ttft-ms patch)))
    (is (true? (:cache-hit patch))))
  (is (nil? (:tps (usage/usage-patch {:completion-tokens 100} {:stream? false :completed-at 2000 :first-content-at 1000 :attempt-started-at 0 :image-cost 0})))
      "throughput only for streams")
  (is (= 0.5 (:image-cost-usd (usage/usage-patch {:image-count 2} {:completed-at 1 :attempt-started-at 0 :image-cost 0.25}))))
  (is (usage/event-stream? "text/event-stream; charset=utf-8" "chat_completions"))
  (is (usage/event-stream? "application/x-ndjson" "ollama_chat"))
  (is (not (usage/event-stream? "application/x-ndjson" "chat_completions")))
  (is (usage/event-stream? "" "openai_responses") "forced-stream modes")
  (is (usage/buffer-substantive? "data: {\"a\":1}"))
  (is (not (usage/buffer-substantive? "data: [DONE]\n"))))

(deftest image-counts
  (is (= 2 (usage/image-count-from-images-payload {"data" [1 2]})))
  (is (= 2 (usage/image-count-from-responses-payload {"output" [{"type" "image_generation_call" "result" ["a" "b"]}]})))
  (is (nil? (usage/image-count-from-responses-payload {"output" [{"type" "message"}]}))))

;; --- diagnostics -------------------------------------------------------------

(def ^:private fake-hash (fn [s] (str (count s) "0000000000000000")))

(deftest diagnostics-counts-shapes-not-text
  (let [d (diag/build-factory-4xx-diagnostics
           fake-hash
           {"messages" [{"role" "system" "content" "Use AGENTS.md"} {"role" "user" "content" [{"type" "image_url" "image_url" {}} {"type" "text" "text" "hi ```x```"}]}
                        {"role" "assistant" "content" nil "reasoning_content" nil "tool_calls" [{} {}]}]}
           "key")]
    (is (= "chat_completions" (:request-format d)))
    (is (= 3 (:message-count d)))
    (is (= 2 (:function-call-count d)))
    (is (= 1 (:image-input-count d)))
    (is (true? (:has-agent-protocol-markers d)))
    (is (true? (:has-code-fence d)))
    (is (true? (:has-reasoning d)) "a null reasoning_content field still counts as sent")
    (is (some? (:prompt-cache-key-hash d)))
    (is (re-matches #"sha256:[0-9a-f]{12}" (:shape-fingerprint d)))))

(deftest diagnostics-responses-format
  (let [d (diag/build-factory-4xx-diagnostics fake-hash {"instructions" "  be   brief " "input" [{"role" "user" "content" "x"} {"type" "function_call"} {"type" "function_call_output" "output" "o"}]} nil)]
    (is (= "responses" (:request-format d)))
    (is (= 3 (:input-item-count d)))
    (is (= 1 (:function-call-count d)))
    (is (= 1 (:function-call-output-count d)))
    (is (= 8 (:instructions-chars d)))
    (is (= 1 (:message-count d)))))

;; --- payload -------------------------------------------------------------------

(deftest service-tier
  (let [tier #(payload/requested-service-tier %1 %2)]
    (is (= "flex" (tier {"open_hax" {"service_tier" " flex "}} {})))
    (is (= "priority" (tier {"open_hax" {"fast_mode" true}} {})))
    (is (= "priority" (tier {} {"x-open-hax-fast-mode" "yes"})))
    (is (= "gold" (tier {} {"x-open-hax-service-tier" ["gold"]})))
    (is (nil? (tier {"open_hax" {"fast_mode" false}} {"x-open-hax-fast-mode" "on"})) "explicit false wins")
    (testing "intentional divergence: a blank service_tier no longer shadows serviceTier (JS ?? stopped at \"\")"
      (is (= "flex" (tier {"open_hax" {"service_tier" "" "serviceTier" "flex"}} {})))))
  (is (= {:service-tier "priority" :service-tier-source "fast_mode"}
         (payload/logged-service-tier {"service_tier" "priority"} {:request-body {"open_hax" {"fast_mode" true}} :headers {}})))
  (is (= {:service-tier "priority" :service-tier-source "explicit"}
         (payload/logged-service-tier {"service_tier" "priority"} {:request-body {"service_tier" "priority"} :headers {}})))
  (is (= {:service-tier-source "none"} (payload/logged-service-tier {} nil)))
  (is (= {"service_tier" "x"} (payload/apply-requested-service-tier {"service_tier" "x"} {"open_hax" {"service_tier" "y"}} {}))))

(deftest payload-adjustments
  (is (= {"input" [{"role" "user"}]}
         (payload/strip-trailing-assistant-prefill {"input" [{"role" "user"} {"role" "assistant"} {"role" "assistant"}]})))
  (is (= {"input" []} (payload/strip-trailing-assistant-prefill {"input" [{"role" "assistant"}]})))
  (is (= {"stream" true "stream_options" {"include_usage" true}} (payload/ensure-usage-in-stream {"stream" true})))
  (is (= {"stream" true "stream_options" {"include_usage" false}} (payload/ensure-usage-in-stream {"stream" true "stream_options" {"include_usage" false}})))
  (testing "intentional divergence: an array stream_options is replaced (JS mutated a property of the array)"
    (is (= {"include_usage" true} (get (payload/ensure-usage-in-stream {"stream" true "stream_options" []}) "stream_options"))))
  (is (= {"model" "r"} (payload/prepare-upstream-body {"model" "q" "open_hax" {}} "r" "q")))
  (is (= "openai/gpt-5" (payload/requesty-model "gpt-5" "openai")))
  (is (= "a/b" (payload/requesty-model "a/b" "openai")))
  (is (= {"created" 1 "data" [{"b64_json" "x" "revised_prompt" "r"}] "background" "opaque"}
         (payload/images-from-responses-output {"output" [{"type" "image_generation_call" "result" "x" "revised_prompt" "r"} {"type" "image_generation_call" "result" ""}]} 1000)))
  (is (= {:issuer "local" :tenant-id "t" :key-id "k"} (payload/usage-attribution {:kind "ui_session" :tenant-id "t" :key-id "k" :subject "s"}))))

;; --- routing -------------------------------------------------------------------

(deftest credential-judgement
  (is (routing/permanently-disable? policy :api-key "vivgrid" 402))
  (is (routing/permanently-disable? policy :api-key "vivgrid" 403))
  (is (not (routing/permanently-disable? policy :api-key "requesty" 403)))
  (is (routing/permanently-disable? policy :api-key "requesty" 402))
  (is (not (routing/permanently-disable? policy :oauth-bearer "openai" 402)))
  (is (routing/cooldown-on-auth-failure? policy "openai" 403))
  (is (not (routing/cooldown-on-auth-failure? policy "factory" 403)))
  (is (routing/transient-provider-retry? policy "factory" 403))
  (is (= {:classification :auth-cooldown :cooldown-ms 10000} (routing/classify-auth-error policy :oauth-bearer "openai" 401 300000)))
  (is (= {:classification :auth-cooldown :cooldown-ms 500} (routing/classify-auth-error policy :oauth-bearer "openai" 401 500)))
  (is (= {:classification :model-not-supported :cooldown-ms 60000} (routing/classify-model-not-supported policy 300000)))
  (is (= 1 (routing/clamp-route-quality policy 10)))
  (is (= 0.05 (routing/clamp-route-quality policy 99999))))

(deftest credential-ordering
  (is (= [1 0 2] (routing/account-order-for-request policy "openai" "gpt-5" ["plus" "free" nil])))
  (is (= [0 1] (routing/account-order-for-request policy "openai" "gpt-5" ["plus" "team"])) "no free account: unchanged")
  (is (= [0 1] (routing/account-order-for-request policy "openai" "claude" ["plus" "free"])))
  (is (= [0 1] (routing/account-order-for-request policy "other" "gpt-5" ["plus" "free"])))
  (testing "latency: clearly faster first, then cheaper plan, then throughput"
    (is (= [1 0] (routing/account-order-for-latency policy [{:ttft 500} {:ttft 100}])))
    (is (= [1 0] (routing/account-order-for-latency policy [{:ttft 100 :plan-type "plus"} {:ttft 150 :plan-type "free"}])))
    (is (= [1 0] (routing/account-order-for-latency policy [{:ttft 100 :tps 5} {:ttft 100 :tps 9}])))
    (is (= [0 1 2 3 4 5 6] (routing/account-order-for-latency policy (vec (repeat 7 {}))))))
  (testing "affinity: preferred first; already-placed duplicates dropped; no match keeps order"
    (is (= [2 0 1] (routing/candidate-order-for-affinities [["a" "1"] ["a" "2"] ["a" "3"]] [["a" "3"]])))
    (is (= [0 1] (routing/candidate-order-for-affinities [["a" "1"] ["a" "2"]] [["z" "9"]])))
    (is (= [0] (routing/candidate-order-for-affinities [["a" "1"] ["a" "1"]] [["a" "1"]])) "the first wins; its twin is dropped"))
  (is (= [1 0] (routing/candidate-order-for-routes policy [{:provider-index 1} {:provider-index 0}])))
  (is (= [1 0] (routing/candidate-order-for-routes policy [{:provider-index 0 :ttft 900} {:provider-index 1 :ttft 100}]))))
