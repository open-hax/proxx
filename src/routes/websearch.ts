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

    const authHeaders: Record<string, string> = {
      "content-type": "application/json",
      ...(deps.config.proxyAuthToken ? { authorization: `Bearer ${deps.config.proxyAuthToken}` } : {}),
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
          tool_choice: "auto",
          store: false,
          stream: false,
        },
      });
    };

    let lastErrorPayload: unknown;

    for (const model of uniqueModels) {
      // Try the most structured tool payload first; fall back to hint-only if upstream rejects unknown fields.
      for (const includeDomainsInTool of [true, false]) {
        const injected = await attemptPayload(model, includeDomainsInTool);
        if (injected.statusCode !== 200) {
          lastErrorPayload = parseJsonIfPossible(injected.body) ?? injected.body;
          continue;
        }

        const json = parseJsonIfPossible(injected.body);
        const extracted = extractResponseTextAndUrlCitations(json);

        const output = extracted.text;
        const sources = extracted.citations.length > 0
          ? extracted.citations
          : extractMarkdownLinks(output);

        reply.send({
          output,
          sources: sources.slice(0, numResults),
          responseId: extracted.responseId,
          model,
        });
        return;
      }
    }

    reply.code(502).send({
      error: "websearch_failed",
      details: lastErrorPayload,
    });
  });
}
