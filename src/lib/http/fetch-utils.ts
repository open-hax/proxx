/**
 * HTTP fetch utilities with timeout and abort signal support.
 */

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
    return await fetch(url, {
      ...init,
      signal: mergedSignal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}
