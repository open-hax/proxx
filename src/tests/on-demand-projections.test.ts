import assert from "node:assert/strict";
import test from "node:test";

import type { SqlFederationStore } from "../lib/db/sql-federation-store.js";
import { ensureFederationProjectedAccountsFresh } from "../lib/federation/on-demand-projections.js";

test("ensureFederationProjectedAccountsFresh pulls remote /api/v1 federation accounts when stale", async () => {
  const seenFetchUrls: string[] = [];
  const seenUpserts: Array<Record<string, unknown>> = [];
  const seenSyncUpdates: Array<Record<string, unknown>> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    seenFetchUrls.push(String(input));
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal((init?.headers as Headers | undefined)?.get?.("authorization")?.startsWith("Bearer ") ?? true, true);

    const body = JSON.stringify({
      localAccounts: [
        {
          providerId: "openai",
          accountId: "acct-a",
          authType: "oauth_bearer",
          hasCredentials: true,
          knowledgeSources: ["local_credential"],
        },
      ],
      projectedAccounts: [],
    });

    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const sqlFederationStore = {
      listPeers: async (_ownerSubject?: string) => [
        {
          id: "peer-a",
          ownerSubject: "did:web:example.com",
          label: "Peer A",
          baseUrl: "http://peer-a:8789",
          controlBaseUrl: "http://peer-a:8789",
          authMode: "admin_key",
          auth: { credential: "peer-token" },
          status: "active",
          capabilities: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      getSyncState: async (_peerId: string) => undefined,
      upsertProjectedAccount: async (record: Record<string, unknown>) => {
        seenUpserts.push(record);
        return record;
      },
      upsertSyncState: async (record: Record<string, unknown>) => {
        seenSyncUpdates.push(record);
        return record;
      },
    } as unknown as SqlFederationStore;

    const result = await ensureFederationProjectedAccountsFresh({
      sqlFederationStore,
      ownerSubject: "did:web:example.com",
      timeoutMs: 1000,
    });

    assert.deepEqual(result?.pulledPeerIds, ["peer-a"]);
    assert.equal(seenFetchUrls.length, 1);
    assert.ok(seenFetchUrls[0]?.includes("/api/v1/federation/accounts"));
    assert.ok(seenFetchUrls[0]?.includes("ownerSubject=did%3Aweb%3Aexample.com"));
    assert.equal(seenUpserts.length, 1);
    assert.equal(seenUpserts[0]?.availabilityState, "remote_route");
    assert.equal(seenUpserts[0]?.providerId, "openai");
    assert.equal(seenUpserts[0]?.accountId, "acct-a");
    assert.equal(seenSyncUpdates.length, 1);
    assert.equal(seenSyncUpdates[0]?.peerId, "peer-a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
