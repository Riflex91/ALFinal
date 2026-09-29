import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/economy.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fixture(options = {}) {
  let clock = 0;
  const calls = [];
  const character = {
    name: options.name || 'My_Merchant',
    ctype: options.ctype || 'merchant',
    rip: !!options.rip,
    map: 'main',
    gold: options.gold == null ? 1000000 : options.gold
  };
  const movement = {
    activeOrder: options.movementOwner ? { id: 'move-1', owner: options.movementOwner } : null,
    lastOrder: null
  };
  const statuses = {
    inventory: { suspended: false, pendingLoot: options.pendingLoot ? { id: 'loot-pending' } : null, lastAction: null },
    merchant: { suspended: false, pending: null, request: null, delivery: null, lastAction: null },
    bank: { suspended: false, pending: null, request: null, lastAction: null },
    trade: { suspended: false, pending: null, request: null, lastAction: null },
    gear: { suspended: false, pending: null, request: null, lastAction: null },
    upgrade: { suspended: false, pending: null, request: null, lastAction: null },
    exchangeCraft: { suspended: false, pending: null, request: null, lastAction: null }
  };

  if (options.busyModule) statuses[options.busyModule].request = { id: 'busy-1' };
  if (options.suspendedModule) {
    statuses[options.suspendedModule].suspended = true;
    statuses[options.suspendedModule].suspendedReason = 'TEST_CHILD_SUSPENDED';
  }

  const plans = {
    merchant: {
      state: 'READY',
      pressure: { state: options.pressure || 'NORMAL' }
    },
    bank: {
      state: options.bankState || 'READY',
      reason: options.bankState === 'NEEDS_BANK' ? 'H12_BANK_NOT_MOUNTED' : 'H12_BANK_READY',
      safeDepositRows: clone(options.bankRows || [])
    },
    trade: {
      state: 'READY',
      safeSellRows: clone(options.sellRows || [])
    },
    gear: {
      state: 'READY',
      local: { improvements: clone(options.gearImprovements || []) }
    },
    upgrade: {
      state: 'READY',
      upgradeCandidates: clone(options.upgrades || []),
      compoundCandidates: clone(options.compounds || [])
    },
    exchangeCraft: {
      state: 'READY',
      exchangeCandidates: clone(options.exchanges || []),
      craftCandidates: clone(options.crafts || [])
    }
  };

  function controller(name, queueMethods = {}) {
    return {
      plan: () => clone(plans[name]),
      status: () => clone(statuses[name]),
      ...queueMethods
    };
  }

  const bank = controller('bank', {
    queueMount: () => {
      calls.push({ module: 'bank', kind: 'MOUNT' });
      if (options.bankMountAlreadyMounted) {
        statuses.bank.lastAction = { at: 't' + (++clock), type: 'BANK_ALREADY_MOUNTED' };
        return { accepted: true, state: 'READY', alreadyMounted: true };
      }
      statuses.bank.request = { id: 'bank-request' };
      statuses.bank.lastAction = { at: 't' + (++clock), type: 'MOUNT_QUEUED' };
      return { accepted: true, request: clone(statuses.bank.request) };
    },
    queueDeposit: (itemName, opts) => {
      calls.push({ module: 'bank', kind: 'DEPOSIT', itemName, opts: clone(opts) });
      statuses.bank.request = { id: 'bank-deposit' };
      statuses.bank.lastAction = { at: 't' + (++clock), type: 'DEPOSIT_QUEUED' };
      return { accepted: true, request: clone(statuses.bank.request) };
    }
  });

  const trade = controller('trade', {
    marketAnalysis: name => ({
      available: true,
      bestBid: options.bestBid ? clone(options.bestBid) : null,
      bids: options.bestBid ? [clone(options.bestBid)] : [],
      asks: []
    }),
    queueMarketSell: (playerName, tradeSlot, quantity, opts) => {
      calls.push({ module: 'trade', kind: 'MARKET_SELL', playerName, tradeSlot, quantity, opts: clone(opts) });
      statuses.trade.request = { id: 'trade-market-sell' };
      statuses.trade.lastAction = { at: 't' + (++clock), type: 'MARKET_SELL_QUEUED' };
      return { accepted: true, request: clone(statuses.trade.request) };
    },
    queueNpcSell: (slot, quantity) => {
      calls.push({ module: 'trade', kind: 'NPC_SELL', slot, quantity });
      if (options.rejectNpcSell) return { accepted: false, reason: 'H13_TEST_REJECT' };
      statuses.trade.request = { id: 'trade-npc-sell' };
      statuses.trade.lastAction = { at: 't' + (++clock), type: 'NPC_SELL_QUEUED' };
      return { accepted: true, request: clone(statuses.trade.request) };
    }
  });

  const gear = controller('gear', {
    queueEquip: (inventorySlot, targetSlot) => {
      calls.push({ module: 'gear', kind: 'EQUIP', inventorySlot, targetSlot });
      statuses.gear.request = { id: 'gear-equip' };
      statuses.gear.lastAction = { at: 't' + (++clock), type: 'EQUIP_QUEUED' };
      return { accepted: true, request: clone(statuses.gear.request) };
    }
  });

  const upgrade = controller('upgrade', {
    queueUpgrade: itemSlot => {
      calls.push({ module: 'upgrade', kind: 'UPGRADE', itemSlot });
      statuses.upgrade.request = { id: 'upgrade-request' };
      statuses.upgrade.lastAction = { at: 't' + (++clock), type: 'UPGRADE_QUEUED' };
      return { accepted: true, request: clone(statuses.upgrade.request) };
    },
    queueCompound: itemSlots => {
      calls.push({ module: 'upgrade', kind: 'COMPOUND', itemSlots: clone(itemSlots) });
      statuses.upgrade.request = { id: 'compound-request' };
      statuses.upgrade.lastAction = { at: 't' + (++clock), type: 'COMPOUND_QUEUED' };
      return { accepted: true, request: clone(statuses.upgrade.request) };
    }
  });

  const exchangeCraft = controller('exchangeCraft', {
    queueExchange: inventorySlot => {
      calls.push({ module: 'exchangeCraft', kind: 'EXCHANGE', inventorySlot });
      statuses.exchangeCraft.request = { id: 'exchange-request' };
      statuses.exchangeCraft.lastAction = { at: 't' + (++clock), type: 'EXCHANGE_QUEUED' };
      return { accepted: true, request: clone(statuses.exchangeCraft.request) };
    },
    queueCraft: itemName => {
      calls.push({ module: 'exchangeCraft', kind: 'CRAFT', itemName });
      statuses.exchangeCraft.request = { id: 'craft-request' };
      statuses.exchangeCraft.lastAction = { at: 't' + (++clock), type: 'CRAFT_QUEUED' };
      return { accepted: true, request: clone(statuses.exchangeCraft.request) };
    }
  });

  const inventory = controller('inventory');
  const merchant = controller('merchant');
  const game = {
    snapshot: () => ({ available: options.gameAvailable !== false, character: options.gameAvailable === false ? null : clone(character) }),
    itemDefinition: name => ({ id: name, g: options.npcPrice == null ? 100 : options.npcPrice }),
    npcLocation: npcId => options.noNpc ? null : { npcId, map: 'main', x: 10, y: 20 }
  };
  const combat = {
    status: () => ({ active: !!options.combatActive, state: options.combatActive ? 'FIGHTING' : 'IDLE' })
  };
  const movementController = { status: () => clone(movement) };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max) } }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'economy.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.EconomyController;
  const economy = new Controller({
    root: ctx, game, movement: movementController, combat,
    inventory, merchant, bank, trade, gear, upgrade, exchangeCraft,
    canAct: () => options.actionBlocked !== true
  });
  economy.start({ scope: { interval: () => 'h17-resource' } });
  economy.policy({ actionCooldownMs: options.actionCooldownMs == null ? 0 : options.actionCooldownMs });

  function settle(module, type) {
    statuses[module].request = null;
    statuses[module].pending = null;
    statuses[module].lastAction = { at: 't' + (++clock), type };
  }

  function suspend(module, reason = 'TEST_UNKNOWN') {
    statuses[module].request = null;
    statuses[module].pending = null;
    statuses[module].suspended = true;
    statuses[module].suspendedReason = reason;
    statuses[module].lastAction = { at: 't' + (++clock), type: 'TEST_UNKNOWN', reason };
  }

  return { economy, calls, statuses, plans, movement, settle, suspend };
}

test('H17 is observe-only until autonomy is explicitly enabled', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'gem0', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  const tick = f.economy.tick();
  assert.equal(tick.state, 'OBSERVE');
  assert.equal(tick.plan.selected.kind, 'EXCHANGE');
  assert.equal(f.calls.length, 0);
  assert.equal(f.economy.status().autonomyEnabled, false);
});

test('H17 deterministically prioritizes pressure bank work over lower economy actions', () => {
  const f = fixture({
    pressure: 'CRITICAL',
    bankState: 'NEEDS_BANK',
    bankRows: [{ slot: 3, name: 'junk', quantity: 5 }],
    gearImprovements: [{
      slot: 'gloves', delta: 5,
      bestInventory: { inventorySlot: 2, item: { name: 'gloves2', definition: { g: 1000 } } }
    }],
    exchanges: [{ safe: true, itemName: 'gem0', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  const plan = f.economy.plan();
  assert.equal(plan.state, 'READY');
  assert.equal(plan.selected.kind, 'BANK_MOUNT');
  assert.ok(plan.proposals.some(row => row.kind === 'GEAR_EQUIP'));
  assert.ok(plan.proposals.some(row => row.kind === 'EXCHANGE'));
});

test('H17 common planner exposes safe proposals across the economy modules', () => {
  const f = fixture({
    gearImprovements: [{
      slot: 'gloves', delta: 5,
      bestInventory: { inventorySlot: 2, item: { name: 'gloves2', definition: { g: 1000 } } }
    }],
    exchanges: [{ safe: true, itemName: 'gem0', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }],
    crafts: [{ safe: true, itemName: 'cake', cost: 5, inputValueAtRisk: 50 }],
    upgrades: [{ itemSlot: 5, itemName: 'sword', fromLevel: 0, budget: { itemValueAtRisk: 500 } }],
    compounds: [{ itemSlots: [6, 7, 8], itemName: 'ring', fromLevel: 0, budget: { itemValueAtRisk: 600 } }],
    sellRows: [{ slot: 9, name: 'junk', quantity: 2, level: 0 }],
    bestBid: { playerName: 'Buyer', slot: 'trade1', rid: 'rid-1', name: 'junk', level: 0, quantity: 10, price: 150 }
  });
  const kinds = new Set(f.economy.plan().proposals.map(row => row.kind));
  for (const kind of ['GEAR_EQUIP', 'MARKET_SELL', 'EXCHANGE', 'CRAFT', 'UPGRADE', 'COMPOUND']) {
    assert.equal(kinds.has(kind), true, 'missing proposal ' + kind);
  }
});

test('H17 immediately confirms a bank mount race that reports already mounted', () => {
  const f = fixture({
    pressure: 'CRITICAL',
    bankState: 'NEEDS_BANK',
    bankRows: [{ slot: 3, name: 'junk', quantity: 5 }],
    bankMountAlreadyMounted: true
  });
  f.economy.startAutonomy({ maxActions: 2 });
  const tick = f.economy.tick();
  assert.equal(tick.state, 'QUEUED');
  assert.equal(tick.result.immediate, true);
  assert.equal(f.economy.status().currentAction, null);
  assert.equal(f.economy.status().metrics.actionsConfirmed, 1);
});

test('H17 refuses planning while combat, foreign movement, or another child owns execution', () => {
  const combat = fixture({ combatActive: true });
  assert.equal(combat.economy.plan().reason, 'H17_COMBAT_ACTIVE');

  const movement = fixture({ movementOwner: 'other-module' });
  assert.equal(movement.economy.plan().reason, 'H17_MOVEMENT_OWNED');

  const busy = fixture({ busyModule: 'trade' });
  assert.equal(busy.economy.plan().reason, 'H17_CHILD_BUSY');
});

test('H17 treats pending loot as inventory ownership and blocks economy planning', () => {
  const f = fixture({
    pendingLoot: true,
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  const plan = f.economy.plan();
  assert.equal(plan.state, 'WAITING');
  assert.equal(plan.reason, 'H17_CHILD_BUSY');
  assert.ok(plan.blockers.some(row => row.module === 'inventory'));
  assert.equal(f.calls.length, 0);
});

test('H17 manual queue is rejected while the economy module is stopped', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  f.economy.stop('TEST_STOP');
  const result = f.economy.queueSelected();
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H17_MODULE_NOT_ACTIVE');
  assert.equal(f.calls.length, 0);
});

test('H17 queues one safe exchange and confirms it only from child evidence', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  assert.equal(f.economy.startAutonomy({ maxActions: 2 }).accepted, true);
  const queued = f.economy.tick();
  assert.equal(queued.state, 'QUEUED');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'EXCHANGE');
  assert.ok(f.economy.status().currentAction);

  assert.equal(f.economy.tick().state, 'WAITING');
  assert.equal(f.calls.length, 1);

  f.settle('exchangeCraft', 'EXCHANGE_CONFIRMED');
  const confirmed = f.economy.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(f.economy.status().currentAction, null);
  assert.equal(f.economy.status().metrics.actionsConfirmed, 1);
  assert.equal(f.calls.length, 1);
});

test('H17 treats a child BLOCKED outcome as a terminal rejection', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  f.economy.startAutonomy({ maxActions: 2 });
  assert.equal(f.economy.tick().state, 'QUEUED');
  f.settle('exchangeCraft', 'EXCHANGE_BLOCKED');
  const result = f.economy.tick();
  assert.equal(result.state, 'REJECTED');
  assert.equal(f.economy.status().currentAction, null);
  assert.equal(f.economy.status().suspended, false);
  assert.equal(f.economy.status().metrics.actionsRejected, 1);
  assert.equal(f.calls.length, 1);
});

test('H17 child UNKNOWN suspends autonomy without blind retry', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  f.economy.startAutonomy({ maxActions: 3 });
  assert.equal(f.economy.tick().state, 'QUEUED');
  f.suspend('exchangeCraft', 'H16_TEST_UNKNOWN');
  const tick = f.economy.tick();
  assert.equal(tick.state, 'SUSPENDED');
  assert.match(tick.reason, /H17_CHILD_SUSPENDED/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.economy.tick().state, 'SUSPENDED');
  assert.equal(f.calls.length, 1);
});

test('H17 known queue rejection enters cooldown instead of retrying every tick', () => {
  const f = fixture({
    sellRows: [{ slot: 8, name: 'junk', quantity: 2, level: 0 }],
    rejectNpcSell: true,
    actionCooldownMs: 5000
  });
  f.economy.startAutonomy({ maxActions: 3 });
  const first = f.economy.tick();
  assert.equal(first.state, 'REJECTED');
  assert.equal(f.calls.length, 1);
  const second = f.economy.tick();
  assert.equal(second.state, 'COOLDOWN');
  assert.equal(f.calls.length, 1);
  assert.equal(f.economy.status().metrics.rejectionBackoffs, 1);
  assert.equal(f.economy.status().rejectionBackoff.length, 1);
});

test('H17 chooses market sell only when a live bid beats the configured NPC floor', () => {
  const f = fixture({
    npcPrice: 100,
    sellRows: [{ slot: 8, name: 'junk', quantity: 2, level: 0 }],
    bestBid: { playerName: 'Buyer', slot: 'trade1', rid: 'rid-1', name: 'junk', level: 0, quantity: 10, price: 150 }
  });
  f.economy.policy({ minMarketPremiumRatio: 1.2 });
  assert.equal(f.economy.plan().selected.kind, 'MARKET_SELL');

  f.economy.policy({ minMarketPremiumRatio: 2 });
  assert.equal(f.economy.plan().selected.kind, 'NPC_SELL');
});

test('H17 active child action cannot be forgotten by reset or autonomy restart', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  f.economy.startAutonomy({ maxActions: 2 });
  f.economy.tick();
  assert.equal(f.economy.startAutonomy().reason, 'H17_ACTION_ACTIVE');
  const reset = f.economy.resetSafety();
  assert.equal(reset.reset, false);
  assert.equal(reset.reason, 'H17_ACTION_ACTIVE');
  assert.ok(f.economy.status().currentAction);
});

test('H17 session action budget stops bounded autonomy', () => {
  const f = fixture({
    exchanges: [{ safe: true, itemName: 'anniversarygift', inventorySlot: 4, requiredQuantity: 1, valueAtRisk: 100 }]
  });
  f.economy.startAutonomy({ maxActions: 1 });
  assert.equal(f.economy.tick().state, 'QUEUED');
  f.settle('exchangeCraft', 'EXCHANGE_CONFIRMED');
  const confirmed = f.economy.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  const after = f.economy.tick();
  assert.equal(after.state, 'COMPLETE');
  assert.equal(after.reason, 'H17_SESSION_ACTION_BUDGET_REACHED');
  assert.equal(f.economy.status().autonomyEnabled, false);
  assert.equal(f.calls.length, 1);
});


test('H17 runtime, API, UI, build and generated bundle are wired without direct action dispatch', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const dist = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.EconomyController/);
  assert.match(runtime, /id: 'economy'/);
  assert.match(runtime, /id: 'h17-economy-autonomy'/);
  assert.match(runtime, /options\.version \|\| '0\.26\.6-h26'/);
  assert.match(runtime, /trade\.movementUnknown/);
  assert.match(runtime, /inventory\.lootUnknown/);
  assert.match(runtime, /status\.pendingLoot/);
  assert.match(source, /H17_MODULE_NOT_ACTIVE/);
  assert.match(source, /child\.pendingLoot/);
  assert.match(source, /type\.includes\('BLOCKED'\)/);
  assert.match(source, /if \(observed\.state !== 'IDLE'\) return observed/);
  assert.match(entry, /0\.26\.6-h26/);
  assert.match(entry, /runtime\.economy\.startAutonomy/);
  assert.match(entry, /Object\.freeze\(api\.economy\)/);
  assert.match(ui, /data-tab="economy"/);
  assert.match(ui, /H17 Economy Autonomy/);
  assert.match(build, /src\/economy\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.6-h26'/);
  assert.match(dist, /AL Bot 0\.26\.6-h26/);
  assert.match(dist, /class EconomyController/);
  assert.doesNotMatch(source, /actions\.dispatch/);
  assert.equal(pkg.version, '0.26.6');
});


test('H17 performs safe bank maintenance at normal inventory pressure', () => {
  const f = fixture({
    pressure: 'NORMAL',
    bankState: 'NEEDS_BANK',
    bankRows: [{ slot: 3, name: 'junk', quantity: 5 }]
  });
  const plan = f.economy.plan();
  assert.equal(plan.state, 'READY');
  assert.equal(plan.selected.kind, 'BANK_MOUNT');
  const mount = plan.proposals.find(row => row.kind === 'BANK_MOUNT');
  assert.ok(mount);
  assert.equal(mount.maintenance, true);
});

test('H17 normal-pressure bank maintenance queues the existing safe H12 mount path', () => {
  const f = fixture({
    pressure: 'NORMAL',
    bankState: 'NEEDS_BANK',
    bankRows: [{ slot: 3, name: 'junk', quantity: 5 }]
  });
  assert.equal(f.economy.startAutonomy({ maxActions: 2 }).accepted, true);
  const tick = f.economy.tick();
  assert.equal(tick.state, 'QUEUED');
  assert.deepEqual(f.calls[0], { module: 'bank', kind: 'MOUNT' });
});
