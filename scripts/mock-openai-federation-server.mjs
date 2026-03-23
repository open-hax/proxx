#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number.parseInt(process.env.MOCK_OPENAI_PORT ?? "8080", 10) || 8080;

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function makeJwt(claims) {
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(claims)}.`;
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendRedirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function identityFromRedirectUri(redirectUri) {
  const url = new URL(redirectUri);
  const host = url.hostname.toLowerCase();
  const slug = safeSlug(host);
  const group = slug.startsWith("a") ? "group-a" : slug.startsWith("b") ? "group-b" : "cluster";
  return {
    host,
    slug,
    group,
    chatgptAccountId: `chatgpt-${slug}`,
    accountId: `mock-${slug}`,
    email: `${slug}@federation.test`,
    subject: `subject-${slug}`,
    planType: group === "group-a" ? "plus" : "pro",
  };
}

function decodeCode(code) {
  try {
    return JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function encodeCode(identity) {
  return Buffer.from(JSON.stringify({
    ...identity,
    nonce: randomUUID(),
  }), "utf8").toString("base64url");
}

function responseTextForRequest(body, request) {
  const model = typeof body?.model === "string" && body.model.length > 0 ? body.model : "unknown-model";
  const chatgptAccountId = request.headers["chatgpt-account-id"];
  const authHeader = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  const authFragment = authHeader.startsWith("Bearer ") ? authHeader.slice(7, 25) : "no-auth";
  const accountMarker = typeof chatgptAccountId === "string" && chatgptAccountId.length > 0
    ? chatgptAccountId
    : authFragment;
  return `mock federated response for ${model} via ${accountMarker}`;
}

function responsesPayload(text, body, request) {
  const model = typeof body?.model === "string" && body.model.length > 0 ? body.model : "gpt-5.3-codex";
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: {
        cached_tokens: request.headers["x-open-hax-federation-hop"] ? 0 : 1,
      },
      output_tokens_details: {
        reasoning_tokens: 0,
      },
    },
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "mock-openai-federation" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (!redirectUri) {
        sendJson(response, 400, { error: "redirect_uri_required" });
        return;
      }

      const identity = identityFromRedirectUri(redirectUri);
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", encodeCode(identity));
      callbackUrl.searchParams.set("state", state);
      sendRedirect(response, callbackUrl.toString());
      return;
    }

    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const bodyText = await readBody(request);
      const body = new URLSearchParams(bodyText);
      const redirectUri = body.get("redirect_uri") ?? "http://unknown/auth/callback";
      const identity = decodeCode(body.get("code") ?? "") ?? identityFromRedirectUri(redirectUri);
      const idToken = makeJwt({
        sub: identity.subject,
        email: identity.email,
        chatgpt_account_id: identity.chatgptAccountId,
        chatgpt_plan_type: identity.planType,
        organizations: [{ id: identity.chatgptAccountId }],
        "https://api.openai.com/auth": {
          chatgpt_account_id: identity.chatgptAccountId,
          chatgpt_plan_type: identity.planType,
        },
        "https://api.openai.com/profile": {
          email: identity.email,
        },
      });

      sendJson(response, 200, {
        id_token: idToken,
        access_token: `mock-access-${identity.slug}`,
        refresh_token: `mock-refresh-${identity.slug}`,
        expires_in: 3600,
        chatgpt_account_id: identity.chatgptAccountId,
      });
      return;
    }

    if (request.method === "POST" && ["/codex/responses", "/codex/responses/compact", "/v1/responses"].includes(url.pathname)) {
      const bodyText = await readBody(request);
      const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
      const text = responseTextForRequest(body, request);
      sendJson(response, 200, responsesPayload(text, body, request));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const bodyText = await readBody(request);
      const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
      const model = typeof body?.model === "string" && body.model.length > 0 ? body.model : "gpt-5.3-codex";
      sendJson(response, 200, {
        id: `chatcmpl_${randomUUID()}`,
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: responseTextForRequest(body, request),
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/images/generations") {
      sendJson(response, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: Buffer.from("mock-image").toString("base64") }],
      });
      return;
    }

    sendJson(response, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    sendJson(response, 500, { error: "mock_openai_server_error", detail: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`mock-openai-federation-server listening on ${port}`);
});
