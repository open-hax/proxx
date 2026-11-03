(ns proxx.runtime.settings-test
  "src/tests/proxy-settings-store.test.ts: the settings store edge against a mock SQL tag."
  (:require ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.runtime.settings :as edge]))

(defn- tmp-settings-path []
  (.join path (.mkdtempSync fs (.join path (.tmpdir os) "proxx-settings-store-")) "proxy-settings.json"))

(defn- cleanup [file] (.rmSync fs (.dirname path file) #js {:recursive true :force true}))

(defn- mock-sql
  "A postgres.js-like tagged template over an atom of {key value}. Seed values are JS values."
  [seed]
  (let [values (atom seed)
        sql (fn [strings & params]
              (let [query (-> (str/join "?" (array-seq strings)) (str/replace #"\s+" " ") str/trim)]
                (cond
                  (.startsWith query "SELECT value FROM config WHERE key = ?")
                  (let [v (get @values (str (first params)))]
                    (js/Promise.resolve (if (some? v) #js [#js {:value v}] #js [])))

                  (.startsWith query "INSERT INTO config (key, value, updated_at) VALUES (?, ?::jsonb, NOW()) ON CONFLICT (key) DO NOTHING")
                  (let [k (str (first params))]
                    (when-not (contains? @values k) (swap! values assoc k (js/JSON.parse (str (second params)))))
                    (js/Promise.resolve #js []))

                  (.startsWith query "INSERT INTO config (key, value, updated_at) VALUES (?, ?::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()")
                  (do (swap! values assoc (str (first params)) (js/JSON.parse (str (second params))))
                      (js/Promise.resolve #js []))

                  :else (throw (js/Error. (str "Unsupported SQL query in test: " query))))))]
    {:sql sql :values values}))

(defn- plain [x] (js->clj x))

(def defaults {"fastMode" false "requestsPerMinute" nil "allowedModels" nil "allowedProviderIds" nil "disabledProviderIds" nil})

(deftest ^:async preserves-file-backed-default-tenant-behavior
  (let [file (tmp-settings-path)]
    (try
      (.writeFileSync fs file (js/JSON.stringify #js {:fastMode true}) "utf8")
      (let [^js store (edge/create-proxy-settings-store-js file nil)
            expected {"fastMode" true "requestsPerMinute" nil "allowedModels" nil "allowedProviderIds" nil "disabledProviderIds" nil}]
        (await (.warmup store))
        (is (= expected (plain (.get store))))
        (is (= expected (plain (await (.getForTenant store "default"))))))
      (finally (cleanup file)))))

(deftest ^:async scopes-sql-backed-settings-by-tenant
  (let [file (tmp-settings-path)
        {:keys [sql values]} (mock-sql {"proxy_settings" (clj->js defaults)})
        ^js store (edge/create-proxy-settings-store-js file sql)
        acme {"fastMode" true "requestsPerMinute" 3 "allowedModels" ["ollama/gpt-oss:20b"]
              "allowedProviderIds" ["factory"] "disabledProviderIds" ["openai"]}]
    (try
      (await (.warmup store))
      (await (.setForTenant store (clj->js acme) "acme"))
      (is (= defaults (plain (await (.getForTenant store "default")))))
      (is (= acme (plain (await (.getForTenant store "acme")))))
      (is (= defaults (plain (get @values "proxy_settings"))))
      (is (= acme (plain (get @values "proxy_settings:acme"))))
      (finally (cleanup file)))))

(deftest ^:async accepts-kebab-case-and-snake-case-settings-keys
  (let [file (tmp-settings-path)]
    (try
      (.writeFileSync fs file (js/JSON.stringify #js {"fast-mode" true :requests_per_minute 12
                                                      :allowedProviderIds #js [" OPENAI " "openai" "ollama"]}) "utf8")
      (let [^js store (edge/create-proxy-settings-store-js file nil)]
        (await (.warmup store))
        (is (= {"fastMode" true "requestsPerMinute" 12 "allowedModels" nil
                "allowedProviderIds" ["openai" "ollama"] "disabledProviderIds" nil}
               (plain (.get store)))))
      (finally (cleanup file)))))

(deftest ^:async parses-stringified-json-values-loaded-from-sql
  (let [file (tmp-settings-path)
        {:keys [sql]} (mock-sql {"proxy_settings" "{\"disabledProviderIds\":[\"zai\"],\"fastMode\":false}"})
        ^js store (edge/create-proxy-settings-store-js file sql)]
    (try
      (await (.warmup store))
      (is (= {"fastMode" false "requestsPerMinute" nil "allowedModels" nil "allowedProviderIds" nil "disabledProviderIds" ["zai"]}
             (plain (await (.getForTenant store "default")))))
      (finally (cleanup file)))))
