import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

import { chromium } from "playwright";

const BASE_URL = "http://127.0.0.1:5174";
const NOW = new Date("2026-04-03T00:00:00Z").toISOString();

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return true;
      }
    } catch {
      // keep waiting
    }
    await sleep(500);
  }
  return false;
}

async function ensureFrontendServer(): Promise<{ child: ChildProcess | null }> {
  if (await waitForServer(BASE_URL, 2_000)) {
    return { child: null };
  }

  const child = spawn("pnpm", ["web:dev"], {
    cwd: "/home/err/devel/orgs/open-hax/proxx",
    stdio: "ignore",
    detached: false,
  });

  const ready = await waitForServer(BASE_URL, 30_000);
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error("Frontend dev server did not become ready on http://127.0.0.1:5174");
  }

  return { child };
}

async function main(): Promise<void> {
  const { child } = await ensureFrontendServer();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.route("**/api/v1/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ fastMode: false }),
    });
  });

  await page.route("**/api/v1/dashboard/overview**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: NOW,
        summary: {
          requests24h: 12,
          tokens24h: 3400,
          promptTokens24h: 1200,
          completionTokens24h: 2200,
          cachedPromptTokens24h: 200,
          imageCount24h: 2,
          imageCostUsd24h: 0.12,
          costUsd24h: 1.23,
          energyJoules24h: 12000,
          waterEvaporatedMl24h: 34,
          cacheKeyUses24h: 3,
          cacheHitRate24h: 20,
          errorRate24h: 0,
          topModel: "gpt-5.3-codex",
          topProvider: "openai",
          activeAccounts: 1,
          routingRequests24h: { local: 10, federated: 1, bridge: 1, distinctPeers: 1, topPeer: "peer-a" },
          serviceTierRequests24h: { fastMode: 1, priority: 2, standard: 9 },
        },
        trends: {
          requests: [{ t: NOW, v: 12 }],
          tokens: [{ t: NOW, v: 3400 }],
          errors: [{ t: NOW, v: 0 }],
        },
        accounts: [
          {
            accountId: "acct-1",
            displayName: "Primary OpenAI",
            providerId: "openai",
            authType: "oauth_bearer",
            status: "healthy",
            requestCount: 12,
            totalTokens: 3400,
            promptTokens: 1200,
            completionTokens: 2200,
            cachedPromptTokens: 200,
            imageCount: 2,
            imageCostUsd: 0.12,
            costUsd: 1.23,
            energyJoules: 12000,
            waterEvaporatedMl: 34,
            cacheHitCount: 1,
            cacheKeyUseCount: 3,
            avgTtftMs: 420,
            avgDecodeTps: 18,
            avgTps: 14,
            avgEndToEndTps: 10,
            healthScore: 0.92,
            transientDebuff: 0,
            lastUsedAt: NOW,
          },
        ],
      }),
    });
  });

  await page.route("**/api/v1/credentials**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          {
            id: "openai",
            authType: "oauth_bearer",
            accountCount: 1,
            accounts: [
              {
                id: "acct-1",
                authType: "oauth_bearer",
                displayName: "Primary OpenAI",
                email: "alice@example.com",
                secretPreview: "tok-***",
                refreshTokenPreview: "refresh-***",
                planType: "pro",
              },
            ],
          },
        ],
        keyPoolStatuses: {
          openai: {
            providerId: "openai",
            authType: "oauth_bearer",
            totalAccounts: 1,
            availableAccounts: 1,
            cooldownAccounts: 0,
            nextReadyInMs: 0,
          },
        },
        requestLogSummary: {},
      }),
    });
  });

  await page.route("**/api/v1/request-logs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [
          {
            id: "req-1",
            timestamp: Date.now(),
            routeKind: "local",
            providerId: "openai",
            accountId: "acct-1",
            authType: "oauth_bearer",
            model: "gpt-5.3-codex",
            upstreamMode: "responses",
            upstreamPath: "/v1/responses",
            status: 200,
            latencyMs: 420,
            serviceTierSource: "none",
          },
        ],
      }),
    });
  });

  await page.route("**/api/v1/credentials/accounts/disabled", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ disabledAccounts: [] }),
    });
  });

  await page.route("**/api/v1/credentials/openai/quota**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ generatedAt: NOW, accounts: [] }),
    });
  });

  await page.route("**/api/v1/credentials/openai/prompt-cache-audit**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: NOW,
        scannedEntryCount: 0,
        distinctHashCount: 0,
        crossAccountHashCount: 0,
        crossSuccessfulAccountHashCount: 0,
        rows: [],
      }),
    });
  });

  await page.route("**/api/v1/hosts/overview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: NOW,
        selfTargetId: "host-a",
        hosts: [
          {
            id: "host-a",
            label: "Host A",
            source: "local",
            fetchedAt: NOW,
            reachable: true,
            baseUrl: "http://host-a.local",
            errors: [],
            containers: [
              { id: "container-1", name: "proxx", image: "proxx:latest", state: "running", status: "Up", ports: ["8789/tcp"] },
            ],
            routes: [
              { host: "proxx.local", matchPaths: ["/api"], upstreams: ["http://127.0.0.1:8789"] },
            ],
            summary: { containerCount: 1, runningCount: 1, healthyCount: 1, routeCount: 1 },
          },
        ],
      }),
    });
  });

  await page.route("**/api/v1/tools?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tools: [
          { id: "apply_patch", description: "Patch files safely", enabled: true },
          { id: "bash", description: "Run shell commands", enabled: true },
        ],
      }),
    });
  });

  await page.route("**/api/v1/mcp-servers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        servers: [
          {
            id: "social-publisher",
            script: "node ./server.js",
            cwd: "/workspace/mcp-social-publisher",
            args: [],
            port: 8799,
            sourceFile: "ecosystem.container.config.cjs",
            running: false,
          },
        ],
      }),
    });
  });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    let content = await page.textContent("body");
    assert.ok(content?.includes("Single Proxy Control Tower"));
    assert.ok(content?.includes("Primary OpenAI"));
    assert.ok(content?.includes("Recent Request Log"));

    await page.goto(`${BASE_URL}/hosts`, { waitUntil: "networkidle" });
    content = await page.textContent("body");
    assert.ok(content?.includes("Promethean ussy host dashboard"));
    assert.ok(content?.includes("Host A"));
    assert.ok(content?.includes("proxx:latest"));

    await page.goto(`${BASE_URL}/credentials`, { waitUntil: "networkidle" });
    content = await page.textContent("body");
    assert.ok(content?.includes("Credentials Manager"));
    assert.ok(content?.includes("Primary OpenAI"));
    assert.ok(content?.includes("Refresh Codex quotas"));

    await page.goto(`${BASE_URL}/tools`, { waitUntil: "networkidle" });
    content = await page.textContent("body");
    assert.ok(content?.includes("Tool Manager"));
    assert.ok(content?.includes("apply_patch"));
    assert.ok(content?.includes("Patch files safely"));
    assert.ok(content?.includes("MCP Manager"));
    assert.ok(content?.includes("social-publisher"));
  } finally {
    await page.close();
    await browser.close();
    if (child) {
      child.kill("SIGTERM");
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
