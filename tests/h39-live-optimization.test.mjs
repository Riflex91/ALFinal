import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir=path.dirname(fileURLToPath(import.meta.url));
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
function load(file) {
  const root={console,Date,Math,JSON,Map,Set,Promise,Object,String,Number,Array,Boolean,Error,
    server_region:'EU',server_identifier:'II',
    __ALBOT_INTERNALS__:{helpers:{clone,cleanText:(v,max=1000)=>String(v==null?'':v).trim().slice(0,max)}}};
  root.globalThis=root;
  vm.runInNewContext(fs.readFileSync(path.resolve(dir,'../src/'+file),'utf8'),root,{filename:file});
  return root;
}

test('H39 peer aggregate group-only WARN cannot recursively degrade all healthy windows',()=>{
  const root=load('autonomous-observer.js');
  const Obs=root.__ALBOT_INTERNALS__.AutonomousObservationCoordinator;
  const ctrl=new Obs({runtime:{}});
  const desired=['Merchant','Ranger','Rogue','Priest'];
  const group={enabled:true,desiredCharacterNames:desired};
  const roster={onlineCharacterNames:desired};
  const peers=desired.slice(1).map(name=>({name,fresh:true,ageMs:100,
    observation:{state:'DEGRADED',subsystems:{
      runtime:{state:'HEALTHY'},farmer:{state:'HEALTHY'},merchant:{state:'HEALTHY'},
      group:{state:'DEGRADED'}}}}));
  const reasons=[];
  ctrl._groupHealth(group,{peers},roster,'Merchant',(code,level,slot)=>reasons.push({code,level,slot}));
  assert.deepEqual(reasons,[]);
  peers[0].observation.subsystems.farmer.state='DEGRADED';
  ctrl._groupHealth(group,{peers},roster,'Merchant',(code,level)=>reasons.push({code,level}));
  assert.equal(reasons.length,1);
  assert.equal(reasons[0].code,'GROUP_PEER_DEGRADED:Ranger');
  peers[0].observation.subsystems.farmer.state='CRITICAL';
  reasons.length=0;
  ctrl._groupHealth(group,{peers},roster,'Merchant',(code,level)=>reasons.push({code,level}));
  assert.equal(reasons.length,1);
  assert.equal(reasons[0].level,2);
});

test('H39 moderate brief group separation does not repeatedly stop an owned H8 session',()=>{
  const root=load('farm-intelligence.js');
  const Farm=root.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const farmer=Object.create(Farm.prototype);
  let now=1000,stops=0,moves=0;
  farmer.now=()=>now;
  farmer.config={groupRegroupTriggerDistance:150,groupRegroupStopDistance:70,
    groupHardRegroupDistance:195,groupModerateRegroupGraceMs:2500,
    groupFollowStep:70};
  farmer.metrics={groupFollowerHolds:0,groupRegroups:0,groupLocalFollows:0,groupHardRegroups:0};
  farmer._movementStatus=()=>({active:false,activeOrder:null,lastOrder:null});
  farmer._farmingStatus=()=>({active:true,session:{owner:'farm-intelligence-h9'}});
  farmer._ownedFarming=()=>true;farmer._ownedMovement=()=>false;
  farmer._groupEncounterActive=()=>false;farmer._stopOwnedFarming=()=>{stops++;};
  farmer._formationPoint=()=>({map:'main',x:165,y:0});
  farmer.movement={_canMoveTo:()=>true,moveLocal:()=>{moves++;return {accepted:true,order:{id:'m'}}}};
  farmer.groupMoveRetryAfterMs=null;
  const group={local:{name:'Rogue',map:'main',x:0,y:0},leader:{name:'Ranger',map:'main',x:165,y:0},
    leaderName:'Ranger',localName:'Rogue',isLeader:false,complete:true,sameMap:true,
    distance:165,maxPairDistance:165,members:[]};
  assert.equal(farmer._tickGroupFollower(group.local,group).reason,'H9_MODERATE_REGROUP_GRACE');
  now=3000;
  assert.equal(farmer._tickGroupFollower(group.local,group).reason,'H9_MODERATE_REGROUP_GRACE');
  assert.equal(stops,0);assert.equal(moves,0);
  now=3700;
  const after=farmer._tickGroupFollower(group.local,group);
  assert.equal(after.state,'TRAVELLING');
  assert.equal(stops,1);assert.equal(moves,1);
});

test('H39 hard group separation bypasses moderate grace without weakening cohesion safety',()=>{
  const root=load('farm-intelligence.js');
  const Farm=root.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const farmer=Object.create(Farm.prototype);
  farmer.now=()=>1000;
  farmer.config={groupRegroupTriggerDistance:150,groupRegroupStopDistance:70,
    groupHardRegroupDistance:195,groupModerateRegroupGraceMs:2500,groupFollowStep:70};
  farmer.metrics={groupFollowerHolds:0,groupRegroups:0,groupLocalFollows:0,groupHardRegroups:0};
  farmer._movementStatus=()=>({active:false,activeOrder:null,lastOrder:null});
  farmer._farmingStatus=()=>({active:true,session:{owner:'farm-intelligence-h9'}});
  farmer._ownedFarming=()=>true;farmer._ownedMovement=()=>false;
  farmer._groupEncounterActive=()=>false;
  let stops=0,smart=0;farmer._stopOwnedFarming=()=>{stops++;};
  farmer._formationPoint=()=>({map:'main',x:210,y:0});
  farmer.movement={_canMoveTo:()=>true,smartMove:()=>{smart++;return {accepted:true,order:{id:'s'}}}};
  const group={local:{map:'main',x:0,y:0},leader:{name:'Ranger',map:'main',x:210,y:0},
    leaderName:'Ranger',isLeader:false,complete:true,sameMap:true,
    distance:210,maxPairDistance:210,members:[]};
  const result=farmer._tickGroupFollower(group.local,group);
  assert.notEqual(result.reason,'H9_MODERATE_REGROUP_GRACE');
  assert.equal(stops,1);assert.equal(smart,1);
});

test('H39 verified item demand outranks ordinary score only among previously admitted candidates',()=>{
  const root=load('farm-intelligence.js');
  const Farm=root.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const farmer=Object.create(Farm.prototype);
  farmer._materialDemand=()=>({monsterType:'spider',material:'spidersilk'});
  farmer._rawMetrics=(_c,row)=>({
    xpPerSecond: row.mtype==='bat'?100:1,goldPerSecond:row.mtype==='bat'?100:1,
    dropSignal:1,density:1,travelSeconds:0,respawnSignal:1,
    competitionSignal:1,safetyConfidence:1
  });
  const ranked=farmer._scoreCandidates({},[
    {mtype:'bat',key:'a',visibleSafeCount:1},
    {mtype:'spider',key:'b',visibleSafeCount:1}
  ]);
  assert.equal(ranked[0].mtype,'spider');
  assert.equal(ranked[0].materialDemandMatch,true);
  farmer._materialDemand=()=>null;
  const normal=farmer._scoreCandidates({},[
    {mtype:'bat',key:'a',visibleSafeCount:1},{mtype:'spider',key:'b',visibleSafeCount:1}
  ]);
  assert.equal(normal[0].mtype,'bat');
});
