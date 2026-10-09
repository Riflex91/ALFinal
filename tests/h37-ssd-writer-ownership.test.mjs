import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeWriterOwnership, WRITER_LEASE_FILE, WRITER_OWNER_FILE } from '../host/ssd-writer-ownership.mjs';
import { createTelemetryServer } from '../host/telemetry-recorder.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('one Node writer; durable owner survives clean restart', t => {
  const root = tempRoot(t);
  const first = new NodeWriterOwnership(root).acquire();
  first.assertOwned();
  assert.throws(() => new NodeWriterOwnership(root).acquire(), /ALBOT_WRITER_LEASE_HELD_OR_STALE/);
  first.release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, WRITER_OWNER_FILE))).owner, 'node');
  const second = new NodeWriterOwnership(root).acquire();
  second.assertOwned();
  second.release();
});

test('stale lease blocks reboot without automatic recovery', t => {
  const root = tempRoot(t);
  new NodeWriterOwnership(root).acquire(); // simulate crash: no release
  assert.throws(() => new NodeWriterOwnership(root).acquire(), /ALBOT_WRITER_LEASE_HELD_OR_STALE/);
  assert.ok(fs.existsSync(path.join(root, WRITER_LEASE_FILE)));
});

test('bridge ownership fences Node restarts', t => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, WRITER_OWNER_FILE), JSON.stringify({ schemaVersion: 1, owner: 'bridge' }));
  assert.throws(() => new NodeWriterOwnership(root).acquire(), /ALBOT_WRITER_CUTOVER_TO_BRIDGE/);
  assert.equal(fs.existsSync(path.join(root, WRITER_LEASE_FILE)), false);
});

test('unknown or malformed ownership never falls back to Node', t => {
  for (const contents of ['{', JSON.stringify({ schemaVersion: 1, owner: 'unknown' })]) {
    const root = tempRoot(t);
    fs.writeFileSync(path.join(root, WRITER_OWNER_FILE), contents);
    assert.throws(() => new NodeWriterOwnership(root).acquire());
    assert.equal(fs.existsSync(path.join(root, WRITER_LEASE_FILE)), false);
  }
});

test('lost lease or changed ownership blocks writes', t => {
  const root = tempRoot(t);
  const active = new NodeWriterOwnership(root).acquire();
  fs.writeFileSync(path.join(root, WRITER_OWNER_FILE), JSON.stringify({ schemaVersion: 1, owner: 'bridge' }));
  assert.throws(() => active.assertOwned(), /ALBOT_WRITER_OWNERSHIP_LOST/);
  assert.throws(() => active.release(), /ALBOT_WRITER_OWNERSHIP_LOST/);
  assert.ok(fs.existsSync(path.join(root, WRITER_LEASE_FILE)));
});

test('HTTP account and telemetry writes stop when ownership is lost', async t => {
  const root = tempRoot(t);
  const lease = new NodeWriterOwnership(path.join(root, 'state')).acquire();
  const app = createTelemetryServer({
    stateRoot: path.join(root, 'state'), root: path.join(root, 'telemetry'), writerLease: lease
  });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const telemetryBody = JSON.stringify({ records: [{ atMs: Date.now(), character: { name: 'My_Mage' } }] });
    const first = await fetch(base + '/v1/telemetry', { method: 'POST', body: telemetryBody });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).accepted, 1);
    fs.writeFileSync(path.join(root, 'state', WRITER_OWNER_FILE),
      JSON.stringify({ schemaVersion: 1, owner: 'bridge' }));
    const denied = await fetch(base + '/v1/telemetry', { method: 'POST', body: telemetryBody });
    assert.equal(denied.status, 423);
    const accountDenied = await fetch(base + '/v1/state/account', { method: 'POST', body: '{}' });
    assert.equal(accountDenied.status, 423);
  } finally {
    await assert.rejects(app.close(), /ALBOT_WRITER_OWNERSHIP_LOST/);
    // Deliberately retain the invalidated lease for operator reconciliation.
  }
});
