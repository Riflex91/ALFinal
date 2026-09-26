import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const merchantSource = fs.readFileSync(path.resolve(here, '../src/merchant.js'), 'utf8');

function internals() {
  return {
    helpers: {
      clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
      cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max),
      COMBAT_CLASSES: new Set(['warrior', 'ranger', 'mage', 'priest', 'rogue', 'paladin'])
    }
  };
}

function row(overrides = {}) {
  return {
    slot: 0,
    name: 'hpot0',
    quantity: 20,
    level: 0,
    locked: false,
    giveaway: false,
    gift: false,
    expiresAt: null,
    disposition: 'KEEP',
    reason: 'CONSUMABLE_OR_UTILITY',
    definition: { type: 'pot', quest: false, upgrade: false, compound: false },
    ...overrides
  };
}

function fixture(options = {}) {
  const local = options.local || { name: 'My_Merchant', ctype: 'merchant', map: 'main', x: 0, y: 0, rip: false };
  const farmer = options.farmer || { name: 'My_Ranger', ctype: 'ranger', map: 'main', x: 40, y: 0, distance: 40 };
  const foreign = { name: 'Foreign', ctype: 'ranger', map: 'main', x: 30, y: 0, distance: 30 };
  const inventoryRows = options.inventoryRows || [
    row(),
    row({
      slot: 1, name: 'material', quantity: 5, disposition: 'BANK',
      reason: 'SAFE_DEFAULT_UNKNOWN_VALUE', definition: { type: 'material', quest: false, upgrade: false, compound: false }
    }),
    row({
      slot: 2, name: 'sword', quantity: 1, disposition: 'PROTECT',
      reason: 'GEAR_OR_UPGRADE_ITEM', definition: { type: 'weapon', quest: false, upgrade: true, compound: false }
    }),
    row({
      slot: 3, name: 'questitem', quantity: 2, disposition: 'RESERVE',
      reason: 'QUEST_ITEM', definition: { type: 'material', quest: true, upgrade: false, compound: false }
    })
  ];
  const slots = options.slots || { capacity: 10, usedSlots: inventoryRows.length, freeSlots: 10 - inventoryRows.length };
  const state = {
    local: { ...local },
    rows: inventoryRows.map(item => JSON.parse(JSON.stringify(item))),
    conditions: {},
    dispatches: [],
    movement: null
  };

  const inventory = {
    plan: () => ({
      state: 'READY',
      inventory: { ...slots },
      reserveFreeSlots: options.reserveFreeSlots == null ? 2 : options.reserveFreeSlots,
      items: state.rows.map(item => JSON.parse(JSON.stringify(item)))
    })
  };

  const game = {
    snapshot: () => ({ available: true, character: { ...state.local } }),
    inventorySnapshot: () => ({
      available: true,
      capacity: slots.capacity,
      usedSlots: state.rows.length,
      freeSlots: slots.freeSlots,
      items: state.rows.map(item => JSON.parse(JSON.stringify(item)))
    }),
    visiblePlayers: () => {
      const rows = [];
      if (options.hideFarmer !== true) rows.push({ ...farmer });
      if (options.includeForeign === true) rows.push({ ...foreign });
      if (String(local.ctype) !== 'merchant' && options.hideMerchant !== true) {
        rows.push({ name: 'My_Merchant', ctype: 'merchant', map: 'main', x: 30, y: 0, distance: 30 });
      }
      return rows;
    },
    playerCondition: (name, id) => {
      const key = String(name) + ':' + String(id);
      const current = state.conditions[key];
      return current || { available: true, playerName: name, conditionId: id, active: false, remainingMs: null, source: null };
    },
    skillReadiness: (id, target) => ({
      available: id === 'mluck',
      allowed: id === 'mluck',
      skillId: id,
      target,
      reasons: [],
      definition: { id: 'mluck', range: 320 }
    })
  };

  const roster = {
    status: () => ({
      local: { name: local.name, ctype: local.ctype },
      characters: [
        { name: 'My_Merchant', ctype: 'merchant', online: true },
        { name: 'My_Ranger', ctype: 'ranger', online: true }
      ],
      farmers: [{ name: 'My_Ranger', ctype: 'ranger', online: true }],
      merchant: { name: 'My_Merchant', ctype: 'merchant', online: true }
    })
  };

  const movement = {
    status: () => state.movement || { active: false, activeOrder: null },
    moveLocal: (x, y, opts) => {
      state.movement = { active: true, activeOrder: { owner: opts.owner, destination: { map: 'main', x, y } } };
      return { accepted: true, order: state.movement.activeOrder };
    },
    smartMove: (destination, opts) => {
      state.movement = { active: true, activeOrder: { owner: opts.owner, destination } };
      return { accepted: true, order: state.movement.activeOrder };
    },
    cancel: () => {
      state.movement = null;
      return { cancelled: true };
    }
  };

  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: [...args] });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.rejectPromise) return { state: 'DISPATCHED', value: Promise.reject(new Error('NETWORK_UNCERTAIN')) };
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      if (name === 'send_item' && options.noTransferMutation !== true) {
        const slot = Number(args[1]);
        const qty = Number(args[2]);
        const item = state.rows.find(candidate => Number(candidate.slot) === slot);
        if (item) {
          item.quantity -= qty;
          if (item.quantity <= 0) state.rows = state.rows.filter(candidate => Number(candidate.slot) !== slot);
        }
      }
      if (name === 'use_skill' && args[0] === 'mluck' && options.noMluckMutation !== true) {
        state.conditions[String(args[1]) + ':mluck'] = {
          available: true, playerName: args[1], conditionId: 'mluck', active: true,
          remainingMs: 60_000, source: local.name
        };
      }
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(merchantSource, ctx, { filename: 'merchant.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.MerchantController;
  const controller = new Controller({
    root: ctx,
    game,
    actions,
    roster,
    movement,
    inventory,
    transferRange: options.transferRange == null ? 320 : options.transferRange,
    switchCooldownMs: options.switchCooldownMs == null ? 500 : options.switchCooldownMs
  });
  controller.start({ scope: { interval: () => 'merchant-resource' } });
  return { controller, state, game, inventory, roster, movement, actions };
}

test('H11 merchant plan uses only owned farmers and safe transfer candidates', () => {
  const f = fixture({ includeForeign: true });
  const plan = f.controller.plan();
  assert.equal(plan.role, 'MERCHANT');
  assert.deepEqual(Array.from(plan.visibleOwnedFarmers, row => row.name), ['My_Ranger']);
  assert.ok(plan.handoffCandidates.some(item => item.name === 'hpot0'));
  assert.ok(plan.handoffCandidates.some(item => item.name === 'material'));
  assert.equal(plan.handoffCandidates.some(item => item.name === 'sword'), false);
  assert.equal(plan.handoffCandidates.some(item => item.name === 'questitem'), false);
});

test('H11 delivery queue fails closed for foreign targets and protected items', () => {
  const f = fixture();
  const foreign = f.controller.queueDelivery('Foreign', 'hpot0', 1);
  assert.equal(foreign.accepted, false);
  assert.equal(foreign.reason, 'H11_DELIVERY_TARGET_NOT_OWNED_FARMER');

  const protectedItem = f.controller.queueDelivery('My_Ranger', 'sword', 1);
  assert.equal(protectedItem.accepted, false);
  assert.equal(protectedItem.reason, 'H11_DELIVERY_ITEM_NOT_SAFE_OR_AVAILABLE');

  const tooMany = f.controller.queueDelivery('My_Ranger', 'hpot0', 999);
  assert.equal(tooMany.accepted, false);
  assert.equal(tooMany.reason, 'H11_DELIVERY_QUANTITY_UNAVAILABLE');
});

test('H11 controlled delivery dispatches through send_item and confirms local inventory delta', async () => {
  const f = fixture();
  const queued = f.controller.queueDelivery('My_Ranger', 'hpot0', 1);
  assert.equal(queued.accepted, true);

  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);
  assert.deepEqual(f.state.dispatches[0], { name: 'send_item', args: ['My_Ranger', 0, 1] });

  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.delivery, null);
  assert.equal(status.metrics.transfersConfirmed, 1);
  assert.ok(status.pending == null || status.pending.kind === 'MLUCK');
  assert.equal(f.state.rows.find(item => item.name === 'hpot0').quantity, 19);
});

test('H11 never-settling item transfer becomes UNKNOWN and is never blindly retried', () => {
  const f = fixture({ neverSettle: true, noTransferMutation: true });
  assert.equal(f.controller.queueDelivery('My_Ranger', 'hpot0', 1).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.dispatches.length, 1);

  f.controller.pending.deadlineAtMs = Date.now() - 1;
  const second = f.controller.tick();
  assert.equal(second.state, 'SUSPENDED');
  assert.equal(second.reason, 'H11_TRANSFER_UNVERIFIED_TIMEOUT');
  assert.equal(f.controller.status().metrics.transfersUnknown, 1);

  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H11 farmer inventory pressure hands off only a safe stack to the owned visible Merchant', async () => {
  const f = fixture({
    local: { name: 'My_Ranger', ctype: 'ranger', map: 'main', x: 0, y: 0, rip: false },
    slots: { capacity: 10, usedSlots: 8, freeSlots: 2 },
    inventoryRows: [
      row({
        slot: 0, name: 'material', quantity: 5, disposition: 'BANK',
        definition: { type: 'material', quest: false, upgrade: false, compound: false }
      }),
      row({
        slot: 1, name: 'sword', quantity: 1, disposition: 'PROTECT',
        definition: { type: 'weapon', quest: false, upgrade: true, compound: false }
      })
    ]
  });
  const plan = f.controller.plan();
  assert.equal(plan.role, 'FARMER');
  assert.equal(plan.pressure.state, 'CRITICAL');
  assert.equal(plan.service.type, 'HANDOFF');
  assert.equal(plan.service.targetName, 'My_Merchant');

  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[0], { name: 'send_item', args: ['My_Merchant', 0, 5] });
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.transfersConfirmed, 1);
});

test('H11 Merchant applies MLuck to an owned farmer and confirms the live condition', async () => {
  const f = fixture();
  const first = f.controller.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[0], { name: 'use_skill', args: ['mluck', 'My_Ranger'] });

  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.metrics.mluckConfirmed, 1);
  assert.equal(status.metrics.mluckUnknown, 0);
  assert.equal(f.game.playerCondition('My_Ranger', 'mluck').active, true);

  const before = f.state.dispatches.length;
  const next = f.controller.tick();
  assert.equal(next.state, 'READY');
  assert.equal(f.state.dispatches.length, before);
});

test('H11 source never performs sell, bank, exchange or gold transfer', () => {
  assert.match(merchantSource, /dispatch\('send_item'/);
  assert.match(merchantSource, /dispatch\('use_skill'/);
  assert.doesNotMatch(merchantSource, /dispatch\('send_gold'/);
  assert.doesNotMatch(merchantSource, /dispatch\('sell'/);
  assert.doesNotMatch(merchantSource, /dispatch\('bank_store'/);
  assert.doesNotMatch(merchantSource, /dispatch\('exchange'/);
});

test('H11 runtime, API, UI, build and ActionBoundary are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const adapter = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.MerchantController/);
  assert.match(runtime, /id: 'merchant'/);
  assert.match(runtime, /id: 'h11-merchant'/);
  assert.match(runtime, /H11_LIVE_TEST_REQUIRES_MERCHANT/);
  assert.match(entry, /0\.11\.0-h11/);
  assert.match(entry, /merchant:/);
  assert.match(entry, /runtime\.merchant\.queueDelivery/);
  assert.match(ui, /data-tab="merchant"/);
  assert.match(ui, /H11 Merchant-Grundbetrieb/);
  assert.match(build, /src\/merchant\.js/);
  assert.match(build, /AL Bot 0\.11\.0-h11/);
  assert.match(boundary, /send_item: Object\.freeze\(\{ publicName: 'send_item'/);
  assert.match(adapter, /playerCondition\(name, conditionId\)/);
  assert.equal(pkg.version, '0.11.0');
});
