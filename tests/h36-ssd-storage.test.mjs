import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { TelemetryStore, PersistentStateStore, createTelemetryServer } from '../host/telemetry-recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('H36 legacy telemetry Node process cannot write the native Bridge SSD key namespace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-native-ssd-isolation-'));
  const app = createTelemetryServer({
    store: new TelemetryStore({ root: path.join(root, 'telemetry') }),
    stateStore: new PersistentStateStore({ stateRoot: path.join(root, 'state') })
  });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.durableStore, undefined);
    const key = encodeURIComponent('albot:h25:autonomy-handoff:v1:EU:I:My_Mage');
    const get = await fetch(base + '/v1/storage?key=' + key);
    assert.equal(get.status, 404);
    const post = await fetch(base + '/v1/storage?key=' + key, {
      method: 'POST',
      headers: { 'Origin': 'https://adventure.land', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ key: 'albot:h25:autonomy-handoff:v1:EU:I:My_Mage', value: 'test' })
    });
    assert.equal(post.status, 404);
    assert.equal(fs.existsSync(path.join(root, 'state', 'durable-kv')), false);
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
  assert.equal(calls.every(row => row.url.startsWith('http://127.0.0.1:17392/v1/storage?')), true);
  await assert.rejects(() => client.read('outside:namespace'), /SSD_KEY_INVALID/);
});
