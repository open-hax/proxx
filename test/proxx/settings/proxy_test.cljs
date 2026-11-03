(ns proxx.settings.proxy-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.json :as json]
            [proxx.settings.proxy :as s]))

(deftest defaults-for-junk
  (doseq [junk [nil 5 true "x" "{bad" "null" "[]" [] [1] "\"s\""]]
    (is (= s/default-settings (s/normalize-settings junk)) (pr-str junk))))

(deftest normalizes-fields
  (is (= {"fastMode" true "requestsPerMinute" 12 "allowedModels" ["a" "b"]
          "allowedProviderIds" ["openai" "zai"] "disabledProviderIds" nil}
         (s/normalize-settings {"fastMode" true "requestsPerMinute" 12.9 "allowedModels" ["A" " a " "b" 5 nil ""]
                                "allowedProviderIds" [" OpenAI " "openai" "ZAI"] "disabledProviderIds" []})))
  (testing "rate limits are whole numbers of at least 1; anything else is unlimited"
    (is (= 1 (get (s/normalize-settings {"requestsPerMinute" 0.5}) "requestsPerMinute")))
    (is (= 1 (get (s/normalize-settings {"requestsPerMinute" -4}) "requestsPerMinute")))
    (is (nil? (get (s/normalize-settings {"requestsPerMinute" "5"}) "requestsPerMinute")))
    (is (nil? (get (s/normalize-settings {"requestsPerMinute" nil}) "requestsPerMinute"))))
  (testing "fastMode is a boolean or false"
    (is (false? (get (s/normalize-settings {"fastMode" "true"}) "fastMode")))
    (is (false? (get (s/normalize-settings {"fastMode" 1}) "fastMode"))))
  (testing "lists that are not arrays are absent"
    (is (nil? (get (s/normalize-settings {"allowedModels" "x"}) "allowedModels")))))

(deftest accepts-every-key-spelling
  (is (= {"fastMode" true "requestsPerMinute" 3 "allowedModels" ["m"] "allowedProviderIds" ["p"] "disabledProviderIds" ["d"]}
         (s/normalize-settings {"fast-mode" true "requests_per_minute" 3 "allowedModels" ["m"]
                                "allowed-provider-ids" ["p"] "disabled_provider_ids" ["d"]}))))

(deftest stringified-json
  (is (= {"fastMode" true "requestsPerMinute" nil "allowedModels" nil "allowedProviderIds" nil "disabledProviderIds" nil}
         (s/normalize-settings (json/write {"fastMode" true}))))
  (is (= true (get (s/normalize-settings (json/write (json/write {"fastMode" true}))) "fastMode"))
      "a doubly-encoded document is decoded twice"))

(deftest merging-and-keys
  (is (= {"fastMode" true "requestsPerMinute" nil} (s/merge-settings {"fastMode" false "requestsPerMinute" 5} {"fastMode" true "requestsPerMinute" nil}))
      "a key present in `next` wins even when nil")
  (is (= "proxy_settings" (s/tenant-key "default" "default")))
  (is (= "proxy_settings:acme" (s/tenant-key "acme" "default")))
  (is (= "default" (s/settings-tenant-id nil "default" identity)))
  (is (= "default" (s/settings-tenant-id "  " "default" identity)))
  (is (= "X" (s/settings-tenant-id "x" "default" #(.toUpperCase %)))))
