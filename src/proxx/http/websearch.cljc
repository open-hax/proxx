(ns proxx.http.websearch
  "POST /api/tools/websearch (src/routes/websearch.ts): request validation, the
  /v1/responses payloads it injects, the verdict on each attempt and the Exa
  MCP fallback's request/response handling. Everything here decides over plain
  string-keyed wire data; injecting the sub-requests and calling Exa are effects
  at the edge.

  Objects are built with `array-map` so field order on the wire matches the
  original."
  (:require [clojure.string :as str]
            [proxx.compat.response-citations :as citations]
            [proxx.jsval :as jv]))

(def ^:private default-num-results 8)
(def ^:private default-fallback-model "gpt-5.4-mini")
(def exa-timeout-ms 25000)
(def exa-url "https://mcp.exa.ai/mcp")

(defn- clean-domains [x]
  (if (sequential? x)
    (->> x (filter string?) (map jv/trim) (remove empty?) (take 50) vec)
    []))

(defn parse-request
  "{:error {:status :body}} for an unusable body, else the search facts
  {:query :num-results :context-size :allowed-domains :requested-model}."
  [body]
  (if-not (map? body)
    {:error {:status 400 :body {"error" "invalid_body"}}}
    (let [query (let [q (get body "query")] (if (string? q) (jv/trim q) ""))]
      (if (empty? query)
        {:error {:status 400 :body {"error" "query_required"}}}
        (let [n (get body "numResults")
              size (let [s (get body "searchContextSize")] (if (string? s) (jv/lower (jv/trim s)) ""))]
          {:query query
           :num-results (if (jv/finite? n) (long (max 1 (min 20 n))) default-num-results)
           :context-size (when (#{"low" "medium" "high"} size) size)
           :allowed-domains (clean-domains (get body "allowedDomains"))
           :requested-model (let [m (get body "model")] (if (string? m) (jv/trim m) ""))})))))

(defn candidate-models
  "The requested model then the fallback, trimmed, non-empty, de-duplicated."
  [requested-model fallback-env]
  (let [fallback (or (jv/nes (some-> fallback-env jv/trim)) default-fallback-model)]
    (->> [requested-model fallback] (map jv/trim) (remove empty?) distinct vec)))

(defn attempt-order
  "[[model include-domains-in-tool?] ...]: every model tried with the domain
  restriction on the tool, then in the prompt."
  [models]
  (vec (for [m models, in-tool? [true false]] [m in-tool?])))

(defn- user-text [{:keys [query num-results allowed-domains]} with-domains-hint?]
  (str/join "\n"
            [(str "Query: " query)
             (str "Return up to " num-results " results as a Markdown list. Each bullet must include a Markdown link and a 1-2 sentence snippet.")
             "Do not fabricate URLs; every link must be backed by web_search citations."
             (if (and with-domains-hint? (seq allowed-domains))
               (str "\n\nRestrict sources to these domains when possible:\n"
                    (str/join "\n" (map #(str "- " %) allowed-domains)))
               "")]))

(defn responses-payload
  "The /v1/responses body for one attempt."
  [{:keys [context-size allowed-domains] :as facts} model include-domains-in-tool?]
  (let [base-tool (apply array-map
                         (concat ["type" "web_search" "external_web_access" true]
                                 (when context-size ["search_context_size" context-size])))
        tool (if (and include-domains-in-tool? (seq allowed-domains))
               (assoc base-tool "allowed_domains" allowed-domains)
               base-tool)]
    (array-map "model" model
               "instructions" "You are a web search helper. Use the web_search tool to gather sources and answer with citations."
               "input" [(array-map "role" "user"
                                   "content" [(array-map "type" "input_text"
                                                         "text" (user-text facts (not include-domains-in-tool?)))])]
               "tools" [tool]
               "tool_choice" "auto"
               "store" false
               "stream" false)))

(defn request-headers [proxy-auth-token]
  (cond-> (array-map "content-type" "application/json")
    (jv/truthy? proxy-auth-token) (assoc "authorization" (str "Bearer " proxy-auth-token))))

(defn- citation->wire [{:keys [url title]}]
  (cond-> (array-map "url" url) title (assoc "title" title)))

(defn attempt-verdict
  "Verdict on one injected /v1/responses answer: `{:status n :parsed v}` where
  `parsed` is the JSON body or nil, and `:text` the raw body.
    {:kind :failed :last-error x}   non-200 (the parsed body, else the text)
    {:kind :empty :last-error x}    200 without text and sources
    {:kind :answer :response {...}} 200 with both"
  [{:keys [status parsed text]} model num-results]
  (if (not= 200 status)
    {:kind :failed :last-error (if (some? parsed) parsed text)}
    (let [{output :text cites :citations response-id :response-id} (citations/extract-text-and-url-citations parsed)
          sources (if (seq cites) cites (citations/extract-markdown-links output))]
      (if (and (seq (jv/trim output)) (seq sources))
        {:kind :answer
         :response (apply array-map
                          (concat ["output" output
                                   "sources" (mapv citation->wire (take num-results sources))]
                                  (when response-id ["responseId" response-id])
                                  ["model" model "backend" "openai"]))}
        {:kind :empty
         :last-error (array-map "reason" "openai_web_search_empty_output" "model" model "toolUsed" false)}))))

;; ---------------------------------------------------------------------------
;; Exa MCP fallback
;; ---------------------------------------------------------------------------

(defn exa-request [query num-results]
  (array-map "jsonrpc" "2.0" "id" 1 "method" "tools/call"
             "params" (array-map "name" "web_search_exa"
                                 "arguments" (array-map "query" query "numResults" num-results
                                                        "type" "auto" "livecrawl" "fallback"))))

(def exa-headers (array-map "accept" "application/json, text/event-stream" "content-type" "application/json"))

(defn- js-string [x]
  (cond (nil? x) "undefined" (string? x) x (number? x) (str x) (boolean? x) (str x) :else "[object Object]"))

(defn exa-parse-event-stream
  "The search output in an MCP event-stream body. Returns `{:output :sources}`;
  throws an Error-like ex-info (message only) on an MCP error or unparsable
  event, like the original. `parse` is JSON.parse (it may throw its own error)."
  [text parse]
  (loop [[line & more] (str/split text #"\n" -1)]
    (cond
      (nil? line) {:output "No search results found. Please try a different query." :sources []}
      (str/starts-with? line "data: ")
      (let [data (parse (subs line 6))]
        (when (nil? data)
          (throw (ex-info "Cannot read properties of null (reading 'error')" {})))
        (let [err (when (map? data) (get data "error"))]
          (when (jv/truthy? err)
            (throw (ex-info (str "Exa MCP error: " (js-string (when (map? err) (get err "message")))) {}))))
        (let [out (when (map? data)
                    (let [content (get-in data ["result" "content"])]
                      (when (sequential? content)
                        (let [t (when (map? (first content)) (get (first content) "text"))]
                          (when (jv/truthy? t) t)))))]
          (if out
            {:output out :sources (mapv citation->wire (citations/extract-markdown-links out))}
            (recur more))))
      :else (recur more))))

(defn exa-response [{:keys [output sources]} num-results]
  (array-map "output" output "sources" (vec (take num-results sources)) "backend" "exa"))

(defn failure-response [last-error]
  {:status 502
   :body (apply array-map (concat ["error" "websearch_failed"] (when (some? last-error) ["details" last-error])))})
