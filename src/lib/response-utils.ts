import { kernels } from "./cljs-kernels.js";

export const extractResponseTextAndUrlCitations = (payload: unknown): {
  readonly text: string;
  readonly citations: Array<{ readonly url: string; readonly title?: string }>;
  readonly responseId?: string;
} => kernels.extractResponseTextAndUrlCitations(payload);

export const extractMarkdownLinks = (text: string): Array<{ readonly url: string; readonly title?: string }> =>
  kernels.extractMarkdownLinks(text);
