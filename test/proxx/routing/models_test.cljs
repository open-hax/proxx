(ns proxx.routing.models-test
  (:require ["node:fs" :as fs]
            ["node:os" :as os]
            [cljs.test :refer [deftest is]]
            [proxx.routing.models :as m]
            [proxx.runtime.models :as edge]))

(defn- thrown [f] (try (f) nil (catch :default e (ex-message e))))

(deftest model-ids
  (is (= ["a" "b"] (m/normalize-model-ids [" a " "b" "a" "" nil 5])))
  (is (= ["a"] (m/normalize-model-ids {"models" ["a" "a"] "data" [{"id" "z"}]})) "models wins over data")
  (is (= ["x" "y"] (m/normalize-model-ids {"data" [{"id" " x "} {"id" 5} [] nil {"id" "y"} {"id" ""}]})))
  (is (= "Invalid model JSON: expected an array or {\"models\": []}" (thrown #(m/normalize-model-ids nil))))
  (is (= "Invalid model JSON: expected an array or {\"models\": []}" (thrown #(m/normalize-model-ids "str"))))
  (is (= "Invalid model JSON: expected an array, {\"models\": []}, or OpenAI-style {\"data\": []}"
         (thrown #(m/normalize-model-ids {"models" "nope"})))))

(deftest intentional-divergence-non-string-model-entries
  ;; TS called `id.trim()` on every entry of {"models": [...]}, so one number made the
  ;; whole file unloadable with a TypeError. Untrusted != ill-typed: drop what is
  ;; not a string and keep the rest.
  (is (= ["a" "b"] (m/normalize-model-ids {"models" ["a" 5 nil "b"]}))))

(deftest declared-models-tolerate-anything
  (is (= [] (m/normalize-declared-models nil)))
  (is (= [] (m/normalize-declared-models {"other" 1})))
  (is (= ["a"] (m/normalize-declared-models {"models" ["a"]})))
  (is (= ["a"] (m/normalize-declared-models ["a" "a"]))))

(deftest preferences
  (is (= {:preferred ["a"] :disabled [] :aliases []} (m/normalize-preferences ["a" "a"] ["f"] nil)))
  (is (= {:preferred ["f"] :disabled [] :aliases []} (m/normalize-preferences nil ["f"] nil)))
  (is (= {:preferred ["f"] :disabled [] :aliases []} (m/normalize-preferences "str" ["f"] nil)))
  (is (= {:preferred ["p"] :disabled ["d"] :aliases [["x" "y"]]}
         (m/normalize-preferences {"preferred" [" p "] "disabled" ["d" "d"] "aliases" {"x" "y"}} [] nil)))
  (is (= {:preferred [] :disabled [] :aliases []} (m/normalize-preferences {"preferred" nil "disabled" nil "aliases" nil} ["f"] nil))
      "a null preference field still marks the document as preferences")
  (is (= {:preferred ["m"] :disabled [] :aliases []} (m/normalize-preferences {"models" ["m"]} [] nil)))
  (is (= "Invalid model JSON: expected an array, {\"models\": []}, or OpenAI-style {\"data\": []}"
         (thrown #(m/normalize-preferences {} [] nil)))
      "an object with no preference fields and no model list is rejected"))

(deftest aliases-are-ordered-trimmed-and-string-only
  (is (= [["a" "z"] ["b" "2"] ["c" "3"]]
         (m/normalize-aliases [[" a " " 1 "] ["b" 5] ["" "x"] ["d" " "] ["b" "2"] ["c" "3"] [" a" "z"]]))
      "later duplicates overwrite in place")
  (is (= [["a" "z"] ["b" "2"]] (m/normalize-aliases [["a" "1"] ["b" "2"] [" a" "z"]])))
  (let [es (mapv (fn [i] [(str "k" i) (str "v" i)]) (range 25))]
    (is (= es (m/normalize-aliases es)) "order survives more than eight entries")))

(deftest intentional-divergence-array-aliases
  ;; TS treated an array as a record (Object.entries) and produced {"0": ..., "1": ...}.
  (is (= [] (:aliases (m/normalize-preferences {"aliases" ["a" "b"]} [] nil)))))

(deftest model-list-fallback
  (is (= ["a"] (m/load-models-result ["a"] ["f"])))
  (is (= ["f"] (m/load-models-result [] ["f"])))
  (is (= ["f"] (m/load-models-result ["", " "] ["f"]))))

(deftest openai-entry
  (is (= {"id" "m" "object" "model" "created" 1700000123 "owned_by" "open-hax"} (m/openai-model "m" 1700000123999))))

(deftest ^:async edge-loads-files-and-preserves-alias-order
  (let [dir (.mkdtempSync fs (str (.tmpdir os) "/models-test-"))
        write! (fn [name text] (let [p (str dir "/" name)] (.writeFileSync fs p text) p))
        prefs (await (edge/load-model-preferences-js
                      (write! "p.json" "{"preferred":["a"],"aliases":{"z":"1","y":"2","x":"3","w":"4","v":"5","u":"6","t":"7","s":"8","r":"9","q":"10"}}")
                      #js []))]
    (is (= ["z" "y" "x" "w" "v" "u" "t" "s" "r" "q"] (vec (js/Object.keys (.-aliases prefs)))))
    (is (= ["f"] (vec (await (edge/load-models-js (str dir "/missing.json") #js ["f"])))))
    (is (= [] (vec (await (edge/load-declared-models-js (str dir "/missing.json"))))))
    (is (= {:preferred ["f"] :aliases []}
           (let [p (await (edge/load-model-preferences-js (str dir "/missing.json") #js ["f"]))]
             {:preferred (vec (.-preferred p)) :aliases (vec (js/Object.keys (.-aliases p)))})))
    (let [e (await (-> (edge/load-models-js (write! "n.json" "null") #js []) (.then (fn [_] nil)) (.catch identity)))]
      (is (= "Invalid model JSON: expected an array or {"models": []}" (.-message e)))
      (is (nil? (ex-data e)) "a plain Error, not ex-info"))
    (let [e (await (-> (edge/load-declared-models-js dir) (.then (fn [_] nil)) (.catch identity)))]
      (is (= "EISDIR" (.-code e)) "read errors other than ENOENT propagate unchanged"))
    (let [e (await (-> (edge/load-models-js (write! "bad.json" "{bad") #js []) (.then (fn [_] nil)) (.catch identity)))]
      (is (instance? js/SyntaxError e)))))
