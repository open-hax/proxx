import { kernels } from "../cljs-kernels.js";

/**
 * Fetch with a response timeout: if the response does not arrive in time the
 * request is aborted with a TimeoutError. The logic is CLJS (`proxx.runtime.http`).
 */
export const fetchWithResponseTimeout = (url: string, init: RequestInit, timeoutMs: number): Promise<Response> =>
  kernels.fetchWithResponseTimeout(url, init, timeoutMs);
