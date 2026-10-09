import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const env = () => {
  const r = { console, Date, Math, JSON, Map, Set, Promise, Object, String, Number, Array, Boolean, Error,
    __ALBOT_INTERNALS__: { helpers: { clone, cleanText: (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max) } } };
  r.globalThis = r;
  return r;
};
function load(root, file) {
  vm.runInNewContext(fs.readFileSync(path.resolve(dir, '../src/' + file), 'utf8'), root, { filename: file });
}
function setup() {
  const root = env();
  load(root, 'party-logistics.js');
  const C = root.__ALBOT_INTERNALS__.PartyLogisticsController;
  const local = { name: 'My_Merchant', ctype: 'merchant', map: 'main', x: 0, y: 0 };
  const target = { name: 'My_Rogue', local: false, visible: false, map: 'cave', x: null, y: null };
  const party = {
    partyId: 'My_Merchant', coordinationEnabled: true,
    ownedMembers: [ { name: 'My_Merchant', local: true, visible: true }, target ]
  };
  const peer = {
    running: true, emergencyStopLatched: false,
    party: { partyId: 'My_Merchant', memberNames: ['My_Merchant', 'My_Rogue'] },
    profile: { name: 'My_Rogue', map: 'cave', x: 48, y: 66, rip: false, observedAtMs: Date.now() }
  };
  const ctl = new C({
    root,
    game: { snapshot: () => ({ available: true, character: local }) },
    crossWindow: { freshPeer: name => name === 'My_Rogue' ? peer : null },
    actions: { available: name => name === 'send_item' }
  });
  ctl._gearDeliveryRow = () => ({ row: { name: 'hpamulet', slot: 4, quantity: 1 },
    authorization: { reservation: { fingerprint: 'hpamulet|0||' } } });
  const request = { id: 'gear-1', kind: 'GEAR', targetName: 'My_Rogue', inventorySlot: 4 };
  return { ctl, local, target, party, peer, request };
}

test('H42 reserved remote Gear may approach only a fresh same-party owned peer', () => {
  const { ctl, party, peer, request, local } = setup();
  const plan = ctl._requestPlan(request, party, { character: local });
  assert.equal(plan.state, 'READY');
  assert.equal(plan.reason, 'H18_GEAR_REMOTE_APPROACH_REQUIRED');
  assert.equal(plan.selected.kind, 'APPROACH');
  assert.equal(plan.selected.destination.map, 'cave');
  assert.equal(plan.selected.advisoryOnly, true);
  assert.equal(ctl._requestPlan({ ...request, kind: 'SUPPLY' }, party, { character: local }).reason, 'H18_TARGET_NOT_VISIBLE');
  peer.profile.observedAtMs = Date.now() - 10000;
  assert.equal(ctl._requestPlan(request, party, { character: local }).reason, 'H18_TARGET_NOT_VISIBLE');
  peer.profile.observedAtMs = Date.now();
  peer.party.partyId = 'OtherParty';
  assert.equal(ctl._requestPlan(request, party, { character: local }).reason, 'H18_TARGET_NOT_VISIBLE');
  peer.party.partyId = 'My_Merchant';
  peer.emergencyStopLatched = true;
  assert.equal(ctl._requestPlan(request, party, { character: local }).reason, 'H18_TARGET_NOT_VISIBLE');
  peer.emergencyStopLatched = false;
  ctl._gearDeliveryRow = () => null;
  assert.equal(ctl._requestPlan(request, party, { character: local }).reason, 'H18_GEAR_DELIVERY_NOT_AUTHORIZED');
});

test('H42 live visibility is required for gear send; advisory proximity alone is not sufficient', () => {
  const { ctl, party, peer, request, local, target } = setup();
  local.map = 'cave'; local.x = 45; local.y = 65;
  assert.equal(ctl._requestPlan(request, party, { character: local }).reason, 'H18_TARGET_NOT_VISIBLE');
  target.visible = true; target.map = 'cave'; target.x = 48; target.y = 66;
  ctl._gearDeliveryRow = () => ({ row: { name: 'hpamulet', slot: 4, quantity: 1 }, authorization: { reservation: { fingerprint: 'hpamulet:0' } } });
  const live = ctl._requestPlan(request, party, { character: local });
  assert.equal(live.state, 'READY');
  assert.equal(live.reason, 'H18_GEAR_DELIVERY_READY');
  assert.equal(live.selected.kind, 'GEAR');
  assert.equal(live.selected.targetName, 'My_Rogue');
  target.visible = false;
  peer.profile.x = null;
  assert.equal(ctl._requestPlan(request, party, { character: local }).reason, 'H18_TARGET_NOT_VISIBLE');
});

test('H42 local profile coordinates preserve unknown positions as null', () => {
  const root = env(); load(root, 'account-strategy.js');
  const C = root.__ALBOT_INTERNALS__.AccountStrategyController;
  const ctl = Object.create(C.prototype);
  const character = { name: 'My_Rogue', ctype: 'rogue', map: 'cave', x: -30, y: 71 };
  ctl.game = { snapshot: () => ({ character }) };
  ctl._localEquipment = () => null;
  ctl._localGearScore = () => 0;
  ctl.now = () => Date.now();
  const known = ctl.localProfile();
  assert.equal(known.x, -30); assert.equal(known.y, 71);
  character.x = null; character.y = undefined;
  const unknown = ctl.localProfile();
  assert.equal(unknown.x, null); assert.equal(unknown.y, null);
});

test('H42 H19 peer normalization retains only explicitly known nonempty Gear for H14 advisory', () => {
  const root = env(); load(root, 'cross-window-lifecycle.js');
  const C = root.__ALBOT_INTERNALS__.H19CrossWindowLifecycleTransport;
  const tx = Object.create(C.prototype);
  tx.now = () => Date.now();
  tx.config = { staleMs: 5000, maxPeers: 16 };
  tx.peers = new Map();
  const at = Date.now();
  const payload = {
    sessionId: 'h19-rogue-session', running: true,
    profile: { name: 'My_Rogue', ctype: 'rogue', map: 'cave',
      equipmentKnown: true, equipment: { mainhand: { name: 'claw', level: 0 } }, observedAtMs: at }
  };
  const known = tx._updatePeer('My_Rogue', payload, at);
  assert.equal(known.profile.equipmentKnown, true);
  assert.equal(known.profile.equipment.mainhand.name, 'claw');
  payload.profile.equipmentKnown = false;
  assert.equal(tx._updatePeer('My_Rogue', payload, at).profile.equipmentKnown, false);
  payload.profile.equipmentKnown = true; payload.profile.equipment = {};
  assert.equal(tx._updatePeer('My_Rogue', payload, at).profile.equipmentKnown, false);
  payload.profile.equipment = null;
  assert.equal(tx._updatePeer('My_Rogue', payload, at).profile.equipmentKnown, false);
});
