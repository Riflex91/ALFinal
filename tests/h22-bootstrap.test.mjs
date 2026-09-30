import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../bootstrap/al-bot-bootstrap.js', import.meta.url), 'utf8');

function loadBootstrap(options = {}) {
  const context = {
    console,
    URL,
    TextEncoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    crypto: crypto.webcrypto,
    fetch: options.fetch || null,
    __ALBOT_BOOTSTRAP_AUTOSTART__: options.autoStart === true ? undefined : false,
    globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'al-bot-bootstrap.js' });
  return { context, api: context.__ALBOT_BOOTSTRAP__ };
}

function executableBundle(version) {
  const code = [
    `/* AL Bot ${version} | generated file | do not edit dist directly */`,
    `(function(root){`,
    `  let running = false;`,
    `  root.ALBot = {`,
    `    version: '${version}',`,
    `    start: async () => { running = true; return { running: true }; },`,
    `    status: () => ({ running, version: '${version}', bootCount: 1, modules: [], scheduler: { enabled: true } }),`,
    `    fullAutonomy: { start: () => ({ accepted: true }) }`,
    `  };`,
    `})(typeof globalThis !== 'undefined' ? globalThis : this);`
  ].join('\n');
  return code + '\n' + ' '.repeat(Math.max(0, 12000 - Buffer.byteLength(code, 'utf8')));
}

function manifestFor(version, body, overrides = {}) {
  const commitSha = overrides.commitSha || '1'.repeat(40);
  return {
    schemaVersion: 1,
    product: 'AL Bot',
    channel: 'stable',
    version,
    packageVersion: version.replace(/-h\d+$/, ''),
    commitSha,
    bundleUrl: `https://raw.githubusercontent.com/Riflex91/ALFinal/${commitSha}/dist/al-bot.js`,
    sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(body, 'utf8'),
    sourceRef: commitSha,
    releasedAt: '2026-09-28T10:00:00.000Z',
    minBootstrapVersion: '1.0.0',
    ...overrides
  };
}

test('H22 bootstrap is a small permanent loader and never contains an update poller', () => {
  assert.ok(Buffer.byteLength(source, 'utf8') < 25000);
  assert.match(source, /const BOOTSTRAP_VERSION = '1\.0\.0'/);
  assert.match(source, /release\/al-bot-release\.json/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /upload_code/);
  assert.doesNotMatch(source, /save_code/);
  assert.doesNotMatch(source, /load_code/);
});

test('H22 committed release manifest is valid before promotion and matches the candidate bundle after promotion', () => {
  const { api } = loadBootstrap();
  const manifest = JSON.parse(fs.readFileSync(new URL('../release/al-bot-release.json', import.meta.url), 'utf8'));
  const dist = fs.readFileSync(new URL('../dist/al-bot.js', import.meta.url), 'utf8');
  const checked = api.validateManifest(manifest);
  const candidateVersion = '0.26.8-h26';
  const candidatePackageVersion = '0.26.8';

  assert.equal(checked.ok, true);
  assert.equal(manifest.minBootstrapVersion, '1.0.0');
  assert.equal(manifest.commitSha, manifest.sourceRef);
  assert.equal(
    manifest.bundleUrl,
    'https://raw.githubusercontent.com/Riflex91/ALFinal/' + manifest.commitSha + '/dist/al-bot.js'
  );
  assert.match(dist, /^\/\* AL Bot 0\.26\.8-h26 \| generated file \| do not edit dist directly \*\//);

  if (manifest.version === candidateVersion) {
    assert.equal(manifest.packageVersion, candidatePackageVersion);
    assert.equal(manifest.bytes, Buffer.byteLength(dist, 'utf8'));
    assert.equal(manifest.sha256, crypto.createHash('sha256').update(dist, 'utf8').digest('hex'));
  } else {
    // During candidate CI the stable pointer intentionally remains on the last
    // verified release. Only the known previous stable release is accepted.
    assert.equal(manifest.version, '0.26.7-h26');
    assert.equal(manifest.packageVersion, '0.26.7');
  }
});

test('H22 bootstrap loads and verifies the official immutable release manifest', async () => {
  const body = executableBundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  let bundleFetches = 0;
  const { api } = loadBootstrap({
    fetch: async url => {
      assert.equal(String(url), manifest.bundleUrl);
      bundleFetches += 1;
      return { ok: true, status: 200, text: async () => body };
    }
  });

  const loaded = await api.loadRelease(manifest);
  assert.equal(bundleFetches, 1);
  assert.equal(loaded.manifest.version, manifest.version);
  assert.equal(loaded.manifest.commitSha, manifest.commitSha);
  assert.equal(loaded.manifest.bundleUrl, manifest.bundleUrl);
  assert.equal(loaded.bytes, manifest.bytes);
  assert.equal(loaded.sha256, manifest.sha256);
});

test('H22 bootstrap rejects non-GitHub hosts and mutable bundle URLs', () => {
  const body = executableBundle('0.22.4-h22');
  const { api } = loadBootstrap();

  const wrongHost = manifestFor('0.22.4-h22', body, {
    bundleUrl: 'https://example.com/1/dist/al-bot.js'
  });
  assert.equal(api.validateManifest(wrongHost).reason, 'BOOTSTRAP_MANIFEST_URL_NOT_GITHUB_RAW');

  const mutable = manifestFor('0.22.4-h22', body, {
    bundleUrl: 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/dist/al-bot.js'
  });
  assert.equal(api.validateManifest(mutable).reason, 'BOOTSTRAP_MANIFEST_BUNDLE_NOT_COMMIT_PINNED');
});

test('H22 bootstrap rejects SHA, byte and banner mismatches before execution', async () => {
  const good = executableBundle('0.22.4-h22');
  const { context, api } = loadBootstrap();

  const badSha = manifestFor('0.22.4-h22', good, { sha256: 'a'.repeat(64) });
  await assert.rejects(() => api.executeVerifiedRelease(badSha, good), /BOOTSTRAP_BUNDLE_SHA256_MISMATCH/);
  assert.equal(context.ALBot, undefined);

  const badBytes = manifestFor('0.22.4-h22', good, { bytes: Buffer.byteLength(good, 'utf8') + 1 });
  await assert.rejects(() => api.executeVerifiedRelease(badBytes, good), /BOOTSTRAP_BUNDLE_SIZE_MISMATCH/);
  assert.equal(context.ALBot, undefined);

  const wrongBannerBody = good.replace('/* AL Bot 0.22.4-h22', '/* AL Bot 9.9.9-h99');
  const wrongBannerManifest = manifestFor('0.22.4-h22', wrongBannerBody);
  await assert.rejects(() => api.executeVerifiedRelease(wrongBannerManifest, wrongBannerBody), /BOOTSTRAP_BUNDLE_SIGNATURE_INVALID/);
  assert.equal(context.ALBot, undefined);
});

test('H22 bootstrap restores candidate marker when verified execution itself throws', async () => {
  const throwing = '/* AL Bot 0.22.4-h22 | generated file | do not edit dist directly */\n'
    + '(function(){ throw new Error("BOOT_FAIL"); })();\n'
    + ' '.repeat(12000);
  const manifest = manifestFor('0.22.4-h22', throwing);
  const { api } = loadBootstrap();

  await assert.rejects(() => api.executeVerifiedRelease(manifest, throwing), /BOOT_FAIL/);
  assert.equal(api.candidateRelease(), null);
  assert.equal(api.activeRelease(), null);
});

test('H22 bootstrap enforces minBootstrapVersion', async () => {
  const body = executableBundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body, { minBootstrapVersion: '2.0.0' });
  const { api } = loadBootstrap();
  await assert.rejects(() => api.verifyRelease(manifest, body), /UPDATE_BOOTSTRAP_TOO_OLD/);
});

test('H22 bootstrap first start creates ALBot and starts the runtime without a pre-existing bot', async () => {
  const body = executableBundle('0.22.4-h22');
  const manifest = manifestFor('0.22.4-h22', body);
  const manifestUrl = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/release/al-bot-release.json';
  const { context, api } = loadBootstrap({
    fetch: async url => String(url) === manifestUrl
      ? { ok: true, status: 200, json: async () => manifest }
      : { ok: true, status: 200, text: async () => body }
  });

  assert.equal(context.ALBot, undefined);
  const result = await api.start();
  assert.equal(result.accepted, true);
  assert.equal(result.started, true);
  assert.equal(context.ALBot.version, '0.22.4-h22');
  assert.equal(context.ALBot.status().running, true);
  assert.equal(typeof context.ALBot.fullAutonomy.start, 'function');
  assert.equal(api.activeRelease().version, '0.22.4-h22');
  assert.equal(api.activeRelease().bundleUrl, manifest.bundleUrl);
});

test('H22 bootstrap does not independently check for updates once ALBot already exists', async () => {
  let fetches = 0;
  const { context, api } = loadBootstrap({
    fetch: async () => {
      fetches += 1;
      throw new Error('MUST_NOT_FETCH');
    }
  });
  context.ALBot = { version: '0.22.4-h22' };
  const result = await api.start();
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.reason, 'BOOTSTRAP_RUNTIME_ALREADY_PRESENT');
  assert.equal(fetches, 0);
});
