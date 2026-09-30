import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterSource = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
const inventorySource = fs.readFileSync(path.resolve(here, '../src/inventory.js'), 'utf8');

function internals() {
  return {
    helpers: {
      clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
      cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
    }
  };
}

function adapterFixture() {
  const character = {
    name: 'Farmer',
    ctype: 'ranger',
    map: 'main',
    hp: 1000,
    max_hp: 1000,
    mp: 500,
    max_mp: 500,
    items: [
      { name: 'sword', level: 3, l: 'l' },
      { name: 'seashell', q: 12 },
      { name: 'hpot1', q: 40 },
      null,
      null,
      null
    ],
    esize: 3
  };
  const chests = {
    chestA: { items: 1 },
    chestB: { items: 4 }
  };
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    character,
    chests,
    get_chests: () => chests,
    G: {
      items: {
        sword: { name: 'Sword', type: 'weapon', upgrade: true, g: 1000 },
        seashell: { name: 'Seashell', type: 'quest', g: 10 },
        hpot1: { name: 'HP Potion', type: 'pot', g: 20 }
      },
      monsters: {}, maps: { main: {} }, skills: {}
    },
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(adapterSource, ctx, { filename: 'game-adapter.js' });
  const Adapter = ctx.__ALBOT_INTERNALS__.AdventureLandGameAdapter;
  return { adapter: new Adapter({ root: ctx }), character, chests };
}

function controllerFixture(options = {}) {
  const inventory = options.inventory || {
    available: true,
    capacity: 8,
    usedSlots: 3,
    freeSlots: 5,
    reportedEmptySlots: 5,
    items: [
      { slot: 0, name: 'sword', quantity: 1, level: 3, locked: false, definition: { type: 'weapon', upgrade: true } },
      { slot: 1, name: 'seashell', quantity: 12, level: 0, locked: false, definition: { type: 'quest' } },
      { slot: 2, name: 'junk', quantity: 1, level: 0, locked: false, definition: { type: 'misc' } }
    ]
  };
  let chests = options.chests || { available: true, chests: [{ id: 'c1', items: 1 }] };
  const game = {
    inventorySnapshot: () => JSON.parse(JSON.stringify(inventory)),
    chestSnapshot: () => JSON.parse(JSON.stringify(chests))
  };
  const dispatches = [];
  const actions = {
    dispatch: (name, args) => {
      dispatches.push({ name, args: [...args] });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: options.syncUnknownError || { message: 'NETWORK_UNCERTAIN' } };
      if (options.rejectPromise) {
        const rejection = options.rejectValue === undefined ? new Error('NETWORK_UNCERTAIN') : options.rejectValue;
        return { state: 'DISPATCHED', value: Promise.reject(rejection) };
      }
      if (options.neverResolvePromise) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      return { state: 'DISPATCHED', value: Promise.resolve(options.lootResponse || { success: true }) };
    }
  };
  const goals = {
    list: () => options.goals || []
  };
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(inventorySource, ctx, { filename: 'inventory.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.LootInventoryController;
  const controller = new Controller({
    game, actions, goals,
    reserveFreeSlots: options.reserveFreeSlots == null ? 2 : options.reserveFreeSlots
  });
  controller.start({ scope: { interval: () => 'h10-resource' } });
  return {
    controller,
    dispatches,
    setChests: rows => { chests = { available: true, chests: rows.map(row => ({ ...row })) }; }
  };
}

test('H10 adapter exposes normalized inventory and live chest capacity', () => {
  const { adapter } = adapterFixture();
  const inventory = adapter.inventorySnapshot();
  assert.equal(inventory.available, true);
  assert.equal(inventory.capacity, 6);
  assert.equal(inventory.usedSlots, 3);
  assert.equal(inventory.freeSlots, 3);
  assert.equal(inventory.reportedEmptySlots, 3);
  assert.equal(inventory.items[0].name, 'sword');
  assert.equal(inventory.items[0].locked, true);
  assert.equal(inventory.items[0].definition.type, 'weapon');
  assert.equal(inventory.items[1].definition.quest, true);

  const chests = adapter.chestSnapshot();
  assert.equal(chests.count, 2);
  assert.deepEqual(Array.from(chests.chests, row => [row.id, row.items]), [['chestA', 1], ['chestB', 4]]);
});

test('H10 protects locked, leveled, gear and quest items with safe BANK fallback', () => {
  const f = controllerFixture();
  const plan = f.controller.plan();

  const sword = plan.items.find(row => row.name === 'sword');
  const shell = plan.items.find(row => row.name === 'seashell');
  const junk = plan.items.find(row => row.name === 'junk');

  assert.equal(sword.disposition, 'PROTECT');
  assert.equal(sword.protected, true);
  assert.equal(shell.disposition, 'RESERVE');
  assert.equal(shell.protected, true);
  assert.equal(junk.disposition, 'BANK');
  assert.equal(junk.protected, true);
});

test('H10 honors the normalized quest flag even when item type is not quest', () => {
  const f = controllerFixture({
    inventory: {
      available: true,
      capacity: 8,
      usedSlots: 1,
      freeSlots: 7,
      reportedEmptySlots: 7,
      items: [
        { slot: 0, name: 'quest_material', quantity: 1, level: 0, locked: false, definition: { type: 'material', quest: true } }
      ]
    },
    chests: { available: true, chests: [] }
  });
  const item = f.controller.plan().items[0];
  assert.equal(item.disposition, 'RESERVE');
  assert.equal(item.reason, 'QUEST_ITEM');
  assert.equal(item.protected, true);
});

test('H10 collection goals reserve matching items without hardcoded names', () => {
  const f = controllerFixture({
    goals: [{ type: 'COLLECT_ITEM', target: 'junk', status: 'ACTIVE' }]
  });
  const plan = f.controller.plan();
  const item = plan.items.find(row => row.name === 'junk');
  assert.equal(item.disposition, 'RESERVE');
  assert.equal(item.reason, 'ACTIVE_COLLECTION_GOAL');
});

test('H10 explicit disposition rules are opt-in and unknown items never default to SELL', () => {
  const f = controllerFixture();
  assert.equal(f.controller.plan().items.find(row => row.name === 'junk').disposition, 'BANK');

  f.controller.setRules({ sellNames: ['junk'] });
  const item = f.controller.plan().items.find(row => row.name === 'junk');
  assert.equal(item.disposition, 'SELL');
  assert.equal(item.protected, false);
});

test('H10 loots only a chest that fits while preserving free-slot reserve', async () => {
  const f = controllerFixture({
    inventory: {
      available: true,
      capacity: 8,
      usedSlots: 3,
      freeSlots: 5,
      reportedEmptySlots: 5,
      items: []
    },
    chests: { available: true, chests: [{ id: 'large', items: 4 }, { id: 'small', items: 2 }] },
    reserveFreeSlots: 2
  });

  const tick = f.controller.tick();
  assert.equal(tick.state, 'LOOT_PENDING');
  assert.equal(tick.chestId, 'small');
  assert.deepEqual(f.dispatches, [{ name: 'loot', args: ['small'] }]);

  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.lootConfirmed, 1);
});

test('H10 blocks loot when free-slot reserve is reached', () => {
  const f = controllerFixture({
    inventory: {
      available: true,
      capacity: 8,
      usedSlots: 6,
      freeSlots: 2,
      reportedEmptySlots: 2,
      items: []
    },
    chests: { available: true, chests: [{ id: 'c1', items: 1 }] },
    reserveFreeSlots: 2
  });
  const tick = f.controller.tick();
  assert.equal(tick.state, 'INVENTORY_PRESSURE');
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.controller.status().metrics.inventoryFullBlocks, 1);
});

test('H10 treats Adventure Land nothing_to_loot and safety responses as known skips', async () => {
  for (const reason of ['nothing_to_loot', 'safety']) {
    const f = controllerFixture({ lootResponse: { reason } });
    const first = f.controller.tick();
    assert.equal(first.state, 'LOOT_PENDING');

    await Promise.resolve();
    f.setChests([]);
    const second = f.controller.tick();
    assert.notEqual(second.state, 'SUSPENDED');
    assert.equal(f.controller.status().metrics.lootKnownRejected, 1);
    assert.equal(f.controller.status().metrics.lootConfirmed, 0);
    assert.equal(f.controller.status().metrics.lootUnknown, 0);
    assert.equal(f.dispatches.length, 1);
  }
});

test('H10 treats rejected Adventure Land not_there loot objects as a recoverable chest race', async () => {
  const f = controllerFixture({
    rejectPromise: true,
    rejectValue: { place: 'loot', reason: 'not_there', failed: true }
  });
  const first = f.controller.tick();
  assert.equal(first.state, 'LOOT_PENDING');
  assert.equal(f.dispatches.length, 1);

  await new Promise(resolve => setTimeout(resolve, 0));
  f.setChests([]);
  const second = f.controller.tick();
  assert.notEqual(second.state, 'SUSPENDED');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().metrics.lootKnownRejected, 1);
  assert.equal(f.controller.status().metrics.lootUnknown, 0);
  assert.equal(f.controller.status().lastAction.type, 'LOOT_SKIPPED');
  assert.equal(f.controller.status().lastAction.reason, 'not_there');
});

test('H10 rejected loot promise becomes UNKNOWN and is never blindly retried', async () => {
  const f = controllerFixture({ rejectPromise: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'LOOT_PENDING');
  assert.equal(f.dispatches.length, 1);

  await new Promise(resolve => setTimeout(resolve, 0));
  const second = f.controller.tick();
  assert.equal(second.state, 'SUSPENDED');
  assert.match(second.reason, /NETWORK_UNCERTAIN/);

  f.controller.tick();
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.controller.status().metrics.lootUnknown, 1);
});

test('H10 pending loot timeout becomes UNKNOWN and requires explicit recovery', () => {
  const f = controllerFixture({ neverResolvePromise: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'LOOT_PENDING');
  assert.equal(f.dispatches.length, 1);

  f.controller.pendingLoot.deadlineAtMs = Date.now() - 1;
  const second = f.controller.tick();
  assert.equal(second.state, 'SUSPENDED');
  assert.equal(second.reason, 'H10_LOOT_OUTCOME_TIMEOUT');
  assert.equal(f.controller.status().metrics.lootUnknown, 1);
  assert.equal(f.controller.status().pendingLoot, null);

  f.controller.tick();
  assert.equal(f.dispatches.length, 1);
});

test('H10 synchronous ActionBoundary UNKNOWN suspends immediately without retry', () => {
  const f = controllerFixture({ syncUnknown: true });
  const first = f.controller.tick();
  assert.equal(first.state, 'SUSPENDED');
  assert.match(first.reason, /NETWORK_UNCERTAIN/);
  assert.equal(f.dispatches.length, 1);

  f.controller.tick();
  assert.equal(f.dispatches.length, 1);
});

test('H10 source remains non-destructive: only loot is dispatched by the controller', () => {
  assert.match(inventorySource, /dispatch\('loot'/);
  assert.doesNotMatch(inventorySource, /dispatch\('sell'/);
  assert.doesNotMatch(inventorySource, /dispatch\('bank_store'/);
  assert.doesNotMatch(inventorySource, /dispatch\('exchange'/);
});


test('H10 explicit safety reset is required before loot resumes after UNKNOWN', async () => {
  const f = controllerFixture({ rejectPromise: true });
  assert.equal(f.controller.tick().state, 'LOOT_PENDING');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.controller.tick().state, 'SUSPENDED');
  assert.equal(f.dispatches.length, 1);

  f.controller.resetSafety('TEST_RESET');
  f.setChests([]);
  const after = f.controller.tick();
  assert.equal(after.state, 'READY');
  assert.equal(f.controller.status().suspended, false);
  assert.equal(f.controller.status().lastAction.type, 'RESET');
  assert.equal(f.dispatches.length, 1);
});

test('H10 runtime, public API, UI and one-click live suite are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.LootInventoryController/);
  assert.match(runtime, /id: 'loot-inventory'/);
  assert.match(runtime, /id: 'h10-loot-inventory'/);
  assert.match(runtime, /H10_PROTECTED_ITEM_LOST/);
  assert.match(runtime, /row && row\.protected === true/);
  assert.doesNotMatch(runtime, /\['PROTECT', 'RESERVE'\]\.includes\(String\(row\.disposition\)\)/);
  assert.match(runtime, /h10-confirmed-loot/);
  assert.match(runtime, /visibleSafeCount/);
  assert.match(runtime, /preferredTypes: \[probe\.mtype\]/);
  assert.match(runtime, /safeAhp - safeBhp/);
  assert.match(runtime, /H10_NO_LOOT_PROBE_CANDIDATE/);
  assert.match(entry, /0\.26\.29-h26/);
  assert.match(entry, /inventory:/);
  assert.match(entry, /reset: reason => runtime\.inventory\.resetSafety/);
  assert.match(build, /src\/inventory\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.29-h26'/);
  assert.match(build, /const banner = `\/\* AL Bot \$\{runtimeVersion\}/);
  assert.match(ui, /data-tab="inventory"/);
  assert.match(ui, /H10 Loot & Inventar/);
  assert.match(boundary, /loot: Object\.freeze\(\{ publicName: 'loot'/);
  assert.equal(pkg.version, '0.26.29');
});

test('H10 source keeps destructive economy actions outside the controller', () => {
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  assert.match(boundary, /publicName: 'loot'/);
  assert.doesNotMatch(inventorySource, /dispatch\('sell'/);
  assert.doesNotMatch(inventorySource, /dispatch\('bank_store'/);
  assert.doesNotMatch(inventorySource, /dispatch\('exchange'/);
  assert.match(inventorySource, /SAFE_DEFAULT_UNKNOWN_VALUE/);
});
