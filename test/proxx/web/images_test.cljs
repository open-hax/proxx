(ns proxx.web.images-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.web.pages.images :as images]
            [proxx.web.storage :as storage]
            [proxx.web.update :as u]))

(defn- boot [& [stored]] (u/init-db {:stored (or stored {}) :token "t" :path "/images"}))

(deftest extract
  (is (= ["data:image/png;base64,AAA" "https://x/y.png"]
         (images/extract-images {"data" [{"b64_json" " AAA " "url" "ignored"} {"url" " https://x/y.png "} {} nil "s" {"b64_json" "  "}]})))
  (is (= [] (images/extract-images nil)))
  (is (= [] (images/extract-images {"data" "nope"}))))

(deftest request
  (is (= {:model "m" :prompt "p" :response_format "b64_json"} (images/request-body "m" "p"))))

(deftest submit-flow
  (let [db (boot)
        [db1 fx1] (u/handle db [:images/submit])]
    (is (true? (get-in db1 [:pages :images :sending?])))
    (let [[_ req] (first fx1)]
      (is (= "/v1/images/generations" (:path req)))
      (is (= {:model "gpt-image-1" :prompt images/default-prompt :response_format "b64_json"} (:body req))))
    (is (= [db1 []] (u/handle db1 [:images/submit])) "ignored while sending")
    (let [[db2] (u/handle db1 [:images/done {"data" [{"url" "u"}]}])]
      (is (= ["u"] (:urls (images/view-model db2))))
      (is (false? (:sending? (images/view-model db2)))))
    (let [[db2] (u/handle db1 [:images/done {"data" []}])]
      (is (true? (:no-data? (images/view-model db2)))))
    (let [[db2] (u/handle db1 [:images/failed "bad"])]
      (is (= "bad" (:error (images/view-model db2))))
      (is (false? (:no-data? (images/view-model db2))))))
  (let [[db] (u/handle (boot) [:images/prompt-changed "   "])]
    (is (= [db []] (u/handle db [:images/submit])) "blank prompt ignored")))

(deftest stored-preferences
  (is (= "m2" (images/model (boot {storage/ls-images-model "m2"}))))
  (is (= images/default-model (images/model (boot {storage/ls-images-model 5})))))
