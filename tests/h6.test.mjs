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
    charge: { class: ['warrior'], mp: 0, cooldown: 40000, condition: 'charging' },
    taunt: { name: 'Taunt', skin: 'skill_taunt', explanation: 'Draws a monster toward you.', class: ['warrior'], mp: 40, cooldown: 3000, range: 200, target: true, hostile: true },
    hardshell: { class: ['warrior'], level: 60, mp: 480, cooldown: 16000, condition: 'hardshell' },
    warcry: { class: ['warrior'], level: 70, mp: 320, cooldown: 60000, range: 600, condition: 'warcry' },
    cleave: { class: ['warrior'], level: 52, wtype: ['axe', 'scythe'], mp: 720, range: 160, cooldown: 1200, hostile: true },
    stomp: { class: ['warrior'], level: 52, wtype: 'basher', mp: 120, range: 400, cooldown: 3200, condition: 'stunned', hostile: true },

    huntersmark: { class: ['ranger'], mp: 240, cooldown: 10000, range_multiplier: 3, range_bonus: 20, target: true, condition: 'marked', hostile: true, use_range: true },
    poisonarrow: { class: ['ranger'], wtype: ['bow', 'crossbow'], mp: 360, cooldown: 300, consume: 'poison', target: true, condition: 'poisoned', hostile: true, use_range: true },
    piercingshot: { class: ['ranger'], level: 72, wtype: ['bow', 'crossbow'], mp: 64, share: 'attack', target: true, hostile: true, use_range: true, damage_multiplier: 0.75 },
    supershot: { class: ['ranger'], wtype: ['bow', 'crossbow'], mp: 400, cooldown: 30000, range_multiplier: 3, range_bonus: 20, target: true, hostile: true, use_range: true, damage_multiplier: 1.5 },
    '3shot': { class: ['ranger'], level: 60, wtype: ['bow', 'crossbow'], mp: 200, share: 'attack', multi: true, use_range: true, damage_multiplier: 0.7 },
    '5shot': { class: ['ranger'], level: 75, wtype: ['bow', 'crossbow'], mp: 320, share: 'attack', multi: true, use_range: true, damage_multiplier: 0.5 },

    burst: { class: ['mage'], mp: 0, cooldown: 6000, ratio: 0.555, target: true, hostile: true, use_range: true },
    cburst: { class: ['mage'], level: 75, mp: 80, cooldown: 240, ratio: 0.5, list: true, hostile: true, use_range: true },
    entangle: { class: ['mage'], level: 72, mp: 360, range: 480, cooldown: 40000, consume: 'essenceofnature', target: true, monsters: true, condition: 'tangled', hostile: true },
    arcane_needle: { class: ['mage'], level: 90, wtype: ['wand'], mp: 160, share: 'attack', target: true, hostile: true, use_range: true, damage_multiplier: 0.75 },

    heal: { class: ['priest'], share: 'attack', target: true, heal: true, use_range: true },
    partyheal: { class: ['priest'], mp: 400, cooldown: 200, party: true, multi: true, heal: true },
    revive: { class: ['priest'], mp: 500, cooldown: 200, range: 240, consume: 'essenceoflife', target: 'player' },
    phaseout: { class: ['priest'], level: 64, mp: 200, cooldown: 4000, consume: 'shadowstone', condition: 'phasedout' },
    curse: { class: ['priest'], mp: 400, cooldown: 5000, range: 200, target: true, condition: 'cursed', hostile: true },
    darkblessing: { class: ['priest'], level: 70, mp: 900, cooldown: 60000, range: 600, condition: 'darkblessing' },

    invis: { class: ['rogue'], reuse_cooldown: 12000 },
    pcoat: { class: ['rogue'], mp: 600, cooldown: 50000, consume: 'poison', condition: 'poisonous' },
    mentalburst: { class: ['rogue'], mp: 180, cooldown: 900, range_multiplier: 1.2, range_bonus: 32, requirements: { int: 64 }, target: true, hostile: true, use_range: true, damage_multiplier: 0.6 },
    quickpunch: { class: ['rogue'], wtype: 'fist', mp: 240, cooldown: 250, target: true, hostile: true, use_range: true, damage_multiplier: 0.25 },
    quickstab: { class: ['rogue'], wtype: 'dagger', mp: 320, cooldown: 250, share: 'quickpunch', target: true, hostile: true, use_range: true, damage_multiplier: 0.36 },
    fanofknives: { class: ['rogue'], level: 65, slot: [['belt', 'knifebelt']], mp: 180, range: 160, multi: true, max_targets: 5, share: 'attack', hostile: true, damage_multiplier: 0.85 },

    selfheal: { class: ['paladin'], mp: 20, cooldown: 1200, heal: true },
    shield_slam: { class: ['paladin'], level: 60, offhand_type: 'shield', mp: 2000, cooldown: 600, target: true, hostile: true, use_range: true, damage_multiplier: 3 },
    purify: { class: ['paladin'], level: 60, mp: 360, cooldown: 24000, range: 480, target: true, hostile: true },
    smash: { class: ['paladin'], level: 10, wtype: 'mace', mp: 380, cooldown: 320, target: true, hostile: true, use_range: true, damage_multiplier: 0.36 },
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
    str: options.str == null ? 80 : options.str,
    int: options.int == null ? 80 : options.int,
    dex: options.dex == null ? 80 : options.dex,
    vit: options.vit == null ? 80 : options.vit,
    map: 'main',
    real_x: 0,
    real_y: 0,
    range: options.range == null ? 100 : options.range,
    speed: 60,
    frequency: 1,
    moving: false,
    rip: false,
    target: null,
    s: {},
    slots: options.slots ? JSON.parse(JSON.stringify(options.slots)) : {},
    items: options.items ? JSON.parse(JSON.stringify(options.items)) : []
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

  const G = {
    monsters: { goo: { armor: options.targetArmor || 0, resistance: options.targetResistance || 0 } },
    maps: { main: {} },
    items: {
      bow: { type: 'weapon', wtype: 'bow' },
      crossbow: { type: 'weapon', wtype: 'crossbow' },
      wand: { type: 'weapon', wtype: 'wand' },
      fist: { type: 'weapon', wtype: 'fist' },
      dagger: { type: 'weapon', wtype: 'dagger' },
      mace: { type: 'weapon', wtype: 'mace' },
      axe: { type: 'weapon', wtype: 'axe' },
      basher: { type: 'weapon', wtype: 'basher' },
      shield: { type: 'shield', wtype: 'shield' },
      knifebelt: { type: 'belt' },
      poison: { type: 'material' },
      shadowstone: { type: 'material' },
      essenceofnature: { type: 'material' },
      essenceoflife: { type: 'material' }
    },
    skills: skillDefs()
  };
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
    entities: {
      [monster.id]: monster,
      ...(options.extraEntities ? JSON.parse(JSON.stringify(options.extraEntities)) : {})
    },
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

  assert.equal(ctx.ALBot.version, '0.26.55-h26');
  assert.equal(typeof ctx.ALBot.classSkills.status, 'function');
  assert.equal(typeof ctx.ALBot.classSkills.preview, 'function');
  assert.equal(typeof ctx.ALBot.classSkills.catalog, 'function');
  assert.equal(typeof ctx.ALBot.classSkills.setEnabled, 'function');
  assert.equal(typeof ctx.ALBot.classSkills.enabled, 'function');
  assert.equal(ctx.ALBot.liveTests.status().recommendedId, 'h19-remote-recovery');

  const module = ctx.ALBot.modules.list().find(row => row.id === 'class-skills');
  assert.equal(module.state, 'ACTIVE');
  assert.equal(module.resources, 0);
  assert.ok(ctx.ALBot.scheduler.status().totalResources > 0);
});

test('Skills catalog uses live class metadata and disabled H6 skills cannot dispatch', async t => {
  const { ctx, calls } = await startController({
    ctype: 'warrior', level: 28, mp: 300, maxMp: 300, range: 100, targetX: 50
  });
  t.after(async () => { try { ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {} try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  const catalog = ctx.ALBot.classSkills.catalog('warrior');
  const taunt = catalog.find(row => row.id === 'taunt');
  assert.ok(taunt);
  assert.equal(taunt.definition.name, 'Taunt');
  assert.equal(taunt.definition.skin, 'skill_taunt');
  assert.equal(taunt.definition.explanation, 'Draws a monster toward you.');
  assert.equal(taunt.definition.range, 200);
  assert.equal(taunt.definition.mp, 40);
  assert.equal(taunt.enabled, true);

  assert.equal(ctx.ALBot.classSkills.preview('m1').skillId, 'taunt');
  const changed = ctx.ALBot.classSkills.setEnabled('taunt', false, 'warrior');
  assert.equal(changed.accepted, true);
  assert.equal(ctx.ALBot.classSkills.enabled('taunt', 'warrior'), false);
  assert.equal(ctx.ALBot.classSkills.preview('m1'), null);

  assert.equal(ctx.ALBot.combat.start({ owner: 'skills-disabled-h6', maxAttack: 20, minMpRatio: 0 }).accepted, true);
  await sleep(500);
  assert.equal(calls.skills.some(row => row.skill === 'taunt'), false);
  assert.ok(ctx.ALBot.classSkills.status().metrics.disabledSkips >= 1);
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
    { ctype: 'mage', expected: 'arcane_needle', level: 90, targetHp: 1000, targetResistance: 300, attack: 100, mp: 800, maxMp: 800, slots: { mainhand: { name: 'wand' } } },
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


test('H32 blocks Rogue mentalburst unless the live 64 INT requirement is met', async t => {
  const low = await startController({
    ctype: 'rogue', level: 60, int: 40, mp: 1000, maxMp: 1000,
    targetX: 50, targetHp: 500, attack: 100
  });
  const high = await startController({
    ctype: 'rogue', level: 60, int: 64, mp: 1000, maxMp: 1000,
    targetX: 50, targetHp: 500, attack: 100
  });
  t.after(async () => {
    for (const env of [low, high]) {
      try { env.ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  const blocked = low.ctx.ALBot.__runtime.game.skillReadiness('mentalburst', 'm1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.includes('SKILL_REQUIREMENT_INT_TOO_LOW'));
  assert.notEqual(low.ctx.ALBot.classSkills.preview('m1')?.skillId, 'mentalburst');

  const allowed = high.ctx.ALBot.__runtime.game.skillReadiness('mentalburst', 'm1');
  assert.equal(allowed.allowed, true);
  assert.equal(high.ctx.ALBot.classSkills.preview('m1').skillId, 'mentalburst');
});

test('H32 Rogue quick skills follow the actually equipped weapon type', async t => {
  const dagger = await startController({
    ctype: 'rogue', level: 60, int: 40, mp: 1000, maxMp: 1000,
    targetX: 30, targetHp: 200, attack: 100,
    slots: { mainhand: { name: 'dagger' } }
  });
  const fist = await startController({
    ctype: 'rogue', level: 60, int: 40, mp: 1000, maxMp: 1000,
    targetX: 30, targetHp: 200, attack: 100,
    slots: { mainhand: { name: 'fist' } }
  });
  t.after(async () => {
    for (const env of [dagger, fist]) {
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  assert.equal(dagger.ctx.ALBot.__runtime.game.skillReadiness('quickstab', 'm1').allowed, true);
  assert.ok(dagger.ctx.ALBot.__runtime.game.skillReadiness('quickpunch', 'm1').reasons.includes('SKILL_WEAPON_TYPE_MISMATCH'));
  assert.equal(dagger.ctx.ALBot.classSkills.preview('m1').skillId, 'quickstab');

  assert.equal(fist.ctx.ALBot.__runtime.game.skillReadiness('quickpunch', 'm1').allowed, true);
  assert.ok(fist.ctx.ALBot.__runtime.game.skillReadiness('quickstab', 'm1').reasons.includes('SKILL_WEAPON_TYPE_MISMATCH'));
  assert.equal(fist.ctx.ALBot.classSkills.preview('m1').skillId, 'quickpunch');
});

test('H32 Ranger multi-shot readiness honors level, bow and shared attack cooldown', async t => {
  const r59 = await startController({
    ctype: 'ranger', level: 59, mp: 1000, maxMp: 1000,
    slots: { mainhand: { name: 'bow' } }
  });
  const r60 = await startController({
    ctype: 'ranger', level: 60, mp: 1000, maxMp: 1000,
    slots: { mainhand: { name: 'bow' } }
  });
  t.after(async () => {
    for (const env of [r59, r60]) {
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  const low = r59.ctx.ALBot.__runtime.game.skillReadiness('3shot');
  assert.equal(low.allowed, false);
  assert.ok(low.reasons.includes('SKILL_LEVEL_TOO_LOW'));

  const ready = r60.ctx.ALBot.__runtime.game.skillReadiness('3shot');
  assert.equal(ready.allowed, true);

  r60.cooldowns.set('attack', Date.now() + 5000);
  const shared = r60.ctx.ALBot.__runtime.game.skillReadiness('3shot');
  assert.equal(shared.allowed, false);
  assert.ok(shared.reasons.includes('SKILL_COOLDOWN'));
  assert.equal(shared.cooldownSource, 'attack');

  const five = r60.ctx.ALBot.__runtime.game.skillReadiness('5shot');
  assert.equal(five.allowed, false);
  assert.ok(five.reasons.includes('SKILL_LEVEL_TOO_LOW'));
});

test('H32 consumable and equipment-gated skills fail closed before dispatch', async t => {
  const noItems = await startController({
    ctype: 'mage', level: 90, mp: 3000, maxMp: 3000,
    slots: { mainhand: { name: 'wand' } }
  });
  const rogue = await startController({
    ctype: 'rogue', level: 70, mp: 2000, maxMp: 2000,
    slots: { mainhand: { name: 'dagger' }, belt: { name: 'knifebelt' } },
    items: [{ name: 'poison', q: 0 }]
  });
  const paladin = await startController({
    ctype: 'paladin', level: 80, mp: 3000, maxMp: 3000,
    slots: { mainhand: { name: 'mace' } }
  });
  t.after(async () => {
    for (const env of [noItems, rogue, paladin]) {
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  const entangle = noItems.ctx.ALBot.__runtime.game.skillReadiness('entangle', 'm1');
  assert.equal(entangle.allowed, false);
  assert.ok(entangle.reasons.includes('SKILL_CONSUMABLE_MISSING'));
  assert.equal(noItems.ctx.ALBot.__runtime.game.skillReadiness('arcane_needle', 'm1').allowed, true);

  const poison = rogue.ctx.ALBot.__runtime.game.skillReadiness('pcoat');
  assert.equal(poison.allowed, false);
  assert.ok(poison.reasons.includes('SKILL_CONSUMABLE_MISSING'));
  assert.equal(rogue.ctx.ALBot.__runtime.game.skillReadiness('fanofknives').allowed, true);

  const slam = paladin.ctx.ALBot.__runtime.game.skillReadiness('shield_slam', 'm1');
  assert.equal(slam.allowed, false);
  assert.ok(slam.reasons.includes('SKILL_OFFHAND_TYPE_MISMATCH'));
  assert.equal(paladin.ctx.ALBot.__runtime.game.skillReadiness('smash', 'm1').allowed, true);
});

test('H32 Mage Mana Burst skips weak farm kills and only secures high-value long fights', async t => {
  const weakKillable = await startController({
    ctype: 'mage', level: 80, mp: 800, maxMp: 800,
    targetHp: 400, attack: 100, targetX: 50
  });
  const tooHealthy = await startController({
    ctype: 'mage', level: 80, mp: 3000, maxMp: 3000,
    targetHp: 1800, attack: 250, targetX: 50
  });
  const highValueKillable = await startController({
    ctype: 'mage', level: 80, mp: 3000, maxMp: 3000,
    targetHp: 1400, attack: 250, targetX: 50
  });
  t.after(async () => {
    for (const env of [weakKillable, tooHealthy, highValueKillable]) {
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  assert.equal(weakKillable.ctx.ALBot.classSkills.preview('m1'), null);
  assert.equal(tooHealthy.ctx.ALBot.classSkills.preview('m1'), null);
  const preview = highValueKillable.ctx.ALBot.classSkills.preview('m1');
  assert.ok(preview);
  assert.equal(preview.skillId, 'burst');
  assert.equal(preview.reason, 'MAGE_BURST_HIGH_VALUE_KILL_SECURE');
});

test('H32 resource topoff excludes situational party support and disabled skills from passive MP reserve', async t => {
  const { ctx } = await startController({
    ctype: 'mage', level: 80, mp: 1350, maxMp: 1350,
    targetHp: 400, attack: 100, targetX: 50
  });
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });

  const first = ctx.ALBot.__runtime.resourceTopoff._skillReserve(ctx.ALBot.__runtime.game.snapshot().character);
  assert.equal(first.skills.some(row => row.id === 'reflection'), false);
  assert.equal(first.maxSkillCost, 360);
  assert.ok(first.requiredRatio < 0.5);

  assert.equal(ctx.ALBot.classSkills.setEnabled('entangle', false, 'mage').accepted, true);
  const second = ctx.ALBot.__runtime.resourceTopoff._skillReserve(ctx.ALBot.__runtime.game.snapshot().character);
  assert.equal(second.skills.some(row => row.id === 'entangle'), false);
  assert.equal(second.maxSkillCost, 160);
});

test('H32 known skill immunity is rejected without suspending the combat session skills', async t => {
  const { ctx, calls } = await startController({
    ctype: 'priest', level: 60, mp: 1000, maxMp: 1000,
    targetHp: 1000, attack: 100, targetX: 50,
    rejectSkill: 'curse', rejectSkillReason: 'skill_immune'
  });
  t.after(async () => {
    try { ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });

  assert.equal(ctx.ALBot.combat.start({ owner: 'h32-priest-immune', maxAttack: 200, minMpRatio: 0 }).accepted, true);
  await sleep(700);
  const state = ctx.ALBot.classSkills.status();
  assert.equal(state.suspended, false);
  assert.equal(state.metrics.unknown, 0);
  assert.ok(state.metrics.rejected >= 1);
  assert.equal(calls.skills.filter(row => row.skill === 'curse').length, 1);
});


test('H32 readiness covers AoE and party skill prerequisites across all combat classes', async t => {
  const warrior = await startController({
    ctype: 'warrior', level: 80, mp: 3000, maxMp: 3000,
    slots: { mainhand: { name: 'axe' } }
  });
  const mage = await startController({ ctype: 'mage', level: 74, mp: 3000, maxMp: 3000 });
  const priestMissing = await startController({
    ctype: 'priest', level: 80, mp: 3000, maxMp: 3000,
    extraEntities: {
      Ally: { id: 'Ally', name: 'Ally', type: 'character', ctype: 'warrior', rip: true, dead: true, visible: true, real_x: 10, real_y: 0 }
    }
  });
  const priestReady = await startController({
    ctype: 'priest', level: 80, mp: 3000, maxMp: 3000,
    items: [{ name: 'essenceoflife', q: 1 }],
    extraEntities: {
      Ally: { id: 'Ally', name: 'Ally', type: 'character', ctype: 'warrior', rip: true, dead: true, visible: true, real_x: 10, real_y: 0 }
    }
  });
  t.after(async () => {
    for (const env of [warrior, mage, priestMissing, priestReady]) {
      try { await env.ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
    }
  });

  assert.equal(warrior.ctx.ALBot.__runtime.game.skillReadiness('cleave').allowed, true);
  const stomp = warrior.ctx.ALBot.__runtime.game.skillReadiness('stomp');
  assert.equal(stomp.allowed, false);
  assert.ok(stomp.reasons.includes('SKILL_WEAPON_TYPE_MISMATCH'));

  const cburst = mage.ctx.ALBot.__runtime.game.skillReadiness('cburst');
  assert.equal(cburst.allowed, false);
  assert.ok(cburst.reasons.includes('SKILL_LEVEL_TOO_LOW'));

  const missingRevive = priestMissing.ctx.ALBot.__runtime.game.skillReadiness('revive', 'Ally', { allowDeadTarget: true });
  assert.equal(missingRevive.allowed, false);
  assert.ok(missingRevive.reasons.includes('SKILL_CONSUMABLE_MISSING'));

  const readyRevive = priestReady.ctx.ALBot.__runtime.game.skillReadiness('revive', 'Ally', { allowDeadTarget: true });
  assert.equal(readyRevive.allowed, true);
  assert.equal(readyRevive.definition.targetType, 'player');
});
