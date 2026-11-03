#!/usr/bin/env node
// Guardrail: provider/model routing rules belong in EDN policy contracts interpreted by CLJS.
// Do not reintroduce TypeScript helpers that decide provider/model routing facts.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const scanRoots = ["src", "test"];
const excludedDirs = new Set(["node_modules", "dist", "target", ".shadow-cljs", "coverage"]);
const tsSuffixes = [".ts", ".tsx", ".cts", ".mts"];

const forbiddenPatterns = [
  {
    pattern: /dynamic-ollama-routes/,
    reason: "dynamic Ollama route discovery/order helpers bypass the EDN policy router",
  },
  {
    pattern: /\bdiscoverDynamicOllamaRoutes\b/,
    reason: "provider discovery for routing must be policy data + CLJS interpretation, not TS helper calls",
  },
  {
    pattern: /\bprependDynamicOllamaRoutes\b/,
    reason: "provider ordering is a routing rule and belongs in EDN policy",
  },
  {
    pattern: /\bfilterDedicatedOllamaRoutes\b/,
    reason: "provider filtering is a routing rule and belongs in EDN policy",
  },
  {
    pattern: /\bhasDedicatedOllamaRoutes\b/,
    reason: "provider classification is a routing rule and belongs in EDN policy",
  },
  {
    pattern: /\bwantsDynamicOllamaRoutes\b/,
    reason: "model/provider intent rules belong in EDN policy, not route-local TS booleans",
  },
  {
    pattern: /\bcatalogHasDynamicOllamaModel\b/,
    reason: "catalog model facts must not trigger TS routing branches",
  },
  {
    pattern: /\bresolveProviderRoutesForModel\b/,
    reason: "model-to-provider route resolution is owned by the EDN policy router",
  },
  {
    pattern: /\bproviderIdLooksLikeOllama\b/,
    reason: "provider-family classification belongs in provider capability contracts",
  },
  {
    pattern: /\bexcludeDynamicOllama\b/,
    reason: "auto-model/provider exclusion rules belong in EDN policy, not TS options",
  },
  {
    pattern: /\bmodel\.startsWith\(["']gemini-/,
    reason: "Gemini model-family eligibility belongs in EDN policy, not a TypeScript strategy gate",
  },
];

function isTsFile(fileName) {
  return tsSuffixes.some((suffix) => fileName.endsWith(suffix));
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
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) {
        await walk(abs, out);
      }
      continue;
    }
    if (entry.isFile() && isTsFile(entry.name)) {
      out.push(abs);
    }
  }
}

const findings = [];
for (const root of scanRoots) {
  const absRoot = path.join(repoRoot, root);
  if (!(await pathExists(absRoot))) continue;
  const files = [];
  await walk(absRoot, files);
  for (const file of files) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const text = await fs.readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(line)) {
          findings.push({ rel, line: index + 1, text: line.trim(), reason: rule.reason });
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Policy boundary violation: provider/model routing facts and rules must live in EDN policy files interpreted by CLJS, not TypeScript.\n");
  for (const finding of findings.slice(0, 100)) {
    console.error(`${finding.rel}:${finding.line}: ${finding.reason}`);
    console.error(`  ${finding.text}`);
  }
  if (findings.length > 100) {
    console.error(`... ${findings.length - 100} more violation(s)`);
  }
  process.exitCode = 1;
} else {
  console.log("Policy boundary gate passed: no forbidden TypeScript provider/model routing helpers found.");
}
