(ns proxx.strategy.attempt-plan-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.strategy.attempt-plan :as plan]))

(def ^:private openai-images
  {:base-url "https://chatgpt.test" :primary-path "/images" :openai-images? true :auth-type "oauth_bearer"
   :openai-api-base-url "https://api.test" :images-path "/v1/images/generations"
   :openai-base-url "https://chatgpt.test" :responses-path "/codex/responses"})

(deftest ordinary-attempts-are-one-step
  (is (= [{:base-url "b" :path "/p" :kind :default}]
         (plan/upstream-steps {:base-url "b" :primary-path "/p" :openai-images? false}))))

(deftest openai-image-steps
  (testing "api keys always use the platform API"
    (is (= [:openai-platform] (map :kind (plan/upstream-steps (assoc openai-images :auth-type "api_key" :images-mode "chatgpt"))))))
  (testing "modes for oauth accounts"
    (is (= [:openai-codex-responses-images] (map :kind (plan/upstream-steps (assoc openai-images :images-mode "chatgpt")))))
    (is (= [:openai-platform] (map :kind (plan/upstream-steps (assoc openai-images :images-mode "platform")))))
    (let [steps (plan/upstream-steps (assoc openai-images :images-mode "auto"))]
      (is (= [:openai-platform :openai-codex-responses-images] (map :kind steps)))
      (is (= [401 403] (:try-next-base-on (first steps)))))))

(deftest affinities
  (is (true? (plan/affinity-match? "p" "a" {:provider-id "p" :account-id "a"})))
  (is (false? (plan/affinity-match? "p" "b" {:provider-id "p" :account-id "a"})))
  (is (false? (plan/affinity-match? "p" "a" nil)))
  (is (true? (plan/reassignment-allowed? nil [{:provider-id "p" :account-id "a"}])))
  (is (false? (plan/reassignment-allowed? {:provider-id "p" :account-id "a"} [{:provider-id "p" :account-id "a"}])))
  (is (true? (plan/reassignment-allowed? {:provider-id "p" :account-id "a"} [{:provider-id "p" :account-id "b"}]))))

(deftest transport-error-text
  (is (= "boom" (plan/transport-error-message "boom" nil)))
  (is (= "fetch failed (ECONNRESET: Error: read ECONNRESET)"
         (plan/transport-error-message "fetch failed" {:code "ECONNRESET" :name "Error" :message "read ECONNRESET"})))
  (is (= "x (E)" (plan/transport-error-message "x" {:code "E" :name "" :message nil}))))

(deftest codex-profile
  (is (true? (plan/codex-header-profile? "openai" "oauth_bearer" "openai")))
  (is (false? (plan/codex-header-profile? "openai" "api_key" "openai")))
  (is (true? (plan/requesty-model? " Requesty "))))
