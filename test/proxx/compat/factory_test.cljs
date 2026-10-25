(ns proxx.compat.factory-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.compat.factory :as f]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]))

(def profile
  (-> (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")
      contracts/compile-contracts
      (f/profile "factory")))

(deftest model-routing-facts-come-from-policy
  (doseq [[model type api path]
          [["claude-opus-4" :anthropic "anthropic" "/api/llm/a/v1/messages"]
           ["Claude-3" :anthropic "anthropic" "/api/llm/a/v1/messages"]
           ["gpt-5" :openai "openai" "/api/llm/o/v1/responses"]
           ["GEMINI-2" :common "google" "/api/llm/o/v1/chat/completions"]
           ["glm-5" :common "fireworks" "/api/llm/o/v1/chat/completions"]
           ["kimi-k2" :common "fireworks" "/api/llm/o/v1/chat/completions"]
           ["something-new" :common "fireworks" "/api/llm/o/v1/chat/completions"]
           ["" :common "fireworks" "/api/llm/o/v1/chat/completions"]]]
    (is (= type (f/model-type profile model)) model)
    (is (= api (f/api-provider profile model)) model)
    (is (= path (f/endpoint-path profile type)) model)))

(deftest headers
  (let [ids {:session-id "s" :message-id "m"}
        common (f/common-headers profile "gpt-5" ids)]
    (is (= "openai" (get common "x-api-provider")))
    (is (= "s" (get common "x-session-id")))
    (is (= "m" (get common "x-assistant-message-id")))
    (is (= "factory-cli/0.74.0" (get common "user-agent")))
    (is (= "x64" (get common "x-stainless-arch"))))
  (let [h #(f/anthropic-headers profile "claude-x" %1 %2 {:session-id "s" :message-id "m"})]
    (is (= "2023-06-01" (get (h {} nil) "anthropic-version")))
    (is (not (contains? (h {"thinking" {"type" "enabled"}} nil) "anthropic-beta")))
    (is (not (contains? (h {"thinking" {"type" "enabled"}} "") "anthropic-beta")))
    (is (not (contains? (h {"thinking" {"type" "disabled"}} "beta") "anthropic-beta")))
    (is (not (contains? (h {} "beta") "anthropic-beta")))
    (is (= "beta" (get (h {"thinking" {"type" "enabled"}} "beta") "anthropic-beta")))))

(deftest fk-keys
  (is (f/fk-key? profile {"authType" "api_key" "token" "fk-abc"}))
  (is (not (f/fk-key? profile {"authType" "oauth_bearer" "token" "fk-abc"})))
  (is (not (f/fk-key? profile {"authType" "api_key" "token" "sk-abc"})))
  (is (not (f/fk-key? profile {"authType" "api_key"}))))

(deftest prompt-sanitizing
  (let [safe (f/sanitize-system-prompt profile "x You Are OpenCode, the best coding agent on the planet y")]
    (is (re-find #"^You are a software engineering assistant" safe))
    (is (= 7 (count (clojure.string/split-lines safe)))))
  (is (= "plain" (f/sanitize-system-prompt profile "plain"))))

(deftest inline-system-prompt
  (testing "no system: identical"
    (let [p {"messages" []}] (is (identical? p (f/inline-system-prompt p)))))
  (testing "empty system just disappears"
    (is (= {"messages" []} (f/inline-system-prompt {"system" "" "messages" []})))
    (is (= {"m" 1} (f/inline-system-prompt {"system" [{"type" "image"}] "m" 1}))))
  (testing "prepends to first user message by content shape"
    (is (= {"messages" [{"role" "assistant" "content" "a"} {"role" "user" "content" "S\n\nhi"}]}
           (f/inline-system-prompt {"system" "S" "messages" [{"role" "assistant" "content" "a"} {"role" "user" "content" "hi"}]})))
    (is (= {"messages" [{"role" "user" "content" [{"type" "text" "text" "S"} {"type" "text" "text" "hi"}]}]}
           (f/inline-system-prompt {"system" "S" "messages" [{"role" "user" "content" [{"type" "text" "text" "hi"}]}]})))
    (is (= {"messages" [{"role" "user" "content" "S" "x" 1}]}
           (f/inline-system-prompt {"system" "S" "messages" [{"role" "user" "content" nil "x" 1}]}))))
  (testing "array system joins text parts"
    (is (= "a\nb\nc\n\n" (get-in (f/inline-system-prompt {"system" ["a" {"type" "text" "text" "b"} {"type" "image"} {"type" "text" "text" ""} {"type" "text" "text" "c"}]
                                                       "messages" [{"role" "user" "content" ""}]})
                             ["messages" 0 "content"]))
        "empty user string: system text followed by blank separator"))
  (testing "no user message: leading user message, or nothing to attach to"
    (is (= [{"role" "user" "content" "S"} {"role" "assistant" "content" "a"}]
           (get (f/inline-system-prompt {"system" "S" "messages" [{"role" "assistant" "content" "a"}]}) "messages")))
    (is (= {"messages" []} (f/inline-system-prompt {"system" "S"})))))

(deftest missing-profile-is-an-error
  (is (= :policy/missing-wire-profile
         (try (f/profile {:index {:contracts []}} "factory") (catch :default e (:error/type (ex-data e)))))))
