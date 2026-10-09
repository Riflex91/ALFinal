import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir=path.dirname(fileURLToPath(import.meta.url));
const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
const env=()=>{
 const r={console,Date,Math,JSON,Map,Set,Promise,Object,String,Number,Array,Boolean,Error,
   __ALBOT_INTERNALS__:{Scheduler:class {},helpers:{clone,cleanText:(v,max=120)=>String(v==null?'':v).trim().slice(0,max)}}};
 r.globalThis=r;return r;
};
function load(root,name){vm.runInNewContext(fs.readFileSync(path.resolve(dir,'../src/'+name),'utf8'),root,{filename:name});}

test('H41 validated H25 swap re-arms only the exact new owned character on the exact server and consumes intent once',()=>{
 const root=env();load(root,'runtime.js');
 const C=root.__ALBOT_INTERNALS__.ALBotRuntime;
 const runtime=Object.create(C.prototype);
 const values=new Map(),names=['My_Merchant','My_Ranger2','My_Ranger3','My_Rogue'];
 const server={region:'EU',identifier:'II'};
 const character={name:'My_Ranger3',ctype:'ranger'};
 const key=runtime._h25AutonomyHandoffKey(character.name,server);
 runtime.running=true;runtime.stopLatch={status:()=>({latched:false})};
 runtime.game={snapshot:()=>({available:true,character,server})};
 runtime.roster={refresh:()=>({accountCharacters:names.map(name=>({name}))})};
 let starts=0,got=null;
 runtime.fullAutonomy={enabled:false,startAutonomy:o=>{starts++;got=o;return {accepted:true}}};
 runtime.storage={
  getShared:k=>values.get(k)||null,
  removeShared:k=>{values.delete(k);return true;}
 };
 const now=Date.now();
 values.set(key,JSON.stringify({schemaVersion:1,source:'H25_VALIDATED_BROWSER_SWAP',
  sourceCharacterName:'My_Ranger1',targetCharacterName:'My_Ranger3',
  serverRegion:'EU',serverIdentifier:'II',taskType:'FARM',desiredCharacterNames:names,
  createdAtMs:now,expiresAtMs:now+60000}));
 assert.equal(runtime._consumeH25AutonomyHandoff().accepted,true);
 assert.equal(starts,1);assert.equal(got.taskType,'FARM');
 assert.equal(runtime._consumeH25AutonomyHandoff().accepted,false);
 assert.equal(starts,1);
 values.set(key,JSON.stringify({schemaVersion:1,source:'H25_VALIDATED_BROWSER_SWAP',
  sourceCharacterName:'My_Ranger1',targetCharacterName:'My_Ranger3',
  serverRegion:'US',serverIdentifier:'II',taskType:'FARM',desiredCharacterNames:names,
  createdAtMs:now,expiresAtMs:now+60000}));
 assert.equal(runtime._consumeH25AutonomyHandoff().accepted,false);
 assert.equal(starts,1);assert.equal(values.has(key),false);
});

test('H41 stale swap, rogue target mismatch and emergency STOP never grant autonomous work',()=>{
 const root=env();load(root,'runtime.js');
 const C=root.__ALBOT_INTERNALS__.ALBotRuntime;
 const runtime=Object.create(C.prototype);
 const names=['My_Merchant','My_Ranger2','My_Ranger3','My_Rogue'];
 const server={region:'EU',identifier:'II'};
 const key=runtime._h25AutonomyHandoffKey('My_Ranger3',server);
 let starts=0,latched=false;
 const map=new Map([[key,JSON.stringify({schemaVersion:1,source:'H25_VALIDATED_BROWSER_SWAP',
   sourceCharacterName:'My_Ranger1',targetCharacterName:'My_Ranger3',serverRegion:'EU',
   serverIdentifier:'II',taskType:'FARM',desiredCharacterNames:names,
   createdAtMs:Date.now()-130000,expiresAtMs:Date.now()-10000})]]);
 runtime.running=true;runtime.stopLatch={status:()=>({latched})};
 runtime.game={snapshot:()=>({character:{name:'My_Ranger3'},server})};
 runtime.roster={refresh:()=>({accountCharacters:names.map(name=>({name}))})};
 runtime.storage={getShared:k=>map.get(k)||null,removeShared:k=>{map.delete(k);return true}};
 runtime.fullAutonomy={enabled:false,startAutonomy:()=>{starts++;return {accepted:true}}};
 assert.equal(runtime._consumeH25AutonomyHandoff().accepted,false);
 assert.equal(starts,0);
 latched=true;map.set(key,JSON.stringify({schemaVersion:1,source:'H25_VALIDATED_BROWSER_SWAP',
   sourceCharacterName:'My_Ranger1',targetCharacterName:'My_Ranger3',serverRegion:'EU',
   serverIdentifier:'II',taskType:'FARM',desiredCharacterNames:names,
   createdAtMs:Date.now(),expiresAtMs:Date.now()+60000}));
 assert.equal(runtime._consumeH25AutonomyHandoff().accepted,false);assert.equal(starts,0);
});

test('H41 local undergeared rogue queues only safe inventory improvements into empty slots',()=>{
 const root=env();load(root,'gear.js');
 const C=root.__ALBOT_INTERNALS__.GearController;
 const defs={
  hpamulet:{name:'hpamulet',type:'amulet',classes:[],stats:{hp:100},upgradeGrowth:{}},
  hpbelt:{name:'hpbelt',type:'belt',classes:[],stats:{hp:150},upgradeGrowth:{}}
 };
 const inventory={available:true,freeSlots:38,items:[
  {name:'hpamulet',slot:4,quantity:1,level:0,locked:false,gift:false,giveaway:false},
  {name:'hpbelt',slot:5,quantity:1,level:0,locked:false,gift:false,giveaway:false}]};
 const slots={};
 let combat=false,allow=true;
 const game={
  snapshot:()=>({available:true,character:{name:'My_Rogue',ctype:'rogue',map:'cave'}}),
  inventorySnapshot:()=>inventory,
  equipmentSnapshot:()=>({available:true,slots}),
  equipmentDefinition:name=>defs[name]||null,
  classEquipmentProfile:()=>({mainhand:['dagger'],offhand:['dagger'],doublehand:[]})
 };
 const controller=new C({root,game,combat:{status:()=>({active:combat})},
   roster:{refresh:()=>({farmers:[{name:'My_Rogue',ctype:'rogue'}]})},
   autoEquipAllowed:()=>allow,autoEquipProbeMs:3000});
 controller.moduleActive=true;
 assert.equal(controller.tick().state,'QUEUED');
 assert.equal(controller.request.kind,'EQUIP');
 assert.ok(['amulet','belt'].includes(controller.request.targetSlot));
 assert.equal(controller.metrics.autoEquipQueued,1);
 controller.request=null;combat=true;controller.autoEquipLastAtMs=0;
 assert.equal(controller.tick().state,'READY');
 assert.equal(controller.request,null);
 combat=false;allow=false;controller.autoEquipLastAtMs=0;
 assert.equal(controller.tick().state,'READY');
 assert.equal(controller.request,null);
});

test('H41 merchant sees gear of fresh remote Rogue for planning but not from an absent/stale peer',()=>{
 const root=env();load(root,'gear.js');
 const C=root.__ALBOT_INTERNALS__.GearController;
 let fresh=true;
 const peer={name:'My_Rogue',running:true,profile:{
  name:'My_Rogue',ctype:'rogue',equipmentKnown:true,observedAtMs:Date.now(),
  equipment:{mainhand:{name:'claw',level:0}}}};
 const gear=new C({root,game:{
   equipmentSnapshot:()=>({available:false,reason:'NOT_VISIBLE'}),
   equipmentDefinition:name=>name==='claw'?{name:'claw',type:'weapon',wtype:'fist',classes:[],stats:{attack:5},upgradeGrowth:{}}:null
 },crossWindow:{freshPeer:()=>fresh?peer:null}});
 const visible=gear._equipmentSnapshot('My_Rogue');
 assert.equal(visible.available,true);
 assert.equal(visible.source,'FRESH_PEER_ADVISORY');
 assert.equal(visible.slots.mainhand.name,'claw');
 fresh=false;
 assert.equal(gear._equipmentSnapshot('My_Rogue').available,false);
 fresh=true;peer.profile.observedAtMs=Date.now()-60000;
 assert.equal(gear._equipmentSnapshot('My_Rogue').available,false);
});

test('H41 future gear evaluator preserves H32 unknown-gear guard for empty snapshots',()=>{
 const root=env();load(root,'gear-progression.js');
 const C=root.__ALBOT_INTERNALS__.FutureGearEconomyEvaluator;
 const g=new C({root});
 assert.equal(g._profileEquipment({equipment:{},equipmentKnown:true}),null);
 assert.equal(g._profileEquipment({equipment:{},equipmentKnown:false}),null);
 assert.equal(g._profileEquipment({equipment:null,equipmentKnown:true}),null);
});
