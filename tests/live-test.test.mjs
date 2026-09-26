import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');

function makeContext() {
  const memory = new Map();
  const character = {
    name: 'Tester',
    ctype: 'ranger',
    level: 50,
    hp: 1000,
    max_hp: 1000,
    mp: 800,
    max_mp: 800,
    map: 'main',
    real_x: 0,
    real_y: 0,
    range: 100,
    speed: 50,
    frequency: 1,
    moving: false,
    rip: false,
    target: null
  };
  const ctx = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    navigator: { userAgent: 'node-live-test' },
    localStorage: {
      getItem: key => memory.has(key) ? memory.get(key) : null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key)
    },
    character,
    entities: {},
    G: { monsters: {}, maps: { main: {} }, items: {}, skills: {} },
    server_region: 'EU',
    server_identifier: 'I',
    can_move_to: () => true,
    move: (x, y) => { character.real_x = Number(x); character.real_y = Number(y); return { success: true }; },
    smart_move: () => Promise.resolve({ success: true }),
    stop: () => ({ success: true }),
    use_skill: () => Promise.resolve({ success: true }),
    get_characters: () => [{ name: 'Tester', ctype: 'ranger', online: true }],
    get_active_characters: () => ({ Tester: 'self' }),
    addEventListener() {},
    removeEventListener() {}
  };
  ctx.globalThis = ctx;
  return ctx;
}

test('generic live test runner executes all steps with one start and restores runtime state', async () => {
  const ctx = makeContext();
  vm.runInNewContext(bundle, ctx);
  const seen = [];

  ctx.ALBot.__runtime.liveTests.register({
    id: 'demo',
    title: 'Demo Test',
    recommended: true,
    steps: [
      { id: 'one', title: 'Erster Schritt', run: async ({ runtime }) => {
        seen.push('one');
        assert.equal(runtime.running, true);
        return { ok: 1 };
      }},
      { id: 'two', title: 'Zweiter Schritt', run: async ({ sleep }) => {
        await sleep(5);
        seen.push('two');
        return { ok: 2 };
      }}
    ]
  });

  const result = await ctx.ALBot.liveTests.startRecommended();

  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(result.state, 'PASSED');
  assert.equal(result.reason, 'ALL_STEPS_PASSED');
  assert.equal(result.runtimeAutoStarted, true);
  assert.equal(result.steps.every(step => step.state === 'PASSED'), true);
  assert.equal(ctx.ALBot.status().running, false);
  assert.equal(ctx.ALBot.liveTests.status().lastRun.state, 'PASSED');
});

test('live test runner fails closed, skips remaining steps and restores auto-started runtime', async () => {
  const ctx = makeContext();
  vm.runInNewContext(bundle, ctx);
  let thirdRan = false;

  ctx.ALBot.__runtime.liveTests.register({
    id: 'failure',
    title: 'Failure Test',
    recommended: true,
    steps: [
      { id: 'one', title: 'One', run: () => true },
      { id: 'two', title: 'Two', run: () => { throw new Error('EXPECTED_FAILURE'); } },
      { id: 'three', title: 'Three', run: () => { thirdRan = true; } }
    ]
  });

  const result = await ctx.ALBot.liveTests.startRecommended();

  assert.equal(result.state, 'FAILED');
  assert.match(result.reason, /EXPECTED_FAILURE/);
  assert.equal(result.steps[0].state, 'PASSED');
  assert.equal(result.steps[1].state, 'FAILED');
  assert.equal(result.steps[2].state, 'SKIPPED');
  assert.equal(thirdRan, false);
  assert.equal(ctx.ALBot.status().running, false);
});

test('latched emergency stop blocks one-click live tests without resetting safety state', async () => {
  const ctx = makeContext();
  vm.runInNewContext(bundle, ctx);

  ctx.ALBot.__runtime.liveTests.register({
    id: 'blocked',
    title: 'Blocked',
    recommended: true,
    steps: [{ id: 'never', title: 'Never', run: () => true }]
  });

  await ctx.ALBot.emergencyStop('TEST_LATCH');
  await assert.rejects(
    () => ctx.ALBot.liveTests.startRecommended(),
    /LIVE_TEST_EMERGENCY_STOP_LATCHED/
  );
  assert.equal(ctx.ALBot.status().emergencyStop.latched, true);
});

test('control center contains single-click test start and automatic clipboard completion UX', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /data-tab="live-test"/);
  assert.match(ui, /Ein-Klick-Live-Test/);
  assert.match(ui, />Test starten</);
  assert.match(ui, /TEST BEENDET – BESTANDEN/);
  assert.match(ui, /automatisch in die Zwischenablage kopiert/);
  assert.match(ui, /await this\.runtime\.liveTests\.startRecommended\(\)/);
  assert.match(ui, /const copy = await this\.copyDiagnostics\(\)/);
});
