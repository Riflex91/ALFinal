import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadStrategy(options = {}) {
  const source = fs.readFileSync(path.resolve(here, '../src/account-strategy.js'), 'utf8');
  const local = options.local || {
    name: 'My_Warrior', ctype: 'warrior', level: 80, hp: 4000, maxHp: 4000,
    mp: 900, maxMp: 900, attack: 700, armor: 500, resistance: 250,
    frequency: 1.2, speed: 45, range: 45, rip: false, map: 'main'
  };
  const peers = options.peers || [
    {
      name: 'My_Priest', running: true, emergencyStopLatched: false, peerFresh: true,
      profile: { name: 'My_Priest', ctype: 'priest', level: 79, hp: 2800, maxHp: 3000, attack: 420, armor: 220, resistance: 420, frequency: 1, speed: 46, range: 120, gearScore: 450, trainingMs: 2000 }
    },
    {
      name: 'My_Ranger1', running: true, emergencyStopLatched: false, peerFresh: true,
      profile: { name: 'My_Ranger1', ctype: 'ranger', level: 76, hp: 2600, maxHp: 2800, attack: 650, armor: 180, resistance: 180, frequency: 1.3, speed: 55, range: 220, gearScore: 430, trainingMs: 1000 }
    },
    {
      name: 'My_Merchant', running: true, emergencyStopLatched: false, peerFresh: true,
      profile: { name: 'My_Merchant', ctype: 'merchant', level: 70, hp: 2200, maxHp: 2200, attack: 120, armor: 120, resistance: 120, frequency: 0.8, speed: 40, range: 40, gearScore: 200, trainingMs: 500 }
    }
  ];
  const accountRows = [
    { name: 'My_Warrior', ctype: 'warrior', level: 80, online: true },
    { name: 'My_Priest', ctype: 'priest', level: 79, online: true },
    { name: 'My_Ranger1', ctype: 'ranger', level: 76, online: true },
    { name: 'My_Merchant', ctype: 'merchant', level: 70, online: true }
  ];
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const ctx = {
    console, Date, Math, JSON, Map, Set, Object, Array, String, Number, Boolean,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'account-strategy.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.AccountStrategyController;
  const game = {
    snapshot: () => ({ available: true, character: clone(local) }),
    equipmentSnapshot: () => ({ available: true, slots: {} })
  };
  const roster = {
    refresh: () => ({
      accountStateAvailable: true,
      accountCharacters: clone(accountRows),
      onlineCharacterNames: accountRows.filter(row => row.online).map(row => row.name)
    })
  };
  const crossWindow = { freshPeers: () => clone(peers) };
  const gear = { score: () => 0 };
  const controller = new Controller({ game, roster, crossWindow, gear, now: options.now || (() => 10000) });
  controller.start({});
  return { controller, ctx };
}

test('account strategy chooses the capable combat trio for boss work and keeps merchant as support', () => {
  const { controller } = loadStrategy();
  const plan = controller.optimizeTask({ type: 'BOSS' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.deepEqual(
    [...plan.selected.memberNames],
    ['My_Priest', 'My_Ranger1', 'My_Warrior']
  );
  assert.equal(plan.leaderName, 'My_Warrior');
  assert.deepEqual([...plan.supportMemberNames], ['My_Merchant']);
  assert.ok(plan.selected.capabilities.includes('TANK'));
  assert.ok(plan.selected.capabilities.includes('HEALER'));
  assert.ok(plan.selected.capabilities.includes('DPS'));
});

test('account progression identifies the weaker combat character for catch-up training', () => {
  const { controller } = loadStrategy({
    peers: [
      {
        name: 'My_Priest', running: true, emergencyStopLatched: false,
        profile: { name: 'My_Priest', ctype: 'priest', level: 80, hp: 3000, maxHp: 3000, attack: 450, armor: 250, resistance: 450, frequency: 1, gearScore: 500, trainingMs: 5000 }
      },
      {
        name: 'My_Ranger1', running: true, emergencyStopLatched: false,
        profile: { name: 'My_Ranger1', ctype: 'ranger', level: 55, hp: 1800, maxHp: 2500, attack: 350, armor: 100, resistance: 100, frequency: 1, gearScore: 220, trainingMs: 250 }
      },
      {
        name: 'My_Merchant', running: true, emergencyStopLatched: false,
        profile: { name: 'My_Merchant', ctype: 'merchant', level: 70, hp: 2200, maxHp: 2200, attack: 120, frequency: 0.8, gearScore: 200, trainingMs: 1000 }
      }
    ]
  });
  const plan = controller.progressionPlan();
  assert.equal(plan.selectedCharacterName, 'My_Ranger1');
  assert.equal(plan.ranking[0].name, 'My_Ranger1');
  assert.ok(plan.ranking[0].catchUp > 0);
});


test('FARM chooses the best task group dynamically instead of forcing the full combat trio', () => {
  const { controller } = loadStrategy({
    peers: [
      {
        name: 'My_Priest', running: true, emergencyStopLatched: false,
        profile: { name: 'My_Priest', ctype: 'priest', level: 80, hp: 3000, maxHp: 3000, attack: 450, armor: 250, resistance: 450, frequency: 1, gearScore: 500, trainingMs: 5000 }
      },
      {
        name: 'My_Ranger1', running: true, emergencyStopLatched: false,
        profile: { name: 'My_Ranger1', ctype: 'ranger', level: 55, hp: 1800, maxHp: 2500, attack: 350, armor: 100, resistance: 100, frequency: 1, gearScore: 220, trainingMs: 250 }
      },
      {
        name: 'My_Merchant', running: true, emergencyStopLatched: false,
        profile: { name: 'My_Merchant', ctype: 'merchant', level: 70, hp: 2200, maxHp: 2200, attack: 120, frequency: 0.8, gearScore: 200, trainingMs: 1000 }
      }
    ]
  });
  const progression = controller.progressionPlan();
  assert.equal(progression.selectedCharacterName, 'My_Ranger1');
  const plan = controller.optimizeTask({ type: 'FARM' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.deepEqual([...plan.selected.memberNames], ['My_Priest', 'My_Ranger1']);
  assert.equal(plan.selected.memberNames.includes('My_Merchant'), false);
  assert.equal(plan.leaderName, 'My_Priest');
  assert.ok(plan.selected.coordinationCost > 0);
  assert.ok(plan.ranking.some(row => row.memberNames.length === 1));
  assert.ok(plan.ranking.some(row => row.memberNames.length === 3));
});

function loadFullAutonomy({ missingPeer = false, stoppedPeerName = null, localName = 'My_Warrior', partyHealthy = true, partyLeader = 'My_Warrior', selectedMembers = ['My_Priest', 'My_Ranger1', 'My_Warrior'], leaderName = 'My_Warrior', lifecycleSuspended = false, lifecycleSuspendedReason = null, farmSuspended = false, farmSuspendedReason = null, onlineNames = ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'] } = {}) {
  const source = fs.readFileSync(path.resolve(here, '../src/full-autonomy.js'), 'utf8');
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const ctx = {
    console, Date, Math, JSON, Map, Set, Object, Array, String, Number, Boolean,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'full-autonomy.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.FullAutonomyController;
  const state = {
    lifecyclePolicy: null,
    lifecycleStarts: 0,
    lifecycleAutonomyEnabled: false,
    lifecycleSuspended,
    lifecycleSuspendedReason,
    onlineNames: onlineNames.slice(),
    farmStarts: 0,
    farmStops: 0,
    farmActive: false,
    farmSuspended,
    farmSuspendedReason,
    farmGroup: null,
    economyStarts: 0,
    economyStops: 0,
    economyActive: false,
    logisticsStarts: 0,
    logisticsStops: 0,
    logisticsActive: false,
    stoppedPeerName,
    broadcasts: 0,
    training: []
  };
  const profileRows = [
    { name: 'My_Warrior', ctype: 'warrior' },
    { name: 'My_Priest', ctype: 'priest' },
    { name: 'My_Ranger1', ctype: 'ranger' },
    { name: 'My_Merchant', ctype: 'merchant' }
  ];
  const profiles = profileRows
    .filter(row => !missingPeer || row.name !== 'My_Merchant')
    .map(row => ({
      ...row,
      online: true,
      local: row.name === localName,
      peerFresh: true,
      running: true
    }));
  const strategy = {
    profiles: () => clone(profiles.map(row => ({
      ...row,
      running: state.stoppedPeerName && row.name === state.stoppedPeerName ? false : row.running
    }))),
    optimizeTask: () => ({
      status: 'SELECTION_READY',
      taskType: 'FARM',
      selected: { memberNames: selectedMembers.slice() },
      supportMemberNames: ['My_Merchant'],
      leaderName,
      progression: { selectedCharacterName: 'My_Ranger1' }
    }),
    recordTraining: value => state.training.push(value)
  };
  const lifecycle = {
    setPolicy: value => { state.lifecyclePolicy = clone(value); return { accepted: true }; },
    status: () => ({
      autonomyEnabled: state.lifecycleAutonomyEnabled,
      suspended: state.lifecycleSuspended,
      suspendedReason: state.lifecycleSuspendedReason,
      currentAction: state.lifecycleCurrentAction || null,
      lastAction: state.lifecycleLastAction || null,
      actionsThisSession: state.lifecycleActionsThisSession || 0
    }),
    startAutonomy: () => {
      state.lifecycleStarts += 1;
      state.lifecycleAutonomyEnabled = true;
      return { accepted: true };
    },
    stopAutonomy: reason => {
      state.lifecycleAutonomyEnabled = false;
      state.lifecycleLastAction = { type: 'AUTONOMY_STOPPED', reason };
      return { accepted: true };
    }
  };
  const farmIntelligence = {
    status: () => ({
      active: state.farmActive,
      suspended: state.farmSuspended,
      suspendedReason: state.farmSuspendedReason,
      session: state.farmActive ? { owner: 'full-autonomy' } : null
    }),
    configureGroup: value => { state.farmGroup = clone(value); return clone(value); },
    startAutonomy: () => { state.farmStarts += 1; state.farmActive = true; return { accepted: true }; },
    stopAutonomy: () => { state.farmStops += 1; state.farmActive = false; return { stopped: true }; }
  };
  const economy = {
    status: () => ({ autonomyEnabled: state.economyActive, currentAction: null, suspendedReason: null }),
    startAutonomy: () => { state.economyStarts += 1; state.economyActive = true; return { accepted: true }; },
    stopAutonomy: () => { state.economyStops += 1; state.economyActive = false; return {}; }
  };
  const partyLogistics = {
    status: () => ({ autonomyEnabled: state.logisticsActive, currentAction: null, suspendedReason: null }),
    plan: () => ({ state: 'IDLE', reason: 'NO_WORK' }),
    startAutonomy: () => { state.logisticsStarts += 1; state.logisticsActive = true; return { accepted: true }; },
    stopAutonomy: () => { state.logisticsStops += 1; state.logisticsActive = false; return {}; }
  };
  const runtime = {
    running: true,
    stopLatch: { status: () => ({ latched: false }) },
    actionAllowed: () => true,
    game: {
      snapshot: () => ({
        available: true,
        character: {
          name: localName,
          ctype: profileRows.find(row => row.name === localName).ctype
        }
      })
    },
    party: {
      snapshot: () => partyHealthy
        ? {
          available: true,
          leader: partyLeader,
          memberNames: ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'],
          size: 4
        }
        : { available: false, leader: null, memberNames: [], size: 0 }
    },
    roster: {
      refresh: () => ({
        onlineCharacterNames: state.onlineNames.slice()
      })
    },
    lifecycle,
    farmIntelligence,
    economy,
    partyLogistics,
    lifecycleTransport: { broadcastHeartbeat: () => { state.broadcasts += 1; } }
  };
  const controller = new Controller({ runtime, strategy });
  controller.start({});
  return { controller, state };
}

test('task optimizer can expand FARM to three members when the third member adds enough value', () => {
  const { controller } = loadStrategy({
    local: {
      name: 'My_Warrior', ctype: 'warrior', level: 80, hp: 4000, maxHp: 4000,
      mp: 900, maxMp: 900, attack: 900, armor: 600, resistance: 350,
      frequency: 1.3, speed: 48, range: 45, rip: false, map: 'main'
    },
    peers: [
      {
        name: 'My_Priest', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Priest', ctype: 'priest', level: 80, hp: 3200, maxHp: 3200, attack: 700, armor: 350, resistance: 550, frequency: 1.1, speed: 48, range: 140, gearScore: 700, trainingMs: 1000 }
      },
      {
        name: 'My_Ranger1', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Ranger1', ctype: 'ranger', level: 80, hp: 3000, maxHp: 3000, attack: 950, armor: 250, resistance: 250, frequency: 1.5, speed: 60, range: 240, gearScore: 700, trainingMs: 1000 }
      },
      {
        name: 'My_Merchant', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Merchant', ctype: 'merchant', level: 70, hp: 2200, maxHp: 2200, attack: 120, frequency: 0.8, gearScore: 200, trainingMs: 1000 }
      }
    ]
  });
  const plan = controller.optimizeTask({ type: 'FARM' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.ok(plan.selected.memberNames.length >= 1 && plan.selected.memberNames.length <= 3);
  assert.equal(plan.selected.memberNames.includes('My_Merchant'), false);
  assert.ok(plan.ranking.some(row => row.memberNames.length !== plan.selected.memberNames.length));
});

test('BOSS remains capability-driven and requires a tank healer and DPS rather than named characters', () => {
  const { controller } = loadStrategy();
  const plan = controller.optimizeTask({ type: 'BOSS' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.ok(plan.selected.capabilities.includes('TANK'));
  assert.ok(plan.selected.capabilities.includes('HEALER'));
  assert.ok(plan.selected.capabilities.includes('DPS'));
  assert.equal(plan.selected.memberNames.includes('My_Merchant'), false);
});

test('full autonomy waits fail-closed until every online character has a fresh bot profile', () => {
  const { controller, state } = loadFullAutonomy({ missingPeer: true });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.deepEqual([...started.tick.missingProfiles], ['My_Merchant']);
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.farmStarts, 0);
});

test('full autonomy applies one shared party policy and starts the selected combat role', () => {
  const { controller, state } = loadFullAutonomy();
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.farmStarts, 1);
  assert.equal(state.lifecyclePolicy.desiredPartyLeader, 'My_Warrior');
  assert.deepEqual(
    [...state.lifecyclePolicy.desiredPartyMemberNames],
    ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior']
  );
  assert.deepEqual(
    [...state.lifecyclePolicy.desiredActiveNames],
    ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior']
  );
  assert.equal(state.broadcasts, 1);
  assert.deepEqual(state.training, [true]);
});


test('healthy non-coordinator does not run competing lifecycle autonomy', () => {
  const { controller, state } = loadFullAutonomy({ localName: 'My_Priest', partyHealthy: true });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(started.tick.localLifecycleCoordinator, false);
  assert.equal(started.tick.lifecycleCoordinator, 'My_Warrior');
  assert.equal(state.lifecycleStarts, 0);
});

test('full autonomy refuses to start unless the configured four-character live roster is online', () => {
  const { controller } = loadFullAutonomy();
  controller.runtime.roster.refresh = () => ({
    onlineCharacterNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, false);
  assert.equal(started.reason, 'FULL_AUTONOMY_EXPECTED_ONLINE_COUNT_MISMATCH');
});


test('healthy full-live roles continue while lifecycle recovery remains safely suspended', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Ranger1',
    partyLeader: 'My_Priest',
    selectedMembers: ['My_Priest', 'My_Ranger1', 'My_Warrior'],
    lifecycleSuspended: true,
    lifecycleSuspendedReason: 'H19_STOP_UNVERIFIED_TIMEOUT'
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(started.tick.partyTopologyHealthy, true);
  assert.equal(started.tick.lifecycleCoordinator, 'My_Priest');
  assert.equal(started.tick.lifecycleRecoveryRequired, false);
  assert.equal(started.tick.lifecycleRecoveryBlocked, true);
  assert.equal(started.tick.lifecycleRecoveryBlockReason, 'H19_STOP_UNVERIFIED_TIMEOUT');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.farmStarts, 1);
});

test('merchant economy continues in a healthy party while lifecycle recovery is suspended', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Merchant',
    partyLeader: 'My_Priest',
    selectedMembers: ['My_Priest', 'My_Ranger1', 'My_Warrior'],
    lifecycleSuspended: true,
    lifecycleSuspendedReason: 'H19_STOP_UNVERIFIED_TIMEOUT'
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(started.tick.localRole, 'economy');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.economyStarts, 1);
});

test('autostart can arm safely before all four characters are online and waits without acting', () => {
  const { controller, state } = loadFullAutonomy({
    onlineNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  const started = controller.startAutonomy({ taskType: 'FARM', waitForRoster: true });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_FOR_EXPECTED_ONLINE_COUNT');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.farmStarts, 0);

  state.onlineNames = ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'];
  const next = controller.tick();
  assert.equal(next.state, 'RUNNING');
  assert.equal(state.farmStarts, 1);
});

test('full autonomy honors a lifecycle self-stop and does not restart it on the next tick', () => {
  const { controller, state } = loadFullAutonomy({ partyHealthy: false });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(state.lifecycleStarts, 1);

  state.lifecycleAutonomyEnabled = false;
  state.lifecycleLastAction = {
    type: 'START_REJECTED',
    reason: 'H19_SERVER_REJECTED',
    autonomyStopped: true
  };
  state.lifecycleActionsThisSession = 1;

  const next = controller.tick();
  assert.equal(next.state, 'BLOCKED');
  assert.equal(next.reason, 'FULL_AUTONOMY_LIFECYCLE_STOP_REQUIRES_EXPLICIT_RESTART');
  assert.equal(state.lifecycleStarts, 1);
});


test('Full Autonomy applies the strategy-selected FARM group and leaves unselected combat characters on standby', () => {
  const selectedMembers = ['My_Priest', 'My_Ranger1'];
  const priest = loadFullAutonomy({ localName: 'My_Priest', selectedMembers, leaderName: 'My_Priest', partyHealthy: true });
  const ranger = loadFullAutonomy({ localName: 'My_Ranger1', selectedMembers, leaderName: 'My_Priest', partyHealthy: true });
  const warrior = loadFullAutonomy({ localName: 'My_Warrior', selectedMembers, leaderName: 'My_Priest', partyHealthy: true });

  const priestStart = priest.controller.startAutonomy({ taskType: 'FARM' });
  const rangerStart = ranger.controller.startAutonomy({ taskType: 'FARM' });
  const warriorStart = warrior.controller.startAutonomy({ taskType: 'FARM' });

  for (const started of [priestStart, rangerStart, warriorStart]) {
    assert.equal(started.accepted, true);
    assert.deepEqual(started.tick.executionMembers, selectedMembers);
  }
  assert.equal(priestStart.tick.localRole, 'combat-farm');
  assert.equal(rangerStart.tick.localRole, 'combat-farm');
  assert.equal(warriorStart.tick.localRole, 'standby');
  assert.deepEqual(priest.state.farmGroup, { groupLeaderName: 'My_Priest', groupMemberNames: selectedMembers });
  assert.deepEqual(ranger.state.farmGroup, { groupLeaderName: 'My_Priest', groupMemberNames: selectedMembers });
  assert.equal(warrior.state.farmGroup, null);
  assert.deepEqual(warrior.state.lifecyclePolicy.desiredPartyMemberNames, ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior']);
});

test('full autonomy arms an already-active lifecycle and blocks if it later stops', () => {
  const { controller, state } = loadFullAutonomy({ partyHealthy: false });
  state.lifecycleAutonomyEnabled = true;

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(controller.status().lifecycleArmed, true);

  state.lifecycleAutonomyEnabled = false;
  state.lifecycleLastAction = { type: 'AUTONOMY_STOPPED', reason: 'H19_SESSION_BUDGET_REACHED' };

  const next = controller.tick();
  assert.equal(next.state, 'BLOCKED');
  assert.equal(next.reason, 'FULL_AUTONOMY_LIFECYCLE_STOP_REQUIRES_EXPLICIT_RESTART');
  assert.equal(state.lifecycleStarts, 0);
});

test('stopped desired peer triggers lifecycle recovery even when party topology is healthy', () => {
  const { controller, state } = loadFullAutonomy({ stoppedPeerName: 'My_Ranger1' });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_RECOVERING_STOPPED_OR_STALE_PEER');
  assert.deepEqual([...started.tick.stoppedDesiredNames], ['My_Ranger1']);
  assert.equal(started.tick.runtimeRecoveryRequired, true);
  assert.equal(state.lifecycleStarts, 1);
  assert.equal(state.farmStarts, 0);
});

test('full autonomy pauses owned FARM work before recovering a dropped pinned roster member', () => {
  const { controller, state } = loadFullAutonomy();
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(state.farmActive, true);

  state.onlineNames = ['My_Merchant', 'My_Priest', 'My_Warrior'];
  const next = controller.tick();
  assert.equal(next.state, 'WARMING');
  assert.equal(next.reason, 'FULL_AUTONOMY_RECOVERING_EXPECTED_ROSTER');
  assert.equal(state.farmActive, false);
  assert.equal(state.farmStops, 1);
  assert.equal(state.lifecycleStarts, 1);
});

test('suspended Farm Intelligence blocks Full Autonomy instead of reporting RUNNING', () => {
  const { controller, state } = loadFullAutonomy({
    farmSuspended: true,
    farmSuspendedReason: 'H9_COMBAT_UNKNOWN'
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'BLOCKED');
  assert.equal(started.tick.reason, 'H9_COMBAT_UNKNOWN');
  assert.equal(state.farmStarts, 0);
});

test('entry auto-starts runtime and arms FARM full autonomy only on live Adventure Land pages', () => {
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  assert.ok(entry.includes("host === 'adventure.land'"));
  assert.match(entry, /await runtime\.start\(\)/);
  assert.match(entry, /startAutonomy\(\{ taskType: 'FARM', waitForRoster: true \}\)/);
  assert.match(entry, /__ALBOT_DISABLE_AUTOSTART__/);
});
