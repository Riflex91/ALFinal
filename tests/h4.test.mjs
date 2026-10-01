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

function runtimeContext(options = {}) {
  const memory = new Map();
  const calls = {
    move: [],
    smart: [],
    stop: [],
    skills: []
  };
  const character = options.character || {
    id: 'Mover',
    name: 'Mover',
    ctype: 'ranger',
    level: 50,
    hp: 1000,
    max_hp: 1000,
    mp: 800,
    max_mp: 800,
    gold: 10,
    xp: 20,
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

  const context = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    localStorage: {
      getItem: key => memory.has(key) ? memory.get(key) : null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key)
    },
    navigator: { userAgent: 'node-h4-test' },
    character,
    entities: options.entities || {},
    G: {
      monsters: { goo: {} },
      maps: { main: {}, winterland: {} },
      items: {},
      skills: { stop: {}, attack: {} }
    },
    server_region: 'EU',
    server_identifier: 'I',
    can_move_to: options.canMoveTo || (() => true),
    move: options.move || ((x, y) => {
      calls.move.push([x, y]);
      character.moving = true;
      character.real_x = Number(x);
      character.real_y = Number(y);
      character.moving = false;
      return { success: true };
    }),
    smart_move: options.smartMove || (destination => {
      calls.smart.push(destination);
      return Promise.resolve({ success: true });
    }),
    stop: options.stop || (kind => {
      calls.stop.push(kind);
      character.moving = false;
      return { success: true };
    }),
    use_skill: options.useSkill || (skill => {
      calls.skills.push(skill);
      if (skill === 'stop') character.moving = false;
      return Promise.resolve({ success: true });
    }),
    get_characters: () => [{ name: 'Mover', ctype: 'ranger', online: true }],
    get_active_characters: () => ({ Mover: 'self' }),
    addEventListener() {},
    removeEventListener() {}
  };
  context.globalThis = context;
  return { context, calls, character };
}

test('H4 exposes bounded movement API and action boundary', async () => {
  const { context: ctx } = runtimeContext();
  vm.runInNewContext(bundle, ctx, { filename: 'al-bot.js' });

  assert.equal(ctx.ALBot.version, '0.26.43-h26');
  assert.equal(typeof ctx.ALBot.movement.local, 'function');
  assert.equal(typeof ctx.ALBot.movement.smart, 'function');
  assert.equal(typeof ctx.ALBot.movement.approachTarget, 'function');
  assert.equal(typeof ctx.ALBot.movement.retarget, 'function');
  assert.equal(typeof ctx.ALBot.movement.cancel, 'function');
  assert.equal(typeof ctx.ALBot.movement.safeReturn, 'function');

  assert.throws(
    () => ctx.ALBot.__runtime.actions.dispatch('move', [1, 2]),
    /ALBOT_RUNTIME_NOT_RUNNING/
  );

  await ctx.ALBot.start();
  const status = ctx.ALBot.status();
  assert.equal(status.movement.enabled, true);
  assert.equal(status.movement.state, 'IDLE');
  assert.equal(status.actions.availability.move, true);
  assert.equal(status.actions.availability.smart_move, true);
  assert.ok(ctx.ALBot.scheduler.status().totalResources > 0);
  await ctx.ALBot.stop('DONE');
});

test('local movement completes only from observed position and leaks no observer', async () => {
  const { context: ctx, calls } = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();
  const resourcesBeforeMove = ctx.ALBot.scheduler.status().totalResources;

  const result = ctx.ALBot.movement.local(120, 80, { arrivalRadius: 2 });
  assert.equal(result.accepted, true);
  assert.deepEqual(calls.move, [[120, 80]]);

  const movement = ctx.ALBot.movement.status();
  assert.equal(movement.active, false);
  assert.equal(movement.lastOrder.state, 'COMPLETED');
  assert.equal(movement.lastOrder.reason, 'ARRIVAL_VERIFIED');
  assert.equal(ctx.ALBot.scheduler.owner('module:movement').resources.length, 0);
  assert.equal(ctx.ALBot.scheduler.status().totalResources, resourcesBeforeMove);

  await ctx.ALBot.stop('DONE');
});

test('smart_move resolution alone is not arrival evidence and stuck movement is not retried', async () => {
  let smartCalls = 0;
  const { context: ctx, calls } = runtimeContext({
    smartMove: destination => {
      smartCalls += 1;
      calls.smart.push(destination);
      return Promise.resolve({ success: true });
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.__runtime.movement.config.pollMs = 50;
  ctx.ALBot.__runtime.movement.config.stuckMs = 220;

  const result = ctx.ALBot.movement.smart({ map: 'main', x: 300, y: 0 });
  assert.equal(result.accepted, true);
  await sleep(380);

  const movement = ctx.ALBot.movement.status();
  assert.equal(movement.active, false);
  assert.equal(movement.lastOrder.state, 'STUCK');
  assert.equal(movement.lastOrder.reason, 'MOVEMENT_STUCK_NO_PROGRESS');
  assert.equal(smartCalls, 1);
  assert.ok(calls.stop.length + calls.skills.length >= 1);
  assert.equal(ctx.ALBot.scheduler.owner('module:movement').resources.length, 0);

  await ctx.ALBot.stop('DONE');
});

test('map-only smart_move treats live movement as progress until the map transition', async () => {
  const { context: ctx, character, calls } = runtimeContext({
    smartMove: destination => {
      calls.smart.push(destination);
      character.moving = true;
      return Promise.resolve({ success: true });
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.__runtime.movement.config.pollMs = 25;
  ctx.ALBot.__runtime.movement.config.stuckMs = 100;
  ctx.ALBot.__runtime.movement.config.mapOnlyStuckMs = 500;

  const result = ctx.ALBot.movement.smart('winterland');
  assert.equal(result.accepted, true);

  await sleep(260);
  let movement = ctx.ALBot.movement.status();
  assert.equal(movement.active, true);
  assert.equal(movement.activeOrder.state, 'ACTIVE');
  assert.ok(movement.activeOrder.progressEvents > 0);

  character.map = 'winterland';
  character.moving = false;
  await sleep(80);

  movement = ctx.ALBot.movement.status();
  assert.equal(movement.active, false);
  assert.equal(movement.lastOrder.state, 'COMPLETED');
  assert.equal(movement.lastOrder.reason, 'ARRIVAL_VERIFIED');
  assert.equal(calls.smart.length, 1);

  await ctx.ALBot.stop('DONE');
});

test('smart_move is completed by fresh observed arrival even if command resolved earlier', async () => {
  const { context: ctx, character } = runtimeContext({
    smartMove: destination => {
      setTimeout(() => {
        character.map = destination.map;
        character.real_x = destination.x;
        character.real_y = destination.y;
        character.moving = false;
      }, 80);
      return Promise.resolve({ success: true });
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.__runtime.movement.config.pollMs = 25;
  const result = ctx.ALBot.movement.smart({ map: 'main', x: 50, y: 60 }, { arrivalRadius: 2 });
  assert.equal(result.accepted, true);

  await sleep(180);
  const movement = ctx.ALBot.movement.status();
  assert.equal(movement.active, false);
  assert.equal(movement.lastOrder.state, 'COMPLETED');
  assert.equal(movement.lastOrder.reason, 'ARRIVAL_VERIFIED');
  assert.equal(movement.lastOrder.commandSettlement, 'RESOLVED');

  await ctx.ALBot.stop('DONE');
});

test('rejected smart_move becomes UNKNOWN and is never blindly retried', async () => {
  let smartCalls = 0;
  const { context: ctx } = runtimeContext({
    smartMove: () => {
      smartCalls += 1;
      return Promise.reject(new Error('NETWORK_UNCERTAIN'));
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const result = ctx.ALBot.movement.smart({ map: 'main', x: 200, y: 200 });
  assert.equal(result.accepted, true);
  await sleep(30);

  const movement = ctx.ALBot.movement.status();
  assert.equal(movement.active, false);
  assert.equal(movement.lastOrder.state, 'UNKNOWN');
  assert.match(movement.lastOrder.reason, /NETWORK_UNCERTAIN/);
  assert.equal(smartCalls, 1);

  await ctx.ALBot.stop('DONE');
});

test('retarget cancels the old movement and transfers the single movement owner', async () => {
  const { context: ctx, calls } = runtimeContext({
    smartMove: destination => {
      calls.smart.push(destination);
      return new Promise(() => {});
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.__runtime.movement.config.retargetMinAgeMs = 0;
  const first = ctx.ALBot.movement.smart({ map: 'main', x: 200, y: 0 }, { owner: 'travel' });
  assert.equal(first.accepted, true);

  const second = ctx.ALBot.movement.retarget(
    { map: 'main', x: 260, y: 40 },
    { owner: 'travel' }
  );
  assert.equal(second.accepted, true);
  assert.equal(ctx.ALBot.movement.status().activeOrder.retargetedFrom, first.order.id);
  assert.equal(ctx.ALBot.movement.status().activeOrder.owner, 'travel');
  assert.equal(calls.smart.length, 2);
  assert.ok(calls.stop.length + calls.skills.length >= 1);
  assert.equal(ctx.ALBot.scheduler.owner('module:movement').resources.length, 1);

  ctx.ALBot.movement.cancel('TEST_DONE');
  assert.equal(ctx.ALBot.scheduler.owner('module:movement').resources.length, 0);
  await ctx.ALBot.stop('DONE');
});

test('anti-pingpong blocks A-B-A movement thrash', async () => {
  const { context: ctx } = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.__runtime.movement.config.rapidSwitchMs = 0;
  ctx.ALBot.__runtime.movement.config.pingPongWindowMs = 10000;

  assert.equal(ctx.ALBot.movement.local(100, 0).accepted, true);
  assert.equal(ctx.ALBot.movement.local(200, 0).accepted, true);
  const back = ctx.ALBot.movement.local(100, 0);

  assert.equal(back.accepted, false);
  assert.equal(back.reason, 'MOVEMENT_PINGPONG_BLOCKED');
  assert.equal(ctx.ALBot.movement.status().metrics.pingPongBlocks, 1);

  await ctx.ALBot.stop('DONE');
});

test('safe return uses the runtime-start safe point and bypasses normal pingpong blocking', async () => {
  const { context: ctx, character } = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const safe = ctx.ALBot.movement.status().safePoint;
  assert.equal(safe.map, 'main');
  assert.equal(safe.x, 0);
  assert.equal(safe.y, 0);

  ctx.ALBot.__runtime.movement.config.rapidSwitchMs = 0;
  assert.equal(ctx.ALBot.movement.local(0, 0).accepted, true);
  assert.equal(ctx.ALBot.movement.local(100, 0).accepted, true);
  assert.equal(character.real_x, 100);

  const result = ctx.ALBot.movement.safeReturn();
  assert.equal(result.accepted, true);
  assert.equal(ctx.ALBot.movement.status().lastOrder.state, 'COMPLETED');
  assert.equal(character.real_x, 0);
  assert.equal(character.real_y, 0);

  await ctx.ALBot.stop('DONE');
});

test('global emergency STOP cancels live movement and leaves zero scheduler resources', async () => {
  const { context: ctx, calls } = runtimeContext({
    smartMove: destination => {
      calls.smart.push(destination);
      return new Promise(() => {});
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const started = ctx.ALBot.movement.smart({ map: 'main', x: 500, y: 500 });
  assert.equal(started.accepted, true);
  assert.equal(ctx.ALBot.movement.status().active, true);
  assert.equal(ctx.ALBot.scheduler.owner('module:movement').resources.length, 1);

  await ctx.ALBot.emergencyStop('H4_TEST_STOP');
  const status = ctx.ALBot.status();

  assert.equal(status.running, false);
  assert.equal(status.emergencyStop.latched, true);
  assert.equal(status.scheduler.totalResources, 0);
  assert.equal(status.movement.active, false);
  assert.equal(status.movement.lastOrder.state, 'CANCELLED');
  assert.ok(calls.stop.length + calls.skills.length >= 1);

  const denied = ctx.ALBot.movement.smart({ map: 'main', x: 1, y: 1 });
  assert.equal(denied.accepted, false);
});

test('approach current target computes a bounded local approach point', async () => {
  const target = {
    id: 'goo1',
    name: 'Goo',
    type: 'monster',
    mtype: 'goo',
    real_x: 100,
    real_y: 0,
    hp: 100,
    max_hp: 100,
    dead: false
  };
  const { context: ctx, character, calls } = runtimeContext({
    character: {
      id: 'Mover',
      name: 'Mover',
      ctype: 'ranger',
      level: 50,
      hp: 1000,
      max_hp: 1000,
      mp: 800,
      max_mp: 800,
      map: 'main',
      real_x: 0,
      real_y: 0,
      range: 50,
      moving: false,
      rip: false,
      target: 'goo1'
    },
    entities: { goo1: target }
  });
  ctx.ctarget = target;
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const result = ctx.ALBot.movement.approachTarget({ distance: 40 });
  assert.equal(result.accepted, true);
  assert.equal(calls.move.length, 1);
  assert.ok(Math.abs(calls.move[0][0] - 60) < 0.001);
  assert.ok(Math.abs(calls.move[0][1]) < 0.001);
  assert.equal(character.real_x, 60);

  await ctx.ALBot.stop('DONE');
});

test('H4 control center exposes movement tab and controls', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /data-tab="navigation"/);
  assert.match(ui, /H4 Bewegung/);
  assert.match(ui, /Lokal bewegen/);
  assert.match(ui, /Smart Move/);
  assert.match(ui, /Retarget/);
  assert.match(ui, /Bewegung abbrechen/);
  assert.match(ui, /Target annähern/);
  assert.match(ui, /Safe Point hier setzen/);
  assert.match(ui, /Zum Safe Point zurück/);
});


test('same-map smart move without coordinates is rejected instead of claiming immediate arrival', async () => {
  const { context: ctx, calls } = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const result = ctx.ALBot.movement.smart('main');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'SMART_MOVE_SAME_MAP_NEEDS_COORDINATES');
  assert.equal(calls.smart.length, 0);
  assert.equal(ctx.ALBot.movement.status().lastOrder, null);

  await ctx.ALBot.stop('DONE');
});

test('hot reload during active movement cancels observer and movement best-effort', async () => {
  const { context: ctx, calls } = runtimeContext({
    smartMove: destination => {
      calls.smart.push(destination);
      return new Promise(() => {});
    }
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const started = ctx.ALBot.movement.smart({ map: 'main', x: 400, y: 400 });
  assert.equal(started.accepted, true);
  assert.equal(ctx.ALBot.scheduler.owner('module:movement').resources.length, 1);

  ctx.ALBot.__runtime.prepareHotReload('H4_TEST_RELOAD');
  const status = ctx.ALBot.__runtime.status();

  assert.equal(status.running, false);
  assert.equal(status.scheduler.totalResources, 0);
  assert.equal(status.movement.active, false);
  assert.equal(status.movement.lastOrder.state, 'CANCELLED');
  assert.ok(calls.stop.length + calls.skills.length >= 1);
});


test('transient formation movement bypasses rapid-switch history without weakening strategic pingpong guards', async () => {
  const { context: ctx } = runtimeContext();
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.__runtime.movement.config.rapidSwitchMs = 10000;
  ctx.ALBot.__runtime.movement.config.pingPongWindowMs = 10000;

  const strategic = ctx.ALBot.movement.local(100, 0, { owner: 'farm-intelligence-h9' });
  assert.equal(strategic.accepted, true);
  assert.equal(ctx.ALBot.movement.status().recentDestinations.length, 1);

  const formation = ctx.ALBot.movement.local(200, 0, {
    owner: 'farm-intelligence-h9-leader-regroup',
    transient: true
  });
  assert.equal(formation.accepted, true);
  assert.equal(ctx.ALBot.movement.status().recentDestinations.length, 1);

  const resume = ctx.ALBot.movement.local(100, 0, { owner: 'farm-intelligence-h9' });
  assert.equal(resume.accepted, true);

  const unrelated = ctx.ALBot.movement.local(300, 0, { owner: 'manual' });
  assert.equal(unrelated.accepted, false);
  assert.equal(unrelated.reason, 'MOVEMENT_RAPID_SWITCH_BLOCKED');

  await ctx.ALBot.stop('DONE');
});
