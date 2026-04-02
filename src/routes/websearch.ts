import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import type { WebSearchToolRequest } from "../lib/request-utils.js";
import { extractResponseTextAndUrlCitations, extractMarkdownLinks } from "../lib/response-utils.js";
import { parseJsonIfPossible } from "../lib/request-utils.js";

const EXA_API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai",
  ENDPOINT: "/mcp",
  DEFAULT_NUM_RESULTS: 8,
  TIMEOUT_MS: 25000,
} as const;

interface McpSearchRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: "web_search_exa";
    arguments: {
      query: string;
      numResults: number;
      type: "auto" | "fast" | "deep";
      livecrawl: "fallback" | "preferred";
    };
  };
}

interface McpSearchResponse {
  jsonrpc: string;
  result?: {
    content: Array<{
      type: string;
      text: string;
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

async function exaWebSearch(params: {
  query: string;
  numResults: number;
  signal?: AbortSignal;
}): Promise<{ output: string; sources: Array<{ url: string; title?: string }> }> {
  const searchRequest: McpSearchRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: params.query,
        numResults: params.numResults,
        type: "auto",
        livecrawl: "fallback",
      },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXA_API_CONFIG.TIMEOUT_MS);
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(`${EXA_API_CONFIG.BASE_URL}${EXA_API_CONFIG.ENDPOINT}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(searchRequest),
      signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Exa search error (${response.status}): ${errorText}`);
    }

    const responseText = await response.text();

    const lines = responseText.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data: McpSearchResponse = JSON.parse(line.slice(6));
        if (data.error) {
          throw new Error(`Exa MCP error: ${data.error.message}`);
        }
        if (data.result?.content?.[0]?.text) {
          const output = data.result.content[0].text;
          const sources = extractMarkdownLinks(output);
          return { output, sources };
        }
      }
    }

    return {
      output: "No search results found. Please try a different query.",
      sources: [],
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

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
          backend: "openai",
        });
        return;
      }
    }

    const exaEnabled = process.env.OPEN_HAX_WEBSEARCH_EXA_FALLBACK !== "false";
    if (exaEnabled) {
      try {
        const exaResult = await exaWebSearch({
          query,
          numResults,
        });

        reply.send({
          output: exaResult.output,
          sources: exaResult.sources.slice(0, numResults),
          backend: "exa",
        });
        return;
      } catch (exaError) {
        lastErrorPayload = exaError instanceof Error ? exaError.message : exaError;
      }
    }

    reply.code(502).send({
      error: "websearch_failed",
      details: lastErrorPayload,
    });
  });
}
