import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const autonomySource = fs.readFileSync(path.resolve(here, '../src/full-autonomy.js'), 'utf8');
const strategySource = fs.readFileSync(path.resolve(here, '../src/account-strategy.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function baseContext() {
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
  return ctx;
}

test('H22 account strategy can constrain FARM selection to the currently online quartet', () => {
  const ctx = baseContext();
  vm.runInNewContext(strategySource, ctx, { filename: 'account-strategy.js' });
  const Strategy = ctx.__ALBOT_INTERNALS__.AccountStrategyController;
  const strategy = new Strategy({});

  const rows = [
    { name: 'My_Ranger1', ctype: 'ranger', strength: 0.95, capabilities: ['DPS', 'RANGED'], rip: false, emergencyStopLatched: false, online: true, running: true },
    { name: 'My_Ranger2', ctype: 'ranger', strength: 0.90, capabilities: ['DPS', 'RANGED'], rip: false, emergencyStopLatched: false, online: true, running: true },
    { name: 'My_Ranger3', ctype: 'ranger', strength: 0.85, capabilities: ['DPS', 'RANGED'], rip: false, emergencyStopLatched: false, online: true, running: true },
    { name: 'My_Rogue', ctype: 'rogue', strength: 0.40, capabilities: ['DPS', 'MELEE'], rip: false, emergencyStopLatched: false, online: false, running: false },
    { name: 'My_Merchant', ctype: 'merchant', strength: 0.30, capabilities: ['ECONOMY', 'LOGISTICS'], rip: false, emergencyStopLatched: false, online: true, running: true }
  ];
  strategy._scoredProfiles = () => clone(rows);
  strategy.progressionPlan = () => ({
    schemaVersion: 1,
    targetCorridor: 0.08,
    strongest: 0.95,
    selectedCharacterName: 'My_Rogue',
    ranking: []
  });

  const unrestricted = strategy.optimizeTask({ type: 'FARM' });
  assert.equal(unrestricted.status, 'SELECTION_READY');
  assert.ok(unrestricted.selected.memberNames.includes('My_Rogue'));

  const constrained = strategy.optimizeTask({
    type: 'FARM',
    allowedCharacterNames: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Ranger3']
  });
  assert.equal(constrained.status, 'SELECTION_READY');
  assert.deepEqual(Array.from(constrained.selected.memberNames), ['My_Ranger1', 'My_Ranger2', 'My_Ranger3']);
  assert.deepEqual(Array.from(constrained.supportMemberNames), ['My_Merchant']);
  assert.equal(constrained.selected.memberNames.includes('My_Rogue'), false);
});

function makePlan(memberNames, supportMemberNames, leaderName, progressionTarget = 'My_Rogue') {
  return {
    schemaVersion: 1,
    taskType: 'FARM',
    status: 'SELECTION_READY',
    selected: { memberNames: memberNames.slice() },
    supportMemberNames: supportMemberNames.slice(),
    leaderName,
    progression: { selectedCharacterName: progressionTarget }
  };
}

function autonomyFixture(options = {}) {
  const ctx = baseContext();
  vm.runInNewContext(autonomySource, ctx, { filename: 'full-autonomy.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.FullAutonomyController;
  const localName = options.localName || 'My_Ranger1';
  const localType = localName === 'My_Merchant' ? 'merchant' : 'ranger';
  const online = ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Ranger3'];
  const profiles = [
    { name: 'My_Merchant', ctype: 'merchant', online: true, peerFresh: localName !== 'My_Merchant', running: true, local: localName === 'My_Merchant' },
    { name: 'My_Ranger1', ctype: 'ranger', online: true, peerFresh: localName !== 'My_Ranger1', running: true, local: localName === 'My_Ranger1' },
    { name: 'My_Ranger2', ctype: 'ranger', online: true, peerFresh: localName !== 'My_Ranger2', running: true, local: localName === 'My_Ranger2' },
    { name: 'My_Ranger3', ctype: 'ranger', online: true, peerFresh: localName !== 'My_Ranger3', running: true, local: localName === 'My_Ranger3' },
    { name: 'My_Rogue', ctype: 'rogue', online: false, peerFresh: false, running: false, local: false }
  ];

  let farmActive = false;
  const calls = { optimize: [], farmStarts: 0, lifecycleStarts: 0, policies: [] };
  const initialPlan = makePlan(['My_Ranger1', 'My_Ranger2', 'My_Rogue'], ['My_Merchant'], 'My_Ranger1');
  const fallbackPlan = makePlan(['My_Ranger1', 'My_Ranger2', 'My_Ranger3'], ['My_Merchant'], 'My_Ranger1');

  const strategy = {
    profiles: () => clone(profiles),
    optimizeTask: input => {
      calls.optimize.push(clone(input));
      return Array.isArray(input.allowedCharacterNames) ? clone(fallbackPlan) : clone(initialPlan);
    },
    recordTraining: () => {}
  };

  const lifecycleStatus = {
    autonomyEnabled: false,
    suspended: false,
    suspendedReason: null,
    currentAction: null,
    actionsThisSession: 0,
    lastAction: null
  };
  const lifecycle = {
    characterRotationReadiness: () => ({
      ready: false,
      reason: 'H19_ROTATION_STOP_NOT_RUNNER_CONTROLLABLE:My_Ranger3',
      blockers: ['H19_ROTATION_STOP_NOT_RUNNER_CONTROLLABLE:My_Ranger3']
    }),
    setPolicy: policy => {
      calls.policies.push(clone(policy));
      return { accepted: true, policy: clone(policy) };
    },
    status: () => clone(lifecycleStatus),
    startAutonomy: () => {
      lifecycleStatus.autonomyEnabled = true;
      calls.lifecycleStarts += 1;
      return { accepted: true };
    },
    stopAutonomy: () => {
      lifecycleStatus.autonomyEnabled = false;
      return { accepted: true };
    }
  };

  const partySnapshot = options.partySnapshot || {
    schemaVersion: 1,
    available: true,
    partyId: 'party-current',
    leader: 'My_Merchant',
    memberNames: online.slice(),
    foreignMemberNames: []
  };

  const runtime = {
    running: true,
    actionAllowed: () => true,
    game: { snapshot: () => ({ character: { name: localName, ctype: localType } }) },
    roster: {
      refresh: () => ({
        accountStateAvailable: true,
        onlineStateAvailable: true,
        activeStateAvailable: true,
        onlineCharacterNames: online.slice(),
        accountCharacters: [
          { name: 'My_Merchant', ctype: 'merchant' },
          { name: 'My_Ranger1', ctype: 'ranger' },
          { name: 'My_Ranger2', ctype: 'ranger' },
          { name: 'My_Ranger3', ctype: 'ranger' },
          { name: 'My_Rogue', ctype: 'rogue' }
        ]
      })
    },
    lifecycle,
    party: { snapshot: () => clone(partySnapshot) },
    farmIntelligence: {
      status: () => ({ active: farmActive, suspended: false, session: farmActive ? { owner: 'full-autonomy' } : null }),
      configureGroup: () => {},
      startAutonomy: () => {
        farmActive = true;
        calls.farmStarts += 1;
        return { accepted: true };
      },
      stopAutonomy: () => {
        farmActive = false;
        return { accepted: true };
      }
    },
    economy: {
      status: () => ({ autonomyEnabled: false, currentAction: null, suspendedReason: null }),
      startAutonomy: () => ({ accepted: true }),
      stopAutonomy: () => ({ accepted: true })
    },
    partyLogistics: {
      status: () => ({ autonomyEnabled: false, currentAction: null, suspendedReason: null }),
      plan: () => ({ state: 'IDLE' }),
      startAutonomy: () => ({ accepted: true }),
      stopAutonomy: () => ({ accepted: true })
    },
    lifecycleTransport: {
      broadcastHeartbeat: () => {},
      freshPeers: () => clone(options.peerStates || [])
    },
    stopLatch: { status: () => ({ latched: false }) }
  };

  const controller = new Controller({ runtime, strategy });
  controller.start({
    scope: {
      interval: () => 'full-autonomy-test-loop',
      cancel: () => true
    }
  });
  return { controller, runtime, strategy, calls, online, profiles, initialPlan, fallbackPlan };
}

test('H24 Full Autonomy preserves the requested catch-up quartet and fails closed when rotation is not controllable', () => {
  const { controller, calls } = autonomyFixture({ localName: 'My_Ranger1' });
  const started = controller.startAutonomy({ taskType: 'FARM' });

  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'BLOCKED');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_ROTATION_UNAVAILABLE');
  assert.deepEqual(Array.from(controller.status().desiredCharacterNames), ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.equal(started.tick.rotationReadiness.reason, 'H19_ROTATION_STOP_NOT_RUNNER_CONTROLLABLE:My_Ranger3');
  assert.deepEqual(Array.from(started.tick.requestedDesiredCharacterNames), ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.equal(calls.optimize.length, 1);
  assert.equal(calls.farmStarts, 0);
  assert.equal(calls.lifecycleStarts, 0);
});

test('H22 lifecycle coordinator converges on one observed owned partial-party leader across different local snapshots', () => {
  const ranger2Party = {
    available: true,
    partyId: 'old-ranger-party',
    leader: 'My_Ranger2',
    memberNames: ['My_Ranger2', 'My_Ranger3'],
    foreignMemberNames: []
  };
  const noParty = {
    available: false,
    partyId: null,
    leader: null,
    memberNames: [],
    foreignMemberNames: []
  };
  const first = autonomyFixture({
    localName: 'My_Ranger1',
    partySnapshot: noParty,
    peerStates: [
      { name: 'My_Ranger2', running: true, party: ranger2Party },
      { name: 'My_Ranger3', running: true, party: ranger2Party },
      { name: 'My_Merchant', running: true, party: noParty }
    ]
  });
  const second = autonomyFixture({
    localName: 'My_Ranger2',
    partySnapshot: ranger2Party,
    peerStates: [
      { name: 'My_Ranger1', running: true, party: noParty },
      { name: 'My_Ranger3', running: true, party: ranger2Party },
      { name: 'My_Merchant', running: true, party: noParty }
    ]
  });
  const desired = ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Ranger3'];
  const readiness = {
    online: desired.slice(),
    profiles: first.profiles,
    missing: [],
    stoppedNames: [],
    unexpectedOnlineNames: []
  };
  const plan = makePlan(['My_Ranger1', 'My_Ranger2', 'My_Ranger3'], ['My_Merchant'], 'My_Ranger1', null);

  first.controller.desiredCharacterNames = desired.slice();
  second.controller.desiredCharacterNames = desired.slice();
  const a = first.controller._ensureLifecycle(plan, readiness);
  const b = second.controller._ensureLifecycle(plan, readiness);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.coordinatorName, 'My_Ranger2');
  assert.equal(b.coordinatorName, 'My_Ranger2');
  assert.equal(a.leader, 'My_Ranger2');
  assert.equal(b.leader, 'My_Ranger2');
  assert.deepEqual(Array.from(a.observedPartyLeaders), ['My_Ranger2']);
  assert.deepEqual(Array.from(b.observedPartyLeaders), ['My_Ranger2']);
  assert.equal(first.calls.policies[0].desiredPartyLeader, 'My_Ranger2');
  assert.equal(second.calls.policies[0].desiredPartyLeader, 'My_Ranger2');
});
