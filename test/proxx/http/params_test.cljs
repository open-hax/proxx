(ns proxx.http.params-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.params :as p]))

(deftest parse-int-is-parseint
  (is (= 12 (p/parse-int "12abc")))
  (is (= -3 (p/parse-int "  -3")))
  (is (= 0 (p/parse-int "0x10")))
  (is (p/nan? (p/parse-int "abc")))
  (is (p/nan? (p/parse-int "")))
  (is (p/nan? (p/parse-int nil)))
  (is (= 1e20 (p/parse-int "100000000000000000000"))))

(deftest js-string-matches-String
  (is (= "a,b" (p/js-string ["a" "b"])))
  (is (= "1,,2" (p/js-string [1 nil 2])))
  (is (= "null" (p/js-string nil)))
  (is (= "[object Object]" (p/js-string {"a" 1})))
  (is (= "5" (p/js-string 5)))
  (is (= "true" (p/js-string true))))

(deftest truthy-string
  (is (not (p/truthy-string? "")))
  (is (not (p/truthy-string? nil)))
  (is (p/truthy-string? "0"))
  (is (p/truthy-string? ["a"])))
