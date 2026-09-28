import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadUpdater() {
  const source = fs.readFileSync(new URL('../src/safe-auto-updater.js', import.meta.url), 'utf8');
  const context = {
    console,
    URL,
    TextEncoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'safe-auto-updater.js' });
  return {
    Controller: context.__ALBOT_INTERNALS__.SafeAutoUpdater,
    helpers: context.__ALBOT_INTERNALS__.safeUpdaterHelpers
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    get: key => map.has(key) ? map.get(key) : null,
    set: (key, value) => { map.set(key, value); return true; },
    remove: key => map.delete(key),
    map
  };
}

function runtimeFixture(options = {}) {
  const root = {
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    fetch: options.fetch || null,
    __ALBOT_AUTO_UPDATE_CONFIG__: options.config || {}
  };
  const storage = memoryStorage();
  const state = {
    combatActive: options.combatActive === true,
    movementActive: options.movementActive === true,
    resourcePending: options.resourcePending || null,
    uploads: [],
    loads: [],
    stops: 0
  };
  const emptyStatus = () => ({ active: false, suspended: false });
  const runtime = {
    version: options.version || '0.22.0-h22',
    bootCount: 1,
    running: true,
    root,
    storage,
    logger: null,
    stopLatch: { status: () => ({ latched: false }) },
    game: { snapshot: () => ({ character: { name: 'My_Ranger1', hp: 1000, max_hp: 1000, rip: false } }) },
    combat: { status: () => ({ active: state.combatActive }) },
    movement: { status: () => ({ active: state.movementActive }) },
    resourceTopoff: { status: () => ({ pending: state.resourcePending }) },
    lifecycle: { status: () => options.lifecycleStatus || emptyStatus() },
    lifecycleTransport: { status: () => options.lifecycleTransportStatus || { pending: [], partyRecoveryLease: null } },
    partyLogistics: { status: () => options.partyLogisticsStatus || emptyStatus() },
    bank: { status: () => options.bankStatus || emptyStatus() },
    trade: { status: () => options.tradeStatus || emptyStatus() },
    upgrade: { status: () => options.upgradeStatus || emptyStatus() },
    exchangeCraft: { status: () => options.exchangeCraftStatus || emptyStatus() },
    economy: { status: () => options.economyStatus || emptyStatus() },
    inventory: { status: emptyStatus },
    merchant: { status: emptyStatus },
    gear: { status: emptyStatus },
    fullAutonomy: { status: () => options.fullAutonomyStatus || { enabled: false } },
    stop: async () => { state.stops += 1; runtime.running = false; return { running: false }; }
  };
  return { root, storage, state, runtime };
}

function bundle(version) {
  return `/* AL Bot ${version} | generated file | do not edit dist directly */\n` + 'x'.repeat(12000);
}

function manifestFor(version, body, sha256 = 'a'.repeat(64), commitSha = '1'.repeat(40)) {
  return {
    schemaVersion: 1,
    product: 'AL Bot',
    channel: 'stable',
    version,
    packageVersion: version.replace(/-h\d+$/, ''),
    commitSha,
    bundleUrl: `https://raw.githubusercontent.com/Riflex91/ALFinal/${commitSha}/dist/al-bot.js`,
    sha256,
    bytes: new TextEncoder().encode(body).byteLength,
    sourceRef: commitSha,
    releasedAt: '2026-09-28T10:00:00.000Z'
  };
}

test('H22 version comparison rejects downgrade and accepts newer release', () => {
  const { helpers } = loadUpdater();
  assert.equal(helpers.compareVersions('0.22.0-h22', '0.21.0-h21') > 0, true);
  assert.equal(helpers.compareVersions('0.21.0-h21', '0.22.0-h22') < 0, true);
  assert.equal(helpers.compareVersions('0.22.0-h22', '0.22.0-h22'), 0);
});

test('H22 automatically downloads and caches a newer GitHub bundle only after SHA verification', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const manifest = manifestFor('0.22.1-h22', body);
  let calls = 0;
  const fixture = runtimeFixture({
    fetch: async url => {
      calls += 1;
      if (String(url).includes('release/al-bot-release.json')) return { ok: true, status: 200, json: async () => manifest };
      return { ok: true, status: 200, text: async () => body };
    }
  });
  const updater = new Controller({
    runtime: fixture.runtime,
    root: fixture.root,
    storage: fixture.storage,
    sha256: async () => manifest.sha256
  });

  const result = await updater.checkAndDownload();
  assert.equal(result.accepted, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.downloaded, true);
  assert.equal(result.verified, true);
  assert.equal(calls, 2);
  assert.equal(updater.status().pending.manifest.version, '0.22.1-h22');
  assert.equal(updater.status().stats.verifiedDownloads, 1);
  assert.ok(fixture.storage.get('albot:auto-update:pending:v1'));
});

test('H22 never downloads an equal or older release bundle', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.21.0-h21');
  const manifest = manifestFor('0.21.0-h21', body);
  let calls = 0;
  const fixture = runtimeFixture({
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => manifest };
    }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  const result = await updater.checkAndDownload();
  assert.equal(result.accepted, true);
  assert.equal(result.updateAvailable, false);
  assert.equal(calls, 1);
  assert.equal(updater.status().pending, null);
});

test('H22 rejects a downloaded bundle when SHA-256 does not match the manifest', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const manifest = manifestFor('0.22.1-h22', body, 'a'.repeat(64));
  const fixture = runtimeFixture({
    fetch: async url => String(url).includes('release/al-bot-release.json')
      ? { ok: true, status: 200, json: async () => manifest }
      : { ok: true, status: 200, text: async () => body }
  });
  const updater = new Controller({
    runtime: fixture.runtime,
    root: fixture.root,
    storage: fixture.storage,
    sha256: async () => 'b'.repeat(64)
  });
  const result = await updater.checkAndDownload();
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'UPDATE_BUNDLE_SHA256_MISMATCH');
  assert.equal(updater.status().pending, null);
  assert.equal(updater.status().stats.hashRejects, 1);
});

test('H22 defers auto-apply while combat is active', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const fixture = runtimeFixture({ combatActive: true, config: { autoApply: true, stagingSlots: ['2'] } });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest: manifestFor('0.22.1-h22', body), bundle: body };
  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UPDATE_SAFE_WINDOW_REQUIRED');
  assert.ok(result.safety.reasons.includes('COMBAT_ACTIVE'));
  assert.equal(fixture.state.stops, 0);
});

test('H22 requires a separate staging slot before any automatic install', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const fixture = runtimeFixture({ config: { autoApply: true, safeHoldMs: 3000 } });
  fixture.root.get_active_code_slot = () => '1';
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest: manifestFor('0.22.1-h22', body), bundle: body };
  updater.safeSince = Date.now() - 4000;
  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UPDATE_STAGING_SLOT_REQUIRED');
  assert.equal(fixture.state.stops, 0);
});

test('H22 applies a verified update through a separate slot and requires the new runtime handshake', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const fixture = runtimeFixture({ config: { autoApply: true, safeHoldMs: 3000, stagingSlots: ['2', '3'] } });
  fixture.root.get_active_code_slot = () => '1';
  fixture.root.upload_code = async (slot, name, code) => {
    fixture.state.uploads.push({ slot: String(slot), name, bytes: code.length });
    return { success: true };
  };
  const oldApi = { version: '0.22.0-h22', status: () => ({ running: true, version: '0.22.0-h22', bootCount: 1 }) };
  fixture.root.ALBot = oldApi;
  fixture.root.load_code = async slot => {
    fixture.state.loads.push(String(slot));
    fixture.root.ALBot = {
      version: '0.22.1-h22',
      status: () => ({ running: true, version: '0.22.1-h22', bootCount: 2 })
    };
  };

  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest: manifestFor('0.22.1-h22', body), bundle: body };
  updater.safeSince = Date.now() - 4000;

  const result = await updater.applyPending();
  assert.equal(result.applied, true);
  assert.equal(fixture.state.uploads.length, 1);
  assert.equal(fixture.state.uploads[0].slot, '2');
  assert.deepEqual(fixture.state.loads, ['2']);
  assert.equal(fixture.state.stops, 1);
  assert.equal(updater.status().pending, null);
  assert.equal(updater.status().stats.reloads, 1);
});


test('H22 rejects mutable main bundle URLs and requires immutable commit pinning', () => {
  const { helpers } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const manifest = manifestFor('0.22.1-h22', body);
  manifest.bundleUrl = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/dist/al-bot.js';
  const result = helpers.validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UPDATE_MANIFEST_BUNDLE_NOT_COMMIT_PINNED');

  const missingCommit = manifestFor('0.22.1-h22', body);
  delete missingCommit.commitSha;
  const result2 = helpers.validateManifest(missingCommit);
  assert.equal(result2.ok, false);
  assert.equal(result2.reason, 'UPDATE_MANIFEST_COMMIT_SHA_INVALID');
});

test('H22 safe point blocks H19 remote work and active economy transitions', () => {
  const { Controller } = loadUpdater();
  const fixture = runtimeFixture({
    lifecycleTransportStatus: { pending: [{ messageId: 'h19-1' }], partyRecoveryLease: null },
    economyStatus: { active: false, suspended: false, currentAction: { kind: 'BANK' } }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  const safety = updater.safety();
  assert.equal(safety.safe, false);
  assert.ok(safety.reasons.includes('H19_REMOTE_REQUEST_PENDING'));
  assert.ok(safety.reasons.includes('ECONOMY_CURRENTACTION'));
});

test('H22 failed release is quarantined after verified rollback and is not immediately retried', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const manifest = manifestFor('0.22.1-h22', body);
  const fixture = runtimeFixture({ config: { autoApply: true, safeHoldMs: 3000, stagingSlots: ['2'] } });
  fixture.root.get_active_code_slot = () => '1';
  fixture.root.upload_code = async () => ({ success: true });

  const oldApi = { version: '0.22.0-h22', status: () => ({ running: true, version: '0.22.0-h22', bootCount: 1 }) };
  fixture.root.ALBot = oldApi;
  fixture.root.load_code = async slot => {
    fixture.state.loads.push(String(slot));
    fixture.root.ALBot = slot === '2'
      ? { version: '0.22.1-h22', status: () => ({ running: false, version: '0.22.1-h22', bootCount: 2 }) }
      : { version: '0.22.0-h22', status: () => ({ running: true, version: '0.22.0-h22', bootCount: 3 }) };
  };

  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  updater.safeSince = Date.now() - 4000;
  updater._waitHandshake = async (_previousApi, version) => version === '0.22.1-h22'
    ? { ok: false, reason: 'RUNTIME_HEARTBEAT_MISSING' }
    : { ok: true, version, bootCount: 3, heartbeatActive: true };

  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.match(result.reason, /UPDATE_HANDSHAKE_FAILED:RUNTIME_HEARTBEAT_MISSING:ROLLBACK_OK/);
  assert.deepEqual(fixture.state.loads, ['2', '1']);
  const status = updater.status();
  assert.equal(status.stats.rollbacks, 1);
  assert.equal(status.stats.quarantines, 1);
  const quarantineRows = Object.values(status.quarantine);
  assert.equal(quarantineRows.length, 1);
  assert.ok(quarantineRows[0].retryAtMs > Date.now());

  const second = await updater.applyPending();
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'UPDATE_RELEASE_QUARANTINED');
});


test('H22 rejects a legacy persisted pending manifest before touching runtime or code slots', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.1-h22');
  const fixture = runtimeFixture({ config: { autoApply: true, safeHoldMs: 3000, stagingSlots: ['2'] } });
  fixture.root.get_active_code_slot = () => '1';
  fixture.root.upload_code = async () => { throw new Error('MUST_NOT_UPLOAD'); };
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  const legacy = manifestFor('0.22.1-h22', body);
  delete legacy.commitSha;
  legacy.bundleUrl = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/dist/al-bot.js';
  updater.pending = { downloadedAt: new Date().toISOString(), manifest: legacy, bundle: body };
  updater.safeSince = Date.now() - 4000;

  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UPDATE_MANIFEST_COMMIT_SHA_INVALID');
  assert.equal(fixture.state.stops, 0);
  assert.equal(updater.status().pending, null);
});

test('H22 build script never publishes a mutable main/latest bundle manifest', () => {
  const build = fs.readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /ALBOT_RELEASE_COMMIT_SHA/);
  assert.match(build, /releaseCommitSha/);
  assert.match(build, /raw\.githubusercontent\.com\/Riflex91\/ALFinal\/\$\{releaseCommitSha\}\/dist\/al-bot\.js/);
  assert.doesNotMatch(build, /raw\.githubusercontent\.com\/Riflex91\/ALFinal\/main\/dist\/al-bot\.js/);
});


test('H22 runtime and public API expose updater diagnostics and stable updater namespace', () => {
  const runtime = fs.readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');
  assert.match(runtime, /h22-safe-auto-updater/);
  assert.match(runtime, /bundleUrlMustPinCommitSha/);
  assert.match(entry, /updater:\s*\{/);
  assert.match(entry, /tick:\s*\(\) => runtime\.safeUpdater\.cycle\(\)/);
  assert.match(entry, /Object\.freeze\(api\.updater\)/);
  assert.match(entry, /updates:\s*\{/);
});
