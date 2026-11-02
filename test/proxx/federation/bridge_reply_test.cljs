(ns proxx.federation.bridge-reply-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.federation.bridge-reply :as r]))

(def ctx {:owner-subject "owner" :peer-label "bridge:c:a"})

(defn- run [events]
  (reduce (fn [[state effects] event]
            (let [[state' fx] (r/step state event ctx)] [state' (into effects fx)]))
          [r/initial []] events))

(deftest buffered-json-reply
  (let [[state effects] (run [{"type" "response_head" "status" 201
                               "headers" {"content-type" "application/json" "Content-Length" "9" "x-a" "1"}}
                              {"type" "response_chunk" "chunk" "{\"a\":1}" "encoding" "utf8"}
                              {"type" "response_end"}])]
    (is (= [{:op :set-headers :pairs [["content-type" "application/json"] ["x-a" "1"]
                                      ["x-open-hax-federation-owner-subject" "owner"]
                                      ["x-open-hax-federation-routed-peer" "bridge:c:a"]]}
            {:op :status :code 201}
            {:op :buffer :chunk "{\"a\":1}" :encoding "utf8"}]
           effects) "content-length is dropped, the owner and peer are attributed")
    (is (= {:op :send :json? true} (r/finish state)))))

(deftest event-stream-is-hijacked
  (let [[state effects] (run [{"type" "response_head" "status" 200 "headers" {"content-type" "text/event-stream"}}
                              {"type" "response_chunk" "chunk" "ZGF0YQ==" "encoding" "base64"}])]
    (is (= [{:op :remove-header :name "content-length"}
            {:op :set-headers :pairs [["cache-control" "no-cache"] ["x-accel-buffering" "no"]
                                      ["content-type" "text/event-stream; charset=utf-8"]]}
            {:op :hijack :status 200}
            {:op :write :chunk "ZGF0YQ==" :encoding "base64"}]
           (drop 2 effects)))
    (is (= {:op :end-stream} (r/finish state)))))

(deftest chunk-without-head-implies-a-200
  (let [[state effects] (run [{"type" "response_chunk" "chunk" "hi" "encoding" "utf8"}])]
    (is (= [{:op :set-headers :pairs [["x-open-hax-federation-owner-subject" "owner"]
                                      ["x-open-hax-federation-routed-peer" "bridge:c:a"]]}
            {:op :status :code 200}
            {:op :buffer :chunk "hi" :encoding "utf8"}]
           effects))
    (is (= {:op :send :json? false} (r/finish state)) "no head, so no content type to parse as JSON")))

(deftest end-and-unknown-events-change-nothing
  (is (= [r/initial []] (r/step r/initial {"type" "response_end"} ctx)))
  (is (= [r/initial []] (r/step r/initial {"type" "mystery"} ctx))))

(deftest provenance-and-frames
  (let [env {"FEDERATION_SELF_CLUSTER_ID" " c1 " "FEDERATION_SELF_NODE_ID" ""}
        p (r/provenance env "openai")]
    (is (= {"servedByClusterId" "c1" "servedByNodeId" "" "providerId" "openai"} p)
        "trimmed; an empty value is kept, an unset one stays absent")
    (is (= {"type" "response_head" "status" 200 "headers" {"a" "b"} "providerId" "openai" "servedByClusterId" "c1" "servedByNodeId" ""}
           (r/head-event p 200 {"a" "b"})))
    (is (= {} (r/provenance {} nil)))
    (is (= "response_end" (get (r/end-event p) "type")))
    (is (= "base64" (get (r/chunk-event p "x" "base64") "encoding")))))

(deftest native-injection-auth
  (is (= {"content-type" "application/json"} (r/native-injection-headers nil "Bearer x")))
  (is (= {"content-type" "application/json"} (r/native-injection-headers "" "Bearer x")))
  (testing "a client that presented the token keeps its header, anyone else is given it"
    (is (= "bearer tok" (get (r/native-injection-headers "tok" "bearer tok") "authorization")))
    (is (= "Bearer tok" (get (r/native-injection-headers "tok" "Bearer other") "authorization")))
    (is (= "Bearer tok" (get (r/native-injection-headers "tok" nil) "authorization")))))
