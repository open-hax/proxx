(ns proxx.web.chat-smoke
  "Chat flow from web/test/e2e/tools.smoke.ts, against the real views."
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.web.support :as s]))

(def ^:private session (atom {"id" "session-1" "title" "Local smoke session" "promptCacheKey" "k"
                              "messages" [{"id" "msg-1" "role" "assistant" "content" "Welcome to the smoke session." "model" "gpt-5.3-codex"}]}))

(defn- set-textarea! [el v]
  (let [setter (.-set (js/Object.getOwnPropertyDescriptor js/window.HTMLTextAreaElement.prototype "value"))]
    (.call setter el v)
    (.dispatchEvent el (js/window.Event. "input" #js {:bubbles true}))))

(deftest ^:async chat-roundtrip
  (reset! session {"id" "session-1" "title" "Local smoke session" "promptCacheKey" "k"
                   "messages" [{"id" "msg-1" "role" "assistant" "content" "Welcome to the smoke session." "model" "gpt-5.3-codex"}]})
  (s/stub-fetch!
   [[#"GET .*/api/v1/settings" {"fastMode" false}]
    [#"POST .*/api/v1/sessions/session-1/messages"
     (fn [body] (let [m {"id" (str "msg-" (inc (count (get @session "messages")))) "role" (get body "role") "content" (get body "content")}]
                  (swap! session update "messages" conj m) {"message" m}))]
    [#"GET .*/api/v1/sessions/session-1/cache-key" {"promptCacheKey" "smoke-cache-key"}]
    [#"GET .*/api/v1/sessions/session-1" (fn [_] {"session" @session})]
    [#"GET .*/api/v1/sessions$" {"sessions" [{"id" "session-1" "title" "Local smoke session" "lastMessagePreview" "Welcome"}]}]
    [#"GET .*/v1/models" {"data" [{"id" "gpt-5.3-codex"} {"id" "gpt-image-1"}]}]
    [#"POST .*/v1/chat/completions" {"choices" [{"message" {"content" "Hello from the mocked assistant." "reasoning_content" "Brief."}}]}]])
  (await (s/mount-app! "/chat"))
  (await (s/wait-text "Welcome to the smoke session."))
  (let [t (s/body-text)]
    (is (str/includes? t "Sessions"))
    (is (str/includes? t "Local smoke session"))
    (is (str/includes? t "Welcome to the smoke session.")))
  (let [ta (.querySelector js/document "textarea[placeholder='Send a message...']")]
    (is (some? ta))
    (set-textarea! ta "hello smoke test")
    (await (s/settle))
    (let [btn (some #(when (= "Send" (str/trim (.-textContent %))) %) (array-seq (.querySelectorAll js/document "button")))]
      (is (some? btn))
      (.click btn)))
  (await (s/wait-text "Hello from the mocked assistant."))
  (is (str/includes? (s/body-text) "Hello from the mocked assistant."))
  (let [completion (some #(when (str/ends-with? (:url %) "/v1/chat/completions") %) @s/calls)]
    (is (= "smoke-cache-key" (get (:body completion) "prompt_cache_key")))
    (is (= [{"role" "assistant" "content" "Welcome to the smoke session."} {"role" "user" "content" "hello smoke test"}]
           (get (:body completion) "messages")))))
