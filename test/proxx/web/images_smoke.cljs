(ns proxx.web.images-smoke
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(deftest ^:async generate-shows-image
  (s/stub-fetch! [[#"GET .*/api/v1/settings" {"fastMode" false}]
                  [#"POST .*/v1/images/generations" {"data" [{"url" "https://example.invalid/generated-cat.png"}]}]])
  (await (s/mount-app! "/images"))
  (is (str/includes? (s/body-text) "Raw response"))
  (.click (.querySelector js/document ".chat-input-form button[type=submit]"))
  (await (s/settle))
  (let [img (.querySelector js/document "img[alt=generated]")]
    (is (some? img))
    (is (= "https://example.invalid/generated-cat.png" (.getAttribute img "src"))))
  (let [post (some #(when (= "POST" (:method %)) %) @s/calls)]
    (is (= "gpt-image-1" (get (:body post) "model")))))
