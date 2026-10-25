;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.browser.device-test
  (:require ["jsdom" :refer [JSDOM]]
            [cljs.test :refer [deftest is]]
            [proxx.browser.device :as device]))

(defn- tick! [] (js/Promise. (fn [resolve _reject] (js/setTimeout resolve 0))))

(deftest ^:async stale-start-response-cannot-cancel-a-new-attempt
  (let [dom (JSDOM. "<main></main>")
        original-document (.-document js/globalThis)
        original-fetch js/fetch
        starts (atom []) calls (atom []) cleanup (atom nil)]
    (set! (.-document js/globalThis) (.. dom -window -document))
    (set! js/globalThis.fetch
      (fn [url _options]
        (swap! calls conj url)
        (if (.endsWith url "/start")
          (js/Promise. (fn [resolve _reject] (swap! starts conj resolve)))
          (js/Promise.resolve #js {:ok true :json #(js/Promise.resolve #js {})}))))
    (try
      (let [root (.querySelector js/document "main")
            _ (reset! cleanup (device/mount! root #(is false "No admission in this fixture")))
            buttons (.querySelectorAll root "button")
            begin (aget buttons 0) cancel (aget buttons 1)
            respond (fn [resolve code]
                      (resolve #js {:ok true :json #(js/Promise.resolve
                                 #js {:user_code code :verification_uri "https://authority.example/device"
                                      :expires_in 600 :interval 600})}))]
        (.click begin)
        (.click cancel)
        (await (tick!))
        (.click begin)
        (is (= 2 (count @starts)))
        (respond (second @starts) "NEW-CODE")
        (await (tick!))
        (respond (first @starts) "OLD-CODE")
        (await (tick!))
        (is (= 1 (count (filter #(.endsWith % "/cancel") @calls)))
            "A stale start cannot send cookie-scoped cancellation for the current transaction")
        (is (.includes (.-textContent root) "NEW-CODE"))
        (is (not (.includes (.-textContent root) "OLD-CODE"))))
      (finally
        (when @cleanup (@cleanup))
        (set! js/globalThis.fetch original-fetch)
        (set! (.-document js/globalThis) original-document)
        (.close (.-window dom))))))
