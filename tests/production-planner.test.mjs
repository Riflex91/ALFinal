import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function context() {
  const ctx = { console, Date, Map, Set, Object, Array, String, Number, Math, JSON,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText: value => String(value ?? '').trim() } } };
  ctx.globalThis = ctx;
  for (const name of ['gear-progression', 'production-planner', 'exchange-craft']) {
    vm.runInNewContext(fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8'), ctx, { filename: name });
  }
  return ctx;
}
function data() {
  return {
    items: {
      output: { type: 'ring', dex: 20 }, intermediate: { g: 50 }, ore: { g: 10 },
      ring: { type: 'ring', compound: { dex: 1 }, g: 10, grades: [2, 3] },
      sword: { type: 'weapon', wtype: 'sword', upgrade: { attack: 1 }, g: 10 },
      scroll0: { g: 5 }, cscroll0: { g: 5 }, old: { type: 'ring', dex: 1 }
    },
    craft: { output: { cost: 5, items: [[2, 'intermediate']] }, intermediate: { cost: 1, items: [[2, 'ore']] } },
    maps: { main: { npcs: [{ id: 'vendor', position: [1, 2] }] } },
    npcs: { vendor: { items: ['intermediate', 'ore', 'ring', 'sword', 'scroll0', 'cscroll0'] } },
    classes: { ranger: { mainhand: { bow: 1 }, offhand: {} } }
  };
}
function fixture(options = {}) {
  const ctx = context();
  const G = options.G || data();
  const character = { name: 'Merchant', ctype: 'merchant', gold: 10000, items: [], ...options.character };
  const planner = new ctx.__ALBOT_INTERNALS__.MerchantProductionPlanner({ goldReserve: 100, maxGoldCost: 10000, ...options.policy });
  const input = { character, gameData: G, ...options.input };
  return { ctx, G, character, planner, input, plan: (name = 'output', quantity = 1) => planner.planTarget(name, quantity, input) };
}
test('v3 graph chooses the cheaper recursive recipe and preserves vendor coordinates', () => {
  const { plan } = fixture();
  const graph = plan();
  assert.equal(graph.state, 'READY');
  assert.equal(graph.steps[0].kind, 'BUY');
  assert.equal(graph.steps[0].name, 'ore');
  assert.equal(graph.steps[0].quantity, 4);
  assert.equal(graph.steps[0].vendor.map, 'main');
  assert.equal(graph.totalGold, 47);
  assert.equal(graph.steps.at(-1).name, 'output');
  assert.equal(graph.actionAuthority, false);
  assert.equal(graph.liveExecutionAllowed, false);
});
test('output yield controls ingredient quantities and root craft count', () => {
  const { G, input, planner } = fixture();
  G.craft.output.q = 3;
  const graph = planner.planTarget('output', 4, input);
  assert.equal(graph.steps.filter(row => row.root).length, 2);
  assert.equal(graph.steps[0].quantity, 8);
  assert.equal(graph.totalGold, 94);
});
test('owned ingredients reduce the recursive cost quote instead of triggering an unnecessary purchase', () => {
  const { G, input, planner } = fixture({ character: { items: [{ name: 'ore', q: 4 }] } });
  G.items.intermediate.g = 5;
  const graph = planner.planTarget('output', 1, input);
  assert.equal(graph.steps.some(row => row.kind === 'BUY'), false);
  assert.equal(graph.totalGold, 7);
});
test('bank and recipe surplus is shared across repeated ingredient requirements exactly once', () => {
  const f = fixture({ character: { bank: { items0: [{ name: 'intermediate', q: 3 }] } } });
  f.G.craft.output.items = [[2, 'intermediate'], [2, 'intermediate']];
  const bank = f.plan();
  assert.equal(bank.steps.filter(row => row.kind === 'BANK_RETRIEVE').length, 1);
  assert.equal(bank.steps.find(row => row.kind === 'BUY').quantity, 2);
  assert.equal(bank.reservations['intermediate|0'], 4);
  f.character.bank = null;
  f.G.craft.intermediate.q = 3;
  const crafted = f.plan();
  assert.equal(crafted.steps.filter(row => row.name === 'intermediate' && row.kind === 'CRAFT').length, 2);
  assert.equal(crafted.steps.filter(row => row.name === 'ore' && row.kind === 'BUY').reduce((sum, row) => sum + row.quantity, 0), 4);
});
test('live inventory then exact bank stacks are used before buying', () => {
  const { plan } = fixture({ character: { items: [{ name: 'intermediate', q: 1 }], bank: {
    items0: [{ name: 'intermediate', q: 2, level: 0 }]
  } } });
  const graph = plan();
  assert.equal(graph.nextStep.kind, 'BANK_RETRIEVE');
  assert.equal(graph.nextStep.quantity, 2);
  assert.equal(graph.steps.some(row => row.kind === 'BUY'), false);
  assert.equal(graph.reservations['intermediate|0'], 2);
});
test('protected identities and external quantity reservations cannot supply a recipe', () => {
  for (const protection of [{ locked: true }, { p: { luck: 1 } }, { statType: 'dex' }, { giveaway: true }, { protected: true }]) {
    const graph = fixture({ character: { items: [{ name: 'intermediate', q: 2, ...protection }] } }).plan();
    assert.equal(graph.steps.some(row => row.kind === 'BUY'), true);
  }
  const graph = fixture({ character: { items: [{ name: 'intermediate', q: 2 }] }, input: { reservations: { 'intermediate|0': 2 } } }).plan();
  assert.equal(graph.steps.some(row => row.kind === 'BUY'), true);
});
test('compound and upgrade requirements use real lower-level inputs and never claim guaranteed outcomes', () => {
  for (const [name, count, kind] of [['ring', 3, 'COMPOUND_REQUIRED'], ['sword', 1, 'UPGRADE_REQUIRED']]) {
    const { G, input, planner } = fixture({ character: { items: Array.from({ length: count }, () => ({ name, level: 0 })) } });
    G.craft.output.items = [[1, name, 1]];
    const graph = planner.planTarget('output', 1, input);
    assert.equal(graph.state, 'BLOCKED');
    assert.equal(graph.nextStep.kind, kind);
    assert.equal(graph.nextStep.inputQuantity, count);
    assert.equal(graph.nextStep.fromLevel, 0);
    assert.equal(graph.nextStep.targetLevel, 1);
    assert.equal(graph.liveExecutionAllowed, false);
  }
});
test('buy lower-level mutation inputs first and replan before suggesting mutation', () => {
  const { G, input, planner } = fixture();
  G.craft.output.items = [[1, 'ring', 1]];
  const graph = planner.planTarget('output', 1, input);
  assert.equal(graph.nextStep.kind, 'BUY');
  assert.equal(graph.nextStep.name, 'ring');
  assert.equal(graph.nextStep.quantity, 3);
  assert.equal(graph.steps.some(row => row.kind === 'COMPOUND_REQUIRED'), false);
});
test('farm-only leaves expand through intermediate recipes instead of farming crafted items', () => {
  const { G, input, planner } = fixture();
  G.npcs.vendor.items = [];
  const graph = planner.planTarget('output', 1, input);
  assert.equal(graph.state, 'BLOCKED');
  assert.equal(graph.steps[0].kind, 'FARM_REQUIRED');
  assert.equal(graph.steps[0].name, 'ore');
  assert.equal(graph.nextStep, null);
});
test('cycles, depth, planning work, quantities and gold budgets fail closed', () => {
  const cyclic = fixture();
  cyclic.G.npcs.vendor.items = [];
  cyclic.G.craft.intermediate.items = [[1, 'output']];
  assert.equal(cyclic.plan().nextStep, null);
  assert.ok(cyclic.plan().blockers.some(row => row.reason === 'RECIPE_CYCLE'));
  const shallow = fixture({ policy: { maxDepth: 1 } });
  shallow.G.npcs.vendor.items = [];
  const depth = shallow.plan();
  assert.equal(depth.nextStep, null);
  assert.ok(depth.blockers.some(row => row.reason === 'MAX_RECIPE_DEPTH'));
  const bounded = fixture({ policy: { maxSteps: 1 } }).plan();
  assert.equal(bounded.nextStep, null);
  assert.equal(bounded.blockers[0].reason, 'PRODUCTION_PLANNING_LIMIT');
  for (const quantity of [0, -1, 1.2, NaN, 100000]) assert.equal(fixture().plan('output', quantity).state, 'HOLD');
  const budget = fixture({ policy: { maxGoldCost: 1 } }).plan();
  assert.equal(budget.nextStep, null);
  assert.ok(budget.blockers.some(row => row.reason === 'PRODUCTION_GOLD_COST_OVER_BUDGET'));
  const reserve = fixture({ character: { gold: 110 } }).plan();
  assert.equal(reserve.nextStep, null);
  assert.ok(reserve.blockers.some(row => row.reason === 'GOLD_RESERVE_WOULD_BE_BREACHED'));
});
test('quest recipes require explicit opt-in and dead/non-merchant/busy inputs hold', () => {
  const f = fixture();
  f.G.craft.intermediate.quest = 'baker';
  assert.equal(f.plan().nextStep, null);
  f.input.allowQuestEvent = true;
  assert.equal(f.plan().state, 'READY');
  for (const options of [{ character: { ctype: 'ranger' } }, { character: { rip: true } }, { input: { controlledBusy: true } }]) {
    assert.equal(fixture(options).plan().state, 'HOLD');
  }
});
test('gear planning uses ALFinal coat slots, trusted offline equipment and weapon restrictions', () => {
  const { G, input, planner } = fixture();
  G.items.output = { type: 'chest', armor: 100 };
  input.registry = { characters: [{ name: 'Ranger', ctype: 'ranger', level: 60,
    equipmentKnown: true, online: false, gear: { ring1: { name: 'old' } } }] };
  assert.equal(planner.plan(input).target.slot, 'coat');
  input.registry.characters[0].equipmentKnown = false;
  assert.equal(planner.plan(input).state, 'HOLD');
  input.registry.characters[0].equipmentKnown = true;
  G.items.output = { type: 'weapon', wtype: 'sword', attack: 100 };
  assert.equal(planner.plan(input).state, 'HOLD');
});
test('planning inputs are immutable and exchange demands cannot reopen expired event work', () => {
  const { G, input, planner } = fixture({ character: { items: [{ name: 'ore', q: 20 }] } });
  G.items.ore.e = 10;
  const original = JSON.stringify(input);
  planner.planTarget('output', 1, input);
  assert.equal(JSON.stringify(input), original);
  const expired = planner.planExchange({ ...input, exchangeDemands: [{ item: 'ore', reason: 'PRODUCTION_MATERIAL', eventKey: 'event' }],
    eventState: { event: { active: true, expiresAt: 1 } } });
  assert.equal(expired, null);
});
test('ALFinal production API reads live snapshots and performs no controller or gameplay writes', () => {
  const { ctx, G } = fixture();
  let writes = 0;
  const rows = [{ slot: 2, name: 'intermediate', level: 0, quantity: 2 }];
  const controller = new ctx.__ALBOT_INTERNALS__.ExchangeCraftController({
    game: { productionData: () => G,
      snapshot: () => ({ available: true, character: { name: 'Merchant', ctype: 'merchant', gold: 10000 } }),
      inventorySnapshot: () => ({ available: true, items: rows }), bankSnapshot: () => ({ available: false }) },
    actions: { dispatch: () => { writes++; } },
    trade: { queueAcquire: () => { writes++; } },
    getProductionProfiles: () => [{ name: 'Ranger', ctype: 'ranger', level: 60, equipmentKnown: true,
      equipment: { ring1: { name: 'old' } } }], goldReserve: 100, maxCraftGoldCost: 10000
  });
  assert.equal(controller.productionGraph('output', 1).state, 'READY');
  assert.equal(controller.productionGear().state, 'READY');
  rows[0].locked = true;
  assert.equal(controller.productionGraph('output', 1).steps[0].kind, 'BUY');
  controller.suspendedReason = 'UNRESOLVED_SETTLEMENT';
  assert.equal(controller.productionGraph('output', 1).state, 'HOLD');
  assert.equal(writes, 0);
});
test('ALFinal adapter preserves bank reservations, inventory rules and marks unknown bank knowledge', () => {
  const { ctx, G } = fixture();
  const controller = new ctx.__ALBOT_INTERNALS__.ExchangeCraftController({
    game: { productionData: () => G,
      snapshot: () => ({ available: true, character: { name: 'Merchant', ctype: 'merchant', gold: 10000 } }),
      inventorySnapshot: () => ({ available: true, items: [] }),
      bankSnapshot: () => ({ available: true, map: 'bank', packs: [{ name: 'items0', map: 'bank',
        items: [{ slot: 0, name: 'intermediate', quantity: 2, level: 0 }] }] }) },
    bank: { status: () => ({ reservations: { intermediate: 1 } }) },
    goldReserve: 100, maxCraftGoldCost: 10000
  });
  let graph = controller.productionGraph('output', 1);
  assert.equal(graph.steps.some(row => row.kind === 'BANK_RETRIEVE'), false);
  controller.bank = { status: () => ({ reservations: {} }) };
  graph = controller.productionGraph('output', 1);
  assert.equal(graph.nextStep.kind, 'BANK_RETRIEVE');
  assert.equal(graph.nextStep.withdrawable, true);
  controller.inventory = { status: () => ({ rules: { reserveNames: ['intermediate'] } }) };
  assert.equal(controller.productionGraph('output', 1).steps.some(row => row.kind === 'BANK_RETRIEVE'), false);
  controller.inventory = { gearProgression: { reservationForItem: item => item.name === 'intermediate' ? { targetCharacter: 'Ranger' } : null } };
  assert.equal(controller.productionGraph('output', 1).steps.some(row => row.kind === 'BANK_RETRIEVE'), false);
  assert.equal(controller.productionGraph('output', 1, { includeBank: false }).bankKnowledge, 'EXCLUDED');
});
test('generated ALFinal bundle exposes the planner with its real game adapter and no autostart', () => {
  const G = data();
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} }, Date, Map, Set, Promise, Object, Array, String, Number, Math, JSON,
    setInterval, clearInterval, setTimeout, clearTimeout,
    __ALBOT_DISABLE_AUTOSTART__: true,
    character: { name: 'Merchant', ctype: 'merchant', gold: 100000, hp: 100, max_hp: 100, map: 'main', x: 0, y: 0,
      items: [{ name: 'intermediate', q: 2 }], slots: { ring1: { name: 'old' } } },
    G, get_characters: () => [{ name: 'Merchant', ctype: 'merchant', level: 60, online: true }],
    get_active_characters: () => ({ Merchant: 'self' })
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../dist/al-bot.js', import.meta.url), 'utf8'), ctx);
  assert.equal(ctx.ALBot.version, '0.26.66-h26');
  assert.equal(ctx.ALBot.status().running, false);
  const plan = ctx.ALBot.exchangeCraft.productionGraph('output', 1, { includeBank: false });
  assert.equal(plan.state, 'READY');
  assert.equal(plan.nextStep.kind, 'CRAFT');
  assert.equal(plan.totalGold, 5);
  assert.equal(plan.bankKnowledge, 'EXCLUDED');
  assert.equal(ctx.ALBot.status().actions.metrics.dispatched, 0);
});
