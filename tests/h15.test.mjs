import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/upgrade.js'), 'utf8');
const actionBoundarySource = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function internals() {
  return {
    helpers: {
      clone,
      cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
    }
  };
}

const equipmentDefinitions = {
  sword: {
    id: 'sword', name: 'Sword', type: 'weapon', wtype: 'sword', classes: ['warrior'],
    stats: { attack: 10 }, upgradeGrowth: { attack: 2 }, upgradeable: true, compoundable: false,
    grades: [2, 4], g: 1000, cash: false, quest: false
  },
  ring: {
    id: 'ring', name: 'Ring', type: 'ring', wtype: null, classes: [],
    stats: { str: 1 }, upgradeGrowth: {}, upgradeable: false, compoundable: true,
    grades: [1, 3], g: 500, cash: false, quest: false
  },
  expensive: {
    id: 'expensive', name: 'Expensive', type: 'weapon', wtype: 'sword', classes: ['warrior'],
    stats: { attack: 30 }, upgradeGrowth: { attack: 4 }, upgradeable: true, compoundable: false,
    grades: [2, 4], g: 500000, cash: false, quest: false
  },
  quest_sword: {
    id: 'quest_sword', name: 'Quest Sword', type: 'weapon', wtype: 'sword', classes: ['warrior'],
    stats: { attack: 1 }, upgradeGrowth: { attack: 1 }, upgradeable: true, compoundable: false,
    grades: [2, 4], g: 10, cash: false, quest: true
  },
  cash_ring: {
    id: 'cash_ring', name: 'Cash Ring', type: 'ring', wtype: null, classes: [],
    stats: { int: 1 }, upgradeGrowth: {}, upgradeable: false, compoundable: true,
    grades: [1, 3], g: 0, cash: true, quest: false
  }
};

const itemDefinitions = {
  scroll0: { id: 'scroll0', name: 'Upgrade Scroll', type: 'uscroll', g: 1000 },
  scroll1: { id: 'scroll1', name: 'High Upgrade Scroll', type: 'uscroll', g: 40000 },
  scroll2: { id: 'scroll2', name: 'Rare Upgrade Scroll', type: 'uscroll', g: 160000 },
  cscroll0: { id: 'cscroll0', name: 'Compound Scroll', type: 'cscroll', g: 6400 },
  cscroll1: { id: 'cscroll1', name: 'High Compound Scroll', type: 'cscroll', g: 64000 },
  cscroll2: { id: 'cscroll2', name: 'Rare Compound Scroll', type: 'cscroll', g: 640000 },
  offeringp: { id: 'offeringp', name: 'Primordial Essence', type: 'offering', g: 50000 },
  offering: { id: 'offering', name: 'Offering', type: 'offering', g: 10000 }
};

function row(overrides = {}) {
  return {
    slot: 0,
    name: 'sword',
    quantity: 1,
    level: 0,
    statType: null,
    locked: false,
    giveaway: false,
    gift: false,
    property: null,
    expiresAt: null,
    ...overrides
  };
}

function fixture(options = {}) {
  const state = {
    character: {
      name: 'My_Merchant',
      ctype: 'merchant',
      rip: false,
      map: 'main',
      gold: 1000000
    },
    rows: clone(options.rows || [
      row({ slot: 0, name: 'sword', level: 0 }),
      row({ slot: 1, name: 'scroll0', quantity: 5 }),
      row({ slot: 2, name: 'ring', level: 0 }),
      row({ slot: 3, name: 'ring', level: 0 }),
      row({ slot: 4, name: 'ring', level: 0 }),
      row({ slot: 5, name: 'cscroll0', quantity: 5 }),
      row({ slot: 6, name: 'offeringp', quantity: 2 }),
      row({ slot: 7, name: 'sword', level: 0, locked: true })
    ]),
    dispatches: []
  };

  const inventorySnapshot = () => ({
    schemaVersion: 1,
    available: true,
    capacity: 20,
    usedSlots: state.rows.length,
    freeSlots: 20 - state.rows.length,
    items: clone(state.rows)
  });

  const at = slot => state.rows.find(item => Number(item.slot) === Number(slot)) || null;
  const removeAt = slot => {
    const index = state.rows.findIndex(item => Number(item.slot) === Number(slot));
    if (index < 0) return null;
    return state.rows.splice(index, 1)[0];
  };
  const decrement = slot => {
    const current = at(slot);
    assert.ok(current);
    const q = Math.max(1, Number(current.quantity) || 1);
    if (q > 1) current.quantity = q - 1;
    else removeAt(slot);
  };

  const game = {
    snapshot: () => ({ available: true, character: clone(state.character) }),
    inventorySnapshot,
    equipmentDefinition: name => equipmentDefinitions[name] ? clone(equipmentDefinitions[name]) : null,
    itemDefinition: name => itemDefinitions[name] ? clone(itemDefinitions[name]) : null
  };

  const actions = {
    previewMutation: options.serverRiskChance == null ? undefined : (name, args) => {
      state.previews = state.previews || [];
      state.previews.push({ name, args: clone(args) });
      if (options.serverRiskPreviewUnavailable) return { state: 'UNAVAILABLE', value: null };
      return {
        state: 'PREVIEWED',
        value: options.serverRiskPreviewReject
          ? Promise.reject(new Error('PREVIEW_FAILED'))
          : { chance: options.serverRiskChance }
      };
    },
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.noMutation !== true) {
        if (name === 'upgrade') {
          const [itemSlot, scrollSlot, offeringSlot] = args;
          const item = at(itemSlot);
          assert.ok(item);
          decrement(scrollSlot);
          if (offeringSlot != null) decrement(offeringSlot);
          if (options.upgradeFailure !== true) item.level = Math.max(0, Number(item.level) || 0) + 1;
        } else if (name === 'compound') {
          const [a, b, c, scrollSlot, offeringSlot] = args;
          const first = at(a);
          assert.ok(first);
          decrement(scrollSlot);
          if (offeringSlot != null) decrement(offeringSlot);
          removeAt(a);
          removeAt(b);
          removeAt(c);
          if (options.compoundFailure !== true) {
            state.rows.push({
              ...clone(first),
              slot: a,
              quantity: 1,
              level: Math.max(0, Number(first.level) || 0) + 1
            });
          }
        }
      }
      const serverResult = options.serverResult || { success: true };
      return { state: 'DISPATCHED', value: Promise.resolve(clone(serverResult)) };
    }
  };

  const combat = { status: () => ({ state: options.combatActive ? 'FIGHTING' : 'IDLE', active: !!options.combatActive }) };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    setTimeout,
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'upgrade.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.UpgradeCompoundController;
  const gearProgression = options.riskChance == null ? null : {
    evaluateInventory: inv => ({
      state: 'READY',
      evaluations: (inv.items || [])
        .filter(candidate => candidate && ['sword', 'ring'].includes(candidate.name))
        .map(candidate => ({
          slot: candidate.slot,
          item: candidate.name,
          observedLevel: candidate.level || 0,
          checked: true,
          protected: true,
          sellSafe: false,
          action: candidate.name === 'ring' ? 'COMPOUND' : 'UPGRADE',
          futureGear: {
            currentScore: options.currentScore == null ? 100 : options.currentScore,
            observedMeaningful: options.usefulNow === true,
            improvement: options.futureImprovement == null ? 0 : options.futureImprovement,
            curve: [{
              level: Math.max(0, Number(candidate.level) || 0) + 1,
              stepChance: options.riskChance
            }]
          }
        }))
    })
  };

  const bank = options.bankRows ? {
    plan: () => ({
      state: 'READY',
      packs: [{ name: 'items0', items: clone(options.bankRows) }]
    })
  } : null;

  const controller = new Controller({
    root: ctx,
    game,
    actions,
    combat,
    gearProgression,
    bank,
    settleGraceMs: options.settleGraceMs || 100,
    outcomeTimeoutMs: options.outcomeTimeoutMs || 1200,
    maxItemValueAtRisk: options.maxItemValueAtRisk,
    maxConsumableCost: options.maxConsumableCost,
    offeringMode: options.offeringMode,
    offeringFromLevel: options.offeringFromLevel
  });
  controller.start({});

  return { controller, state, game, actions };
}

test('H15 plans safe upgrade and compound candidates with grade scrolls', () => {
  const { controller } = fixture();
  const plan = controller.plan();
  assert.equal(plan.state, 'READY');
  assert.equal(plan.upgradeCandidates.length, 1);
  assert.equal(plan.upgradeCandidates[0].itemSlot, 0);
  assert.equal(plan.upgradeCandidates[0].scrollName, 'scroll0');
  assert.deepEqual(plan.compoundCandidates[0].itemSlots, [2, 3, 4]);
  assert.equal(plan.compoundCandidates[0].scrollName, 'cscroll0');
});

test('H15 V3 mutation risk blocks a low-chance upgrade when no replacement exists', () => {
  const { controller } = fixture({
    rows: [
      row({ slot: 0, name: 'sword', level: 0 }),
      row({ slot: 1, name: 'scroll0', quantity: 5 })
    ],
    riskChance: 0.49,
    currentScore: 100,
    futureImprovement: 0
  });
  const plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 0);
  assert.equal(controller.status().lastMutationRiskDecision.allowed, false);
  assert.equal(controller.status().lastMutationRiskDecision.reason, 'MUTATION_RISK_EXCEEDS_POLICY');
  assert.equal(controller.status().lastMutationRiskDecision.replacement.spareEquivalents, 0);
  assert.ok(controller.status().lastMutationRiskDecision.minChance >= 0.60);
  assert.equal(controller.status().riskHolds.length, 1);
});

test('H15 V3 mutation risk relaxes the threshold when two replacement items exist', () => {
  const { controller } = fixture({
    rows: [
      row({ slot: 0, name: 'sword', level: 0 }),
      row({ slot: 1, name: 'scroll0', quantity: 5 }),
      row({ slot: 2, name: 'sword', level: 0 }),
      row({ slot: 3, name: 'sword', level: 0 })
    ],
    riskChance: 0.25,
    currentScore: 100,
    futureImprovement: 0
  });
  const plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 3);
  const candidate = plan.upgradeCandidates.find(row => row.itemSlot === 0);
  assert.ok(candidate);
  assert.equal(candidate.risk.allowed, true);
  assert.equal(candidate.risk.replacement.spareEquivalents, 2);
  assert.ok(candidate.risk.minChance <= 0.25);
});

test('H15 V3 mutation risk counts usable bank replacements', () => {
  const { controller } = fixture({
    rows: [
      row({ slot: 0, name: 'sword', level: 0 }),
      row({ slot: 1, name: 'scroll0', quantity: 5 })
    ],
    bankRows: [
      row({ slot: 5, name: 'sword', level: 0 }),
      row({ slot: 6, name: 'sword', level: 0 })
    ],
    riskChance: 0.25,
    currentScore: 100,
    futureImprovement: 0
  });
  const plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 1);
  assert.equal(plan.upgradeCandidates[0].risk.replacement.bankUnits, 2);
  assert.equal(plan.upgradeCandidates[0].risk.replacement.spareEquivalents, 2);
});

test('H15 server-authoritative preview blocks a mutation that model probability alone would allow', () => {
  const { controller, state } = fixture({
    rows: [
      row({ slot: 0, name: 'sword', level: 0 }),
      row({ slot: 1, name: 'scroll0', quantity: 5 })
    ],
    riskChance: 0.99,
    serverRiskChance: 0.40,
    currentScore: 100,
    futureImprovement: 0
  });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  const tick = controller.tick();
  assert.equal(tick.state, 'BLOCKED');
  assert.equal(tick.reason, 'MUTATION_RISK_EXCEEDS_POLICY');
  assert.equal(tick.risk.serverAuthoritative, true);
  assert.equal(tick.risk.chance, 0.40);
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.previews.length, 1);
  assert.equal(controller.status().metrics.mutationAuthoritativeHolds, 1);
});

test('H15 dispatches only after server-authoritative mutation chance passes the V3 risk threshold', () => {
  const { controller, state } = fixture({
    rows: [
      row({ slot: 0, name: 'sword', level: 0 }),
      row({ slot: 1, name: 'scroll0', quantity: 5 })
    ],
    riskChance: 0.99,
    serverRiskChance: 0.90,
    currentScore: 100,
    futureImprovement: 0
  });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  const preview = controller.tick();
  assert.equal(preview.state, 'RISK_ACCEPTED');
  assert.equal(preview.risk.serverAuthoritative, true);
  assert.equal(state.dispatches.length, 0);
  const mutation = controller.tick();
  assert.equal(mutation.accepted, true);
  assert.equal(mutation.state, 'DISPATCHED');
  assert.equal(state.previews.length, 1);
  assert.equal(state.dispatches.length, 1);
  assert.equal(controller.status().metrics.mutationAuthoritativeAccepted, 1);
});

test('action boundary uses Adventure Land CODE preview mode without dispatching a real mutation', () => {
  const calls = [];
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    upgrade: function (itemSlot, scrollSlot, offeringSlot, mode, preview) {
      calls.push([itemSlot, scrollSlot, offeringSlot, mode, preview]);
      return { chance: 0.42 };
    },
    __ALBOT_INTERNALS__: internals()
  };
  root.globalThis = root;
  vm.runInNewContext(actionBoundarySource, root, { filename: 'action-boundary.js' });
  const Boundary = root.__ALBOT_INTERNALS__.GameActionBoundary;
  const boundary = new Boundary({ root, assertAllowed: () => true });
  const result = boundary.previewMutation('upgrade', [4, 7, null]);
  assert.equal(result.state, 'PREVIEWED');
  assert.equal(result.value.chance, 0.42);
  assert.deepEqual(calls[0], [4, 7, undefined, 'code', true]);
  assert.equal(boundary.status().metrics.mutationPreviewsResolved, 1);
  assert.equal(boundary.status().metrics.dispatched, 0);
});

test('H15 excludes protected items from automated candidates', () => {
  const { controller } = fixture();
  const plan = controller.plan();
  assert.equal(plan.upgradeCandidates.some(candidate => candidate.itemSlot === 7), false);
  const queued = controller.queueUpgrade(7);
  assert.equal(queued.accepted, false);
  assert.equal(queued.reason, 'H15_ITEM_NOT_AUTOMATION_SAFE');
});

test('H15 confirms upgrade only from observed inventory level and scroll deltas', () => {
  const { controller, state } = fixture();
  const queued = controller.queueUpgrade(0);
  assert.equal(queued.accepted, true);
  assert.equal(controller.tick().accepted, true);
  controller.tick();
  const status = controller.status();
  assert.equal(status.metrics.upgradesDispatched, 1);
  assert.equal(status.metrics.upgradesSucceeded, 1);
  assert.equal(status.metrics.upgradesUnknown, 0);
  assert.equal(state.rows.find(item => item.slot === 0).level, 1);
  assert.equal(state.rows.find(item => item.slot === 1).quantity, 4);
});

test('H15 accepts explicit server success when inventory redraw lags without suspending Economy', async () => {
  const { controller, state } = fixture({ noMutation: true });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 120));
  controller.tick();
  const status = controller.status();
  assert.equal(status.suspended, false);
  assert.equal(status.metrics.upgradesSucceeded, 1);
  assert.equal(status.metrics.upgradesUnknown, 0);
  assert.equal(status.lastAction.evidence, 'SERVER_SETTLEMENT_SUCCESS');
  assert.equal(state.rows.find(item => item.slot === 0).level, 0);
});

test('H15 accepts explicit server failure as known failure when inventory redraw lags', async () => {
  const { controller } = fixture({ noMutation: true, serverResult: { success: false, reason: 'upgrade_failed' } });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  assert.equal(controller.tick().state, 'DISPATCHED');
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 120));
  controller.tick();
  const status = controller.status();
  assert.equal(status.suspended, false);
  assert.equal(status.metrics.upgradesFailed, 1);
  assert.equal(status.metrics.upgradesUnknown, 0);
  assert.equal(status.lastAction.evidence, 'SERVER_SETTLEMENT_FAILURE');
  assert.equal(status.lastAction.serverReason, 'upgrade_failed');
});

test('H15 records known upgrade failure when scroll is consumed without level gain', async () => {
  const { controller, state } = fixture({ upgradeFailure: true });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  controller.tick();
  controller.tick();
  await new Promise(resolve => setTimeout(resolve, 120));
  controller.tick();
  const status = controller.status();
  assert.equal(status.metrics.upgradesFailed, 1);
  assert.equal(status.metrics.upgradesUnknown, 0);
  assert.equal(state.rows.find(item => item.slot === 0).level, 0);
  assert.equal(state.rows.find(item => item.slot === 1).quantity, 4);
});

test('H15 compounds exactly three identical items and confirms resulting level', () => {
  const { controller, state } = fixture();
  assert.equal(controller.queueCompound([2, 3, 4]).accepted, true);
  controller.tick();
  controller.tick();
  const status = controller.status();
  assert.equal(status.metrics.compoundsDispatched, 1);
  assert.equal(status.metrics.compoundsSucceeded, 1);
  const rings = state.rows.filter(item => item.name === 'ring');
  assert.equal(rings.length, 1);
  assert.equal(rings[0].level, 1);
});

test('H15 rejects compound inputs that are not identical', () => {
  const rows = [
    row({ slot: 0, name: 'ring', level: 0 }),
    row({ slot: 1, name: 'ring', level: 0, statType: 'str' }),
    row({ slot: 2, name: 'ring', level: 0 }),
    row({ slot: 3, name: 'cscroll0', quantity: 2 })
  ];
  const { controller } = fixture({ rows });
  const result = controller.queueCompound([0, 1, 2]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H15_COMPOUND_ITEMS_NOT_IDENTICAL');
});

test('H15 revalidates source slots immediately before dispatch', () => {
  const { controller, state } = fixture();
  assert.equal(controller.queueUpgrade(0).accepted, true);
  state.rows.find(item => item.slot === 0).level = 1;
  const tick = controller.tick();
  assert.equal(tick.state, 'BLOCKED');
  assert.equal(tick.reason, 'H15_SOURCE_CHANGED');
  assert.equal(state.dispatches.length, 0);
});

test('H15 blocks writes while combat is active', () => {
  const { controller, state } = fixture({ combatActive: true });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  const tick = controller.tick();
  assert.equal(tick.state, 'BLOCKED');
  assert.equal(tick.reason, 'H15_COMBAT_ACTIVE');
  assert.equal(state.dispatches.length, 0);
});

test('H15 suspends on synchronous UNKNOWN and does not blind retry', () => {
  const { controller, state } = fixture({ syncUnknown: true });
  assert.equal(controller.queueUpgrade(0).accepted, true);
  const first = controller.tick();
  assert.equal(first.state, 'SUSPENDED');
  const second = controller.tick();
  assert.equal(second.state, 'SUSPENDED');
  assert.equal(state.dispatches.length, 1);
  assert.equal(controller.status().metrics.upgradesUnknown, 1);
});

test('H15 enforces item-value risk budget', () => {
  const rows = [
    row({ slot: 0, name: 'expensive', level: 0 }),
    row({ slot: 1, name: 'scroll0', quantity: 2 })
  ];
  const { controller } = fixture({ rows, maxItemValueAtRisk: 1000 });
  const result = controller.queueUpgrade(0);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H15_ITEM_VALUE_OVER_BUDGET');
});

test('H15 offering policy requires and consumes an offering when configured', () => {
  const { controller, state } = fixture({ offeringMode: 'REQUIRED', offeringFromLevel: 0 });
  const queued = controller.queueUpgrade(0);
  assert.equal(queued.accepted, true);
  controller.tick();
  assert.equal(state.dispatches[0].name, 'upgrade');
  assert.deepEqual(state.dispatches[0].args, [0, 1, 6]);
  controller.tick();
  assert.equal(controller.status().metrics.upgradesSucceeded, 1);
  assert.equal(state.rows.find(item => item.slot === 6).quantity, 1);
});


test('H15 excludes quest and cash definitions from automatic mutation', () => {
  const rows = [
    row({ slot: 0, name: 'quest_sword', level: 0 }),
    row({ slot: 1, name: 'scroll0', quantity: 2 }),
    row({ slot: 2, name: 'cash_ring', level: 0 }),
    row({ slot: 3, name: 'cash_ring', level: 0 }),
    row({ slot: 4, name: 'cash_ring', level: 0 }),
    row({ slot: 5, name: 'cscroll0', quantity: 2 })
  ];
  const { controller } = fixture({ rows });
  const plan = controller.plan();
  assert.equal(plan.upgradeCandidates.length, 0);
  assert.equal(plan.compoundCandidates.length, 0);
  const upgrade = controller.queueUpgrade(0);
  assert.equal(upgrade.accepted, false);
  assert.equal(upgrade.reason, 'H15_ITEM_DEFINITION_PROTECTED');
  const compound = controller.queueCompound([2, 3, 4]);
  assert.equal(compound.accepted, false);
  assert.equal(compound.reason, 'H15_ITEM_DEFINITION_PROTECTED');
});

test('H15 compound risk budget counts all three source items', () => {
  const rows = [
    row({ slot: 0, name: 'ring', level: 0 }),
    row({ slot: 1, name: 'ring', level: 0 }),
    row({ slot: 2, name: 'ring', level: 0 }),
    row({ slot: 3, name: 'cscroll0', quantity: 2 })
  ];
  const { controller } = fixture({ rows, maxItemValueAtRisk: 1000 });
  const result = controller.queueCompound([0, 1, 2]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H15_ITEM_VALUE_OVER_BUDGET');
});
