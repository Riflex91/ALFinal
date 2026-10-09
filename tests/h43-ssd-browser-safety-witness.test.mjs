import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(here, '../scripts/ssd-browser-safety-witness.js'), 'utf8');

function storageFixture(rows, overrides = {}) {
  const records = new Map(Object.entries(rows || {}));
  const calls = [];
  const storage = {
    get length() { return records.size; },
    key(index) { return [...records.keys()][index] ?? null; },
    getItem(key) {
      calls.push('get');
      if (overrides.throwRead) throw new Error('STORAGE_DENIED');
      return records.has(key) ? records.get(key) : null;
    },
    setItem() { calls.push('set'); throw new Error('UNAUTHORIZED_STORAGE_MUTATION'); },
    removeItem() { calls.push('remove'); throw new Error('UNAUTHORIZED_STORAGE_MUTATION'); },
    clear() { calls.push('clear'); throw new Error('UNAUTHORIZED_STORAGE_MUTATION'); }
  };
  return { storage, calls, records };
}

async function witness(t, rows, overrides) {
  const f = storageFixture(rows, overrides);
  const logs = [];
  const ctx = {
    window: { localStorage: f.storage },
    crypto: webcrypto, TextEncoder,
    Date, JSON, Object, String, Number, Array, Uint8Array, Error,
    console: { log: text => logs.push(text) }
  };
  const result = await vm.runInNewContext(script, ctx, { filename: 'ssd-browser-safety-witness.js' });
  assert.equal(logs.length, 1);
  return { ...f, result, output: logs[0] };
}

test('browser witness fingerprints safety records without mutating or disclosing names', async t => {
  const records = {
    'albot:emergency-stop:v1': JSON.stringify({ latched: true, reason: 'OPERATOR_STOP' }),
    'albot:h19:pending:v1:SecretMage': JSON.stringify({
      id: 'h19-action-secret', kind: 'STOP', targetName: 'SecretWarrior',
      unknownRecorded: true
    }),
    'albot:h19:policy:v1:SecretMage': JSON.stringify({ desiredActiveNames: ['SecretRanger'] }),
    'albot:h25:autonomy-handoff:v1:SecretMage': JSON.stringify({ target: 'SecretPriest' }),
    'ignored-key': 'private'
  };
  const { calls, result, output } = await witness(t, records);
  assert.equal(result.verified, true);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.liveMutationPerformed, false);
  assert.equal(result.stop.latched, true);
  assert.equal(result.h19.pendingCount, 1);
  assert.equal(result.h19.unknownCount, 1);
  assert.equal(result.h19.policyCount, 1);
  assert.equal(result.h25.handoffCount, 1);
  assert.equal(result.fingerprints.length, 4);
  assert.ok(result.fingerprints.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.ok(calls.every(call => call === 'get'));
  for (const secret of ['SecretMage', 'SecretWarrior', 'SecretRanger', 'SecretPriest', 'h19-action-secret']) {
    assert.equal(output.includes(secret), false);
  }
});

test('browser witness fails closed on corrupt STOP data and does not clear it', async t => {
  const key = 'albot:emergency-stop:v1';
  const { records, calls, result } = await witness(t, { [key]: '{not-json' });
  assert.equal(result.verified, false);
  assert.equal(result.issue, 'BROWSER_SAFETY_EVIDENCE_UNVERIFIED');
  assert.equal(result.stop.latched, null);
  assert.equal(result.fingerprints.length, 0);
  assert.equal(records.get(key), '{not-json');
  assert.ok(calls.every(call => call === 'get'));
});

test('browser witness fails closed on storage read denial', async t => {
  const { result, calls } = await witness(t, {
    'albot:emergency-stop:v1': '{"latched":false}'
  }, { throwRead: true });
  assert.equal(result.verified, false);
  assert.equal(result.stop.valid, false);
  assert.equal(result.cutoverAuthorized, false);
  assert.ok(calls.every(call => call === 'get'));
});

test('browser witness never interprets an empty snapshot as cutover permission', async t => {
  const { result } = await witness(t, {});
  assert.equal(result.verified, true);
  assert.equal(result.stop.found, false);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.liveMutationPerformed, false);
});
