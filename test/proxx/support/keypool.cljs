(ns proxx.support.keypool
  "Builds key pools the way the TypeScript entry point did: real seed specs from
  the policy manifest, node:crypto hashing, and an explicit environment."
  (:require ["node:crypto" :as crypto]
            ["node:path" :as path]
            [proxx.runtime :as rt]
            [proxx.runtime.factory-auth :as fa]
            [proxx.runtime.keypool :as kp]))

(set! *warn-on-infer* false)

(def uuid-v5-pattern #"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

(defn sha256-hex [value]
  (-> (.createHash crypto "sha256") (.update value) (.digest "hex")))

(def seed-specs
  (delay (rt/load-provider-seed-specs-js
          (.resolve path (js/process.cwd) "./resources/policies/runtime/00-manifest.edn"))))

(defn make-pool
  "`config` is a JS KeyPoolConfig; opts: :env (clj map of strings), :rng,
  :telemetry, :load-factory-auth."
  [config & {:keys [env rng telemetry load-factory-auth]}]
  (kp/create-key-pool-js
   config
   (doto #js {:seedSpecs @seed-specs
              :sha256Hex sha256-hex
              :env (if (map? env) (clj->js env) (or env #js {}))
              :loadFactoryAuth (or load-factory-auth (fn [] (js/Promise.resolve nil)))}
     (cond-> rng (aset "rng" rng))
     (cond-> telemetry (aset "telemetry" telemetry)))))

(defn ids [credentials] (mapv #(.-accountId %) (array-seq credentials)))

(defn- b64url [value]
  (.toString (js/Buffer.from (js/JSON.stringify (clj->js value))) "base64url"))

(defn make-jwt
  "An unsigned JWT-shaped token carrying `payload` (a clj map of string keys)."
  [payload]
  (str (b64url {"alg" "RS256" "typ" "JWT"}) "." (b64url payload) ".fake-signature"))

(defn process-env
  "A plain-object copy of `process.env` (what the TypeScript `KeyPool` handed the kernel)."
  []
  (let [o #js {}]
    (doseq [k (js/Object.keys js/process.env)]
      (aset o k (aget js/process.env k)))
    o))

(defn ^:async load-factory-auth
  "The Factory auth.v2 loader the TypeScript `KeyPool` passed: the decrypted
  credentials plus the access token's JWT expiry, or nil."
  []
  (let [^js credentials (await (fa/load-factory-auth-v2-js))]
    (when credentials
      #js {:accessToken (.-accessToken credentials)
           :refreshToken (.-refreshToken credentials)
           :expiresAt (let [expiry (fa/parse-jwt-expiry-js (.-accessToken credentials))]
                        (if (nil? expiry) js/undefined expiry))})))

(defn make-process-pool
  "A pool configured like `new KeyPool(config)`: the ambient `process.env` and the
  real Factory auth.v2 loader."
  [config]
  (make-pool config :env (process-env) :load-factory-auth load-factory-auth))
