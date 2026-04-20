// Compatibility barrel for the provider-strategy migration.
//
// Older call sites import from "../lib/provider-strategy.js". The implementation
// has been split into modules under ./provider-strategy/*.

export {
  selectProviderStrategy,
  buildResponsesPassthroughContext,
  buildImagesPassthroughContext,
} from "./provider-strategy/contexts.js";

export { executeLocalStrategy } from "./provider-strategy/local.js";

export {
  executeProviderRoutingPlan,
  executeProviderFallback,
  inspectProviderAvailability,
} from "./provider-strategy/fallback/index.js";

export * from "./provider-strategy/shared.js";
