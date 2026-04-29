import { initTelemetry, shutdownTelemetry } from "./lib/telemetry/otel.js";
import { createApp } from "./app.js";
import { assertCljsRuntimeReady, loadCljsRuntime } from "./lib/cljs-runtime.js";
import { loadConfig } from "./lib/config.js";

initTelemetry();

const config = loadConfig();
const app = await createApp(config);

const cljsRuntime = await loadCljsRuntime({ required: process.env.PROXX_CLJS_RUNTIME_REQUIRED === "true" });
if (cljsRuntime.loaded) {
  await assertCljsRuntimeReady(cljsRuntime.runtime);
  app.log.info({ modulePath: cljsRuntime.modulePath }, "CLJS runtime loaded");
} else {
  app.log.warn({ reason: cljsRuntime.reason }, "CLJS runtime not loaded; TypeScript runtime remains authoritative");
}

await app.listen({ host: config.host, port: config.port });
app.log.info({ host: config.host, port: config.port }, "open-hax-openai-proxy listening");

let shuttingDown = false;
const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  app.log.info({ signal }, "shutdown: received signal, closing server");

  // Stop accepting new connections and wait for in-flight requests to finish.
  // Fastify implements graceful shutdown semantics via app.close().
  try {
    await app.close();
  } catch (error) {
    app.log.warn({ err: error }, "shutdown: error while closing server");
  }

  try {
    await shutdownTelemetry();
  } catch (error) {
    app.log.warn({ err: error }, "shutdown: error while shutting down telemetry");
  }

  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
