import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/lifecycle-recovery.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryStorage(seed) {
  const map = seed || new Map();
  return {
    map,
    get: key => map.has(key) ? map.get(key) : null,
    set: (key, value) => { map.set(key, String(value)); return true; },
    remove: key => { map.delete(key); return true; }
  };
}

function fixture(options = {}) {
  const state = options.state || {
    character: { name: 'My_Ranger', ctype: 'ranger', rip: !!options.dead },
    account: [
      { name: 'My_Ranger', ctype: 'ranger', online: true },
      { name: 'My_Priest', ctype: 'priest', online: true },
      { name: 'My_Merchant', ctype: 'merchant', online: true },
      { name: 'My_Warrior', ctype: 'warrior', online: true }
    ],
    online: new Set(options.onlineNames || options.activeNames || ['My_Ranger', 'My_Priest']),
    active: new Set(options.runnerActiveNames || options.activeNames || options.onlineNames || ['My_Ranger', 'My_Priest']),
    party: {
      partyId: options.partyId || (Array.isArray(options.partyMembers) && options.partyMembers.length ? 'party-1' : null),
      leader: options.partyLeader || (Array.isArray(options.partyMembers) && options.partyMembers.length ? options.partyMembers[0] : null),
      members: new Set(options.partyMembers || []),
      foreignMemberNames: clone(options.foreignPartyNames || [])
    },
    dispatches: []
  };
  const storage = options.storage || createMemoryStorage();

  const game = {
    snapshot: () => ({ available: true, character: clone(state.character) })
  };

  const roster = {
    refresh: () => ({
      observedAt: new Date().toISOString(),
      source: 'test',
      accountStateAvailable: options.accountUnavailable !== true,
      onlineStateAvailable: options.onlineUnavailable !== true && options.accountUnavailable !== true,
      activeStateAvailable: options.activeUnavailable !== true,
      local: { name: state.character.name, ctype: state.character.ctype, online: true, state: 'self' },
      characters: state.account.filter(row => state.online.has(row.name)).map(row => ({ ...clone(row), online: true, state: row.name === state.character.name ? 'self' : null })),
      accountCharacters: state.account.map(row => ({ ...clone(row), online: state.online.has(row.name) })),
      onlineCharacterNames: [...state.online].sort(),
      activeCharacterNames: [...state.active].sort(),
      runnerActiveCharacterNames: [...state.active].sort(),
      farmers: [],
      merchant: null,
      merchantCandidates: [],
      hardcodedNamesRequired: false
    }),
    status() { return this.refresh(); }
  };

  const party = {
    snapshot: () => ({
      schemaVersion: 1,
      available: !!state.party.partyId,
      partyId: state.party.partyId,
      leader: state.party.leader,
      memberNames: [...state.party.members],
      members: [...state.party.members].map(name => ({
        name,
        local: name === state.character.name,
        owned: state.account.some(row => row.name === name),
        visible: state.active.has(name),
        rip: name === state.character.name ? !!state.character.rip : false
      })),
      ownedMemberNames: [...state.party.members].filter(name => state.account.some(row => row.name === name)),
      ownedMembers: [...state.party.members]
        .filter(name => state.account.some(row => row.name === name))
        .map(name => ({ name, local: name === state.character.name, owned: true, visible: state.active.has(name), rip: false })),
      foreignMemberNames: clone(state.party.foreignMemberNames),
      coordinationEnabled: state.party.members.size >= 2 && state.party.foreignMemberNames.length === 0
    })
  };

  let resolvePending = null;
  let rejectPending = null;
  const actions = {
    available: name => !(Array.isArray(options.unavailableActions) && options.unavailableActions.includes(String(name))),
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', dispatched: true, error: { message: 'NETWORK_UNCERTAIN' } };

      if (name === 'start_character' && options.noMutation !== true) {
        if (options.startOnlyRunnerState !== true) state.online.add(String(args[0]));
        if (options.freezeRunnerActive !== true) state.active.add(String(args[0]));
      }
      if (name === 'stop_character' && options.noMutation !== true) {
        state.online.delete(String(args[0]));
        if (options.freezeRunnerActive !== true) state.active.delete(String(args[0]));
      }
      if (name === 'respawn' && options.noMutation !== true) state.character.rip = false;
      if (options.noMutation !== true && ['send_party_invite', 'send_party_request', 'accept_party_invite', 'accept_party_request'].includes(name)) {
        const target = String(args[0]);
        state.party.partyId = state.party.partyId || 'party-recovered';
        state.party.members.add(state.character.name);
        state.party.members.add(target);
        if (name === 'send_party_invite' || name === 'accept_party_request') state.party.leader = state.character.name;
        if (name === 'send_party_request' || name === 'accept_party_invite') state.party.leader = target;
      }

      if (options.neverSettle) return { id: 'act-' + state.dispatches.length, state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.manualSettlement) {
        const value = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
        return { id: 'act-' + state.dispatches.length, state: 'DISPATCHED', value };
      }
      if (options.rejectPromise) {
        const reason = options.rejectReason || 'PROMISE_REJECTED';
        const error = new Error(reason);
        error.reason = reason;
        return { id: 'act-' + state.dispatches.length, state: 'DISPATCHED', value: Promise.reject(error) };
      }
      if (options.serverReject) {
        return { id: 'act-' + state.dispatches.length, state: 'DISPATCHED', value: Promise.resolve({ success: false, reason: 'SERVER_REJECTED_TEST' }) };
      }
      return { id: 'act-' + state.dispatches.length, state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };

  const runtimePeers = new Map((options.crossWindowPeers || []).map(peer => [
    String(peer.name),
    {
      name: String(peer.name),
      sessionId: String(peer.sessionId || ('session-' + peer.name)),
      running: peer.running === true,
      runEpoch: Number(peer.runEpoch || 1),
      fullAutonomyEnabled: peer.fullAutonomyEnabled === true,
      characterDisconnectCapable: peer.characterDisconnectCapable === true,
      characterNavigateCapable: peer.characterNavigateCapable === true
    }
  ]));
  state.crossWindowDispatches = state.crossWindowDispatches || [];
  state.localNavigations = state.localNavigations || [];
  const crossWindow = options.crossWindowPeers ? {
    freshPeer(name) {
      const peer = runtimePeers.get(String(name));
      return peer ? clone(peer) : null;
    },
    freshPeers() {
      return [...runtimePeers.values()].map(clone);
    },
    requestRuntimeState(name, desiredRunning) {
      const peer = runtimePeers.get(String(name));
      if (!peer) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      }
      const desired = desiredRunning === true;
      state.crossWindowDispatches.push({ type: 'runtime-state', name: String(name), desiredRunning: desired, sessionId: peer.sessionId });
      if (options.crossWindowNoMutation !== true) {
        peer.running = desired;
        if (desired) peer.runEpoch += 1;
      }
      const response = {
        success: options.crossWindowReject !== true,
        reason: options.crossWindowReject ? 'CROSS_WINDOW_REJECTED_TEST' : 'CROSS_WINDOW_SETTLED_TEST',
        target: String(name),
        targetSessionId: peer.sessionId,
        state: { running: peer.running, runEpoch: peer.runEpoch }
      };
      return {
        id: 'cm-' + state.crossWindowDispatches.length,
        state: 'DISPATCHED',
        dispatched: true,
        value: options.crossWindowNeverSettle ? new Promise(() => {}) : Promise.resolve(response)
      };
    },
    requestCharacterDisconnect(name) {
      const peer = runtimePeers.get(String(name));
      if (!peer || peer.running !== true || peer.characterDisconnectCapable !== true) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_CAPABILITY_MISSING' } };
      }
      state.crossWindowDispatches.push({ type: 'disconnect-character', name: String(name), sessionId: peer.sessionId });
      if (options.crossWindowNoMutation !== true) {
        state.online.delete(String(name));
        state.active.delete(String(name));
      }
      return {
        id: 'cm-' + state.crossWindowDispatches.length,
        state: 'DISPATCHED',
        dispatched: true,
        value: options.crossWindowNeverSettle
          ? new Promise(() => {})
          : Promise.resolve({ success: true, reason: 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_ACCEPTED' })
      };
    },
    requestCharacterNavigation(name, desiredName) {
      const peer = runtimePeers.get(String(name));
      if (!peer || peer.running !== true || peer.characterNavigateCapable !== true || peer.characterDisconnectCapable !== true) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_CAPABILITY_MISSING' } };
      }
      state.crossWindowDispatches.push({
        type: 'navigate-character',
        name: String(name),
        desiredName: String(desiredName),
        sessionId: peer.sessionId
      });
      if (options.crossWindowNoMutation !== true) {
        state.online.delete(String(name));
        state.active.delete(String(name));
        state.active.add(String(desiredName));
        if (options.browserSwapAccountOnlineLag !== true) state.online.add(String(desiredName));
        runtimePeers.delete(String(name));
      }
      return {
        id: 'cm-' + state.crossWindowDispatches.length,
        state: 'DISPATCHED',
        dispatched: true,
        value: options.crossWindowNeverSettle
          ? new Promise(() => {})
          : Promise.resolve({ success: true, reason: 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_ACCEPTED' })
      };
    }
  } : null;

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'lifecycle-recovery.js' });

  const Controller = ctx.__ALBOT_INTERNALS__.CharacterLifecycleController;
  const controller = new Controller({
    root: ctx,
    game,
    actions,
    roster,
    party,
    storage,
    crossWindow,
    sessionId: options.sessionId || 'h19-fixture-session',
    navigateCharacterLocal: desiredName => {
      state.localNavigations.push({ from: String(state.character.name), to: String(desiredName) });
      if (options.localNavigationNoMutation !== true) {
        state.online.delete(String(state.character.name));
        state.active.delete(String(state.character.name));
        state.active.add(String(desiredName));
        if (options.browserSwapAccountOnlineLag !== true) state.online.add(String(desiredName));
      }
      return { accepted: true, desiredCharacterName: String(desiredName) };
    },
    canNavigateCharacterLocal: () => options.localNavigationUnavailable !== true,
    canAct: () => options.actionBlocked !== true,
    outcomeTimeoutMs: options.outcomeTimeoutMs == null ? 5000 : options.outcomeTimeoutMs,
    startOutcomeTimeoutMs: options.startOutcomeTimeoutMs == null ? 15000 : options.startOutcomeTimeoutMs,
    browserSwapTimeoutMs: options.browserSwapTimeoutMs == null ? 20000 : options.browserSwapTimeoutMs,
    startRetryBackoffMs: options.startRetryBackoffMs == null ? 750 : options.startRetryBackoffMs,
    partyRetryBackoffMs: options.partyRetryBackoffMs == null ? 1500 : options.partyRetryBackoffMs,
    maxActionsPerSession: options.maxActionsPerSession == null ? 4 : options.maxActionsPerSession
  });
  controller.start({ scope: { interval: () => 'h19-resource' } });

  return {
    controller,
    state,
    storage,
    ctx,
    resolve: value => resolvePending && resolvePending(value == null ? { success: true } : value),
    reject: error => rejectPending && rejectPending(error || new Error('PROMISE_REJECTED')),
    recreate: extra => fixture({ ...options, ...(extra || {}), state, storage }),
    runtimePeers
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('H19 roster separates account-wide online truth from runner-active truth', () => {
  const coreSource = fs.readFileSync(path.resolve(here, '../src/core.js'), 'utf8');
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    character: { name: 'My_Ranger', ctype: 'ranger' },
    get_characters: () => [
      { name: 'My_Ranger', ctype: 'ranger', online: true },
      { name: 'My_Priest', ctype: 'priest', online: true },
      { name: 'My_Merchant', ctype: 'merchant', online: true },
      { name: 'My_Warrior', ctype: 'warrior', online: false }
    ],
    get_active_characters: () => ({ My_Ranger: 'self' })
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(coreSource, ctx, { filename: 'core.js' });

  const roster = new ctx.__ALBOT_INTERNALS__.CharacterRosterService({ root: ctx });
  const snapshot = roster.refresh();
  assert.equal(snapshot.accountStateAvailable, true);
  assert.equal(snapshot.onlineStateAvailable, true);
  assert.equal(snapshot.activeStateAvailable, true);
  assert.equal(snapshot.onlineCharacterNames.join(','), 'My_Merchant,My_Priest,My_Ranger');
  assert.equal(snapshot.activeCharacterNames.join(','), 'My_Ranger');
  assert.equal(snapshot.runnerActiveCharacterNames.join(','), 'My_Ranger');
});

test('H19 lifecycle only targets account-owned non-local characters', () => {
  const { controller } = fixture();
  assert.equal(controller.queueStart('Not_Mine').accepted, false);
  assert.equal(controller.queueStart('My_Ranger').accepted, false);
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
});

test('H19 start requires settlement and live active-roster evidence', async () => {
  const { controller, state, resolve } = fixture({ manualSettlement: true });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  const dispatched = controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.equal(state.active.has('My_Merchant'), true);

  const premature = controller.tick();
  assert.equal(premature.state, 'PENDING');
  assert.equal(controller.status().metrics.startsConfirmed, 0);

  resolve({ success: true });
  await flush();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.details.evidence, 'ACTIVE_ROSTER_PRESENT');
  assert.equal(controller.status().metrics.startsConfirmed, 1);
});

test('H25 start confirms from runner loading state while account online flag still lags', async () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Ranger'],
    runnerActiveNames: ['My_Ranger'],
    startOnlyRunnerState: true
  });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  assert.equal(state.online.has('My_Merchant'), false);
  assert.equal(state.active.has('My_Merchant'), true);
  await flush();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.details.evidence, 'RUNNER_START_STATE_PRESENT');
  assert.equal(controller.status().suspended, false);
});

test('H25 late positive START evidence clears only the matching timeout suspension', async () => {
  const f = fixture({
    onlineNames: ['My_Ranger'],
    runnerActiveNames: ['My_Ranger'],
    manualSettlement: true,
    startOnlyRunnerState: true
  });
  assert.equal(f.controller.queueStart('My_Merchant').accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  f.controller.currentAction.deadlineAtMs = Date.now() - 1;
  const timedOut = f.controller.tick();
  assert.equal(timedOut.state, 'UNKNOWN');
  assert.equal(f.controller.status().suspendedReason, 'H19_START_UNVERIFIED_TIMEOUT');

  f.resolve({ success: true });
  await flush();
  const recovered = f.controller.tick();
  assert.equal(recovered.state, 'CONFIRMED');
  assert.equal(recovered.lateConfirmed, true);
  assert.equal(recovered.details.evidence, 'RUNNER_START_STATE_PRESENT');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().suspendedReason, null);
  assert.equal(f.controller.status().metrics.lateOutcomeRecoveries, 1);
});

test('H19 stop confirms only after settlement and target disappears from active roster', async () => {
  const { controller, state } = fixture({ activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'] });
  assert.equal(controller.queueStop('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(state.active.has('My_Merchant'), false);
  assert.equal(controller.status().metrics.stopsConfirmed, 1);
});

test('H19 respawn waits for the observed 12-second game cooldown before dispatch', async () => {
  const { controller, state } = fixture({ dead: true });
  assert.equal(controller.queueRespawn().accepted, true);

  const waiting = controller.tick();
  assert.equal(waiting.state, 'WAIT');
  assert.equal(waiting.reason, 'H19_RESPAWN_COOLDOWN');
  assert.equal(state.dispatches.length, 0);
  assert.equal(controller.status().metrics.respawnCooldownBlocks >= 1, true);

  controller.deathObservedAtMs = Date.now() - controller.status().config.respawnGraceMs - 1;
  assert.equal(controller.tick().state, 'DISPATCHED');
  assert.equal(state.dispatches.length, 1);
  await flush();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(state.character.rip, false);
  assert.equal(controller.status().metrics.respawnsConfirmed, 1);
});

test('H19 cant_respawn is a known reject, not UNKNOWN, and is never blindly retried', async () => {
  const { controller, state } = fixture({
    dead: true,
    rejectPromise: true,
    rejectReason: 'cant_respawn',
    noMutation: true
  });
  assert.equal(controller.queueRespawn().accepted, true);
  controller.deathObservedAtMs = Date.now() - controller.status().config.respawnGraceMs - 1;

  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  const rejected = controller.tick();
  assert.equal(rejected.state, 'REJECTED');
  assert.equal(rejected.reason, 'H19_RESPAWN_COOLDOWN');
  assert.equal(rejected.serverReason, 'cant_respawn');
  assert.equal(controller.status().suspended, false);
  assert.equal(controller.status().metrics.actionsRejected, 1);
  assert.equal(controller.status().metrics.actionsUnknown, 0);
  assert.equal(controller.status().metrics.respawnCooldownRejects, 1);
  assert.equal(state.dispatches.length, 1);

  controller.tick();
  assert.equal(state.dispatches.length, 1);
});

test('H19 rejected lifecycle Promise suspends without blind retry', async () => {
  const { controller, state } = fixture({ rejectPromise: true, noMutation: true });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  const unknown = controller.tick();
  assert.equal(unknown.state, 'UNKNOWN');
  assert.match(unknown.reason, /H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME/);
  assert.equal(controller.status().suspended, true);
  assert.equal(state.dispatches.length, 1);
  controller.tick();
  assert.equal(state.dispatches.length, 1);
});


test('H19 late STOP live evidence clears the matching rejected-settlement suspension without redispatch', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    rejectPromise: true,
    noMutation: true
  });
  assert.equal(controller._enqueue('STOP', 'My_Merchant', { automatic: true }).accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  const unknown = controller.tick();
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.reason, 'H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME');
  assert.equal(controller.status().currentAction.kind, 'STOP');
  assert.equal(controller.status().currentAction.unknownRecorded, true);
  assert.equal(controller.status().autonomyEnabled, false);

  // A rejected settlement without live offline evidence must remain fail-closed.
  assert.equal(controller.tick().state, 'UNKNOWN');
  assert.equal(state.dispatches.length, 1);
  assert.equal(controller.status().suspended, true);

  // The exact STOP action is now confirmed by independent account roster truth.
  state.online.delete('My_Merchant');
  state.active.delete('My_Merchant');
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.kind, 'STOP');
  assert.equal(confirmed.targetName, 'My_Merchant');
  assert.equal(confirmed.details.evidence, 'ACTIVE_ROSTER_ABSENT');
  assert.equal(confirmed.lateConfirmed, true);

  const status = controller.status();
  assert.equal(status.currentAction, null);
  assert.equal(status.suspended, false);
  assert.equal(status.suspendedReason, null);
  assert.equal(status.autonomyEnabled, true);
  assert.equal(status.lastAction.type, 'STOP_CONFIRMED');
  assert.equal(status.lastAction.lateConfirmed, true);
  assert.equal(status.metrics.actionsUnknown, 1);
  assert.equal(status.metrics.actionsDispatched, 1);
  assert.equal(status.metrics.actionsConfirmed, 1);
  assert.equal(status.metrics.lateOutcomeRecoveries, 1);
  assert.equal(state.dispatches.length, 1);
});

test('H19 rejected START stays suspended if there is no live state confirmation', async () => {
  const { controller, state } = fixture({ rejectPromise: true, noMutation: true });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  assert.equal(controller.tick().state, 'UNKNOWN');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(controller.tick().state, 'UNKNOWN');
  }
  const status = controller.status();
  assert.equal(status.suspended, true);
  assert.equal(status.suspendedReason, 'H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME');
  assert.equal(status.currentAction.kind, 'START');
  assert.equal(status.metrics.actionsConfirmed, 0);
  assert.equal(status.metrics.lateOutcomeRecoveries, 0);
  assert.equal(state.dispatches.length, 1);
});

test('H19 late confirmation does not clear a suspension attributed to another action kind', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    rejectPromise: true,
    noMutation: true
  });
  assert.equal(controller.queueStop('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  assert.equal(controller.tick().state, 'UNKNOWN');

  // A mismatched safety reason cannot be cleared by an unrelated confirmation.
  controller.suspendedReason = 'H19_START_UNVERIFIED_TIMEOUT';
  state.online.delete('My_Merchant');
  state.active.delete('My_Merchant');
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.lateConfirmed, false);
  const status = controller.status();
  assert.equal(status.suspended, true);
  assert.equal(status.suspendedReason, 'H19_START_UNVERIFIED_TIMEOUT');
  assert.equal(status.metrics.lateOutcomeRecoveries, 0);
  assert.equal(state.dispatches.length, 1);
});

test('H19 synchronous UNKNOWN preserves ownership, removes queued duplicate and counts once', () => {
  const { controller, state } = fixture({ syncUnknown: true, noMutation: true });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  const result = controller.tick();
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.reason, /H19_DISPATCH_SYNC_UNKNOWN/);
  assert.equal(controller.status().suspended, true);
  assert.ok(controller.status().currentAction);
  assert.equal(controller.status().queue.length, 0);
  assert.equal(controller.status().metrics.actionsUnknown, 1);
  assert.equal(state.dispatches.length, 1);

  controller.currentAction.deadlineAtMs = Date.now() - 1;
  controller.tick();
  assert.equal(controller.status().metrics.actionsUnknown, 1);
  assert.equal(state.dispatches.length, 1);
});

test('H19 UNKNOWN ownership requires explicit acknowledgement before safety reset', () => {
  const { controller, state } = fixture({ syncUnknown: true, noMutation: true });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'UNKNOWN');
  assert.equal(controller.resetSafety('TOO_EARLY').accepted, false);

  const ack = controller.acknowledgeUnknown('TEST_OPERATOR_ACK');
  assert.equal(ack.accepted, true);
  assert.equal(ack.safetyResetRequired, true);
  assert.equal(controller.status().currentAction, null);
  assert.equal(controller.status().suspended, true);
  assert.equal(controller.resetSafety('TEST_AFTER_ACK').accepted, true);
  assert.equal(controller.status().suspended, false);
  assert.equal(state.dispatches.length, 1);
});

test('H19 preserves pending lifecycle ownership across module reload and reconciles instead of redispatching', () => {
  const first = fixture({ neverSettle: true });
  assert.equal(first.controller.queueStart('My_Merchant').accepted, true);
  assert.equal(first.controller.tick().state, 'DISPATCHED');
  assert.equal(first.state.dispatches.length, 1);
  assert.equal(first.storage.map.size > 0, true);
  first.controller.stop('TEST_RELOAD');

  const second = first.recreate({ neverSettle: false });
  assert.equal(second.controller.status().currentAction.restored, true);
  const reconciled = second.controller.tick();
  assert.equal(reconciled.state, 'CONFIRMED');
  assert.equal(second.state.dispatches.length, 1);
  assert.equal(second.controller.status().metrics.reconciliations, 1);
});

test('H19 late settlement from stopped controller cannot resurrect pending storage', async () => {
  const first = fixture({ manualSettlement: true });
  assert.equal(first.controller.queueStart('My_Merchant').accepted, true);
  assert.equal(first.controller.tick().state, 'DISPATCHED');
  first.controller.stop('TEST_HOT_RELOAD');

  const second = first.recreate({ manualSettlement: false });
  assert.equal(second.controller.status().currentAction.restored, true);
  assert.equal(second.controller.tick().state, 'CONFIRMED');
  assert.equal([...first.storage.map.keys()].some(key => key.includes(':pending:')), false);

  first.resolve({ success: true });
  await flush();
  assert.equal([...first.storage.map.keys()].some(key => key.includes(':pending:')), false);
  assert.equal(second.controller.status().currentAction, null);
});

test('H19 rotates farmers stop-before-start so the four-character account limit is never exceeded', async () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    runnerActiveNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    partyMembers: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    partyLeader: 'My_Priest',
    maxActionsPerSession: 4
  });
  state.account.push({ name: 'My_Mage', ctype: 'mage', online: false });

  const policy = controller.setPolicy({
    desiredActiveNames: ['My_Mage', 'My_Merchant', 'My_Ranger', 'My_Warrior'],
    desiredPartyMemberNames: ['My_Mage', 'My_Merchant', 'My_Ranger', 'My_Warrior'],
    desiredPartyLeader: 'My_Warrior'
  });
  assert.equal(policy.accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 4 }).accepted, true);

  const stopDispatch = controller.tick();
  assert.equal(stopDispatch.state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[0], { name: 'stop_character', args: ['My_Priest'] });
  assert.equal(state.online.size, 3);

  await flush();
  const stopConfirmed = controller.tick();
  assert.equal(stopConfirmed.state, 'CONFIRMED');

  const startDispatch = controller.tick();
  assert.equal(startDispatch.state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[1], { name: 'start_character', args: ['My_Mage'] });
  assert.equal(state.online.size, 4);
  assert.equal(state.online.has('My_Priest'), false);
  assert.equal(state.online.has('My_Mage'), true);
});

test('H19 captureDesiredActive drives bounded missing-character recovery', async () => {
  const { controller, state } = fixture({ activeNames: ['My_Ranger', 'My_Priest'] });
  assert.equal(controller.captureDesiredActive().accepted, true);
  state.online.add('My_Merchant');
  assert.equal(controller.captureDesiredActive().accepted, true);
  state.online.delete('My_Merchant');

  assert.equal(controller.startAutonomy({ maxActions: 1 }).accepted, true);
  const dispatched = controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[0], { name: 'start_character', args: ['My_Merchant'] });
  await flush();
  assert.equal(controller.tick().state, 'CONFIRMED');
  const done = controller.tick();
  assert.equal(done.state, 'COMPLETE');
  assert.equal(controller.status().autonomyEnabled, false);
  assert.equal(state.dispatches.length, 1);
});

test('H19 captures the owned live party leader with the desired active set', () => {
  const { controller } = fixture({
    activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    partyMembers: ['My_Ranger', 'My_Priest'],
    partyLeader: 'My_Ranger'
  });
  const captured = controller.captureDesiredActive();
  assert.equal(captured.accepted, true);
  assert.equal(captured.desiredPartyLeader, 'My_Ranger');
  assert.deepEqual(captured.desiredActiveNames, ['My_Merchant', 'My_Priest', 'My_Ranger']);
  assert.deepEqual(captured.desiredPartyMemberNames, ['My_Priest', 'My_Ranger']);
});

test('H33 party leader skips an online member without a fresh same-server peer and invites the next reachable farmer', async () => {
  const f = fixture({
    onlineNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    runnerActiveNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    partyMembers: ['My_Merchant', 'My_Ranger'],
    partyLeader: 'My_Merchant',
    crossWindowPeers: [
      { name: 'My_Ranger', running: true },
      { name: 'My_Warrior', running: true }
    ]
  });
  f.state.character.name = 'My_Merchant';
  f.state.character.ctype = 'merchant';

  assert.equal(f.controller.setPolicy({
    desiredActiveNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    desiredRuntimeRunningNames: [],
    desiredPartyMemberNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    desiredPartyLeader: 'My_Merchant'
  }).accepted, true);
  assert.equal(f.controller.startAutonomy({ maxActions: 4 }).accepted, true);

  const dispatched = f.controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[0], { name: 'send_party_invite', args: ['My_Warrior'] });
  assert.equal(f.controller.status().suspended, false);
  assert.ok(f.controller.status().metrics.partyPeerBlocks >= 1);

  await flush();
  const confirmed = f.controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.targetName, 'My_Warrior');

  const waiting = f.controller.plan();
  assert.equal(waiting.state, 'WAITING');
  assert.equal(waiting.reason, 'H33_PARTY_MEMBER_PEER_UNAVAILABLE');
  assert.deepEqual(Array.from(waiting.peerUnavailableNames), ['My_Priest']);
});

test('H33 transient invalid party invite rejection backs off only that target and keeps party recovery alive', async () => {
  const f = fixture({
    onlineNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    runnerActiveNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    partyMembers: ['My_Merchant', 'My_Ranger'],
    partyLeader: 'My_Merchant',
    crossWindowPeers: [
      { name: 'My_Priest', running: true },
      { name: 'My_Ranger', running: true },
      { name: 'My_Warrior', running: true }
    ],
    noMutation: true,
    rejectPromise: true,
    rejectReason: 'invalid',
    partyRetryBackoffMs: 1500
  });
  f.state.character.name = 'My_Merchant';
  f.state.character.ctype = 'merchant';

  assert.equal(f.controller.setPolicy({
    desiredActiveNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    desiredRuntimeRunningNames: [],
    desiredPartyMemberNames: ['My_Merchant', 'My_Priest', 'My_Ranger', 'My_Warrior'],
    desiredPartyLeader: 'My_Merchant'
  }).accepted, true);
  assert.equal(f.controller.startAutonomy({ maxActions: 4 }).accepted, true);

  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[0], { name: 'send_party_invite', args: ['My_Priest'] });
  await flush();

  const rejected = f.controller.tick();
  assert.equal(rejected.state, 'WAITING');
  assert.equal(rejected.reason, 'H33_PARTY_TARGET_TRANSIENTLY_UNAVAILABLE');
  assert.equal(rejected.targetName, 'My_Priest');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().autonomyEnabled, true);
  assert.equal(f.controller.status().metrics.partyTransientRejects, 1);

  const second = f.controller.tick();
  assert.equal(second.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[1], { name: 'send_party_invite', args: ['My_Warrior'] });
});

test('H19 party leader restores only a previously captured party member', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    partyMembers: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    partyLeader: 'My_Ranger'
  });
  assert.equal(controller.captureDesiredActive().accepted, true);
  state.party.members.delete('My_Merchant');

  assert.equal(controller.startAutonomy({ maxActions: 1 }).accepted, true);
  const dispatched = controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[0], { name: 'send_party_invite', args: ['My_Merchant'] });
  await flush();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.details.evidence, 'PARTY_SNAPSHOT_MEMBERSHIP');
  assert.equal(controller.status().metrics.partyInvitesConfirmed, 1);
});

test('H19 does not pull active owned characters into party unless they were captured as party members', () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    partyMembers: ['My_Ranger', 'My_Priest'],
    partyLeader: 'My_Ranger'
  });
  assert.equal(controller.captureDesiredActive().accepted, true);
  assert.deepEqual(controller.status().policy.desiredPartyMemberNames, ['My_Priest', 'My_Ranger']);
  assert.equal(controller.startAutonomy({ maxActions: 2 }).accepted, true);
  const plan = controller.plan();
  assert.equal(plan.state, 'IDLE');
  assert.equal(plan.reason, 'H19_DESIRED_ACTIVE_AND_PARTY_SET_HEALTHY');
  assert.equal(state.dispatches.length, 0);
});

test('H19 nonleader requests the captured desired leader after party loss', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest']
  });
  assert.equal(controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest'],
    desiredPartyMemberNames: ['My_Ranger', 'My_Priest'],
    desiredPartyLeader: 'My_Priest'
  }).accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 1 }).accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[0], { name: 'send_party_request', args: ['My_Priest'] });
  await flush();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().metrics.partyRequestsConfirmed, 1);
  assert.equal(state.party.leader, 'My_Priest');
});

test('H19 accepts an observed invite only from the desired owned leader', async () => {
  const { controller, state, ctx } = fixture({
    activeNames: ['My_Ranger', 'My_Priest']
  });
  assert.equal(controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest'],
    desiredPartyMemberNames: ['My_Ranger', 'My_Priest'],
    desiredPartyLeader: 'My_Priest'
  }).accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 1 }).accepted, true);

  ctx.on_party_invite('Not_Mine');
  assert.equal(controller.status().partySignals.length, 0);

  ctx.on_party_invite('My_Priest');
  assert.equal(controller.status().partySignals.length, 1);
  assert.equal(controller.tick().state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[0], { name: 'accept_party_invite', args: ['My_Priest'] });
  await flush();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().metrics.partyAcceptsConfirmed, 1);
  assert.equal(controller.status().partySignals.length, 0);
});

test('H19 party recovery ignores signals without captured leader and blocks foreign party topology', () => {
  const noLeader = fixture({ activeNames: ['My_Ranger', 'My_Priest'] });
  assert.equal(noLeader.controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest']
  }).accepted, true);
  noLeader.ctx.on_party_invite('My_Priest');
  assert.equal(noLeader.controller.status().partySignals.length, 0);

  const foreign = fixture({
    activeNames: ['My_Ranger', 'My_Priest'],
    foreignPartyNames: ['Foreign_Player']
  });
  assert.equal(foreign.controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest'],
    desiredPartyMemberNames: ['My_Ranger', 'My_Priest'],
    desiredPartyLeader: 'My_Priest'
  }).accepted, true);
  assert.equal(foreign.controller.startAutonomy({ maxActions: 1 }).accepted, true);
  foreign.ctx.on_party_invite('My_Priest');
  const plan = foreign.controller.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.reason, 'H19_FOREIGN_PARTY_MEMBER_PRESENT');
  assert.equal(foreign.state.dispatches.length, 0);
});

test('H19 automatic known reject stops autonomy and does not immediately retry', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest'],
    serverReject: true,
    noMutation: true
  });
  assert.equal(controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest', 'My_Merchant']
  }).accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 3 }).accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  const rejected = controller.tick();
  assert.equal(rejected.state, 'REJECTED');
  assert.equal(rejected.autonomyStopped, true);
  assert.equal(controller.status().autonomyEnabled, false);
  assert.equal(state.dispatches.length, 1);
  controller.tick();
  assert.equal(state.dispatches.length, 1);
});

test('H19 fails closed when account or account-wide online truth is unavailable', () => {
  const accountUnavailable = fixture({ accountUnavailable: true });
  assert.equal(accountUnavailable.controller.queueStart('My_Merchant').accepted, false);
  assert.equal(accountUnavailable.state.dispatches.length, 0);

  const onlineUnavailable = fixture({ onlineUnavailable: true });
  assert.equal(onlineUnavailable.controller.queueStart('My_Merchant').accepted, false);
  assert.equal(onlineUnavailable.state.dispatches.length, 0);

  const runnerActiveUnavailable = fixture({
    activeUnavailable: true,
    onlineNames: ['My_Ranger', 'My_Priest'],
    runnerActiveNames: ['My_Ranger', 'My_Priest']
  });
  assert.equal(runnerActiveUnavailable.controller.queueStart('My_Merchant').accepted, true);
  const blockedStop = runnerActiveUnavailable.controller.queueStop('My_Priest');
  assert.equal(blockedStop.accepted, false);
  assert.equal(blockedStop.reason, 'H19_RUNNER_ACTIVE_STATE_UNAVAILABLE');
  assert.equal(runnerActiveUnavailable.state.dispatches.length, 0);
});

test('H19 separate-window lifecycle uses fresh CM peer instead of runner-active membership', async () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Ranger', 'My_Merchant'],
    runnerActiveNames: ['My_Ranger'],
    freezeRunnerActive: true,
    crossWindowPeers: [
      { name: 'My_Merchant', sessionId: 'merchant-window-session', running: true, runEpoch: 8 }
    ]
  });

  const captured = controller.captureDesiredActive();
  assert.equal(captured.accepted, true);
  assert.deepEqual([...captured.desiredRuntimeRunningNames], ['My_Merchant']);

  assert.equal(controller.queueStop('My_Merchant').accepted, true);
  const stoppedDispatch = controller.tick();
  assert.equal(stoppedDispatch.state, 'DISPATCHED');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.crossWindowDispatches.length, 1);
  assert.equal(state.online.has('My_Merchant'), true);

  await flush();
  const stopped = controller.tick();
  assert.equal(stopped.state, 'CONFIRMED');
  assert.equal(stopped.details.evidence, 'CROSS_WINDOW_RUNTIME_SETTLEMENT');
  assert.equal(stopped.details.running, false);
  assert.equal(controller.status().metrics.stopsConfirmed, 1);
  assert.equal(controller.status().metrics.crossWindowConfirms, 1);

  assert.equal(controller.startAutonomy({ maxActions: 1 }).accepted, true);
  const restartedDispatch = controller.tick();
  assert.equal(restartedDispatch.state, 'DISPATCHED');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.crossWindowDispatches.length, 2);

  await flush();
  const restarted = controller.tick();
  assert.equal(restarted.state, 'CONFIRMED');
  assert.equal(restarted.details.evidence, 'CROSS_WINDOW_RUNTIME_SETTLEMENT');
  assert.equal(restarted.details.running, true);
  assert.equal(state.online.has('My_Merchant'), true);
  assert.equal(controller.status().metrics.startsConfirmed, 1);
  assert.equal(controller.status().metrics.crossWindowDispatches, 2);
});

test('H26 browser swap waits for the replacement bot runtime to load and start', async () => {
  const { controller, state, runtimePeers } = fixture({
    onlineNames: ['My_Merchant', 'My_Ranger', 'My_Priest', 'My_Warrior'],
    runnerActiveNames: ['My_Ranger'],
    freezeRunnerActive: true,
    browserSwapAccountOnlineLag: true,
    crossWindowPeers: [
      { name: 'My_Priest', sessionId: 'priest-window-session', running: true, runEpoch: 4, characterDisconnectCapable: true, characterNavigateCapable: true }
    ],
    maxActionsPerSession: 4
  });
  state.account.push({ name: 'My_Mage', ctype: 'mage', online: false });

  const desired = ['My_Mage', 'My_Merchant', 'My_Ranger', 'My_Warrior'];
  const readiness = controller.characterRotationReadiness(desired);
  assert.equal(readiness.ready, true);
  assert.deepEqual(clone(readiness.browserSwapPairs), [{ from: 'My_Priest', to: 'My_Mage' }]);

  assert.equal(controller.setPolicy({
    desiredActiveNames: desired,
    desiredPartyMemberNames: desired,
    desiredPartyLeader: 'My_Ranger'
  }).accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 4 }).accepted, true);

  const plan = controller.plan();
  assert.equal(plan.state, 'READY');
  assert.equal(plan.request.kind, 'BROWSER_SWAP');
  assert.equal(plan.request.targetName, 'My_Priest');
  assert.equal(plan.request.desiredName, 'My_Mage');

  const dispatched = controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.equal(state.crossWindowDispatches.length, 1);
  assert.deepEqual(clone(state.crossWindowDispatches[0]), {
    type: 'navigate-character',
    name: 'My_Priest',
    desiredName: 'My_Mage',
    sessionId: 'priest-window-session'
  });
  assert.equal(state.online.has('My_Priest'), false);
  assert.equal(state.online.has('My_Mage'), false, 'account online flag may lag the browser load');
  assert.equal(state.active.has('My_Mage'), true, 'loading/starting runner state is live start evidence');
  assert.equal(state.dispatches.filter(row => row.name === 'start_character').length, 0);

  await flush();
  const characterOnly = controller.tick();
  assert.equal(characterOnly.state, 'PENDING', 'character presence alone must not confirm the browser swap');
  assert.equal(controller.status().metrics.browserSwapsConfirmed, 0);

  runtimePeers.set('My_Mage', {
    name: 'My_Mage',
    sessionId: 'mage-window-session',
    running: false,
    runEpoch: 1,
    fullAutonomyEnabled: false,
    characterDisconnectCapable: true,
    characterNavigateCapable: true
  });
  const loadedButStopped = controller.tick();
  assert.equal(loadedButStopped.state, 'PENDING', 'a loaded but stopped bot runtime must not confirm the browser swap');

  runtimePeers.get('My_Mage').running = true;
  runtimePeers.get('My_Mage').runEpoch = 2;
  const runtimeOnly = controller.tick();
  assert.equal(runtimeOnly.state, 'PENDING', 'runtime running without Full Autonomy must not confirm the browser swap');

  runtimePeers.get('My_Mage').fullAutonomyEnabled = true;
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.kind, 'BROWSER_SWAP');
  assert.equal(confirmed.desiredName, 'My_Mage');
  assert.equal(confirmed.details.evidence, 'BROWSER_SWAP_NEW_RUNTIME_READY');
  assert.equal(confirmed.details.desiredRuntimeLoaded, true);
  assert.equal(confirmed.details.desiredRuntimeRunning, true);
  assert.equal(confirmed.details.desiredFullAutonomyEnabled, true);
  assert.equal(confirmed.details.desiredSessionId, 'mage-window-session');
  assert.equal(controller.status().metrics.browserSwapsConfirmed, 1);
  assert.equal(state.dispatches.filter(row => row.name === 'start_character').length, 0);
});

test('H30 browser swap rebinds to a replacement target session instead of suspending forever', async () => {
  const { controller, state, runtimePeers } = fixture({
    onlineNames: ['My_Merchant', 'My_Ranger', 'My_Priest', 'My_Warrior'],
    runnerActiveNames: ['My_Merchant'],
    freezeRunnerActive: true,
    crossWindowNeverSettle: true,
    crossWindowNoMutation: true,
    crossWindowPeers: [
      {
        name: 'My_Warrior',
        sessionId: 'warrior-session-a',
        running: true,
        runEpoch: 1,
        fullAutonomyEnabled: true,
        characterDisconnectCapable: true,
        characterNavigateCapable: true
      }
    ],
    maxActionsPerSession: 4
  });
  state.account.push({ name: 'My_Mage', ctype: 'mage', online: false });

  const desired = ['My_Mage', 'My_Merchant', 'My_Priest', 'My_Ranger'];
  assert.equal(controller.setPolicy({
    desiredActiveNames: desired,
    desiredPartyMemberNames: desired,
    desiredPartyLeader: 'My_Merchant'
  }).accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 4 }).accepted, true);

  const first = controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(first.currentAction.kind, 'BROWSER_SWAP');
  assert.equal(first.currentAction.targetName, 'My_Warrior');
  assert.equal(first.currentAction.before.targetSessionId, 'warrior-session-a');
  assert.equal(state.crossWindowDispatches.length, 1);

  // Reproduce the live incident: the outgoing browser reloads the same
  // character under a new runtime session while the old action boundary has
  // already become UNKNOWN/REJECTED.
  runtimePeers.set('My_Warrior', {
    name: 'My_Warrior',
    sessionId: 'warrior-session-b',
    running: true,
    runEpoch: 1,
    fullAutonomyEnabled: true,
    characterDisconnectCapable: true,
    characterNavigateCapable: true
  });
  controller.currentAction.settlement = 'REJECTED';
  controller.currentAction.error = 'H19_CROSS_WINDOW_SETTLEMENT_TIMEOUT';
  controller.currentAction.unknownRecorded = true;
  controller.suspended = true;
  controller.suspendedReason = 'H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME';
  controller.autonomyEnabled = false;

  const rebound = controller.tick();
  assert.equal(rebound.state, 'DISPATCHED');
  assert.equal(state.crossWindowDispatches.length, 2);
  assert.deepEqual(clone(state.crossWindowDispatches.map(row => row.sessionId)), [
    'warrior-session-a',
    'warrior-session-b'
  ]);

  let status = controller.status();
  assert.equal(status.suspended, false);
  assert.equal(status.autonomyEnabled, true);
  assert.equal(status.currentAction.kind, 'BROWSER_SWAP');
  assert.equal(status.currentAction.before.targetSessionId, 'warrior-session-b');
  assert.equal(status.metrics.browserSwapSessionRecoveries, 1);
  assert.equal(status.metrics.stalePendingDiscarded, 1);
  assert.equal(status.metrics.reconciliations, 1);
  assert.equal(status.metrics.actionsDispatched, 2);
  assert.deepEqual(clone(status.browserSwapRecoveryAttempts), [
    { key: 'My_Warrior->My_Mage', attempts: 1 }
  ]);
  assert.equal(state.dispatches.filter(row => row.name === 'start_character').length, 0);

  // A second reload of the same outgoing character means the handoff itself is
  // not succeeding. Do not create an infinite logout/reload loop.
  runtimePeers.set('My_Warrior', {
    name: 'My_Warrior',
    sessionId: 'warrior-session-c',
    running: true,
    runEpoch: 1,
    fullAutonomyEnabled: true,
    characterDisconnectCapable: true,
    characterNavigateCapable: true
  });
  controller.currentAction.settlement = 'REJECTED';
  controller.currentAction.error = 'H19_CROSS_WINDOW_SETTLEMENT_TIMEOUT';
  controller.currentAction.unknownRecorded = true;
  controller.suspended = true;
  controller.suspendedReason = 'H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME';
  controller.autonomyEnabled = false;

  const blockedRecovery = controller.tick();
  assert.equal(blockedRecovery.state, 'BLOCKED');
  assert.equal(blockedRecovery.reason, 'H31_BROWSER_SWAP_RETRY_LIMIT_REACHED:My_Warrior->My_Mage');
  assert.equal(state.crossWindowDispatches.length, 2, 'no third logout/navigation may be dispatched');

  const stableBlock = controller.tick();
  assert.equal(stableBlock.state, 'BLOCKED');
  assert.equal(stableBlock.reason, 'H31_BROWSER_SWAP_RETRY_LIMIT_REACHED:My_Warrior->My_Mage');
  assert.equal(state.crossWindowDispatches.length, 2);

  status = controller.status();
  assert.equal(status.suspended, false);
  assert.equal(status.autonomyEnabled, true);
  assert.equal(status.currentAction, null);
  assert.equal(status.metrics.browserSwapSessionRecoveries, 1);
  assert.equal(status.metrics.browserSwapRecoveryBlocks, 1);
  assert.equal(status.metrics.stalePendingDiscarded, 2);
  assert.equal(status.metrics.reconciliations, 2);

  await flush();
});

test('H25 rotation blocks rather than falling back to reconnect-prone disconnect when browser navigation is unavailable', () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Merchant', 'My_Ranger', 'My_Priest', 'My_Warrior'],
    runnerActiveNames: ['My_Ranger'],
    freezeRunnerActive: true,
    crossWindowPeers: [
      { name: 'My_Priest', sessionId: 'priest-window-session', running: true, runEpoch: 4, characterDisconnectCapable: true, characterNavigateCapable: false }
    ]
  });
  state.account.push({ name: 'My_Mage', ctype: 'mage', online: false });
  const desired = ['My_Mage', 'My_Merchant', 'My_Ranger', 'My_Warrior'];
  const readiness = controller.characterRotationReadiness(desired);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'H25_ROTATION_BROWSER_NAVIGATION_UNAVAILABLE:My_Priest');
  assert.equal(state.crossWindowDispatches.length, 0);
});

test('H24 surplus-window disconnect remains fail-closed when no replacement is needed and self-disconnect is unavailable', () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Merchant', 'My_Ranger', 'My_Priest', 'My_Warrior'],
    runnerActiveNames: ['My_Ranger'],
    freezeRunnerActive: true,
    crossWindowPeers: [
      { name: 'My_Priest', sessionId: 'priest-window-session', running: true, runEpoch: 4, characterDisconnectCapable: false }
    ]
  });
  const desired = ['My_Merchant', 'My_Ranger', 'My_Warrior'];
  const readiness = controller.characterRotationReadiness(desired);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.includes('H19_ROTATION_STOP_NOT_RUNNER_CONTROLLABLE:My_Priest'));
  assert.equal(state.crossWindowDispatches.length, 0);
});

test('H19 stale pending from another runtime session is discarded without suspending the new session', () => {
  const first = fixture({
    sessionId: 'runtime-session-a',
    manualSettlement: true,
    noMutation: true,
    onlineNames: ['My_Ranger', 'My_Priest'],
    runnerActiveNames: ['My_Ranger', 'My_Priest']
  });
  assert.equal(first.controller.queueStop('My_Priest').accepted, true);
  assert.equal(first.controller.tick().state, 'DISPATCHED');
  first.controller.stop('TEST_OLD_RUNTIME_GONE');

  const second = first.recreate({
    sessionId: 'runtime-session-b',
    manualSettlement: false,
    noMutation: true
  });
  const status = second.controller.status();
  assert.equal(status.currentAction, null);
  assert.equal(status.suspended, false);
  assert.equal(status.metrics.stalePendingDiscarded, 1);
  assert.equal(status.lastAction.type, 'STALE_PENDING_DISCARDED');
  assert.equal([...first.storage.map.keys()].some(key => key.includes(':pending:')), false);
});

test('H19 stale pending from another runtime session is reconciled when live character state proves success', () => {
  const first = fixture({
    sessionId: 'runtime-session-a',
    manualSettlement: true,
    onlineNames: ['My_Ranger', 'My_Priest'],
    runnerActiveNames: ['My_Ranger', 'My_Priest']
  });
  assert.equal(first.controller.queueStart('My_Merchant').accepted, true);
  assert.equal(first.controller.tick().state, 'DISPATCHED');
  assert.equal(first.state.online.has('My_Merchant'), true);
  first.controller.stop('TEST_OLD_RUNTIME_GONE');

  const second = first.recreate({
    sessionId: 'runtime-session-b',
    manualSettlement: false
  });
  const status = second.controller.status();
  assert.equal(status.currentAction, null);
  assert.equal(status.suspended, false);
  assert.equal(status.metrics.stalePendingReconciled, 1);
  assert.equal(status.lastAction.type, 'STALE_PENDING_RECONCILED');
  assert.equal(status.lastAction.evidence, 'STALE_ACTIVE_ROSTER_PRESENT');
});

test('H19 prefers direct child control when a runner-active target also has a CM heartbeat', async () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Ranger', 'My_Merchant'],
    runnerActiveNames: ['My_Ranger', 'My_Merchant'],
    crossWindowPeers: [
      { name: 'My_Merchant', sessionId: 'merchant-window-session', running: true, runEpoch: 5 }
    ]
  });

  assert.equal(controller.queueStop('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  assert.deepEqual(state.dispatches[0], { name: 'stop_character', args: ['My_Merchant'] });
  assert.equal(state.crossWindowDispatches.length, 0);
  await flush();
  assert.equal(controller.tick().state, 'CONFIRMED');
});

test('H19 setPolicy preserves and restores desired cross-window runtime targets', () => {
  const { controller } = fixture({
    onlineNames: ['My_Ranger', 'My_Merchant'],
    runnerActiveNames: ['My_Ranger'],
    crossWindowPeers: [
      { name: 'My_Merchant', sessionId: 'merchant-window-session', running: true, runEpoch: 5 }
    ]
  });

  assert.equal(controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Merchant'],
    desiredRuntimeRunningNames: ['My_Merchant']
  }).accepted, true);
  assert.deepEqual(controller.status().policy.desiredRuntimeRunningNames, ['My_Merchant']);

  assert.equal(controller.setPolicy({
    desiredActiveNames: ['My_Ranger']
  }).accepted, true);
  assert.deepEqual(controller.status().policy.desiredRuntimeRunningNames, []);

  const invalid = controller.setPolicy({
    desiredRuntimeRunningNames: ['My_Merchant']
  });
  assert.equal(invalid.accepted, false);
  assert.equal(invalid.reason, 'H19_RUNTIME_TARGET_NOT_DESIRED_ACTIVE');
});

test('H19 does not fall back to child start when a desired separate-window runtime loses fresh peer authority', () => {
  const setup = fixture({
    onlineNames: ['My_Ranger', 'My_Merchant'],
    runnerActiveNames: ['My_Ranger'],
    crossWindowPeers: [
      { name: 'My_Merchant', sessionId: 'merchant-window-session', running: true, runEpoch: 3 }
    ]
  });
  const { controller, state } = setup;
  assert.equal(controller.captureDesiredActive().accepted, true);
  assert.deepEqual(controller.status().policy.desiredRuntimeRunningNames, ['My_Merchant']);

  setup.controller.crossWindow.freshPeer = () => null;
  setup.controller.crossWindow.freshPeers = () => [];
  assert.equal(controller.startAutonomy({ maxActions: 1 }).accepted, true);
  const plan = controller.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.reason, 'H19_DESIRED_RUNTIME_PEER_UNAVAILABLE');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.crossWindowDispatches.length, 0);
});

test('H19 remote stop requires runner controllability while start still uses account-wide online truth', async () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    runnerActiveNames: ['My_Ranger'],
    freezeRunnerActive: true
  });

  const captured = controller.captureDesiredActive();
  assert.equal(captured.accepted, true);
  assert.deepEqual([...captured.desiredActiveNames], ['My_Merchant', 'My_Priest', 'My_Ranger']);
  assert.equal(state.active.has('My_Merchant'), false);

  const blockedStop = controller.queueStop('My_Merchant');
  assert.equal(blockedStop.accepted, false);
  assert.equal(blockedStop.reason, 'H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE');
  assert.equal(state.dispatches.length, 0);

  state.online.delete('My_Merchant');
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(state.online.has('My_Merchant'), true);
  assert.equal(state.active.has('My_Merchant'), false);
  assert.equal(controller.status().metrics.stopsConfirmed, 0);
  assert.equal(controller.status().metrics.startsConfirmed, 1);
});

test('H19 cross-window readiness suite is non-mutating and gates complete peer readiness', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const start = runtime.indexOf("id: 'h19-cross-window-readiness'");
  const end = runtime.indexOf("id: 'h19-remote-recovery'", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const readiness = runtime.slice(start, end);
  assert.match(readiness, /recommended: false/);
  assert.match(readiness, /autoStartRuntime: false/);
  assert.match(readiness, /restoreRuntimeState: false/);
  assert.match(readiness, /H19_READINESS_MISSING_REMOTE_HEARTBEAT/);
  assert.match(readiness, /H19_READINESS_VERSION_MISMATCH/);
  assert.match(readiness, /H19_READINESS_REMOTE_EMERGENCY_STOP_LATCHED/);
  assert.match(readiness, /H19_READINESS_CROSS_WINDOW_TARGET_UNAVAILABLE/);
  assert.doesNotMatch(readiness, /queueStart\(/);
  assert.doesNotMatch(readiness, /queueStop\(/);
  assert.doesNotMatch(readiness, /captureDesiredActive\(/);
  assert.doesNotMatch(readiness, /startAutonomy\(/);
});

test('H19 party recovery live suite is bounded, leader-protected and fail-closed', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const start = runtime.indexOf("id: 'h19-party-recovery'");
  const end = runtime.indexOf('_installErrorCapture()', start);
  assert.ok(start >= 0); assert.ok(end > start);
  const suite = runtime.slice(start, end);
  assert.match(suite, /recommended: false/);
  assert.match(suite, /H19_PARTY_TEST_REQUIRES_LOCAL_LEADER/);
  assert.match(suite, /H19_PARTY_FOREIGN_MEMBER_PRESENT/);
  assert.match(suite, /lifecycleAutonomyEnabled === false/);
  assert.match(suite, /requestPartyLeave\(targetName\)/);
  assert.match(suite, /requestPartyJoin\(targetName\)/);
  assert.match(suite, /startAutonomy\(\{ maxActions: 1 \}\)/);
  assert.match(suite, /H19_PARTY_INVITE_PINGPONG_DETECTED/);
  assert.match(suite, /H19_PARTY_CM_COMMAND_COUNT_INVALID/);
  assert.match(suite, /H19_PARTY_CLEANUP_MANUAL_RESTORE_REQUIRED/);
  assert.doesNotMatch(suite, /queueStop\(/);
  assert.doesNotMatch(suite, /queueStart\(/);
});

test('H19 runtime, API, UI, ActionBoundary, build and generated bundle are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const core = fs.readFileSync(path.resolve(here, '../src/core.js'), 'utf8');
  const crossWindow = fs.readFileSync(path.resolve(here, '../src/cross-window-lifecycle.js'), 'utf8');
  const fullAutonomy = fs.readFileSync(path.resolve(here, '../src/full-autonomy.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const dist = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.H19CrossWindowLifecycleTransport/);
  assert.match(runtime, /lifecycleTransport\.install\(\)/);
  assert.match(runtime, /new ns\.CharacterLifecycleController/);
  assert.match(runtime, /id: 'character-lifecycle'/);
  assert.match(runtime, /id: 'h19-character-lifecycle'/);
  assert.match(runtime, /id: 'h19-cross-window-readiness'/);
  assert.match(runtime, /id: 'h19-remote-recovery'/);
  assert.match(runtime, /id: 'h19-party-recovery'/);
  assert.match(runtime, /_registerH19RemoteRecoveryLiveTest\(\)/);
  assert.match(runtime, /_registerH19PartyRecoveryLiveTest\(\)/);
  assert.match(runtime, /const runnerActive = runnerActiveSet\(liveRoster\)/);
  assert.match(runtime, /online\.has\(row\.name\)/);
  assert.match(runtime, /runnerActive\.has\(name\)/);
  assert.match(runtime, /H19_REMOTE_CONTROLLABLE_TARGET_UNAVAILABLE/);
  assert.match(runtime, /safeFirstStartRecovery/);
  assert.match(runtime, /targetName = null;\s*targetControlMode = null;\s*baseline = null;\s*originalPolicy = null;/);
  assert.match(runtime, /const cleanupSleep = \(runtime, ms\) => new Promise/);
  assert.match(runtime, /const waitForCleanup = async \(runtime, predicate, options = \{\}\)/);
  assert.match(runtime, /cleanup: async \(\{ runtime \}\) =>/);
  assert.match(runtime, /H19_REMOTE_CLEANUP_RESTORE_UNSAFE_RETRY_BLOCKED/);
  assert.match(runtime, /H19_REMOTE_CLEANUP_RESTORE_TIMEOUT/);
  assert.match(runtime, /if \(cleanupFailure\) throw cleanupFailure/);
  assert.match(runtime, /dispatchedDelta === 1/);
  assert.match(runtime, /rejectedDelta === 0/);
  assert.match(runtime, /unknownDelta === 0/);
  assert.match(runtime, /H19_REMOTE_TARGET_NOT_RESTORED/);
  assert.match(runtime, /options\.version \|\| '0\.26\.87-h26'/);
  assert.match(entry, /runtime\.lifecycle\.queueStart/);
  assert.match(entry, /runtime\.lifecycle\.queueStop/);
  assert.match(entry, /runtime\.lifecycle\.queueRespawn/);
  assert.match(entry, /runtime\.lifecycle\.acknowledgeUnknown/);
  assert.match(entry, /Object\.freeze\(api\.lifecycle\)/);
  assert.match(ui, /H19 Character Lifecycle & Recovery/);
  assert.match(ui, /albot-h19-ack-unknown/);
  assert.match(runtime, /if \(!current\.currentAction\) runtime\.lifecycle\.resetSafety\('H19_LIVE_TEST_RESET'\)/);
  assert.match(runtime, /action\.restored === true/);
  assert.match(runtime, /action\.unknownRecorded === true/);
  assert.match(runtime, /action\.kind === 'RESPAWN'/);
  assert.match(runtime, /H19_LIVE_TEST_EXPLICIT_RETRY_ACK/);
  assert.match(runtime, /String\(action\.targetName \|\| ''\) === String\(local\.name \|\| ''\)/);
  assert.match(source, /acknowledgeUnknown\(reason = 'H19_EXPLICIT_UNKNOWN_ACK'\)/);
  assert.match(source, /settlementGeneration/);
  assert.match(source, /respawnGraceMs/);
  assert.match(source, /H19_RESPAWN_COOLDOWN/);
  assert.match(source, /H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE/);
  assert.match(source, /H19_RUNNER_ACTIVE_STATE_UNAVAILABLE/);
  assert.match(source, /cross-window-runtime/);
  assert.match(source, /desiredRuntimeRunningNames/);
  assert.match(source, /H19_DESIRED_RUNTIME_PEER_UNAVAILABLE/);
  assert.match(boundary, /start_character: Object\.freeze/);
  assert.match(boundary, /stop_character: Object\.freeze/);
  assert.match(boundary, /disconnect: Object\.freeze/);
  assert.match(boundary, /respawn: Object\.freeze/);
  assert.match(core, /accountCharacters/);
  assert.match(core, /onlineStateAvailable/);
  assert.match(core, /onlineCharacterNames/);
  assert.match(core, /runnerActiveCharacterNames/);
  assert.match(core, /activeCharacterNames/);
  assert.match(crossWindow, /requestCharacterDisconnect\(targetName\)/);
  assert.match(crossWindow, /DISCONNECT_CHARACTER/);
  assert.match(crossWindow, /ACCOUNT_ROSTER_OFFLINE_REQUIRED/);
  assert.match(crossWindow, /requestPartyLeave\(targetName\)/);
  assert.match(crossWindow, /requestPartyJoin\(targetName\)/);
  assert.match(crossWindow, /H19_CROSS_WINDOW_PARTY_LEADER_PROTECTED/);
  assert.match(crossWindow, /H19_CROSS_WINDOW_PARTY_AUTONOMY_ACTIVE/);
  assert.match(crossWindow, /H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN/);
  assert.match(crossWindow, /H19_CROSS_WINDOW_PARTY_RECOVERY_AUTHORITY_UNAVAILABLE/);
  assert.match(crossWindow, /partyRecoveryLease/);
  assert.match(source, /cross-window-character-disconnect/);
  assert.match(source, /ACTIVE_ROSTER_ABSENT_AFTER_REMOTE_SELF_DISCONNECT/);
  assert.match(fullAutonomy, /FULL_AUTONOMY_ROTATION_UNAVAILABLE/);
  assert.doesNotMatch(fullAutonomy, /fallbackUsesExactOnlineQuartet/);
  assert.match(build, /src\/cross-window-lifecycle\.js/);
  assert.match(build, /src\/lifecycle-recovery\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.87-h26'/);
  assert.match(dist, /AL Bot 0\.26\.87-h26/);
  assert.match(dist, /class H19CrossWindowLifecycleTransport/);
  assert.match(dist, /albot-h19-cross-window-v1/);
  assert.match(dist, /h19-cross-window-readiness/);
  assert.match(dist, /h19-party-recovery/);
  assert.match(dist, /requestPartyLeave\(targetName\)/);
  assert.match(dist, /requestPartyJoin\(targetName\)/);
  assert.match(dist, /class CharacterLifecycleController/);
  assert.match(dist, /H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE/);
  assert.match(dist, /H19_REMOTE_CONTROLLABLE_TARGET_UNAVAILABLE/);
  assert.equal(pkg.version, '0.26.87');
});


test('H22 live regression: non-coordinator accepts a validated owned-party invite while proactive lifecycle autonomy stays disabled', async () => {
  const f = fixture({ onlineNames: ['My_Ranger', 'My_Priest'], runnerActiveNames: ['My_Ranger', 'My_Priest'] });
  const policy = f.controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest'],
    desiredRuntimeRunningNames: [],
    desiredPartyMemberNames: ['My_Ranger', 'My_Priest'],
    desiredPartyLeader: 'My_Priest'
  });
  assert.equal(policy.accepted, true);
  assert.equal(f.controller.status().autonomyEnabled, false);

  assert.equal(f.controller._recordPartySignal('INVITE', 'My_Priest'), true);
  const dispatched = f.controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);
  assert.equal(f.state.dispatches[0].name, 'accept_party_invite');

  await flush();
  const confirmed = f.controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.kind, 'PARTY_ACCEPT_INVITE');
  assert.equal(f.controller.status().autonomyEnabled, false);
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().metrics.partyAcceptsConfirmed, 1);
});

test('H22 live regression: replacement runtime heartbeat confirms even when the old session transport never settles', () => {
  const f = fixture({
    onlineNames: ['My_Ranger', 'My_Priest'],
    runnerActiveNames: ['My_Ranger', 'My_Priest'],
    crossWindowPeers: [{ name: 'My_Priest', sessionId: 'old-session', running: false, runEpoch: 1 }],
    crossWindowNoMutation: true,
    crossWindowNeverSettle: true
  });
  const policy = f.controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest'],
    desiredRuntimeRunningNames: ['My_Priest'],
    desiredPartyMemberNames: [],
    desiredPartyLeader: null
  });
  assert.equal(policy.accepted, true);
  assert.equal(f.controller.startAutonomy({ maxActions: 4 }).accepted, true);

  const dispatched = f.controller.tick();
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.equal(f.controller.status().currentAction.before.targetSessionId, 'old-session');
  assert.equal(f.controller.status().currentAction.settlement, 'PENDING');

  f.runtimePeers.set('My_Priest', {
    name: 'My_Priest',
    sessionId: 'replacement-session',
    running: true,
    runEpoch: 1
  });

  const reconciled = f.controller.tick();
  assert.equal(reconciled.state, 'CONFIRMED');
  assert.equal(reconciled.details.evidence, 'CROSS_WINDOW_RUNTIME_REPLACED_SESSION_LIVE_STATE');
  assert.equal(reconciled.details.previousTargetSessionId, 'old-session');
  assert.equal(reconciled.details.targetSessionId, 'replacement-session');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().metrics.actionsUnknown, 0);
});


test('H26 transient start authorization rejection waits and retries without suspending lifecycle autonomy', async () => {
  const f = fixture({
    onlineNames: ['My_Ranger'],
    runnerActiveNames: ['My_Ranger'],
    noMutation: true,
    rejectPromise: true,
    rejectReason: 'authorization_in_progress',
    startRetryBackoffMs: 750
  });
  assert.equal(f.controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Merchant'],
    desiredRuntimeRunningNames: [],
    desiredPartyMemberNames: [],
    desiredPartyLeader: null
  }).accepted, true);
  assert.equal(f.controller.startAutonomy({ maxActions: 4 }).accepted, true);

  assert.equal(f.controller.tick().state, 'DISPATCHED');
  await flush();
  const waiting = f.controller.tick();
  assert.equal(waiting.state, 'WAITING');
  assert.equal(waiting.reason, 'H19_START_AUTHORIZATION_IN_PROGRESS');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().autonomyEnabled, true);
  assert.equal(f.controller.status().metrics.transientStartRejects, 1);
  assert.equal(f.state.dispatches.length, 1);

  const retry = f.controller.transientStartRetries.get('My_Merchant');
  assert.ok(retry);
  retry.retryAtMs = Date.now() - 1;
  const second = f.controller.tick();
  assert.equal(second.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 2);
});


test('H27 hard slot guard rejects a fifth START before dispatch', () => {
  const f = fixture({
    onlineNames: ['My_Ranger', 'My_Priest', 'My_Merchant', 'My_Warrior'],
    runnerActiveNames: ['My_Ranger', 'My_Priest', 'My_Merchant', 'My_Warrior']
  });
  f.state.account.push({ name: 'My_Mage', ctype: 'mage', online: false });
  const result = f.controller.queueStart('My_Mage');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H27_ACCOUNT_CHARACTER_SLOT_LIMIT_REACHED');
  assert.equal(f.state.dispatches.filter(row => row.name === 'start_character').length, 0);
});

test('H27 local outgoing browser fails closed and leaves rotation to the Merchant coordinator', () => {
  const { controller, state } = fixture({
    onlineNames: ['My_Merchant', 'My_Ranger', 'My_Priest', 'My_Warrior'],
    runnerActiveNames: ['My_Priest'],
    freezeRunnerActive: true,
    browserSwapAccountOnlineLag: true,
    maxActionsPerSession: 4
  });
  state.character.name = 'My_Priest';
  state.character.ctype = 'priest';
  state.account.push({ name: 'My_Mage', ctype: 'mage', online: false });

  const desired = ['My_Mage', 'My_Merchant', 'My_Ranger', 'My_Warrior'];
  const readiness = controller.characterRotationReadiness(desired);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'H27_ROTATION_LOCAL_REPLACEMENT_REQUIRES_MERCHANT_COORDINATOR:My_Priest');
  assert.deepEqual(clone(readiness.browserSwapPairs), []);
  assert.deepEqual(clone(state.localNavigations), []);
  assert.equal(state.dispatches.length, 0);
});
