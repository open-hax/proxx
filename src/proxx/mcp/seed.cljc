(ns proxx.mcp.seed
  "Seeds for the MCP server list and the tool list (src/lib/tool-mcp-seed.ts):
  reading `clobber.macro/defapp` blocks out of ecosystem files, deciding which
  of them are MCP servers, and which coding tools a model gets.

  Pure over strings: the directory listing and file reads are the edge's
  (proxx.runtime.mcp-seed)."
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Tools
;; ---------------------------------------------------------------------------

(def opencode-tools
  [{:id "question" :description "Ask targeted user clarifications."}
   {:id "bash" :description "Run shell commands."}
   {:id "read" :description "Read files and directories."}
   {:id "glob" :description "Find files by pattern."}
   {:id "grep" :description "Search file contents."}
   {:id "edit" :description "Apply focused line edits."}
   {:id "write" :description "Write complete file contents."}
   {:id "task" :description "Delegate complex subtasks."}
   {:id "webfetch" :description "Fetch web content from URL."}
   {:id "todowrite" :description "Track task list state."}
   {:id "websearch" :description "Search the web for research."}
   {:id "codesearch" :description "Search code examples."}
   {:id "skill" :description "Load reusable skill packs."}
   {:id "apply_patch" :description "Apply file-oriented diff patches."}])

(defn patch-model?
  "GPT models other than the oss and gpt-4 families edit with patches."
  [model-id]
  (let [lower (str/lower-case model-id)]
    (and (str/includes? lower "gpt-")
         (not (str/includes? lower "oss"))
         (not (str/includes? lower "gpt-4")))))

(defn tool-seed-for-model
  "{:id :description :enabled} for every tool: patches for patch models, edit and
  write for the rest, everything else always."
  [model-id]
  (let [patch? (patch-model? model-id)]
    (mapv (fn [{:keys [id] :as tool}]
            (assoc tool :enabled (case id
                                   "apply_patch" patch?
                                   ("edit" "write") (not patch?)
                                   true)))
          opencode-tools)))

;; ---------------------------------------------------------------------------
;; defapp blocks
;; ---------------------------------------------------------------------------

(def ^:private marker "(clobber.macro/defapp \"")

(defn- block-end
  "Index just past the paren that closes the form opening at `start`, or the end
  of the text when it never closes. Parens are counted without regard to strings."
  [content start]
  (let [n (count content)]
    (loop [i start depth 0]
      (if (>= i n)
        n
        (let [c (nth content i)
              depth (case c \( (inc depth) \) (dec depth) depth)]
          (if (and (= \) c) (zero? depth)) (inc i) (recur (inc i) depth)))))))

(defn defapp-blocks
  "[{:name :body} ...] for every `(clobber.macro/defapp \"name\" ...)` form, in order."
  [content]
  (loop [index 0 blocks []]
    (let [marker-index (when (<= index (count content)) (str/index-of content marker index))]
      (if-not marker-index
        blocks
        (let [name-start (+ marker-index (count marker))
              name-end (str/index-of content "\"" name-start)]
          (if-not name-end
            blocks
            (let [end (block-end content marker-index)]
              (recur end (conj blocks {:name (subs content name-start name-end)
                                       :body (subs content marker-index end)})))))))))

(defn- parse-vector [raw]
  (mapv second (re-seq #"\"([^\"]+)\"" raw)))

(defn- finite-number [s]
  #?(:cljs (let [n (js/Number s)] (when (js/Number.isFinite n) n))
     :clj (let [n (Double/parseDouble s)] (when-not (Double/isInfinite n) n))))

(defn- parse-port
  "The `:PORT \"n\"` number, or nil when absent or not a finite number."
  [body]
  (when-let [[_ digits] (re-find #":PORT\s+\"(\d+)\"" body)]
    (finite-number digits)))

(defn mcp-server?
  "Whether a defapp looks like an MCP server: by its name, script or cwd, by an
  explicit MCP setting, or by an MCP shared secret next to a port (a mere
  service-url list is not one)."
  [name script cwd body]
  (let [lower-name (str/lower-case name)
        lower-script (str/lower-case script)
        lower-cwd (str/lower-case (or cwd ""))
        lower-body (str/lower-case body)]
    (boolean
     (or (str/starts-with? lower-name "mcp-")
         (str/includes? lower-name "-mcp")
         (str/includes? lower-script "mcp")
         (str/includes? lower-cwd "/mcp-")
         (str/ends-with? lower-cwd "/mcp")
         (str/includes? body ":MCP_TRANSPORT")
         (str/includes? body ":LEGACY_MCP_URL")
         (and (not (str/includes? body ":MCP_SERVICE_URLS"))
              (or (and (str/includes? body ":MCP_INTERNAL_SHARED_SECRET") (str/includes? body ":PORT"))
                  (str/includes? lower-body "mcp-files.json")))))))

(defn mcp-seed
  "The seed for one defapp block, or nil when it is not an MCP server.
  `:cwd` and `:port` are present only when found (a port of 0 counts as none)."
  [name body source-file]
  (let [script (or (second (re-find #":script\s+\"([^\"]+)\"" body)) "")
        cwd (second (re-find #":cwd\s+\"([^\"]+)\"" body))
        args (parse-vector (or (second (re-find #":args\s+\[([^\]]*)\]" body)) ""))
        port (parse-port body)]
    (when (mcp-server? name script cwd body)
      (cond-> {:id name :script script :args args :source-file source-file :running false}
        (seq cwd) (assoc :cwd cwd)
        (and port (not (zero? port))) (assoc :port port)))))

(defn- locale-compare [a b] #?(:cljs (.localeCompare ^string a ^string b) :clj (compare a b)))

(defn dedupe-and-sort
  "One seed per id (the last one read wins) in id order."
  [seeds]
  (vec (sort-by :id locale-compare (vals (into {} (map (juxt :id identity)) seeds)))))
