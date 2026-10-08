import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/farm-intelligence.js'), 'utf8');

function makeFixture(options = {}) {
  let now = options.now == null ? 100000 : options.now;
  const character = {
    name: options.characterName || 'Farmer',
    ctype: options.ctype || 'ranger',
    map: 'main',
    x: 0,
    y: 0,
    hp: 1000,
    maxHp: 1000,
    mp: 1000,
    maxMp: 1000,
    attack: 200,
    frequency: 1,
    speed: 50,
    damageType: options.damageType || 'physical',
    rip: false
  };

  let safe = (options.safe || [
    { id: 'g1', mtype: 'goo', map: 'main', x: 20, y: 20, distance: 28, attack: 10, targetId: null }
  ]).map(row => ({ ...row }));

  const definitions = {
    goo: { id: 'goo', hp: 500, attack: 10, xp: 100, gold: 20, dropSignal: 0.2 },
    bee: { id: 'bee', hp: 500, attack: 12, xp: 400, gold: 80, dropSignal: 0.5 },
    crab: { id: 'crab', hp: 700, attack: 15, xp: 250, gold: 60, dropSignal: 0.3 },
    ...(options.definitions || {})
  };
  let catalog = (options.catalog || []).map(row => ({ ...row }));
  let players = (options.players || []).map(row => ({ ...row }));

  let farmState = options.foreignFarm
    ? { active: true, session: { owner: 'someone-else', monsterType: 'goo' } }
    : { active: false, session: null };
  const farmingCalls = [];
  const farming = {
    status: () => JSON.parse(JSON.stringify(farmState)),
    startSession: args => {
      farmingCalls.push({ type: 'start', args: { ...args } });
      if (options.rejectFarmStart) return { accepted: false, reason: 'TEST_FARM_REJECT' };
      farmState = { active: true, session: { owner: args.owner, monsterType: args.monsterType } };
      return { accepted: true, session: { ...farmState.session } };
    },
    stopSession: reason => {
      farmingCalls.push({ type: 'stop', reason });
      const old = farmState.session;
      farmState = { active: false, session: null };
      return { stopped: true, session: old };
    }
  };

  let movementState = options.foreignMovement
    ? { active: true, activeOrder: { id: 'foreign-move', owner: 'other-module', state: 'ACTIVE', destination: { map: 'main', x: 400, y: 0 } }, lastOrder: null }
    : { active: false, activeOrder: null, lastOrder: null };
  const movementCalls = [];
  let movementSequence = 0;
  const movement = {
    status: () => JSON.parse(JSON.stringify(movementState)),
    _canMoveTo: () => options.canMoveTo !== false,
    smartMove: (destination, args) => {
      movementCalls.push({ type: 'smart', destination: { ...destination }, args: { ...args } });
      const order = {
        id: 'move-' + (++movementSequence),
        owner: args.owner,
        state: 'ACTIVE',
        destination: { ...destination },
        transient: args.transient === true
      };
      movementState = { active: true, activeOrder: order, lastOrder: null };
      return { accepted: true, order: { ...order } };
    },
    moveLocal: (x, y, args) => {
      const destination = { map: character.map, x: Number(x), y: Number(y) };
      movementCalls.push({ type: 'local', destination: { ...destination }, args: { ...args } });
      const order = {
        id: 'move-' + (++movementSequence),
        owner: args.owner,
        state: 'ACTIVE',
        destination,
        transient: args.transient === true
      };
      movementState = { active: true, activeOrder: order, lastOrder: null };
      return { accepted: true, order: { ...order } };
    },
    retarget: (destination, args) => {
      movementCalls.push({ type: 'retarget', destination: { ...destination }, args: { ...args } });
      const order = {
        id: movementState.activeOrder && movementState.activeOrder.id || 'move-' + (++movementSequence),
        owner: args.owner,
        state: 'ACTIVE',
        destination: { ...destination },
        transient: args.transient === true
      };
      movementState = { active: true, activeOrder: order, lastOrder: null };
      return { accepted: true, order: { ...order } };
    },
    cancel: reason => {
      movementCalls.push({ type: 'cancel', reason });
      movementState = { active: false, activeOrder: null, lastOrder: movementState.activeOrder };
      return { cancelled: true };
    }
  };

  const game = {
    snapshot: () => ({ available: true, character: { ...character } }),
    visiblePlayers: () => players.map(row => ({ ...row })),
    monsterDefinition: type => definitions[type] ? { ...definitions[type] } : null,
    farmSpotCatalog: () => catalog.map(row => ({
      ...row,
      definition: row.definition || (definitions[row.mtype] ? { ...definitions[row.mtype] } : null)
    }))
  };
  const combat = { safeCandidates: () => safe.map(row => ({ ...row })) };
  let foreignParty = options.foreignParty ? ['Stranger'] : [];
  const partyOwnedMembers = (options.partyOwnedMembers || [{
    name: character.name,
    ctype: character.ctype,
    damageType: character.damageType,
    map: character.map,
    x: character.x,
    y: character.y
  }]).map(row => ({ ...row }));
  const party = { status: () => ({ party: {
    ownedMemberNames: partyOwnedMembers.map(row => String(row.name)),
    ownedMembers: partyOwnedMembers.map(row => ({ ...row })),
    foreignMemberNames: foreignParty.slice()
  } }) };

  const ctx = {
    console,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
        cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'farm-intelligence.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const controller = new Controller({
    game, combat, farming, movement, party,
    now: () => now,
    minHoldMs: options.minHoldMs || 5000,
    switchCooldownMs: options.switchCooldownMs || 5000,
    pingPongWindowMs: options.pingPongWindowMs || 120000,
    switchImprovementRatio: options.switchImprovementRatio || 0.18
  });
  controller.start({ scope: { interval: () => 'resource-1' }, heartbeat() {} });

  return {
    controller,
    farmingCalls,
    movementCalls,
    character,
    setSafe: rows => { safe = rows.map(row => ({ ...row })); },
    setCatalog: rows => { catalog = rows.map(row => ({ ...row })); },
    setPlayers: rows => { players = rows.map(row => ({ ...row })); },
    setForeignParty: names => { foreignParty = names.slice(); },
    setNow: value => { now = value; },
    advance: ms => { now += ms; },
    movementUnknown: (transient = false) => {
      const last = movementState.activeOrder || { id: 'move-failed', owner: 'farm-intelligence-h9' };
      movementState = {
        active: false,
        activeOrder: null,
        lastOrder: { ...last, state: 'UNKNOWN', reason: 'failed', commandError: 'failed', transient: transient === true }
      };
    },
    movementComplete: () => {
      const last = movementState.activeOrder;
      movementState = { active: false, activeOrder: null, lastOrder: last ? { ...last, state: 'COMPLETED' } : null };
    },
    setActiveMovementOwner: owner => {
      movementState = {
        active: true,
        activeOrder: {
          id: 'move-delegated',
          owner,
          state: 'ACTIVE',
          destination: { map: 'main', x: 80, y: 0 }
        },
        lastOrder: null
      };
    },
    farmState: () => JSON.parse(JSON.stringify(farmState))
  };
}

function cluster(type, count, baseX = 20, baseY = 20) {
  return Array.from({ length: count }, (_, i) => ({
    id: type + '-' + i,
    mtype: type,
    map: 'main',
    x: baseX + i * 4,
    y: baseY + i * 3,
    distance: Math.hypot(baseX + i * 4, baseY + i * 3),
    attack: type === 'bee' ? 12 : 10,
    targetId: null
  }));
}

test('H9 scores live-safe clusters and starts H8 with the best monster type', () => {
  const f = makeFixture({ safe: [...cluster('goo', 2), ...cluster('bee', 4, 30, 25)] });
  const started = f.controller.startAutonomy();
  assert.equal(started.accepted, true);
  const status = f.controller.status();
  assert.equal(status.currentSelection.mtype, 'bee');
  assert.equal(status.lastPlan.state, 'FARM_READY');
  assert.equal(f.farmState().active, true);
  assert.equal(f.farmState().session.owner, 'farm-intelligence-h9');
  assert.equal(f.farmState().session.monsterType, 'bee');
  assert.equal(status.metrics.farmingStarts, 1);
});

test('H9 excludes near-unhittable high-evasion farm targets for physical classes', () => {
  const f = makeFixture({
    damageType: 'physical',
    safe: [...cluster('frog', 2, 15, 15), ...cluster('goo', 2, 40, 40)],
    definitions: {
      frog: { id: 'frog', hp: 600, attack: 24, xp: 7200, gold: 313, dropSignal: 0.16, evasion: 99 }
    },
    catalog: [{ key: 'main:frog:0', map: 'main', mtype: 'frog', x: 500, y: 0, count: 2, respawn: 960 }]
  });

  const plan = f.controller.plan();
  assert.ok(plan.candidates.length > 0);
  assert.equal(plan.candidates.some(row => row.mtype === 'frog'), false);
  assert.equal(plan.selected.mtype, 'goo');
});

test('H9 keeps high physical-evasion targets eligible for magical classes', () => {
  const f = makeFixture({
    damageType: 'magical',
    safe: [...cluster('frog', 2, 15, 15), ...cluster('goo', 1, 80, 80)],
    definitions: {
      frog: { id: 'frog', hp: 600, attack: 24, xp: 7200, gold: 313, dropSignal: 0.16, evasion: 99 }
    }
  });

  const plan = f.controller.plan();
  const frog = plan.candidates.find(row => row.mtype === 'frog');
  assert.ok(frog);
  assert.equal(frog.expectedHitChance, 1);
  assert.equal(plan.selected.mtype, 'frog');
});


test('H9 group leader excludes targets that known physical followers cannot safely hit', () => {
  const f = makeFixture({
    characterName: 'My_Priest',
    ctype: 'priest',
    damageType: 'magical',
    safe: [...cluster('frog', 2, 15, 15), ...cluster('goo', 2, 50, 50)],
    definitions: {
      frog: { id: 'frog', hp: 600, attack: 24, xp: 7200, gold: 313, dropSignal: 0.16, evasion: 99 },
      goo: { id: 'goo', hp: 500, attack: 10, xp: 100, gold: 20, dropSignal: 0.2, evasion: 0 }
    },
    partyOwnedMembers: [
      { name: 'My_Priest', ctype: 'priest', damageType: 'magical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 20, y: 0 },
      { name: 'My_Ranger2', ctype: 'ranger', damageType: 'physical', map: 'main', x: -20, y: 0 }
    ]
  });

  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Priest',
    groupMemberNames: ['My_Priest', 'My_Ranger1', 'My_Ranger2']
  });
  assert.equal(started.accepted, true);
  const plan = f.controller.plan();
  assert.equal(plan.candidates.some(row => row.mtype === 'frog'), false);
  assert.equal(plan.selected.mtype, 'goo');
});

test('H9 treats H5 approach movement as delegated ownership while its H8 farm is active', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.farmState().active, true);
  assert.equal(f.farmState().session.owner, 'farm-intelligence-h9');

  f.setActiveMovementOwner('combat-h5-approach');
  const tick = f.controller.tick();

  assert.equal(tick.state, 'FARMING');
  assert.equal(tick.reason, 'H9_DELEGATED_COMBAT_MOVEMENT');
  assert.equal(f.controller.status().metrics.ownershipBlocks, 0);
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.farmState().active, true);
});

test('H9 hold window prevents score-chasing target switches', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  f.advance(1000);
  f.setSafe([...cluster('goo', 1), ...cluster('bee', 6, 25, 25)]);
  const plan = f.controller.plan();
  assert.equal(plan.selected.mtype, 'goo');
  assert.equal(plan.reason, 'H9_HOLD_MIN_DURATION');
  assert.equal(f.controller.status().metrics.holds, 1);
});

test('H9 gives a depleted current cluster a bounded respawn grace before switching', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.controller.status().currentSelection.mtype, 'goo');

  f.advance(1000);
  f.setSafe(cluster('bee', 5, 30, 30));
  const grace = f.controller.tick();
  assert.equal(grace.state, 'WAITING_RESPAWN');
  assert.equal(grace.reason, 'H9_DEPLETION_GRACE');
  assert.equal(f.controller.status().currentSelection.mtype, 'goo');
  assert.equal(f.farmState().session.monsterType, 'goo');

  f.advance(5001);
  const switched = f.controller.tick();
  assert.equal(switched.state, 'FARMING');
  assert.equal(f.controller.status().currentSelection.mtype, 'bee');
  assert.equal(f.farmState().session.monsterType, 'bee');
});

test('H9 does not count live-to-catalog aliasing as depletion or a farmspot switch', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.controller.status().currentSelection.source, 'LIVE_SAFE_CLUSTER');

  f.advance(1000);
  f.setSafe([]);
  f.setCatalog([{ key: 'main:goo:0', map: 'main', mtype: 'goo', x: 30, y: 30, count: 6, respawn: 2 }]);
  const held = f.controller.tick();

  assert.equal(held.state, 'FARMING');
  assert.equal(f.controller.status().currentSelection.mtype, 'goo');
  assert.equal(f.controller.status().currentSelection.source, 'LIVE_G_MAP_SPAWN');
  assert.equal(f.controller.status().metrics.switches, 0);
  assert.equal(f.controller.status().history.length, 1);
  assert.equal(f.controller.status().metrics.farmingStarts, 1);
  assert.equal(f.controller.status().metrics.depletionEvents, 0);
});

test('H9 keeps one physical spot stable when its representation changes from catalog to live cluster', () => {
  const f = makeFixture({
    safe: [],
    catalog: [{ key: 'main:goo:catalog', map: 'main', mtype: 'goo', x: 500, y: 0, count: 6, respawn: 1000 }],
    minHoldMs: 5000,
    switchCooldownMs: 5000
  });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.controller.status().currentSelection.mtype, 'goo');
  assert.equal(f.controller.status().currentSelection.source, 'LIVE_G_MAP_SPAWN');

  f.advance(1000);
  f.setSafe([
    ...cluster('goo', 1, 500, 0),
    ...cluster('bee', 6, 30, 25)
  ]);
  const plan = f.controller.plan();

  assert.equal(plan.selected.mtype, 'goo');
  assert.equal(plan.reason, 'H9_HOLD_MIN_DURATION');
  const prior = f.controller.status().observations.find(row => row.key === 'catalog:main:goo:catalog');
  assert.equal(prior && prior.depletedAtMs, null);
});

test('H9 switches after hold and cooldown when improvement is material', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  f.advance(6000);
  f.setSafe([...cluster('goo', 1), ...cluster('bee', 6, 25, 25)]);
  const tick = f.controller.tick();
  assert.equal(tick.state, 'FARMING');
  assert.equal(f.controller.status().currentSelection.mtype, 'bee');
  assert.equal(f.controller.status().metrics.switches, 1);
  assert.equal(f.farmState().session.monsterType, 'bee');
  assert.ok(f.farmingCalls.some(row => row.type === 'stop'));
});

test('H9 anti-pingpong blocks a quick return to the previous spot without a decisive advantage', () => {
  const equal = {
    goo: { id: 'goo', hp: 500, attack: 10, xp: 300, gold: 60, dropSignal: 0.4 },
    bee: { id: 'bee', hp: 500, attack: 10, xp: 300, gold: 60, dropSignal: 0.4 }
  };
  const f = makeFixture({ safe: cluster('goo', 4), switchImprovementRatio: 0.18, definitions: equal });
  assert.equal(f.controller.startAutonomy().accepted, true);

  f.advance(6000);
  f.setSafe([...cluster('goo', 1), ...cluster('bee', 6, 25, 25)]);
  f.controller.tick();
  assert.equal(f.controller.status().currentSelection.mtype, 'bee');

  f.advance(6000);
  f.setSafe([...cluster('goo', 6), ...cluster('bee', 4, 25, 25)]);
  const plan = f.controller.plan();
  assert.equal(plan.selected.mtype, 'bee');
  assert.equal(plan.reason, 'H9_ANTI_PINGPONG');
  assert.equal(f.controller.status().metrics.pingPongBlocks, 1);
});

test('H9 depletion cannot force an A-B-A return inside the pingpong window', () => {
  const equal = {
    goo: { id: 'goo', hp: 500, attack: 10, xp: 300, gold: 60, dropSignal: 0.4 },
    bee: { id: 'bee', hp: 500, attack: 10, xp: 300, gold: 60, dropSignal: 0.4 }
  };
  const f = makeFixture({ safe: cluster('goo', 4), switchImprovementRatio: 0.18, definitions: equal });
  assert.equal(f.controller.startAutonomy().accepted, true);

  f.advance(6000);
  f.setSafe([...cluster('goo', 1), ...cluster('bee', 6, 25, 25)]);
  f.controller.tick();
  assert.equal(f.controller.status().currentSelection.mtype, 'bee');

  f.advance(1000);
  f.setSafe(cluster('goo', 4));
  const grace = f.controller.tick();
  assert.equal(grace.state, 'WAITING_RESPAWN');
  assert.equal(grace.reason, 'H9_DEPLETION_GRACE');

  f.advance(5001);
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'WAITING_RESPAWN');
  assert.equal(blocked.reason, 'H9_ANTI_PINGPONG');
  assert.equal(f.controller.status().currentSelection.mtype, 'bee');
  assert.equal(f.controller.status().metrics.pingPongBlocks, 1);
});

test('H9 uses H4 smart movement for a known current-map spawn with no live-safe targets', () => {
  const f = makeFixture({
    safe: [],
    catalog: [{ key: 'main:bee:0', map: 'main', mtype: 'bee', x: 600, y: 0, count: 6, respawn: 10 }]
  });
  const started = f.controller.startAutonomy();
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(f.movementCalls.length, 1);
  assert.equal(f.movementCalls[0].args.owner, 'farm-intelligence-h9');
  assert.equal(f.controller.status().metrics.travelOrders, 1);
  assert.equal(f.farmState().active, false);
});

test('H9 suspends after owned movement becomes UNKNOWN and does not blindly restart it', () => {
  const f = makeFixture({
    safe: [],
    catalog: [{ key: 'main:bee:0', map: 'main', mtype: 'bee', x: 600, y: 0, count: 6, respawn: 10 }]
  });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 1);
  f.movementUnknown();
  const tick = f.controller.tick();
  assert.equal(tick.state, 'SUSPENDED');
  assert.match(tick.reason, /H9_MOVEMENT_UNKNOWN/);
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 1);
  assert.equal(f.controller.status().suspended, true);
});

test('H9 V3-style follower uses a local step for moderate same-map separation instead of smart-move churn', () => {
  const f = makeFixture({
    characterName: 'My_Rogue',
    ctype: 'rogue',
    partyOwnedMembers: [
      { name: 'My_Rogue', ctype: 'rogue', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 120, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Ranger1',
    groupMemberNames: ['My_Ranger1', 'My_Rogue']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_LOCAL_FOLLOW_STARTED');
  assert.equal(f.movementCalls.filter(row => row.type === 'local').length, 1);
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 0);
});

test('H9 follower inside the stop radius does not restart regroup movement', () => {
  const f = makeFixture({
    characterName: 'My_Rogue',
    ctype: 'rogue',
    partyOwnedMembers: [
      { name: 'My_Rogue', ctype: 'rogue', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 50, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Ranger1',
    groupMemberNames: ['My_Ranger1', 'My_Rogue']
  });
  assert.equal(started.tick.state, 'FARMING');
  assert.equal(f.movementCalls.length, 0);
});

test('H9 follower closes the live leader gap when its formation offset is already inside the stop radius', () => {
  const f = makeFixture({
    characterName: 'My_Ranger2',
    ctype: 'ranger',
    partyOwnedMembers: [
      { name: 'My_Warrior', ctype: 'warrior', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: -45, y: 0 },
      { name: 'My_Ranger2', ctype: 'ranger', damageType: 'physical', map: 'main', x: -75, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Warrior', 'My_Ranger1', 'My_Ranger2']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_LOCAL_FOLLOW_STARTED');
  const local = f.movementCalls.find(row => row.type === 'local');
  assert.ok(local);
  assert.ok(Math.hypot(local.destination.x, local.destination.y) < 75);
  assert.equal(f.farmState().active, false);
});

test('H9 near follower ignores another farmer\'s large gap instead of restarting regroup', () => {
  const f = makeFixture({
    characterName: 'My_Ranger2',
    ctype: 'ranger',
    partyOwnedMembers: [
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger2', ctype: 'ranger', damageType: 'physical', map: 'main', x: -40, y: -30 },
      { name: 'My_Rogue', ctype: 'rogue', damageType: 'physical', map: 'main', x: 220, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Ranger1',
    groupMemberNames: ['My_Ranger1', 'My_Ranger2', 'My_Rogue']
  });
  assert.equal(started.tick.state, 'FARMING');
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 0);
  assert.equal(f.movementCalls.filter(row => row.type === 'local').length, 0);
});

test('H9 leader may finish current farm travel only while group separation stays below hard-regroup distance', () => {
  const f = makeFixture({
    characterName: 'My_Ranger1',
    ctype: 'ranger',
    partyOwnedMembers: [
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Rogue', ctype: 'rogue', damageType: 'physical', map: 'main', x: 175, y: 0 }
    ]
  });
  f.setActiveMovementOwner('farm-intelligence-h9');
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Ranger1',
    groupMemberNames: ['My_Ranger1', 'My_Rogue']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_LEADER_TRAVEL_CONTINUES');
  assert.equal(f.movementCalls.some(row => row.type === 'cancel'), false);
});

test('H9 leader cancels farm travel on hard separation so a lagging follower can catch up', () => {
  const f = makeFixture({
    characterName: 'My_Warrior',
    ctype: 'warrior',
    partyOwnedMembers: [
      { name: 'My_Warrior', ctype: 'warrior', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 300, y: 0 }
    ]
  });
  f.setActiveMovementOwner('farm-intelligence-h9');
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Warrior', 'My_Ranger1']
  });
  assert.notEqual(started.tick.reason, 'H9_GROUP_LEADER_TRAVEL_CONTINUES');
  assert.equal(f.movementCalls.some(row => row.type === 'cancel'), true);
});

test('H9 leader resumes V3-style farm travel once group recovery is inside the trigger envelope', () => {
  const f = makeFixture({
    characterName: 'My_Warrior',
    ctype: 'warrior',
    safe: [],
    catalog: [{ key: 'catalog:main:crab:0', map: 'main', mtype: 'crab', x: -1202.5, y: -66, count: 4 }],
    partyOwnedMembers: [
      { name: 'My_Warrior', ctype: 'warrior', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 106.6, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Warrior', 'My_Ranger1']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_MOVING_TO_SELECTED_SPOT');
  const travel = f.movementCalls.find(row => row.type === 'smart');
  assert.ok(travel);
  assert.equal(travel.args.owner, 'farm-intelligence-h9');
  assert.deepEqual(travel.destination, { map: 'main', x: -1202.5, y: -66 });
  assert.equal(f.farmingCalls.length, 0);
});

test('H9 retries a transient far same-map smart regroup to the live leader', () => {
  const f = makeFixture({
    characterName: 'My_Rogue',
    ctype: 'rogue',
    partyOwnedMembers: [
      { name: 'My_Rogue', ctype: 'rogue', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 300, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Ranger1',
    groupMemberNames: ['My_Ranger1', 'My_Rogue']
  });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_REGROUP_STARTED');
  assert.equal(f.movementCalls.filter(row => row.type === 'local').length, 0);
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 1);
  assert.deepEqual(f.movementCalls.find(row => row.type === 'smart').destination, { map: 'main', x: 300, y: 0 });

  f.movementUnknown(true);
  const backoff = f.controller.tick();
  assert.equal(backoff.state, 'WAITING');
  assert.equal(backoff.reason, 'H9_GROUP_REGROUP_RETRY_BACKOFF');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().metrics.transientMovementRecoveries, 1);

  f.advance(2500);
  const retry = f.controller.tick();
  assert.equal(retry.state, 'TRAVELLING');
  assert.equal(retry.reason, 'H9_GROUP_REGROUP_STARTED');
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 2);
  assert.equal(f.controller.status().suspended, false);
});

test('H9 keeps moderate same-map separation on local follow rather than escalating to smart regroup', () => {
  const f = makeFixture({
    characterName: 'My_Ranger1',
    ctype: 'ranger',
    partyOwnedMembers: [
      { name: 'My_Ranger1', ctype: 'ranger', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Warrior', ctype: 'warrior', damageType: 'physical', map: 'main', x: 170, y: 0 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Ranger1', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_LOCAL_FOLLOW_STARTED');
  assert.equal(f.movementCalls.filter(row => row.type === 'local').length, 1);
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 0);
});

test('H9 far same-map follower falls back to the live leader position when no safe local step exists', () => {
  const f = makeFixture({
    characterName: 'My_Ranger2',
    ctype: 'ranger',
    canMoveTo: false,
    partyOwnedMembers: [
      { name: 'My_Ranger2', ctype: 'ranger', damageType: 'physical', map: 'main', x: 0, y: 0 },
      { name: 'My_Warrior', ctype: 'warrior', damageType: 'physical', map: 'main', x: 300, y: 40 }
    ]
  });
  const started = f.controller.startAutonomy({
    owner: 'full-autonomy',
    groupLeaderName: 'My_Warrior',
    groupMemberNames: ['My_Ranger2', 'My_Warrior']
  });
  assert.equal(started.tick.state, 'TRAVELLING');
  assert.equal(started.tick.reason, 'H9_GROUP_REGROUP_STARTED');
  assert.equal(f.movementCalls.filter(row => row.type === 'local').length, 0);
  const smart = f.movementCalls.find(row => row.type === 'smart');
  assert.ok(smart);
  assert.deepEqual(smart.destination, { map: 'main', x: 300, y: 40 });
});

test('H9 foreign party blocks planning before any H4 travel or H8 farming action', () => {
  const f = makeFixture({
    foreignParty: true,
    safe: [],
    catalog: [{ key: 'main:bee:0', map: 'main', mtype: 'bee', x: 600, y: 0, count: 6, respawn: 10 }]
  });
  const started = f.controller.startAutonomy();
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'SUSPENDED');
  assert.equal(started.tick.reason, 'H9_FOREIGN_PARTY_BLOCK');
  assert.equal(f.controller.status().suspended, true);
  assert.equal(f.controller.status().suspendedReason, 'H9_FOREIGN_PARTY_BLOCK');
  assert.equal(f.movementCalls.length, 0);
  assert.equal(f.farmingCalls.length, 0);
  assert.equal(f.controller.status().metrics.foreignPartyBlocks, 1);
});

test('H9 stops its owned H8 session and suspends if a foreign party member appears mid-run', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.farmState().active, true);

  f.setForeignParty(['Stranger']);
  const tick = f.controller.tick();
  assert.equal(tick.state, 'SUSPENDED');
  assert.equal(tick.reason, 'H9_FOREIGN_PARTY_BLOCK');
  assert.equal(f.farmState().active, false);
  assert.equal(f.controller.status().suspended, true);
  assert.ok(f.farmingCalls.some(row => row.type === 'stop'));
});

test('H9 suspends instead of competing with a foreign H4 movement order', () => {
  const f = makeFixture({
    foreignMovement: true,
    safe: [],
    catalog: [{ key: 'main:bee:0', map: 'main', mtype: 'bee', x: 600, y: 0, count: 6, respawn: 10 }]
  });
  const started = f.controller.startAutonomy();
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'SUSPENDED');
  assert.equal(started.tick.reason, 'H9_FOREIGN_MOVEMENT_OWNERSHIP');
  assert.equal(f.movementCalls.filter(row => row.type === 'smart').length, 0);
  assert.equal(f.controller.status().metrics.ownershipBlocks, 1);
});

test('H9 refuses to steal an H8 session owned by another client', () => {
  const f = makeFixture({ foreignFarm: true });
  const started = f.controller.startAutonomy();
  assert.equal(started.accepted, false);
  assert.equal(started.reason, 'H9_FARMING_ALREADY_OWNED');
  assert.equal(f.controller.status().metrics.ownershipBlocks, 1);
});

test('H9 competition signal penalizes crowded spots without treating unknown remote state as live truth', () => {
  const safe = [...cluster('goo', 3, 20, 20), ...cluster('bee', 3, 350, 350)];
  const f = makeFixture({
    safe,
    players: [
      { id: 'p1', name: 'Other1', map: 'main', x: 20, y: 25 },
      { id: 'p2', name: 'Other2', map: 'main', x: 30, y: 30 }
    ],
    definitions: {
      goo: { id: 'goo', hp: 500, attack: 10, xp: 300, gold: 60, dropSignal: 0.4 },
      bee: { id: 'bee', hp: 500, attack: 10, xp: 300, gold: 60, dropSignal: 0.4 }
    }
  });
  const plan = f.controller.plan();
  const goo = plan.candidates.find(row => row.mtype === 'goo');
  const bee = plan.candidates.find(row => row.mtype === 'bee');
  assert.ok(goo.competitors > bee.competitors);
  assert.ok(goo.components.competition < bee.components.competition);
});

test('H9 source is integrated into runtime build and public API', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const adapter = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  assert.match(runtime, /id: 'farm-intelligence'/);
  assert.match(runtime, /new ns\.FarmIntelligenceController/);
  assert.match(entry, /farmIntelligence:/);
  assert.match(entry, /visiblePlayers:/);
  assert.match(entry, /monsterDefinition:/);
  assert.match(entry, /farmSpots:/);
  assert.match(build, /src\/farm-intelligence\.js/);
  assert.match(adapter, /monsterDefinition\(mtype\)/);
  assert.match(adapter, /farmSpotCatalog\(options = \{\}\)/);
  assert.match(adapter, /visiblePlayers\(options = \{\}\)/);
});

test('H9 control center and one-click live suite are wired', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  assert.match(ui, /data-tab="farm-intelligence"/);
  assert.match(ui, /H9 Farm Intelligence/);
  assert.match(runtime, /id: 'h9-farm-intelligence'/);
  assert.match(runtime, /H9_FARM_TARGET_PINGPONG/);
  assert.match(runtime, /visibleSafe\.length > 0/);
  assert.match(runtime, /h9-adaptive-decisions/);
  assert.match(runtime, /timeoutMs: 85000/);
  assert.match(entry, /0\.26\.62-h26/);
  assert.match(entry, /farmIntelligence:/);
  assert.match(build, /const runtimeVersion = '0\.26\.62-h26'/);
});

test('H9 game adapter normalizes live farm data for scoring', () => {
  const adapterSource = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  const root = {
    character: {
      name: 'Farmer', id: 'Farmer', ctype: 'ranger', map: 'main',
      x: 10, y: 20, hp: 1000, max_hp: 1000, mp: 500, max_mp: 500,
      attack: 200, range: 120, speed: 50, frequency: 1
    },
    entities: {
      p1: { id: 'p1', name: 'Other', type: 'character', ctype: 'mage', map: 'main', x: 50, y: 60, hp: 500, max_hp: 500, visible: true },
      m1: { id: 'm1', type: 'monster', mtype: 'goo', map: 'main', x: 30, y: 40, hp: 100, max_hp: 100, attack: 5, visible: true }
    },
    G: {
      monsters: {
        goo: { name: 'Goo', hp: 100, attack: 5, xp: 50, respawn: 2 }
      },
      monster_gold: { goo: 12 },
      drops: {
        gold: { base: 0.64, random: 0.8 },
        monsters: { goo: [[0.5, 'slime'], [0.01, 'rare']] }
      },
      maps: {
        main: {
          monsters: [
            { type: 'goo', boundary: [0, 0, 100, 200], count: 8, respawn: 2 },
            { type: 'goo', boundary: { x1: 300, y1: 300, x2: 500, y2: 500 }, count: 4 }
          ]
        }
      },
      skills: {}
    }
  };
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    character: root.character,
    entities: root.entities,
    G: root.G,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
        cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(adapterSource, ctx, { filename: 'game-adapter.js' });
  const Adapter = ctx.__ALBOT_INTERNALS__.AdventureLandGameAdapter;
  const adapter = new Adapter({ root: ctx });

  const players = adapter.visiblePlayers();
  assert.equal(players.length, 1);
  assert.equal(players[0].name, 'Other');

  const monster = adapter.monsterDefinition('goo');
  assert.equal(monster.xp, 50);
  assert.equal(monster.gold, 13.48);
  assert.equal(monster.dropSignal, 0.51);
  assert.deepEqual(
    Array.from(monster.drops, row => [row.item, row.chance, row.quantity]),
    [['slime', 0.5, 1], ['rare', 0.01, 1]]
  );

  const spots = adapter.farmSpotCatalog({ map: 'main', currentOnly: true });
  assert.equal(spots.length, 2);
  assert.deepEqual(
    Array.from(spots, row => [row.mtype, row.x, row.y, row.count]),
    [['goo', 50, 100, 8], ['goo', 400, 400, 4]]
  );
});


test('H9 exposes incomplete group wait as an explicit decision instead of appearing dead', () => {
  const f = makeFixture();
  f.controller.configureGroup({
    groupLeaderName: 'My_Priest',
    groupMemberNames: ['Farmer', 'My_Priest']
  });
  const started = f.controller.startAutonomy({
    groupLeaderName: 'My_Priest',
    groupMemberNames: ['Farmer', 'My_Priest']
  });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WAITING');
  assert.equal(started.tick.reason, 'H9_GROUP_LEADER_POSITION_UNAVAILABLE');

  const status = f.controller.status();
  assert.equal(status.metrics.decisions, 1);
  assert.equal(status.lastPlan.state, 'WAITING');
  assert.equal(status.lastPlan.reason, 'H9_GROUP_LEADER_POSITION_UNAVAILABLE');
  assert.equal(status.lastPlan.group.leaderName, 'My_Priest');
  assert.equal(status.lastPlan.group.complete, false);
});


// H27 regression: an armed but targetless follower is formation-waiting, not fighting.
test('H9 does not treat WAITING_GROUP_TARGET without a live target as an active encounter', () => {
  const f = makeFixture();
  const farm = { active: true, session: { owner: 'farm-intelligence-h9' } };
  const group = {
    members: [
      { name: 'Leader', targetId: null },
      { name: 'Follower', targetId: null }
    ]
  };
  const waiting = {
    active: true,
    state: 'WAITING_GROUP_TARGET',
    pendingAttack: null,
    session: { targetId: null }
  };

  assert.equal(f.controller._groupEncounterActive(group, farm, waiting), false);
  assert.equal(f.controller._groupEncounterActive(group, farm, { ...waiting, session: { targetId: 'goo-1' } }), true);
  assert.equal(f.controller._groupEncounterActive({
    members: [{ name: 'Leader', targetId: 'goo-2' }, { name: 'Follower', targetId: null }]
  }, farm, waiting), true);
});
