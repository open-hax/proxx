import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import type { RequestLogEntry, RequestLogEvent, RequestLogStore } from "../request-log-store.js";

export interface RequestLogWsIdentity {
  readonly authKind: "legacy_admin" | "ui_session";
  readonly tenantId?: string;
}

export interface RequestLogWsSubscription {
  readonly ownerSubject?: string;
  readonly routeKind?: "local" | "federated" | "bridge" | "routed" | "any";
}

function writeUpgradeResponse(socket: Duplex, statusCode: number, statusText: string, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: application/json; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "\r\n"
      + body,
  );
  socket.destroy();
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

function toWireEntry(entry: RequestLogEntry): RequestLogEntry & { readonly decodeTps?: number } {
  return {
    ...entry,
    decodeTps: entry.tps,
  };
}

export class RequestLogWsHub {
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly clients = new Map<WebSocket, { readonly identity: RequestLogWsIdentity; readonly subscription: RequestLogWsSubscription }>();
  private readonly unsubscribe: () => void;

  public constructor(store: RequestLogStore) {
    this.unsubscribe = store.subscribe((event) => {
      this.broadcast(event);
    });
  }

  public rejectUpgrade(socket: Duplex, statusCode: 401 | 403 | 404, payload: Record<string, unknown>): void {
    const statusText = statusCode === 401 ? "Unauthorized" : statusCode === 403 ? "Forbidden" : "Not Found";
    writeUpgradeResponse(socket, statusCode, statusText, payload);
  }

  public handleAuthorizedUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: RequestLogWsIdentity,
    subscription: RequestLogWsSubscription,
  ): void {
    this.wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.clients.set(webSocket, { identity, subscription });

      webSocket.on("close", () => {
        this.clients.delete(webSocket);
      });

      webSocket.on("error", () => {
        this.clients.delete(webSocket);
      });

      webSocket.send(JSON.stringify({
        type: "hello",
        protocol: "request-log-ws-v0",
        now: new Date().toISOString(),
        subscription,
      }));
    });
  }

  public async close(): Promise<void> {
    this.unsubscribe();

    for (const client of this.wsServer.clients) {
      client.close();
    }

    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });

    this.clients.clear();
  }

  private broadcast(event: RequestLogEvent): void {
    if (this.clients.size === 0) {
      return;
    }

    const payload = JSON.stringify({
      type: event.type === "record" ? "request_log_record" : "request_log_update",
      entry: toWireEntry(event.entry),
    });

    for (const [client, meta] of this.clients.entries()) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (!entryVisibleToIdentity(event.entry, meta.identity)) {
        continue;
      }

      if (!entryMatchesSubscription(event.entry, meta.subscription)) {
        continue;
      }

      try {
        client.send(payload);
      } catch {
        try {
          client.terminate();
        } catch {
          // ignore
        }
        this.clients.delete(client);
      }
    }
  }
}
