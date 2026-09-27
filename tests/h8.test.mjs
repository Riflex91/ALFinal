import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/farming.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeFixture(options = {}) {
  const character = {
    name: 'Farmer',
    ctype: options.ctype || 'ranger',
    hp: options.hp == null ? 1000 : options.hp,
    maxHp: 1000,
    mp: options.mp == null ? 1000 : options.mp,
    maxMp: 1000,
    attack: 150,
    range: 120,
    rip: false
  };
  const monsters = (options.monsters || [
    { id: 'm1', mtype: 'goo', distance: 60, attack: 30, targetId: 'Farmer', visible: true, dead: false },
    { id: 'm2', mtype: 'goo', distance: 70, attack: 30, targetId: null, visible: true, dead: false },
    { id: 'm3', mtype: 'goo', distance: 80, attack: 30, targetId: null, visible: true, dead: false },
    { id: 'm4', mtype: 'goo', distance: 90, attack: 30, targetId: null, visible: true, dead: false }
  ]).map(row => ({ visible: true, dead: false, ...row }));

  const definitions = {
    '5shot': { id: '5shot', classes: ['ranger'], mp: 320, multi: true, maxTargets: 5 },
    '3shot': { id: '3shot', classes: ['ranger'], mp: 200, multi: true, maxTargets: 3 },
    cburst: { id: 'cburst', classes: ['mage'], multi: true },
    fanofknives: { id: 'fanofknives', classes: ['rogue'], mp: 180, range: 160, multi: true, maxTargets: 5 },
    cleave: { id: 'cleave', classes: ['warrior'], mp: 720, range: 160, hostile: true },
    stomp: { id: 'stomp', classes: ['warrior'], mp: 120, range: 400, hostile: true }
  };
  if (options.disabledSkills) {
    for (const id of options.disabledSkills) delete definitions[id];
  }

  let combatState = { active: false, session: null };
  let stopped = 0;
  const combat = {
    status: () => ({
      moduleActive: true,
      active: combatState.active,
      session: combatState.session,
      state: combatState.active ? 'ACTIVE' : 'IDLE'
    }),
    startSession: startOptions => {
      combatState = {
        active: true,
        session: {
          id: 'combat-1',
          owner: startOptions.owner,
          targetId: options.targetId || 'm1',
          policy: { ...startOptions }
        }
      };
      return { accepted: true, session: { ...combatState.session } };
    },
    stopSession: reason => {
      stopped += 1;
      const old = combatState.session;
      combatState = { active: false, session: null };
      return { stopped: true, reason, session: old };
    },
    safeCandidates: () => monsters.filter(row => options.safeIds ? options.safeIds.includes(row.id) : true)
  };

  const calls = [];
  const actions = {
    dispatch: (action, args) => {
      calls.push({ action, args });
      if (options.syncUnknown) {
        return { id: 'act-1', state: 'UNKNOWN', error: { message: 'NETWORK_SYNC_UNKNOWN' } };
      }
      if (options.rejectKnown) {
        return { id: 'act-1', state: 'DISPATCHED', value: Promise.reject(new Error('cooldown')) };
      }
      return {
        id: 'act-' + calls.length,
        state: 'DISPATCHED',
        value: Promise.resolve({ success: true, response: 'data', place: args[0] })
      };
    }
  };

  const game = {
    snapshot: () => ({ available: true, character: { ...character } }),
    visibleMonsters: () => monsters.map(row => ({ ...row })),
    skillDefinition: id => definitions[id] ? { ...definitions[id] } : null,
    skillReadiness: id => definitions[id]
      ? { available: true, allowed: options.notReadySkill === id ? false : true, skillId: id, reasons: [] }
      : { available: false, allowed: false, skillId: id, reasons: ['MISSING'] }
  };

  const partySnapshot = options.foreign
    ? { ownedMemberNames: ['Farmer'], foreignMemberNames: ['Stranger'] }
    : { ownedMemberNames: ['Farmer'], foreignMemberNames: [] };
  const party = {
    status: () => ({ party: partySnapshot }),
    preferredTargetId: () => options.partyFocus || null
  };
  const classSkills = { status: () => ({ pending: options.h6Pending ? { skillId: 'x' } : null }) };

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
  vm.runInNewContext(source, ctx, { filename: 'farming.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.AdaptiveFarmingController;
  const controller = new Controller({ game, actions, combat, party, classSkills, now: options.now || (() => Date.now()) });
  controller.start({ heartbeat() {} });
  return { controller, combat, calls, character, monsters, getStopped: () => stopped };
}

test('H8 ranger plans a bounded four-target pack and prefers 5shot', () => {
  const f = makeFixture({ ctype: 'ranger' });
  const started = f.controller.startSession();
  assert.equal(started.accepted, true);
  const plan = f.controller.plan();
  assert.equal(plan.state, 'AOE_READY');
  assert.equal(plan.aoe.skillId, '5shot');
  assert.equal(plan.aoe.packSize, 4);
  assert.deepEqual(Array.from(plan.aoe.args[1]), ['m1', 'm2', 'm3', 'm4']);
  assert.ok(plan.aggregateAttack <= 220);
});

test('H8 reduces to single target below pull health threshold and retreats at hard threshold', () => {
  const mid = makeFixture({ ctype: 'ranger', hp: 780 });
  assert.equal(mid.controller.startSession().accepted, true);
  const midPlan = mid.controller.plan();
  assert.equal(midPlan.state, 'SINGLE_TARGET');
  assert.equal(midPlan.capacity, 1);

  const low = makeFixture({ ctype: 'ranger', hp: 350 });
  assert.equal(low.controller.startSession().accepted, true);
  const lowPlan = low.controller.plan();
  assert.equal(lowPlan.state, 'RETREAT');
  assert.equal(lowPlan.reason, 'H8_LOW_HP');
});

test('H8 aggregate attack budget prevents overpull even when many H5 candidates are individually safe', () => {
  const f = makeFixture({
    ctype: 'ranger',
    monsters: [
      { id: 'm1', mtype: 'goo', distance: 50, attack: 150, targetId: 'Farmer' },
      { id: 'm2', mtype: 'goo', distance: 60, attack: 150, targetId: null },
      { id: 'm3', mtype: 'goo', distance: 70, attack: 150, targetId: null }
    ]
  });
  assert.equal(f.controller.startSession().accepted, true);
  const plan = f.controller.plan();
  assert.equal(plan.state, 'SINGLE_TARGET');
  assert.equal(plan.pack.length, 1);
  assert.ok(plan.aggregateAttack <= 220);
});

test('H8 primary insertion never exceeds aggregate attack budget', () => {
  const f = makeFixture({
    ctype: 'ranger',
    targetId: 'primary',
    monsters: [
      { id: 'a', mtype: 'goo', distance: 40, attack: 50, targetId: 'Farmer' },
      { id: 'b', mtype: 'goo', distance: 50, attack: 50, targetId: 'Farmer' },
      { id: 'c', mtype: 'goo', distance: 60, attack: 50, targetId: 'Farmer' },
      { id: 'd', mtype: 'goo', distance: 70, attack: 50, targetId: 'Farmer' },
      { id: 'primary', mtype: 'goo', distance: 80, attack: 80, targetId: null }
    ]
  });
  assert.equal(f.controller.startSession().accepted, true);
  const plan = f.controller.plan();
  assert.ok(plan.pack.some(row => row.id === 'primary'));
  assert.ok(plan.aggregateAttack <= 220);
  assert.equal(plan.aggregateAttack, plan.pack.reduce((sum, row) => sum + Number(row.attack || 0), 0));
});

test('H8 fails closed when a foreign party member is present', () => {
  const f = makeFixture({ foreign: true });
  assert.equal(f.controller.startSession().accepted, true);
  const plan = f.controller.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.reason, 'H8_FOREIGN_PARTY_BLOCK');
  assert.equal(f.controller.status().metrics.foreignPartyBlocks, 1);
});

test('H8 untargeted warrior AoE is blocked if its effect zone contains a monster rejected by H5 safety', () => {
  const f = makeFixture({
    ctype: 'warrior',
    safeIds: ['m1', 'm2', 'm3'],
    monsters: [
      { id: 'm1', mtype: 'goo', distance: 50, attack: 30, targetId: 'Farmer' },
      { id: 'm2', mtype: 'goo', distance: 60, attack: 30, targetId: null },
      { id: 'm3', mtype: 'goo', distance: 70, attack: 30, targetId: null },
      { id: 'unsafe', mtype: 'goo', distance: 80, attack: 999, targetId: null }
    ]
  });
  assert.equal(f.controller.startSession().accepted, true);
  const plan = f.controller.plan();
  assert.equal(plan.state, 'SINGLE_TARGET');
  assert.equal(plan.reason, 'H8_NO_LIVE_READY_AOE_SKILL');
  assert.ok(f.controller.status().metrics.unsafeZoneBlocks >= 1);
});

test('H8 synchronous UNKNOWN suspends AoE immediately and never blindly retries', () => {
  let now = 1000;
  const f = makeFixture({ ctype: 'ranger', syncUnknown: true, now: () => now });
  const started = f.controller.startSession();
  assert.equal(started.accepted, true);
  const combatSession = f.combat.status().session;

  const first = f.controller.maybeUse({ session: combatSession });
  assert.equal(first.handled, true);
  assert.equal(first.unknown, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.status().suspended, true);
  assert.equal(f.controller.status().metrics.aoeUnknown, 1);

  now += 1000;
  const second = f.controller.maybeUse({ session: combatSession });
  assert.equal(second.handled, false);
  assert.equal(second.suspended, true);
  assert.equal(f.calls.length, 1);
});

test('H8 known AoE rejection enters backoff without UNKNOWN suspension', async () => {
  let now = 1000;
  const f = makeFixture({ ctype: 'ranger', rejectKnown: true, now: () => now });
  assert.equal(f.controller.startSession().accepted, true);
  const combatSession = f.combat.status().session;
  const first = f.controller.maybeUse({ session: combatSession });
  assert.equal(first.handled, true);
  await sleep(0);
  const state = f.controller.status();
  assert.equal(state.suspended, false);
  assert.equal(state.metrics.aoeRejected, 1);
  assert.ok(state.backoffUntilMs > now);

  now += 500;
  const second = f.controller.maybeUse({ session: combatSession });
  assert.equal(second.handled, false);
  assert.equal(second.reason, 'H8_AOE_BACKOFF');
  assert.equal(f.calls.length, 1);
});

test('H8 stop only releases its owned H5 combat session', () => {
  const f = makeFixture({ ctype: 'mage' });
  const started = f.controller.startSession();
  assert.equal(started.accepted, true);
  assert.equal(f.combat.status().session.owner, 'farming-h8');
  const stopped = f.controller.stopSession('TEST_DONE');
  assert.equal(stopped.stopped, true);
  assert.equal(f.getStopped(), 1);
  assert.equal(f.combat.status().active, false);
});

test('H8 control center exposes adaptive farming surface', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /data-tab="farming"/);
  assert.match(ui, /albot-panel-farming/);
  assert.match(ui, /H8 AoE & adaptives Farming/);
  assert.match(ui, /Plan prüfen/);
  assert.match(ui, /AoE UNKNOWN/);
});

test('H8 runtime registers one-click suite and diagnostics surface', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  assert.match(runtime, /id: 'h8-adaptive-farming'/);
  assert.match(runtime, /title: 'H8 – AoE & adaptives Farming'/);
  assert.match(runtime, /runtime\.farming\.startSession/);
  assert.match(runtime, /H8_AOE_UNKNOWN_DURING_STABILITY/);
  assert.match(runtime, /farming: this\.farming\.status\(\)/);
});

test('H8 bundle version and build pipeline include farming core', () => {
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  assert.match(entry, /0\.12\.0-h12/);
  assert.match(entry, /farming:/);
  assert.match(build, /src\/farming\.js/);
  assert.match(build, /AL Bot 0\.12\.0-h12/);
});
