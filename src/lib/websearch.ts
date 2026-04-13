import { isRecord } from "./provider-utils.js";

export type WebSearchContextSize = "low" | "medium" | "high";

export interface WebSearchSource {
  readonly url: string;
  readonly title?: string;
}

export function normalizeOpenAiModelForWebsearch(model: string | undefined): string {
  const raw = typeof model === "string" ? model.trim() : "";
  if (!raw) {
    return "openai/gpt-5.3-codex";
  }

  if (raw.startsWith("openai/") || raw.startsWith("openai:")) {
    return raw;
  }

  return `openai/${raw}`;
}

export function buildWebSearchPrompt(input: {
  query: string;
  numResults: number;
  year: number;
}): string {
  return [
    `Today is ${input.year}. If the query is time-sensitive, bias toward ${input.year} sources.`,
    `Search the web for: ${JSON.stringify(input.query)}.`,
    `Return up to ${input.numResults} results as a markdown list.`,
    `Each item MUST include: title, url, and a 1-2 sentence snippet.`,
    `Do not add commentary outside the list.`,
  ].join("\n");
}

export function extractOutputTextFromResponses(response: unknown): string {
  if (!isRecord(response)) return "";

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const output = response.output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== "message") continue;
    if (item.role !== "assistant") continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (part.type !== "output_text") continue;
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }

  return chunks.join("\n").trim();
}

export function extractWebSearchSourcesFromResponses(response: unknown): WebSearchSource[] {
  if (!isRecord(response)) return [];
  const output = response.output;
  if (!Array.isArray(output)) return [];

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== "web_search_call") continue;

    const action = isRecord(item.action) ? item.action : null;
    const sources = action && Array.isArray(action.sources) ? action.sources : null;
    if (!sources) continue;

    const result: WebSearchSource[] = [];
    for (const source of sources) {
      if (!isRecord(source)) continue;
      const url = typeof source.url === "string" ? source.url : "";
      if (!url) continue;
      const title = typeof source.title === "string" ? source.title : undefined;
      result.push({ url, title });
    }
    return result;
  }

  return [];
}
