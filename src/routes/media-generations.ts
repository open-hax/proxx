import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { joinUrl } from "../lib/http/index.js";
import { buildUpstreamHeadersForCredential, copyUpstreamHeaders } from "../lib/proxy.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { kernels } from "../lib/cljs-kernels.js";
import { toErrorMessage } from "../lib/errors/index.js";
import type { ProviderCredential } from "../lib/key-pool.js";

/*
 * Media generation routes (music, video, tts). The routes, provider verdicts and
 * payload shapes live in CLJS (proxx.http.media, proxx.runtime.routes.media);
 * this module supplies the node-level effects: the HTTP POST to the provider
 * and saving generated audio to disk.
 */

interface MediaResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

function headersToIncoming(headers: Headers): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of headers.entries()) {
    result[name] = value;
  }
  return result;
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(name, entry);
      }
    } else if (typeof value === "string") {
      result.set(name, value);
    } else if (typeof value === "number") {
      result.set(name, String(value));
    }
  }
  return result;
}

function postMediaJson(
  upstreamUrl: string,
  headers: Headers | Record<string, string>,
  bodyText: string,
  timeoutMs: number,
): Promise<MediaResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(upstreamUrl);
    const requestFn = parsedUrl.protocol === "http:" ? httpRequest : httpsRequest;
    const upstreamRequest = requestFn(
      parsedUrl,
      {
        method: "POST",
        headers: headersToIncoming(new Headers(headers)),
        timeout: timeoutMs,
      },
      (upstreamResponse) => {
        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamResponse.on("end", () => {
          resolve({
            status: upstreamResponse.statusCode ?? 502,
            headers: headersFromIncoming(upstreamResponse.headers),
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    upstreamRequest.on("timeout", () => {
      upstreamRequest.destroy(new Error(`BlazeAPI media request timed out after ${timeoutMs}ms`));
    });
    upstreamRequest.on("error", reject);
    upstreamRequest.write(bodyText);
    upstreamRequest.end();
  });
}

/** Decode and save generated audio (and the full upstream JSON beside it); returns the byte count. */
async function saveGeneratedAudio(input: {
  readonly rawAudio: string;
  readonly encoding: "hex" | "base64";
  readonly filePath: string;
  readonly text: string;
}): Promise<number> {
  const audioBytes = Buffer.from(input.rawAudio, input.encoding === "hex" ? "hex" : "base64");
  try {
    await mkdir("/app/data/blaze_generated", { recursive: true });
    await writeFile(input.filePath, audioBytes);
    await writeFile(input.filePath.replace(/\.(mp3|wav)$/i, ".json"), input.text, "utf8");
  } catch {
    // ignore write errors
  }
  return audioBytes.length;
}

export function registerMediaGenerationRoutes(deps: AppDeps, app: FastifyInstance): void {
  kernels.registerMediaRoutes(app, deps, {
    postMediaJson,
    saveGeneratedAudio,
    buildCredentialHeaders: (clientHeaders: IncomingHttpHeaders, account: ProviderCredential) =>
      buildUpstreamHeadersForCredential(clientHeaders, account),
    copyUpstreamHeaders,
    toErrorMessage,
    joinUrl,
    getActiveCljsRuntime,
  });
}
