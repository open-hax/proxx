(ns proxx.runtime.interop-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.account-identity :as identity]
            [proxx.runtime.routing :as routing]))

(deftest constructor-keys-survive-conversion
  (is (= {"constructor" "x" "a" [1 {"constructor" nil}]}
         (interop/js->data (js/JSON.parse "{\"constructor\":\"x\",\"a\":[1,{\"constructor\":null}]}"))))
  (is (not= {"a" 1} (js->clj (js/JSON.parse "{\"constructor\":\"x\",\"a\":1}")))
      "the hazard this namespace exists for: js->clj leaves such objects unconverted"))

(deftest scalars-and-nil
  (is (nil? (interop/js->data js/undefined)))
  (is (nil? (interop/js->data nil)))
  (is (= [1 "a" true nil] (interop/js->data #js [1 "a" true nil]))))

(deftest edges-read-objects-with-constructor-keys
  (is (= ["https://viv"]
         (mapv #(aget % "baseUrl")
               (js/Array.from
                (routing/declared-provider-routes-js
                 "resources/policies/runtime/00-manifest.edn"
                 #js {:status "ok" :providerRoutes #js [#js {:providerId "vivgrid" :baseUrl "https://api"}]}
                 (js/JSON.parse "{\"openaiProviderId\":\"openai\",\"openaiBaseUrl\":\"\",\"upstreamProviderBaseUrls\":{\"constructor\":\"x\",\"vivgrid\":\"https://viv/\"}}"))))))
  (let [claims (str "h." (.toString (js/Buffer.from "{\"constructor\":1,\"email\":\"A@b\"}") "base64url") ".s")]
    (is (= "a@b" (.-email (identity/derive-oauth-metadata-from-token-js claims))))))
