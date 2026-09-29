import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const progressionSource = fs.readFileSync(path.resolve(here, '../src/gear-progression.js'), 'utf8');
const inventorySource = fs.readFileSync(path.resolve(here, '../src/inventory.js'), 'utf8');
const tradeSource = fs.readFileSync(path.resolve(here, '../src/trade.js'), 'utf8');
const upgradeSource = fs.readFileSync(path.resolve(here, '../src/upgrade.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function context(extra = {}) {
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    setTimeout, clearTimeout,
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

function baseGameData() {
  return {
    classes: {
      warrior: {
        mainhand: { sword: true },
        doublehand: {},
        offhand: { shield: true }
      }
    },
    upgrades: {
      0: { 1: 0.99, 2: 0.95, 3: 0.90, 4: 0.70, 5: 0.60, 6: 0.40, 7: 0.25 }
    },
    compounds: {
      0: { 1: 0.99, 2: 0.75, 3: 0.40, 4: 0.25 }
    },
    items: {
      old_sword: { type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 20, g: 5000 },
      future_sword: { type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 10, upgrade: { attack: 6 }, grades: [8, 9], igrade: 0, g: 1000 },
      junk_sword: { type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 1, upgrade: { attack: 0 }, grades: [8, 9], igrade: 0, g: 100 },
      strong_ring: { type: 'ring', str: 50, g: 10000 },
      weak_ring: { type: 'ring', str: 1, compound: { str: 0 }, grades: [8, 9], igrade: 0, g: 1000 },
      scroll0: { type: 'uscroll', g: 1_000_000_000 },
      cscroll0: { type: 'cscroll', g: 1 },
      event_sword: { type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 100, upgrade: { attack: 1 }, event: true, g: 1000 }
    }
  };
}

function game(root) {
  return {
    classEquipmentProfile: ctype => {
      const row = root.G.classes[String(ctype || '').toLowerCase()];
      if (!row) return null;
      return {
        mainhand: Object.keys(row.mainhand || {}),
        doublehand: Object.keys(row.doublehand || {}),
        offhand: Object.keys(row.offhand || {})
      };
    }
  };
}

function localWarrior(overrides = {}) {
  return {
    name: 'Warrior',
    ctype: 'warrior',
    level: 80,
    online: true,
    local: true,
    peerFresh: true,
    rip: false,
    equipment: {
      mainhand: { name: 'old_sword', level: 0 },
      ring1: { name: 'strong_ring', level: 0 },
      ring2: { name: 'strong_ring', level: 0 }
    },
    ...overrides
  };
}

function evaluatorFixture(profiles = [localWarrior()]) {
  const root = context({ G: baseGameData() });
  vm.runInNewContext(progressionSource, root, { filename: 'gear-progression.js' });
  const Evaluator = root.__ALBOT_INTERNALS__.FutureGearEconomyEvaluator;
  const evaluator = new Evaluator({
    root,
    game: game(root),
    getProfiles: () => clone(profiles),
    minImprovementRatio: 0.01,
    economicUpgradeMaxLevel: 1
  });
  return { root, evaluator };
}

function inventory(rows) {
  return {
    schemaVersion: 1,
    available: true,
    capacity: 42,
    usedSlots: rows.length,
    freeSlots: 42 - rows.length,
    items: clone(rows)
  };
}

function item(slot, name, level = 0, extra = {}) {
  return {
    slot, name, level, quantity: 1, locked: false, giveaway: false, gift: false,
    expiresAt: null, statType: null, property: null, ...extra
  };
}

test('V3 future gear protects an item that is weak now but becomes a real gear upgrade later', () => {
  const { evaluator } = evaluatorFixture();
  const plan = evaluator.evaluateInventory(inventory([item(0, 'future_sword')]));
  const result = plan.evaluations[0];
  assert.equal(result.checked, true);
  assert.equal(result.protected, true);
  assert.equal(result.sellSafe, false);
  assert.equal(result.action, 'UPGRADE');
  assert.equal(result.futureGear.targetCharacter, 'Warrior');
  assert.equal(result.futureGear.targetSlot, 'mainhand');
  assert.ok(result.futureGear.targetLevel >= 2);
  assert.ok(result.futureGear.firstMeaningfulLevel >= 2);
  assert.ok(result.futureGear.curve.some(row => row.level >= 2 && row.meaningful === true));
  assert.ok(result.futureGear.cumulativeSuccessChance > 0);
});

test('V3 expected-value fallback sells upgradeable gear only after future gear value is disproved', () => {
  const { evaluator } = evaluatorFixture();
  const plan = evaluator.evaluateInventory(inventory([item(4, 'junk_sword')]));
  const result = plan.evaluations[0];
  assert.equal(result.checked, true);
  assert.equal(result.futureGear, null);
  assert.equal(result.action, 'SELL');
  assert.equal(result.sellSafe, true);
  assert.equal(result.protected, false);
  assert.equal(result.economic.family, 'UPGRADE');
  assert.equal(result.economic.action, 'SELL');
});

test('V3 compound policy accumulates until three identical items exist, then authorizes compound', () => {
  const { evaluator } = evaluatorFixture();
  let plan = evaluator.evaluateInventory(inventory([
    item(1, 'weak_ring'),
    item(2, 'weak_ring')
  ]));
  assert.equal(plan.evaluations[0].checked, true);
  assert.equal(plan.evaluations[0].futureGear, null);
  assert.equal(plan.evaluations[0].action, 'ACCUMULATE');
  assert.equal(plan.evaluations[0].sameCount, 2);

  plan = evaluator.evaluateInventory(inventory([
    item(1, 'weak_ring'),
    item(2, 'weak_ring'),
    item(3, 'weak_ring')
  ]));
  assert.equal(plan.evaluations[0].action, 'COMPOUND');
  assert.equal(plan.evaluations[0].sameCount, 3);
  assert.ok(plan.evaluations[0].economic.expectedGain > 0);
});

test('future gear disposal remains fail-closed when a live party profile lacks equipment evidence', () => {
  const profiles = [
    localWarrior(),
    { name: 'RemoteRanger', ctype: 'ranger', level: 80, online: true, peerFresh: true, rip: false, equipment: null }
  ];
  const { evaluator } = evaluatorFixture(profiles);
  const result = evaluator.evaluateInventory(inventory([item(0, 'junk_sword')])).evaluations[0];
  assert.equal(result.checked, false);
  assert.equal(result.protected, true);
  assert.equal(result.sellSafe, false);
  assert.equal(result.action, 'KEEP');
  assert.equal(result.reason, 'PROFILE_EQUIPMENT_UNKNOWN');
});

test('event and special items stay hard protected before any economic processing', () => {
  const { evaluator } = evaluatorFixture();
  const result = evaluator.evaluateInventory(inventory([item(0, 'event_sword')])).evaluations[0];
  assert.equal(result.protected, true);
  assert.equal(result.sellSafe, false);
  assert.equal(result.action, 'KEEP');
  assert.equal(result.reason, 'SPECIAL_ITEM_PROTECTED');
});

test('inventory and trade allow processed gear sale only with completed future-gear sell authority', () => {
  const root = context();
  vm.runInNewContext(inventorySource, root, { filename: 'inventory.js' });
  vm.runInNewContext(tradeSource, root, { filename: 'trade.js' });
  const Inventory = root.__ALBOT_INTERNALS__.LootInventoryController;
  const Trade = root.__ALBOT_INTERNALS__.TradeController;

  const rows = [item(5, 'junk_sword', 2, {
    definition: { type: 'weapon', upgrade: true, compound: false, quest: false }
  })];
  const gameStub = {
    inventorySnapshot: () => inventory(rows),
    chestSnapshot: () => ({ available: true, chests: [] })
  };
  let authority = {
    state: 'READY',
    evaluations: [{
      slot: 5, item: 'junk_sword', observedLevel: 2, checked: true,
      protected: false, sellSafe: true, action: 'SELL', reason: 'FUTURE_GEAR_EVALUATED_SAFE'
    }]
  };
  const progression = { evaluateInventory: () => clone(authority) };
  const inventoryController = new Inventory({ root, game: gameStub, gearProgression: progression });
  const tradeController = new Trade({ root, game: gameStub, inventory: inventoryController, gearProgression: progression });

  let planned = inventoryController.plan();
  assert.equal(planned.items[0].disposition, 'SELL');
  assert.equal(tradeController._safeSellRows().length, 1);

  authority = {
    state: 'READY',
    evaluations: [{
      slot: 5, item: 'junk_sword', observedLevel: 2, checked: false,
      protected: true, sellSafe: false, action: 'KEEP', reason: 'FUTURE_GEAR_EVALUATION_REQUIRED'
    }]
  };
  planned = inventoryController.plan();
  assert.equal(planned.items[0].disposition, 'PROTECT');
  assert.equal(tradeController._safeSellRows().length, 0);
});

test('upgrade executor accepts only the mutation action authorized by future gear intelligence', () => {
  const root = context();
  vm.runInNewContext(upgradeSource, root, { filename: 'upgrade.js' });
  const Upgrade = root.__ALBOT_INTERNALS__.UpgradeCompoundController;
  const rows = [
    item(0, 'future_sword'),
    item(1, 'scroll0', 0, { quantity: 5 })
  ];
  const gameStub = {
    snapshot: () => ({ available: true, character: { name: 'Merchant', ctype: 'merchant', rip: false } }),
    inventorySnapshot: () => inventory(rows),
    equipmentDefinition: name => name === 'future_sword'
      ? { id: name, type: 'weapon', wtype: 'sword', stats: { attack: 10 }, upgradeGrowth: { attack: 6 }, upgradeable: true, compoundable: false, grades: [8, 9], g: 1000, cash: false, quest: false }
      : null,
    itemDefinition: name => name === 'scroll0' ? { id: name, type: 'uscroll', g: 1 } : null
  };
  let action = 'SELL';
  const progression = {
    evaluateInventory: () => ({
      state: 'READY',
      evaluations: [{
        slot: 0, item: 'future_sword', observedLevel: 0, checked: true,
        protected: action !== 'SELL', sellSafe: action === 'SELL', action
      }]
    })
  };
  const controller = new Upgrade({
    root, game: gameStub, combat: { status: () => ({ active: false, state: 'IDLE' }) },
    actions: { dispatch: () => ({ state: 'DISPATCHED', value: Promise.resolve({ success: true }) }) },
    gearProgression: progression
  });

  let plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 0);
  assert.equal(controller.queueUpgrade(0).reason, 'H15_MUTATION_NOT_RECOMMENDED');

  action = 'UPGRADE';
  plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 1);
  assert.equal(plan.upgradeCandidates[0].progression.action, 'UPGRADE');
  assert.equal(controller.queueUpgrade(0).accepted, true);
});

test('runtime bundle wiring includes V3 future gear service and the Anniversary actionability fix', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const encounters = fs.readFileSync(path.resolve(here, '../src/encounters.js'), 'utf8');
  assert.match(runtime, /new ns\.FutureGearEconomyEvaluator/);
  assert.match(runtime, /gearProgression: this\.gearProgression/);
  assert.match(entry, /gearProgression:/);
  assert.match(build, /src\/gear-progression\.js/);
  assert.match(encounters, /_eventActionability/);
  assert.match(encounters, /ANNIVERSARY_NO_LIVE_VISIT/);
  assert.match(encounters, /ANNIVERSARY_VISIT_READY/);
});
