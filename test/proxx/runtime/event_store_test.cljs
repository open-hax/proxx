(ns proxx.runtime.event-store-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.events.store :as store]
            [proxx.runtime.event-store :as es]))

(defn- fake-sql [calls]
  (let [sql (fn [strings & values] (swap! calls conj [:tpl (vec strings) (vec values)]) (js/Promise.resolve #js []))]
    (aset sql "unsafe" (fn [text _] (swap! calls conj [:unsafe text]) (js/Promise.resolve #js [])))
    (aset sql "json" (fn [v] #js {"json" v}))
    sql))

(deftest pure-write-decisions
  (is (nil? (store/merged-tags ["a"] [])) "no labeler tagged it: buffered as given")
  (is (= ["a" "x" "y"] (store/merged-tags ["a"] ["x" "y"])))
  (is (= ["x"] (store/merged-tags nil ["x"])))
  (is (store/full? 200 200))
  (is (not (store/full? 199 200)))
  (is (= [50 50 3] (map count (store/chunks (range 103))))))

(deftest labelers-append-tags-and-flush-writes-rows
  (async done
    (let [calls (atom [])
          ^js s (es/create-event-store-js (fake-sql calls) 100000 200)]
      (.registerLabeler s #js {"id" "l" "applies" (fn [_] true) "label" (fn [_] #js ["auto"])})
      (.emit s #js {"kind" "request" "entryId" "e1" "tags" #js ["own"] "meta" #js {"k" 1} "payload" #js {"a" 1}})
      (-> (.flush s)
          (.then (fn [_]
                   (let [[kind strings values] (first @calls)]
                     (is (= :tpl kind))
                     (is (= (dec (count strings)) (count values)))
                     (is (= ["request" "e1" nil nil nil nil] (subvec (vec values) 0 6)) "absent optional fields are null")
                     (is (= ["own" "auto"] (vec (.-json ^js (nth values 6)))))
                     (is (= 7 (nth values 9)) "payload bytes = size of {\"a\":1}"))
                   (.close s)))
          (.then (fn [_] (done)))))))

(deftest a-failing-chunk-does-not-reject-flush
  (async done
    (let [sql (fn [& _] (js/Promise.reject (js/Error. "boom")))
          _ (aset sql "json" (fn [v] v))
          ^js s (es/create-event-store-js sql 100000 200)
          orig js/console.error]
      (set! js/console.error (fn [& _] nil))
      (.emit s #js {"kind" "error" "entryId" "e"})
      (-> (.flush s)
          (.then (fn [_] (set! js/console.error orig) (is true) (.close s)))
          (.then (fn [_] (done)))))))
