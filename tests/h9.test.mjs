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
  let foreignParty = options.foreignParty ? ['Stranger'] : [];
  const party = { status: () => ({ party: {
    ownedMemberNames: ['Farmer'],
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
    movementUnknown: () => {
      const last = movementState.activeOrder || { id: 'move-1', owner: 'farm-intelligence-h9' };
      movementState = { active: false, activeOrder: null, lastOrder: { ...last, state: 'UNKNOWN' } };
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

test('H9 does not count live-to-catalog aliasing as a farmspot switch', () => {
  const f = makeFixture({ safe: cluster('goo', 3) });
  assert.equal(f.controller.startAutonomy().accepted, true);
  assert.equal(f.controller.status().currentSelection.source, 'LIVE_SAFE_CLUSTER');

  f.advance(1000);
  f.setSafe([]);
  f.setCatalog([{ key: 'main:goo:0', map: 'main', mtype: 'goo', x: 30, y: 30, count: 6, respawn: 2 }]);
  const grace = f.controller.tick();
  assert.equal(grace.state, 'WAITING_RESPAWN');

  f.advance(5001);
  const held = f.controller.tick();
  assert.equal(held.state, 'FARMING');
  assert.equal(f.controller.status().currentSelection.mtype, 'goo');
  assert.equal(f.controller.status().metrics.switches, 0);
  assert.equal(f.controller.status().history.length, 1);
  assert.equal(f.controller.status().metrics.farmingStarts, 1);
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
  assert.match(entry, /0\.22\.7-h22/);
  assert.match(entry, /farmIntelligence:/);
  assert.match(build, /const runtimeVersion = '0\.22\.7-h22'/);
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
