(ns proxx.errors.classification-test
  (:require [clojure.test :refer [deftest is testing]]
            [proxx.errors.classification :as c]))

(deftest extract-error-message-precedence
  (is (= "raw" (c/extract-error-message "raw")))
  (is (= "direct" (c/extract-error-message {"message" "direct" "error" "ignored"})))
  (is (= "flat" (c/extract-error-message {"error" "flat"})))
  (is (= "nested" (c/extract-error-message {"error" {"message" "nested" "code" "c"}})))
  (is (= "c" (c/extract-error-message {"error" {"code" "c"}})))
  (is (nil? (c/extract-error-message {"error" {}})))
  (is (nil? (c/extract-error-message nil)))
  (is (nil? (c/extract-error-message {"message" "  "}))))

(deftest error-like-payload
  (is (c/error-like-payload? {"error" {}}))
  (is (c/error-like-payload? {"type" "invalid_request_ERROR"}))
  (is (c/error-like-payload? {"event" "response.error"}))
  (is (c/error-like-payload? {"object" "error"}))
  (is (not (c/error-like-payload? {"type" "message"})))
  (is (not (c/error-like-payload? "error")))
  (is (not (c/error-like-payload? nil))))

(deftest quota-message-separator-insensitive
  (doseq [m ["insufficient_quota" "Insufficient-Credits" "payment   required"
             "You hit your MONTHLY LIMIT" "outstanding_balance"]]
    (is (c/quota-message? m) m))
  (is (not (c/quota-message? "rate limit reached"))))

(deftest truncate-for-log
  (is (= "a b c" (c/truncate-for-log "  a\n b\t c  ")))
  (is (= "abcd…" (c/truncate-for-log "abcdefgh" 5)))
  (is (= "abc" (c/truncate-for-log "abc" 3))))

(deftest quota-error-verdicts
  (let [json {:content-type "application/json"}]
    (testing "status short-circuits"
      (is (c/quota-error? {:status 402}))
      (doseq [s [429 403 503]]
        (is (not (c/quota-error? (assoc json :status s :payload {"error" "insufficient quota"}))))))
    (testing "streams and header-less responses are not body-inspected"
      (is (not (c/quota-error? {:status 400 :content-type "text/event-stream" :payload {"error" "quota exceeded"}})))
      (is (not (c/quota-error? {:status 400 :payload {"error" "quota exceeded"}}))))
    (testing "body decides"
      (is (c/quota-error? (assoc json :status 400 :payload {"error" {"message" "Insufficient quota"}})))
      (is (not (c/quota-error? (assoc json :status 200 :payload {"ok" "insufficient quota"}))))
      (is (c/quota-error? (assoc json :status 400 :payload {"error" {"detail" "quota_exceeded"}}))
          "falls back to scanning the whole error payload")
      (is (not (c/quota-error? (assoc json :status 400 :payload {"detail" "quota_exceeded"})))
          "non-error-like payload without a message is not a quota error"))))

(deftest quota-body-needed
  (is (c/quota-body-needed? {:status 400 :content-type "application/json"}))
  (is (c/quota-body-needed? {:status 200 :content-type "application/json; charset=utf-8"}))
  (is (not (c/quota-body-needed? {:status 402 :content-type "application/json"})))
  (is (not (c/quota-body-needed? {:status 429 :content-type "application/json"})))
  (is (not (c/quota-body-needed? {:status 400 :content-type "Text/Event-Stream"})))
  (is (not (c/quota-body-needed? {:status 400 :content-type ""})))
  (is (not (c/quota-body-needed? {:status 400}))))

(deftest missing-model-verdicts
  (let [f {:status 404 :payload {"error" {"message" "The model gpt-x was not found"}}}]
    (is (c/missing-model? f "gpt-x"))
    (is (c/missing-model? f "  "))
    (is (not (c/missing-model? f "other")))
    (is (c/missing-model? {:status 404 :payload {"error" "model_not_found: model not found"}} "other"))
    (is (not (c/missing-model? (assoc f :status 500) "gpt-x")))
    (is (not (c/missing-model? {:status 404 :payload {"error" "not found"}} "gpt-x")))))

(deftest model-not-supported-verdicts
  (testing "subscription wording is enough"
    (is (c/model-not-supported-for-account?
         {:status 403 :payload {"error" "this model requires a subscription, upgrade for access"}} "glm-5")))
  (testing "401 never matches"
    (is (not (c/model-not-supported-for-account? {:status 401 :payload {"error" "unauthorized"}} "m"))))
  (testing "access denied needs the model or an account mention"
    (is (c/model-not-supported-for-account?
         {:status 403 :payload {"error" "You do not have access to gpt-5"}} "gpt-5"))
    (is (c/model-not-supported-for-account?
         {:status 400 :payload {"error" "model is not supported with a ChatGPT account"}} "gpt-5"))
    (is (not (c/model-not-supported-for-account?
              {:status 400 :payload {"error" "model access denied"}} "gpt-5")))
    (is (c/model-not-supported-for-account? {:status 400 :payload {"error" "model access denied"}} ""))))

(deftest summarize-upstream-error
  (is (= {} (c/summarize-upstream-error nil)))
  (is (= {} (c/summarize-upstream-error "")))
  (is (= {:upstream-error-message "boom"} (c/summarize-upstream-error "boom")))
  (is (= {:upstream-error-code "c" :upstream-error-type "t" :upstream-error-message "m"}
         (c/summarize-upstream-error {"error" {"code" "c" "type" "t" "message" "m"}})))
  (is (= {:upstream-error-code "top" :upstream-error-message "top"}
         (c/summarize-upstream-error {"code" "top" "message" "top"}))
      "top-level code/type are the fallback when error is not an object"))

(deftest sse-and-stream-quota
  (let [parse (fn [s] #?(:cljs (js->clj (js/JSON.parse s)) :clj (throw (ex-info "no json" {}))))
        body "event: x\r\ndata: {\"type\":\"error\",\"error\":{\"message\":\"quota exceeded\"}}\n\ndata: [DONE]\n"]
    (is (= ["{\"a\":1}" "[DONE]"] (c/sse-data-lines "data: {\"a\":1}\ndata:\nnoise\ndata:  [DONE] \n")))
    #?(:cljs
       (testing "parsed error events"
         (is (c/stream-quota-error? parse body))
         (is (not (c/stream-quota-error? parse "data: {\"type\":\"message\",\"text\":\"quota exceeded\"}\n")))
         (is (not (c/stream-quota-error? parse "data: [DONE]\n")))))
    (testing "unparseable events are judged as text"
      (is (c/stream-quota-error? (fn [_] (throw (ex-info "bad" {}))) "data: payment required\n"))
      (is (not (c/stream-quota-error? (fn [_] (throw (ex-info "bad" {}))) "data: hello\n"))))))
