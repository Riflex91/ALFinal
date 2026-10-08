import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const encounterSource = fs.readFileSync(path.resolve(here, '../src/encounters.js'), 'utf8');
const autonomySource = fs.readFileSync(path.resolve(here, '../src/full-autonomy.js'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function create(options = {}) {
  const root = {
    Date, Math, JSON, Map, Set, Promise, String, Number, Object, Array, Boolean,
    __ALBOT_INTERNALS__: { helpers: {
      clone,
      cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max)
    } },
    G: { monsters: { slenderman: { boss: true } } },
    S: { slenderman: { active: true, live: true, map: 'cave', x: 0, y: 0 } }
  };
  root.globalThis = root;
  vm.runInNewContext(encounterSource, root);
  const character = options.character || { name: 'My_Warrior', ctype: 'warrior', map: 'cave', x: 0, y: 0 };
  let visible = [];
  const controller = new root.__ALBOT_INTERNALS__.EncounterController({
    root,
    absentTargetWaitMs: 15000,
    absentTargetCooldownMs: 300000,
    game: {
      snapshot: () => ({ available: true, character }),
      monsterDefinition: type => root.G.monsters[type] || null,
      visibleMonsters: ({ type } = {}) => type === 'slenderman' ? visible : []
    },
    combat: { safeCandidates: () => options.safeCandidates || [] }
  });
  controller.setEnabled('event', 'slenderman', true);
  return { root, controller, character, setVisible: monsters => { visible = monsters; } };
}

test('slenderman at cave (0,0) with no mob switches to cooldown and frees FARM', () => {
  const { controller } = create();
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  const marker = controller.absentEventTargets.get('slenderman');
  assert.ok(marker, 'arrival starts waiting rather than an immediate blacklist');
  marker.arrivedAtMs = Date.now() - controller.config.absentTargetWaitMs - 1;
  assert.equal(controller.preferredTask(), null, 'absent event must no longer override FARM');
  const plan = controller.plan({ taskType: 'EVENT' });
  assert.equal(plan.state, 'WAITING');
  assert.equal(plan.actionability.reason, 'ENCOUNTER_TARGET_ABSENT_COOLDOWN');
  assert.equal(controller.status().metrics.absentTargetCooldowns, 1, 'no repeated cooldown increments');
  assert.equal(controller.preferredTask(), null);
  assert.equal(controller.status().metrics.absentTargetCooldowns, 1);
  assert.equal(controller.status().absentTargetObservations[0].coolingDown, true);
});

test('absent event resumes after cooldown, then waits again before another fallback', () => {
  const { controller } = create();
  controller.preferredTask();
  const marker = controller.absentEventTargets.get('slenderman');
  marker.arrivedAtMs -= controller.config.absentTargetWaitMs + 1;
  assert.equal(controller.preferredTask(), null);
  const cooling = controller.absentEventTargets.get('slenderman');
  cooling.retryAtMs = Date.now() - 1;
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.equal(controller.absentEventTargets.get('slenderman').retryAtMs, 0);
  assert.equal(controller.status().metrics.absentTargetCooldowns, 1);
});

test('visible safe event reactivates immediately even during absence cooldown', () => {
  const { controller, setVisible } = create({ safeCandidates: [{ id: 's1' }] });
  controller.preferredTask();
  controller.absentEventTargets.get('slenderman').arrivedAtMs -= 20000;
  assert.equal(controller.preferredTask(), null);
  setVisible([{ id: 's1', mtype: 'slenderman', distance: 15, hp: 100, maxHp: 100 }]);
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.equal(controller.absentEventTargets.has('slenderman'), false);
});

test('destination is still travelled to and observation begins only after confirmed arrival', () => {
  const character = { name: 'My_Warrior', ctype: 'warrior', map: 'main', x: 0, y: 0 };
  const { controller } = create({ character });
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.equal(controller.absentEventTargets.has('slenderman'), false);
  character.map = 'cave';
  character.x = 0;
  character.y = 0;
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.ok(controller.absentEventTargets.has('slenderman'));
  character.x = 300;
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.equal(controller.absentEventTargets.has('slenderman'), false);
});

test('event round change and explicit event preference allow a fresh observation', () => {
  const { controller, root } = create();
  controller.preferredTask();
  controller.absentEventTargets.get('slenderman').arrivedAtMs -= 20000;
  assert.equal(controller.preferredTask(), null);
  root.S.slenderman.round = 2;
  assert.equal(controller.preferredTask().taskType, 'EVENT', 'new event round must not inherit old cooldown');
  controller.setEnabled('event', 'slenderman', false);
  assert.equal(controller.preferredTask(), null);
  controller.setEnabled('event', 'slenderman', true);
  assert.equal(controller.preferredTask().taskType, 'EVENT');
});

test('Full Autonomy leaves encounter ownership and starts FARM for a waiting EVENT plan', () => {
  const root = create().root;
  vm.runInNewContext(autonomySource, root);
  const Controller = root.__ALBOT_INTERNALS__.FullAutonomyController;
  const full = Object.create(Controller.prototype);
  let stopped = 0;
  let farmStarted = 0;
  full._local = () => ({ name: 'My_Warrior', ctype: 'warrior' });
  full.started = { encounters: true, farming: false };
  full.runtime = {
    encounters: {
      plan: () => ({ state: 'WAITING', reason: 'ENCOUNTER_TARGET_ABSENT_COOLDOWN' }),
      stopAutonomy: () => { stopped += 1; }
    },
    farmIntelligence: {
      status: () => ({ active: false, suspended: false }),
      configureGroup: () => {},
      startAutonomy: () => { farmStarted += 1; return { accepted: true }; }
    }
  };
  const result = full._ensureCombatRole({
    taskType: 'EVENT', selected: { memberNames: ['My_Warrior'] },
    leaderName: 'My_Warrior'
  });
  assert.equal(result.ok, true);
  assert.equal(result.shouldFarm, true);
  assert.equal(farmStarted, 1);
  assert.equal(stopped, 1);
  assert.equal(full.started.farming, true);
  assert.equal(full.started.encounters, false);
});

test('three independent combat characters all release an absent shared event', () => {
  for (const [name, ctype] of [
    ['My_Warrior', 'warrior'],
    ['My_Ranger1', 'ranger'],
    ['My_Priest', 'priest']
  ]) {
    const { controller } = create({
      character: { name, ctype, map: 'cave', x: 0, y: 0 }
    });
    assert.equal(controller.preferredTask().taskType, 'EVENT', name);
    const observation = controller.absentEventTargets.get('slenderman');
    assert.ok(observation, name);
    observation.arrivedAtMs -= controller.config.absentTargetWaitMs + 1;
    assert.equal(controller.preferredTask(), null, name + ' should return to FARM priority');
    assert.equal(controller.plan({ taskType: 'EVENT' }).state, 'WAITING', name);
  }
});

test('missing local coordinates are not misread as arrival at event coordinate zero', () => {
  const character = { name: 'My_Warrior', ctype: 'warrior', map: 'cave', x: null, y: null };
  const { controller } = create({ character });
  assert.equal(controller.preferredTask().taskType, 'EVENT');
  assert.equal(controller.absentEventTargets.has('slenderman'), false);
});
