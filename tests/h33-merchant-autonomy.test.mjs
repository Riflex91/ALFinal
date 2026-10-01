import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/merchant-autonomy.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fixture(options = {}) {
  const listeners = {};
  const socketListeners = {};
  const state = {
    inventory: clone(options.inventory || [
      { slot: 0, name: 'rod', level: 0, quantity: 1, locked: false, giveaway: false, definition: { type: 'tool', wtype: 'rod' } },
      { slot: 1, name: 'stand0', level: 0, quantity: 1, locked: false, giveaway: false, definition: { type: 'stand' } }
    ]),
    dispatches: [],
    movement: null,
    gold: options.gold == null ? 1_000_000 : options.gold
  };
  const character = {
    name: 'My_Merchant',
    ctype: 'merchant',
    level: options.level == null ? 90 : options.level,
    map: options.map || 'main',
    in: options.instance || 'main',
    real_x: options.x == null ? 0 : options.x,
    real_y: options.y == null ? 0 : options.y,
    hp: 2000,
    max_hp: 2000,
    mp: 5000,
    max_mp: 5000,
    gold: state.gold,
    moving: false,
    rip: false,
    stand: options.stand === true,
    p: options.stand === true ? { stand: true } : {},
    s: {},
    slots: clone(options.tradeSlots || {}),
    on: (name, handler) => {
      listeners[name] = handler;
      return name + '-listener';
    },
    remove: id => {
      for (const [name] of Object.entries(listeners)) if (id === name + '-listener') delete listeners[name];
    }
  };
  if (options.mainhand) character.slots.mainhand = clone(options.mainhand);
  else if (options.rodEquipped !== false) character.slots.mainhand = { name: 'rod', level: 0 };

  const entities = options.entities || {};
  const G = {
    items: {
      hpot0: { name: 'HP Potion', type: 'pot', g: 20 },
      stand0: { name: 'Merchant Stand', type: 'stand', g: 1000 },
      rod: { name: 'Rod', type: 'tool', wtype: 'rod', g: 2000 },
      pickaxe: { name: 'Pickaxe', type: 'tool', wtype: 'pickaxe', g: 2000 },
      bargain: { name: 'Bargain', type: 'material', g: 100 },
      ...clone(options.items || {})
    },
    maps: {
      main: {
        safe: true,
        npcs: [],
        zones: [
          { type: 'fishing', polygon: [[-20, -20], [20, -20], [20, 20], [-20, 20]] }
        ]
      },
      woffice: {
        safe: true,
        npcs: [],
        zones: [
          { type: 'mining', polygon: [[-184, -232], [-128, -232], [-128, -184], [-184, -184]] }
        ]
      }
    },
    npcs: {
      citizen22: {
        name: 'Merrit',
        market: {
          areas: [[-240, -120, 240, 144], [-88, 144, 88, 360]],
          handoff: 32,
          settle_ms: 120000,
          hour_ms: 3600000,
          anchor_tolerance: 4,
          npc_clearance: 40,
          stand_clearance: 10,
          front_width: 10,
          front_clearance: 15
        }
      }
    },
    multipliers: { secondhands_mult: 2, secondhands_cash_mult: 2 }
  };

  const socket = {
    on: (name, handler) => { socketListeners[name] = handler; },
    off: (name, handler) => { if (socketListeners[name] === handler) delete socketListeners[name]; }
  };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    character, entities, G, socket,
    is_on_cooldown: skill => !!(options.cooldowns && options.cooldowns.includes(skill)),
    calculate_item_value: item => options.itemValue == null ? Number(G.items[item.name]?.g || 0) : options.itemValue,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;

  const enabledSkills = new Set(options.enabledSkills || []);
  const game = {
    snapshot: () => ({
      available: true,
      character: {
        name: character.name,
        ctype: character.ctype,
        level: character.level,
        map: character.map,
        x: character.real_x,
        y: character.real_y,
        hp: character.hp,
        maxHp: character.max_hp,
        mp: character.mp,
        maxMp: character.max_mp,
        gold: state.gold,
        moving: character.moving,
        rip: character.rip
      }
    }),
    inventorySnapshot: () => ({
      available: true,
      capacity: 42,
      usedSlots: state.inventory.length,
      freeSlots: 42 - state.inventory.length,
      items: clone(state.inventory)
    }),
    marketSnapshot: () => ({
      available: true,
      listings: clone(options.marketListings || [])
    }),
    npcLocation: id => id === 'secondhands' && options.ponty !== false
      ? { npcId: 'secondhands', map: 'main', x: character.real_x, y: character.real_y }
      : null,
    visibleMonsters: () => clone(options.monsters || []),
    skillReadiness: skill => ({
      available: enabledSkills.has(skill),
      allowed: enabledSkills.has(skill) && !(options.cooldowns || []).includes(skill),
      reasons: [],
      definition: { id: skill, mp: skill === 'fishing' || skill === 'mining' ? 120 : 0 }
    }),
    itemDefinition: name => clone(G.items[name] || null)
  };

  const classSkills = {
    isSkillEnabled: skill => enabledSkills.has(skill)
  };
  const movement = {
    status: () => state.movement || { active: false, activeOrder: null },
    smartMove: (destination, config) => {
      state.movement = { active: true, activeOrder: { owner: config.owner, destination: clone(destination) } };
      return { accepted: true, order: clone(state.movement.activeOrder) };
    },
    cancel: () => {
      state.movement = null;
      return { cancelled: true };
    }
  };
  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (name === 'wishlist') {
        const [slot, itemName, price, level, quantity] = args;
        character.slots[slot] = { name: itemName, price, level, q: quantity, b: true };
      }
      if (name === 'open_stand') {
        character.stand = true;
        character.p.stand = true;
      }
      if (name === 'close_stand') {
        character.stand = false;
        delete character.p.stand;
      }
      if (name === 'equip') {
        const item = state.inventory.find(row => Number(row.slot) === Number(args[0]));
        if (item) character.slots.mainhand = { name: item.name, level: item.level || 0 };
      }
      if (name === 'use_skill' && args[0] === 'fishing') {
        return { state: 'DISPATCHED', value: Promise.resolve({ response: 'fishing_success', found: true, item: 'seashell' }) };
      }
      if (name === 'use_skill' && args[0] === 'mining') {
        return { state: 'DISPATCHED', value: Promise.resolve({ response: 'mining_none', found: false }) };
      }
      if (name === 'use_skill') {
        character.s[args[0]] = { ms: 10000 };
        return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
      }
      if (name === 'get_secondhands') {
        return { state: 'DISPATCHED', value: Promise.resolve({ success: true, items: clone(options.pontyItems || []) }) };
      }
      if (name === 'buy_secondhand') {
        const row = (options.pontyItems || []).find(item => String(item.rid) === String(args[0]));
        if (row) {
          state.inventory.push({
            slot: state.inventory.length + 10,
            name: row.name,
            level: row.level || 0,
            quantity: row.q || 1,
            definition: clone(G.items[row.name] || {})
          });
          const cost = Number(options.pontyBuyCost == null ? 200 : options.pontyBuyCost);
          state.gold -= cost;
          character.gold = state.gold;
        }
        return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
      }
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };
  const economy = {
    status: () => ({ autonomyEnabled: false, currentAction: null, suspendedReason: null }),
    plan: () => options.economySelected
      ? { state: 'READY', selected: clone(options.economySelected) }
      : { state: 'IDLE', reason: 'H17_NO_SAFE_ECONOMY_ACTION', selected: null }
  };
  const market = {
    priceBand: (name, config) => ({
      itemName: name,
      level: config.level || 0,
      recommendedAsk: options.marketAsk == null ? 1000 : options.marketAsk,
      confidence: options.marketConfidence || 'LIVE_VISIBLE'
    })
  };
  const gearProgression = {
    evaluateItem: item => options.progressionUseful
      ? { checked: true, protected: true, action: 'GEAR', item: item.name }
      : { checked: true, protected: false, action: 'SELL', item: item.name }
  };
  const memory = new Map();
  const storage = {
    getShared: key => memory.get(key) || null,
    setShared: (key, value) => { memory.set(key, value); return true; },
    get: key => memory.get(key) || null,
    set: (key, value) => { memory.set(key, value); return true; }
  };

  vm.runInNewContext(source, ctx, { filename: 'merchant-autonomy.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.MerchantAutonomyController;
  const controller = new Controller({
    root: ctx,
    game,
    actions,
    movement,
    inventory: { plan: () => ({ state: 'READY', items: clone(state.inventory), inventory: { freeSlots: 40 } }) },
    classSkills,
    trade: options.trade || null,
    economy,
    exchangeCraft: options.exchangeCraft || null,
    merchantStand: null,
    market,
    gearProgression,
    storage,
    canAct: () => true,
    pontyProbeMs: 15000,
    giveawayProbeMs: 2000
  });
  controller.start({ scope: { interval: () => 'merchant-autonomy-observer' } });
  controller.configure({ autoManage: true });

  return { controller, state, character, ctx, listeners, socketListeners, game, actions };
}

function coolMerrit(f) {
  f.controller.lastMerritReceipt = { at: new Date().toISOString(), atMs: Date.now(), shells: 0, source: 'TEST' };
}

test('H33 Merrit deliberately settles for two minutes, then waits stationary for the 32px handoff', () => {
  const f = fixture({
    stand: true,
    tradeSlots: { trade1: { name: 'hpot0', price: 20, q: 1 } },
    entities: { merrit: { id: 'citizen22', name: 'Merrit', npc: true, map: 'main', real_x: 20, real_y: 0 } }
  });
  const first = f.controller.plan({ backgroundAllowed: false });
  assert.equal(first.state, 'READY');
  assert.equal(first.selected.kind, 'MERRIT_SETTLE');
  assert.equal(first.selected.exclusive, true);
  assert.ok(first.selected.settleRemainingMs > 0);
  assert.ok(f.controller.status().merrit.session);

  f.controller.merritSession.sinceMs = Date.now() - 120001;
  const ready = f.controller.plan({ backgroundAllowed: false });
  assert.equal(ready.selected.kind, 'MERRIT_WAIT');
  assert.equal(ready.selected.handoffRange, 32);
  assert.equal(ready.selected.withinHandoff, true);
  assert.ok(ready.selected.merritDistance <= 32);
});

test('H33 Merrit character event records parcel evidence and starts the one-hour cooldown', () => {
  const f = fixture({
    stand: true,
    tradeSlots: { trade1: { name: 'hpot0', price: 20, q: 1 } }
  });
  assert.equal(typeof f.listeners.merrit, 'function');
  f.listeners.merrit({ item: 'marketparcel', quantity: 1, shells: 1 });

  const status = f.controller.status();
  assert.equal(status.metrics.merritParcels, 1);
  assert.equal(status.metrics.merritShells, 1);
  assert.ok(status.merrit.cooldownRemainingMs > 3_500_000);
  assert.equal(status.merrit.lastReceipt.item, 'marketparcel');
});

test('H33 creates a safe own wishlist when Merrit needs a qualifying listing', async () => {
  const f = fixture({ stand: true, rodEquipped: false, enabledSkills: [] });
  const plan = f.controller.plan({ backgroundAllowed: false });
  assert.equal(plan.selected.kind, 'WISHLIST');
  assert.equal(plan.selected.wishlist.name, 'hpot0');
  assert.equal(plan.selected.wishlist.quantity, 1);

  const step = f.controller.tick({ backgroundAllowed: false });
  assert.equal(step.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.at(-1).name, 'wishlist');
  await Promise.resolve();
  f.controller.tick({ backgroundAllowed: false });
  assert.equal(f.controller.status().metrics.wishlistsCreated, 1);
  assert.equal(f.character.slots.trade1.b, true);
});

test('H33 Fishing uses the live zone and confirmed use_skill result', async () => {
  const cooldowns = [];
  const f = fixture({
    enabledSkills: ['fishing'],
    cooldowns,
    ponty: false,
    stand: false,
    rodEquipped: true
  });
  coolMerrit(f);
  const plan = f.controller.plan({ backgroundAllowed: true });
  assert.equal(plan.selected.kind, 'GATHER');
  assert.equal(plan.selected.gatherKind, 'fishing');

  const step = f.controller.tick({ backgroundAllowed: true });
  assert.equal(step.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches.at(-1), { name: 'use_skill', args: ['fishing'] });
  cooldowns.push('fishing');
  await Promise.resolve();
  f.controller.tick({ backgroundAllowed: true });
  const status = f.controller.status();
  assert.equal(status.metrics.gatheringAttempts, 1);
  assert.equal(status.metrics.gatheringFound, 1);
  assert.equal(status.gathering.lastResult.kind, 'fishing');
  assert.equal(status.gathering.lastResult.found, true);
});

test('H33 joins visible giveaways once and never creates a giveaway', async () => {
  const f = fixture({
    enabledSkills: [],
    ponty: false,
    marketListings: [
      { playerName: 'OtherMerchant', slot: 'trade4', rid: 'give-1', name: 'hpot0', giveaway: true }
    ]
  });
  coolMerrit(f);

  const first = f.controller.tick({ backgroundAllowed: true });
  assert.equal(first.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches.at(-1), {
    name: 'join_giveaway',
    args: ['OtherMerchant', 'trade4', 'give-1']
  });
  await Promise.resolve();
  f.controller.tick({ backgroundAllowed: true });
  assert.equal(f.controller.status().metrics.giveawaysJoined, 1);
  assert.equal(f.state.dispatches.some(row => row.name === 'giveaway'), false);
});

test('H33 scans Ponty and buys only a strong revalidated bargain inside budget', async () => {
  const f = fixture({
    enabledSkills: [],
    ponty: true,
    pontyItems: [{ name: 'bargain', level: 0, q: 1, rid: 'ponty-1' }],
    pontyBuyCost: 200,
    itemValue: 100,
    marketAsk: 1000,
    marketConfidence: 'LIVE_VISIBLE'
  });
  coolMerrit(f);

  const scan = f.controller.tick({ backgroundAllowed: true });
  assert.equal(scan.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.at(-1).name, 'get_secondhands');
  await Promise.resolve();

  const buy = f.controller.tick({ backgroundAllowed: true });
  assert.equal(buy.state, 'DISPATCHED');
  assert.equal(f.state.dispatches.at(-1).name, 'buy_secondhand');
  assert.equal(f.state.dispatches.at(-1).args[0], 'ponty-1');
  await Promise.resolve();

  f.controller.tick({ backgroundAllowed: true });
  const status = f.controller.status();
  assert.equal(status.metrics.pontyScans, 1);
  assert.equal(status.metrics.pontyBuys, 1);
  assert.ok(status.metrics.pontySpend > 0);
});

test('H33 Merchant pre-buffs Exchange with the strongest enabled mass-exchange skill', async () => {
  const f = fixture({
    enabledSkills: ['massexchange', 'massexchangepp'],
    ponty: false,
    economySelected: { kind: 'EXCHANGE', itemName: 'marketparcel' }
  });
  coolMerrit(f);
  const plan = f.controller.plan({ backgroundAllowed: false });
  assert.equal(plan.selected.kind, 'MERCHANT_SKILL');
  assert.equal(plan.selected.skillId, 'massexchangepp');
  assert.equal(plan.selected.priorityClass, 'ECONOMY_PREBUFF');

  const step = f.controller.tick({ backgroundAllowed: false });
  assert.equal(step.state, 'DISPATCHED');
  assert.deepEqual(f.state.dispatches.at(-1), { name: 'use_skill', args: ['massexchangepp'] });
  await Promise.resolve();
  f.controller.tick({ backgroundAllowed: false });
  assert.equal(f.controller.status().metrics.merchantSkills, 1);
});

test('H33 wiring exposes only giveaway-join, Merchant skill policy, runtime module and Full Autonomy ownership', () => {
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const skills = fs.readFileSync(path.resolve(here, '../src/class-skills.js'), 'utf8');
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const full = fs.readFileSync(path.resolve(here, '../src/full-autonomy.js'), 'utf8');
  const stand = fs.readFileSync(path.resolve(here, '../src/market-intelligence.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');

  assert.match(boundary, /wishlist: Object\.freeze/);
  assert.match(boundary, /join_giveaway: Object\.freeze/);
  assert.match(boundary, /get_secondhands: Object\.freeze/);
  assert.match(boundary, /buy_secondhand: Object\.freeze/);
  assert.doesNotMatch(boundary, /^\s*giveaway: Object\.freeze/m);

  assert.match(skills, /merchant: Object\.freeze\(\['fishing', 'mining', 'mluck'/);
  assert.match(skills, /throw: 'DESTRUCTIVE_ITEM_THROW_REQUIRES_EXPLICIT_INTENT'/);
  assert.match(runtime, /new ns\.MerchantAutonomyController/);
  assert.match(runtime, /id: 'merchant-autonomy'/);
  assert.match(full, /owner: 'merchant-autonomy'/);
  assert.match(full, /backgroundAllowed: true/);
  assert.match(stand, /MERCHANT_AUTONOMY_ACTIVE/);
  assert.match(build, /src\/merchant-autonomy\.js/);
});
