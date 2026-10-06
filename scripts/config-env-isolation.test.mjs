import assert from 'node:assert/strict';
import { after, describe } from 'node:test';

const before = { ...process.env };
describe('config tests inherited into a concurrent parent', { concurrency: true }, async () => {
  await import('../src/tests/config.test.ts');
});
after(() => {
  const keys = new Set([...Object.keys(before), ...Object.keys(process.env)]);
  for (const key of keys) {
    assert.ok(process.env[key] === before[key], `environment was not restored for ${key}`);
  }
});
