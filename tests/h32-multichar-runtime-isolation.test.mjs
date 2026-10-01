import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const entrySource = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');

function createRunner(sharedHost, name) {
  const created = [];

  class FakeRuntime {
    constructor(options = {}) {
      this.name = name;
      this.root = options.root;
      this.version = options.version || 'test';
      this.bootCount = Number(options.bootCount) || 0;
      this.replacedPrevious = options.replacedPrevious === true;
      this.loadedAt = '2026-10-01T00:00:00.000Z';
      this.running = false;
      this.hotReloadReasons = [];
      this.destroyCount = 0;
      this.logger = {
        info() {},
        error() {},
        list() { return []; }
      };
      this.bus = {};
      created.push(this);
    }

    prepareHotReload(reason) {
      this.hotReloadReasons.push(String(reason || ''));
    }

    destroy() {
      this.destroyCount += 1;
    }
  }

  const context = {
    console,
    parent: sharedHost,
    document: { body: null },
    location: { hostname: 'test.invalid' },
    __ALBOT_INTERNALS__: {
      ALBotRuntime: FakeRuntime,
      helpers: {
        cleanText(value) {
          return String(value == null ? '' : value);
        }
      }
    },
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);

  const boot = () => {
    vm.runInContext(entrySource, context, { filename: 'entry.js' });
    return context.ALBot.__runtime;
  };

  return { context, created, boot };
}

test('character runners sharing one Adventure Land host do not destroy each other', () => {
  const sharedHost = { document: {} };
  const merchant = createRunner(sharedHost, 'My_Merchant');
  const ranger = createRunner(sharedHost, 'My_Ranger2');

  const merchantRuntime = merchant.boot();
  assert.equal(merchantRuntime.replacedPrevious, false);
  assert.equal(merchantRuntime.bootCount, 1);

  const rangerRuntime = ranger.boot();
  assert.equal(rangerRuntime.replacedPrevious, false);
  assert.equal(rangerRuntime.bootCount, 1);

  // Regression for the live 1/4 discovery failure: before per-runner ownership,
  // Ranger startup read the Merchant from the shared singleton as "previous" and
  // invoked prepareHotReload/destroy on the Merchant runtime.
  assert.deepEqual(merchantRuntime.hotReloadReasons, []);
  assert.equal(merchantRuntime.destroyCount, 0);
  assert.deepEqual(rangerRuntime.hotReloadReasons, []);
  assert.equal(rangerRuntime.destroyCount, 0);
  assert.equal(merchant.context.ALBot.__runtime, merchantRuntime);
  assert.equal(ranger.context.ALBot.__runtime, rangerRuntime);
});

test('hot reload still replaces only the runtime owned by the same runner', () => {
  const sharedHost = { document: {} };
  const merchant = createRunner(sharedHost, 'My_Merchant');
  const ranger = createRunner(sharedHost, 'My_Ranger2');

  const merchantFirst = merchant.boot();
  const rangerFirst = ranger.boot();
  const merchantSecond = merchant.boot();

  assert.equal(merchantSecond.replacedPrevious, true);
  assert.equal(merchantSecond.bootCount, 2);
  assert.deepEqual(merchantFirst.hotReloadReasons, ['BUNDLE_RELOAD']);
  assert.equal(merchantFirst.destroyCount, 0);

  assert.deepEqual(rangerFirst.hotReloadReasons, []);
  assert.equal(rangerFirst.destroyCount, 0);
  assert.equal(rangerFirst.bootCount, 1);
  assert.equal(ranger.context.ALBot.__runtime, rangerFirst);
});
