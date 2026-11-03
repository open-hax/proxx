(ns proxx.http.ring-reply-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.ring :as http]))

(defn- ^:async call [app opts]
  (let [res (await (.inject app (clj->js opts)))]
    {:status (.-statusCode res) :headers (js->clj (.-headers res)) :text (.-payload res)}))

(deftest ^:async handlers-may-take-the-reply-and-keep-the-body-opaque
  (let [app ((js/require "fastify"))
        seen (atom nil)]
    (http/register!
     app
     [{:method :post :path "/own-reply" :opaque-body? true
       :handler (fn [{:keys [^js reply body]}]
                  (reset! seen body)
                  (.send (.code reply 202) "sent by the handler")
                  {:handled? true})}
      {:method :get :path "/multi-header"
       :handler (fn [_] {:headers {"set-cookie" ["a=1" "b=2"]} :body "ok"})}])
    (let [own (await (call app {:method "POST" :url "/own-reply" :payload #js {:k "v"}}))
          multi (await (call app {:method "GET" :url "/multi-header"}))]
      (is (= 202 (:status own)))
      (is (= "sent by the handler" (:text own)))
      (is (object? @seen) "an opaque body stays the parsed JS value")
      (is (= ["a=1" "b=2"] (get (:headers multi) "set-cookie"))))
    (await (.close app))))
