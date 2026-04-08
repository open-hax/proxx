import type { ServerResponse } from "node:http";

import type { RequestLogEvent, RequestLogEntry, RequestLogStore } from "../request-log-store.js";
import type { RequestLogWsIdentity, RequestLogWsSubscription } from "./request-log-ws-hub.js";

interface SseClient {
  readonly res: ServerResponse;
  readonly identity: RequestLogWsIdentity;
  readonly subscription: RequestLogWsSubscription;
}

export class RequestLogSseHub {
  private readonly sseClients = new Set<SseClient>();
  private readonly unsubscribe: () => void;

  public constructor(store: RequestLogStore) {
    this.unsubscribe = store.subscribe((event) => {
      this.broadcast(event);
    });
  }

  public addClient(res: ServerResponse, identity: RequestLogWsIdentity, subscription: RequestLogWsSubscription): () => void {
    const client: SseClient = { res, identity, subscription };
    this.sseClients.add(client);

    res.write(`event: hello\ndata: ${JSON.stringify({
      type: "hello",
      protocol: "request-log-sse-v0",
      now: new Date().toISOString(),
      subscription,
    })}\n\n`);

    const remove = () => {
      this.sseClients.delete(client);
    };

    res.on("close", remove);

    return remove;
  }

  public async close(): Promise<void> {
    this.unsubscribe();
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
  }

  private broadcast(event: RequestLogEvent): void {
    if (this.sseClients.size === 0) {
      return;
    }

    const payload = {
      type: event.type === "record" ? "request_log_record" : "request_log_update",
      entry: event.entry,
    };

    for (const client of this.sseClients) {
      if (client.res.writableEnded) {
        this.sseClients.delete(client);
        continue;
      }

      if (!entryVisibleToIdentity(event.entry, client.identity)) {
        continue;
      }

      if (!entryMatchesSubscription(event.entry, client.subscription)) {
        continue;
      }

      try {
        client.res.write(`event: request_log\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}

function normalizeRouteKind(value: string | undefined): RequestLogWsSubscription["routeKind"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "federated" || normalized === "bridge" || normalized === "routed" || normalized === "any") {
    return normalized;
  }
  return undefined;
}

function entryMatchesSubscription(entry: RequestLogEntry, subscription: RequestLogWsSubscription): boolean {
  const routeKind = normalizeRouteKind(subscription.routeKind);
  if (routeKind && routeKind !== "any") {
    if (routeKind === "routed") {
      if (entry.routeKind === "local") {
        return false;
      }
    } else if (entry.routeKind !== routeKind) {
      return false;
    }
  }

  const ownerSubject = typeof subscription.ownerSubject === "string" ? subscription.ownerSubject.trim() : "";
  if (ownerSubject.length > 0) {
    return entry.federationOwnerSubject === ownerSubject;
  }

  return true;
}

function entryVisibleToIdentity(entry: RequestLogEntry, identity: RequestLogWsIdentity): boolean {
  if (identity.authKind === "legacy_admin") {
    return true;
  }

  const tenantId = typeof identity.tenantId === "string" ? identity.tenantId.trim() : "";
  if (tenantId.length === 0) {
    return false;
  }

  return entry.tenantId === tenantId;
}