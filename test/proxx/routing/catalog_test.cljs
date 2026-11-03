(ns proxx.routing.catalog-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.catalog :as c]
            [proxx.routing.surface :as s]))

(def facts (-> (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn") contracts/compile-contracts s/facts))

(defn- assemble [m] (c/assemble-catalog facts (merge {:preferences {:preferred [] :disabled [] :aliases []} :declared []
                                                       :route-results [] :ollama-results [] :ollama-route-ids []} m)))

(deftest discovered-models-are-deduped-filtered-and-ordered
  (let [r (assemble {:preferences {:preferred ["b" "ghost" "c"] :disabled [" a "] :aliases []}
                     :route-results [{:provider-id "p" :model-ids ["a" "b" "c" "d"] :fetched-at 1 :source-endpoints ["/v1/models"]}
                                     {:provider-id "q" :model-ids ["d" "e"] :fetched-at 2 :source-endpoints ["/v1/models"]}
                                     {:provider-id "empty" :model-ids [] :fetched-at 3 :source-endpoints []}]
                     :declared ["a" "d" "z"]})]
    (is (= ["b" "c" "d" "e" "z"] (:model-ids r)) "preferred first, declared-only appended, disabled dropped")
    (is (= ["b" "c"] (get-in r [:preferences :preferred])) "only discovered, enabled preferred models are reported")
    (is (= ["d" "z"] (:declared-model-ids r)) "declared minus disabled")
    (is (= ["p" "q"] (mapv first (:provider-catalogs r))) "providers with no models are absent")))

(deftest ollama-results-extend-or-open-entries
  (let [r (assemble {:route-results [{:provider-id "ollama-a" :model-ids ["m:7b"] :fetched-at 1 :source-endpoints ["/v1/models"]}]
                     :ollama-results [{:provider-id "ollama-a" :model-ids ["m:7b" "m:70b"] :fetched-at 9}
                                      {:provider-id "ollama-b" :model-ids ["x:1b"] :fetched-at 9}]
                     :ollama-route-ids ["ollama-a" "ollama-b" "ollama-a" "ollama-none"]})
        by-id (into {} (:provider-catalogs r))]
    (is (= ["m:7b" "m:70b"] (:model-ids (by-id "ollama-a"))))
    (is (= 1 (:fetched-at (by-id "ollama-a"))) "an existing entry keeps its own fetch time and endpoints")
    (is (= ["/v1/models" "/api/tags"] (:source-endpoints (by-id "ollama-b"))) "a new entry records the Ollama probe paths")
    (is (= ["m:7b" "m:70b" "x:1b"] (:dynamic-ollama-model-ids r)))
    (is (= [["m" "m:70b"] ["x" "x:1b"]] (:alias-targets r)))
    (is (= ["m:7b" "m:70b" "x:1b" "m" "x"] (:model-ids r)) "aliases are models too, after the real ones")))

(deftest preferred-aliases-need-a-discovered-target
  (let [r (assemble {:preferences {:preferred [] :disabled [] :aliases [["fast" "a"] ["slow" "ghost"] ["m" "a"]]}
                     :route-results [{:provider-id "ollama-a" :model-ids ["a" "m:7b"] :fetched-at 1 :source-endpoints []}]
                     :ollama-route-ids ["ollama-a"]})]
    (is (= [["m" "a"] ["fast" "a"]] (:alias-targets r)) "preferred aliases override the computed ones in place and append the rest")
    (is (= [["fast" "a"] ["slow" "ghost"] ["m" "a"]] (get-in r [:preferences :aliases])) "preferences echo what was declared")))

(deftest local-ollama-route
  (is (c/local-ollama-route? "HTTP://L:1///" " http://l:1 "))
  (is (not (c/local-ollama-route? "" "")))
  (is (not (c/local-ollama-route? "http://a" "http://b"))))

(deftest concrete-models
  (let [catalog {"modelIds" ["a" "auto:fast" "alias" "b"] "aliasTargets" {"alias" "a"} "declaredModelIds" ["d" "auto:x" "alias" "e"]}]
    (is (= ["a" "b"] (c/concrete-model-ids catalog)))
    (is (nil? (c/concrete-model-ids nil)))
    (is (= ["d" "e" "a" "x"]
           (c/concrete-model-ids-for-providers
            {"catalog" catalog "providerCatalogs" {"p" {"modelIds" ["a" "alias" "auto:y" "d"]} "q" {"modelIds" ["x"]}}}
            ["p" "missing" "q"] nil)))
    (is (= ["e"] (c/concrete-model-ids-for-providers {"catalog" catalog "providerCatalogs" {}} [] #(= % "e"))))
    (is (nil? (c/concrete-model-ids-for-providers nil ["p"] nil)))))

(deftest intentional-divergence-prototype-named-models
  ;; TS looked aliasTargets[modelId] up on a plain object, so a model called
  ;; "constructor" or "toString" counted as an alias and vanished from the concrete list.
  (is (= ["constructor" "toString"] (c/concrete-model-ids {"modelIds" ["constructor" "toString"] "aliasTargets" {}}))))

(deftest alias-resolution
  (let [bundle {"catalog" {"aliasTargets" {"llama3" "llama3:70b" "ollama/x" "hosted-x" "gone" "bad"}}
                "preferences" {"disabled" ["bad" "off"]}}]
    (is (= {:routing-model "llama3:70b" :alias-applied? true} (c/resolve-alias facts bundle "llama3" false)))
    (is (= {:routing-model "plain" :alias-applied? false} (c/resolve-alias facts bundle "plain" false)))
    (is (= {:routing-model "hosted-x" :alias-applied? true} (c/resolve-alias facts bundle "ollama/x" false)))
    (is (= {:routing-model "ollama/x" :alias-applied? false} (c/resolve-alias facts bundle "ollama/x" true))
        "an explicit Ollama request is kept when the alias leaves Ollama")
    (is (= {:routing-model "ollama/y" :alias-applied? true}
           (c/resolve-alias facts (assoc-in bundle ["catalog" "aliasTargets" "ollama/z"] "ollama/y") "ollama/z" true)))
    (is (= {:status 403 :message "Model is disabled: off" :type "invalid_request_error" :code "model_disabled"}
           (:error (c/resolve-alias facts bundle "off" false))))
    (is (= "Model is disabled: gone" (get-in (c/resolve-alias facts bundle "gone" false) [:error :message]))
        "a request whose alias target is disabled is disabled")))

(deftest alias-models-follow-object-key-order
  (let [r (assemble {:preferences {:preferred [] :disabled [] :aliases [["zeta" "a"] ["2" "a"] ["1" "a"]]}
                     :route-results [{:provider-id "p" :model-ids ["a"] :fetched-at 1 :source-endpoints []}]})]
    (is (= ["a" "1" "2" "zeta"] (:model-ids r)) "numeric-looking aliases lead, as Object.keys orders them")))
