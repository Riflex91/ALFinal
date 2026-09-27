import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const cleanText = (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max);

function loadController(file, exportedName, extraHelpers = {}) {
  const source = fs.readFileSync(path.resolve(here, '..', file), 'utf8');
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText, ...extraHelpers } }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: file });
  return { Controller: ctx.__ALBOT_INTERNALS__[exportedName], ctx, source };
}

function resourceFixture(options = {}) {
  const { Controller } = loadController('src/resource-topoff.js', 'ResourceTopoffController');
  const state = {
    character: {
      name: options.name || 'My_Ranger1',
      ctype: options.ctype || 'ranger',
      hp: options.hp == null ? 2800 : options.hp,
      maxHp: options.maxHp == null ? 2800 : options.maxHp,
      mp: options.mp == null ? 250 : options.mp,
      maxMp: options.maxMp == null ? 1000 : options.maxMp,
      rip: false
    },
    items: [
      { slot: 0, name: 'hpot0', quantity: 20 },
      { slot: 1, name: 'mpot0', quantity: options.mpPotions == null ? 20 : options.mpPotions }
    ],
    dispatches: []
  };
  const skillCosts = {
    huntersmark: 240, supershot: 400, '5shot': 320, '3shot': 200,
    heal: 120, partyheal: 400, revive: 500, curse: 160, darkblessing: 240,
    hardshell: 120, charge: 200, taunt: 40, warcry: 320, cleave: 160, stomp: 240,
    mluck: 10
  };
  const game = {
    snapshot: () => ({ available: true, character: clone(state.character) }),
    inventorySnapshot: () => ({ available: true, items: clone(state.items) }),
    skillDefinition: id => skillCosts[id] == null ? null : { id, mp: skillCosts[id] }
  };
  const actions = {
    dispatch: action => {
      state.dispatches.push(action);
      if (options.unknown === true) return { id: 'pot-unknown', state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (action === 'use_mp') {
        state.character.mp = Math.min(state.character.maxMp, state.character.mp + 400);
        const row = state.items.find(item => item.name === 'mpot0');
        if (row) row.quantity -= 1;
      } else if (action === 'use_hp') {
        state.character.hp = Math.min(state.character.maxHp, state.character.hp + 400);
        const row = state.items.find(item => item.name === 'hpot0');
        if (row) row.quantity -= 1;
      }
      return { id: 'pot-' + state.dispatches.length, state: 'DISPATCHED', value: Promise.resolve({ success: true, used: true }) };
    }
  };
  const controller = new Controller({ game, actions, root: { G: { items: {
    hpot0: { gives: [['hp', 400]] },
    mpot0: { gives: [['mp', 400]] }
  } } } });
  controller.start({ scope: { interval: () => 'resource-loop' } });
  return { controller, state };
}

test('resource topoff preserves enough MP for the most expensive relevant class skill', async () => {
  const f = resourceFixture({ mp: 250, maxMp: 1000 });
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(first.action, 'use_mp');
  assert.equal(first.reason, 'SKILL_MP_RESERVE');
  assert.deepEqual(f.state.dispatches, ['use_mp']);
  assert.ok(f.controller.status().skillReserve.requiredMp >= 500);

  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.confirmed, 1);
  assert.equal(f.state.character.mp, 650);
});

test('resource topoff keeps V3 utilization protection for tiny non-operational deficits', () => {
  const f = resourceFixture({ mp: 950, maxMp: 1000 });
  const result = f.controller.tick();
  assert.equal(result.state, 'WAITING');
  assert.equal(result.reason, 'RESOURCE_TOPOFF_UTILIZATION_HOLD');
  assert.deepEqual(f.state.dispatches, []);
});

test('resource topoff suspends on UNKNOWN and never blindly retries', () => {
  const f = resourceFixture({ mp: 100, unknown: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'SUSPENDED');
  assert.equal(first.reason, 'RESOURCE_TOPOFF_DISPATCH_UNKNOWN');
  assert.equal(f.state.dispatches.length, 1);
  const second = f.controller.tick();
  assert.equal(second.state, 'SUSPENDED');
  assert.equal(f.state.dispatches.length, 1);
});

function h9FollowerFixture({ leaderX = 300, farmActive = false, combatActive = false } = {}) {
  const { Controller } = loadController('src/farm-intelligence.js', 'FarmIntelligenceController');
  const state = { moves: [], farmStarts: [], activeOrder: null, farmActive, combatActive };
  const character = { name: 'My_Ranger1', ctype: 'ranger', map: 'main', x: 0, y: 0, hp: 2500, maxHp: 2500, mp: 700, maxMp: 900, rip: false };
  const game = {
    snapshot: () => ({ available: true, character: clone(character) }),
    visiblePlayers: () => [],
    farmSpotCatalog: () => [],
    monsterDefinition: () => null
  };
  const party = {
    status: () => ({
      party: {
        ownedMemberNames: ['My_Ranger1', 'My_Priest', 'My_Warrior'],
        ownedMembers: [
          { name: 'My_Ranger1', local: true, map: 'main', x: 0, y: 0 },
          { name: 'My_Warrior', local: false, map: 'main', x: leaderX, y: 0 },
          { name: 'My_Priest', local: false, map: 'main', x: Math.min(leaderX, 40), y: 20 }
        ]
      }
    }),
    preferredTargetId: () => 'leader-target'
  };
  const movement = {
    status: () => ({ activeOrder: state.activeOrder, lastOrder: null }),
    smartMove: (destination, opts) => {
      state.moves.push({ kind: 'smart', destination: clone(destination), owner: opts.owner });
      state.activeOrder = { owner: opts.owner, destination: clone(destination), startedAtMs: 0 };
      return { accepted: true, order: clone(state.activeOrder) };
    },
    retarget: (destination, opts) => {
      state.moves.push({ kind: 'retarget', destination: clone(destination), owner: opts.owner });
      state.activeOrder = { owner: opts.owner, destination: clone(destination), startedAtMs: 0 };
      return { accepted: true, changed: true, order: clone(state.activeOrder) };
    },
    cancel: () => { state.activeOrder = null; return { cancelled: true }; }
  };
  const farming = {
    status: () => ({
      active: state.farmActive,
      session: state.farmActive ? { owner: 'farm-intelligence-h9', monsterType: null } : null
    }),
    startSession: options => {
      state.farmStarts.push(clone(options));
      state.farmActive = true;
      return { accepted: true, session: { id: 'farm-1' } };
    },
    stopSession: () => { state.farmActive = false; return { stopped: true }; }
  };
  const combat = {
    status: () => ({ active: state.combatActive }),
    safeCandidates: () => []
  };
  const controller = new Controller({ game, combat, farming, movement, party, now: () => 10000 });
  controller.start({ scope: { interval: () => 'h9-loop' } });
  return { controller, state };
}

test('group follower never chooses its own farm direction and smart-regroups to the Warrior leader', () => {
  const f = h9FollowerFixture({ leaderX: 300 });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_REGROUP_STARTED');
  assert.equal(f.state.moves.length, 1);
  assert.equal(f.state.moves[0].owner, 'farm-intelligence-h9-group-regroup');
  assert.equal(f.state.moves[0].destination.x, 300);
  assert.equal(f.state.farmStarts.length, 0);
});

test('group follower starts mirror-only farming when already inside formation', () => {
  const f = h9FollowerFixture({ leaderX: 80 });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'FARMING');
  assert.equal(f.state.moves.length, 0);
  assert.equal(f.state.farmStarts.length, 1);
  assert.equal(f.state.farmStarts[0].monsterType, null);
  assert.equal(f.state.farmStarts[0].leaderOwnedPulls, true);
  assert.equal(f.state.farmStarts[0].groupLeaderName, 'My_Warrior');
});

test('active group follower holds fire position until hard regroup distance is exceeded', () => {
  const f = h9FollowerFixture({ leaderX: 150, farmActive: true, combatActive: true });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'FARMING');
  assert.equal(started.tick.reason, 'H9_GROUP_FORMATION_HOLD');
  assert.equal(f.state.moves.length, 0);
});

function combatFixture({ ctype = 'ranger', partyRows = [] } = {}) {
  const { Controller } = loadController('src/combat.js', 'CombatController');
  const state = { moves: [], h9Suspensions: [] };
  const character = {
    name: ctype === 'warrior' ? 'My_Warrior' : 'My_Ranger1',
    ctype, map: 'main', x: 100, y: 0, hp: 2500, maxHp: 2500, mp: 800, maxMp: 1000,
    range: ctype === 'warrior' ? 45 : 200, speed: 55, rip: false
  };
  const game = {
    snapshot: () => ({ available: true, character: clone(character), target: null }),
    visibleMonsters: () => [],
    monsterDefinition: () => ({ range: 25, speed: 40 }),
    entityReference: () => null
  };
  const movement = {
    status: () => ({ activeOrder: null }),
    _canMoveTo: () => true,
    moveLocal: (x, y, opts) => {
      state.moves.push({ x, y, owner: opts.owner });
      return { accepted: true, order: { owner: opts.owner, destination: { x, y } } };
    },
    cancel: () => ({ cancelled: true })
  };
  const actions = { available: () => false, dispatch: () => ({ state: 'UNAVAILABLE' }) };
  const party = {
    status: () => ({ party: { ownedMembers: clone(partyRows) } }),
    preferredTargetId: () => null,
    isOwnedPartyMember: () => true
  };
  const farming = { onCombatEnded: () => {} };
  const farmIntelligence = {
    suspendFromCombatUnknown: (reason, details) => {
      state.h9Suspensions.push({ reason, details: clone(details) });
      return { suspended: true };
    }
  };
  const controller = new Controller({ game, movement, actions, party, farming, farmIntelligence, now: () => 10000 });
  controller.start({ scope: { interval: () => 'combat-loop' } });
  const start = controller.startSession({
    owner: 'farming-h8',
    kiting: true,
    leaderOwnedPulls: partyRows.length > 0,
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(start.accepted, true);
  return { controller, state, character };
}

test('Warrior remains the stable melee anchor and never enters routine kite movement', () => {
  const f = combatFixture({ ctype: 'warrior' });
  const moved = f.controller._kite(
    { character: clone(f.character) },
    { id: 'm1', mtype: 'goo', x: 80, y: 0, distance: 20, targetId: 'My_Warrior' }
  );
  assert.equal(moved, false);
  assert.equal(f.state.moves.length, 0);
  assert.equal(f.controller.status().metrics.meleeKiteBypasses, 1);
});

test('Ranger with self aggro uses a terrain-aware tangential/orbital kite waypoint', () => {
  const f = combatFixture({ ctype: 'ranger' });
  const moved = f.controller._kite(
    { character: clone(f.character) },
    { id: 'm1', mtype: 'goo', x: 0, y: 0, distance: 100, targetId: 'My_Ranger1', range: 25, speed: 40 }
  );
  assert.equal(moved, true);
  assert.equal(f.state.moves.length, 1);
  assert.equal(f.state.moves[0].owner, 'combat-h5-kite');
  assert.ok(Math.abs(f.state.moves[0].y) > 1, 'kite should have a tangential component');
  assert.equal(f.controller.status().session.lastDecision.type, 'KITE_ORBIT');
});

test('non-aggro Ranger holds fire position instead of kiting', () => {
  const f = combatFixture({ ctype: 'ranger' });
  const moved = f.controller._kite(
    { character: clone(f.character) },
    { id: 'm1', mtype: 'goo', x: 0, y: 0, distance: 100, targetId: 'My_Warrior', range: 25, speed: 40 }
  );
  assert.equal(moved, false);
  assert.equal(f.state.moves.length, 0);
  assert.equal(f.controller.status().metrics.kiteNoAggroHolds, 1);
});

test('group hard tether blocks a kite that would split the combat trio', () => {
  const teammateRows = [
    { name: 'My_Warrior', local: false, map: 'main', x: 0, y: 0 },
    { name: 'My_Priest', local: false, map: 'main', x: 20, y: 0 }
  ];
  const f = combatFixture({ ctype: 'ranger', partyRows: teammateRows });
  const allowed = f.controller._groupTetherAllows(
    clone(f.character),
    { x: 260, y: 0 }
  );
  assert.equal(allowed, false);
});

test('combat UNKNOWN propagates into Farm Intelligence suspension', () => {
  const f = combatFixture({ ctype: 'ranger' });
  f.controller._fail('UNKNOWN', 'ATTACK_OUTCOME_UNCONFIRMED', { attackId: 'act-1' });
  assert.equal(f.state.h9Suspensions.length, 1);
  assert.equal(f.state.h9Suspensions[0].reason, 'ATTACK_OUTCOME_UNCONFIRMED');
  assert.equal(f.controller.status().lastSession.state, 'UNKNOWN');
});

test('Merchant service yields while Economy owns execution', () => {
  const { Controller } = loadController('src/merchant.js', 'MerchantController', {
    COMBAT_CLASSES: new Set(['warrior', 'ranger', 'mage', 'priest', 'rogue', 'paladin'])
  });
  const controller = new Controller({
    game: {},
    actions: {},
    roster: {},
    movement: {},
    inventory: {}
  });
  controller.start({ scope: { interval: () => 'merchant-loop' } });
  controller.plan = () => ({ pressure: { state: 'LOW' }, service: { type: 'IDLE' } });
  controller.partyLogistics = { status: () => ({ autonomyEnabled: false, currentAction: null, queue: [] }) };
  controller.economy = { status: () => ({ autonomyEnabled: true, currentAction: { kind: 'BANK_DEPOSIT' }, queue: [] }) };
  const result = controller.tick();
  assert.equal(result.state, 'WAITING');
  assert.equal(result.reason, 'H11_ECONOMY_OWNERSHIP');
});

test('runtime and build wire resource topoff and safe H19 Full Live rearm', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  assert.match(runtime, /new ns\.ResourceTopoffController/);
  assert.match(runtime, /id: 'resource-topoff'/);
  assert.match(runtime, /_h19FullAutonomyRearmIntent/);
  assert.match(runtime, /waitForRoster: true/);
  assert.match(runtime, /this\.merchant\.economy = this\.economy/);
  assert.match(build, /src\/resource-topoff\.js/);
  assert.match(boundary, /use_hp: Object\.freeze/);
  assert.match(boundary, /use_mp: Object\.freeze/);
});
