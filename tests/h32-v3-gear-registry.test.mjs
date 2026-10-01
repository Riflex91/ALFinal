import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/account-strategy.js'), 'utf8');
const gearProgressionSource = fs.readFileSync(path.resolve(here, '../src/gear-progression.js'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function controllerFixture(shared, options = {}) {
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  root.globalThis = root;
  vm.runInNewContext(source, root, { filename: 'account-strategy.js' });

  const storage = {
    get: key => shared.has(key) ? shared.get(key) : null,
    set: (key, value) => { shared.set(key, String(value)); return true; },
    getShared: key => shared.has(key) ? shared.get(key) : null,
    setShared: (key, value) => { shared.set(key, String(value)); return true; }
  };

  const account = [
    { name: 'My_Mage', ctype: 'mage', level: 80, online: false },
    { name: 'My_Merchant', ctype: 'merchant', level: 58, online: true },
    { name: 'My_Priest', ctype: 'priest', level: 75, online: false },
    { name: 'My_Ranger1', ctype: 'ranger', level: 70, online: false },
    { name: 'My_Ranger2', ctype: 'ranger', level: 70, online: false },
    { name: 'My_Ranger3', ctype: 'ranger', level: 70, online: false },
    { name: 'My_Rogue', ctype: 'rogue', level: 29, online: options.rogueOnline === true },
    { name: 'My_Warrior', ctype: 'warrior', level: 72, online: false }
  ];
  const roster = {
    refresh: () => ({
      accountCharacters: clone(account),
      onlineCharacterNames: account.filter(row => row.online).map(row => row.name)
    })
  };
  const game = {
    snapshot: () => ({
      available: true,
      character: {
        name: 'My_Merchant', ctype: 'merchant', level: 58,
        hp: 1000, maxHp: 1000, mp: 500, maxMp: 500,
        attack: 100, armor: 100, resistance: 100, frequency: 1,
        speed: 50, range: 40, rip: false, map: 'main', gold: 12345
      }
    }),
    equipmentSnapshot: name => ({
      available: true,
      character: { name, ctype: 'merchant' },
      slots: name === 'My_Merchant'
        ? { mainhand: { name: 'computer', level: 0 } }
        : {}
    }),
    bankSnapshot: () => ({ available: false })
  };

  const stalePeer = {
    name: 'My_Rogue',
    sessionId: 'rogue-old-session',
    running: false,
    observedAtMs: 1000,
    profile: {
      schemaVersion: 1,
      name: 'My_Rogue',
      ctype: 'rogue',
      level: 29,
      hp: 1200,
      maxHp: 1200,
      mp: 700,
      maxMp: 700,
      attack: 180,
      armor: 90,
      resistance: 70,
      frequency: 1.4,
      speed: 65,
      range: 35,
      rip: false,
      map: 'main',
      gold: 777,
      gearScore: 321,
      equipment: {
        mainhand: { name: 'dagger', level: 4, statType: 'dex', property: null },
        helmet: { name: 'helmet', level: 5, statType: 'dex', property: null }
      },
      trainingMs: 0,
      observedAtMs: 1000
    }
  };

  const emptyMagePeer = {
    name: 'My_Mage',
    sessionId: 'mage-old-session',
    running: false,
    observedAtMs: 1500,
    profile: {
      schemaVersion: 1,
      name: 'My_Mage',
      ctype: 'mage',
      level: 80,
      gold: 555,
      equipment: {},
      observedAtMs: 1500
    }
  };

  const crossWindow = options.withCrossWindow === false ? null : {
    status: () => ({
      peers: [clone(stalePeer), clone(emptyMagePeer)],
      freshPeers: []
    }),
    freshPeers: () => []
  };

  const hostState = {
    profile: name => name === 'My_Rogue'
      ? {
          schemaVersion: 1,
          name: 'My_Rogue',
          ctype: 'rogue',
          level: 29,
          gold: 999,
          equipment: null,
          observedAtMs: 999999
        }
      : null,
    persistProfile: () => true,
    wealth: () => null,
    persistWealth: () => true
  };

  const Controller = root.__ALBOT_INTERNALS__.AccountStrategyController;
  const controller = new Controller({
    root, game, roster, storage, crossWindow, hostState,
    gear: { score: () => 1 },
    now: () => 2000
  });
  return { controller, shared };
}

test('H32 V3-style gear registry retains an offline peer gear snapshot inside the bot', () => {
  const shared = new Map();
  const { controller } = controllerFixture(shared, { withCrossWindow: true, rogueOnline: false });
  const profiles = controller.profiles();
  const rogue = profiles.find(row => row.name === 'My_Rogue');

  assert.ok(rogue);
  assert.equal(rogue.online, false);
  assert.equal(rogue.equipment.mainhand.name, 'dagger');
  assert.equal(rogue.equipment.mainhand.level, 4);
  assert.equal(rogue.equipment.helmet.level, 5);

  const registry = controller.status().gearRegistry;
  const row = registry.rows.find(entry => entry.name === 'My_Rogue');
  assert.ok(row);
  assert.equal(row.equipmentKnown, true);
  assert.equal(row.equipmentSlots, 2);
  assert.equal(row.source, 'CROSS_WINDOW_LAST_KNOWN');
});

test('H32 account registry contains all eight characters and empty equipment is never known', () => {
  const shared = new Map();
  const { controller } = controllerFixture(shared, { withCrossWindow: true, rogueOnline: false });
  const profiles = controller.profiles();
  const expected = ['My_Mage', 'My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Ranger2', 'My_Ranger3', 'My_Rogue', 'My_Warrior'];

  assert.deepEqual(Array.from(profiles.map(row => row.name)), expected);
  const mage = profiles.find(row => row.name === 'My_Mage');
  assert.ok(mage);
  assert.equal(mage.equipment, null);
  assert.equal(mage.equipmentKnown, false);

  const registry = controller.status().gearRegistry;
  assert.equal(registry.count, 8);
  const mageRegistry = registry.rows.find(row => row.name === 'My_Mage');
  assert.ok(mageRegistry);
  assert.equal(mageRegistry.equipmentKnown, false);
  assert.equal(mageRegistry.equipmentSlots, 0);

  for (const name of expected) assert.ok(registry.rows.some(row => row.name === name), 'missing registry row ' + name);
});

test('H32 future gear evaluation rejects empty equipment even when the object is truthy', () => {
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  root.globalThis = root;
  vm.runInNewContext(gearProgressionSource, root, { filename: 'gear-progression.js' });
  const Evaluator = root.__ALBOT_INTERNALS__.FutureGearEconomyEvaluator;
  const evaluator = new Evaluator({ root });

  assert.equal(evaluator._profileEquipment({ equipment: {}, equipmentKnown: true }), null);
  assert.equal(evaluator._profileEquipment({ equipment: {}, equipmentKnown: false }), null);
  const equipment = { mainhand: { name: 'wand', level: 3 } };
  assert.deepEqual(clone(evaluator._profileEquipment({ equipment, equipmentKnown: true })), equipment);
});

test('H32 bot shared gear cache survives a Merchant controller restart without SSD authority', () => {
  const shared = new Map();

  const first = controllerFixture(shared, { withCrossWindow: true });
  const firstRogue = first.controller.profiles().find(row => row.name === 'My_Rogue');
  assert.equal(firstRogue.equipment.mainhand.name, 'dagger');

  const second = controllerFixture(shared, { withCrossWindow: false });
  const secondRogue = second.controller.profiles().find(row => row.name === 'My_Rogue');
  assert.ok(secondRogue);
  assert.equal(secondRogue.equipment.mainhand.name, 'dagger');
  assert.equal(secondRogue.equipment.helmet.level, 5);

  const row = second.controller.status().gearRegistry.rows.find(entry => entry.name === 'My_Rogue');
  assert.ok(row);
  assert.equal(row.source, 'BOT_SHARED_CACHE');
  assert.equal(row.equipmentKnown, true);
});

// Candidate handoff guard: this test intentionally proves external host state
// cannot replace the bot-native cross-character registry.
test('H32 incomplete host fallback cannot overwrite a bot-native gear snapshot', () => {
  const shared = new Map();
  const first = controllerFixture(shared, { withCrossWindow: true });
  first.controller.profiles();

  const second = controllerFixture(shared, { withCrossWindow: false });
  const rogue = second.controller.profiles().find(row => row.name === 'My_Rogue');

  assert.equal(rogue.equipment.mainhand.name, 'dagger');
  assert.equal(rogue.gold, 777);
  assert.notEqual(rogue.observedAtMs, 999999);
});
