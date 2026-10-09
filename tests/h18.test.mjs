import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/party-logistics.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fixture(options = {}) {
  const state = {
    character: {
      name: 'My_Merchant', ctype: 'merchant', rip: false,
      map: 'main', x: 0, y: 0, gold: options.gold == null ? 500000 : options.gold
    },
    inventory: clone(options.inventory || [
      { slot: 0, name: 'hpot0', quantity: 100, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: { type: 'pot', quest: false, cash: false, upgrade: false, compound: false } },
      { slot: 1, name: 'scroll0', quantity: 5, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: { type: 'uscroll', quest: false, cash: false, upgrade: false, compound: false } },
      { slot: 2, name: 'ore0', quantity: 20, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: { type: 'material', quest: false, cash: false, upgrade: false, compound: false } },
      { slot: 3, name: 'sword', quantity: 1, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: { type: 'weapon', quest: false, cash: false, upgrade: true, compound: false } }
    ]),
    target: {
      name: 'My_Priest', local: false, owned: true, visible: options.targetVisible !== false,
      ctype: 'priest', role: 'HEALER', rip: false, map: options.targetMap || 'main',
      x: Object.prototype.hasOwnProperty.call(options, 'targetX') ? options.targetX : 100,
      y: Object.prototype.hasOwnProperty.call(options, 'targetY') ? options.targetY : 0
    },
    movement: { active: false, activeOrder: null, lastOrder: null },
    dispatches: [],
    movementSequence: 0,
    combatActive: !!options.combatActive
  };

  const game = {
    snapshot: () => ({ available: true, character: clone(state.character) }),
    inventorySnapshot: () => ({
      available: true,
      capacity: 42,
      usedSlots: state.inventory.length,
      freeSlots: 42 - state.inventory.length,
      items: clone(state.inventory)
    })
  };

  const party = {
    snapshot: () => {
      const local = {
        name: state.character.name, local: true, owned: true, visible: true,
        ctype: 'merchant', role: 'LOGISTICS', rip: false,
        map: state.character.map, x: state.character.x, y: state.character.y
      };
      const foreign = options.foreignParty === true ? ['Foreign_Player'] : [];
      return {
        available: true,
        size: 2 + foreign.length,
        leader: options.leader || state.target.name,
        members: [local, clone(state.target)],
        ownedMembers: [local, clone(state.target)],
        ownedMemberNames: [local.name, state.target.name],
        foreignMemberNames: foreign,
        coordinationEnabled: foreign.length === 0
      };
    }
  };

  const movement = {
    status: () => clone(state.movement),
    smartMove: (destination, opts) => {
      if (options.movementReject) return { accepted: false, reason: 'TEST_MOVEMENT_REJECTED' };
      const order = {
        id: 'move-' + (++state.movementSequence),
        owner: opts && opts.owner,
        destination: clone(destination),
        state: 'ACTIVE'
      };
      state.movement = { active: true, activeOrder: order, lastOrder: state.movement.lastOrder };
      return { accepted: true, order: clone(order) };
    },
    cancel: reason => {
      const active = state.movement.activeOrder;
      state.movement = {
        active: false,
        activeOrder: null,
        lastOrder: active ? { ...clone(active), state: 'CANCELLED', reason } : state.movement.lastOrder
      };
      return { cancelled: !!active };
    }
  };

  const actions = {
    available: name => ['send_item', 'send_gold'].includes(name) && !(name === 'send_gold' && options.noSendGold),
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (name === 'send_item' && options.noMutation !== true) {
        const slot = Number(args[1]);
        const quantity = Number(args[2]);
        const row = state.inventory.find(item => Number(item.slot) === slot);
        assert.ok(row);
        row.quantity -= quantity;
        if (row.quantity <= 0) state.inventory = state.inventory.filter(item => item !== row);
      }
      if (name === 'send_gold' && options.noMutation !== true) {
        state.character.gold -= Number(args[1]);
      }
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.rejectPromise) return { state: 'DISPATCHED', value: Promise.reject(new Error('PROMISE_REJECTED')) };
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };

  const combat = { status: () => ({ active: state.combatActive, state: state.combatActive ? 'FIGHTING' : 'IDLE' }) };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: 'party-logistics.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.PartyLogisticsController;
  const statusController = value => ({ status: () => clone(value || {}) });
  const controller = new Controller({
    root: ctx, game, actions, party, movement, combat,
    inventory: statusController(options.inventoryStatus),
    merchant: statusController(options.merchantStatus),
    bank: statusController(options.bankStatus),
    trade: statusController(options.tradeStatus),
    gear: statusController(options.gearStatus),
    upgrade: statusController(options.upgradeStatus),
    exchangeCraft: statusController(options.exchangeStatus),
    economy: statusController(options.economyStatus),
    canAct: () => options.actionBlocked !== true,
    transferRange: options.transferRange == null ? 320 : options.transferRange,
    regroupDistance: options.regroupDistance == null ? 700 : options.regroupDistance,
    goldReserve: options.goldReserve == null ? 100000 : options.goldReserve,
    outcomeTimeoutMs: options.outcomeTimeoutMs == null ? 500 : options.outcomeTimeoutMs
  });
  controller.start({ scope: { interval: () => 'h18-resource' } });

  return {
    controller,
    state,
    arrive: () => {
      const active = state.movement.activeOrder;
      assert.ok(active);
      state.character.map = active.destination.map;
      state.character.x = active.destination.x;
      state.character.y = active.destination.y;
      state.movement = {
        active: false,
        activeOrder: null,
        lastOrder: { ...clone(active), state: 'COMPLETED', reason: 'ARRIVAL_VERIFIED' }
      };
    }
  };
}

test('H18 supply catalog allows safe utilities/materials and blocks equipment', () => {
  const { controller } = fixture();
  const catalog = controller.supplyCatalog();
  assert.equal(catalog.some(row => row.name === 'hpot0' && row.utility), true);
  assert.equal(catalog.some(row => row.name === 'scroll0' && row.utility), true);
  assert.equal(catalog.some(row => row.name === 'ore0' && !row.utility), true);
  assert.equal(catalog.some(row => row.name === 'sword'), false);
});

test('H18 queues supply only for an owned party member', () => {
  const { controller } = fixture();
  assert.equal(controller.queueSupply('My_Priest', 'hpot0', 5).accepted, true);
  const foreign = controller.queueSupply('Not_Mine', 'hpot0', 1);
  assert.equal(foreign.accepted, false);
  assert.equal(foreign.reason, 'H18_TARGET_NOT_OWNED_PARTY_MEMBER');
});

test('H18 rejects unknown item definitions and invalid explicit quantities', () => {
  const unknown = fixture({
    inventory: [
      { slot: 0, name: 'mystery', quantity: 10, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: null }
    ]
  });
  assert.equal(unknown.controller.supplyCatalog().length, 0);
  assert.equal(unknown.controller.queueSupply('My_Priest', 'mystery', 1).reason, 'H18_SUPPLY_ITEM_NOT_SAFE_OR_AVAILABLE');

  const { controller } = fixture();
  for (const quantity of [0, -5, 'abc', 1.5]) {
    const result = controller.queueSupply('My_Priest', 'hpot0', quantity);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'H18_SUPPLY_QUANTITY_INVALID');
  }
  assert.equal(controller.queueSupply('My_Priest', 'hpot0').accepted, true);
});

test('H18 treats missing target coordinates as unavailable instead of zero', () => {
  const { controller, state } = fixture({ targetX: null, targetY: null });
  controller.queueSupply('My_Priest', 'hpot0', 1);
  controller.startAutonomy({ maxActions: 1 });
  const tick = controller.tick();
  assert.equal(tick.state, 'WAITING');
  assert.equal(tick.reason, 'H18_TARGET_NOT_VISIBLE');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.movement.activeOrder, null);
});

test('H18 confirms supply from settled sender inventory evidence', async () => {
  const { controller, state } = fixture();
  assert.equal(controller.queueSupply('My_Priest', 'hpot0', 5).accepted, true);
  assert.equal(controller.startAutonomy({ maxActions: 2 }).accepted, true);
  const first = controller.tick();
  assert.equal(first.state, 'QUEUED');
  assert.equal(state.dispatches[0].name, 'send_item');
  await Promise.resolve();
  const confirmed = controller.tick();
  assert.equal(confirmed.state, 'CONFIRMED');
  const status = controller.status();
  assert.equal(status.metrics.suppliesConfirmed, 1);
  assert.equal(status.metrics.suppliesUnknown, 0);
  assert.equal(status.queue.length, 0);
});

test('H18 preserves an in-flight irreversible transfer across module stop and reconciles it after restart', async () => {
  const { controller, state } = fixture();
  controller.queueSupply('My_Priest', 'hpot0', 5);
  controller.startAutonomy({ maxActions: 2 });
  assert.equal(controller.tick().state, 'QUEUED');
  const stopped = controller.stop('TEST_STOP_DURING_TRANSFER');
  assert.equal(stopped.inFlightPreserved, true);
  assert.ok(controller.status().currentAction);
  assert.equal(controller.status().queue.length, 1);
  await Promise.resolve();
  const restarted = controller.start({ scope: { interval: () => 'h18-resumed' } });
  assert.equal(restarted.resumedInFlight, true);
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().currentAction, null);
  assert.equal(controller.status().queue.length, 0);
  assert.equal(controller.status().metrics.suppliesConfirmed, 1);
  assert.equal(state.dispatches.length, 1);
});

test('H18 retains supply ownership while the dispatch promise is still pending', () => {
  const { controller, state } = fixture({ neverSettle: true });
  controller.queueSupply('My_Priest', 'hpot0', 5);
  controller.startAutonomy({ maxActions: 2 });
  assert.equal(controller.tick().state, 'QUEUED');
  const held = controller.tick();
  assert.equal(held.state, 'WAITING');
  assert.ok(controller.status().currentAction);
  assert.equal(controller.status().metrics.suppliesConfirmed, 0);
  assert.equal(state.inventory.find(row => row.name === 'hpot0').quantity, 95);
});

test('H18 confirms the exact sent slot when duplicate item stacks exist', async () => {
  const { controller, state } = fixture({
    inventory: [
      { slot: 0, name: 'hpot0', quantity: 2, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: { type: 'pot', quest: false, cash: false, upgrade: false, compound: false } },
      { slot: 1, name: 'hpot0', quantity: 50, level: 0, locked: false, giveaway: false, gift: false, expiresAt: null, definition: { type: 'pot', quest: false, cash: false, upgrade: false, compound: false } }
    ]
  });
  assert.equal(controller.queueSupply('My_Priest', 'hpot0', 2).accepted, true);
  controller.startAutonomy({ maxActions: 1 });
  assert.equal(controller.tick().state, 'QUEUED');
  assert.deepEqual(state.dispatches[0].args, ['My_Priest', 0, 2]);
  await Promise.resolve();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().metrics.suppliesConfirmed, 1);
  assert.equal(state.inventory.some(row => Number(row.slot) === 0), false);
  assert.equal(state.inventory.find(row => Number(row.slot) === 1).quantity, 50);
});

test('H18 keeps an explicit supply request when approach movement is rejected', () => {
  const { controller, state } = fixture({ targetX: 1200, transferRange: 300, movementReject: true });
  controller.queueSupply('My_Priest', 'hpot0', 2);
  controller.startAutonomy({ maxActions: 1 });
  const result = controller.tick();
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.reason, 'TEST_MOVEMENT_REJECTED');
  assert.equal(controller.status().queue.length, 1);
  assert.equal(state.dispatches.length, 0);
});

test('H18 blocks while another inventory or economy owner is active', () => {
  const loot = fixture({ inventoryStatus: { pendingLoot: { id: 'loot-1' } } });
  loot.controller.startAutonomy();
  const lootTick = loot.controller.tick();
  assert.equal(lootTick.state, 'WAITING');
  assert.equal(lootTick.reason, 'H18_EXTERNAL_OWNERSHIP_BUSY');
  assert.equal(loot.state.dispatches.length, 0);

  const economy = fixture({ economyStatus: { autonomyEnabled: true, currentAction: null } });
  economy.controller.startAutonomy();
  const economyTick = economy.controller.tick();
  assert.equal(economyTick.state, 'WAITING');
  assert.equal(economyTick.reason, 'H18_EXTERNAL_OWNERSHIP_BUSY');
  assert.equal(economy.state.dispatches.length, 0);
});

test('H18 rejects invalid explicit gold amounts', () => {
  const { controller } = fixture();
  for (const amount of [0, -1, 'abc', 1.5]) {
    const result = controller.queueGold('My_Priest', amount);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'H18_GOLD_AMOUNT_INVALID');
  }
});

test('H18 sends gold only above the configured reserve and confirms sender gold delta', async () => {
  const blocked = fixture({ gold: 150000, goldReserve: 100000 });
  assert.equal(blocked.controller.queueGold('My_Priest', 60000).reason, 'H18_GOLD_RESERVE_BLOCKED');

  const { controller, state } = fixture({ gold: 500000, goldReserve: 100000 });
  assert.equal(controller.queueGold('My_Priest', 50000).accepted, true);
  controller.startAutonomy({ maxActions: 1 });
  assert.equal(controller.tick().state, 'QUEUED');
  assert.equal(state.dispatches[0].name, 'send_gold');
  await Promise.resolve();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().metrics.goldConfirmed, 1);
  assert.equal(state.character.gold, 450000);
});

test('H18 approaches an owned target before dispatching a queued supply', async () => {
  const { controller, state, arrive } = fixture({ targetX: 1200, transferRange: 300, regroupDistance: 2000 });
  controller.queueSupply('My_Priest', 'hpot0', 2);
  controller.startAutonomy({ maxActions: 1 });
  const move = controller.tick();
  assert.equal(move.state, 'QUEUED');
  assert.equal(move.plan.selected.kind, 'APPROACH');
  assert.equal(state.dispatches.length, 0);
  arrive();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().queue.length, 1);
  assert.equal(controller.tick().state, 'QUEUED');
  assert.equal(state.dispatches.length, 1);
  await Promise.resolve();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().queue.length, 0);
});

test('H18 autonomous regroup uses movement ownership when the party is separated', () => {
  const { controller, state, arrive } = fixture({ targetX: 1200, regroupDistance: 500 });
  controller.startAutonomy({ maxActions: 2 });
  const first = controller.tick();
  assert.equal(first.state, 'QUEUED');
  assert.equal(first.plan.selected.kind, 'REGROUP');
  assert.equal(state.movement.activeOrder.owner, 'party-logistics-h18');
  arrive();
  assert.equal(controller.tick().state, 'CONFIRMED');
  assert.equal(controller.status().metrics.regroupsConfirmed, 1);
  assert.equal(controller.status().actionsThisSession, 1);
});

test('H18 blocks foreign parties and combat instead of dispatching logistics', () => {
  const foreign = fixture({ foreignParty: true });
  foreign.controller.startAutonomy();
  assert.equal(foreign.controller.tick().reason, 'H18_OWNED_PARTY_REQUIRED');
  assert.equal(foreign.state.dispatches.length, 0);

  const combat = fixture({ combatActive: true });
  combat.controller.startAutonomy();
  assert.equal(combat.controller.tick().reason, 'H18_COMBAT_ACTIVE');
  assert.equal(combat.state.dispatches.length, 0);
});

test('H18 promise rejection after dispatch suspends without blind retry', async () => {
  const { controller, state } = fixture({ rejectPromise: true });
  controller.queueSupply('My_Priest', 'hpot0', 1);
  controller.startAutonomy({ maxActions: 3 });
  assert.equal(controller.tick().state, 'QUEUED');
  await Promise.resolve();
  await Promise.resolve();
  const next = controller.tick();
  assert.equal(next.state, 'SUSPENDED');
  assert.match(next.reason, /H18_DISPATCH_REJECTED_WITHOUT_OUTCOME/);
  assert.equal(state.dispatches.length, 1);
  assert.equal(controller.tick().state, 'SUSPENDED');
});

test('H18 session action budget stops bounded autonomy', async () => {
  const { controller } = fixture();
  controller.queueSupply('My_Priest', 'hpot0', 1);
  controller.queueSupply('My_Priest', 'scroll0', 1);
  controller.startAutonomy({ maxActions: 1 });
  assert.equal(controller.tick().state, 'QUEUED');
  await Promise.resolve();
  assert.equal(controller.tick().state, 'CONFIRMED');
  const stopped = controller.tick();
  assert.equal(stopped.state, 'COMPLETE');
  assert.equal(stopped.reason, 'H18_SESSION_ACTION_BUDGET_REACHED');
  assert.equal(controller.status().queue.length, 1);
  assert.equal(controller.status().autonomyEnabled, false);
});


test('H18 runtime, API, UI, ActionBoundary, build and generated bundle are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const dist = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.PartyLogisticsController/);
  assert.match(runtime, /id: 'party-logistics'/);
  assert.match(runtime, /id: 'h18-party-logistics'/);
  assert.match(runtime, /options\.version \|\| '0\.26\.71-h26'/);
  assert.match(entry, /runtime\.partyLogistics\.queueSupply/);
  assert.match(entry, /runtime\.partyLogistics\.queueGold/);
  assert.match(entry, /Object\.freeze\(api\.partyLogistics\)/);
  assert.match(ui, /H18 Party Logistics/);
  assert.match(boundary, /send_gold: Object\.freeze/);
  assert.match(fs.readFileSync(path.resolve(here, '../src/inventory.js'), 'utf8'), /H10_PARTY_LOGISTICS_OWNERSHIP/);
  assert.match(fs.readFileSync(path.resolve(here, '../src/merchant.js'), 'utf8'), /H11_PARTY_LOGISTICS_OWNERSHIP/);
  assert.match(fs.readFileSync(path.resolve(here, '../src/economy.js'), 'utf8'), /partyLogistics/);
  assert.match(build, /src\/party-logistics\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.71-h26'/);
  assert.match(dist, /AL Bot 0\.26\.71-h26/);
  assert.match(dist, /class PartyLogisticsController/);
  assert.equal(pkg.version, '0.26.71');
});
