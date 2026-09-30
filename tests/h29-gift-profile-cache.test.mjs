import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = name => fs.readFileSync(path.resolve(here, '../src/' + name), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function context(extra = {}) {
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error, encodeURIComponent,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max) } },
    ...extra
  };
  root.globalThis = root;
  return root;
}

function storage() {
  const rows = new Map();
  return {
    rows,
    get: key => rows.get(key) || null,
    set: (key, value) => { rows.set(key, value); return true; },
    getShared: key => rows.get(key) || null,
    setShared: (key, value) => { rows.set(key, value); return true; }
  };
}

function giftItem(extra = {}) {
  return {
    slot: 2, name: 'helmet', quantity: 1, level: 5,
    locked: false, giveaway: false, gift: true, expiresAt: null,
    statType: null, property: null,
    definition: { id: 'helmet', type: 'helmet', g: 3200, quest: false, cash: false, upgrade: false, compound: false },
    ...extra
  };
}

test('gift items use normal gear/economy authority instead of hard protection', () => {
  const root = context({ G: { items: { helmet: { type: 'helmet', g: 3200 } } } });
  for (const file of ['gear-progression.js','inventory.js','trade.js','upgrade.js','bank.js']) {
    vm.runInNewContext(src(file), root, { filename: file });
  }

  const evaluator = new root.__ALBOT_INTERNALS__.FutureGearEconomyEvaluator({ root, getProfiles: () => [] });
  assert.equal(evaluator._hardProtection(giftItem(), root.G.items.helmet), null);

  const sellAuthority = { checked: true, protected: false, sellSafe: true, action: 'SELL', reason: 'FUTURE_GEAR_EVALUATED_SAFE' };
  const inventory = new root.__ALBOT_INTERNALS__.LootInventoryController({ root, gearProgression: {} });
  const classified = inventory._classify(giftItem(), new Set(), sellAuthority);
  assert.equal(classified.disposition, 'SELL');
  assert.notEqual(classified.reason, 'ITEM_GIFT');

  const sellRow = { ...giftItem(), disposition: 'SELL', protected: false, futureGearEvaluation: clone(sellAuthority) };
  const trade = new root.__ALBOT_INTERNALS__.TradeController({ root, inventory: { plan: () => ({ state: 'READY', items: [sellRow] }) } });
  assert.equal(trade._safeSellRows().length, 1);

  const upgrade = new root.__ALBOT_INTERNALS__.UpgradeCompoundController({ root });
  assert.equal(upgrade._safeItem(giftItem()), true);

  const bankRow = {
    ...giftItem(),
    disposition: 'BANK',
    protected: true,
    futureGearEvaluation: {
      checked: true, protected: true, sellSafe: false, action: 'GEAR',
      futureGear: { targetCharacter: 'OfflineWarrior', targetOnline: false }
    }
  };
  const bank = new root.__ALBOT_INTERNALS__.BankController({ root, inventory: { plan: () => ({ state: 'READY', items: [bankRow] }) } });
  assert.equal(bank._safeDepositRows().length, 1);
});

test('account profile cache still reads the legacy aggregate map', () => {
  const root = context();
  vm.runInNewContext(src('account-strategy.js'), root, { filename: 'account-strategy.js' });
  const Controller = root.__ALBOT_INTERNALS__.AccountStrategyController;
  const shared = storage();
  shared.setShared('albot:h28:account-profile-cache:v1', JSON.stringify({
    My_Ranger3: {
      name: 'My_Ranger3',
      ctype: 'ranger',
      level: 59,
      gold: 1234,
      equipment: { helmet: { name: 'helmet', level: 5 } }
    }
  }));
  const controller = new Controller({
    root,
    storage: shared,
    roster: { refresh: () => ({
      accountCharacters: [{ name: 'My_Ranger3', ctype: 'ranger', level: 59, online: false }],
      onlineCharacterNames: []
    })},
    game: {
      snapshot: () => ({ available: false }),
      equipmentSnapshot: () => ({ available: false }),
      bankSnapshot: () => ({ available: false })
    },
    gear: { score: () => 1 }
  });
  const profile = controller.profiles()[0];
  assert.equal(profile.name, 'My_Ranger3');
  assert.equal(profile.cached, true);
  assert.equal(profile.equipment.helmet.name, 'helmet');
});

test('account profile cache writes independent durable keys per character', () => {
  const root = context();
  vm.runInNewContext(src('account-strategy.js'), root, { filename: 'account-strategy.js' });
  const Controller = root.__ALBOT_INTERNALS__.AccountStrategyController;
  const shared = storage();
  const names = ['My_Mage','My_Priest','My_Merchant'];

  const make = localName => new Controller({
    root, storage: shared,
    roster: { refresh: () => ({
      accountCharacters: names.map(name => ({ name, ctype: name === 'My_Mage' ? 'mage' : name === 'My_Priest' ? 'priest' : 'merchant', level: 50, online: name === localName })),
      onlineCharacterNames: [localName]
    })},
    game: {
      snapshot: () => ({ available: true, character: { name: localName, ctype: localName === 'My_Mage' ? 'mage' : localName === 'My_Priest' ? 'priest' : 'merchant', level: 50, gold: 1000 } }),
      equipmentSnapshot: () => ({ available: true, slots: { helmet: { name: 'helmet', level: 5 } } }),
      bankSnapshot: () => ({ available: true, gold: 0 })
    },
    gear: { score: () => 1 }
  });

  make('My_Mage').profiles();
  make('My_Priest').profiles();

  assert.ok(shared.rows.has('albot:h28:account-profile-cache:v1:My_Mage'));
  assert.ok(shared.rows.has('albot:h28:account-profile-cache:v1:My_Priest'));

  const profiles = make('My_Merchant').profiles();
  for (const name of ['My_Mage','My_Priest']) {
    const row = profiles.find(profile => profile.name === name);
    assert.equal(!!row.equipment, true);
    assert.equal(row.cached, true);
  }
});
