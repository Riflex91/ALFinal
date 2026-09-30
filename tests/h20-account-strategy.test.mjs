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
  const accountRows = options.accountRows || [
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

test('account profiles expose default V3 gear roles to future-gear scoring', () => {
  const { controller } = loadStrategy();
  const roles = Object.fromEntries(controller.profiles().map(row => [row.name, row.gearRole]));
  assert.equal(roles.My_Warrior, 'tank');
  assert.equal(roles.My_Priest, 'healer');
  assert.equal(roles.My_Ranger1, 'dps');
  assert.equal(roles.My_Merchant, 'economy');
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


test('FARM always selects exactly three combat farmers even when one is weaker', () => {
  const { controller } = loadStrategy({
    peers: [
      {
        name: 'My_Priest', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Priest', ctype: 'priest', level: 80, hp: 3000, maxHp: 3000, attack: 450, armor: 250, resistance: 450, frequency: 1, speed: 46, range: 120, gearScore: 500, trainingMs: 5000 }
      },
      {
        name: 'My_Ranger1', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Ranger1', ctype: 'ranger', level: 55, hp: 1800, maxHp: 2500, attack: 350, armor: 100, resistance: 100, frequency: 1, speed: 55, range: 220, gearScore: 220, trainingMs: 250 }
      },
      {
        name: 'My_Merchant', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Merchant', ctype: 'merchant', level: 70, hp: 2200, maxHp: 2200, attack: 120, frequency: 0.8, gearScore: 200, trainingMs: 1000 }
      }
    ]
  });
  const plan = controller.optimizeTask({ type: 'FARM' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.equal(plan.selected.memberNames.length, 3);
  assert.deepEqual([...plan.selected.memberNames], ['My_Priest', 'My_Ranger1', 'My_Warrior']);
  assert.equal(plan.selected.memberNames.includes('My_Merchant'), false);
  assert.deepEqual([...plan.supportMemberNames], ['My_Merchant']);
  assert.ok(plan.ranking.every(row => row.memberNames.length === 3));
});

test('FARM remains exactly three combat farmers when all candidates are strong', () => {
  const { controller } = loadStrategy({
    local: {
      name: 'My_Warrior', ctype: 'warrior', level: 80, hp: 4000, maxHp: 4000,
      mp: 900, maxMp: 900, attack: 1100, armor: 700, resistance: 400,
      frequency: 1.4, speed: 48, range: 45, rip: false, map: 'main'
    },
    accountRows: [
      { name: 'My_Warrior', ctype: 'warrior', level: 80, online: true },
      { name: 'My_Priest', ctype: 'priest', level: 80, online: true },
      { name: 'My_Ranger1', ctype: 'ranger', level: 80, online: true },
      { name: 'My_Merchant', ctype: 'merchant', level: 70, online: true }
    ],
    peers: [
      {
        name: 'My_Priest', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Priest', ctype: 'priest', level: 80, hp: 3200, maxHp: 3200, attack: 900, armor: 500, resistance: 650, frequency: 1.3, speed: 50, range: 150, gearScore: 800, trainingMs: 1000 }
      },
      {
        name: 'My_Ranger1', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Ranger1', ctype: 'ranger', level: 80, hp: 3000, maxHp: 3000, attack: 1100, armor: 300, resistance: 300, frequency: 1.6, speed: 65, range: 250, gearScore: 800, trainingMs: 1000 }
      },
      {
        name: 'My_Merchant', running: true, emergencyStopLatched: false, peerFresh: true,
        profile: { name: 'My_Merchant', ctype: 'merchant', level: 70, hp: 2200, maxHp: 2200, attack: 120, frequency: 0.8, gearScore: 200, trainingMs: 1000 }
      }
    ]
  });
  const plan = controller.optimizeTask({ type: 'FARM' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.equal(plan.selected.memberNames.length, 3);
  assert.equal(plan.selected.memberNames.includes('My_Merchant'), false);
  assert.ok(plan.ranking.length > 0);
  assert.ok(plan.ranking.every(row => row.memberNames.length === 3));
});

test('offline catch-up candidates may rotate into the exact three-farmer FARM group', () => {
  const { controller } = loadStrategy({
    accountRows: [
      { name: 'My_Warrior', ctype: 'warrior', level: 80, online: true },
      { name: 'My_Priest', ctype: 'priest', level: 80, online: true },
      { name: 'My_Ranger1', ctype: 'ranger', level: 80, online: true },
      { name: 'My_Mage', ctype: 'mage', level: 40, online: false },
      { name: 'My_Rogue', ctype: 'rogue', level: 80, online: false },
      { name: 'My_Merchant', ctype: 'merchant', level: 70, online: true }
    ]
  });
  const progression = controller.progressionPlan();
  assert.equal(progression.selectedCharacterName, 'My_Mage');
  const plan = controller.optimizeTask({ type: 'FARM' });
  assert.equal(plan.status, 'SELECTION_READY');
  assert.ok(plan.selected.memberNames.includes('My_Mage'));
  assert.equal(plan.selected.memberNames.length, 3);
  assert.equal(plan.selected.memberNames.includes('My_Merchant'), false);
  assert.deepEqual([...plan.supportMemberNames], ['My_Merchant']);
});

test('activity requirements change the exact three-farmer composition without hardcoding class names', () => {
  const { controller } = loadStrategy({
    accountRows: [
      { name: 'My_Warrior', ctype: 'warrior', level: 80, online: true },
      { name: 'My_Priest', ctype: 'priest', level: 80, online: true },
      { name: 'My_Ranger1', ctype: 'ranger', level: 80, online: true },
      { name: 'My_Mage', ctype: 'mage', level: 80, online: false },
      { name: 'My_Rogue', ctype: 'rogue', level: 80, online: false },
      { name: 'My_Merchant', ctype: 'merchant', level: 70, online: true }
    ]
  });
  const farm = controller.optimizeTask({ type: 'FARM' });
  const boss = controller.optimizeTask({ type: 'BOSS' });
  assert.equal(farm.selected.memberNames.length, 3);
  assert.equal(boss.selected.memberNames.length, 3);
  assert.ok(boss.selected.capabilities.includes('TANK'));
  assert.ok(boss.selected.capabilities.includes('HEALER'));
  assert.ok(boss.selected.capabilities.includes('DPS'));
  assert.deepEqual([...boss.supportMemberNames], ['My_Merchant']);
});


function loadFullAutonomy({ missingPeer = false, stoppedPeerName = null, inactiveFullAutonomyName = null, localName = 'My_Warrior', partyHealthy = true, partyLeader = 'My_Warrior', partyMembers = null, profileRows: customProfileRows = null, selectedMembers = ['My_Priest', 'My_Ranger1', 'My_Warrior'], supportMembers = ['My_Merchant'], leaderName = 'My_Warrior', merchantDesiredNames = null, merchantLeaderName = null, lifecycleSuspended = false, lifecycleSuspendedReason = null, farmSuspended = false, farmSuspendedReason = null, farmOwner = 'full-autonomy', onlineNames = ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'], economyPlan = { state: 'READY', reason: 'TEST_READY', selected: { kind: 'TEST' } }, initialEconomyActive = false } = {}) {
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
    farmGroupConfigCalls: 0,
    farmOwner,
    economyStarts: 0,
    economyStops: 0,
    economyActive: initialEconomyActive,
    standAutoManage: false,
    standConfigureCalls: 0,
    standTicks: 0,
    logisticsStarts: 0,
    logisticsStops: 0,
    logisticsActive: false,
    stoppedPeerName,
    selectedMembers: selectedMembers.slice(),
    merchantDesiredNames: (merchantDesiredNames || [...selectedMembers, ...supportMembers]).slice().sort(),
    merchantLeaderName: merchantLeaderName || leaderName,
    broadcasts: 0,
    training: []
  };
  const profileRows = customProfileRows || [
    { name: 'My_Warrior', ctype: 'warrior' },
    { name: 'My_Priest', ctype: 'priest' },
    { name: 'My_Ranger1', ctype: 'ranger' },
    { name: 'My_Merchant', ctype: 'merchant' }
  ];
  const resolvedPartyMembers = partyMembers || ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'];
  const profiles = profileRows
    .filter(row => !missingPeer || row.name !== 'My_Merchant')
    .map(row => ({
      ...row,
      online: state.onlineNames.includes(row.name),
      local: row.name === localName,
      peerFresh: row.name === localName || state.onlineNames.includes(row.name),
      running: row.name === localName || state.onlineNames.includes(row.name),
      fullAutonomyEnabled: row.name === localName || row.name !== inactiveFullAutonomyName
    }));
  const strategy = {
    profiles: () => clone(profiles.map(row => {
      const online = state.onlineNames.includes(row.name);
      const running = state.stoppedPeerName && row.name === state.stoppedPeerName
        ? false
        : (row.local || online);
      return {
        ...row,
        online,
        peerFresh: row.local || online,
        running,
        fullAutonomyEnabled: row.local || row.name !== inactiveFullAutonomyName
      };
    })),
    optimizeTask: () => ({
      status: 'SELECTION_READY',
      taskType: 'FARM',
      selected: { memberNames: state.selectedMembers.slice() },
      supportMemberNames: supportMembers.slice(),
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
    },
    characterRotationReadiness: desired => ({
      ready: true,
      reason: 'H25_ROTATION_CHARACTER_CONTROL_READY',
      desiredCharacterNames: desired.slice()
    })
  };
  const farmIntelligence = {
    status: () => ({
      active: state.farmActive,
      suspended: state.farmSuspended,
      suspendedReason: state.farmSuspendedReason,
      session: state.farmActive ? { owner: state.farmOwner } : null
    }),
    configureGroup: value => {
      state.farmGroupConfigCalls += 1;
      state.farmGroup = clone(value);
      return clone(value);
    },
    startAutonomy: () => { state.farmStarts += 1; state.farmActive = true; return { accepted: true }; },
    stopAutonomy: () => { state.farmStops += 1; state.farmActive = false; return { stopped: true }; }
  };
  const economy = {
    status: () => ({ autonomyEnabled: state.economyActive, currentAction: null, suspendedReason: null }),
    plan: () => clone(economyPlan),
    startAutonomy: () => { state.economyStarts += 1; state.economyActive = true; return { accepted: true }; },
    stopAutonomy: () => { state.economyStops += 1; state.economyActive = false; return {}; }
  };
  const merchantStand = {
    status: () => ({
      autoManage: state.standAutoManage,
      pending: null,
      suspended: false,
      suspendedReason: null,
      lastPlan: null,
      lastAction: null
    }),
    configure: options => {
      state.standConfigureCalls += 1;
      if (options && options.autoManage != null) state.standAutoManage = options.autoManage === true;
      return { autoManage: state.standAutoManage };
    },
    tick: () => {
      state.standTicks += 1;
      return { state: 'IDLE', reason: 'NO_SAFE_SELL_LISTING_WITH_ACTIONABLE_PRICE_SIGNAL' };
    }
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
          memberNames: resolvedPartyMembers.slice(),
          size: resolvedPartyMembers.length
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
    merchantStand,
    partyLogistics,
    lifecycleTransport: {
      broadcastHeartbeat: () => { state.broadcasts += 1; },
      freshPeer: name => {
        const merchant = supportMembers[0];
        if (String(name) !== String(merchant)
            || String(localName) === String(merchant)
            || missingPeer
            || !state.onlineNames.includes(String(merchant))) return null;
        return {
          name: String(merchant),
          running: true,
          fullAutonomyEnabled: true,
          fullAutonomyDesiredCharacterNames: state.merchantDesiredNames.slice(),
          fullAutonomyDesiredSource: 'merchant-authority',
          fullAutonomyDesiredChangedAtMs: 123456,
          fullAutonomyLeaderName: state.merchantLeaderName
        };
      },
      freshPeers: () => []
    }
  };
  const controller = new Controller({ runtime, strategy });
  controller.start({});
  return { controller, state };
}

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

test('H26 party recovery waits until every desired remote bot has Full Autonomy active', () => {
  const { controller, state } = loadFullAutonomy({
    partyHealthy: false,
    inactiveFullAutonomyName: 'My_Priest'
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_REMOTE_FULL_AUTONOMY');
  assert.deepEqual([...started.tick.missingProfiles], ['My_Priest']);
  assert.deepEqual([...started.tick.inactiveFullAutonomyNames], ['My_Priest']);
  assert.equal(state.lifecycleStarts, 0, 'leader must not invite a bot that cannot accept the desired-party policy yet');
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


test('H26 incomplete party bootstrap is Merchant-led while the combat leader stays independent', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Merchant',
    partyHealthy: false,
    leaderName: 'My_Ranger1',
    selectedMembers: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });

  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
  assert.equal(started.tick.executionLeader, 'My_Ranger1');
  assert.equal(started.tick.partyLeader, 'My_Merchant');
  assert.equal(started.tick.lifecycleCoordinator, 'My_Merchant');
  assert.equal(state.lifecyclePolicy.desiredPartyLeader, 'My_Merchant');
  assert.equal(state.lifecycleStarts, 1);
  assert.equal(state.farmStarts, 0);
});

test('healthy non-coordinator does not run competing lifecycle autonomy', () => {
  const { controller, state } = loadFullAutonomy({ localName: 'My_Priest', partyHealthy: true });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(started.tick.localLifecycleCoordinator, false);
  assert.equal(started.tick.lifecycleCoordinator, 'My_Merchant');
  assert.equal(state.lifecycleStarts, 0);
});

test('H27 partial live roster waits fail-closed when the Merchant authority is offline', () => {
  const { controller, state } = loadFullAutonomy({
    onlineNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_MERCHANT_AUTHORITY');
  assert.equal(started.tick.lifecycleArmed, false);
  assert.equal(state.lifecycleStarts, 0);
  assert.deepEqual([...controller.status().desiredCharacterNames], []);
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
  assert.equal(started.tick.lifecycleCoordinator, 'My_Merchant');
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

test('H27 autostart waits without lifecycle actions until Merchant authority becomes available', () => {
  const { controller, state } = loadFullAutonomy({
    onlineNames: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  const started = controller.startAutonomy({ taskType: 'FARM', waitForRoster: true });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_MERCHANT_AUTHORITY');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.farmStarts, 0);

  state.onlineNames = ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'];
  const next = controller.tick();
  assert.equal(next.state, 'RUNNING');
  assert.equal(state.farmStarts, 1);
});

test('Full Autonomy rotates an old farmer out when strategy selects a different account farmer', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Warrior',
    partyLeader: 'My_Warrior',
    partyMembers: ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'],
    profileRows: [
      { name: 'My_Warrior', ctype: 'warrior' },
      { name: 'My_Priest', ctype: 'priest' },
      { name: 'My_Ranger1', ctype: 'ranger' },
      { name: 'My_Mage', ctype: 'mage' },
      { name: 'My_Merchant', ctype: 'merchant' }
    ],
    selectedMembers: ['My_Mage', 'My_Ranger1', 'My_Warrior'],
    onlineNames: ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior']
  });

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_ROTATING_ACTIVITY_GROUP');
  assert.equal(started.tick.rotationRequired, true);
  assert.deepEqual([...started.tick.desiredCharacterNames], ['My_Mage', 'My_Merchant', 'My_Ranger1', 'My_Warrior']);
  assert.deepEqual([...started.tick.unexpectedOnlineNames], ['My_Priest']);
  assert.equal(started.tick.lifecycleCoordinator, 'My_Merchant');
  assert.equal(state.lifecycleStarts, 0);
  assert.deepEqual([...state.lifecyclePolicy.desiredActiveNames], ['My_Mage', 'My_Merchant', 'My_Ranger1', 'My_Warrior']);
  assert.deepEqual([...state.lifecyclePolicy.desiredPartyMemberNames], ['My_Mage', 'My_Merchant', 'My_Ranger1', 'My_Warrior']);
  assert.equal(state.farmStarts, 0);
});

test('full autonomy honors a lifecycle self-stop and does not restart it on the next tick', () => {
  const { controller, state } = loadFullAutonomy({ localName: 'My_Merchant', partyHealthy: false });
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


test('Full Autonomy rejects any plan that is not exactly three farmers plus one Merchant', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Priest',
    selectedMembers: ['My_Priest', 'My_Ranger1'],
    leaderName: 'My_Priest',
    partyHealthy: true
  });

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'BLOCKED');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_REQUIRES_THREE_FARMERS_AND_ONE_MERCHANT');
  assert.equal(state.farmStarts, 0);
  assert.equal(state.lifecycleStarts, 0);
});

test('Full Autonomy blocks foreign H9 before any lifecycle recovery or rotation mutation', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Warrior',
    farmOwner: 'manual-h9',
    partyLeader: 'My_Warrior',
    partyMembers: ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior'],
    profileRows: [
      { name: 'My_Warrior', ctype: 'warrior' },
      { name: 'My_Priest', ctype: 'priest' },
      { name: 'My_Ranger1', ctype: 'ranger' },
      { name: 'My_Mage', ctype: 'mage' },
      { name: 'My_Merchant', ctype: 'merchant' }
    ],
    selectedMembers: ['My_Mage', 'My_Ranger1', 'My_Warrior'],
    onlineNames: ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Warrior']
  });
  state.farmActive = true;

  const started = controller.startAutonomy({ taskType: 'FARM' });

  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'BLOCKED');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_FOREIGN_FARM_INTELLIGENCE_OWNERSHIP');
  assert.equal(state.lifecycleStarts, 0);
  assert.equal(state.lifecyclePolicy, null);
  assert.equal(state.farmGroupConfigCalls, 0);
  assert.equal(state.farmStarts, 0);
  assert.equal(state.farmStops, 0);
  assert.equal(state.farmActive, true);
});

test('Full Autonomy never reconfigures a foreign active H9 session before rejecting ownership', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Warrior',
    farmOwner: 'manual-h9'
  });
  state.farmActive = true;

  const result = controller._ensureCombatRole({
    selected: { memberNames: ['My_Priest', 'My_Ranger1', 'My_Warrior'] },
    leaderName: 'My_Priest'
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FULL_AUTONOMY_FOREIGN_FARM_INTELLIGENCE_OWNERSHIP');
  assert.equal(state.farmGroupConfigCalls, 0);
  assert.equal(state.farmGroup, null);
  assert.equal(state.farmStarts, 0);
  assert.equal(state.farmStops, 0);
  assert.equal(state.farmActive, true);
});

test('Full Autonomy stops an already-active owned H9 session when the local farmer is no longer selected', () => {
  const { controller, state } = loadFullAutonomy({ localName: 'My_Warrior' });
  state.farmActive = true;
  const result = controller._ensureCombatRole({
    selected: { memberNames: ['My_Mage', 'My_Priest', 'My_Ranger1'] },
    leaderName: 'My_Priest'
  });
  assert.equal(result.ok, true);
  assert.equal(state.farmStops, 1);
  assert.equal(state.farmActive, false);
});

test('full autonomy arms an already-active lifecycle and blocks if it later stops', () => {
  const { controller, state } = loadFullAutonomy({ localName: 'My_Merchant', partyHealthy: false });
  state.lifecycleAutonomyEnabled = true;

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
  assert.equal(started.tick.partyLeader, 'My_Merchant');
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
  const { controller, state } = loadFullAutonomy({ localName: 'My_Merchant', stoppedPeerName: 'My_Ranger1' });
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
  assert.equal(next.lifecycleCoordinator, 'My_Merchant');
  assert.equal(state.lifecycleStarts, 0);
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


test('Full Autonomy enables safe Merchant Stand management and restores default-off on stop', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Merchant',
    partyLeader: 'My_Priest',
    selectedMembers: ['My_Priest', 'My_Ranger1', 'My_Warrior']
  });

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(state.standAutoManage, true);
  assert.equal(controller.status().standManagedByFullAutonomy, true);
  assert.ok(state.standConfigureCalls >= 1);

  controller.stopAutonomy('TEST_STOP');
  assert.equal(state.standAutoManage, false);
  assert.equal(controller.status().standManagedByFullAutonomy, false);
});


test('H26 non-Merchant windows follow the Merchant shared desired quartet instead of rotating independently', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Rogue',
    partyHealthy: false,
    profileRows: [
      { name: 'My_Rogue', ctype: 'rogue' },
      { name: 'My_Warrior', ctype: 'warrior' },
      { name: 'My_Ranger1', ctype: 'ranger' },
      { name: 'My_Ranger2', ctype: 'ranger' },
      { name: 'My_Merchant', ctype: 'merchant' }
    ],
    selectedMembers: ['My_Ranger1', 'My_Ranger2', 'My_Warrior'],
    merchantDesiredNames: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'],
    merchantLeaderName: 'My_Ranger1',
    onlineNames: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']
  });

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.deepEqual([...controller.status().desiredCharacterNames], ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.equal(controller.status().desiredSource, 'merchant-peer');
  assert.equal(started.tick.state, 'WARMING');
  assert.equal(started.tick.reason, 'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
  assert.deepEqual([...state.lifecyclePolicy.desiredActiveNames], ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.equal(state.lifecyclePolicy.desiredPartyLeader, 'My_Merchant');
  assert.equal(started.tick.lifecycleCoordinator, 'My_Merchant');
  assert.equal(state.lifecycleStarts, 0, 'only the Merchant window may own proactive party recovery while it is online');
  assert.equal(state.farmStarts, 0);
});

test('H26 Merchant selection hysteresis prevents Rogue-Warrior ping-pong and adopts only a stable candidate', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Merchant',
    partyHealthy: true,
    partyLeader: 'My_Ranger1',
    partyMembers: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'],
    profileRows: [
      { name: 'My_Rogue', ctype: 'rogue' },
      { name: 'My_Warrior', ctype: 'warrior' },
      { name: 'My_Ranger1', ctype: 'ranger' },
      { name: 'My_Ranger2', ctype: 'ranger' },
      { name: 'My_Merchant', ctype: 'merchant' }
    ],
    selectedMembers: ['My_Ranger1', 'My_Ranger2', 'My_Rogue'],
    supportMembers: ['My_Merchant'],
    leaderName: 'My_Ranger1',
    onlineNames: ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']
  });

  const started = controller.startAutonomy({ taskType: 'FARM', selectionStabilityMs: 3000, rotationCooldownMs: 10000 });
  assert.equal(started.accepted, true);
  assert.deepEqual([...controller.status().desiredCharacterNames], ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);

  state.selectedMembers = ['My_Ranger1', 'My_Ranger2', 'My_Warrior'];
  controller.desiredChangedAtMs = Date.now() - 20000;
  const candidate = controller.tick();
  assert.deepEqual([...controller.status().desiredCharacterNames], ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  assert.deepEqual([...controller.status().selectionCandidateNames], ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Warrior']);
  assert.equal(candidate.state, 'RUNNING');

  controller.selectionCandidateSinceMs = Date.now() - 4000;
  const adopted = controller.tick();
  assert.deepEqual([...controller.status().desiredCharacterNames], ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Warrior']);
  assert.equal(controller.status().selectionCandidateNames.length, 0);
  assert.equal(adopted.state, 'WARMING');
  assert.equal(adopted.reason, 'FULL_AUTONOMY_ROTATING_ACTIVITY_GROUP');
  assert.equal(adopted.lifecycleCoordinator, 'My_Merchant');
});


test('Full Autonomy leaves no-op Economy released so Merchant Stand is not permanently blocked', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Merchant',
    partyLeader: 'My_Priest',
    selectedMembers: ['My_Priest', 'My_Ranger1', 'My_Warrior'],
    economyPlan: {
      state: 'IDLE',
      reason: 'H17_NO_SAFE_ECONOMY_ACTION',
      selected: null,
      proposals: []
    }
  });

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(state.standAutoManage, true);
  assert.ok(state.standTicks >= 1);
  assert.equal(state.economyStarts, 0);
  assert.equal(state.economyActive, false);
});


test('Full Autonomy releases an already-active Economy immediately after its last real action drains', () => {
  const { controller, state } = loadFullAutonomy({
    localName: 'My_Merchant',
    partyLeader: 'My_Priest',
    selectedMembers: ['My_Priest', 'My_Ranger1', 'My_Warrior'],
    initialEconomyActive: true,
    economyPlan: {
      state: 'IDLE',
      reason: 'H17_NO_SAFE_ECONOMY_ACTION',
      selected: null,
      proposals: []
    }
  });

  const started = controller.startAutonomy({ taskType: 'FARM' });
  assert.equal(started.accepted, true);
  assert.equal(started.tick.state, 'RUNNING');
  assert.equal(state.economyStops, 1);
  assert.equal(state.economyActive, false);
  assert.equal(state.standAutoManage, true);
  assert.ok(state.standTicks >= 1);
  assert.equal(started.tick.localRole, 'idle');
});
