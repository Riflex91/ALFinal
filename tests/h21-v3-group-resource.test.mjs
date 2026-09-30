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
    inventoryAvailable: true,
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
    inventorySnapshot: () => ({ available: state.inventoryAvailable, items: clone(state.items) }),
    skillDefinition: id => skillCosts[id] == null ? null : { id, mp: skillCosts[id] }
  };
  const actions = {
    dispatch: action => {
      state.dispatches.push(action);
      if (options.unknown === true) return { id: 'pot-unknown', state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.pending === true) return { id: 'pot-pending', state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.rejectObjectReason) {
        return { id: 'pot-rejected', state: 'DISPATCHED', value: Promise.reject({ reason: options.rejectObjectReason }) };
      }
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

test('resource topoff preserves unverified potion ownership across module stop and restart', () => {
  const f = resourceFixture({ mp: 100, pending: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);
  assert.ok(f.controller.status().pending);

  const stopped = f.controller.stop('H19_RUNTIME_RECOVERY_STOP');
  assert.ok(stopped.pending);
  f.controller.start({ scope: { interval: () => 'resource-loop-2' } });
  const next = f.controller.tick();
  assert.equal(next.state, 'PENDING');
  assert.equal(f.state.dispatches.length, 1);
});

test('resource topoff does not confirm a pending potion from unrelated MP regeneration alone', () => {
  const f = resourceFixture({ mp: 100, maxMp: 1000, pending: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);
  f.state.character.mp += 150;
  const next = f.controller.tick();
  assert.equal(next.state, 'PENDING');
  assert.equal(f.controller.status().metrics.confirmed, 0);
  assert.ok(f.controller.status().pending);
  assert.equal(f.state.dispatches.length, 1);
});

test('resource topoff keeps a potion pending when inventory visibility disappears after dispatch', () => {
  const f = resourceFixture({ mp: 100, maxMp: 1000, pending: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);

  f.state.inventoryAvailable = false;
  const hidden = f.controller.tick();
  assert.equal(hidden.state, 'PENDING');
  assert.equal(f.controller.status().metrics.confirmed, 0);
  assert.ok(f.controller.status().pending);
  assert.equal(f.state.dispatches.length, 1);

  f.state.inventoryAvailable = true;
  const visibleAgain = f.controller.tick();
  assert.equal(visibleAgain.state, 'PENDING');
  assert.equal(f.controller.status().metrics.confirmed, 0);
  assert.equal(f.state.dispatches.length, 1);
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

function h9FollowerFixture({ leaderX = 300, leaderMap = 'main', farmActive = false, combatActive = false } = {}) {
  const { Controller } = loadController('src/farm-intelligence.js', 'FarmIntelligenceController');
  const state = {
    moves: [], farmStarts: [], farmGroupConfigs: [], activeOrder: null,
    farmActive, combatActive, leaderVisible: true, leaderX, nowMs: 10000
  };
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
          { name: 'My_Ranger1', ctype: 'ranger', local: true, map: 'main', x: 0, y: 0 },
          ...(state.leaderVisible ? [{ name: 'My_Warrior', ctype: 'warrior', local: false, map: leaderMap, x: state.leaderX, y: 0 }] : []),
          { name: 'My_Priest', ctype: 'priest', local: false, map: 'main', x: Math.min(state.leaderX, 40), y: 20 }
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
    stopSession: () => { state.farmActive = false; return { stopped: true }; },
    configureGroup: options => {
      state.farmGroupConfigs.push(clone(options));
      return { changed: true, ...clone(options) };
    }
  };
  const combat = {
    status: () => ({ active: state.combatActive }),
    safeCandidates: () => []
  };
  const controller = new Controller({ game, combat, farming, movement, party, now: () => state.nowMs });
  controller.start({ scope: { interval: () => 'h9-loop' } });
  return { controller, state };
}

function h9LeaderFixture({ rangerX = 260, priestX = 240 } = {}) {
  const { Controller } = loadController('src/farm-intelligence.js', 'FarmIntelligenceController');
  const state = { moves: [], activeOrder: null, farmActive: false, farmStarts: [], leaderX: 0, rangerX, priestX, nowMs: 10000 };
  const character = { name: 'My_Warrior', ctype: 'warrior', map: 'main', x: 0, y: 0, hp: 4000, maxHp: 4000, mp: 500, maxMp: 500, rip: false };
  const game = {
    snapshot: () => ({ available: true, character: { ...clone(character), x: state.leaderX } }),
    visiblePlayers: () => [],
    visibleMonsters: () => [],
    farmSpotCatalog: () => [],
    monsterDefinition: () => null
  };
  const party = {
    status: () => ({
      party: {
        ownedMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior'],
        ownedMembers: [
          { name: 'My_Warrior', ctype: 'warrior', local: true, map: 'main', x: state.leaderX, y: 0 },
          { name: 'My_Ranger1', ctype: 'ranger', local: false, map: 'main', x: state.rangerX, y: 0 },
          { name: 'My_Priest', ctype: 'priest', local: false, map: 'main', x: state.priestX, y: 20 }
        ]
      }
    }),
    preferredTargetId: () => null
  };
  const movement = {
    _canMoveTo: () => true,
    status: () => ({ activeOrder: state.activeOrder, lastOrder: null }),
    moveLocal: (x, y, opts) => {
      state.moves.push({ kind: 'local', x, y, owner: opts.owner });
      state.activeOrder = { owner: opts.owner, destination: { map: 'main', x, y }, startedAtMs: state.nowMs };
      return { accepted: true, order: clone(state.activeOrder) };
    },
    cancel: () => { state.activeOrder = null; return { cancelled: true }; }
  };
  const farming = {
    status: () => ({ active: state.farmActive, session: state.farmActive ? { owner: 'farm-intelligence-h9' } : null }),
    startSession: options => { state.farmStarts.push(clone(options)); state.farmActive = true; return { accepted: true }; },
    stopSession: () => { state.farmActive = false; return { stopped: true }; }
  };
  const combat = { status: () => ({ active: false }), safeCandidates: () => [] };
  const controller = new Controller({ game, combat, farming, movement, party, now: () => state.nowMs });
  controller.start({ scope: { interval: () => 'h9-leader-loop' } });
  return { controller, state, character };
}

test('group leader stops new pulls and takes a bounded cohesion-recovery step toward separated followers', () => {
  const f = h9LeaderFixture({ rangerX: 260, priestX: 240 });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_LEADER_RECOVERY_STARTED');
  assert.equal(f.state.farmStarts.length, 0);
  assert.equal(f.state.moves.length, 1);
  assert.equal(f.state.moves[0].owner, 'farm-intelligence-h9-leader-regroup');
  assert.ok(f.state.moves[0].x > 0 && f.state.moves[0].x <= 60);
  assert.ok(started.tick.projectedMaxPairDistance < started.tick.maxPairDistance);
});

test('group leader releases regroup only after pairwise cohesion reaches the stop radius', () => {
  const f = h9LeaderFixture({ rangerX: 60, priestX: 45 });
  f.controller.session = {
    id: 'leader-test',
    enabled: true,
    owner: 'full-autonomy',
    preferredTypes: [],
    excludedTypes: [],
    allowTravel: true,
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  };
  const group = f.controller._groupContext(f.character);
  assert.ok(group.maxPairDistance <= f.controller.config.groupRegroupStopDistance);
  assert.equal(f.controller._tickGroupLeader(f.character, group), null);
});

test('group follower smart fallback targets the live Warrior rather than an offset formation coordinate', () => {
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
  assert.equal(Math.round(f.state.moves[0].destination.x), 300);
  assert.equal(Math.round(f.state.moves[0].destination.y), 0);
  assert.equal(f.state.farmStarts.length, 0);
});

test('active regroup ignores small/fast leader drift instead of retarget-chasing every tick', () => {
  const f = h9FollowerFixture({ leaderX: 300 });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(f.state.moves.length, 1);

  f.state.leaderX = 360;
  f.state.nowMs = 12000;
  const held = f.controller.tick();
  assert.equal(held.state, 'TRAVELLING');
  assert.equal(f.state.moves.length, 1);
  assert.equal(f.controller.status().metrics.groupRetargets, 0);

  f.state.leaderX = 410;
  f.state.nowMs = 15050;
  const retargeted = f.controller.tick();
  assert.equal(retargeted.state, 'TRAVELLING');
  assert.equal(f.state.moves.length, 2);
  assert.equal(f.state.moves[1].kind, 'retarget');
  assert.equal(f.controller.status().metrics.groupRetargets, 1);
});

test('rejoined follower cancels regroup before evaluating a stale leader retarget', () => {
  const f = h9FollowerFixture({ leaderX: 300 });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(f.state.moves.length, 1);

  // Rejoin now means live leader cohesion as well as formation cohesion.
  // Keep this stale-retarget regression inside the actual 70px stop radius.
  f.state.leaderX = 60;
  f.state.nowMs = 20000;
  const rejoined = f.controller.tick();
  assert.equal(rejoined.state, 'FARMING');
  assert.equal(f.state.activeOrder, null);
  assert.equal(f.state.moves.length, 1);
  assert.equal(f.controller.status().metrics.groupRetargets, 0);
  assert.equal(f.state.farmStarts.length, 1);
});

test('active regroup is cancelled when the leader position disappears', () => {
  const f = h9FollowerFixture({ leaderX: 300 });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.ok(f.state.activeOrder);
  f.state.leaderVisible = false;
  const next = f.controller.tick();
  assert.equal(next.state, 'WAITING');
  assert.equal(next.reason, 'H9_GROUP_LEADER_POSITION_UNAVAILABLE');
  assert.equal(f.state.activeOrder, null);
  assert.equal(f.controller.groupMove, null);
});

test('group follower refuses regroup when the leader map is unknown', () => {
  const f = h9FollowerFixture({ leaderX: 300, leaderMap: null });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WAITING');
  assert.equal(started.tick.reason, 'H9_GROUP_LEADER_POSITION_UNAVAILABLE');
  assert.equal(f.state.moves.length, 0);
  assert.equal(f.state.farmStarts.length, 0);
});

test('H9 propagates a changed group policy into an already-owned H8 session', () => {
  const f = h9FollowerFixture({ leaderX: 80, farmActive: true, combatActive: true });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.accepted, true);
  const updated = f.controller.configureGroup({
    groupLeaderName: 'My_Priest',
    groupMemberNames: ['My_Mage', 'My_Priest', 'My_Ranger1']
  });
  assert.equal(updated.changed, true);
  assert.equal(f.state.farmGroupConfigs.length, 1);
  assert.equal(f.state.farmGroupConfigs[0].groupLeaderName, 'My_Priest');
  assert.deepEqual([...f.state.farmGroupConfigs[0].groupMemberNames], ['My_Mage', 'My_Priest', 'My_Ranger1']);
});

test('group follower starts mirror-only farming when already inside live leader and formation cohesion', () => {
  const f = h9FollowerFixture({ leaderX: 60 });
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

test('active H8 group policy updates the farming-owned H5 combat session in place', () => {
  const { Controller } = loadController('src/farming.js', 'AdaptiveFarmingController');
  const state = { combatActive: false, combatGroup: null };
  const game = {
    snapshot: () => ({ available: true, character: { name: 'My_Ranger1', ctype: 'ranger', rip: false } })
  };
  const combat = {
    status: () => state.combatActive
      ? { active: true, session: { id: 'combat-1', owner: 'farming-h8' } }
      : { active: false, session: null },
    startSession: () => {
      state.combatActive = true;
      return { accepted: true, session: { id: 'combat-1', owner: 'farming-h8' } };
    },
    configureGroup: options => {
      state.combatGroup = clone(options);
      return { changed: true };
    },
    stopSession: () => { state.combatActive = false; return { stopped: true }; }
  };
  const controller = new Controller({ game, combat, actions: {} });
  controller.start({});
  const started = controller.startSession({
    owner: 'farm-intelligence-h9',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior'],
    leaderOwnedPulls: true
  });
  assert.equal(started.accepted, true);
  const changed = controller.configureGroup({
    groupLeaderName: 'My_Priest',
    groupMemberNames: ['My_Mage', 'My_Priest', 'My_Ranger1'],
    leaderOwnedPulls: true
  });
  assert.equal(changed.changed, true);
  assert.equal(controller.status().session.groupLeaderName, 'My_Priest');
  assert.deepEqual([...controller.status().session.groupMemberNames], ['My_Mage', 'My_Priest', 'My_Ranger1']);
  assert.equal(state.combatGroup.groupLeaderName, 'My_Priest');
  assert.deepEqual([...state.combatGroup.groupMemberNames], ['My_Mage', 'My_Priest', 'My_Ranger1']);
});

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

test('Ranger already inside danger radius executes an outward escape instead of freezing', () => {
  const f = combatFixture({ ctype: 'ranger' });
  const moved = f.controller._kite(
    { character: { ...clone(f.character), x: 50, y: 0 } },
    { id: 'm1', mtype: 'goo', x: 0, y: 0, distance: 50, targetId: 'My_Ranger1', range: 25, speed: 40 }
  );
  assert.equal(moved, true);
  assert.equal(f.state.moves.length, 1);
  assert.equal(f.controller.status().session.lastDecision.type, 'KITE_ESCAPE');
  assert.ok(Math.hypot(f.state.moves[0].x, f.state.moves[0].y) > 50);
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

test('group hard tether fails closed when a configured teammate position is missing', () => {
  const teammateRows = [
    { name: 'My_Warrior', local: false, map: 'main', x: 20, y: 0 }
  ];
  const f = combatFixture({ ctype: 'ranger', partyRows: teammateRows });
  const allowed = f.controller._groupTetherAllows(
    clone(f.character),
    { x: 120, y: 20 }
  );
  assert.equal(allowed, false);
});

test('group hard tether fails closed when a configured teammate map is unknown', () => {
  const teammateRows = [
    { name: 'My_Warrior', local: false, x: 20, y: 0 },
    { name: 'My_Priest', local: false, map: 'main', x: 30, y: 0 }
  ];
  const f = combatFixture({ ctype: 'ranger', partyRows: teammateRows });
  const allowed = f.controller._groupTetherAllows(
    clone(f.character),
    { x: 120, y: 20 }
  );
  assert.equal(allowed, false);
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

test('group follower mirrors a fresh visible leader focus before aggro starts', () => {
  const { Controller } = loadController('src/combat.js', 'CombatController');
  const state = { changeTargets: 0 };
  const character = { name: 'My_Ranger1', ctype: 'ranger', map: 'main', x: 0, y: 0, hp: 2500, maxHp: 2500, mp: 800, maxMp: 1000, range: 200, rip: false };
  const stale = { id: 'stale', mtype: 'goo', map: 'main', x: 80, y: 0, distance: 80, attack: 10, targetId: null, dead: false, visible: true, hp: 100 };
  const game = {
    snapshot: () => ({ available: true, character: clone(character), target: null }),
    visibleMonsters: () => [clone(stale)],
    entityReference: () => ({ id: 'stale' }),
    monsterDefinition: () => ({ evasion: 0, avoidance: 0 })
  };
  const actions = {
    available: () => true,
    dispatch: action => {
      if (action === 'change_target') state.changeTargets += 1;
      return { id: 'a1', state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };
  const movement = { status: () => ({ activeOrder: null }), captureSafePoint: () => ({}), cancel: () => ({}) };
  const party = {
    preferredTargetId: () => 'stale',
    isOwnedPartyMember: () => true,
    status: () => ({ party: { ownedMembers: [] } })
  };
  const controller = new Controller({ game, actions, movement, party, now: () => 10000 });
  controller.start({ scope: { interval: () => 'combat-loop' } });
  const started = controller.startSession({
    owner: 'farming-h8',
    partyAssist: true,
    leaderOwnedPulls: true,
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.accepted, true);
  const selected = controller._selectTarget({ character });
  assert.ok(selected);
  assert.equal(selected.id, 'stale');
  assert.equal(state.changeTargets, 1);
  assert.equal(controller.status().session.targetId, 'stale');
});

test('group follower keeps an active group-aggro target when preferred focus is stale', () => {
  const { Controller } = loadController('src/combat.js', 'CombatController');
  const state = { changeTargets: 0, attacks: 0 };
  const character = { name: 'My_Ranger1', ctype: 'ranger', map: 'main', x: 0, y: 0, hp: 2500, maxHp: 2500, mp: 800, maxMp: 1000, range: 200, rip: false };
  const active = { id: 'active', mtype: 'goo', map: 'main', x: 80, y: 0, distance: 80, attack: 10, targetId: 'My_Warrior', dead: false, visible: true, hp: 100 };
  const stale = { id: 'stale', mtype: 'goo', map: 'main', x: 90, y: 0, distance: 90, attack: 10, targetId: null, dead: false, visible: true, hp: 100 };
  const game = {
    snapshot: () => ({ available: true, character: clone(character), target: clone(active) }),
    visibleMonsters: () => [clone(active), clone(stale)],
    entityReference: id => ({ id }),
    monsterDefinition: () => ({ evasion: 0, avoidance: 0 }),
    combatReadiness: () => ({ targetAvailable: true, inRange: true, canAttack: false, cooldown: true })
  };
  const actions = {
    available: () => true,
    dispatch: action => {
      if (action === 'change_target') state.changeTargets += 1;
      if (action === 'attack') state.attacks += 1;
      return { id: 'a1', state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };
  const movement = { status: () => ({ activeOrder: null }), captureSafePoint: () => ({}), cancel: () => ({}) };
  const party = {
    preferredTargetId: () => 'stale',
    isOwnedPartyMember: name => ['My_Warrior', 'My_Priest', 'My_Ranger1'].includes(String(name)),
    status: () => ({ party: { ownedMembers: [] } })
  };
  const controller = new Controller({ game, actions, movement, party, now: () => 10000 });
  controller.start({ scope: { interval: () => 'combat-loop' } });
  const started = controller.startSession({
    owner: 'farming-h8',
    partyAssist: true,
    leaderOwnedPulls: true,
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.accepted, true);
  controller.session.targetId = 'active';
  controller.session.targetType = 'goo';
  controller._tick();
  assert.equal(controller.status().session.targetId, 'active');
  assert.equal(state.changeTargets, 0);
  assert.equal(state.attacks, 0);
});

test('group members share one orbit direction instead of orbiting against each other', () => {
  const teammateRows = [
    { name: 'My_Warrior', local: false, map: 'main', x: 20, y: 0 },
    { name: 'My_Priest', local: false, map: 'main', x: 30, y: 10 }
  ];
  const f = combatFixture({ ctype: 'ranger', partyRows: teammateRows });
  const first = f.controller._orbitDirection({ name: 'My_Ranger1' });
  const second = f.controller._orbitDirection({ name: 'My_Ranger2' });
  assert.equal(first, second);
});

test('group soft kite tether only permits out-of-formation motion when it improves cohesion', () => {
  const teammateRows = [
    { name: 'My_Warrior', local: false, map: 'main', x: 0, y: 0 },
    { name: 'My_Priest', local: false, map: 'main', x: 20, y: 0 }
  ];
  const f = combatFixture({ ctype: 'ranger', partyRows: teammateRows });
  assert.equal(f.controller._groupTetherAllows(clone(f.character), { x: 120, y: 0 }), false);
  assert.equal(f.controller._groupTetherAllows(clone(f.character), { x: 80, y: 0 }), true);
});

test('group kill race recovers a server not_there rejection when live target is already gone', () => {
  const f = combatFixture({
    ctype: 'ranger',
    partyRows: [
      { name: 'My_Warrior', local: false, map: 'main', x: 20, y: 0 },
      { name: 'My_Priest', local: false, map: 'main', x: 30, y: 0 }
    ]
  });
  f.controller.session.targetId = 'already-killed';
  f.controller.session.targetType = 'goo';
  f.controller.pendingAttack = {
    attackId: 'attack-race',
    targetId: 'already-killed',
    baselineHp: 25,
    deadlineAtMs: 12000,
    commandSettlement: 'REJECTED',
    commandResponse: null,
    commandError: 'not_there'
  };
  assert.equal(f.controller._observePendingAttack(), true);
  assert.equal(f.controller.status().active, true);
  assert.equal(f.controller.status().session.state, 'ACQUIRING');
  assert.equal(f.controller.status().metrics.attackTargetRaceRecoveries, 1);
  assert.equal(f.state.h9Suspensions.length, 0);
});

test('network-uncertain group attack still fails closed instead of using kill-race recovery', () => {
  const f = combatFixture({
    ctype: 'ranger',
    partyRows: [
      { name: 'My_Warrior', local: false, map: 'main', x: 20, y: 0 },
      { name: 'My_Priest', local: false, map: 'main', x: 30, y: 0 }
    ]
  });
  f.controller.session.targetId = 'uncertain';
  f.controller.pendingAttack = {
    attackId: 'attack-uncertain',
    targetId: 'uncertain',
    baselineHp: 25,
    deadlineAtMs: 12000,
    commandSettlement: 'REJECTED',
    commandResponse: null,
    commandError: 'ATTACK_NETWORK_UNCERTAIN'
  };
  assert.equal(f.controller._observePendingAttack(), true);
  assert.equal(f.controller.status().active, false);
  assert.equal(f.controller.status().lastSession.state, 'UNKNOWN');
  assert.equal(f.controller.status().metrics.attackTargetRaceRecoveries, 0);
  assert.equal(f.state.h9Suspensions.length, 1);
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
  assert.match(runtime, /async emergencyStop[\s\S]*?_h19FullAutonomyRearmIntent = null[\s\S]*?stopLatch\.latch/);
  assert.match(runtime, /async stop[\s\S]*?EMERGENCY\|UNKNOWN\|UNVERIFIED\|TERMINAL\|SAFETY\|SUSPEND\|FAIL[\s\S]*?_h19FullAutonomyRearmIntent = null/);
  assert.match(runtime, /waitForRoster: true/);
  assert.match(runtime, /this\.merchant\.economy = this\.economy/);
  assert.match(build, /src\/resource-topoff\.js/);
  assert.match(boundary, /use_hp: Object\.freeze/);
  assert.match(boundary, /use_mp: Object\.freeze/);
});


test('H22 live regression: structured potion cooldown rejection stays a known reject instead of [object Object] UNKNOWN', async () => {
  const f = resourceFixture({ mp: 100, rejectObjectReason: 'cooldown' });
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  await Promise.resolve();
  await Promise.resolve();

  const observed = f.controller.tick();
  assert.equal(observed.state, 'OBSERVED');
  const status = f.controller.status();
  assert.equal(status.suspended, false);
  assert.equal(status.metrics.rejected, 1);
  assert.equal(status.metrics.unknown, 0);
  assert.equal(status.lastUse.state, 'REJECTED');
  assert.equal(status.lastUse.reason, 'cooldown');
});
