(ns proxx.runtime.prompt-affinity-test
  "src/tests/prompt-affinity-store.test.ts: the in-memory (no SQL handle) prompt-affinity edge."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.prompt-affinity :as edge]))

(defn- new-store [] (edge/create-prompt-affinity-store-js nil #js {}))

(defn- field [^js record k] (when (some? record) (let [v (aget record k)] (when-not (undefined? v) v))))

;; ---- basic store operations -----------------------------------------------------

(deftest ^:async upsert-stores-and-retrieves-records
  (let [^js store (new-store)]
    (await (.init store))
    (await (.upsert store "cache-key-1" "factory" "acct-1"))
    (await (.upsert store "cache-key-2" "openai" "acct-2"))
    (await (.upsert store "cache-key-1" "factory" "acct-3"))
    (let [r1 (await (.get store "cache-key-1"))]
      (is (= "cache-key-1" (field r1 "promptCacheKey")))
      (is (= "factory" (field r1 "providerId")))
      (is (= "acct-3" (field r1 "accountId")))
      (is (= "number" (goog/typeOf (field r1 "updatedAt")))))
    (let [r2 (await (.get store "cache-key-2"))]
      (is (= "cache-key-2" (field r2 "promptCacheKey")))
      (is (= "openai" (field r2 "providerId")))
      (is (= "acct-2" (field r2 "accountId"))))
    (is (nil? (await (.get store "nonexistent"))))
    (await (.close store))))

(deftest ^:async promotes-fallback-only-after-repeated-successful-use
  (let [^js store (new-store)
        get-record (fn [] (.get store "cache-key-1"))]
    (await (.init store))
    (await (.noteSuccess store "cache-key-1" "openai" "acct-a"))
    (let [r (await (get-record))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-a" (field r "accountId")))
      (is (nil? (field r "provisionalProviderId"))))

    (await (.noteSuccess store "cache-key-1" "openai" "acct-b"))
    (let [r (await (get-record))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-a" (field r "accountId")))
      (is (= "openai" (field r "provisionalProviderId")))
      (is (= "acct-b" (field r "provisionalAccountId")))
      (is (= 1 (field r "provisionalSuccessCount"))))

    (await (.noteSuccess store "cache-key-1" "openai" "acct-b"))
    (let [r (await (get-record))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-b" (field r "accountId")))
      (is (nil? (field r "provisionalProviderId")))
      (is (nil? (field r "provisionalAccountId"))))

    (await (.noteSuccess store "cache-key-1" "openai" "acct-b"))
    (let [r (await (get-record))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-b" (field r "accountId")))
      (is (nil? (field r "provisionalProviderId"))))

    (await (.noteSuccess store "cache-key-1" "openai" "acct-a"))
    (let [r (await (get-record))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-b" (field r "accountId")))
      (is (= "openai" (field r "provisionalProviderId")))
      (is (= "acct-a" (field r "provisionalAccountId")))
      (is (= 1 (field r "provisionalSuccessCount"))))

    (await (.noteSuccess store "cache-key-1" "openai" "acct-b"))
    (let [r (await (get-record))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-b" (field r "accountId")))
      (is (nil? (field r "provisionalProviderId"))))
    (await (.close store))))

(deftest ^:async delete-removes-records
  (let [^js store (new-store)]
    (await (.init store))
    (await (.upsert store "cache-key-1" "factory" "acct-1"))
    (is (= "factory" (field (await (.get store "cache-key-1")) "providerId")))
    (await (.delete store "cache-key-1"))
    (is (nil? (await (.get store "cache-key-1"))))
    (await (.close store))))

;; ---- edge cases and provisional promotion logic ---------------------------------

(deftest ^:async ignores-empty-or-whitespace-only-keys
  (let [^js store (new-store)]
    (await (.init store))
    (await (.upsert store "" "openai" "acct-1"))
    (await (.upsert store "   " "openai" "acct-2"))
    (await (.upsert store "\t\n" "openai" "acct-3"))
    (is (nil? (await (.get store ""))))
    (is (nil? (await (.get store "   "))))
    (is (nil? (await (.get store "\t\n"))))
    (await (.close store))))

(deftest ^:async trims-keys-on-upsert-and-get
  (let [^js store (new-store)]
    (await (.init store))
    (await (.upsert store "  cache-key-trim  " "openai" "acct-1"))
    (let [r (await (.get store "cache-key-trim"))]
      (is (= "cache-key-trim" (field r "promptCacheKey")))
      (is (= "openai" (field r "providerId")))
      (is (= "acct-1" (field r "accountId"))))
    (await (.close store))))

(deftest ^:async note-success-ignores-invalid-parameters
  (let [^js store (new-store)]
    (await (.init store))
    (await (.noteSuccess store "" "openai" "acct-1"))
    (await (.noteSuccess store "key-1" "" "acct-1"))
    (await (.noteSuccess store "key-1" "openai" ""))
    (await (.noteSuccess store "   " "openai" "acct-1"))
    (is (nil? (await (.get store "key-1"))))
    (is (nil? (await (.get store ""))))
    (await (.close store))))

(deftest ^:async primary-success-clears-provisional-tracking
  (let [^js store (new-store)
        k "key-alternating"]
    (await (.init store))
    (await (.noteSuccess store k "openai" "acct-a"))
    (await (.noteSuccess store k "openai" "acct-b"))
    (let [r (await (.get store k))]
      (is (= "acct-a" (field r "accountId")))
      (is (= "acct-b" (field r "provisionalAccountId")))
      (is (= 1 (field r "provisionalSuccessCount"))))
    ;; acct-a matches primary: clears provisional
    (await (.noteSuccess store k "openai" "acct-a"))
    (let [r (await (.get store k))]
      (is (= "acct-a" (field r "accountId")))
      (is (nil? (field r "provisionalAccountId")))
      (is (nil? (field r "provisionalSuccessCount"))))
    ;; acct-b starts fresh as a new provisional
    (await (.noteSuccess store k "openai" "acct-b"))
    (let [r (await (.get store k))]
      (is (= "acct-a" (field r "accountId")))
      (is (= "acct-b" (field r "provisionalAccountId")))
      (is (= 1 (field r "provisionalSuccessCount"))))
    ;; second acct-b success promotes
    (await (.noteSuccess store k "openai" "acct-b"))
    (let [r (await (.get store k))]
      (is (= "acct-b" (field r "accountId")))
      (is (nil? (field r "provisionalAccountId"))))
    (await (.close store))))

(deftest ^:async handles-provider-switching-during-fallback
  (let [^js store (new-store)
        k "key-provider-switch"]
    (await (.init store))
    (await (.noteSuccess store k "openai" "acct-oa"))
    (await (.noteSuccess store k "factory" "acct-fa"))
    (let [r (await (.get store k))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-oa" (field r "accountId")))
      (is (= "factory" (field r "provisionalProviderId")))
      (is (= "acct-fa" (field r "provisionalAccountId"))))
    (await (.noteSuccess store k "factory" "acct-fa"))
    (let [r (await (.get store k))]
      (is (= "factory" (field r "providerId")))
      (is (= "acct-fa" (field r "accountId")))
      (is (nil? (field r "provisionalProviderId"))))
    (await (.close store))))

(deftest ^:async delete-clears-both-primary-and-provisional-affinity
  (let [^js store (new-store)
        k "key-delete-provisional"]
    (await (.init store))
    (await (.noteSuccess store k "openai" "acct-a"))
    (await (.noteSuccess store k "openai" "acct-b"))
    (is (= "acct-b" (field (await (.get store k)) "provisionalAccountId")))
    (await (.delete store k))
    (is (nil? (await (.get store k))))
    (await (.noteSuccess store k "openai" "acct-c"))
    (let [r (await (.get store k))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-c" (field r "accountId")))
      (is (nil? (field r "provisionalAccountId"))))
    (await (.close store))))

(deftest ^:async upsert-overwrites-provisional-fields
  (let [^js store (new-store)
        k "key-upsert-overwrite"]
    (await (.init store))
    (await (.noteSuccess store k "openai" "acct-a"))
    (await (.noteSuccess store k "openai" "acct-b"))
    (is (= "acct-b" (field (await (.get store k)) "provisionalAccountId")))
    (await (.upsert store k "factory" "acct-c"))
    (let [r (await (.get store k))]
      (is (= "factory" (field r "providerId")))
      (is (= "acct-c" (field r "accountId")))
      (is (nil? (field r "provisionalProviderId")))
      (is (nil? (field r "provisionalAccountId"))))
    (await (.close store))))

(deftest ^:async provisional-count-resets-when-switching-to-different-candidate
  (let [^js store (new-store)
        k "key-count-reset"]
    (await (.init store))
    (await (.noteSuccess store k "openai" "acct-a"))
    (doseq [acct ["acct-b" "acct-c" "acct-b"]]
      (await (.noteSuccess store k "openai" acct))
      (let [r (await (.get store k))]
        (is (= 1 (field r "provisionalSuccessCount")))
        (is (= acct (field r "provisionalAccountId")))))
    (await (.close store))))

(deftest ^:async get-returns-copy-not-reference
  (let [^js store (new-store)]
    (await (.init store))
    (await (.upsert store "key-copy-test" "openai" "acct-1"))
    (let [r1 (await (.get store "key-copy-test"))
          r2 (await (.get store "key-copy-test"))]
      (is (= (js->clj r1) (js->clj r2)))
      (is (not (identical? r1 r2))))
    (await (.close store))))

(deftest ^:async stores-and-trims-provider-and-account-ids
  (let [^js store (new-store)]
    (await (.init store))
    (await (.upsert store "key-trim-ids" "  openai  " "  acct-trim  "))
    (let [r (await (.get store "key-trim-ids"))]
      (is (= "openai" (field r "providerId")))
      (is (= "acct-trim" (field r "accountId"))))
    (await (.close store))))

;; ---- concurrent access patterns -------------------------------------------------

(deftest ^:async handles-concurrent-note-success-calls
  (let [^js store (new-store)]
    (await (.init store))
    (await (js/Promise.all #js [(.noteSuccess store "key-concurrent" "openai" "acct-a")
                                (.noteSuccess store "key-concurrent" "openai" "acct-b")
                                (.noteSuccess store "key-concurrent" "openai" "acct-c")]))
    (let [r (await (.get store "key-concurrent"))]
      (is (some? r) "Record should exist after concurrent writes")
      (is (= "openai" (field r "providerId")))
      (is (contains? #{"acct-a" "acct-b" "acct-c"} (field r "accountId"))
          (str "Primary account should be one of the concurrent accounts, got: " (field r "accountId"))))
    (await (.close store))))

(deftest ^:async handles-rapid-succession-updates
  (let [^js store (new-store)]
    (await (.init store))
    (doseq [i (range 10)]
      (await (.noteSuccess store "key-rapid" "openai" (str "acct-" (mod i 3)))))
    (is (some? (await (.get store "key-rapid"))) "Record should exist after rapid updates")
    (await (.close store))))
