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
    active: new Set(options.activeNames || ['My_Ranger', 'My_Priest']),
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
      activeStateAvailable: options.activeUnavailable !== true,
      local: { name: state.character.name, ctype: state.character.ctype, online: true, state: 'self' },
      characters: state.account.filter(row => state.active.has(row.name)).map(row => ({ ...clone(row), state: row.name === state.character.name ? 'self' : 'active' })),
      accountCharacters: clone(state.account),
      activeCharacterNames: [...state.active].sort(),
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

      if (name === 'start_character' && options.noMutation !== true) state.active.add(String(args[0]));
      if (name === 'stop_character' && options.noMutation !== true) state.active.delete(String(args[0]));
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
        return { id: 'act-' + state.dispatches.length, state: 'DISPATCHED', value: Promise.reject(new Error('PROMISE_REJECTED')) };
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

test('H19 respawn is local-only and needs settled live rip=false evidence', async () => {
  const { controller, state } = fixture({ dead: true });
  assert.equal(controller.queueRespawn().accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await flush();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(state.character.rip, false);
  assert.equal(controller.status().metrics.respawnsConfirmed, 1);
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


test('H19 synchronous UNKNOWN preserves ownership and suspends without retry', () => {
  const { controller, state } = fixture({ syncUnknown: true, noMutation: true });
  assert.equal(controller.queueStart('My_Merchant').accepted, true);
  const result = controller.tick();
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.reason, /H19_DISPATCH_SYNC_UNKNOWN/);
  assert.equal(controller.status().suspended, true);
  assert.ok(controller.status().currentAction);
  assert.equal(state.dispatches.length, 1);
  controller.tick();
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

test('H19 captureDesiredActive drives bounded missing-character recovery', async () => {
  const { controller, state } = fixture({ activeNames: ['My_Ranger', 'My_Priest'] });
  assert.equal(controller.captureDesiredActive().accepted, true);
  state.active.add('My_Merchant');
  assert.equal(controller.captureDesiredActive().accepted, true);
  state.active.delete('My_Merchant');

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
});

test('H19 party leader invites a missing active desired member and confirms from party snapshot', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest', 'My_Merchant'],
    partyMembers: ['My_Ranger', 'My_Priest'],
    partyLeader: 'My_Ranger'
  });
  assert.equal(controller.captureDesiredActive().accepted, true);
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

test('H19 nonleader requests the captured desired leader after party loss', async () => {
  const { controller, state } = fixture({
    activeNames: ['My_Ranger', 'My_Priest']
  });
  assert.equal(controller.setPolicy({
    desiredActiveNames: ['My_Ranger', 'My_Priest'],
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

test('H19 fails closed when account or active roster truth is unavailable', () => {
  const accountUnavailable = fixture({ accountUnavailable: true });
  assert.equal(accountUnavailable.controller.queueStart('My_Merchant').accepted, false);
  assert.equal(accountUnavailable.state.dispatches.length, 0);

  const activeUnavailable = fixture({ activeUnavailable: true });
  assert.equal(activeUnavailable.controller.queueStart('My_Merchant').accepted, false);
  assert.equal(activeUnavailable.state.dispatches.length, 0);
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
  assert.match(runtime, /options\.version \|\| '0\.19\.0-h19'/);
  assert.match(entry, /runtime\.lifecycle\.queueStart/);
  assert.match(entry, /runtime\.lifecycle\.queueStop/);
  assert.match(entry, /runtime\.lifecycle\.queueRespawn/);
  assert.match(entry, /Object\.freeze\(api\.lifecycle\)/);
  assert.match(ui, /H19 Character Lifecycle & Recovery/);
  assert.match(boundary, /start_character: Object\.freeze/);
  assert.match(boundary, /stop_character: Object\.freeze/);
  assert.match(boundary, /respawn: Object\.freeze/);
  assert.match(core, /accountCharacters/);
  assert.match(core, /activeCharacterNames/);
  assert.match(build, /src\/lifecycle-recovery\.js/);
  assert.match(build, /AL Bot 0\.19\.0-h19/);
  assert.match(dist, /AL Bot 0\.19\.0-h19/);
  assert.match(dist, /class CharacterLifecycleController/);
  assert.equal(pkg.version, '0.19.0');
});
