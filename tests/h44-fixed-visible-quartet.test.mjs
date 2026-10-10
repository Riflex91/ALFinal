import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const cleanText = (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max);
const sandbox = { __ALBOT_INTERNALS__: { helpers: { clone, cleanText } } };
vm.runInNewContext(fs.readFileSync(new URL('../src/full-autonomy.js', import.meta.url), 'utf8'), sandbox);
const Autonomy = sandbox.__ALBOT_INTERNALS__.FullAutonomyController;
const names = ['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue'].sort();
const wrong = ['My_Merchant', 'My_Priest', 'My_Ranger1', 'My_Rogue'].sort();
const profiles = names.map(name => ({name, ctype:name==='My_Merchant'?'merchant':name==='My_Rogue'?'rogue':'ranger',online:true,running:true,peerFresh:true}));
let recorded;

function make(local='My_Merchant', options={}) {
  let merchantPeer = options.merchantDesired === undefined ? null
    : { name: 'My_Merchant', running:true, fullAutonomyEnabled:true,
        fullAutonomyDesiredSource:'merchant-authority', fullAutonomyDesiredChangedAtMs: Date.now(),
        fullAutonomyDesiredCharacterNames: options.merchantDesired, fullAutonomyLeaderName:'My_Ranger1' };
  const online = options.online || names;
  const created = [];
  const strategy = {
    optimizeTask: args => {
      created.push({kind:'strategy',args:clone(args)});
      return { status:'SELECTION_READY', taskType:'FARM',
        selected:{memberNames:['My_Priest','My_Ranger1','My_Rogue']},
        supportMemberNames:['My_Merchant'],leaderName:'My_Ranger1',
        progression:{selectedCharacterName:'My_Priest'} };
    },
    recordTraining:()=>{}
  };
  const runtime = {
    running:true, actionAllowed:()=>true,
    visibleClients: { fixedQuartet:()=>options.fixed===false?null:names },
    roster: { refresh:()=>({accountStateAvailable:options.accountUnknown!==true,
      accountCharacters:profiles.map(row=>({name:row.name,ctype:row.ctype}))}) },
    farmIntelligence: {status:()=>({active:false})},
    lifecycle: { status:()=>({suspended:false,currentAction:null,queueLength:0,metrics:{actionsUnknown:0}}),
      characterRotationReadiness:()=>{created.push({kind:'rotationProbe'});return {ready:false,reason:'MUST_NOT_ROTATE'}} },
    lifecycleTransport: { freshPeer:name=>name==='My_Merchant'?merchantPeer:null,
      broadcastHeartbeat:()=>{} }
  };
  const c=new Autonomy({runtime,strategy});
  c.moduleActive=true;c.enabled=true;
  c._local=()=>({name:local,ctype:local==='My_Merchant'?'merchant':'ranger'});
  c._profileReadiness=()=>{
    const desired=c.desiredCharacterNames;
    return {online,profiles:profiles.map(p=>({...p,online:online.includes(p.name)})),
      missing:desired.filter(name=>!online.includes(name)),unexpectedOnlineNames:online.filter(name=>!desired.includes(name)),
      onlineLimitExceeded:false, stoppedNames:[],missingPeerNames:[],inactiveAutonomyNames:[] };
  };
  c._ensureLifecycle=plan=>{created.push({kind:'partyCoordinator',desired:c.desiredCharacterNames.slice(),plan:clone(plan)});
    return {ok:true,coordinator:local==='My_Merchant',partyTopologyHealthy:false,
      coordinatorName:'My_Merchant',partyNames:c.desiredCharacterNames.slice(),leader:'My_Merchant',
      rosterRecoveryRequired:c.desiredCharacterNames.some(n=>!online.includes(n)),
      rotationRequired:false};};
  c._pauseOwnedRoleWork=()=>{};
  return {c,created,setMerchantPeer:desired=>{merchantPeer={...merchantPeer,
    name:'My_Merchant',running:true,fullAutonomyEnabled:true,
    fullAutonomyDesiredSource:'merchant-authority',fullAutonomyDesiredChangedAtMs:Date.now(),
    fullAutonomyDesiredCharacterNames:desired,fullAutonomyLeaderName:'My_Ranger1'};}};
}
const normalized = arr => [...arr].sort();

test('H44 Merchant pins exactly both Rangers and Rogue despite optimizer preferring Priest',()=>{
  const {c,created}=make();
  const result=c.tick();
  assert.equal(result.reason,'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
  assert.deepEqual(normalized(c.desiredCharacterNames),names);
  assert.deepEqual(normalized(c.lastPlan.selected.memberNames),['My_Ranger1','My_Ranger2','My_Rogue']);
  assert.equal(c.lastPlan.selectionPolicy,'H44_FIXED_VISIBLE_QUARTET');
  assert.equal(c.lastPlan.progression.selectedCharacterName,null);
  assert.equal(c.desiredSource,'merchant-authority');
  assert.deepEqual(created.find(e=>e.kind==='strategy').args.allowedCharacterNames,names);
  assert.deepEqual(created.find(e=>e.kind==='partyCoordinator').desired,names);
  assert.equal(created.some(e=>e.kind==='rotationProbe'),false);
});

test('H44 follower never accepts old Merchant authority with Priest, then converges on pinned quartet',()=>{
  const f=make('My_Ranger2',{merchantDesired:wrong});
  const waiting=f.c.tick();
  assert.equal(waiting.reason,'H44_WAITING_MERCHANT_FIXED_QUARTET');
  assert.equal(f.created.some(e=>e.kind==='partyCoordinator'),false);
  f.setMerchantPeer(names);
  const joined=f.c.tick();
  assert.equal(joined.reason,'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
  assert.deepEqual(normalized(f.c.desiredCharacterNames),names);
  assert.equal(f.c.desiredSource,'merchant-peer');
  assert.deepEqual(f.created.find(e=>e.kind==='partyCoordinator').desired,names);
});

test('H44 fixed quartet waits for offline browser instead of initiating unsafe rotation',()=>{
  const f=make('My_Merchant',{online:['My_Merchant','My_Ranger1']});
  const result=f.c.tick();
  assert.equal(result.state,'WARMING');
  assert.deepEqual(normalized(f.c.desiredCharacterNames),names);
  assert.equal(f.created.some(e=>e.kind==='rotationProbe'),false);
  assert.equal(f.created.some(e=>e.kind==='partyCoordinator'),true);
});

test('H44 refuses pinned character slots when account ownership evidence is unavailable',()=>{
  const f=make('My_Merchant',{accountUnknown:true});
  const result=f.c.tick();
  assert.equal(result.reason,'H44_VISIBLE_QUARTET_ACCOUNT_UNVERIFIED');
  assert.equal(f.created.some(e=>e.kind==='partyCoordinator'),false);
});

test('H44 unarmed mode preserves H41 healthy-roster fallback and does not force H44 selection',()=>{
  const f=make('My_Merchant',{fixed:false});
  f.c.tick();
  // H41 already prefers the healthy online quartet over a proposed Priest
  // if all four online profiles can be proven valid.
  assert.deepEqual(normalized(f.c.desiredCharacterNames),names);
  assert.equal(f.created.find(e=>e.kind==='strategy').args.allowedCharacterNames,undefined);
  assert.equal(f.c.lastPlan.selectionPolicy,undefined);
});
