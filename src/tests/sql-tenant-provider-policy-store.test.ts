import assert from "node:assert/strict";
import test from "node:test";

import type { Sql } from "../lib/db/index.js";
import { SqlTenantProviderPolicyStore } from "../lib/db/sql-tenant-provider-policy-store.js";

type Row = {
  subject_did: string;
  provider_id: string;
  provider_kind: "local_upstream" | "peer_proxx";
  owner_subject: string;
  share_mode: "deny" | "descriptor_only" | "relay_only" | "warm_import" | "project_credentials";
  trust_tier: "owned_administered" | "less_trusted";
  allowed_models: string[];
  max_requests_per_minute: number | null;
  max_concurrent_requests: number | null;
  encrypted_channel_required: boolean;
  warm_import_threshold: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function createMockSql(): Sql {
  const rows = new Map<string, Row>();

  const sql = {
    unsafe: async (query: string, values: readonly unknown[] = []) => {
      const normalized = query.replace(/\s+/g, " ").trim();

      if (normalized.startsWith("CREATE TABLE IF NOT EXISTS tenant_provider_policies")
        || normalized.startsWith("CREATE INDEX IF NOT EXISTS idx_tenant_provider_policies_owner_subject")) {
        return [];
      }

      if (normalized.startsWith("INSERT INTO tenant_provider_policies")) {
        const now = new Date().toISOString();
        const key = `${String(values[0])}\0${String(values[1])}`;
        const existing = rows.get(key);
        const row: Row = {
          subject_did: String(values[0]),
          provider_id: String(values[1]),
          provider_kind: values[2] as Row["provider_kind"],
          owner_subject: String(values[3]),
          share_mode: values[4] as Row["share_mode"],
          trust_tier: values[5] as Row["trust_tier"],
          allowed_models: JSON.parse(String(values[6])) as string[],
          max_requests_per_minute: values[7] as number | null,
          max_concurrent_requests: values[8] as number | null,
          encrypted_channel_required: Boolean(values[9]),
          warm_import_threshold: values[10] as number | null,
          notes: values[11] as string | null,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        rows.set(key, row);
        return [row];
      }

      if (normalized.includes("FROM tenant_provider_policies WHERE subject_did = $1 AND provider_id = $2")) {
        const key = `${String(values[0])}\0${String(values[1])}`;
        const row = rows.get(key);
        return row ? [row] : [];
      }

      if (normalized.includes("FROM tenant_provider_policies")) {
        let listed = [...rows.values()];
        if (normalized.includes("WHERE subject_did = $1") && values[0]) {
          listed = listed.filter((row) => row.subject_did === String(values[0]));
        }
        if (normalized.includes("WHERE owner_subject = $1") && values[0]) {
          listed = listed.filter((row) => row.owner_subject === String(values[0]));
        }
        if (normalized.includes("subject_did = $1 AND owner_subject = $2")) {
          listed = listed.filter((row) => row.subject_did === String(values[0]) && row.owner_subject === String(values[1]));
        }
        if (normalized.includes("owner_subject = $1 AND subject_did = $2")) {
          listed = listed.filter((row) => row.owner_subject === String(values[0]) && row.subject_did === String(values[1]));
        }
        listed.sort((left, right) => left.owner_subject.localeCompare(right.owner_subject)
          || left.subject_did.localeCompare(right.subject_did)
          || left.provider_id.localeCompare(right.provider_id));
        return listed;
      }

      throw new Error(`Unsupported SQL query in tenant-provider-policy test: ${normalized}`);
    },
  } as unknown as Sql;

  return sql;
}

test("sql tenant provider policy store upserts and lists policies", async () => {
  const store = new SqlTenantProviderPolicyStore(createMockSql());
  await store.init();

  const first = await store.upsertPolicy({
    subjectDid: "did:web:big.ussy.promethean.rest",
    providerId: "openai",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    shareMode: "project_credentials",
    trustTier: "owned_administered",
    allowedModels: ["gpt-5.4", "gpt-5.3-codex"],
    warmImportThreshold: 3,
  });

  assert.equal(first.providerId, "openai");
  assert.equal(first.shareMode, "project_credentials");
  assert.equal(first.trustTier, "owned_administered");
  assert.deepEqual(first.allowedModels, ["gpt-5.4", "gpt-5.3-codex"]);

  const fetched = await store.getPolicy("did:web:big.ussy.promethean.rest", "openai");
  assert.ok(fetched);
  assert.equal(fetched.shareMode, "project_credentials");

  const listed = await store.listPolicies({ ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.subjectDid, "did:web:big.ussy.promethean.rest");
});