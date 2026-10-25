(ns proxx.federation.owner-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.owner :as owner]))

(def plc "did:plc:z72i7hdynmk6r22z27h6tvur")
(defn- fake-sha [s] (str (apply str (repeat 8 "0123456789abcdef")) "-" s))

(deftest at-did-detection
  (is (owner/at-did? plc))
  (is (owner/at-did? "did:web:proxx.promethean.rest"))
  (is (owner/at-did? "did:web:proxx.promethean.rest:peer:local"))
  (is (owner/at-did? (str "  " plc "\n")) "surrounding whitespace is ignored")
  (is (owner/at-did? "DID:PLC:Z72I7HDYNMK6R22Z27H6TVUR") "the scheme and identifier are case-insensitive")
  (doseq [bad [nil "" "  " "not-a-did" "did:key:z6Mkabc" "did:plc:short" (str plc "x") "did:web:" 42]]
    (is (not (owner/at-did? bad)) (pr-str bad))))

(deftest at-did-unicode-case-folding-is-preserved
  ;; The TypeScript patterns use /iu, under which U+017F and U+212A match [a-z].
  ;; Stored owner subjects were accepted with that rule, so it stays.
  (is (owner/at-did? (str "did:plc:" (apply str (repeat 24 "ſ")))))
  (is (owner/at-did? "did:web:K.example")))

(deftest normalize-at-did
  (is (= "did:web:proxx.promethean.rest" (owner/normalize-at-did "DID:WEB:PROXX.PROMETHEAN.REST")))
  (is (= "did:web:proxx.promethean.rest:Peer:Local" (owner/normalize-at-did "did:web:Proxx.Promethean.Rest:Peer:Local"))
      "only the host is lower-cased")
  (is (= "did:web:proxx.promethean.rest/Peer/Local" (owner/normalize-at-did "did:web:Proxx.Promethean.Rest/Peer/Local")))
  (is (= "did:web:h.example/a:B" (owner/normalize-at-did "did:web:H.Example/a:B")) "the earliest separator ends the host")
  (is (= plc (owner/normalize-at-did (str " " (.toUpperCase plc) " "))) "did:plc is lower-cased and trimmed")
  (is (= "invalid at did: did:key:z6Mkabc"
         (try (owner/normalize-at-did "did:key:z6Mkabc") (catch :default e (ex-message e))))))

(deftest owner-credentials
  (is (= {"kind" "at_did" "value" plc "ownerSubject" plc} (owner/parse-owner-credential fake-sha plc)))
  (testing "anything else is an admin key owned by its fingerprint"
    (let [c (owner/parse-owner-credential fake-sha "  super-secret ")]
      (is (= "admin_key" (get c "kind")))
      (is (= "super-secret" (get c "value")))
      (is (= (str "legacy_admin_key:" (subs (fake-sha "super-secret") 0 32)) (get c "ownerSubject"))
          "the fingerprint is the first 32 hex characters of the injected digest")))
  (is (nil? (owner/parse-owner-credential fake-sha nil)))
  (is (nil? (owner/parse-owner-credential fake-sha "   "))))
