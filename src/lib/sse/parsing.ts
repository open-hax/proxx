/**
 * SSE (Server-Sent Events) parsing utilities.
 */

import { isRecord, asString } from "../provider-utils.js";

/**
 * Extract data lines from an SSE payload.
 * Returns an array of parsed data values (after the "data:" prefix).
 */
export function extractSseDataLines(payload: string): string[] {
  return payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
}

/**
 * Remove comment lines (starting with ":") from an SSE payload.
 */
export function stripSseCommentLines(payload: string): string {
  return payload
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(":"))
    .join("\n");
}

/**
 * Check if a chat completion object contains reasoning content.
 */
export function chatCompletionHasReasoningContent(completion: Record<string, unknown>): boolean {
  const topLevelReasoning = asString(completion["reasoning_content"]) ?? asString(completion["reasoning"]);
  if (topLevelReasoning && topLevelReasoning.length > 0) {
    return true;
  }

  const choices = Array.isArray(completion["choices"]) ? completion["choices"] : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }

    const message = isRecord(choice["message"]) ? choice["message"] : null;
    if (message) {
      const reasoning = asString(message["reasoning_content"]) ?? asString(message["reasoning"]);
      if (reasoning && reasoning.length > 0) {
        return true;
      }
    }

    const delta = isRecord(choice["delta"]) ? choice["delta"] : null;
    if (delta) {
      const reasoning = asString(delta["reasoning_content"]) ?? asString(delta["reasoning"]);
      if (reasoning && reasoning.length > 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an SSE stream payload contains reasoning trace content.
 * Parses data lines and checks for reasoning-related event types.
 */
export function streamPayloadHasReasoningTrace(payload: string): boolean {
  for (const data of extractSseDataLines(payload)) {
    if (data === "[DONE]") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) {
        continue;
      }

      if (chatCompletionHasReasoningContent(parsed)) {
        return true;
      }

      const type = asString(parsed["type"]);
      if (
        type === "response.reasoning.delta"
        || type === "response.reasoning_text.delta"
        || type === "response.reasoning_summary.delta"
        || type === "response.reasoning_summary_text.delta"
        || type === "response.reasoning_summary_part.delta"
      ) {
        const delta = parsed["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          return true;
        }
        if (isRecord(delta) && typeof delta["text"] === "string" && delta["text"].length > 0) {
          return true;
        }
      }

      if (type === "response.output_item.added") {
        const item = isRecord(parsed["item"]) ? parsed["item"] : null;
        if (item && asString(item["type"]) === "reasoning") {
          return true;
        }
      }
    } catch {
      // ignore malformed stream fragments during validation
    }
  }
  return false;
}

/**
 * Check if an SSE stream payload contains substantive (non-empty) chunks.
 */
export function streamPayloadHasSubstantiveChunks(payload: string): boolean {
  for (const data of extractSseDataLines(payload)) {
    if (data === "[DONE]") {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) {
        return true;
      }

      const type = asString(parsed["type"]);
      if (
        type === "response.reasoning.delta"
        || type === "response.reasoning_text.delta"
        || type === "response.reasoning_summary.delta"
        || type === "response.reasoning_summary_text.delta"
        || type === "response.reasoning_summary_part.delta"
      ) {
        const delta = parsed["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          return true;
        }

        if (isRecord(delta) && typeof delta["text"] === "string" && delta["text"].length > 0) {
          return true;
        }
        continue;
      }
    } catch {
      return true;
    }

    return true;
  }
  return false;
}
