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
        autoDownload: globalConfig.autoDownload !== false,
        autoApply: globalConfig.autoApply === true,
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
        if (row && row.manifest && typeof row.bundle === 'string') this.pending = row;
      } catch (_) {}
    }

    _persistPending() {
      if (!this.storage) return;
      try {
        if (!this.pending) this.storage.remove(PENDING_KEY);
        else this.storage.set(PENDING_KEY, JSON.stringify(this.pending));
      } catch (_) {}
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
          if (!this.config.autoApply || !this.pending || this.busy) return;
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
        if (manifest.minBootstrapVersion && compareVersions(this.runtime.version, manifest.minBootstrapVersion) < 0) {
          throw new Error('UPDATE_BOOTSTRAP_TOO_OLD');
        }
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

    safety() {
      const reasons = [];
      const read = controller => {
        try { return controller && typeof controller.status === 'function' ? controller.status() : null; }
        catch (_) { return null; }
      };
      const blockController = (name, status, busyKeys = []) => {
        if (!status) return;
        if (status.suspended === true) reasons.push(name + '_SUSPENDED');
        for (const key of busyKeys) {
          const value = status[key];
          if (Array.isArray(value) ? value.length > 0 : !!value) reasons.push(name + '_' + key.toUpperCase());
        }
      };

      if (!this.runtime.running) reasons.push('RUNTIME_NOT_RUNNING');
      if (this.runtime.stopLatch && this.runtime.stopLatch.status().latched) reasons.push('EMERGENCY_STOP_LATCHED');

      const combat = read(this.runtime.combat);
      if (combat && combat.active) reasons.push('COMBAT_ACTIVE');
      if (combat && combat.pendingAttack) reasons.push('COMBAT_PENDING_ATTACK');

      const movement = read(this.runtime.movement);
      if (movement && (movement.active || movement.activeOrder)) reasons.push('MOVEMENT_ACTIVE');

      blockController('RESOURCE', read(this.runtime.resourceTopoff), ['pending']);
      blockController('LIFECYCLE', read(this.runtime.lifecycle), ['currentAction', 'queue']);
      blockController('LOGISTICS', read(this.runtime.partyLogistics), ['currentAction', 'queue']);
      blockController('BANK', read(this.runtime.bank), ['pending', 'request']);
      blockController('TRADE', read(this.runtime.trade), ['pending', 'request']);
      blockController('UPGRADE', read(this.runtime.upgrade), ['pending', 'request']);
      blockController('CRAFT', read(this.runtime.exchangeCraft), ['pending', 'request']);
      blockController('ECONOMY', read(this.runtime.economy), ['currentAction']);
      blockController('INVENTORY', read(this.runtime.inventory), ['pending', 'request', 'pendingLoot']);
      blockController('MERCHANT', read(this.runtime.merchant), ['pending', 'request', 'delivery', 'currentAction']);
      blockController('GEAR', read(this.runtime.gear), ['pending', 'request', 'delivery']);

      const transport = read(this.runtime.lifecycleTransport);
      if (transport && Array.isArray(transport.pending) && transport.pending.length) reasons.push('H19_REMOTE_REQUEST_PENDING');
      if (transport && transport.partyRecoveryLease) reasons.push('H19_PARTY_RECOVERY_PENDING');

      const full = read(this.runtime.fullAutonomy);
      if (full && full.enabled === true) {
        const state = full.lastDecision && String(full.lastDecision.state || '').toUpperCase();
        if (!state || state !== 'RUNNING') reasons.push('FULL_AUTONOMY_UNSAFE_TRANSITION');
      }

      let game = null;
      try { game = this.runtime.game.snapshot(); } catch (_) {}
      const character = game && game.character;
      if (!character) reasons.push('CHARACTER_UNKNOWN');
      if (character && (character.rip || character.dead)) reasons.push('CHARACTER_DEAD');
      const hp = finite(character && character.hp, 0);
      const maxHp = finite(character && (character.max_hp != null ? character.max_hp : character.maxHp), 0);
      if (maxHp > 0 && hp / maxHp < 0.90) reasons.push('HP_BELOW_UPDATE_THRESHOLD');

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
        stable: safe && this.safeSince > 0 && now - this.safeSince >= this.config.safeHoldMs,
        reasons
      };
      return clone(this.lastSafety);
    }

    _binding(name) {
      if (this.root && typeof this.root[name] === 'function') return { fn: this.root[name], owner: this.root };
      let parent = null;
      try { parent = this.root && this.root.parent; } catch (_) {}
      if (parent && typeof parent[name] === 'function') return { fn: parent[name], owner: parent };
      return null;
    }

    _activeSlot() {
      const binding = this._binding('get_active_code_slot');
      if (!binding) return null;
      try {
        const value = binding.fn.call(binding.owner);
        const slot = value && typeof value === 'object' ? (value.slot ?? value.id ?? value.name) : value;
        return slot == null ? null : String(slot);
      } catch (_) {
        return null;
      }
    }

    _stagingSlot(activeSlot) {
      return this.config.stagingSlots.find(slot => String(slot) !== String(activeSlot)) || null;
    }

    async _saveCode(slot, code, version) {
      const upload = this._binding('upload_code');
      if (upload) {
        const result = upload.fn.call(upload.owner, slot, 'AL Bot ' + version, code);
        return result && typeof result.then === 'function' ? await result : result;
      }
      let parent = null;
      try { parent = this.root && this.root.parent; } catch (_) {}
      if (!parent || typeof parent.api_call !== 'function') throw new Error('UPDATE_SAVE_CODE_UNAVAILABLE');
      const result = parent.api_call('save_code', { slot, name: 'AL Bot ' + version, code, auto: true, electron: true }, { timeout: 15000 });
      return result && typeof result.then === 'function' ? await result : result;
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

    async applyPending() {
      if (!this.pending || !this.pending.manifest || typeof this.pending.bundle !== 'string') return { applied: false, reason: 'UPDATE_NOT_DOWNLOADED' };
      if (!this.config.autoApply) return { applied: false, reason: 'UPDATE_AUTO_APPLY_DISABLED' };
      if (this.busy) return { applied: false, reason: 'UPDATE_BUSY' };

      const checkedManifest = validateManifest(this.pending.manifest);
      if (!checkedManifest.ok) {
        this.pending = null;
        this._persistPending();
        return { applied: false, reason: checkedManifest.reason };
      }
      const manifest = checkedManifest.manifest;
      if (compareVersions(manifest.version, this.runtime.version) <= 0) {
        this.pending = null;
        this._persistPending();
        return { applied: false, reason: 'UPDATE_NOT_NEWER_THAN_RUNTIME' };
      }
      if (manifest.minBootstrapVersion && compareVersions(this.runtime.version, manifest.minBootstrapVersion) < 0) {
        return { applied: false, reason: 'UPDATE_BOOTSTRAP_TOO_OLD' };
      }
      const quarantine = this._quarantineState(manifest);
      if (quarantine.blocked) {
        return { applied: false, reason: 'UPDATE_RELEASE_QUARANTINED', retryAt: quarantine.row && quarantine.row.retryAt || null };
      }

      const safety = this.safety();
      if (!safety.stable) {
        this.stats.safeDeferrals += 1;
        return { applied: false, reason: 'UPDATE_SAFE_WINDOW_REQUIRED', safety };
      }

      const activeSlot = this._activeSlot();
      const stagingSlot = this._stagingSlot(activeSlot);
      if (activeSlot == null) return { applied: false, reason: 'UPDATE_ACTIVE_SLOT_UNKNOWN' };
      if (stagingSlot == null) return { applied: false, reason: 'UPDATE_STAGING_SLOT_REQUIRED', activeSlot };

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

      const previousApi = this.root && this.root.ALBot;
      let previousStatus = null;
      try { previousStatus = previousApi && typeof previousApi.status === 'function' ? previousApi.status() : null; } catch (_) {}
      const previousVersion = String(previousStatus && previousStatus.version || this.runtime.version || '');
      const previousBootCount = Math.max(0, finite(previousStatus && previousStatus.bootCount, this.runtime.bootCount || 0));
      const rearmIntent = this._captureRearmIntent();
      this.busy = true;
      let failureRecorded = false;
      try {
        const save = await this._saveCode(stagingSlot, this.pending.bundle, manifest.version);
        if (save && (save.failed === true || save.success === false)) throw new Error('UPDATE_SAVE_CODE_REJECTED');

        await this.runtime.stop('PLANNED_AUTO_UPDATE');
        const load = this._binding('load_code');
        if (!load) throw new Error('UPDATE_LOAD_CODE_UNAVAILABLE');

        const loaded = load.fn.call(load.owner, stagingSlot);
        if (loaded && typeof loaded.then === 'function') await loaded;

        const handshake = await this._waitHandshake(previousApi, manifest.version, { previousBootCount });
        if (!handshake.ok) {
          this.stats.rollbacks += 1;
          const failedApi = this.root && this.root.ALBot;
          let rollbackHandshake = { ok: false, reason: 'ROLLBACK_NOT_ATTEMPTED' };
          try {
            const rollback = load.fn.call(load.owner, activeSlot);
            if (rollback && typeof rollback.then === 'function') await rollback;
            rollbackHandshake = await this._waitHandshake(failedApi, previousVersion, { previousBootCount });
            if (!rollbackHandshake.ok) this.stats.rollbackFailures += 1;
          } catch (rollbackError) {
            this.stats.rollbackFailures += 1;
            rollbackHandshake = { ok: false, reason: clean(rollbackError && rollbackError.message || rollbackError, 240) };
          }
          let rollbackRearm = null;
          if (rollbackHandshake.ok) rollbackRearm = await this._rearmApi(this.root && this.root.ALBot, rearmIntent);
          const quarantineRow = this._recordReleaseFailure(
            manifest,
            'UPDATE_HANDSHAKE_FAILED:' + handshake.reason,
            { handshake, rollbackHandshake, rollbackRearm, activeSlot, stagingSlot }
          );
          failureRecorded = true;
          throw new Error('UPDATE_HANDSHAKE_FAILED:' + handshake.reason + ':ROLLBACK_' + (rollbackHandshake.ok ? 'OK' : 'FAILED'));
        }

        const rearm = await this._rearmApi(this.root && this.root.ALBot, rearmIntent);
        if (!rearm.accepted) {
          this.stats.rollbacks += 1;
          const failedApi = this.root && this.root.ALBot;
          let rollbackHandshake = { ok: false, reason: 'ROLLBACK_NOT_ATTEMPTED' };
          try {
            const rollback = load.fn.call(load.owner, activeSlot);
            if (rollback && typeof rollback.then === 'function') await rollback;
            rollbackHandshake = await this._waitHandshake(failedApi, previousVersion, { previousBootCount });
            if (!rollbackHandshake.ok) this.stats.rollbackFailures += 1;
          } catch (rollbackError) {
            this.stats.rollbackFailures += 1;
            rollbackHandshake = { ok: false, reason: clean(rollbackError && rollbackError.message || rollbackError, 240) };
          }
          let rollbackRearm = null;
          if (rollbackHandshake.ok) rollbackRearm = await this._rearmApi(this.root && this.root.ALBot, rearmIntent);
          this._recordReleaseFailure(
            manifest,
            'UPDATE_REARM_FAILED:' + (rearm.reason || 'UNKNOWN'),
            { handshake, rearm, rollbackHandshake, rollbackRearm, activeSlot, stagingSlot }
          );
          failureRecorded = true;
          throw new Error('UPDATE_REARM_FAILED:' + (rearm.reason || 'UNKNOWN'));
        }

        this.stats.applies += 1;
        this.stats.reloads += 1;
        this._clearReleaseFailure(manifest);
        this.lastApply = {
          at: new Date().toISOString(),
          from: previousVersion,
          to: manifest.version,
          commitSha: manifest.commitSha,
          activeSlot,
          stagingSlot,
          handshake,
          rearm
        };
        this.pending = null;
        this._persistPending();
        this.lastError = null;
        return { applied: true, ...clone(this.lastApply) };
      } catch (error) {
        this.stats.failures += 1;
        this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
        if (!failureRecorded) {
          this._recordReleaseFailure(manifest, this.lastError.reason, { activeSlot, stagingSlot });
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
      const activeSlot = this._activeSlot();
      return {
        schemaVersion: 1,
        mode: 'h22-github-safe-auto-updater',
        active: this.active,
        enabled: this.config.enabled,
        localVersion: this.runtime.version,
        manifestUrl: this.config.manifestUrl,
        checkIntervalMs: this.config.checkIntervalMs,
        applyIntervalMs: this.config.applyIntervalMs,
        safeHoldMs: this.config.safeHoldMs,
        handshakeTimeoutMs: this.config.handshakeTimeoutMs,
        autoDownload: this.config.autoDownload,
        autoApply: this.config.autoApply,
        stagingSlots: this.config.stagingSlots.slice(),
        activeSlot,
        applyReady: !!(this.config.autoApply && activeSlot != null && this._stagingSlot(activeSlot) != null),
        pending: this.pending ? {
          downloadedAt: this.pending.downloadedAt,
          manifest: clone(this.pending.manifest),
          cachedBytes: this._utf8Bytes(this.pending.bundle)
        } : null,
        busy: this.busy,
        safeSince: this.safeSince || null,
        safety: clone(this.lastSafety),
        lastCheckAt: this.lastCheckAt || null,
        lastSuccessAt: this.lastSuccessAt,
        lastError: clone(this.lastError),
        lastApply: clone(this.lastApply),
        lastIncident: clone(this.lastIncident),
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
          automaticApplyRequiresExplicitStagingSlots: true,
          safeWindowRequiredBeforeApply: true,
          activeSlotNeverOverwrittenBeforeHandshake: true,
          rollbackLoadsPreviousSlot: true,
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
