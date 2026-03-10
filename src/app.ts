import Fastify, { type FastifyInstance } from "fastify";

import { DEFAULT_MODELS, type ProxyConfig } from "./lib/config.js";
import { KeyPool, type ProviderCredential } from "./lib/key-pool.js";
import { loadModels, toOpenAiModel } from "./lib/models.js";
import { buildForwardHeaders } from "./lib/proxy.js";
import {
  buildLargestModelAliases,
  buildOllamaCatalogRoutes,
  buildProviderRoutes,
  dedupeModelIds,
  minMsUntilAnyProviderKeyReady,
  parseModelIdsFromCatalogPayload,
  resolveProviderRoutesForModel,
  type ProviderRoute,
  type ResolvedModelCatalog,
} from "./lib/provider-routing.js";
import {
  executeLocalStrategy,
  executeProviderFallback,
  inspectProviderAvailability,
  selectProviderStrategy,
} from "./lib/provider-strategy.js";
import {
  fetchWithResponseTimeout,
  hasBearerToken,
  isRecord,
  sendOpenAiError,
  toErrorMessage,
} from "./lib/provider-utils.js";
import { RequestLogStore } from "./lib/request-log-store.js";
import { PromptAffinityStore } from "./lib/prompt-affinity-store.js";
import { registerUiRoutes } from "./lib/ui-routes.js";
import {
  ensureNativeOllamaChatContextFits,
  ensureNativeOllamaEmbedContextFits,
  ensureOllamaContextFits,
} from "./lib/ollama-context.js";
import {
  chatCompletionToNativeChat,
  chatCompletionToNativeGenerate,
  modelIdsToNativeTags,
  nativeChatToOpenAiRequest,
  nativeEmbedResponseToOpenAiEmbeddings,
  nativeEmbedToOpenAiRequest,
  nativeGenerateToChatRequest,
  openAiEmbeddingsToNativeEmbed,
  openAiEmbeddingsToNativeEmbeddings,
} from "./lib/ollama-native.js";
import { applyNativeOllamaAuth } from "./lib/native-auth.js";
import { requestHasExplicitNumCtx } from "./lib/ollama-compat.js";

interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages?: unknown;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}

const PROXY_AUTH_COOKIE_NAME = "open_hax_proxy_auth_token";

function readCookieToken(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) {
      continue;
    }

    const rawValue = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}

function extractPromptCacheKey(body: Record<string, unknown>): string | undefined {
  const raw = typeof body.prompt_cache_key === "string"
    ? body.prompt_cache_key
    : typeof body.promptCacheKey === "string"
      ? body.promptCacheKey
      : undefined;
  const normalized = raw?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

const SUPPORTED_V1_ENDPOINTS = [
  "POST /v1/chat/completions",
  "POST /v1/embeddings",
  "GET /v1/models",
  "GET /v1/models/:model"
] as const;

const SUPPORTED_NATIVE_OLLAMA_ENDPOINTS = [
  "POST /api/chat",
  "POST /api/generate",
  "POST /api/embed",
  "POST /api/embeddings",
  "GET /api/tags"
] as const;

export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 300 * 1024 * 1024
  });

  const keyPool = new KeyPool({
    keysFilePath: config.keysFilePath,
    reloadIntervalMs: config.keyReloadMs,
    defaultCooldownMs: config.keyCooldownMs,
    defaultProviderId: config.upstreamProviderId
  });
  try {
    await keyPool.warmup();
  } catch (error) {
    app.log.warn({ error: toErrorMessage(error) }, "failed to warm up provider accounts; non-keyed routes may still work");
  }
  const requestLogStore = new RequestLogStore(config.requestLogsFilePath, 5000);
  await requestLogStore.warmup();
  const promptAffinityStore = new PromptAffinityStore(config.promptAffinityFilePath);
  await promptAffinityStore.warmup();

  const ollamaCatalogRoutes = buildOllamaCatalogRoutes(config);
  const modelCatalogTtlMs = 30_000;
  let cachedModelCatalog: { readonly expiresAt: number; readonly value: ResolvedModelCatalog } | null = null;

  async function fetchProviderModelCatalog(route: ProviderRoute): Promise<string[]> {
    let accounts: ProviderCredential[];
    try {
      accounts = await keyPool.getRequestOrder(route.providerId);
    } catch {
      return [];
    }

    if (accounts.length === 0) {
      return [];
    }

    const candidatePaths = ["/v1/models", "/api/tags"];

    for (const account of accounts) {
      for (const candidatePath of candidatePaths) {
        const url = joinUrl(route.baseUrl, candidatePath);
        let response: Response;
        try {
            response = await fetchWithResponseTimeout(url, {
              method: "GET",
              headers: {
                authorization: `Bearer ${account.token}`,
                accept: "application/json"
              }
            }, Math.min(config.requestTimeoutMs, 45_000));
        } catch {
          continue;
        }

        if (!response.ok) {
          try {
            await response.arrayBuffer();
          } catch {
            // ignore body read failures while probing model catalogs
          }
          continue;
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          continue;
        }

        const modelIds = parseModelIdsFromCatalogPayload(payload);
        if (modelIds.length > 0) {
          return modelIds;
        }
      }
    }

    return [];
  }

  async function getResolvedModelCatalog(forceRefresh = false): Promise<ResolvedModelCatalog> {
    const now = Date.now();
    if (!forceRefresh && cachedModelCatalog && cachedModelCatalog.expiresAt > now) {
      return cachedModelCatalog.value;
    }

    const configuredModels = await loadModels(config.modelsFilePath, DEFAULT_MODELS);
    const dynamicOllamaModels: string[] = [];

    for (const route of ollamaCatalogRoutes) {
      const providerModels = await fetchProviderModelCatalog(route);
      if (providerModels.length > 0) {
        dynamicOllamaModels.push(...providerModels);
      }
    }

    const aliasTargets = buildLargestModelAliases(dynamicOllamaModels);
    const aliasIds = Object.keys(aliasTargets);

    const resolvedCatalog: ResolvedModelCatalog = {
      modelIds: dedupeModelIds([
        ...configuredModels,
        ...dynamicOllamaModels,
        ...aliasIds
      ]),
      aliasTargets,
      dynamicOllamaModelIds: dedupeModelIds(dynamicOllamaModels)
    };

    cachedModelCatalog = {
      expiresAt: now + modelCatalogTtlMs,
      value: resolvedCatalog
    };

    return resolvedCatalog;
  }

  if (config.allowUnauthenticated) {
    app.log.warn("proxy auth disabled via PROXY_ALLOW_UNAUTHENTICATED=true");
  }

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    reply.header("Access-Control-Allow-Origin", origin ?? "*");
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With, Cookie");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (config.proxyAuthToken) {
      const rawPath = (request.raw.url ?? request.url).split("?", 1)[0] ?? request.url;
      const allowUnauthenticatedRoute = rawPath === "/api/ui/credentials/openai/oauth/browser/callback";

      if (allowUnauthenticatedRoute) {
        return;
      }

      const authorization = request.headers.authorization;
      const cookieToken = readCookieToken(request.headers.cookie, PROXY_AUTH_COOKIE_NAME);
      const ok = hasBearerToken(authorization, config.proxyAuthToken) || cookieToken === config.proxyAuthToken;
      if (!ok) {
        sendOpenAiError(reply, 401, "Unauthorized", "invalid_request_error", "unauthorized");
      }
    }
  });

  app.options("/", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/health", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/chat/completions", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/embeddings", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/models", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/v1/models/:model", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/chat", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/generate", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/embed", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/embeddings", async (_request, reply) => {
    reply.code(204).send();
  });

  app.options("/api/tags", async (_request, reply) => {
    reply.code(204).send();
  });

  app.get("/health", async () => {
    let keyPoolStatus: unknown;
    let keyPoolProviders: unknown;
    try {
      const status = await keyPool.getStatus(config.upstreamProviderId);
      keyPoolStatus = {
        providerId: status.providerId,
        authType: status.authType,
        totalKeys: status.totalAccounts,
        availableKeys: status.availableAccounts,
        cooldownKeys: status.cooldownAccounts,
        nextReadyInMs: status.nextReadyInMs
      };

      const allStatuses = await keyPool.getAllStatuses();
      keyPoolProviders = Object.fromEntries(
        Object.entries(allStatuses).map(([providerId, providerStatus]) => [
          providerId,
          {
            providerId: providerStatus.providerId,
            authType: providerStatus.authType,
            totalAccounts: providerStatus.totalAccounts,
            availableAccounts: providerStatus.availableAccounts,
            cooldownAccounts: providerStatus.cooldownAccounts,
            nextReadyInMs: providerStatus.nextReadyInMs
          }
        ])
      );
    } catch (error) {
      keyPoolStatus = { error: toErrorMessage(error) };
      keyPoolProviders = {};
    }

    return {
      ok: true,
      service: "open-hax-openai-proxy",
      authMode: config.proxyAuthToken ? "token" : "unauthenticated",
      keyPool: keyPoolStatus,
      keyPoolProviders
    };
  });

  app.get("/v1/models", async (_request, reply) => {
    const catalog = await getResolvedModelCatalog();
    reply.send({
      object: "list",
      data: catalog.modelIds.map(toOpenAiModel)
    });
  });

  app.get<{ Params: { model: string } }>("/v1/models/:model", async (request, reply) => {
    const catalog = await getResolvedModelCatalog();
    const model = catalog.modelIds.find((entry) => entry === request.params.model);
    if (!model) {
      sendOpenAiError(reply, 404, `Model not found: ${request.params.model}`, "invalid_request_error", "model_not_found");
      return;
    }

    reply.send(toOpenAiModel(model));
  });

  app.get("/api/tags", async (_request, reply) => {
    const upstreamResponse = await fetchWithResponseTimeout(joinUrl(config.ollamaBaseUrl, "/api/tags"), {
      method: "GET",
      headers: { accept: "application/json" },
    }, Math.min(config.requestTimeoutMs, 30_000));

    if (!upstreamResponse.ok) {
      reply.code(upstreamResponse.status).send(await upstreamResponse.text());
      return;
    }

    reply.send(await upstreamResponse.json());
  });

  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const requestedModelInput = typeof request.body.model === "string" ? request.body.model : "";
    let routingModelInput = requestedModelInput;
    let resolvedModelCatalog: ResolvedModelCatalog | null = null;
    try {
      const catalog = await getResolvedModelCatalog();
      resolvedModelCatalog = catalog;
      const aliasTarget = catalog.aliasTargets[requestedModelInput];
      if (typeof aliasTarget === "string" && aliasTarget.length > 0) {
        routingModelInput = aliasTarget;
        reply.header("x-open-hax-model-alias", `${requestedModelInput}->${aliasTarget}`);
      }
    } catch (error) {
      request.log.warn({ error: toErrorMessage(error) }, "failed to resolve dynamic model aliases; using requested model as-is");
    }

    const { strategy, context } = selectProviderStrategy(config, request.headers, request.body, requestedModelInput, routingModelInput);
    reply.header("x-open-hax-upstream-mode", strategy.mode);

    let payload: ReturnType<typeof strategy.buildPayload>;
    try {
      payload = strategy.buildPayload(context);
    } catch (error) {
      sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
      return;
    }

    if (strategy.mode === "ollama_chat" || strategy.mode === "local_ollama_chat") {
      const candidateRequestBody = payload.upstreamPayload;
      if (isRecord(candidateRequestBody) && !requestHasExplicitNumCtx(request.body)) {
        const budget = await ensureOllamaContextFits(config.ollamaBaseUrl, candidateRequestBody, Math.min(config.requestTimeoutMs, 30_000));
        if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
          sendOpenAiError(
            reply,
            400,
            `Request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, requested output tokens: ${budget.requestedOutputTokens}, required total: ${budget.requiredContextTokens}, available: ${budget.availableContextTokens}. Reduce input size or request a larger context/model.`,
            "invalid_request_error",
            "ollama_context_overflow"
          );
          return;
        }
      }
    }

    if (strategy.isLocal) {
      await executeLocalStrategy(strategy, reply, requestLogStore, context, payload);
      return;
    }

    let providerRoutes = buildProviderRoutes(
      config,
      context.openAiPrefixed,
      !context.openAiPrefixed && strategy.mode === "responses"
    );
    if (!context.openAiPrefixed && resolvedModelCatalog) {
      providerRoutes = resolveProviderRoutesForModel(providerRoutes, context.routedModel, resolvedModelCatalog);
    }

    const availability = await inspectProviderAvailability(keyPool, providerRoutes);
    const promptCacheKey = extractPromptCacheKey(request.body);
    const execution = await executeProviderFallback(
      strategy,
      reply,
      requestLogStore,
      promptAffinityStore,
      keyPool,
      providerRoutes,
      context,
      payload,
      promptCacheKey,
    );

    if (execution.handled) {
      return;
    }

    if (execution.candidateCount === 0) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      if (!availability.sawConfiguredProvider) {
        sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration", "server_error", "keys_unavailable");
        return;
      }

      sendOpenAiError(
        reply,
        429,
        "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
        "rate_limit_error",
        "all_keys_rate_limited"
      );
      return;
    }

    const { summary } = execution;

    if (summary.sawUpstreamInvalidRequest) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream invalid-request responses");
      sendOpenAiError(
        reply,
        400,
        "No upstream account accepted the request payload. Check model availability and request parameters.",
        "invalid_request_error",
        "upstream_rejected_request"
      );
      return;
    }

    if (summary.sawRateLimit) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream rate limits");
      sendOpenAiError(
        reply,
        429,
        "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
        "rate_limit_error",
        "no_available_key"
      );
      return;
    }

    if (summary.sawUpstreamServerError) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream server errors");
      sendOpenAiError(
        reply,
        502,
        "Upstream returned transient server errors across all available accounts.",
        "server_error",
        "upstream_server_error"
      );
      return;
    }

    if (summary.sawModelNotFound && !summary.sawRequestError) {
      app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to model-not-found responses");
      sendOpenAiError(
        reply,
        404,
        `Model not found across available upstream providers: ${context.routedModel}`,
        "invalid_request_error",
        "model_not_found"
      );
      return;
    }

    const message = summary.sawRequestError
      ? "All upstream attempts failed due to network/transport errors."
      : "Upstream rejected the request with no successful fallback.";

    app.log.error({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode, sawRequestError: summary.sawRequestError }, "all upstream attempts exhausted");
    sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
  });

  app.post<{ Body: Record<string, unknown> }>("/v1/embeddings", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const model = typeof request.body.model === "string" ? request.body.model : "";
    const routingState = selectProviderStrategy(config, request.headers, {
      model,
      messages: [{ role: "user", content: "embed" }],
      stream: false,
    }, model, model).context;

    const routedModel = routingState.routedModel;
    const upstreamUrl = joinUrl(config.ollamaBaseUrl, "/api/embed");
    const embedBody = nativeEmbedToOpenAiRequest({
      ...request.body,
      model: routedModel,
    });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
        method: "POST",
        headers: buildForwardHeaders(request.headers),
        body: JSON.stringify({
          model: embedBody.model,
          input: embedBody.input,
        }),
      }, config.requestTimeoutMs);
    } catch (error) {
      sendOpenAiError(
        reply,
        502,
        `Embedding upstream request failed: ${toErrorMessage(error)}`,
        "server_error",
        "embedding_upstream_unavailable"
      );
      return;
    }

    if (!upstreamResponse.ok) {
      sendOpenAiError(
        reply,
        upstreamResponse.status >= 500 ? 502 : upstreamResponse.status,
        `Embedding upstream rejected the request: ${await upstreamResponse.text()}`,
        upstreamResponse.status >= 500 ? "server_error" : "invalid_request_error",
        "embedding_upstream_error"
      );
      return;
    }

    const upstreamJson = await upstreamResponse.json() as Record<string, unknown>;
    reply.send(nativeEmbedResponseToOpenAiEmbeddings(upstreamJson, embedBody.model));
  });

  app.post<{ Body: Record<string, unknown> }>("/api/chat", async (request, reply) => {
    const body = isRecord(request.body) ? { ...request.body } : {};
    const options = isRecord(body["options"]) ? { ...body["options"] } : {};
    const hasExplicitNumCtx = typeof options["num_ctx"] !== "undefined" || typeof body["num_ctx"] !== "undefined";

    if (!hasExplicitNumCtx) {
      const budget = await ensureNativeOllamaChatContextFits(config.ollamaBaseUrl, body, Math.min(config.requestTimeoutMs, 30_000));
      if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
        reply.code(400).send({
          error: `Request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, requested output tokens: ${budget.requestedOutputTokens}, required total: ${budget.requiredContextTokens}, available: ${budget.availableContextTokens}. Reduce input size or use a model with a larger context window.`,
        });
        return;
      }

      if (budget) {
        options["num_ctx"] = budget.recommendedNumCtx;
        body["options"] = options;
      }
    }

    const upstreamResponse = await fetchWithResponseTimeout(joinUrl(config.ollamaBaseUrl, "/api/chat"), {
      method: "POST",
      headers: buildForwardHeaders(request.headers),
      body: JSON.stringify(body),
    }, config.requestTimeoutMs);

    reply.code(upstreamResponse.status);
    reply.header("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
    reply.send(await upstreamResponse.text());
  });

  app.post<{ Body: Record<string, unknown> }>("/api/generate", async (request, reply) => {
    const originalBody = isRecord(request.body) ? request.body : {};
    const syntheticChatBody = nativeGenerateToChatRequest(originalBody);
    const nativeBody = {
      ...originalBody,
      system: typeof originalBody["system"] === "string" ? originalBody["system"] : undefined,
      prompt: typeof originalBody["prompt"] === "string" ? originalBody["prompt"] : "",
      options: isRecord(originalBody["options"]) ? { ...originalBody["options"] } : {},
    } as Record<string, unknown>;

    const hasExplicitNumCtx = isRecord(nativeBody["options"]) && typeof nativeBody["options"]["num_ctx"] !== "undefined"
      || typeof nativeBody["num_ctx"] !== "undefined";

    if (!hasExplicitNumCtx) {
      const budget = await ensureNativeOllamaChatContextFits(config.ollamaBaseUrl, {
        model: nativeBody["model"],
        messages: syntheticChatBody["messages"],
        tools: syntheticChatBody["tools"],
        options: nativeBody["options"],
      }, Math.min(config.requestTimeoutMs, 30_000));
      if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
        reply.code(400).send({
          error: `Request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, requested output tokens: ${budget.requestedOutputTokens}, required total: ${budget.requiredContextTokens}, available: ${budget.availableContextTokens}. Reduce input size or use a model with a larger context window.`,
        });
        return;
      }

      if (budget && isRecord(nativeBody["options"])) {
        nativeBody["options"] = {
          ...nativeBody["options"],
          num_ctx: budget.recommendedNumCtx,
        };
      }
    }

    const upstreamResponse = await fetchWithResponseTimeout(joinUrl(config.ollamaBaseUrl, "/api/generate"), {
      method: "POST",
      headers: buildForwardHeaders(request.headers),
      body: JSON.stringify(nativeBody),
    }, config.requestTimeoutMs);

    reply.code(upstreamResponse.status);
    reply.header("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
    reply.send(await upstreamResponse.text());
  });

  app.post<{ Body: Record<string, unknown> }>("/api/embed", async (request, reply) => {
    const body = isRecord(request.body) ? { ...request.body } : {};
    const options = isRecord(body["options"]) ? { ...body["options"] } : {};
    const hasExplicitNumCtx = typeof options["num_ctx"] !== "undefined" || typeof body["num_ctx"] !== "undefined";

    if (!hasExplicitNumCtx) {
      const budget = await ensureNativeOllamaEmbedContextFits(config.ollamaBaseUrl, body, Math.min(config.requestTimeoutMs, 30_000));
      if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
        reply.code(400).send({
          error: `Embedding request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, available: ${budget.availableContextTokens}. Reduce input size or use a model with a larger context window.`,
        });
        return;
      }

      if (budget) {
        options["num_ctx"] = budget.recommendedNumCtx;
        body["options"] = options;
      }
    }

    const upstreamResponse = await fetchWithResponseTimeout(joinUrl(config.ollamaBaseUrl, "/api/embed"), {
      method: "POST",
      headers: buildForwardHeaders(request.headers),
      body: JSON.stringify(body),
    }, config.requestTimeoutMs);

    reply.code(upstreamResponse.status);
    reply.header("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
    reply.send(await upstreamResponse.text());
  });

  app.post<{ Body: Record<string, unknown> }>("/api/embeddings", async (request, reply) => {
    const normalized = nativeEmbedToOpenAiRequest(isRecord(request.body) ? request.body : {});
    const body = {
      ...(isRecord(request.body) ? request.body : {}),
      model: normalized.model,
      input: normalized.input,
    } as Record<string, unknown>;
    const options = isRecord(body["options"]) ? { ...body["options"] } : {};
    const hasExplicitNumCtx = typeof options["num_ctx"] !== "undefined" || typeof body["num_ctx"] !== "undefined";

    if (!hasExplicitNumCtx) {
      const budget = await ensureNativeOllamaEmbedContextFits(config.ollamaBaseUrl, body, Math.min(config.requestTimeoutMs, 30_000));
      if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
        reply.code(400).send({
          error: `Embedding request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, available: ${budget.availableContextTokens}. Reduce input size or use a model with a larger context window.`,
        });
        return;
      }

      if (budget) {
        options["num_ctx"] = budget.recommendedNumCtx;
        body["options"] = options;
      }
    }

    const upstreamResponse = await fetchWithResponseTimeout(joinUrl(config.ollamaBaseUrl, "/api/embeddings"), {
      method: "POST",
      headers: buildForwardHeaders(request.headers),
      body: JSON.stringify(body),
    }, config.requestTimeoutMs);

    reply.code(upstreamResponse.status);
    reply.header("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
    reply.send(await upstreamResponse.text());
  });

  await registerUiRoutes(app, {
    config,
    keyPool,
    requestLogStore
  });

  app.addHook("onClose", async () => {
    await requestLogStore.close();
  });

  app.setNotFoundHandler(async (request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    const path = rawUrl.split("?", 1)[0] ?? rawUrl;

    if (path.startsWith("/v1/")) {
      sendOpenAiError(
        reply,
        404,
        `Unsupported endpoint: ${request.method} ${path}. Supported endpoints: ${SUPPORTED_V1_ENDPOINTS.join(", ")}`,
        "invalid_request_error",
        "unsupported_endpoint"
      );
      return;
    }

    if (path.startsWith("/api/")) {
      reply.code(404).send({
        error: `Unsupported endpoint: ${request.method} ${path}. Supported native endpoints: ${SUPPORTED_NATIVE_OLLAMA_ENDPOINTS.join(", ")}`
      });
      return;
    }

    reply.code(404).send({ ok: false, error: "Not Found" });
  });

  return app;
}
