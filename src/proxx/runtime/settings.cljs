(ns proxx.runtime.settings
  "Stateful edge of the proxy settings store: the per-tenant cache atom, the
  SQL `config` row and settings-file persistence, behind the ProxySettingsStore
  method names. Normalization and merging are proxx.settings.proxy.

  Persistence is faithful to the TypeScript store: the `config` row and the
  file hold `JSON.stringify` of the settings object in canonical field order
  (an explicitly-undefined field is dropped from the JSON); SQL failures are
  swallowed and fall back to memory/defaults; a read-only filesystem keeps the
  settings in memory only."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [proxx.routing.tenant-key :as tk]
            [proxx.settings.proxy :as settings]))

(def ^:private unset ::unset)

(defn- js->settings
  "A settings map from a JS value. `undefined` properties become `unset` so a
  merge can tell them from null."
  [v]
  (if (and (some? v) (object? v) (not (array? v)))
    (reduce (fn [m k] (assoc m k (let [x (aget v k)] (if (undefined? x) unset (js->clj x)))))
            {} (js-keys v))
    (js->clj v)))

(defn- settings->js
  "A fresh JS object, canonical fields first; `unset` fields are present-but-undefined."
  [m]
  (let [o #js {}
        put (fn [k] (when (contains? m k)
                      (let [v (get m k)] (aset o k (cond (= unset v) js/undefined (nil? v) nil :else (clj->js v))))))]
    (doseq [k settings/setting-keys] (put k))
    (doseq [k (remove (set settings/setting-keys) (keys m))] (put k))
    o))

(defn- tagged
  "A tagged-template `strings` array (with `.raw`) for postgres.js."
  [& strings]
  (let [arr (to-array strings)]
    (aset arr "raw" (to-array strings))
    arr))

(defn- select-row [^js sql key]
  (sql (tagged "\n          SELECT value FROM config WHERE key = " "\n        ") key))

(defn- json-of [m] (js/JSON.stringify (settings->js m)))

(defn- read-json-file [file-path]
  (.then (.readFile fsp file-path "utf8") js/JSON.parse))

(defn create-proxy-settings-store-js
  "Build a settings store for `file-path`, persisting to `sql` (a postgres.js
  handle) when given."
  [file-path ^js sql]
  (let [default-id tk/default-tenant-id
        defaults settings/default-settings
        cache (atom {default-id defaults})
        sql (when (some? sql) sql)
        tenant-id-of #(settings/settings-tenant-id
                       % default-id
                       (fn [id] (try (tk/normalize-tenant-id id)
                                     (catch :default e (throw (if (ex-data e) (js/Error. (ex-message e)) e))))))
        key-of #(settings/tenant-key % default-id)
        copy (fn [m] (settings->js m))
        load-default
        (fn ^:async load-default []
          (if sql
            (let [row (try {:rows (await (select-row sql (key-of default-id)))}
                           (catch :default _ {:failed true}))]
              (cond
                (:failed row) defaults
                (pos? (.-length ^js (:rows row))) (settings/normalize-settings (js->clj (.-value (aget (:rows row) 0))))
                :else
                (try
                  (let [seeded (settings/normalize-settings (js->clj (await (read-json-file file-path))))]
                    (try (await (sql (tagged "\n            INSERT INTO config (key, value, updated_at)\n            VALUES (" ", " "::jsonb, NOW())\n            ON CONFLICT (key) DO NOTHING\n          ")
                                     (key-of default-id) (json-of seeded)))
                         (catch :default _ nil))
                    seeded)
                  (catch :default _ defaults))))
            (try (settings/normalize-settings (js->clj (await (read-json-file file-path))))
                 (catch :default _ defaults))))
        get-for-tenant
        (fn ^:async get-for-tenant [tenant-id]
          (let [id (tenant-id-of tenant-id)]
            (if-let [cached (get @cache id)]
              (copy cached)
              (do
                (when sql
                  (try (let [rows (await (select-row sql (key-of id)))]
                         (when-let [row (aget rows 0)]
                           (swap! cache assoc id (settings/normalize-settings (js->clj (.-value ^js row))))))
                       (catch :default _ nil)))
                (if-let [loaded (get @cache id)]
                  (copy loaded)
                  (let [fallback (get @cache default-id defaults)]
                    (swap! cache assoc id fallback)
                    (copy fallback)))))))
        set-for-tenant
        (fn ^:async set-for-tenant [next tenant-id]
          (let [id (tenant-id-of tenant-id)
                current (js->settings (await (get-for-tenant id)))
                merged (settings/merge-settings current (js->settings next))]
            (swap! cache assoc id merged)
            (if sql
              (try (await (sql (tagged "\n          INSERT INTO config (key, value, updated_at)\n          VALUES (" ", " "::jsonb, NOW())\n          ON CONFLICT (key) DO UPDATE SET\n            value = EXCLUDED.value,\n            updated_at = NOW()\n        ")
                               (key-of id) (json-of merged)))
                   (catch :default _ nil))
              (try (await (.mkdir fsp (.dirname path file-path) #js {:recursive true}))
                   (when (= id default-id)
                     (await (.writeFile fsp file-path (js/JSON.stringify (settings->js merged) nil 2) "utf8")))
                   (catch :default _ nil)))
            (copy merged)))]
    #js {:warmup (fn ^:async warmup []
                   (swap! cache assoc default-id (await (load-default)))
                   js/undefined)
         :get (fn [] (copy (get @cache default-id defaults)))
         :getForTenant (fn [tenant-id] (get-for-tenant tenant-id))
         :set (fn [next] (set-for-tenant next default-id))
         :setForTenant (fn [next tenant-id] (set-for-tenant next tenant-id))}))
