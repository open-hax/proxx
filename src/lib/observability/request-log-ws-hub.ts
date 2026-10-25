import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { kernels } from "../cljs-kernels.js";
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

function toWireEntry(entry: RequestLogEntry): RequestLogEntry & { readonly decodeTps?: number } {
  return {
    ...entry,
    decodeTps: entry.tps,
  };
}

export class RequestLogWsHub {
  private readonly wsServer = new WebSocketServer({ noServer: true });
  // Sockets keyed by the id registered with the CLJS fan-out state
  // (proxx.observability.fanout), which decides who receives each entry.
  private readonly clients = new Map<string, WebSocket>();
  private readonly fanout = kernels.createRequestLogFanout();
  private nextClientId = 0;
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
      const clientId = `ws-${this.nextClientId++}`;
      this.clients.set(clientId, webSocket);
      this.fanout.subscribe(clientId, identity, subscription);

      const remove = () => {
        this.clients.delete(clientId);
        this.fanout.unsubscribe(clientId);
      };
      webSocket.on("close", remove);
      webSocket.on("error", remove);

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
    this.fanout.clear();
  }

  private broadcast(event: RequestLogEvent): void {
    if (this.clients.size === 0) {
      return;
    }

    const payload = JSON.stringify({
      type: this.fanout.eventType(event.type),
      entry: toWireEntry(event.entry),
    });

    for (const clientId of this.fanout.recipients(event.entry)) {
      const client = this.clients.get(clientId);
      if (client === undefined || client.readyState !== WebSocket.OPEN) {
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
        this.clients.delete(clientId);
        this.fanout.unsubscribe(clientId);
      }
    }
  }
}
