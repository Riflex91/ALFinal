import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/exchange-craft.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function row(overrides = {}) {
  return {
    slot: 0, name: 'gem0', quantity: 5, level: 0, statType: null,
    locked: false, giveaway: false, gift: false, property: null, expiresAt: null,
    ...overrides
  };
}

const definitions = {
  gem0: { id: 'gem0', name: 'Raw Emerald', type: 'material', g: 100, e: 5, upgrade: false, compound: false, cash: false, quest: false },
  gem1: { id: 'gem1', name: 'Polished Emerald', type: 'material', g: 200, e: 2, upgrade: false, compound: false, cash: false, quest: false },
  eventtoken: { id: 'eventtoken', name: 'Event Token', type: 'quest', g: 10, e: 1, upgrade: false, compound: false, cash: false, quest: true },
  whiteegg: { id: 'whiteegg', name: 'White Egg', type: 'material', g: 10, e: null, upgrade: false, compound: false, cash: false, quest: false },
  cake: { id: 'cake', name: 'Cake', type: 'elixir', g: 100, e: null, upgrade: false, compound: false, cash: false, quest: false },
  cocoon: { id: 'cocoon', name: 'Cocoon', type: 'material', g: 500, e: null, upgrade: false, compound: false, cash: false, quest: false },
  spidersilk: { id: 'spidersilk', name: 'Spider Silk', type: 'material', g: 5, e: null, upgrade: false, compound: false, cash: false, quest: false }
};

const recipes = {
  cake: {
    name: 'cake', output: definitions.cake,
    items: [{ quantity: 10, name: 'whiteegg', level: 0 }],
    cost: 5, quest: null
  },
  cocoon: {
    name: 'cocoon', output: definitions.cocoon,
    items: [{ quantity: 1000, name: 'spidersilk', level: 0 }],
    cost: 2500, quest: null
  }
};

function fixture(options = {}) {
  const state = {
    character: { name: 'My_Merchant', ctype: 'merchant', rip: false, map: 'main', x: 0, y: 0, gold: options.gold == null ? 100000 : options.gold },
    rows: clone(options.rows || [
      row({ slot: 0, name: 'gem0', quantity: 5 }),
      row({ slot: 1, name: 'whiteegg', quantity: 10 })
    ]),
    movement: null,
    dispatches: [],
    bank: clone(options.bank || null),
    tradeCalls: [],
    bankCalls: [],
    combatActive: !!options.combatActive
  };

  const inventorySnapshot = () => ({
    available: true,
    capacity: 20,
    usedSlots: state.rows.length,
    freeSlots: 20 - state.rows.length,
    items: clone(state.rows)
  });

  const find = (name, level = 0) => state.rows.find(item =>
    item && item.name === name && Number(item.level || 0) === Number(level || 0));

  const decrement = (name, level, q) => {
    const item = find(name, level);
    assert.ok(item);
    const next = Math.max(1, Number(item.quantity) || 1) - q;
    if (next > 0) item.quantity = next;
    else state.rows = state.rows.filter(row => row !== item);
  };

  const add = (name, level = 0, q = 1) => {
    const existing = find(name, level);
    if (existing) existing.quantity = Math.max(1, Number(existing.quantity) || 1) + q;
    else {
      const occupied = new Set(state.rows.map(item => Number(item.slot)));
      let slot = 0;
      while (occupied.has(slot)) slot += 1;
      state.rows.push(row({ slot, name, level, quantity: q }));
    }
  };

  const game = {
    snapshot: () => ({ available: true, character: clone(state.character) }),
    inventorySnapshot,
    bankSnapshot: () => state.bank ? clone(state.bank) : { available: false, reason: 'BANK_NOT_MOUNTED', packs: [] },
    itemDefinition: name => definitions[name] ? clone(definitions[name]) : null,
    craftDefinition: name => recipes[name] ? clone(recipes[name]) : null,
    craftCatalog: () => Object.values(recipes).map(clone),
    npcShopSources: name => options.npcSources && options.npcSources[name] ? clone(options.npcSources[name]) : [],
    npcLocation: npcId => ({
      npcId,
      map: 'main',
      x: npcId === 'craftsman' ? 100 : 200,
      y: npcId === 'craftsman' ? 50 : 75
    })
  };

  state.movement = { active: false, activeOrder: null, lastOrder: null };
  let movementSequence = 0;
  const movement = {
    status: () => clone(state.movement),
    smartMove: (destination, opts) => {
      const order = { id: 'move-' + (++movementSequence), owner: opts && opts.owner, destination: clone(destination), state: 'ACTIVE' };
      state.movement = { active: true, activeOrder: order, lastOrder: state.movement.lastOrder || null };
      return { accepted: true, order: clone(order) };
    },
    cancel: reason => {
      const active = state.movement.activeOrder;
      state.movement = {
        active: false,
        activeOrder: null,
        lastOrder: active ? { ...clone(active), state: 'CANCELLED', reason: reason || 'CANCELLED' } : state.movement.lastOrder
      };
      return { cancelled: !!active };
    }
  };

  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.rejectPromise) return { state: 'DISPATCHED', value: Promise.reject(new Error('PROMISE_REJECTED_AFTER_DISPATCH')) };
      if (name === 'exchange' && options.noMutation !== true) {
        const slot = Number(args[0]);
        const item = state.rows.find(r => Number(r.slot) === slot);
        assert.ok(item);
        const def = definitions[item.name];
        decrement(item.name, item.level, def.e);
        add('reward', 0, 1);
      }
      if (name === 'auto_craft' && options.noMutation !== true) {
        const target = args[0];
        const recipe = recipes[target];
        assert.ok(recipe);
        for (const ingredient of recipe.items) decrement(ingredient.name, ingredient.level || 0, ingredient.quantity);
        state.character.gold -= recipe.cost;
        add(target, 0, 1);
      }
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      return { state: 'DISPATCHED', value: Promise.resolve(name === 'exchange' ? { success: true, reward: 'reward' } : { success: true }) };
    }
  };

  const bank = {
    status: () => ({ reservations: clone(options.bankReservations || {}) }),
    queueWithdraw: (pack, slot) => {
      state.bankCalls.push({ pack, slot });
      if (typeof options.bankWithdraw === 'function') return options.bankWithdraw(pack, slot);
      return { accepted: true, request: { kind: 'WITHDRAW' } };
    }
  };
  const trade = {
    marketAnalysis: name => ({ available: true, bestAsk: options.bestAsk ? clone(options.bestAsk) : null, asks: [], bids: [] }),
    queueAcquire: (name, quantity, opts) => {
      state.tradeCalls.push({ name, quantity, opts: clone(opts) });
      return { accepted: true, request: { kind: 'NPC_BUY' } };
    }
  };
  const combat = { status: () => ({ active: !!state.combatActive, state: state.combatActive ? 'FIGHTING' : 'IDLE' }) };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error, setTimeout,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'exchange-craft.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.ExchangeCraftController;
  const controller = new Controller({
    root: ctx, game, actions, movement, bank, trade, combat,
    outcomeTimeoutMs: options.outcomeTimeoutMs || 500,
    maxExchangeValueAtRisk: options.maxExchangeValueAtRisk,
    maxCraftGoldCost: options.maxCraftGoldCost,
    maxCraftInputValueAtRisk: options.maxCraftInputValueAtRisk,
    goldReserve: options.goldReserve == null ? 1000 : options.goldReserve,
    allowQuestEvent: options.allowQuestEvent
  });
  controller.start({});

  return {
    controller, state, game,
    arrive: () => {
      const active = state.movement.activeOrder;
      assert.ok(active);
      state.movement = {
        active: false,
        activeOrder: null,
        lastOrder: { ...clone(active), state: 'COMPLETED', reason: 'ARRIVAL_VERIFIED' }
      };
    }
  };
}

test('H16 detects a safe exchange candidate from live e quantity', () => {
  const { controller } = fixture();
  const candidates = controller.exchangeCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].itemName, 'gem0');
  assert.equal(candidates[0].requiredQuantity, 5);
  assert.equal(candidates[0].safe, true);
  assert.equal(candidates[0].valueAtRisk, 500);
});

test('H16 confirms exchange only after observed source quantity delta and settled dispatch', async () => {
  const { controller, state, arrive } = fixture();
  assert.equal(controller.queueExchange(0).accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  arrive();
  assert.equal(controller.tick().accepted, true);
  await Promise.resolve();
  controller.tick();
  const status = controller.status();
  assert.equal(status.metrics.exchangesDispatched, 1);
  assert.equal(status.metrics.exchangesConfirmed, 1);
  assert.equal(status.metrics.exchangesUnknown, 0);
  assert.equal(state.dispatches.length, 1);
  assert.equal(state.dispatches[0].name, 'exchange');
});

test('H16 retains exchange ownership while live delta is visible but dispatch settlement is pending', () => {
  const { controller, state, arrive } = fixture({ neverSettle: true });
  assert.equal(controller.queueExchange(0).accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  arrive();
  assert.equal(controller.tick().accepted, true);

  const held = controller.tick();
  const status = controller.status();
  assert.equal(held.state, 'PENDING');
  assert.ok(status.pending);
  assert.equal(status.pending.settlement, 'PENDING');
  assert.equal(status.metrics.exchangesConfirmed, 0);
  assert.equal(status.metrics.exchangesUnknown, 0);
  assert.equal(state.dispatches.length, 1);
});

test('H16 observes the exact exchange item level instead of assuming level zero', async () => {
  const { controller, state, arrive } = fixture({
    rows: [row({ slot: 0, name: 'gem1', quantity: 2, level: 2 })]
  });
  assert.equal(controller.queueExchange(0).accepted, true);
  controller.tick();
  arrive();
  assert.equal(controller.tick().accepted, true);
  await Promise.resolve();
  controller.tick();
  assert.equal(controller.status().metrics.exchangesConfirmed, 1);
  assert.equal(controller.status().metrics.exchangesUnknown, 0);
  assert.equal(state.dispatches.length, 1);
});

test('H16 quest and event exchange requires explicit opt-in', () => {
  const { controller } = fixture({ rows: [row({ slot: 0, name: 'eventtoken', quantity: 1 })] });
  const candidate = controller.exchangeCandidates()[0];
  assert.equal(candidate.safe, false);
  assert.equal(candidate.reason, 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN');
  assert.equal(controller.queueExchange(0).accepted, false);
  assert.equal(controller.queueExchange(0, { allowQuestEvent: true }).accepted, true);
});

test('H16 crafts with live input output and gold deltas after dispatch settlement', async () => {
  const { controller, state, arrive } = fixture();
  const candidates = controller.craftCandidates();
  const cake = candidates.find(row => row.itemName === 'cake');
  assert.ok(cake);
  assert.equal(cake.safe, true);
  assert.equal(controller.queueCraft('cake').accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  arrive();
  assert.equal(controller.tick().accepted, true);
  await Promise.resolve();
  controller.tick();
  const status = controller.status();
  assert.equal(status.metrics.craftsDispatched, 1);
  assert.equal(status.metrics.craftsConfirmed, 1);
  assert.equal(status.metrics.craftsUnknown, 0);
  assert.equal(state.rows.some(row => row.name === 'cake'), true);
  assert.equal(state.rows.some(row => row.name === 'whiteegg'), false);
  assert.equal(state.character.gold, 99995);
});

test('H16 blocks auto craft when the first matching source is protected', () => {
  const { controller } = fixture({
    rows: [
      row({ slot: 0, name: 'whiteegg', quantity: 10, locked: true }),
      row({ slot: 1, name: 'whiteegg', quantity: 10 })
    ]
  });
  const result = controller.queueCraft('cake');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H16_CRAFT_AUTO_SOURCE_PROTECTED');
});

test('H16 production graph expands nested recipes and reports missing leaves', () => {
  const { controller } = fixture({ rows: [] });
  const plan = controller.productionPlan('cocoon', 2, { includeBank: false });
  assert.equal(plan.state, 'NEEDS_MATERIALS');
  assert.equal(JSON.stringify(plan.stages.map(row => [row.itemName, row.runs])), JSON.stringify([['cocoon', 2]]));
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].itemName, 'spidersilk');
  assert.equal(plan.missing[0].quantity, 2000);
  assert.equal(plan.totalCraftGold, 5000);
});

test('H16 production READY requires craft cost plus configured gold reserve', () => {
  const rows = [row({ slot: 0, name: 'spidersilk', quantity: 1000 })];
  const blocked = fixture({ rows, gold: 1000, goldReserve: 1000 }).controller.productionPlan('cocoon', 1, { includeBank: false });
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H16_PRODUCTION_GOLD_RESERVE_BLOCKED');
  assert.equal(blocked.totalCraftGold, 2500);
  assert.equal(blocked.gold, 1000);
  assert.equal(blocked.goldReserve, 1000);

  const funded = fixture({ rows, gold: 3500, goldReserve: 1000 }).controller.productionPlan('cocoon', 1, { includeBank: false });
  assert.equal(funded.state, 'READY');
  assert.equal(funded.reason, 'H16_PRODUCTION_READY');
});

test('H16 production graph consumes mounted bank stock before declaring missing material', () => {
  const bank = {
    available: true,
    packs: [{ name: 'items0', items: [{ pack: 'items0', slot: 0, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller } = fixture({ rows: [], bank });
  const plan = controller.productionPlan('cocoon', 1);
  assert.equal(plan.state, 'READY');
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.stages[0].itemName, 'cocoon');
});

test('H16 rejects invalid material acquisition quantities without bank or trade writes', () => {
  const bank = {
    available: true,
    packs: [{ name: 'items0', items: [{ pack: 'items0', slot: 1, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller, state } = fixture({ bank });
  for (const quantity of [0, -1, 1.5, 'not-a-number']) {
    const result = controller.queueMaterialAcquire('spidersilk', quantity, { maxUnitPrice: 50 });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'H16_MATERIAL_QUANTITY_INVALID');
  }
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.tradeCalls.length, 0);
});

test('H16 material acquisition skips a recoverably unusable bank stack and uses a later valid stack', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [
      { name: 'items0', map: 'bank', items: [{ pack: 'items0', slot: 1, name: 'spidersilk', level: 0, quantity: 1000 }] },
      { name: 'items1', map: 'bank', items: [{ pack: 'items1', slot: 2, name: 'spidersilk', level: 0, quantity: 1000 }] }
    ]
  };
  const { controller, state } = fixture({
    bank,
    bankWithdraw: (pack, slot) => pack === 'items0'
      ? { accepted: false, reason: 'H12_BANK_RESERVATION_BLOCKED' }
      : { accepted: true, request: { kind: 'WITHDRAW', pack, slot } }
  });
  const result = controller.queueMaterialAcquire('spidersilk', 100);
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'bank');
  assert.equal(result.source.pack, 'items1');
  assert.equal(result.source.slot, 2);
  assert.equal(state.bankCalls.length, 2);
  assert.equal(state.tradeCalls.length, 0);
});

test('H16 material acquisition stops on a non-recoverable bank rejection instead of racing trade', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{ name: 'items0', map: 'bank', items: [{ pack: 'items0', slot: 1, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller, state } = fixture({
    bank,
    bankWithdraw: () => ({ accepted: false, reason: 'H12_BUSY' })
  });
  const result = controller.queueMaterialAcquire('spidersilk', 100, { maxUnitPrice: 50 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H12_BUSY');
  assert.equal(result.delegatedTo, 'bank');
  assert.equal(state.bankCalls.length, 1);
  assert.equal(state.tradeCalls.length, 0);
});

test('H16 material acquisition prefers mounted bank before trade', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{ name: 'items0', map: 'bank', items: [{ pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller, state } = fixture({ bank });
  const result = controller.queueMaterialAcquire('spidersilk', 100);
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'bank');
  assert.equal(state.bankCalls.length, 1);
  assert.equal(state.tradeCalls.length, 0);
});

test('H16 material acquisition can explicitly bypass mounted bank for live-test trade evidence', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{ name: 'items0', map: 'bank', items: [{ pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller, state } = fixture({ bank });
  const result = controller.queueMaterialAcquire('spidersilk', 100, { maxUnitPrice: 50, allowBank: false });
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'trade');
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.tradeCalls.length, 1);
});

test('H16 production plan exposes mounted bank rows while includeBank false keeps them as acquisition needs', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{ name: 'items0', map: 'bank', items: [{ pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller } = fixture({ rows: [], bank });
  const plan = controller.productionPlan('cocoon', 1, { includeBank: false });
  assert.equal(plan.state, 'NEEDS_MATERIALS');
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].itemName, 'spidersilk');
  assert.equal(plan.missing[0].bankRows.length, 1);
  assert.equal(plan.missing[0].bankRows[0].pack, 'items0');
  assert.equal(plan.missing[0].bankRows[0].map, 'bank');
  assert.equal(plan.missing[0].bankRows[0].quantity, 1000);
  assert.equal(plan.missing[0].bankRows[0].safe, true);
  assert.equal(plan.missing[0].bankRows[0].mountedMapMatch, true);
  assert.equal(plan.missing[0].bankRows[0].withdrawable, true);
});

test('H16 material acquisition ignores protected bank stacks and uses a safe stack', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{
      name: 'items0',
      map: 'bank',
      items: [
        { pack: 'items0', slot: 1, name: 'spidersilk', level: 0, quantity: 1000, locked: true },
        { pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 1000, locked: false }
      ]
    }]
  };
  const { controller, state } = fixture({ bank });
  const result = controller.queueMaterialAcquire('spidersilk', 100);
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'bank');
  assert.deepEqual(state.bankCalls, [{ pack: 'items0', slot: 2 }]);
  assert.equal(state.tradeCalls.length, 0);
});

test('H16 bank reservations make reserved stacks non-withdrawable and preserve trade fallback', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{
      name: 'items0',
      map: 'bank',
      items: [{ pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 1000 }]
    }]
  };
  const { controller, state } = fixture({
    rows: [],
    bank,
    bankReservations: { spidersilk: 1000 },
    bestAsk: { playerName: 'Seller', slot: 'trade1', name: 'spidersilk', level: 0, quantity: 1000, price: 7 }
  });
  const plan = controller.productionPlan('cocoon', 1, { includeBank: false });
  assert.equal(plan.missing[0].bankRows[0].reservedQuantity, 1000);
  assert.equal(plan.missing[0].bankRows[0].remainingAfterWholeStack, 0);
  assert.equal(plan.missing[0].bankRows[0].withdrawable, false);

  const result = controller.queueMaterialAcquire('spidersilk', 100, { maxUnitPrice: 7 });
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'trade');
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.tradeCalls.length, 1);
});

test('H16 material acquisition skips a deficit-sized bank stack when craft needs one larger stack', () => {
  const bank = {
    available: true,
    map: 'bank',
    packs: [{
      name: 'items0',
      map: 'bank',
      items: [{ pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 500 }]
    }]
  };
  const { controller, state } = fixture({
    bank,
    bestAsk: { playerName: 'Seller', slot: 'trade1', name: 'spidersilk', level: 0, quantity: 1000, price: 7 }
  });
  const result = controller.queueMaterialAcquire('spidersilk', 500, {
    maxUnitPrice: 7,
    minBankStackQuantity: 1000
  });
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'trade');
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.tradeCalls.length, 1);
});

test('H16 production plan exposes NPC and market acquisition sources for missing leaves', () => {
  const { controller } = fixture({
    rows: [],
    npcSources: {
      spidersilk: [{ npcId: 'materials', name: 'Materials', location: { map: 'main', x: 10, y: 20 } }]
    },
    bestAsk: { playerName: 'Seller', slot: 'trade1', name: 'spidersilk', level: 0, quantity: 1000, price: 7 }
  });
  const plan = controller.productionPlan('cocoon', 1, { includeBank: false });
  assert.equal(plan.state, 'NEEDS_MATERIALS');
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].itemName, 'spidersilk');
  assert.equal(plan.missing[0].npcSources.length, 1);
  assert.equal(plan.missing[0].bestMarketAsk.price, 7);
});

test('H16 material acquisition delegates to H13 trade with explicit price ceiling', () => {
  const { controller, state } = fixture();
  const result = controller.queueMaterialAcquire('spidersilk', 100, { maxUnitPrice: 50 });
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'trade');
  assert.equal(state.tradeCalls.length, 1);
  assert.equal(state.tradeCalls[0].opts.maxUnitPrice, 50);
});

test('H16 blocks dispatch while combat is active', () => {
  const { controller, state } = fixture({ combatActive: true });
  assert.equal(controller.queueExchange(0).accepted, true);
  const tick = controller.tick();
  assert.equal(tick.state, 'BLOCKED');
  assert.equal(tick.reason, 'H16_COMBAT_ACTIVE');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.movement.active, false);
});

test('H16 cancels owned travel when combat starts after movement was launched', () => {
  const { controller, state } = fixture();
  assert.equal(controller.queueExchange(0).accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  assert.equal(state.movement.active, true);
  assert.equal(state.movement.activeOrder.owner, 'exchange-craft-h16');

  state.combatActive = true;
  const tick = controller.tick();
  assert.equal(tick.state, 'BLOCKED');
  assert.equal(tick.reason, 'H16_COMBAT_ACTIVE');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.movement.active, false);
  assert.equal(state.movement.lastOrder.state, 'CANCELLED');
});

test('H16 refuses to dispatch after owned movement is cancelled instead of verified complete', () => {
  const { controller, state } = fixture();
  assert.equal(controller.queueExchange(0).accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  const active = state.movement.activeOrder;
  assert.ok(active);
  state.movement = {
    active: false,
    activeOrder: null,
    lastOrder: { ...clone(active), state: 'CANCELLED', reason: 'MANUAL_CANCEL' }
  };
  const tick = controller.tick();
  assert.equal(tick.state, 'SUSPENDED');
  assert.equal(tick.reason, 'H16_MOVEMENT_CANCELLED');
  assert.equal(state.dispatches.length, 0);
});

test('H16 treats rejected dispatched promises as unknown without blind retry', async () => {
  const { controller, state, arrive } = fixture({ rejectPromise: true });
  assert.equal(controller.queueExchange(0).accepted, true);
  controller.tick();
  arrive();
  assert.equal(controller.tick().accepted, true);
  await Promise.resolve();
  await Promise.resolve();
  const tick = controller.tick();
  assert.equal(tick.state, 'SUSPENDED');
  assert.match(tick.reason, /PROMISE_REJECTED_AFTER_DISPATCH/);
  assert.equal(controller.status().metrics.exchangesUnknown, 1);
  assert.equal(state.dispatches.length, 1);
  assert.equal(controller.tick().state, 'SUSPENDED');
});

test('H16 suspends on synchronous unknown and does not blind retry', () => {
  const { controller, state, arrive } = fixture({ syncUnknown: true });
  assert.equal(controller.queueExchange(0).accepted, true);
  controller.tick();
  arrive();
  const first = controller.tick();
  assert.equal(first.state, 'SUSPENDED');
  const second = controller.tick();
  assert.equal(second.state, 'SUSPENDED');
  assert.equal(state.dispatches.length, 1);
  assert.equal(controller.status().metrics.exchangesUnknown, 1);
});


test('H16 runtime, API, UI, build, adapter and ActionBoundary are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const adapter = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  const dist = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.ExchangeCraftController/);
  assert.match(runtime, /id: 'exchange-craft'/);
  assert.match(runtime, /id: 'h16-exchange-craft'/);
  assert.match(runtime, /H16_NEEDS_LOW_RISK_CRAFT_OR_ACQUIRABLE_MATERIALS/);
  assert.match(runtime, /ACQUIRE_CRAFT_AND_EXCHANGE_COVERAGE/);
  assert.match(runtime, /allowBank: bankExpected/);
  assert.match(runtime, /maxExchangeValueAtRisk: 2000000/);
  assert.match(runtime, /maxCraftGoldCost: 1000000/);
  assert.match(runtime, /maxCraftInputValueAtRisk: 2000000/);
  assert.match(runtime, /version: '6'/);
  const h16SuiteStart = runtime.indexOf("    _registerH16LiveTest() {");
  assert.ok(h16SuiteStart > -1);
  const h16Suite = runtime.slice(h16SuiteStart);
  assert.match(h16Suite, /id: 'bank-discovery'/);
  assert.match(h16Suite, /runtime\.bank\.queueMount\(\)/);
  assert.match(h16Suite, /H16_BANK_DISCOVERY_WRITE_DETECTED/);
  assert.match(h16Suite, /H16_BANK_DISCOVERY_NOT_REQUIRED_FOR_NON_MERCHANT/);
  assert.doesNotMatch(h16Suite, /H16_BANK_DISCOVERY_REQUIRES_MERCHANT/);
  const bankDiscoveryStart = h16Suite.indexOf("id: 'bank-discovery'");
  const h16PreflightStart = h16Suite.indexOf("id: 'preflight'");
  const bankDiscovery = h16Suite.slice(bankDiscoveryStart, h16PreflightStart);
  assert.ok(bankDiscovery.indexOf("H16_BANK_DISCOVERY_NOT_REQUIRED_FOR_NON_MERCHANT") < bankDiscovery.indexOf("runtime.bank.queueMount()"));
  assert.ok(bankDiscoveryStart < h16PreflightStart);
  const h5Start = runtime.indexOf("id: 'h5-combat'");
  const h6Start = runtime.indexOf("id: 'h6-class-logic'");
  assert.ok(h5Start > -1 && h6Start > h5Start);
  assert.doesNotMatch(runtime.slice(h5Start, h6Start), /id: 'bank-discovery'/);
  assert.match(runtime, /localCraftRejects/);
  assert.match(runtime, /fallbackRejects/);
  assert.match(runtime, /topNearMatches: nearMatches\.slice\(0, 5\)/);
  assert.match(runtime, /buildPreflightDiagnostics/);
  assert.match(runtime, /note\(buildPreflightDiagnostics\(\)\)/);
  const finalPreflightFailIndex = runtime.indexOf("assert(selectedCraft && selectedExchange");
  assert.ok(finalPreflightFailIndex > -1);
  assert.ok(runtime.lastIndexOf("note(buildPreflightDiagnostics())", finalPreflightFailIndex) > -1);
  assert.match(runtime, /const recordLocalCraftReject/);
  assert.match(runtime, /H16_NEEDS_LOW_RISK_EXCHANGE_CANDIDATE/);
  assert.match(runtime, /PROTECTED_RECIPE_IN_PRODUCTION/);
  assert.match(runtime, /PRODUCTION_NOT_NEEDS_MATERIALS/);
  assert.ok(runtime.indexOf("PROTECTED_RECIPE_IN_PRODUCTION") < runtime.indexOf("PRODUCTION_NOT_NEEDS_MATERIALS"));
  assert.match(runtime, /missingItemName: row\.itemName/);
  const nearMatchBuilder = runtime.slice(
    runtime.indexOf("const recordFallbackReject"),
    runtime.indexOf("const buildPreflightDiagnostics")
  );
  assert.ok(nearMatchBuilder.indexOf("...details") < nearMatchBuilder.indexOf("itemName: recipe"));
  assert.match(runtime, /NESTED_OR_MULTI_STAGE_RECIPE/);
  assert.match(runtime, /TOO_MANY_MISSING_LEAVES/);
  assert.match(runtime, /MISSING_LEAF_LEVEL_NONZERO/);
  assert.match(runtime, /MISSING_LEAF_NO_BANK_NPC_OR_MARKET_SOURCE/);
  assert.match(runtime, /source: 'BANK'/);
  assert.match(runtime, /source\.withdrawable === true/);
  assert.match(runtime, /reservedQuantity/);
  assert.match(runtime, /remainingAfterWholeStack/);
  assert.match(runtime, /withdrawable: source\.withdrawable === true/);
  assert.match(runtime, /expectedSource: chosen\.source/);
  assert.match(source, /_bankMaterialRows\(name, level = 0\)/);
  assert.match(source, /safe: this\._safeItem\(row\)/);
  assert.match(source, /remainingAfterWholeStack >= reservedQuantity/);
  assert.match(source, /minBankStackQuantity/);
  assert.match(source, /row\.withdrawable === true && row\.quantity >= minBankStackQuantity/);
  assert.match(runtime, /recipeIngredientQuantity/);
  assert.match(runtime, /minBankStackQuantity: material\.minBankStackQuantity/);
  assert.match(runtime, /availableInventorySlots/);
  assert.match(runtime, /plannedBankWithdrawals/);
  assert.match(runtime, /bankSlotAvailable = plannedBankWithdrawals < availableInventorySlots/);
  assert.match(runtime, /if \(chosen\.source === 'BANK'\) plannedBankWithdrawals \+= 1/);
  assert.match(runtime, /inventorySlotReservation: chosen\.source === 'BANK' \? plannedBankWithdrawals : null/);
  const bankOfferStart = runtime.indexOf("const bankSlotAvailable = plannedBankWithdrawals < availableInventorySlots");
  const bankChoiceStart = runtime.indexOf("offers.sort((a, b) => a.unitPrice - b.unitPrice)", bankOfferStart);
  const bankReservationIncrement = runtime.indexOf("if (chosen.source === 'BANK') plannedBankWithdrawals += 1", bankChoiceStart);
  assert.ok(bankOfferStart > -1 && bankChoiceStart > bankOfferStart && bankReservationIncrement > bankChoiceStart);
  assert.match(runtime, /queued\.delegatedTo === \(bankExpected \? 'bank' : 'trade'\)/);
  assert.match(runtime, /MATERIAL_ACQUISITION_OVER_CAP/);
  assert.match(runtime, /GOLD_RESERVE_AFTER_ACQUISITION_AND_CRAFT/);
  assert.match(runtime, /MATERIAL_ACQUISITION_REQUIRES_MERCHANT/);
  assert.match(runtime, /MATERIAL_ACQUISITION_TRADE_SUSPENDED/);
  assert.match(runtime, /recordLocalCraftReject\(craft, 'NO_DISJOINT_EXCHANGE_CANDIDATE'/);
  assert.match(runtime, /acquisitionGold > 1000000/);
  assert.match(runtime, /materialAcquisitionGold <= 1000000/);
  assert.match(runtime, /outputRisk == null \|\| outputRisk > 2000000/);
  assert.match(runtime, /Number\(row\.cost \|\| 0\) <= 1000000/);
  assert.match(runtime, /Number\(row\.inputValueAtRisk \|\| 0\) <= 2000000/);
  assert.match(runtime, /Number\(row\.valueAtRisk \|\| 0\) <= 2000000/);
  assert.match(runtime, /if \(!current\.suspended\) runtime\.exchangeCraft\.resetSafety/);
  assert.match(runtime, /currentGold - totalEstimatedGold < 10000/);
  assert.match(runtime, /requiredGoldWithReserve/);
  assert.match(source, /H16_MATERIAL_QUANTITY_INVALID/);
  assert.match(source, /H16_PRODUCTION_GOLD_RESERVE_BLOCKED/);
  assert.match(source, /_cancelOwnedMovement\(gate\.reason/);
  assert.match(entry, /0\.26\.55-h26/);
  assert.match(entry, /exchangeCraft:/);
  assert.match(entry, /runtime\.exchangeCraft\.productionPlan/);
  assert.match(entry, /craftDefinition: name => runtime\.game\.craftDefinition/);
  assert.match(ui, /data-tab="exchange-craft"/);
  assert.match(ui, /H16 Exchange & Craft/);
  assert.match(build, /src\/exchange-craft\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.55-h26'/);
  assert.match(boundary, /exchange: Object\.freeze\(\{ publicName: 'exchange'/);
  assert.match(boundary, /auto_craft: Object\.freeze\(\{ publicName: 'auto_craft'/);
  assert.match(adapter, /craftDefinition\(name\)/);
  assert.match(adapter, /craftCatalog\(\)/);
  assert.match(dist, /AL Bot 0\.26\.55-h26/);
  assert.match(dist, /class ExchangeCraftController/);
  assert.equal(pkg.version, '0.26.55');
});
