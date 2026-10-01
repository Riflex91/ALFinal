import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PersistentStateStore } from '../host/telemetry-recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = name => fs.readFileSync(path.resolve(here, '../src/' + name), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function context(extra = {}) {
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    encodeURIComponent, setTimeout, clearTimeout,
    AbortController: globalThis.AbortController,
    Blob: globalThis.Blob,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    },
    ...extra
  };
  root.globalThis = root;
  return root;
}

test('H31 SSD store keeps independent latest gear snapshots and account wealth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-h31-state-'));
  try {
    const store = new PersistentStateStore({ stateRoot: dir });
    assert.equal(store.writeProfile({
      name: 'My_Mage',
      observedAtMs: 100,
      gold: 111,
      equipment: { mainhand: { name: 'firestaff', level: 4 } }
    }), true);
    assert.equal(store.writeProfile({
      name: 'My_Priest',
      observedAtMs: 200,
      gold: 222,
      equipment: { mainhand: { name: 'staff', level: 3 } }
    }), true);
    assert.equal(store.writeWealth({ schemaVersion: 1, bankGold: 987654321, observedAtMs: 300 }), true);

    const account = store.readAccount();
    assert.equal(account.profiles.length, 2);
    assert.equal(account.profiles.find(row => row.name === 'My_Mage').equipment.mainhand.level, 4);
    assert.equal(account.profiles.find(row => row.name === 'My_Priest').equipment.mainhand.name, 'staff');
    assert.equal(account.wealth.bankGold, 987654321);
    assert.equal(fs.existsSync(path.join(dir, 'account-profiles', 'My_Mage.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'account-profiles', 'My_Priest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'account-wealth.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H31 host state loads SSD profiles before start returns and flushes final snapshots', async () => {
  const posts = [];
  const listeners = [];
  const root = context({
    addEventListener: (name, fn) => listeners.push({ name, fn }),
    removeEventListener: () => {},
    fetch: async (url, options = {}) => {
      if (String(options.method || 'GET').toUpperCase() === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 1,
            profiles: [{
              name: 'My_Ranger1',
              observedAtMs: 10,
              equipment: { mainhand: { name: 'bow', level: 6 } }
            }],
            wealth: { bankGold: 1234, observedAtMs: 10 }
          })
        };
      }
      posts.push({ url, options: clone({ ...options, signal: undefined }) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, profilesWritten: 1 })
      };
    }
  });
  vm.runInNewContext(source('host-state.js'), root, { filename: 'host-state.js' });
  const Client = root.__ALBOT_INTERNALS__.HostPersistentStateClient;
  const intervals = [];
  const events = [];
  const client = new Client({ root, requestTimeoutMs: 1000 });
  const started = await client.start({
    scope: {
      interval: (label, fn) => { intervals.push({ label, fn }); return label; },
      event: (label, target, eventName, fn) => { events.push({ label, eventName, fn }); return label; }
    }
  });
  assert.equal(started.cacheProfiles, 1);
  assert.equal(client.profile('My_Ranger1').equipment.mainhand.level, 6);
  assert.equal(client.wealth().bankGold, 1234);
  assert.ok(events.some(row => row.eventName === 'pagehide'));
  assert.ok(events.some(row => row.eventName === 'beforeunload'));

  client.persistProfile({
    name: 'My_Ranger1',
    observedAtMs: 20,
    equipment: { mainhand: { name: 'bow', level: 7 } }
  });
  const flushed = await client.flushFinal();
  assert.equal(flushed.accepted, true);
  assert.equal(posts.length, 1);
  const payload = JSON.parse(posts[0].options.body);
  assert.equal(payload.profiles[0].equipment.mainhand.level, 7);
  assert.equal(client.status().metrics.finalFlushes, 1);
});

test('H31 account strategy writes a local gear snapshot on start and again on stop', () => {
  const root = context();
  vm.runInNewContext(source('account-strategy.js'), root, { filename: 'account-strategy.js' });
  const Controller = root.__ALBOT_INTERNALS__.AccountStrategyController;
  const rows = [];
  let equipmentLevel = 4;
  const storageRows = new Map();
  const controller = new Controller({
    root,
    hostState: {
      persistProfile: profile => { rows.push(clone(profile)); return true; },
      profile: () => null,
      wealth: () => null
    },
    storage: {
      get: key => storageRows.get(key) || null,
      set: (key, value) => { storageRows.set(key, value); return true; },
      getShared: key => storageRows.get(key) || null,
      setShared: (key, value) => { storageRows.set(key, value); return true; }
    },
    game: {
      snapshot: () => ({
        available: true,
        character: {
          name: 'My_Mage', ctype: 'mage', level: 35,
          hp: 1000, maxHp: 1000, mp: 800, maxMp: 800,
          attack: 200, armor: 100, resistance: 120,
          frequency: 1, speed: 50, range: 120, gold: 1000, map: 'main', rip: false
        }
      }),
      equipmentSnapshot: () => ({
        available: true,
        slots: { mainhand: { name: 'firestaff', level: equipmentLevel } }
      })
    },
    roster: { refresh: () => ({ accountCharacters: [], onlineCharacterNames: [] }) },
    gear: { score: () => 1 }
  });

  controller.start({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].equipment.mainhand.level, 4);

  equipmentLevel = 5;
  controller.stop();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].equipment.mainhand.level, 5);
});

function farmFixture(options = {}) {
  const character = {
    name: 'My_Ranger1', ctype: 'ranger', map: 'main', x: 0, y: 0,
    hp: 900, maxHp: 900, mp: 500, maxMp: 500,
    attack: 100, frequency: 1, speed: 60, range: 120, damageType: 'physical', rip: false
  };
  const definitions = {
    goo: { id: 'goo', hp: 500, attack: 15, frequency: 1, xp: 300, gold: 30, dropSignal: 0.2 },
    ogre: { id: 'ogre', hp: 1800, attack: 80, frequency: 1, xp: 5000, gold: 500, dropSignal: 0.3 },
    snowman: { id: 'snowman', hp: 1000, attack: 10, frequency: 1, xp: 999999, gold: 9999, dropSignal: 1, cooperative: true },
    armored: { id: 'armored', hp: 1200, attack: 20, frequency: 1, xp: 600, gold: 60, dropSignal: 0.2 }
  };
  const safe = [
    { id: 'g1', mtype: 'goo', map: 'main', x: 20, y: 0, distance: 20, attack: 15 },
    { id: 'o1', mtype: 'ogre', map: 'main', x: 30, y: 0, distance: 30, attack: 80 },
    { id: 's1', mtype: 'snowman', map: 'main', x: 40, y: 0, distance: 40, attack: 10 },
    ...(options.includeArmored ? [{ id: 'a1', mtype: 'armored', map: 'main', x: 50, y: 0, distance: 50, attack: 20 }] : [])
  ];
  let capturedSafeOptions = null;
  const combat = {
    safeCandidates: args => {
      capturedSafeOptions = clone(args);
      return safe.map(clone);
    },
    damageProfile: mtype => options.damageProfiles && options.damageProfiles[mtype]
      ? clone(options.damageProfiles[mtype])
      : null
  };
  const members = [
    { name: 'My_Ranger1', ctype: 'ranger', map: 'main', x: 0, y: 0, maxHp: 900, attack: 100, frequency: 1, speed: 60, damageType: 'physical' },
    { name: 'My_Warrior', ctype: 'warrior', map: 'main', x: 10, y: 0, maxHp: 5000, attack: 220, frequency: 1, speed: 45, damageType: 'physical' },
    { name: 'My_Priest', ctype: 'priest', map: 'main', x: -10, y: 0, maxHp: 1400, attack: 180, frequency: 1, speed: 55, damageType: 'magical' }
  ];
  const party = {
    status: () => ({ party: {
      ownedMemberNames: members.map(row => row.name),
      ownedMembers: members.map(clone),
      foreignMemberNames: []
    } })
  };
  const strategy = { profiles: () => members.map(row => ({ ...clone(row), online: true, equipment: {} })) };
  const game = {
    snapshot: () => ({ available: true, character: clone(character) }),
    visiblePlayers: () => [],
    monsterDefinition: type => clone(definitions[type]),
    farmSpotCatalog: () => []
  };
  const farming = {
    status: () => ({ active: false, session: null }),
    startSession: () => ({ accepted: true, session: { id: 'farm' } }),
    stopSession: () => ({ stopped: true })
  };
  const movement = {
    status: () => ({ active: false, activeOrder: null, lastOrder: null }),
    _canMoveTo: () => true,
    smartMove: () => ({ accepted: true }),
    moveLocal: () => ({ accepted: true }),
    cancel: () => ({ cancelled: true })
  };

  const root = context();
  vm.runInNewContext(source('farm-intelligence.js'), root, { filename: 'farm-intelligence.js' });
  const Controller = root.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const controller = new Controller({
    root, game, combat, farming, movement, party, strategy,
    minHoldMs: 5000, switchCooldownMs: 5000
  });
  controller.start({ scope: { interval: () => 'h31-farm-loop' }, heartbeat() {} });
  controller.startAutonomy({
    owner: 'test',
    groupLeaderName: 'My_Ranger1',
    groupMemberNames: ['My_Ranger1', 'My_Warrior', 'My_Priest']
  });
  return { controller, captured: () => capturedSafeOptions };
}

test('H31 farm planner uses three-player DPS, warrior tank safety, and excludes Snowman from FARM', () => {
  const f = farmFixture();
  const plan = f.controller.plan();
  assert.equal(plan.candidates.some(row => row.mtype === 'snowman'), false);

  const ogre = plan.candidates.find(row => row.mtype === 'ogre');
  assert.ok(ogre);
  assert.equal(ogre.groupPerformance.complete, true);
  assert.equal(Math.round(ogre.groupPerformance.aggregateDps), 500);
  assert.equal(ogre.raw.groupSize, 3);
  assert.equal(ogre.raw.dpsModel, 'GROUP_THEORETICAL');
  assert.equal(ogre.groupSafety.tankName, 'My_Warrior');
  assert.equal(ogre.groupSafety.tankMaxHp, 5000);
  assert.equal(ogre.groupSafety.healerPresent, true);
  assert.equal(ogre.groupSafety.safe, true);

  const safeOptions = f.captured();
  assert.equal(safeOptions.maxAttack, 500);
  assert.notEqual(safeOptions.maxAttack, 72);
});

test('H31 farm planner folds observed one-damage behavior into group DPS estimation', () => {
  const f = farmFixture({
    includeArmored: true,
    damageProfiles: {
      armored: { mtype: 'armored', samples: 5, emaDamage: 1, averageDamage: 1, minDamage: 1, maxDamage: 1 }
    }
  });
  const plan = f.controller.plan();
  const armored = plan.candidates.find(row => row.mtype === 'armored');
  assert.ok(armored);
  assert.equal(armored.raw.dpsModel, 'GROUP_WITH_LOCAL_OBSERVED_DAMAGE');
  assert.ok(armored.raw.dps < armored.groupPerformance.aggregateDps);
  assert.equal(armored.raw.observedDamage.emaDamage, 1);
});

function lifecycleController(desiredOnline) {
  const root = context();
  vm.runInNewContext(source('lifecycle-recovery.js'), root, { filename: 'lifecycle-recovery.js' });
  const Controller = root.__ALBOT_INTERNALS__.CharacterLifecycleController;
  const online = new Set(desiredOnline ? ['My_Merchant', 'My_Ranger3'] : ['My_Merchant']);
  const account = [
    { name: 'My_Merchant', ctype: 'merchant' },
    { name: 'My_Warrior', ctype: 'warrior' },
    { name: 'My_Ranger3', ctype: 'ranger' }
  ];
  const controller = new Controller({
    root,
    game: { snapshot: () => ({ available: true, character: { name: 'My_Merchant', ctype: 'merchant', rip: false } }) },
    actions: { available: () => true, dispatch: () => ({ state: 'DISPATCHED', value: Promise.resolve({ success: true }) }) },
    roster: {
      refresh: () => ({
        accountStateAvailable: true,
        onlineStateAvailable: true,
        activeStateAvailable: true,
        accountCharacters: account.map(row => ({ ...row, online: online.has(row.name) })),
        onlineCharacterNames: [...online],
        activeCharacterNames: [...online],
        runnerActiveCharacterNames: [...online]
      })
    },
    party: { snapshot: () => ({ available: false, partyId: null, memberNames: [], members: [], ownedMemberNames: [], ownedMembers: [], foreignMemberNames: [] }) },
    storage: { get: () => null, set: () => true, remove: () => true },
    canAct: () => true
  });
  controller.start({ scope: { interval: () => 'h31-life-loop' } });
  controller.autonomyEnabled = true;
  controller.currentAction = {
    id: 'swap-1',
    kind: 'BROWSER_SWAP',
    targetName: 'My_Warrior',
    desiredName: 'My_Ranger3',
    automatic: true,
    settlement: 'RESOLVED',
    response: { success: false, reason: 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TARGET_ALREADY_ONLINE' },
    before: { targetWasActive: true },
    deadlineAtMs: Date.now() + 10000
  };
  return controller;
}

test('H31 lifecycle reconciles target-already-online browser race only with matching live truth', () => {
  const recovered = lifecycleController(true);
  const result = recovered.tick();
  assert.equal(result.state, 'IDLE');
  assert.equal(result.reason, 'H31_BROWSER_SWAP_TARGET_ALREADY_ONLINE_RECONCILED');
  assert.equal(recovered.status().autonomyEnabled, true);
  assert.equal(recovered.status().currentAction, null);
  assert.equal(recovered.status().metrics.browserSwapTargetAlreadyOnlineRecoveries, 1);

  const rejected = lifecycleController(false);
  const negative = rejected.tick();
  assert.equal(negative.state, 'REJECTED');
  assert.equal(negative.autonomyStopped, true);
  assert.equal(rejected.status().autonomyEnabled, false);
  assert.equal(rejected.status().metrics.browserSwapTargetAlreadyOnlineRecoveries, 0);
});

test('H31 runtime wires SSD state before account strategy and snapshots before rotation/reload', () => {
  const runtime = source('runtime.js');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  assert.match(build, /'src\/host-state\.js'/);
  assert.match(runtime, /id: 'host-state'/);
  assert.match(runtime, /hostState: this\.hostState/);
  assert.match(runtime, /persistLocalProfile\(\)/);
  assert.match(runtime, /flushFinalBestEffort\(\)/);
  assert.match(runtime, /view\.location\.assign\(url\)/);
});
