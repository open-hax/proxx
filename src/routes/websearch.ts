import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import type { WebSearchToolRequest } from "../lib/request-utils.js";
import { extractResponseTextAndUrlCitations, extractMarkdownLinks } from "../lib/response-utils.js";
import { parseJsonIfPossible } from "../lib/request-utils.js";

export function registerWebsearchRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: WebSearchToolRequest }>("/api/tools/websearch", async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    const body = request.body as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length === 0) {
      reply.code(400).send({ error: "query_required" });
      return;
    }

    const rawNumResults = typeof body.numResults === "number" ? body.numResults : Number.NaN;
    const numResults = Number.isFinite(rawNumResults)
      ? Math.max(1, Math.min(20, Math.trunc(rawNumResults)))
      : 8;

    const searchContextSize = typeof body.searchContextSize === "string"
      ? body.searchContextSize.trim().toLowerCase()
      : "";
    const contextSize = (searchContextSize === "low" || searchContextSize === "medium" || searchContextSize === "high")
      ? searchContextSize
      : undefined;

    const rawAllowedDomains = body.allowedDomains;
    const allowedDomains = Array.isArray(rawAllowedDomains)
      ? (rawAllowedDomains as unknown[])
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 50)
      : [];

    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";

    const fallbackModel = process.env.OPEN_HAX_WEBSEARCH_FALLBACK_MODEL?.trim() || "gpt-5.2";
    const candidateModels = [requestedModel, fallbackModel]
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const uniqueModels: string[] = [];
    for (const entry of candidateModels) {
      if (!uniqueModels.includes(entry)) {
        uniqueModels.push(entry);
      }
    }

    const upstreamProxyAuth = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : (deps.config.proxyAuthToken ? `Bearer ${deps.config.proxyAuthToken}` : undefined);

    const authHeaders: Record<string, string> = {
      "content-type": "application/json",
      ...(upstreamProxyAuth ? { authorization: upstreamProxyAuth } : {}),
    };

    const parseSseJsonPayload = (raw: string): unknown => {
      // Minimal SSE parser: pick the last `data:` JSON object.
      // Tests provide bodies like: `data: { ... }\n\n` or `event: ...\ndata: { ... }\n\n`.
      const lines = raw.split(/\r?\n/u);
      let lastJson: unknown = undefined;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payloadText = trimmed.slice("data:".length).trim();
        if (payloadText.length === 0 || payloadText === "[DONE]") {
          continue;
        }
        try {
          lastJson = JSON.parse(payloadText);
        } catch {
          // ignore
        }
      }

      return lastJson;
    };

    const baseTool: Record<string, unknown> = {
      type: "web_search",
      external_web_access: true,
      ...(contextSize ? { search_context_size: contextSize } : {}),
    };

    const buildUserText = (withDomainsHint: boolean) => {
      const domainHint = withDomainsHint && allowedDomains.length > 0
        ? `\n\nRestrict sources to these domains when possible:\n${allowedDomains.map((d) => `- ${d}`).join("\n")}`
        : "";
      return [
        `Query: ${query}`,
        `Return up to ${numResults} results as a Markdown list. Each bullet must include a Markdown link and a 1-2 sentence snippet.`,
        `Do not fabricate URLs; every link must be backed by web_search citations.`,
        domainHint,
      ].join("\n");
    };

    const attemptPayload = async (model: string, includeDomainsInTool: boolean) => {
      const tool = includeDomainsInTool && allowedDomains.length > 0
        ? { ...baseTool, allowed_domains: allowedDomains }
        : baseTool;

      return deps.app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: authHeaders,
        payload: {
          model,
          instructions: "You are a web search helper. Use the web_search tool to gather sources and answer with citations.",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: buildUserText(!includeDomainsInTool) }],
            },
          ],
          tools: [tool],
          tool_choice: { type: "web_search" },
          store: false,
          stream: false,
        },
      });
    };

    const resolveInjectedJson = (injected: { readonly body: string; readonly headers: Record<string, unknown> }): unknown => {
      const contentType = typeof injected.headers["content-type"] === "string" ? String(injected.headers["content-type"]) : "";
      const raw = injected.body;
      if (contentType.toLowerCase().includes("text/event-stream") || raw.trim().startsWith("data:")) {
        const parsed = parseSseJsonPayload(raw);
        if (parsed && typeof parsed === "object" && (parsed as any).response && typeof (parsed as any).response === "object") {
          return (parsed as any).response;
        }
        return parsed;
      }
      return parseJsonIfPossible(raw);
    };

    let lastErrorPayload: unknown;

    for (const model of uniqueModels) {
      const injected = await attemptPayload(model, true);
      if (injected.statusCode !== 200) {
        lastErrorPayload = parseJsonIfPossible(injected.body) ?? injected.body;
        continue;
      }

      const upstreamProvider = injected.headers["x-open-hax-upstream-provider"];
      const upstreamMode = injected.headers["x-open-hax-upstream-mode"];
      if (typeof upstreamProvider === "string") {
        reply.header("x-open-hax-upstream-provider", upstreamProvider);
      }
      if (typeof upstreamMode === "string") {
        reply.header("x-open-hax-upstream-mode", upstreamMode);
      }

      const json = resolveInjectedJson(injected);
      const extracted = extractResponseTextAndUrlCitations(json);

      const output = extracted.text;
      const sources = extracted.citations.length > 0
        ? extracted.citations
        : extractMarkdownLinks(output);

      reply.send({
        query,
        model: requestedModel || model,
        backend: "openai",
        output,
        sources: sources.slice(0, numResults),
        responseId: extracted.responseId,
      });
      return;
    }

    const exaUrl = process.env.OPEN_HAX_EXA_MCP_URL?.trim() || "https://mcp.exa.ai/sse";
    try {
      const exaResponse = await fetch(exaUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "websearch",
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query,
              num_results: numResults,
              ...(allowedDomains.length > 0 ? { allowed_domains: allowedDomains } : {}),
            },
          },
        }),
      });

      if (exaResponse.ok) {
        const raw = await exaResponse.text();
        const parsed = parseSseJsonPayload(raw);
        const content = (parsed as any)?.result?.content;
        const textBlocks = Array.isArray(content)
          ? content
            .map((entry) => (entry && typeof entry === "object") ? (entry as any).text : undefined)
            .filter((entry): entry is string => typeof entry === "string")
          : [];

        const output = textBlocks.join("\n");
        const sources = extractMarkdownLinks(output);

        reply.send({
          query,
          model: requestedModel || fallbackModel,
          backend: "exa",
          output,
          sources: sources.slice(0, numResults),
        });
        return;
      }
    } catch {
      // ignore and fall through
    }

    reply.code(502).send({
      error: "websearch_failed",
      details: lastErrorPayload,
    });
  });
}
