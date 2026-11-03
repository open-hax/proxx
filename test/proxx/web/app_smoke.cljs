(ns proxx.web.app-smoke
  "Mirror of the former vitest `app.test.tsx` (shell renders; onboarding shows)."
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private settings-ok [#"GET .*/api/v1/settings" {"fastMode" false}])

(deftest ^:async renders-shell
  (s/stub-fetch! [settings-ok])
  (await (s/mount-app! "/"))
  (let [t (s/body-text)]
    (is (str/includes? t "Proxx"))
    (is (str/includes? t "Proxy Token"))
    (is (str/includes? t "Theme"))))

(deftest ^:async shows-onboarding-without-token
  (s/stub-fetch! [settings-ok])
  (await (s/mount-app! "/"))
  (is (str/includes? (s/body-text) "Welcome to Proxx")))
