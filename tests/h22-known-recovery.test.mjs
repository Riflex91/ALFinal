import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadRecovery() {
  const source = fs.readFileSync(new URL('../src/known-recovery.js', import.meta.url), 'utf8');
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const cleanText = (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);
  const context = { console, __ALBOT_INTERNALS__: { helpers: { clone, cleanText } }, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'known-recovery.js' });
  return context.__ALBOT_INTERNALS__.KnownRecoveryCoordinator;
}

function fixture(options = {}) {
  const state = {
    running: true,
    scheduler: { enabled: true },
    stop: { latched: false },
    character: { name: 'FarmerA', ctype: 'ranger', hp: 1000, max_hp: 1000, rip: false },
    combat: { active: false, pendingAttack: null },
    movement: { active: false, activeOrder: null },
    classSkills: { pending: null, suspendedReason: null },
    resourceTopoff: { pending: null, suspended: false },
    lifecycle: { currentAction: null, queue: [], suspended: false, autonomyEnabled: true },
    partyLogistics: { currentAction: null, queue: [], suspended: false },
    bank: { pending: null, request: null, suspended: false },
    trade: { pending: null, request: null, suspended: false },
    upgrade: { pending: null, request: null, suspended: false },
    exchangeCraft: { pending: null, request: null, suspended: false },
    inventory: { pending: null, request: null, suspended: false },
    merchant: { pending: null, request: null, delivery: null, suspended: false },
    gear: { pending: null, request: null, delivery: null, suspended: false },
    economy: { currentAction: null, suspended: false },
    safeUpdater: { busy: false },
    fullAutonomy: { enabled: false, lastDecision: null },
    transport: { pending: [], partyRecoveryLease: null },
    modules: [
      { id: 'runtime-health', state: 'ACTIVE', health: 'HEALTHY' },
      { id: 'account-strategy', state: 'ACTIVE', health: 'HEALTHY' },
      { id: 'autonomous-observer', state: 'ACTIVE', health: 'HEALTHY' },
      { id: 'combat', state: 'ACTIVE', health: 'HEALTHY' }
    ],
    assessment: { state: 'HEALTHY', verdict: 'PASS', reasons: [] },
    restartCalls: [],
    restartResults: {}
  };
  const status = key => ({ status: () => state[key] });
  const events = [];
  const runtime = {
    get running() { return state.running; },
    logger: null,
    bus: { emit: (type, row) => events.push({ type, row }) },
    scheduler: { status: () => state.scheduler },
    stopLatch: { status: () => state.stop },
    game: { snapshot: () => ({ available: true, character: state.character }) },
    modules: { list: () => state.modules },
    combat: status('combat'),
    movement: status('movement'),
    classSkills: status('classSkills'),
    resourceTopoff: status('resourceTopoff'),
    lifecycle: status('lifecycle'),
    partyLogistics: status('partyLogistics'),
    bank: status('bank'),
    trade: status('trade'),
    upgrade: status('upgrade'),
    exchangeCraft: status('exchangeCraft'),
    inventory: status('inventory'),
    merchant: status('merchant'),
    gear: status('gear'),
    economy: status('economy'),
    safeUpdater: status('safeUpdater'),
    fullAutonomy: status('fullAutonomy'),
    lifecycleTransport: { status: () => state.transport },
    restartModule: async (id, reason) => {
      state.restartCalls.push({ id, reason });
      if (options.restartError) throw new Error(options.restartError);
      return state.restartResults[id] || { id, state: 'ACTIVE', health: 'HEALTHY' };
    }
  };
  const observer = options.observerThrows
    ? { status: () => { throw new Error('observer unavailable'); } }
    : { status: () => ({ assessment: state.assessment }) };
  return { state, runtime, observer, events };
}

function activate(controller) {
  controller.moduleActive = true;
  return controller;
}

function fault(state, id, kind = 'STALE') {
  const row = state.modules.find(module => module.id === id);
  row.state = kind === 'ERROR' ? 'ERROR' : 'ACTIVE';
  row.health = kind;
  state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_' + kind + ':' + id] };
}

test('H22 known recovery is a no-op for healthy observation', () => {
  const Controller = loadRecovery();
  const f = fixture();
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  const plan = recovery.plan();
  assert.equal(plan.state, 'NONE');
  assert.equal(plan.reason, 'HEALTHY_NO_RECOVERY');
});

test('H22 allowlisted fault must persist through confirmation before restart', async () => {
  const Controller = loadRecovery();
  const f = fixture();
  let now = 1000;
  fault(f.state, 'runtime-health', 'STALE');
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => now, confirmMs: 5000 }));

  let result = await recovery.tick();
  assert.equal(result.plan.state, 'WATCH');
  now = 5999;
  result = await recovery.tick();
  assert.equal(result.plan.state, 'WATCH');
  assert.equal(f.state.restartCalls.length, 0);
  now = 6001;
  result = await recovery.tick();
  assert.equal(result.executed, true);
  assert.equal(result.success, true);
  assert.equal(f.state.restartCalls[0].id, 'runtime-health');
});

test('H22 account-strategy and observer are automatic infrastructure recovery targets', () => {
  const Controller = loadRecovery();
  for (const id of ['account-strategy', 'autonomous-observer']) {
    const f = fixture({ observerThrows: id === 'autonomous-observer' });
    fault(f.state, id, 'ERROR');
    if (id === 'autonomous-observer') f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: [] };
    const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000, confirmMs: 1000 }));
    const plan = recovery.plan();
    assert.equal(plan.state, 'WATCH');
    assert.equal(plan.target, id);
  }
});

test('H22 action-bearing module faults escalate instead of restarting', () => {
  const Controller = loadRecovery();
  const f = fixture();
  fault(f.state, 'combat', 'ERROR');
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  const plan = recovery.plan();
  assert.equal(plan.state, 'ESCALATE');
  assert.equal(plan.reason, 'MODULE_RECOVERY_NOT_ALLOWLISTED');
  assert.ok(plan.protectedFaults.some(row => row.id === 'combat'));
});

test('H22 safety gate blocks combat, transactions, UNKNOWN state, emergency and unsafe autonomy', () => {
  const Controller = loadRecovery();
  const cases = [
    ['COMBAT_ACTIVE', f => { f.state.combat.active = true; }],
    ['BANK_PENDING', f => { f.state.bank.pending = { id: 'bank-1' }; }],
    ['TRADE_SUSPENDED', f => { f.state.trade.suspended = true; }],
    ['EMERGENCY_STOP_LATCHED', f => { f.state.stop.latched = true; }],
    ['FULL_AUTONOMY_UNSAFE_TRANSITION', f => { f.state.fullAutonomy = { enabled: true, lastDecision: { state: 'BLOCKED' } }; }],
    ['CLASS_SKILLS_SUSPENDED', f => { f.state.classSkills.suspendedReason = 'ATTACK_UNKNOWN'; }]
  ];
  for (const [expected, mutate] of cases) {
    const f = fixture();
    fault(f.state, 'runtime-health', 'STALE');
    mutate(f);
    const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000, confirmMs: 1000 }));
    const plan = recovery.plan();
    assert.equal(plan.state, 'BLOCKED', expected);
    assert.equal(plan.reason, 'RECOVERY_SAFETY_GATE_BLOCKED', expected);
    assert.ok(plan.blockers.includes(expected), expected);
  }
});

test('H22 additional health reasons prevent automatic restart', () => {
  const Controller = loadRecovery();
  const f = fixture();
  fault(f.state, 'runtime-health', 'STALE');
  f.state.assessment.reasons.push('FARMER_NO_COMBAT_PROGRESS');
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  const plan = recovery.plan();
  assert.equal(plan.state, 'ESCALATE');
  assert.equal(plan.reason, 'ADDITIONAL_HEALTH_REASONS_PRESENT');
});

test('H22 character death delegates to H19 only when lifecycle autonomy is safe', () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['CHARACTER_DEAD'] };
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  let plan = recovery.plan();
  assert.equal(plan.state, 'DELEGATED');
  assert.equal(plan.owner, 'character-lifecycle');

  f.state.lifecycle.autonomyEnabled = false;
  plan = recovery.plan();
  assert.equal(plan.state, 'ESCALATE');
});

test('H22 peer failures delegate to the host watchdog', () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = {
    state: 'CRITICAL',
    verdict: 'FAIL',
    reasons: ['GROUP_PEER_STALE:FarmerB', 'GROUP_DESIRED_MEMBER_OFFLINE']
  };
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  const plan = recovery.plan();
  assert.equal(plan.state, 'DELEGATED');
  assert.equal(plan.owner, 'host-watchdog');
  assert.equal(plan.action, null);
});

test('H22 cooldown and budget are independent per target', async () => {
  const Controller = loadRecovery();
  const f = fixture();
  let now = 1000;
  fault(f.state, 'runtime-health', 'STALE');
  const recovery = activate(new Controller({
    runtime: f.runtime,
    observer: f.observer,
    now: () => now,
    confirmMs: 1000,
    cooldownMs: 5000,
    attemptWindowMs: 60000,
    maxAttemptsPerWindow: 1
  }));

  assert.equal((await recovery.tick()).plan.state, 'WATCH');
  now = 2001;
  assert.equal((await recovery.tick()).success, true);
  fault(f.state, 'runtime-health', 'STALE');
  now = 3000;
  assert.equal((await recovery.tick()).plan.reason, 'RECOVERY_COOLDOWN');
  now = 7002;
  assert.equal((await recovery.tick()).plan.reason, 'RECOVERY_BUDGET_EXHAUSTED');

  f.state.modules.find(row => row.id === 'runtime-health').health = 'HEALTHY';
  fault(f.state, 'account-strategy', 'STALE');
  now = 8000;
  assert.equal((await recovery.tick()).plan.state, 'WATCH');
  now = 9001;
  const second = await recovery.tick();
  assert.equal(second.success, true);
  assert.equal(f.state.restartCalls.at(-1).id, 'account-strategy');
});

test('H22 failed recovery is recorded without gameplay, transactional, UNKNOWN or code authority', async () => {
  const Controller = loadRecovery();
  const f = fixture({ restartError: 'boom' });
  let now = 1000;
  fault(f.state, 'runtime-health', 'ERROR');
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => now, confirmMs: 1000 }));

  assert.equal((await recovery.tick()).plan.state, 'WATCH');
  now = 2001;
  const result = await recovery.tick();
  assert.equal(result.success, false);
  assert.equal(result.result.error, 'boom');

  const status = recovery.status();
  assert.equal(status.stats.failures, 1);
  assert.equal(status.policies.gameplayActionAuthority, false);
  assert.equal(status.policies.transactionalRecoveryAuthority, false);
  assert.equal(status.policies.unknownRecoveryAuthority, false);
  assert.equal(status.policies.codeRepairAuthority, false);
  assert.equal(status.policies.chatgptRequiredForNormalOperation, false);
  assert.ok(f.events.some(event => event.type === 'h22-known-recovery' && event.row.type === 'RECOVERY_FAILED'));
});


test('H22 known recovery is wired through build, runtime, observer and public API', () => {
  const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  const observer = fs.readFileSync(new URL('../src/autonomous-observer.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');

  assert.match(build, /src\/known-recovery\.js/);
  assert.match(runtime, /new ns\.KnownRecoveryCoordinator/);
  assert.match(runtime, /id: 'known-recovery'/);
  assert.match(runtime, /knownRecovery: this\.knownRecovery\.status\(\)/);
  assert.match(runtime, /h22-known-recovery/);
  assert.match(observer, /this\.bus\.on\('h22-known-recovery'/);
  assert.match(entry, /recovery:\s*\{/);
  assert.match(entry, /runtime\.knownRecovery\.plan/);
  assert.match(entry, /Object\.freeze\(api\.recovery\)/);
});
