import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (root, file) => vm.runInNewContext(
  fs.readFileSync(path.resolve(here, '../src/' + file), 'utf8'), root);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function fixture(extra = {}) {
  const root = {
    Date, Math, JSON, Map, Set, Promise, Number, String, Object, Array, Boolean,
    __ALBOT_INTERNALS__: { helpers: {
      clone, cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
    } }, ...extra
  };
  root.globalThis = root;
  return root;
}

test('stand0 remains protected even with an explicit bank rule', () => {
  const root = fixture();
  load(root, 'inventory.js');
  const inventory = new root.__ALBOT_INTERNALS__.LootInventoryController({ root });
  inventory.setRules({ bankNames: ['stand0'] });
  const classification = inventory._classify(
    { name: 'stand0', level: 0, definition: { type: 'stand' } }, new Set());
  assert.equal(classification.disposition, 'KEEP');
  assert.equal(classification.reason, 'MERCHANT_STAND_OPERATIONAL_TOOL');
  assert.equal(classification.protected, true);
});

test('H12 deposit safety independently excludes stand0 and blocks an explicit request', () => {
  const root = fixture();
  load(root, 'bank.js');
  const bank = new root.__ALBOT_INTERNALS__.BankController({
    root,
    inventory: { plan: () => ({
      state: 'READY', items: [
        { slot: 3, name: 'stand0', disposition: 'BANK', quantity: 1, level: 0 },
        { slot: 4, name: 'seashell', disposition: 'BANK', quantity: 1, level: 0 }
      ]
    }) },
    game: { snapshot: () => ({
      available: true, character: { name: 'My_Merchant', ctype: 'merchant', rip: false }
    }) }
  });
  assert.deepEqual(bank._safeDepositRows().map(row => row.name), ['seashell']);
  assert.equal(bank.queueDeposit('stand0', { inventorySlot: 3 }).accepted, false);
});

test('bank travel waits for live close_stand confirmation instead of moving an open stand', () => {
  const character = { name: 'My_Merchant', ctype: 'merchant', stand: true, p: { stand: true } };
  const root = fixture({ character });
  load(root, 'bank.js');
  const actions = [];
  const moves = [];
  const bank = new root.__ALBOT_INTERNALS__.BankController({
    root,
    game: {
      _character: () => character,
      snapshot: () => ({ available: true, character: { ctype: 'merchant', rip: false } }),
      bankSnapshot: () => ({ available: false })
    },
    actions: { dispatch: name => {
      actions.push(name);
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    } },
    movement: {
      status: () => ({ activeOrder: null }),
      smartMove: destination => { moves.push(destination); return { accepted: true }; }
    }
  });
  bank.moduleActive = true;
  assert.equal(bank.queueMount().accepted, true);
  bank.tick();
  assert.deepEqual(actions, ['close_stand']);
  assert.equal(moves.length, 0, 'must not move while stand is open');
  bank.tick();
  assert.equal(actions.length, 1, 'must not blindly retry close_stand');
  character.stand = false;
  character.p.stand = false;
  bank.tick();
  assert.deepEqual(moves, ['bank']);
});

test('visible but unsafe event does not preempt normal FARM', () => {
  const root = fixture({
    character: { name: 'My_Warrior', ctype: 'warrior' },
    G: { monsters: { mrpumpkin: { name: 'Mr Pumpkin', attack: 1200 } } },
    S: { mrpumpkin: { active: true, live: true, map: 'halloween', x: 12, y: 45 } }
  });
  load(root, 'encounters.js');
  const controller = new root.__ALBOT_INTERNALS__.EncounterController({
    root,
    game: {
      snapshot: () => ({ character: { name: 'My_Warrior', ctype: 'warrior' } }),
      monsterDefinition: name => name === 'mrpumpkin' ? { attack: 1200 } : null,
      visibleMonsters: ({ type } = {}) => type === 'mrpumpkin'
        ? [{ id: 'm1', mtype: 'mrpumpkin', distance: 300, attack: 1200 }]
        : []
    },
    combat: { safeCandidates: () => [] }
  });
  assert.equal(controller._eventActionability({
    id: 'mrpumpkin', kind: 'event', active: true, enabled: true,
    map: 'halloween', x: 12, y: 45
  }).reason, 'ENCOUNTER_VISIBLE_NO_SAFE_TARGET');
  assert.equal(controller.preferredTask(), null);
  assert.equal(controller.plan({ taskType: 'EVENT' }).state, 'WAITING');
});

test('safe visible event remains actionable', () => {
  const root = fixture();
  load(root, 'encounters.js');
  const controller = new root.__ALBOT_INTERNALS__.EncounterController({
    root,
    game: {
      snapshot: () => ({ character: { name: 'My_Warrior', ctype: 'warrior' } }),
      monsterDefinition: () => ({ cooperative: true }),
      visibleMonsters: () => [{ id: 'safe', mtype: 'mrpumpkin', distance: 100 }]
    },
    combat: { safeCandidates: () => [{ id: 'safe' }] }
  });
  assert.equal(controller._eventActionability({
    id: 'mrpumpkin', kind: 'event', active: true, enabled: true,
    map: 'halloween', x: 12, y: 45
  }).actionable, true);
});

test('unverified stand closure fails closed without travel or retry', () => {
  const character = { name: 'My_Merchant', ctype: 'merchant', stand: true, p: { stand: true } };
  const root = fixture({ character });
  load(root, 'bank.js');
  const actions = [];
  const moves = [];
  const bank = new root.__ALBOT_INTERNALS__.BankController({
    root,
    game: {
      _character: () => character,
      snapshot: () => ({ available: true, character: { ctype: 'merchant', rip: false } }),
      bankSnapshot: () => ({ available: false })
    },
    actions: { dispatch: name => {
      actions.push(name);
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    } },
    movement: {
      status: () => ({ activeOrder: null }),
      smartMove: destination => { moves.push(destination); return { accepted: true }; }
    }
  });
  bank.moduleActive = true;
  assert.equal(bank.queueMount().accepted, true);
  bank.tick();
  assert.equal(bank.standClosePending != null, true);
  bank.standClosePending.deadlineAtMs = Date.now() - 1;
  const result = bank.tick();
  assert.equal(result.state, 'SUSPENDED');
  assert.equal(bank.suspendedReason, 'H12_STAND_CLOSE_UNVERIFIED_TIMEOUT');
  assert.equal(actions.length, 1);
  assert.equal(moves.length, 0);
});
