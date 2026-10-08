import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
function load(file,root){vm.runInNewContext(fs.readFileSync(path.resolve(here,'../src/'+file),'utf8'),root,{filename:file});}
function makeRoot(extra={}){const ctx={console,Date,Math,JSON,Map,Set,Promise,Object,String,Number,Array,Boolean,
  __ALBOT_INTERNALS__:{helpers:{clone,cleanText:(v,max=1000)=>String(v==null?'':v).trim().slice(0,max)}},...extra};ctx.globalThis=ctx;return ctx;}

test('H38 v1 opt-out preferences cannot silently re-enable old boss/event targets',()=>{
  const store=new Map();
  store.set('albot:encounter-preferences:v1', JSON.stringify({schemaVersion:1,disabled:{boss:[],event:[]},
    knownEvents:{slenderman:{id:'slenderman',active:true,map:'cave',x:0,y:0}}}));
  const root=makeRoot({G:{monsters:{slenderman:{boss:true}}},S:{slenderman:{active:true,map:'cave',x:0,y:0}}});
  load('encounters.js',root);
  const c=new root.__ALBOT_INTERNALS__.EncounterController({root,storage:{
    get:key=>store.get(key)||null,set:(key,val)=>{store.set(key,val);return true;} },
    game:{visibleMonsters:()=>[],monsterDefinition:()=>null}});
  assert.equal(c.catalog().defaultEnabled,false);
  assert.equal(c.catalog().bosses[0].enabled,false);
  assert.equal(c.catalog().events[0].enabled,false);
  assert.equal(c.preferredTask(),null);
  assert.equal(c.setAll('event',true).enabled,true);
  root.S.new_event={active:true,map:'main',x:1,y:1};
  const catalog=c.catalog();
  assert.equal(catalog.events.find(e=>e.id==='slenderman').enabled,true);
  assert.equal(catalog.events.find(e=>e.id==='new_event').enabled,false);
  c.setAll('event',false);
  assert.equal(c.preferredTask(),null);
});

test('H38 incomplete group DPS rejects even attractive material farming targets before movement',()=>{
  const root=makeRoot();
  load('farm-intelligence.js',root);
  const C=root.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const c=Object.create(C.prototype);
  c.session={groupMemberNames:['Priest','Warrior','Ranger'],preferredTypes:[],excludedTypes:[]};
  c._groupPlanningProfiles=()=>({enabled:true,complete:true,memberNames:['Priest','Warrior','Ranger'],profiles:[
    {name:'Priest',ctype:'priest',attack:300,frequency:1,maxHp:1200},
    {name:'Warrior',ctype:'warrior',attack:500,frequency:1,maxHp:3000},
    {name:'Ranger',ctype:'ranger',attack:null,frequency:1,maxHp:1500}
  ]});
  c._groupTankEnvelope=()=>({maxSingleAttack:300,incomingBudget:1800,tankMaxHp:3000});
  c._expectedHitChance=()=>1;c.config={minExpectedHitChance:0.25};
  c.metrics={groupSafetyBlocks:0,damageLimitedBlocks:0};
  const candidates=[{key:'g',mtype:'goo',definition:{hp:100,attack:1,frequency:1}}];
  assert.equal(c._filteredCandidates(candidates,{name:'Warrior',attack:500}).length,0);
  assert.equal(c.metrics.groupSafetyBlocks,1);
  assert.equal(candidates[0].groupSafety.reason,'H9_GROUP_DPS_INCOMPLETE');
  c._groupPlanningProfiles=()=>({enabled:true,complete:true,memberNames:['Priest','Warrior','Ranger'],profiles:[
    {name:'Priest',ctype:'priest',attack:300,frequency:1,maxHp:1200},
    {name:'Warrior',ctype:'warrior',attack:500,frequency:1,maxHp:3000},
    {name:'Ranger',ctype:'ranger',attack:450,frequency:1,maxHp:1500}
  ]});
  assert.equal(c._filteredCandidates([{mtype:'goo',definition:{hp:100,attack:1,frequency:1}}],{name:'Warrior'}).length,1);
  assert.equal(c._filteredCandidates([{mtype:'boss',definition:{hp:100,attack:1,boss:true}}],{name:'Warrior'}).length,0);
});

test('H38 merchant stand does not reopen without sale listings, and p.stand remains authoritative',()=>{
  const root=makeRoot({character:{name:'M',ctype:'merchant',stand:false,p:{}}});
  load('market-intelligence.js',root);
  const Stand=root.__ALBOT_INTERNALS__.MerchantStandController;
  const stand=new Stand({root,inventory:{plan:()=>({items:[]})},
    movement:{status:()=>({active:false})}});
  assert.equal(stand.plan().state,'IDLE');
  assert.equal(stand.plan().reason,'MERCHANT_STAND_NO_LISTING_NO_OPEN');
  root.character.p.stand=true;
  assert.equal(stand._standOpen(root.character),true);
});

test('H38 merchant handoff dispatches close once and confirms only against live stand state',()=>{
  const root=makeRoot();
  load('merchant-autonomy.js',root);
  const C=root.__ALBOT_INTERNALS__.MerchantAutonomyController;
  const c=Object.create(C.prototype);
  c.moduleActive=true;c.autoManage=true;c.suspendedReason=null;
  c.pending=null;c.metrics={unknown:0};c.config={actionTimeoutMs:15000};
  let open=true,dispatches=0;
  c._standOpen=()=>open;
  c._dispatch=(kind,name,args,opts)=>{
    dispatches++;c.pending={kind,deadlineAtMs:Date.now()+15000,...opts};
    return {state:'DISPATCHED',kind};
  };
  assert.equal(c.closeStandForWork().state,'DISPATCHED');
  assert.equal(c.closeStandForWork().state,'PENDING');
  assert.equal(dispatches,1);
  assert.equal(c._observePending().state,undefined);
  open=false;
  assert.equal(c._observePending().state,'CONFIRMED');
  assert.equal(c.pending,null);
});

test('H38 movement rejects open merchant stand before dispatching a move',()=>{
  const root=makeRoot({character:{name:'M',ctype:'merchant',stand:true,p:{stand:true}}});
  load('movement.js',root);
  const C=root.__ALBOT_INTERNALS__.MovementController;
  const c=Object.create(C.prototype);
  c.enabled=true;c.activeOrder=null;c.root=root;
  c._snapshot=()=>({available:true,character:{name:'M',ctype:'merchant',rip:false,map:'main',x:0,y:0}});
  const res=c._preflight('smart',{map:'main',x:200,y:200});
  assert.equal(res.ok,false);
  assert.equal(res.reason,'MOVEMENT_MERCHANT_STAND_OPEN');
});
