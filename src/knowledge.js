(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;
  const GAME_NAME = 'Adventure Land - The Code MMORPG';
  const LIVE_FORMAT = 'ADVENTURE_LAND_V5_LIVE_WISSEN';
  const SHA256_RE = /^[a-f0-9]{64}$/;
  const ALLOWED_DOMAINS = new Set([
    'KERN','CHARAKTER','INVENTAR','SKILL','MONSTER','MAP','EVENT','QUEST',
    'MARKT','BANK','HANDWERK','KAMPF','NAVIGATION','GRUPPE','SERVER','ITEM','NPC'
  ]);
  const SECRET_FRAGMENTS = [
    'password','passwort','token','secret','credential','applicationkey',
    'accesskey','authorization','cookie','session','localpath','lokalerpfad',
    'filesystempath','dateipfad'
  ];

  function utf8Encoder(rootRef) {
    const Encoder = rootRef && rootRef.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
    if (!Encoder) throw new Error('KNOWLEDGE_TEXT_ENCODER_UNAVAILABLE');
    return new Encoder();
  }

  function utf8Decoder(rootRef) {
    const Decoder = rootRef && rootRef.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
    if (!Decoder) throw new Error('KNOWLEDGE_TEXT_DECODER_UNAVAILABLE');
    return new Decoder('utf-8');
  }

  function normalizeSecretKey(name) {
    return String(name || '').replace(/[_-]/g, '').toLowerCase();
  }

  function rejectSecrets(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const row of value) rejectSecrets(row);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeSecretKey(key);
      if (SECRET_FRAGMENTS.some(fragment => normalized.includes(fragment))) {
        throw new Error('KNOWLEDGE_SECRET_FIELD_REJECTED:' + cleanText(key, 80));
      }
      rejectSecrets(child);
    }
  }

  function parseJson(text, code) {
    try { return JSON.parse(text); }
    catch (_) { throw new Error(code || 'KNOWLEDGE_JSON_INVALID'); }
  }

  function validateTime(value, field) {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) throw new Error('KNOWLEDGE_TIME_INVALID:' + field);
    return ms;
  }

  function validateLiveFact(fact) {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) throw new Error('KNOWLEDGE_FACT_NOT_OBJECT');
    if (fact.schemaVersion !== 1) throw new Error('KNOWLEDGE_FACT_SCHEMA_INVALID');
    if (fact.spiel !== GAME_NAME) throw new Error('KNOWLEDGE_FACT_GAME_INVALID');
    if (fact.status !== 'LIVE_VERIFIZIERT') throw new Error('KNOWLEDGE_FACT_NOT_VERIFIED');
    if (!fact.kennung || String(fact.kennung).length > 200) throw new Error('KNOWLEDGE_FACT_ID_INVALID');
    if (!ALLOWED_DOMAINS.has(String(fact.domaene || ''))) throw new Error('KNOWLEDGE_FACT_DOMAIN_INVALID');
    if (!Object.prototype.hasOwnProperty.call(fact, 'wert')) throw new Error('KNOWLEDGE_FACT_VALUE_MISSING');
    const observed = validateTime(fact.beobachtetAm, 'beobachtetAm');
    const verified = validateTime(fact.verifiziertAm, 'verifiziertAm');
    if (verified < observed) throw new Error('KNOWLEDGE_FACT_VERIFIED_BEFORE_OBSERVED');
    if (observed > Date.now() + 5 * 60 * 1000 || verified > Date.now() + 5 * 60 * 1000) {
      throw new Error('KNOWLEDGE_FACT_TIME_IN_FUTURE');
    }
    if (!fact.quelle || fact.quelle.art !== 'LIVE_SPIEL' || !fact.quelle.methode) {
      throw new Error('KNOWLEDGE_FACT_SOURCE_INVALID');
    }
    rejectSecrets(fact);
    return fact;
  }

  function validateManifest(manifest) {
    if (!manifest || manifest.schemaVersion !== 1 || manifest.format !== LIVE_FORMAT || manifest.spiel !== GAME_NAME) {
      throw new Error('KNOWLEDGE_MANIFEST_INVALID');
    }
    if (manifest.aktuellVerzeichnis !== 'aktuell') throw new Error('KNOWLEDGE_MANIFEST_CURRENT_DIR_INVALID');
    rejectSecrets(manifest);
    return manifest;
  }

  function validateStatus(status) {
    if (!status || status.schemaVersion !== 1 || status.spiel !== GAME_NAME) throw new Error('KNOWLEDGE_STATUS_INVALID');
    if (!Number.isInteger(status.generation) || status.generation < 0) throw new Error('KNOWLEDGE_GENERATION_INVALID');
    if (status.zustand !== 'BEREIT' && status.zustand !== 'SCHREIBT') throw new Error('KNOWLEDGE_STATE_INVALID');
    validateTime(status.aktualisiertAm, 'aktualisiertAm');
    rejectSecrets(status);
    return status;
  }

  function validateImportMeta(meta, generation) {
    if (!meta || meta.schemaVersion !== 1) throw new Error('KNOWLEDGE_IMPORT_INVALID');
    if (meta.spiel !== GAME_NAME) throw new Error('KNOWLEDGE_IMPORT_GAME_INVALID');
    if (meta.quelle !== 'LOKALE_LIVE_WISSENSDATENBANK') throw new Error('KNOWLEDGE_IMPORT_SOURCE_INVALID');
    if (meta.generation !== generation) throw new Error('KNOWLEDGE_IMPORT_GENERATION_MISMATCH');
    if (!SHA256_RE.test(String(meta.snapshotSha256 || ''))) throw new Error('KNOWLEDGE_IMPORT_HASH_INVALID');
    if (!Number.isInteger(meta.dateien) || meta.dateien < 0) throw new Error('KNOWLEDGE_IMPORT_FILE_COUNT_INVALID');
    if (!Number.isFinite(Number(meta.bytes)) || Number(meta.bytes) < 0) throw new Error('KNOWLEDGE_IMPORT_BYTES_INVALID');
    validateTime(meta.importiertAm, 'importiertAm');
    rejectSecrets(meta);
    return meta;
  }

  function validateNormalizedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== 1) {
      throw new Error('KNOWLEDGE_SNAPSHOT_INVALID');
    }
    if (!Number.isInteger(snapshot.generation) || snapshot.generation < 0) {
      throw new Error('KNOWLEDGE_SNAPSHOT_GENERATION_INVALID');
    }
    if (snapshot.snapshotSha256 != null && !SHA256_RE.test(String(snapshot.snapshotSha256))) {
      throw new Error('KNOWLEDGE_SNAPSHOT_HASH_INVALID');
    }
    if (!Array.isArray(snapshot.facts)) throw new Error('KNOWLEDGE_SNAPSHOT_FACTS_INVALID');
    for (const row of snapshot.facts) {
      if (!row || typeof row !== 'object' || !row.fact) throw new Error('KNOWLEDGE_SNAPSHOT_FACT_ROW_INVALID');
      validateLiveFact(row.fact);
    }
    rejectSecrets(snapshot);
    return snapshot;
  }

  class WindowsBridgeKnowledgeProvider {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.fetchFn = options.fetchFn || (this.root && typeof this.root.fetch === 'function' ? this.root.fetch.bind(this.root) : null);
      this.repository = options.repository || 'Riflex91/Riflex91-Repo';
      this.ref = options.ref || 'main';
      this.snapshotPath = options.snapshotPath || 'v5/wissensbasis/live/snapshot';
      this.timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 8000));
      this.maxFiles = Math.max(1, Math.min(500, Number(options.maxFiles) || 250));
      this.maxTotalBytes = Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Number(options.maxTotalBytes) || 5 * 1024 * 1024));
      this.state = 'IDLE';
      this.mode = null;
      this.lastAttemptAt = null;
      this.lastSuccessAt = null;
      this.lastError = null;
    }

    _sharedRoots() {
      const rows = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!rows.includes(current)) rows.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) { parentWindow = null; }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return rows.reverse();
    }

    _handoff() {
      for (const candidate of this._sharedRoots()) {
        try {
          const value = candidate && candidate.__ALBOT_WINDOWS_BRIDGE_KNOWLEDGE__;
          if (value && typeof value === 'object') return value.snapshot || value;
        } catch (_) {}
      }
      return null;
    }

    _repoParts() {
      const parts = String(this.repository).split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('KNOWLEDGE_REPOSITORY_INVALID');
      return parts;
    }

    _encodePath(path) {
      return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    }

    _rawUrl(path) {
      const [owner, repo] = this._repoParts();
      return 'https://raw.githubusercontent.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo)
        + '/' + encodeURIComponent(this.ref) + '/' + this._encodePath(path);
    }

    _contentsUrl(path) {
      const [owner, repo] = this._repoParts();
      return 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo)
        + '/contents/' + this._encodePath(path) + '?ref=' + encodeURIComponent(this.ref);
    }

    async _fetchBytes(url, label) {
      if (!this.fetchFn) throw new Error('KNOWLEDGE_FETCH_UNAVAILABLE');
      let controller = null;
      let timeout = null;
      try {
        const Controller = this.root && this.root.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
        if (Controller) {
          controller = new Controller();
          const set = this.root && this.root.setTimeout || setTimeout;
          timeout = set(() => controller.abort(), this.timeoutMs);
        }
        const response = await this.fetchFn(url, controller ? { cache: 'no-store', signal: controller.signal } : { cache: 'no-store' });
        if (!response || response.ok !== true) {
          const status = response && response.status != null ? response.status : 'NO_RESPONSE';
          throw new Error('KNOWLEDGE_FETCH_FAILED:' + label + ':HTTP_' + status);
        }
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (!bytes.length) throw new Error('KNOWLEDGE_EMPTY_RESPONSE:' + label);
        return bytes;
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('KNOWLEDGE_FETCH_TIMEOUT:' + label);
        throw error;
      } finally {
        if (timeout != null) {
          const clear = this.root && this.root.clearTimeout || clearTimeout;
          clear(timeout);
        }
      }
    }

    _decode(bytes) {
      return utf8Decoder(this.root).decode(bytes);
    }

    async _sha256Hex(bytes) {
      const cryptoRef = this.root && this.root.crypto || (typeof crypto !== 'undefined' ? crypto : null);
      if (!cryptoRef || !cryptoRef.subtle || typeof cryptoRef.subtle.digest !== 'function') {
        throw new Error('KNOWLEDGE_CRYPTO_UNAVAILABLE');
      }
      const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const digest = await cryptoRef.subtle.digest('SHA-256', input);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    }

    _concat(parts) {
      const total = parts.reduce((sum, bytes) => sum + bytes.length, 0);
      if (total > this.maxTotalBytes * 2) throw new Error('KNOWLEDGE_HASH_INPUT_TOO_LARGE');
      const out = new Uint8Array(total);
      let offset = 0;
      for (const bytes of parts) {
        out.set(bytes, offset);
        offset += bytes.length;
      }
      return out;
    }

    async _listJsonFiles(path) {
      const queue = [path];
      const files = [];
      while (queue.length) {
        const dir = queue.shift();
        const bytes = await this._fetchBytes(this._contentsUrl(dir), 'LIST:' + dir);
        const parsed = parseJson(this._decode(bytes), 'KNOWLEDGE_DIRECTORY_JSON_INVALID');
        if (!Array.isArray(parsed)) throw new Error('KNOWLEDGE_DIRECTORY_RESPONSE_INVALID');
        for (const row of parsed) {
          if (!row || typeof row !== 'object') continue;
          if (row.type === 'dir') {
            queue.push(String(row.path || ''));
            continue;
          }
          if (row.type !== 'file') continue;
          const filePath = String(row.path || '');
          if (!filePath.toLowerCase().endsWith('.json')) throw new Error('KNOWLEDGE_UNEXPECTED_FILE_TYPE');
          files.push(filePath);
          if (files.length > this.maxFiles) throw new Error('KNOWLEDGE_TOO_MANY_FILES');
        }
      }
      return files.sort();
    }

    async _fromHandoff(raw) {
      const snapshot = validateNormalizedSnapshot(clone(raw));
      return {
        ...snapshot,
        source: snapshot.source || 'WINDOWS_BRIDGE_HANDOFF',
        sourceKind: 'WINDOWS_BRIDGE',
        receivedAt: new Date().toISOString(),
        authority: 'PLANNING_EVIDENCE',
        executionAuthority: false
      };
    }

    async _fromMirror() {
      const base = this.snapshotPath.replace(/\/+$/, '');
      const statusBeforeBytes = await this._fetchBytes(this._rawUrl(base + '/status.json'), 'STATUS_BEFORE');
      const statusBeforeText = this._decode(statusBeforeBytes);
      const statusBefore = validateStatus(parseJson(statusBeforeText, 'KNOWLEDGE_STATUS_JSON_INVALID'));
      if (statusBefore.zustand !== 'BEREIT') throw new Error('KNOWLEDGE_SNAPSHOT_NOT_READY');

      const manifestBytes = await this._fetchBytes(this._rawUrl(base + '/manifest.json'), 'MANIFEST');
      const manifest = validateManifest(parseJson(this._decode(manifestBytes), 'KNOWLEDGE_MANIFEST_JSON_INVALID'));

      const importBytes = await this._fetchBytes(this._rawUrl(base + '/import.json'), 'IMPORT');
      const importMeta = validateImportMeta(parseJson(this._decode(importBytes), 'KNOWLEDGE_IMPORT_JSON_INVALID'), statusBefore.generation);

      const currentRoot = base + '/' + manifest.aktuellVerzeichnis;
      const filePaths = await this._listJsonFiles(currentRoot);
      if (filePaths.length !== importMeta.dateien) throw new Error('KNOWLEDGE_FILE_COUNT_MISMATCH');

      let totalBytes = manifestBytes.length + statusBeforeBytes.length;
      const facts = [];
      const hashParts = [manifestBytes, statusBeforeBytes];
      const encoder = utf8Encoder(this.root);

      for (const fullPath of filePaths) {
        const fileBytes = await this._fetchBytes(this._rawUrl(fullPath), 'FACT:' + fullPath);
        totalBytes += fileBytes.length;
        if (totalBytes > this.maxTotalBytes) throw new Error('KNOWLEDGE_TOTAL_BYTES_EXCEEDED');
        const relativePath = fullPath.slice((currentRoot + '/').length);
        const fact = validateLiveFact(parseJson(this._decode(fileBytes), 'KNOWLEDGE_FACT_JSON_INVALID'));
        const fileHash = await this._sha256Hex(fileBytes);
        hashParts.push(encoder.encode(relativePath));
        hashParts.push(encoder.encode(fileHash));
        facts.push({ path: relativePath, fact });
      }

      const statusAfterBytes = await this._fetchBytes(this._rawUrl(base + '/status.json'), 'STATUS_AFTER');
      const statusAfterText = this._decode(statusAfterBytes);
      const statusAfter = validateStatus(parseJson(statusAfterText, 'KNOWLEDGE_STATUS_JSON_INVALID'));
      if (statusAfter.zustand !== 'BEREIT'
        || statusAfter.generation !== statusBefore.generation
        || statusAfterText !== statusBeforeText) {
        throw new Error('KNOWLEDGE_SNAPSHOT_CHANGED_DURING_READ');
      }

      if (Number(importMeta.bytes) !== totalBytes) throw new Error('KNOWLEDGE_TOTAL_BYTES_MISMATCH');
      const snapshotHash = await this._sha256Hex(this._concat(hashParts));
      if (snapshotHash !== importMeta.snapshotSha256) throw new Error('KNOWLEDGE_SNAPSHOT_HASH_MISMATCH');

      return {
        schemaVersion: 1,
        generation: statusBefore.generation,
        source: 'WINDOWS_BRIDGE_GITHUB_MIRROR',
        sourceKind: 'WINDOWS_BRIDGE',
        receivedAt: new Date().toISOString(),
        updatedAt: statusBefore.aktualisiertAm,
        importedAt: importMeta.importiertAm,
        snapshotSha256: snapshotHash,
        status: 'READY',
        authority: 'PLANNING_EVIDENCE',
        executionAuthority: false,
        factCount: facts.length,
        bytes: totalBytes,
        facts
      };
    }

    async getSnapshot() {
      this.lastAttemptAt = new Date().toISOString();
      this.state = 'LOADING';
      this.lastError = null;
      try {
        const handoff = this._handoff();
        const snapshot = handoff ? await this._fromHandoff(handoff) : await this._fromMirror();
        this.state = 'READY';
        this.mode = handoff ? 'HANDOFF' : 'GITHUB_MIRROR';
        this.lastSuccessAt = new Date().toISOString();
        return snapshot;
      } catch (error) {
        const rawError = cleanText(error && error.message || error, 500);
        const waiting = rawError.includes('STATUS_BEFORE:HTTP_404')
          || rawError === 'KNOWLEDGE_SNAPSHOT_NOT_READY';
        this.state = waiting ? 'WAITING_FOR_BRIDGE' : 'UNAVAILABLE';
        this.mode = null;
        this.lastError = waiting ? 'BRIDGE_SNAPSHOT_NOT_AVAILABLE' : rawError;
        if (waiting) throw new Error(this.lastError);
        throw error;
      }
    }

    status() {
      return {
        name: 'windows-bridge',
        state: this.state,
        mode: this.mode,
        readOnly: true,
        repository: this.repository,
        ref: this.ref,
        snapshotPath: this.snapshotPath,
        handoffAvailable: !!this._handoff(),
        lastAttemptAt: this.lastAttemptAt,
        lastSuccessAt: this.lastSuccessAt,
        lastError: this.lastError
      };
    }
  }

  class PersistentKnowledgeService {
    constructor(options = {}) {
      this.logger = options.logger || null;
      this.storage = options.storage || null;
      this.provider = null;
      this.key = options.key || 'albot:knowledge-lkg:v1';
      this.maxPersistChars = Math.max(64 * 1024, Number(options.maxPersistChars) || 3 * 1024 * 1024);
      this.lastGood = null;
      this.lastRefreshAt = null;
      this.lastRefreshError = null;
      this._load();
    }

    _load() {
      if (!this.storage) return;
      const raw = this.storage.get(this.key);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.snapshot) return;
        validateNormalizedSnapshot(parsed.snapshot);
        this.lastGood = {
          receivedAt: parsed.receivedAt || parsed.snapshot.receivedAt || null,
          persistedAt: parsed.persistedAt || null,
          snapshot: parsed.snapshot
        };
      } catch (_) {
        try { this.storage.remove(this.key); } catch (_) {}
      }
    }

    _persist() {
      if (!this.storage || !this.lastGood) return false;
      try {
        const payload = JSON.stringify({
          receivedAt: this.lastGood.receivedAt,
          persistedAt: new Date().toISOString(),
          snapshot: this.lastGood.snapshot
        });
        if (payload.length > this.maxPersistChars) {
          if (this.logger) this.logger.warn('Knowledge-LKG zu groß für persistente Ablage', { chars: payload.length, limit: this.maxPersistChars });
          return false;
        }
        this.storage.set(this.key, payload);
        return true;
      } catch (error) {
        if (this.logger) this.logger.warn('Knowledge-LKG konnte nicht persistiert werden', { error: cleanText(error && error.message || error, 300) });
        return false;
      }
    }

    setProvider(provider) {
      if (provider != null && typeof provider !== 'object') throw new Error('KNOWLEDGE_PROVIDER_INVALID');
      this.provider = provider || null;
      if (this.logger) this.logger.info('KnowledgeProvider gesetzt', { configured: !!provider, provider: provider && provider.status ? provider.status().name : null });
      return this.status();
    }

    async refresh() {
      this.lastRefreshAt = new Date().toISOString();
      this.lastRefreshError = null;
      if (!this.provider || typeof this.provider.getSnapshot !== 'function') return this.status();
      try {
        const snapshot = await this.provider.getSnapshot();
        validateNormalizedSnapshot(snapshot);
        this.lastGood = {
          receivedAt: snapshot.receivedAt || new Date().toISOString(),
          persistedAt: null,
          snapshot: clone(snapshot)
        };
        const persisted = this._persist();
        if (this.logger) this.logger.info('Knowledge-Snapshot aktualisiert', {
          generation: snapshot.generation,
          source: snapshot.source,
          facts: snapshot.factCount != null ? snapshot.factCount : snapshot.facts.length,
          persisted
        });
      } catch (error) {
        this.lastRefreshError = cleanText(error && error.message || error, 500);
        if (this.logger) this.logger.warn('Knowledge-Aktualisierung fehlgeschlagen; Last-Known-Good bleibt erhalten', {
          error: this.lastRefreshError,
          hasLastKnownGood: !!this.lastGood
        });
      }
      return this.status();
    }

    status() {
      let providerStatus = null;
      try { providerStatus = this.provider && typeof this.provider.status === 'function' ? this.provider.status() : null; } catch (_) {}
      const receivedMs = this.lastGood && this.lastGood.receivedAt ? Date.parse(this.lastGood.receivedAt) : NaN;
      return {
        configured: !!this.provider,
        provider: clone(providerStatus),
        lastRefreshAt: this.lastRefreshAt,
        lastRefreshError: this.lastRefreshError,
        usingLastKnownGood: !!this.lastGood && (!providerStatus || providerStatus.state !== 'READY'),
        lastKnownGood: this.lastGood ? {
          receivedAt: this.lastGood.receivedAt,
          ageMs: Number.isFinite(receivedMs) ? Math.max(0, Date.now() - receivedMs) : null,
          generation: this.lastGood.snapshot.generation,
          source: this.lastGood.snapshot.source || null,
          snapshotSha256: this.lastGood.snapshot.snapshotSha256 || null,
          factCount: this.lastGood.snapshot.factCount != null ? this.lastGood.snapshot.factCount : this.lastGood.snapshot.facts.length
        } : null
      };
    }

    snapshot() {
      return this.lastGood ? clone(this.lastGood.snapshot) : null;
    }

    fact(id) {
      const wanted = String(id == null ? '' : id);
      if (!wanted || !this.lastGood) return null;
      const row = this.lastGood.snapshot.facts.find(item => item && item.fact && String(item.fact.kennung) === wanted);
      return row ? clone(row.fact) : null;
    }
  }

  ns.WindowsBridgeKnowledgeProvider = WindowsBridgeKnowledgeProvider;
  ns.KnowledgeService = PersistentKnowledgeService;
  ns.knowledgeValidation = {
    validateLiveFact,
    validateManifest,
    validateStatus,
    validateImportMeta,
    validateNormalizedSnapshot
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
