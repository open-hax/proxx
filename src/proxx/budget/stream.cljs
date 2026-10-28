(ns proxx.budget.stream
  (:require [clojure.string :as str]))

(defn- nonempty-text? [s] (and (string? s) (seq (str/trim s))))

(defn- parse-json [s]
  (try (js->clj (js/JSON.parse s) :keywordize-keys true)
       (catch :default _ nil)))

(defn- tool-valid? [tool allowed-names]
  (let [function (:function tool)
        args (:arguments function)
        parsed (if (string? args) (parse-json args) args)]
    (and (contains? allowed-names (:name function))
         (nonempty-text? (:id tool))
         (map? parsed))))

(defn- consume [state payload allowed-names]
  (reduce
   (fn [s choice]
     (let [delta (or (:delta choice) (:message choice))
           tools (reduce (fn [acc t]
                           (let [index (or (:index t) 0)]
                             (update acc index
                                     (fn [old]
                                       {:id (or (:id t) (:id old))
                                        :function {:name (let [prior (get-in old [:function :name] "")
                                                         part (get-in t [:function :name] "")]
                                                     (if (= prior part) prior (str prior part)))
                                                   :arguments (str (get-in old [:function :arguments] "")
                                                                   (get-in t [:function :arguments] ""))}}))))
                         (:tools s) (:tool_calls delta))
           complete? (or (= "tool_calls" (:finish_reason choice))
                         (and (:message choice) (seq (:tool_calls delta))))]
       (assoc s :tools tools
              :ready (boolean (or (:ready s)
                                  (nonempty-text? (:content delta))
                                  (and complete? (seq tools)
                                       (every? #(tool-valid? % allowed-names) (vals tools)))))
              :fatal (boolean (or (:fatal s) (= "error" (:finish_reason choice)))))))
   (update state :fatal #(boolean (or % (:error payload))))
   (:choices payload)))

(defn probe
  "Pure pre-commit probe: only visible text or completed, known tool calls
   count. Headers, heartbeats, reasoning and partial JSON never commit a route."
  [text format tools]
  (let [allowed-names (set (keep #(get-in % [:function :name]) tools))
        payloads (if (= "sse" format)
                   (keep (fn [line]
                           (when (str/starts-with? line "data:")
                             (parse-json (str/trim (subs line 5)))))
                         (str/split-lines text))
                   [(parse-json text)])
        state (reduce #(consume %1 %2 allowed-names)
                      {:ready false :fatal false :tools {}} payloads)]
    (select-keys state [:ready :fatal])))
