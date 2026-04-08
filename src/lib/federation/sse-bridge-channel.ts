import type { ServerResponse } from "node:http";

import type { BridgeSendChannel } from "./bridge-send-channel.js";

class SseBridgeSendChannel implements BridgeSendChannel {
  private readonly res: ServerResponse;
  private _isOpen: boolean = true;

  constructor(res: ServerResponse) {
    this.res = res;
  }

  get isOpen(): boolean {
    return this._isOpen && !this.res.writableEnded;
  }

  send(data: string): void {
    if (!this.isOpen) {
      return;
    }
    this.res.write(`data: ${data}\n\n`);
  }

  close(code?: number, reason?: string): void {
    if (!this._isOpen) {
      return;
    }
    this._isOpen = false;
    if (code && code >= 4000) {
      this.res.write(`event: close\ndata: {"code":${code},"reason":${JSON.stringify(reason ?? "")}}\n\n`);
    }
    this.res.end();
  }
}

export interface SseBridgeSession {
  readonly sessionId: string;
  readonly channel: BridgeSendChannel;
}

export function createSseBridgeSendChannel(res: ServerResponse): BridgeSendChannel {
  return new SseBridgeSendChannel(res);
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}