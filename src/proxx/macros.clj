(ns proxx.macros)

(defmacro defn-async
  "Defines a fn that always returns a Promise.
   Body is synchronous Clojure — just return a value or a Promise.
   If the body returns a Promise it is passed through; otherwise it is
   wrapped in Promise.resolve.

   (defn-async my-fn [a b]
     (+ a b))"
  [name args & body]
  `(defn ~name ~args
     (js/Promise.
      (fn [resolve# reject#]
        (try
          (let [result# (do ~@body)]
            (if (instance? js/Promise result#)
              (.then result# resolve# reject#)
              (resolve# result#)))
          (catch :default e#
            (reject# e#)))))))

(defmacro p->
  "Thread a Promise-returning seed through Promise-returning fns.

   (p-> (fetch url)
        parse-json
        validate)"
  [init & steps]
  (reduce
   (fn [acc step] `(.then ~acc ~step))
   init
   steps))

(defmacro p-let
  "Sequential async let bindings. Each RHS is awaited before the next
   name is bound. Returns a Promise resolving to the body value.

   (p-let [resp (fetch url)
            body (parse resp)]
     body)"
  [bindings & body]
  (if (empty? bindings)
    `(js/Promise.resolve (do ~@body))
    (let [[sym init & more] bindings]
      `(.then (js/Promise.resolve ~init)
              (fn [~sym]
                (p-let [~@more]
                  ~@body))))))
