import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createTelemetryServer } from '../host/telemetry-recorder.mjs';
import { SSDKeyValueStore } from '../host/ssd-kv-store.mjs';

test('H41 SSD KV persists across process objects and validates keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-h41-kv-'));
  try {
    const a = new SSDKeyValueStore({ root });
    assert.equal(a.get('albot:party:v1'), null);
    assert.equal(a.set('albot:party:v1', '{"members":["My_Ranger1"]}'), true);
    const b = new SSDKeyValueStore({ root });
    assert.equal(b.get('albot:party:v1'), '{"members":["My_Ranger1"]}');
    assert.throws(() => b.set('../../other', 'tamper'), /SSD_KV_KEY_REJECTED/);
    assert.throws(() => b.set('albot:large', 'x'.repeat(1048577)), /SSD_KV_VALUE_INVALID/);
    b.remove('albot:party:v1');
    assert.equal(a.get('albot:party:v1'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('H41 SSD localhost API enables CORS, durable GET, POST, DELETE without localStorage', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-h41-http-'));
  const app = createTelemetryServer({ root: path.join(base,'telemetry'), stateRoot: path.join(base,'state') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + app.server.address().port;
  const headers = { 'Origin': 'https://adventure.land', 'Content-Type': 'application/json' };
  try {
    const key = encodeURIComponent('albot:h19:party:v1:EU:II');
    const health = await (await fetch(endpoint + '/health', { headers })).json();
    assert.equal(health.kvStore.backend, 'SSD_KEY_VALUE_V1');
    assert.equal(health.kvStore.root, path.join(base,'state','kv'));
    const empty = await (await fetch(endpoint + '/v1/kv?key=' + key, { headers })).json();
    assert.equal(empty.value, null);
    const post = await fetch(endpoint + '/v1/kv?key=' + key, {
      method:'POST', headers, body:JSON.stringify({value:'{"party":["My_Ranger1"]}'})
    });
    assert.equal(post.status,200);
    assert.equal(post.headers.get('access-control-allow-origin'),'https://adventure.land');
    const read = await (await fetch(endpoint + '/v1/kv?key=' + key, { headers })).json();
    assert.equal(read.value,'{"party":["My_Ranger1"]}');
    const invalid = await fetch(endpoint + '/v1/kv?key=' + encodeURIComponent('../other'),
      { method:'POST', headers, body:JSON.stringify({value:'nope'}) });
    assert.equal(invalid.status,400);
    await fetch(endpoint + '/v1/kv?key=' + key,{method:'DELETE',headers});
    assert.equal((await (await fetch(endpoint + '/v1/kv?key=' + key,{headers})).json()).value,null);
    const originBlocked = await fetch(endpoint + '/v1/kv?key=' + key,
      {method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},
      body:JSON.stringify({value:'bad'})});
    assert.equal(originBlocked.status,403);
  } finally { await app.close(); fs.rmSync(base,{recursive:true,force:true}); }
});

test('H41 browser mode uses SSD host only, never touches legacy browser localStorage', () => {
  const code = fs.readFileSync(new URL('../src/core.js', import.meta.url),'utf8');
  const map = new Map();
  let localStorageTouches = 0, hostReady = true;
  const root = {
    get localStorage() { localStorageTouches++; throw Error('BROWSER_STORAGE_FORBIDDEN'); },
    XMLHttpRequest: class {
      open(method, url, async) { assert.equal(async,false); this.method=method; this.url=new URL(url); }
      setRequestHeader() {}
      send(payload) {
        if (!hostReady) { this.status=503;this.responseText='unavailable';return; }
        this.status=200;
        const key=this.url.searchParams.get('key');
        if (this.url.pathname==='/health') {
          this.responseText=JSON.stringify({ok:true,kvStore:{root:'D:/ALBot/state/kv',available:true}});
        } else if (this.method==='GET') {
          this.responseText=JSON.stringify({ok:true,value:map.get(key) ?? null});
        } else if (this.method==='POST') {
          const body = JSON.parse(payload);
          if (body.operation === 'DELETE') map.delete(key);
          else map.set(key, body.value);
          this.responseText=JSON.stringify({ok:true});
        } else if (this.method==='DELETE') {
          map.delete(key);this.responseText=JSON.stringify({ok:true});
        }
      }
    }
  };
  const ctx = { __ALBOT_INTERNALS__:{}, Date, Map, Set, JSON, String };
  vm.runInNewContext(code,ctx,{filename:'src/core.js'});
  const storage = new ctx.__ALBOT_INTERNALS__.StorageAdapter(root);
  assert.equal(storage.mode,'SSD_ONLY');
  assert.equal(storage.sharedAvailable(),true);
  assert.equal(storage.setShared('albot:gear:v1','{\"rogue\":true}'),true);
  assert.equal(storage.get('albot:gear:v1'),'{\"rogue\":true}');
  assert.equal(storage.removeShared('albot:gear:v1'),true);
  assert.equal(storage.getShared('albot:gear:v1'),null);
  assert.equal(storage.set('non-bot-key','unsafe'),false);
  assert.equal(localStorageTouches,0);
  hostReady=false;
  assert.equal(storage.setShared('albot:health-check','x'),false);
  assert.equal(storage.sharedAvailable(),false);
  assert.equal(localStorageTouches,0);
});

test('H41 restore exact Gear-H19 transport binding and healthy online roster policy', () => {
  const code=fs.readFileSync(new URL('../src/runtime.js',import.meta.url),'utf8');
  const constructed=code.indexOf('this.gear = new ns.GearController(');
  const transport=code.indexOf('this.lifecycleTransport = new ns.H19CrossWindowLifecycleTransport(');
  const bind=code.indexOf('this.gear.crossWindow = this.lifecycleTransport;');
  assert.ok(constructed>=0 && transport>constructed && bind>transport);
  assert.match(code,/if \(!this\.storage\.sharedAvailable\(\)\) throw new Error\('ALBOT_SSD_STATE_UNAVAILABLE/);
  const full=fs.readFileSync(new URL('../src/full-autonomy.js',import.meta.url),'utf8');
  assert.match(full,/requiresRotation && localName === String\(merchantName/);
  assert.doesNotMatch(full,/if \(rotationProbe && rotationProbe\.ready === false\)/);
});
