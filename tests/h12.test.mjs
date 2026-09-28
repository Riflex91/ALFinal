import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bankSource = fs.readFileSync(path.resolve(here, '../src/bank.js'), 'utf8');

function internals() {
  return {
    helpers: {
      clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
      cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
    }
  };
}

function item(overrides = {}) {
  return {
    slot: 0, name: 'material', quantity: 5, level: 0, statType: null,
    locked: false, giveaway: false, gift: false, property: null, expiresAt: null,
    disposition: 'BANK', reason: 'SAFE_DEFAULT_UNKNOWN_VALUE',
    definition: { type: 'material', quest: false, upgrade: false, compound: false },
    ...overrides
  };
}

function fixture(options = {}) {
  const state = {
    local: {
      name: 'My_Merchant', ctype: options.ctype || 'merchant', map: options.map || 'main',
      x: 0, y: 0, rip: false, gold: options.characterGold == null ? 10000 : options.characterGold
    },
    rows: (options.inventoryRows || [
      item(),
      item({
        slot: 1, name: 'hpot0', quantity: 20, disposition: 'KEEP',
        reason: 'CONSUMABLE_OR_UTILITY', definition: { type: 'pot', quest: false, upgrade: false, compound: false }
      }),
      item({
        slot: 2, name: 'sword', quantity: 1, disposition: 'PROTECT',
        reason: 'GEAR_OR_UPGRADE_ITEM', definition: { type: 'weapon', quest: false, upgrade: true, compound: false }
      })
    ]).map(row => JSON.parse(JSON.stringify(row))),
    mounted: options.mounted !== false,
    bankAvailable: options.bankAvailable !== false,
    inventoryAvailable: options.inventoryAvailable !== false,
    bankGold: options.bankGold == null ? 5000 : options.bankGold,
    packs: { items0: new Array(6).fill(null), items1: new Array(4).fill(null) },
    dispatches: [],
    movementCalls: 0,
    movement: null
  };

  if (options.bankRows) {
    for (const row of options.bankRows) {
      if (!state.packs[row.pack]) state.packs[row.pack] = new Array(6).fill(null);
      state.packs[row.pack][row.slot] = JSON.parse(JSON.stringify(row));
    }
  }

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const inventorySnapshot = () => {
    if (!state.inventoryAvailable) return { available: false, reason: 'CHARACTER_UNAVAILABLE', capacity: 6, usedSlots: 0, freeSlots: 0, items: [] };
    return { available: true, capacity: 6, usedSlots: state.rows.length, freeSlots: 6 - state.rows.length, items: clone(state.rows) };
  };
  const bankSnapshot = () => {
    if (!state.mounted || !state.bankAvailable) {
      return { available: false, reason: 'BANK_NOT_MOUNTED', map: state.local.map, gold: null, capacity: 0, usedSlots: 0, freeSlots: 0, packs: [] };
    }
    const packs = Object.entries(state.packs).map(([name, slots]) => {
      const items = [];
      for (let slot = 0; slot < slots.length; slot += 1) {
        const row = slots[slot];
        if (row) items.push({ ...clone(row), pack: name, slot });
      }
      return { name, map: 'bank', capacity: slots.length, usedSlots: items.length, freeSlots: slots.length - items.length, items };
    });
    return {
      available: true, reason: null, map: 'bank', gold: state.bankGold,
      capacity: packs.reduce((n, p) => n + p.capacity, 0),
      usedSlots: packs.reduce((n, p) => n + p.usedSlots, 0),
      freeSlots: packs.reduce((n, p) => n + p.freeSlots, 0),
      packs
    };
  };

  const game = {
    snapshot: () => ({ available: true, character: { ...state.local } }),
    inventorySnapshot,
    bankSnapshot
  };
  const inventory = {
    plan: () => ({
      state: state.inventoryAvailable ? 'READY' : 'BLOCKED',
      inventory: inventorySnapshot(),
      items: clone(state.rows),
      reserveFreeSlots: 2
    })
  };
  const movement = {
    status: () => state.movement || { active: false, activeOrder: null },
    smartMove: (destination, opts) => {
      state.movementCalls += 1;
      if (options.moveReject) return { accepted: false, reason: 'MOVEMENT_REJECTED' };
      if (options.keepMovementActive) {
        state.movement = { active: true, activeOrder: { owner: opts.owner, destination } };
      } else {
        state.local.map = 'bank';
        state.mounted = true;
        state.movement = null;
      }
      return { accepted: true, order: { owner: opts.owner, destination } };
    },
    cancel: () => { state.movement = null; return { cancelled: true }; }
  };

  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: [...args] });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.rejectPromise) return { state: 'DISPATCHED', value: Promise.reject(new Error('NETWORK_UNCERTAIN')) };
      if (options.noMutation !== true) {
        if (name === 'bank_store') {
          const [invSlot, pack, bankSlot] = args;
          const index = state.rows.findIndex(row => Number(row.slot) === Number(invSlot));
          const row = index >= 0 ? state.rows[index] : null;
          if (row) {
            state.rows.splice(index, 1);
            state.packs[pack][bankSlot] = { ...clone(row), pack, slot: bankSlot };
          }
        } else if (name === 'bank_retrieve') {
          const [pack, bankSlot, invSlot] = args;
          const row = state.packs[pack] && state.packs[pack][bankSlot];
          if (row) {
            state.packs[pack][bankSlot] = null;
            state.rows.push({ ...clone(row), slot: invSlot });
          }
        } else if (name === 'bank_deposit') {
          state.local.gold -= Number(args[0]);
          state.bankGold += Number(args[0]);
        } else if (name === 'bank_withdraw') {
          state.local.gold += Number(args[0]);
          state.bankGold -= Number(args[0]);
        }
      }
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(bankSource, ctx, { filename: 'bank.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.BankController;
  const controller = new Controller({ root: ctx, game, actions, movement, inventory, outcomeTimeoutMs: 1000, bankMountTimeoutMs: 3000 });
  controller.start({ scope: { interval: () => 'bank-resource' } });
  return { controller, state, game, inventory, movement, actions };
}

test('H12 plan/search expose bank packs while only BANK-disposition rows are safe deposits', () => {
  const f = fixture({ bankRows: [{ pack: 'items0', slot: 2, ...item({ name: 'stored', quantity: 3 }) }] });
  const plan = f.controller.plan();
  assert.equal(plan.state, 'READY');
  assert.deepEqual(Array.from(plan.safeDepositRows, row => row.name), ['material']);
  assert.equal(plan.packs.length, 2);
  assert.equal(f.controller.search('stored').length, 1);
  assert.equal(f.controller.search('missing').length, 0);
});

test('H12 deposit fails closed for KEEP and PROTECT inventory items', () => {
  const f = fixture();
  assert.equal(f.controller.queueDeposit('hpot0', { inventorySlot: 1 }).accepted, false);
  assert.equal(f.controller.queueDeposit('sword', { inventorySlot: 2 }).accepted, false);
  assert.equal(f.state.dispatches.length, 0);
});

test('H12 read-only mount travels to bank without any ActionBoundary write', () => {
  const f = fixture({ mounted: false });
  const queued = f.controller.queueMount();
  assert.equal(queued.accepted, true);
  const first = f.controller.tick();
  assert.equal(first.state, 'WAITING_BANK');
  assert.equal(f.state.movementCalls, 1);
  assert.equal(f.state.dispatches.length, 0);
  const second = f.controller.tick();
  assert.equal(second.state, 'READY');
  assert.equal(second.reason, 'H12_BANK_READY');
  assert.equal(f.controller.status().request, null);
  assert.equal(f.controller.status().lastAction.type, 'BANK_MOUNTED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H12 read-only mount is a no-op when bank is already mounted', () => {
  const f = fixture();
  const queued = f.controller.queueMount();
  assert.equal(queued.accepted, true);
  assert.equal(queued.state, 'READY');
  assert.equal(queued.alreadyMounted, true);
  assert.equal(f.state.movementCalls, 0);
  assert.equal(f.state.dispatches.length, 0);
});

test('H12 controlled deposit dispatches bank_store and confirms inventory plus bank delta', async () => {
  const f = fixture();
  assert.equal(f.controller.queueDeposit('material', { inventorySlot: 0 }).accepted, true);
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[0], { name: 'bank_store', args: [0, 'items0', 0] });
  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.metrics.depositsConfirmed, 1);
  assert.equal(status.metrics.depositsUnknown, 0);
  assert.equal(f.state.rows.some(row => row.name === 'material'), false);
  assert.equal(f.state.packs.items0[0].name, 'material');
});

test('H12 deposit travels to bank once before dispatching and never repeats the move', async () => {
  const f = fixture({ mounted: false });
  assert.equal(f.controller.queueDeposit('material', { inventorySlot: 0 }).accepted, true);
  assert.equal(f.controller.tick().state, 'WAITING_BANK');
  assert.equal(f.state.movementCalls, 1);
  assert.equal(f.state.dispatches.length, 0);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.movementCalls, 1);
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.depositsConfirmed, 1);
});

test('H12 withdraw respects bank reservations', () => {
  const f = fixture({ bankRows: [{ ...item({ name: 'reserved', quantity: 5 }), pack: 'items0', slot: 1 }] });
  f.controller.setReservations({ reserved: 5 });
  const blocked = f.controller.queueWithdraw('items0', 1, { inventorySlot: 3 });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'H12_BANK_RESERVATION_BLOCKED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H12 deposit then withdraw round-trip restores the exact inventory slot and quantity', async () => {
  const f = fixture();
  assert.equal(f.controller.queueDeposit('material', { inventorySlot: 0 }).accepted, true);
  f.controller.tick();
  await Promise.resolve();
  f.controller.tick();
  const depositStatus = f.controller.status();
  assert.equal(depositStatus.metrics.depositsConfirmed, 1);
  assert.equal(depositStatus.lastAction.pack, 'items0');
  assert.equal(depositStatus.lastAction.bankSlot, 0);

  assert.equal(f.controller.queueWithdraw('items0', 0, { inventorySlot: 0 }).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[1], { name: 'bank_retrieve', args: ['items0', 0, 0] });
  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.metrics.withdrawalsConfirmed, 1);
  const restored = f.state.rows.find(row => Number(row.slot) === 0);
  assert.equal(restored.name, 'material');
  assert.equal(restored.quantity, 5);
  assert.equal(f.state.packs.items0[0], null);
  assert.equal(f.controller.reconcile().available, true);
});

test('H12 unavailable observations never confirm a bank write and timeout suspends without retry', () => {
  const f = fixture({ noMutation: true, neverSettle: true });
  assert.equal(f.controller.queueDeposit('material', { inventorySlot: 0 }).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);
  f.state.bankAvailable = false;
  f.state.inventoryAvailable = false;
  f.controller.pending.deadlineAtMs = Date.now() - 1;
  const timedOut = f.controller.tick();
  assert.equal(timedOut.state, 'SUSPENDED');
  assert.equal(f.controller.status().metrics.depositsConfirmed, 0);
  assert.equal(f.controller.status().metrics.depositsUnknown, 1);
  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H12 synchronous UNKNOWN suspends immediately and never retries', () => {
  const f = fixture({ syncUnknown: true, noMutation: true });
  assert.equal(f.controller.queueDeposit('material', { inventorySlot: 0 }).accepted, true);
  const first = f.controller.tick();
  assert.equal(first.state, 'SUSPENDED');
  assert.equal(f.controller.status().metrics.depositsUnknown, 1);
  assert.equal(f.state.dispatches.length, 1);
  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H12 rejects zero, negative, fractional and nonnumeric gold amounts without a write', () => {
  const f = fixture();
  for (const value of [0, -5, 1.5, NaN, 'abc']) {
    const deposit = f.controller.queueGoldDeposit(value);
    assert.equal(deposit.accepted, false);
    assert.equal(deposit.reason, 'H12_GOLD_AMOUNT_INVALID');
    const withdraw = f.controller.queueGoldWithdraw(value);
    assert.equal(withdraw.accepted, false);
    assert.equal(withdraw.reason, 'H12_GOLD_AMOUNT_INVALID');
  }
  assert.equal(f.state.dispatches.length, 0);
});

test('H12 gold operations require observable bank gold and confirm both-sided deltas', async () => {
  const f = fixture();
  assert.equal(f.controller.queueGoldDeposit(1000).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.goldDepositsConfirmed, 1);
  assert.equal(f.state.local.gold, 9000);
  assert.equal(f.state.bankGold, 6000);

  assert.equal(f.controller.queueGoldWithdraw(500).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.goldWithdrawalsConfirmed, 1);
  assert.equal(f.state.local.gold, 9500);
  assert.equal(f.state.bankGold, 5500);
});

test('H12 runtime, API, UI, build, adapter and ActionBoundary are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const adapter = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.BankController/);
  assert.match(runtime, /id: 'bank'/);
  assert.match(runtime, /id: 'h12-bank'/);
  assert.match(runtime, /H12_LIVE_TEST_REQUIRES_MERCHANT/);
  assert.match(bankSource, /queueMount\(\)/);
  assert.match(bankSource, /type: 'BANK_MOUNTED'/);
  assert.match(entry, /0\.24\.1-h24/);
  assert.match(entry, /runtime\.bank\.queueDeposit/);
  assert.match(ui, /data-tab="bank"/);
  assert.match(ui, /H12 Bank/);
  assert.match(build, /src\/bank\.js/);
  assert.match(build, /const runtimeVersion = '0\.24\.1-h24'/);
  assert.match(boundary, /bank_store: Object\.freeze\(\{ publicName: 'bank_store'/);
  assert.match(boundary, /bank_retrieve: Object\.freeze\(\{ publicName: 'bank_retrieve'/);
  assert.match(adapter, /bankSnapshot\(\)/);
  assert.match(adapter, /bankPackDefinitions\(\)/);
  assert.equal(pkg.version, '0.24.1');
});
