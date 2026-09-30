import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const progressionSource = fs.readFileSync(path.resolve(here, '../src/gear-progression.js'), 'utf8');
const inventorySource = fs.readFileSync(path.resolve(here, '../src/inventory.js'), 'utf8');
const partyLogisticsSource = fs.readFileSync(path.resolve(here, '../src/party-logistics.js'), 'utf8');
const accountStrategySource = fs.readFileSync(path.resolve(here, '../src/account-strategy.js'), 'utf8');
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

function memoryStorage() {
  const rows = new Map();
  return {
    get: key => rows.get(key) || null,
    set: (key, value) => { rows.set(key, value); return true; },
    getShared: key => rows.get(key) || null,
    setShared: (key, value) => { rows.set(key, value); return true; }
  };
}

function gameData() {
  return {
    classes: {
      warrior: {
        mainhand: { sword: true },
        doublehand: {},
        offhand: { shield: true }
      }
    },
    upgrades: {
      0: { 1: 0.75, 2: 0.95, 3: 1, 4: 1 }
    },
    compounds: {
      0: { 1: 1, 2: 1, 3: 0.4 }
    },
    items: {
      old_sword: { type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 20, g: 5000 },
      ready_sword: { type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 40, g: 1000 },
      future_sword: {
        type: 'weapon', wtype: 'sword', class: ['warrior'],
        attack: 10, upgrade: { attack: 20 }, grades: [8, 9], igrade: 0, g: 1000
      },
      economic_sword: {
        type: 'weapon', wtype: 'sword', class: ['warrior'],
        attack: 1, upgrade: { attack: 0 }, grades: [8, 9], igrade: 0, g: 100
      },
      legendary_sword: {
        type: 'weapon', wtype: 'sword', class: ['warrior'],
        attack: 10, upgrade: { attack: 20 }, grades: [8, 9], igrade: 0, g: 1000, rarity: 'legendary'
      },
      valuable_sword: {
        type: 'weapon', wtype: 'sword', class: ['warrior'],
        attack: 10, upgrade: { attack: 20 }, grades: [8, 9], igrade: 0, g: 100000000
      },
      strong_ring: { type: 'ring', str: 50, g: 10000 },
      weak_ring: { type: 'ring', str: 1, compound: { str: 0 }, grades: [8, 9], igrade: 0, g: 1000 },
      scroll0: { type: 'uscroll', g: 0 },
      cscroll0: { type: 'cscroll', g: 0 }
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

function warrior({ online = true } = {}) {
  return {
    name: 'My_Warrior',
    ctype: 'warrior',
    level: 80,
    online,
    local: online,
    peerFresh: online,
    rip: false,
    gold: 100000000,
    equipment: {
      mainhand: { name: 'old_sword', level: 0 },
      ring1: { name: 'strong_ring', level: 0 },
      ring2: { name: 'strong_ring', level: 0 }
    }
  };
}

function row(slot, name, level = 0, extra = {}) {
  return {
    slot, name, level, quantity: 1, locked: false, giveaway: false, gift: false,
    expiresAt: null, statType: null, property: null, ...extra
  };
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

function evaluator(options = {}) {
  const root = context({ G: options.G || gameData() });
  vm.runInNewContext(progressionSource, root, { filename: 'gear-progression.js' });
  const Evaluator = root.__ALBOT_INTERNALS__.FutureGearEconomyEvaluator;
  const profiles = options.profiles || [warrior()];
  const service = new Evaluator({
    root,
    game: game(root),
    storage: options.storage || memoryStorage(),
    market: options.market || null,
    getProfiles: () => clone(profiles),
    getAccountWealth: options.getAccountWealth || (() => ({ known: true, totalGold: 500000000 })),
    minImprovementRatio: 0.01,
    economicUpgradeMaxLevel: options.economicUpgradeMaxLevel == null ? 4 : options.economicUpgradeMaxLevel,
    economicCompoundMaxLevel: options.economicCompoundMaxLevel == null ? 2 : options.economicCompoundMaxLevel,
    noRiskItemValueGold: options.noRiskItemValueGold == null ? 50000000 : options.noRiskItemValueGold
  });
  return { root, service };
}

test('account strategy persists offline equipment and gold and computes account-wide wealth', () => {
  const storage = memoryStorage();
  const rootA = context();
  vm.runInNewContext(accountStrategySource, rootA, { filename: 'account-strategy.js' });
  const ControllerA = rootA.__ALBOT_INTERNALS__.AccountStrategyController;
  const controllerA = new ControllerA({
    root: rootA,
    storage,
    roster: {
      refresh: () => ({
        accountCharacters: [{ name: 'My_Warrior', ctype: 'warrior', level: 80, online: true }],
        onlineCharacterNames: ['My_Warrior']
      })
    },
    game: {
      snapshot: () => ({ available: true, character: { name: 'My_Warrior', ctype: 'warrior', level: 80, gold: 40000000 } }),
      equipmentSnapshot: () => ({ available: true, slots: { mainhand: { name: 'old_sword', level: 0 } } }),
      bankSnapshot: () => ({ available: true, gold: 70000000 })
    },
    gear: { score: () => 1 }
  });
  controllerA.profiles();

  const rootB = context();
  vm.runInNewContext(accountStrategySource, rootB, { filename: 'account-strategy.js' });
  const ControllerB = rootB.__ALBOT_INTERNALS__.AccountStrategyController;
  const controllerB = new ControllerB({
    root: rootB,
    storage,
    roster: {
      refresh: () => ({
        accountCharacters: [
          { name: 'My_Warrior', ctype: 'warrior', level: 80, online: false },
          { name: 'My_Merchant', ctype: 'merchant', level: 80, online: true }
        ],
        onlineCharacterNames: ['My_Merchant']
      })
    },
    game: {
      snapshot: () => ({ available: true, character: { name: 'My_Merchant', ctype: 'merchant', level: 80, gold: 50000000 } }),
      equipmentSnapshot: () => ({ available: true, slots: {} }),
      bankSnapshot: () => ({ available: true, gold: 70000000 })
    },
    gear: { score: () => 1 }
  });

  const profiles = controllerB.profiles();
  const offline = profiles.find(profile => profile.name === 'My_Warrior');
  assert.equal(offline.online, false);
  assert.equal(offline.cached, true);
  assert.equal(offline.gold, 40000000);
  assert.equal(offline.equipment.mainhand.name, 'old_sword');

  const wealth = controllerB.accountWealth();
  assert.equal(wealth.known, true);
  assert.equal(wealth.characterGold, 90000000);
  assert.equal(wealth.bankGold, 70000000);
  assert.equal(wealth.totalGold, 160000000);
});

test('offline account characters remain gear targets and ready gear is reserved for bank delivery', () => {
  const storage = memoryStorage();
  const { root, service } = evaluator({ profiles: [warrior({ online: false })], storage });
  const item = row(0, 'ready_sword', 0, { definition: clone(root.G.items.ready_sword) });
  const plan = service.evaluateInventory(inventory([item]));
  const result = plan.evaluations[0];

  assert.equal(result.checked, true);
  assert.equal(result.action, 'GEAR');
  assert.equal(result.futureGear.targetCharacter, 'My_Warrior');
  assert.equal(result.futureGear.targetOnline, false);
  assert.equal(service.pendingGearReservations().length, 1);

  vm.runInNewContext(inventorySource, root, { filename: 'inventory.js' });
  const Inventory = root.__ALBOT_INTERNALS__.LootInventoryController;
  const controller = new Inventory({
    root,
    game: {
      inventorySnapshot: () => inventory([item]),
      chestSnapshot: () => ({ available: true, chests: [] })
    },
    gearProgression: service
  });
  const inventoryPlan = controller.plan();
  assert.equal(inventoryPlan.items[0].disposition, 'BANK');
  assert.equal(inventoryPlan.items[0].reason, 'OFFLINE_TARGET_GEAR_BANK');
});

test('under 150M account gold a sub-80-percent gear mutation is held and never converted into a sell', () => {
  const { service } = evaluator({
    profiles: [warrior()],
    getAccountWealth: () => ({ known: true, totalGold: 149999999 })
  });
  const result = service.evaluateInventory(inventory([row(0, 'future_sword')])).evaluations[0];

  assert.equal(result.checked, true);
  assert.equal(result.action, 'HOLD');
  assert.equal(result.protected, true);
  assert.equal(result.sellSafe, false);
  assert.equal(result.mutationPolicy.mode, 'CONSERVATIVE');
  assert.equal(result.mutationPolicy.chance, 0.75);
  assert.equal(result.mutationPolicy.reason, 'CONSERVATIVE_CHANCE_BELOW_80_PERCENT');
});

test('conservative account-risk mode uses 150M/170M hysteresis', () => {
  let gold = 149000000;
  const { root, service } = evaluator({
    getAccountWealth: () => ({ known: true, totalGold: gold })
  });
  const item = row(0, 'future_sword');
  const meta = root.G.items.future_sword;

  let decision = service.mutationRiskPolicy('UPGRADE', item, meta, null, 1, 0.75);
  assert.equal(decision.mode, 'CONSERVATIVE');
  assert.equal(decision.allowed, false);

  gold = 160000000;
  decision = service.mutationRiskPolicy('UPGRADE', item, meta, null, 1, 0.75);
  assert.equal(decision.mode, 'CONSERVATIVE');
  assert.equal(decision.allowed, false);

  gold = 170000000;
  decision = service.mutationRiskPolicy('UPGRADE', item, meta, null, 1, 0.75);
  assert.equal(decision.mode, 'NORMAL');
  assert.equal(decision.allowed, true);
});

test('extremely rare or valuable items reject every nondeterministic mutation even with ample gold', () => {
  const { root, service } = evaluator();
  const rare = service.mutationRiskPolicy(
    'UPGRADE', row(0, 'legendary_sword'), root.G.items.legendary_sword, null, 1, 0.99
  );
  assert.equal(rare.allowed, false);
  assert.equal(rare.reason, 'NO_RISK_ITEM_MUTATION_BLOCKED');
  assert.equal(rare.noRisk.reason, 'EXTREME_RARITY');

  const valuable = service.mutationRiskPolicy(
    'UPGRADE', row(1, 'valuable_sword'), root.G.items.valuable_sword, null, 1, 0.99
  );
  assert.equal(valuable.allowed, false);
  assert.equal(valuable.reason, 'NO_RISK_ITEM_MUTATION_BLOCKED');
  assert.equal(valuable.noRisk.reason, 'EXTREME_VALUE');

  const deterministic = service.mutationRiskPolicy(
    'UPGRADE', row(1, 'valuable_sword'), root.G.items.valuable_sword, null, 1, 1
  );
  assert.equal(deterministic.allowed, true);
});

test('live market liquidation value can beat an otherwise profitable upgrade chain', () => {
  const G = gameData();
  G.upgrades[0] = { 1: 1, 2: 1, 3: 1, 4: 1 };
  const market = {
    marketAnalysis: (name, options = {}) => ({
      available: true,
      bestBid: name === 'economic_sword' && Number(options.level || 0) === 0
        ? { price: 1000000, quantity: 1, playerName: 'Buyer', slot: 'trade1', rid: 'rid-1' }
        : null
    })
  };
  const { service } = evaluator({ G, market, profiles: [warrior()] });
  const result = service.evaluateInventory(inventory([row(0, 'economic_sword')])).evaluations[0];

  assert.equal(result.futureGear, null);
  assert.equal(result.action, 'SELL');
  assert.equal(result.economic.directSale.source, 'MARKET_BID');
  assert.equal(result.economic.directSellGold, 1000000);
});

test('compound economics can optimize through more than one future compound level', () => {
  const rows = Array.from({ length: 9 }, (_, index) => row(index, 'weak_ring'));
  const { service } = evaluator({ profiles: [warrior()], economicCompoundMaxLevel: 2 });
  const result = service.evaluateInventory(inventory(rows)).evaluations[0];

  assert.equal(result.futureGear, null);
  assert.equal(result.action, 'COMPOUND');
  assert.equal(result.economic.multiStep, true);
  assert.ok(result.economic.targetLevel >= 2);
  assert.ok(result.economic.expectedGain > 0);
});

test('reserved gear can only be queued for the exact owned party target', () => {
  const root = context();
  vm.runInNewContext(partyLogisticsSource, root, { filename: 'party-logistics.js' });
  const Controller = root.__ALBOT_INTERNALS__.PartyLogisticsController;
  const gearRow = row(4, 'ready_sword');
  const party = {
    coordinationEnabled: true,
    ownedMembers: [
      { name: 'My_Merchant', local: true },
      { name: 'My_Warrior', local: false, rip: false, visible: true, map: 'main', x: 10, y: 10 }
    ]
  };
  const controller = new Controller({
    root,
    game: {
      inventorySnapshot: () => inventory([gearRow]),
      snapshot: () => ({ available: true, character: { name: 'My_Merchant', ctype: 'merchant', map: 'main', x: 0, y: 0, gold: 1 } })
    },
    party: { snapshot: () => clone(party) },
    gearProgression: {
      deliveryAuthorization: (item, target) => ({
        allowed: item && item.name === 'ready_sword' && target === 'My_Warrior',
        reservation: { fingerprint: 'ready_sword|0||' }
      })
    },
    actions: { available: name => name === 'send_item' }
  });
  controller.start();

  assert.equal(controller.queueGearDelivery('NotMine', 4).reason, 'H18_TARGET_NOT_OWNED_PARTY_MEMBER');
  const accepted = controller.queueGearDelivery('My_Warrior', 4);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.request.kind, 'GEAR');
  assert.equal(accepted.request.targetName, 'My_Warrior');
});

test('upgrade execution boundary honors account-level no-risk policy before producing a candidate', () => {
  const root = context();
  vm.runInNewContext(upgradeSource, root, { filename: 'upgrade.js' });
  const Upgrade = root.__ALBOT_INTERNALS__.UpgradeCompoundController;
  const rows = [
    row(0, 'future_sword'),
    row(1, 'scroll0', 0, { quantity: 5 })
  ];
  const progression = {
    evaluateInventory: () => ({
      state: 'READY',
      evaluations: [{
        slot: 0,
        item: 'future_sword',
        observedLevel: 0,
        checked: true,
        protected: true,
        sellSafe: false,
        action: 'UPGRADE',
        futureGear: {
          currentScore: 20,
          observedMeaningful: false,
          improvement: 20,
          curve: [{ level: 1, stepChance: 0.99 }]
        }
      }]
    }),
    mutationRiskPolicy: () => ({
      allowed: false,
      reason: 'NO_RISK_ITEM_MUTATION_BLOCKED',
      minChance: 1
    })
  };
  const controller = new Upgrade({
    root,
    game: {
      inventorySnapshot: () => inventory(rows),
      equipmentDefinition: name => name === 'future_sword'
        ? { id: name, type: 'weapon', wtype: 'sword', stats: { attack: 10 }, upgradeGrowth: { attack: 20 }, upgradeable: true, compoundable: false, grades: [8, 9], g: 1000, cash: false, quest: false }
        : null,
      itemDefinition: name => name === 'scroll0' ? { id: name, type: 'uscroll', g: 0 } : null
    },
    combat: { status: () => ({ active: false, state: 'IDLE' }) },
    gearProgression: progression
  });

  const plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 0);
  const direct = controller._upgradeCandidate(rows[0], inventory(rows), { progressionPlan: progression.evaluateInventory() });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'NO_RISK_ITEM_MUTATION_BLOCKED');
  assert.equal(direct.risk.accountPolicy.reason, 'NO_RISK_ITEM_MUTATION_BLOCKED');
});

test('runtime wiring exposes account wealth, market economics and gear delivery dependencies', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  assert.match(runtime, /market: this\.trade/);
  assert.match(runtime, /getAccountWealth:/);
  assert.match(runtime, /storage: this\.storage/);
  assert.match(runtime, /gearProgression: this\.gearProgression/);
  assert.match(runtime, /party: this\.party/);
});
