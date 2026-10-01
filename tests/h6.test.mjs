import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function skillDefs() {
  return {
    charge: { class: ['warrior'], level: 1, mp: 0, cooldown: 40000 },
    taunt: { class: ['warrior'], level: 1, mp: 40, cooldown: 3000, range: 200 },
    hardshell: { class: ['warrior'], level: 60, mp: 480, cooldown: 16000 },
    warcry: { class: ['warrior'], level: 70, mp: 320, cooldown: 60000, range: 600 },
    huntersmark: { class: ['ranger'], level: 1, mp: 240, cooldown: 10000, range_multiplier: 1 },
    supershot: { class: ['ranger'], level: 1, mp: 400, cooldown: 30000, range_multiplier: 1 },
    burst: { class: ['mage'], level: 1, mp: 0, cooldown: 6000, range_multiplier: 1 },
    curse: { class: ['priest'], level: 1, mp: 400, cooldown: 5000, range: 200 },
    darkblessing: { class: ['priest'], level: 70, mp: 900, cooldown: 60000, range: 600 },
    invis: { class: ['rogue'], level: 1, mp: 120, cooldown: 12000 },
    mentalburst: { class: ['rogue'], level: 1, mp: 180, cooldown: 900, range_multiplier: 1 },
    quickpunch: { class: ['rogue'], level: 1, mp: 240, cooldown: 250, range_multiplier: 1 },
    selfheal: { class: ['paladin'], level: 1, mp: 20, cooldown: 1200 },
    smash: { class: ['paladin'], level: 10, mp: 380, cooldown: 320, range_multiplier: 1 },
    attack: {}
  };
}

function makeContext(options = {}) {
  const memory = new Map();
  const calls = { skills: [], attacks: 0, changes: 0, moves: 0, smart: 0 };
  const cooldowns = new Map();
  const character = {
    name: options.name || 'ClassTester',
    ctype: options.ctype || 'warrior',
    level: options.level == null ? 80 : options.level,
    hp: options.hp == null ? 1000 : options.hp,
    max_hp: options.maxHp == null ? 1000 : options.maxHp,
    mp: options.mp == null ? 2000 : options.mp,
    max_mp: options.maxMp == null ? 2000 : options.maxMp,
    attack: options.attack == null ? 100 : options.attack,
    map: 'main',
    real_x: 0,
    real_y: 0,
    range: options.range == null ? 100 : options.range,
    speed: 60,
    frequency: 1,
    moving: false,
    rip: false,
    target: null,
    s: {}
  };
  const monster = {
    id: 'm1',
    name: 'Goo',
    type: 'monster',
    mtype: 'goo',
    visible: true,
    dead: false,
    hp: options.targetHp == null ? 1000 : options.targetHp,
    max_hp: options.targetMaxHp == null ? 1000 : options.targetMaxHp,
    attack: options.targetAttack == null ? 5 : options.targetAttack,
    range: 25,
    frequency: 1,
    real_x: options.targetX == null ? 80 : options.targetX,
    real_y: 0,
    target: options.targetTarget == null ? null : options.targetTarget,
    map: 'main',
    s: {}
  };

  const G = { monsters: { goo: {} }, maps: { main: {} }, items: {}, skills: skillDefs() };
  const ctx = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    localStorage: {
      getItem: key => memory.has(key) ? memory.get(key) : null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key)
    },
    navigator: { userAgent: 'node-h6-test' },
    character,
    entities: { [monster.id]: monster },
    ctarget: null,
    G,
    server_region: 'EU',
    server_identifier: 'I',
    can_move_to: () => true,
    move: (x, y) => {
      calls.moves += 1;
      character.real_x = Number(x);
      character.real_y = Number(y);
      return { success: true };
    },
    smart_move: destination => {
      calls.smart += 1;
      if (destination && typeof destination === 'object') {
        if (destination.x != null) character.real_x = Number(destination.x);
        if (destination.y != null) character.real_y = Number(destination.y);
      }
      return Promise.resolve({ success: true });
    },
    stop: () => ({ success: true }),
    change_target: target => {
      calls.changes += 1;
      ctx.ctarget = target || null;
      character.target = target ? target.id : null;
      return { success: true };
    },
    is_on_cooldown: skill => (cooldowns.get(skill) || 0) > Date.now(),
    can_use: skill => (cooldowns.get(skill) || 0) <= Date.now(),
    is_in_range: (target, skill) => {
      if (!target || target.visible === false) return false;
      const def = G.skills[skill] || {};
      const distance = Math.hypot(character.real_x - target.real_x, character.real_y - target.real_y);
      if (Number.isFinite(Number(def.range))) return distance <= Number(def.range);
      const multiplier = Number.isFinite(Number(def.range_multiplier)) ? Number(def.range_multiplier) : 1;
      const bonus = Number.isFinite(Number(def.range_bonus)) ? Number(def.range_bonus) : 0;
      return distance <= character.range * multiplier + bonus;
    },
    can_attack: target => {
      if (!target || target.dead || target.visible === false) return false;
      return Math.hypot(character.real_x - target.real_x, character.real_y - target.real_y) <= character.range
        && (cooldowns.get('attack') || 0) <= Date.now();
    },
    use_skill: (skill, target) => {
      calls.skills.push({ skill, target: target && target.id ? target.id : target });
      const def = G.skills[skill] || {};
      cooldowns.set(skill, Date.now() + Math.min(250, Number(def.cooldown) || 100));
      if (options.rejectSkill === skill) {
        return Promise.reject(new Error(options.rejectSkillReason || 'NETWORK_UNCERTAIN'));
      }

      if (skill === 'taunt') monster.target = character.name;
      if (skill === 'hardshell') character.s.hardshell = { ms: 5000 };
      if (skill === 'warcry') character.s.warcry = { ms: 5000 };
      if (skill === 'invis') character.s.invis = { ms: 5000 };
      if (skill === 'darkblessing') character.s.darkblessing = { ms: 5000 };
      if (skill === 'selfheal') character.hp = Math.min(character.max_hp, character.hp + 250);

      const damageSkills = new Set(['supershot', 'burst', 'mentalburst', 'quickpunch', 'smash']);
      let damage = null;
      if (damageSkills.has(skill)) {
        damage = options.skillDamage == null ? 75 : options.skillDamage;
        monster.hp = Math.max(0, monster.hp - damage);
        if (monster.hp <= 0) {
          monster.dead = true;
          monster.visible = false;
        }
      }
      return Promise.resolve({
        success: true,
        response: 'data',
        place: skill,
        target: monster.id,
        damage
      });
    },
    attack: target => {
      calls.attacks += 1;
      cooldowns.set('attack', Date.now() + 60);
      const damage = 50;
      target.hp = Math.max(0, target.hp - damage);
      if (target.hp <= 0) {
        target.dead = true;
        target.visible = false;
      }
      return Promise.resolve({
        success: true,
        response: 'data',
        place: 'attack',
        target: target.id,
        attacker: character.name,
        damage
      });
    },
    use_skill_stop: () => Promise.resolve({ success: true }),
    get_characters: () => [{ name: character.name, ctype: character.ctype, online: true }],
    get_active_characters: () => ({ [character.name]: 'self' }),
    addEventListener() {},
    removeEventListener() {}
  };
  ctx.globalThis = ctx;
  return { ctx, character, monster, calls, cooldowns };
}

async function startController(options = {}) {
  const env = makeContext(options);
  vm.runInNewContext(bundle, env.ctx);
  await env.ctx.ALBot.start();
  return env;
}

test('H6 exposes class skill API, module and recommended live suite', async t => {
  const { ctx } = await startController({ ctype: 'warrior', level: 28, mp: 300, maxMp: 300, range: 23 });
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  assert.equal(ctx.ALBot.version, '0.26.45-h26');
  assert.equal(typeof ctx.ALBot.classSkills.status, 'function');
  assert.equal(typeof ctx.ALBot.classSkills.preview, 'function');
  assert.equal(ctx.ALBot.liveTests.status().recommendedId, 'h19-remote-recovery');

  const module = ctx.ALBot.modules.list().find(row => row.id === 'class-skills');
  assert.equal(module.state, 'ACTIVE');
  assert.equal(module.resources, 0);
  assert.ok(ctx.ALBot.scheduler.status().totalResources > 0);
});

test('Game Adapter skill readiness honors class, level, MP, cooldown and range', async t => {
  const { ctx, cooldowns } = await startController({ ctype: 'warrior', level: 28, mp: 100, maxMp: 300, range: 23, targetX: 80 });
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  const taunt = ctx.ALBot.__runtime.game.skillReadiness('taunt', 'm1');
  assert.equal(taunt.allowed, true);

  const shell = ctx.ALBot.__runtime.game.skillReadiness('hardshell');
  assert.equal(shell.allowed, false);
  assert.ok(shell.reasons.includes('SKILL_LEVEL_TOO_LOW'));
  assert.ok(shell.reasons.includes('SKILL_MP_TOO_LOW'));

  cooldowns.set('taunt', Date.now() + 5000);
  const cooled = ctx.ALBot.__runtime.game.skillReadiness('taunt', 'm1');
  assert.equal(cooled.allowed, false);
  assert.ok(cooled.reasons.includes('SKILL_COOLDOWN'));

  const ranger = ctx.ALBot.__runtime.game.skillReadiness('supershot', 'm1');
  assert.equal(ranger.allowed, false);
  assert.ok(ranger.reasons.includes('SKILL_CLASS_MISMATCH'));
});

test('Warrior uses charge at distance then taunt without same-skill spam', async t => {
  const { ctx, calls } = await startController({
    ctype: 'warrior', level: 28, mp: 300, maxMp: 300, range: 23, targetX: 90
  });
  t.after(async () => { try { ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {} try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  const result = ctx.ALBot.combat.start({ owner: 'h6-warrior', maxAttack: 20, minMpRatio: 0 });
  assert.equal(result.accepted, true);
  await sleep(1400);

  const skills = calls.skills.map(row => row.skill);
  assert.ok(skills.includes('charge'));
  assert.ok(skills.includes('taunt'));
  assert.equal(skills.filter(id => id === 'charge').length, 1);
  assert.equal(skills.filter(id => id === 'taunt').length, 1);
  assert.ok(ctx.ALBot.classSkills.status().metrics.confirmed >= 2);
  assert.equal(ctx.ALBot.classSkills.status().metrics.unknown, 0);
});

test('Ranger, Mage, Priest, Rogue and Paladin choose class-specific safe skills', async t => {
  const scenarios = [
    { ctype: 'ranger', expected: 'huntersmark', targetHp: 1000, attack: 100, mp: 2000, maxMp: 2000 },
    { ctype: 'mage', expected: 'burst', targetHp: 500, attack: 100, mp: 800, maxMp: 800 },
    { ctype: 'priest', expected: 'curse', targetHp: 1000, attack: 100, mp: 1000, maxMp: 1000, level: 60 },
    { ctype: 'rogue', expected: 'mentalburst', targetHp: 500, attack: 100, mp: 1000, maxMp: 1000 },
    { ctype: 'paladin', expected: 'selfheal', targetHp: 500, attack: 100, hp: 600, maxHp: 1000, mp: 1000, maxMp: 1000 }
  ];

  const envs = [];
  t.after(async () => {
    for (const env of envs) {
      try { env.ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  for (const scenario of scenarios) {
    const env = await startController({ ...scenario, targetX: 50 });
    envs.push(env);
    const preview = env.ctx.ALBot.classSkills.preview('m1');
    assert.ok(preview, 'missing preview for ' + scenario.ctype);
    assert.equal(preview.skillId, scenario.expected, scenario.ctype);
  }
});

test('Rogue not_there skill race is a known rejection and does not suspend class skills', async t => {
  const { ctx, calls } = await startController({
    ctype: 'rogue',
    level: 60,
    mp: 1000,
    maxMp: 1000,
    range: 20,
    targetX: 15,
    targetHp: 500,
    attack: 100,
    rejectSkill: 'mentalburst',
    rejectSkillReason: 'not_there'
  });
  t.after(async () => { try { ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {} try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  assert.equal(ctx.ALBot.combat.start({ owner: 'h6-rogue-race', maxAttack: 200, minMpRatio: 0 }).accepted, true);
  await sleep(700);

  const status = ctx.ALBot.classSkills.status();
  assert.equal(status.suspended, false);
  assert.equal(status.metrics.unknown, 0);
  assert.ok(status.metrics.rejected >= 1);
  assert.equal(calls.skills.filter(row => row.skill === 'mentalburst').length, 1);
  assert.ok(calls.attacks >= 1);
});

test('unknown skill outcome suspends class skills for that combat session and is not blindly retried', async t => {
  const { ctx, calls } = await startController({
    ctype: 'warrior', level: 28, mp: 300, maxMp: 300, range: 23, targetX: 90, rejectSkill: 'charge'
  });
  t.after(async () => { try { ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {} try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  ctx.ALBot.combat.start({ owner: 'h6-unknown', maxAttack: 20, minMpRatio: 0 });
  await sleep(700);

  const status = ctx.ALBot.classSkills.status();
  assert.equal(status.suspended, true);
  assert.equal(status.metrics.unknown, 1);
  assert.equal(calls.skills.filter(row => row.skill === 'charge').length, 1);
  assert.ok(calls.attacks >= 1 || calls.moves >= 1);
});

test('H6 one-click live suite passes on a level-28 warrior and restores runtime state', async () => {
  const { ctx } = makeContext({
    ctype: 'warrior',
    level: 28,
    hp: 1000,
    maxHp: 1000,
    mp: 300,
    maxMp: 300,
    range: 23,
    targetX: 80,
    targetHp: 600,
    targetAttack: 5
  });
  vm.runInNewContext(bundle, ctx);

  const result = await ctx.ALBot.liveTests.start('h6-class-logic');

  assert.equal(result.state, 'PASSED');
  assert.equal(result.reason, 'ALL_STEPS_PASSED');
  assert.equal(result.steps.every(step => step.state === 'PASSED'), true);
  assert.equal(result.steps[0].result.characterClass, 'warrior');
  assert.ok(['charge', 'taunt'].includes(result.steps[2].result.skillId));
  assert.equal(ctx.ALBot.status().running, false);
  assert.equal(ctx.ALBot.scheduler.status().totalResources, 0);
  assert.equal(ctx.ALBot.classSkills.status().pending, null);
  assert.equal(ctx.ALBot.classSkills.status().sessionId, null);
});

test('H6 UI exposes class-skill status and one-click test remains the primary workflow', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /H5\/H6 Combat & Klassenlogik/);
  assert.match(ui, /H6 Klassen-Skills/);
  assert.match(ui, /Anti-Spam Skips/);
  assert.match(ui, /Test starten/);
});
