import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const encounterSource = fs.readFileSync(path.resolve(here, '../src/encounters.js'), 'utf8');
const marketSource = fs.readFileSync(path.resolve(here, '../src/market-intelligence.js'), 'utf8');
const telemetrySource = fs.readFileSync(path.resolve(here, '../src/telemetry.js'), 'utf8');
const actionSource = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function context(extra = {}) {
  const storageMap = new Map();
  const root = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone,
        cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
      }
    },
    ...extra
  };
  root.globalThis = root;
  return {
    root,
    storage: {
      get: key => storageMap.get(key) || null,
      set: (key, value) => { storageMap.set(key, value); return true; }
    }
  };
}

test('encounter catalog defaults off and saves explicit per-ID opt-ins', () => {
  const { root, storage } = context({
    G: { monsters: { bigboss: { name: 'Big Boss', boss: true }, goo: { name: 'Goo' } } },
    S: { seasonal: { live: true, map: 'main', x: 10, y: 20 } }
  });
  vm.runInNewContext(encounterSource, root);
  const Controller = root.__ALBOT_INTERNALS__.EncounterController;
  const controller = new Controller({
    root, storage,
    game: { visibleMonsters: () => [], monsterDefinition: id => id === 'bigboss' ? { boss: true } : null }
  });
  let catalog = controller.catalog();
  assert.equal(catalog.defaultEnabled, false);
  assert.equal(catalog.bosses.find(row => row.id === 'bigboss').enabled, false);
  assert.equal(catalog.events.find(row => row.id === 'seasonal').enabled, false);
  assert.equal(controller.preferredTask(), null);
  assert.equal(controller.setEnabled('event', 'seasonal', true).accepted, true);
  assert.equal(controller.setEnabled('boss', 'bigboss', true).accepted, true);
  catalog = controller.catalog();
  assert.equal(catalog.events.find(row => row.id === 'seasonal').enabled, true);
  assert.equal(catalog.bosses.find(row => row.id === 'bigboss').enabled, true);
  assert.equal(controller.setEnabled('event', 'seasonal', false).enabled, false);
  const reloaded = new Controller({
    root, storage, game: { visibleMonsters: () => [], monsterDefinition: () => null }
  });
  assert.equal(reloaded.catalog().events.find(row => row.id === 'seasonal').enabled, false);
  assert.equal(reloaded.catalog().bosses.find(row => row.id === 'bigboss').enabled, true);
});

test('Anniversary celebration without a live claimable visit does not preempt FARM', () => {
  const now = Date.now();
  const { root, storage } = context({
    server_region: 'EU',
    server_identifier: 'II',
    character: { name: 'My_Ranger1', ctype: 'ranger', gold: 200000, items: [], s: {} },
    G: { monsters: {}, craft: {} },
    S: { anniversary: { active: true, live: false, next: now + 60000 } }
  });
  vm.runInNewContext(encounterSource, root);
  const Controller = root.__ALBOT_INTERNALS__.EncounterController;
  const controller = new Controller({
    root, storage,
    game: { visibleMonsters: () => [], monsterDefinition: () => null, npcLocation: () => ({ npcId: 'anniversary_baker', map: 'main', x: 64, y: -88 }) }
  });
  const event = controller.catalog().events.find(row => row.id === 'anniversary');
  assert.equal(event.active, true, 'celebration remains visible in the catalog');
  assert.equal(controller.preferredTask(), null, 'inactive visit window must not replace normal FARM');
  assert.equal(controller.status().anniversary.visit.reason, 'ANNIVERSARY_NO_LIVE_VISIT');
});

test('Anniversary live round becomes actionable only with matching visit ticket and exposes workshop readiness', () => {
  const now = Date.now();
  const round = 123;
  const ticket = { ms: 240000, round, realm: 'EU II', expires: now + 240000 };
  const { root, storage } = context({
    server_region: 'EU',
    server_identifier: 'II',
    character: {
      name: 'My_Priest', ctype: 'priest', gold: 150000,
      items: [
        { name: 'slice_strawberry', q: 1 }, { name: 'slice_citrus', q: 1 },
        { name: 'slice_honey', q: 1 }, { name: 'slice_mint', q: 1 },
        { name: 'slice_blueberry', q: 1 }, { name: 'slice_nightberry', q: 1 }
      ],
      s: { anniversary_visit: ticket }
    },
    G: {
      monsters: {},
      craft: {
        sixcake: {
          cost: 100000,
          items: [
            [1, 'slice_strawberry', 0], [1, 'slice_citrus', 0], [1, 'slice_honey', 0],
            [1, 'slice_mint', 0], [1, 'slice_blueberry', 0], [1, 'slice_nightberry', 0]
          ]
        }
      }
    },
    S: {
      anniversary: {
        active: true, live: true, id: 'FeaturedPlayerId', target: 'FeaturedPlayer',
        map: 'main', x: 420, y: 180, round, expires: now + 240000, available: true
      }
    }
  });
  vm.runInNewContext(encounterSource, root);
  const Controller = root.__ALBOT_INTERNALS__.EncounterController;
  const controller = new Controller({
    root, storage,
    game: { visibleMonsters: () => [], monsterDefinition: () => null, npcLocation: () => ({ npcId: 'anniversary_baker', map: 'main', x: 64, y: -88 }) }
  });
  controller.setEnabled('event', 'anniversary', true);
  const preferred = controller.preferredTask();
  assert.equal(preferred.taskType, 'EVENT');
  assert.equal(preferred.actionability.interaction, 'ANNIVERSARY_VISIT');
  const plan = controller.plan({ taskType: 'EVENT' });
  assert.equal(plan.state, 'READY');
  assert.equal(plan.reason, 'ANNIVERSARY_VISIT_READY');
  assert.equal(plan.targetId, 'FeaturedPlayerId');
  assert.equal(plan.location.map, 'main');
  assert.equal(plan.location.x, 420);
  const anniversary = controller.status().anniversary;
  assert.equal(anniversary.workshop.map, 'main');
  assert.equal(anniversary.workshop.x, 64);
  assert.equal(anniversary.inventory.sixcakeRecipe.ready, true);
  assert.equal(anniversary.policies.automaticCraftingEnabled, false);
  assert.equal(anniversary.policies.automaticRewardOpeningEnabled, false);
});

test('Anniversary visit travels to featured player and dispatches I Kiss You only inside the live window', async () => {
  const now = Date.now();
  const round = 456;
  const character = {
    name: 'My_Warrior', ctype: 'warrior', map: 'main', x: 0, y: 0, gold: 0, items: [],
    s: { anniversary_visit: { ms: 240000, round, realm: 'EU II', expires: now + 240000 } }
  };
  const moves = [];
  const actions = [];
  let nearby = false;
  const { root, storage } = context({
    server_region: 'EU',
    server_identifier: 'II',
    character,
    G: { monsters: {}, craft: {} },
    S: {
      anniversary: {
        active: true, live: true, id: 'FeaturedPlayerId', target: 'FeaturedPlayer',
        map: 'main', x: 100, y: 0, round, expires: now + 240000, available: true
      }
    }
  });
  vm.runInNewContext(encounterSource, root);
  const Controller = root.__ALBOT_INTERNALS__.EncounterController;
  const movement = {
    status: () => ({ activeOrder: null }),
    smartMove(destination, options) {
      moves.push({ destination: clone(destination), options: clone(options) });
      return { accepted: true, order: { owner: options.owner } };
    },
    cancel: () => ({ cancelled: true })
  };
  const game = {
    snapshot: () => ({ character: clone(character) }),
    visibleMonsters: () => [],
    monsterDefinition: () => null,
    visiblePlayers: () => nearby ? [{ id: 'FeaturedPlayerId', name: 'FeaturedPlayer', distance: 20 }] : [],
    npcLocation: () => ({ npcId: 'anniversary_baker', map: 'main', x: 64, y: -88 })
  };
  const controller = new Controller({
    root, storage, game, movement,
    combat: { status: () => ({ session: null, lastSession: null }) },
    actions: {
      dispatch(action, args) {
        actions.push({ action, args: clone(args) });
        return { dispatched: true, value: Promise.resolve({ rewarded: true }) };
      }
    },
    canAct: () => true
  });
  controller.moduleActive = true;
  controller.setEnabled('event', 'anniversary', true);
  assert.equal(controller.startAutonomy({ owner: 'test', taskType: 'EVENT' }).accepted, true);

  const travelling = controller.tick();
  assert.equal(travelling.state, 'TRAVELLING');
  assert.equal(travelling.reason, 'ANNIVERSARY_TRAVEL');
  assert.deepEqual(moves[0].destination, { map: 'main', x: 100, y: 0 });
  assert.equal(moves[0].options.owner, 'encounter-h23:anniversary');
  assert.equal(actions.length, 0);

  character.x = 80;
  nearby = true;
  const interacting = controller.tick();
  assert.equal(interacting.state, 'INTERACTING');
  assert.equal(interacting.reason, 'ANNIVERSARY_KISS_DISPATCHED');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'use_skill');
  assert.deepEqual(actions[0].args, ['ikissyou', 'FeaturedPlayerId']);
  await Promise.resolve();
  assert.equal(controller.status().metrics.anniversaryVisitsConfirmed, 1);
});

test('explicitly enabled boss does not opt in future discoveries', () => {
  const { root, storage } = context({
    G: { monsters: { boss1: { boss: true } } },
    S: {}
  });
  vm.runInNewContext(encounterSource, root);
  const Controller = root.__ALBOT_INTERNALS__.EncounterController;
  const first = new Controller({ root, storage, game: { visibleMonsters: () => [], monsterDefinition: () => ({ boss: true }) } });
  first.setEnabled('boss', 'boss1', true);
  root.G.monsters.boss2 = { boss: true };
  const second = new Controller({ root, storage, game: { visibleMonsters: () => [], monsterDefinition: () => ({ boss: true }) } });
  const catalog = second.catalog();
  assert.equal(catalog.bosses.find(row => row.id === 'boss1').enabled, true);
  assert.equal(catalog.bosses.find(row => row.id === 'boss2').enabled, false);
});

test('ALData refresh consumes the documented /trades WTS/WTB schema and drops stale owners', async () => {
  const now = Date.now();
  const { root, storage } = context({
    character: { name: 'LocalMerchant', owner: 'local-owner' },
    fetch: async (url) => {
      assert.equal(url, 'https://aldata.earthiverse.ca/trades');
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            owner: 'remote-owner',
            lastUpdated: now,
            listings: [{
              name: 'firestaff',
              level: 9,
              wts: { price: 50_000_000, quantity: 1 },
              wtb: { price: 40_000_000, quantity: 2 }
            }]
          },
          {
            owner: 'stale-owner',
            lastUpdated: now - 8 * 86400000,
            listings: [{ name: 'firestaff', level: 9, wts: { price: 1 } }]
          },
          {
            owner: 'local-owner',
            lastUpdated: now,
            listings: [{ name: 'firestaff', level: 9, wts: { price: 2 } }]
          }
        ]
      };
    }
  });
  vm.runInNewContext(marketSource, root);
  const Market = root.__ALBOT_INTERNALS__.ALDataMarketIntelligence;
  const market = new Market({ root, storage, game: {}, trade: null });
  market.moduleActive = true;
  const refreshed = await market.refresh();
  assert.equal(refreshed.accepted, true);
  assert.equal(refreshed.listings, 3);
  assert.equal(refreshed.staleDropped, 1);
  const info = market.item('firestaff', { level: 9 });
  assert.equal(info.sampleCount, 2);
  assert.equal(info.bestAsk.price, 50_000_000);
  assert.equal(info.bestBid.price, 40_000_000);
  assert.equal(market.status().endpoint, 'https://aldata.earthiverse.ca/trades');
});

test('market price band is advisory and cannot bypass live mutation safety', () => {
  const { root, storage } = context();
  vm.runInNewContext(marketSource, root);
  const Market = root.__ALBOT_INTERNALS__.ALDataMarketIntelligence;
  const market = new Market({
    root, storage,
    game: { itemDefinition: () => ({ g: 100 }) },
    trade: { marketAnalysis: () => ({ bestAsk: { price: 200 }, bestBid: { price: 150 } }) }
  });
  market.snapshot = {
    fetchedAt: new Date().toISOString(),
    fetchedAtMs: Date.now(),
    listings: [
      { itemName: 'testitem', level: 0, price: 210, buying: false },
      { itemName: 'testitem', level: 0, price: 220, buying: false },
      { itemName: 'testitem', level: 0, price: 140, buying: true }
    ]
  };
  const band = market.priceBand('testitem');
  assert.equal(band.advisoryOnly, true);
  assert.equal(band.liveTruthRequiredBeforeMutation, true);
  assert.equal(band.confidence, 'LIVE_VISIBLE');
  assert.ok(band.recommendedAsk >= 110);
  assert.ok(band.recommendedAsk < 200);
});

test('merchant stand automatic mutation is off by default and only considers explicit SELL rows', () => {
  const { root } = context({ character: { name: 'M', ctype: 'merchant', stand: true, slots: {} } });
  vm.runInNewContext(marketSource, root);
  const Stand = root.__ALBOT_INTERNALS__.MerchantStandController;
  const stand = new Stand({
    root,
    game: { inventorySnapshot: () => ({ items: [] }) },
    inventory: { plan: () => ({ items: [
      { slot: 0, name: 'keepme', level: 0, quantity: 1, disposition: 'KEEP', protected: true },
      { slot: 1, name: 'sellme', level: 0, quantity: 2, disposition: 'SELL', protected: false }
    ] }) },
    market: { priceBand: name => name === 'sellme' ? { recommendedAsk: 500, confidence: 'ALDATA_SAMPLE' } : null },
    combat: { status: () => ({ active: false }) },
    movement: { status: () => ({ active: false }) },
    economy: { status: () => ({ autonomyEnabled: false, currentAction: null }) },
    partyLogistics: { status: () => ({ autonomyEnabled: false, currentAction: null }) }
  });
  assert.equal(stand.status().autoManage, false);
  const plan = stand.plan();
  assert.equal(plan.selected.itemName, 'sellme');
  assert.equal(plan.selected.price, 500);
});

test('merchant repricing uses validated unlist then relist and confirms from live slot state', () => {
  const { root } = context({
    character: {
      name: 'M',
      ctype: 'merchant',
      stand: true,
      slots: {
        trade1: { name: 'sellme', level: 0, q: 2, price: 1000, rid: 'rid-a' }
      }
    }
  });
  vm.runInNewContext(marketSource, root);
  const Stand = root.__ALBOT_INTERNALS__.MerchantStandController;
  let inventoryRows = [];
  const calls = [];
  const stand = new Stand({
    root,
    game: {
      inventorySnapshot: () => ({ available: true, freeSlots: 3, items: inventoryRows })
    },
    inventory: {
      plan: () => ({ items: [] }),
      ruleSnapshot: () => ({ sellNames: ['sellme'] })
    },
    market: {
      priceBand: () => ({ recommendedAsk: 800, confidence: 'LIVE_VISIBLE' })
    },
    actions: {
      dispatch: (action, args) => {
        calls.push({ action, args });
        return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
      }
    },
    combat: { status: () => ({ active: false }) },
    movement: { status: () => ({ active: false }) },
    economy: { status: () => ({ autonomyEnabled: false, currentAction: null }) },
    partyLogistics: { status: () => ({ autonomyEnabled: false, currentAction: null }) },
    canAct: () => true
  });
  stand.moduleActive = true;
  stand.autoManage = true;

  const first = stand.tick();
  assert.equal(first.state, 'DISPATCHED');
  assert.equal(calls[0].action, 'unequip');
  assert.deepEqual(Array.from(calls[0].args), ['trade1']);

  root.character.slots.trade1 = null;
  inventoryRows = [{ slot: 4, name: 'sellme', level: 0, quantity: 2, statType: null, property: null, locked: false, giveaway: false }];
  const second = stand.tick();
  assert.equal(second.state, 'DISPATCHED');
  assert.equal(calls[1].action, 'trade');
  assert.deepEqual(Array.from(calls[1].args), [4, 1, 800, 2]);

  root.character.slots.trade1 = { name: 'sellme', level: 0, q: 2, price: 800, rid: 'rid-b' };
  const third = stand.tick();
  assert.equal(third.state, 'CONFIRMED');
  assert.equal(stand.status().repricesThisSession, 1);
  assert.equal(stand.status().pending, null);
});

test('action boundary exposes merchant stand actions through the central write gate', () => {
  const { root } = context({
    open_stand: () => true,
    close_stand: () => true,
    trade: () => true
  });
  vm.runInNewContext(actionSource, root);
  const Boundary = root.__ALBOT_INTERNALS__.GameActionBoundary;
  const actions = new Boundary({ root, assertAllowed: () => true });
  assert.equal(actions.available('open_stand'), true);
  assert.equal(actions.available('close_stand'), true);
  assert.equal(actions.available('trade'), true);
});

test('telemetry client contract points to localhost recorder and D drive storage', () => {
  const { root } = context();
  vm.runInNewContext(telemetrySource, root);
  const Client = root.__ALBOT_INTERNALS__.HostTelemetryClient;
  const client = new Client({ root, runtime: {} });
  const status = client.status();
  assert.equal(status.endpoint, 'http://127.0.0.1:17391/v1/telemetry');
  assert.equal(status.hostStorageContract.defaultRoot, 'D:/ALBot/telemetry');
});

test('host telemetry store writes short-term NDJSON and long-term daily summaries', async () => {
  const { TelemetryStore } = await import('../host/telemetry-recorder.mjs');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-telemetry-'));
  const store = new TelemetryStore({ root: rootDir, rawRetentionDays: 30, dailyRetentionDays: 365 });
  store.ingest({
    atMs: Date.now(),
    character: { name: 'Farmer A', map: 'main', hp: 900, maxHp: 1000, gold: 12345 },
    fullAutonomy: { taskType: 'FARM' },
    encounter: { selected: null },
    health: { state: 'HEALTHY' }
  });
  store.flushDaily();
  assert.equal(fs.existsSync(path.join(rootDir, 'raw')), true);
  assert.equal(fs.existsSync(path.join(rootDir, 'daily')), true);
  assert.ok(fs.readdirSync(path.join(rootDir, 'daily')).length >= 1);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('full autonomy has explicit encounter ownership and task priority wiring', () => {
  const source = fs.readFileSync(path.resolve(here, '../src/full-autonomy.js'), 'utf8');
  assert.match(source, /encounterPriority/);
  assert.match(source, /FULL_AUTONOMY_ENCOUNTER_PRIORITY/);
  assert.match(source, /combat-encounter/);
  assert.match(source, /started\.encounters/);
});

test('runtime and public API expose H23 controllers', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  assert.match(runtime, /new ns\.EncounterController/);
  assert.match(runtime, /new ns\.ALDataMarketIntelligence/);
  assert.match(runtime, /new ns\.MerchantStandController/);
  assert.match(runtime, /new ns\.HostTelemetryClient/);
  assert.match(entry, /encounters:/);
  assert.match(entry, /marketIntelligence:/);
  assert.match(entry, /merchantStand:/);
  assert.match(entry, /telemetry:/);
});

test('build includes encounter market telemetry and advanced GUI modules', () => {
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  assert.match(build, /src\/encounters\.js/);
  assert.match(build, /src\/market-intelligence\.js/);
  assert.match(build, /src\/telemetry\.js/);
  assert.match(build, /src\/ui-advanced\.js/);
});
