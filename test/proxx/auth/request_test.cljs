(ns proxx.auth.request-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.auth.request :as req]))

(deftest bearer-extraction
  (doseq [[h expected] [[nil nil] ["" nil] ["Bearer x" "x"] ["bearer  x " "x"] ["  BEARER x" "x"] ["Bearer" nil]
                        ["Bearer  " nil] ["Basic x" nil] ["Bearerx" nil] [5 nil]]]
    (is (= expected (req/bearer-token h)) (pr-str h))))

(deftest legacy-admin-matching
  (is (= :bearer (req/legacy-admin-source "pt" "pt" "pt")) "the bearer wins over the cookie")
  (is (= :cookie (req/legacy-admin-source "pt" "other" "pt")))
  (is (nil? (req/legacy-admin-source nil "x" "x")) "no configured token: nothing matches")
  (is (nil? (req/legacy-admin-source "" nil nil)))
  (is (nil? (req/legacy-admin-source "pt" nil nil))))

(deftest session-candidates
  (is (= [[:bearer "b"] [:cookie "c"]] (req/ui-session-candidates "b" "c")))
  (is (= [[:bearer "b"]] (req/ui-session-candidates "b" "b")) "an identical cookie is not retried")
  (is (= [[:cookie "c"]] (req/ui-session-candidates nil "c")))
  (is (= [] (req/ui-session-candidates nil nil))))

(deftest result-shapes
  (is (= {"kind" "legacy_admin" "tenantId" "default" "role" "owner" "source" "cookie" "subject" "legacy:proxy-auth-token"}
         (req/legacy-admin :cookie "default")))
  (is (= "tenant_api_key:k1" (get (req/tenant-api-key-auth {"id" "k1" "tenantId" "t" "scopes" ["s"]}) "subject")))
  (is (= "cookie" (get (req/ui-session-auth :cookie {"activeTenantId" "t"}) "source"))))
