import assert from "node:assert/strict";
import test from "node:test";

import { ALL_MIGRATIONS, SCHEMA_VERSION } from "../lib/db/schema.js";

test("SCHEMA_VERSION matches the highest version in ALL_MIGRATIONS", () => {
  const maxVersion = Math.max(...ALL_MIGRATIONS.map((m) => m.version));
  assert.equal(
    SCHEMA_VERSION,
    maxVersion,
    `SCHEMA_VERSION (${SCHEMA_VERSION}) must equal the highest migration version (${maxVersion}). ` +
      "If you added a new migration to ALL_MIGRATIONS, bump SCHEMA_VERSION to match.",
  );
});

test("ALL_MIGRATIONS versions are non-decreasing", () => {
  let previous = 0;
  for (const migration of ALL_MIGRATIONS) {
    assert.ok(
      migration.version >= previous,
      `Migration versions must be non-decreasing: version ${migration.version} came after ${previous}`,
    );
    previous = migration.version;
  }
});

test("ALL_MIGRATIONS entries are non-empty SQL strings", () => {
  for (const migration of ALL_MIGRATIONS) {
    assert.ok(
      typeof migration.sql === "string" && migration.sql.trim().length > 0,
      `Migration version ${migration.version} must have a non-empty SQL string`,
    );
  }
});

test("ALTER TABLE migrations use IF NOT EXISTS for safety", () => {
  for (const migration of ALL_MIGRATIONS) {
    if (migration.sql.toUpperCase().includes("ALTER TABLE")) {
      assert.ok(
        migration.sql.toUpperCase().includes("IF NOT EXISTS"),
        `ALTER TABLE migration version ${migration.version} should use IF NOT EXISTS for idempotency: "${migration.sql.slice(0, 80)}..."`,
      );
    }
  }
});

test("CREATE TABLE migrations use IF NOT EXISTS for safety", () => {
  for (const migration of ALL_MIGRATIONS) {
    if (migration.sql.toUpperCase().includes("CREATE TABLE")) {
      assert.ok(
        migration.sql.toUpperCase().includes("IF NOT EXISTS"),
        `CREATE TABLE migration version ${migration.version} should use IF NOT EXISTS for idempotency`,
      );
    }
  }
});
