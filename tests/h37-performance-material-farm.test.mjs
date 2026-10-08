import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
function context() {
  const root = { console, Date, Math, JSON, Map, Set, Promise, String, Object, Number, Array, Boolean,
    server_region: 'EU', server_identifier: 'II',
    __ALBOT_INTERNALS__: { helpers: {
      clone, cleanText: (value, max = 1000) => String(value == null ? '' : value).trim().slice(0,max)
    } }
  };
  root.globalThis = root;
  return root;
}
function load(root, file) {
  vm.runInNewContext(fs.readFileSync(path.resolve(dir, '../src/' + file), 'utf8'), root, { filename: file });
}

test('H37 profile persistence coalesces repeated identical snapshots while preserving gold updates', () => {
  const root = context();
  load(root, 'account-strategy.js');
  const values = new Map();
  let writes = 0, mirrors = 0, now = 10000;
  const character = { name:'My_Merchant', ctype:'merchant', level:58, gold:100000,
    hp:2000, maxHp:2000, mp:2000, maxMp:2000, map:'main', rip:false };
  const storage = { get:key=>values.get(key)||null, getShared:key=>values.get(key)||null,
    setShared:(key,value)=>{ writes++; values.set(key,value); return true; } };
  const account = new root.__ALBOT_INTERNALS__.AccountStrategyController({
    root, storage, hostState:{persistProfile:()=>{ mirrors++; return true; }},
    game:{ snapshot:()=>({available:true,character:clone(character)}),
      equipmentSnapshot:()=>({available:true,slots:{}}) },
    roster:{refresh:()=>({accountCharacters:[{name:'My_Merchant',ctype:'merchant',level:58,online:true}],
      onlineCharacterNames:['My_Merchant']})},
    gear:{score:()=>0}, now:()=>now
  });
  account.start({});
  for(let i=0;i<50;i++)account.profiles();
  assert.equal(writes,1);
  assert.equal(mirrors,1);
  character.gold+=200;
  account.profiles();
  assert.equal(writes,2);
  now+=10001;
  account.profiles();
  assert.equal(writes,3);
});

test('H37 exchange travel skips movement only with a verified live arrival', () => {
  const root = context();
  load(root,'exchange-craft.js');
  const Controller=root.__ALBOT_INTERNALS__.ExchangeCraftController;
  const merchant={map:'main',x:200,y:75,moving:false};
  let moves=0;
  const controller=Object.create(Controller.prototype);
  controller.game={snapshot:()=>({available:true,character:clone(merchant)})};
  controller.movement={status:()=>({activeOrder:null,lastOrder:null}),smartMove:()=>{moves++;return {accepted:true,order:{id:'m'+moves}}}};
  controller.metrics={movementRequests:0,movementBlocks:0};
  controller.config={movementTimeoutMs:60000};
  const at={kind:'EXCHANGE',destination:{map:'main',x:200,y:75},travelRequested:false};
  assert.equal(controller._ensureTravel(at).ready,true);
  assert.equal(moves,0);
  const unknown={...at,travelRequested:false};
  merchant.x=null;
  assert.equal(controller._ensureTravel(unknown).waiting,true);
  assert.equal(moves,1);
});

test('H37 gathering tools are not inserted into generic background stand wishlist', () => {
  const root=context();
  load(root,'merchant-autonomy.js');
  const Controller=root.__ALBOT_INTERNALS__.MerchantAutonomyController;
  const merchant=Object.create(Controller.prototype);
  merchant.config={gatheringToolMaxPrice:10000,wishlistGoldReserve:1000,wishlistFallbackPrice:20};
  merchant._gameData=()=>({items:{rod:{g:2000},pickaxe:{g:2000}}});
  merchant._gold=()=>1000000;
  merchant._skillEnabled=()=>true;
  merchant._inventoryCount=()=>0;
  merchant._rawCharacter=()=>({slots:{}});
  merchant._wishlistExists=()=>false;
  merchant._emptyTradeSlot=()=> 'trade1';
  merchant.economy={plan:()=>({selected:null})};
  assert.equal(merchant._wishlistSpec(),null);
  assert.equal(merchant._wishlistSpec({includeTools:true}).name,'rod');
});

test('H37 verified craft material order reaches FARM only as a safe scoring preference', () => {
  const root=context();
  load(root,'merchant-autonomy.js');
  load(root,'farm-intelligence.js');
  const values=new Map();
  const storage={sharedAvailable:()=>true,getShared:key=>values.get(key)||null,
    setShared:(key,value)=>{values.set(key,value);return true;}};
  const Controller=root.__ALBOT_INTERNALS__.MerchantAutonomyController;
  const merchant=Object.create(Controller.prototype);
  merchant.root=root;merchant._roots=()=>[root];merchant.storage=storage;
  merchant.materialFarmRequest=null;merchant.metrics={materialFarmOrders:0};
  merchant.config={materialFarmWaitMs:180000};
  merchant._gameData=()=>({monsters:{goo:{}}});
  merchant._snapshot=()=>({character:{name:'My_Merchant'}});
  merchant.game={monsterDefinition:type=>type==='goo'
    ? {boss:false,cooperative:false,drops:[{item:'wood',chance:0.3}]}:null};
  merchant.exchangeCraft={productionGraph:()=>({steps:[{kind:'FARM_REQUIRED',name:'wood',level:0,quantity:4}]})};
  const order=merchant._requestToolMaterialFarm('rod');
  assert.equal(order.reason,'MERCHANT_TOOL_MATERIAL_FARM_PUBLISHED');
  assert.equal(merchant.metrics.materialFarmOrders,1);
  assert.equal(merchant._requestToolMaterialFarm('rod').reason,'MERCHANT_TOOL_MATERIAL_FARM_PENDING');
  assert.equal(merchant.metrics.materialFarmOrders,1);
  const Farm=root.__ALBOT_INTERNALS__.FarmIntelligenceController;
  const farmer=Object.create(Farm.prototype);
  farmer.root=root;farmer.storage=storage;farmer.now=()=>Date.now();
  farmer.game=merchant.game;
  assert.equal(farmer._materialDemand().monsterType,'goo');
  const metrics={xpPerSecond:1,goldPerSecond:1,dropSignal:1,density:1,
    travelSeconds:0,respawnSignal:1,competitionSignal:1,safetyConfidence:1};
  farmer._rawMetrics=()=>metrics;
  farmer.lastMaterialDemand=null;
  const scored=farmer._scoreCandidates({name:'My_Ranger1'},[
    {mtype:'bee',key:'b',visibleSafeCount:1},{mtype:'goo',key:'g',visibleSafeCount:1}
  ]);
  assert.equal(scored[0].mtype,'goo');
  assert.equal(scored[0].materialDemandMatch,true);
  farmer.game={monsterDefinition:()=>({boss:true,drops:[{item:'wood',chance:1}]})};
  assert.equal(farmer._materialDemand(),null,'unsafe boss cannot acquire preference');
  merchant.materialFarmRequest.expiresAtMs=Date.now()-1;
  assert.equal(merchant._requestToolMaterialFarm('rod'),null,'expired orders do not renew indefinitely');
});
