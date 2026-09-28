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
  const storage = options.storage || memoryStorage();
  const previousVersion = options.version || '0.22.3-h22';
  const previousBody = bundle(previousVersion);
  const previousRelease = options.previousRelease || manifestFor(previousVersion, previousBody, 'c'.repeat(64), '2'.repeat(40));
  const state = {
    combatActive: options.combatActive === true,
    movementActive: options.movementActive === true,
    resourcePending: options.resourcePending || null,
    uploads: [],
    loads: [],
    executes: [],
    rollbackLoads: [],
    confirmations: [],
    fullAutonomyStarts: [],
    stops: 0,
    activeRelease: previousRelease
  };
  root.__ALBOT_BOOTSTRAP__ = options.bootstrap || {
    product: 'AL Bot',
    version: options.bootstrapVersion || '1.0.0',
    activeRelease: () => state.activeRelease,
    confirmActiveRelease: manifest => {
      state.activeRelease = JSON.parse(JSON.stringify(manifest));
      state.confirmations.push(manifest.version);
      return state.activeRelease;
    },
    executeVerifiedRelease: async (manifest, code) => {
      state.executes.push({ version: manifest.version, bundleUrl: manifest.bundleUrl, bytes: new TextEncoder().encode(code).byteLength });
      if (typeof options.executeRelease === 'function') {
        return options.executeRelease(manifest, code, { root, state });
      }
      root.ALBot = {
        version: manifest.version,
        status: () => ({ running: true, version: manifest.version, bootCount: state.executes.length + 1, modules: [], scheduler: { enabled: true } }),
        fullAutonomy: {
          start: async value => {
            state.fullAutonomyStarts.push(value);
            return { accepted: true };
          }
        }
      };
      return { executed: true, manifest };
    },
    loadRelease: async manifest => {
      state.rollbackLoads.push(manifest.bundleUrl);
      if (typeof options.loadRelease === 'function') return options.loadRelease(manifest, { root, state });
      return { manifest, bundle: previousBody };
    }
  };
  const emptyStatus = () => ({ active: false, suspended: false });
  const runtime = {
    version: options.version || '0.22.3-h22',
    bootCount: 1,
    running: true,
    root,
    storage,
    logger: null,
    stopLatch: { status: () => ({ latched: false }) },
    game: {
      snapshot: () => options.gameSnapshot || ({
        character: { name: options.localName || 'My_Ranger1', hp: 1000, max_hp: 1000, rip: false, targetId: null },
        target: null
      }),
      monsterDefinition: mtype => ({
        id: String(mtype || ''),
        boss: Array.isArray(options.bossTypes) && options.bossTypes.includes(String(mtype || ''))
      })
    },
    combat: { status: () => ({
      active: state.combatActive,
      pendingAttack: options.pendingAttack || null,
      session: options.combatSession || null
    }) },
    movement: { status: () => ({ active: state.movementActive }) },
    resourceTopoff: { status: () => ({ pending: state.resourcePending }) },
    lifecycle: { status: () => options.lifecycleStatus || emptyStatus() },
    lifecycleTransport: {
      status: () => options.lifecycleTransportStatus || { pending: [], partyRecoveryLease: null },
      freshPeers: () => Array.isArray(options.freshPeers) ? options.freshPeers : [],
      requestUpdatePrepare: (name, payload) => options.requestUpdatePrepare
        ? options.requestUpdatePrepare(name, payload)
        : { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'NO_PREPARE_STUB' } },
      requestUpdateCommit: (name, payload) => options.requestUpdateCommit
        ? options.requestUpdateCommit(name, payload)
        : { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'NO_COMMIT_STUB' } },
      requestUpdateCancel: (name, payload) => options.requestUpdateCancel
        ? options.requestUpdateCancel(name, payload)
        : { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'NO_CANCEL_STUB' } }
    },
    roster: {
      refresh: () => options.rosterSnapshot || {
        onlineStateAvailable: true,
        onlineCharacterNames: [options.localName || 'My_Ranger1']
      }
    },
    partyLogistics: { status: () => options.partyLogisticsStatus || emptyStatus() },
    bank: { status: () => options.bankStatus || emptyStatus() },
    trade: { status: () => options.tradeStatus || emptyStatus() },
    upgrade: { status: () => options.upgradeStatus || emptyStatus() },
    exchangeCraft: { status: () => options.exchangeCraftStatus || emptyStatus() },
    economy: { status: () => options.economyStatus || emptyStatus() },
    inventory: { status: emptyStatus },
    merchant: { status: emptyStatus },
    gear: { status: emptyStatus },
    fullAutonomy: {
      status: () => options.fullAutonomyStatus || { enabled: false },
      startAutonomy: value => {
        state.fullAutonomyStarts.push(value);
        return { accepted: true };
      },
      stopAutonomy: () => ({ accepted: true })
    },
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
  assert.equal(helpers.compareVersions('0.22.3-h22', '0.21.0-h21') > 0, true);
  assert.equal(helpers.compareVersions('0.21.0-h21', '0.22.3-h22') < 0, true);
  assert.equal(helpers.compareVersions('0.22.3-h22', '0.22.3-h22'), 0);
});

test('H22 automatically downloads and caches a newer GitHub bundle only after SHA verification', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
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
  assert.equal(updater.status().pending.manifest.version, '0.22.4-h22');
  assert.equal(updater.status().stats.verifiedDownloads, 1);
  const persisted = JSON.parse(fixture.storage.get('albot:auto-update:pending:v1'));
  assert.equal(persisted.manifest.version, '0.22.4-h22');
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'bundle'), false);
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
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body, 'a'.repeat(64));
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

test('H22 ordinary combat and gameplay activity do not block update safety', () => {
  const { Controller } = loadUpdater();
  const fixture = runtimeFixture({
    combatActive: true,
    movementActive: true,
    resourcePending: { kind: 'POTION' },
    lifecycleTransportStatus: { pending: [{ messageId: 'h19-1' }], partyRecoveryLease: { id: 'lease-1' } },
    economyStatus: { active: true, suspended: false, currentAction: { kind: 'BANK' } }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  const safety = updater.safety();
  assert.equal(safety.safe, true);
  assert.equal(safety.reasons.length, 0);
  assert.equal(safety.protection.event, false);
  assert.equal(safety.protection.boss, false);
});

test('H22 defers every update while participating in an EVENT task', () => {
  const { Controller } = loadUpdater();
  const fixture = runtimeFixture({
    fullAutonomyStatus: { enabled: true, config: { taskType: 'EVENT' }, lastDecision: { state: 'RUNNING' } }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  const safety = updater.safety();
  assert.equal(safety.safe, false);
  assert.equal(safety.protection.event, true);
  assert.ok(safety.reasons.includes('EVENT_ACTIVE'));
});

test('H22 defers while the character is actually fighting a boss but not merely travelling to a BOSS task', () => {
  const { Controller } = loadUpdater();
  const travelling = runtimeFixture({
    combatActive: false,
    fullAutonomyStatus: { enabled: true, config: { taskType: 'BOSS' }, lastDecision: { state: 'RUNNING' } }
  });
  const travellingUpdater = new Controller({ runtime: travelling.runtime, root: travelling.root, storage: travelling.storage, sha256: async () => 'a'.repeat(64) });
  assert.equal(travellingUpdater.safety().safe, true);

  const fighting = runtimeFixture({
    combatActive: true,
    combatSession: { targetType: 'mrgreen' },
    bossTypes: ['mrgreen'],
    fullAutonomyStatus: { enabled: true, config: { taskType: 'BOSS' }, lastDecision: { state: 'RUNNING' } }
  });
  const fightingUpdater = new Controller({ runtime: fighting.runtime, root: fighting.root, storage: fighting.storage, sha256: async () => 'a'.repeat(64) });
  const safety = fightingUpdater.safety();
  assert.equal(safety.safe, false);
  assert.equal(safety.protection.boss, true);
  assert.ok(safety.reasons.includes('BOSS_COMBAT_ACTIVE'));
});

test('H22 large bundle apply never calls Adventure Land upload_code or save_code', async () => {
  const { Controller } = loadUpdater();
  const body = '/* AL Bot 0.22.4-h22 | generated file | do not edit dist directly */\n' + 'x'.repeat(1400000);
  const manifest = manifestFor('0.22.4-h22', body);
  const fixture = runtimeFixture({
    config: { autoApply: true, coordinatedApply: false },
    fullAutonomyStatus: {
      enabled: true,
      config: { taskType: 'FARM' },
      desiredCharacterNames: ['My_Ranger1']
    }
  });
  fixture.root.upload_code = async () => { throw new Error('MUST_NOT_UPLOAD_CODE'); };
  fixture.root.parent = {
    api_call: async name => { throw new Error('MUST_NOT_API_CALL:' + name); }
  };
  const oldApi = { version: '0.22.3-h22', status: () => ({ running: true, version: '0.22.3-h22', bootCount: 1 }) };
  fixture.root.ALBot = oldApi;

  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  updater._waitHandshake = async () => ({ ok: true, version: manifest.version, bootCount: 2, heartbeatActive: true });

  const result = await updater.applyPending();
  assert.equal(result.applied, true);
  assert.equal(fixture.state.executes.length, 1);
  assert.equal(fixture.state.executes[0].bytes, new TextEncoder().encode(body).byteLength);
  assert.equal(fixture.state.uploads.length, 0);
  assert.equal(fixture.state.loads.length, 0);
  assert.equal(fixture.state.stops, 1);
});

test('H22 applies a verified release through the bootstrap runtime loader and requires the new runtime handshake', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const fixture = runtimeFixture({
    config: { autoApply: true, coordinatedApply: false },
    fullAutonomyStatus: {
      enabled: true,
      config: { taskType: 'FARM' },
      desiredCharacterNames: ['My_Ranger1']
    }
  });
  const oldApi = { version: '0.22.3-h22', status: () => ({ running: true, version: '0.22.3-h22', bootCount: 1 }) };
  fixture.root.ALBot = oldApi;

  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  updater._waitHandshake = async () => ({ ok: true, version: manifest.version, bootCount: 2, heartbeatActive: true });

  const result = await updater.applyPending();
  assert.equal(result.applied, true);
  assert.equal(fixture.state.executes.length, 1);
  assert.equal(fixture.state.executes[0].bundleUrl, manifest.bundleUrl);
  assert.equal(fixture.state.stops, 1);
  assert.equal(fixture.state.activeRelease.version, '0.22.4-h22');
  assert.equal(fixture.state.confirmations.at(-1), '0.22.4-h22');
  assert.equal(fixture.state.fullAutonomyStarts.length, 1);
  assert.equal(fixture.state.fullAutonomyStarts[0].taskType, 'FARM');
  assert.equal(updater.status().pending, null);
  assert.equal(updater.status().stats.reloads, 1);
});


test('H22 rejects mutable main bundle URLs and requires immutable commit pinning', () => {
  const { helpers } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  manifest.bundleUrl = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/dist/al-bot.js';
  const result = helpers.validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UPDATE_MANIFEST_BUNDLE_NOT_COMMIT_PINNED');

  const missingCommit = manifestFor('0.22.4-h22', body);
  delete missingCommit.commitSha;
  const result2 = helpers.validateManifest(missingCommit);
  assert.equal(result2.ok, false);
  assert.equal(result2.reason, 'UPDATE_MANIFEST_COMMIT_SHA_INVALID');
});

test('H22 coordinator prepares every online peer before one shared group commit', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const calls = [];
  const peerProtection = {
    schemaVersion: 1,
    protocol: 'h22-synchronized-update-v1',
    coordinatedUpdateCapable: true,
    blocked: false,
    event: false,
    boss: false,
    observedAtMs: Date.now()
  };
  const fixture = runtimeFixture({
    localName: 'Alpha',
    config: { autoApply: true, coordinatedApply: true, groupApplyDelayMs: 6500 },
    rosterSnapshot: { onlineStateAvailable: true, onlineCharacterNames: ['Alpha', 'Bravo', 'Charlie', 'Delta'] },
    freshPeers: [
      { name: 'Bravo', running: true, version: '0.22.3-h22', updateProtection: peerProtection },
      { name: 'Charlie', running: true, version: '0.22.3-h22', updateProtection: peerProtection },
      { name: 'Delta', running: true, version: '0.22.3-h22', updateProtection: peerProtection }
    ],
    requestUpdatePrepare: (name, payload) => {
      calls.push({ type: 'PREPARE', name, payload });
      return { id: 'prepare-1', state: 'DISPATCHED', dispatched: true, value: Promise.resolve({ success: true }) };
    },
    requestUpdateCommit: (name, payload) => {
      calls.push({ type: 'COMMIT', name, payload });
      return { id: 'commit-1', state: 'DISPATCHED', dispatched: true, value: Promise.resolve({ success: true }) };
    },
    requestUpdateCancel: (name, payload) => {
      calls.push({ type: 'CANCEL', name, payload });
      return { id: 'cancel-1', state: 'DISPATCHED', dispatched: true, value: Promise.resolve({ success: true }) };
    }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };

  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UPDATE_GROUP_COMMITTED');
  assert.deepEqual(calls.map(row => row.type), ['PREPARE', 'PREPARE', 'PREPARE', 'COMMIT', 'COMMIT', 'COMMIT']);
  assert.deepEqual(calls.slice(0, 3).map(row => row.name), ['Bravo', 'Charlie', 'Delta']);
  assert.deepEqual(calls.slice(3).map(row => row.name), ['Bravo', 'Charlie', 'Delta']);
  assert.equal(calls[0].payload.releaseKey, calls[3].payload.releaseKey);
  assert.equal(calls[0].payload.coordinator, 'Alpha');
  assert.deepEqual(Array.from(calls[0].payload.participants), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  assert.equal(calls[0].payload.previousRelease.bundleUrl, fixture.state.activeRelease.bundleUrl);
  const applyTimes = new Set(calls.filter(row => row.type === 'COMMIT').map(row => row.payload.applyAtMs));
  assert.equal(applyTimes.size, 1);
  assert.ok(Number(calls[3].payload.applyAtMs) > Date.now());
  assert.equal(fixture.state.executes.length, 0);
  assert.equal(fixture.state.stops, 0);
  assert.equal(updater.status().preparedUpdate.cachedInWindow, true);
  assert.equal(updater.status().preparedUpdate.bundleUrl, manifest.bundleUrl);
  const cancelled = updater.cancelCoordinatedUpdate({ releaseKey: calls[0].payload.releaseKey });
  assert.equal(cancelled.accepted, true);
});

test('H22 final cutover accepts a peer that already reached exactly the planned new version', () => {
  const { Controller } = loadUpdater();
  const peerProtection = {
    schemaVersion: 1,
    protocol: 'h22-synchronized-update-v1',
    coordinatedUpdateCapable: true,
    blocked: false,
    event: false,
    boss: false,
    observedAtMs: Date.now()
  };
  const fixture = runtimeFixture({
    localName: 'Alpha',
    rosterSnapshot: { onlineStateAvailable: true, onlineCharacterNames: ['Alpha', 'Bravo'] },
    freshPeers: [{ name: 'Bravo', running: true, version: '0.22.4-h22', updateProtection: peerProtection }]
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });

  const strict = updater._groupState();
  assert.equal(strict.ready, false);
  assert.ok(strict.reasons.includes('UPDATE_GROUP_PEER_VERSION_MISMATCH:Bravo'));

  const cutover = updater._groupState({ acceptedVersions: ['0.22.4-h22'] });
  assert.equal(cutover.ready, true);
  assert.equal(cutover.reasons.length, 0);
});

test('H22 mismatched rollback identity or release key prevents coordinated commit', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const fixture = runtimeFixture({
    localName: 'Alpha',
    config: { autoApply: true, coordinatedApply: true },
    rosterSnapshot: { onlineStateAvailable: true, onlineCharacterNames: ['Alpha'] }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  const releaseKey = manifest.version + '@' + manifest.commitSha + ':' + manifest.sha256;
  const release = {
    version: manifest.version,
    commitSha: manifest.commitSha,
    sha256: manifest.sha256,
    bytes: manifest.bytes,
    bundleUrl: manifest.bundleUrl
  };

  const badRollback = {
    ...fixture.state.activeRelease,
    commitSha: '3'.repeat(40),
    bundleUrl: 'https://raw.githubusercontent.com/Riflex91/ALFinal/' + '3'.repeat(40) + '/dist/al-bot.js'
  };
  const rolloutId = releaseKey + ':test:Alpha';
  const rejected = await updater.prepareCoordinatedUpdate({
    releaseKey,
    rolloutId,
    release,
    previousRelease: badRollback,
    coordinator: 'Alpha',
    participants: ['Alpha']
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'UPDATE_GROUP_ROLLBACK_RELEASE_MISMATCH');

  const prepared = await updater.prepareCoordinatedUpdate({
    releaseKey,
    rolloutId,
    release,
    previousRelease: fixture.state.activeRelease,
    coordinator: 'Alpha',
    participants: ['Alpha']
  });
  assert.equal(prepared.accepted, true);

  const committed = updater.commitCoordinatedUpdate({
    releaseKey: releaseKey + ':different',
    rolloutId,
    release,
    previousRelease: fixture.state.activeRelease,
    coordinator: 'Alpha',
    participants: ['Alpha'],
    applyAtMs: Date.now() + 6500
  });
  assert.equal(committed.accepted, false);
  assert.equal(committed.reason, 'UPDATE_GROUP_RELEASE_MISMATCH');
  updater.cancelCoordinatedUpdate({ releaseKey });
});

test('H22 coordinated health barrier makes healthy peers roll back when one peer fails', async () => {
  const { Controller } = loadUpdater();
  const sharedStorage = memoryStorage();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const releaseKey = manifest.version + '@' + manifest.commitSha + ':' + manifest.sha256;
  const rolloutId = releaseKey + ':barrier:Alpha';
  const participants = ['Alpha', 'Bravo'];
  const peerProtection = {
    schemaVersion: 1,
    protocol: 'h22-synchronized-update-v1',
    coordinatedUpdateCapable: true,
    blocked: false,
    event: false,
    boss: false,
    observedAtMs: Date.now()
  };

  const alpha = runtimeFixture({
    storage: sharedStorage,
    localName: 'Alpha',
    config: { autoApply: true, coordinatedApply: true, handshakeTimeoutMs: 3000 },
    rosterSnapshot: { onlineStateAvailable: true, onlineCharacterNames: participants },
    freshPeers: [{ name: 'Bravo', running: true, version: '0.22.3-h22', updateProtection: peerProtection }]
  });
  const bravo = runtimeFixture({
    storage: sharedStorage,
    localName: 'Bravo',
    config: { autoApply: true, coordinatedApply: true, handshakeTimeoutMs: 3000 },
    rosterSnapshot: { onlineStateAvailable: true, onlineCharacterNames: participants },
    freshPeers: [{ name: 'Alpha', running: true, version: '0.22.3-h22', updateProtection: peerProtection }],
    executeRelease: (release, _code, { root }) => {
      if (release.version === '0.22.4-h22') throw new Error('BRAVO_BOOT_FAIL');
      root.ALBot = {
        version: release.version,
        status: () => ({ running: true, version: release.version, bootCount: 3 }),
        fullAutonomy: { start: async () => ({ accepted: true }) }
      };
      return { executed: true, manifest: release };
    }
  });

  const alphaUpdater = new Controller({ runtime: alpha.runtime, root: alpha.root, storage: sharedStorage, sha256: async () => manifest.sha256 });
  const bravoUpdater = new Controller({ runtime: bravo.runtime, root: bravo.root, storage: sharedStorage, sha256: async () => manifest.sha256 });
  alpha.root.ALBot = { version: '0.22.3-h22', status: () => ({ running: true, version: '0.22.3-h22', bootCount: 1 }) };
  bravo.root.ALBot = { version: '0.22.3-h22', status: () => ({ running: true, version: '0.22.3-h22', bootCount: 1 }) };
  alphaUpdater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  bravoUpdater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };

  const previousRelease = alpha.state.activeRelease;
  const rolloutBase = {
    protocol: 'h22-synchronized-update-v1',
    state: 'COMMITTED',
    releaseKey,
    rolloutId,
    release: {
      version: manifest.version,
      commitSha: manifest.commitSha,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      bundleUrl: manifest.bundleUrl
    },
    previousRelease,
    coordinator: 'Alpha',
    participants,
    applyAtMs: Date.now() - 1,
    applyAt: new Date(Date.now() - 1).toISOString(),
    rearmIntent: null
  };
  alphaUpdater.preparedUpdate = { ...rolloutBase, localName: 'Alpha' };
  bravoUpdater.preparedUpdate = { ...rolloutBase, localName: 'Bravo' };
  alphaUpdater._waitHandshake = async (_api, version) => ({ ok: true, version, bootCount: version === '0.22.4-h22' ? 2 : 3, heartbeatActive: true });
  bravoUpdater._waitHandshake = async (_api, version) => ({ ok: true, version, bootCount: 3, heartbeatActive: true });

  const [alphaResult, bravoResult] = await Promise.all([
    alphaUpdater.applyPending({ localOnly: true, coordinated: true, releaseKey }),
    bravoUpdater.applyPending({ localOnly: true, coordinated: true, releaseKey })
  ]);

  assert.equal(alphaResult.applied, false);
  assert.match(alphaResult.reason, /UPDATE_GROUP_MEMBER_FAILED:Bravo:ROLLBACK_OK/);
  assert.equal(bravoResult.applied, false);
  assert.match(bravoResult.reason, /UPDATE_EXECUTION_FAILED:BRAVO_BOOT_FAIL:ROLLBACK_OK/);
  assert.equal(alpha.state.activeRelease.version, '0.22.3-h22');
  assert.equal(bravo.state.activeRelease.version, '0.22.3-h22');
  assert.deepEqual(alpha.state.executes.map(row => row.version), ['0.22.4-h22', '0.22.3-h22']);
  assert.deepEqual(bravo.state.executes.map(row => row.version), ['0.22.4-h22', '0.22.3-h22']);
  assert.equal(alphaUpdater.status().stats.rollbacks, 1);
  assert.equal(bravoUpdater.status().stats.rollbacks, 1);
});

test('H22 group rollout is deferred when any online peer reports event or boss protection', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  let dispatches = 0;
  const fixture = runtimeFixture({
    localName: 'Alpha',
    config: { autoApply: true, coordinatedApply: true },
    rosterSnapshot: { onlineStateAvailable: true, onlineCharacterNames: ['Alpha', 'Bravo'] },
    freshPeers: [{
      name: 'Bravo',
      running: true,
      version: '0.22.3-h22',
      updateProtection: {
        schemaVersion: 1,
        protocol: 'h22-synchronized-update-v1',
        coordinatedUpdateCapable: true,
        blocked: true,
        event: true,
        boss: false,
        observedAtMs: Date.now()
      }
    }],
    requestUpdatePrepare: () => { dispatches += 1; throw new Error('MUST_NOT_DISPATCH'); }
  });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };

  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UPDATE_GROUP_NOT_READY');
  assert.ok(result.group.reasons.includes('REMOTE_EVENT_ACTIVE:Bravo'));
  assert.equal(dispatches, 0);
});

test('H22 failed release is quarantined and rollback reloads the previous immutable release', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const fixture = runtimeFixture({
    config: { autoApply: true, coordinatedApply: false },
    fullAutonomyStatus: {
      enabled: true,
      config: { taskType: 'FARM' },
      desiredCharacterNames: ['My_Ranger1']
    },
    executeRelease: (release, _code, { root, state }) => {
      root.ALBot = release.version === '0.22.4-h22'
        ? { version: release.version, status: () => ({ running: false, version: release.version, bootCount: 2 }) }
        : {
            version: release.version,
            status: () => ({ running: true, version: release.version, bootCount: 3 }),
            fullAutonomy: {
              start: async value => {
                state.fullAutonomyStarts.push(value);
                return { accepted: true };
              }
            }
          };
      return { executed: true, manifest: release };
    }
  });

  const oldApi = { version: '0.22.3-h22', status: () => ({ running: true, version: '0.22.3-h22', bootCount: 1 }) };
  fixture.root.ALBot = oldApi;
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  updater._waitHandshake = async (_previousApi, version) => version === '0.22.4-h22'
    ? { ok: false, reason: 'RUNTIME_HEARTBEAT_MISSING' }
    : { ok: true, version, bootCount: 3, heartbeatActive: true };

  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.match(result.reason, /UPDATE_HANDSHAKE_FAILED:RUNTIME_HEARTBEAT_MISSING:ROLLBACK_OK/);
  assert.equal(fixture.state.executes.length, 2);
  assert.equal(fixture.state.executes[0].version, '0.22.4-h22');
  assert.equal(fixture.state.executes[1].version, '0.22.3-h22');
  assert.deepEqual(fixture.state.rollbackLoads, [fixture.state.activeRelease.bundleUrl]);
  assert.equal(fixture.state.activeRelease.version, '0.22.3-h22');
  assert.equal(fixture.state.fullAutonomyStarts.length, 1);
  assert.equal(fixture.state.fullAutonomyStarts[0].taskType, 'FARM');

  const status = updater.status();
  assert.equal(status.stats.rollbacks, 1);
  assert.equal(status.stats.quarantines, 1);
  const quarantineRows = Object.values(status.quarantine);
  assert.equal(quarantineRows.length, 1);
  assert.equal(quarantineRows[0].bundleUrl, manifest.bundleUrl);
  assert.ok(quarantineRows[0].retryAtMs > Date.now());

  const second = await updater.applyPending();
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'UPDATE_RELEASE_QUARANTINED');
});


test('H22 direct execution failure quarantines candidate and rolls back to the previous immutable release', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const fixture = runtimeFixture({
    config: { autoApply: true, coordinatedApply: false },
    executeRelease: (release, _code, { root }) => {
      if (release.version === '0.22.4-h22') throw new Error('BUNDLE_BOOT_THROW');
      root.ALBot = {
        version: release.version,
        status: () => ({ running: true, version: release.version, bootCount: 3 }),
        fullAutonomy: { start: async () => ({ accepted: true }) }
      };
      return { executed: true, manifest: release };
    }
  });

  fixture.root.ALBot = {
    version: '0.22.3-h22',
    status: () => ({ running: true, version: '0.22.3-h22', bootCount: 1 })
  };
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => manifest.sha256 });
  updater.pending = { downloadedAt: new Date().toISOString(), manifest, bundle: body };
  updater._waitHandshake = async (_previousApi, version) => ({ ok: true, version, bootCount: 3, heartbeatActive: true });

  const previousUrl = fixture.state.activeRelease.bundleUrl;
  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.match(result.reason, /UPDATE_EXECUTION_FAILED:BUNDLE_BOOT_THROW:ROLLBACK_OK/);
  assert.deepEqual(fixture.state.executes.map(row => row.version), ['0.22.4-h22', '0.22.3-h22']);
  assert.deepEqual(fixture.state.rollbackLoads, [previousUrl]);
  assert.equal(fixture.state.activeRelease.version, '0.22.3-h22');
  assert.equal(updater.status().stats.rollbacks, 1);
  assert.equal(updater.status().stats.quarantines, 1);
});

test('H22 rejects a legacy persisted pending manifest before touching runtime or code slots', async () => {
  const { Controller } = loadUpdater();
  const body = bundle('0.22.4-h22');
  const fixture = runtimeFixture({ config: { autoApply: true } });
  const updater = new Controller({ runtime: fixture.runtime, root: fixture.root, storage: fixture.storage, sha256: async () => 'a'.repeat(64) });
  const legacy = manifestFor('0.22.4-h22', body);
  delete legacy.commitSha;
  legacy.bundleUrl = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/dist/al-bot.js';
  updater.pending = { downloadedAt: new Date().toISOString(), manifest: legacy, bundle: body };
  updater.safeSince = Date.now() - 4000;

  const result = await updater.applyPending();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'UPDATE_MANIFEST_COMMIT_SHA_INVALID');
  assert.equal(fixture.state.stops, 0);
  assert.equal(fixture.state.executes.length, 0);
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
  const updaterSource = fs.readFileSync(new URL('../src/safe-auto-updater.js', import.meta.url), 'utf8');
  assert.match(updaterSource, /executeVerifiedRelease/);
  assert.match(updaterSource, /rollbackLoadsPreviousPinnedRelease/);
  assert.match(updaterSource, /fullBundleNeverSavedToAdventureLandCodeSlot/);
  assert.doesNotMatch(updaterSource, /upload_code/);
  assert.doesNotMatch(updaterSource, /api_call\('save_code'/);
  assert.doesNotMatch(updaterSource, /load_code/);
  assert.match(runtime, /prepareUpdateLocal/);
  assert.match(runtime, /commitUpdateLocal/);
  const transport = fs.readFileSync(new URL('../src/cross-window-lifecycle.js', import.meta.url), 'utf8');
  assert.match(transport, /PREPARE_UPDATE/);
  assert.match(transport, /COMMIT_UPDATE/);
  assert.match(transport, /requestUpdatePrepare/);
  assert.match(entry, /updater:\s*\{/);
  assert.match(entry, /tick:\s*\(\) => runtime\.safeUpdater\.cycle\(\)/);
  assert.match(entry, /Object\.freeze\(api\.updater\)/);
  assert.match(entry, /updates:\s*\{/);
});
