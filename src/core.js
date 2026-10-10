(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__ = root.__ALBOT_INTERNALS__ || {};

  const COMBAT_CLASSES = new Set(['warrior', 'paladin', 'rogue', 'ranger', 'mage', 'priest']);
  const ACTIVE_STATES = new Set(['self', 'starting', 'loading', 'active', 'code']);

  function nowIso() { return new Date().toISOString(); }
  function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }
  function cleanText(value, max = 200) {
    const text = String(value == null ? '' : value).trim();
    return text.slice(0, max);
  }
  function safeJsonParse(value, fallback) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  function onlineFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return !['', '0', 'false', 'offline', 'none', 'null', 'undefined'].includes(normalized);
  }
  function readFn(rootRef, name) {
    if (rootRef && typeof rootRef[name] === 'function') return rootRef[name].bind(rootRef);
    if (rootRef && rootRef.parent && typeof rootRef.parent[name] === 'function') return rootRef.parent[name].bind(rootRef.parent);
    return null;
  }

  class EventBus {
    constructor() { this.listeners = new Map(); }
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      const set = this.listeners.get(type) || new Set();
      set.add(fn); this.listeners.set(type, set);
      return () => set.delete(fn);
    }
    emit(type, payload) {
      const set = this.listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (_) {}
      }
    }
    clear() { this.listeners.clear(); }
  }

  class Logger {
    constructor(options = {}) {
      this.limit = Math.max(50, Math.min(1000, Number(options.limit) || 250));
      this.entries = [];
      this.bus = options.bus || null;
    }
    write(level, message, data) {
      const row = { at: nowIso(), level: String(level || 'INFO').toUpperCase(), message: cleanText(message, 500), data: clone(data) };
      this.entries.push(row);
      if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
      if (this.bus) this.bus.emit('log', row);
      return row;
    }
    info(m, d) { return this.write('INFO', m, d); }
    warn(m, d) { return this.write('WARN', m, d); }
    error(m, d) { return this.write('ERROR', m, d); }
    list(limit = 100) { return clone(this.entries.slice(-Math.max(1, limit))); }
    clear() { this.entries.length = 0; }
  }

  // H41: Production runtime persistence goes only to the local SSD writer.
  // Legacy localStorage is NOT a runtime storage fallback. The test-only
  // branch below preserves Node VM fixtures that do not expose XMLHttpRequest.
  class StorageAdapter {
    constructor(rootRef) {
      this.root = rootRef;
      this.memory = new Map();
      this.endpoint = 'http://127.0.0.1:17391';
      this.mode = rootRef && typeof rootRef.XMLHttpRequest === 'function'
        ? 'SSD_ONLY' : 'NON_BROWSER_TEST_FIXTURE';
      this.lastProbeMs = 0;
      this.hostAvailable = false;
      this.failureUntilMs = 0;
      this.lastError = null;
      this.metrics = { reads: 0, writes: 0, deletes: 0, failures: 0 };
    }
    _legacyFixture() {
      // A native Adventure Land browser always exposes XMLHttpRequest.
      if (this.mode !== 'NON_BROWSER_TEST_FIXTURE') return null;
      try { return this.root && this.root.localStorage || null; } catch (_) { return null; }
    }
    _failure(error) {
      this.hostAvailable = false;
      this.failureUntilMs = Date.now() + 2000;
      this.lastError = String(error && error.message || error || 'SSD_HOST_UNAVAILABLE').slice(0,250);
      this.metrics.failures++;
      return null;
    }
    _request(method, path, payload) {
      if (Date.now() < this.failureUntilMs) return null;
      try {
        const xhr = new this.root.XMLHttpRequest();
        xhr.open(method, this.endpoint + path, false);
        if (method === 'POST') xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        xhr.send(payload == null ? null : JSON.stringify(payload));
        if (xhr.status !== 200 || !xhr.responseText) throw new Error('SSD_HTTP_' + xhr.status);
        const value = JSON.parse(xhr.responseText);
        if (!value || value.ok !== true) throw new Error('SSD_RESPONSE_INVALID');
        this.hostAvailable = true;
        this.failureUntilMs = 0;
        this.lastError = null;
        return value;
      } catch (error) { return this._failure(error); }
    }
    _key(key) {
      const text = String(key == null ? '' : key);
      // Keep all of AL Bot's keys, including existing extension keys, but
      // do not permit arbitrary browser-origin filesystem access.
      if (!text.startsWith('albot:') || text.length > 512) return null;
      return '/v1/kv?key=' + encodeURIComponent(text);
    }
    sharedAvailable() {
      if (this.mode === 'NON_BROWSER_TEST_FIXTURE') return !!this._legacyFixture();
      const now = Date.now();
      if (now < this.failureUntilMs) return false;
      if (now - this.lastProbeMs > 1500 || !this.lastProbeMs) {
        this.lastProbeMs = now;
        const health = this._request('GET', '/health');
        const root = health && health.kvStore && String(health.kvStore.root || '').replace(/\\/g, '/').toLowerCase();
        if (!root || !root.startsWith('d:/albot/state/kv')) return !!this._failure('SSD_ROOT_MUST_BE_D_ALBOT');
      }
      return this.hostAvailable;
    }
    get(key) { return this.getShared(key); }
    set(key, value) { return this.setShared(key, value); }
    remove(key) { return this.removeShared(key); }
    getShared(key) {
      if (this.mode === 'NON_BROWSER_TEST_FIXTURE') {
        const ls = this._legacyFixture();
        if (ls) try { return ls.getItem(key); } catch (_) {}
        return this.memory.get(key) ?? null;
      }
      const uri = this._key(key);
      if (!uri) return null;
      const response = this._request('GET', uri);
      if (response) this.metrics.reads++;
      return response ? response.value : null;
    }
    setShared(key, value) {
      if (this.mode === 'NON_BROWSER_TEST_FIXTURE') {
        const ls = this._legacyFixture();
        if (ls) try { ls.setItem(key, String(value)); return true; } catch (_) {}
        this.memory.set(key, String(value)); return true;
      }
      const uri = this._key(key);
      if (!uri) return false;
      const response = this._request('POST', uri, { value: String(value) });
      if (response) this.metrics.writes++;
      return !!response;
    }
    removeShared(key) {
      if (this.mode === 'NON_BROWSER_TEST_FIXTURE') {
        const ls = this._legacyFixture();
        if (ls) try { ls.removeItem(key); return true; } catch (_) {}
        return this.memory.delete(key);
      }
      const uri = this._key(key);
      if (!uri) return false;
      const response = this._request('POST', uri, { operation: 'DELETE' });
      if (response) this.metrics.deletes++;
      return !!response;
    }
    status() {
      return { backend: this.mode, hostAvailable: this.sharedAvailable(),
        root: 'D:/ALBot/state/kv', endpoint: this.endpoint,
        lastError: this.lastError, metrics: { ...this.metrics } };
    }
  }

  class EmergencyStop {
    constructor(options = {}) {
      this.storage = options.storage;
      this.logger = options.logger;
      this.bus = options.bus;
      this.key = options.key || 'albot:emergency-stop:v1';
      this.state = { latched: false, reason: null, at: null };
      this._load();
    }
    _load() {
      const raw = this.storage && this.storage.get(this.key);
      const parsed = raw ? safeJsonParse(raw, null) : null;
      if (parsed && parsed.latched === true) this.state = { latched: true, reason: cleanText(parsed.reason || 'PERSISTED_STOP', 200), at: parsed.at || null };
    }
    _persist() {
      if (this.storage) this.storage.set(this.key, JSON.stringify(this.state));
    }
    latch(reason = 'MANUAL_STOP') {
      if (!this.state.latched) {
        this.state = { latched: true, reason: cleanText(reason, 200) || 'MANUAL_STOP', at: nowIso() };
        this._persist();
        if (this.logger) this.logger.error('GLOBALER STOP AKTIVIERT', this.state);
        if (this.bus) this.bus.emit('emergency-stop', this.status());
      }
      return this.status();
    }
    reset() {
      const previous = this.status();
      this.state = { latched: false, reason: null, at: null };
      this._persist();
      if (this.logger) this.logger.warn('Globaler STOP wurde manuell zurückgesetzt', { previous });
      if (this.bus) this.bus.emit('emergency-reset', this.status());
      return this.status();
    }
    assertAllowed(action = 'action') {
      if (this.state.latched) throw new Error('ALBOT_EMERGENCY_STOP:' + action);
      return true;
    }
    status() { return clone(this.state); }
  }

  class ModuleRegistry {
    constructor(options = {}) { this.modules = new Map(); this.logger = options.logger; }
    register(definition) {
      if (!definition || !cleanText(definition.id, 80)) throw new Error('MODULE_ID_REQUIRED');
      const id = cleanText(definition.id, 80);
      if (this.modules.has(id)) throw new Error('MODULE_ALREADY_REGISTERED:' + id);
      const row = {
        id,
        title: cleanText(definition.title || id, 120),
        version: cleanText(definition.version || '0.0.0', 40),
        state: 'REGISTERED',
        start: typeof definition.start === 'function' ? definition.start : null,
        stop: typeof definition.stop === 'function' ? definition.stop : null,
        status: typeof definition.status === 'function' ? definition.status : null
      };
      this.modules.set(id, row);
      if (this.logger) this.logger.info('Modul registriert', { id, version: row.version });
      return this.describe(id);
    }
    async startAll(context) {
      const results = [];
      for (const row of this.modules.values()) {
        try {
          if (row.start) await row.start(context);
          row.state = 'ACTIVE';
          results.push({ id: row.id, ok: true });
        } catch (error) {
          row.state = 'ERROR';
          const errorText = cleanText(error && error.message || error, 300);
          results.push({ id: row.id, ok: false, error: errorText });
          if (this.logger) this.logger.error('Modulstart fehlgeschlagen', { id: row.id, error: errorText });
        }
      }
      return results;
    }
    async stopAll(reason = 'STOP') {
      const results = [];
      for (const row of [...this.modules.values()].reverse()) {
        try {
          if (row.stop) await row.stop(reason);
          row.state = 'STOPPED';
          results.push({ id: row.id, ok: true });
        } catch (error) {
          row.state = 'ERROR';
          const errorText = cleanText(error && error.message || error, 300);
          results.push({ id: row.id, ok: false, error: errorText });
          if (this.logger) this.logger.error('Modulstop fehlgeschlagen', { id: row.id, error: errorText });
        }
      }
      return results;
    }
    describe(id) {
      const row = this.modules.get(id);
      if (!row) return null;
      let details = null;
      try { details = row.status ? row.status() : null; } catch (error) { details = { error: cleanText(error && error.message || error, 300) }; }
      return { id: row.id, title: row.title, version: row.version, state: row.state, details: clone(details) };
    }
    list() { return [...this.modules.keys()].map(id => this.describe(id)); }
  }

  class GoalService {
    constructor(options = {}) {
      this.storage = options.storage;
      this.logger = options.logger;
      this.key = options.key || 'albot:goals:v1';
      this.priorityKey = options.priorityKey || 'albot:strategic-priorities:v2';
      this.goals = [];
      this.priorities = {
        leveling: 'NORMAL', gold: 'NORMAL', gear: 'HIGH', items: 'NORMAL', events: 'NORMAL', quests: 'LOW', economy: 'NORMAL'
      };
      this._load();
    }
    _load() {
      const goals = safeJsonParse(this.storage.get(this.key), []);
      const priorities = safeJsonParse(this.storage.get(this.priorityKey), null);
      if (Array.isArray(goals)) this.goals = goals.filter(g => g && g.id).slice(-100);
      if (priorities && typeof priorities === 'object') this.priorities = { ...this.priorities, ...priorities };
    }
    _save() {
      this.storage.set(this.key, JSON.stringify(this.goals));
      this.storage.set(this.priorityKey, JSON.stringify(this.priorities));
    }
    add(input = {}) {
      const type = cleanText(input.type || 'CUSTOM', 50).toUpperCase();
      const target = cleanText(input.target || '', 120);
      if (!target && type !== 'GEAR') throw new Error('GOAL_TARGET_REQUIRED');
      const amount = input.amount == null || input.amount === '' ? null : Number(input.amount);
      if (amount != null && (!Number.isFinite(amount) || amount <= 0)) throw new Error('GOAL_AMOUNT_INVALID');
      const id = 'goal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const goal = {
        id, type, target, amount,
        progress: 0,
        priority: cleanText(input.priority || 'NORMAL', 20).toUpperCase(),
        scope: cleanText(input.scope || 'PARTY', 50).toUpperCase(),
        status: 'ACTIVE',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        completion: cleanText(input.completion || '', 250) || null,
        blockedReason: null
      };
      this.goals.unshift(goal);
      this.goals = this.goals.slice(0, 100);
      this._save();
      if (this.logger) this.logger.info('Goal angelegt', goal);
      return clone(goal);
    }
    setStatus(id, status) {
      const allowed = new Set(['ACTIVE','PAUSED','COMPLETED','BLOCKED','CANCELLED','ERROR']);
      status = String(status || '').toUpperCase();
      if (!allowed.has(status)) throw new Error('GOAL_STATUS_INVALID');
      const goal = this.goals.find(g => g.id === id);
      if (!goal) throw new Error('GOAL_NOT_FOUND');
      goal.status = status; goal.updatedAt = nowIso();
      this._save();
      if (this.logger) this.logger.info('Goal-Status geändert', { id, status });
      return clone(goal);
    }
    setProgress(id, progress) {
      const goal = this.goals.find(g => g.id === id);
      if (!goal) throw new Error('GOAL_NOT_FOUND');
      const value = Number(progress);
      if (!Number.isFinite(value) || value < 0) throw new Error('GOAL_PROGRESS_INVALID');
      goal.progress = value; goal.updatedAt = nowIso();
      if (goal.amount != null && value >= goal.amount) goal.status = 'COMPLETED';
      this._save(); return clone(goal);
    }
    remove(id) {
      const index = this.goals.findIndex(g => g.id === id);
      if (index < 0) throw new Error('GOAL_NOT_FOUND');
      const [removed] = this.goals.splice(index, 1);
      this._save();
      if (this.logger) this.logger.warn('Goal gelöscht', { id, type: removed.type, target: removed.target });
      return clone(removed);
    }
    setPriority(name, value) {
      const allowed = new Set(['LOW','NORMAL','HIGH','CRITICAL']);
      value = String(value || '').toUpperCase();
      if (!allowed.has(value)) throw new Error('STRATEGIC_PRIORITY_INVALID');
      if (!(name in this.priorities)) throw new Error('STRATEGIC_PRIORITY_UNKNOWN');
      this.priorities[name] = value; this._save();
      return this.getPriorities();
    }
    list() { return clone(this.goals); }
    getPriorities() { return clone(this.priorities); }
  }

  class KnowledgeService {
    constructor(options = {}) {
      this.logger = options.logger;
      this.provider = null;
      this.lastGood = null;
    }
    setProvider(provider) {
      if (provider != null && typeof provider !== 'object') throw new Error('KNOWLEDGE_PROVIDER_INVALID');
      this.provider = provider || null;
      if (this.logger) this.logger.info('KnowledgeProvider gesetzt', { configured: !!provider });
      return this.status();
    }
    async refresh() {
      if (!this.provider || typeof this.provider.getSnapshot !== 'function') return this.status();
      try {
        const snapshot = await this.provider.getSnapshot();
        if (!snapshot || typeof snapshot !== 'object') throw new Error('KNOWLEDGE_SNAPSHOT_INVALID');
        this.lastGood = { receivedAt: nowIso(), snapshot: clone(snapshot) };
        if (this.logger) this.logger.info('Knowledge-Snapshot aktualisiert', { generation: snapshot.generation ?? null });
      } catch (error) {
        if (this.logger) this.logger.warn('Knowledge-Aktualisierung fehlgeschlagen; Last-Known-Good bleibt erhalten', { error: cleanText(error && error.message || error, 300) });
      }
      return this.status();
    }
    status() {
      let providerStatus = null;
      try { providerStatus = this.provider && typeof this.provider.status === 'function' ? this.provider.status() : null; } catch (_) {}
      return {
        configured: !!this.provider,
        provider: clone(providerStatus),
        lastKnownGood: this.lastGood ? {
          receivedAt: this.lastGood.receivedAt,
          generation: this.lastGood.snapshot && this.lastGood.snapshot.generation != null ? this.lastGood.snapshot.generation : null,
          source: this.lastGood.snapshot && this.lastGood.snapshot.source || null
        } : null
      };
    }
    snapshot() { return this.lastGood ? clone(this.lastGood.snapshot) : null; }
  }

  class CharacterRosterService {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger;
      this.last = null;
    }
    _local() {
      const c = this.root && (this.root.character || this.root.parent && this.root.parent.character);
      if (!c || !c.name) return null;
      return { name: cleanText(c.name, 80), ctype: cleanText(c.ctype || c.type || '', 40).toLowerCase(), level: Number.isFinite(Number(c.level)) ? Number(c.level) : null, online: true, state: 'self' };
    }
    _accountRows() {
      const fn = readFn(this.root, 'get_characters');
      if (!fn) return { available: false, rows: [] };
      try {
        const raw = fn();
        const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
        return { available: raw != null, rows: rows.map(row => ({
          name: cleanText(row && row.name || '', 80),
          ctype: cleanText(row && (row.ctype || row.type) || '', 40).toLowerCase(),
          level: Number.isFinite(Number(row && row.level)) ? Number(row.level) : null,
          online: onlineFlag(row && row.online)
        })).filter(row => row.name) };
      } catch (_) { return { available: false, rows: [] }; }
    }
    _activeRows() {
      const fn = readFn(this.root, 'get_active_characters');
      if (!fn) return { available: false, rows: [] };
      try {
        const raw = fn();
        const rows = [];
        if (raw && typeof raw === 'object') {
          for (const [name, state] of Object.entries(raw)) {
            const normalized = cleanText(state, 30).toLowerCase();
            if (ACTIVE_STATES.has(normalized)) rows.push({ name: cleanText(name, 80), state: normalized });
          }
        }
        return { available: raw != null, rows };
      } catch (_) { return { available: false, rows: [] }; }
    }
    refresh() {
      const local = this._local();
      const account = this._accountRows();
      const active = this._activeRows();
      const byName = new Map();
      for (const row of account.rows) byName.set(row.name, { ...row, state: null });
      for (const row of active.rows) {
        const existing = byName.get(row.name) || { name: row.name, ctype: '', online: true };
        byName.set(row.name, { ...existing, online: true, state: row.state });
      }
      if (local) {
        const existing = byName.get(local.name) || local;
        byName.set(local.name, { ...existing, ...local, ctype: local.ctype || existing.ctype });
      }
      const characters = [...byName.values()].filter(row => row.online || row.state).sort((a,b) => a.name.localeCompare(b.name));
      const accountCharacters = account.rows.slice().sort((a,b) => a.name.localeCompare(b.name));
      const onlineCharacterNames = [...new Set([
        ...account.rows.filter(row => row.online === true).map(row => row.name),
        ...(local && local.name ? [local.name] : [])
      ])].sort((a,b) => a.localeCompare(b));
      const activeCharacterNames = [...new Set([
        ...active.rows.map(row => row.name),
        ...(local && local.name ? [local.name] : [])
      ])].sort((a,b) => a.localeCompare(b));
      const farmers = characters.filter(row => COMBAT_CLASSES.has(row.ctype));
      const merchants = characters.filter(row => row.ctype === 'merchant');
      this.last = {
        observedAt: nowIso(),
        source: account.available ? 'get_characters+get_active_characters' : active.available ? 'get_active_characters-fallback' : 'local-only',
        accountStateAvailable: account.available,
        onlineStateAvailable: account.available,
        activeStateAvailable: active.available,
        local,
        characters,
        accountCharacters,
        onlineCharacterNames,
        activeCharacterNames,
        runnerActiveCharacterNames: activeCharacterNames,
        farmers,
        merchant: merchants.length === 1 ? merchants[0] : null,
        merchantCandidates: merchants,
        hardcodedNamesRequired: false
      };
      return this.status();
    }
    status() { return clone(this.last || this.refresh()); }
  }

  ns.EventBus = EventBus;
  ns.Logger = Logger;
  ns.StorageAdapter = StorageAdapter;
  ns.EmergencyStop = EmergencyStop;
  ns.ModuleRegistry = ModuleRegistry;
  ns.GoalService = GoalService;
  ns.KnowledgeService = KnowledgeService;
  ns.CharacterRosterService = CharacterRosterService;
  ns.helpers = { clone, cleanText, nowIso, onlineFlag, COMBAT_CLASSES, ACTIVE_STATES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
