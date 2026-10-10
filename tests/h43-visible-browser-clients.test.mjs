import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/visible-clients.js', import.meta.url), 'utf8');
const lifecycleSource = fs.readFileSync(new URL('../src/lifecycle-recovery.js', import.meta.url), 'utf8');
const names = ['My_Merchant','My_Ranger1','My_Ranger2','My_Rogue'];
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));

function fixture(name='My_Merchant', opts={}) {
  const kv = opts.kv || new Map();
  const page = opts.pageName || name;
  const top = { location:{hostname:'adventure.land',pathname:'/character/'+page+'/in/EU/II/'},
    document:{querySelector:()=>opts.canvas===false?null:{}},
    character: opts.connected===false ? null : {name:page} };
  const root = opts.child ? {parent:top} : top;
  const storage = {sharedAvailable:()=>opts.ssd!==false,
    getShared:k=>kv.get(k)||null,setShared:(k,v)=>{kv.set(k,v);return true}};
  const roster = {refresh:()=>({accountStateAvailable:true,onlineStateAvailable:true,activeStateAvailable:true,
    accountCharacters:names.map(name=>({name})),
    onlineCharacterNames:opts.online||names,runnerActiveCharacterNames:opts.active||names})};
  const game = {snapshot:()=>({character:{name}})};
  const ctx = {console,Date,JSON,Map,Set,__ALBOT_INTERNALS__:{helpers:{clone,cleanText:(v,m=300)=>String(v??'').slice(0,m)}}};
  ctx.globalThis=ctx; vm.runInNewContext(source,ctx);
  const runtime={running:true};
  const mode=new ctx.__ALBOT_INTERNALS__.VisibleClientMode({root,game,roster,storage,runtime});
  return {ctx,mode,storage,kv,root,game,roster,runtime};
}

test('visible gameplay evidence excludes connecting pages and child code runners',()=>{
  assert.equal(fixture().mode.localEvidence().kind,'VISIBLE_BROWSER');
  assert.equal(fixture('My_Merchant',{connected:false}).mode.localEvidence().visible,false);
  assert.equal(fixture('My_Merchant',{canvas:false}).mode.localEvidence().visible,false);
  assert.equal(fixture('My_Ranger1',{pageName:'My_Merchant',child:true}).mode.localEvidence().kind,'CHILD_CODE_RUNNER');
});
test('only real visible Merchant with SSD and owned quartet can arm mode',()=>{
  const f=fixture();
  assert.equal(f.mode.enable().accepted,true);
  assert.equal(JSON.parse([...f.kv.values()][0]).enabled,true);
  assert.equal(fixture('My_Ranger1').mode.enable().accepted,false);
  assert.equal(fixture('My_Merchant',{ssd:false}).mode.enable().accepted,false);
});
test('enabled mode fails closed if SSD state disappears',()=>{
  const f=fixture();f.mode.enable();f.kv.clear();assert.equal(f.mode.enabled(),true);
});
test('runner-active is not considered a visible browser',()=>{
  const f=fixture();f.mode.enable();
  f.mode.transport={freshPeer:n=>n==='My_Ranger1'?{visibleClient:false,clientKind:'CHILD_CODE_RUNNER',running:true}:null};
  const s=f.mode.status();
  assert.equal(s.visibleAndRunningCount,1);assert.equal(s.complete,false);
  assert.equal(s.clients[1].runnerActive,true);assert.equal(s.clients[1].visible,false);
});
test('H19 never starts child, disconnects visible peer or rotates in visible mode',()=>{
  const f=fixture('My_Merchant',{online:['My_Merchant'],active:['My_Merchant']});
  f.mode.enable();
  vm.runInNewContext(lifecycleSource,f.ctx);
  const dispatched=[];
  const lifecycle=new f.ctx.__ALBOT_INTERNALS__.CharacterLifecycleController({
    root:f.root,game:f.game,roster:f.roster,storage:f.storage,visibleClients:f.mode,
    actions:{available:()=>true,dispatch:(n,args)=>{dispatched.push(n);return {state:'DISPATCHED'}}},
    party:{snapshot:()=>({partyId:null,memberNames:[]})}
  });
  lifecycle.moduleActive=true;lifecycle.autonomyEnabled=true;
  lifecycle.policyState.desiredActiveNames=names;
  lifecycle.policyState.desiredPartyMemberNames=names;
  lifecycle.policyState.desiredPartyLeader='My_Merchant';
  const plan=lifecycle.plan();
  assert.equal(plan.state,'WAITING');
  assert.equal(plan.reason,'H43_VISIBLE_GAME_CLIENT_REQUIRED');
  assert.equal(dispatched.length,0);
  assert.equal(lifecycle._validateRemoteTarget('My_Ranger1','START',{requireCharacterStateChange:true}).ok,false);
  assert.equal(lifecycle._validateRemoteTarget('My_Ranger1','BROWSER_SWAP',{desiredName:'My_Rogue'}).ok,false);
  assert.equal(lifecycle._validateRemoteTarget('My_Ranger1','STOP',{requireCharacterStateChange:true}).ok,false);
});
