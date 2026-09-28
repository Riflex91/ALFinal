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

test('encounter catalog enables all newly discovered bosses and events by default and persists opt-out', () => {
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
  assert.equal(catalog.defaultEnabled, true);
  assert.equal(catalog.bosses.find(row => row.id === 'bigboss').enabled, true);
  assert.equal(catalog.events.find(row => row.id === 'seasonal').enabled, true);
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.equal(controller.setEnabled('event', 'seasonal', false).accepted, true);
  catalog = controller.catalog();
  assert.equal(catalog.events.find(row => row.id === 'seasonal').enabled, false);
});

test('disabled set keeps future encounter content enabled by default', () => {
  const { root, storage } = context({
    G: { monsters: { boss1: { boss: true } } },
    S: {}
  });
  vm.runInNewContext(encounterSource, root);
  const Controller = root.__ALBOT_INTERNALS__.EncounterController;
  const first = new Controller({ root, storage, game: { visibleMonsters: () => [], monsterDefinition: () => ({ boss: true }) } });
  first.setEnabled('boss', 'boss1', false);
  root.G.monsters.boss2 = { boss: true };
  const second = new Controller({ root, storage, game: { visibleMonsters: () => [], monsterDefinition: () => ({ boss: true }) } });
  const catalog = second.catalog();
  assert.equal(catalog.bosses.find(row => row.id === 'boss1').enabled, false);
  assert.equal(catalog.bosses.find(row => row.id === 'boss2').enabled, true);
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
  assert.deepEqual(calls[0].args, ['trade1']);

  root.character.slots.trade1 = null;
  inventoryRows = [{ slot: 4, name: 'sellme', level: 0, quantity: 2, statType: null, property: null, locked: false, giveaway: false }];
  const second = stand.tick();
  assert.equal(second.state, 'DISPATCHED');
  assert.equal(calls[1].action, 'trade');
  assert.deepEqual(calls[1].args, [4, 1, 800, 2]);

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
