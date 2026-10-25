import type { ServerResponse } from "node:http";

import type { RequestLogEvent, RequestLogStore } from "../request-log-store.js";
import { kernels } from "../cljs-kernels.js";
import type { RequestLogWsIdentity, RequestLogWsSubscription } from "./request-log-ws-hub.js";

// Visibility and subscription filtering are decided by the CLJS fan-out
// state (proxx.observability.fanout); this hub only owns the sockets.

export class RequestLogSseHub {
  private readonly sseClients = new Map<string, ServerResponse>();
  private readonly fanout = kernels.createRequestLogFanout();
  private nextClientId = 0;
  private readonly unsubscribe: () => void;

  public constructor(store: RequestLogStore) {
    this.unsubscribe = store.subscribe((event) => {
      this.broadcast(event);
    });
  }

  public addClient(res: ServerResponse, identity: RequestLogWsIdentity, subscription: RequestLogWsSubscription): () => void {
    const clientId = `sse-${this.nextClientId++}`;
    this.sseClients.set(clientId, res);
    this.fanout.subscribe(clientId, identity, subscription);

    res.write(`event: hello\ndata: ${JSON.stringify({
      type: "hello",
      protocol: "request-log-sse-v0",
      now: new Date().toISOString(),
      subscription,
    })}\n\n`);

    const remove = () => {
      this.sseClients.delete(clientId);
      this.fanout.unsubscribe(clientId);
    };

    res.on("close", remove);

    return remove;
  }

  public async close(): Promise<void> {
    this.unsubscribe();
    for (const res of this.sseClients.values()) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    this.fanout.clear();
  }

  private broadcast(event: RequestLogEvent): void {
    if (this.sseClients.size === 0) {
      return;
    }

    for (const [clientId, res] of this.sseClients) {
      if (res.writableEnded) {
        this.sseClients.delete(clientId);
        this.fanout.unsubscribe(clientId);
      }
    }

    const payload = {
      type: this.fanout.eventType(event.type),
      entry: event.entry,
    };

    for (const clientId of this.fanout.recipients(event.entry)) {
      const res = this.sseClients.get(clientId);
      if (res === undefined) {
        continue;
      }

      try {
        res.write(`event: request_log\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        this.sseClients.delete(clientId);
        this.fanout.unsubscribe(clientId);
      }
    }
  }
}
