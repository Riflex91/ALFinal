import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadBridge() {
  const source = fs.readFileSync(new URL('../src/windows-bridge.js', import.meta.url), 'utf8');
  const context = { console, __ALBOT_INTERNALS__: {}, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'windows-bridge.js' });
  return context.__ALBOT_INTERNALS__;
}

function fixture() {
  const listeners = new Map();
  const bus = {
    on(type, fn) {
      listeners.set(type, fn);
      return () => listeners.delete(type);
    },
    emit(type, payload) {
      const fn = listeners.get(type);
      if (fn) fn(payload);
    }
  };
  const logs = [
    { at: '2026-09-28T12:00:00.000Z', level: 'INFO', message: 'boot', data: { ok: true } }
  ];
  const runtime = {
    version: '0.26.1-h26',
    logger: { list: () => logs },
    bus,
    status: () => ({ product: 'AL Bot', version: '0.26.1-h26', running: true }),
    diagnostics: () => ({ schemaVersion: 3, runtime: { running: true } }),
    game: { snapshot: () => ({ character: { name: 'FarmerA', ctype: 'ranger' } }) },
    observer: { hostBeacon: () => ({ alive: true, seq: 7 }) }
  };
  return { runtime, bus };
}

test('V6 bridge identity is generation locked and transport-only', () => {
  const ns = loadBridge();
  const { runtime } = fixture();
  const bridge = new ns.WindowsBridgeTransportAdapter({ runtime });
  const identity = bridge.identity();

  assert.equal(identity.product, 'AL Bot');
  assert.equal(identity.generation, 6);
  assert.equal(identity.bridgeProtocol, 'albot-v6-bridge-v1');
  assert.equal(identity.runtimeVersion, '0.26.1-h26');
  assert.equal(identity.transportOnly, true);
  assert.equal(identity.gameplayActionAuthority, false);
  assert.equal(identity.acceptsLegacyGenerations, false);
});

test('V6 bridge exposes bounded sequence telemetry with acknowledgement', () => {
  const ns = loadBridge();
  const { runtime, bus } = fixture();
  const bridge = new ns.WindowsBridgeTransportAdapter({ runtime, bus, logger: runtime.logger, limit: 100 });

  bus.emit('log', { at: '2026-09-28T12:00:01.000Z', level: 'WARN', message: 'second', data: { value: 2 } });
  const batch = bridge.events(0, 10);

  assert.equal(batch.type, 'ALBOT_V6_DEBUG_EVENTS');
  assert.equal(batch.events.length, 2);
  assert.equal(batch.events[0].seq, 1);
  assert.equal(batch.events[1].seq, 2);
  assert.equal(batch.events[1].severity, 'warning');

  const ack = bridge.ackThrough(1);
  assert.equal(ack.type, 'ALBOT_V6_TELEMETRY_ACK');
  assert.equal(ack.supported, true);
  assert.equal(ack.acknowledged, 1);
  assert.equal(ack.remaining, 1);
  assert.equal(bridge.peekTelemetry(10)[0].seq, 2);
});

test('V6 bridge snapshot never grants gameplay authority', () => {
  const ns = loadBridge();
  const { runtime } = fixture();
  const bridge = new ns.WindowsBridgeTransportAdapter({ runtime });
  const snapshot = bridge.snapshot({ deep: true });

  assert.equal(snapshot.type, 'ALBOT_V6_DEBUG_SNAPSHOT');
  assert.equal(snapshot.identity.generation, 6);
  assert.equal(snapshot.identity.gameplayActionAuthority, false);
  assert.equal(snapshot.character.name, 'FarmerA');
  assert.equal(snapshot.diagnostics.schemaVersion, 3);
  assert.equal(bridge.status().policies.noGenericRemoteEvaluate, true);
  assert.equal(bridge.status().policies.noEmbeddedCloudSecrets, true);
  assert.equal(bridge.status().policies.legacyV3V4V5TransportRejected, true);
});
