import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');

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
    navigator: { userAgent: 'node-test' },
    character: { name: 'CurrentRanger', ctype: 'ranger', hp: 100, max_hp: 100, mp: 80, max_mp: 80, gold: 5, map: 'main', x: 1, y: 2 },
    get_characters: () => [
      { name: 'TradeChar', ctype: 'merchant', online: true },
      { name: 'CurrentRanger', ctype: 'ranger', online: true },
      { name: 'HealChar', ctype: 'priest', online: false },
      { name: 'OfflineMage', ctype: 'mage', online: false }
    ],
    get_active_characters: () => ({ TradeChar: 'code', CurrentRanger: 'self', HealChar: 'active' }),
    addEventListener() {}, removeEventListener() {}
  };
  context.globalThis = context;
  return context;
}

test('H1 bundle loads and exposes ALBot API', () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx, { filename: 'al-bot.js' });
  assert.equal(ctx.ALBot.product, 'AL Bot');
  assert.equal(ctx.ALBot.version, '0.1.0-h1');
  assert.equal(ctx.ALBot.status().running, false);
});

test('dynamic roster discovers active farmers without hardcoded names', () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  const roster = ctx.ALBot.roster.refresh();
  assert.equal(roster.hardcodedNamesRequired, false);
  assert.deepEqual(Array.from(roster.farmers, x => x.name).sort(), ['CurrentRanger', 'HealChar']);
  assert.equal(roster.merchant.name, 'TradeChar');
  assert.equal(roster.characters.some(x => x.name === 'OfflineMage'), false);
});

test('global emergency stop blocks actions and persists until reset', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();
  assert.equal(ctx.ALBot.actions.canAct('test'), true);
  await ctx.ALBot.emergencyStop('TEST');
  assert.equal(ctx.ALBot.actions.canAct('test'), false);
  assert.equal(ctx.ALBot.status().emergencyStop.latched, true);
  ctx.ALBot.resetEmergencyStop();
  assert.equal(ctx.ALBot.status().emergencyStop.latched, false);
});

test('goal service supports add, pause, resume, cancel and strategic priorities', () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  const goal = ctx.ALBot.goals.add({ type: 'COLLECT_ITEM', target: 'seashell', amount: 200, scope: 'FARMERS', priority: 'HIGH' });
  assert.equal(goal.amount, 200);
  assert.equal(ctx.ALBot.goals.pause(goal.id).status, 'PAUSED');
  assert.equal(ctx.ALBot.goals.resume(goal.id).status, 'ACTIVE');
  assert.equal(ctx.ALBot.goals.cancel(goal.id).status, 'CANCELLED');
  ctx.ALBot.goals.setPriority('leveling', 'CRITICAL');
  assert.equal(ctx.ALBot.goals.priorities().leveling, 'CRITICAL');
});

test('knowledge provider failures keep last-known-good snapshot', async () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  let fail = false;
  ctx.ALBot.knowledge.setProvider({
    status: () => ({ name: 'test-provider', ready: !fail }),
    getSnapshot: async () => { if (fail) throw new Error('offline'); return { generation: 7, source: 'TEST' }; }
  });
  await ctx.ALBot.knowledge.refresh();
  assert.equal(ctx.ALBot.knowledge.status().lastKnownGood.generation, 7);
  fail = true;
  await ctx.ALBot.knowledge.refresh();
  assert.equal(ctx.ALBot.knowledge.status().lastKnownGood.generation, 7);
});

test('selftest passes', () => {
  const ctx = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  const result = ctx.ALBot.selfTest();
  assert.equal(result.passed, true);
  assert.ok(result.checks.some(c => c.name === 'dynamic-roster-no-hardcoded-names' && c.ok));
});
