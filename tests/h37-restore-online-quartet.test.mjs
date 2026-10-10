import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../src/full-autonomy.js', import.meta.url), 'utf8');
const sandbox = {
  __ALBOT_INTERNALS__: {
    helpers: {
      clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
      cleanText: (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max)
    }
  }
};
vm.runInNewContext(code, sandbox, { filename: 'src/full-autonomy.js' });
const Controller = sandbox.__ALBOT_INTERNALS__.FullAutonomyController;

const online = ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'].sort();
const preferred = ['My_Mage', 'My_Merchant', 'My_Ranger2', 'My_Ranger3'].sort();
const profiles = [
  { name: 'My_Merchant', ctype: 'merchant', online: true },
  { name: 'My_Ranger1', ctype: 'ranger', online: true },
  { name: 'My_Ranger2', ctype: 'ranger', online: true },
  { name: 'My_Rogue', ctype: 'rogue', online: true }
];
function make(name, lifecycleOverrides = {}) {
  const lifecycle = {
    characterRotationReadiness: () => ({ ready: false, reason: 'H27_ROTATION_LOCAL_REPLACEMENT_REQUIRES_MERCHANT_COORDINATOR' }),
    status: () => ({
      suspended: false, currentAction: null, queueLength: 0,
      metrics: { actionsUnknown: 0 }, ...lifecycleOverrides
    })
  };
  const runtime = {
    running: true,
    actionAllowed: () => true,
    lifecycle,
    farmIntelligence: { status: () => ({ active: false }) },
    lifecycleTransport: { broadcastHeartbeat: () => {} }
  };
  const strategy = {
    optimizeTask: () => ({
      status: 'SELECTION_READY', taskType: 'FARM',
      selected: { memberNames: ['My_Mage', 'My_Ranger2', 'My_Ranger3'] },
      supportMemberNames: ['My_Merchant'], leaderName: 'My_Mage'
    }),
    recordTraining: () => {}
  };
  const c = new Controller({ runtime, strategy });
  c.moduleActive = true;
  c.enabled = true;
  c._local = () => ({ name });
  c._profileReadiness = () => ({
    online, profiles, missing: [], unexpectedOnlineNames: [],
    onlineLimitExceeded: false, stoppedNames: [], missingPeerNames: [], inactiveAutonomyNames: []
  });
  c._ensureLifecycle = () => ({
    ok: true, partyTopologyHealthy: false,
    partyNames: c.desiredCharacterNames, leader: 'My_Merchant', coordinatorName: 'My_Merchant'
  });
  return c;
}

test('Merchant retains healthy online 3+1 team when rotation is unavailable', () => {
  const c = make('My_Merchant');
  const state = c.tick();
  assert.equal(state.reason, 'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
  assert.deepEqual([...c.desiredCharacterNames], online);
  assert.deepEqual([...c.lastPlan.selected.memberNames].sort(), ['My_Ranger1','My_Ranger2','My_Rogue']);
  assert.equal(c.desiredSource, 'merchant-authority');
});

test('No fallback if H19 has an in-flight action', () => {
  const c = make('My_Merchant', { currentAction: { kind: 'BROWSER_SWAP' } });
  const state = c.tick();
  assert.equal(state.reason, 'FULL_AUTONOMY_ROTATION_UNAVAILABLE');
  assert.deepEqual([...c.desiredCharacterNames], preferred);
});

test('Outgoing farmer waits for Merchant instead of blocking group', () => {
  const c = make('My_Ranger1');
  c._merchantSelectionPeer = () => ({
    desired: preferred, peer: { fullAutonomyLeaderName: 'My_Mage' }
  });
  c._profileReadiness = () => ({
    online, profiles, missing: [], unexpectedOnlineNames: ['My_Ranger1','My_Rogue'],
    onlineLimitExceeded: false, stoppedNames: [], missingPeerNames: [], inactiveAutonomyNames: []
  });
  const state = c.tick();
  assert.equal(state.state, 'WARMING');
  assert.equal(state.reason, 'FULL_AUTONOMY_WAITING_MERCHANT_ROTATION');
});
