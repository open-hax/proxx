(ns proxx.strategy.select-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.strategy :as edge]
            [proxx.strategy.select :as select]))

(deftest execution-provider
  (is (= "openai" (select/execution-provider [" OpenAI " "ollama"])) "the first route, normalised")
  (is (nil? (select/execution-provider [])) "an empty plan keeps the default")
  (is (nil? (select/execution-provider ["  " ""])) "blank ids are no routes")
  (is (nil? (select/execution-provider ["ollama" "Ollama-Local"])) "local Ollama only: the default serves it")
  (is (= "ollama" (select/execution-provider ["", "ollama" "gemini"])) "a remote route anywhere in the plan hands over to the first one")
  (is (= "gemini" (select/execution-provider ["gemini" "ollama"])))
  (is (= "x" (edge/execution-provider-js #js ["X"])))
  (is (undefined? (edge/execution-provider-js #js []))))
