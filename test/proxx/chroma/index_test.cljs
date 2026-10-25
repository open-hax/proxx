(ns proxx.chroma.index-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.chroma.index :as idx]))

(deftest vectors
  (is (= [1 2] (idx/to-vector [1 "a" js/NaN 2 js/Infinity])))
  (is (nil? (idx/to-vector [])))
  (is (nil? (idx/to-vector "x")))
  (is (= [[1] [2]] (idx/batch-vectors {"embeddings" [[1] [2]]} 2)))
  (is (thrown-with-msg? js/Error #"unexpected embedding count" (idx/batch-vectors {"embeddings" [[1] []]} 2)))
  (is (thrown-with-msg? js/Error #"missing embeddings" (idx/batch-vectors {"embeddings" "x"} 1)))
  (is (= [3] (idx/legacy-vector {"embedding" [3]})))
  (is (thrown-with-msg? js/Error #"missing embedding" (idx/legacy-vector {"embedding" []}))))

(deftest config
  (is (= {"url" "http://h" "model" "m"} (idx/build-config {"url" " http://h " "model" " m "})))
  (is (= {"url" idx/default-ollama-url "model" idx/default-embedding-model} (idx/build-config {})))
  (is (= "n" (get (idx/build-config {"model_name" " " "model" "n"}) "model")) "build falls through blank names")
  (is (thrown-with-msg? js/Error #"non-empty model_name"
                        (idx/validate-config {"url" "u" "model_name" " " "model" "n"}))
      "validate does not (matches the original)")
  (is (nil? (idx/validate-config {"url" "u" "model" "n"})))
  (is (thrown-with-msg? js/Error #"non-empty url" (idx/validate-config {"model" "n"}))))

(deftest connection
  (is (= {"host" "h" "ssl" true} (idx/connection-options {"protocol" "https:" "hostname" "h" "port" ""})))
  (is (= {"host" "h" "ssl" false "port" 8000} (idx/connection-options {"protocol" "http:" "hostname" "h" "port" "8000"})))
  (is (thrown-with-msg? js/Error #"Unsupported Chroma protocol: ftp:" (idx/connection-options {"protocol" "ftp:" "hostname" "h" "port" ""}))))

(deftest search-rows
  (is (= [{"sessionId" "s" "sessionTitle" "T" "messageId" "id1" "role" "user" "content" "d" "createdAt" 9 "distance" 0}]
         (idx/search-results ["id1" "id2"] ["d"] [{"sessionId" "s" "sessionTitle" "T" "role" "bogus"} {"messageId" "m"}] [js/NaN] 9))
      "rows without a session id are dropped; bad role/createdAt/distance fall back"))
