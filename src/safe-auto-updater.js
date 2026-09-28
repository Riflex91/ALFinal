(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__ = root.__ALBOT_INTERNALS__ || {};

  const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/release/al-bot-release.json';
  const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const DEFAULT_APPLY_INTERVAL_MS = 1000;
  const DEFAULT_SAFE_HOLD_MS = 8000;
  const DEFAULT_MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
  const DEFAULT_HANDSHAKE_TIMEOUT_MS = 12000;
  const DEFAULT_RETRY_BASE_MS = 5 * 60 * 1000;
  const DEFAULT_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
  const DEFAULT_GROUP_APPLY_DELAY_MS = 8000;
  const DEFAULT_COORDINATION_RETRY_MS = 5000;
  const UPDATE_COORDINATION_PROTOCOL = 'h22-synchronized-update-v1';
  const PENDING_KEY = 'albot:auto-update:pending:v1';
  const QUARANTINE_KEY = 'albot:auto-update:quarantine:v1';

  function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clean(value, max = 300) {
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
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

  function validSha256(value) {
    return /^[a-f0-9]{64}$/i.test(String(value || ''));
  }

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'UPDATE_MANIFEST_REQUIRED' };
    if (manifest.schemaVersion !== 1) return { ok: false, reason: 'UPDATE_MANIFEST_SCHEMA_UNSUPPORTED' };
    if (String(manifest.product || '') !== 'AL Bot') return { ok: false, reason: 'UPDATE_MANIFEST_PRODUCT_INVALID' };
    if (String(manifest.channel || '') !== 'stable') return { ok: false, reason: 'UPDATE_MANIFEST_CHANNEL_INVALID' };

    const version = clean(manifest.version, 80);
    if (!version) return { ok: false, reason: 'UPDATE_MANIFEST_VERSION_INVALID' };
    const commitSha = clean(manifest.commitSha, 80).toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(commitSha)) return { ok: false, reason: 'UPDATE_MANIFEST_COMMIT_SHA_INVALID' };
    if (!validSha256(manifest.sha256)) return { ok: false, reason: 'UPDATE_MANIFEST_SHA256_INVALID' };

    const bytes = Math.floor(finite(manifest.bytes, 0));
    if (bytes < 10000 || bytes > DEFAULT_MAX_BUNDLE_BYTES) return { ok: false, reason: 'UPDATE_MANIFEST_BYTES_INVALID' };

    const releasedAtMs = Date.parse(String(manifest.releasedAt || ''));
    if (!Number.isFinite(releasedAtMs)) return { ok: false, reason: 'UPDATE_MANIFEST_RELEASED_AT_INVALID' };

    let url;
    try { url = new URL(String(manifest.bundleUrl || '')); } catch (_) { return { ok: false, reason: 'UPDATE_MANIFEST_URL_INVALID' }; }
    if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com') {
      return { ok: false, reason: 'UPDATE_MANIFEST_URL_NOT_GITHUB_RAW' };
    }
    const expectedPath = '/Riflex91/ALFinal/' + commitSha + '/dist/al-bot.js';
    if (url.pathname !== expectedPath || url.search || url.hash) {
      return { ok: false, reason: 'UPDATE_MANIFEST_BUNDLE_NOT_COMMIT_PINNED' };
    }

    const minBootstrapVersion = clean(manifest.minBootstrapVersion || '', 80) || null;
    return {
      ok: true,
      manifest: {
        ...manifest,
        version,
        commitSha,
        bytes,
        sha256: String(manifest.sha256).toLowerCase(),
        bundleUrl: url.toString(),
        releasedAt: new Date(releasedAtMs).toISOString(),
        minBootstrapVersion
      }
    };
  }

  class SafeAutoUpdater {
    constructor(options = {}) {
      this.runtime = options.runtime;
      if (!this.runtime) throw new Error('SAFE_UPDATER_RUNTIME_REQUIRED');
      this.root = options.root || this.runtime.root || root;
      this.logger = options.logger || this.runtime.logger || null;
      this.storage = options.storage || this.runtime.storage || null;
      this.fetchFn = options.fetch || this.root && this.root.fetch || null;
      this.sha256Fn = options.sha256 || null;
      const globalConfig = this.root && this.root.__ALBOT_AUTO_UPDATE_CONFIG__ && typeof this.root.__ALBOT_AUTO_UPDATE_CONFIG__ === 'object'
        ? this.root.__ALBOT_AUTO_UPDATE_CONFIG__
        : {};
      this.config = {
        enabled: globalConfig.enabled !== false,
        manifestUrl: clean(globalConfig.manifestUrl || DEFAULT_MANIFEST_URL, 900),
        checkIntervalMs: Math.max(60000, finite(globalConfig.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS)),
        applyIntervalMs: Math.max(500, finite(globalConfig.applyIntervalMs, DEFAULT_APPLY_INTERVAL_MS)),
        safeHoldMs: Math.max(3000, finite(globalConfig.safeHoldMs, DEFAULT_SAFE_HOLD_MS)),
        maxBundleBytes: Math.max(250000, finite(globalConfig.maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES)),
        handshakeTimeoutMs: Math.max(3000, finite(globalConfig.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS)),
        retryBaseMs: Math.max(60000, finite(globalConfig.retryBaseMs, DEFAULT_RETRY_BASE_MS)),
        retryMaxMs: Math.max(5 * 60000, finite(globalConfig.retryMaxMs, DEFAULT_RETRY_MAX_MS)),
        groupApplyDelayMs: Math.max(6000, finite(globalConfig.groupApplyDelayMs, DEFAULT_GROUP_APPLY_DELAY_MS)),
        coordinationRetryMs: Math.max(2000, finite(globalConfig.coordinationRetryMs, DEFAULT_COORDINATION_RETRY_MS)),
        autoDownload: globalConfig.autoDownload !== false,
        autoApply: globalConfig.autoApply !== false,
        coordinatedApply: globalConfig.coordinatedApply !== false,
        stagingSlots: Array.isArray(globalConfig.stagingSlots)
          ? [...new Set(globalConfig.stagingSlots.map(value => String(value)).filter(Boolean))].slice(0, 4)
          : []
      };
      this.active = false;
      this.busy = false;
      this.safeSince = 0;
      this.pending = null;
      this.quarantine = {};
      this.lastCheckAt = 0;
      this.lastSuccessAt = null;
      this.lastError = null;
      this.lastSafety = { safe: false, reasons: ['NOT_EVALUATED'] };
      this.lastApply = null;
      this.lastIncident = null;
      this.preparedUpdate = null;
      this.rolloutTimer = null;
      this.coordinationRetryAtMs = 0;
      this.lastCoordination = null;
      this.stats = {
        checks: 0,
        updatesFound: 0,
        downloads: 0,
        verifiedDownloads: 0,
        hashRejects: 0,
        safeDeferrals: 0,
        applies: 0,
        reloads: 0,
        rollbacks: 0,
        rollbackFailures: 0,
        rearms: 0,
        quarantines: 0,
        groupPrepares: 0,
        groupCommits: 0,
        groupCancels: 0,
        groupDeferrals: 0,
        coordinationFailures: 0,
        failures: 0
      };
      this._loadPending();
      this._loadQuarantine();
    }

    _log(level, message, details) {
      if (!this.logger || typeof this.logger[level] !== 'function') return;
      try { this.logger[level](message, details || null); } catch (_) {}
    }

    configure(value = {}) {
      if (Object.prototype.hasOwnProperty.call(value, 'enabled')) this.config.enabled = value.enabled === true;
      if (Object.prototype.hasOwnProperty.call(value, 'autoDownload')) this.config.autoDownload = value.autoDownload === true;
      if (Object.prototype.hasOwnProperty.call(value, 'autoApply')) this.config.autoApply = value.autoApply === true;
      if (value.checkIntervalMs != null) this.config.checkIntervalMs = Math.max(60000, finite(value.checkIntervalMs, this.config.checkIntervalMs));
      if (value.applyIntervalMs != null) this.config.applyIntervalMs = Math.max(500, finite(value.applyIntervalMs, this.config.applyIntervalMs));
      if (value.safeHoldMs != null) this.config.safeHoldMs = Math.max(3000, finite(value.safeHoldMs, this.config.safeHoldMs));
      if (value.handshakeTimeoutMs != null) this.config.handshakeTimeoutMs = Math.max(3000, finite(value.handshakeTimeoutMs, this.config.handshakeTimeoutMs));
      if (value.retryBaseMs != null) this.config.retryBaseMs = Math.max(60000, finite(value.retryBaseMs, this.config.retryBaseMs));
      if (value.retryMaxMs != null) this.config.retryMaxMs = Math.max(this.config.retryBaseMs, finite(value.retryMaxMs, this.config.retryMaxMs));
      if (value.groupApplyDelayMs != null) this.config.groupApplyDelayMs = Math.max(6000, finite(value.groupApplyDelayMs, this.config.groupApplyDelayMs));
      if (value.coordinationRetryMs != null) this.config.coordinationRetryMs = Math.max(2000, finite(value.coordinationRetryMs, this.config.coordinationRetryMs));
      if (Object.prototype.hasOwnProperty.call(value, 'coordinatedApply')) this.config.coordinatedApply = value.coordinatedApply !== false;
      if (Array.isArray(value.stagingSlots)) {
        this.config.stagingSlots = [...new Set(value.stagingSlots.map(item => String(item)).filter(Boolean))].slice(0, 4);
      }
      return this.status();
    }

    _loadPending() {
      if (!this.storage) return;
      try {
        const raw = this.storage.get(PENDING_KEY);
        const row = raw ? JSON.parse(raw) : null;
        if (row && row.manifest) {
          this.pending = {
            downloadedAt: row.downloadedAt || null,
            manifest: row.manifest,
            bundle: null
          };
        }
      } catch (_) {}
    }

    _persistPending() {
      if (!this.storage) return;
      try {
        if (!this.pending) {
          this.storage.remove(PENDING_KEY);
        } else {
          this.storage.set(PENDING_KEY, JSON.stringify({
            downloadedAt: this.pending.downloadedAt || null,
            manifest: clone(this.pending.manifest)
          }));
        }
      } catch (_) {}
    }

    _bootstrap() {
      const api = this.root && this.root.__ALBOT_BOOTSTRAP__;
      if (!api || String(api.product || '') !== 'AL Bot') return null;
      return api;
    }

    _bootstrapCompatibility(manifest) {
      const bootstrap = this._bootstrap();
      if (!bootstrap) return { ok: false, reason: 'UPDATE_BOOTSTRAP_UNAVAILABLE' };
      for (const method of ['loadRelease', 'executeVerifiedRelease', 'confirmActiveRelease', 'activeRelease']) {
        if (typeof bootstrap[method] !== 'function') {
          return { ok: false, reason: 'UPDATE_BOOTSTRAP_API_INCOMPLETE:' + method };
        }
      }
      const version = clean(bootstrap.version || '', 80);
      if (!version) return { ok: false, reason: 'UPDATE_BOOTSTRAP_VERSION_UNKNOWN' };
      if (manifest && manifest.minBootstrapVersion
          && compareVersions(version, manifest.minBootstrapVersion) < 0) {
        return {
          ok: false,
          reason: 'UPDATE_BOOTSTRAP_TOO_OLD',
          bootstrapVersion: version,
          minBootstrapVersion: manifest.minBootstrapVersion
        };
      }
      return { ok: true, bootstrap, version };
    }

    _loadQuarantine() {
      if (!this.storage) return;
      try {
        const raw = this.storage.get(QUARANTINE_KEY);
        const row = raw ? JSON.parse(raw) : null;
        this.quarantine = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
      } catch (_) {
        this.quarantine = {};
      }
    }

    _persistQuarantine() {
      if (!this.storage) return;
      try {
        const keys = Object.keys(this.quarantine || {});
        if (!keys.length) this.storage.remove(QUARANTINE_KEY);
        else this.storage.set(QUARANTINE_KEY, JSON.stringify(this.quarantine));
      } catch (_) {}
    }

    _releaseKey(manifest) {
      return manifest && manifest.version && manifest.commitSha && manifest.sha256
        ? String(manifest.version) + '@' + String(manifest.commitSha) + ':' + String(manifest.sha256)
        : null;
    }

    _quarantineState(manifest) {
      const key = this._releaseKey(manifest);
      const row = key && this.quarantine && this.quarantine[key];
      const now = Date.now();
      if (!row) return { key, blocked: false, row: null };
      const retryAtMs = finite(row.retryAtMs, 0);
      return { key, blocked: retryAtMs > now, row: clone(row), retryAtMs };
    }

    _recordReleaseFailure(manifest, reason, details = {}) {
      const key = this._releaseKey(manifest);
      if (!key) return null;
      const previous = this.quarantine[key] || {};
      const failures = Math.max(0, Math.floor(finite(previous.failures, 0))) + 1;
      const delayMs = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * Math.pow(2, Math.max(0, failures - 1)));
      const retryAtMs = Date.now() + delayMs;
      const row = {
        version: manifest.version,
        commitSha: manifest.commitSha,
        sha256: manifest.sha256,
        bytes: Math.floor(finite(manifest.bytes, 0)),
        bundleUrl: clean(manifest.bundleUrl || '', 900) || null,
        failures,
        retryAtMs,
        retryAt: new Date(retryAtMs).toISOString(),
        lastFailedAt: new Date().toISOString(),
        reason: clean(reason, 240)
      };
      this.quarantine[key] = row;
      this.stats.quarantines += 1;
      this._persistQuarantine();
      this._emitIncident('UPDATE_RELEASE_QUARANTINED', { ...details, quarantine: clone(row) });
      return row;
    }

    _clearReleaseFailure(manifest) {
      const key = this._releaseKey(manifest);
      if (!key || !this.quarantine[key]) return false;
      delete this.quarantine[key];
      this._persistQuarantine();
      return true;
    }

    _emitIncident(type, details = {}) {
      this.lastIncident = {
        at: new Date().toISOString(),
        type: clean(type, 120),
        details: clone(details)
      };
      try {
        if (this.runtime && this.runtime.bus && typeof this.runtime.bus.emit === 'function') {
          this.runtime.bus.emit('h22-update-incident', clone(this.lastIncident));
        }
      } catch (_) {}
      this._log('warn', 'H22 Update Incident', this.lastIncident);
      return clone(this.lastIncident);
    }

    async start(context) {
      if (this.active) return this.status();
      this.active = true;
      if (context && context.scope && typeof context.scope.interval === 'function') {
        context.scope.interval('update-check', () => {
          Promise.resolve(this.checkAndDownload()).catch(error => {
            this.stats.failures += 1;
            this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
          });
        }, this.config.checkIntervalMs, { immediate: true });
        context.scope.interval('update-apply', () => {
          if (!this.config.autoApply || this.busy) return;
          if (!this.pending) this._loadPending();
          if (!this.pending) return;
          Promise.resolve(this.applyPending()).catch(error => {
            this.stats.failures += 1;
            this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
          });
        }, this.config.applyIntervalMs);
      }
      return this.status();
    }

    stop() {
      this.active = false;
      if (this.rolloutTimer != null) {
        try {
          const clear = this.root && this.root.clearTimeout || clearTimeout;
          clear(this.rolloutTimer);
        } catch (_) {}
      }
      this.rolloutTimer = null;
      this.preparedUpdate = null;
      return this.status();
    }

    async _fetchJson(url) {
      if (typeof this.fetchFn !== 'function') throw new Error('UPDATE_FETCH_UNAVAILABLE');
      const response = await this.fetchFn.call(this.root, url, { cache: 'no-store' });
      if (!response || response.ok !== true) throw new Error('UPDATE_HTTP_' + String(response && response.status || 'FAILED'));
      return response.json();
    }

    async _fetchText(url) {
      if (typeof this.fetchFn !== 'function') throw new Error('UPDATE_FETCH_UNAVAILABLE');
      const response = await this.fetchFn.call(this.root, url, { cache: 'no-store' });
      if (!response || response.ok !== true) throw new Error('UPDATE_HTTP_' + String(response && response.status || 'FAILED'));
      return response.text();
    }

    async _sha256(text) {
      if (typeof this.sha256Fn === 'function') return String(await this.sha256Fn(String(text))).toLowerCase();
      const crypto = this.root && this.root.crypto;
      const Encoder = this.root && this.root.TextEncoder;
      if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== 'function' || typeof Encoder !== 'function') {
        throw new Error('UPDATE_SHA256_UNAVAILABLE');
      }
      const bytes = new Encoder().encode(String(text));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    }

    _utf8Bytes(text) {
      const Encoder = this.root && this.root.TextEncoder;
      if (typeof Encoder === 'function') return new Encoder().encode(String(text)).byteLength;
      return unescape(encodeURIComponent(String(text))).length;
    }

    async checkAndDownload() {
      if (!this.config.enabled) return { accepted: false, reason: 'UPDATE_DISABLED' };
      if (this.busy) return { accepted: false, reason: 'UPDATE_BUSY' };
      this.busy = true;
      this.stats.checks += 1;
      this.lastCheckAt = Date.now();
      try {
        const rawManifest = await this._fetchJson(this.config.manifestUrl);
        const checked = validateManifest(rawManifest);
        if (!checked.ok) throw new Error(checked.reason);
        const manifest = checked.manifest;
        const bootstrapCheck = this._bootstrapCompatibility(manifest);
        if (!bootstrapCheck.ok) throw new Error(bootstrapCheck.reason);
        if (compareVersions(manifest.version, this.runtime.version) <= 0) {
          if (this.pending && compareVersions(this.pending.manifest.version, this.runtime.version) <= 0) {
            this.pending = null;
            this._persistPending();
          }
          this.lastError = null;
          return { accepted: true, updateAvailable: false, localVersion: this.runtime.version, remoteVersion: manifest.version };
        }

        this.stats.updatesFound += 1;
        const quarantine = this._quarantineState(manifest);
        if (quarantine.blocked) {
          return {
            accepted: false,
            reason: 'UPDATE_RELEASE_QUARANTINED',
            retryAt: quarantine.row && quarantine.row.retryAt || null,
            manifest: clone(manifest)
          };
        }
        if (!this.config.autoDownload) {
          return { accepted: true, updateAvailable: true, downloaded: false, manifest: clone(manifest) };
        }

        if (this.pending && this.pending.manifest && this.pending.manifest.version === manifest.version
            && this.pending.manifest.sha256 === manifest.sha256 && typeof this.pending.bundle === 'string') {
          return { accepted: true, updateAvailable: true, downloaded: true, cached: true, manifest: clone(manifest) };
        }

        const bundle = await this._fetchText(manifest.bundleUrl);
        this.stats.downloads += 1;
        const bytes = this._utf8Bytes(bundle);
        if (bytes !== manifest.bytes || bytes > this.config.maxBundleBytes) throw new Error('UPDATE_BUNDLE_SIZE_MISMATCH');
        const sha256 = await this._sha256(bundle);
        if (sha256 !== manifest.sha256) {
          this.stats.hashRejects += 1;
          throw new Error('UPDATE_BUNDLE_SHA256_MISMATCH');
        }
        const expectedBanner = '/* AL Bot ' + String(manifest.version) + ' | generated file | do not edit dist directly */';
        if (!String(bundle).startsWith(expectedBanner + '\n')) throw new Error('UPDATE_BUNDLE_SIGNATURE_INVALID');

        this.pending = {
          downloadedAt: new Date().toISOString(),
          manifest: clone(manifest),
          bundle
        };
        this._persistPending();
        this.stats.verifiedDownloads += 1;
        this.lastSuccessAt = new Date().toISOString();
        this.lastError = null;
        this._log('info', 'H22 GitHub-Update verifiziert und lokal vorgeladen', {
          from: this.runtime.version,
          to: manifest.version,
          bytes,
          sha256
        });
        return { accepted: true, updateAvailable: true, downloaded: true, verified: true, manifest: clone(manifest) };
      } catch (error) {
        this.stats.failures += 1;
        this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
        this._log('warn', 'H22 GitHub-Update-Prüfung fehlgeschlagen', this.lastError);
        return { accepted: false, reason: this.lastError.reason };
      } finally {
        this.busy = false;
      }
    }

    localProtection() {
      const now = Date.now();
      const read = controller => {
        try { return controller && typeof controller.status === 'function' ? controller.status() : null; }
        catch (_) { return null; }
      };

      let game = null;
      try { game = this.runtime.game && typeof this.runtime.game.snapshot === 'function' ? this.runtime.game.snapshot() : null; }
      catch (_) {}
      const character = game && game.character || null;
      const localName = clean(character && character.name || '', 120) || null;

      const full = read(this.runtime.fullAutonomy);
      const taskType = full && full.enabled === true
        ? clean(full.config && full.config.taskType || '', 40).toUpperCase() || null
        : null;
      const event = taskType === 'EVENT';

      const combat = read(this.runtime.combat);
      const combatSession = combat && combat.session || null;
      const targetType = clean(
        combatSession && combatSession.targetType
          || game && game.target && game.target.mtype
          || '',
        120
      ) || null;

      let boss = taskType === 'BOSS' && !!(combat && combat.active === true);
      if (!boss && targetType) {
        try {
          const definition = this.runtime.game && typeof this.runtime.game.monsterDefinition === 'function'
            ? this.runtime.game.monsterDefinition(targetType)
            : null;
          const engaged = !!(
            combat && combat.active === true
            || character && character.targetId
            || game && game.target && game.target.targetId && localName
              && String(game.target.targetId) === String(localName)
          );
          if (definition && definition.boss === true && engaged) boss = true;
        } catch (_) {}
      }

      const reasons = [];
      if (event) reasons.push('EVENT_ACTIVE');
      if (boss) reasons.push('BOSS_COMBAT_ACTIVE');
      return {
        schemaVersion: 1,
        protocol: UPDATE_COORDINATION_PROTOCOL,
        coordinatedUpdateCapable: true,
        observedAtMs: now,
        characterName: localName,
        blocked: event || boss,
        event,
        boss,
        taskType,
        targetType,
        reasons
      };
    }

    safety() {
      const protection = this.localProtection();
      const reasons = [];
      if (!this.runtime.running) reasons.push('RUNTIME_NOT_RUNNING');
      if (this.runtime.stopLatch && this.runtime.stopLatch.status().latched) reasons.push('EMERGENCY_STOP_LATCHED');
      if (!protection.characterName) reasons.push('CHARACTER_UNKNOWN');
      if (protection.event) reasons.push('EVENT_ACTIVE');
      if (protection.boss) reasons.push('BOSS_COMBAT_ACTIVE');

      const safe = reasons.length === 0;
      const now = Date.now();
      if (safe) {
        if (!this.safeSince) this.safeSince = now;
      } else {
        this.safeSince = 0;
      }
      this.lastSafety = {
        at: new Date(now).toISOString(),
        safe,
        stable: safe,
        reasons,
        protection
      };
      return clone(this.lastSafety);
    }

    _releaseDescriptor(manifest) {
      return manifest ? {
        version: clean(manifest.version || '', 80),
        commitSha: clean(manifest.commitSha || '', 80).toLowerCase(),
        sha256: clean(manifest.sha256 || '', 80).toLowerCase(),
        bytes: Math.floor(finite(manifest.bytes, 0)),
        bundleUrl: clean(manifest.bundleUrl || '', 900)
      } : null;
    }

    _releaseMatches(manifest, release) {
      if (!manifest || !release) return false;
      const local = this._releaseDescriptor(manifest);
      return !!local
        && local.version === clean(release.version || '', 80)
        && local.commitSha === clean(release.commitSha || '', 80).toLowerCase()
        && local.sha256 === clean(release.sha256 || '', 80).toLowerCase()
        && local.bytes === Math.floor(finite(release.bytes, 0))
        && local.bundleUrl === clean(release.bundleUrl || '', 900);
    }

    _localName() {
      const protection = this.localProtection();
      return protection.characterName || null;
    }

    _groupState() {
      const local = this.localProtection();
      const localName = local.characterName;
      const transport = this.runtime.lifecycleTransport;
      let peers = [];
      try {
        peers = transport && typeof transport.freshPeers === 'function' ? transport.freshPeers() : [];
      } catch (_) {
        peers = [];
      }
      const peerMap = new Map(peers.filter(Boolean).map(peer => [String(peer.name || ''), peer]));

      let online = [];
      try {
        const roster = this.runtime.roster && typeof this.runtime.roster.refresh === 'function'
          ? this.runtime.roster.refresh()
          : null;
        if (roster && roster.onlineStateAvailable === true && Array.isArray(roster.onlineCharacterNames)) {
          online = roster.onlineCharacterNames.map(String);
        }
      } catch (_) {}
      if (!online.length) online = [localName, ...peers.map(peer => peer && peer.name)].filter(Boolean).map(String);

      const participants = [...new Set(online.filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (localName && !participants.includes(String(localName))) participants.push(String(localName));
      participants.sort((a, b) => a.localeCompare(b));

      const reasons = [];
      if (!localName) reasons.push('UPDATE_GROUP_LOCAL_IDENTITY_REQUIRED');
      if (local.blocked) reasons.push(...local.reasons.map(reason => 'LOCAL_' + reason));

      for (const name of participants) {
        if (String(name) === String(localName || '')) continue;
        const peer = peerMap.get(String(name));
        if (!peer) {
          reasons.push('UPDATE_GROUP_PEER_NOT_FRESH:' + name);
          continue;
        }
        if (peer.running !== true) reasons.push('UPDATE_GROUP_PEER_RUNTIME_NOT_RUNNING:' + name);
        if (peer.emergencyStopLatched === true) reasons.push('UPDATE_GROUP_PEER_EMERGENCY_STOP:' + name);
        if (peer.version && String(peer.version) !== String(this.runtime.version)) {
          reasons.push('UPDATE_GROUP_PEER_VERSION_MISMATCH:' + name);
        }
        const protection = peer.updateProtection;
        if (!protection || protection.coordinatedUpdateCapable !== true) {
          reasons.push('UPDATE_GROUP_PEER_CAPABILITY_MISSING:' + name);
          continue;
        }
        if (protection.event === true) reasons.push('REMOTE_EVENT_ACTIVE:' + name);
        if (protection.boss === true) reasons.push('REMOTE_BOSS_COMBAT_ACTIVE:' + name);
      }

      const coordinator = participants.length ? participants[0] : localName;
      return {
        ready: reasons.length === 0,
        localName,
        coordinator,
        participants,
        peers: peers.map(peer => ({
          name: peer.name,
          running: peer.running === true,
          version: peer.version || null,
          updateProtection: clone(peer.updateProtection || null)
        })),
        localProtection: local,
        reasons
      };
    }

    async _verifyPendingForRelease(release) {
      if (!this.pending) this._loadPending();
      if (!this.pending || !this.pending.manifest || !this._releaseMatches(this.pending.manifest, release)
          || typeof this.pending.bundle !== 'string') {
        const checked = await this.checkAndDownload();
        if (!checked || checked.accepted !== true) {
          return { ok: false, reason: checked && checked.reason || 'UPDATE_GROUP_DOWNLOAD_FAILED' };
        }
      }
      if (!this.pending || !this.pending.manifest || !this._releaseMatches(this.pending.manifest, release)
          || typeof this.pending.bundle !== 'string') {
        return { ok: false, reason: 'UPDATE_GROUP_RELEASE_MISMATCH' };
      }

      const manifestCheck = validateManifest(this.pending.manifest);
      if (!manifestCheck.ok) return { ok: false, reason: manifestCheck.reason };
      const manifest = manifestCheck.manifest;
      const bootstrapCheck = this._bootstrapCompatibility(manifest);
      if (!bootstrapCheck.ok) return { ok: false, reason: bootstrapCheck.reason };

      const bytes = this._utf8Bytes(this.pending.bundle);
      const sha256 = await this._sha256(this.pending.bundle);
      const expectedBanner = '/* AL Bot ' + String(manifest.version) + ' | generated file | do not edit dist directly */';
      if (bytes !== manifest.bytes || bytes > this.config.maxBundleBytes || sha256 !== manifest.sha256
          || !String(this.pending.bundle).startsWith(expectedBanner + '\n')) {
        return { ok: false, reason: 'UPDATE_PENDING_REVALIDATION_FAILED', bytes, sha256 };
      }

      const safety = this.safety();
      if (!safety.safe) return { ok: false, reason: 'UPDATE_EVENT_OR_BOSS_ACTIVE', safety };

      return {
        ok: true,
        manifest,
        bytes,
        sha256,
        bundleUrl: manifest.bundleUrl,
        cachedInWindow: true
      };
    }

    async prepareCoordinatedUpdate(payload = {}, meta = {}) {
      if (!this.config.enabled) return { accepted: false, reason: 'UPDATE_DISABLED' };
      if (!this.config.autoApply) return { accepted: false, reason: 'UPDATE_AUTO_APPLY_DISABLED' };
      if (!this.config.coordinatedApply) return { accepted: false, reason: 'UPDATE_GROUP_COORDINATION_DISABLED' };
      if (this.busy) return { accepted: false, reason: 'UPDATE_BUSY' };

      const release = payload && payload.release || null;
      const releaseKey = clean(payload && payload.releaseKey || '', 300);
      const expectedKey = release && release.version && release.commitSha && release.sha256
        ? String(release.version) + '@' + String(release.commitSha).toLowerCase() + ':' + String(release.sha256).toLowerCase()
        : null;
      if (!release || !releaseKey || releaseKey !== expectedKey) return { accepted: false, reason: 'UPDATE_GROUP_RELEASE_INVALID' };

      const coordinator = clean(payload.coordinator || '', 120);
      const sender = clean(meta && meta.sender || '', 120);
      if (!coordinator) return { accepted: false, reason: 'UPDATE_GROUP_COORDINATOR_REQUIRED' };
      if (sender && sender !== coordinator) return { accepted: false, reason: 'UPDATE_GROUP_COORDINATOR_MISMATCH' };

      const participants = Array.isArray(payload.participants)
        ? [...new Set(payload.participants.map(value => clean(value, 120)).filter(Boolean))].sort((a, b) => a.localeCompare(b))
        : [];
      const localName = this._localName();
      if (!localName || !participants.includes(localName)) return { accepted: false, reason: 'UPDATE_GROUP_LOCAL_NOT_PARTICIPANT' };

      if (this.preparedUpdate && this.preparedUpdate.releaseKey !== releaseKey) {
        return { accepted: false, reason: 'UPDATE_GROUP_DIFFERENT_RELEASE_ALREADY_PREPARED' };
      }

      const ready = await this._verifyPendingForRelease(release);
      if (!ready.ok) return { accepted: false, reason: ready.reason, details: clone(ready) };

      this.preparedUpdate = {
        protocol: UPDATE_COORDINATION_PROTOCOL,
        state: 'PREPARED',
        releaseKey,
        release: clone(release),
        coordinator,
        participants,
        localName,
        cachedInWindow: ready.cachedInWindow === true,
        bytes: ready.bytes,
        sha256: ready.sha256,
        bundleUrl: ready.bundleUrl,
        rearmIntent: this._captureRearmIntent(),
        preparedAt: new Date().toISOString(),
        preparedAtMs: Date.now(),
        applyAt: null,
        applyAtMs: null
      };
      this.stats.groupPrepares += 1;
      return {
        accepted: true,
        state: 'PREPARED',
        releaseKey,
        localName,
        cachedInWindow: ready.cachedInWindow === true,
        bytes: ready.bytes,
        sha256: ready.sha256,
        bundleUrl: ready.bundleUrl
      };
    }

    commitCoordinatedUpdate(payload = {}, meta = {}) {
      const releaseKey = clean(payload && payload.releaseKey || '', 300);
      const coordinator = clean(payload && payload.coordinator || '', 120);
      const sender = clean(meta && meta.sender || '', 120);
      if (!this.preparedUpdate || this.preparedUpdate.state !== 'PREPARED') {
        return { accepted: false, reason: 'UPDATE_GROUP_NOT_PREPARED' };
      }
      if (!releaseKey || this.preparedUpdate.releaseKey !== releaseKey) {
        return { accepted: false, reason: 'UPDATE_GROUP_RELEASE_MISMATCH' };
      }
      if (!coordinator || coordinator !== this.preparedUpdate.coordinator) {
        return { accepted: false, reason: 'UPDATE_GROUP_COORDINATOR_MISMATCH' };
      }
      if (sender && sender !== coordinator) return { accepted: false, reason: 'UPDATE_GROUP_COORDINATOR_MISMATCH' };

      const safety = this.safety();
      if (!safety.safe) return { accepted: false, reason: 'UPDATE_EVENT_OR_BOSS_ACTIVE', safety };

      const applyAtMs = Math.floor(finite(payload.applyAtMs, 0));
      const now = Date.now();
      if (applyAtMs < now + 250 || applyAtMs > now + 30000) {
        return { accepted: false, reason: 'UPDATE_GROUP_APPLY_TIME_INVALID' };
      }

      if (this.rolloutTimer != null) {
        try {
          const clear = this.root && this.root.clearTimeout || clearTimeout;
          clear(this.rolloutTimer);
        } catch (_) {}
      }

      this.preparedUpdate = {
        ...this.preparedUpdate,
        state: 'COMMITTED',
        applyAtMs,
        applyAt: new Date(applyAtMs).toISOString(),
        committedAt: new Date().toISOString()
      };
      const timer = this.root && this.root.setTimeout || setTimeout;
      this.rolloutTimer = timer(() => {
        this.rolloutTimer = null;
        Promise.resolve(this.applyPending({
          localOnly: true,
          releaseKey,
          coordinated: true
        })).catch(error => {
          this.stats.failures += 1;
          this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
        });
      }, Math.max(0, applyAtMs - now));

      this.stats.groupCommits += 1;
      return {
        accepted: true,
        state: 'COMMITTED',
        releaseKey,
        localName: this.preparedUpdate.localName,
        applyAt: this.preparedUpdate.applyAt,
        applyAtMs
      };
    }

    cancelCoordinatedUpdate(payload = {}, meta = {}) {
      const releaseKey = clean(payload && payload.releaseKey || '', 300);
      const sender = clean(meta && meta.sender || '', 120);
      if (this.preparedUpdate && releaseKey && this.preparedUpdate.releaseKey !== releaseKey) {
        return { accepted: true, cancelled: false, reason: 'UPDATE_GROUP_OTHER_RELEASE_PREPARED' };
      }
      if (this.preparedUpdate && sender && this.preparedUpdate.coordinator && sender !== this.preparedUpdate.coordinator) {
        return { accepted: false, cancelled: false, reason: 'UPDATE_GROUP_COORDINATOR_MISMATCH' };
      }
      if (this.rolloutTimer != null) {
        try {
          const clear = this.root && this.root.clearTimeout || clearTimeout;
          clear(this.rolloutTimer);
        } catch (_) {}
      }
      const previous = clone(this.preparedUpdate);
      this.rolloutTimer = null;
      this.preparedUpdate = null;
      if (previous) this.stats.groupCancels += 1;
      return { accepted: true, cancelled: !!previous, previous };
    }

    async _dispatchGroup(method, names, payload) {
      const transport = this.runtime.lifecycleTransport;
      if (!transport || typeof transport[method] !== 'function') {
        return { ok: false, reason: 'UPDATE_GROUP_TRANSPORT_UNAVAILABLE', results: [] };
      }
      const commands = [];
      for (const name of names) {
        const command = transport[method](name, payload);
        if (!command || command.state !== 'DISPATCHED' || !command.value) {
          return {
            ok: false,
            reason: command && command.error && command.error.message || 'UPDATE_GROUP_COMMAND_NOT_DISPATCHED:' + name,
            results: commands
          };
        }
        commands.push({ name, command });
      }
      try {
        const settled = await Promise.all(commands.map(async row => ({
          name: row.name,
          outcome: await row.command.value
        })));
        const failed = settled.find(row => !row.outcome || row.outcome.success !== true);
        if (failed) {
          return {
            ok: false,
            reason: failed.outcome && failed.outcome.reason || 'UPDATE_GROUP_REMOTE_REJECTED:' + failed.name,
            results: settled
          };
        }
        return { ok: true, results: settled };
      } catch (error) {
        return { ok: false, reason: clean(error && error.message || error, 240), results: [] };
      }
    }

    async _cancelGroup(names, payload) {
      const transport = this.runtime.lifecycleTransport;
      if (!transport || typeof transport.requestUpdateCancel !== 'function') return;
      const waits = [];
      for (const name of names) {
        try {
          const command = transport.requestUpdateCancel(name, payload);
          if (command && command.state === 'DISPATCHED' && command.value) waits.push(command.value.catch(() => null));
        } catch (_) {}
      }
      if (waits.length) {
        try { await Promise.all(waits); } catch (_) {}
      }
    }

    _coordinationFailure(reason, details = {}) {
      const now = Date.now();
      this.stats.coordinationFailures += 1;
      this.coordinationRetryAtMs = now + this.config.coordinationRetryMs;
      this.lastCoordination = {
        at: new Date(now).toISOString(),
        state: 'FAILED',
        reason: clean(reason, 240),
        retryAt: new Date(this.coordinationRetryAtMs).toISOString(),
        details: clone(details)
      };
      this._emitIncident('UPDATE_GROUP_COORDINATION_FAILED', this.lastCoordination);
      return {
        applied: false,
        reason: this.lastCoordination.reason,
        retryAt: this.lastCoordination.retryAt,
        coordination: clone(this.lastCoordination)
      };
    }

    async _coordinatePending(manifest) {
      const now = Date.now();
      if (now < this.coordinationRetryAtMs) {
        return {
          applied: false,
          reason: 'UPDATE_GROUP_COORDINATION_BACKOFF',
          retryAt: new Date(this.coordinationRetryAtMs).toISOString()
        };
      }
      if (this.preparedUpdate) {
        return {
          applied: false,
          reason: this.preparedUpdate.state === 'COMMITTED' ? 'UPDATE_GROUP_COMMITTED' : 'UPDATE_GROUP_PREPARED',
          rollout: clone(this.preparedUpdate)
        };
      }

      const group = this._groupState();
      if (!group.ready) {
        this.stats.groupDeferrals += 1;
        this.lastCoordination = {
          at: new Date().toISOString(),
          state: 'DEFERRED',
          reason: 'UPDATE_GROUP_NOT_READY',
          details: clone(group)
        };
        return { applied: false, reason: 'UPDATE_GROUP_NOT_READY', group };
      }
      if (String(group.coordinator || '') !== String(group.localName || '')) {
        return {
          applied: false,
          reason: 'UPDATE_WAITING_FOR_GROUP_COORDINATOR',
          coordinator: group.coordinator,
          participants: group.participants
        };
      }

      const release = this._releaseDescriptor(manifest);
      const releaseKey = this._releaseKey(manifest);
      const payload = {
        protocol: UPDATE_COORDINATION_PROTOCOL,
        releaseKey,
        release,
        coordinator: group.coordinator,
        participants: group.participants.slice()
      };
      const remoteNames = group.participants.filter(name => String(name) !== String(group.localName));

      const localPrepare = await this.prepareCoordinatedUpdate(payload, {});
      if (!localPrepare || localPrepare.accepted !== true) {
        return this._coordinationFailure(localPrepare && localPrepare.reason || 'UPDATE_GROUP_LOCAL_PREPARE_FAILED', { group, localPrepare });
      }
      const remotePrepare = await this._dispatchGroup('requestUpdatePrepare', remoteNames, payload);
      if (!remotePrepare.ok) {
        await this._cancelGroup(remoteNames, { ...payload, reason: remotePrepare.reason });
        this.cancelCoordinatedUpdate({ releaseKey, reason: remotePrepare.reason });
        return this._coordinationFailure(remotePrepare.reason, { phase: 'PREPARE', group, remotePrepare });
      }

      const rechecked = this._groupState();
      if (!rechecked.ready) {
        await this._cancelGroup(remoteNames, { ...payload, reason: 'UPDATE_GROUP_PROTECTION_CHANGED' });
        this.cancelCoordinatedUpdate({ releaseKey, reason: 'UPDATE_GROUP_PROTECTION_CHANGED' });
        this.stats.groupDeferrals += 1;
        return { applied: false, reason: 'UPDATE_GROUP_PROTECTION_CHANGED', group: rechecked };
      }

      const applyAtMs = Date.now() + this.config.groupApplyDelayMs;
      const commitPayload = { ...payload, applyAtMs };

      // Arm remote peers first and wait for their COMMIT settlements. The local
      // coordinator is armed last so it can still cancel the group if any peer
      // rejects the cutover.
      const remoteCommit = await this._dispatchGroup('requestUpdateCommit', remoteNames, commitPayload);
      if (!remoteCommit.ok) {
        await this._cancelGroup(remoteNames, { ...payload, reason: remoteCommit.reason });
        this.cancelCoordinatedUpdate({ releaseKey, reason: remoteCommit.reason });
        return this._coordinationFailure(remoteCommit.reason, { phase: 'COMMIT', remoteCommit });
      }

      const localCommit = this.commitCoordinatedUpdate(commitPayload, {});
      if (!localCommit || localCommit.accepted !== true) {
        await this._cancelGroup(remoteNames, { ...payload, reason: localCommit && localCommit.reason || 'LOCAL_COMMIT_FAILED' });
        this.cancelCoordinatedUpdate({ releaseKey, reason: localCommit && localCommit.reason || 'LOCAL_COMMIT_FAILED' });
        return this._coordinationFailure(localCommit && localCommit.reason || 'UPDATE_GROUP_LOCAL_COMMIT_FAILED', { phase: 'COMMIT', localCommit, remoteCommit });
      }

      this.lastCoordination = {
        at: new Date().toISOString(),
        state: 'COMMITTED',
        releaseKey,
        coordinator: group.coordinator,
        participants: group.participants.slice(),
        applyAt: new Date(applyAtMs).toISOString(),
        applyAtMs
      };
      return {
        applied: false,
        reason: 'UPDATE_GROUP_COMMITTED',
        coordination: clone(this.lastCoordination)
      };
    }

    _activeRelease() {
      const bootstrap = this._bootstrap();
      if (!bootstrap || typeof bootstrap.activeRelease !== 'function') return null;
      try {
        const release = bootstrap.activeRelease();
        const checked = validateManifest(release);
        return checked.ok ? checked.manifest : null;
      } catch (_) {
        return null;
      }
    }

    async _executeVerifiedRelease(manifest, bundle) {
      const check = this._bootstrapCompatibility(manifest);
      if (!check.ok) throw new Error(check.reason);
      return check.bootstrap.executeVerifiedRelease(manifest, bundle);
    }

    async _confirmActiveRelease(manifest) {
      const check = this._bootstrapCompatibility(manifest);
      if (!check.ok) throw new Error(check.reason);
      return check.bootstrap.confirmActiveRelease(manifest);
    }

    async _rollbackToRelease(previousRelease, failedApi, previousBootCount, rearmIntent) {
      const checked = validateManifest(previousRelease);
      if (!checked.ok) return { ok: false, reason: 'ROLLBACK_RELEASE_INVALID:' + checked.reason };
      const bootstrapCheck = this._bootstrapCompatibility(checked.manifest);
      if (!bootstrapCheck.ok) return { ok: false, reason: bootstrapCheck.reason };

      try {
        const loaded = await bootstrapCheck.bootstrap.loadRelease(checked.manifest);
        if (!loaded || !loaded.manifest || typeof loaded.bundle !== 'string') {
          return { ok: false, reason: 'ROLLBACK_RELEASE_LOAD_INVALID' };
        }
        await bootstrapCheck.bootstrap.executeVerifiedRelease(loaded.manifest, loaded.bundle);
        const handshake = await this._waitHandshake(failedApi, checked.manifest.version, { previousBootCount });
        if (!handshake.ok) {
          this.stats.rollbackFailures += 1;
          return { ok: false, reason: 'ROLLBACK_HANDSHAKE_FAILED:' + handshake.reason, handshake };
        }

        const rearm = await this._rearmApi(this.root && this.root.ALBot, rearmIntent);
        if (!rearm.accepted) {
          this.stats.rollbackFailures += 1;
          return { ok: false, reason: 'ROLLBACK_REARM_FAILED:' + (rearm.reason || 'UNKNOWN'), handshake, rearm };
        }

        await this._confirmActiveRelease(checked.manifest);
        return {
          ok: true,
          release: this._releaseDescriptor(checked.manifest),
          handshake,
          rearm
        };
      } catch (error) {
        this.stats.rollbackFailures += 1;
        return { ok: false, reason: clean(error && error.message || error, 240) };
      }
    }

    _sleep(ms) {
      const timer = this.root && this.root.setTimeout || setTimeout;
      return new Promise(resolve => timer(resolve, ms));
    }

    _captureRearmIntent() {
      let full = null;
      try { full = this.runtime.fullAutonomy && this.runtime.fullAutonomy.status ? this.runtime.fullAutonomy.status() : null; } catch (_) {}
      return full && full.enabled === true ? {
        enabled: true,
        taskType: full.config && full.config.taskType || 'FARM',
        desiredCharacterNames: Array.isArray(full.desiredCharacterNames) ? full.desiredCharacterNames.slice() : []
      } : null;
    }

    async _rearmApi(api, intent) {
      if (!intent || intent.enabled !== true) return { required: false, accepted: true };
      if (!api || !api.fullAutonomy || typeof api.fullAutonomy.start !== 'function') {
        return { required: true, accepted: false, reason: 'UPDATE_REARM_API_UNAVAILABLE' };
      }
      try {
        const result = await api.fullAutonomy.start({
          taskType: intent.taskType || 'FARM',
          waitForRoster: true,
          desiredCharacterNames: intent.desiredCharacterNames || []
        });
        const accepted = !!(result && result.accepted === true);
        if (accepted) this.stats.rearms += 1;
        return { required: true, accepted, reason: accepted ? null : clean(result && result.reason || 'UPDATE_REARM_REJECTED', 240) };
      } catch (error) {
        return { required: true, accepted: false, reason: clean(error && error.message || error || 'UPDATE_REARM_FAILED', 240) };
      }
    }

    async _waitHandshake(previousApi, version, options = {}) {
      const timeoutMs = Math.max(1000, finite(options.timeoutMs, this.config.handshakeTimeoutMs));
      const previousBootCount = Math.max(0, finite(options.previousBootCount, 0));
      const deadline = Date.now() + timeoutMs;
      let last = 'NOT_CHECKED';
      let startAttempted = false;
      while (Date.now() < deadline) {
        const api = this.root && this.root.ALBot;
        if (!api) {
          last = 'API_MISSING';
        } else if (api === previousApi) {
          last = 'OLD_API_STILL_ACTIVE';
        } else if (String(api.version || '') !== String(version)) {
          last = 'VERSION_MISMATCH';
        } else {
          try {
            let status = typeof api.status === 'function' ? api.status() : null;
            if (status && status.running !== true && !startAttempted && typeof api.start === 'function') {
              startAttempted = true;
              try { await api.start(); } catch (_) {}
              status = typeof api.status === 'function' ? api.status() : status;
            }
            const bootCount = Math.max(0, finite(status && status.bootCount, 0));
            const runtimeHealth = status && Array.isArray(status.modules)
              ? status.modules.find(row => row && row.id === 'runtime-health')
              : null;
            let heartbeatActive = true;
            if (api.scheduler && typeof api.scheduler.owner === 'function') {
              try {
                const owner = api.scheduler.owner('module:runtime-health');
                heartbeatActive = !!(owner && Array.isArray(owner.resources) && owner.resources.length > 0);
              } catch (_) {
                heartbeatActive = false;
              }
            }
            if (!status || status.running !== true) last = 'RUNTIME_NOT_RUNNING';
            else if (String(status.version || '') !== String(version)) last = 'STATUS_VERSION_MISMATCH';
            else if (previousBootCount > 0 && bootCount <= previousBootCount) last = 'RUNTIME_INSTANCE_NOT_REPLACED';
            else if (status.emergencyStop && status.emergencyStop.latched === true) last = 'EMERGENCY_STOP_LATCHED';
            else if (status.scheduler && status.scheduler.enabled === false) last = 'SCHEDULER_NOT_RUNNING';
            else if (runtimeHealth && runtimeHealth.state && runtimeHealth.state !== 'ACTIVE') last = 'RUNTIME_HEALTH_NOT_ACTIVE';
            else if (!heartbeatActive) last = 'RUNTIME_HEARTBEAT_MISSING';
            else {
              return {
                ok: true,
                version,
                bootCount: bootCount || null,
                runEpoch: status.runEpoch || null,
                startedAt: status.startedAt || null,
                heartbeatActive
              };
            }
          } catch (_) {
            last = 'STATUS_FAILED';
          }
        }
        await this._sleep(100);
      }
      return { ok: false, reason: last };
    }

    async applyPending(options = {}) {
      if (!this.pending) this._loadPending();
      if (!this.pending || !this.pending.manifest) return { applied: false, reason: 'UPDATE_NOT_DOWNLOADED' };
      if (!this.config.autoApply) return { applied: false, reason: 'UPDATE_AUTO_APPLY_DISABLED' };
      if (this.busy) return { applied: false, reason: 'UPDATE_BUSY' };

      if (typeof this.pending.bundle !== 'string') {
        const refreshed = await this.checkAndDownload();
        if (!refreshed || refreshed.accepted !== true || !this.pending || typeof this.pending.bundle !== 'string') {
          return { applied: false, reason: refreshed && refreshed.reason || 'UPDATE_NOT_DOWNLOADED' };
        }
      }

      const checkedManifest = validateManifest(this.pending.manifest);
      if (!checkedManifest.ok) {
        this.pending = null;
        this._persistPending();
        return { applied: false, reason: checkedManifest.reason };
      }
      const manifest = checkedManifest.manifest;
      const bootstrapCheck = this._bootstrapCompatibility(manifest);
      if (!bootstrapCheck.ok) return { applied: false, reason: bootstrapCheck.reason };

      if (compareVersions(manifest.version, this.runtime.version) <= 0) {
        this.pending = null;
        this._persistPending();
        return { applied: false, reason: 'UPDATE_NOT_NEWER_THAN_RUNTIME' };
      }
      const quarantine = this._quarantineState(manifest);
      if (quarantine.blocked) {
        return { applied: false, reason: 'UPDATE_RELEASE_QUARANTINED', retryAt: quarantine.row && quarantine.row.retryAt || null };
      }

      const safety = this.safety();
      if (!safety.safe) {
        this.stats.safeDeferrals += 1;
        return { applied: false, reason: 'UPDATE_EVENT_OR_BOSS_ACTIVE', safety };
      }

      const releaseKey = this._releaseKey(manifest);
      if (options.releaseKey && String(options.releaseKey) !== String(releaseKey)) {
        return { applied: false, reason: 'UPDATE_GROUP_RELEASE_MISMATCH' };
      }
      if (!options.localOnly && this.config.coordinatedApply) {
        return this._coordinatePending(manifest);
      }

      const rollout = clone(this.preparedUpdate);
      if (options.localOnly && options.coordinated === true) {
        if (!rollout || rollout.state !== 'COMMITTED' || rollout.releaseKey !== releaseKey) {
          return { applied: false, reason: 'UPDATE_GROUP_COMMIT_REQUIRED' };
        }
        if (Date.now() + 50 < finite(rollout.applyAtMs, 0)) {
          return { applied: false, reason: 'UPDATE_GROUP_APPLY_NOT_DUE', rollout };
        }

        const finalGroup = this._groupState();
        const expectedParticipants = Array.isArray(rollout.participants) ? rollout.participants.slice().sort() : [];
        const actualParticipants = Array.isArray(finalGroup.participants) ? finalGroup.participants.slice().sort() : [];
        if (!finalGroup.ready || JSON.stringify(expectedParticipants) !== JSON.stringify(actualParticipants)) {
          this.stats.groupDeferrals += 1;
          return { applied: false, reason: 'UPDATE_GROUP_PROTECTION_CHANGED', group: finalGroup };
        }
      }

      const bytes = this._utf8Bytes(this.pending.bundle);
      const sha256 = await this._sha256(this.pending.bundle);
      const expectedBanner = '/* AL Bot ' + String(manifest.version) + ' | generated file | do not edit dist directly */';
      if (bytes !== manifest.bytes || bytes > this.config.maxBundleBytes || sha256 !== manifest.sha256
          || !String(this.pending.bundle).startsWith(expectedBanner + '\n')) {
        this.stats.hashRejects += 1;
        this._recordReleaseFailure(manifest, 'UPDATE_PENDING_REVALIDATION_FAILED', { bytes, sha256 });
        this.pending = null;
        this._persistPending();
        return { applied: false, reason: 'UPDATE_PENDING_REVALIDATION_FAILED' };
      }

      const previousRelease = this._activeRelease();
      if (!previousRelease) {
        return { applied: false, reason: 'UPDATE_PREVIOUS_RELEASE_UNKNOWN' };
      }

      const previousApi = this.root && this.root.ALBot;
      let previousStatus = null;
      try { previousStatus = previousApi && typeof previousApi.status === 'function' ? previousApi.status() : null; } catch (_) {}
      const previousVersion = String(previousStatus && previousStatus.version || previousRelease.version || this.runtime.version || '');
      const previousBootCount = Math.max(0, finite(previousStatus && previousStatus.bootCount, this.runtime.bootCount || 0));
      const rearmIntent = rollout && rollout.rearmIntent || this._captureRearmIntent();

      this.busy = true;
      let failureRecorded = false;
      try {
        await this.runtime.stop('PLANNED_AUTO_UPDATE');
        await this._executeVerifiedRelease(manifest, this.pending.bundle);

        const handshake = await this._waitHandshake(previousApi, manifest.version, { previousBootCount });
        if (!handshake.ok) {
          this.stats.rollbacks += 1;
          const failedApi = this.root && this.root.ALBot;
          let failedStatus = null;
          try { failedStatus = failedApi && typeof failedApi.status === 'function' ? failedApi.status() : null; } catch (_) {}
          const rollbackBaseBootCount = Math.max(previousBootCount, finite(failedStatus && failedStatus.bootCount, 0));
          const rollback = await this._rollbackToRelease(previousRelease, failedApi, rollbackBaseBootCount, rearmIntent);
          this._recordReleaseFailure(
            manifest,
            'UPDATE_HANDSHAKE_FAILED:' + handshake.reason,
            { handshake, rollback, previousRelease: this._releaseDescriptor(previousRelease) }
          );
          failureRecorded = true;
          throw new Error('UPDATE_HANDSHAKE_FAILED:' + handshake.reason + ':ROLLBACK_' + (rollback.ok ? 'OK' : 'FAILED'));
        }

        const rearm = await this._rearmApi(this.root && this.root.ALBot, rearmIntent);
        if (!rearm.accepted) {
          this.stats.rollbacks += 1;
          const failedApi = this.root && this.root.ALBot;
          let failedStatus = null;
          try { failedStatus = failedApi && typeof failedApi.status === 'function' ? failedApi.status() : null; } catch (_) {}
          const rollbackBaseBootCount = Math.max(previousBootCount, finite(failedStatus && failedStatus.bootCount, 0));
          const rollback = await this._rollbackToRelease(previousRelease, failedApi, rollbackBaseBootCount, rearmIntent);
          this._recordReleaseFailure(
            manifest,
            'UPDATE_REARM_FAILED:' + (rearm.reason || 'UNKNOWN'),
            { handshake, rearm, rollback, previousRelease: this._releaseDescriptor(previousRelease) }
          );
          failureRecorded = true;
          throw new Error('UPDATE_REARM_FAILED:' + (rearm.reason || 'UNKNOWN') + ':ROLLBACK_' + (rollback.ok ? 'OK' : 'FAILED'));
        }

        await this._confirmActiveRelease(manifest);
        this.stats.applies += 1;
        this.stats.reloads += 1;
        this._clearReleaseFailure(manifest);
        this.lastApply = {
          at: new Date().toISOString(),
          from: previousVersion,
          to: manifest.version,
          releaseKey,
          previousRelease: this._releaseDescriptor(previousRelease),
          release: this._releaseDescriptor(manifest),
          handshake,
          rearm,
          transport: 'verified-bootstrap-runtime-loader'
        };
        this.pending = null;
        this._persistPending();
        if (this.rolloutTimer != null) {
          try {
            const clear = this.root && this.root.clearTimeout || clearTimeout;
            clear(this.rolloutTimer);
          } catch (_) {}
        }
        this.rolloutTimer = null;
        this.preparedUpdate = null;
        this.coordinationRetryAtMs = 0;
        this.lastError = null;
        return { applied: true, ...clone(this.lastApply) };
      } catch (error) {
        this.stats.failures += 1;
        this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
        if (!failureRecorded) {
          this._recordReleaseFailure(manifest, this.lastError.reason, {
            previousRelease: this._releaseDescriptor(previousRelease),
            release: this._releaseDescriptor(manifest)
          });
        }
        return { applied: false, reason: this.lastError.reason };
      } finally {
        this.busy = false;
      }
    }

    async cycle() {
      if (!this.config.enabled) return { accepted: false, reason: 'UPDATE_DISABLED' };
      let result = null;
      if (!this.pending || compareVersions(this.pending.manifest && this.pending.manifest.version, this.runtime.version) <= 0) {
        result = await this.checkAndDownload();
      }
      if (this.pending && this.config.autoApply) {
        const quarantine = this._quarantineState(this.pending.manifest);
        if (quarantine.blocked) {
          return { check: result, apply: { applied: false, reason: 'UPDATE_RELEASE_QUARANTINED', retryAt: quarantine.row && quarantine.row.retryAt || null } };
        }
        const applied = await this.applyPending();
        return { check: result, apply: applied };
      }
      return result || { accepted: true, pending: !!this.pending };
    }

    discardPending(reason = 'MANUAL_DISCARD') {
      const previous = this.pending && this.pending.manifest ? this.pending.manifest.version : null;
      this.pending = null;
      this._persistPending();
      return { discarded: true, reason: clean(reason, 120), previousVersion: previous };
    }

    status() {
      const bootstrap = this._bootstrap();
      const activeRelease = this._activeRelease();
      return {
        schemaVersion: 1,
        mode: 'h22-github-bootstrap-auto-updater',
        active: this.active,
        enabled: this.config.enabled,
        localVersion: this.runtime.version,
        manifestUrl: this.config.manifestUrl,
        checkIntervalMs: this.config.checkIntervalMs,
        applyIntervalMs: this.config.applyIntervalMs,
        safeHoldMs: this.config.safeHoldMs,
        handshakeTimeoutMs: this.config.handshakeTimeoutMs,
        groupApplyDelayMs: this.config.groupApplyDelayMs,
        coordinationRetryMs: this.config.coordinationRetryMs,
        autoDownload: this.config.autoDownload,
        autoApply: this.config.autoApply,
        coordinatedApply: this.config.coordinatedApply,
        bootstrapVersion: bootstrap && bootstrap.version || null,
        activeRelease: this._releaseDescriptor(activeRelease),
        applyReady: !!(this.config.autoApply && bootstrap),
        pending: this.pending ? {
          downloadedAt: this.pending.downloadedAt,
          manifest: clone(this.pending.manifest),
          cachedBytes: typeof this.pending.bundle === 'string' ? this._utf8Bytes(this.pending.bundle) : 0,
          cachedInWindow: typeof this.pending.bundle === 'string'
        } : null,
        busy: this.busy,
        safeSince: this.safeSince || null,
        safety: clone(this.lastSafety),
        lastCheckAt: this.lastCheckAt || null,
        lastSuccessAt: this.lastSuccessAt,
        lastError: clone(this.lastError),
        lastApply: clone(this.lastApply),
        lastIncident: clone(this.lastIncident),
        lastCoordination: clone(this.lastCoordination),
        preparedUpdate: clone(this.preparedUpdate),
        localProtection: this.localProtection(),
        coordinationRetryAt: this.coordinationRetryAtMs ? new Date(this.coordinationRetryAtMs).toISOString() : null,
        quarantine: clone(this.quarantine),
        stats: { ...this.stats },
        policies: {
          githubReadOnly: true,
          manifestAndBundleHttpsOnly: true,
          manifestRequiresCommitSha: true,
          bundleUrlMustPinCommitSha: true,
          bundleSha256Required: true,
          bundleRevalidatedBeforeApply: true,
          downgradeForbidden: true,
          automaticDownload: true,
          automaticApplyEnabledByDefault: true,
          automaticApplyRequiresVerifiedBootstrap: true,
          bootstrapOwnsTransportNotUpdateAuthority: true,
          fullBundleNeverSavedToAdventureLandCodeSlot: true,
          coordinatedAllOnlineCharacters: true,
          twoPhasePrepareCommit: true,
          bundleCachedAndVerifiedBeforeGroupCommit: true,
          finalProtectionRecheckBeforeExecution: true,
          ordinaryCombatDoesNotBlockApply: true,
          ordinaryGameplayDoesNotBlockApply: true,
          eventOrBossDefersApply: true,
          safeWindowRequiredBeforeApply: false,
          rollbackLoadsPreviousPinnedRelease: true,
          rollbackRevalidatesBytesHashAndBanner: true,
          rollbackHandshakeRequired: true,
          failedReleaseQuarantineWithBackoff: true,
          fullAutonomyRearmAfterHealthyBoot: true,
          noGitHubWriteCredentialInBot: true
        }
      };
    }
  }

  ns.SafeAutoUpdater = SafeAutoUpdater;
  ns.safeUpdaterHelpers = { compareVersions, validateManifest };
})(typeof globalThis !== 'undefined' ? globalThis : this);
