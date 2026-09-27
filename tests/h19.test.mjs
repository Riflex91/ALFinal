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
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', dispatched: true, error: { message: 'NETWORK_UNCERTAIN' } };

      if (name === 'start_character' && options.noMutation !== true) {
        state.online.add(String(args[0]));
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
    canAct: () => options.actionBlocked !== true,
    outcomeTimeoutMs: options.outcomeTimeoutMs == null ? 5000 : options.outcomeTimeoutMs,
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
    recreate: extra => fixture({ ...options, ...(extra || {}), state, storage })
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

test('H19 runtime, API, UI, ActionBoundary, build and generated bundle are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const core = fs.readFileSync(path.resolve(here, '../src/core.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const dist = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.CharacterLifecycleController/);
  assert.match(runtime, /id: 'character-lifecycle'/);
  assert.match(runtime, /id: 'h19-character-lifecycle'/);
  assert.match(runtime, /id: 'h19-remote-recovery'/);
  assert.match(runtime, /_registerH19RemoteRecoveryLiveTest\(\)/);
  assert.match(runtime, /const runnerActive = runnerActiveSet\(roster\)/);
  assert.match(runtime, /online\.has\(row\.name\)/);
  assert.match(runtime, /runnerActive\.has\(row\.name\)/);
  assert.match(runtime, /H19_REMOTE_CONTROLLABLE_TARGET_UNAVAILABLE/);
  assert.match(runtime, /safeFirstStartRecovery/);
  assert.match(runtime, /targetName = null;\s*baseline = null;\s*originalPolicy = null;/);
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
  assert.match(runtime, /options\.version \|\| '0\.19\.0-h19'/);
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
  assert.match(boundary, /start_character: Object\.freeze/);
  assert.match(boundary, /stop_character: Object\.freeze/);
  assert.match(boundary, /respawn: Object\.freeze/);
  assert.match(core, /accountCharacters/);
  assert.match(core, /onlineStateAvailable/);
  assert.match(core, /onlineCharacterNames/);
  assert.match(core, /runnerActiveCharacterNames/);
  assert.match(core, /activeCharacterNames/);
  assert.match(build, /src\/lifecycle-recovery\.js/);
  assert.match(build, /AL Bot 0\.19\.0-h19/);
  assert.match(dist, /AL Bot 0\.19\.0-h19/);
  assert.match(dist, /class CharacterLifecycleController/);
  assert.match(dist, /H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE/);
  assert.match(dist, /H19_REMOTE_CONTROLLABLE_TARGET_UNAVAILABLE/);
  assert.equal(pkg.version, '0.19.0');
});
