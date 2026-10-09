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

function h25HandoffFixture(options = {}) {
  // Execute the actual production class method, not a mock implementation.
  const source = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const context = { __ALBOT_INTERNALS__: { Scheduler: class {} } };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'runtime.js' });
  const proto = context.__ALBOT_INTERNALS__.ALBotRuntime.prototype;
  const names = ['My_Mage', 'My_Priest', 'My_Ranger', 'My_Warrior'];
  const now = Date.now();
  const row = {
    schemaVersion: 1, source: 'H25_VALIDATED_BROWSER_SWAP',
    sourceCharacterName: 'My_Priest', targetCharacterName: 'My_Mage',
    serverRegion: 'EU', serverIdentifier: 'I', taskType: 'FARM',
    desiredCharacterNames: names, createdAtMs: now - 1000, expiresAtMs: now + 119000,
    ...options.record
  };
  let found = true;
  const calls = [];
  const runtime = {
    running: true,
    fullAutonomy: {
      enabled: false,
      startAutonomy(args) { calls.push('start'); return { accepted: true, args }; }
    },
    stopLatch: { status: () => ({ latched: options.stopLatched === true }) },
    game: { snapshot: () => ({
      character: { name: 'My_Mage' }, server: { region: 'EU', identifier: 'I' }
    }) },
    roster: { refresh: () => ({ accountCharacters: names.map(name => ({ name })) }) },
    _h25AutonomyHandoffKey: proto._h25AutonomyHandoffKey,
    durableStorage: {
      async read() {
        calls.push('read');
        return found ? { ok: true, found: true, value: JSON.stringify(row) }
          : { ok: true, found: false };
      },
      async remove() {
        calls.push('remove');
        if (!options.noOpRemove) found = false;
        return { ok: true };
      }
    }
  };
  return { proto, runtime, calls };
}

test('H36 H25 handoff refuses no-op SSD deletion and never rearms a replayable record', async () => {
  const f = h25HandoffFixture({ noOpRemove: true });
  const result = await f.proto._consumeH25AutonomyHandoff.call(f.runtime);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H25_REARM_HANDOFF_CLEAR_UNCONFIRMED');
  assert.deepEqual(f.calls, ['read', 'remove', 'read']);
});

test('H36 H25 invalid handoff stays intact for operator reconciliation', async () => {
  const f = h25HandoffFixture({ record: { schemaVersion: 2 } });
  const result = await f.proto._consumeH25AutonomyHandoff.call(f.runtime);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H25_REARM_HANDOFF_INVALID');
  assert.deepEqual(f.calls, ['read']);
});

test('H36 H25 handoff rearms exactly once only after confirmed SSD absence', async () => {
  const f = h25HandoffFixture();
  const result = await f.proto._consumeH25AutonomyHandoff.call(f.runtime);
  assert.equal(result.accepted, true);
  assert.deepEqual(f.calls, ['read', 'remove', 'read', 'start']);
  const second = await f.proto._consumeH25AutonomyHandoff.call(f.runtime);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'H25_REARM_NO_HANDOFF');
  assert.deepEqual(f.calls, ['read', 'remove', 'read', 'start', 'read']);
});

test('H36 H25 emergency STOP disallows SSD handoff consumption and gameplay rearm', async () => {
  const f = h25HandoffFixture({ stopLatched: true });
  const result = await f.proto._consumeH25AutonomyHandoff.call(f.runtime);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H25_REARM_NOT_ELIGIBLE');
  assert.deepEqual(f.calls, []);
});
