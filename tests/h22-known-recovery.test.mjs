import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadRecovery() {
  const source = fs.readFileSync(new URL('../src/known-recovery.js', import.meta.url), 'utf8');
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const cleanText = (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);
  const context = {
    console,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText } },
    globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'known-recovery.js' });
  return context.__ALBOT_INTERNALS__.KnownRecoveryCoordinator;
}

function fixture(options = {}) {
  const state = {
    stop: { latched: false },
    resourceTopoff: { pending: null, suspended: false },
    lifecycle: { currentAction: null, queue: [], suspended: false },
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
    transport: { pending: [], partyRecoveryLease: null },
    assessment: {
      state: 'HEALTHY',
      verdict: 'PASS',
      reasons: []
    },
    restartCalls: [],
    restartResult: {
      id: 'runtime-health',
      state: 'ACTIVE',
      health: 'HEALTHY'
    }
  };

  const status = key => ({ status: () => state[key] });
  const events = [];
  const runtime = {
    logger: null,
    bus: { emit: (type, row) => events.push({ type, row }) },
    stopLatch: { status: () => state.stop },
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
    lifecycleTransport: { status: () => state.transport },
    restartModule: async (id, reason) => {
      state.restartCalls.push({ id, reason });
      if (options.restartError) throw new Error(options.restartError);
      return state.restartResult;
    }
  };
  const observer = { status: () => ({ assessment: state.assessment }) };
  return { state, runtime, observer, events };
}

function activate(controller) {
  controller.moduleActive = true;
  return controller;
}

test('H22 known recovery is a no-op for healthy observation', () => {
  const Controller = loadRecovery();
  const f = fixture();
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  const plan = recovery.plan();
  assert.equal(plan.state, 'NONE');
  assert.equal(plan.reason, 'HEALTHY_NO_RECOVERY');
  assert.equal(plan.action, null);
});

test('H22 known recovery allowlists only runtime-health stale or error', () => {
  const Controller = loadRecovery();
  const f = fixture();
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));

  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_STALE:runtime-health'] };
  let plan = recovery.plan();
  assert.equal(plan.state, 'READY');
  assert.equal(plan.action, 'RESTART_MODULE');
  assert.equal(plan.target, 'runtime-health');

  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_ERROR:runtime-health'] };
  plan = recovery.plan();
  assert.equal(plan.state, 'READY');

  for (const reason of ['MODULE_STALE:combat', 'MODULE_ERROR:merchant', 'FARMER_NO_COMBAT_PROGRESS']) {
    f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: [reason] };
    plan = recovery.plan();
    assert.equal(plan.state, 'NONE');
    assert.equal(plan.reason, 'NO_ALLOWLISTED_RECOVERY');
  }
});

test('H22 known recovery blocks runtime-health restart when any additional health reason exists', () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = {
    state: 'CRITICAL',
    verdict: 'FAIL',
    reasons: ['MODULE_STALE:runtime-health', 'FARMER_NO_COMBAT_PROGRESS']
  };
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));
  const plan = recovery.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.reason, 'ADDITIONAL_HEALTH_REASONS_PRESENT');
  assert.ok(plan.blockers.includes('FARMER_NO_COMBAT_PROGRESS'));
});

test('H22 known recovery blocks emergency stop and transactional or UNKNOWN safety states', () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_STALE:runtime-health'] };
  const recovery = activate(new Controller({ runtime: f.runtime, observer: f.observer, now: () => 1000 }));

  f.state.stop.latched = true;
  let plan = recovery.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.reason, 'RECOVERY_SAFETY_GATE_BLOCKED');
  assert.ok(plan.blockers.includes('EMERGENCY_STOP_LATCHED'));

  f.state.stop.latched = false;
  f.state.bank.pending = { id: 'bank-pending' };
  plan = recovery.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.ok(plan.blockers.includes('BANK_PENDING'));

  f.state.bank.pending = null;
  f.state.resourceTopoff.suspended = true;
  plan = recovery.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.ok(plan.blockers.includes('RESOURCE_TOPOFF_SUSPENDED'));

  f.state.resourceTopoff.suspended = false;
  f.state.transport.pending = [{ id: 'h19-pending' }];
  plan = recovery.plan();
  assert.equal(plan.state, 'BLOCKED');
  assert.ok(plan.blockers.includes('H19_REMOTE_PENDING'));
});

test('H22 known recovery restarts runtime-health exactly once when safe', async () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_STALE:runtime-health'] };
  let clock = 1000;
  const recovery = activate(new Controller({
    runtime: f.runtime,
    observer: f.observer,
    now: () => clock,
    cooldownMs: 5000,
    maxAttemptsPerWindow: 2
  }));

  const result = await recovery.tick();
  assert.equal(result.executed, true);
  assert.equal(result.success, true);
  assert.equal(f.state.restartCalls.length, 1);
  assert.equal(f.state.restartCalls[0].id, 'runtime-health');
  assert.match(f.state.restartCalls[0].reason, /^H22_KNOWN_RECOVERY:/);
  assert.equal(recovery.status().stats.successes, 1);
  assert.ok(f.events.some(row => row.type === 'h22-known-recovery' && row.row.type === 'RECOVERY_SUCCEEDED'));
});

test('H22 known recovery cooldown prevents immediate retry loops', async () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_ERROR:runtime-health'] };
  let clock = 1000;
  const recovery = activate(new Controller({
    runtime: f.runtime,
    observer: f.observer,
    now: () => clock,
    cooldownMs: 5000,
    maxAttemptsPerWindow: 3
  }));

  assert.equal((await recovery.tick()).success, true);
  clock = 2000;
  const second = await recovery.tick();
  assert.equal(second.executed, false);
  assert.equal(second.plan.reason, 'RECOVERY_COOLDOWN');
  assert.equal(f.state.restartCalls.length, 1);
});

test('H22 known recovery opens its attempt budget instead of blindly retrying', async () => {
  const Controller = loadRecovery();
  const f = fixture();
  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_STALE:runtime-health'] };
  let clock = 1000;
  const recovery = activate(new Controller({
    runtime: f.runtime,
    observer: f.observer,
    now: () => clock,
    cooldownMs: 5000,
    attemptWindowMs: 60000,
    maxAttemptsPerWindow: 1
  }));

  assert.equal((await recovery.tick()).success, true);
  clock = 7000;
  const blocked = await recovery.tick();
  assert.equal(blocked.executed, false);
  assert.equal(blocked.plan.reason, 'RECOVERY_BUDGET_EXHAUSTED');
  assert.equal(f.state.restartCalls.length, 1);
});

test('H22 known recovery surfaces restart failure and leaves it for later evidence, not blind retry', async () => {
  const Controller = loadRecovery();
  const f = fixture({ restartError: 'simulated restart failure' });
  f.state.assessment = { state: 'CRITICAL', verdict: 'FAIL', reasons: ['MODULE_ERROR:runtime-health'] };
  let clock = 1000;
  const recovery = activate(new Controller({
    runtime: f.runtime,
    observer: f.observer,
    now: () => clock,
    cooldownMs: 5000
  }));

  const result = await recovery.tick();
  assert.equal(result.executed, true);
  assert.equal(result.success, false);
  assert.match(result.result.error, /simulated restart failure/);
  assert.equal(f.state.restartCalls.length, 1);

  clock = 2000;
  const second = await recovery.tick();
  assert.equal(second.executed, false);
  assert.equal(second.plan.reason, 'RECOVERY_COOLDOWN');
  assert.equal(f.state.restartCalls.length, 1);
});

test('H22 known recovery policies forbid gameplay, transactional, UNKNOWN, emergency and code repair authority', () => {
  const Controller = loadRecovery();
  const f = fixture();
  const recovery = new Controller({ runtime: f.runtime, observer: f.observer });
  const policies = recovery.status().policies;
  assert.equal(policies.allowlistedOnly, true);
  assert.deepEqual(Array.from(policies.automaticRecoveryTargets), ['runtime-health']);
  assert.equal(policies.gameplayActionAuthority, false);
  assert.equal(policies.rawGameplayActionAuthority, false);
  assert.equal(policies.transactionalRecoveryAuthority, false);
  assert.equal(policies.unknownRecoveryAuthority, false);
  assert.equal(policies.emergencyOverrideAuthority, false);
  assert.equal(policies.codeRepairAuthority, false);
  assert.equal(policies.chatgptRequiredForNormalOperation, false);
});

test('H22 known recovery is wired into build, runtime, diagnostics, self-test and public API', () => {
  const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');
  const observer = fs.readFileSync(new URL('../src/autonomous-observer.js', import.meta.url), 'utf8');

  assert.match(build, /src\/known-recovery\.js/);
  assert.match(runtime, /new ns\.KnownRecoveryCoordinator/);
  assert.match(runtime, /id: 'known-recovery'/);
  assert.match(runtime, /knownRecovery: this\.knownRecovery\.status\(\)/);
  assert.match(runtime, /h22-known-recovery/);
  assert.match(entry, /recovery:\s*\{/);
  assert.match(entry, /plan: assessment => runtime\.knownRecovery\.plan/);
  assert.match(entry, /Object\.freeze\(api\.recovery\)/);
  assert.match(observer, /this\.bus\.on\('h22-known-recovery'/);
});
