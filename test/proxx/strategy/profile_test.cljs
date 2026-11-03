(ns proxx.strategy.profile-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy.loader :as loader]
            [proxx.strategy.profile :as profile]
            [proxx.strategy.select :as select]))

(def ^:private registry
  (select/registry-from-contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")))

(def ^:private ids (map :strategy/id (:registry/entries registry)))

(deftest every-registered-strategy-has-a-profile
  (is (= 27 (count ids)))
  (doseq [id ids]
    (is (contains? #{:normalized :bare-normalized :request :reasoned-request :gemini} (profile/payload-source id)) (str id))
    (is (some? (profile/path-source id)) (str id))))

(deftest payload-sources
  (is (= :request (profile/payload-source :hf-embeddings)))
  (is (= :request (profile/payload-source :factory-responses-passthrough)))
  (is (= :reasoned-request (profile/payload-source :remote-ollama)))
  (is (= :bare-normalized (profile/payload-source :local-ollama)))
  (is (= :gemini (profile/payload-source :gemini-chat)))
  (is (= :normalized (profile/payload-source :messages))))

(deftest reasoning-provider
  (is (= "ollama-cloud" (profile/reasoning-provider :ollama-cloud "anything")))
  (is (= "lan" (profile/reasoning-provider :ollama "lan")))
  (is (= "ollama" (profile/reasoning-provider :remote-ollama nil))))

(deftest paths-and-headers
  (is (= [:factory "anthropic"] (profile/path-source :factory-messages)))
  (is (= [:factory "common"] (profile/path-source :factory-chat)))
  (is (= :gemini (profile/path-source :gemini-chat)))
  (is (= :registry (profile/path-source :messages)))
  (is (= :interleaved-beta (profile/header-recipe :messages)))
  (is (= :factory-anthropic (profile/header-recipe :factory-messages)))
  (is (= :gemini-key (profile/header-recipe :gemini-chat)))
  (is (nil? (profile/header-recipe :chat-completions)))
  (is (profile/direct-execution? :gemini-chat))
  (is (not (profile/direct-execution? :messages))))
