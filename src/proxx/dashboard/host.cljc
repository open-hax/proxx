(ns proxx.dashboard.host
  "Pure aggregation behind the host dashboard: fleet target configuration, Caddy
  route extraction, Docker container summaries and snapshot assembly.

  Facts in, facts out: the Docker socket, the Caddyfile and the remote /self
  endpoint are read at the edge (proxx.runtime.host-dashboard) and arrive here
  as parsed data; the clock is an argument. Targets and snapshots are
  string-keyed maps (they cross the JSON/API boundary unchanged); remote
  containers and routes are passed through untouched.

  Untrusted payloads are tolerated rather than trusted: a remote container with
  no string `status`, or a Docker port row that is not an object, is summarized
  as best it can be instead of failing the whole host."
  (:require [clojure.string :as str]
            [proxx.json :as json]
            [proxx.jsval :as j]))

;; ---------------------------------------------------------------------------
;; Small helpers
;; ---------------------------------------------------------------------------

(defn unique-strings
  "Trimmed, non-empty, de-duplicated (first wins) strings."
  [values]
  (vec (distinct (remove empty? (map j/trim values)))))

(defn normalize-host
  "Lower-cased host of a URL, or of a bare host/URL-ish string; \"\" when absent."
  [value]
  (if (or (nil? value) (= "" value))
    ""
    (try
      (j/lower #?(:cljs (.-host (js/URL. value))
                  :clj (throw (UnsupportedOperationException. "proxx.dashboard.host requires the ClojureScript runtime"))))
      (catch #?(:cljs :default :clj Exception) _
        (-> (j/lower (j/trim value))
            (str/replace #"^https?://" "")
            (str/replace #"/+$" ""))))))

(defn- trimmed-nes [v] (when (string? v) (let [t (j/trim v)] (when (seq t) t))))

;; ---------------------------------------------------------------------------
;; Targets
;; ---------------------------------------------------------------------------

(defn sanitize-target
  "A normalized target from one configured entry, or nil without an id and label."
  [candidate]
  (when (map? candidate)
    (let [id (if (string? (get candidate "id")) (j/trim (get candidate "id")) "")
          label (if (string? (get candidate "label")) (j/trim (get candidate "label")) "")]
      (when (and (seq id) (seq label))
        {"id" id
         "label" label
         "baseUrl" (some-> (trimmed-nes (get candidate "baseUrl")) (str/replace #"/+$" ""))
         "publicHost" (trimmed-nes (get candidate "publicHost"))
         "authToken" (trimmed-nes (get candidate "authToken"))
         "authTokenEnv" (trimmed-nes (get candidate "authTokenEnv"))
         "notes" (trimmed-nes (get candidate "notes"))}))))

(defn parse-targets
  "Targets from the HOST_DASHBOARD_TARGETS_JSON text. Blank means unconfigured
  (no implicit outbound probes). Throws ex-info for a non-array or an array
  without a single valid target; a malformed document throws the JSON error."
  [raw]
  (let [text (when raw (j/trim raw))]
    (if (empty? text)
      []
      (let [parsed (json/parse text)]
        (when-not (vector? parsed)
          (throw (ex-info "HOST_DASHBOARD_TARGETS_JSON must be a JSON array" {:error/type ::targets-not-array})))
        (let [targets (into [] (keep sanitize-target) parsed)]
          (when (empty? targets)
            (throw (ex-info "HOST_DASHBOARD_TARGETS_JSON did not contain any valid targets"
                            {:error/type ::no-valid-targets})))
          targets)))))

(defn resolve-token
  "The target's own token, else the one named by `authTokenEnv` in `env` (a
  string-keyed lookup fn); never a proxy-wide fallback."
  [target env-get]
  (or (get target "authToken")
      (when-let [env-name (get target "authTokenEnv")]
        (let [token (some-> (env-get env-name) j/trim)]
          (when (seq token) token)))))

(defn infer-self-id
  "The id of the target this request addresses: the explicit id when it names a
  target, else the first target whose base URL or public host matches the request."
  [targets {:keys [explicit-self-id request-base-url request-host]}]
  (let [explicit (some-> explicit-self-id j/trim)]
    (if (and (seq explicit) (some #(= explicit (get % "id")) targets))
      explicit
      (let [request-hosts (set (unique-strings [(normalize-host request-base-url) (normalize-host request-host)]))]
        (some (fn [target]
                (when (some request-hosts (unique-strings [(normalize-host (get target "baseUrl"))
                                                           (normalize-host (get target "publicHost"))]))
                  (get target "id")))
              targets)))))

;; ---------------------------------------------------------------------------
;; Caddyfile routes
;; ---------------------------------------------------------------------------

(defn- count-char [s ch] (count (filter #{ch} s)))

(defn- site-hosts [site]
  (unique-strings (remove #(or (empty? %) (str/includes? % "__PUBLIC_HOST__"))
                          (str/split (nth (re-find #"^([^@][^{]+?)\s*\{$" site) 1) #"[\s,]+" -1))))

(defn- fold-caddy-line [{:keys [hosts depth matchers] :as acc} raw-line]
  (let [line (j/trim (str/replace raw-line #"\s+#.*$" ""))]
    (cond
      (empty? line) acc

      (<= depth 0)
      (if (re-find #"^([^@][^{]+?)\s*\{$" line)
        (assoc acc :hosts (site-hosts line) :depth 1 :matchers {})
        acc)

      (and (str/starts-with? line "reverse_proxy") (str/includes? line "{"))
      acc ;; block-form directive: skipped entirely, braces uncounted

      :else
      (let [parts (str/split line #"\s+" -1)
            acc (cond
                  (str/starts-with? line "@")
                  (if (and (>= (count parts) 3) (= "path" (nth parts 1)))
                    (assoc-in acc [:matchers (first parts)] (vec (drop 2 parts)))
                    acc)

                  (str/starts-with? line "reverse_proxy")
                  (let [args (vec (rest parts))
                        matcher (when (some-> (first args) (str/starts-with? "@")) (first args))
                        upstreams (unique-strings (if matcher (rest args) args))]
                    (reduce (fn [a host]
                              (update a :routes conj {"host" host
                                                      "matcher" matcher
                                                      "matchPaths" (if matcher (get matchers matcher []) [])
                                                      "upstreams" upstreams}))
                            acc hosts))

                  :else acc)
            depth (+ depth (- (count-char line \{) (count-char line \})))]
        (if (<= depth 0)
          (assoc acc :hosts [] :matchers {} :depth 0)
          (assoc acc :depth depth))))))

(defn parse-caddy-routes
  "Reverse-proxy routes of a Caddyfile: one per (site host, directive), with its
  path matcher and upstreams. Block-form `reverse_proxy { ... }` is ignored.
  Sorted by host, then upstreams."
  [source]
  (->> (str/split source #"\r?\n" -1)
       (reduce fold-caddy-line {:routes [] :hosts [] :depth 0 :matchers {}})
       :routes
       (sort (fn [l r]
               (if (not= (get l "host") (get r "host"))
                 (j/locale-compare (get l "host") (get r "host"))
                 (j/locale-compare (str/join "," (get l "upstreams")) (str/join "," (get r "upstreams"))))))
       vec))

(defn caddy-candidate-paths
  "Caddyfile locations to try under each distinct non-empty root, in order."
  [roots]
  (vec (mapcat (fn [root] (map #(str root "/" %) ["Caddyfile" "deploy/Caddyfile" "deploy/Caddyfile.template"]))
               (unique-strings roots))))

;; ---------------------------------------------------------------------------
;; Docker containers
;; ---------------------------------------------------------------------------

(defn format-docker-ports
  "`ip:public->private/proto`, `private/proto` or `proto` for each port row."
  [ports]
  (if-not (and (vector? ports) (seq ports))
    []
    (mapv (fn [port]
            (let [port (if (map? port) port {})
                  protocol (if (seq (j/as-string (get port "Type"))) (get port "Type") "tcp")
                  public (get port "PublicPort")
                  private (get port "PrivatePort")]
              (cond
                (and (number? public) (number? private))
                (str (if (seq (j/as-string (get port "IP"))) (get port "IP") "0.0.0.0") ":" public "->" private "/" protocol)
                (number? private) (str private "/" protocol)
                :else protocol)))
          ports)))

(defn container-summaries
  "Summaries of Docker `/containers/json` rows, ordered by name. Throws ex-info
  when the payload is not an array."
  [rows]
  (when-not (vector? rows)
    (throw (ex-info "docker API returned an unexpected payload" {:error/type ::bad-docker-payload})))
  (->> rows
       (map (fn [row]
              (let [row (if (map? row) row {})
                    names (get row "Names")
                    first-name (when (vector? names) (first names))]
                {"id" (if (string? (get row "Id")) (subs (get row "Id") 0 (min 12 (count (get row "Id")))) "unknown")
                 "name" (if (string? first-name) (str/replace first-name #"^/" "") "unknown")
                 "image" (if (string? (get row "Image")) (get row "Image") "unknown")
                 "state" (if (string? (get row "State")) (get row "State") "unknown")
                 "status" (if (string? (get row "Status")) (get row "Status") "unknown")
                 "ports" (format-docker-ports (get row "Ports"))})))
       (sort (fn [l r] (j/locale-compare (get l "name") (get r "name"))))
       vec))

;; ---------------------------------------------------------------------------
;; Snapshots
;; ---------------------------------------------------------------------------

(defn summarize
  "{containerCount runningCount healthyCount routeCount}. A container without a
  string status is simply not healthy."
  [containers routes]
  {"containerCount" (count containers)
   "runningCount" (count (filter #(= "running" (get % "state")) containers))
   "healthyCount" (count (filter #(some-> (j/as-string (get % "status")) j/lower (str/includes? "healthy")) containers))
   "routeCount" (count routes)})

(defn- snapshot [target source fetched-at reachable errors containers routes extra]
  (merge {"id" (get target "id") "label" (get target "label") "source" source "fetchedAt" fetched-at
          "reachable" reachable
          "baseUrl" (get target "baseUrl") "publicHost" (get target "publicHost") "notes" (get target "notes")
          "errors" errors "containers" containers "routes" routes
          "summary" (summarize containers routes)}
         extra))

(defn unavailable-snapshot [target source error fetched-at]
  (snapshot target source fetched-at false [error] [] [] nil))

(defn local-snapshot
  "The snapshot of this host given the Docker result, Caddy routes and any errors."
  [target fetched-at errors containers routes]
  (snapshot target "local" fetched-at
            (boolean (or (empty? errors) (seq containers) (seq routes)))
            (vec errors) containers routes nil))

(defn remote-snapshot
  "A remote host's snapshot from its parsed /self body (tolerating a malformed
  one), or an unavailable snapshot naming why the endpoint was not usable."
  [target base-url status-ok? status body fetched-at]
  (let [parsed (if (map? body) body {})
        nes-or (fn [k default] (let [v (get parsed k)] (if (and (string? v) (seq (j/trim v))) v default)))]
    (if-not status-ok?
      (unavailable-snapshot target "remote"
                            (if (string? (get parsed "error")) (get parsed "error") (str "request failed with " status))
                            fetched-at)
      (let [objects (fn [k] (into [] (filter #(or (map? %) (vector? %))) (let [v (get parsed k)] (when (vector? v) v))))
            containers (objects "containers")
            routes (objects "routes")
            errors (into [] (filter string?) (let [v (get parsed "errors")] (when (vector? v) v)))]
        (assoc (snapshot target "remote" (nes-or "fetchedAt" fetched-at) (not= false (get parsed "reachable"))
                         errors containers routes nil)
               "label" (nes-or "label" (get target "label"))
               "baseUrl" base-url
               "publicHost" (nes-or "publicHost" (get target "publicHost"))
               "notes" (nes-or "notes" (get target "notes")))))))
