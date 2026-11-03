#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerLines = dockerfile.split(/\r?\n/);

const dependencyCopyIndex = dockerLines.findIndex((line) =>
  line.startsWith("COPY ")
  && line.includes("package.json")
  && line.includes("pnpm-lock.yaml")
  && line.includes("pnpm-workspace.yaml")
);
const installIndex = dockerLines.findIndex((line) => line.startsWith("RUN pnpm install"));

assert.notEqual(dependencyCopyIndex, -1, "Dockerfile must copy package.json, pnpm-lock.yaml, and pnpm-workspace.yaml together");
assert.notEqual(installIndex, -1, "Dockerfile must install dependencies during the image build");
assert.ok(dependencyCopyIndex < installIndex, "Dockerfile must copy the lock contract before installing dependencies");
assert.match(dockerLines[installIndex], /--frozen-lockfile(?:\s|$)/, "Dockerfile dependency installation must use --frozen-lockfile");
assert.doesNotMatch(dockerfile, /--no-frozen-lockfile/, "Dockerfile must not permit mutable dependency resolution");

const ecosystem = require("../ecosystem.container.config.cjs");
assert.ok(Array.isArray(ecosystem.apps) && ecosystem.apps.length > 0, "container process manifest must declare applications");

const packageManagers = new Set(["corepack", "npm", "npx", "pnpm", "yarn"]);
for (const app of ecosystem.apps) {
  assert.equal(typeof app.name, "string", "every container application must have a name");
  assert.equal(typeof app.script, "string", `${app.name} must declare an executable`);
  assert.ok(
    !packageManagers.has(app.script),
    `${app.name} must execute built artifacts directly, not invoke ${app.script} at runtime`
  );
}

const web = ecosystem.apps.find((app) => app.name === "open-hax-openai-proxy-web");
assert.ok(web, "container process manifest must retain the web preview process");
assert.equal(web.script, "node", "web preview must execute with node");
assert.ok(
  Array.isArray(web.args) && web.args[0] === "node_modules/vite/bin/vite.js",
  "web preview must invoke the installed Vite entrypoint directly"
);

console.log("container runtime is immutable: locked build and no runtime package manager");
