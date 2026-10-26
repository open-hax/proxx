import { kernels } from "../cljs-kernels.js";

/**
 * OTLP/HTTP telemetry. Payload shaping, queue accounting and configuration are
 * pure CLJS (`proxx.telemetry.otlp`); `proxx.runtime.telemetry` owns the active
 * client, span objects, the flush timer and the exports.
 */
type TelemetryValue = string | number | boolean | null | undefined;
export type TelemetryAttributes = Record<string, TelemetryValue>;

type TelemetryLevel = "debug" | "info" | "warn" | "error";

type SpanStatus = "ok" | "error";

export interface TelemetrySpan {
  setAttribute: (key: string, value: TelemetryValue) => void;
  setAttributes: (attributes: TelemetryAttributes) => void;
  setStatus: (status: SpanStatus, message?: string) => void;
  recordError: (error: unknown) => void;
  end: (extraAttributes?: TelemetryAttributes) => void;
}

export interface TelemetryClient {
  readonly enabled: boolean;
  startSpan: (name: string, attributes?: TelemetryAttributes) => TelemetrySpan;
  recordMetric: (name: string, value: number, attributes?: TelemetryAttributes) => void;
  recordLog: (level: TelemetryLevel, message: string, attributes?: TelemetryAttributes) => void;
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
  getStats: () => {
    enabled: boolean;
    endpoint: string | null;
    queued: {
      traces: number;
      logs: number;
      metrics: number;
    };
    flushes: number;
    dropped: number;
    lastFlushAt: string | null;
  };
}

export function initTelemetry(): TelemetryClient {
  return kernels.initTelemetry(process.env);
}

export function getTelemetry(): TelemetryClient {
  return kernels.getTelemetry();
}

export function shutdownTelemetry(): Promise<void> {
  return kernels.shutdownTelemetry();
}
