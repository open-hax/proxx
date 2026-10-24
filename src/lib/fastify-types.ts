import type { ResolvedRequestAuth } from "./request-auth.js";
import type { TelemetrySpan } from "./telemetry/otel.js";

declare module "fastify" {
  interface FastifyInstance {
    axxiumConsumer?: import("./cljs-runtime.js").AxxiumConsumer;
  }
  interface FastifyRequest {
    openHaxAuth: ResolvedRequestAuth | null;
    _otelSpan: TelemetrySpan | null;
  }
}
