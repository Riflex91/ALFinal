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

function team(options = {}) {
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
    const server = { region: options.region || 'EU', identifier: options.servers && options.servers[name] || 'II' };
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
      roster: { refresh: () => ({
        accountStateAvailable: true, onlineStateAvailable: true,
        accountCharacters: names.map(name => ({ name })),
        onlineCharacterNames: names
      }) },
      farmIntelligence: { status: () => ({
        lastPlan: { selected: { competitors: 5, visibleSafeCount: 1 } }
      }) }
    };
    const hop = new Hop({ runtime, storage, game, root });
    hop.moduleActive = true;
    hop.catalogUpdatedAtMs = Date.now();
    hop.config.targetServers = [
      { region: 'EU', identifier: 'I' }, { region: 'EU', identifier: 'II' },
      { region: 'EU', identifier: 'III' }, { region: 'US', identifier: 'I' },
      { region: 'US', identifier: 'II' }, { region: 'US', identifier: 'III' }
    ];
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
  assert.equal(t.members.My_Merchant.hop.status().metrics.proposals, 1,
    JSON.stringify({
      merchant: t.members.My_Merchant.hop.status().lastDecision,
      ranger: t.members.My_Ranger1.hop.status().lastDecision,
      congestion: t.db.get('albot:h38:server-hop:v1:congestion'),
      peers: names.map(n => t.db.get('albot:h38:server-hop:v1:peer:' + n))
    }));
  assert.equal(t.members.My_Merchant.calls.length, 0);
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  const ticketKey = 'albot:h38:server-hop:v1:proposal';
  let ticket = JSON.parse(t.db.get(ticketKey));
  assert.equal(ticket.state, 'COMMITTED');
  assert.equal(ticket.target.region, 'EU');
  assert.equal(ticket.target.identifier, 'III');
  assert.equal(t.members.My_Ranger1.hop.handoffActive(), true);
  ticket.switchAtMs = Date.now() - 1;
  t.db.set(ticketKey, JSON.stringify(ticket));
  for (const name of names) t.members[name].hop.tick();
  for (const name of names) {
    assert.equal(t.members[name].calls.length, 1);
    assert.equal(t.members[name].calls[0].identifier, 'III');
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
  const group = { enabled: true, isLeader: true, complete: true, sameMap: true, maxPairDistance: 225, leaderName: 'My_Ranger1' };
  const first = instance._tickGroupLeader({ name: 'My_Ranger1' }, group);
  assert.equal(first.reason, 'H38_GROUP_TRAVEL_COHESION_GRACE');
  assert.deepEqual(cancelled, []);
  now += 12000;
  instance._tickGroupLeader({ name: 'My_Ranger1' }, group);
  assert.ok(cancelled.includes('H9_GROUP_HARD_COHESION_RECOVERY'));
});

test('H39 permits all verified EU/US PVE realms but excludes PVP, Hardcore, unknown metadata and other regions', () => {
  const t = team();
  const h = t.members.My_Merchant.hop;
  const list = h._normalizeGameServerCatalog({ servers: [
    { region: 'EU', name: 'I', pvp: false },
    { region: 'EU', name: 'II', pvp: false },
    { region: 'EU', name: 'III', pvp: false },
    { region: 'EU', name: 'IV', pvp: false },
    { region: 'US', name: 'I', pvp: false },
    { region: 'US', name: 'II', pvp: false },
    { region: 'US', name: 'III', pvp: false },
    { region: 'US', name: 'IV', pvp: false },
    { region: 'US', name: 'PVP', pvp: true },
    { region: 'EU', name: 'V', pvp: true },
    { region: 'US', name: 'HARDCORE', pvp: false },
    { region: 'ASIA', name: 'I', pvp: false },
    { region: 'US', name: 'V' },
    { region: 'EU', name: 'VI', pvp: 'unknown' },
    { region: 'US', name: 'III', pvp: false },
    { region: 'EU', identifier: 'VII', name: 'EU-PvP-7', pvp: false, type: 'pve' },
    { region: 'US', identifier: 'VIII', name: 'pVp-Battle', pvp: false },
    { region: 'EU', identifier: 'IX', name: 'NoPvP', pvp: false },
    { region: 'US', identifier: 'X', name: 'US Normal PvP Zone', pvp: 0 },
    { region: 'US', identifier: 'XI', server_name: 'us-mixedPVP-11', pvp: false },
    { region: 'EU', identifier: 'XII', serverName: 'PvpHiddenInName', pvp: false }
  ]});
  assert.deepEqual([...list].map(s => s.region + ' ' + s.identifier), [
    'EU I','EU II','EU III','EU IV','US I','US II','US III','US IV'
  ]);
  h.config.targetServers = list;
  assert.deepEqual({ ...h._target({ region: 'EU', identifier: 'IV' }) }, { region: 'US', identifier: 'I' });
  assert.deepEqual({ ...h._target({ region: 'US', identifier: 'IV' }) }, { region: 'EU', identifier: 'I' });
  assert.equal(h._target({ region: 'US', identifier: 'PVP' }), null);
  assert.equal(list.some(s => s.region === 'EU' && s.identifier === 'XII'), false);
  assert.equal(list.some(s => s.region === 'US' && s.identifier === 'XI'), false);
  for (const id of ['VII', 'IX']) {
    assert.equal(list.some(s => s.region === 'EU' && s.identifier === id), false);
  }
  for (const id of ['VIII', 'X']) {
    assert.equal(list.some(s => s.region === 'US' && s.identifier === id), false);
  }
});

test('H39 uses live get_servers() results and never picks an unverified target', async () => {
  const t = team();
  const h = t.members.My_Merchant.hop;
  h.catalogUpdatedAtMs = null;
  h.config.targetServers = [];
  h.root.get_servers = () => Promise.resolve({ servers: [
    { region: 'EU', identifier: 'II', pvp: false },
    { region: 'US', identifier: 'I', pvp: false },
    { region: 'US', identifier: 'PVP', pvp: true }
  ]});
  assert.equal(h._target({ region: 'EU', identifier: 'II' }), null);
  h._refreshGameServerCatalog();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.catalogPending, false);
  assert.deepEqual({ ...h._target({ region: 'EU', identifier: 'II' }) }, { region: 'US', identifier: 'I' });
  assert.equal(h.catalogError, null);
});

test('H39 stale catalog fails closed and PVP-only live list does not authorize a hop', async () => {
  const t = team();
  const h = t.members.My_Merchant.hop;
  h.catalogUpdatedAtMs = Date.now() - h.config.catalogMaxAgeMs - 10;
  assert.equal(h._target({ region: 'EU', identifier: 'II' }), null);
  h.config.targetServers = h._normalizeGameServerCatalog({ servers: [
    { region: 'EU', name: 'I', pvp: true },
    { region: 'US', name: 'PVP', pvp: true }
  ]});
  h.catalogUpdatedAtMs = Date.now();
  assert.equal(h._target({ region: 'EU', identifier: 'II' }), null);
});

test('H42: Merchant on EU I automatically rejoins three owned farmers on EU II', () => {
  const t = team({ servers: { My_Merchant: 'I' } });
  for (const name of names) t.members[name].hop.tick();
  const merchant = t.members.My_Merchant.hop;
  const proposal = merchant.tick();
  assert.equal(proposal.reason, 'H42_REJOIN_MAJORITY_SELECTED');
  assert.equal(proposal.target.identifier, 'II');
  assert.deepEqual([...proposal.movingNames], ['My_Merchant']);
  assert.equal(merchant.handoffActive(), true);
  for (const name of names) t.members[name].hop.tick();
  assert.equal(t.members.My_Merchant.calls.length, 1);
  assert.equal(t.members.My_Merchant.calls[0].identifier, 'II');
  for (const name of names) t.members[name].hop.tick();
  assert.equal(merchant.rejoinActive(), false);
  assert.equal(t.members.My_Ranger1.calls.length, 0);
  assert.equal(t.members.My_Ranger2.calls.length, 0);
  assert.equal(t.members.My_Rogue.calls.length, 0);
});

test('H42: a single outlying farmer follows the Merchant and two other farmers', () => {
  const t = team({ servers: { My_Rogue: 'I' } });
  for (const name of names) t.members[name].hop.tick();
  const proposal = t.members.My_Merchant.hop.tick();
  assert.equal(proposal.reason, 'H42_REJOIN_MAJORITY_SELECTED');
  assert.deepEqual([...proposal.movingNames], ['My_Rogue']);
  t.members.My_Rogue.hop.tick();
  assert.deepEqual(t.members.My_Rogue.calls[0], { region:'EU',identifier:'II' });
  assert.equal(t.members.My_Merchant.calls.length, 0);
});

test('H42: a two-versus-two split never triggers arbitrary migration', () => {
  const t = team({ servers: { My_Merchant: 'I', My_Rogue:'I' } });
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  assert.equal(t.db.has('albot:h38:server-hop:v1:rejoin'), false);
  for (const name of names) assert.equal(t.members[name].calls.length, 0);
});

test('H42: unknown H19 settlement blocks all split-party recovery', () => {
  const t = team({ servers: { My_Merchant: 'I' } });
  t.members.My_Rogue.runtime.lifecycle.status = () => ({
    suspended:false,currentAction:null,metrics:{actionsUnknown:1}
  });
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  assert.equal(t.db.has('albot:h38:server-hop:v1:rejoin'), false);
});

test('H42: never targets PVP, even when it has three online members', () => {
  const t = team({ servers: { My_Merchant:'II',My_Ranger1:'PVP',My_Ranger2:'PVP',My_Rogue:'PVP' } });
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  assert.equal(t.db.has('albot:h38:server-hop:v1:rejoin'), false);
});

test('H42: a committed rejoin cannot bypass local H19 suspension', () => {
  const t = team({ servers: { My_Merchant:'I' } });
  for (const name of names) t.members[name].hop.tick();
  t.members.My_Merchant.hop.tick();
  t.members.My_Merchant.runtime.lifecycle.status = () => ({
    suspended:true,currentAction:null,metrics:{actionsUnknown:0}
  });
  const state = t.members.My_Merchant.hop.tick();
  assert.equal(state.reason, 'H42_REJOIN_H19_SAFETY_GATE');
  assert.equal(t.members.My_Merchant.calls.length,0);
});
