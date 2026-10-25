(ns proxx.http.request-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.request :as r]
            [proxx.runtime.http :as edge]))

(deftest cookies
  (is (= "v" (r/read-cookie-token "a=1; tok=v; b=2" "tok")))
  (is (= "a b" (r/read-cookie-token "tok=a%20b" "tok")))
  (is (= "%E0%A4%A" (r/read-cookie-token "tok=%E0%A4%A" "tok")) "malformed escapes fall back to raw")
  (is (= "" (r/read-cookie-token "tok=" "tok")) "an empty value is still a value")
  (is (= "first" (r/read-cookie-token "tok=first; tok=second" "tok")))
  (is (nil? (r/read-cookie-token "xtok=1" "tok")) "name must match exactly")
  (is (nil? (r/read-cookie-token "" "tok")))
  (is (nil? (r/read-cookie-token nil "tok"))))

(deftest json-if-possible
  (let [parse #(js->clj (js/JSON.parse %))]
    (is (= {:value {"a" 1}} (r/parse-json-if-possible parse "{\"a\":1}")))
    (is (= {:value nil} (r/parse-json-if-possible parse "null")) "null is a value, not a failure")
    (is (nil? (r/parse-json-if-possible parse "  ")))
    (is (nil? (r/parse-json-if-possible parse "{nope")))))

(deftest headers-and-models
  (is (= "x" (r/single-header-value "x")))
  (is (= "b" (r/single-header-value ["" 5 "b" "c"])))
  (is (nil? (r/single-header-value ["" nil])))
  (is (nil? (r/single-header-value 5)))
  (is (= "m" (r/normalize-requested-model "  m\n")))
  (is (nil? (r/normalize-requested-model "   ")))
  (is (nil? (r/normalize-requested-model 5)))
  (is (= "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;" (r/escape-html "<a href=\"x\">&'</a>")))
  (doseq [a ["127.0.0.1" "::1" "::ffff:127.0.0.1"]] (is (r/trusted-local-bridge-address? a)))
  (is (not (r/trusted-local-bridge-address? "10.0.0.1")))
  (is (not (r/trusted-local-bridge-address? nil))))

(deftest bearer
  (is (r/bearer-token? "Bearer secret" "secret"))
  (is (r/bearer-token? "bEaReR   secret extra" "secret") "only the first two fields count")
  (is (not (r/bearer-token? "Bearer wrong" "secret")))
  (is (not (r/bearer-token? "Bearer secre" "secret")))
  (is (not (r/bearer-token? "Bearer Secret" "secret")) "same length, differs only in case")
  (is (not (r/bearer-token? "Bearer secrex" "secret")) "same length, differs in the last char")
  (is (r/bearer-token? "Bearer sécret" "sécret"))
  (is (r/bearer-token? "Bearer " ""))
  (is (not (r/bearer-token? "Basic secret" "secret")))
  (is (not (r/bearer-token? " Bearer secret" "secret")) "leading whitespace yields an empty scheme")
  (is (not (r/bearer-token? "Bearer" "secret")))
  (is (not (r/bearer-token? "" "secret")))
  (is (not (r/bearer-token? nil "secret"))))

(deftest queue-errors
  (is (= {:status 429 :message "Request queue full" :type "server_error" :code "queue_full" :retry-after-seconds 3}
         (r/queue-error-response {"code" ":queue/full" "retry-after-ms" 2100})))
  (is (= 1 (:retry-after-seconds (r/queue-error-response {:code :queue/full :retryAfterMs 5}))))
  (is (not (contains? (r/queue-error-response {:code "queue/full" "retry-after-ms" "soon"}) :retry-after-seconds)))
  (doseq [code ["queue/dropped" "queue/total-timeout" ":queue/exhausted"]]
    (is (= {:status 503 :message "Request queue dropped or timed out" :type "server_error" :code "queue_dropped"}
           (r/queue-error-response {"code" code}))))
  (is (= 429 (:status (r/queue-error-response {"code" {"ns" "queue" "name" "full"}}))) "serialized keyword object")
  (is (nil? (r/queue-error-response {"code" "other"})))
  (is (nil? (r/queue-error-response nil))))

(deftest edge-preserves-js-values
  (let [parsed (edge/parse-json-if-possible-js "{\"z\":1,\"a\":[1,null]}")]
    (is (= ["z" "a"] (vec (js/Object.keys parsed))) "key order untouched"))
  (is (nil? (edge/parse-json-if-possible-js "null")))
  (is (undefined? (edge/parse-json-if-possible-js "")))
  (is (= "b" (edge/read-single-header-js #js {"h" #js ["" "b"]} "h")))
  (is (undefined? (edge/read-single-header-js #js {} "h")))
  (is (undefined? (edge/read-cookie-token-js "a=1" "tok")))
  (is (= 429 (.-statusCode (edge/queue-error-response-js #js {"data" #js {"code" "queue/full"}}))))
  (is (undefined? (edge/queue-error-response-js #js {"data" #js {"code" "x"}})))
  (is (undefined? (edge/queue-error-response-js #js {}))))
