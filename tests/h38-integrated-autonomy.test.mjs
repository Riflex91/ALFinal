import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function controller(file, name) {
  const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  const ctx = {
    Date, JSON, Set, Map, Math, Number, String,
    __ALBOT_INTERNALS__: {
      helpers: {
        clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
        cleanText: (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx, { filename: file });
  return ctx.__ALBOT_INTERNALS__[name];
}
const Hop = controller('server-hop.js', 'ServerHopController');
const Merchant = controller('merchant-autonomy.js', 'MerchantAutonomyController');
const Farm = controller('farm-intelligence.js', 'FarmIntelligenceController');
const names = ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'].sort();

function team() {
  const db = new Map();
  const storage = {
    sharedAvailable: () => true,
    getShared: k => db.get(k) || null,
    setShared: (k, v) => { db.set(k, v); return true; }
  };
  const members = {};
  for (const name of names) {
    const merchant = name === 'My_Merchant';
    const local = { name, ctype: merchant ? 'merchant' : 'ranger', rip: false };
    const server = { region: 'EU', identifier: 'II' };
    const calls = [];
    const root = { change_server: (region, identifier) => {
      calls.push({ region, identifier }); server.identifier = identifier;
    } };
    const game = { snapshot: () => ({
      character: local, server, target: null, available: true
    }) };
    const runtime = {
      running: true, stopLatch: { status: () => ({ latched: false }) },
      fullAutonomy: { status: () => ({
        enabled: true, desiredCharacterNames: names,
        lastPlan: { leaderName: 'My_Ranger1' }
      }) },
      lifecycle: { status: () => ({ suspended: false, currentAction: null, metrics: { actionsUnknown: 0 } }) },
      combat: { status: () => ({ pendingAttack: null, suspended: false }) },
      farming: { status: () => ({ pending: null, suspended: false }) },
      movement: { status: () => ({ active: false }) },
      safeUpdater: { status: () => ({ busy: false }) },
      roster: { refresh: () => ({ onlineCharacterNames: names }) },
      farmIntelligence: { status: () => ({
        lastPlan: { selected: { competitors: 5, visibleSafeCount: 1 } }
      }) }
    };
    const hop = new Hop({ runtime, storage, game, root });
    hop.moduleActive = true;
    members[name] = { hop, calls, server, root, runtime };
  }
  return { db, members };
}

test('H38 one farmer cannot hop without four fresh safe peers', () => {
  const t = team();
  const ranger = t.members.My_Ranger1.hop;
  ranger.congestedSinceMs = Date.now() - 130000;
  ranger.tick();
  t.members.My_Merchant.hop.tick();
  assert.equal(t.members.My_Merchant.hop.status().metrics.proposals, 0);
  assert.equal(t.members.My_Merchant.calls.length, 0);
});

test('H38 sustained congestion creates a proposal; four peers ACK before any navigation', () => {
  const t = team();
  const ranger = t.members.My_Ranger1.hop;
  ranger.congestedSinceMs = Date.now() - 130000;
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  assert.equal(t.members.My_Merchant.hop.status().metrics.proposals, 1);
  assert.equal(t.members.My_Merchant.calls.length, 0);
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  const ticketKey = 'albot:h38:server-hop:v1:proposal';
  let ticket = JSON.parse(t.db.get(ticketKey));
  assert.equal(ticket.state, 'COMMITTED');
  assert.equal(ticket.target.identifier, 'I');
  assert.equal(t.members.My_Ranger1.hop.handoffActive(), true);
  ticket.switchAtMs = Date.now() - 1;
  t.db.set(ticketKey, JSON.stringify(ticket));
  for (const name of names) t.members[name].hop.tick();
  for (const name of names) {
    assert.equal(t.members[name].calls.length, 1);
    assert.equal(t.members[name].calls[0].identifier, 'I');
  }
  for (const name of names) t.members[name].hop.tick();
  assert.equal(t.members.My_Ranger1.hop.handoffActive(), false);
  assert.equal(t.members.My_Ranger1.calls.length, 1);
});

test('H38 H19 UNKNOWN blocks quorum', () => {
  const t = team();
  t.members.My_Rogue.runtime.lifecycle.status = () => ({
    suspended: false, currentAction: null, metrics: { actionsUnknown: 1 }
  });
  t.members.My_Ranger1.hop.congestedSinceMs = Date.now() - 130000;
  for (const name of names) t.members[name].hop.tick();
  assert.equal(t.members.My_Merchant.hop.status().metrics.proposals, 0);
});

test('H38 Merchant publishes material demand even when Economy owns an action', () => {
  const instance = Object.create(Merchant.prototype);
  instance.moduleActive = true;
  instance.autoManage = true;
  instance.suspendedReason = null;
  instance.lastMaterialDemandCheckAtMs = 0;
  instance.materialFarmRequest = null;
  instance._isMerchant = () => true;
  instance._skillEnabled = () => true;
  instance._inventoryRow = () => null;
  instance._equippedMainhand = () => null;
  instance._observePending = () => null;
  instance._childBusy = () => null;
  instance.merritSession = null;
  instance.pending = { kind: 'EXCHANGE' };
  instance._requestToolMaterialFarm = tool => ({
    state: 'WAITING', reason: 'MERCHANT_TOOL_MATERIAL_FARM_PUBLISHED', tool
  });
  instance.status = () => ({});
  let called = [];
  const original = instance._requestToolMaterialFarm;
  instance._requestToolMaterialFarm = tool => { called.push(tool); return original(tool); };
  instance._maintenanceTick();
  assert.deepEqual(called, ['rod']);
});

test('H38 group leader does not cancel travel on the first hard-gap sample', () => {
  const instance = Object.create(Farm.prototype);
  let now = 100000;
  const cancelled = [];
  instance.now = () => now;
  instance.config = {
    groupRegroupTriggerDistance: 150, groupHardRegroupDistance: 195,
    groupTravelCohesionGraceMs: 9000
  };
  instance.metrics = { groupLeaderHolds: 0 };
  instance.movement = { cancel: reason => cancelled.push(reason) };
  instance._movementStatus = () => ({ activeOrder: { owner: 'farm-intelligence-h9', destination: { map: 'main', x: 0, y: 0 } } });
  instance._farmingStatus = () => ({ active: false });
  instance._groupEncounterActive = () => false;
  instance._stopOwnedFarming = () => {};
  instance._bestLeaderRecoveryWaypoint = () => null;
  const group = { complete: true, sameMap: true, maxPairDistance: 225, leaderName: 'My_Ranger1' };
  const first = instance._tickGroupLeader({ name: 'My_Ranger1' }, group);
  assert.equal(first.reason, 'H38_GROUP_TRAVEL_COHESION_GRACE');
  assert.deepEqual(cancelled, []);
  now += 12000;
  instance._tickGroupLeader({ name: 'My_Ranger1' }, group);
  assert.ok(cancelled.includes('H9_GROUP_HARD_COHESION_RECOVERY'));
});
