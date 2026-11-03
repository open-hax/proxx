(ns proxx.http.streams-test
  (:require [cljs.test :refer [deftest is testing]]
            [clojure.string :as str]
            [proxx.http.streams :as streams]
            [proxx.runtime.routes.ws :as ws]))

(deftest route-kinds
  (is (= "local" (streams/route-kind " Local ")))
  (is (= "any" (streams/route-kind "ANY")))
  (is (nil? (streams/route-kind "nope")))
  (is (nil? (streams/route-kind nil)))
  (testing "a repeated parameter (an array) is ignored; the TS threw a TypeError (500)"
    (is (nil? (streams/route-kind ["local" "bridge"])))))

(deftest subscription
  (is (= {} (streams/request-log-subscription nil nil)))
  (is (= {:ownerSubject "o" :routeKind "bridge"} (streams/request-log-subscription " o " "bridge")))
  (is (= {} (streams/request-log-subscription "  " "zzz"))))

(deftest identity-mapping
  (is (= {:authKind "legacy_admin" :tenantId "t"} (streams/identity-of {"kind" "legacy_admin" "tenantId" "t" "subject" "s"} false)))
  (is (= {:authKind "ui_session" :subject "s"} (streams/identity-of {"kind" "ui_session" "subject" "s"} true)))
  (testing "every non-admin manager is reported as a ui_session"
    (is (= "ui_session" (:authKind (streams/identity-of {"kind" "tenant_api_key"} false))))))

(deftest session-access
  (let [session {:authSubject " s " :tenantId "t"}]
    (is (streams/can-access-session? {:authKind "legacy_admin"} session))
    (is (streams/can-access-session? {:authKind "ui_session" :subject "s" :tenantId " t"} session))
    (is (not (streams/can-access-session? {:authKind "ui_session" :subject "x" :tenantId "t"} session)))
    (is (not (streams/can-access-session? {:authKind "ui_session" :subject "s" :tenantId "other"} session)))
    (testing "an empty subject never matches, even an empty session subject"
      (is (not (streams/can-access-session? {:authKind "ui_session" :subject ""} {:authSubject ""}))))))

(deftest origins
  (is (streams/origin-allowed? nil "h"))
  (is (streams/origin-allowed? "" "h"))
  (is (streams/origin-allowed? "http://localhost" "h"))
  (is (streams/origin-allowed? "http://localhost:5173" "h"))
  (is (streams/origin-allowed? "http://127.0.0.1:1" "h"))
  (is (streams/origin-allowed? "https://proxx.example" "proxx.example"))
  (is (streams/origin-allowed? "http://proxx.example" "proxx.example"))
  (is (not (streams/origin-allowed? "https://evil.example" "proxx.example")))
  (testing "https localhost is not special"
    (is (not (streams/origin-allowed? "https://localhost" "h")))))

(deftest frames
  (is (= "event: session_bound\ndata: {\"sessionId\":\"s1\",\"sentAt\":\"t\",\"message\":\"SSE channel bound to bridge session\"}\n\n"
         (streams/sse-open-frame "s1" "t")))
  (is (str/starts-with? (streams/sse-open-frame nil "t") "event: sse_open\ndata: {\"protocolVersion\":\"bridge-sse-v0\"")))

(deftest upgrade-handler-throws-on-unparsable-target
  ;; Pinned security observation: a request target `new URL` rejects throws out of
  ;; the `upgrade` listener before any authentication (the TS original did too).
  (let [handler (ws/upgrade-handler {})]
    (is (thrown? js/Error (handler #js {:url "//["} nil nil)))
    (testing "other paths are ignored"
      (is (nil? (handler #js {:url "/somewhere/else"} nil nil))))))
