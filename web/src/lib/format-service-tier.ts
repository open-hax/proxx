import { type RequestLogEntry } from "./api";

export type FormatServiceTierStyle = "title" | "lower";

/**
 * Format a request log entry's service tier for display.
 *
 * - `serviceTierSource === "fast_mode"` is shown as "Fast mode" / "fast mode".
 * - `serviceTier === "priority"` is shown as "Priority" / "priority".
 * - Missing tier is shown as "Standard" / "standard".
 * - Any other tier has underscores/dashes replaced with spaces.
 */
export function formatServiceTier(entry: RequestLogEntry, style: FormatServiceTierStyle = "lower"): string {
  if (!entry.serviceTier) {
    return style === "title" ? "Standard" : "standard";
  }

  if (entry.serviceTierSource === "fast_mode") {
    return style === "title" ? "Fast mode" : "fast mode";
  }

  if (entry.serviceTier === "priority") {
    return style === "title" ? "Priority" : "priority";
  }

  return entry.serviceTier.replace(/[_-]+/g, " ");
}
