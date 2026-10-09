import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectReadOnlySsdWitness } from '../scripts/ssd-readonly-witness.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-readonly-witness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const telemetryRoot = path.join(root, 'telemetry');
  fs.mkdirSync(path.join(stateRoot, 'account-profiles'), { recursive: true });
  fs.mkdirSync(path.join(telemetryRoot, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(telemetryRoot, 'daily'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"node"}');
  fs.writeFileSync(path.join(stateRoot, 'account-profiles', 'Mage.json'), '{"name":"Mage"}');
  return { stateRoot, telemetryRoot, root };
}

async function listen(t, responder) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    responder(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, calls };
}

test('read-only witness collects recognized localhost services without touching account files', async t => {
  const f = fixture(t);
  const account = path.join(f.stateRoot, 'account-profiles', 'Mage.json');
  const before = fs.readFileSync(account);
  const node = await listen(t, (_, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, store: {}, stateStore: {}, secret: 'DO_NOT_LOG' }));
  });
  const bridge = await listen(t, (_, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, service: 'ALFinal Windows Bridge native SSD',
      processId: 123, durableStore: { schemaVersion: 1 }
    }));
  });
  const result = await collectReadOnlySsdWitness({
    stateRoot: f.stateRoot, telemetryRoot: f.telemetryRoot,
    nodePort: node.port, bridgePort: bridge.port
  });
  assert.equal(result.node.state, 'RECOGNIZED_HEALTHY');
  assert.equal(result.bridge.state, 'RECOGNIZED_HEALTHY');
  assert.equal(result.bridge.processId, 123);
  assert.equal(result.disk.owner, 'node');
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.liveGameplayVerified, false);
  assert.deepEqual(node.calls, [{ method: 'GET', url: '/health' }]);
  assert.deepEqual(bridge.calls, [{ method: 'GET', url: '/health' }]);
  assert.deepEqual(fs.readFileSync(account), before);
  assert.equal(JSON.stringify(result).includes('DO_NOT_LOG'), false);
  assert.equal(JSON.stringify(result).includes('Mage'), false);
});

test('witness never treats spoofed service, stale lease or malformed health as cutover permission', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stateRoot, 'writer-lease.json'),
    '{"schemaVersion":1,"owner":"node","token":"stale-lease"}');
  const node = await listen(t, (_, res) => res.end('{'));
  const bridge = await listen(t, (_, res) => res.end('{"ok":true}'));
  const result = await collectReadOnlySsdWitness({
    stateRoot: f.stateRoot, telemetryRoot: f.telemetryRoot,
    nodePort: node.port, bridgePort: bridge.port
  });
  assert.equal(result.node.state, 'INVALID_HEALTH_JSON');
  assert.equal(result.bridge.state, 'UNVERIFIED_SERVICE');
  assert.ok(result.disk.blockers.includes('WRITER_LEASE_PRESENT_ACTIVE_OR_STALE'));
  assert.equal(result.cutoverAuthorized, false);
  assert.ok(fs.existsSync(path.join(f.stateRoot, 'writer-lease.json')));
});

test('witness restricts port overrides and cannot probe two services on the same port', async t => {
  const f = fixture(t);
  await assert.rejects(
    collectReadOnlySsdWitness({
      stateRoot: f.stateRoot, telemetryRoot: f.telemetryRoot, nodePort: -1
    }),
    /SSD_WITNESS_INVALID_PORT/
  );
  await assert.rejects(
    collectReadOnlySsdWitness({
      stateRoot: f.stateRoot, telemetryRoot: f.telemetryRoot,
      nodePort: 17391, bridgePort: 17391
    }),
    /SSD_WITNESS_DISTINCT_PORTS_REQUIRED/
  );
});

test('witness reports oversized health responses without leaking service body', async t => {
  const f = fixture(t);
  const node = await listen(t, (_, res) => res.end('X'.repeat(9000)));
  const bridge = await listen(t, (_, res) => res.end('{"ok":false}'));
  const result = await collectReadOnlySsdWitness({
    stateRoot: f.stateRoot, telemetryRoot: f.telemetryRoot,
    nodePort: node.port, bridgePort: bridge.port
  });
  assert.equal(result.node.state, 'OVERSIZED_RESPONSE');
  assert.equal(result.bridge.state, 'UNVERIFIED_SERVICE');
  assert.equal(result.cutoverAuthorized, false);
});
