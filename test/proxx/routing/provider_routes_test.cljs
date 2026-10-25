(ns proxx.routing.provider-routes-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.model-ids :as ids]
            [proxx.routing.provider-routes :as pr]
            [proxx.routing.surface :as s]
            [proxx.runtime.routing :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")
(def facts (-> (loader/load-policy-contracts! manifest) contracts/compile-contracts s/facts))

;; ---- routes ---------------------------------------------------------------

(deftest route-parsing-accepts-every-key-spelling
  (is (= [{"providerId" "p" "baseUrl" "https://x" "authRequired" false "paths" {"chat" "/c"}}]
         (pr/routes-from-raw [{"provider/id" " p " "provider/base-url" "https://x///" "required?" false
                               "paths" {"chat" "/c" "bad" "  " "n" 5}}])))
  (is (= [{"providerId" "p" "baseUrl" "u"}]
         (pr/routes-from-raw [{"provider_id" "p" "base_url" "u" "auth-required" "yes" "paths" {}}]))
      "a non-boolean auth flag is dropped and an empty paths map is omitted")
  (is (= [{"providerId" "p" "baseUrl" "u" "authRequired" true}]
         (pr/routes-from-raw [{"id" "p" "baseUrl" "u" "authRequired" true "auth_required" false}]))
      "the first spelling present wins")
  (is (= [{"providerId" "5" "baseUrl" "7"}] (pr/routes-from-raw [{"id" 5 "baseUrl" 7}])) "numbers stringify like String()")
  (is (= [] (pr/routes-from-raw [{} {"id" "p"} {"baseUrl" "u"} "x" nil 5 [] {"id" " " "baseUrl" "u"}])))
  (is (nil? (pr/routes-from-raw nil)))
  (is (nil? (pr/routes-from-raw {"a" 1}))))

(deftest intentional-divergence-non-record-route-values
  ;; TS: String({}) -> "[object Object]" became a provider id / base url, and an array
  ;; `paths` became {"0": ...}. Neither is a route we can honour.
  (is (= [] (pr/routes-from-raw [{"id" {} "baseUrl" "u"} {"id" "p" "baseUrl" []}])))
  (is (= [{"providerId" "p" "baseUrl" "u"}] (pr/routes-from-raw [{"id" "p" "baseUrl" "u" "paths" ["x"]}]))))

(deftest configured-urls-win
  (let [routes [{"providerId" "openai" "baseUrl" "a"} {"providerId" "ollama" "baseUrl" "b"}
                {"providerId" "z" "baseUrl" "c"} {"providerId" "y" "baseUrl" "d"}]
        cfg {:openai-provider-id "openai" :openai-base-url " https://oa/// " :ollama-base-url "http://l/"
             :upstream-provider-base-urls {"z" "https://z/" "y" "  "}}]
    (is (= ["https://oa" "http://l" "https://z" "d"]
           (mapv #(get % "baseUrl") (pr/apply-configured-route-facts facts routes cfg))))
    (is (= routes (pr/apply-configured-route-facts facts routes nil)))
    (is (= routes (pr/apply-configured-route-facts facts routes {:openai-provider-id "OPENAI"}))
        "provider ids compare exactly")))

(deftest enrichment-prefers-the-richest-matching-route
  (let [input [{"providerId" "p" "baseUrl" "u" "x" 1}
               {"providerId" "p" "baseUrl" "u" "authRequired" false "paths" {"a" "/a"}}
               {"providerId" "p" "baseUrl" "other" "paths" {}}]]
    (is (= {"providerId" "p" "baseUrl" "u" "authRequired" false "paths" {"a" "/a"}}
           (pr/enrich-filtered-route {"providerId" "p" "baseUrl" "u"} input)) "exact identity first, richest of those")
    (is (= {"providerId" "p" "baseUrl" "new" "authRequired" false "paths" {"a" "/a"}}
           (pr/enrich-filtered-route {"providerId" "p" "baseUrl" "new"} input))
        "same provider, richest overall")
    (is (= {"providerId" "q" "baseUrl" "u"} (pr/enrich-filtered-route {"providerId" "q" "baseUrl" "u"} input)))
    (is (= {"providerId" "p" "baseUrl" "u" "paths" {"mine" "/m"}}
           (pr/enrich-filtered-route {"providerId" "p" "baseUrl" "u" "paths" {"mine" "/m"}} [{"providerId" "p" "baseUrl" "u"}]))
        "the filtered route's own fields win")))

(deftest decisions
  (let [routes [{"providerId" "a" "baseUrl" "1"} {"providerId" "b" "baseUrl" "2"} {"providerId" "b" "baseUrl" "3"}]
        modes #{"chat" "responses"}]
    (is (= {:routes [{"providerId" "b" "baseUrl" "3"} {"providerId" "a" "baseUrl" "1"} {"providerId" "b" "baseUrl" "3"}]
            :strategy-mode "chat" :strategy-mode-by-provider {"a" "responses"}}
           (pr/apply-policy-decision routes {"status" "ok" "providers" ["b" "a" "b" "ghost" 5] "strategy" {"mode" "chat"}
                                             "strategy-by-provider" {"a" "responses" "b" "unknown" "c" 5}} modes))
        "ok: decision order, duplicate ids repeat, the last route per provider id is the one selected")
    (is (= [] (:routes (pr/apply-policy-decision routes {"status" "denied"} modes))))
    (is (= [] (:routes (pr/apply-policy-decision routes {"status" "exhausted"} modes))))
    (is (= routes (:routes (pr/apply-policy-decision routes {"status" "other"} modes))))
    (is (= {:routes routes} (pr/apply-policy-decision routes nil modes)))
    (is (= {:routes routes} (pr/apply-policy-decision routes ["ok"] modes)))
    (is (= "responses" (:strategy-mode (pr/apply-policy-decision routes {"strategy" "responses"} modes))))
    (is (nil? (:strategy-mode (pr/apply-policy-decision routes {"strategy" "nope"} modes))))
    (is (= {"a" "chat"} (:strategy-mode-by-provider (pr/apply-policy-decision routes {"strategyByProvider" {"a" {"mode" "chat"}}} modes))))
    (is (nil? (:strategy-mode-by-provider (pr/apply-policy-decision routes {"strategyByProvider" {"a" "nope"}} modes))))))

(deftest retry-fold
  (is (= 5 (pr/next-min-ready 0 5)))
  (is (= 3 (pr/next-min-ready 5 3)))
  (is (= 3 (pr/next-min-ready 3 5)))
  (is (= 3 (pr/next-min-ready 3 0)))
  (is (= 3 (pr/next-min-ready 3 -1))))

;; ---- model ids ------------------------------------------------------------

(deftest prefixes
  (is (= "llama3" (ids/strip-model-prefix "OLLAMA/llama3" ["" "ollama/"])))
  (is (= "ollama/" (ids/strip-model-prefix "ollama/" ["ollama/"])) "nothing left: unchanged")
  (is (= "ollama/ " (ids/strip-model-prefix "ollama/ " ["ollama/"])))
  (is (= "x" (ids/strip-model-prefix "x" [])))
  (is (ids/has-model-prefix? "FOO-1" ["", "foo-"]))
  (is (not (ids/has-model-prefix? "foo" [""])) "an empty prefix is not a wildcard"))

(deftest local-ollama
  (let [pats [":4b" "llama3"]]
    (is (ids/local-ollama-model? facts "gemma4:e4b" pats) "size tags with a letter prefix normalise to :4b")
    (is (ids/local-ollama-model? facts "LLAMA3" pats))
    (is (ids/local-ollama-model? facts "x/llama3" pats))
    (is (ids/local-ollama-model? facts "x-llama3" pats))
    (is (ids/local-ollama-model? facts "x:llama3" pats))
    (is (not (ids/local-ollama-model? facts "llama3x" pats)))
    (is (not (ids/local-ollama-model? facts "gpt-5:4b" pats)) "hosted OpenAI families never match")
    (is (not (ids/local-ollama-model? facts "o1" ["o1"])))))

(deftest routing-state
  (let [cfg {:factory-model-prefixes ["factory/"] :ollama-model-prefixes ["ollama/"] :openai-model-prefixes ["openai/"]
             :local-ollama-enabled true :local-ollama-model-patterns [":4b"]}]
    (is (= {:explicit-ollama false :openai-prefixed false :factory-prefixed true :local-ollama false :routed-model "claude"}
           (ids/request-routing-state facts cfg "factory/claude")))
    (is (= {:explicit-ollama true :openai-prefixed false :factory-prefixed false :local-ollama true :routed-model "qwen:4b"}
           (ids/request-routing-state facts cfg "ollama/qwen:4b")))
    (is (= {:explicit-ollama false :openai-prefixed true :factory-prefixed false :local-ollama false :routed-model "gpt-5:4b"}
           (ids/request-routing-state facts cfg "openai/gpt-5:4b")))
    (is (true? (:local-ollama (ids/request-routing-state facts cfg "qwen:4b"))))
    (is (false? (:local-ollama (ids/request-routing-state facts (assoc cfg :local-ollama-enabled false) "qwen:4b"))))
    (is (= "plain" (:routed-model (ids/request-routing-state facts cfg "plain"))))))

(deftest catalog-payloads
  (is (= ["a" "b"] (ids/parse-model-ids-from-catalog-payload ["a" 5 " b " "a"])))
  (is (= ["x"] (ids/parse-model-ids-from-catalog-payload {"data" [{"id" "x"} {"id" 5} nil] "models" ["m"]})) "data wins even when it yields less")
  (is (= [] (ids/parse-model-ids-from-catalog-payload {"data" [{"name" "n"}] "models" ["m"]})))
  (is (= ["s" "i" "n" "m"]
         (ids/parse-model-ids-from-catalog-payload
          {"models" ["s" {"id" "i" "name" "no"} {"id" 5 "name" "n"} {"model" "m"} {"id" "" "name" "n2"} nil 7]}))
      "first string among id/name/model, even when empty, then nothing")
  (is (= [] (ids/parse-model-ids-from-catalog-payload nil)))
  (is (= [] (ids/parse-model-ids-from-catalog-payload {"other" 1}))))

(deftest largest-aliases
  (is (= [["llama3" "llama3:70b"] ["llama3:latest" "llama3:70b"] ["qwen" "qwen:7b"]]
         (ids/largest-model-aliases ["llama3:8b" "llama3:70b" "llama3:latest" "qwen:7b" "plain" "m:" ":x"])))
  (is (= [["a" "a:7b"]] (ids/largest-model-aliases ["a:7b" "a:07b-q"])) "equal scale: shorter tag wins")
  (is (= [["a" "a:2t"]] (ids/largest-model-aliases ["a:1500b" "a:2t"])) "t is thousands of b")
  (is (= [] (ids/largest-model-aliases ["a:7b" "a"])) "a name that is already a model gets no alias")
  (is (= [["a" "a:7b"]] (ids/largest-model-aliases ["a:7b" "a:7b"])))
  (is (= [["a" "a:7B"]] (ids/largest-model-aliases ["a:7b" "a:7B"])) "equal everything but case: the smaller code-unit string (upper-case) wins")
  (let [many (mapv #(str "m" % ":7b") (range 30))]
    (is (= (mapv #(str "m" %) (range 30)) (mapv first (ids/largest-model-aliases many))) "order beyond eight entries")))

(deftest ollama-routes
  (let [cfg {:ollama-base-url " http://l/// " :local-ollama-enabled true
             :upstream-provider-base-urls [["ollama-lan" "http://a//"] ["Ollama-Cloud" "https://c"] ["openai" "x"]
                                           [" ollama-lan " "http://dup"] ["ollama-empty" ""] ["ollama-blank" " "]]}]
    (is (= [{"providerId" "ollama-local" "baseUrl" "http://l"} {"providerId" "ollama-lan" "baseUrl" "http://a"}
            {"providerId" "Ollama-Cloud" "baseUrl" "https://c"}]
           (ids/ollama-catalog-routes facts cfg))
        "a blank-url duplicate does not shadow, but a seen id is never repeated")
    (is (= [] (ids/ollama-catalog-routes facts {:ollama-base-url "" :local-ollama-enabled true :upstream-provider-base-urls []})))
    (is (= ["ollama-lan"] (mapv #(get % "providerId") (ids/ollama-catalog-routes facts (assoc cfg :local-ollama-enabled false
                                                                                                :upstream-provider-base-urls [["ollama-lan" "http://a"]])))))))

;; ---- edge -----------------------------------------------------------------

(deftest ^:async min-ms-ignores-errors-and-takes-smallest-positive
  (let [delays {"a" 5000 "b" 0 "c" 20 "d" :throw "e" :reject}
        pool #js {:msUntilAnyKeyReady (fn [id] (case (delays id)
                                                 :throw (throw (js/Error. "x"))
                                                 :reject (js/Promise.reject (js/Error. "y"))
                                                 (js/Promise.resolve (delays id))))}
        routes (to-array (map (fn [id] #js {:providerId id}) ["a" "b" "c" "d" "e"]))]
    (is (= 20 (await (edge/min-ms-until-any-provider-key-ready-js pool routes))))
    (is (= 0 (await (edge/min-ms-until-any-provider-key-ready-js pool #js []))))))

(deftest ^:async dynamic-base-url-getter
  (is (undefined? (edge/create-dynamic-provider-base-url-getter-js nil)))
  (let [store #js {:getProviderById (fn [id] (js/Promise.resolve (case id "a" #js {:baseUrl "http://a"} "n" #js {:baseUrl nil} nil)))}
        get-url (edge/create-dynamic-provider-base-url-getter-js store)]
    (is (= "http://a" (await (get-url "a"))))
    (is (nil? (await (get-url "n"))))
    (is (nil? (await (get-url "z"))))))

(deftest edge-filter-helpers-keep-route-identity
  (let [a #js {:providerId "openai"} b #js {:providerId "ollama"} routes #js [a b]
        out (edge/filter-responses-api-routes-js manifest routes nil)]
    (is (= 1 (.-length out)))
    (is (identical? a (aget out 0)) "the original route objects are returned, not copies")
    (is (= 1 (.-length (edge/filter-images-api-routes-js manifest routes "nothing"))) "ollama is not OpenAI-compatible")))

(deftest edge-aliases-are-ordered-js-objects
  (let [o (edge/build-largest-model-aliases-js #js ["z:7b" "y:7b" "z:latest"])]
    (is (= ["z" "z:latest" "y"] (vec (js/Object.keys o))))
    (is (= "z:7b" (aget o "z:latest")))))
