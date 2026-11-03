(ns proxx.runtime.strategy-routes-test
  "The ordering and auto-model glue that used to live in
  src/lib/provider-strategy/{shared,strategies/*}.ts: the host's own objects come back
  in the verdict's order, and the ranking is a callback the kernels sequence."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.strategy-routes :as edge]))

(defn- cand [provider account] #js {:providerId provider :account #js {:accountId account}})
(defn- ids [xs] (mapv (fn [^js x] (str (.-providerId x) "/" (.-accountId (.-account x)))) (array-seq xs)))

(deftest affinities-put-preferred-candidates-first-and-return-the-same-objects
  (let [a (cand "p" "1") b (cand "p" "2") c (cand "q" "1")
        out (edge/reorder-candidates-for-affinities-js #js [a b c] #js [#js {:providerId "q" :accountId "1"}])]
    (is (= ["q/1" "p/1" "p/2"] (ids out)))
    (is (identical? c (aget out 0)) "the host's own objects, not copies")
    (is (= ["p/1" "p/2" "q/1"] (ids (edge/reorder-candidates-for-affinities-js #js [a b c] #js []))) "no preference keeps the order")))

(deftest accounts-for-request-is-a-permutation-of-the-input
  (let [a #js {:accountId "1" :planType "free"} b #js {:accountId "2" :planType "pro"}
        out (edge/provider-accounts-for-request-js #js [a b] "openai" "gpt-5.4")]
    (is (= 2 (.-length out)))
    (is (= #{a b} (set (array-seq out))))))

(deftest latency-order-asks-the-store-per-account-and-tolerates-missing-samples
  (let [asked (atom [])
        fast #js {:accountId "fast" :planType "pro"} slow #js {:accountId "slow" :planType "pro"} none #js {:accountId "none" :planType "pro"}
        store #js {:getPerfSummary (fn [provider account model mode]
                                     (swap! asked conj [provider account model mode])
                                     (case account
                                       "fast" #js {:ewmaTtftMs 100 :ewmaTps 50}
                                       "slow" #js {:ewmaTtftMs 900 :ewmaTps 5}
                                       nil))}
        out (edge/reorder-accounts-for-latency-js store "p" #js [slow none fast] "m" "chat_completions")]
    (is (= 3 (count @asked)))
    (is (= [["p" "slow" "m" "chat_completions"] ["p" "none" "m" "chat_completions"] ["p" "fast" "m" "chat_completions"]] @asked))
    (is (< (.indexOf out fast) (.indexOf out slow)) "lower ttft first")
    ;; ttft and tps disagree: the field read for ttft decides, not tps
    (let [quick #js {:accountId "quick" :planType "pro"} bulky #js {:accountId "bulky" :planType "pro"}
          store2 #js {:getPerfSummary (fn [_ account _ _]
                                        (case account
                                          "quick" #js {:ewmaTtftMs 100 :ewmaTps 5}
                                          "bulky" #js {:ewmaTtftMs 900 :ewmaTps 50}))}
          out2 (edge/reorder-accounts-for-latency-js store2 "p" #js [bulky quick] "m" "chat_completions")]
      (is (= "quick" (.-accountId (aget out2 0))) "ttft outranks throughput"))))

(deftest auto-model-resolution-only-ranks-auto-models
  (let [calls (atom [])
        select (fn [m] (swap! calls conj m) nil)]
    (is (= "gpt-5" (edge/resolve-auto-model-js "gpt-5" select)))
    (is (empty? @calls) "a plain model is never ranked")
    (is (= "auto:fastest" (edge/resolve-auto-model-js "auto:fastest" select)) "no pick falls back to the model itself")
    (is (= ["auto:fastest"] @calls))
    (is (= "gpt-x" (edge/resolve-auto-model-js "auto:fastest" (fn [_] "gpt-x"))))))

(deftest auto-model-candidates-are-ranked-and-capped
  (is (= ["gpt-5"] (vec (edge/auto-model-candidates-js "gpt-5" (fn [_] (throw (js/Error. "must not rank")))))))
  (is (= [] (vec (edge/auto-model-candidates-js "auto:cheapest" (fn [_] #js [])))))
  (let [many (to-array (map #(str "m" %) (range 40)))
        out (edge/auto-model-candidates-js "auto:cheapest" (fn [_] many))]
    (is (= 8 (count out)) "the default cap")
    (is (= ["m0" "m1"] (vec (take 2 out))) "rank order kept")))

(deftest cephalon-plans-ranks-then-chooses
  (is (= ["gpt-5"] (vec (edge/cephalon-model-candidates-js "gpt-5" nil (fn [_ _] (throw (js/Error. "must not rank")))))))
  (is (nil? (edge/resolve-cephalon-auto-model-js "gpt-5" nil (fn [_ _] #js []))))
  (let [seen (atom nil)
        out (edge/cephalon-model-candidates-js "auto:cephalon:smartest" #js ["gpt-oss:120b" "x"]
                                               (fn [inner candidates] (reset! seen [inner (vec (array-seq candidates))]) #js ["gpt-oss:120b" "x"]))]
    (is (= "auto:smartest" (first @seen)) "the inner auto model is what gets ranked")
    (is (some #{"x"} (second @seen)) "the catalog's models are candidates")
    (is (= ["gpt-oss:120b"] (vec out)))))

(deftest vision-candidates-and-route-order
  (is (= ["gpt-5"] (vec (edge/vision-model-candidates-for-js "gpt-5" #js []))))
  (is (= "glm-5v-turbo" (first (edge/vision-model-candidates-for-js "auto:vision" #js ["glm-5v-turbo" "Kimi-K2.5"]))))
  (let [a #js {:providerId "openai" :baseUrl "u"} z #js {:providerId "zai" :baseUrl "u"}
        out (edge/reorder-vision-provider-routes-js #js [a z] "glm-5v-turbo")]
    (is (identical? z (aget out 0)) "zai is favoured for GLM vision models")
    (is (identical? a (aget out 1)))))

(deftest advancing-needs-more-candidates-an-auto-model-and-a-retryable-summary
  (let [limited #js {:sawRateLimit true} calm #js {:sawRateLimit false}]
    (doseq [[kind model] [["auto" "auto:fastest"] ["vision" "auto:vision"] ["cephalon" "auto:cephalon"]]]
      (is (true? (edge/should-advance-model-candidate-js kind model true limited)) kind)
      (is (false? (edge/should-advance-model-candidate-js kind model false limited)) "no more candidates")
      (is (false? (edge/should-advance-model-candidate-js kind model true calm)) "nothing to retry"))
    (is (false? (edge/should-advance-model-candidate-js "vision" "gpt-5" true limited)) "not that kind of model")))
