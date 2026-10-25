(ns proxx.observability.fanout-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.observability.fanout :as f]))

(def admin {"authKind" "legacy_admin"})
(defn tenant [t] {"authKind" "ui_session" "tenantId" t})

(deftest route-kind-normalization
  (is (= "local" (f/normalize-route-kind "  LoCal ")))
  (is (nil? (f/normalize-route-kind "other")))
  (is (nil? (f/normalize-route-kind nil)))
  (is (nil? (f/normalize-route-kind 3))))

(deftest visibility
  (is (f/entry-visible-to-identity? {"tenantId" "x"} admin))
  (is (f/entry-visible-to-identity? {"tenantId" "x"} (tenant " x ")))
  (is (not (f/entry-visible-to-identity? {"tenantId" "x"} (tenant "y"))))
  (is (not (f/entry-visible-to-identity? {} (tenant "")))
      "blank tenant sees nothing, even entries with no tenant")
  (is (not (f/entry-visible-to-identity? {"tenantId" "x"} {"authKind" "ui_session"}))))

(deftest subscription-filters
  (is (f/entry-matches-subscription? {"routeKind" "local"} {}))
  (is (f/entry-matches-subscription? {"routeKind" "local"} {"routeKind" "any"}))
  (is (f/entry-matches-subscription? {"routeKind" "local"} {"routeKind" "bogus"}) "unknown kinds filter nothing")
  (is (not (f/entry-matches-subscription? {"routeKind" "local"} {"routeKind" "routed"})))
  (is (f/entry-matches-subscription? {"routeKind" "bridge"} {"routeKind" "routed"}))
  (is (f/entry-matches-subscription? {"routeKind" nil} {"routeKind" "routed"}) "routed = anything but local")
  (is (not (f/entry-matches-subscription? {"routeKind" "bridge"} {"routeKind" "federated"})))
  (is (f/entry-matches-subscription? {"federationOwnerSubject" "o"} {"ownerSubject" " o "}))
  (is (not (f/entry-matches-subscription? {} {"ownerSubject" "o"})))
  (is (f/entry-matches-subscription? {} {"ownerSubject" "   "})))

(deftest state-transitions
  (let [s (-> f/empty-state
              (f/subscribe "b" admin {})
              (f/subscribe "a" (tenant "t") {"routeKind" "federated"})
              (f/subscribe "c" admin {"routeKind" "local"}))]
    (testing "subscription order, not id order"
      (is (= ["b" "a"] (f/recipients s {"tenantId" "t" "routeKind" "federated"})))
      (is (= ["b" "c"] (f/recipients s {"tenantId" "z" "routeKind" "local"}))))
    (testing "resubscribe keeps position, unsubscribe removes"
      (is (= ["b" "a"] (f/recipients (f/subscribe s "b" admin {}) {"tenantId" "t" "routeKind" "federated"})))
      (is (= ["a"] (f/recipients (f/unsubscribe s "b") {"tenantId" "t" "routeKind" "federated"})))
      (is (= 3 (f/client-count s))))
    (testing "a client added after a resubscribe still orders last"
      (let [s2 (-> s (f/subscribe "b" admin {}) (f/subscribe "d" admin {}))]
        (is (= ["b" "c" "d"] (f/recipients s2 {"routeKind" "local"})))))
    (is (= "request_log_record" (f/event-wire-type "record")))
    (is (= "request_log_update" (f/event-wire-type "update")))))
