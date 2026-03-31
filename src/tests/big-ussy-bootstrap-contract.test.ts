import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

function resolveBigUssyBootstrapScriptPath(): string {
  const override = process.env.PROXX_BIG_USSY_BOOTSTRAP_SCRIPT?.trim();
  if (override) {
    return override;
  }

  return resolve(repoRoot, "../../../services/proxx/bin/project-complete-devel-stack-to-big-ussy.sh");
}

test("big ussy bootstrap script keeps repaired local-core relay contract", async (t) => {
  const scriptPath = resolveBigUssyBootstrapScriptPath();
  try {
    await access(scriptPath, constants.R_OK);
  } catch {
    t.skip(`bootstrap script not present at ${scriptPath}`);
    return;
  }

  const script = await readFile(scriptPath, "utf8");

  assert.match(script, /REMOTE_RELAY_PORT="18790"/);
  assert.match(script, /'id': 'local-core'/);
  assert.match(script, /'baseUrl': f'http:\/\/host\.docker\.internal:\$\{REMOTE_RELAY_PORT\}'/);
  assert.match(script, /'controlBaseUrl': f'http:\/\/host\.docker\.internal:\$\{REMOTE_RELAY_PORT\}'/);
  assert.doesNotMatch(script, /PROXX_CANON_SYNC_PEER_ID=local-canonical/);
  assert.match(script, /PROXX_CANON_SYNC_PEER_ID=local-core/);
  assert.match(script, /start_new_session=True/);
  assert.match(script, /stdin=subprocess\.DEVNULL/);
});
