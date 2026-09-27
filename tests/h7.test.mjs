import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.resolve(here, '../dist/al-bot.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makePartyContext(options = {}) {
  const memory = new Map();
  const calls = { attacks: 0, targets: [], heals: [], skills: [], moves: 0, smart: 0 };
  const cooldowns = new Map();

  const local = {
    id: 'LocalRanger',
    name: 'LocalRanger',
    ctype: options.localClass || 'ranger',
    level: 70,
    hp: options.localHp == null ? 1000 : options.localHp,
    max_hp: 1000,
    mp: 1200,
    max_mp: 1200,
    attack: 150,
    range: 120,
    speed: 60,
    frequency: 1,
    map: 'main',
    real_x: 0,
    real_y: 0,
    moving: false,
    rip: false,
    target: null,
    party: 'OwnedParty',
    s: {}
  };
  const partner = {
    id: 'TankWarrior',
    name: 'TankWarrior',
    type: 'character',
    player: true,
    ctype: options.partnerClass || 'warrior',
    level: 70,
    hp: options.partnerHp == null ? 1000 : options.partnerHp,
    max_hp: 1000,
    mp: 800,
    max_mp: 800,
    attack: 130,
    range: 40,
    map: 'main',
    real_x: 20,
    real_y: 0,
    visible: true,
    rip: options.partnerRip === true,
    target: options.partnerTarget === undefined ? 'm1' : options.partnerTarget,
    party: 'OwnedParty'
  };
  const monster = {
    id: 'm1',
    name: 'Goo',
    type: 'monster',
    mtype: 'goo',
    visible: true,
    dead: false,
    hp: 1200,
    max_hp: 1200,
    attack: 5,
    range: 25,
    frequency: 1,
    real_x: 80,
    real_y: 0,
    target: partner.name,
    map: 'main'
  };

  const skills = {
    heal: { class: ['priest'], mp: 40, share: 'attack', heal: true, target: true, range_multiplier: 1 },
    partyheal: { class: ['priest'], mp: 400, cooldown: 1200, heal: true, party: true, multi: true },
    revive: { class: ['priest'], mp: 500, cooldown: 200, range: 240, target: true },
    huntersmark: { class: ['ranger'], mp: 240, cooldown: 10000, range_multiplier: 3, target: true, hostile: true },
    supershot: { class: ['ranger'], mp: 400, cooldown: 30000, range_multiplier: 3, damage_multiplier: 1.5, target: true, hostile: true },
    taunt: { class: ['warrior'], mp: 40, cooldown: 3000, range: 200, target: true, hostile: true },
    attack: {}
  };

  const party = {
    [local.name]: { name: local.name, ctype: local.ctype, level: local.level, hp: local.hp, max_hp: local.max_hp, mp: local.mp, max_mp: local.max_mp, map: 'main' },
    [partner.name]: { name: partner.name, ctype: partner.ctype, level: partner.level, hp: partner.hp, max_hp: partner.max_hp, mp: partner.mp, max_mp: partner.max_mp, map: 'main', rip: partner.rip, target: partner.target }
  };

  if (options.foreign) {
    party.Stranger = { name: 'Stranger', ctype: 'mage', level: 60, hp: 900, max_hp: 900, map: 'main' };
  }

  const entities = { [partner.id]: partner, [monster.id]: monster };
  if (options.foreign) {
    entities.Stranger = { id: 'Stranger', name: 'Stranger', type: 'character', player: true, ctype: 'mage', level: 60, hp: 900, max_hp: 900, map: 'main', real_x: 30, real_y: 0, visible: true, party: 'OwnedParty' };
  }

  const ctx = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    navigator: { userAgent: 'node-h7-test' },
    localStorage: {
      getItem: key => memory.has(key) ? memory.get(key) : null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key)
    },
    character: local,
    entities,
    party,
    party_list: options.foreign ? [partner.name, local.name, 'Stranger'] : [partner.name, local.name],
    ctarget: null,
    G: { monsters: { goo: {} }, maps: { main: {} }, items: {}, skills },
    server_region: 'EU',
    server_identifier: 'I',
    get_party: () => party,
    get_characters: () => [
      { name: local.name, ctype: local.ctype, online: true },
      { name: partner.name, ctype: partner.ctype, online: true }
    ],
    get_active_characters: () => ({ [local.name]: 'self', [partner.name]: 'active' }),
    can_move_to: () => true,
    move: (x, y) => {
      calls.moves += 1;
      local.real_x = Number(x);
      local.real_y = Number(y);
      return { success: true };
    },
    smart_move: destination => {
      calls.smart += 1;
      if (destination && destination.x != null) local.real_x = Number(destination.x);
      if (destination && destination.y != null) local.real_y = Number(destination.y);
      return Promise.resolve({ success: true });
    },
    stop: () => ({ success: true }),
    change_target: target => {
      ctx.ctarget = target || null;
      local.target = target ? target.id : null;
      calls.targets.push(target ? target.id : null);
      return { success: true };
    },
    is_on_cooldown: skill => (cooldowns.get(skill) || 0) > Date.now(),
    can_use: skill => (cooldowns.get(skill) || 0) <= Date.now(),
    is_in_range: (target, skill) => {
      if (!target) return false;
      const def = skills[skill] || {};
      const tx = Number(target.real_x == null ? target.x : target.real_x);
      const ty = Number(target.real_y == null ? target.y : target.real_y);
      const distance = Math.hypot(local.real_x - tx, local.real_y - ty);
      if (Number.isFinite(Number(def.range))) return distance <= Number(def.range);
      const mult = Number.isFinite(Number(def.range_multiplier)) ? Number(def.range_multiplier) : 1;
      return distance <= local.range * mult;
    },
    can_attack: target => !!target && !target.dead && target.visible !== false
      && Math.hypot(local.real_x - target.real_x, local.real_y - target.real_y) <= local.range
      && (cooldowns.get('attack') || 0) <= Date.now(),
    attack: target => {
      calls.attacks += 1;
      cooldowns.set('attack', Date.now() + 80);
      const damage = 75;
      target.hp = Math.max(0, target.hp - damage);
      return Promise.resolve({ success: true, response: 'data', place: 'attack', target: target.id, attacker: local.name, damage });
    },
    heal: target => {
      calls.heals.push(target.name);
      cooldowns.set('attack', Date.now() + 80);
      target.hp = Math.min(target.max_hp, target.hp + 300);
      if (target === partner) party[partner.name].hp = target.hp;
      return Promise.resolve({ success: true, response: 'data', place: 'heal', target: target.name, heal: 300 });
    },
    use_skill: (skill, target) => {
      calls.skills.push({ skill, target: target && target.id ? target.id : target });
      cooldowns.set(skill, Date.now() + 100);
      if (options.throwSupport === skill) throw new Error('NETWORK_SYNC_UNKNOWN');
      if (options.rejectSupport === skill) return Promise.reject(new Error('NETWORK_UNCERTAIN'));
      if (skill === 'partyheal') {
        local.hp = Math.min(local.max_hp, local.hp + 200);
        partner.hp = Math.min(partner.max_hp, partner.hp + 200);
        party[local.name].hp = local.hp;
        party[partner.name].hp = partner.hp;
      }
      if (skill === 'revive') {
        partner.rip = false;
        partner.hp = 300;
        partner.visible = true;
        party[partner.name].rip = false;
        party[partner.name].hp = 300;
      }
      if (skill === 'huntersmark') monster.s = { marked: true };
      if (skill === 'supershot') monster.hp = Math.max(0, monster.hp - 150);
      return Promise.resolve({ success: true, response: 'data', place: skill, target: target && target.id ? target.id : target });
    },
    addEventListener() {},
    removeEventListener() {}
  };
  ctx.globalThis = ctx;
  return { ctx, local, partner, monster, party, calls };
}

test('H7 exposes normalized owned party roles and coordinator API', async t => {
  const { ctx } = makePartyContext();
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();

  assert.equal(ctx.ALBot.version, '0.17.0-h17');
  assert.equal(typeof ctx.ALBot.party.status, 'function');
  assert.equal(typeof ctx.ALBot.party.snapshot, 'function');
  assert.equal(ctx.ALBot.liveTests.status().recommendedId, 'h17-economy-autonomy');

  const snapshot = ctx.ALBot.party.snapshot();
  assert.equal(snapshot.size, 2);
  assert.equal(snapshot.coordinationEnabled, true);
  assert.equal(snapshot.foreignMemberNames.length, 0);
  assert.equal(snapshot.ownedMembers.find(row => row.name === 'TankWarrior').role, 'TANK');
  assert.equal(snapshot.ownedMembers.find(row => row.name === 'LocalRanger').role, 'DPS');
  assert.equal(ctx.ALBot.scheduler.status().totalResources, 13);
});

test('H7 fail-closes coordination when a foreign party member is present', async t => {
  const { ctx } = makePartyContext({ foreign: true });
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();
  await sleep(350);

  const party = ctx.ALBot.party.status();
  assert.equal(party.party.coordinationEnabled, false);
  assert.deepEqual(Array.from(party.party.foreignMemberNames), ['Stranger']);
  assert.equal(party.focus.targetId, null);
  assert.ok(party.metrics.foreignPartyBlocks >= 1);
});

test('H7 detects true A-B-A focus pingpong but not sequential unique targets', () => {
  const { ctx } = makePartyContext();
  vm.runInNewContext(bundle, ctx);
  const party = ctx.ALBot.__runtime.party;

  party._recordFocusTarget('m1', 'test', 1000);
  party._recordFocusTarget('m2', 'test', 2000);
  party._recordFocusTarget('m3', 'test', 3000);
  assert.equal(party.status().metrics.focusPingPongs, 0);

  party._recordFocusTarget('m2', 'test', 3500);
  assert.equal(party.status().metrics.focusPingPongs, 1);
});

test('H7 party focus follows owned tank target and H5 combat converges onto it', async t => {
  const { ctx } = makePartyContext();
  vm.runInNewContext(bundle, ctx);
  t.after(async () => {
    try { ctx.ALBot.combat.stop('TEST_CLEANUP'); } catch (_) {}
    try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {}
  });
  await ctx.ALBot.start();

  const started = ctx.ALBot.combat.start({ owner: 'h7-focus-test', maxAttack: 20, minMpRatio: 0, partyAssist: true });
  assert.equal(started.accepted, true);

  let converged = null;
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    const party = ctx.ALBot.party.status();
    const combat = ctx.ALBot.combat.status();
    if (party.focus.targetId === 'm1' && combat.session && combat.session.targetId === 'm1') {
      converged = { party, combat };
      break;
    }
    await sleep(40);
  }

  assert.ok(converged, 'party/combat focus did not converge before target lifecycle changed');
  assert.match(converged.party.focus.source, /^tank:/);
  assert.equal(converged.party.metrics.focusPingPongs, 0);
  const safe = ctx.ALBot.combat.candidates({ maxAttack: 20, minMpRatio: 0, partyAssist: true });
  assert.ok(safe.some(row => row.id === 'm1'), 'owned-party target must remain a safe H5 combat candidate');
});

test('H7 priest heals an injured owned party member through central action boundary', async t => {
  const { ctx, partner, calls } = makePartyContext({ localClass: 'priest', partnerHp: 400, partnerTarget: null });
  ctx.G.skills.darkblessing = { class: ['priest'], mp: 900, cooldown: 60000, party: true };
  ctx.G.skills.curse = { class: ['priest'], mp: 400, cooldown: 5000, range: 200, target: true };
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();
  await sleep(700);

  const party = ctx.ALBot.party.status();
  assert.ok(calls.heals.includes(partner.name));
  assert.ok(party.metrics.healsDispatched >= 1);
  assert.ok(party.metrics.supportConfirmed >= 1);
  assert.equal(party.metrics.supportUnknown, 0);
  assert.ok(ctx.ALBot.status().actions.supportedActions.includes('heal'));
});

test('H7 priest revive basis detects and revives a visible downed owned member', async t => {
  const { ctx, partner, calls } = makePartyContext({ localClass: 'priest', partnerRip: true, partnerHp: 0, partnerTarget: null });
  ctx.G.skills.darkblessing = { class: ['priest'], mp: 900, cooldown: 60000, party: true };
  ctx.G.skills.curse = { class: ['priest'], mp: 400, cooldown: 5000, range: 200, target: true };
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();
  await sleep(700);

  const party = ctx.ALBot.party.status();
  assert.ok(calls.skills.some(row => row.skill === 'revive' && row.target === partner.name));
  assert.ok(party.metrics.revivesDispatched >= 1);
  assert.ok(party.metrics.supportConfirmed >= 1);
  assert.equal(party.metrics.supportUnknown, 0);
});

test('H7 support UNKNOWN suspends further automated support without blind retry', async t => {
  const { ctx, calls } = makePartyContext({ localClass: 'priest', partnerHp: 400, partnerTarget: null, rejectSupport: 'partyheal' });
  ctx.character.hp = 500;
  ctx.party.LocalRanger.hp = 500;
  ctx.G.skills.darkblessing = { class: ['priest'], mp: 900, cooldown: 60000, party: true };
  ctx.G.skills.curse = { class: ['priest'], mp: 400, cooldown: 5000, range: 200, target: true };
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();
  await sleep(1000);

  const status = ctx.ALBot.party.status();
  assert.equal(status.support.suspended, true);
  assert.equal(status.metrics.supportUnknown, 1);
  assert.equal(calls.skills.filter(row => row.skill === 'partyheal').length, 1);
});

test('H7 synchronous support UNKNOWN suspends immediately without blind retry', async t => {
  const { ctx, calls } = makePartyContext({ localClass: 'priest', partnerHp: 400, partnerTarget: null, throwSupport: 'partyheal' });
  ctx.character.hp = 500;
  ctx.party.LocalRanger.hp = 500;
  ctx.G.skills.darkblessing = { class: ['priest'], mp: 900, cooldown: 60000, party: true };
  ctx.G.skills.curse = { class: ['priest'], mp: 400, cooldown: 5000, range: 200, target: true };
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();
  await sleep(700);

  const status = ctx.ALBot.party.status();
  assert.equal(status.support.suspended, true);
  assert.equal(status.metrics.supportUnknown, 1);
  assert.equal(calls.skills.filter(row => row.skill === 'partyheal').length, 1);
  assert.ok(ctx.ALBot.status().actions.metrics.synchronousErrors >= 1);
});

test('H7 blocks direct merchant combat before any attack dispatch', async t => {
  const { ctx, calls } = makePartyContext({ localClass: 'merchant' });
  vm.runInNewContext(bundle, ctx);
  t.after(async () => { try { await ctx.ALBot.stop('TEST_CLEANUP'); } catch (_) {} });
  await ctx.ALBot.start();

  const started = ctx.ALBot.combat.start({ owner: 'merchant-should-not-fight', maxAttack: 20, minMpRatio: 0 });
  assert.equal(started.accepted, false);
  assert.equal(started.reason, 'COMBAT_UNSUPPORTED_CLASS:merchant');
  await sleep(250);
  assert.equal(calls.attacks, 0);
  assert.equal(ctx.ALBot.combat.status().metrics.attackUnknown, 0);
});

test('H7 one-click live suite keeps logistics merchant observer-only and passes', async () => {
  const { ctx, calls } = makePartyContext({ localClass: 'merchant' });
  vm.runInNewContext(bundle, ctx);

  const result = await ctx.ALBot.liveTests.start('h7-party');

  assert.equal(result.state, 'PASSED');
  assert.equal(result.reason, 'ALL_STEPS_PASSED');
  assert.equal(result.steps.every(step => step.state === 'PASSED'), true);
  assert.equal(result.steps[0].result.localRole, 'LOGISTICS');
  assert.equal(result.steps[0].result.observerOnly, true);
  assert.equal(result.steps[1].result.observerOnly, true);
  assert.equal(result.steps[1].result.combatState, 'NOT_STARTED');
  assert.equal(result.steps[3].result.observerOnly, true);
  assert.equal(calls.attacks, 0);
  assert.equal(ctx.ALBot.status().running, false);
  assert.equal(ctx.ALBot.scheduler.status().totalResources, 0);
});

test('H7 one-click live suite passes for two owned party members and restores runtime state', async () => {
  const { ctx } = makePartyContext();
  vm.runInNewContext(bundle, ctx);

  const result = await ctx.ALBot.liveTests.start('h7-party');

  assert.equal(result.state, 'PASSED');
  assert.equal(result.reason, 'ALL_STEPS_PASSED');
  assert.equal(result.steps.every(step => step.state === 'PASSED'), true);
  assert.equal(result.steps[0].result.partySize, 2);
  assert.equal(result.steps[1].result.focusTargetId, 'm1');
  assert.equal(ctx.ALBot.status().running, false);
  assert.equal(ctx.ALBot.scheduler.status().totalResources, 0);
});

test('H7 UI includes party coordination surface and one-click workflow', () => {
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  assert.match(ui, /data-tab="party"/);
  assert.match(ui, /H7 Party/);
  assert.match(ui, /Focus Target/);
  assert.match(ui, /Test starten/);
});
