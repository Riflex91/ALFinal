(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__ = root.__ALBOT_INTERNALS__ || {};

  const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/release/al-bot-release.json';
  const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const DEFAULT_SAFE_HOLD_MS = 8000;
  const DEFAULT_MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
  const PENDING_KEY = 'albot:auto-update:pending:v1';

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
    if (!clean(manifest.version, 80)) return { ok: false, reason: 'UPDATE_MANIFEST_VERSION_INVALID' };
    if (!validSha256(manifest.sha256)) return { ok: false, reason: 'UPDATE_MANIFEST_SHA256_INVALID' };
    const bytes = Math.floor(finite(manifest.bytes, 0));
    if (bytes < 10000 || bytes > DEFAULT_MAX_BUNDLE_BYTES) return { ok: false, reason: 'UPDATE_MANIFEST_BYTES_INVALID' };
    let url;
    try { url = new URL(String(manifest.bundleUrl || '')); } catch (_) { return { ok: false, reason: 'UPDATE_MANIFEST_URL_INVALID' }; }
    if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com') {
      return { ok: false, reason: 'UPDATE_MANIFEST_URL_NOT_GITHUB_RAW' };
    }
    if (!/^\/Riflex91\/ALFinal\//.test(url.pathname)) {
      return { ok: false, reason: 'UPDATE_MANIFEST_REPOSITORY_INVALID' };
    }
    return { ok: true, manifest: { ...manifest, bytes, sha256: String(manifest.sha256).toLowerCase(), bundleUrl: url.toString() } };
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
        safeHoldMs: Math.max(3000, finite(globalConfig.safeHoldMs, DEFAULT_SAFE_HOLD_MS)),
        maxBundleBytes: Math.max(250000, finite(globalConfig.maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES)),
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
      this.lastCheckAt = 0;
      this.lastSuccessAt = null;
      this.lastError = null;
      this.lastSafety = { safe: false, reasons: ['NOT_EVALUATED'] };
      this.lastApply = null;
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
        failures: 0
      };
      this._loadPending();
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
      if (value.safeHoldMs != null) this.config.safeHoldMs = Math.max(3000, finite(value.safeHoldMs, this.config.safeHoldMs));
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

    async start(context) {
      if (this.active) return this.status();
      this.active = true;
      if (context && context.scope && typeof context.scope.interval === 'function') {
        context.scope.interval('update-check', () => {
          Promise.resolve(this.cycle()).catch(error => {
            this.stats.failures += 1;
            this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
          });
        }, this.config.checkIntervalMs, { immediate: true });
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
        if (compareVersions(manifest.version, this.runtime.version) <= 0) {
          if (this.pending && compareVersions(this.pending.manifest.version, this.runtime.version) <= 0) {
            this.pending = null;
            this._persistPending();
          }
          this.lastError = null;
          return { accepted: true, updateAvailable: false, localVersion: this.runtime.version, remoteVersion: manifest.version };
        }

        this.stats.updatesFound += 1;
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
        if (!bundle.includes('AL Bot') || !bundle.includes(String(manifest.version))) throw new Error('UPDATE_BUNDLE_VERSION_MARKER_MISSING');

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
      if (!this.runtime.running) reasons.push('RUNTIME_NOT_RUNNING');
      if (this.runtime.stopLatch && this.runtime.stopLatch.status().latched) reasons.push('EMERGENCY_STOP_LATCHED');

      const safeStatus = (controller, name, keys = ['pending']) => {
        let status = null;
        try { status = controller && typeof controller.status === 'function' ? controller.status() : null; } catch (_) {}
        if (!status) return;
        if (status.active === true && (name === 'combat' || name === 'movement')) reasons.push(name.toUpperCase() + '_ACTIVE');
        for (const key of keys) if (status[key]) reasons.push(name.toUpperCase() + '_' + key.toUpperCase());
        if (status.suspended === true) reasons.push(name.toUpperCase() + '_SUSPENDED');
      };

      safeStatus(this.runtime.combat, 'combat', ['pendingAction']);
      safeStatus(this.runtime.movement, 'movement', ['pending']);
      safeStatus(this.runtime.resourceTopoff, 'resource', ['pending']);
      safeStatus(this.runtime.lifecycle, 'lifecycle', ['pending', 'inFlight']);
      safeStatus(this.runtime.partyLogistics, 'logistics', ['pendingSupply', 'pendingGrant', 'pendingOutbound']);
      safeStatus(this.runtime.economy, 'economy', ['pending']);

      let game = null;
      try { game = this.runtime.game.snapshot(); } catch (_) {}
      const character = game && game.character;
      if (!character) reasons.push('CHARACTER_UNKNOWN');
      if (character && (character.rip || character.dead)) reasons.push('CHARACTER_DEAD');
      const hp = finite(character && character.hp, 0), maxHp = finite(character && character.max_hp, 0);
      if (maxHp > 0 && hp / maxHp < 0.90) reasons.push('HP_BELOW_UPDATE_THRESHOLD');

      const safe = reasons.length === 0;
      const now = Date.now();
      if (safe) {
        if (!this.safeSince) this.safeSince = now;
      } else {
        this.safeSince = 0;
      }
      this.lastSafety = { at: new Date(now).toISOString(), safe, stable: safe && this.safeSince > 0 && now - this.safeSince >= this.config.safeHoldMs, reasons };
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

    async _waitHandshake(previousApi, version, timeoutMs = 12000) {
      const deadline = Date.now() + timeoutMs;
      let last = 'NOT_CHECKED';
      while (Date.now() < deadline) {
        const api = this.root && this.root.ALBot;
        if (!api) last = 'API_MISSING';
        else if (api === previousApi) last = 'OLD_API_STILL_ACTIVE';
        else if (String(api.version || '') !== String(version)) last = 'VERSION_MISMATCH';
        else {
          try {
            const status = typeof api.status === 'function' ? api.status() : null;
            if (status && status.running === true && String(status.version || '') === String(version)) {
              return { ok: true, version, bootCount: status.bootCount || null };
            }
            last = 'RUNTIME_NOT_RUNNING';
          } catch (_) { last = 'STATUS_FAILED'; }
        }
        await this._sleep(100);
      }
      return { ok: false, reason: last };
    }

    async applyPending() {
      if (!this.pending || !this.pending.manifest || typeof this.pending.bundle !== 'string') return { applied: false, reason: 'UPDATE_NOT_DOWNLOADED' };
      if (!this.config.autoApply) return { applied: false, reason: 'UPDATE_AUTO_APPLY_DISABLED' };
      if (this.busy) return { applied: false, reason: 'UPDATE_BUSY' };
      const safety = this.safety();
      if (!safety.stable) {
        this.stats.safeDeferrals += 1;
        return { applied: false, reason: 'UPDATE_SAFE_WINDOW_REQUIRED', safety };
      }

      const activeSlot = this._activeSlot();
      const stagingSlot = this._stagingSlot(activeSlot);
      if (activeSlot == null) return { applied: false, reason: 'UPDATE_ACTIVE_SLOT_UNKNOWN' };
      if (stagingSlot == null) return { applied: false, reason: 'UPDATE_STAGING_SLOT_REQUIRED', activeSlot };

      const manifest = this.pending.manifest;
      const previousApi = this.root && this.root.ALBot;
      this.busy = true;
      try {
        const save = await this._saveCode(stagingSlot, this.pending.bundle, manifest.version);
        if (save && save.failed === true) throw new Error('UPDATE_SAVE_CODE_REJECTED');
        await this.runtime.stop('PLANNED_AUTO_UPDATE');
        const load = this._binding('load_code');
        if (!load) throw new Error('UPDATE_LOAD_CODE_UNAVAILABLE');
        const loaded = load.fn.call(load.owner, stagingSlot);
        if (loaded && typeof loaded.then === 'function') await loaded;
        const handshake = await this._waitHandshake(previousApi, manifest.version);
        if (!handshake.ok) {
          this.stats.rollbacks += 1;
          try {
            const rollback = load.fn.call(load.owner, activeSlot);
            if (rollback && typeof rollback.then === 'function') await rollback;
          } catch (_) {}
          throw new Error('UPDATE_HANDSHAKE_FAILED:' + handshake.reason);
        }
        this.stats.applies += 1;
        this.stats.reloads += 1;
        this.lastApply = {
          at: new Date().toISOString(),
          from: this.runtime.version,
          to: manifest.version,
          activeSlot,
          stagingSlot,
          handshake
        };
        this.pending = null;
        this._persistPending();
        return { applied: true, ...clone(this.lastApply) };
      } catch (error) {
        this.stats.failures += 1;
        this.lastError = { at: new Date().toISOString(), reason: clean(error && error.message || error, 240) };
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
        stats: { ...this.stats },
        policies: {
          githubReadOnly: true,
          manifestAndBundleHttpsOnly: true,
          bundleSha256Required: true,
          downgradeForbidden: true,
          automaticDownload: true,
          automaticApplyRequiresExplicitStagingSlots: true,
          safeWindowRequiredBeforeApply: true,
          activeSlotNeverOverwrittenBeforeHandshake: true,
          rollbackLoadsPreviousSlot: true,
          noGitHubWriteCredentialInBot: true
        }
      };
    }
  }

  ns.SafeAutoUpdater = SafeAutoUpdater;
  ns.safeUpdaterHelpers = { compareVersions, validateManifest };
})(typeof globalThis !== 'undefined' ? globalThis : this);
