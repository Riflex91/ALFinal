import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function combatContext(options = {}) {
  const memory = new Map();
  const calls = { attack: 0, changeTarget: 0, move: 0, smart: 0, stop: 0, skills: 0 };
  let nextAttackAt = 0;

  const character = options.character || {
    name: 'CombatTester',
    ctype: 'ranger',
    level: 60,
    hp: 1000,
    max_hp: 1000,
    mp: 500,
    max_mp: 500,
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

  const monster = options.monster === null ? null : (options.monster || {
    id: 'goo1',
    name: 'Goo',
    type: 'monster',
    mtype: 'goo',
    visible: true,
    dead: false,
    hp: 100,
    max_hp: 100,
    attack: 10,
    range: 25,
    frequency: 1,
    real_x: 50,
    real_y: 0,
    target: null,
    map: 'main'
  });

  const entities = monster ? { [monster.id]: monster } : {};
  const ctx = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    navigator: { userAgent: 'node-h5-test' },
    localStorage: {
      getItem: key => memory.has(key) ? memory.get(key) : null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key)
    },
    character,
    entities,
    ctarget: null,
    G: {
      monsters: { goo: {} },
      maps: { main: {} },
      items: {},
      skills: { attack: {} }
    },
    server_region: 'EU',
    server_identifier: 'I',
    can_move_to: () => options.canMoveTo !== false,
    move: (x, y) => {
      calls.move += 1;
      character.real_x = Number(x);
      character.real_y = Number(y);
      character.moving = false;
      return { success: true };
    },
    smart_move: destination => {
      calls.smart += 1;
      if (destination && typeof destination === 'object') {
        if (destination.map) character.map = destination.map;
        if (destination.x != null) character.real_x = Number(destination.x);
        if (destination.y != null) character.real_y = Number(destination.y);
      }
      return Promise.resolve({ success: true });
    },
    stop: () => { calls.stop += 1; character.moving = false; return { success: true }; },
    use_skill: () => { calls.skills += 1; return Promise.resolve({ success: true }); },
    change_target: target => {
      calls.changeTarget += 1;
      ctx.ctarget = target || null;
      character.target = target ? target.id : null;
      return { success: true };
    },
    is_in_range: target => {
      if (!target || target.visible === false || target.dead) return false;
      return Math.hypot(character.real_x - target.real_x, character.real_y - target.real_y) <= character.range;
    },
    is_on_cooldown: skill => skill === 'attack' && Date.now() < nextAttackAt,
    can_attack: target => {
      if (!target || target.visible === false || target.dead || character.rip) return false;
      const inRange = Math.hypot(character.real_x - target.real_x, character.real_y - target.real_y) <= character.range;
      return inRange && Date.now() >= nextAttackAt;
    },
    attack: target => {
      calls.attack += 1;
      nextAttackAt = Date.now() + (options.cooldownMs == null ? 80 : options.cooldownMs);
      if (options.rejectAttack) return Promise.reject(new Error('ATTACK_NETWORK_UNCERTAIN'));
      const damage = options.damage == null ? 25 : options.damage;
      setTimeout(() => {
        if (!target || target.dead) return;
        target.hp = Math.max(0, Number(target.hp) - damage);
        if (target.hp <= 0) {
          target.dead = true;
          target.visible = false;
        }
      }, options.damageDelayMs == null ? 10 : options.damageDelayMs);
      if (options.authoritativeResponse) {
        return Promise.resolve({
          success: true,
          response: 'data',
          place: 'attack',
          target: target && target.id,
          attacker: character.name,
          damage
        });
      }
      return Promise.resolve({ success: true });
    },
    get_characters: () => [{ name: character.name, ctype: character.ctype, online: true }],
    get_active_characters: () => ({ [character.name]: 'self' }),
    addEventListener() {},
    removeEventListener() {}
  };
  ctx.globalThis = ctx;
  return { ctx, calls, character, monster };
}

test('H5 combat API, module and explicit H5 live suite remain available under H6', async t => {
  const { ctx } = combatContext();
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  vm.runInNewContext(bundle, ctx);

  assert.equal(ctx.ALBot.version, '0.22.7-h22');
  assert.equal(typeof ctx.ALBot.combat.start, 'function');
  assert.equal(typeof ctx.ALBot.combat.stop, 'function');
  assert.equal(typeof ctx.ALBot.combat.candidates, 'function');
  assert.ok(ctx.ALBot.liveTests.list().some(row => row.id === 'h5-combat'));
  assert.equal(ctx.ALBot.liveTests.status().recommendedId, 'h19-remote-recovery');

  await ctx.ALBot.start();
  const module = ctx.ALBot.modules.list().find(row => row.id === 'combat');
  assert.equal(module.state, 'ACTIVE');
  assert.equal(module.resources, 1);
  assert.ok(ctx.ALBot.scheduler.status().totalResources > 0);
  await ctx.ALBot.stop('DONE');
});

test('H5 acquires a fresh safe monster and confirms attacks from observed HP/death evidence', async t => {
  const { ctx, calls } = combatContext();
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const started = ctx.ALBot.combat.start({
    owner: 'test',
    maxAttackToHpRatio: 0.5,
    minMpRatio: 0
  });
  assert.equal(started.accepted, true);

  await sleep(700);
  const status = ctx.ALBot.combat.status();
  assert.ok(status.metrics.targetsAcquired >= 1);
  assert.ok(status.metrics.attacksDispatched >= 1);
  assert.ok(status.metrics.attacksConfirmed >= 1);
  assert.ok(calls.attack >= 1);
  assert.ok(calls.changeTarget >= 1);
  assert.equal(status.metrics.attackUnknown, 0);

  ctx.ALBot.combat.stop('DONE');
  await ctx.ALBot.stop('DONE');
});

test('H5 uses live cooldown truth and does not spam attacks', async t => {
  const { ctx, calls, monster } = combatContext({ cooldownMs: 220, damage: 1 });
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  monster.hp = 1000;
  monster.max_hp = 1000;
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.combat.start({ maxAttackToHpRatio: 0.5, minMpRatio: 0 });
  await sleep(650);

  assert.ok(calls.attack >= 2);
  assert.ok(calls.attack <= 4);
  assert.equal(ctx.ALBot.combat.status().metrics.attackUnknown, 0);

  ctx.ALBot.combat.stop('DONE');
  await ctx.ALBot.stop('DONE');
});

test('H5 approaches an out-of-range target through the H4 movement owner before attacking', async t => {
  const { ctx, calls, monster, character } = combatContext({ damage: 10 });
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  monster.real_x = 240;
  character.range = 70;
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.combat.start({ maxAttackToHpRatio: 0.5, minMpRatio: 0 });
  await sleep(700);

  const status = ctx.ALBot.combat.status();
  assert.ok(status.metrics.approaches >= 1);
  assert.ok(calls.move + calls.smart >= 1);
  assert.ok(calls.attack >= 1);
  assert.equal(status.metrics.attackUnknown, 0);

  ctx.ALBot.combat.stop('DONE');
  await ctx.ALBot.stop('DONE');
});

test('H5 low HP triggers safe retreat before any attack', async t => {
  const { ctx, calls, character } = combatContext();
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  character.real_x = 120;
  character.real_y = 60;
  character.hp = 250;

  ctx.ALBot.combat.start({
    maxAttackToHpRatio: 0.5,
    retreatHpRatio: 0.35,
    resumeHpRatio: 0.65,
    minMpRatio: 0
  });
  await sleep(450);

  const status = ctx.ALBot.combat.status();
  assert.equal(status.metrics.retreats, 1);
  assert.equal(calls.attack, 0);
  assert.equal(character.real_x, 0);
  assert.equal(character.real_y, 0);
  assert.ok(status.session && ['RETREATING', 'WAITING_RECOVERY'].includes(status.session.state));

  ctx.ALBot.combat.stop('DONE');
  await ctx.ALBot.stop('DONE');
});

test('H5 attack rejection becomes UNKNOWN and is never blindly retried', async t => {
  const { ctx, calls } = combatContext({ rejectAttack: true });
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.combat.start({ maxAttackToHpRatio: 0.5, minMpRatio: 0 });
  await sleep(500);

  const status = ctx.ALBot.combat.status();
  assert.equal(status.active, false);
  assert.equal(status.lastSession.state, 'UNKNOWN');
  assert.match(status.lastSession.reason, /ATTACK_NETWORK_UNCERTAIN/);
  assert.equal(calls.attack, 1);
  assert.equal(status.metrics.attackUnknown, 1);

  await ctx.ALBot.stop('DONE');
});

test('H5 V3-style kiting moves a ranged character only when it holds monster aggro', async t => {
  const { ctx, calls, monster, character } = combatContext({ damage: 1, cooldownMs: 500 });
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  monster.real_x = 10;
  monster.target = character.name;
  character.range = 100;
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.combat.start({
    maxAttackToHpRatio: 0.5,
    minMpRatio: 0,
    kiting: true
  });
  await sleep(400);

  const status = ctx.ALBot.combat.status();
  assert.ok(status.metrics.kites >= 1);
  assert.ok(calls.move >= 1);

  ctx.ALBot.combat.stop('DONE');
  await ctx.ALBot.stop('DONE');
});

test('H5 physical combat excludes near-unhittable high-evasion monsters', async t => {
  const { ctx, calls, character, monster } = combatContext({ damage: 1, cooldownMs: 100 });
  character.ctype = 'warrior';
  character.damage_type = 'physical';
  monster.mtype = 'frog';
  monster.name = 'Froggie';
  monster.attack = 24;
  ctx.G.monsters.frog = { name: 'Froggie', hp: 600, attack: 24, xp: 7200, evasion: 99 };
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });

  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const candidates = ctx.ALBot.combat.candidates({
    maxAttackToHpRatio: 0.5,
    minExpectedHitChance: 0.25
  });
  assert.equal(candidates.length, 0);

  const started = ctx.ALBot.combat.start({
    owner: 'high-evasion-physical-test',
    monsterType: 'frog',
    maxAttackToHpRatio: 0.5,
    minExpectedHitChance: 0.25,
    minMpRatio: 0
  });
  assert.equal(started.accepted, true);

  await sleep(350);
  assert.equal(calls.attack, 0);
  assert.equal(calls.changeTarget, 0);
  assert.equal(ctx.ALBot.combat.status().metrics.targetsAcquired, 0);
});

test('H5 magical combat does not reject a monster solely for physical evasion', async t => {
  const { ctx, character, monster } = combatContext();
  character.ctype = 'mage';
  character.damage_type = 'magical';
  monster.mtype = 'frog';
  monster.name = 'Froggie';
  monster.attack = 24;
  ctx.G.monsters.frog = { name: 'Froggie', hp: 600, attack: 24, xp: 7200, evasion: 99 };
  t.after(async () => {
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });

  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  const candidates = ctx.ALBot.combat.candidates({
    maxAttackToHpRatio: 0.5,
    minExpectedHitChance: 0.25
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mtype, 'frog');
  assert.equal(candidates[0].expectedHitChance, 1);
});

test('global STOP shuts down combat, movement and all scheduler resources', async t => {
  const { ctx } = combatContext({ damage: 1, cooldownMs: 1000 });
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();

  ctx.ALBot.combat.start({ maxAttackToHpRatio: 0.5, minMpRatio: 0 });
  await sleep(250);
  await ctx.ALBot.emergencyStop('H5_TEST_STOP');

  const status = ctx.ALBot.status();
  assert.equal(status.running, false);
  assert.equal(status.emergencyStop.latched, true);
  assert.equal(status.scheduler.totalResources, 0);
  assert.equal(status.combat.active, false);
  assert.equal(status.movement.active, false);
});


test('H5 one-click live test adapts retreat threshold to current HP and weak monster danger', async t => {
  const { ctx, monster } = combatContext({
    character: {
      name: 'CombatTester',
      ctype: 'warrior',
      level: 28,
      hp: 200,
      max_hp: 1000,
      mp: 300,
      max_mp: 300,
      map: 'main',
      real_x: 0,
      real_y: 0,
      range: 30,
      speed: 50,
      frequency: 1,
      moving: false,
      rip: false,
      target: null
    },
    damage: 40,
    cooldownMs: 80
  });
  monster.attack = 5;
  monster.real_x = 40;
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });

  vm.runInNewContext(bundle, ctx);
  const result = await ctx.ALBot.liveTests.start('h5-combat');

  assert.equal(result.state, 'PASSED');
  assert.equal(result.steps[0].state, 'PASSED');
  assert.ok(result.steps[0].result.retreatHpRatio < 0.2);
  assert.ok(result.steps[0].result.retreatHp >= 100);
  assert.equal(result.steps[1].state, 'PASSED');
  assert.equal(result.steps[2].state, 'PASSED');
  assert.equal(result.steps[3].state, 'PASSED');
  assert.equal(result.steps[4].state, 'PASSED');
});


test('H5 confirms a lethal vanished target from authoritative Adventure Land attack response', async t => {
  const { ctx, monster } = combatContext({
    damage: 104,
    damageDelayMs: 0,
    authoritativeResponse: true,
    cooldownMs: 500
  });
  monster.hp = 3;
  monster.max_hp = 100;
  t.after(async () => {
    try { ctx.ALBot && ctx.ALBot.combat && ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { ctx.ALBot && await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });

  vm.runInNewContext(bundle, ctx);
  await ctx.ALBot.start();
  const started = ctx.ALBot.combat.start({
    owner: 'test-authoritative-kill',
    maxAttackToHpRatio: 0.5,
    minMpRatio: 0
  });
  assert.equal(started.accepted, true);

  await sleep(450);
  const status = ctx.ALBot.combat.status();

  assert.equal(status.metrics.attackUnknown, 0);
  assert.ok(status.metrics.attacksConfirmed >= 1);
  assert.ok(status.metrics.killsObserved >= 1);
  assert.ok(
    (status.session && status.session.lastDecision && status.session.lastDecision.type === 'KILL_CONFIRMED_SERVER')
    || (status.lastSession && status.lastSession.lastDecision && status.lastSession.lastDecision.type === 'KILL_CONFIRMED_SERVER')
    || status.metrics.killsObserved >= 1
  );
});
