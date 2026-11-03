(ns proxx.federation.stream
  "The queue behind one bridged response, as an immutable value.

  Frames arrive from the relay while a consumer pulls them with `next`; the two
  rarely line up, so a stream holds frames nobody asked for yet and consumers
  nobody has answered yet. Every operation returns [effects stream'] (or
  [outcome stream'] for a pull) and never completes a consumer itself: a waiter
  is an opaque handle owned by the edge, handed back in an effect.

    {:events  [frame ...]    frames not yet pulled
     :done?   bool           no more frames will arrive
     :failure message|nil    the request failed; pulled after the queued frames
     :waiters [handle ...]}  consumers parked until a frame, the end, or a failure

  Effects: [:resolve-event handle frame] [:resolve-done handle] [:reject handle message].")

(def empty-stream {:events [] :done? false :failure nil :waiters []})

(defn pull
  "A consumer asks for the next frame. Queued frames come first (even after a
  failure), then the failure, then the end; otherwise `waiter` is parked.
  Returns [outcome stream'] with outcome one of {:yield frame} {:fail message} :done :wait."
  [stream waiter]
  (let [{:keys [events failure done?]} stream]
    (cond
      (seq events) [{:yield (first events)} (assoc stream :events (subvec events 1))]
      failure [{:fail failure} stream]
      done? [:done stream]
      :else [:wait (update stream :waiters conj waiter)])))

(defn push
  "A frame arrived: it goes to the oldest parked consumer, else to the queue."
  [stream frame]
  (if-let [waiter (first (:waiters stream))]
    [[[:resolve-event waiter frame]] (update stream :waiters subvec 1)]
    [[] (update stream :events conj frame)]))

(defn- flush-done [stream]
  [(mapv (fn [w] [:resolve-done w]) (:waiters stream)) (assoc stream :waiters [])])

(defn finish
  "The terminal frame arrived: deliver it, then release every remaining consumer as done."
  [stream frame]
  (let [[fx stream] (push (assoc stream :done? true) frame)
        [fx' stream] (flush-done stream)]
    [(into fx fx') stream]))

(defn close
  "The consumer walked away: nothing more will be pulled, so release parked consumers."
  [stream]
  (flush-done (assoc stream :done? true)))

(defn fail
  "The request failed: reject every parked consumer; later pulls see the failure
  once the queued frames are drained."
  [stream message]
  [(mapv (fn [w] [:reject w message]) (:waiters stream))
   (assoc stream :failure message :waiters [])])
