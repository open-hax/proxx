#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = "scripts/check-deployment-boundary.mjs";

const retiredEntryPoints = [
  "scripts/deploy-remote.sh",
  "scripts/deploy-target.sh",
  "deploy/targets/big-ussy-hub-spokes.env",
  "deploy/targets/big-ussy-owned-relay.env",
  "docs/promethean-federated-deployments.md",
];

const activeRoots = [".github/workflows", "scripts", "deploy/targets"];
const rules = [
  ["retired Services workflow", /deploy-promethean\.ya?ml/],
  ["legacy VPS address", /\b104\.130\.159\.19\b/],
  ["legacy SSH identity", /\berror@(?:[^\s]+\.promethean\.rest|104\.130\.159\.19)\b/],
  ["legacy runtime root", /\/home\/error(?:\/|\b)/],
  ["unverified SSH policy", /StrictHostKeyChecking\s*(?:=|\s)\s*(?:accept-new|no)\b/i],
  ["unverified SSH host-key discovery", /\bssh-keyscan\b/],
  [
    "Promethean SSH host default",
    /(?:DEPLOY_HOST|STAGING_HOST|TESTING_HOST|PRODUCTION_HOST|PROMETHEAN_SSH_HOST)[^\n]{0,160}(?:ussy|proxx)[^\n]{0,80}\.promethean\.rest/,
  ],
  [
    "legacy SSH user default",
    /(?:DEPLOY_USER|STAGING_SSH_USER|TESTING_SSH_USER|PRODUCTION_SSH_USER|PROMETHEAN_SSH_USER)[^\n]{0,200}\berror\b/,
  ],
];

async function exists(relativePath) {
  try {
    await access(path.join(repositoryRoot, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function filesBelow(relativeRoot) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  if (!(await exists(relativeRoot))) return [];
  const entries = await readdir(absoluteRoot, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repositoryRoot, path.join(entry.parentPath, entry.name)))
    .filter((relativePath) => relativePath !== self)
    .sort();
}

function violations(relativePath, text) {
  const found = [];
  for (const [lineIndex, line] of text.split("\n").entries()) {
    for (const [name, pattern] of rules) {
      if (pattern.test(line)) found.push({ relativePath, line: lineIndex + 1, name, source: line.trim() });
    }
  }
  return found;
}

function selfTest() {
  const bad = [
    "uses: open-hax/services/.github/workflows/deploy-promethean.yaml@main",
    "ssh error@ussy3.promethean.rest",
    "ssh error@104.130.159.19",
    "DEPLOY_PATH=/home/error/devel/services/proxx",
    "StrictHostKeyChecking=no",
    "ssh-keyscan -H host.example",
    "DEPLOY_HOST=${DEPLOY_HOST:-ussy.promethean.rest}",
    "STAGING_SSH_USER=${STAGING_SSH_USER:-error}",
  ];
  const safe = [
    "PROXX_PUBLIC_HOST=proxx.promethean.rest",
    "runtimeRoot: /srv/open-hax",
    "sshUser: deploy",
    "StrictHostKeyChecking yes",
  ];
  const failures = [];
  for (const sample of bad) {
    if (violations("bad", sample).length === 0) failures.push(`missed forbidden sample: ${sample}`);
  }
  for (const sample of safe) {
    if (violations("safe", sample).length !== 0) failures.push(`rejected safe sample: ${sample}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    return 1;
  }
  console.log("deployment boundary classifier self-test passed");
  return 0;
}

async function scan() {
  const found = [];
  for (const relativePath of retiredEntryPoints) {
    if (await exists(relativePath)) {
      found.push({ relativePath, line: 1, name: "retired deploy entry point exists", source: relativePath });
    }
  }
  for (const relativeRoot of activeRoots) {
    for (const relativePath of await filesBelow(relativeRoot)) {
      const text = await readFile(path.join(repositoryRoot, relativePath), "utf8");
      found.push(...violations(relativePath, text));
    }
  }
  if (found.length > 0) {
    for (const item of found) {
      console.error(`::error file=${item.relativePath},line=${item.line}::${item.name}: ${item.source}`);
    }
    console.error(`deployment boundary rejected ${found.length} legacy reference(s)`);
    return 1;
  }
  console.log("deployment boundary contains no active legacy deployment authority");
  return 0;
}

const exitCode = process.argv.includes("--self-test") ? selfTest() : await scan();
process.exitCode = exitCode;
