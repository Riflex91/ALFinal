import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/cross-window-lifecycle.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeRoster(localName, names) {
  return {
    refresh: () => ({
      accountStateAvailable: true,
      onlineStateAvailable: true,
      activeStateAvailable: true,
      accountCharacters: names.map(name => ({ name, ctype: name.includes('Merchant') ? 'merchant' : 'ranger', online: true })),
      onlineCharacterNames: names.slice(),
      activeCharacterNames: [localName],
      runnerActiveCharacterNames: [localName]
    })
  };
}

function makeContext(name, names, network, state, nowRef) {
  const intervals = new Map();
  let intervalSeq = 0;
  const timeouts = new Set();
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    character: { name },
    server_region: 'EU',
    server_identifier: 'I',
    parent: null,
    on_cm: null,
    send_cm(target, payload) {
      const peer = network.get(String(target));
      if (!peer || typeof peer.on_cm !== 'function') throw new Error('TARGET_UNAVAILABLE:' + target);
      peer.on_cm(name, clone(payload));
      return { receivers: [String(target)] };
    },
    setInterval(fn, ms) {
      const id = ++intervalSeq;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) {
      const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms);
      timeouts.add(id);
      return id;
    },
    clearTimeout(id) { clearTimeout(id); timeouts.delete(id); },
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  ctx.parent = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'cross-window-lifecycle.js' });
  const Transport = ctx.__ALBOT_INTERNALS__.H19CrossWindowLifecycleTransport;
  const transport = new Transport({
    root: ctx,
    roster: makeRoster(name, names),
    now: () => nowRef.value,
    heartbeatIntervalMs: 1500,
    staleMs: 5000,
    settlementTimeoutMs: 5000,
    sessionId: 'session-' + name,
    getLocalState: () => ({
      localName: name,
      running: state.running,
      runEpoch: state.runEpoch,
      emergencyStopLatched: state.emergencyStopLatched,
      version: '0.19.0-h19'
    }),
    startRuntime: async () => {
      if (state.emergencyStopLatched) throw new Error('ALBOT_START_BLOCKED_BY_EMERGENCY_STOP');
      if (!state.running) { state.running = true; state.runEpoch += 1; }
    },
    stopRuntime: async () => { state.running = false; },
    getPartyState: () => clone(state.party || { available: false, partyId: null, leader: null, memberNames: [], foreignMemberNames: [], size: 0 }),
    leavePartyLocal: async () => {
      const party = state.party;
      if (!party || !party.partyId) throw new Error('NOT_IN_PARTY');
      state.partyActions = state.partyActions || [];
      state.partyActions.push({ action: 'leave_party' });
      state.previousPartyId = party.partyId;
      state.party = { available: false, partyId: null, leader: null, memberNames: [], foreignMemberNames: [], size: 0 };
    },
    requestPartyJoinLocal: async leaderName => {
      state.partyActions = state.partyActions || [];
      state.partyActions.push({ action: 'send_party_request', leaderName: String(leaderName) });
      state.party = { available: true, partyId: state.previousPartyId || 'party-test', leader: String(leaderName), memberNames: [String(leaderName), name], foreignMemberNames: [], size: 2 };
    }
  });
  network.set(name, ctx);
  return { ctx, transport, intervals, timeouts };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('H19 cross-window heartbeat timer unrefs when the host timer supports it', () => {
  const names = ['My_Ranger1'];
  const network = new Map();
  const nowRef = { value: 900 };
  const state = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const setup = makeContext('My_Ranger1', names, network, state, nowRef);
  let unrefCalls = 0;
  let cleared = 0;
  const timer = { unref() { unrefCalls += 1; } };
  setup.transport.setIntervalFn = () => timer;
  setup.transport.clearIntervalFn = value => {
    assert.equal(value, timer);
    cleared += 1;
  };

  setup.transport.install();
  assert.equal(unrefCalls, 1);
  setup.transport.destroy();
  assert.equal(cleared, 1);
});

test('H19 cross-window transport discovers separate browser runtimes by CM heartbeat', () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 1000 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const bState = { running: true, runEpoch: 4, emergencyStopLatched: false };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Merchant', names, network, bState, nowRef);

  a.transport.install();
  b.transport.install();
  a.transport.broadcastHeartbeat();
  b.transport.broadcastHeartbeat();

  const peer = a.transport.freshPeer('My_Merchant');
  assert.ok(peer);
  assert.equal(peer.sessionId, 'session-My_Merchant');
  assert.equal(peer.running, true);
  assert.equal(peer.runEpoch, 4);
  assert.equal(a.transport.status().freshPeers.length, 1);

  a.transport.destroy();
  b.transport.destroy();
});

test('H19 cross-window STOP and START settle against the target runtime without changing character online state', async () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 2000 };
  const aState = { running: true, runEpoch: 2, emergencyStopLatched: false };
  const bState = { running: true, runEpoch: 7, emergencyStopLatched: false };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Merchant', names, network, bState, nowRef);

  a.transport.install();
  b.transport.install();
  a.transport.broadcastHeartbeat();
  b.transport.broadcastHeartbeat();

  const stop = a.transport.requestRuntimeState('My_Merchant', false);
  assert.equal(stop.state, 'DISPATCHED');
  const stopSettlement = await stop.value;
  await flush();
  assert.equal(stopSettlement.success, true);
  assert.equal(bState.running, false);
  assert.equal(a.transport.freshPeer('My_Merchant').running, false);
  assert.equal(a.transport.status().metrics.commandsSent, 1);
  assert.equal(a.transport.status().metrics.settlementsReceived, 1);

  const start = a.transport.requestRuntimeState('My_Merchant', true);
  assert.equal(start.state, 'DISPATCHED');
  const startSettlement = await start.value;
  await flush();
  assert.equal(startSettlement.success, true);
  assert.equal(bState.running, true);
  assert.equal(bState.runEpoch, 8);
  assert.equal(a.transport.freshPeer('My_Merchant').running, true);
  assert.equal(a.transport.status().metrics.commandsSent, 2);
  assert.equal(a.transport.status().metrics.settlementsSucceeded, 2);

  a.transport.destroy();
  b.transport.destroy();
});

test('H19 cross-window transport rejects stale-session commands fail-closed', async () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 3000 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const bState = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Merchant', names, network, bState, nowRef);

  a.transport.install();
  b.transport.install();
  b.transport.broadcastHeartbeat();
  const observed = a.transport.freshPeer('My_Merchant');
  assert.equal(observed.sessionId, 'session-My_Merchant');

  a.transport.peers.set('My_Merchant', { ...observed, sessionId: 'stale-session', aliveUntilMs: nowRef.value + 5000 });
  const stop = a.transport.requestRuntimeState('My_Merchant', false);
  assert.equal(stop.state, 'DISPATCHED');
  const settlement = await stop.value;
  await flush();
  assert.equal(settlement.success, false);
  assert.equal(settlement.reason, 'H19_CROSS_WINDOW_TARGET_SESSION_MISMATCH');
  assert.equal(bState.running, true);
  assert.equal(b.transport.status().metrics.rejectedSessionMismatch, 1);

  a.transport.destroy();
  b.transport.destroy();
});

test('H19 cross-window CM handler preserves an existing non-H19 on_cm handler', () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 4000 };
  const state = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const a = makeContext('My_Ranger1', names, network, state, nowRef);
  let previousCalls = 0;
  a.ctx.on_cm = () => { previousCalls += 1; return 'previous'; };

  a.transport.install();
  assert.equal(a.ctx.on_cm('Other', { hello: 'world' }), 'previous');
  assert.equal(previousCalls, 1);
  a.transport.destroy();
  assert.equal(typeof a.ctx.on_cm, 'function');
  assert.equal(a.ctx.on_cm('Other', {}), 'previous');
  assert.equal(previousCalls, 2);
});


test('H19 cross-window party recovery leaves only a nonleader and consumes one-shot rejoin authority', async () => {
  const names = ['My_Ranger1', 'My_Merchant'], network = new Map(), nowRef = { value: 5000 };
  const aState = { running: true, runEpoch: 2, emergencyStopLatched: false };
  const bState = { running: true, runEpoch: 3, emergencyStopLatched: false, party: { available: true, partyId: 'party-1', leader: 'My_Ranger1', memberNames: ['My_Ranger1', 'My_Merchant'], foreignMemberNames: [], size: 2 }, partyActions: [] };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef), b = makeContext('My_Merchant', names, network, bState, nowRef);
  a.transport.install(); b.transport.install(); a.transport.broadcastHeartbeat(); b.transport.broadcastHeartbeat();
  const leave = a.transport.requestPartyLeave('My_Merchant');
  assert.equal(leave.state, 'DISPATCHED');
  const leaveSettlement = await leave.value; await flush();
  assert.equal(leaveSettlement.success, true); assert.equal(leaveSettlement.reason, 'H19_CROSS_WINDOW_PARTY_LEFT');
  assert.equal(bState.party.partyId, null); assert.deepEqual(bState.partyActions, [{ action: 'leave_party' }]);
  assert.equal(b.transport.status().partyRecoveryLease.leader, 'My_Ranger1');
  const join = a.transport.requestPartyJoin('My_Merchant');
  assert.equal(join.state, 'DISPATCHED');
  const joinSettlement = await join.value; await flush();
  assert.equal(joinSettlement.success, true); assert.equal(joinSettlement.reason, 'H19_CROSS_WINDOW_PARTY_JOINED');
  assert.equal(bState.party.leader, 'My_Ranger1'); assert.deepEqual(bState.party.memberNames, ['My_Ranger1', 'My_Merchant']);
  assert.equal(b.transport.status().partyRecoveryLease, null);
  assert.deepEqual(bState.partyActions, [{ action: 'leave_party' }, { action: 'send_party_request', leaderName: 'My_Ranger1' }]);
  const retry = a.transport.requestPartyJoin('My_Merchant');
  assert.equal(retry.state, 'DISPATCHED');
  const retrySettlement = await retry.value; await flush();
  assert.equal(retrySettlement.success, false); assert.equal(retrySettlement.reason, 'H19_CROSS_WINDOW_PARTY_RECOVERY_AUTHORITY_UNAVAILABLE');
  assert.equal(bState.partyActions.filter(row => row.action === 'send_party_request').length, 1);
  a.transport.destroy(); b.transport.destroy();
});

test('H19 cross-window party loss command protects the party leader', async () => {
  const names = ['My_Ranger1', 'My_Merchant'], network = new Map(), nowRef = { value: 6000 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const bState = { running: true, runEpoch: 1, emergencyStopLatched: false, party: { available: true, partyId: 'party-2', leader: 'My_Merchant', memberNames: ['My_Merchant', 'My_Ranger1'], foreignMemberNames: [], size: 2 }, partyActions: [] };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef), b = makeContext('My_Merchant', names, network, bState, nowRef);
  a.transport.install(); b.transport.install(); a.transport.broadcastHeartbeat(); b.transport.broadcastHeartbeat();
  const leave = a.transport.requestPartyLeave('My_Merchant');
  assert.equal(leave.state, 'DISPATCHED');
  const settlement = await leave.value; await flush();
  assert.equal(settlement.success, false); assert.equal(settlement.reason, 'H19_CROSS_WINDOW_PARTY_LEADER_PROTECTED');
  assert.equal(bState.party.partyId, 'party-2'); assert.deepEqual(bState.partyActions, []);
  a.transport.destroy(); b.transport.destroy();
});
