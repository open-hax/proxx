import type { ResolvedRequestAuth } from "./request-auth.js";
import type { TelemetrySpan } from "./telemetry/otel.js";

declare module "fastify" {
  interface FastifyRequest {
    openHaxAuth: ResolvedRequestAuth | null;
    _otelSpan: TelemetrySpan | null;
  }
}
