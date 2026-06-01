#!/usr/bin/env node
// Proxx no-new-TypeScript gate.
// Plain Node ESM by design: this migration guard must not require TypeScript.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const allowlistPath = path.join(repoRoot, "scripts", "typescript-inventory-allowlist.json");

const excludedDirs = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".shadow-cljs",
  ".next",
  "coverage",
  "tmp",
  "vendor",
  ".worktrees",
]);

const tsFamilySuffixes = [".d.ts", ".ts", ".tsx", ".cts", ".mts"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isTsFamily(fileName) {
  return tsFamilySuffixes.some((suffix) => fileName.endsWith(suffix));
}

async function pathExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) {
        await walk(path.join(dir, entry.name), out);
      }
      continue;
    }

    if (entry.isFile() && isTsFamily(entry.name)) {
      out.push(toPosix(path.relative(repoRoot, path.join(dir, entry.name))));
    }
  }
}

async function findPackageRoot(relPath) {
  let cursor = path.dirname(path.join(repoRoot, relPath));
  while (cursor.startsWith(repoRoot)) {
    if (await pathExists(path.join(cursor, "package.json"))) {
      return toPosix(path.relative(repoRoot, cursor)) || ".";
    }
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return ".";
}

async function loadAllowlist() {
  const raw = await fs.readFile(allowlistPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Allowlist must contain an entries array");
  }
  return parsed;
}

function entryRemoved(entry) {
  return entry.removed === true || entry.disposition === "removed" || entry.disposition === "deleted";
}

function validateEntry(entry, index) {
  const required = ["path", "owner", "disposition", "removalCondition"];
  const missing = required.filter((key) => typeof entry[key] !== "string" || entry[key].trim() === "");
  if (missing.length > 0) {
    return `entry[${index}] ${entry.path || "<missing path>"} missing ${missing.join(", ")}`;
  }
  if (path.isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.includes("..")) {
    return `entry[${index}] has invalid relative POSIX path: ${entry.path}`;
  }
  return null;
}

async function groupByOwnerAndPackage(active, entriesByPath) {
  const grouped = new Map();
  for (const relPath of active) {
    const entry = entriesByPath.get(relPath);
    const owner = entry?.owner || "<unowned>";
    const pkg = await findPackageRoot(relPath);
    const ownerRow = grouped.get(owner) || { total: 0, packages: new Map() };
    ownerRow.total += 1;
    ownerRow.packages.set(pkg, (ownerRow.packages.get(pkg) || 0) + 1);
    grouped.set(owner, ownerRow);
  }
  return grouped;
}

function formatGroupedReport(grouped) {
  const lines = ["Remaining TypeScript-family files by migration owner:"];
  for (const [owner, row] of [...grouped.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))) {
    lines.push(`  ${String(row.total).padStart(4, " ")} ${owner}`);
    for (const [pkg, count] of [...row.packages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)) {
      lines.push(`       ${String(count).padStart(4, " ")} ${pkg}`);
    }
    if (row.packages.size > 12) {
      lines.push(`            ... ${row.packages.size - 12} more package/root group(s)`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const active = [];
  await walk(repoRoot, active);
  active.sort();

  const allowlist = await loadAllowlist();
  const entryErrors = [];
  const entriesByPath = new Map();
  for (const [index, entry] of allowlist.entries.entries()) {
    const err = validateEntry(entry, index);
    if (err) entryErrors.push(err);
    if (entriesByPath.has(entry.path)) {
      entryErrors.push(`duplicate allowlist path: ${entry.path}`);
    }
    entriesByPath.set(entry.path, entry);
  }

  const activeSet = new Set(active);
  const unlisted = active.filter((relPath) => !entriesByPath.has(relPath));
  const stale = allowlist.entries
    .filter((entry) => !entryRemoved(entry) && !activeSet.has(entry.path))
    .map((entry) => entry.path)
    .sort();

  const grouped = await groupByOwnerAndPackage(active, entriesByPath);

  if (args.has("--json")) {
    console.log(JSON.stringify({
      activeCount: active.length,
      allowlistCount: allowlist.entries.length,
      unlisted,
      stale,
      entryErrors,
      policy: allowlist.policy || null,
    }, null, 2));
  } else {
    console.log(formatGroupedReport(grouped));
    console.log(`\nActive TypeScript-family files: ${active.length}`);
    console.log(`Allowlist entries: ${allowlist.entries.length}`);
  }

  if (args.has("--update")) {
    console.error("\n--update is intentionally not automatic. Add owner/disposition/removalCondition explicitly.");
    process.exitCode = 2;
    return;
  }

  if (entryErrors.length > 0 || unlisted.length > 0 || stale.length > 0) {
    if (entryErrors.length > 0) {
      console.error("\nAllowlist entry errors:");
      for (const err of entryErrors.slice(0, 50)) console.error(`  - ${err}`);
      if (entryErrors.length > 50) console.error(`  ... ${entryErrors.length - 50} more`);
    }
    if (unlisted.length > 0) {
      console.error("\nUnallowlisted TypeScript-family files:");
      for (const relPath of unlisted.slice(0, 80)) console.error(`  - ${relPath}`);
      if (unlisted.length > 80) console.error(`  ... ${unlisted.length - 80} more`);
    }
    if (stale.length > 0) {
      console.error("\nStale allowlist entries without active files:");
      for (const relPath of stale.slice(0, 80)) console.error(`  - ${relPath}`);
      if (stale.length > 80) console.error(`  ... ${stale.length - 80} more`);
    }
    process.exitCode = 1;
    return;
  }

  if (!args.has("--json")) {
    console.log("\nNo-new-TypeScript gate passed: all active TS-family files are task-owned and allowlisted.");
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
