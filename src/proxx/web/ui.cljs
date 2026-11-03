(ns proxx.web.ui
  "Reagent adapters for the canonical UI kit, `@open-hax/uxx` (React).

  The kit's own Reagent wrapper package (`devel.ui.*`, uxx/reagent) is not
  published and cannot be resolved from this repository's build, so this
  namespace adapts the React components directly. Reagent already converts
  kebab-case props to camelCase and keywords to strings; `element` lifts hiccup
  into a React element for props that expect nodes (`:actions`, `:meta`, ...)."
  (:require [reagent.core :as r]
            ["@open-hax/uxx" :as uxx]))

(def theme-provider (r/adapt-react-class (.-ThemeProvider ^js uxx)))
(def toast-provider (r/adapt-react-class (.-ToastProvider ^js uxx)))
(def button (r/adapt-react-class (.-Button ^js uxx)))
(def badge (r/adapt-react-class (.-Badge ^js uxx)))
(def card (r/adapt-react-class (.-Card ^js uxx)))
(def input (r/adapt-react-class (.-Input ^js uxx)))
(def textarea (r/adapt-react-class (.-Textarea ^js uxx)))
(def modal (r/adapt-react-class (.-Modal ^js uxx)))
(def spinner (r/adapt-react-class (.-Spinner ^js uxx)))
(def panel-header (r/adapt-react-class (.-PanelHeader ^js uxx)))
(def surface-hero (r/adapt-react-class (.-SurfaceHero ^js uxx)))
(def data-table-shell (r/adapt-react-class (.-DataTableShell ^js uxx)))
(def chat (r/adapt-react-class (.-Chat ^js uxx)))
(def tabs (r/adapt-react-class (.-Tabs ^js uxx)))
(def metric-tile (r/adapt-react-class (.-MetricTile ^js uxx)))
(def metric-tile-grid (r/adapt-react-class (.-MetricTileGrid ^js uxx)))
(def status-chip-stack (r/adapt-react-class (.-StatusChipStack ^js uxx)))
(def action-strip (r/adapt-react-class (.-ActionStrip ^js uxx)))
(def filter-toolbar (r/adapt-react-class (.-FilterToolbar ^js uxx)))

(defn element
  "Hiccup -> React element (for props that take nodes)."
  [hiccup]
  (r/as-element hiccup))

(defn event-value
  "Value of a React change event's current target."
  [^js e]
  (.. e -currentTarget -value))

(defn event-checked [^js e] (.. e -currentTarget -checked))
