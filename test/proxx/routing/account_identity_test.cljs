(ns proxx.routing.account-identity-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.routing.account-identity :as id]
            [proxx.runtime.account-identity :as edge]))

(def ^:private auth "https://api.openai.com/auth")
(def ^:private profile "https://api.openai.com/profile")

(deftest metadata-from-claims
  (is (= {:email "a@b.c" :subject "sub1" :chatgpt-account-id "ws" :plan-type "plus"}
         (id/derive-oauth-metadata {"email" "  A@B.C " "sub" " sub1 " auth {"chatgpt_account_id" " ws " "chatgpt_plan_type" " Plus "}})))
  (is (= {:email "p@x.y"} (id/derive-oauth-metadata {profile {"email" "P@X.Y"}})) "profile email when the top-level one is not a string")
  (is (= {} (id/derive-oauth-metadata {"email" "" profile {"email" "p@x.y"}}))
      "an empty top-level email wins over the profile one and then vanishes (a ?? b stops at the empty string)")
  (is (= {:chatgpt-account-id "top"} (id/derive-oauth-metadata {"chatgpt_account_id" "top" auth {"chatgpt_account_id" "nested"}})))
  (is (= {} (id/derive-oauth-metadata nil)))
  (is (= {} (id/derive-oauth-metadata [])))
  (is (= {} (id/derive-oauth-metadata {"email" 5 "sub" nil profile "x" auth []}))))

(deftest display-name
  (is (= "e" (id/display-name {:email "e" :chatgpt-account-id "w" :id "i"})))
  (is (= "" (id/display-name {:email "" :id "i"})) "an empty email still wins: only nil falls through")
  (is (= "w" (id/display-name {:chatgpt-account-id "w" :id "i"})))
  (is (= "i" (id/display-name {:id "i"}))))

(deftest reauth-matching
  (is (id/reauth-identity-matches? {:subject " s "} {:subject "s"}))
  (is (id/reauth-identity-matches? {:subject "a" :email "X@Y.z"} {:subject "b" :email " x@y.Z "}) "falls through to email")
  (is (not (id/reauth-identity-matches? {:subject "a"} {:subject "b"})))
  (is (id/reauth-identity-matches? {:chatgpt-account-id "w"} {:chatgpt-account-id " w " :email "e"})
      "workspace matches only when the target has no subject or email")
  (is (not (id/reauth-identity-matches? {:chatgpt-account-id "w" :email "e"} {:chatgpt-account-id "w"})))
  (is (not (id/reauth-identity-matches? {} {}))))

(deftest blank-subject-target-falls-back-to-workspace
  (is (id/reauth-identity-matches? {:chatgpt-account-id "w" :subject " "} {:chatgpt-account-id "w" :subject "s"})))

(defn- jwt [claims]
  (let [b64 (fn [o] (-> (js/Buffer.from (js/JSON.stringify o)) (.toString "base64url")))]
    (str "h." (b64 (clj->js claims)) ".s")))

(deftest edge-token-decoding
  (let [m (edge/derive-oauth-metadata-from-token-js (jwt {"email" "A@B.C" "sub" "s" auth {"chatgpt_plan_type" "Pro"}}))]
    (is (= "a@b.c" (.-email m)))
    (is (= "pro" (.-planType m)))
    (is (js/Object.hasOwn m "chatgptAccountId") "all four keys are present, undefined when absent")
    (is (undefined? (.-chatgptAccountId m))))
  (is (= 0 (.-length (js/Object.keys (edge/derive-oauth-metadata-from-token-js "not-a-jwt")))))
  (is (= 0 (.-length (js/Object.keys (edge/derive-oauth-metadata-from-token-js "a.%%%.c")))))
  (is (= 0 (.-length (js/Object.keys (edge/derive-oauth-metadata-from-token-js (str "h." (.toString (js/Buffer.from "5") "base64url") ".s")))))
      "a JSON scalar payload is not claims")
  (is (= 4 (.-length (js/Object.keys (edge/derive-oauth-metadata-from-token-js (str "h." (.toString (js/Buffer.from "[1]") "base64url") ".s")))))
      "a JSON array payload counts as claims (all-undefined fields), as in TS"))

(deftest edge-display-and-matching
  (is (= "w" (edge/account-display-name-js #js {:chatgptAccountId "w" :id "i"})))
  (is (= "e" (edge/account-display-name-js #js {:email "e" :id "i"})))
  (is (edge/open-ai-reauth-identity-matches-js #js {:email "A@b"} #js {:email "a@B"})))
