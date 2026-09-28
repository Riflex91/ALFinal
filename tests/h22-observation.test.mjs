import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadObserver() {
  const source = fs.readFileSync(new URL('../src/autonomous-observer.js', import.meta.url), 'utf8');
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const cleanText = (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);
  const context = {
    console,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText } },
    globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'autonomous-observer.js' });
  return {
    Controller: context.__ALBOT_INTERNALS__.AutonomousObservationCoordinator,
    Ring: context.__ALBOT_INTERNALS__.BoundedTelemetryRing,
    helpers: context.__ALBOT_INTERNALS__.observationHelpers
  };
}

function fixture() {
  const state = {
    character: { name: 'FarmerA', ctype: 'ranger', map: 'main', hp: 1000, max_hp: 1000, mp: 500, max_mp: 500, rip: false },
    stopLatch: { latched: false, reason: null },
    scheduler: { enabled: true, generation: 1, metrics: { callbackErrors: 0 } },
    modules: [],
    combat: { active: false, pendingAttack: null, metrics: { attacksConfirmed: 0, killsObserved: 0 } },
    farming: { active: false, suspended: false },
    farmIntelligence: { active: false, suspended: false },
    resourceTopoff: { suspended: false, pending: null },
    inventory: { suspended: false },
    merchant: { suspended: false, pending: null, delivery: null, metrics: { transfersConfirmed: 0, mluckConfirmed: 0 } },
    bank: { suspended: false },
    trade: { suspended: false },
    gear: { suspended: false },
    upgrade: { suspended: false },
    exchangeCraft: { suspended: false },
    economy: { suspended: false, currentAction: null, actionsThisSession: 0 },
    partyLogistics: { suspended: false, currentAction: null, queue: [], actionsThisSession: 0 },
    lifecycle: { suspended: false, currentAction: null, queue: [] },
    fullAutonomy: { enabled: false, desiredCharacterNames: [], lastDecision: null },
    safeUpdater: { enabled: true },
    transport: { peers: [] },
    roster: { onlineCharacterNames: ['FarmerA'] }
  };
  const ctrl = key => ({ status: () => state[key] });
  const runtime = {
    root: {},
    logger: null,
    bus: { on: () => () => {} },
    version: '0.22.1-h22',
    running: true,
    runEpoch: 1,
    bootCount: 1,
    stopLatch: { status: () => state.stopLatch },
    scheduler: { status: () => state.scheduler },
    modules: { list: () => state.modules },
    game: { snapshot: () => ({ available: true, character: state.character }) },
    combat: ctrl('combat'),
    farming: ctrl('farming'),
    farmIntelligence: ctrl('farmIntelligence'),
    resourceTopoff: ctrl('resourceTopoff'),
    inventory: ctrl('inventory'),
    merchant: ctrl('merchant'),
    bank: ctrl('bank'),
    trade: ctrl('trade'),
    gear: ctrl('gear'),
    upgrade: ctrl('upgrade'),
    exchangeCraft: ctrl('exchangeCraft'),
    economy: ctrl('economy'),
    partyLogistics: ctrl('partyLogistics'),
    lifecycle: ctrl('lifecycle'),
    fullAutonomy: ctrl('fullAutonomy'),
    safeUpdater: ctrl('safeUpdater'),
    lifecycleTransport: { status: () => state.transport },
    roster: { status: () => state.roster }
  };
  return { state, runtime };
}

test('H22 bounded flight recorder retains only the newest rows and sanitizes secrets', () => {
  const { Ring, helpers } = loadObserver();
  const ring = new Ring(50);
  for (let i = 0; i < 60; i += 1) ring.push({ seq: i + 1 });
  assert.equal(ring.status().size, 50);
  assert.equal(ring.list(50)[0].seq, 11);

  const sanitized = helpers.sanitize({
    authorization: 'Bearer private',
    nested: { apiKey: 'secret-value', safe: 'ok' }
  });
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.nested.apiKey, '[REDACTED]');
  assert.equal(sanitized.nested.safe, 'ok');
});

test('H22 observer returns deterministic PASS for a healthy idle runtime', () => {
  const { Controller } = loadObserver();
  const { runtime } = fixture();
  let clock = 1000;
  const observer = new Controller({ runtime, now: () => clock });
  observer.moduleActive = true;
  const result = observer.tick();
  assert.equal(result.state, 'HEALTHY');
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(Array.from(result.reasons), []);
  assert.equal(observer.status().policies.gameplayActionAuthority, false);
  assert.equal(observer.status().policies.chatgptRequiredForNormalOperation, false);
});

test('H22 observer marks emergency stop and module failures CRITICAL', () => {
  const { Controller } = loadObserver();
  const { state, runtime } = fixture();
  state.stopLatch = { latched: true, reason: 'TEST' };
  state.modules = [{ id: 'combat', state: 'ERROR', health: 'ERROR' }];
  const observer = new Controller({ runtime, now: () => 2000 });
  observer.moduleActive = true;
  const result = observer.tick();
  assert.equal(result.state, 'CRITICAL');
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('EMERGENCY_STOP_LATCHED'));
  assert.ok(result.reasons.includes('MODULE_ERROR:combat'));
  assert.ok(observer.status().openIncident);
});

test('H22 observer detects diagnostic timer gaps without taking action authority', () => {
  const { Controller } = loadObserver();
  const { runtime } = fixture();
  let clock = 1000;
  const observer = new Controller({
    runtime,
    now: () => clock,
    timerGapWarnMs: 1500,
    timerGapCriticalMs: 3000
  });
  observer.moduleActive = true;
  assert.equal(observer.tick().verdict, 'PASS');
  clock = 4501;
  const result = observer.tick();
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('DIAGNOSTIC_TIMER_GAP_CRITICAL'));
  assert.equal(observer.status().policies.actionAuthority, false);
});

test('H22 farmer stall detection is activity-aware and becomes FAIL only after the critical window', () => {
  const { Controller } = loadObserver();
  const { state, runtime } = fixture();
  state.fullAutonomy = { enabled: true, desiredCharacterNames: [], lastDecision: { state: 'RUNNING' } };
  state.farmIntelligence = { active: true, suspended: false };
  let clock = 1000;
  const observer = new Controller({
    runtime,
    now: () => clock,
    timerGapWarnMs: 999999999,
    timerGapCriticalMs: 999999999,
    farmerWatchMs: 30000,
    farmerCriticalMs: 60000
  });
  observer.moduleActive = true;
  assert.equal(observer.tick().verdict, 'PASS');
  clock += 31000;
  const warning = observer.tick();
  assert.equal(warning.verdict, 'WARN');
  assert.ok(warning.reasons.includes('FARMER_COMBAT_PROGRESS_WATCH'));
  state.combat.metrics.attacksConfirmed += 1;
  clock += 1000;
  assert.equal(observer.tick().verdict, 'PASS');
  clock += 61000;
  const failed = observer.tick();
  assert.equal(failed.verdict, 'FAIL');
  assert.ok(failed.reasons.includes('FARMER_NO_COMBAT_PROGRESS'));
});

test('H22 merchant stall detection only runs while merchant work is actually expected', () => {
  const { Controller } = loadObserver();
  const { state, runtime } = fixture();
  state.character = { ...state.character, name: 'MerchantA', ctype: 'merchant' };
  state.roster = { onlineCharacterNames: ['MerchantA'] };
  state.fullAutonomy = { enabled: true, desiredCharacterNames: [], lastDecision: { state: 'RUNNING' } };
  let clock = 1000;
  const observer = new Controller({
    runtime,
    now: () => clock,
    timerGapWarnMs: 999999999,
    timerGapCriticalMs: 999999999,
    merchantWatchMs: 60000,
    merchantCriticalMs: 120000
  });
  observer.moduleActive = true;
  assert.equal(observer.tick().verdict, 'PASS');

  state.merchant.pending = { id: 'm1' };
  clock += 1000;
  assert.equal(observer.tick().verdict, 'PASS');
  clock += 61000;
  assert.equal(observer.tick().verdict, 'WARN');
  clock += 60000;
  const failed = observer.tick();
  assert.equal(failed.verdict, 'FAIL');
  assert.ok(failed.reasons.includes('MERCHANT_NO_SERVICE_PROGRESS'));
});

test('H22 group coordinator folds passive peer health into local PASS/WARN/FAIL', () => {
  const { Controller } = loadObserver();
  const { state, runtime } = fixture();
  state.fullAutonomy = {
    enabled: true,
    desiredCharacterNames: ['FarmerA', 'FarmerB', 'FarmerC', 'MerchantA'],
    lastDecision: { state: 'RUNNING' }
  };
  state.roster = { onlineCharacterNames: ['FarmerA', 'FarmerB', 'FarmerC', 'MerchantA'] };
  state.transport = {
    peers: [
      { name: 'FarmerB', fresh: true, ageMs: 100, observation: { state: 'HEALTHY', verdict: 'PASS' } },
      { name: 'FarmerC', fresh: true, ageMs: 100, observation: { state: 'CRITICAL', verdict: 'FAIL' } },
      { name: 'MerchantA', fresh: true, ageMs: 100, observation: { state: 'HEALTHY', verdict: 'PASS' } }
    ]
  };
  const observer = new Controller({ runtime, now: () => 1000 });
  observer.moduleActive = true;
  const result = observer.tick();
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('GROUP_PEER_CRITICAL:FarmerC'));
  assert.equal(result.subsystems.group.state, 'CRITICAL');
});

test('H22 incident package captures bounded pre/post evidence and finalizes deterministically', () => {
  const { Controller } = loadObserver();
  const { state, runtime } = fixture();
  let clock = 1000;
  const observer = new Controller({
    runtime,
    now: () => clock,
    incidentPreMs: 5000,
    incidentPostMs: 1000,
    timerGapWarnMs: 999999999,
    timerGapCriticalMs: 999999999
  });
  observer.moduleActive = true;
  observer._record('PRE_EVENT', 'INFO', 'test', 'before');
  state.stopLatch = { latched: true, reason: 'TEST' };
  observer.tick();
  assert.ok(observer.status().openIncident);
  clock += 500;
  observer._record('POST_EVENT', 'WARN', 'test', 'after');
  clock += 600;
  observer.tick();
  const incidents = observer.listIncidents(10);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].state, 'CRITICAL');
  assert.ok(incidents[0].events.some(row => row.type === 'PRE_EVENT'));
  assert.ok(incidents[0].events.some(row => row.type === 'POST_EVENT'));
  assert.equal(observer.status().openIncident, null);
});

test('H22 observation integration is wired through build, runtime, H19 heartbeat and public API', () => {
  const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  const crossWindow = fs.readFileSync(new URL('../src/cross-window-lifecycle.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');

  assert.match(build, /src\/autonomous-observer\.js/);
  assert.match(runtime, /new ns\.AutonomousObservationCoordinator/);
  assert.match(runtime, /id: 'autonomous-observer'/);
  assert.match(runtime, /observationEvents: this\.observer\.listEvents\(200\)/);
  assert.match(runtime, /h22-autonomous-observer/);
  assert.match(crossWindow, /observation: state\.observation/);
  assert.match(crossWindow, /observation: row\.observation/);
  assert.match(entry, /observation:\s*\{/);
  assert.match(entry, /incidents: limit => runtime\.observer\.listIncidents\(limit\)/);
  assert.match(entry, /Object\.freeze\(api\.observation\)/);
});
