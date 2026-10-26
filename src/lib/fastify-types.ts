import type { BudgetRoutePlan } from "./cljs-runtime.js";
import type { ResponseDeadlineLease } from "./http/index.js";
import type { ResolvedRequestAuth } from "./request-auth.js";
import type { TelemetrySpan } from "./telemetry/otel.js";

declare module "fastify" {
  interface FastifyRequest {
    _proxxAdmittedAt?: number;
    _budgetRoutePlan?: BudgetRoutePlan;
    _firstOutputLease?: ResponseDeadlineLease;
    openHaxAuth: ResolvedRequestAuth | null;
    _otelSpan: TelemetrySpan | null;
  }
}
