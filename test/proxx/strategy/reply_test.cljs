(ns proxx.strategy.reply-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.reply :as frames]
            [proxx.strategy.reply :as plan]))

(deftest handlers-by-registry-id
  (is (= :standard (plan/provider-handler "chat-completions")))
  (is (= :transformed (plan/provider-handler "messages")))
  (is (= :transformed (plan/provider-handler "factory-messages")))
  (is (= :responses (plan/provider-handler "responses")))
  (is (= :openai-codex (plan/provider-handler "openai-chat")))
  (is (= :passthrough (plan/provider-handler "factory-responses-passthrough")))
  (is (= :ollama-cloud (plan/provider-handler "ollama-cloud")))
  (is (= :local-ollama (plan/local-handler "local-ollama")))
  (is (= :ollama (plan/local-handler "remote-ollama")))
  (is (= :standard (plan/local-handler "chat-completions"))))

(deftest passthrough-plans
  (is (= :stream (plan/passthrough-plan {:ct "text/event-stream" :has-body? true})))
  (is (= :no-body (plan/passthrough-plan {:ct "text/event-stream" :has-body? false})))
  (is (= :text (plan/passthrough-plan {:ct "application/json" :has-body? false})))
  (is (= :bytes (plan/passthrough-plan {:ct "application/json" :has-body? true})))
  (testing "openai passthrough"
    (is (= :standard (plan/openai-passthrough-plan {:ok? false :ct "application/json"})))
    (is (= :stream-error (plan/openai-passthrough-plan {:ok? false :ct ""})))
    (is (= :relay (plan/openai-passthrough-plan {:ok? true :ct "" :wants-stream? true})))
    (is (= :collect (plan/openai-passthrough-plan {:ok? true :ct "text/event-stream" :wants-stream? false})))
    (is (= :copy (plan/openai-passthrough-plan {:ok? true :ct "application/json" :wants-stream? true})))))

(deftest ollama-plans
  (is (= :standard (plan/ollama-plan {:ok? false :wants-stream? true :has-body? true})))
  (is (= :ndjson (plan/ollama-plan {:ok? true :wants-stream? true :has-body? true})))
  (is (= :json (plan/ollama-plan {:ok? true :wants-stream? true :has-body? false})))
  (is (= :bootstrap (plan/local-ollama-plan {:ok? true :wants-stream? true :ct "application/json" :has-body? true})))
  (is (= :standard-stream (plan/local-ollama-plan {:ok? true :wants-stream? true :ct "text/event-stream" :has-body? true})))
  (is (= {:status 502 :type "server_error" :code "ollama_parse_failed"
          :message "Failed to parse Ollama upstream payload: x"}
         (plan/ollama-parse-failure false "x"))))

(deftest frames-order
  (testing "identity reveals the account only to legacy admins"
    (is (= [[:header "x-open-hax-upstream-provider" "p"]]
           (frames/identity-frames {:provider-id "p" :auth-kind "tenant_api_key"})))
    (is (= [[:header "x-open-hax-upstream-provider" "p"]
            [:header "x-open-hax-upstream-account" "a"]
            [:header "x-open-hax-upstream-auth-type" "api_key"]]
           (frames/identity-frames {:provider-id "p" :auth-kind "legacy_admin" :account-id "a" :auth-type "api_key"}))))
  (testing "a relayed stream drops content-length after copying upstream headers"
    (let [f (frames/relayed-stream-head {:status 200 :lead [[:header "x-p" "1"]]
                                         :upstream-headers [["x-up" "v"] ["transfer-encoding" "chunked"]]})]
      (is (= [[:header "x-p" "1"] [:code 200] [:header "x-up" "v"] [:remove-header "content-length"]
              [:header "cache-control" "no-cache"] [:header "x-accel-buffering" "no"]
              [:header "content-type" "text/event-stream; charset=utf-8"] [:hijack 200]]
             f))))
  (testing "a translated stream head"
    (is (= [[:header "x-p" "1"] [:code 200] [:header "content-type" "text/event-stream; charset=utf-8"]
            [:header "cache-control" "no-cache"] [:header "x-accel-buffering" "no"] [:hijack 200]]
           (frames/translated-stream-head {:before [[:header "x-p" "1"]]})))))
