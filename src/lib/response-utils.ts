import { isRecord } from "./provider-utils.js";

export function extractResponseTextAndUrlCitations(payload: unknown): {
  readonly text: string;
  readonly citations: Array<{ readonly url: string; readonly title?: string }>;
  readonly responseId?: string;
} {
  if (!isRecord(payload)) {
    return { text: "", citations: [] };
  }

  const responseId = typeof payload.id === "string" ? payload.id : undefined;
  const outputText = typeof payload.output_text === "string" ? payload.output_text : "";
  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];
  const citations = new Map<string, { url: string; title?: string }>();

  for (const item of output) {
    if (isRecord(item) && item.type === "web_search_call") {
      const action = isRecord(item.action) ? item.action : null;
      const sources = action && Array.isArray(action.sources) ? action.sources : [];
      for (const source of sources) {
        if (!isRecord(source)) {
          continue;
        }
        const url = typeof source.url === "string" ? source.url : "";
        if (!url) {
          continue;
        }
        if (!citations.has(url)) {
          const title = typeof source.title === "string" && source.title.trim().length > 0 ? source.title.trim() : undefined;
          citations.set(url, { url, ...(title ? { title } : {}) });
        }
      }
      continue;
    }

    if (!isRecord(item) || item.type !== "message") {
      continue;
    }
    if (typeof item.role === "string" && item.role !== "assistant") {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part) || part.type !== "output_text") {
        continue;
      }

      const text = typeof part.text === "string" ? part.text : "";
      if (text.length > 0) {
        texts.push(text);
      }

      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const ann of annotations) {
        if (!isRecord(ann)) {
          continue;
        }
        if (ann.type !== "url_citation") {
          continue;
        }
        const url = typeof ann.url === "string" ? ann.url : "";
        if (!url) {
          continue;
        }
        if (!citations.has(url)) {
          const title = typeof ann.title === "string" && ann.title.trim().length > 0 ? ann.title.trim() : undefined;
          citations.set(url, { url, ...(title ? { title } : {}) });
        }
      }
    }
  }

  const combined = (texts.length > 0 ? texts.join("\n\n") : outputText).trim();
  return { text: combined, citations: Array.from(citations.values()), responseId };
}

export function extractMarkdownLinks(text: string): Array<{ readonly url: string; readonly title?: string }> {
  const citations = new Map<string, { url: string; title?: string }>();
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of text.matchAll(regex)) {
    const title = (match[1] ?? "").trim();
    const url = (match[2] ?? "").trim();
    if (!url) continue;
    if (citations.has(url)) continue;
    citations.set(url, { url, ...(title ? { title } : {}) });
  }
  return Array.from(citations.values());
}
