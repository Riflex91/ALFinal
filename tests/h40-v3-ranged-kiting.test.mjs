import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/combat.js', import.meta.url), 'utf8');
const ctx = {
  __ALBOT_INTERNALS__: { helpers: {
    clone: v => v == null ? v : JSON.parse(JSON.stringify(v)),
    cleanText: (v,max=200) => String(v == null ? '' : v).slice(0,max)
  } }
};
vm.runInNewContext(source, ctx, { filename: 'src/combat.js' });
const Controller = ctx.__ALBOT_INTERNALS__.CombatController;
const makeCharacter = options => ({
  name:'My_Ranger1', ctype:'ranger', map:'main', x:0, y:0,
  hp:900, maxHp:1000, mp:300, maxMp:400, range:150, speed:65, ...options
});
const makeMonster = options => ({
  id:'crab-a', mtype:'crab', name:'Crab', type:'monster', map:'main',
  x:42, y:0, targetId:'My_Ranger1', range:20, distance:42,
  visible:true, dead:false, ...options
});
function fixture(character=makeCharacter(), threats=[makeMonster()]) {
  const moves = [];
  const c = Object.create(Controller.prototype);
  c.now = ()=>100000;
  c.moduleActive = true;
  c.session = {
    enabled:true, id:'h40-test', owner:'test', state:'FARMING',
    policy:{kiting:true,partyAssist:false,leaderOwnedPulls:false,groupMemberNames:[],minMpRatio:0.05,retreatHpRatio:0.35},
    counters:{ticks:0,kites:0,attacksDispatched:0}
  };
  c.metrics = {
    kites:0,kiteOrbitMoves:0,kiteNoAggroHolds:0,meleeKiteBypasses:0,
    kiteTerrainBlocks:0,kiteGroupTetherBlocks:0,kiteGroupSoftTetherBlocks:0,
    kiteSpiralEscapes:0,kiteEmergencyEscapes:0,kiteAnchorCorrections:0,kiteAggroThreatOverrides:0,
    attackUnknown:0
  };
  c.config = {
    kiteMonsterBuffer:20,kiteSpeedBufferSeconds:0.5,
    kiteMaxRangeRatio:0.82,kiteDesiredRangeRatio:0.72,kiteStepSeconds:0.65,
    groupKiteFormationRadius:100,groupHardKiteTether:195
  };
  c.orbitDirectionByCharacter = new Map();
  const game = {available:true,character};
  c.game = {
    snapshot:()=>game, visibleMonsters:()=>threats,
    monsterDefinition:()=>({range:20,speed:40})
  };
  c.movement = {
    _canMoveTo:()=>true,
    status:()=>({activeOrder:null}),
    moveLocal:(x,y,o)=>{moves.push({x,y,...o});return {accepted:true}}
  };
  c._groupTetherAllows=()=>true;
  c._farmKiteAnchor=()=>null;
  return {c,moves,game,character};
}

test('V3: distant farm target does not override a closer real attacker on the ranged player',()=>{
  const close=makeMonster({id:'close',x:42,distance:42});
  const focus=makeMonster({id:'focus',x:65,distance:65,targetId:'My_Ranger2'});
  const {c,game,moves}=fixture(makeCharacter(),[close,focus]);
  assert.equal(c._kite(game,focus),true);
  assert.equal(moves.length,1);
  assert.equal(c.session.lastDecision.targetId,'close');
  assert.equal(c.metrics.kiteAggroThreatOverrides,1);
});

test('V3: ranged unit does not kite without aggro; melee Rogue keeps its original behavior',()=>{
  const f=fixture(makeCharacter(),[makeMonster({targetId:'My_Merchant'})]);
  assert.equal(f.c._kite(f.game,null),false);
  assert.equal(f.moves.length,0);
  const m=fixture(makeCharacter({ctype:'rogue'}),[makeMonster()]);
  assert.equal(m.c._kite(m.game,null),false);
  assert.equal(m.c.metrics.meleeKiteBypasses,1);
});

test('V3: spiral terrain escape is chosen when direct radial candidates are blocked',()=>{
  const {c,game,moves}=fixture(makeCharacter({range:150,speed:65}),[makeMonster({x:25,distance:25})]);
  c.movement._canMoveTo=(x,y)=>x < -10 && Math.abs(y) > 10;
  assert.equal(c._kite(game,null),true);
  assert.equal(moves.length,1);
  assert.ok(c.session.lastDecision.spiral || c.session.lastDecision.emergency);
  assert.ok(Math.hypot(moves[0].x-25,moves[0].y)>25);
});

test('V3: safely escaping an outranging monster outranks preserving attack range',()=>{
  const {c,game,moves}=fixture(makeCharacter({range:70,speed:65}),[makeMonster({x:25,distance:25,range:65})]);
  assert.equal(c._kite(game,null),true);
  assert.equal(c.session.lastDecision.emergency,true);
  assert.equal(c.metrics.kiteEmergencyEscapes,1);
  assert.ok(moves[0].x<0);
});

test('V3: farm anchor allows contained orbit but rejects drift and rewards return toward anchor',()=>{
  const {c,character}=fixture();
  const anchor={x:0,y:0,radius:120};
  assert.equal(c._anchorAllowsKite(character,{x:100,y:40},anchor),true);
  assert.equal(c._anchorAllowsKite(character,{x:121,y:20},anchor),false);
  const far=makeCharacter({x:180,y:0});
  assert.equal(c._anchorAllowsKite(far,{x:165,y:0},anchor),true);
  assert.equal(c._anchorAllowsKite(far,{x:190,y:0},anchor),false);
});

test('V3: normal skills and AOE never delay a possible urgent kite move',()=>{
  const {c,game}=fixture();
  const target=makeMonster({x:42,distance:42});
  const calls=[];
  c.game.combatReadiness=()=>({targetAvailable:true,inRange:true,cooldown:true,canAttack:false});
  c._observePendingAttack=()=>false;
  c._freshTarget=()=>target;
  c._targetConfirmed=()=>true;
  c._kite=()=>{calls.push('kite');return true};
  c.classSkills={maybeUse:()=>{calls.push('skill');return {handled:true}}};
  c.farming={maybeUse:()=>{calls.push('aoe');return {handled:true}}};
  c._tick();
  assert.deepEqual(calls,['kite']);
});

test('V3: kiting remains active during a pending attack without skipping reconciliation',()=>{
  const {c}=fixture();
  const calls=[];
  c.pendingAttack={attackId:'old',targetId:'crab-a'};
  c._kite=()=>{calls.push('kite');return true};
  c._observePendingAttack=()=>{calls.push('observe');return true};
  c._tick();
  assert.deepEqual(calls,['kite','observe']);
});

test('H19/H5: low-HP retreat remains higher priority than any kiting',()=>{
  const {c}=fixture(makeCharacter({hp:200,maxHp:1000}));
  const calls=[];
  c._retreat=()=>calls.push('retreat');
  c._kite=()=>calls.push('kite');
  c._tick();
  assert.deepEqual(calls,['retreat']);
});
