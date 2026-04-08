export interface BridgeSendChannel {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
}