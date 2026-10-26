// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadFile, addClassPath } = require('nbb');
let loaded;

function loadOwner() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'owner-source.json'), 'utf8'));
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(__dirname, file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('typed-kimi:owner-source-mismatch');
    }
  }
  addClassPath(path.join(__dirname, 'src'));
  return loadFile(path.join(__dirname, 'src/proxx/extern/typed_kimi.cljs'), {
    disableConfig: true,
  });
}

async function runtime() {
  // A rejected load remains rejected; no fallback source or configuration.
  if (!loaded) loaded = Promise.resolve().then(loadOwner);
  return loaded;
}
async function schema(expected) { return (await runtime()).schema(expected); }
async function publicationIntent(expected, response) {
  return (await runtime()).publicationIntent(expected, response);
}
async function structuredRequest() { throw new Error('typed-kimi:submission-not-implemented'); }
async function parseSubmission() { throw new Error('typed-kimi:submission-not-implemented'); }
module.exports = { schema, publicationIntent, structuredRequest, parseSubmission };
