(function (root) {
  'use strict';

  const BOOTSTRAP_VERSION = '1.0.0';
  const PRODUCT = 'AL Bot';
  const CHANNEL = 'stable';
  const MANIFEST_URL = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/release/al-bot-release.json';
  const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
  const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;

  function clean(value, max = 300) {
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function versionParts(value) {
    return String(value || '').match(/\d+/g)?.map(Number) || [];
  }

  function compareVersions(a, b) {
    const aa = versionParts(a), bb = versionParts(b);
    const length = Math.max(aa.length, bb.length);
    for (let i = 0; i < length; i += 1) {
      const av = aa[i] || 0, bv = bb[i] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  }

  function utf8Bytes(text) {
    const Encoder = root && root.TextEncoder;
    if (typeof Encoder === 'function') return new Encoder().encode(String(text)).byteLength;
    return unescape(encodeURIComponent(String(text))).length;
  }

  async function sha256(text) {
    const crypto = root && root.crypto;
    const Encoder = root && root.TextEncoder;
    if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== 'function' || typeof Encoder !== 'function') {
      throw new Error('BOOTSTRAP_SHA256_UNAVAILABLE');
    }
    const bytes = new Encoder().encode(String(text));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function releaseKey(manifest) {
    return manifest && manifest.version && manifest.commitSha && manifest.sha256
      ? String(manifest.version) + '@' + String(manifest.commitSha).toLowerCase() + ':' + String(manifest.sha256).toLowerCase()
      : null;
  }

  function validateManifest(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'BOOTSTRAP_MANIFEST_REQUIRED' };
    if (raw.schemaVersion !== 1) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_SCHEMA_UNSUPPORTED' };
    if (String(raw.product || '') !== PRODUCT) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_PRODUCT_INVALID' };
    if (String(raw.channel || '') !== CHANNEL) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_CHANNEL_INVALID' };

    const version = clean(raw.version, 80);
    const commitSha = clean(raw.commitSha, 80).toLowerCase();
    const digest = clean(raw.sha256, 80).toLowerCase();
    const bytes = Math.floor(Number(raw.bytes) || 0);
    if (!version) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_VERSION_INVALID' };
    if (!/^[a-f0-9]{40}$/.test(commitSha)) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_COMMIT_SHA_INVALID' };
    if (!/^[a-f0-9]{64}$/.test(digest)) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_SHA256_INVALID' };
    if (bytes < 10000 || bytes > MAX_BUNDLE_BYTES) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_BYTES_INVALID' };

    const releasedAtMs = Date.parse(String(raw.releasedAt || ''));
    if (!Number.isFinite(releasedAtMs)) return { ok: false, reason: 'BOOTSTRAP_MANIFEST_RELEASED_AT_INVALID' };

    let bundleUrl;
    try { bundleUrl = new URL(String(raw.bundleUrl || '')); }
    catch (_) { return { ok: false, reason: 'BOOTSTRAP_MANIFEST_URL_INVALID' }; }
    if (bundleUrl.protocol !== 'https:' || bundleUrl.hostname !== 'raw.githubusercontent.com') {
      return { ok: false, reason: 'BOOTSTRAP_MANIFEST_URL_NOT_GITHUB_RAW' };
    }
    const expectedPath = '/Riflex91/ALFinal/' + commitSha + '/dist/al-bot.js';
    if (bundleUrl.pathname !== expectedPath || bundleUrl.search || bundleUrl.hash) {
      return { ok: false, reason: 'BOOTSTRAP_MANIFEST_BUNDLE_NOT_COMMIT_PINNED' };
    }

    const minBootstrapVersion = clean(raw.minBootstrapVersion || '', 80) || null;
    return {
      ok: true,
      manifest: {
        ...raw,
        schemaVersion: 1,
        product: PRODUCT,
        channel: CHANNEL,
        version,
        commitSha,
        sha256: digest,
        bytes,
        bundleUrl: bundleUrl.toString(),
        releasedAt: new Date(releasedAtMs).toISOString(),
        minBootstrapVersion
      }
    };
  }

  function assertBootstrapCompatible(manifest) {
    if (manifest.minBootstrapVersion && compareVersions(BOOTSTRAP_VERSION, manifest.minBootstrapVersion) < 0) {
      throw new Error('UPDATE_BOOTSTRAP_TOO_OLD');
    }
  }

  function manifestRequestUrl(url) {
    if (String(url) !== MANIFEST_URL) throw new Error('BOOTSTRAP_MANIFEST_URL_NOT_OFFICIAL');
    const request = new URL(MANIFEST_URL);
    request.searchParams.set('_albot_cb', String(Date.now()));
    return request.toString();
  }

  async function fetchJson(url) {
    if (!root || typeof root.fetch !== 'function') throw new Error('BOOTSTRAP_FETCH_UNAVAILABLE');
    const response = await root.fetch(manifestRequestUrl(url), { cache: 'no-store' });
    if (!response || response.ok !== true) throw new Error('BOOTSTRAP_MANIFEST_HTTP_' + String(response && response.status || 'FAILED'));
    return response.json();
  }

  async function fetchText(url) {
    if (!root || typeof root.fetch !== 'function') throw new Error('BOOTSTRAP_FETCH_UNAVAILABLE');
    const response = await root.fetch(url, { cache: 'no-store' });
    if (!response || response.ok !== true) throw new Error('BOOTSTRAP_BUNDLE_HTTP_' + String(response && response.status || 'FAILED'));
    return response.text();
  }

  async function verifyRelease(rawManifest, bundle) {
    const checked = validateManifest(rawManifest);
    if (!checked.ok) throw new Error(checked.reason);
    const manifest = checked.manifest;
    assertBootstrapCompatible(manifest);

    const actualBytes = utf8Bytes(bundle);
    if (actualBytes !== manifest.bytes || actualBytes > MAX_BUNDLE_BYTES) {
      throw new Error('BOOTSTRAP_BUNDLE_SIZE_MISMATCH');
    }
    const actualSha256 = await sha256(bundle);
    if (actualSha256 !== manifest.sha256) throw new Error('BOOTSTRAP_BUNDLE_SHA256_MISMATCH');

    const expectedBanner = '/* AL Bot ' + manifest.version + ' | generated file | do not edit dist directly */';
    if (!String(bundle).startsWith(expectedBanner + '\n')) throw new Error('BOOTSTRAP_BUNDLE_SIGNATURE_INVALID');

    return {
      manifest,
      bundle: String(bundle),
      releaseKey: releaseKey(manifest),
      bytes: actualBytes,
      sha256: actualSha256
    };
  }

  async function loadRelease(rawManifest) {
    const checked = validateManifest(rawManifest);
    if (!checked.ok) throw new Error(checked.reason);
    assertBootstrapCompatible(checked.manifest);
    const bundle = await fetchText(checked.manifest.bundleUrl);
    return verifyRelease(checked.manifest, bundle);
  }

  function activeRelease() {
    return clone(root && root.__ALBOT_ACTIVE_RELEASE__ || null);
  }

  function confirmActiveRelease(rawManifest) {
    const checked = validateManifest(rawManifest);
    if (!checked.ok) throw new Error(checked.reason);
    root.__ALBOT_ACTIVE_RELEASE__ = clone(checked.manifest);
    root.__ALBOT_CANDIDATE_RELEASE__ = null;
    return activeRelease();
  }

  function candidateRelease() {
    return clone(root && root.__ALBOT_CANDIDATE_RELEASE__ || null);
  }

  async function executeVerifiedRelease(rawManifest, bundle) {
    const verified = await verifyRelease(rawManifest, bundle);
    const previousCandidate = candidateRelease();
    root.__ALBOT_CANDIDATE_RELEASE__ = clone(verified.manifest);

    const Runner = root && root.Function || Function;
    if (typeof Runner !== 'function') {
      root.__ALBOT_CANDIDATE_RELEASE__ = previousCandidate;
      throw new Error('BOOTSTRAP_EXECUTION_UNAVAILABLE');
    }
    const source = verified.bundle + '\n//# sourceURL=al-bot-' + verified.manifest.commitSha + '.js';
    try {
      const fn = Runner(source);
      fn.call(root);
    } catch (error) {
      root.__ALBOT_CANDIDATE_RELEASE__ = previousCandidate;
      throw error;
    }
    return {
      executed: true,
      manifest: clone(verified.manifest),
      releaseKey: verified.releaseKey,
      previousRelease: activeRelease()
    };
  }

  function sleep(ms) {
    const timer = root && root.setTimeout || setTimeout;
    return new Promise(resolve => timer(resolve, ms));
  }

  async function waitHandshake(previousApi, version, timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_HANDSHAKE_TIMEOUT_MS);
    let last = 'ALBOT_MISSING';
    while (Date.now() < deadline) {
      const api = root && root.ALBot;
      if (!api) {
        last = 'ALBOT_MISSING';
      } else if (api === previousApi) {
        last = 'OLD_API_STILL_ACTIVE';
      } else if (String(api.version || '') !== String(version || '')) {
        last = 'VERSION_MISMATCH';
      } else {
        try {
          let status = typeof api.status === 'function' ? api.status() : null;
          if (status && status.running !== true && typeof api.start === 'function') {
            await api.start();
            status = typeof api.status === 'function' ? api.status() : status;
          }
          if (!status || status.running !== true) last = 'RUNTIME_NOT_RUNNING';
          else if (String(status.version || '') !== String(version || '')) last = 'STATUS_VERSION_MISMATCH';
          else if (!api.fullAutonomy || typeof api.fullAutonomy.start !== 'function') last = 'FULL_AUTONOMY_API_MISSING';
          else return { ok: true, version, status: clone(status) };
        } catch (_) {
          last = 'STATUS_FAILED';
        }
      }
      await sleep(100);
    }
    return { ok: false, reason: last };
  }

  async function start() {
    if (root && root.ALBot) {
      return {
        accepted: true,
        alreadyRunning: true,
        reason: 'BOOTSTRAP_RUNTIME_ALREADY_PRESENT',
        activeRelease: activeRelease()
      };
    }

    const rawManifest = await fetchJson(MANIFEST_URL);
    const checked = validateManifest(rawManifest);
    if (!checked.ok) throw new Error(checked.reason);
    assertBootstrapCompatible(checked.manifest);

    const verified = await loadRelease(checked.manifest);
    const previousApi = root && root.ALBot || null;
    await executeVerifiedRelease(verified.manifest, verified.bundle);
    const handshake = await waitHandshake(previousApi, verified.manifest.version);
    if (!handshake.ok) throw new Error('BOOTSTRAP_HANDSHAKE_FAILED:' + handshake.reason);

    confirmActiveRelease(verified.manifest);
    return {
      accepted: true,
      started: true,
      version: verified.manifest.version,
      releaseKey: verified.releaseKey,
      handshake
    };
  }

  const api = Object.freeze({
    product: PRODUCT,
    version: BOOTSTRAP_VERSION,
    manifestUrl: MANIFEST_URL,
    compareVersions,
    validateManifest,
    verifyRelease,
    loadRelease,
    executeVerifiedRelease,
    waitHandshake,
    activeRelease,
    candidateRelease,
    confirmActiveRelease,
    start
  });

  root.__ALBOT_BOOTSTRAP__ = api;
  if (!root.ALBot && root.__ALBOT_BOOTSTRAP_AUTOSTART__ !== false) {
    root.__ALBOT_BOOTSTRAP_READY__ = start().catch(error => {
      try { if (root && typeof root.game_log === 'function') root.game_log('AL Bot Bootstrap: ' + String(error && error.message || error), '#ff6b6b'); } catch (_) {}
      throw error;
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
