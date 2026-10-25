(ns proxx.runtime-seed-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime :as runtime]))

(deftest provider-seed-specs-are-exported-in-the-documented-camel-case-shape
  (let [specs (js->clj (runtime/load-provider-seed-specs-js "resources/policies/runtime/00-manifest.edn"))
        by-fallback (into {} (map (juxt #(get % "providerIdFallback") identity)) specs)]
    (is (every? #(= #{"providerIdEnvNames" "providerIdFallback" "keyEnvNames"} (set (keys %))) specs))
    (is (= ["ZAI_PROVIDER_ID" "ZHIPU_PROVIDER_ID"] (get-in by-fallback ["zai" "providerIdEnvNames"])))
    (is (= ["ZAI_API_KEY" "ZHIPU_API_KEY"] (get-in by-fallback ["zai" "keyEnvNames"])))
    (is (= {"providerIdEnvNames" [] "providerIdFallback" "factory" "keyEnvNames" ["FACTORY_API_KEY"]}
           (get by-fallback "factory"))
        "Factory is a seed with no provider-id override")))
