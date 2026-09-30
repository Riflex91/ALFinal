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

function makeRoster(localName, names, state = {}) {
  return {
    refresh: () => {
      const online = new Set(Array.isArray(state.onlineNames) ? state.onlineNames.map(String) : names.map(String));
      if (state.disconnected === true) online.delete(String(localName));
      else online.add(String(localName));
      return {
        accountStateAvailable: true,
        onlineStateAvailable: true,
        activeStateAvailable: true,
        accountCharacters: names.map(name => ({
          name,
          ctype: name.includes('Merchant') ? 'merchant' : 'ranger',
          online: online.has(String(name))
        })),
        onlineCharacterNames: [...online].sort(),
        activeCharacterNames: [localName],
        runnerActiveCharacterNames: [localName]
      };
    }
  };
}

function createMemoryStorage(seed = new Map()) {
  return {
    get: key => seed.has(String(key)) ? seed.get(String(key)) : null,
    set: (key, value) => { seed.set(String(key), String(value)); return true; },
    remove: key => seed.delete(String(key)),
    map: seed
  };
}

function makeContext(name, names, network, state, nowRef, options = {}) {
  const intervals = new Map();
  let intervalSeq = 0;
  const timeouts = new Set();
  const characterListeners = new Map();
  let characterListenerSeq = 0;
  const character = {
    name,
    on(event, fn) {
      const id = ++characterListenerSeq;
      characterListeners.set(id, { event: String(event), fn });
      return id;
    },
    remove(id) {
      characterListeners.delete(id);
    },
    __emit(event, payload) {
      for (const row of characterListeners.values()) {
        if (row.event === String(event)) row.fn(clone(payload));
      }
    }
  };
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    character,
    server_region: 'EU',
    server_identifier: 'I',
    parent: null,
    on_cm: null,
    send_cm(target, payload) {
      if (options.dropCm === true) return { receivers: [String(target)], dropped: true };
      const peer = network.get(String(target));
      if (!peer) throw new Error('TARGET_UNAVAILABLE:' + target);
      if (peer.character && typeof peer.character.__emit === 'function') {
        peer.character.__emit('cm', { name, message: clone(payload) });
      } else if (typeof peer.on_cm === 'function') {
        peer.on_cm(name, clone(payload));
      } else {
        throw new Error('TARGET_UNAVAILABLE:' + target);
      }
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
    roster: makeRoster(name, names, state),
    storage: options.storage || null,
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
      lifecycleAutonomyEnabled: state.autonomyEnabled === true,
      fullAutonomyEnabled: state.fullAutonomyEnabled === true,
      fullAutonomyDesiredCharacterNames: Array.isArray(state.fullAutonomyDesiredCharacterNames)
        ? state.fullAutonomyDesiredCharacterNames.slice()
        : [],
      fullAutonomyDesiredSource: state.fullAutonomyDesiredSource || null,
      fullAutonomyDesiredChangedAtMs: state.fullAutonomyDesiredChangedAtMs || null,
      characterDisconnectCapable: state.characterDisconnectCapable === true,
      characterNavigateCapable: state.characterNavigateCapable === true,
      version: '0.19.0-h19'
    }),
    startRuntime: async () => {
      if (state.emergencyStopLatched) throw new Error('ALBOT_START_BLOCKED_BY_EMERGENCY_STOP');
      if (!state.running) { state.running = true; state.runEpoch += 1; }
    },
    stopRuntime: async () => { state.running = false; },
    disconnectLocal: () => {
      state.disconnects = (state.disconnects || 0) + 1;
      state.disconnected = true;
    },
    navigateCharacterLocal: desiredName => {
      state.navigations = state.navigations || [];
      state.navigations.push(String(desiredName));
      state.navigatedTo = String(desiredName);
    },
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
  return { ctx, transport, intervals, timeouts, characterListeners };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('H26 cross-window transport prefers the current character cm event and removes it on destroy', () => {
  const names = ['My_Ranger1'];
  const network = new Map();
  const nowRef = { value: 800 };
  const state = { running: true, runEpoch: 1, emergencyStopLatched: false };
  const setup = makeContext('My_Ranger1', names, network, state, nowRef);

  setup.transport.install();
  assert.equal(setup.transport.status().receiveMode, 'character-event');
  assert.equal(setup.characterListeners.size, 1);
  assert.equal(setup.ctx.on_cm, null, 'legacy on_cm must remain untouched when character events are available');

  setup.transport.destroy();
  assert.equal(setup.characterListeners.size, 0);
});

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
  assert.equal(peer.lifecycleAutonomyEnabled, false);
  assert.equal(peer.fullAutonomyEnabled, false);
  assert.equal(a.transport.status().freshPeers.length, 1);

  a.transport.destroy();
  b.transport.destroy();
});

test('H26 cross-window heartbeat exposes Full Autonomy readiness', () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 1500 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, fullAutonomyEnabled: true };
  const bState = {
    running: true,
    runEpoch: 2,
    emergencyStopLatched: false,
    fullAutonomyEnabled: true,
    fullAutonomyDesiredCharacterNames: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'],
    fullAutonomyDesiredSource: 'merchant-authority',
    fullAutonomyDesiredChangedAtMs: 1499
  };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Merchant', names, network, bState, nowRef);

  a.transport.install();
  b.transport.install();
  b.transport.broadcastHeartbeat();

  const peer = a.transport.freshPeer('My_Merchant');
  assert.ok(peer);
  assert.equal(peer.running, true);
  assert.equal(peer.fullAutonomyEnabled, true);
  assert.deepEqual(Array.from(peer.fullAutonomyDesiredCharacterNames), ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.equal(peer.fullAutonomyDesiredSource, 'merchant-authority');
  assert.equal(peer.fullAutonomyDesiredChangedAtMs, 1499);

  a.transport.destroy();
  b.transport.destroy();
});

test('H28 shared-storage fallback keeps Merchant authority fresh when send_cm silently drops heartbeats', () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 1750 };
  const storage = createMemoryStorage();
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, fullAutonomyEnabled: true };
  const bState = {
    running: true,
    runEpoch: 2,
    emergencyStopLatched: false,
    fullAutonomyEnabled: true,
    fullAutonomyDesiredCharacterNames: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'],
    fullAutonomyDesiredSource: 'merchant-authority',
    fullAutonomyDesiredChangedAtMs: 1749
  };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef, { storage, dropCm: true });
  const b = makeContext('My_Merchant', names, network, bState, nowRef, { storage, dropCm: true });

  a.transport.install();
  b.transport.install();
  b.transport.broadcastHeartbeat();

  const peer = a.transport.freshPeer('My_Merchant');
  assert.ok(peer);
  assert.equal(peer.sessionId, 'session-My_Merchant');
  assert.equal(peer.fullAutonomyEnabled, true);
  assert.equal(peer.fullAutonomyDesiredSource, 'merchant-authority');
  assert.deepEqual(Array.from(peer.fullAutonomyDesiredCharacterNames), ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.equal(a.transport.status().sharedStorageFallback, true);
  assert.ok(a.transport.status().metrics.sharedPeerLoads >= 1);

  a.transport.destroy();
  b.transport.destroy();
});

test('H28 shared-storage mailbox settles lifecycle commands when send_cm silently drops them', async () => {
  const names = ['My_Ranger1', 'My_Merchant'];
  const network = new Map();
  const nowRef = { value: 1800 };
  const storage = createMemoryStorage();
  const aState = { running: true, runEpoch: 2, emergencyStopLatched: false };
  const bState = { running: true, runEpoch: 7, emergencyStopLatched: false };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef, { storage, dropCm: true });
  const b = makeContext('My_Merchant', names, network, bState, nowRef, { storage, dropCm: true });

  a.transport.install();
  b.transport.install();
  a.transport.broadcastHeartbeat();
  b.transport.broadcastHeartbeat();
  assert.ok(a.transport.freshPeer('My_Merchant'));

  const stop = a.transport.requestRuntimeState('My_Merchant', false);
  assert.equal(stop.state, 'DISPATCHED');
  b.transport._pollSharedMailbox();
  await flush();
  a.transport._pollSharedMailbox();
  await flush();

  const settlement = await stop.value;
  assert.equal(settlement.success, true);
  assert.equal(bState.running, false);
  assert.ok(a.transport.status().metrics.sharedMessagesPublished >= 1);
  assert.ok(a.transport.status().metrics.sharedMessagesReceived >= 1);
  assert.ok(b.transport.status().metrics.sharedMessagesReceived >= 1);

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

test('H24 cross-window character disconnect settles before the target self-disconnects', async () => {
  const names = ['My_Ranger1', 'My_Priest'];
  const network = new Map();
  const nowRef = { value: 2500 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, characterDisconnectCapable: true };
  const bState = { running: true, runEpoch: 3, emergencyStopLatched: false, characterDisconnectCapable: true, disconnects: 0 };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Priest', names, network, bState, nowRef);
  a.transport.install();
  b.transport.install();
  a.transport.broadcastHeartbeat();
  b.transport.broadcastHeartbeat();

  const peer = a.transport.freshPeer('My_Priest');
  assert.equal(peer.characterDisconnectCapable, true);
  const request = a.transport.requestCharacterDisconnect('My_Priest');
  assert.equal(request.state, 'DISPATCHED');
  const settlement = await request.value;
  assert.equal(settlement.success, true);
  assert.equal(settlement.reason, 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_ACCEPTED');
  assert.equal(settlement.details.completionEvidence, 'ACCOUNT_ROSTER_OFFLINE_REQUIRED');
  assert.equal(bState.disconnects, 0, 'disconnect must not run before the CM settlement is emitted');

  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(bState.disconnects, 1);
  assert.equal(bState.disconnected, true);
  a.transport.destroy();
  b.transport.destroy();
});

test('H24 cross-window character disconnect is unavailable without explicit target capability', () => {
  const names = ['My_Ranger1', 'My_Priest'];
  const network = new Map();
  const nowRef = { value: 2700 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, characterDisconnectCapable: true };
  const bState = { running: true, runEpoch: 3, emergencyStopLatched: false, characterDisconnectCapable: false };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Priest', names, network, bState, nowRef);
  a.transport.install();
  b.transport.install();
  b.transport.broadcastHeartbeat();
  const request = a.transport.requestCharacterDisconnect('My_Priest');
  assert.equal(request.state, 'UNAVAILABLE');
  assert.equal(request.error.message, 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_CAPABILITY_MISSING');
  assert.equal(bState.disconnects || 0, 0);
  a.transport.destroy();
  b.transport.destroy();
});

test('H25 cross-window browser navigation settles before the page navigation destroys the old runtime', async () => {
  const names = ['My_Ranger1', 'My_Priest'];
  const network = new Map();
  const nowRef = { value: 2850 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, characterNavigateCapable: true };
  const bState = { running: true, runEpoch: 3, emergencyStopLatched: false, characterDisconnectCapable: true, characterNavigateCapable: true, navigations: [] };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Priest', names, network, bState, nowRef);
  a.transport.install();
  b.transport.install();
  a.transport.broadcastHeartbeat();
  b.transport.broadcastHeartbeat();

  const peer = a.transport.freshPeer('My_Priest');
  assert.equal(peer.characterNavigateCapable, true);
  const request = a.transport.requestCharacterNavigation('My_Priest', 'My_Ranger1');
  assert.equal(request.state, 'UNAVAILABLE', 'same/local desired target must not be reused as replacement');

  names.push('My_Mage');
  aState.onlineNames = ['My_Ranger1', 'My_Priest'];
  bState.onlineNames = ['My_Ranger1', 'My_Priest'];
  // Recreate with the complete owned roster while the desired replacement stays offline.
  a.transport.destroy();
  b.transport.destroy();
  const network2 = new Map();
  const a2 = makeContext('My_Ranger1', names, network2, aState, nowRef);
  const b2 = makeContext('My_Priest', names, network2, bState, nowRef);
  a2.transport.install();
  b2.transport.install();
  a2.transport.broadcastHeartbeat();
  b2.transport.broadcastHeartbeat();

  const dispatched = a2.transport.requestCharacterNavigation('My_Priest', 'My_Mage');
  assert.equal(dispatched.state, 'DISPATCHED');
  const settlement = await dispatched.value;
  assert.equal(settlement.success, true);
  assert.equal(settlement.reason, 'H27_CROSS_WINDOW_SAFE_CHARACTER_ROTATION_ACCEPTED');
  assert.equal(settlement.details.sourceOfflineConfirmed, true);
  assert.equal(settlement.details.desiredCharacterName, 'My_Mage');
  assert.equal(settlement.details.completionEvidence, 'OLD_ACCOUNT_OFFLINE_AND_NEW_CHARACTER_PRESENT');
  assert.deepEqual(bState.navigations, [], 'navigation must occur only after the settlement is emitted');

  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(bState.disconnects, 1);
  assert.equal(bState.disconnected, true);
  assert.deepEqual(bState.navigations, ['My_Mage']);
  assert.equal(bState.navigatedTo, 'My_Mage');
  a2.transport.destroy();
  b2.transport.destroy();
});

test('H25 cross-window browser navigation is unavailable without explicit navigation capability', () => {
  const names = ['My_Ranger1', 'My_Priest', 'My_Mage'];
  const network = new Map();
  const nowRef = { value: 2900 };
  const aState = {
    running: true,
    runEpoch: 1,
    emergencyStopLatched: false,
    characterNavigateCapable: true,
    onlineNames: ['My_Ranger1', 'My_Priest']
  };
  const bState = {
    running: true,
    runEpoch: 3,
    emergencyStopLatched: false,
    characterNavigateCapable: false,
    onlineNames: ['My_Ranger1', 'My_Priest']
  };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef);
  const b = makeContext('My_Priest', names, network, bState, nowRef);
  a.transport.install();
  b.transport.install();
  b.transport.broadcastHeartbeat();
  const request = a.transport.requestCharacterNavigation('My_Priest', 'My_Mage');
  assert.equal(request.state, 'UNAVAILABLE');
  assert.equal(request.error.message, 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_CAPABILITY_MISSING');
  assert.deepEqual(bState.navigations || [], []);
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


test('H19 cross-window party loss rejects a remote target with lifecycle autonomy enabled', async () => {
  const names = ['My_Ranger1', 'My_Merchant'], network = new Map(), nowRef = { value: 7000 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, autonomyEnabled: false };
  const bState = {
    running: true, runEpoch: 1, emergencyStopLatched: false, autonomyEnabled: true,
    party: { available: true, partyId: 'party-3', leader: 'My_Ranger1', memberNames: ['My_Ranger1', 'My_Merchant'], foreignMemberNames: [], size: 2 },
    partyActions: []
  };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef), b = makeContext('My_Merchant', names, network, bState, nowRef);
  a.transport.install(); b.transport.install(); a.transport.broadcastHeartbeat(); b.transport.broadcastHeartbeat();
  assert.equal(a.transport.freshPeer('My_Merchant').lifecycleAutonomyEnabled, true);

  const leave = a.transport.requestPartyLeave('My_Merchant');
  assert.equal(leave.state, 'DISPATCHED');
  const settlement = await leave.value; await flush();
  assert.equal(settlement.success, false);
  assert.equal(settlement.reason, 'H19_CROSS_WINDOW_PARTY_AUTONOMY_ACTIVE');
  assert.equal(bState.party.partyId, 'party-3');
  assert.deepEqual(bState.partyActions, []);
  a.transport.destroy(); b.transport.destroy();
});

test('H19 cross-window preserves recovery authority after an UNKNOWN leave dispatch', async () => {
  const names = ['My_Ranger1', 'My_Merchant'], network = new Map(), nowRef = { value: 8000 };
  const aState = { running: true, runEpoch: 1, emergencyStopLatched: false, autonomyEnabled: false };
  const bState = {
    running: true, runEpoch: 1, emergencyStopLatched: false, autonomyEnabled: false,
    party: { available: true, partyId: 'party-4', leader: 'My_Ranger1', memberNames: ['My_Ranger1', 'My_Merchant'], foreignMemberNames: [], size: 2 },
    partyActions: []
  };
  const a = makeContext('My_Ranger1', names, network, aState, nowRef), b = makeContext('My_Merchant', names, network, bState, nowRef);
  b.transport.leavePartyLocal = () => { throw new Error('H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN:leave_party'); };
  a.transport.install(); b.transport.install(); a.transport.broadcastHeartbeat(); b.transport.broadcastHeartbeat();

  const leave = a.transport.requestPartyLeave('My_Merchant');
  assert.equal(leave.state, 'DISPATCHED');
  const settlement = await leave.value; await flush();
  assert.equal(settlement.success, false);
  assert.equal(settlement.reason, 'H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN:leave_party');
  const lease = b.transport.status().partyRecoveryLease;
  assert.ok(lease);
  assert.equal(lease.leader, 'My_Ranger1');
  assert.equal(lease.targetName, 'My_Merchant');
  assert.equal(bState.party.partyId, 'party-4');
  a.transport.destroy(); b.transport.destroy();
});
