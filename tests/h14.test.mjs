import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gearSource = fs.readFileSync(path.resolve(here, '../src/gear.js'), 'utf8');
const adapterSource = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function internals() {
  return {
    helpers: {
      clone,
      cleanText: (value, max = 1000) => String(value == null ? '' : value).slice(0, max)
    }
  };
}

const definitions = {
  gloves_old: {
    id: 'gloves_old', name: 'Old Gloves', type: 'gloves', wtype: null, classes: [],
    stats: { armor: 5 }, upgradeGrowth: {}, upgradeable: true, compoundable: false
  },
  gloves_new: {
    id: 'gloves_new', name: 'New Gloves', type: 'gloves', wtype: null, classes: [],
    stats: { armor: 12, str: 1 }, upgradeGrowth: { armor: 1 }, upgradeable: true, compoundable: false
  },
  gloves_locked: {
    id: 'gloves_locked', name: 'Locked Gloves', type: 'gloves', wtype: null, classes: [],
    stats: { armor: 20 }, upgradeGrowth: {}, upgradeable: true, compoundable: false
  },
  sword: {
    id: 'sword', name: 'Sword', type: 'weapon', wtype: 'sword', classes: ['warrior'],
    stats: { attack: 10 }, upgradeGrowth: { attack: 2 }, upgradeable: true, compoundable: false
  },
  greatsword: {
    id: 'greatsword', name: 'Greatsword', type: 'weapon', wtype: 'greatsword', classes: ['warrior'],
    stats: { attack: 25 }, upgradeGrowth: { attack: 3 }, upgradeable: true, compoundable: false
  },
  shield: {
    id: 'shield', name: 'Shield', type: 'shield', wtype: null, classes: ['warrior'],
    stats: { armor: 15 }, upgradeGrowth: { armor: 1 }, upgradeable: true, compoundable: false
  },
  ring_int: {
    id: 'ring_int', name: 'Int Ring', type: 'ring', wtype: null, classes: [],
    stats: { int: 3 }, upgradeGrowth: {}, upgradeable: false, compoundable: true
  }
};

const profiles = {
  merchant: { ctype: 'merchant', mainhand: ['staff'], offhand: ['source'], doublehand: [] },
  warrior: { ctype: 'warrior', mainhand: ['sword'], offhand: ['shield', 'sword'], doublehand: ['greatsword'] },
  priest: { ctype: 'priest', mainhand: ['staff', 'wand'], offhand: ['source'], doublehand: [] }
};

function item(overrides = {}) {
  return {
    slot: 0,
    name: 'gloves_new',
    quantity: 1,
    level: 1,
    statType: null,
    locked: false,
    giveaway: false,
    gift: false,
    property: null,
    expiresAt: null,
    ...overrides
  };
}

function equipped(name, overrides = {}) {
  return {
    name,
    quantity: 1,
    level: 0,
    statType: null,
    locked: false,
    giveaway: false,
    gift: false,
    property: null,
    expiresAt: null,
    ...overrides
  };
}

function fixture(options = {}) {
  const localCtype = options.ctype || 'merchant';
  const state = {
    local: {
      name: options.localName || 'My_Merchant',
      ctype: localCtype,
      map: 'main',
      x: 0,
      y: 0,
      rip: false,
      gold: 100000
    },
    rows: clone(options.rows || [
      item({ slot: 0, name: 'gloves_new', level: 1 }),
      item({ slot: 1, name: 'ring_int', level: 0 }),
      item({ slot: 2, name: 'gloves_locked', level: 0, locked: true })
    ]),
    equipment: {
      My_Merchant: clone(options.localEquipment || {
        gloves: equipped('gloves_old', { level: 0 })
      }),
      My_Warrior: clone(options.farmerEquipment || {
        gloves: equipped('gloves_old', { level: 0 })
      })
    },
    dispatches: [],
    inventoryAvailable: options.inventoryAvailable !== false
  };

  if (state.local.name !== 'My_Merchant') {
    state.equipment[state.local.name] = clone(options.localEquipment || state.equipment.My_Merchant);
  }
  if (localCtype === 'warrior' && !options.localEquipment) {
    state.equipment[state.local.name] = {
      mainhand: equipped('sword'),
      offhand: equipped('shield')
    };
    state.rows = [
      item({ slot: 0, name: 'gloves_new', level: 1 }),
      item({ slot: 1, name: 'greatsword', level: 1 }),
      item({ slot: 2, name: 'gloves_locked', locked: true })
    ];
  }

  const ctypeFor = name => name === state.local.name ? state.local.ctype : name === 'My_Warrior' ? 'warrior' : null;

  const inventorySnapshot = () => ({
    schemaVersion: 1,
    available: state.inventoryAvailable,
    reason: state.inventoryAvailable ? null : 'CHARACTER_UNAVAILABLE',
    capacity: 12,
    usedSlots: state.inventoryAvailable ? state.rows.length : 0,
    freeSlots: state.inventoryAvailable ? 12 - state.rows.length : 0,
    reportedEmptySlots: state.inventoryAvailable ? 12 - state.rows.length : 0,
    items: state.inventoryAvailable ? clone(state.rows) : []
  });

  const equipmentSnapshot = name => {
    const target = name || state.local.name;
    const slots = state.equipment[target];
    if (!slots) {
      return { schemaVersion: 1, available: false, reason: 'PLAYER_NOT_VISIBLE', character: { name: target, ctype: null }, slots: {} };
    }
    const ctype = ctypeFor(target);
    return {
      schemaVersion: 1,
      available: true,
      reason: null,
      character: { name: target, ctype, map: 'main', rip: false },
      profile: clone(profiles[ctype] || null),
      slots: clone(slots)
    };
  };

  const game = {
    snapshot: () => ({ available: true, character: { ...state.local } }),
    inventorySnapshot,
    equipmentSnapshot,
    equipmentDefinition: name => definitions[name] ? clone(definitions[name]) : null,
    classEquipmentProfile: ctype => profiles[ctype] ? clone(profiles[ctype]) : null
  };

  const roster = {
    refresh: () => ({
      source: 'fixture',
      local: { name: state.local.name, ctype: state.local.ctype },
      characters: [
        { name: 'My_Warrior', ctype: 'warrior', online: true },
        { name: 'My_Merchant', ctype: 'merchant', online: true }
      ],
      farmers: [{ name: 'My_Warrior', ctype: 'warrior', online: true }],
      merchant: { name: 'My_Merchant', ctype: 'merchant', online: true },
      hardcodedNamesRequired: false
    })
  };

  const combat = { status: () => ({ state: options.combatActive ? 'FIGHTING' : 'IDLE', active: !!options.combatActive }) };

  const findRow = slot => state.rows.find(row => Number(row.slot) === Number(slot));
  const removeRow = slot => {
    const index = state.rows.findIndex(row => Number(row.slot) === Number(slot));
    if (index < 0) return null;
    return state.rows.splice(index, 1)[0];
  };
  const firstFree = () => {
    for (let slot = 0; slot < 12; slot += 1) if (!findRow(slot)) return slot;
    return -1;
  };

  const actions = {
    dispatch: (name, args) => {
      state.dispatches.push({ name, args: clone(args) });
      if (options.syncUnknown) return { state: 'UNKNOWN', error: { message: 'NETWORK_UNCERTAIN' } };
      if (options.neverSettle) return { state: 'DISPATCHED', value: new Promise(() => {}) };
      if (options.noMutation !== true) {
        if (name === 'equip') {
          const [inventorySlot, targetSlot] = args;
          const candidate = removeRow(inventorySlot);
          assert.ok(candidate);
          const old = state.equipment[state.local.name][targetSlot] || null;
          state.equipment[state.local.name][targetSlot] = {
            name: candidate.name,
            quantity: 1,
            level: candidate.level || 0,
            statType: candidate.statType || null,
            locked: !!candidate.locked,
            giveaway: !!candidate.giveaway,
            gift: !!candidate.gift,
            property: candidate.property == null ? null : clone(candidate.property),
            expiresAt: candidate.expiresAt == null ? null : candidate.expiresAt
          };
          if (old) state.rows.push({ ...clone(old), slot: Number(inventorySlot) });
        } else if (name === 'unequip') {
          const [targetSlot] = args;
          const old = state.equipment[state.local.name][targetSlot] || null;
          if (old) {
            const free = firstFree();
            assert.ok(free >= 0);
            state.rows.push({ ...clone(old), slot: free });
            delete state.equipment[state.local.name][targetSlot];
          }
        } else if (name === 'send_item') {
          const [, inventorySlot] = args;
          removeRow(inventorySlot);
        }
      }
      return { state: 'DISPATCHED', value: Promise.resolve({ success: true }) };
    }
  };

  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    setTimeout,
    __ALBOT_INTERNALS__: internals()
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(gearSource, ctx, { filename: 'gear.js' });
  const Controller = ctx.__ALBOT_INTERNALS__.GearController;
  const controller = new Controller({
    root: ctx,
    game,
    actions,
    roster,
    combat,
    outcomeTimeoutMs: 1000
  });
  controller.start({ scope: { interval: () => 'gear-resource' } });
  return { controller, state, game, roster, combat, actions };
}

test('H14 ranks a real local improvement and exposes upgrade candidates', () => {
  const f = fixture();
  const plan = f.controller.plan();
  assert.equal(plan.state, 'READY');
  const gloves = plan.local.slots.find(row => row.slot === 'gloves');
  assert.ok(gloves);
  assert.equal(gloves.improvement, true);
  assert.equal(gloves.safeSwitch, true);
  assert.equal(gloves.bestInventory.item.name, 'gloves_new');
  assert.equal(gloves.bestInventory.item.locked, false);
  assert.ok(gloves.delta > 0);
  assert.ok(plan.local.upgradeCandidates.some(row => row.item.name === 'gloves_new'));
});

test('H14 group allocation keeps farmers ahead of merchant and proposes only merchant-safe delivery', () => {
  const f = fixture();
  const plan = f.controller.plan();
  assert.equal(plan.group.targets[0].role, 'FARMER');
  assert.equal(plan.group.targets.at(-1).role, 'MERCHANT');
  assert.ok(plan.group.proposals.length > 0);
  assert.equal(plan.group.proposals[0].targetName, 'My_Warrior');
  assert.notEqual(plan.group.proposals[0].item.name, 'gloves_locked');

  const farmerLocal = fixture({ ctype: 'warrior', localName: 'My_Warrior' });
  const farmerPlan = farmerLocal.controller.plan();
  assert.equal(farmerPlan.group.proposals.length, 0);
});

test('H14 group allocation uses distinct inventory items for interchangeable ring slots', () => {
  const f = fixture({
    rows: [
      item({ slot: 3, name: 'ring_int', level: 2 }),
      item({ slot: 4, name: 'ring_int', level: 1 })
    ]
  });
  const proposals = f.controller.plan().group.proposals
    .filter(row => row.targetName === 'My_Warrior' && row.item.name === 'ring_int');
  assert.equal(proposals.length, 2);
  assert.equal(new Set(proposals.map(row => row.inventorySlot)).size, 2);
  assert.equal(new Set(proposals.map(row => row.slot)).size, 2);
  assert.deepEqual(new Set(proposals.map(row => row.slot)), new Set(['ring1', 'ring2']));
});

test('H14 Gear Goals distinguish local equip, remote delivery and acquisition gaps', () => {
  const f = fixture();
  f.controller.setGoals([
    { id: 'local', targetName: 'My_Merchant', slot: 'gloves', itemName: 'gloves_new', minLevel: 1 },
    { id: 'farmer', targetName: 'My_Warrior', slot: 'gloves', itemName: 'gloves_new', minLevel: 1 },
    { id: 'missing', targetName: 'My_Warrior', slot: 'helmet', itemName: 'unknown_helmet', minLevel: 0 }
  ]);
  const goals = f.controller.plan().goals;
  assert.equal(goals.find(row => row.id === 'local').state, 'READY_TO_EQUIP');
  assert.equal(goals.find(row => row.id === 'farmer').state, 'READY_TO_DELIVER');
  assert.equal(goals.find(row => row.id === 'missing').state, 'NEEDS_ACQUISITION');
});

test('H14 locked gift giveaway or expiring gear is excluded from automated equip planning', () => {
  const f = fixture();
  const plan = f.controller.plan();
  const gloves = plan.local.slots.find(row => row.slot === 'gloves');
  assert.equal(gloves.bestInventory.item.name, 'gloves_new');
  assert.equal(f.controller.queueEquip(2, 'gloves').accepted, false);
  assert.equal(f.controller.queueEquip(2, 'gloves').reason, 'H14_EQUIP_ITEM_NOT_AUTOMATION_SAFE');
  assert.equal(f.state.dispatches.length, 0);
});

test('H14 two-hand candidate is fail-closed when it would displace an offhand', () => {
  const f = fixture({ ctype: 'warrior', localName: 'My_Warrior' });
  const result = f.controller.queueEquip(1, 'mainhand');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H14_TWO_HAND_WOULD_DISPLACE_OFFHAND');
  assert.equal(f.state.dispatches.length, 0);
});

test('H14 combat blocks equipment writes', () => {
  const f = fixture({ combatActive: true });
  const result = f.controller.queueEquip(0, 'gloves');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'H14_COMBAT_ACTIVE');
  assert.equal(f.state.dispatches.length, 0);
});

test('H14 equip confirms only from equipment and inventory deltas', async () => {
  const f = fixture();
  const queued = f.controller.queueEquip(0, 'gloves');
  assert.equal(queued.accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.dispatches[0].name, 'equip');
  await Promise.resolve();
  f.controller.tick();
  const status = f.controller.status();
  assert.equal(status.metrics.equipsConfirmed, 1);
  assert.equal(status.metrics.equipsUnknown, 0);
  assert.equal(f.state.equipment.My_Merchant.gloves.name, 'gloves_new');
  assert.ok(f.state.rows.some(row => row.name === 'gloves_old'));
});

test('H14 equip revalidates the target slot immediately before dispatch', () => {
  const f = fixture();
  assert.equal(f.controller.queueEquip(0, 'gloves').accepted, true);
  f.state.equipment.My_Merchant.gloves = equipped('gloves_locked');
  const blocked = f.controller.tick();
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'H14_EQUIP_TARGET_CHANGED');
  assert.equal(f.state.dispatches.length, 0);
});

test('H14 unequip requires free inventory space and confirms the slot becomes empty', async () => {
  const f = fixture();
  const queued = f.controller.queueUnequip('gloves');
  assert.equal(queued.accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.unequipsConfirmed, 1);
  assert.equal(f.state.equipment.My_Merchant.gloves, undefined);
  assert.ok(f.state.rows.some(row => row.name === 'gloves_old'));
});

test('H14 merchant delivery accepts only own visible farmers and confirms sender delta', async () => {
  const f = fixture();
  assert.equal(f.controller.queueDelivery('ForeignGuy', 0).reason, 'H14_DELIVERY_TARGET_NOT_OWN_FARMER');
  assert.equal(f.controller.queueDelivery('My_Warrior', 2).reason, 'H14_DELIVERY_ITEM_NOT_TRANSFER_SAFE');

  const queued = f.controller.queueDelivery('My_Warrior', 0);
  assert.equal(queued.accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  assert.equal(f.state.dispatches[0].name, 'send_item');
  await Promise.resolve();
  f.controller.tick();
  assert.equal(f.controller.status().metrics.deliveriesConfirmed, 1);
  assert.equal(f.state.rows.some(row => row.name === 'gloves_new'), false);
});

test('H14 never-settling equip becomes UNKNOWN, suspends and never blindly retries', () => {
  const f = fixture({ neverSettle: true, noMutation: true });
  assert.equal(f.controller.queueEquip(0, 'gloves').accepted, true);
  assert.equal(f.controller.tick().state, 'DISPATCHED');
  f.controller.pending.deadlineAtMs = Date.now() - 1;
  assert.equal(f.controller.tick().state, 'SUSPENDED');
  assert.equal(f.controller.status().metrics.equipsUnknown, 1);
  assert.equal(f.state.dispatches.length, 1);
  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H14 synchronous UNKNOWN suspends immediately without retry', () => {
  const f = fixture({ syncUnknown: true, noMutation: true });
  assert.equal(f.controller.queueEquip(0, 'gloves').accepted, true);
  assert.equal(f.controller.tick().state, 'SUSPENDED');
  assert.equal(f.controller.status().metrics.equipsUnknown, 1);
  assert.equal(f.state.dispatches.length, 1);
  f.controller.tick();
  assert.equal(f.state.dispatches.length, 1);
});

test('H14 game adapter exposes equipment definitions, class profiles and live slots', () => {
  const root = {
    character: {
      name: 'WarriorA',
      ctype: 'warrior',
      map: 'main',
      items: [],
      slots: {
        mainhand: { name: 'sword', level: 2 },
        offhand: { name: 'shield', level: 1 },
        trade1: { name: 'gloves_new', level: 1 },
        elixir: { name: 'elixir' }
      }
    },
    G: {
      items: {
        sword: { name: 'Sword', type: 'weapon', wtype: 'sword', class: ['warrior'], attack: 10, upgrade: { attack: 2 } },
        shield: { name: 'Shield', type: 'shield', class: ['warrior'], armor: 15, upgrade: { armor: 1 } },
        gloves_new: { name: 'New Gloves', type: 'gloves', armor: 12 },
        elixir: { name: 'Elixir', type: 'elixir' }
      },
      classes: {
        warrior: {
          mainhand: { sword: true },
          offhand: { shield: true, sword: true },
          doublehand: { greatsword: true }
        }
      }
    }
  };
  root.parent = root;
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error,
    __ALBOT_INTERNALS__: internals(),
    ...root
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(adapterSource, ctx, { filename: 'game-adapter.js' });
  const Adapter = ctx.__ALBOT_INTERNALS__.AdventureLandGameAdapter;
  const adapter = new Adapter({ root: ctx });
  const definition = adapter.equipmentDefinition('sword');
  assert.equal(definition.wtype, 'sword');
  assert.equal(definition.stats.attack, 10);
  assert.equal(definition.upgradeGrowth.attack, 2);
  const profile = adapter.classEquipmentProfile('warrior');
  assert.deepEqual(Array.from(profile.mainhand), ['sword']);
  assert.deepEqual(Array.from(profile.doublehand), ['greatsword']);
  const equipment = adapter.equipmentSnapshot('WarriorA');
  assert.equal(equipment.available, true);
  assert.equal(equipment.slots.mainhand.name, 'sword');
  assert.equal(equipment.slots.offhand.name, 'shield');
  assert.equal(equipment.slots.trade1, undefined);
  assert.equal(equipment.slots.elixir, undefined);
});

test('H14 runtime, API, UI, build, adapter and ActionBoundary are wired', () => {
  const runtime = fs.readFileSync(path.resolve(here, '../src/runtime.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(here, '../src/entry.js'), 'utf8');
  const ui = fs.readFileSync(path.resolve(here, '../src/ui.js'), 'utf8');
  const build = fs.readFileSync(path.resolve(here, '../scripts/build.mjs'), 'utf8');
  const boundary = fs.readFileSync(path.resolve(here, '../src/action-boundary.js'), 'utf8');
  const adapter = fs.readFileSync(path.resolve(here, '../src/game-adapter.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));

  assert.match(runtime, /new ns\.GearController/);
  assert.match(runtime, /id: 'gear'/);
  assert.match(runtime, /id: 'h14-gear'/);
  assert.match(runtime, /H14_NEEDS_REVERSIBLE_COMPATIBLE_INVENTORY_GEAR/);
  assert.match(entry, /0\.26\.78-h26/);
  assert.match(entry, /runtime\.gear\.queueBestLocal/);
  assert.match(ui, /data-tab="gear"/);
  assert.match(ui, /H14 Gear/);
  assert.match(build, /src\/gear\.js/);
  assert.match(build, /const runtimeVersion = '0\.26\.78-h26'/);
  assert.match(boundary, /equip: Object\.freeze\(\{ publicName: 'equip'/);
  assert.match(boundary, /unequip: Object\.freeze\(\{ publicName: 'unequip'/);
  assert.match(adapter, /equipmentSnapshot\(name = null\)/);
  assert.match(adapter, /classEquipmentProfile\(ctype\)/);
  assert.equal(pkg.version, '0.26.78');
});
