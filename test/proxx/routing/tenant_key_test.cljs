(ns proxx.routing.tenant-key-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.routing.tenant-key :as tk]
            [proxx.runtime.tenant-key :as edge]))

(defn- thrown [f] (try (f) nil (catch :default e (ex-message e))))

(deftest tenant-ids
  (is (= "open-hax" (tk/normalize-tenant-id "  Open-Hax  ")))
  (is (= "default" tk/default-tenant-id))
  (is (= "tenant id must not be empty" (thrown #(tk/normalize-tenant-id "  \t"))))
  (is (= "tenant id must not be empty" (thrown #(tk/normalize-tenant-id "")))))

(deftest visible-prefix
  (is (= "ohpk_abcdefg" (tk/key-prefix "ohpk_abcdefghijklmnopqrstuvwxyz")))
  (is (= "short" (tk/key-prefix "  short ")) "shorter than the visible length: whole trimmed token")
  (is (= 12 (count (tk/key-prefix (apply str (repeat 40 "x"))))))
  (is (= "tenant api key must not be empty" (thrown #(tk/key-prefix "  ")))))

(deftest peppered-hash-is-persisted-identity
  ;; sha256("pepper-a:ohpk_example_secret"), computed independently with sha256sum.
  (is (= "cad206f073001bc66f304b14a603b16e9e9e31e483a6686e373f9dbf83ff3efa"
         (edge/hash-tenant-api-key-js "  ohpk_example_secret " "pepper-a"))
      "pinned digest: changing it invalidates every stored tenant key")
  (is (= "H(p :t)" (tk/key-hash (fn [s] (str "H(" s ")")) " t " "p ")) "pepper verbatim, token trimmed")
  (is (= "tenant api key must not be empty" (thrown #(tk/key-hash identity "" "pepper"))))
  (is (= "tenant api key pepper must not be empty" (thrown #(tk/key-hash identity "t" "  "))))
  (is (= "tenant api key must not be empty" (thrown #(tk/key-hash identity " " " ")))
      "the token is validated before the pepper"))

(deftest edge-errors-are-plain-errors-with-the-same-message
  (let [e (try (edge/normalize-tenant-id-js " ") nil (catch :default e e))]
    (is (instance? js/Error e))
    (is (nil? (ex-data e)))
    (is (= "tenant id must not be empty" (.-message e)))))

(deftest generated-keys
  (let [k (edge/generate-tenant-api-key-js)]
    (is (re-matches #"ohpk_[A-Za-z0-9_-]{32}" k))
    (is (not= k (edge/generate-tenant-api-key-js)))))

;; --- Ported from src/tests/tenant-api-key.test.ts ------------------------------

(deftest default-tenant-id-remains-stable
  (is (= "default" (.-defaultTenantId (edge/tenant-api-key-constants-js)))))

(deftest normalize-tenant-id-trims-and-lowercases
  (is (= "open-hax" (edge/normalize-tenant-id-js "  Open-Hax  "))))

(deftest generate-tenant-api-key-returns-prefixed-secret
  (let [prefix (.-apiKeyPrefix (edge/tenant-api-key-constants-js))
        token (edge/generate-tenant-api-key-js)]
    (is (= "ohpk_" prefix))
    (is (.startsWith token prefix))
    (is (> (count token) (+ (count prefix) 16)))))

(deftest build-tenant-api-key-prefix-exposes-only-visible-prefix
  (is (= "ohpk_abcdefg" (edge/build-tenant-api-key-prefix-js "ohpk_abcdefghijklmnopqrstuvwxyz"))))

(deftest hash-tenant-api-key-is-deterministic-and-pepper-sensitive
  (let [token "ohpk_example_secret"
        first-hash (edge/hash-tenant-api-key-js token "pepper-a")
        second-hash (edge/hash-tenant-api-key-js token "pepper-a")
        third-hash (edge/hash-tenant-api-key-js token "pepper-b")]
    (is (= first-hash second-hash))
    (is (not= first-hash third-hash))
    (is (= 64 (count first-hash)))))
