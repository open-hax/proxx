(ns proxx.http.api-v1
  "The /api/v1 index: the migration map from the legacy /api/ui surface.")

(def endpoints
  "Declared endpoint migration state, in presentation order."
  (array-map
   "credentials" {"path" "/api/v1/credentials" "legacyPath" "/api/ui/credentials" "status" "implemented"
                  "description" "Credential management endpoints migrating from the legacy UI surface."}
   "federation" {"path" "/api/v1/federation" "legacyPath" "/api/ui/federation" "status" "planned"
                 "description" "Federation control and synchronization endpoints migrating from the legacy UI surface."}
   "sessions" {"path" "/api/v1/sessions" "legacyPath" "/api/ui/sessions" "status" "implemented"
               "description" "Session and search endpoints migrating from the legacy UI surface."}
   "settings" {"path" "/api/v1/settings" "legacyPath" "/api/ui/settings" "status" "implemented"
               "description" "Tenant and proxy settings endpoints migrating from the legacy UI surface."}
   "hosts" {"path" "/api/v1/hosts" "legacyPath" "/api/ui/hosts" "status" "implemented"
            "description" "Host inventory and host overview endpoints migrating from the legacy UI surface."}
   "events" {"path" "/api/v1/events" "legacyPath" "/api/ui/events" "status" "implemented"
             "description" "Event store query and tag endpoints migrating from the legacy UI surface."}
   "observability" {"path" "/api/v1/dashboard" "legacyPath" "/api/ui/dashboard" "status" "implemented"
                    "description" "Dashboard, analytics, request-log, tool, and MCP seed endpoints migrating from the legacy UI surface."}
   "mcp" {"path" "/api/v1/mcp" "legacyPath" "/api/ui/mcp-servers" "status" "planned"
          "description" "MCP discovery endpoints migrating from the legacy UI surface."}))

(defn- count-with-status [status]
  (count (filter #(= status (get % "status")) (vals endpoints))))

(defn index []
  {"version" "1.0.0"
   "migration" {"legacyPrefix" "/api/ui"
                "targetPrefix" "/api/v1"
                "strategy" "planned_to_implemented"
                "deprecationRule" "legacy routes are deprecated only after the corresponding /api/v1 endpoint is implemented"}
   "summary" {"planned" (count-with-status "planned") "implemented" (count-with-status "implemented")}
   "endpoints" endpoints
   "documentation" {"path" "/api/v1/openapi.json" "status" "implemented"}})
