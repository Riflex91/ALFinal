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
    name: 'Farmer',
    ctype: 'ranger',
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

  let movementState = { active: false, activeOrder: null, lastOrder: null };
  const movementCalls = [];
  const movement = {
    status: () => JSON.parse(JSON.stringify(movementState)),
    smartMove: (destination, args) => {
      movementCalls.push({ type: 'smart', destination: { ...destination }, args: { ...args } });
      const order = { id: 'move-1', owner: args.owner, state: 'ACTIVE', destination: { ...destination } };
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
  const party = { status: () => ({ party: { ownedMemberNames: ['Farmer'] } }) };

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
    setNow: value => { now = value; },
    advance: ms => { now += ms; },
    movementUnknown: () => {
      const last = movementState.activeOrder || { id: 'move-1', owner: 'farm-intelligence-h9' };
      movementState = { active: false, activeOrder: null, lastOrder: { ...last, state: 'UNKNOWN' } };
    },
    movementComplete: () => {
      const last = movementState.activeOrder;
      movementState = { active: false, activeOrder: null, lastOrder: last ? { ...last, state: 'COMPLETED' } : null };
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
  const f = makeFixture({ safe: cluster('goo', 4), switchImprovementRatio: 0.18 });
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
  assert.match(build, /src\/farm-intelligence\.js/);
  assert.match(adapter, /monsterDefinition\(mtype\)/);
  assert.match(adapter, /farmSpotCatalog\(options = \{\}\)/);
  assert.match(adapter, /visiblePlayers\(options = \{\}\)/);
});
