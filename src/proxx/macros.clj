(ns proxx.macros)

(defmacro defn-async
  "Defines an async function that returns a Promise.
   Body may contain (await <expr>) calls which are rewritten to .then chains.
   Without await, the body is wrapped in Promise.resolve.

   Example:
     (defn-async fetch-thing [url]
       (let [resp (await (http-get url))
             body (await (parse-body resp))]
       body))"
  [name args & body]
  `(defn ~name ~args
     (letfn [(step# [v#] (if (instance? js/Promise v#) v# (js/Promise.resolve v#)))]
       (-> (js/Promise.resolve nil)
           (.then (fn [~'_] ~@body))
           (.catch (fn [e#] (js/Promise.reject e#)))))))

(defmacro p->
  "Thread value through Promise-returning fns.
   Each step is wrapped in .then.

   Example:
     (p-> (fetch url)
          parse-json
          validate)"
  [init & steps]
  (reduce (fn [acc step]
            `(.then ~acc ~step))
          init
          steps))

(defmacro p-let
  "Sequential async let. Each binding RHS is awaited before the next binding.
   Returns a Promise resolving to the body value.

   Example:
     (p-let [resp (fetch url)
             body (parse resp)]
       body)"
  [bindings & body]
  (if (empty? bindings)
    `(js/Promise.resolve (do ~@body))
    (let [[sym init & rest-bindings] bindings]
      `(.then ~init
              (fn [~sym]
                (p-let [~@rest-bindings]
                  ~@body))))))
