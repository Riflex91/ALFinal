import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DurableKeyStore } from '../host/durable-storage.mjs';
import { TelemetryStore, PersistentStateStore, createTelemetryServer } from '../host/telemetry-recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('H36 durable SSD store uses atomic files, enforces namespaces and revisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-ssd-kv-'));
  try {
    const store = new DurableKeyStore({ stateRoot: root });
    const key = 'albot:h25:autonomy-handoff:v1:EU:I:My_Mage';
    assert.equal(store.read(key).found, false);
    const row = store.write(key, '{"target":"My_Mage"}', { expiresAtMs: Date.now() + 60000 });
    assert.equal(row.revision, 1);
    const restored = new DurableKeyStore({ stateRoot: root });
    assert.equal(restored.read(key).value, '{"target":"My_Mage"}');
    assert.equal(restored.read(key).revision, 1);
    assert.throws(() => restored.write(key, 'x', { expectedRevision: 0 }), /DURABLE_REVISION_CONFLICT/);
    assert.equal(restored.write(key, 'updated', { expectedRevision: 1 }).revision, 2);
    assert.throws(() => restored.read('../../unsafe'), /DURABLE_KEY_INVALID/);
    assert.throws(() => restored.write('token:secret', 'x'), /DURABLE_KEY_INVALID/);
    assert.throws(() => restored.write(key, 'x'.repeat(3 * 1024 * 1024 + 1)), /DURABLE_VALUE_INVALID_OR_OVERSIZE/);
    assert.equal(restored.remove(key).removed, true);
    assert.equal(restored.read(key).found, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('H36 SSD HTTP API rejects foreign origins and confirms writes before reads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-ssd-http-'));
  const app = createTelemetryServer({
    store: new TelemetryStore({ root: path.join(root, 'telemetry') }),
    stateStore: new PersistentStateStore({ stateRoot: path.join(root, 'state') }),
    port: 0, host: '127.0.0.1'
  });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    const url = 'http://127.0.0.1:' + address.port + '/v1/storage?key='
      + encodeURIComponent('albot:h25:autonomy-handoff:v1:EU:I:My_Mage');
    const denied = await fetch(url, { headers: { Origin: 'https://evil.invalid' } });
    assert.equal(denied.status, 403);
    const written = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://adventure.land', 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        key: 'albot:h25:autonomy-handoff:v1:EU:I:My_Mage',
        value: '{"taskType":"FARM"}', expiresAtMs: Date.now() + 60000
      })
    });
    assert.equal(written.status, 200);
    assert.equal((await written.json()).revision, 1);
    const read = await fetch(url, { headers: { Origin: 'https://adventure.land' } });
    const data = await read.json();
    assert.equal(data.found, true);
    assert.equal(data.value, '{"taskType":"FARM"}');
    const removed = await fetch(url, {
      method: 'DELETE', headers: { Origin: 'https://adventure.land' }
    });
    assert.equal((await removed.json()).removed, true);
    const absent = await fetch(url, { headers: { Origin: 'https://adventure.land' } });
    assert.equal((await absent.json()).found, false);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H36 browser client uses only confirmed localhost SSD HTTP operations', async () => {
  const source = fs.readFileSync(path.resolve(here, '../src/ssd-storage.js'), 'utf8');
  const calls = [];
  const context = {
    console, Date, Math, JSON, Promise, Object, String, Number,
    encodeURIComponent, setTimeout, clearTimeout, AbortController,
    __ALBOT_INTERNALS__: {},
    fetch: async (url, options) => {
      calls.push({ url, method: options.method });
      return { ok: true, json: async () => ({ ok: true, found: true, value: 'ssd', revision: 1 }) };
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'ssd-storage.js' });
  const client = new context.__ALBOT_INTERNALS__.HostDurableStorageClient({ root: context });
  await client.write('albot:h25:handoff', 'test');
  assert.equal((await client.read('albot:h25:handoff')).value, 'ssd');
  await client.remove('albot:h25:handoff');
  assert.deepEqual(calls.map(row => row.method), ['POST','GET','DELETE']);
  assert.equal(calls.every(row => row.url.startsWith('http://127.0.0.1:17391/v1/storage?')), true);
  await assert.rejects(() => client.read('outside:namespace'), /SSD_KEY_INVALID/);
});
