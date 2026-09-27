import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runtimeContext() {
  const memory = new Map();
  const context = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    localStorage: {
      getItem: k => memory.has(k) ? memory.get(k) : null,
      setItem: (k,v) => memory.set(k,String(v)),
      removeItem: k => memory.delete(k)
    },
    navigator: { userAgent: 'node-h2-test' },
    character: { name: 'FarmerA', ctype: 'ranger', hp: 100, max_hp: 100, mp: 80, max_mp: 80, gold: 5, map: 'main', x: 1, y: 2 },
    get_characters: () => [
      { name: 'FarmerA', ctype: 'ranger', online: true },
      { name: 'MerchantA', ctype: 'merchant', online: true }
    ],
    get_active_characters: () => ({ FarmerA: 'self', MerchantA: 'code' }),
    addEventListener() {},
    removeEventListener() {}
  };
  context.globalThis = context;
  return context;
}

test('H2 exposes central scheduler and lifecycle API', () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx, { filename: 'al-bot.js' });
  assert.equal(ctx.ALBot.version, '0.18.0-h18');
  assert.equal(typeof ctx.ALBot.scheduler.status, 'function');
  assert.equal(typeof ctx.ALBot.modules.restart, 'function');
  assert.equal(typeof ctx.ALBot.dev.stabilityProbe, 'function');
  assert.equal(ctx.ALBot.scheduler.status().enabled, false);
});

test('repeated start stop cycles do not leak scheduler resources', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);

  await ctx.ALBot.start();
  const first = ctx.ALBot.scheduler.status();
  assert.equal(first.enabled, true);
  assert.ok(first.totalResources >= 2);
  const expectedResources = first.totalResources;

  await ctx.ALBot.stop('TEST_STOP_1');
  const stopped1 = ctx.ALBot.scheduler.status();
  assert.equal(stopped1.enabled, false);
  assert.equal(stopped1.totalResources, 0);

  await ctx.ALBot.start();
  const second = ctx.ALBot.scheduler.status();
  assert.equal(second.totalResources, expectedResources);

  await ctx.ALBot.stop('TEST_STOP_2');
  assert.equal(ctx.ALBot.scheduler.status().totalResources, 0);
});

test('H2 stability probe restarts a module without duplicate timers', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const result = await ctx.ALBot.dev.stabilityProbe();
  assert.equal(result.passed, true);
  assert.deepEqual(Array.from(result.restartResourceCounts), [1, 1, 1, 1]);
  assert.equal(result.resourcesAfterStop, 0);

  await ctx.ALBot.stop('DONE');
});

test('scheduler callback crash is isolated to the offending module', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.modules.register({
    id: 'crash-probe',
    version: '1.0.0',
    start: context => {
      context.scope.interval('boom', () => {
        throw new Error('INTENTIONAL_H2_CRASH');
      }, 10);
    },
    stop: () => {}
  });

  await ctx.ALBot.modules.start('crash-probe');
  await sleep(35);

  const crashed = ctx.ALBot.modules.list().find(row => row.id === 'crash-probe');
  const health = ctx.ALBot.modules.list().find(row => row.id === 'runtime-health');

  assert.equal(crashed.state, 'ERROR');
  assert.equal(crashed.health, 'ERROR');
  assert.equal(crashed.resources, 0);
  assert.equal(ctx.ALBot.status().running, true);
  assert.equal(health.state, 'ACTIVE');

  await ctx.ALBot.stop('DONE');
});

test('module watchdog can mark a non-heartbeating module stale without stopping runtime', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.modules.register({
    id: 'stale-probe',
    version: '1.0.0',
    watchdogMs: 30,
    start: () => {},
    stop: () => {}
  });

  await ctx.ALBot.modules.start('stale-probe');
  await sleep(300);
  ctx.ALBot.__runtime.modules.checkWatchdogs();

  const stale = ctx.ALBot.modules.list().find(row => row.id === 'stale-probe');
  assert.equal(stale.state, 'ACTIVE');
  assert.equal(stale.health, 'STALE');
  assert.equal(ctx.ALBot.status().running, true);

  await ctx.ALBot.stop('DONE');
});

test('resource scopes remove event listeners and cleanup hooks', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const handlers = new Map();
  const target = {
    addEventListener(name, fn) { handlers.set(name, fn); },
    removeEventListener(name, fn) {
      if (handlers.get(name) === fn) handlers.delete(name);
    }
  };
  let cleaned = false;
  const scope = ctx.ALBot.__runtime.scheduler.scope('test:resources');
  scope.event('sample-event', target, 'sample', () => {});
  scope.cleanup('sample-cleanup', () => { cleaned = true; });

  assert.equal(ctx.ALBot.scheduler.owner('test:resources').resources.length, 2);
  scope.close('TEST_DONE');
  assert.equal(ctx.ALBot.scheduler.owner('test:resources').resources.length, 0);
  assert.equal(handlers.size, 0);
  assert.equal(cleaned, true);

  await ctx.ALBot.stop('DONE');
});

test('hot reload cleanup removes all runtime scheduler resources synchronously', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();
  assert.ok(ctx.ALBot.scheduler.status().totalResources > 0);

  ctx.ALBot.__runtime.prepareHotReload('TEST_HOT_RELOAD');
  const status = ctx.ALBot.__runtime.status();

  assert.equal(status.running, false);
  assert.equal(status.scheduler.enabled, false);
  assert.equal(status.scheduler.totalResources, 0);
  assert.ok(status.modules.every(row => row.state === 'STOPPED'));
});


test('latched emergency stop is explicit in the main control center', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /GLOBALER STOP IST AKTIV/);
  assert.match(ui, /id="albot-reset-stop-main"/);
  assert.match(ui, /startButton\.disabled = status\.emergencyStop\.latched === true/);
});


test('hot reload is shared across separate same-origin runner contexts', async t => {
  const sharedHost = { document: {} };

  const first = runtimeContext();
  let second = null;
  t.after(async () => {
    try { if (first.ALBot) await first.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    try { if (second && second.ALBot) await second.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });

  first.parent = sharedHost;
  vm.runInNewContext(bundle, first);
  await first.ALBot.start();

  const previousRuntime = first.ALBot.__runtime;
  assert.equal(previousRuntime.status().scheduler.totalResources, 14);
  assert.equal(first.ALBot.status().bootCount, 1);

  second = runtimeContext();
  second.parent = sharedHost;
  vm.runInNewContext(bundle, second);

  assert.equal(second.ALBot.status().bootCount, 2);
  assert.equal(second.ALBot.status().replacedPrevious, true);
  assert.equal(second.ALBot.status().running, false);
  assert.equal(second.ALBot.scheduler.status().totalResources, 0);

  const oldStatus = previousRuntime.status();
  assert.equal(oldStatus.running, false);
  assert.equal(oldStatus.scheduler.totalResources, 0);
  assert.ok(oldStatus.modules.every(row => row.state === 'STOPPED'));

  await second.ALBot.start();
  assert.equal(second.ALBot.scheduler.status().totalResources, 14);
  await second.ALBot.stop('DONE');
});
