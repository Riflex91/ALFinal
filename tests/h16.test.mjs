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
    bankCalls: []
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
    npcShopSources: name => options.npcSources && options.npcSources[name] ? clone(options.npcSources[name]) : []
  };

  const movement = {
    status: () => state.movement ? clone(state.movement) : { active: false, activeOrder: null },
    smartMove: (destination, opts) => {
      state.movement = { active: true, activeOrder: { owner: opts && opts.owner, destination } };
      return { accepted: true };
    },
    cancel: () => { state.movement = null; return { cancelled: true }; }
  };

  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
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
    queueWithdraw: (pack, slot) => {
      state.bankCalls.push({ pack, slot });
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
  const combat = { status: () => ({ active: !!options.combatActive, state: options.combatActive ? 'FIGHTING' : 'IDLE' }) };

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
    arrive: () => { state.movement = null; }
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

test('H16 confirms exchange only after observed source quantity delta', () => {
  const { controller, state, arrive } = fixture();
  assert.equal(controller.queueExchange(0).accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  arrive();
  assert.equal(controller.tick().accepted, true);
  controller.tick();
  const status = controller.status();
  assert.equal(status.metrics.exchangesDispatched, 1);
  assert.equal(status.metrics.exchangesConfirmed, 1);
  assert.equal(status.metrics.exchangesUnknown, 0);
  assert.equal(state.dispatches.length, 1);
  assert.equal(state.dispatches[0].name, 'exchange');
});

test('H16 quest and event exchange requires explicit opt-in', () => {
  const { controller } = fixture({ rows: [row({ slot: 0, name: 'eventtoken', quantity: 1 })] });
  const candidate = controller.exchangeCandidates()[0];
  assert.equal(candidate.safe, false);
  assert.equal(candidate.reason, 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN');
  assert.equal(controller.queueExchange(0).accepted, false);
  assert.equal(controller.queueExchange(0, { allowQuestEvent: true }).accepted, true);
});

test('H16 crafts with live input output and gold deltas', () => {
  const { controller, state, arrive } = fixture();
  const candidates = controller.craftCandidates();
  const cake = candidates.find(row => row.itemName === 'cake');
  assert.ok(cake);
  assert.equal(cake.safe, true);
  assert.equal(controller.queueCraft('cake').accepted, true);
  assert.equal(controller.tick().state, 'WAITING_TRAVEL');
  arrive();
  assert.equal(controller.tick().accepted, true);
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
  assert.deepEqual(plan.stages.map(row => [row.itemName, row.runs]), [['cocoon', 2]]);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].itemName, 'spidersilk');
  assert.equal(plan.missing[0].quantity, 2000);
  assert.equal(plan.totalCraftGold, 5000);
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

test('H16 material acquisition prefers mounted bank before trade', () => {
  const bank = {
    available: true,
    packs: [{ name: 'items0', items: [{ pack: 'items0', slot: 2, name: 'spidersilk', level: 0, quantity: 1000 }] }]
  };
  const { controller, state } = fixture({ bank });
  const result = controller.queueMaterialAcquire('spidersilk', 100);
  assert.equal(result.accepted, true);
  assert.equal(result.delegatedTo, 'bank');
  assert.equal(state.bankCalls.length, 1);
  assert.equal(state.tradeCalls.length, 0);
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
  const { controller, state, arrive } = fixture({ combatActive: true });
  assert.equal(controller.queueExchange(0).accepted, true);
  const tick = controller.tick();
  assert.equal(tick.state, 'BLOCKED');
  assert.equal(tick.reason, 'H16_COMBAT_ACTIVE');
  assert.equal(state.dispatches.length, 0);
  arrive();
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
