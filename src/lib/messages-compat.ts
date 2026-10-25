/**
 * OpenAI chat-completions <-> Anthropic /v1/messages translation.
 *
 * The translation is pure data transformation in CLJS (`proxx.compat.messages`);
 * these are the stable TypeScript entry points.
 */

import { kernels } from "./cljs-kernels.js";

export const shouldUseMessagesUpstream = (model: unknown, prefixes: readonly string[]): boolean =>
  kernels.shouldUseMessagesUpstream(model, prefixes);

export const normalizeMessagesThinkingBudget = (payload: Record<string, unknown>): Record<string, unknown> =>
  kernels.normalizeMessagesThinkingBudget(payload);

export const chatRequestToMessagesRequest = (body: Record<string, unknown>): Record<string, unknown> =>
  kernels.chatRequestToMessagesRequest(body);

export const messagesToChatCompletion = (body: unknown, fallbackModel: string): Record<string, unknown> =>
  kernels.messagesToChatCompletion(body, fallbackModel);
