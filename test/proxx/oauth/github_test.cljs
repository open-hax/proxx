(ns proxx.oauth.github-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.oauth.github :as gh]))

(deftest callback-query-rejections
  (is (= {:status 400 :body {"error" "access_denied" "error_description" "d"}}
         (gh/callback-rejection {"error" "access_denied" "error_description" "d" "code" "c" "state" "s"})))
  (is (= {:status 400 :body {"error" "access_denied"}} (gh/callback-rejection {"error" "access_denied"}))
      "an absent description is omitted, not null")
  (is (= "invalid_request" (get-in (gh/callback-rejection {"code" "c"}) [:body "error"])))
  (is (= "invalid_request" (get-in (gh/callback-rejection {"state" "s" "code" ""}) [:body "error"])))
  (is (nil? (gh/callback-rejection {"code" "c" "state" "s"}))))

(deftest pending-states
  (let [p (gh/add-pending {} "s" {:redirect-uri "/x" :created-at 1000})
        [entry p'] (gh/take-pending p "s")]
    (is (empty? p') "taking consumes the entry")
    (is (nil? (gh/pending-rejection entry (+ 1000 gh/pending-ttl-ms))) "exactly five minutes is still valid")
    (is (= "expired_state" (get-in (gh/pending-rejection entry (+ 1001 gh/pending-ttl-ms)) [:body "error"])))
    (is (= "invalid_state" (get-in (gh/pending-rejection nil 0) [:body "error"])))
    (let [[e p''] (gh/take-pending p' "s")] (is (nil? e)) (is (empty? p'')))))

(deftest refresh-decision
  (is (= :missing (gh/refresh-plan false nil 10)))
  (is (= :expired (gh/refresh-plan true 10 10)) "expiry is inclusive")
  (is (= :rotate (gh/refresh-plan true 11 10))))

(deftest cookies
  (let [decode js/decodeURIComponent]
    (is (= "v" (gh/cookie-value "a=1; proxy_auth=v; b=2" "proxy_auth" decode)))
    (is (= "a b" (gh/cookie-value "proxy_auth=a%20b" "proxy_auth" decode)))
    (is (nil? (gh/cookie-value nil "x" decode)))
    (is (nil? (gh/cookie-value "xproxy_auth=1" "proxy_auth" decode)) "name must match from the start of the pair")
    (is (= "first" (gh/cookie-value "t=first;t=second" "t" decode)))
    (is (thrown? js/Error (gh/cookie-value "t=%E0%A4%A" "t" decode)) "a malformed value still throws, as before"))
  (is (= "n=v; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=E" (gh/set-cookie-header "n" "v" "E")))
  (is (= "n=; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT" (gh/clear-cookie-header "n"))))

(deftest bearer-and-views
  (is (= "tok" (gh/bearer-from-authorization "Bearer tok")))
  (is (nil? (gh/bearer-from-authorization "bearer tok")) "this route's check is case-sensitive")
  (is (nil? (gh/bearer-from-authorization nil)))
  (is (= {"id" "a" "authType" "api_key" "hasToken" true "hasRefreshToken" false}
         (gh/admin-account-view {"accountId" "a" "authType" "api_key" "refreshToken" ""})))
  (is (= "x" (gh/normalize-login "  X ")))
  (is (= [["client_id" "c"] ["redirect_uri" "r"] ["scope" "read:user user:email"] ["state" "s"]]
         (gh/authorize-params "c" "r" "s"))))
