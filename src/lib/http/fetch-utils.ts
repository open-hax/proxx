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

export interface ResponseDeadlineLease {
  readonly signal: AbortSignal;
  readonly markReady: () => void;
}

/** An absolute deadline covers queueing and setup, and ends at usable output. */
export async function withResponseDeadline<T>(
  deadlineAt: number,
  timeoutError: () => Error,
  task: (lease: ResponseDeadlineLease) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError();
      controller.abort(error);
      reject(error);
    }, remaining);
  });
  const markReady = () => { if (timer) clearTimeout(timer); timer = undefined; };
  try { return await Promise.race([task({ signal: controller.signal, markReady }), timeout]); }
  finally { markReady(); }
}

/** Buffer bytes before downstream commitment. The CLJS policy supplies the
 * readiness probe; this adapter only enforces byte/time bounds and replays IO. */
export async function stageResponse(
  response: Response,
  deadlineAt: number,
  maxBytes: number,
  probe: (text: string, format: string) => { readonly ready: boolean; readonly fatal: boolean },
  onReady: () => void,
  awaitEnd = false,
): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No upstream response body");
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  const format = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ? "sse" : "json";
  let text = "";
  let bytes = 0;
  let ended = false;
  const cancel = () => {
    abortFetchResponse(response);
    void reader.cancel().catch(() => {});
  };
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("First usable output deadline exceeded");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("First usable output deadline exceeded")), remaining);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      ended = chunk.done === true;
      if (chunk.value) {
        chunks.push(chunk.value);
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("Upstream bootstrap byte bound exceeded");
        text += decoder.decode(chunk.value, { stream: true });
      }
      if (ended) text += decoder.decode();
      const result = response.ok ? probe(text, format) : { ready: false, fatal: false };
      if (result.fatal) { cancel(); ended = true; break; }
      if (result.ready && (ended || (format === "sse" && !awaitEnd))) { onReady(); break; }
      if (ended) {
        if (response.ok) throw new Error("Upstream ended without usable output");
        break;
      }
    }
  } catch (error) { cancel(); throw error; }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      if (ended) { c.close(); try { reader.releaseLock(); } catch { /* canceled reader */ } }
    },
    async pull(c) {
      if (ended) return;
      try {
        const next = await reader.read();
        if (next.done) { ended = true; c.close(); reader.releaseLock(); }
        else if (next.value) c.enqueue(next.value);
      } catch (error) { c.error(error); cancel(); }
    },
    cancel() { cancel(); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
