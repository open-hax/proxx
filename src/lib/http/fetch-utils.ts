/**
 * HTTP fetch utilities with timeout and abort signal support.
 */

const responseAbortControllers = new WeakMap<Response, AbortController>();

/** Abort the transport that produced a response after its headers were received. */
export function abortFetchResponse(response: Response, reason?: unknown): void {
  const controller = responseAbortControllers.get(response);
  if (controller && !controller.signal.aborted) {
    controller.abort(reason);
  }
}

/**
 * Fetch with a response timeout.
 *
 * If the response doesn't arrive within the specified timeout, the request
 * is aborted with a TimeoutError.
 */
export async function fetchWithResponseTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);

  const mergedSignal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(url, {
      ...init,
      signal: mergedSignal,
    });
    responseAbortControllers.set(response, controller);
    return response;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
