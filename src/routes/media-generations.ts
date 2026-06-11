import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { joinUrl } from "../lib/http/index.js";
import { buildUpstreamHeadersForCredential, copyUpstreamHeaders } from "../lib/proxy.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { isRecord, sendOpenAiError } from "../lib/provider-utils.js";
import { toErrorMessage } from "../lib/errors/index.js";

interface BlazeMediaRoute {
  readonly localPath: string;
  readonly upstreamPath: string;
  readonly label: string;
}

const BLAZE_MEDIA_ROUTES: readonly BlazeMediaRoute[] = [
  { localPath: "/v1/music/generations", upstreamPath: "/music/generations", label: "music" },
  { localPath: "/v1/videos/generations", upstreamPath: "/videos/generations", label: "video" },
  { localPath: "/v1/video/generations", upstreamPath: "/videos/generations", label: "video" },
  { localPath: "/v1/audio/speech", upstreamPath: "/audio/speech", label: "tts" },
];

interface BlazeMediaResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

function blazeBaseUrl(deps: AppDeps): string {
  return (deps.config.upstreamProviderBaseUrls.blaze ?? "https://blazeai.boxu.dev/api").replace(/\/+$/, "");
}

function minimaxBaseUrl(deps: AppDeps): string {
  return (deps.config.upstreamProviderBaseUrls.minimax ?? "https://api.minimax.io").replace(/\/+$/, "");
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

function parseBlazeLogicalFailure(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const message = typeof parsed.message === "string" ? parsed.message : undefined;
    if (status === "failed" || status === "error" || status === "terminated" || status === "canceled" || status === "cancelled") {
      return [status ? `status=${status}` : undefined, error ?? message]
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .join("; ") || "status=failed";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseMinimaxLogicalFailure(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const baseResp = isRecord(parsed.base_resp) ? parsed.base_resp : null;
    if (baseResp) {
      const statusCode = typeof baseResp.status_code === "number" ? baseResp.status_code : undefined;
      const statusMsg = typeof baseResp.status_msg === "string" ? baseResp.status_msg : undefined;

      if (statusCode !== undefined && statusCode !== 0) {
        return `MiniMax error ${statusCode}: ${statusMsg ?? "unknown error"}`;
      }
    }

    const data = isRecord(parsed.data) ? parsed.data : null;
    const generationStatus = typeof data?.status === "number" ? data.status : undefined;
    if (generationStatus !== undefined && generationStatus !== 2) {
      return `MiniMax generation incomplete (status=${generationStatus})`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function hasValidMediaOutput(text: string, routeLabel: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return false;
    }
    const data = isRecord(parsed.data) ? parsed.data : null;
    if (!data) {
      return false;
    }
    switch (routeLabel) {
      case "music":
        return typeof data.audio === "string" && data.audio.length > 0;
      case "video":
        return typeof data.video === "string" && data.video.length > 0;
      case "image":
        return (typeof data.url === "string" && data.url.length > 0) ||
               (typeof data.image_url === "string" && data.image_url.length > 0);
      default:
        return true;
    }
  } catch {
    return false;
  }
}

function postBlazeMediaJson(upstreamUrl: string, headers: Headers, bodyText: string, timeoutMs: number): Promise<BlazeMediaResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(upstreamUrl);
    const requestFn = parsedUrl.protocol === "http:" ? httpRequest : httpsRequest;
    const upstreamRequest = requestFn(
      parsedUrl,
      {
        method: "POST",
        headers: headersToIncoming(headers),
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

function mediaProviderFromPolicy(deps: AppDeps, route: BlazeMediaRoute, model: string): string {
  const runtime = getActiveCljsRuntime();
  if (!runtime) {
    return "blaze";
  }

  try {
    const result = runtime.previewPolicyDecision(
      deps.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn",
      {
        modelId: model,
        requestKind: route.label,
        tenantSettings: {},
      },
    );
    if (result.status !== "ok" || !isRecord(result.decision)) {
      return "blaze";
    }
    const providerId = result.decision["provider-id"];
    return typeof providerId === "string" && providerId.length > 0 ? providerId : "blaze";
  } catch (error) {
    deps.app.log.warn({ model, requestKind: route.label, error: toErrorMessage(error) }, "CLJS media policy preview failed");
    return "blaze";
  }
}

function musicgenBaseUrl(deps: AppDeps): string {
  return (deps.config.upstreamProviderBaseUrls.musicgen ?? "http://musicgen:8080").replace(/\/+$/, "");
}

function transformToMinimaxBody(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "";
  const minimaxModel = model.replace(/^MiniMax-music-/i, "music-").replace(/-highspeed$/i, "");

  const result: Record<string, unknown> = {
    model: minimaxModel,
    output_format: "hex",
  };

  if (typeof body.prompt === "string") {
    result.prompt = body.prompt;
  }

  if (typeof body.lyrics === "string") {
    result.lyrics = body.lyrics;
  }

  const audioSetting: Record<string, unknown> = {};
  if (typeof body.sample_rate === "number") {
    audioSetting.sample_rate = body.sample_rate;
  } else {
    audioSetting.sample_rate = 44100;
  }
  if (typeof body.bitrate === "number") {
    audioSetting.bitrate = body.bitrate;
  } else {
    audioSetting.bitrate = 256000;
  }
  if (typeof body.audio_format === "string") {
    audioSetting.format = body.audio_format;
  } else {
    audioSetting.format = "mp3";
  }
  result.audio_setting = audioSetting;

  if (typeof body.lyrics_optimizer === "boolean") {
    result.lyrics_optimizer = body.lyrics_optimizer;
  }
  if (typeof body.is_instrumental === "boolean") {
    result.is_instrumental = body.is_instrumental;
  }

  return result;
}

async function forwardMinimaxMusicRequest(
  deps: AppDeps,
  route: BlazeMediaRoute,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requestStartedAt = Date.now();
  const rawToolCallId = request.headers["x-open-hax-tool-call-id"];
  const toolCallId = typeof rawToolCallId === "string" ? rawToolCallId : undefined;

  if (!isRecord(request.body)) {
    sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
    return;
  }

  const model = typeof request.body.model === "string" ? request.body.model : "";
  const apiKey = process.env.MINIMAX_API_KEY;

  if (!apiKey) {
    sendOpenAiError(reply, 503, "MINIMAX_API_KEY not configured", "invalid_request_error", "provider_not_configured");
    return;
  }

  deps.app.log.info({
    toolCallId,
    mode: route.label,
    localPath: route.localPath,
    model,
    provider: "minimax",
  }, "MiniMax music proxy request start");

  const minimaxBody = transformToMinimaxBody(request.body);
  const bodyText = JSON.stringify(minimaxBody);
  const upstreamUrl = joinUrl(minimaxBaseUrl(deps), "/v1/music_generation");
  const entryId = toolCallId ?? `${route.label}:${model}:${Date.now()}`;

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Content-Type", "application/json");
  if (toolCallId) {
    headers.set("X-Open-Hax-Tool-Call-Id", toolCallId);
  }

  deps.eventStore?.emitRequest(entryId, "minimax", "minimax-direct", model, minimaxBody, {
    upstreamMode: route.label,
    upstreamPath: "/v1/music_generation",
    upstreamUrl,
  });

  try {
    const upstreamResponse = await postBlazeMediaJson(
      upstreamUrl,
      headers,
      bodyText,
      deps.config.requestTimeoutMs,
    );
    const { text } = upstreamResponse;

    let logicalFailure: string | undefined;
    if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
      logicalFailure = parseMinimaxLogicalFailure(text);
      if (!logicalFailure && !hasValidMediaOutput(text, route.label)) {
        logicalFailure = `missing or empty ${route.label} output`;
      }
    }

    const status = logicalFailure ? 502 : upstreamResponse.status;
    const error = logicalFailure ? `MiniMax ${route.label} returned failed payload: ${logicalFailure}` : text;

    deps.app.log.info({
      toolCallId,
      mode: route.label,
      model,
      upstreamStatus: upstreamResponse.status,
      logicalFailure,
      elapsedMs: Date.now() - requestStartedAt,
      responseBytes: Buffer.byteLength(text),
    }, "MiniMax music proxy upstream attempt complete");

    if (logicalFailure) {
      deps.app.log.warn({
        toolCallId,
        mode: route.label,
        model,
        logicalFailure,
        elapsedMs: Date.now() - requestStartedAt,
      }, "MiniMax music proxy logical failure payload");
      deps.eventStore?.emitError(entryId, "minimax", "minimax-direct", model, status, {
        error,
        logicalFailure,
        responsePreview: text.slice(0, 500),
      }, { elapsedMs: Date.now() - requestStartedAt });

      sendOpenAiError(reply, status, `MiniMax music generation failed: ${logicalFailure}`, "upstream_error", "provider_failed");
      return;
    }

    let parsedPayload: Record<string, unknown> | null = null;
    try {
      parsedPayload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsedPayload = { raw: text };
    }

    let eventPayload: Record<string, unknown>;
    const dataField = isRecord(parsedPayload) ? parsedPayload.data : null;
    if (isRecord(dataField) && typeof dataField.audio === "string" && (dataField.audio as string).length > 0) {
      const rawAudio = dataField.audio as string;
      const looksHex = /^[0-9a-fA-F]+$/.test(rawAudio) && rawAudio.length % 2 === 0;
      const audioBytes = Buffer.from(rawAudio, looksHex ? "hex" : "base64");
      const fileName = `${entryId.replace(/[:/]/g, "-")}.mp3`;
      const filePath = `/app/data/blaze_generated/${fileName}`;
      try {
        await mkdir("/app/data/blaze_generated", { recursive: true });
        await writeFile(filePath, audioBytes);
        await writeFile(filePath.replace(/\.mp3$/i, ".json"), text, "utf8");
      } catch {
        // ignore write errors
      }
      eventPayload = {
        ...parsedPayload,
        data: {
          ...(isRecord(dataField) ? dataField : {}),
          audio: `[STRIPPED: ${audioBytes.length} bytes saved to ${filePath} (${looksHex ? "hex" : "base64"})]`,
        },
        _savedPath: filePath,
        _savedBytes: audioBytes.length,
      };
    } else {
      eventPayload = parsedPayload ?? {};
    }

    deps.eventStore?.emitResponse(entryId, "minimax", "minimax-direct", model, upstreamResponse.status, eventPayload, {
      elapsedMs: Date.now() - requestStartedAt,
      responseBytes: Buffer.byteLength(text),
    });

    copyUpstreamHeaders(reply, upstreamResponse.headers);
    reply.header("x-open-hax-upstream-provider", "minimax");
    reply.header("x-open-hax-upstream-mode", route.label);
    reply.header("x-open-hax-upstream-path", "/v1/music_generation");
    reply.code(upstreamResponse.status).send(text);
  } catch (error) {
    const errorMsg = toErrorMessage(error);
    deps.app.log.warn({
      toolCallId,
      mode: route.label,
      model,
      error: errorMsg,
      elapsedMs: Date.now() - requestStartedAt,
    }, "MiniMax music proxy upstream attempt error");
    deps.eventStore?.emitError(entryId, "minimax", "minimax-direct", model, 0, {
      error: errorMsg,
    }, { elapsedMs: Date.now() - requestStartedAt });
    sendOpenAiError(reply, 502, `MiniMax music generation failed: ${errorMsg}`, "upstream_error", "provider_failed");
  }
}

async function forwardMusicgenRequest(
  deps: AppDeps,
  route: BlazeMediaRoute,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requestStartedAt = Date.now();
  const rawToolCallId = request.headers["x-open-hax-tool-call-id"];
  const toolCallId = typeof rawToolCallId === "string" ? rawToolCallId : undefined;

  if (!isRecord(request.body)) {
    sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
    return;
  }

  const model = typeof request.body.model === "string" ? request.body.model : "";
  const prompt = typeof request.body.prompt === "string" ? request.body.prompt : "";

  if (!prompt) {
    sendOpenAiError(reply, 400, "Missing required field: prompt", "invalid_request_error", "missing_prompt");
    return;
  }

  deps.app.log.info({
    toolCallId,
    mode: route.label,
    localPath: route.localPath,
    model,
    provider: "musicgen",
  }, "MusicGen proxy request start");

  const duration = typeof request.body.duration === "number" ? request.body.duration : 30;
  const musicgenBody = { prompt, duration };
  const bodyText = JSON.stringify(musicgenBody);
  const upstreamUrl = joinUrl(musicgenBaseUrl(deps), "/generate");
  const entryId = toolCallId ?? `${route.label}:${model}:${Date.now()}`;

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  if (toolCallId) {
    headers.set("X-Open-Hax-Tool-Call-Id", toolCallId);
  }

  deps.eventStore?.emitRequest(entryId, "musicgen", "musicgen-local", model, musicgenBody, {
    upstreamMode: route.label,
    upstreamPath: "/generate",
    upstreamUrl,
  });

  try {
    const upstreamResponse = await postBlazeMediaJson(
      upstreamUrl,
      headers,
      bodyText,
      deps.config.requestTimeoutMs,
    );
    const { text } = upstreamResponse;

    let logicalFailure: string | undefined;
    if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
      if (!hasValidMediaOutput(text, route.label)) {
        logicalFailure = `missing or empty ${route.label} output`;
      }
    }

    const status = logicalFailure ? 502 : upstreamResponse.status;

    deps.app.log.info({
      toolCallId,
      mode: route.label,
      model,
      upstreamStatus: upstreamResponse.status,
      logicalFailure,
      elapsedMs: Date.now() - requestStartedAt,
      responseBytes: Buffer.byteLength(text),
    }, "MusicGen proxy upstream attempt complete");

    if (logicalFailure) {
      deps.app.log.warn({
        toolCallId,
        mode: route.label,
        model,
        logicalFailure,
        elapsedMs: Date.now() - requestStartedAt,
      }, "MusicGen proxy logical failure payload");
      deps.eventStore?.emitError(entryId, "musicgen", "musicgen-local", model, status, {
        error: logicalFailure,
        responsePreview: text.slice(0, 500),
      }, { elapsedMs: Date.now() - requestStartedAt });

      sendOpenAiError(reply, status, `MusicGen generation failed: ${logicalFailure}`, "upstream_error", "provider_failed");
      return;
    }

    // Transform MusicGen response to OpenAI-compatible format
    let parsedPayload: Record<string, unknown> | null = null;
    try {
      parsedPayload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsedPayload = { raw: text };
    }

    const dataField = isRecord(parsedPayload) ? parsedPayload.data : null;
    let openAiResponse: Record<string, unknown>;

    if (isRecord(dataField) && typeof dataField.audio === "string") {
      const rawAudio = dataField.audio as string;
      const audioBytes = Buffer.from(rawAudio, "base64");
      const fileName = `${entryId.replace(/[:/]/g, "-")}.wav`;
      const filePath = `/app/data/blaze_generated/${fileName}`;
      try {
        await mkdir("/app/data/blaze_generated", { recursive: true });
        await writeFile(filePath, audioBytes);
        await writeFile(filePath.replace(/\.wav$/i, ".json"), text, "utf8");
      } catch {
        // ignore write errors
      }

      openAiResponse = {
        status: "success",
        data: {
          audio: rawAudio,
          format: "wav",
          duration: dataField.duration ?? duration,
          sample_rate: dataField.sample_rate ?? 32000,
        },
        _savedPath: filePath,
        _savedBytes: audioBytes.length,
      };

      deps.eventStore?.emitResponse(entryId, "musicgen", "musicgen-local", model, upstreamResponse.status, {
        ...openAiResponse,
        data: {
          ...(isRecord(dataField) ? dataField : {}),
          audio: `[STRIPPED: ${audioBytes.length} bytes saved to ${filePath}]`,
        },
      }, {
        elapsedMs: Date.now() - requestStartedAt,
        responseBytes: Buffer.byteLength(text),
      });
    } else {
      openAiResponse = parsedPayload ?? {};
      deps.eventStore?.emitResponse(entryId, "musicgen", "musicgen-local", model, upstreamResponse.status, openAiResponse, {
        elapsedMs: Date.now() - requestStartedAt,
        responseBytes: Buffer.byteLength(text),
      });
    }

    copyUpstreamHeaders(reply, upstreamResponse.headers);
    reply.header("x-open-hax-upstream-provider", "musicgen");
    reply.header("x-open-hax-upstream-mode", route.label);
    reply.header("x-open-hax-upstream-path", "/generate");
    reply.code(200).send(JSON.stringify(openAiResponse));
  } catch (error) {
    const errorMsg = toErrorMessage(error);
    deps.app.log.warn({
      toolCallId,
      mode: route.label,
      model,
      error: errorMsg,
      elapsedMs: Date.now() - requestStartedAt,
    }, "MusicGen proxy upstream attempt error");
    deps.eventStore?.emitError(entryId, "musicgen", "musicgen-local", model, 0, {
      error: errorMsg,
    }, { elapsedMs: Date.now() - requestStartedAt });
    sendOpenAiError(reply, 502, `MusicGen generation failed: ${errorMsg}`, "upstream_error", "provider_failed");
  }
}

async function forwardBlazeMediaRequest(deps: AppDeps, route: BlazeMediaRoute, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const requestStartedAt = Date.now();
  const rawToolCallId = request.headers["x-open-hax-tool-call-id"];
  const toolCallId = typeof rawToolCallId === "string" ? rawToolCallId : undefined;
  if (!isRecord(request.body)) {
    sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
    return;
  }

  const model = typeof request.body.model === "string" ? request.body.model : "";
  if (model.length === 0) {
    sendOpenAiError(reply, 400, "Missing required field: model", "invalid_request_error", "missing_model");
    return;
  }

  const policyProviderId = mediaProviderFromPolicy(deps, route, model);
  if (route.label === "music" && policyProviderId === "minimax") {
    return forwardMinimaxMusicRequest(deps, route, request, reply);
  }
  if (route.label === "music" && policyProviderId === "musicgen") {
    return forwardMusicgenRequest(deps, route, request, reply);
  }

  deps.app.log.info({
    toolCallId,
    mode: route.label,
    localPath: route.localPath,
    upstreamPath: route.upstreamPath,
    model,
  }, "Blaze media proxy request start");

  let accounts;
  try {
    await deps.ensureFreshAccounts(policyProviderId);
    accounts = await deps.keyPool.getRequestOrder(policyProviderId);
  } catch (error) {
    sendOpenAiError(reply, 503, `No ${policyProviderId} account is available: ${toErrorMessage(error)}`, "invalid_request_error", "provider_not_configured");
    return;
  }

  if (accounts.length === 0) {
    sendOpenAiError(reply, 503, `No ready ${policyProviderId} account is available.`, "rate_limit_error", "provider_unavailable");
    return;
  }

  const upstreamUrl = joinUrl(blazeBaseUrl(deps), route.upstreamPath);
  const bodyText = JSON.stringify(request.body);
  let lastError = "";
  let lastStatus = 0;
  const entryId = toolCallId ?? `${route.label}:${model}:${Date.now()}`;

  for (const account of accounts) {
    const release = deps.keyPool.markInFlight(account);
    try {
      deps.app.log.info({
        toolCallId,
        mode: route.label,
        model,
        accountId: account.accountId,
        upstreamPath: route.upstreamPath,
      }, "Blaze media proxy upstream attempt start");
      deps.eventStore?.emitRequest(entryId, policyProviderId, account.accountId, model, request.body as Record<string, unknown>, {
        upstreamMode: route.label,
        upstreamPath: route.upstreamPath,
        upstreamUrl,
      });
      const upstreamResponse = await postBlazeMediaJson(
        upstreamUrl,
        buildUpstreamHeadersForCredential(request.headers, account),
        bodyText,
        deps.config.requestTimeoutMs,
      );
      const { text } = upstreamResponse;
      let logicalFailure: string | undefined;
      if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
        logicalFailure = parseBlazeLogicalFailure(text);
        if (!logicalFailure && !hasValidMediaOutput(text, route.label)) {
          logicalFailure = `missing or empty ${route.label} output`;
        }
      }

      if (upstreamResponse.status === 429) {
        deps.keyPool.markRateLimited(account);
      }

      lastStatus = logicalFailure ? 502 : upstreamResponse.status;
      lastError = logicalFailure ? `BlazeAPI ${route.label} returned failed payload: ${logicalFailure}` : text;

      deps.app.log.info({
        toolCallId,
        mode: route.label,
        model,
        accountId: account.accountId,
        upstreamStatus: upstreamResponse.status,
        logicalFailure,
        elapsedMs: Date.now() - requestStartedAt,
        responseBytes: Buffer.byteLength(text),
      }, "Blaze media proxy upstream attempt complete");

      if (logicalFailure) {
        deps.app.log.warn({
          toolCallId,
          mode: route.label,
          model,
          accountId: account.accountId,
          logicalFailure,
          elapsedMs: Date.now() - requestStartedAt,
        }, "Blaze media proxy logical failure payload");
        deps.eventStore?.emitError(entryId, policyProviderId, account.accountId, model, lastStatus, {
          error: lastError,
          logicalFailure,
          responsePreview: text.slice(0, 500),
        }, { elapsedMs: Date.now() - requestStartedAt });
      } else {
        let parsedPayload: Record<string, unknown> | null = null;
        try {
          parsedPayload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsedPayload = { raw: text };
        }

        // Strip base64 audio data from event payload, save to disk, emit metadata only
        let eventPayload: Record<string, unknown>;
        const dataField = isRecord(parsedPayload) ? parsedPayload.data : null;
        if (isRecord(dataField) && typeof dataField.audio === "string" && (dataField.audio as string).length > 0) {
          const rawAudio = dataField.audio as string;
          // Blaze sometimes returns audio as hex (e.g. starts with 494433 == "ID3"), not base64.
          // Heuristic: if it's all hex chars and even-length, treat as hex; otherwise treat as base64.
          const looksHex = /^[0-9a-fA-F]+$/.test(rawAudio) && rawAudio.length % 2 === 0;
          const audioBytes = Buffer.from(rawAudio, looksHex ? "hex" : "base64");
          const fileName = `${entryId.replace(/[:/]/g, "-")}.mp3`;
          const filePath = `/app/data/blaze_generated/${fileName}`;
          try {
            await mkdir("/app/data/blaze_generated", { recursive: true });
            await writeFile(filePath, audioBytes);
            // Keep the full upstream JSON payload for forensic/debug recovery.
            await writeFile(filePath.replace(/\.mp3$/i, ".json"), text, "utf8");
          } catch {
            // ignore write errors
          }
          eventPayload = {
            ...parsedPayload,
            data: {
              ...(isRecord(dataField) ? dataField : {}),
              audio: `[STRIPPED: ${audioBytes.length} bytes saved to ${filePath} (${looksHex ? "hex" : "base64"})]`,
            },
            _savedPath: filePath,
            _savedBytes: audioBytes.length,
          };
        } else {
          eventPayload = parsedPayload ?? {};
        }

        deps.eventStore?.emitResponse(entryId, policyProviderId, account.accountId, model, upstreamResponse.status, eventPayload, {
          elapsedMs: Date.now() - requestStartedAt,
          responseBytes: Buffer.byteLength(text),
        });
      }

      if (!logicalFailure && (upstreamResponse.status < 400 || accounts.length === 1)) {
        copyUpstreamHeaders(reply, upstreamResponse.headers);
        reply.header("x-open-hax-upstream-provider", "blaze");
        reply.header("x-open-hax-upstream-mode", route.label);
        reply.header("x-open-hax-upstream-path", route.upstreamPath);
        reply.code(upstreamResponse.status).send(text);
        return;
      }
    } catch (error) {
      lastStatus = 0;
      lastError = toErrorMessage(error);
      deps.app.log.warn({
        toolCallId,
        mode: route.label,
        model,
        accountId: account.accountId,
        error: lastError,
        elapsedMs: Date.now() - requestStartedAt,
      }, "Blaze media proxy upstream attempt error");
      deps.eventStore?.emitError(entryId, "blaze", account.accountId, model, 0, {
        error: lastError,
      }, { elapsedMs: Date.now() - requestStartedAt });
    } finally {
      release();
    }
  }

  deps.app.log.error({
    toolCallId,
    mode: route.label,
    model,
    lastStatus,
    lastError,
    elapsedMs: Date.now() - requestStartedAt,
  }, "Blaze media proxy exhausted accounts");
  sendOpenAiError(reply, lastStatus > 0 ? lastStatus : 502, `BlazeAPI ${route.label} generation failed: ${lastError}`, "upstream_error", "provider_failed");
}

export function registerMediaGenerationRoutes(deps: AppDeps, app: FastifyInstance): void {
  for (const route of BLAZE_MEDIA_ROUTES) {
    app.post<{ Body: Record<string, unknown> }>(route.localPath, async (request, reply) => {
      await forwardBlazeMediaRequest(deps, route, request, reply);
    });
  }
}
