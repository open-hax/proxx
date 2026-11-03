(ns proxx.web.format-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.web.format :as f]))

(deftest auth-type
  (is (= "API Key" (f/format-auth-type "api_key")))
  (is (= "OAuth" (f/format-auth-type " OAUTH_BEARER ")))
  (is (= "Unknown" (f/format-auth-type "  ")))
  (is (= "Some Odd Type" (f/format-auth-type "some_odd-type"))))

(deftest request-origin
  (is (= "unknown" (f/format-request-origin {})))
  (is (= "tenant t · key k · issuer i" (f/format-request-origin {:tenantId " t " :keyId "k" :issuer "i"})))
  (is (= "local" (f/format-request-origin {:issuer "local"})))
  (is (= "tenant t" (f/format-request-origin {:tenantId "t" :issuer "local"})))
  (is (= "issuer x" (f/format-request-origin {:issuer "x"}))))

(deftest small-formatters
  (is (= "-" (f/format-maybe "  ")))
  (is (= "x" (f/format-maybe "x")))
  (is (= "-" (f/format-maybe-number js/NaN)))
  (is (= "0" (f/format-maybe-number 0)))
  (is (= "-" (f/format-bytes 0)))
  (is (= "512 B" (f/format-bytes 512)))
  (is (= "1.5 kB" (f/format-bytes 1536)))
  (is (= "2.0 MB" (f/format-bytes (* 2 1024 1024))))
  (is (= "{\n  \"a\": 1\n}" (f/compact-json {"a" 1})))
  (is (= "{\n  \"a\": \n…" (f/compact-json {"a" "xxxxxxxxxx"} 9))))
