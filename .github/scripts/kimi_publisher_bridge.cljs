;; SPDX-License-Identifier: GPL-3.0-or-later
(ns kimi-publisher-bridge (:require [kimi-publisher-law :as law]))
;; Only reviewed default-source Clojure law is evaluated; artifacts stay data.
#js {:authority (fn [x] (clj->js (law/authority! (js->clj x :keywordize-keys true))))
     :token (fn [x] (clj->js (law/token! (js->clj x :keywordize-keys true))))
     :trigger (fn [x] (clj->js (law/trigger! (js->clj x :keywordize-keys true))))
     :native (fn [x] (clj->js (law/native! (js->clj x :keywordize-keys true))))
     :artifact (fn [x] (clj->js (law/artifact! (js->clj x :keywordize-keys true))))
     :body (fn [b p] (clj->js (law/body-provenance (js->clj b :keywordize-keys true)
                                                (js->clj p :keywordize-keys true))))}
