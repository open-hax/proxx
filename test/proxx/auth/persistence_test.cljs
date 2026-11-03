(ns proxx.auth.persistence-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.auth.persistence :as ap]))

(defn- parse [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))

(deftest tokens
  (is (= {"token" "t" "clientId" "c" "subject" "s" "scopes" ["a"] "expiresAt" 1700000000}
         (ap/token-view {"token" "t" "client_id" "c" "subject" "s" "scopes" "[\"a\"]" "expires_at" "1700000000"} parse)))
  (doseq [bad [nil "" "not json" "null"]]
    (is (= [] (get (ap/token-view {"scopes" bad "expires_at" 1} parse) "scopes")) (pr-str bad)))
  (is (= "r" (get (ap/token-view {"resource" "r" "expires_at" 1} parse) "resource")))
  (is (not (contains? (ap/token-view {"resource" nil "expires_at" 1} parse) "resource"))))

(deftest sessions-and-clients
  (is (= 99 (get (ap/session-view {"expires_at" 1} parse 99) "createdAt")))
  (let [c (ap/client-view {"client_id" "c" "redirect_uris" nil "grant_types" nil "response_types" "bad"} parse)]
    (is (= [] (get c "redirectUris")))
    (is (= ["authorization_code" "refresh_token"] (get c "grantTypes")))
    (is (= ["code"] (get c "responseTypes")))))
