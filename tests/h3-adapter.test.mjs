import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
const encoder = new TextEncoder();

function byteLength(text) {
  return encoder.encode(text).byteLength;
}

function response(text, status = 200) {
  const bytes = encoder.encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function runtimeContext(options = {}) {
  const memory = options.memory || new Map();
  const context = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    Uint8Array, ArrayBuffer, AbortController, TextEncoder, TextDecoder,
    crypto: webcrypto,
    fetch: options.fetch || (async () => response('{}', 404)),
    localStorage: {
      getItem: k => memory.has(k) ? memory.get(k) : null,
      setItem: (k,v) => memory.set(k,String(v)),
      removeItem: k => memory.delete(k)
    },
    navigator: { userAgent: 'node-h3-test' },
    character: options.character || {
      id: 'FarmerA',
      name: 'FarmerA',
      ctype: 'ranger',
      level: 42,
      hp: 900,
      max_hp: 1000,
      mp: 700,
      max_mp: 800,
      gold: 12345,
      xp: 999,
      map: 'main',
      real_x: 1,
      real_y: 2,
      range: 120,
      speed: 45,
      frequency: 1.2,
      target: 'm1'
    },
    entities: options.entities || {
      m1: {
        id: 'm1',
        name: 'Frog One',
        type: 'monster',
        mtype: 'frog',
        real_x: 4,
        real_y: 6,
        hp: 50,
        max_hp: 100,
        dead: false
      }
    },
    G: options.G || {
      monsters: { frog: {} },
      maps: { main: {} },
      items: { hpot0: {} },
      skills: { attack: {} }
    },
    server_region: 'EU',
    server_identifier: 'I',
    get_characters: () => [
      { name: 'FarmerA', ctype: 'ranger', online: true },
      { name: 'MerchantA', ctype: 'merchant', online: true }
    ],
    get_active_characters: () => ({ FarmerA: 'self', MerchantA: 'code' }),
    addEventListener() {},
    removeEventListener() {}
  };
  if (options.parent) context.parent = options.parent;
  context.globalThis = context;
  return { context, memory };
}

function liveFact() {
  return {
    schemaVersion: 1,
    spiel: 'Adventure Land - The Code MMORPG',
    kennung: 'server.eu.i.monster.frog.spawn',
    domaene: 'MONSTER',
    status: 'LIVE_VERIFIZIERT',
    beobachtetAm: '2026-09-26T16:00:00Z',
    verifiziertAm: '2026-09-26T16:00:01Z',
    quelle: {
      art: 'LIVE_SPIEL',
      methode: 'reconciled-world-observation'
    },
    wert: { mtype: 'frog', map: 'main' }
  };
}

function validMirrorFetch() {
  const manifestText = JSON.stringify({
    schemaVersion: 1,
    format: 'ADVENTURE_LAND_V5_LIVE_WISSEN',
    spiel: 'Adventure Land - The Code MMORPG',
    aktuellVerzeichnis: 'aktuell'
  });
  const statusText = JSON.stringify({
    schemaVersion: 1,
    spiel: 'Adventure Land - The Code MMORPG',
    generation: 7,
    zustand: 'BEREIT',
    aktualisiertAm: '2026-09-26T16:05:00Z'
  });
  const factText = JSON.stringify(liveFact());
  const relativePath = 'monster/frog.json';
  const factHash = createHash('sha256').update(Buffer.from(factText)).digest('hex');
  const snapshotHash = createHash('sha256')
    .update(Buffer.from(manifestText))
    .update(Buffer.from(statusText))
    .update(Buffer.from(relativePath))
    .update(Buffer.from(factHash))
    .digest('hex');
  const totalBytes = byteLength(manifestText) + byteLength(statusText) + byteLength(factText);
  const importText = JSON.stringify({
    schemaVersion: 1,
    importiertAm: '2026-09-26T16:05:02Z',
    generation: 7,
    dateien: 1,
    bytes: totalBytes,
    snapshotSha256: snapshotHash,
    quelle: 'LOKALE_LIVE_WISSENSDATENBANK',
    spiel: 'Adventure Land - The Code MMORPG'
  });

  let fail = false;
  const fetch = async url => {
    if (fail) return response('{}', 503);
    if (url.endsWith('/status.json')) return response(statusText);
    if (url.endsWith('/manifest.json')) return response(manifestText);
    if (url.endsWith('/import.json')) return response(importText);
    if (url.includes('/contents/v5/wissensbasis/live/snapshot/aktuell/monster?ref=main')) {
      return response(JSON.stringify([{
        type: 'file',
        path: 'v5/wissensbasis/live/snapshot/aktuell/monster/frog.json'
      }]));
    }
    if (url.includes('/contents/v5/wissensbasis/live/snapshot/aktuell?ref=main')) {
      return response(JSON.stringify([{
        type: 'dir',
        path: 'v5/wissensbasis/live/snapshot/aktuell/monster'
      }]));
    }
    if (url.endsWith('/aktuell/monster/frog.json')) return response(factText);
    return response('{}', 404);
  };

  return {
    fetch,
    fail: () => { fail = true; },
    snapshotHash
  };
}

test('H3 game adapter normalizes live character, position and target', () => {
  const { context: ctx } = runtimeContext();
  vm.runInNewContext(bundle, ctx, { filename: 'al-bot.js' });

  const snap = ctx.ALBot.game.snapshot();
  assert.equal(ctx.ALBot.version, '0.26.1-h26');
  assert.equal(snap.available, true);
  assert.equal(snap.character.name, 'FarmerA');
  assert.equal(snap.character.ctype, 'ranger');
  assert.equal(snap.character.map, 'main');
  assert.equal(snap.character.x, 1);
  assert.equal(snap.character.y, 2);
  assert.equal(snap.character.hp, 900);
  assert.equal(snap.character.maxHp, 1000);
  assert.equal(snap.character.mp, 700);
  assert.equal(snap.character.maxMp, 800);
  assert.equal(snap.target.id, 'm1');
  assert.equal(snap.target.mtype, 'frog');
  assert.equal(snap.target.distance, 5);
  assert.equal(snap.server.region, 'EU');
  assert.equal(snap.server.identifier, 'I');
});

test('H3 game adapter handles no target without inventing one', () => {
  const { context: ctx } = runtimeContext({
    character: {
      name: 'MerchantA',
      ctype: 'merchant',
      map: 'main',
      hp: 100,
      max_hp: 100,
      mp: 50,
      max_mp: 50,
      x: 0,
      y: 0,
      target: null
    },
    entities: {}
  });
  vm.runInNewContext(bundle, ctx);
  const snap = ctx.ALBot.game.snapshot();
  assert.equal(snap.available, true);
  assert.equal(snap.target, null);
  assert.equal(snap.character.targetId, null);
});

test('H12 game adapter exposes bank packs with verified map truth and leaves unknown pack maps null', () => {
  const bankCharacter = {
    name: 'MerchantA',
    ctype: 'merchant',
    map: 'bank',
    hp: 100,
    max_hp: 100,
    mp: 50,
    max_mp: 50,
    gold: 1000,
    items: new Array(6).fill(null),
    bank: {
      gold: 5000,
      items0: [{ name: 'hpot0', q: 3 }, null],
      mystery: [{ name: 'hpot0', q: 1 }, null]
    }
  };
  const { context: ctx } = runtimeContext({ character: bankCharacter, entities: {} });
  ctx.bank_packs = {
    items0: ['bank', 0, 0],
    items8: ['bank_b', 0, 0]
  };
  vm.runInNewContext(bundle, ctx);

  const bank = ctx.ALBot.game.bank();
  assert.equal(bank.available, true);
  assert.equal(bank.map, 'bank');
  assert.equal(bank.gold, 5000);
  const items0 = bank.packs.find(row => row.name === 'items0');
  const mystery = bank.packs.find(row => row.name === 'mystery');
  assert.equal(items0.map, 'bank');
  assert.equal(items0.items[0].name, 'hpot0');
  assert.equal(items0.items[0].quantity, 3);
  assert.equal(mystery.map, null);
});

test('Windows Bridge GitHub mirror snapshot is validated and persisted as LKG', async () => {
  const mirror = validMirrorFetch();
  const { context: ctx } = runtimeContext({ fetch: mirror.fetch });
  vm.runInNewContext(bundle, ctx);

  const refreshed = await ctx.ALBot.knowledge.refresh();
  assert.equal(refreshed.provider.state, 'READY');
  assert.equal(refreshed.provider.mode, 'GITHUB_MIRROR');
  assert.equal(refreshed.lastKnownGood.generation, 7);
  assert.equal(refreshed.lastKnownGood.snapshotSha256, mirror.snapshotHash);
  assert.equal(refreshed.lastKnownGood.factCount, 1);

  const fact = ctx.ALBot.knowledge.fact('server.eu.i.monster.frog.spawn');
  assert.equal(fact.domaene, 'MONSTER');
  assert.equal(fact.wert.mtype, 'frog');

  const persisted = new ctx.__ALBOT_INTERNALS__.KnowledgeService({
    logger: ctx.ALBot.__runtime.logger,
    storage: ctx.ALBot.__runtime.storage
  });
  assert.equal(persisted.status().lastKnownGood.generation, 7);
  assert.equal(persisted.fact('server.eu.i.monster.frog.spawn').wert.map, 'main');
});

test('Knowledge refresh failure preserves Last Known Good and runtime stability', async () => {
  const mirror = validMirrorFetch();
  const { context: ctx } = runtimeContext({ fetch: mirror.fetch });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();
  const resourcesBeforeRefresh = ctx.ALBot.scheduler.status().totalResources;

  await ctx.ALBot.knowledge.refresh();
  mirror.fail();
  const failed = await ctx.ALBot.knowledge.refresh();

  assert.equal(failed.provider.state, 'UNAVAILABLE');
  assert.equal(failed.usingLastKnownGood, true);
  assert.equal(failed.lastKnownGood.generation, 7);
  assert.equal(ctx.ALBot.knowledge.fact('server.eu.i.monster.frog.spawn').wert.mtype, 'frog');
  assert.equal(ctx.ALBot.status().running, true);
  assert.equal(ctx.ALBot.scheduler.status().totalResources, resourcesBeforeRefresh);

  await ctx.ALBot.stop('DONE');
});

test('Bridge outage without any LKG is diagnosable but does not crash core', async () => {
  const { context: ctx } = runtimeContext({ fetch: async () => response('{}', 503) });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();
  const resourcesBeforeRefresh = ctx.ALBot.scheduler.status().totalResources;

  const status = await ctx.ALBot.knowledge.refresh();
  assert.equal(status.provider.state, 'UNAVAILABLE');
  assert.equal(status.lastKnownGood, null);
  assert.match(status.lastRefreshError, /KNOWLEDGE_FETCH_FAILED/);
  assert.equal(ctx.ALBot.status().running, true);
  assert.equal(ctx.ALBot.scheduler.status().totalResources, resourcesBeforeRefresh);

  await ctx.ALBot.stop('DONE');
});

test('same-origin Windows Bridge handoff takes precedence over mirror fetch', async () => {
  const fact = liveFact();
  const sharedHost = {
    document: {},
    __ALBOT_WINDOWS_BRIDGE_KNOWLEDGE__: {
      schemaVersion: 1,
      generation: 9,
      source: 'WINDOWS_BRIDGE_HANDOFF',
      snapshotSha256: 'a'.repeat(64),
      factCount: 1,
      facts: [{ path: 'monster/frog.json', fact }]
    }
  };
  const { context: ctx } = runtimeContext({
    parent: sharedHost,
    fetch: async () => { throw new Error('MIRROR_SHOULD_NOT_BE_USED'); }
  });
  vm.runInNewContext(bundle, ctx);

  const status = await ctx.ALBot.knowledge.refresh();
  assert.equal(status.provider.state, 'READY');
  assert.equal(status.provider.mode, 'HANDOFF');
  assert.equal(status.lastKnownGood.generation, 9);
  assert.equal(ctx.ALBot.knowledge.fact(fact.kennung).status, 'LIVE_VERIFIZIERT');
});

test('H3 control center exposes Knowledge and normalized live game status', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /data-tab="knowledge"/);
  assert.match(ui, /Live Game Adapter/);
  assert.match(ui, /Knowledge aktualisieren/);
  assert.match(ui, /Last Known Good/);
  assert.match(ui, /Scheduler Starts/);
  assert.match(ui, /Runtime Starts/);
});


test('missing bridge snapshot is reported as waiting instead of runtime failure', async () => {
  const { context: ctx } = runtimeContext({ fetch: async () => response('{}', 404) });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const status = await ctx.ALBot.knowledge.refresh();
  assert.equal(status.provider.state, 'WAITING_FOR_BRIDGE');
  assert.equal(status.lastRefreshError, 'BRIDGE_SNAPSHOT_NOT_AVAILABLE');
  assert.equal(status.lastKnownGood, null);
  assert.equal(ctx.ALBot.status().running, true);

  await ctx.ALBot.stop('DONE');
});


test('character position is displayed with exactly two decimals', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /function formatPosition\(value\)/);
  assert.match(ui, /number\.toFixed\(2\)/);
  assert.match(ui, /formatPosition\(gameCharacter\.x\)/);
  assert.match(ui, /formatPosition\(gameCharacter\.y\)/);
});


test('H3 target lookup also accepts Adventure Land entity collection keys', () => {
  const { context: ctx } = runtimeContext({
    character: {
      name: 'FarmerA',
      ctype: 'ranger',
      map: 'main',
      hp: 100,
      max_hp: 100,
      mp: 50,
      max_mp: 50,
      real_x: 10,
      real_y: 20,
      target: '5887406'
    },
    entities: {
      '5887406': {
        name: 'Keyed Frog',
        type: 'monster',
        mtype: 'frog',
        real_x: 13,
        real_y: 24,
        hp: 40,
        max_hp: 50
      }
    }
  });
  vm.runInNewContext(bundle, ctx);

  const snap = ctx.ALBot.game.snapshot();
  assert.equal(snap.character.targetId, '5887406');
  assert.equal(snap.target.id, '5887406');
  assert.equal(snap.target.name, 'Keyed Frog');
  assert.equal(snap.target.mtype, 'frog');
  assert.equal(snap.target.distance, 5);
});


test('H3 target lookup merges runner and parent entity collections', () => {
  const sharedHost = {
    document: {},
    entities: {
      '5891957': {
        id: '5891957',
        name: 'Parent Frog',
        type: 'monster',
        mtype: 'frog',
        real_x: 16,
        real_y: 510,
        hp: 45,
        max_hp: 60
      }
    }
  };
  const { context: ctx } = runtimeContext({
    parent: sharedHost,
    character: {
      name: 'FarmerA',
      ctype: 'ranger',
      map: 'main',
      hp: 100,
      max_hp: 100,
      mp: 50,
      max_mp: 50,
      real_x: 13,
      real_y: 506,
      target: '5891957'
    },
    entities: {
      localOnly: {
        id: 'localOnly',
        name: 'Other Entity',
        type: 'monster',
        mtype: 'goo',
        real_x: 1,
        real_y: 1
      }
    }
  });
  vm.runInNewContext(bundle, ctx);

  const snap = ctx.ALBot.game.snapshot();
  assert.equal(snap.target.id, '5891957');
  assert.equal(snap.target.name, 'Parent Frog');
  assert.equal(snap.target.mtype, 'frog');
  assert.equal(snap.targetResolution.resolved, true);
  assert.equal(snap.targetResolution.entitySourceCount, 2);
  assert.equal(snap.targetResolution.mergedEntityCount, 2);
});


test('H3 uses Adventure Land parent.ctarget as primary selected monster source', () => {
  const selected = {
    id: '5894232',
    name: 'Selected Frog',
    type: 'monster',
    mtype: 'frog',
    real_x: 16,
    real_y: 510,
    hp: 55,
    max_hp: 60,
    dead: false
  };
  const sharedHost = {
    document: {},
    ctarget: selected,
    entities: {}
  };
  const { context: ctx } = runtimeContext({
    parent: sharedHost,
    character: {
      name: 'FarmerA',
      ctype: 'ranger',
      map: 'main',
      hp: 100,
      max_hp: 100,
      mp: 50,
      max_mp: 50,
      real_x: 13,
      real_y: 506,
      target: '5894232'
    },
    entities: {}
  });
  vm.runInNewContext(bundle, ctx);

  const snap = ctx.ALBot.game.snapshot();
  assert.equal(snap.character.targetId, '5894232');
  assert.equal(snap.target.id, '5894232');
  assert.equal(snap.target.name, 'Selected Frog');
  assert.equal(snap.target.mtype, 'frog');
  assert.equal(snap.targetResolution.resolved, true);
  assert.equal(snap.targetResolution.resolvedFrom, 'parent.ctarget');
  assert.equal(snap.target.distance, 5);
});
