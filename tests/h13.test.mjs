import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tradeSource = fs.readFileSync(path.resolve(here, '../src/trade.js'), 'utf8');
const boundarySource = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');

function internals() {
  return {
    helpers: {
      clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
      cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
    }
  };
}

function row(overrides = {}) {
  return {
    slot: 0,
    name: 'hpot0',
    quantity: 10,
    level: 0,
    statType: null,
    property: null,
    locked: false,
    giveaway: false,
    gift: false,
    expiresAt: null,
    disposition: 'KEEP',
    reason: 'CONSUMABLE_OR_UTILITY',
    definition: { type: 'pot', g: 200, quest: false, upgrade: false, compound: false },
    ...overrides
  };
}

function fixture(options = {}) {
  const state = {
    local: {
      name: 'My_Merchant',
      ctype: options.ctype || 'merchant',
      map: options.map || 'main',
      x: options.x == null ? 0 : options.x,
      y: options.y == null ? 0 : options.y,
      rip: false,
      gold: options.gold == null ? 50000 : options.gold
    },
    rows: (options.rows || [
      row(),
      row({
        slot: 1,
        name: 'junk',
        quantity: 3,
        disposition: 'SELL',
        reason: 'RULE_SELL',
        definition: { type: 'material', g: 100, quest: false, upgrade: false, compound: false }
      }),
      row({
        slot: 2,
        name: 'sword',
        quantity: 1,
        disposition: 'PROTECT',
        reason: 'GEAR_OR_UPGRADE_ITEM',
        definition: { type: 'weapon', g: 1000, quest: false, upgrade: true, compound: false }
      })
    ]).map(x => JSON.parse(JSON.stringify(x))),
    listings: (options.listings || [
      {
        playerId: 'Seller1', playerName: 'Seller1', slot: 'trade1', rid: 'ask-rid',
        name: 'hpot0', level: 0, quantity: 5, price: 180, buying: false, giveaway: false
      },
      {
        playerId: 'Buyer1', playerName: 'Buyer1', slot: 'trade2', rid: 'bid-rid',
        name: 'junk', level: 0, quantity: 2, price: 150, buying: true, giveaway: false
      }
    ]).map(x => JSON.parse(JSON.stringify(x))),
    players: {
      Seller1: { id: 'Seller1', name: 'Seller1', slots: { trade1: { name: 'hpot0', level: 0, q: 5, price: 180, rid: 'ask-rid' } } },
      Buyer1: { id: 'Buyer1', name: 'Buyer1', slots: { trade2: { name: 'junk', level: 0, q: 2, price: 150, rid: 'bid-rid', b: true } } }
    },
    dispatches: [],
    movement: null,
    movementCalls: 0,
    inventoryAvailable: options.inventoryAvailable !== false,
    marketAvailable: options.marketAvailable !== false
  };

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const inventorySnapshot = () => ({
    available: state.inventoryAvailable,
    reason: state.inventoryAvailable ? null : 'CHARACTER_UNAVAILABLE',
    capacity: 10,
    usedSlots: state.inventoryAvailable ? state.rows.length : 0,
    freeSlots: state.inventoryAvailable ? 10 - state.rows.length : 0,
    items: state.inventoryAvailable ? clone(state.rows) : []
  });
  const marketSnapshot = () => ({
    available: state.marketAvailable,
    reason: state.marketAvailable ? null : 'MARKET_UNAVAILABLE',
    players: state.marketAvailable ? Object.values(state.players).map(p => ({ id: p.id, name: p.name })) : [],
    listings: state.marketAvailable ? clone(state.listings) : []
  });

  const game = {
    snapshot: () => ({ available: true, character: { ...state.local } }),
    inventorySnapshot,
    marketSnapshot,
    itemDefinition: name => name === 'hpot0'
      ? { id: 'hpot0', name: 'Health Potion', type: 'pot', g: 200 }
      : name === 'junk'
        ? { id: 'junk', name: 'Junk', type: 'material', g: 100 }
        : null,
    npcShopSources: name => name === 'hpot0'
      ? [{ npcId: 'fancypots', name: 'Ernis', role: 'merchant', location: { npcId: 'fancypots', map: 'main', x: 100, y: 0 } }]
      : [],
    npcLocation: npcId => npcId === 'fancypots'
      ? { npcId: 'fancypots', map: 'main', x: 100, y: 0 }
      : null,
    playerReference: name => state.players[name] || null
  };

  const inventory = {
    plan: () => ({
      state: state.inventoryAvailable ? 'READY' : 'BLOCKED',
      inventory: inventorySnapshot(),
      items: clone(state.rows)
    })
  };

  const movement = {
    status: () => state.movement || { active: false, activeOrder: null },
    smartMove: (destination, opts) => {
      state.movementCalls += 1;
      if (options.moveReject) return { accepted: false, reason: 'MOVEMENT_REJECTED' };
      state.local.map = destination.map;
      state.local.x = destination.x;
      state.local.y = destination.y;
      state.movement = null;
      return { accepted: true, order: { owner: opts.owner, destination } };
    },
    cancel: () => { state.movement = null; return { cancelled: true }; }
  };

  const addInventory = (name, quantity, level = 0) => {
    let item = state.rows.find(x => x.name === name && Number(x.level || 0) === Number(level || 0));
    if (item) item.quantity += quantity;
    else {
      let slot = 0;
      while (state.rows.some(x => Number(x.slot) === slot)) slot += 1;
      state.rows.push(row({ slot, name, quantity, level, disposition: 'KEEP' }));
    }
  };

  const removeFingerprint = (name, quantity) => {
    const item = state.rows.find(x => x.name === name);
    if (!item) return;
    item.quantity -= quantity;
    if (item.quantity <= 0) state.rows = state.rows.filter(x => x !== item);
  };

  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: [...args] });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.noMutation !== true) {
        if (name === 'buy_with_gold') {
          const [itemName, q] = args;
          const unit = itemName === 'hpot0' ? 200 : 1;
          state.local.gold -= unit * q;
          addInventory(itemName, q, 0);
        } else if (name === 'sell') {
          const [slot, q] = args;
          const item = state.rows.find(x => Number(x.slot) === Number(slot));
          if (item) {
            const itemName = item.name;
            removeFingerprint(itemName, q);
            state.local.gold += 50 * q;
          }
        } else if (name === 'trade_buy') {
          const [target, tradeSlot, rid, q] = args;
          const listing = target.slots[tradeSlot];
          assert.equal(String(listing.rid), String(rid));
          state.local.gold -= Number(listing.price) * q;
          addInventory(listing.name, q, listing.level || 0);
          const live = state.listings.find(x => x.playerName === target.name && x.slot === tradeSlot);
          if (live) live.quantity -= q;
        } else if (name === 'trade_sell') {
          const [target, tradeSlot, rid, q] = args;
          const listing = target.slots[tradeSlot];
          assert.equal(String(listing.rid), String(rid));
          removeFingerprint(listing.name, q);
          state.local.gold += Number(listing.price) * q;
          const live = state.listings.find(x => x.playerName === target.name && x.slot === tradeSlot);
          if (live) live.quantity -= q;
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
  vm.runInNewContext(tradeSource, ctx, { filename: 'trade.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.TradeController;
  const controller = new Controller({
    root: ctx,
    game,
    actions,
    movement,
    inventory,
    outcomeTimeoutMs: 1000,
    movementTimeoutMs: 3000,
    goldReserve: options.goldReserve == null ? 10000 : options.goldReserve
  });
  controller.start({ scope: { interval: () => 'trade-resource' } });
  return { controller, state, game, inventory, movement, actions };
}

test('H13 market analysis sorts asks low-to-high and bids high-to-low without dispatching', () => {
  const f = fixture({
    listings: [
      { playerId:'A', playerName:'A', slot:'trade1', rid:'a', name:'hpot0', level:0, quantity:1, price:220, buying:false, giveaway:false },
      { playerId:'B', playerName:'B', slot:'trade1', rid:'b', name:'hpot0', level:0, quantity:1, price:180, buying:false, giveaway:false },
      { playerId:'C', playerName:'C', slot:'trade1', rid:'c', name:'hpot0', level:0, quantity:1, price:140, buying:true, giveaway:false },
      { playerId:'D', playerName:'D', slot:'trade1', rid:'d', name:'hpot0', level:0, quantity:1, price:160, buying:true, giveaway:false }
    ]
  });
  const analysis = f.controller.marketAnalysis('hpot0', { level: 0 });
  assert.equal(analysis.available, true);
  assert.deepEqual(Array.from(analysis.asks, x => x.price), [180, 220]);
  assert.deepEqual(Array.from(analysis.bids, x => x.price), [160, 140]);
  assert.equal(analysis.spread, 20);
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 global market analysis does not invent a spread across different items', () => {
  const f = fixture({
    listings: [
      { playerId:'A', playerName:'A', slot:'trade1', rid:'a', name:'seashell', level:0, quantity:1, price:960, buying:false, giveaway:false },
      { playerId:'B', playerName:'B', slot:'trade2', rid:'b', name:'frozenkey', level:0, quantity:1, price:4000000, buying:true, giveaway:false }
    ]
  });
  const analysis = f.controller.marketAnalysis(null);
  assert.equal(analysis.bestAsk.name, 'seashell');
  assert.equal(analysis.bestBid.name, 'frozenkey');
  assert.equal(analysis.spread, null);
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 NPC buy requires an explicit price cap and respects gold reserve', () => {
  const f = fixture();
  assert.equal(f.controller.queueNpcBuy('hpot0', 1, {}).reason, 'H13_MAX_UNIT_PRICE_REQUIRED');
  assert.equal(f.controller.queueNpcBuy('hpot0', 1, { maxUnitPrice: 199 }).reason, 'H13_NPC_PRICE_ABOVE_LIMIT');
  const lowGold = fixture({ gold: 10199 });
  assert.equal(lowGold.controller.queueNpcBuy('hpot0', 1, { maxUnitPrice: 200 }).reason, 'H13_GOLD_RESERVE_BLOCKED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 NPC buy travels once, dispatches buy_with_gold and confirms inventory plus gold delta', async () => {
  const f = fixture({ x: 0 });
  assert.equal(f.controller.queueNpcBuy('hpot0', 1, { maxUnitPrice: 200 }).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches[0], { name: 'buy_with_gold', args: ['hpot0', 1] });
  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.metrics.npcBuysConfirmed, 1);
  assert.equal(status.metrics.npcBuysUnknown, 0);
  assert.equal(f.state.rows.find(x => x.name === 'hpot0').quantity, 11);
  assert.equal(f.state.local.gold, 49800);
});

test('H13 NPC buy rechecks gold reserve immediately before dispatch', () => {
  const f = fixture();
  const queued = f.controller.queueNpcBuy('hpot0', 1, { maxUnitPrice: 200 });
  assert.equal(queued.accepted, true);
  f.state.local.gold = 10199;
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H13_GOLD_RESERVE_CHANGED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 NPC sell only accepts H10 SELL rows and confirms both deltas', async () => {
  const f = fixture();
  assert.equal(f.controller.queueNpcSell(2, 1).reason, 'H13_SELL_ITEM_NOT_SAFE');
  const queued = f.controller.queueNpcSell(1, 1);
  assert.equal(queued.accepted, true);
  const first = f.controller.tick();
  assert.ok(['WAITING_NPC','DISPATCHED'].includes(first.state));
  if (first.state === 'WAITING_NPC') f.controller.tick();
  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.metrics.npcSellsConfirmed, 1);
  assert.equal(f.state.rows.find(x => x.name === 'junk').quantity, 2);
  assert.equal(f.state.local.gold, 50050);
});

test('H13 NPC sell rechecks H10 SELL safety immediately before dispatch', () => {
  const f = fixture();
  const queued = f.controller.queueNpcSell(1, 1);
  assert.equal(queued.accepted, true);
  f.state.rows.find(x => Number(x.slot) === 1).disposition = 'KEEP';
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H13_SELL_ITEM_NO_LONGER_SAFE');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 market buy enforces price cap and rechecks listing RID before dispatch', () => {
  const f = fixture();
  assert.equal(f.controller.queueMarketBuy('Seller1', 'trade1', 1, { maxUnitPrice: 179 }).reason, 'H13_MARKET_PRICE_ABOVE_LIMIT');
  const ok = f.controller.queueMarketBuy('Seller1', 'trade1', 1, { maxUnitPrice: 180 });
  assert.equal(ok.accepted, true);
  f.state.listings[0].rid = 'changed';
  f.state.players.Seller1.slots.trade1.rid = 'changed';
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H13_MARKET_ASK_CHANGED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 market buy dispatches trade_buy and confirms inventory plus gold delta', async () => {
  const f = fixture();
  assert.equal(f.controller.queueMarketBuy('Seller1', 'trade1', 1, { maxUnitPrice: 180 }).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.dispatches[0].name, 'trade_buy');
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.marketBuysConfirmed, 1);
  assert.equal(f.state.rows.find(x => x.name === 'hpot0').quantity, 11);
  assert.equal(f.state.local.gold, 49820);
});

test('H13 market sell requires the safe inventory variant to match the bid fingerprint', () => {
  const f = fixture({
    listings: [{
      playerId:'Buyer1', playerName:'Buyer1', slot:'trade2', rid:'bid-rid',
      name:'junk', level:0, quantity:2, price:150, buying:true, giveaway:false,
      statType:'int', property:{bonus:1}
    }]
  });
  f.state.players.Buyer1 = {
    id:'Buyer1', name:'Buyer1',
    slots:{ trade2:{ name:'junk', level:0, q:2, price:150, rid:'bid-rid', b:true, stat_type:'int', p:{bonus:1} } }
  };
  const blocked = f.controller.queueMarketSell('Buyer1', 'trade2', 1, { minUnitPrice: 150 });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'H13_MARKET_SELL_ITEM_NOT_SAFE_OR_AVAILABLE');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 market sell rechecks H10 safety immediately before dispatch', () => {
  const f = fixture();
  const queued = f.controller.queueMarketSell('Buyer1', 'trade2', 1, { minUnitPrice: 150 });
  assert.equal(queued.accepted, true);
  f.state.rows.find(x => x.name === 'junk').disposition = 'KEEP';
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H13_MARKET_SELL_ITEM_NO_LONGER_SAFE');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 market sell rejects quantity larger than the live bid', () => {
  const f = fixture();
  const blocked = f.controller.queueMarketSell('Buyer1', 'trade2', 3, { minUnitPrice: 150 });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'H13_MARKET_BID_QUANTITY_UNAVAILABLE');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 market sell requires a safe SELL item and minimum bid price', async () => {
  const f = fixture();
  assert.equal(f.controller.queueMarketSell('Buyer1', 'trade2', 1, { minUnitPrice: 151 }).reason, 'H13_MARKET_BID_BELOW_LIMIT');
  assert.equal(f.controller.queueMarketSell('Buyer1', 'trade2', 1, { minUnitPrice: 150 }).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.dispatches[0].name, 'trade_sell');
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.marketSellsConfirmed, 1);
  assert.equal(f.state.rows.find(x => x.name === 'junk').quantity, 2);
  assert.equal(f.state.local.gold, 50150);
});

test('H13 acquisition chooses cheaper visible ask over NPC and otherwise NPC within cap', () => {
  const market = fixture();
  const a = market.controller.queueAcquire('hpot0', 1, { maxUnitPrice: 200 });
  assert.equal(a.accepted, true);
  assert.equal(a.request.kind, 'MARKET_BUY');
  assert.equal(a.request.unitPrice, 180);

  const npc = fixture({ listings: [] });
  const b = npc.controller.queueAcquire('hpot0', 1, { maxUnitPrice: 200 });
  assert.equal(b.accepted, true);
  assert.equal(b.request.kind, 'NPC_BUY');
  assert.equal(b.request.unitPrice, 200);
});

test('H13 acquisition skips undersized cheap asks and chooses a source that can fill the request', () => {
  const f = fixture({
    listings: [
      { playerId:'Tiny', playerName:'Tiny', slot:'trade1', rid:'tiny', name:'hpot0', level:0, quantity:1, price:100, buying:false, giveaway:false },
      { playerId:'Enough', playerName:'Enough', slot:'trade2', rid:'enough', name:'hpot0', level:0, quantity:3, price:190, buying:false, giveaway:false }
    ]
  });
  f.state.players.Tiny = { id:'Tiny', name:'Tiny', slots:{ trade1:{ name:'hpot0', level:0, q:1, price:100, rid:'tiny' } } };
  f.state.players.Enough = { id:'Enough', name:'Enough', slots:{ trade2:{ name:'hpot0', level:0, q:3, price:190, rid:'enough' } } };
  const selected = f.controller.queueAcquire('hpot0', 2, { maxUnitPrice: 200 });
  assert.equal(selected.accepted, true);
  assert.equal(selected.request.kind, 'MARKET_BUY');
  assert.equal(selected.request.playerName, 'Enough');
  assert.equal(selected.request.quantity, 2);

  const fallback = fixture({
    listings: [
      { playerId:'Tiny', playerName:'Tiny', slot:'trade1', rid:'tiny', name:'hpot0', level:0, quantity:1, price:100, buying:false, giveaway:false }
    ]
  });
  const npc = fallback.controller.queueAcquire('hpot0', 2, { maxUnitPrice: 200 });
  assert.equal(npc.accepted, true);
  assert.equal(npc.request.kind, 'NPC_BUY');
  assert.equal(npc.request.quantity, 2);
});

test('H13 ActionBoundary preserves listing RID across CODE-wrapper and native parent trade signatures', () => {
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(boundarySource, ctx, { filename: 'action-boundary.js' });
  const Boundary = ctx.__ALBOT_INTERNALS__.GameActionBoundary;
  const target = { id: 'Seller1', slots: { trade1: { rid: 'rid-1' } } };

  const wrapperCalls = [];
  const wrapperRoot = {
    trade_buy(targetArg, slotArg, quantityArg) {
      wrapperCalls.push([targetArg, slotArg, quantityArg]);
      return Promise.resolve({ success: true });
    }
  };
  const wrapper = new Boundary({ root: wrapperRoot, assertAllowed: () => true });
  assert.equal(wrapper.dispatch('trade_buy', [target, 'trade1', 'rid-1', 2]).state, 'DISPATCHED');
  assert.equal(wrapperCalls.length, 1);
  assert.equal(wrapperCalls[0][0], target);
  assert.equal(wrapperCalls[0][1], 'trade1');
  assert.equal(wrapperCalls[0][2], 2);

  const nativeCalls = [];
  const parent = {
    document: {},
    trade_sell(slotArg, idArg, ridArg, quantityArg) {
      nativeCalls.push([slotArg, idArg, ridArg, quantityArg]);
      return Promise.resolve({ success: true });
    }
  };
  const child = { parent };
  const native = new Boundary({ root: child, assertAllowed: () => true });
  assert.equal(native.dispatch('trade_sell', [target, 'trade1', 'rid-1', 3]).state, 'DISPATCHED');
  assert.deepEqual(nativeCalls[0], ['trade1', 'Seller1', 'rid-1', 3]);

  const mismatch = new Boundary({ root: wrapperRoot, assertAllowed: () => true });
  const bad = mismatch.dispatch('trade_buy', [target, 'trade1', 'wrong-rid', 1]);
  assert.equal(bad.state, 'UNKNOWN');
  assert.equal(wrapperCalls.length, 1);
});

test('H13 market buy also rechecks gold reserve before dispatch', () => {
  const f = fixture();
  const queued = f.controller.queueMarketBuy('Seller1', 'trade1', 1, { maxUnitPrice: 180 });
  assert.equal(queued.accepted, true);
  f.state.local.gold = 10179;
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H13_GOLD_RESERVE_CHANGED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H13 UNKNOWN suspends immediately and is never blindly retried', () => {
  const f = fixture({ syncUnknown: true, noMutation: true });
  assert.equal(f.controller.queueMarketBuy('Seller1', 'trade1', 1, { maxUnitPrice: 180 }).accepted, true);
  const first = f.controller.tick();
  assert.equal(first.state, 'SUSPENDED');
  assert.equal(f.controller.status().metrics.marketBuysUnknown, 1);
  assert.equal(f.state.dispatches.length, 1);
  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H13 never-settling promise times out UNKNOWN and never retries', () => {
  const f = fixture({ neverSettle: true, noMutation: true });
  assert.equal(f.controller.queueMarketBuy('Seller1', 'trade1', 1, { maxUnitPrice: 180 }).accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  f.controller.pending.deadlineAtMs = Date.now() - 1;
  assert.equal(f.controller.tick().state, 'SUSPENDED');
  assert.equal(f.controller.status().metrics.marketBuysUnknown, 1);
  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H13 runtime, API, UI, build, adapter and ActionBoundary are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const adapter = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.TradeController/);
  assert.match(runtime, /id: 'trade'/);
  assert.match(runtime, /id: 'h13-trade'/);
  assert.match(runtime, /H13_LIVE_TEST_REQUIRES_MERCHANT/);
  assert.match(entry, /0\.26\.92-h26/);
  assert.match(entry, /runtime\.trade\.queueAcquire/);
  assert.match(ui, /data-tab="trade"/);
  assert.match(ui, /H13 Handel/);
  assert.match(build, /src\/trade\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.92-h26'/);
  assert.match(boundary, /buy_with_gold: Object\.freeze\(\{ publicName: 'buy_with_gold'/);
  assert.match(boundary, /trade_buy: Object\.freeze\(\{ publicName: 'trade_buy'/);
  assert.match(boundary, /ALBOT_PLAYER_TRADE_RID_MISMATCH/);
  assert.match(adapter, /marketSnapshot\(options = \{\}\)/);
  assert.match(adapter, /npcShopSources\(itemName\)/);
  assert.equal(pkg.version, '0.26.92');
});
