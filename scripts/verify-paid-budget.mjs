// Isolated PostgreSQL integration test. DATABASE_URL must name a test-capable DB.
// No upstream inference or provider charge is made.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { loadCljsRuntime } from '../dist/lib/cljs-runtime.js';
import * as schema from '../dist/lib/db/schema.js';
import { SqlRequestUsageStore } from '../dist/lib/db/sql-request-usage-store.js';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required');
const namespace = `budget_test_${randomUUID().replaceAll('-', '')}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
let sql;
let reopened;
const options = { max: 16, onnotice: () => {}, connection: { search_path: namespace, default_transaction_isolation: "repeatable read" } };
try {
  await admin.unsafe(`CREATE SCHEMA ${namespace}`);
  sql = postgres(process.env.DATABASE_URL, options);
  await sql.unsafe(schema.CREATE_PAID_BUDGET_RESERVATIONS_TABLE);
  const usageStore = new SqlRequestUsageStore(sql);
  await usageStore.init();
  await usageStore.upsertEntry({ id: randomUUID(), timestamp: Date.now(), providerId: 'requesty', accountId: 'fixture',
    authType: 'api_key', routeKind: 'local', model: 'gemma4:31b', upstreamModel: 'deepinfra/google/gemma-4-31B-it',
    upstreamMode: 'chat_completions', upstreamPath: '/v1/chat/completions', status: 200, latencyMs: 1,
    serviceTierSource: 'none', costUsd: 0.51, promptTokens: 1000000, completionTokens: 1000000 });
  const usageEntries = await usageStore.listEntries();
  assert.equal(usageEntries[0].model, 'gemma4:31b');
  assert.equal(usageEntries[0].upstreamModel, 'deepinfra/google/gemma-4-31B-it');
  assert.equal(usageEntries[0].costUsd, 0.51);
  const loaded = await loadCljsRuntime({ required: true });
  assert.ok(loaded.loaded);
  const runtime = loaded.runtime;
  const policy = runtime.loadPaidBudgetPolicy('resources/policies/runtime/00-manifest.edn', ':paid-budget/knoxx-social');
  assert.equal(policy.dailyMicrousd, 500000);
  assert.equal(policy.monthlyMicrousd, 5000000);
  assert.equal(policy.calendar, 'utc');
  const queries = {
    lock: schema.LOCK_PAID_BUDGET_SCOPE,
    usage: schema.SELECT_PAID_BUDGET_USAGE,
    snapshot: schema.SELECT_PAID_BUDGET_SNAPSHOT,
    insert: schema.INSERT_PAID_BUDGET_RESERVATION,
    settle: schema.SETTLE_PAID_BUDGET_RESERVATION,
  };
  const attempts = await Promise.all(Array.from({ length: 40 }, () =>
    runtime.reservePaidBudget(sql, queries, policy, randomUUID(), 50000)));
  const admitted = attempts.filter(x => x.status === 'admitted');
  assert.equal(admitted.length, 10, 'parallel requests must not exceed daily 50 cents');
  assert.equal(attempts.filter(x => x.status === 'daily-limit').length, 30);

  await sql.end();
  sql = undefined;
  reopened = postgres(process.env.DATABASE_URL, options);
  assert.equal((await runtime.reservePaidBudget(reopened, queries, policy, randomUUID(), 1)).status, 'daily-limit', 'new process/connection retains reserved spend');
  assert.equal((await runtime.settlePaidBudget(reopened, queries, policy.scopeId, admitted[0].reservationId, null)).status, 'unreconciled');
  assert.equal((await runtime.reservePaidBudget(reopened, queries, policy, randomUUID(), 1)).status, 'daily-limit', 'unknown usage must not release funds');
  assert.equal((await runtime.settlePaidBudget(reopened, queries, policy.scopeId, admitted[0].reservationId, 10000)).status, 'settled');
  assert.equal((await runtime.settlePaidBudget(reopened, queries, policy.scopeId, admitted[0].reservationId, 0)).status, 'unchanged', 'duplicate settlement cannot refund again');
  assert.equal((await runtime.reservePaidBudget(reopened, queries, policy, randomUUID(), 40000)).status, 'admitted');
  assert.equal((await runtime.reservePaidBudget(reopened, queries, policy, randomUUID(), 1)).status, 'daily-limit');

  const monthlyPolicy = { ...policy, scopeId: 'monthly-test', dailyMicrousd: 10000000 };
  const monthly = await Promise.all(Array.from({ length: 10 }, () =>
    runtime.reservePaidBudget(reopened, queries, monthlyPolicy, randomUUID(), 1000000)));
  assert.equal(monthly.filter(x => x.status === 'admitted').length, 5);
  assert.equal(monthly.filter(x => x.status === 'monthly-limit').length, 5);
  // Synthetic rollover states: a process died with a previous-period hold.
  const rolloverPolicy = { ...policy, scopeId: 'rollover-test' };
  const rolloverId = randomUUID();
  await reopened.unsafe(`INSERT INTO paid_budget_reservations
    (id, scope_id, day_utc, month_utc, reserved_microusd)
    VALUES ($1, $2, '2000-01-31', '2000-01-01', 500000)`, [rolloverId, rolloverPolicy.scopeId]);
  assert.equal((await runtime.reservePaidBudget(reopened, queries, rolloverPolicy, randomUUID(), 1)).status, 'daily-limit', 'unresolved previous month carries into current daily cap');
  assert.equal((await runtime.settlePaidBudget(reopened, queries, rolloverPolicy.scopeId, rolloverId, 10000)).status, 'settled');
  assert.equal((await runtime.reservePaidBudget(reopened, queries, rolloverPolicy, randomUUID(), 500000)).status, 'admitted', 'late prior-month settlement returns current allowance without moving old charge');
  const monthCarry = { ...monthlyPolicy, scopeId: 'month-carry-test' };
  await reopened.unsafe(`INSERT INTO paid_budget_reservations
    (id, scope_id, day_utc, month_utc, reserved_microusd)
    VALUES ($1, $2, '2000-01-31', '2000-01-01', 5000000)`, [randomUUID(), monthCarry.scopeId]);
  assert.equal((await runtime.reservePaidBudget(reopened, queries, monthCarry, randomUUID(), 1)).status, 'monthly-limit', 'previous-month unresolved spend also consumes current monthly cap');
  const dailyCarry = { ...policy, scopeId: 'day-carry-test' };
  const dailyCarryId = randomUUID();
  await reopened.unsafe(`INSERT INTO paid_budget_reservations
    (id, scope_id, day_utc, month_utc, reserved_microusd)
    VALUES ($1, $2, timezone('UTC', CURRENT_TIMESTAMP)::date - 1,
      date_trunc('month', timezone('UTC', CURRENT_TIMESTAMP)::date - 1)::date, 500000)`, [dailyCarryId, dailyCarry.scopeId]);
  assert.equal((await runtime.reservePaidBudget(reopened, queries, dailyCarry, randomUUID(), 1)).status, 'daily-limit', 'yesterday hold does not disappear at midnight');
  await runtime.settlePaidBudget(reopened, queries, dailyCarry.scopeId, dailyCarryId, 500000);
  assert.equal((await runtime.reservePaidBudget(reopened, queries, dailyCarry, randomUUID(), 500000)).status, 'admitted', 'settled yesterday cost does not consume today allowance');
  const duplicatePolicy = { ...policy, scopeId: 'duplicate-test' };
  const sameId = randomUUID();
  const duplicates = await Promise.all(Array.from({ length: 4 }, () =>
    runtime.reservePaidBudget(reopened, queries, duplicatePolicy, sameId, 50000)));
  assert.equal(duplicates.filter(x => x.status === 'admitted').length, 1, 'one reservation cannot admit several paid requests');
  assert.equal(duplicates.filter(x => x.status === 'unavailable').length, 3);
  assert.equal((await runtime.reservePaidBudget(null, queries, policy, randomUUID(), 1)).status, 'unavailable');
  const snapshot = await runtime.readPaidBudgets(reopened, queries,
    'resources/policies/runtime/00-manifest.edn', {kind: 'tenant_api_key', keyId: 'knoxx-social-proxx'});
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.budgets.length, 1);
  const budget = snapshot.budgets[0];
  assert.equal(budget.status, 'ok');
  assert.equal(budget.usage.dailyChargedMicrousd, 10000);
  assert.equal(budget.usage.heldMicrousd, 490000);
  assert.equal(budget.dailyRemainingMicrousd, 0);
  assert.equal(budget.monthlyRemainingMicrousd, 4500000);
  const isolated = await runtime.readPaidBudgets(reopened, queries,
    'resources/policies/runtime/00-manifest.edn', {kind: 'tenant_api_key', keyId: 'unrelated-key'});
  assert.equal(isolated.budgets.length, 0);
  const denied = await runtime.readPaidBudgets(reopened, queries,
    'resources/policies/runtime/00-manifest.edn', {kind: 'tenant_api_key', keyId: 'unrelated-key'}, 'knoxx-social-proxx');
  assert.equal(denied.status, 'forbidden');
  const unavailable = await runtime.readPaidBudgets(null, queries,
    'resources/policies/runtime/00-manifest.edn', {kind: 'tenant_api_key', keyId: 'knoxx-social-proxx'});
  assert.equal(unavailable.budgets[0].status, 'unavailable');
  assert.equal(unavailable.budgets[0].dailyRemainingMicrousd, undefined);
  console.log('paid-budget-postgres-ok: concurrent daily/monthly caps, restart durability, daily/monthly rollover, late/unknown settlement, duplicate-ID boundaries and SQL upstream model readback');
} finally {
  await sql?.end();
  await reopened?.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
  await admin.end();
}
