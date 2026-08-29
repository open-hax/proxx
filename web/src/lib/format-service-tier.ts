import type { RequestLogEntry } from "./api";

type ServiceTierFields = Pick<RequestLogEntry, "serviceTier" | "serviceTierSource">;

/**
 * Format a request log entry's service tier for display.
 *
 * - `serviceTierSource === "fast_mode"` is shown as "Fast mode".
 * - `serviceTier === "priority"` is shown as "Priority".
 * - Missing tier is shown as "Standard".
 * - Any other tier is normalized to sentence case with underscores/dashes
 *   replaced by spaces.
 */
export function formatServiceTier(entry: ServiceTierFields): string {
  if (entry.serviceTierSource === "fast_mode") {
    return "Fast mode";
  }

  if (!entry.serviceTier) {
    return "Standard";
  }

  const normalized = entry.serviceTier.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return "Standard";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
