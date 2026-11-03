(ns proxx.compat.response-citations-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.compat.response-citations :as rc]
            [proxx.runtime.response-citations :as edge]))

(defn- msg [& parts] {"type" "message" "role" "assistant" "content" (vec parts)})
(defn- text [t & anns] {"type" "output_text" "text" t "annotations" (vec anns)})
(defn- cite [url & [title]] (cond-> {"type" "url_citation" "url" url} title (assoc "title" title)))

(deftest text-is-joined-and-trimmed
  (is (= {:text "a\n\nb" :citations [] :response-id "r1"}
         (rc/extract-text-and-url-citations
          {"id" "r1" "output" [(msg (text "  a") (text "") (text "b  "))]}))))

(deftest only-assistant-messages-and-output-text
  (is (= "kept"
         (:text (rc/extract-text-and-url-citations
                 {"output" [{"type" "message" "role" "user" "content" [(text "no")]}
                            {"type" "reasoning" "content" [(text "no")]}
                            {"type" "message" "content" [{"type" "refusal" "text" "no"} (text "kept")]}
                            "junk" nil [(text "no")]]})))
      "a message with no role counts as assistant; other types and parts are skipped"))

(deftest citations-dedupe-by-url-first-title-wins
  (is (= [{:url "https://a" :title "A"} {:url "https://b"} {:url "https://c" :title "C"}]
         (:citations (rc/extract-text-and-url-citations
                      {"output" [(msg (text "x" (cite "https://a" " A ") (cite "https://a" "other") (cite "https://b" "  ")
                                           {"type" "other" "url" "https://z"} (cite "") nil "x")
                                      (text "y" (cite "https://c" "C")))]})))))

(deftest malformed-payloads-yield-empty
  (doseq [p [nil 1 "s" [] {} {"output" "x"} {"output" [{"type" "message" "content" 5}]}]]
    (is (= {:text "" :citations []} (select-keys (rc/extract-text-and-url-citations p) [:text :citations])) (pr-str p)))
  (is (not (contains? (rc/extract-text-and-url-citations {"id" 5}) :response-id))))

(deftest markdown-links
  (is (= [{:url "https://a.io/x" :title "A"} {:url "http://b.io"}]
         (rc/extract-markdown-links "see [A](https://a.io/x), [ ](http://b.io) and again [Again](https://a.io/x) [bad](ftp://x) [t](https://has space)")))
  (is (= [] (rc/extract-markdown-links ""))))

(deftest edge-shapes
  (let [out (edge/extract-response-text-and-url-citations-js
             #js {:id "r" :output #js [#js {:type "message" :content #js [#js {:type "output_text" :text "hi"
                                                                              :annotations #js [#js {:type "url_citation" :url "https://u" :title "T"}]}]}]})]
    (is (= "hi" (.-text out)))
    (is (= "r" (.-responseId out)))
    (is (= "T" (.-title (aget (.-citations out) 0)))))
  (is (not (js/Object.hasOwn (edge/extract-response-text-and-url-citations-js #js {}) "responseId"))))
