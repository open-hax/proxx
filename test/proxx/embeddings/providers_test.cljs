(ns proxx.embeddings.providers-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.embeddings.providers :as p]))

(deftest config-from-env
  (let [cfg (p/embeddings-config {"HF_API_KEY" "k" "TEI_EMBED_DIMENSIONS" "256" "LLAMACPP_EMBED_DIMENSIONS" ""})]
    (is (= 1024 (get-in cfg ["llamacpp-embed" "defaultDimensions"])) "empty means unset")
    (is (= 256 (get-in cfg ["tei" "defaultDimensions"])))
    (is (= ["endpoint" "apiKey" "defaultModel"] (keys (get cfg "huggingface-cloud"))) "unset dimensions are absent, not null")
    (is (= "ollama" (get cfg "defaultProvider")))))

(deftest requests
  (is (= "http://h/pipeline/feature-extraction/a%2Fb"
         (:url (p/request "huggingface-cloud" {"endpoint" "http://h"} {"model" "a/b" "input" "x"}))))
  (is (= {"inputs" ["x"] "parameters" {"prompt" "i" "truncate_dim" 8}}
         (into {} (map (fn [[k v]] [k (if (map? v) (into {} v) v)])
                       (:body (p/request "huggingface-cloud" {"endpoint" "h"} {"model" "m" "input" "x" "instruction" "i" "dimensions" 8}))))))
  (is (= "Bearer k" (get (:headers (p/request "tei" {"endpoint" "h" "apiKey" "k"} {"input" ["a"]})) "Authorization")))
  (is (= 30000 (p/timeout-ms {} {}))))

(deftest responses
  (is (= 2 (get (p/response "tei" {"model" "m"} [[1 2]]) "dimensions")))
  (is (= [1 3] (get (p/response "huggingface-cloud" {"model" "m"} [[1 2] [3]]) "embeddings"))
      "pinned original behaviour: a [batch, dims] answer yields the first value of each row")
  (is (= [[2] [1]] (get (p/response "ovm-npu" {"model" "m"} {"data" [{"embedding" [1] "index" 1} {"embedding" [2] "index" 0}]}) "embeddings")) "sorted by index")
  (is (thrown-with-msg? ExceptionInfo #"reading 'embeddings'" (p/response "ollama" {"model" "m"} nil))))
