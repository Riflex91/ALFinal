/* AL Bot 0.20.0-h20 | generated file | do not edit dist directly */
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

  class StorageAdapter {
    constructor(rootRef) { this.root = rootRef; this.memory = new Map(); }
    _ls() {
      try { return this.root && this.root.localStorage ? this.root.localStorage : null; } catch (_) { return null; }
    }
    get(key) {
      const ls = this._ls();
      if (ls) { try { return ls.getItem(key); } catch (_) {} }
      return this.memory.has(key) ? this.memory.get(key) : null;
    }
    set(key, value) {
      const ls = this._ls();
      if (ls) { try { ls.setItem(key, value); return true; } catch (_) {} }
      this.memory.set(key, value); return true;
    }
    remove(key) {
      const ls = this._ls();
      if (ls) { try { ls.removeItem(key); } catch (_) {} }
      this.memory.delete(key);
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


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function errorDetails(error) {
    return {
      name: cleanText(error && error.name || 'Error', 80),
      message: cleanText(error && error.message || error || 'Unknown error', 500),
      stack: error && error.stack ? String(error.stack).slice(0, 4000) : null
    };
  }

  class ResourceScope {
    constructor(scheduler, owner) {
      this.scheduler = scheduler;
      this.owner = owner;
      this.closed = false;
    }
    _open() {
      if (this.closed) throw new Error('RESOURCE_SCOPE_CLOSED:' + this.owner);
      return true;
    }
    timeout(label, fn, delayMs) {
      this._open();
      return this.scheduler.timeout(this.owner, label, fn, delayMs);
    }
    interval(label, fn, delayMs, options) {
      this._open();
      return this.scheduler.interval(this.owner, label, fn, delayMs, options);
    }
    event(label, target, eventName, handler, options) {
      this._open();
      return this.scheduler.event(this.owner, label, target, eventName, handler, options);
    }
    cleanup(label, fn) {
      this._open();
      return this.scheduler.cleanup(this.owner, label, fn);
    }
    cancel(id, reason) {
      return this.scheduler.cancel(id, reason || 'SCOPE_CANCEL');
    }
    status() {
      return this.scheduler.ownerStatus(this.owner);
    }
    close(reason) {
      if (this.closed) return this.status();
      this.closed = true;
      this.scheduler.cancelOwner(this.owner, reason || 'SCOPE_CLOSED');
      return this.status();
    }
  }

  class Scheduler {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.bus = options.bus || null;
      this.enabled = false;
      this.generation = 0;
      this.sequence = 0;
      this.resources = new Map();
      this.errorHandler = typeof options.onError === 'function' ? options.onError : null;
      this.metrics = {
        created: 0,
        cancelled: 0,
        callbackErrors: 0,
        skippedOverlaps: 0
      };
      this.lastError = null;
    }

    setErrorHandler(fn) {
      this.errorHandler = typeof fn === 'function' ? fn : null;
    }

    start() {
      if (!this.enabled) {
        this.enabled = true;
        this.generation += 1;
        if (this.logger) this.logger.info('Scheduler gestartet', { generation: this.generation });
      }
      return this.status();
    }

    stop(reason = 'SCHEDULER_STOP') {
      this.enabled = false;
      this.cancelAll(reason);
      if (this.logger) this.logger.warn('Scheduler gestoppt', { reason, generation: this.generation });
      return this.status();
    }

    scope(owner) {
      owner = cleanText(owner, 120);
      if (!owner) throw new Error('SCHEDULER_OWNER_REQUIRED');
      return new ResourceScope(this, owner);
    }

    _id(kind, owner, label) {
      this.sequence += 1;
      return kind + ':' + this.sequence + ':' + owner + ':' + cleanText(label || kind, 80);
    }

    _assertEnabled() {
      if (!this.enabled) throw new Error('SCHEDULER_NOT_RUNNING');
    }

    _reportError(record, error) {
      const details = {
        at: new Date().toISOString(),
        resourceId: record && record.id || null,
        owner: record && record.owner || null,
        label: record && record.label || null,
        kind: record && record.kind || null,
        error: errorDetails(error)
      };
      this.metrics.callbackErrors += 1;
      this.lastError = details;
      if (this.logger) this.logger.error('Scheduler-Callback fehlgeschlagen', details);
      if (this.bus) this.bus.emit('scheduler-error', clone(details));
      if (this.errorHandler) {
        try { this.errorHandler(clone(details)); } catch (_) {}
      }
    }

    _invoke(record, fn, args, allowOverlap = false) {
      if (!record || record.cancelled || !this.enabled) return;
      if (!allowOverlap && record.running) {
        record.skippedOverlaps += 1;
        this.metrics.skippedOverlaps += 1;
        return;
      }
      record.running = true;
      record.lastRunAt = new Date().toISOString();
      record.runCount += 1;
      let result;
      try {
        result = fn.apply(null, args || []);
      } catch (error) {
        record.running = false;
        record.errorCount += 1;
        this._reportError(record, error);
        return;
      }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(error => {
          record.errorCount += 1;
          this._reportError(record, error);
        }).finally(() => {
          record.running = false;
        });
      } else {
        record.running = false;
      }
    }

    timeout(owner, label, fn, delayMs) {
      this._assertEnabled();
      if (typeof fn !== 'function') throw new Error('SCHEDULER_CALLBACK_REQUIRED');
      const delay = Math.max(0, Number(delayMs) || 0);
      const id = this._id('timeout', owner, label);
      const record = {
        id, kind: 'timeout', owner: cleanText(owner, 120), label: cleanText(label || 'timeout', 120),
        delayMs: delay, createdAt: new Date().toISOString(), running: false, cancelled: false,
        runCount: 0, errorCount: 0, skippedOverlaps: 0, handle: null
      };
      record.handle = this.root.setTimeout(() => {
        if (!this.resources.has(id)) return;
        this.resources.delete(id);
        this._invoke(record, fn, []);
      }, delay);
      this.resources.set(id, record);
      this.metrics.created += 1;
      return id;
    }

    interval(owner, label, fn, delayMs, options = {}) {
      this._assertEnabled();
      if (typeof fn !== 'function') throw new Error('SCHEDULER_CALLBACK_REQUIRED');
      const delay = Math.max(10, Number(delayMs) || 10);
      const id = this._id('interval', owner, label);
      const record = {
        id, kind: 'interval', owner: cleanText(owner, 120), label: cleanText(label || 'interval', 120),
        delayMs: delay, createdAt: new Date().toISOString(), running: false, cancelled: false,
        runCount: 0, errorCount: 0, skippedOverlaps: 0, handle: null
      };
      record.handle = this.root.setInterval(() => this._invoke(record, fn, [], options.allowOverlap === true), delay);
      this.resources.set(id, record);
      this.metrics.created += 1;
      if (options.immediate === true) this._invoke(record, fn, [], options.allowOverlap === true);
      return id;
    }

    event(owner, label, target, eventName, handler, options) {
      this._assertEnabled();
      if (!target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
        throw new Error('SCHEDULER_EVENT_TARGET_INVALID');
      }
      if (typeof handler !== 'function') throw new Error('SCHEDULER_CALLBACK_REQUIRED');
      const id = this._id('event', owner, label);
      const record = {
        id, kind: 'event', owner: cleanText(owner, 120), label: cleanText(label || eventName, 120),
        eventName: cleanText(eventName, 120), createdAt: new Date().toISOString(),
        running: false, cancelled: false, runCount: 0, errorCount: 0, skippedOverlaps: 0,
        target, options, wrapped: null
      };
      record.wrapped = (...args) => this._invoke(record, handler, args);
      target.addEventListener(eventName, record.wrapped, options);
      this.resources.set(id, record);
      this.metrics.created += 1;
      return id;
    }

    cleanup(owner, label, fn) {
      this._assertEnabled();
      if (typeof fn !== 'function') throw new Error('SCHEDULER_CLEANUP_REQUIRED');
      const id = this._id('cleanup', owner, label);
      this.resources.set(id, {
        id, kind: 'cleanup', owner: cleanText(owner, 120), label: cleanText(label || 'cleanup', 120),
        createdAt: new Date().toISOString(), cancelled: false, cleanupFn: fn,
        runCount: 0, errorCount: 0, skippedOverlaps: 0, running: false
      });
      this.metrics.created += 1;
      return id;
    }

    cancel(id, reason = 'CANCEL') {
      const record = this.resources.get(id);
      if (!record) return false;
      this.resources.delete(id);
      record.cancelled = true;
      try {
        if (record.kind === 'timeout') this.root.clearTimeout(record.handle);
        else if (record.kind === 'interval') this.root.clearInterval(record.handle);
        else if (record.kind === 'event') record.target.removeEventListener(record.eventName, record.wrapped, record.options);
        else if (record.kind === 'cleanup') record.cleanupFn(reason);
      } catch (error) {
        this._reportError(record, error);
      }
      this.metrics.cancelled += 1;
      return true;
    }

    cancelOwner(owner, reason = 'OWNER_CANCEL') {
      const ids = [...this.resources.values()].filter(row => row.owner === owner).map(row => row.id);
      for (const id of ids) this.cancel(id, reason);
      return ids.length;
    }

    cancelAll(reason = 'CANCEL_ALL') {
      const ids = [...this.resources.keys()];
      for (const id of ids) this.cancel(id, reason);
      return ids.length;
    }

    ownerStatus(owner) {
      const rows = [...this.resources.values()].filter(row => row.owner === owner);
      return {
        owner,
        resources: rows.map(row => ({
          id: row.id, kind: row.kind, label: row.label, delayMs: row.delayMs || null,
          runCount: row.runCount || 0, errorCount: row.errorCount || 0,
          skippedOverlaps: row.skippedOverlaps || 0, running: row.running === true
        }))
      };
    }

    status() {
      const rows = [...this.resources.values()];
      const count = kind => rows.filter(row => row.kind === kind).length;
      const owners = {};
      for (const row of rows) owners[row.owner] = (owners[row.owner] || 0) + 1;
      return {
        enabled: this.enabled,
        generation: this.generation,
        totalResources: rows.length,
        intervals: count('interval'),
        timeouts: count('timeout'),
        listeners: count('event'),
        cleanups: count('cleanup'),
        owners,
        metrics: clone(this.metrics),
        lastError: clone(this.lastError)
      };
    }
  }

  class StableModuleRegistry {
    constructor(options = {}) {
      this.modules = new Map();
      this.logger = options.logger || null;
      this.scheduler = options.scheduler || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    }

    register(definition) {
      if (!definition || !cleanText(definition.id, 80)) throw new Error('MODULE_ID_REQUIRED');
      const id = cleanText(definition.id, 80);
      if (this.modules.has(id)) throw new Error('MODULE_ALREADY_REGISTERED:' + id);
      const watchdogMsRaw = Number(definition.watchdogMs);
      const row = {
        id,
        title: cleanText(definition.title || id, 120),
        version: cleanText(definition.version || '0.0.0', 40),
        state: 'REGISTERED',
        health: 'IDLE',
        start: typeof definition.start === 'function' ? definition.start : null,
        stop: typeof definition.stop === 'function' ? definition.stop : null,
        status: typeof definition.status === 'function' ? definition.status : null,
        watchdogMs: Number.isFinite(watchdogMsRaw) && watchdogMsRaw > 0 ? Math.max(250, watchdogMsRaw) : null,
        scope: null,
        context: null,
        startedAt: null,
        stoppedAt: null,
        lastHeartbeatAtMs: null,
        lastHeartbeat: null,
        lastError: null,
        startCount: 0,
        stopCount: 0,
        restartCount: 0,
        crashCount: 0
      };
      this.modules.set(id, row);
      if (this.logger) this.logger.info('Modul registriert', { id, version: row.version, watchdogMs: row.watchdogMs });
      return this.describe(id);
    }

    has(id) { return this.modules.has(id); }

    _context(row, baseContext) {
      if (row.context) return row.context;
      const scope = this.scheduler ? this.scheduler.scope('module:' + row.id) : null;
      row.scope = scope;
      row.context = {
        ...(baseContext || {}),
        module: { id: row.id, title: row.title, version: row.version },
        scope,
        scheduler: this.scheduler,
        heartbeat: details => {
          row.lastHeartbeatAtMs = this.now();
          row.lastHeartbeat = clone(details || null);
          if (row.state === 'ACTIVE') row.health = 'HEALTHY';
          return row.lastHeartbeatAtMs;
        }
      };
      return row.context;
    }

    async startOne(id, baseContext) {
      const row = this.modules.get(id);
      if (!row) throw new Error('MODULE_NOT_FOUND:' + id);
      if (row.state === 'ACTIVE' || row.state === 'STARTING') return this.describe(id);
      row.state = 'STARTING';
      row.health = 'STARTING';
      row.lastError = null;
      const context = this._context(row, baseContext);
      try {
        if (row.start) await row.start(context);
        row.state = 'ACTIVE';
        row.health = 'HEALTHY';
        row.startedAt = new Date().toISOString();
        row.startCount += 1;
        context.heartbeat({ phase: 'start' });
        if (this.logger) this.logger.info('Modul gestartet', { id });
        return this.describe(id);
      } catch (error) {
        row.state = 'ERROR';
        row.health = 'ERROR';
        row.crashCount += 1;
        row.lastError = errorDetails(error);
        if (row.scope) row.scope.close('MODULE_START_FAILED');
        row.scope = null;
        row.context = null;
        if (this.logger) this.logger.error('Modulstart fehlgeschlagen', { id, error: row.lastError });
        return this.describe(id);
      }
    }

    async stopOne(id, reason = 'STOP') {
      const row = this.modules.get(id);
      if (!row) throw new Error('MODULE_NOT_FOUND:' + id);
      if (row.state === 'STOPPED' || row.state === 'REGISTERED') {
        if (row.scope) row.scope.close(reason);
        row.scope = null;
        row.context = null;
        row.state = 'STOPPED';
        row.health = 'IDLE';
        return this.describe(id);
      }
      row.state = 'STOPPING';
      let stopError = null;
      try {
        if (row.stop) await row.stop(reason, row.context);
      } catch (error) {
        stopError = error;
        row.lastError = errorDetails(error);
        if (this.logger) this.logger.error('Modulstop fehlgeschlagen', { id, error: row.lastError });
      } finally {
        if (row.scope) row.scope.close(reason);
        else if (this.scheduler) this.scheduler.cancelOwner('module:' + row.id, reason);
        row.scope = null;
        row.context = null;
        row.state = 'STOPPED';
        row.health = stopError ? 'STOPPED_WITH_ERROR' : 'IDLE';
        row.stoppedAt = new Date().toISOString();
        row.stopCount += 1;
      }
      return this.describe(id);
    }

    async restartOne(id, baseContext, reason = 'RESTART') {
      const row = this.modules.get(id);
      if (!row) throw new Error('MODULE_NOT_FOUND:' + id);
      row.restartCount += 1;
      await this.stopOne(id, reason);
      return this.startOne(id, baseContext);
    }

    async startAll(baseContext) {
      const results = [];
      for (const row of this.modules.values()) results.push(await this.startOne(row.id, baseContext));
      return results;
    }

    async stopAll(reason = 'STOP') {
      const rows = [...this.modules.values()].reverse();
      const results = [];
      for (const row of rows) results.push(await this.stopOne(row.id, reason));
      return results;
    }

    forceCleanup(reason = 'FORCE_CLEANUP') {
      for (const row of this.modules.values()) {
        try {
          if (row.stop) {
            const maybePromise = row.stop(reason, row.context);
            if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
          }
        } catch (_) {}
        if (row.scope) {
          try { row.scope.close(reason); } catch (_) {}
        } else if (this.scheduler) {
          this.scheduler.cancelOwner('module:' + row.id, reason);
        }
        row.scope = null;
        row.context = null;
        row.state = 'STOPPED';
        row.health = 'IDLE';
        row.stoppedAt = new Date().toISOString();
      }
    }

    handleResourceError(details) {
      const owner = details && details.owner || '';
      if (!owner.startsWith('module:')) return false;
      const id = owner.slice('module:'.length);
      const row = this.modules.get(id);
      if (!row) return false;
      row.state = 'ERROR';
      row.health = 'ERROR';
      row.crashCount += 1;
      row.lastError = clone(details.error || details);
      if (this.scheduler) this.scheduler.cancelOwner(owner, 'MODULE_CRASH_ISOLATION');
      row.scope = null;
      row.context = null;
      if (this.logger) this.logger.error('Modul durch Crash-Isolation angehalten', { id, error: row.lastError });
      return true;
    }

    checkWatchdogs() {
      const at = this.now();
      const stale = [];
      for (const row of this.modules.values()) {
        if (row.state !== 'ACTIVE' || !row.watchdogMs) continue;
        const age = row.lastHeartbeatAtMs == null ? Infinity : at - row.lastHeartbeatAtMs;
        const next = age > row.watchdogMs ? 'STALE' : 'HEALTHY';
        if (next !== row.health) {
          row.health = next;
          if (this.logger) {
            if (next === 'STALE') this.logger.warn('Modul-Watchdog meldet stale', { id: row.id, ageMs: age, watchdogMs: row.watchdogMs });
            else this.logger.info('Modul-Watchdog wieder gesund', { id: row.id, ageMs: age });
          }
        }
        if (next === 'STALE') stale.push({ id: row.id, ageMs: age, watchdogMs: row.watchdogMs });
      }
      return stale;
    }

    unregister(id, reason = 'UNREGISTER') {
      const row = this.modules.get(id);
      if (!row) return false;
      if (row.state === 'ACTIVE' || row.state === 'STARTING' || row.state === 'STOPPING') {
        throw new Error('MODULE_MUST_BE_STOPPED_BEFORE_UNREGISTER:' + id);
      }
      if (row.scope) row.scope.close(reason);
      if (this.scheduler) this.scheduler.cancelOwner('module:' + id, reason);
      this.modules.delete(id);
      return true;
    }

    describe(id) {
      const row = this.modules.get(id);
      if (!row) return null;
      let details = null;
      try { details = row.status ? row.status() : null; }
      catch (error) { details = { error: errorDetails(error) }; }
      return {
        id: row.id,
        title: row.title,
        version: row.version,
        state: row.state,
        health: row.health,
        watchdogMs: row.watchdogMs,
        lastHeartbeatAtMs: row.lastHeartbeatAtMs,
        lastHeartbeat: clone(row.lastHeartbeat),
        startedAt: row.startedAt,
        stoppedAt: row.stoppedAt,
        lastError: clone(row.lastError),
        counters: {
          starts: row.startCount,
          stops: row.stopCount,
          restarts: row.restartCount,
          crashes: row.crashCount
        },
        resources: this.scheduler ? this.scheduler.ownerStatus('module:' + row.id).resources.length : 0,
        details: clone(details)
      };
    }

    list() {
      return [...this.modules.keys()].map(id => this.describe(id));
    }
  }

  ns.ResourceScope = ResourceScope;
  ns.Scheduler = Scheduler;
  ns.ModuleRegistry = StableModuleRegistry;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function safeBoolean(value) {
    return value === true;
  }

  class AdventureLandGameAdapter {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.lastSnapshot = null;
    }

    _roots() {
      const rows = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!rows.includes(current)) rows.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return rows;
    }

    _read(name) {
      for (const candidate of this._roots()) {
        try {
          if (candidate && candidate[name] != null) return candidate[name];
        } catch (_) {}
      }
      return null;
    }

    _resolveFunction(name) {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate[name] === 'function') {
            return { owner: candidate, fn: candidate[name] };
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && typeof candidate.parent[name] === 'function') {
            return { owner: candidate.parent, fn: candidate.parent[name] };
          }
        } catch (_) {}
      }
      return null;
    }

    _character() {
      return this._read('character');
    }

    _entitySources() {
      const sources = [];
      const add = value => {
        if (value && typeof value === 'object' && !sources.includes(value)) sources.push(value);
      };
      for (const candidate of this._roots()) {
        try { add(candidate && candidate.entities); } catch (_) {}
        try { add(candidate && candidate.parent && candidate.parent.entities); } catch (_) {}
      }
      return sources;
    }

    _entityEntries() {
      const rows = [];
      const seen = new Set();
      for (const source of this._entitySources()) {
        for (const [key, entity] of Object.entries(source)) {
          if (!entity || typeof entity !== 'object') continue;
          const stableId = String(entity.id != null ? entity.id : key);
          if (seen.has(stableId)) continue;
          seen.add(stableId);
          rows.push({ key: String(key), entity, stableId });
        }
      }
      return rows;
    }

    _entities() {
      const merged = {};
      for (const row of this._entityEntries()) merged[row.stableId] = row.entity;
      return merged;
    }

    _gameData() {
      const value = this._read('G');
      return value && typeof value === 'object' ? value : {};
    }

    _position(value) {
      if (!value) return { x: null, y: null };
      return {
        x: finite(value.real_x != null ? value.real_x : value.x),
        y: finite(value.real_y != null ? value.real_y : value.y)
      };
    }

    _targetId(character) {
      if (!character) return null;
      const value = character.target != null ? character.target : character.target_id;
      return value == null || value === '' ? null : String(value);
    }

    _currentTarget() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && candidate.ctarget && !candidate.ctarget.dead) {
            return { source: 'ctarget', entity: candidate.ctarget };
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && candidate.parent.ctarget && !candidate.parent.ctarget.dead) {
            return { source: 'parent.ctarget', entity: candidate.parent.ctarget };
          }
        } catch (_) {}
      }
      return null;
    }

    _entityByIdOrName(id) {
      if (id == null) return null;
      const wanted = String(id);
      for (const row of this._entityEntries()) {
        const key = row.key;
        const entity = row.entity;
        if (String(key) === wanted
          || String(row.stableId) === wanted
          || String(entity.id || '') === wanted
          || String(entity.name || '') === wanted) {
          return { key: String(key), entity };
        }
      }
      return null;
    }

    _normalizeEntity(match, characterMap) {
      if (!match) return null;
      const entity = match.entity || match;
      const fallbackId = match.key != null ? String(match.key) : null;
      const pos = this._position(entity);
      return {
        id: entity.id == null ? fallbackId : String(entity.id),
        name: entity.name == null ? null : cleanText(entity.name, 120),
        type: entity.type == null ? null : cleanText(entity.type, 80),
        ctype: entity.ctype == null ? null : cleanText(entity.ctype, 80),
        mtype: entity.mtype == null ? null : cleanText(entity.mtype, 120),
        player: safeBoolean(entity.player),
        npc: safeBoolean(entity.npc) || entity.type === 'npc',
        map: entity.map || characterMap || null,
        x: pos.x,
        y: pos.y,
        hp: finite(entity.hp),
        maxHp: finite(entity.max_hp),
        mp: finite(entity.mp),
        maxMp: finite(entity.max_mp),
        level: finite(entity.level),
        xp: finite(entity.xp),
        attack: finite(entity.attack),
        range: finite(entity.range),
        frequency: finite(entity.frequency),
        visible: entity.visible !== false,
        party: entity.party == null ? null : cleanText(entity.party, 120),
        targetId: entity.target == null ? null : String(entity.target),
        dead: safeBoolean(entity.dead) || safeBoolean(entity.rip)
      };
    }

    playerReference(name, options = {}) {
      if (name == null) return null;
      const wanted = String(name);
      const character = this._character();
      if (character && (String(character.name || '') === wanted || String(character.id || '') === wanted)) {
        if (options.allowDead === true || (!character.rip && !character.dead)) return character;
      }
      const match = this._entityByIdOrName(wanted);
      if (!match || !match.entity) return null;
      const entity = match.entity;
      const isPlayer = entity.type === 'character' || entity.player === true || entity.ctype != null;
      if (!isPlayer) return null;
      if (options.allowDead !== true && (entity.dead || entity.rip || entity.visible === false)) return null;
      return entity;
    }

    partySnapshot() {
      const character = this._character();
      let rawParty = {};
      let rawList = [];
      const getParty = this._resolveFunction('get_party');
      try {
        if (getParty) rawParty = getParty.fn.call(getParty.owner) || {};
      } catch (_) {}
      if (!rawParty || typeof rawParty !== 'object' || Array.isArray(rawParty)) rawParty = {};
      for (const candidate of this._roots()) {
        try {
          if (candidate && Array.isArray(candidate.party_list)) {
            rawList = candidate.party_list.slice();
            break;
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && Array.isArray(candidate.parent.party_list)) {
            rawList = candidate.parent.party_list.slice();
            break;
          }
        } catch (_) {}
      }

      const names = [];
      const addName = value => {
        const name = cleanText(value || '', 120);
        if (name && !names.includes(name)) names.push(name);
      };
      rawList.forEach(addName);
      Object.keys(rawParty).forEach(addName);
      if (character && character.party) addName(character.name);

      const members = names.map(name => {
        const partyRow = rawParty[name] && typeof rawParty[name] === 'object' ? rawParty[name] : {};
        const live = this.playerReference(name, { allowDead: true });
        const source = live || partyRow;
        const pos = this._position(source);
        const local = !!(character && String(character.name || '') === name);
        const hp = finite(live && live.hp != null ? live.hp : partyRow.hp);
        const maxHp = finite(live && live.max_hp != null ? live.max_hp : partyRow.max_hp);
        const mp = finite(live && live.mp != null ? live.mp : partyRow.mp);
        const maxMp = finite(live && live.max_mp != null ? live.max_mp : partyRow.max_mp);
        return {
          name,
          local,
          visible: local || !!live,
          ctype: cleanText((live && live.ctype) || partyRow.ctype || partyRow.type || '', 80) || null,
          level: finite((live && live.level) != null ? live.level : partyRow.level),
          map: (live && live.map) || partyRow.map || (local && character && character.map) || null,
          x: pos.x,
          y: pos.y,
          hp,
          maxHp,
          hpRatio: hp != null && maxHp != null && maxHp > 0 ? hp / maxHp : null,
          mp,
          maxMp,
          rip: safeBoolean((live && live.rip) || partyRow.rip || (live && live.dead)),
          targetId: ((live && live.target) != null ? live.target : partyRow.target) == null
            ? null
            : String((live && live.target) != null ? live.target : partyRow.target)
        };
      });

      return {
        schemaVersion: 1,
        available: names.length > 0,
        partyId: character && character.party ? String(character.party) : null,
        leader: rawList.length ? cleanText(rawList[0], 120) : (names[0] || null),
        memberNames: names,
        members,
        size: members.length,
        rawListAvailable: rawList.length > 0,
        rawPartyAvailable: Object.keys(rawParty).length > 0
      };
    }

    entityReference(id) {
      const match = this._entityByIdOrName(id);
      if (match && match.entity && match.entity.visible !== false && !match.entity.dead && !match.entity.rip) {
        return match.entity;
      }
      const current = this._currentTarget();
      if (current && current.entity) {
        const currentId = current.entity.id == null ? null : String(current.entity.id);
        if (id == null || currentId === String(id)) return current.entity;
      }
      return null;
    }

    visibleMonsters(options = {}) {
      const character = this._character();
      if (!character || !character.name) return [];
      const charPos = this._position(character);
      const type = cleanText(options.type || options.mtype || '', 120) || null;
      const rows = [];
      for (const row of this._entityEntries()) {
        const entity = row.entity;
        if (!entity || entity.visible === false || entity.dead === true || entity.rip === true) continue;
        if (!(entity.type === 'monster' || entity.mtype)) continue;
        if (type && String(entity.mtype || '') !== type) continue;
        if (entity.map && character.map && String(entity.map) !== String(character.map)) continue;
        const normalized = this._normalizeEntity({ key: row.key, entity }, character.map || null);
        if (!normalized || normalized.dead || normalized.visible === false) continue;
        if (charPos.x != null && charPos.y != null && normalized.x != null && normalized.y != null) {
          normalized.distance = Math.hypot(charPos.x - normalized.x, charPos.y - normalized.y);
        } else {
          normalized.distance = null;
        }
        rows.push(normalized);
      }
      rows.sort((a, b) => {
        const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
        const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
        return ad - bd;
      });
      return clone(rows);
    }

    visiblePlayers(options = {}) {
      const character = this._character();
      if (!character || !character.name) return [];
      const charPos = this._position(character);
      const radius = finite(options.radius);
      const rows = [];
      for (const row of this._entityEntries()) {
        const entity = row.entity;
        if (!entity || entity.visible === false || entity.dead === true || entity.rip === true) continue;
        const isPlayer = entity.type === 'character' || entity.player === true || entity.ctype != null;
        if (!isPlayer) continue;
        const entityName = entity.name == null ? null : String(entity.name);
        const entityId = entity.id == null ? String(row.key) : String(entity.id);
        if (entityName === String(character.name || '') || entityId === String(character.id || '')) continue;
        if (entity.map && character.map && String(entity.map) !== String(character.map)) continue;
        const normalized = this._normalizeEntity({ key: row.key, entity }, character.map || null);
        if (!normalized || normalized.dead || normalized.visible === false) continue;
        if (charPos.x != null && charPos.y != null && normalized.x != null && normalized.y != null) {
          normalized.distance = Math.hypot(charPos.x - normalized.x, charPos.y - normalized.y);
        } else {
          normalized.distance = null;
        }
        if (radius != null && (normalized.distance == null || normalized.distance > radius)) continue;
        rows.push(normalized);
      }
      rows.sort((a, b) => {
        const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
        const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
        return ad - bd;
      });
      return clone(rows);
    }

    npcLocation(npcId) {
      const id = cleanText(npcId || '', 120);
      if (!id) return null;
      const findNpc = this._resolveFunction('find_npc');
      if (!findNpc) return null;
      let raw = null;
      try { raw = findNpc.fn.call(findNpc.owner, id); } catch (_) { raw = null; }
      if (!raw || typeof raw !== 'object') return null;
      const x = finite(raw.x != null ? raw.x : raw.real_x);
      const y = finite(raw.y != null ? raw.y : raw.real_y);
      const map = cleanText(raw.map || '', 120) || null;
      if (!map || x == null || y == null) return null;
      return { npcId: id, map, x, y };
    }

    npcShopSources(itemName) {
      const wanted = cleanText(itemName || '', 160);
      if (!wanted) return [];
      const G = this._gameData();
      const npcs = G && G.npcs && typeof G.npcs === 'object' ? G.npcs : {};
      const rows = [];
      for (const [npcId, raw] of Object.entries(npcs)) {
        if (!raw || !Array.isArray(raw.items) || !raw.items.includes(wanted)) continue;
        const location = this.npcLocation(npcId);
        rows.push({
          npcId: String(npcId),
          name: raw.name == null ? String(npcId) : cleanText(raw.name, 160),
          role: raw.role == null ? null : cleanText(raw.role, 80),
          location
        });
      }
      return clone(rows);
    }

    marketSnapshot(options = {}) {
      const character = this._character();
      if (!character || !character.name) {
        return {
          schemaVersion: 1,
          available: false,
          reason: 'CHARACTER_UNAVAILABLE',
          players: [],
          listings: []
        };
      }
      const radius = finite(options.radius);
      const charPos = this._position(character);
      const players = [];
      const listings = [];
      for (const row of this._entityEntries()) {
        const entity = row.entity;
        if (!entity || entity.visible === false || entity.dead === true || entity.rip === true) continue;
        const isPlayer = entity.type === 'character' || entity.player === true || entity.ctype != null;
        if (!isPlayer) continue;
        const name = cleanText(entity.name || entity.id || row.key || '', 120);
        if (!name || name === String(character.name || '')) continue;
        if (entity.map && character.map && String(entity.map) !== String(character.map)) continue;
        const pos = this._position(entity);
        const distance = charPos.x != null && charPos.y != null && pos.x != null && pos.y != null
          ? Math.hypot(charPos.x - pos.x, charPos.y - pos.y)
          : null;
        if (radius != null && (distance == null || distance > radius)) continue;

        const player = {
          id: entity.id == null ? String(row.key) : String(entity.id),
          name,
          ctype: entity.ctype == null ? null : cleanText(entity.ctype, 80),
          map: entity.map || character.map || null,
          x: pos.x,
          y: pos.y,
          distance,
          stand: !!(entity.stand || entity.p && entity.p.stand)
        };
        players.push(player);

        const slots = entity.slots && typeof entity.slots === 'object' ? entity.slots : {};
        for (const [slot, rawListing] of Object.entries(slots)) {
          if (!String(slot).startsWith('trade') || !rawListing || !rawListing.name) continue;
          const price = finite(rawListing.price);
          if (price == null || price <= 0) continue;
          listings.push({
            playerId: player.id,
            playerName: player.name,
            distance,
            slot: String(slot),
            rid: rawListing.rid == null ? null : cleanText(rawListing.rid, 160),
            name: cleanText(rawListing.name, 160),
            level: Math.max(0, finite(rawListing.level) || 0),
            quantity: Math.max(1, finite(rawListing.q) || 1),
            price,
            buying: rawListing.b === true,
            giveaway: rawListing.giveaway === true,
            statType: rawListing.stat_type == null ? null : cleanText(rawListing.stat_type, 80),
            property: rawListing.p == null ? null : clone(rawListing.p)
          });
        }
      }
      players.sort((a, b) => {
        const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
        const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
        return ad - bd;
      });
      listings.sort((a, b) => {
        if (String(a.name) !== String(b.name)) return String(a.name).localeCompare(String(b.name));
        if (a.buying !== b.buying) return a.buying ? 1 : -1;
        return a.buying ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price);
      });
      return {
        schemaVersion: 1,
        available: true,
        reason: null,
        players: clone(players),
        listings: clone(listings)
      };
    }

    equipmentDefinition(name) {
      const id = cleanText(name || '', 160);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.items && G.items[id];
      if (!raw || typeof raw !== 'object') return null;
      const statNames = ['attack', 'armor', 'resistance', 'hp', 'mp', 'speed', 'range', 'str', 'dex', 'int', 'vit', 'stat'];
      const stats = {};
      const upgradeGrowth = {};
      for (const key of statNames) {
        const value = finite(raw[key]);
        if (value != null) stats[key] = value;
        const growth = raw.upgrade && typeof raw.upgrade === 'object' ? finite(raw.upgrade[key]) : null;
        if (growth != null) upgradeGrowth[key] = growth;
      }
      const classes = Array.isArray(raw.class)
        ? raw.class.map(value => cleanText(value, 60).toLowerCase()).filter(Boolean)
        : [];
      return {
        id,
        name: raw.name == null ? id : cleanText(raw.name, 200),
        type: raw.type == null ? null : cleanText(raw.type, 80).toLowerCase(),
        wtype: raw.wtype == null ? null : cleanText(raw.wtype, 80).toLowerCase(),
        classes,
        stats,
        upgradeGrowth,
        upgradeable: raw.upgrade === true || !!(raw.upgrade && typeof raw.upgrade === 'object'),
        compoundable: raw.compound === true || !!(raw.compound && typeof raw.compound === 'object'),
        grades: Array.isArray(raw.grades) ? clone(raw.grades) : null,
        g: finite(raw.g),
        cash: safeBoolean(raw.cash),
        quest: safeBoolean(raw.quest) || String(raw.type || '').toLowerCase() === 'quest'
      };
    }

    classEquipmentProfile(ctype) {
      const id = cleanText(ctype || '', 60).toLowerCase();
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.classes && G.classes[id];
      if (!raw || typeof raw !== 'object') return null;
      const allowed = value => {
        if (!value || typeof value !== 'object') return [];
        return Object.entries(value)
          .filter(([, enabled]) => enabled !== false && enabled != null)
          .map(([name]) => cleanText(name, 80).toLowerCase())
          .filter(Boolean)
          .sort();
      };
      return {
        ctype: id,
        mainhand: allowed(raw.mainhand),
        offhand: allowed(raw.offhand),
        doublehand: allowed(raw.doublehand)
      };
    }

    equipmentSnapshot(name = null) {
      const character = this._character();
      if (!character || !character.name) {
        return {
          schemaVersion: 1,
          available: false,
          reason: 'CHARACTER_UNAVAILABLE',
          character: null,
          slots: {}
        };
      }
      const wanted = cleanText(name || character.name, 120);
      let entity = null;
      if (!wanted || wanted === String(character.name || '') || wanted === String(character.id || '')) entity = character;
      else entity = this.playerReference(wanted, { allowDead: true });
      if (!entity) {
        return {
          schemaVersion: 1,
          available: false,
          reason: 'PLAYER_NOT_VISIBLE',
          character: { name: wanted || null, ctype: null },
          slots: {}
        };
      }

      const ctype = cleanText(entity.ctype || entity.type || '', 60).toLowerCase() || null;
      const rawSlots = entity.slots && typeof entity.slots === 'object' ? entity.slots : {};
      const slots = {};
      for (const [slot, raw] of Object.entries(rawSlots)) {
        if (String(slot).startsWith('trade') || String(slot) === 'elixir') continue;
        if (!raw || !raw.name) continue;
        const itemName = cleanText(raw.name, 160);
        slots[String(slot)] = {
          slot: String(slot),
          name: itemName,
          quantity: Math.max(1, finite(raw.q) || 1),
          level: Math.max(0, finite(raw.level) || 0),
          statType: raw.stat_type == null ? null : cleanText(raw.stat_type, 80),
          locked: !!raw.l,
          giveaway: !!raw.giveaway,
          gift: !!raw.gift,
          property: raw.p == null ? null : clone(raw.p),
          expiresAt: raw.expires == null ? null : raw.expires,
          definition: this.equipmentDefinition(itemName)
        };
      }
      return {
        schemaVersion: 1,
        available: true,
        reason: null,
        character: {
          name: cleanText(entity.name || wanted || '', 120) || null,
          ctype,
          map: entity.map == null ? (character.map || null) : entity.map,
          rip: !!(entity.rip || entity.dead)
        },
        profile: this.classEquipmentProfile(ctype),
        slots
      };
    }

    itemDefinition(name) {
      const id = cleanText(name || '', 160);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.items && G.items[id];
      if (!raw || typeof raw !== 'object') return null;
      return {
        id,
        name: raw.name == null ? id : cleanText(raw.name, 200),
        type: raw.type == null ? null : cleanText(raw.type, 80).toLowerCase(),
        g: finite(raw.g),
        e: finite(raw.e),
        upgrade: safeBoolean(raw.upgrade),
        compound: safeBoolean(raw.compound),
        cash: safeBoolean(raw.cash),
        quest: safeBoolean(raw.quest) || String(raw.type || '').toLowerCase() === 'quest',
        skin: raw.skin == null ? null : cleanText(raw.skin, 120)
      };
    }

    craftDefinition(name) {
      const id = cleanText(name || '', 160);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.craft && G.craft[id];
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
      const items = [];
      for (const entry of raw.items) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const quantity = finite(entry[0]);
        const itemName = cleanText(entry[1] || '', 160);
        const level = Math.max(0, finite(entry[2]) || 0);
        if (!itemName || quantity == null || quantity <= 0) continue;
        items.push({
          quantity: Math.max(1, Math.floor(quantity)),
          name: itemName,
          level
        });
      }
      if (!items.length) return null;
      const cost = finite(raw.cost != null ? raw.cost : raw.gold);
      return {
        name: id,
        output: this.itemDefinition(id),
        items,
        cost: Math.max(0, cost || 0),
        quest: raw.quest == null ? null : cleanText(raw.quest, 120) || null
      };
    }

    craftCatalog() {
      const G = this._gameData();
      const raw = G && G.craft;
      if (!raw || typeof raw !== 'object') return [];
      return Object.keys(raw)
        .map(name => this.craftDefinition(name))
        .filter(Boolean)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    inventorySnapshot() {
      const character = this._character();
      if (!character || !character.name) {
        return {
          schemaVersion: 1,
          available: false,
          reason: 'CHARACTER_UNAVAILABLE',
          capacity: 0,
          usedSlots: 0,
          freeSlots: 0,
          reportedEmptySlots: null,
          items: []
        };
      }

      const rawItems = Array.isArray(character.items) ? character.items : [];
      const items = [];
      for (let slot = 0; slot < rawItems.length; slot += 1) {
        const item = rawItems[slot];
        if (!item || !item.name) continue;
        const name = cleanText(item.name, 160);
        items.push({
          slot,
          name,
          quantity: Math.max(1, finite(item.q) || 1),
          level: Math.max(0, finite(item.level) || 0),
          statType: item.stat_type == null ? null : cleanText(item.stat_type, 80),
          locked: !!item.l,
          giveaway: !!item.giveaway,
          gift: !!item.gift,
          property: item.p == null ? null : clone(item.p),
          expiresAt: item.expires == null ? null : item.expires,
          definition: this.itemDefinition(name)
        });
      }

      const reportedEmptySlots = finite(character.esize);
      const capacity = rawItems.length;
      const usedSlots = items.length;
      return {
        schemaVersion: 1,
        available: true,
        reason: null,
        capacity,
        usedSlots,
        freeSlots: Math.max(0, capacity - usedSlots),
        reportedEmptySlots,
        items
      };
    }

    bankPackDefinitions() {
      const raw = this._read('bank_packs');
      if (!raw || typeof raw !== 'object') return {};
      const out = {};
      for (const [name, value] of Object.entries(raw)) {
        let map = null;
        if (Array.isArray(value)) map = value[0] == null ? null : cleanText(value[0], 120);
        else if (value && typeof value === 'object') {
          map = value.map == null
            ? (value[0] == null ? null : cleanText(value[0], 120))
            : cleanText(value.map, 120);
        }
        out[String(name)] = { name: String(name), map };
      }
      return out;
    }

    bankSnapshot() {
      const character = this._character();
      if (!character || !character.name) {
        return {
          schemaVersion: 1,
          available: false,
          reason: 'CHARACTER_UNAVAILABLE',
          map: null,
          gold: null,
          capacity: 0,
          usedSlots: 0,
          freeSlots: 0,
          packs: []
        };
      }

      const rawBank = character.bank;
      if (!rawBank || typeof rawBank !== 'object') {
        return {
          schemaVersion: 1,
          available: false,
          reason: 'BANK_NOT_MOUNTED',
          map: character.map == null ? null : cleanText(character.map, 120),
          gold: null,
          capacity: 0,
          usedSlots: 0,
          freeSlots: 0,
          packs: []
        };
      }

      const definitions = this.bankPackDefinitions();
      const packs = [];
      let capacity = 0;
      let usedSlots = 0;
      for (const [packName, rawPack] of Object.entries(rawBank)) {
        if (!Array.isArray(rawPack)) continue;
        const items = [];
        for (let slot = 0; slot < rawPack.length; slot += 1) {
          const item = rawPack[slot];
          if (!item || !item.name) continue;
          const name = cleanText(item.name, 160);
          items.push({
            pack: String(packName),
            slot,
            name,
            quantity: Math.max(1, finite(item.q) || 1),
            level: Math.max(0, finite(item.level) || 0),
            statType: item.stat_type == null ? null : cleanText(item.stat_type, 80),
            locked: !!item.l,
            giveaway: !!item.giveaway,
            gift: !!item.gift,
            property: item.p == null ? null : clone(item.p),
            expiresAt: item.expires == null ? null : item.expires,
            definition: this.itemDefinition(name)
          });
        }
        const packCapacity = rawPack.length;
        capacity += packCapacity;
        usedSlots += items.length;
        const definition = definitions[String(packName)] || null;
        packs.push({
          name: String(packName),
          map: definition && definition.map || null,
          capacity: packCapacity,
          usedSlots: items.length,
          freeSlots: Math.max(0, packCapacity - items.length),
          items
        });
      }

      packs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
        schemaVersion: 1,
        available: true,
        reason: null,
        map: character.map == null ? null : cleanText(character.map, 120),
        gold: finite(rawBank.gold),
        capacity,
        usedSlots,
        freeSlots: Math.max(0, capacity - usedSlots),
        packs
      };
    }

    chestSnapshot() {
      let raw = null;
      const getChests = this._resolveFunction('get_chests');
      try {
        if (getChests) raw = getChests.fn.call(getChests.owner);
      } catch (_) {}
      if (!raw || typeof raw !== 'object') raw = this._read('chests');
      if (!raw || typeof raw !== 'object') raw = {};
      const chests = Object.entries(raw).map(([id, chest]) => ({
        id: String(id),
        items: chest && finite(chest.items),
        lastLootAt: chest && chest.last_loot ? String(chest.last_loot) : null
      }));
      return {
        schemaVersion: 1,
        available: true,
        count: chests.length,
        chests
      };
    }

    monsterDefinition(mtype) {
      const id = cleanText(mtype || '', 120);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.monsters && G.monsters[id];
      if (!raw || typeof raw !== 'object') return null;
      const liveDropTable = G && G.drops && G.drops.monsters && G.drops.monsters[id];
      const dropsRaw = Array.isArray(raw.drops) && raw.drops.length
        ? raw.drops
        : (Array.isArray(liveDropTable) ? liveDropTable : []);
      const drops = [];
      let dropSignal = 0;
      for (const row of dropsRaw) {
        let chance = null;
        let item = null;
        let quantity = 1;
        if (Array.isArray(row)) {
          chance = finite(row[0]);
          item = row[1] == null ? null : cleanText(row[1], 160);
          const rawQuantity = finite(row[2]);
          if (rawQuantity != null && rawQuantity > 0) quantity = rawQuantity;
        } else if (row && typeof row === 'object') {
          chance = finite(row.chance != null ? row.chance : row.probability);
          item = cleanText(row.item || row.name || row.id || '', 160) || null;
          const rawQuantity = finite(row.quantity != null ? row.quantity : row.count);
          if (rawQuantity != null && rawQuantity > 0) quantity = rawQuantity;
        }
        if (chance != null && chance > 0) dropSignal += Math.min(1, chance) * quantity;
        if (item || chance != null) drops.push({ item, chance, quantity });
      }

      const rawGold = finite(raw.gold);
      const monsterGold = G && G.monster_gold && finite(G.monster_gold[id]);
      const goldRules = G && G.drops && G.drops.gold || {};
      const goldBase = finite(goldRules.base);
      const goldRandom = finite(goldRules.random);
      const gold = rawGold != null
        ? rawGold
        : (monsterGold != null
          ? 1 + monsterGold * ((goldBase || 0) + (goldRandom || 0) / 2)
          : null);

      return {
        id,
        name: raw.name == null ? id : cleanText(raw.name, 160),
        hp: finite(raw.hp),
        attack: finite(raw.attack),
        xp: finite(raw.xp),
        gold,
        speed: finite(raw.speed),
        range: finite(raw.range),
        frequency: finite(raw.frequency),
        respawn: finite(raw.respawn),
        damageType: raw.damage_type == null ? null : cleanText(raw.damage_type, 60).toLowerCase(),
        armor: finite(raw.armor),
        resistance: finite(raw.resistance),
        evasion: finite(raw.evasion),
        avoidance: finite(raw.avoidance),
        reflection: finite(raw.reflection),
        drops,
        dropSignal,
        boss: safeBoolean(raw.boss),
        cooperative: safeBoolean(raw.cooperative)
      };
    }

    _boundaryCenter(value) {
      if (Array.isArray(value)) {
        if (value.length >= 4 && value.slice(0, 4).every(item => finite(item) != null)) {
          return {
            x: (Number(value[0]) + Number(value[2])) / 2,
            y: (Number(value[1]) + Number(value[3])) / 2
          };
        }
        if (value.length === 2 && value.every(item => finite(item) != null)) {
          return { x: Number(value[0]), y: Number(value[1]) };
        }
        const centers = value.map(item => this._boundaryCenter(item)).filter(Boolean);
        if (!centers.length) return null;
        return {
          x: centers.reduce((sum, row) => sum + row.x, 0) / centers.length,
          y: centers.reduce((sum, row) => sum + row.y, 0) / centers.length
        };
      }
      if (!value || typeof value !== 'object') return null;
      const x = finite(value.x);
      const y = finite(value.y);
      if (x != null && y != null) return { x, y };
      const x1 = finite(value.x1);
      const y1 = finite(value.y1);
      const x2 = finite(value.x2);
      const y2 = finite(value.y2);
      if ([x1, y1, x2, y2].every(item => item != null)) {
        return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      }
      if (value.boundary != null) return this._boundaryCenter(value.boundary);
      if (value.boundaries != null) return this._boundaryCenter(value.boundaries);
      return null;
    }

    farmSpotCatalog(options = {}) {
      const G = this._gameData();
      const character = this._character();
      const requestedMap = cleanText(options.map || '', 120) || null;
      const currentOnly = options.currentOnly !== false;
      const currentMap = requestedMap || (character && character.map) || null;
      const maps = G && G.maps && typeof G.maps === 'object' ? G.maps : {};
      const rows = [];
      for (const [mapId, mapRaw] of Object.entries(maps)) {
        if (!mapRaw || typeof mapRaw !== 'object') continue;
        if (currentOnly && currentMap && String(mapId) !== String(currentMap)) continue;
        if (requestedMap && String(mapId) !== String(requestedMap)) continue;
        const spawnsRaw = Array.isArray(mapRaw.monsters)
          ? mapRaw.monsters
          : (mapRaw.monsters && typeof mapRaw.monsters === 'object' ? Object.values(mapRaw.monsters) : []);
        for (let index = 0; index < spawnsRaw.length; index += 1) {
          const spawn = spawnsRaw[index];
          if (!spawn || typeof spawn !== 'object') continue;
          const mtype = cleanText(spawn.type || spawn.mtype || spawn.monster || spawn.id || '', 120);
          if (!mtype) continue;
          const center = this._boundaryCenter(
            spawn.boundary != null ? spawn.boundary
              : spawn.boundaries != null ? spawn.boundaries
                : spawn.position != null ? spawn.position
                  : spawn.positions
          );
          if (!center) continue;
          const definition = this.monsterDefinition(mtype);
          rows.push({
            key: String(mapId) + ':' + mtype + ':' + String(index),
            map: String(mapId),
            mtype,
            x: center.x,
            y: center.y,
            count: finite(spawn.count),
            respawn: finite(spawn.respawn != null ? spawn.respawn : definition && definition.respawn),
            definition
          });
        }
      }
      return clone(rows);
    }

    playerCondition(name, conditionId) {
      const player = this.playerReference(name, { allowDead: true });
      const id = cleanText(conditionId || '', 120);
      if (!player || !id) {
        return {
          available: !!player,
          playerName: cleanText(name || '', 120) || null,
          conditionId: id || null,
          active: false,
          remainingMs: null,
          source: null
        };
      }
      let raw = null;
      try { raw = player.s && player.s[id] || null; } catch (_) {}
      return {
        available: true,
        playerName: cleanText(player.name || name || '', 120) || null,
        conditionId: id,
        active: !!raw,
        remainingMs: raw ? finite(raw.ms != null ? raw.ms : raw.duration) : null,
        source: raw && (raw.f != null ? cleanText(raw.f, 120) : raw.source != null ? cleanText(raw.source, 120) : null),
        raw: raw ? clone(raw) : null
      };
    }

    skillDefinition(skillId) {
      const id = cleanText(skillId || '', 120);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.skills && G.skills[id];
      if (!raw || typeof raw !== 'object') return null;
      const classesRaw = Array.isArray(raw.class) ? raw.class : (raw.class ? [raw.class] : []);
      return {
        id,
        name: raw.name == null ? id : cleanText(raw.name, 160),
        classes: classesRaw.map(value => cleanText(value, 60).toLowerCase()).filter(Boolean),
        level: finite(raw.level),
        mp: finite(raw.mp),
        cooldown: finite(raw.cooldown),
        range: finite(raw.range),
        rangeMultiplier: finite(raw.range_multiplier),
        rangeBonus: finite(raw.range_bonus),
        damageMultiplier: finite(raw.damage_multiplier),
        maxTargets: finite(raw.max_targets),
        share: raw.share == null ? null : cleanText(raw.share, 120),
        target: raw.target == null ? null : safeBoolean(raw.target),
        multi: safeBoolean(raw.multi),
        list: safeBoolean(raw.list),
        party: safeBoolean(raw.party),
        heal: safeBoolean(raw.heal),
        hostile: safeBoolean(raw.hostile)
      };
    }

    skillReadiness(skillId, targetId = null, options = {}) {
      const definition = this.skillDefinition(skillId);
      const character = this._character();
      const normalized = this.snapshot();
      if (!definition || !character || !normalized.available || !normalized.character) {
        return {
          available: false,
          allowed: false,
          skillId: cleanText(skillId || '', 120) || null,
          definition,
          reasons: ['SKILL_OR_CHARACTER_UNAVAILABLE'],
          cooldown: null,
          canUse: null,
          inRange: targetId == null ? true : null,
          activeCondition: false
        };
      }

      const reasons = [];
      const c = normalized.character;
      if (definition.classes.length && !definition.classes.includes(String(c.ctype || '').toLowerCase())) {
        reasons.push('SKILL_CLASS_MISMATCH');
      }
      if (definition.level != null && c.level != null && c.level < definition.level) reasons.push('SKILL_LEVEL_TOO_LOW');
      if (definition.mp != null && c.mp != null && c.mp < definition.mp) reasons.push('SKILL_MP_TOO_LOW');

      const cooldownFn = this._resolveFunction('is_on_cooldown');
      let cooldown = null;
      try { if (cooldownFn) cooldown = cooldownFn.fn.call(cooldownFn.owner, definition.id) === true; } catch (_) {}
      if (cooldown === true) reasons.push('SKILL_COOLDOWN');

      const canUseFn = this._resolveFunction('can_use');
      let canUse = null;
      try { if (canUseFn) canUse = canUseFn.fn.call(canUseFn.owner, definition.id) === true; } catch (_) {}
      if (canUse === false) reasons.push('SKILL_CAN_USE_FALSE');

      let inRange = targetId == null;
      if (targetId != null) {
        const rawTarget = options.allowDeadTarget === true
          ? this.playerReference(targetId, { allowDead: true })
          : this.entityReference(targetId);
        if (!rawTarget) {
          inRange = false;
          reasons.push('SKILL_TARGET_UNAVAILABLE');
        } else {
          const inRangeFn = this._resolveFunction('is_in_range');
          let observed = null;
          try { if (inRangeFn) observed = inRangeFn.fn.call(inRangeFn.owner, rawTarget, definition.id) === true; } catch (_) {}
          if (observed == null) {
            const cp = this._position(character);
            const tp = this._position(rawTarget);
            let allowedRange = definition.range;
            if (allowedRange == null && c.range != null) {
              allowedRange = c.range * (definition.rangeMultiplier == null ? 1 : definition.rangeMultiplier)
                + (definition.rangeBonus == null ? 0 : definition.rangeBonus);
            }
            observed = cp.x != null && cp.y != null && tp.x != null && tp.y != null && allowedRange != null
              ? Math.hypot(cp.x - tp.x, cp.y - tp.y) <= allowedRange
              : false;
          }
          inRange = observed;
          if (!inRange) reasons.push('SKILL_OUT_OF_RANGE');
        }
      }

      let activeCondition = false;
      try {
        activeCondition = !!(character.s && character.s[definition.id]);
      } catch (_) {}

      return {
        available: true,
        allowed: reasons.length === 0,
        skillId: definition.id,
        definition,
        reasons,
        cooldown,
        canUse,
        inRange,
        activeCondition
      };
    }

    combatReadiness(targetId) {
      const character = this._character();
      const raw = this.entityReference(targetId);
      if (!character || !raw) {
        return {
          available: false,
          targetAvailable: !!raw,
          canAttack: false,
          inRange: false,
          cooldown: null,
          source: 'unavailable'
        };
      }

      const canAttackFn = this._resolveFunction('can_attack');
      const inRangeFn = this._resolveFunction('is_in_range');
      const cooldownFn = this._resolveFunction('is_on_cooldown');

      let canAttack = null;
      let inRange = null;
      let cooldown = null;

      try { if (canAttackFn) canAttack = canAttackFn.fn.call(canAttackFn.owner, raw) === true; } catch (_) {}
      try { if (inRangeFn) inRange = inRangeFn.fn.call(inRangeFn.owner, raw, 'attack') === true; } catch (_) {}
      try { if (cooldownFn) cooldown = cooldownFn.fn.call(cooldownFn.owner, 'attack') === true; } catch (_) {}

      if (inRange == null) {
        const cp = this._position(character);
        const tp = this._position(raw);
        const range = finite(character.range);
        if (cp.x != null && cp.y != null && tp.x != null && tp.y != null && range != null) {
          inRange = Math.hypot(cp.x - tp.x, cp.y - tp.y) <= range;
        } else {
          inRange = false;
        }
      }
      if (cooldown == null) cooldown = false;
      if (canAttack == null) {
        canAttack = !safeBoolean(character.rip) && inRange && !cooldown;
      }

      return {
        available: true,
        targetAvailable: true,
        canAttack,
        inRange,
        cooldown,
        source: canAttackFn || inRangeFn || cooldownFn ? 'adventure-land-api' : 'adapter-fallback'
      };
    }

    _server() {
      const region = this._read('server_region');
      const identifier = this._read('server_identifier');
      const server = this._read('server');
      return {
        region: region == null ? null : cleanText(region, 60),
        identifier: identifier == null ? null : cleanText(identifier, 60),
        name: server && server.name ? cleanText(server.name, 120) : null
      };
    }

    snapshot() {
      const character = this._character();
      if (!character || !character.name) {
        const unavailable = {
          schemaVersion: 1,
          observedAt: new Date().toISOString(),
          available: false,
          reason: 'CHARACTER_UNAVAILABLE',
          character: null,
          target: null,
          server: this._server(),
          world: { entityCount: 0, monsterCount: 0, playerCount: 0, npcCount: 0 },
          gameData: { available: !!this._read('G'), monstersKnown: 0, mapsKnown: 0 }
        };
        this.lastSnapshot = unavailable;
        return clone(unavailable);
      }

      const pos = this._position(character);
      const targetId = this._targetId(character);
      const directTarget = this._currentTarget();
      const targetRaw = directTarget || this._entityByIdOrName(targetId);
      const target = this._normalizeEntity(targetRaw, character.map || null);
      if (target && pos.x != null && pos.y != null && target.x != null && target.y != null) {
        target.distance = Math.hypot(pos.x - target.x, pos.y - target.y);
      } else if (target) {
        target.distance = null;
      }

      const entityEntries = this._entityEntries();
      const entities = entityEntries.map(row => row.entity);
      let monsterCount = 0;
      let playerCount = 0;
      let npcCount = 0;
      for (const entity of entities) {
        if (entity.player === true) playerCount += 1;
        else if (entity.npc === true || entity.type === 'npc') npcCount += 1;
        else if (entity.mtype || entity.type === 'monster') monsterCount += 1;
      }

      const G = this._gameData();
      const snapshot = {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        available: true,
        reason: null,
        character: {
          name: cleanText(character.name, 120),
          ctype: cleanText(character.ctype || character.type || '', 60).toLowerCase() || null,
          level: finite(character.level),
          map: character.map || null,
          x: pos.x,
          y: pos.y,
          hp: finite(character.hp),
          maxHp: finite(character.max_hp),
          mp: finite(character.mp),
          maxMp: finite(character.max_mp),
          gold: finite(character.gold),
          xp: finite(character.xp),
          attack: finite(character.attack),
          armor: finite(character.armor),
          resistance: finite(character.resistance),
          range: finite(character.range),
          speed: finite(character.speed),
          frequency: finite(character.frequency),
          damageType: character.damage_type == null ? null : cleanText(character.damage_type, 60).toLowerCase(),
          moving: safeBoolean(character.moving),
          rip: safeBoolean(character.rip),
          targetId
        },
        target,
        targetResolution: {
          requestedId: targetId,
          resolved: !!target,
          resolvedFrom: directTarget ? directTarget.source : (target ? 'entities' : null),
          entitySourceCount: this._entitySources().length,
          mergedEntityCount: entityEntries.length
        },
        server: this._server(),
        world: {
          entityCount: entities.length,
          monsterCount,
          playerCount,
          npcCount
        },
        gameData: {
          available: !!this._read('G'),
          monstersKnown: G.monsters && typeof G.monsters === 'object' ? Object.keys(G.monsters).length : 0,
          mapsKnown: G.maps && typeof G.maps === 'object' ? Object.keys(G.maps).length : 0,
          itemsKnown: G.items && typeof G.items === 'object' ? Object.keys(G.items).length : 0,
          skillsKnown: G.skills && typeof G.skills === 'object' ? Object.keys(G.skills).length : 0
        }
      };

      this.lastSnapshot = snapshot;
      return clone(snapshot);
    }

    status() {
      return this.snapshot();
    }
  }

  ns.AdventureLandGameAdapter = AdventureLandGameAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);


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


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const ACTIONS = Object.freeze({
    move: Object.freeze({ publicName: 'move', family: 'movement' }),
    smart_move: Object.freeze({ publicName: 'smart_move', family: 'movement' }),
    stop: Object.freeze({ publicName: 'stop', family: 'movement-cleanup' }),
    use_skill: Object.freeze({ publicName: 'use_skill', family: 'skill' }),
    attack: Object.freeze({ publicName: 'attack', family: 'combat' }),
    heal: Object.freeze({ publicName: 'heal', family: 'party-heal' }),
    change_target: Object.freeze({ publicName: 'change_target', family: 'combat-target' }),
    loot: Object.freeze({ publicName: 'loot', family: 'loot' }),
    send_item: Object.freeze({ publicName: 'send_item', family: 'merchant-logistics' }),
    send_gold: Object.freeze({ publicName: 'send_gold', family: 'party-logistics' }),
    bank_store: Object.freeze({ publicName: 'bank_store', family: 'bank' }),
    bank_retrieve: Object.freeze({ publicName: 'bank_retrieve', family: 'bank' }),
    bank_deposit: Object.freeze({ publicName: 'bank_deposit', family: 'bank-gold' }),
    bank_withdraw: Object.freeze({ publicName: 'bank_withdraw', family: 'bank-gold' }),
    buy_with_gold: Object.freeze({ publicName: 'buy_with_gold', family: 'npc-trade' }),
    sell: Object.freeze({ publicName: 'sell', family: 'npc-trade' }),
    trade_buy: Object.freeze({ publicName: 'trade_buy', family: 'player-trade' }),
    trade_sell: Object.freeze({ publicName: 'trade_sell', family: 'player-trade' }),
    equip: Object.freeze({ publicName: 'equip', family: 'gear' }),
    unequip: Object.freeze({ publicName: 'unequip', family: 'gear' }),
    upgrade: Object.freeze({ publicName: 'upgrade', family: 'upgrade-compound' }),
    compound: Object.freeze({ publicName: 'compound', family: 'upgrade-compound' }),
    exchange: Object.freeze({ publicName: 'exchange', family: 'exchange-craft' }),
    auto_craft: Object.freeze({ publicName: 'auto_craft', family: 'exchange-craft' }),
    start_character: Object.freeze({ publicName: 'start_character', family: 'character-lifecycle' }),
    stop_character: Object.freeze({ publicName: 'stop_character', family: 'character-lifecycle' }),
    respawn: Object.freeze({ publicName: 'respawn', family: 'character-recovery' }),
    send_party_invite: Object.freeze({ publicName: 'send_party_invite', family: 'party-recovery' }),
    send_party_request: Object.freeze({ publicName: 'send_party_request', family: 'party-recovery' }),
    accept_party_invite: Object.freeze({ publicName: 'accept_party_invite', family: 'party-recovery' }),
    accept_party_request: Object.freeze({ publicName: 'accept_party_request', family: 'party-recovery' }),
    leave_party: Object.freeze({ publicName: 'leave_party', family: 'party-recovery' })
  });

  function errorDetails(error) {
    return {
      name: cleanText(error && error.name || 'Error', 80),
      message: cleanText(error && error.message || error || 'Unknown error', 500),
      stack: error && error.stack ? String(error.stack).slice(0, 3000) : null
    };
  }

  class GameActionBoundary {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.assertAllowed = typeof options.assertAllowed === 'function'
        ? options.assertAllowed
        : () => true;
      this.sequence = 0;
      this.lastAction = null;
      this.metrics = {
        attempted: 0,
        dispatched: 0,
        unavailable: 0,
        blocked: 0,
        synchronousErrors: 0,
        cleanupDispatches: 0
      };
    }

    _roots() {
      const out = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!out.includes(current)) out.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return out;
    }

    _resolve(publicName) {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate[publicName] === 'function') {
            return { owner: candidate, fn: candidate[publicName] };
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && typeof candidate.parent[publicName] === 'function') {
            return { owner: candidate.parent, fn: candidate.parent[publicName] };
          }
        } catch (_) {}
      }
      return null;
    }

    available(action) {
      const def = ACTIONS[action];
      if (!def) return false;
      return !!this._resolve(def.publicName);
    }

    _normalizedCallArgs(action, resolved, args) {
      if (!['trade_buy', 'trade_sell'].includes(action) || !Array.isArray(args) || args.length < 4) return args;
      const target = args[0];
      const tradeSlot = cleanText(args[1] || '', 80);
      const rid = cleanText(args[2] || '', 160);
      const quantity = Number(args[3]);
      if (!target || !target.id || !tradeSlot || !rid || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('ALBOT_PLAYER_TRADE_ARGS_INVALID:' + action);
      }
      const live = target.slots && target.slots[tradeSlot];
      if (!live || String(live.rid || '') !== rid) {
        throw new Error('ALBOT_PLAYER_TRADE_RID_MISMATCH:' + action);
      }

      // Adventure Land exposes two compatible layers:
      // CODE wrapper: trade_buy(target, slot, quantity)
      // native parent: trade_buy(slot, id, rid, quantity)
      // Keep one logical boundary contract and adapt only at dispatch time.
      if (Number(resolved && resolved.fn && resolved.fn.length) >= 4) {
        return [tradeSlot, target.id, rid, quantity];
      }
      return [target, tradeSlot, quantity];
    }

    dispatch(action, args = [], options = {}) {
      const def = ACTIONS[action];
      if (!def) throw new Error('ALBOT_ACTION_UNKNOWN:' + cleanText(action, 80));
      if (!Array.isArray(args)) throw new Error('ALBOT_ACTION_ARGS_INVALID:' + action);

      const cleanup = options.cleanup === true;
      if (cleanup && action !== 'stop' && action !== 'use_skill' && action !== 'change_target') {
        throw new Error('ALBOT_CLEANUP_ACTION_NOT_ALLOWED:' + action);
      }
      if (cleanup && action === 'change_target' && args[0] != null) {
        throw new Error('ALBOT_CLEANUP_TARGET_MUST_CLEAR');
      }

      this.metrics.attempted += 1;
      const id = 'act-' + (++this.sequence);
      const at = new Date().toISOString();

      if (!cleanup) {
        try {
          this.assertAllowed(action);
        } catch (error) {
          this.metrics.blocked += 1;
          this.lastAction = {
            id, at, action, family: def.family, state: 'BLOCKED',
            cleanup: false, error: errorDetails(error)
          };
          throw error;
        }
      }

      const resolved = this._resolve(def.publicName);
      if (!resolved) {
        this.metrics.unavailable += 1;
        const result = {
          id, at, action, family: def.family, state: 'UNAVAILABLE',
          cleanup, dispatched: false, value: null,
          error: { name: 'Error', message: 'ALBOT_ACTION_API_UNAVAILABLE:' + def.publicName, stack: null }
        };
        this.lastAction = clone(result);
        return result;
      }

      try {
        const callArgs = this._normalizedCallArgs(action, resolved, args);
        const value = resolved.fn.apply(resolved.owner, callArgs);
        this.metrics.dispatched += 1;
        if (cleanup) this.metrics.cleanupDispatches += 1;
        const result = {
          id, at, action, family: def.family, state: 'DISPATCHED',
          cleanup, dispatched: true, value,
          error: null
        };
        this.lastAction = {
          id, at, action, family: def.family, state: 'DISPATCHED',
          cleanup, dispatched: true, error: null
        };
        if (this.logger) this.logger.info('Game-Aktion gesendet', {
          id, action, family: def.family, cleanup
        });
        return result;
      } catch (error) {
        this.metrics.synchronousErrors += 1;
        const result = {
          id, at, action, family: def.family, state: 'UNKNOWN',
          cleanup, dispatched: true, value: null, error: errorDetails(error)
        };
        this.lastAction = clone(result);
        if (this.logger) this.logger.error('Game-Aktion endete synchron unklar', {
          id, action, family: def.family, cleanup, error: result.error
        });
        return result;
      }
    }

    status() {
      return {
        schemaVersion: 1,
        supportedActions: Object.keys(ACTIONS),
        availability: Object.fromEntries(Object.keys(ACTIONS).map(action => [action, this.available(action)])),
        metrics: clone(this.metrics),
        lastAction: clone(this.lastAction)
      };
    }
  }

  ns.GameActionBoundary = GameActionBoundary;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function distance(a, b) {
    if (!a || !b) return null;
    const ax = finite(a.x), ay = finite(a.y), bx = finite(b.x), by = finite(b.y);
    if (ax == null || ay == null || bx == null || by == null) return null;
    return Math.hypot(ax - bx, ay - by);
  }

  function errorReason(value, fallback = 'MOVEMENT_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 180);
    }
    const text = cleanText(value, 180);
    return text || fallback;
  }

  class MovementController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        pollMs: Math.max(100, Math.min(1000, Number(options.pollMs) || 200)),
        localTimeoutMs: Math.max(3000, Math.min(60000, Number(options.localTimeoutMs) || 15000)),
        smartTimeoutMs: Math.max(10000, Math.min(10 * 60 * 1000, Number(options.smartTimeoutMs) || 120000)),
        stuckMs: Math.max(1500, Math.min(30000, Number(options.stuckMs) || 6000)),
        progressEpsilon: Math.max(0.5, Math.min(20, Number(options.progressEpsilon) || 2)),
        arrivalRadius: Math.max(2, Math.min(100, Number(options.arrivalRadius) || 12)),
        retargetMinAgeMs: Math.max(250, Math.min(10000, Number(options.retargetMinAgeMs) || 1000)),
        rapidSwitchMs: Math.max(250, Math.min(10000, Number(options.rapidSwitchMs) || 1500)),
        pingPongWindowMs: Math.max(1000, Math.min(30000, Number(options.pingPongWindowMs) || 6000)),
        destinationBucket: Math.max(5, Math.min(100, Number(options.destinationBucket) || 20))
      };

      this.enabled = false;
      this.scope = null;
      this.heartbeat = null;
      this.pollResourceId = null;
      this.sequence = 0;
      this.activeOrder = null;
      this.lastOrder = null;
      this.safePoint = null;
      this.destinationHistory = [];
      this.metrics = {
        localMoves: 0,
        smartMoves: 0,
        approaches: 0,
        retargets: 0,
        safeReturns: 0,
        completed: 0,
        cancelled: 0,
        stuck: 0,
        failedSafe: 0,
        unknown: 0,
        rejected: 0,
        pingPongBlocks: 0,
        rapidSwitchBlocks: 0,
        cleanupStops: 0
      };
    }

    start(context) {
      this.enabled = true;
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      this.captureSafePoint('RUNTIME_START');
      if (this.heartbeat) this.heartbeat({ phase: 'movement-start', active: false });
      return this.status();
    }

    stop(reason = 'MOVEMENT_MODULE_STOP') {
      this.enabled = false;
      this._cancelActive(reason, { cleanup: true });
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _character() {
      const snap = this._snapshot();
      return snap && snap.available ? snap.character : null;
    }

    _canMoveTo(x, y) {
      const wantedX = finite(x);
      const wantedY = finite(y);
      if (wantedX == null || wantedY == null) return false;
      const candidates = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!candidates.includes(current)) candidates.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) { parentWindow = null; }
        if (!parentWindow) break;
        current = parentWindow;
      }
      for (const candidate of candidates) {
        try {
          if (candidate && typeof candidate.can_move_to === 'function') {
            return candidate.can_move_to(wantedX, wantedY) !== false;
          }
        } catch (_) {
          return false;
        }
        try {
          if (candidate && candidate.parent && typeof candidate.parent.can_move_to === 'function') {
            return candidate.parent.can_move_to(wantedX, wantedY) !== false;
          }
        } catch (_) {
          return false;
        }
      }
      return null;
    }

    _normalizeDestination(destination, currentMap) {
      if (typeof destination === 'string') {
        const map = cleanText(destination, 120);
        if (!map) throw new Error('MOVEMENT_DESTINATION_INVALID');
        return { map, x: null, y: null };
      }
      if (!destination || typeof destination !== 'object') throw new Error('MOVEMENT_DESTINATION_INVALID');
      const map = cleanText(destination.map || currentMap || '', 120) || null;
      const x = finite(destination.x);
      const y = finite(destination.y);
      if (!map && (x == null || y == null)) throw new Error('MOVEMENT_DESTINATION_INVALID');
      if ((x == null) !== (y == null)) throw new Error('MOVEMENT_DESTINATION_COORDINATES_INCOMPLETE');
      return { map, x, y };
    }

    _destinationKey(destination) {
      const bucket = this.config.destinationBucket;
      const x = destination.x == null ? '*' : Math.round(destination.x / bucket);
      const y = destination.y == null ? '*' : Math.round(destination.y / bucket);
      return String(destination.map || '*') + ':' + x + ':' + y;
    }

    _trimHistory(now = this.now()) {
      const cutoff = now - this.config.pingPongWindowMs;
      this.destinationHistory = this.destinationHistory.filter(row => row.atMs >= cutoff).slice(-8);
    }

    _antiPingPong(destination, options = {}) {
      const now = this.now();
      this._trimHistory(now);
      const key = this._destinationKey(destination);
      if (options.safety === true) return { ok: true, key };
      const last = this.destinationHistory[this.destinationHistory.length - 1] || null;

      if (last && last.key !== key && !options.retarget && now - last.atMs < this.config.rapidSwitchMs) {
        this.metrics.rapidSwitchBlocks += 1;
        return { ok: false, reason: 'MOVEMENT_RAPID_SWITCH_BLOCKED', key, previousKey: last.key };
      }

      if (last && last.key !== key) {
        const olderSame = this.destinationHistory.slice(0, -1).reverse().find(row => row.key === key);
        if (olderSame && now - olderSame.atMs < this.config.pingPongWindowMs) {
          this.metrics.pingPongBlocks += 1;
          return { ok: false, reason: 'MOVEMENT_PINGPONG_BLOCKED', key, previousKey: last.key };
        }
      }
      return { ok: true, key };
    }

    _recordDestination(key, kind) {
      const now = this.now();
      this._trimHistory(now);
      this.destinationHistory.push({ key, kind, atMs: now });
      this._trimHistory(now);
    }

    _preflight(kind, destination, options = {}) {
      if (!this.enabled) return { ok: false, reason: 'MOVEMENT_MODULE_NOT_ACTIVE' };
      if (this.activeOrder && options.allowActive !== true) return { ok: false, reason: 'MOVEMENT_BUSY' };

      const snap = this._snapshot();
      const character = snap && snap.character;
      if (!snap || !snap.available || !character) return { ok: false, reason: 'CHARACTER_UNAVAILABLE' };
      if (character.rip === true) return { ok: false, reason: 'CHARACTER_DEAD' };

      let normalized;
      try { normalized = this._normalizeDestination(destination, character.map); }
      catch (error) { return { ok: false, reason: errorReason(error, 'MOVEMENT_DESTINATION_INVALID') }; }

      if (kind === 'local') {
        if (normalized.map && character.map && String(normalized.map) !== String(character.map)) {
          return { ok: false, reason: 'LOCAL_MOVE_CROSS_MAP_REJECTED' };
        }
        if (normalized.x == null || normalized.y == null) return { ok: false, reason: 'LOCAL_MOVE_COORDINATES_REQUIRED' };
        const passable = this._canMoveTo(normalized.x, normalized.y);
        if (passable === false) return { ok: false, reason: 'LOCAL_DESTINATION_NOT_WALKABLE' };
      }

      if (kind === 'smart'
        && normalized.x == null
        && normalized.y == null
        && normalized.map
        && character.map
        && String(normalized.map) === String(character.map)) {
        return { ok: false, reason: 'SMART_MOVE_SAME_MAP_NEEDS_COORDINATES' };
      }

      const anti = this._antiPingPong(normalized, options);
      if (!anti.ok) return { ...anti, destination: normalized };
      return { ok: true, character, destination: normalized, key: anti.key };
    }

    _publicOrder(order) {
      if (!order) return null;
      const copy = clone(order);
      delete copy.promise;
      return copy;
    }

    _cancelPoll(reason) {
      if (this.pollResourceId && this.scope) {
        try { this.scope.cancel(this.pollResourceId, reason || 'MOVEMENT_POLL_CANCEL'); } catch (_) {}
      }
      this.pollResourceId = null;
    }

    _bestEffortStop(reason, options = {}) {
      const results = [];
      const smart = options.smart !== false;
      const local = options.local !== false;
      if (smart && this.actions) {
        try {
          const result = this.actions.dispatch('stop', ['smart'], { cleanup: true });
          results.push({ action: 'stop-smart', state: result.state });
          if (result.dispatched) this.metrics.cleanupStops += 1;
        } catch (_) {}
      }
      if (local && this.actions && this.actions.available('use_skill')) {
        try {
          const result = this.actions.dispatch('use_skill', ['stop'], { cleanup: true });
          results.push({ action: 'use-skill-stop', state: result.state });
          if (result.dispatched) this.metrics.cleanupStops += 1;
        } catch (_) {}
      }
      if (this.logger && results.length) this.logger.warn('Bewegung bestmöglich gestoppt', { reason, results });
      return results;
    }

    _finish(state, reason, options = {}) {
      const order = this.activeOrder;
      if (!order) return null;
      this._cancelPoll('MOVEMENT_' + state);

      order.state = state;
      order.reason = reason;
      order.finishedAt = new Date().toISOString();
      order.finishedAtMs = this.now();
      order.lastObserved = options.lastObserved || order.lastObserved || null;

      if (state === 'COMPLETED') this.metrics.completed += 1;
      else if (state === 'CANCELLED') this.metrics.cancelled += 1;
      else if (state === 'STUCK') this.metrics.stuck += 1;
      else if (state === 'UNKNOWN') this.metrics.unknown += 1;
      else if (state === 'FAILED_SAFE') this.metrics.failedSafe += 1;

      if (options.stop !== false && state !== 'COMPLETED') {
        this._bestEffortStop(reason, { smart: order.kind === 'smart', local: true });
      } else if (options.stopOnArrival === true && order.kind === 'smart') {
        this._bestEffortStop('ARRIVAL_VERIFIED', { smart: true, local: false });
      }

      this.lastOrder = this._publicOrder(order);
      this.activeOrder = null;
      if (this.heartbeat) this.heartbeat({ phase: 'movement-terminal', state, reason, orderId: order.id });

      if (this.logger) {
        const data = { id: order.id, kind: order.kind, state, reason, destination: order.destination };
        if (state === 'COMPLETED') this.logger.info('Bewegungsauftrag abgeschlossen', data);
        else this.logger.warn('Bewegungsauftrag beendet', data);
      }
      return this.lastOrder;
    }

    _observeOrder() {
      const order = this.activeOrder;
      if (!order) return;
      const snap = this._snapshot();
      const character = snap && snap.character;
      const now = this.now();

      if (!snap || !snap.available || !character) {
        this._finish('UNKNOWN', 'CHARACTER_OBSERVATION_LOST');
        return;
      }
      if (character.rip === true) {
        this._finish('FAILED_SAFE', 'CHARACTER_DEAD', { lastObserved: character });
        return;
      }

      const sameMap = !order.destination.map || String(character.map || '') === String(order.destination.map);
      const currentDistance = sameMap && order.destination.x != null
        ? distance(character, order.destination)
        : null;

      const observed = {
        at: new Date().toISOString(),
        atMs: now,
        map: character.map || null,
        x: finite(character.x),
        y: finite(character.y),
        moving: character.moving === true,
        distance: currentDistance
      };
      order.lastObserved = observed;

      const arrivedByPosition = sameMap
        && currentDistance != null
        && currentDistance <= order.arrivalRadius;
      const arrivedByMap = sameMap
        && order.destination.x == null
        && order.destination.y == null
        && String(character.map || '') === String(order.destination.map || '');

      if (arrivedByPosition || arrivedByMap) {
        this._finish('COMPLETED', 'ARRIVAL_VERIFIED', {
          lastObserved: observed,
          stop: false,
          stopOnArrival: true
        });
        return;
      }

      let progress = false;
      if (order.lastMap != null && String(character.map || '') !== String(order.lastMap)) progress = true;
      if (currentDistance != null && (order.bestDistance == null || currentDistance < order.bestDistance - this.config.progressEpsilon)) {
        order.bestDistance = currentDistance;
        progress = true;
      }
      if (progress) {
        order.lastProgressAtMs = now;
        order.progressEvents += 1;
      }
      order.lastMap = character.map || null;

      if (now >= order.deadlineAtMs) {
        this._finish('FAILED_SAFE', 'MOVEMENT_TIMEOUT', { lastObserved: observed });
        return;
      }

      if (now - order.lastProgressAtMs >= this.config.stuckMs) {
        this._finish('STUCK', 'MOVEMENT_STUCK_NO_PROGRESS', { lastObserved: observed });
        return;
      }

      if (this.heartbeat) this.heartbeat({
        phase: 'movement-active',
        orderId: order.id,
        kind: order.kind,
        distance: currentDistance,
        progressEvents: order.progressEvents
      });
    }

    _watchCommand(order, dispatch) {
      if (!dispatch || dispatch.state !== 'DISPATCHED') return;
      const value = dispatch.value;
      if (!value || typeof value.then !== 'function') {
        order.commandSettlement = 'RETURNED';
        return;
      }

      order.commandSettlement = 'PENDING';
      Promise.resolve(value).then(response => {
        if (!this.activeOrder || this.activeOrder.id !== order.id) return;
        order.commandResponse = response == null ? null : clone(response);
        if (response && response.failed === true) {
          order.commandSettlement = 'FAILED';
          this._finish('FAILED_SAFE', errorReason(response.reason || response, 'MOVEMENT_COMMAND_FAILED'));
          return;
        }
        order.commandSettlement = 'RESOLVED';
        // Return/resolve is not arrival evidence. Observation decides completion.
      }, error => {
        if (!this.activeOrder || this.activeOrder.id !== order.id) return;
        order.commandSettlement = 'REJECTED';
        order.commandError = errorReason(error, 'MOVEMENT_COMMAND_REJECTED');
        this._finish('UNKNOWN', order.commandError);
      }).catch(() => {});
    }

    _startOrder(kind, destination, options = {}) {
      const check = this._preflight(kind, destination, options);
      if (!check.ok) {
        this.metrics.rejected += 1;
        if (this.logger) this.logger.warn('Bewegungsauftrag abgelehnt', { kind, reason: check.reason, destination: check.destination || destination });
        return { accepted: false, reason: check.reason, status: this.status() };
      }

      const now = this.now();
      const character = check.character;
      const arrivalRadius = Math.max(2, Math.min(100, Number(options.arrivalRadius) || this.config.arrivalRadius));
      const timeoutMs = kind === 'local'
        ? Math.max(1000, Number(options.timeoutMs) || this.config.localTimeoutMs)
        : Math.max(3000, Number(options.timeoutMs) || this.config.smartTimeoutMs);

      const order = {
        id: 'move-' + (++this.sequence),
        kind,
        owner: cleanText(options.owner || 'manual', 80) || 'manual',
        state: 'STARTING',
        reason: null,
        destination: check.destination,
        destinationKey: check.key,
        arrivalRadius,
        startedAt: new Date().toISOString(),
        startedAtMs: now,
        deadlineAtMs: now + timeoutMs,
        lastProgressAtMs: now,
        progressEvents: 0,
        bestDistance: distance(character, check.destination),
        lastMap: character.map || null,
        lastObserved: {
          at: new Date().toISOString(),
          atMs: now,
          map: character.map || null,
          x: finite(character.x),
          y: finite(character.y),
          moving: character.moving === true,
          distance: distance(character, check.destination)
        },
        commandSettlement: 'NOT_SENT',
        commandResponse: null,
        commandError: null,
        retargetedFrom: options.retargetedFrom || null
      };

      this.activeOrder = order;
      this._recordDestination(check.key, kind);

      const action = kind === 'local' ? 'move' : 'smart_move';
      const args = kind === 'local'
        ? [check.destination.x, check.destination.y]
        : [check.destination.x == null
          ? check.destination.map
          : { map: check.destination.map, x: check.destination.x, y: check.destination.y }];

      let dispatch;
      try {
        dispatch = this.actions.dispatch(action, args);
      } catch (error) {
        order.commandSettlement = 'BLOCKED';
        this._finish('FAILED_SAFE', errorReason(error, 'MOVEMENT_ACTION_BLOCKED'), { stop: false });
        return { accepted: false, reason: this.lastOrder.reason, order: clone(this.lastOrder) };
      }

      if (!dispatch || dispatch.state === 'UNAVAILABLE') {
        order.commandSettlement = 'UNAVAILABLE';
        this._finish('FAILED_SAFE', 'MOVEMENT_API_UNAVAILABLE', { stop: false });
        return { accepted: false, reason: 'MOVEMENT_API_UNAVAILABLE', order: clone(this.lastOrder) };
      }
      if (dispatch.state === 'UNKNOWN') {
        order.commandSettlement = 'UNKNOWN';
        this._finish('UNKNOWN', errorReason(dispatch.error, 'MOVEMENT_DISPATCH_UNKNOWN'));
        return { accepted: false, reason: this.lastOrder.reason, order: clone(this.lastOrder) };
      }

      order.state = 'ACTIVE';
      order.commandSettlement = 'DISPATCHED';
      if (kind === 'local') this.metrics.localMoves += 1;
      else this.metrics.smartMoves += 1;

      if (!this.scope) {
        this._finish('UNKNOWN', 'MOVEMENT_SCOPE_UNAVAILABLE');
        return { accepted: false, reason: 'MOVEMENT_SCOPE_UNAVAILABLE', order: clone(this.lastOrder) };
      }

      this.pollResourceId = this.scope.interval(
        'movement-observer:' + order.id,
        () => this._observeOrder(),
        this.config.pollMs,
        { immediate: false }
      );
      this._observeOrder();
      this._watchCommand(order, dispatch);

      if (this.logger) this.logger.warn('Bewegungsauftrag gestartet', {
        id: order.id,
        kind,
        owner: order.owner,
        destination: order.destination,
        arrivalRadius
      });
      return { accepted: true, order: this._publicOrder(order) };
    }

    moveLocal(x, y, options = {}) {
      const character = this._character();
      return this._startOrder('local', {
        map: character && character.map || null,
        x,
        y
      }, options);
    }

    smartMove(destination, options = {}) {
      return this._startOrder('smart', destination, options);
    }

    approachCurrentTarget(options = {}) {
      const snap = this._snapshot();
      const character = snap && snap.character;
      const target = snap && snap.target;
      if (!character || !target || target.dead === true) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_TARGET_UNAVAILABLE', status: this.status() };
      }
      if (target.map && character.map && String(target.map) !== String(character.map)) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_TARGET_CROSS_MAP', status: this.status() };
      }
      const d = distance(character, target);
      if (d == null || d <= 0) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_TARGET_DISTANCE_UNAVAILABLE', status: this.status() };
      }
      const desired = Math.max(0, Math.min(d, Number(options.distance) || Math.max(10, Number(character.range) * 0.8 || 40)));
      if (d <= desired + this.config.arrivalRadius) {
        return { accepted: true, completed: true, reason: 'ALREADY_IN_APPROACH_RANGE', distance: d };
      }
      const dx = Number(target.x) - Number(character.x);
      const dy = Number(target.y) - Number(character.y);
      const x = Number(target.x) - (dx / d) * desired;
      const y = Number(target.y) - (dy / d) * desired;
      this.metrics.approaches += 1;

      const localAllowed = this._canMoveTo(x, y);
      if (localAllowed !== false) {
        return this._startOrder('local', { map: character.map, x, y }, {
          ...options,
          owner: options.owner || 'target-approach'
        });
      }
      return this._startOrder('smart', { map: character.map, x, y }, {
        ...options,
        owner: options.owner || 'target-approach'
      });
    }

    retarget(destination, options = {}) {
      const active = this.activeOrder;
      if (!active) {
        return options.local === true
          ? this.moveLocal(destination && destination.x, destination && destination.y, options)
          : this.smartMove(destination, options);
      }

      const now = this.now();
      if (now - active.startedAtMs < this.config.retargetMinAgeMs) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_RETARGET_TOO_SOON', status: this.status() };
      }

      let normalized;
      try {
        const character = this._character();
        normalized = this._normalizeDestination(destination, character && character.map);
      } catch (error) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: errorReason(error, 'MOVEMENT_DESTINATION_INVALID'), status: this.status() };
      }
      const key = this._destinationKey(normalized);
      if (key === active.destinationKey) {
        return { accepted: true, changed: false, reason: 'MOVEMENT_DESTINATION_UNCHANGED', order: this._publicOrder(active) };
      }

      const anti = this._antiPingPong(normalized, { retarget: true });
      if (!anti.ok) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: anti.reason, status: this.status() };
      }

      const previousId = active.id;
      this._cancelActive('RETARGET', { cleanup: true });
      this.metrics.retargets += 1;
      return options.local === true
        ? this._startOrder('local', normalized, { ...options, retarget: true, retargetedFrom: previousId })
        : this._startOrder('smart', normalized, { ...options, retarget: true, retargetedFrom: previousId });
    }

    _cancelActive(reason, options = {}) {
      if (!this.activeOrder) {
        if (options.forceCleanup === true) this._bestEffortStop(reason, { smart: true, local: true });
        return { cancelled: false, reason: 'NO_ACTIVE_MOVEMENT' };
      }
      const id = this.activeOrder.id;
      const order = this._finish('CANCELLED', cleanText(reason || 'MOVEMENT_CANCELLED', 180), {
        stop: options.cleanup !== false
      });
      return { cancelled: true, orderId: id, order };
    }

    cancel(reason = 'MANUAL_CANCEL') {
      return this._cancelActive(reason, { cleanup: true });
    }

    emergencyStop(reason = 'EMERGENCY_STOP') {
      return this._cancelActive(reason, { cleanup: true, forceCleanup: true });
    }

    captureSafePoint(source = 'MANUAL') {
      const character = this._character();
      if (!character || !character.map || finite(character.x) == null || finite(character.y) == null) {
        return { captured: false, reason: 'CHARACTER_POSITION_UNAVAILABLE' };
      }
      this.safePoint = {
        map: character.map,
        x: finite(character.x),
        y: finite(character.y),
        capturedAt: new Date().toISOString(),
        source: cleanText(source, 80)
      };
      return { captured: true, safePoint: clone(this.safePoint) };
    }

    safeReturn(options = {}) {
      if (!this.safePoint) return { accepted: false, reason: 'SAFE_POINT_UNAVAILABLE' };
      this.metrics.safeReturns += 1;
      const character = this._character();
      if (character && String(character.map || '') === String(this.safePoint.map || '')) {
        const can = this._canMoveTo(this.safePoint.x, this.safePoint.y);
        if (can !== false) {
          return this._startOrder('local', this.safePoint, {
            ...options,
            owner: options.owner || 'safe-return',
            safety: true
          });
        }
      }
      return this._startOrder('smart', this.safePoint, {
        ...options,
        owner: options.owner || 'safe-return',
        safety: true
      });
    }

    status() {
      return {
        schemaVersion: 1,
        enabled: this.enabled,
        state: this.activeOrder ? this.activeOrder.state : 'IDLE',
        active: !!this.activeOrder,
        activeOrder: this._publicOrder(this.activeOrder),
        lastOrder: clone(this.lastOrder),
        safePoint: clone(this.safePoint),
        config: clone(this.config),
        recentDestinations: clone(this.destinationHistory.slice(-5)),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.MovementController = MovementController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const SUPPORTED_CLASSES = Object.freeze(['warrior', 'ranger', 'mage', 'priest', 'rogue', 'paladin']);
  const CLASS_SKILLS = Object.freeze({
    warrior: Object.freeze(['hardshell', 'charge', 'taunt', 'warcry']),
    ranger: Object.freeze(['huntersmark', 'supershot']),
    mage: Object.freeze(['burst']),
    priest: Object.freeze(['curse', 'darkblessing']),
    rogue: Object.freeze(['invis', 'mentalburst', 'quickpunch']),
    paladin: Object.freeze(['selfheal', 'smash'])
  });

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function ratio(value, max) {
    const current = finite(value);
    const total = finite(max);
    if (current == null || total == null || total <= 0) return null;
    return Math.max(0, Math.min(1, current / total));
  }

  function errorReason(value, fallback = 'CLASS_SKILL_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 240);
    }
    const text = cleanText(value, 240);
    return text || fallback;
  }

  class ClassSkillController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.config = {
        minGlobalIntervalMs: Math.max(150, Math.min(2000, Number(options.minGlobalIntervalMs) || 350)),
        rejectionBackoffMs: Math.max(1000, Math.min(30000, Number(options.rejectionBackoffMs) || 5000)),
        mpReserveRatio: Math.max(0, Math.min(0.8, Number(options.mpReserveRatio) || 0.20)),
        defensiveHpRatio: Math.max(0.35, Math.min(0.8, Number(options.defensiveHpRatio) || 0.50)),
        paladinHealHpRatio: Math.max(0.40, Math.min(0.9, Number(options.paladinHealHpRatio) || 0.70)),
        longFightHpFactor: Math.max(2, Math.min(20, Number(options.longFightHpFactor) || 4))
      };

      this.active = false;
      this.sessionId = null;
      this.pending = null;
      this.pendingGeneration = 0;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.lastAttemptAtMs = 0;
      this.lastDecision = null;
      this.lastUse = null;
      this.suppression = new Map();
      this.metrics = {
        decisions: 0,
        dispatched: 0,
        confirmed: 0,
        rejected: 0,
        unknown: 0,
        damageSkills: 0,
        supportSkills: 0,
        defensiveSkills: 0,
        mobilitySkills: 0,
        skillKillsConfirmed: 0,
        cooldownSkips: 0,
        mpSkips: 0,
        rangeSkips: 0,
        spamSkips: 0,
        overkillSkips: 0,
        unavailableSkips: 0,
        activeConditionSkips: 0
      };
    }

    start() {
      this.active = true;
      return this.status();
    }

    stop(reason = 'CLASS_SKILLS_STOP') {
      this.active = false;
      this.endSession(reason);
      return this.status();
    }

    beginSession(sessionId) {
      const id = cleanText(sessionId || '', 120) || null;
      if (id && id !== this.sessionId) {
        this.sessionId = id;
        this.suspendedSessionId = null;
        this.suspendedReason = null;
        this.pendingGeneration += 1;
        this.pending = null;
      }
      return this.status();
    }

    endSession(reason = 'COMBAT_SESSION_END') {
      this.pendingGeneration += 1;
      this.pending = null;
      this.sessionId = null;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.lastDecision = this.lastDecision ? { ...this.lastDecision, sessionEndReason: cleanText(reason, 180) } : null;
      return this.status();
    }

    supportedSkills(ctype) {
      const key = cleanText(ctype || '', 60).toLowerCase();
      return (CLASS_SKILLS[key] || []).slice();
    }

    liveSkillSummary(ctype) {
      return this.supportedSkills(ctype).map(id => {
        const definition = this.game && typeof this.game.skillDefinition === 'function'
          ? this.game.skillDefinition(id)
          : null;
        return { id, available: !!definition, definition };
      });
    }

    _suppressionKey(skillId, targetId) {
      return String(skillId) + ':' + (targetId == null ? '*' : String(targetId));
    }

    _isSuppressed(skillId, targetId) {
      const key = this._suppressionKey(skillId, targetId);
      const until = this.suppression.get(key) || 0;
      if (until <= this.now()) {
        if (until) this.suppression.delete(key);
        return false;
      }
      return true;
    }

    _suppress(skillId, targetId, ms) {
      const duration = Math.max(0, Number(ms) || 0);
      if (!duration) return;
      this.suppression.set(this._suppressionKey(skillId, targetId), this.now() + duration);
      if (this.suppression.size > 80) {
        const now = this.now();
        for (const [key, until] of this.suppression.entries()) {
          if (until <= now) this.suppression.delete(key);
        }
      }
    }

    _skillCandidate(skillId, target, game, options = {}) {
      const targetId = options.targeted === false ? null : (target && target.id);
      if (this._isSuppressed(skillId, targetId)) {
        this.metrics.spamSkips += 1;
        return null;
      }

      const readiness = this.game.skillReadiness(skillId, targetId);
      if (!readiness || !readiness.available) {
        this.metrics.unavailableSkips += 1;
        return null;
      }
      if (readiness.activeCondition && options.skipIfActive !== false) {
        this.metrics.activeConditionSkips += 1;
        return null;
      }
      if (!readiness.allowed) {
        const reasons = readiness.reasons || [];
        if (reasons.includes('SKILL_COOLDOWN') || reasons.includes('SKILL_CAN_USE_FALSE')) this.metrics.cooldownSkips += 1;
        if (reasons.includes('SKILL_MP_TOO_LOW')) this.metrics.mpSkips += 1;
        if (reasons.includes('SKILL_OUT_OF_RANGE') || reasons.includes('SKILL_TARGET_UNAVAILABLE')) this.metrics.rangeSkips += 1;
        return null;
      }

      const character = game && game.character;
      const cost = finite(readiness.definition && readiness.definition.mp) || 0;
      const mp = finite(character && character.mp);
      const maxMp = finite(character && character.maxMp);
      const reserveRatio = options.mpReserveRatio == null ? this.config.mpReserveRatio : Number(options.mpReserveRatio);
      if (mp != null && maxMp != null && maxMp > 0 && mp - cost < maxMp * reserveRatio) {
        this.metrics.mpSkips += 1;
        return null;
      }

      return {
        id: skillId,
        targetId,
        readiness,
        args: targetId == null ? [skillId] : [skillId, String(targetId)],
        kind: options.kind || 'support',
        reason: options.reason || 'CLASS_SKILL_SELECTED',
        recastMs: Math.max(0, Number(options.recastMs) || 0),
        baselineHp: target && finite(target.hp),
        utility: Number(options.utility) || 0
      };
    }

    _choose(game, target) {
      const character = game && game.character;
      if (!character || !target) return null;
      const ctype = String(character.ctype || '').toLowerCase();
      if (!SUPPORTED_CLASSES.includes(ctype)) return null;

      const hpRatio = ratio(character.hp, character.maxHp);
      const mpRatio = ratio(character.mp, character.maxMp);
      const attack = Math.max(1, finite(character.attack) || 100);
      const targetHp = finite(target.hp);
      const distance = finite(target.distance);
      const range = Math.max(1, finite(character.range) || 40);
      const longFight = targetHp != null && targetHp >= attack * this.config.longFightHpFactor;

      if (ctype === 'warrior') {
        if (hpRatio != null && hpRatio <= this.config.defensiveHpRatio) {
          const defensive = this._skillCandidate('hardshell', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'WARRIOR_LOW_HP_HARDSHELL',
            recastMs: 12000,
            utility: 300
          });
          if (defensive) return defensive;
        }
        if (distance != null && distance > Math.max(35, range * 1.4)) {
          const charge = this._skillCandidate('charge', target, game, {
            targeted: false,
            kind: 'mobility',
            reason: 'WARRIOR_CLOSE_DISTANCE_CHARGE',
            recastMs: 30000,
            utility: 220
          });
          if (charge) return charge;
        }
        if (target.targetId !== character.name) {
          const taunt = this._skillCandidate('taunt', target, game, {
            kind: 'support',
            reason: target.targetId ? 'WARRIOR_RECLAIM_AGGRO' : 'WARRIOR_CONTROLLED_ENGAGE_TAUNT',
            recastMs: 12000,
            utility: 180
          });
          if (taunt) return taunt;
        }
        if (longFight && mpRatio != null && mpRatio >= 0.65) {
          const warcry = this._skillCandidate('warcry', target, game, {
            targeted: false,
            kind: 'support',
            reason: 'WARRIOR_LONG_FIGHT_WARCRY',
            recastMs: 55000,
            utility: 120
          });
          if (warcry) return warcry;
        }
      }

      if (ctype === 'ranger') {
        if (longFight && mpRatio != null && mpRatio >= 0.50) {
          const mark = this._skillCandidate('huntersmark', target, game, {
            kind: 'support',
            reason: 'RANGER_LONG_FIGHT_HUNTERSMARK',
            recastMs: 10000,
            utility: 220
          });
          if (mark) return mark;
        }
        if (targetHp != null && targetHp > Math.max(150, attack * 1.5)) {
          const shot = this._skillCandidate('supershot', target, game, {
            kind: 'damage',
            reason: 'RANGER_SUPERSHOT_SAFE_DAMAGE',
            recastMs: 25000,
            utility: 180
          });
          if (shot) return shot;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      if (ctype === 'mage') {
        if (targetHp != null && targetHp > Math.max(100, attack * 1.3)) {
          const burst = this._skillCandidate('burst', target, game, {
            kind: 'damage',
            reason: 'MAGE_BURST_SAFE_DAMAGE',
            recastMs: 5000,
            utility: 180
          });
          if (burst) return burst;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      if (ctype === 'priest') {
        if (longFight && mpRatio != null && mpRatio >= 0.80) {
          const blessing = this._skillCandidate('darkblessing', target, game, {
            targeted: false,
            kind: 'support',
            reason: 'PRIEST_LONG_FIGHT_DARKBLESSING',
            recastMs: 55000,
            utility: 200
          });
          if (blessing) return blessing;
        }
        if (targetHp != null && targetHp > Math.max(300, attack * 3) && mpRatio != null && mpRatio >= 0.55) {
          const curse = this._skillCandidate('curse', target, game, {
            kind: 'support',
            reason: 'PRIEST_LONG_FIGHT_CURSE',
            recastMs: 5000,
            utility: 170
          });
          if (curse) return curse;
        }
      }

      if (ctype === 'rogue') {
        if (hpRatio != null && hpRatio <= this.config.defensiveHpRatio) {
          const invis = this._skillCandidate('invis', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'ROGUE_LOW_HP_INVIS',
            recastMs: 10000,
            utility: 300
          });
          if (invis) return invis;
        }
        if (targetHp != null && targetHp > Math.max(140, attack * 1.5)) {
          const burst = this._skillCandidate('mentalburst', target, game, {
            kind: 'damage',
            reason: 'ROGUE_MENTALBURST_SAFE_DAMAGE',
            recastMs: 750,
            utility: 190
          });
          if (burst) return burst;
        }
        if (targetHp != null && targetHp > Math.max(90, attack * 1.15)) {
          const punch = this._skillCandidate('quickpunch', target, game, {
            kind: 'damage',
            reason: 'ROGUE_QUICKPUNCH_SAFE_DAMAGE',
            recastMs: 300,
            utility: 150
          });
          if (punch) return punch;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      if (ctype === 'paladin') {
        if (hpRatio != null && hpRatio <= this.config.paladinHealHpRatio) {
          const heal = this._skillCandidate('selfheal', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'PALADIN_SELFHEAL_THRESHOLD',
            recastMs: 1000,
            utility: 280,
            mpReserveRatio: 0.05
          });
          if (heal) return heal;
        }
        if (targetHp != null && targetHp > Math.max(150, attack * 1.5)) {
          const smash = this._skillCandidate('smash', target, game, {
            kind: 'damage',
            reason: 'PALADIN_SMASH_SAFE_DAMAGE',
            recastMs: 400,
            utility: 170
          });
          if (smash) return smash;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      return null;
    }

    preview(targetId) {
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      if (!game || !game.character) return null;
      const targets = this.game && typeof this.game.visibleMonsters === 'function' ? this.game.visibleMonsters() : [];
      const target = targetId == null
        ? (game.target || targets[0] || null)
        : targets.find(row => String(row.id) === String(targetId)) || (game.target && String(game.target.id) === String(targetId) ? game.target : null);
      if (!target) return null;
      const decision = this._choose(game, target);
      return decision ? clone({
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason,
        recastMs: decision.recastMs
      }) : null;
    }

    _knownRejection(reason) {
      const value = String(reason || '').toLowerCase();
      if (!value) return false;
      if (value.includes('disconnect') || value.includes('timeout') || value.includes('network')) return false;
      return [
        'cooldown', 'no_mp', 'mp', 'too_far', 'range', 'not_found', 'cant_use',
        'cannot_use', 'level', 'weapon', 'requirements', 'disabled', 'stunned'
      ].some(token => value.includes(token));
    }

    _settleConfirmed(pending, response) {
      if (!pending) return;
      this.metrics.confirmed += 1;
      if (pending.kind === 'damage') this.metrics.damageSkills += 1;
      else if (pending.kind === 'defensive') this.metrics.defensiveSkills += 1;
      else if (pending.kind === 'mobility') this.metrics.mobilitySkills += 1;
      else this.metrics.supportSkills += 1;

      const damage = response && typeof response === 'object' ? finite(response.damage) : null;
      const lethal = damage != null && pending.baselineHp != null && damage >= pending.baselineHp;
      if (lethal) this.metrics.skillKillsConfirmed += 1;

      this.lastUse = {
        at: new Date().toISOString(),
        sessionId: pending.sessionId,
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        state: 'CONFIRMED',
        damage,
        lethal,
        response: response == null ? null : clone(response)
      };
      this.pending = null;
      if (this.logger) this.logger.info('Klassen-Skill bestätigt', {
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        damage,
        lethal
      });
    }

    _settleRejected(pending, reason, response) {
      if (!pending) return;
      this.metrics.rejected += 1;
      this._suppress(pending.skillId, pending.targetId, this.config.rejectionBackoffMs);
      this.lastUse = {
        at: new Date().toISOString(),
        sessionId: pending.sessionId,
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        state: 'REJECTED',
        error: cleanText(reason, 240),
        response: response == null ? null : clone(response)
      };
      this.pending = null;
      if (this.logger) this.logger.warn('Klassen-Skill serverseitig abgelehnt', {
        skillId: pending.skillId,
        targetId: pending.targetId,
        error: reason
      });
    }

    _settleUnknown(pending, reason, details) {
      if (!pending) return;
      this.metrics.unknown += 1;
      this.suspendedSessionId = pending.sessionId;
      this.suspendedReason = cleanText(reason, 240);
      this.lastUse = {
        at: new Date().toISOString(),
        sessionId: pending.sessionId,
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        state: 'UNKNOWN',
        error: this.suspendedReason,
        response: details == null ? null : clone(details)
      };
      this.pending = null;
      if (this.logger) this.logger.error('Klassen-Skill Outcome unklar; Skills für Combat-Session suspendiert', {
        skillId: pending.skillId,
        targetId: pending.targetId,
        error: this.suspendedReason
      });
    }

    _watch(dispatch, pending, generation) {
      const value = dispatch && dispatch.value;
      if (!value || typeof value.then !== 'function') {
        const response = value;
        if (response && typeof response === 'object' && response.failed === true) {
          this._settleRejected(pending, errorReason(response, 'SKILL_REJECTED'), response);
        } else if (response && typeof response === 'object' && (response.success === true || response.place || response.response)) {
          this._settleConfirmed(pending, response);
        } else {
          this._settleUnknown(pending, 'SKILL_RESULT_UNCONFIRMED', response);
        }
        return;
      }

      Promise.resolve(value).then(response => {
        if (generation !== this.pendingGeneration) return;
        if (!this.pending || this.pending.id !== pending.id) return;
        if (response && typeof response === 'object' && response.failed === true) {
          this._settleRejected(pending, errorReason(response, 'SKILL_REJECTED'), response);
          return;
        }
        this._settleConfirmed(pending, response);
      }, error => {
        if (generation !== this.pendingGeneration) return;
        if (!this.pending || this.pending.id !== pending.id) return;
        const reason = errorReason(error, 'SKILL_PROMISE_REJECTED');
        if (this._knownRejection(reason)) this._settleRejected(pending, reason, error);
        else this._settleUnknown(pending, reason, error);
      }).catch(() => {});
    }

    maybeUse(context = {}) {
      if (!this.active) return { handled: false, reason: 'CLASS_SKILLS_INACTIVE' };
      const session = context.session || null;
      const game = context.game || (this.game && this.game.snapshot ? this.game.snapshot() : null);
      const target = context.target || (game && game.target) || null;
      if (!session || !session.id || !game || !game.character || !target) return { handled: false, reason: 'CLASS_SKILL_CONTEXT_INCOMPLETE' };

      this.beginSession(session.id);
      if (this.suspendedSessionId === session.id) {
        return { handled: false, suspended: true, reason: this.suspendedReason || 'CLASS_SKILLS_SUSPENDED' };
      }
      if (this.pending) return { handled: true, pending: true, skillId: this.pending.skillId };

      const now = this.now();
      if (now - this.lastAttemptAtMs < this.config.minGlobalIntervalMs) {
        this.metrics.spamSkips += 1;
        return { handled: false, reason: 'CLASS_SKILL_GLOBAL_INTERVAL' };
      }

      this.metrics.decisions += 1;
      const decision = this._choose(game, target);
      this.lastDecision = decision ? {
        at: new Date().toISOString(),
        sessionId: session.id,
        characterClass: game.character.ctype,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason
      } : {
        at: new Date().toISOString(),
        sessionId: session.id,
        characterClass: game.character.ctype,
        skillId: null,
        targetId: target.id || null,
        kind: null,
        reason: 'NO_CLASS_SKILL_SELECTED'
      };
      if (!decision) return { handled: false, reason: 'NO_CLASS_SKILL_SELECTED' };

      let dispatch;
      try {
        dispatch = this.actions.dispatch('use_skill', decision.args);
      } catch (error) {
        return { handled: false, reason: errorReason(error, 'CLASS_SKILL_ACTION_BLOCKED') };
      }

      this.lastAttemptAtMs = now;
      this._suppress(decision.id, decision.targetId, decision.recastMs);

      if (!dispatch || dispatch.state === 'UNAVAILABLE') {
        this.metrics.unavailableSkips += 1;
        return { handled: false, reason: 'USE_SKILL_API_UNAVAILABLE' };
      }
      if (dispatch.state === 'UNKNOWN') {
        const pseudo = {
          id: dispatch.id || ('skill-' + now),
          sessionId: session.id,
          skillId: decision.id,
          targetId: decision.targetId,
          kind: decision.kind,
          reason: decision.reason,
          baselineHp: decision.baselineHp
        };
        this._settleUnknown(pseudo, errorReason(dispatch.error, 'SKILL_DISPATCH_UNKNOWN'), dispatch);
        return { handled: true, unknown: true, skillId: decision.id };
      }

      const pending = {
        id: dispatch.id,
        sessionId: session.id,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason,
        baselineHp: decision.baselineHp,
        dispatchedAt: new Date().toISOString(),
        dispatchedAtMs: now
      };
      this.pending = pending;
      this.metrics.dispatched += 1;
      const generation = this.pendingGeneration;
      this._watch(dispatch, pending, generation);

      if (this.logger) this.logger.info('Klassen-Skill gesendet', {
        id: dispatch.id,
        sessionId: session.id,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason
      });

      return {
        handled: true,
        pending: !!this.pending,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason
      };
    }

    status() {
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const ctype = game && game.character && game.character.ctype || null;
      return {
        schemaVersion: 1,
        active: this.active,
        supportedClasses: SUPPORTED_CLASSES.slice(),
        currentClass: ctype,
        supportedSkills: this.supportedSkills(ctype),
        liveSkills: this.liveSkillSummary(ctype),
        sessionId: this.sessionId,
        suspended: !!(this.sessionId && this.suspendedSessionId === this.sessionId),
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        lastDecision: clone(this.lastDecision),
        lastUse: clone(this.lastUse),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.ClassSkillController = ClassSkillController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function roleForClass(ctype, hasWarrior) {
    const value = String(ctype || '').toLowerCase();
    if (value === 'warrior') return 'TANK';
    if (value === 'priest') return 'HEALER';
    if (value === 'paladin') return hasWarrior ? 'SUPPORT' : 'TANK';
    if (['ranger', 'mage', 'rogue'].includes(value)) return 'DPS';
    if (value === 'merchant') return 'LOGISTICS';
    return 'UNKNOWN';
  }

  function errorReason(value, fallback = 'PARTY_ACTION_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 240);
    }
    const text = cleanText(value, 240);
    return text || fallback;
  }

  class PartyCoordinator {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.roster = options.roster;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.config = {
        tickMs: Math.max(100, Math.min(2000, Number(options.tickMs) || 250)),
        focusHoldMs: Math.max(250, Math.min(10000, Number(options.focusHoldMs) || 1200)),
        focusPingPongWindowMs: Math.max(1000, Math.min(30000, Number(options.focusPingPongWindowMs) || 6000)),
        healHpRatio: Math.max(0.25, Math.min(0.95, Number(options.healHpRatio) || 0.70)),
        partyHealHpRatio: Math.max(0.25, Math.min(0.95, Number(options.partyHealHpRatio) || 0.68)),
        partyHealMinMembers: Math.max(2, Math.min(8, Number(options.partyHealMinMembers) || 2)),
        supportBackoffMs: Math.max(1000, Math.min(30000, Number(options.supportBackoffMs) || 4000))
      };

      this.active = false;
      this.scope = null;
      this.heartbeat = null;
      this.lastSnapshot = null;
      this.focusTargetId = null;
      this.focusSource = null;
      this.focusSinceMs = 0;
      this.pendingFocusId = null;
      this.pendingFocusSinceMs = 0;
      this.focusHistory = [];
      this.pendingSupport = null;
      this.supportGeneration = 0;
      this.supportSuspended = false;
      this.supportSuspendedReason = null;
      this.supportBackoffUntil = 0;
      this.lastSupport = null;
      this.lastDecision = null;
      this.metrics = {
        ticks: 0,
        partySnapshots: 0,
        focusUpdates: 0,
        focusChanges: 0,
        focusPingPongs: 0,
        assistTargetsObserved: 0,
        healsDispatched: 0,
        partyHealsDispatched: 0,
        revivesDispatched: 0,
        supportConfirmed: 0,
        supportRejected: 0,
        supportUnknown: 0,
        foreignPartyBlocks: 0,
        noPartyTicks: 0
      };
    }

    start(context) {
      this.active = true;
      this.focusHistory = [];
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (!this.scope) throw new Error('PARTY_SCOPE_REQUIRED');
      this.scope.interval('party-loop', () => this._tick(), this.config.tickMs, { immediate: true });
      return this.status();
    }

    stop(reason = 'PARTY_MODULE_STOP') {
      this.active = false;
      this.supportGeneration += 1;
      this.pendingSupport = null;
      this.scope = null;
      this.heartbeat = null;
      this.lastDecision = {
        at: new Date().toISOString(),
        type: 'STOP',
        reason: cleanText(reason, 200)
      };
      return this.status();
    }

    _ownedNames() {
      const status = this.roster && this.roster.status ? this.roster.status() : null;
      const rows = status && Array.isArray(status.characters) ? status.characters : [];
      return new Set(rows.map(row => String(row && row.name || '')).filter(Boolean));
    }

    _decorateParty(snapshot) {
      const owned = this._ownedNames();
      const members = (snapshot && snapshot.members || []).map(member => ({
        ...member,
        owned: owned.has(String(member.name || ''))
      }));
      const hasWarrior = members.some(member => member.owned && String(member.ctype || '').toLowerCase() === 'warrior');
      for (const member of members) member.role = roleForClass(member.ctype, hasWarrior);
      const foreign = members.filter(member => !member.owned).map(member => member.name);
      const ownedMembers = members.filter(member => member.owned);
      const local = members.find(member => member.local) || null;
      return {
        ...(snapshot || {}),
        members,
        ownedMembers,
        foreignMemberNames: foreign,
        ownedMemberNames: ownedMembers.map(member => member.name),
        coordinationEnabled: ownedMembers.length >= 2 && foreign.length === 0,
        localRole: local ? local.role : null
      };
    }

    snapshot() {
      const raw = this.game && this.game.partySnapshot ? this.game.partySnapshot() : null;
      return this._decorateParty(raw || {
        schemaVersion: 1,
        available: false,
        partyId: null,
        leader: null,
        memberNames: [],
        members: [],
        size: 0
      });
    }

    _visibleMonsterIds() {
      const monsters = this.game && this.game.visibleMonsters ? this.game.visibleMonsters() : [];
      return new Set(monsters.map(row => String(row.id)));
    }

    _proposedFocus(snapshot) {
      if (!snapshot || !snapshot.coordinationEnabled) return null;
      const visibleMonsters = this._visibleMonsterIds();
      const alive = snapshot.ownedMembers.filter(member => !member.rip && member.targetId && visibleMonsters.has(String(member.targetId)));
      if (!alive.length) return null;

      const tank = alive.find(member => member.role === 'TANK');
      if (tank) return { id: String(tank.targetId), source: 'tank:' + tank.name };

      const leader = alive.find(member => String(member.name) === String(snapshot.leader || ''));
      if (leader) return { id: String(leader.targetId), source: 'leader:' + leader.name };

      const counts = new Map();
      for (const member of alive) {
        const key = String(member.targetId);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      let best = null;
      for (const [id, count] of counts.entries()) {
        if (!best || count > best.count || (count === best.count && id < best.id)) best = { id, count };
      }
      return best ? { id: best.id, source: 'majority:' + best.count } : null;
    }

    _recordFocusTarget(targetId, source, atMs = this.now()) {
      const id = targetId == null ? null : String(targetId);
      if (!id) return false;
      const cutoff = atMs - this.config.focusPingPongWindowMs;
      this.focusHistory = this.focusHistory.filter(row => row && row.atMs >= cutoff);

      const last = this.focusHistory.length ? this.focusHistory[this.focusHistory.length - 1] : null;
      if (last && last.targetId === id) return false;

      let pingPong = false;
      if (last && last.targetId !== id) {
        for (let i = this.focusHistory.length - 2; i >= 0; i -= 1) {
          if (this.focusHistory[i].targetId === id) {
            pingPong = true;
            break;
          }
        }
      }

      this.focusHistory.push({
        targetId: id,
        source: cleanText(source || '', 160) || null,
        atMs
      });
      if (this.focusHistory.length > 24) this.focusHistory.splice(0, this.focusHistory.length - 24);

      if (pingPong) {
        this.metrics.focusPingPongs += 1;
        if (this.logger) this.logger.warn('Party Focus Pingpong erkannt', {
          targetId: id,
          previousTargetId: last && last.targetId || null,
          windowMs: this.config.focusPingPongWindowMs
        });
      }
      return pingPong;
    }

    _updateFocus(snapshot) {
      const proposed = this._proposedFocus(snapshot);
      const now = this.now();

      if (!proposed) {
        this.pendingFocusId = null;
        this.pendingFocusSinceMs = 0;
        if (this.focusTargetId && !this._visibleMonsterIds().has(String(this.focusTargetId))) {
          this.focusTargetId = null;
          this.focusSource = null;
          this.focusSinceMs = 0;
          this.metrics.focusChanges += 1;
        }
        return;
      }

      this.metrics.assistTargetsObserved += 1;
      if (String(proposed.id) === String(this.focusTargetId || '')) {
        this.pendingFocusId = null;
        this.pendingFocusSinceMs = 0;
        this.focusSource = proposed.source;
        return;
      }

      if (String(proposed.id) !== String(this.pendingFocusId || '')) {
        this.pendingFocusId = proposed.id;
        this.pendingFocusSinceMs = now;
        if (!this.focusTargetId) this.pendingFocusSinceMs = now - this.config.focusHoldMs;
      }

      if (now - this.pendingFocusSinceMs < this.config.focusHoldMs) return;
      this._recordFocusTarget(proposed.id, proposed.source, now);
      this.focusTargetId = proposed.id;
      this.focusSource = proposed.source;
      this.focusSinceMs = now;
      this.pendingFocusId = null;
      this.pendingFocusSinceMs = 0;
      this.metrics.focusUpdates += 1;
      this.metrics.focusChanges += 1;
      if (this.logger) this.logger.info('Party Focus aktualisiert', {
        targetId: this.focusTargetId,
        source: this.focusSource
      });
    }

    preferredTargetId() {
      return this.focusTargetId;
    }

    isOwnedPartyMember(name) {
      if (name == null) return false;
      const snapshot = this.lastSnapshot || this.snapshot();
      return !!(snapshot && Array.isArray(snapshot.ownedMemberNames)
        && snapshot.ownedMemberNames.includes(String(name)));
    }

    _supportReadiness(skillId, member, allowDead = false) {
      if (!this.game || typeof this.game.skillReadiness !== 'function') return null;
      return this.game.skillReadiness(skillId, member && member.name || null, { allowDeadTarget: allowDead });
    }

    _chooseSupport(snapshot) {
      if (!snapshot || !snapshot.coordinationEnabled) return null;
      const local = snapshot.ownedMembers.find(member => member.local);
      if (!local || String(local.ctype || '').toLowerCase() !== 'priest') return null;
      if (this.supportSuspended || this.pendingSupport || this.now() < this.supportBackoffUntil) return null;

      const downed = snapshot.ownedMembers
        .filter(member => !member.local && member.rip && member.visible)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (downed.length) {
        const target = downed[0];
        const readiness = this._supportReadiness('revive', target, true);
        if (readiness && readiness.allowed) {
          return { kind: 'revive', action: 'use_skill', args: ['revive', target.name], target, readiness };
        }
      }

      const injured = snapshot.ownedMembers
        .filter(member => !member.rip && member.visible && member.hpRatio != null && member.hpRatio < 0.999)
        .sort((a, b) => a.hpRatio - b.hpRatio);
      const partyHealTargets = injured.filter(member => member.hpRatio <= this.config.partyHealHpRatio);
      if (partyHealTargets.length >= this.config.partyHealMinMembers) {
        const readiness = this.game.skillReadiness('partyheal');
        if (readiness && readiness.allowed) {
          return { kind: 'partyheal', action: 'use_skill', args: ['partyheal'], target: null, readiness };
        }
      }

      const target = injured.find(member => member.hpRatio <= this.config.healHpRatio);
      if (target) {
        const readiness = this._supportReadiness('heal', target, false);
        if (readiness && readiness.allowed && this.actions.available('heal')) {
          const raw = this.game.playerReference(target.name);
          if (raw) return { kind: 'heal', action: 'heal', args: [raw], target, readiness };
        }
      }
      return null;
    }

    _settleSupport(pending, state, response) {
      if (!pending || !this.pendingSupport || this.pendingSupport.id !== pending.id) return;
      if (state === 'CONFIRMED') {
        this.metrics.supportConfirmed += 1;
        this.lastSupport = {
          at: new Date().toISOString(),
          id: pending.id,
          kind: pending.kind,
          target: pending.targetName,
          state,
          response: response == null ? null : clone(response)
        };
      } else if (state === 'REJECTED') {
        this.metrics.supportRejected += 1;
        this.supportBackoffUntil = this.now() + this.config.supportBackoffMs;
        this.lastSupport = {
          at: new Date().toISOString(),
          id: pending.id,
          kind: pending.kind,
          target: pending.targetName,
          state,
          error: errorReason(response, 'PARTY_SUPPORT_REJECTED')
        };
      } else {
        this.metrics.supportUnknown += 1;
        this.supportSuspended = true;
        this.supportSuspendedReason = errorReason(response, 'PARTY_SUPPORT_UNKNOWN');
        this.lastSupport = {
          at: new Date().toISOString(),
          id: pending.id,
          kind: pending.kind,
          target: pending.targetName,
          state: 'UNKNOWN',
          error: this.supportSuspendedReason
        };
      }
      this.pendingSupport = null;
    }

    _watchSupport(dispatch, pending, generation) {
      const value = dispatch && dispatch.value;
      if (!value || typeof value.then !== 'function') {
        if (value && typeof value === 'object' && value.failed === true) this._settleSupport(pending, 'REJECTED', value);
        else if (value && typeof value === 'object' && (value.success === true || value.response || value.place || value.heal != null)) this._settleSupport(pending, 'CONFIRMED', value);
        else this._settleSupport(pending, 'UNKNOWN', value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (generation !== this.supportGeneration) return;
        if (!this.pendingSupport || this.pendingSupport.id !== pending.id) return;
        if (response && typeof response === 'object' && response.failed === true) this._settleSupport(pending, 'REJECTED', response);
        else this._settleSupport(pending, 'CONFIRMED', response);
      }, error => {
        if (generation !== this.supportGeneration) return;
        if (!this.pendingSupport || this.pendingSupport.id !== pending.id) return;
        const reason = errorReason(error, 'PARTY_SUPPORT_PROMISE_REJECTED');
        const known = /cooldown|no_mp|too_far|range|not_found|cant_use|cannot_use|level|disabled/i.test(reason);
        this._settleSupport(pending, known ? 'REJECTED' : 'UNKNOWN', error);
      }).catch(() => {});
    }

    _dispatchSupport(decision) {
      let dispatch;
      try {
        dispatch = this.actions.dispatch(decision.action, decision.args);
      } catch (error) {
        this.lastDecision = { at: new Date().toISOString(), type: 'SUPPORT_BLOCKED', error: errorReason(error) };
        return;
      }
      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        const state = dispatch && dispatch.state || null;
        if (state === 'UNKNOWN') {
          if (decision.kind === 'heal') this.metrics.healsDispatched += 1;
          if (decision.kind === 'partyheal') this.metrics.partyHealsDispatched += 1;
          if (decision.kind === 'revive') this.metrics.revivesDispatched += 1;

          const pending = {
            id: dispatch.id,
            kind: decision.kind,
            targetName: decision.target && decision.target.name || null,
            dispatchedAt: dispatch.at || new Date().toISOString()
          };
          this.pendingSupport = pending;
          this.lastDecision = {
            at: new Date().toISOString(),
            type: 'SUPPORT_UNKNOWN',
            kind: pending.kind,
            target: pending.targetName
          };
          this._settleSupport(pending, 'UNKNOWN', dispatch.error || dispatch);
          return;
        }
        this.lastDecision = { at: new Date().toISOString(), type: 'SUPPORT_NOT_DISPATCHED', state };
        return;
      }

      if (decision.kind === 'heal') this.metrics.healsDispatched += 1;
      if (decision.kind === 'partyheal') this.metrics.partyHealsDispatched += 1;
      if (decision.kind === 'revive') this.metrics.revivesDispatched += 1;

      const pending = {
        id: dispatch.id,
        kind: decision.kind,
        targetName: decision.target && decision.target.name || null,
        dispatchedAt: new Date().toISOString()
      };
      this.pendingSupport = pending;
      this.lastDecision = {
        at: new Date().toISOString(),
        type: 'SUPPORT_DISPATCHED',
        kind: pending.kind,
        target: pending.targetName
      };
      const generation = this.supportGeneration;
      this._watchSupport(dispatch, pending, generation);
    }

    _tick() {
      if (!this.active) return;
      this.metrics.ticks += 1;
      const snapshot = this.snapshot();
      this.lastSnapshot = snapshot;
      this.metrics.partySnapshots += 1;

      if (this.heartbeat) {
        this.heartbeat({
          phase: snapshot.coordinationEnabled ? 'party-coordination' : 'party-observe',
          size: snapshot.size,
          owned: snapshot.ownedMemberNames.length,
          focusTargetId: this.focusTargetId
        });
      }

      if (!snapshot.available || snapshot.size < 2) {
        this.metrics.noPartyTicks += 1;
        this.focusTargetId = null;
        this.focusSource = null;
        return;
      }
      if (snapshot.foreignMemberNames.length) {
        this.metrics.foreignPartyBlocks += 1;
        this.focusTargetId = null;
        this.focusSource = null;
        this.lastDecision = {
          at: new Date().toISOString(),
          type: 'FOREIGN_PARTY_BLOCK',
          members: snapshot.foreignMemberNames.slice()
        };
        return;
      }

      this._updateFocus(snapshot);
      const support = this._chooseSupport(snapshot);
      if (support) this._dispatchSupport(support);
    }

    status() {
      const snapshot = this.lastSnapshot || this.snapshot();
      const localClass = snapshot && snapshot.ownedMembers && snapshot.ownedMembers.find(member => member.local);
      const partyBuffSkills = [];
      if (localClass && this.game && typeof this.game.skillDefinition === 'function') {
        const candidates = ['warcry', 'darkblessing', 'partyheal'];
        for (const id of candidates) {
          const definition = this.game.skillDefinition(id);
          if (definition && definition.classes.includes(String(localClass.ctype || '').toLowerCase()) && (definition.party || definition.multi || id !== 'partyheal')) {
            partyBuffSkills.push(id);
          }
        }
      }
      return {
        schemaVersion: 1,
        active: this.active,
        party: clone(snapshot),
        focus: {
          targetId: this.focusTargetId,
          source: this.focusSource,
          sinceMs: this.focusSinceMs || null,
          pendingTargetId: this.pendingFocusId,
          recentHistory: clone(this.focusHistory)
        },
        support: {
          pending: clone(this.pendingSupport),
          suspended: this.supportSuspended,
          suspendedReason: this.supportSuspendedReason,
          last: clone(this.lastSupport),
          backoffUntilMs: this.supportBackoffUntil || null
        },
        partyBuffSkills,
        lastDecision: clone(this.lastDecision),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.PartyCoordinator = PartyCoordinator;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const EQUIPMENT_TYPES = new Set([
    'weapon','shield','helmet','hat','gloves','shoes','pants','chest','armor','cape',
    'ring','earring','amulet','orb','belt','offhand','source','quiver'
  ]);

  function finite(value) {
    if (value == null) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  class PartyLogisticsController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.party = options.party || null;
      this.movement = options.movement || null;
      this.combat = options.combat || null;
      this.inventory = options.inventory || null;
      this.merchant = options.merchant || null;
      this.bank = options.bank || null;
      this.trade = options.trade || null;
      this.gear = options.gear || null;
      this.upgrade = options.upgrade || null;
      this.exchangeCraft = options.exchangeCraft || null;
      this.economy = options.economy || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : null;

      this.moduleActive = false;
      this.scope = null;
      this.autonomyEnabled = false;
      this.suspendedReason = null;
      this.queue = [];
      this.currentAction = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.actionsThisSession = 0;

      this.config = {
        tickMs: Math.max(250, Math.min(5000, Math.floor(finite(options.tickMs) == null ? 750 : finite(options.tickMs)))),
        transferRange: Math.max(80, Math.min(600, finite(options.transferRange) == null ? 320 : finite(options.transferRange))),
        regroupDistance: Math.max(100, Math.min(5000, finite(options.regroupDistance) == null ? 700 : finite(options.regroupDistance))),
        regroupArrivalRadius: Math.max(20, Math.min(180, finite(options.regroupArrivalRadius) == null ? 80 : finite(options.regroupArrivalRadius))),
        outcomeTimeoutMs: Math.max(2000, Math.min(60000, Math.floor(finite(options.outcomeTimeoutMs) == null ? 8000 : finite(options.outcomeTimeoutMs)))),
        movementTimeoutMs: Math.max(3000, Math.min(120000, Math.floor(finite(options.movementTimeoutMs) == null ? 60000 : finite(options.movementTimeoutMs)))),
        maxActionsPerSession: Math.max(1, Math.min(50, Math.floor(finite(options.maxActionsPerSession) == null ? 6 : finite(options.maxActionsPerSession)))),
        maxQueue: Math.max(1, Math.min(50, Math.floor(finite(options.maxQueue) == null ? 12 : finite(options.maxQueue)))),
        goldReserve: Math.max(0, Math.floor(finite(options.goldReserve) == null ? 100000 : finite(options.goldReserve))),
        allowRegroup: options.allowRegroup !== false
      };

      this.metrics = {
        ticks: 0,
        plans: 0,
        suppliesQueued: 0,
        suppliesDispatched: 0,
        suppliesConfirmed: 0,
        suppliesRejected: 0,
        suppliesUnknown: 0,
        goldQueued: 0,
        goldDispatched: 0,
        goldConfirmed: 0,
        goldRejected: 0,
        goldUnknown: 0,
        regroupPlanned: 0,
        regroupRequests: 0,
        regroupsConfirmed: 0,
        regroupsRejected: 0,
        regroupsUnknown: 0,
        movementBlocks: 0,
        foreignPartyBlocks: 0,
        combatBlocks: 0,
        ownershipBlocks: 0,
        sessionBudgetBlocks: 0,
        actionsQueued: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H18_ALREADY_ACTIVE' };
      const resumedInFlight = !!(this.currentAction && ['SUPPLY','GOLD'].includes(String(this.currentAction.kind || '')));
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.autonomyEnabled = false;
      if (!resumedInFlight) {
        this.suspendedReason = null;
        this.currentAction = null;
        this.actionsThisSession = 0;
      }
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('party-logistics-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true, resumedInFlight };
    }

    stop(reason = 'H18_MODULE_STOP') {
      const preserveInFlight = !!(this.currentAction && ['SUPPLY','GOLD'].includes(String(this.currentAction.kind || '')));
      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.scope = null;
      if (!preserveInFlight) {
        this._cancelOwnedMovement(reason);
        this.currentAction = null;
      }
      this.lastAction = {
        at: nowIso(),
        type: preserveInFlight ? 'STOP_WITH_INFLIGHT_PRESERVED' : 'STOP',
        reason: cleanText(reason, 240),
        currentAction: preserveInFlight ? clone(this.currentAction) : null
      };
      return { stopped: true, inFlightPreserved: preserveInFlight };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.currentAction) return { accepted: false, reason: 'H18_ACTION_ACTIVE' };
      if (this.canAct && this.canAct('party-logistics') !== true) return { accepted: false, reason: 'H18_RUNTIME_ACTION_BLOCKED' };
      if (options.maxActions != null) {
        this.config.maxActionsPerSession = Math.max(1, Math.min(50, Math.floor(Number(options.maxActions) || 1)));
      }
      this.actionsThisSession = 0;
      this.autonomyEnabled = true;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STARTED', maxActions: this.config.maxActionsPerSession };
      return { accepted: true, status: this.status() };
    }

    stopAutonomy(reason = 'H18_AUTONOMY_STOP') {
      this.autonomyEnabled = false;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STOPPED', reason: cleanText(reason, 240) };
      return this.status();
    }

    resetSafety(reason = 'H18_EXPLICIT_RESET') {
      if (this.currentAction) return { ...this.status(), reset: false, reason: 'H18_ACTION_ACTIVE' };
      this.suspendedReason = null;
      this.autonomyEnabled = false;
      this.actionsThisSession = 0;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return { ...this.status(), reset: true };
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H18_POLICY_MUST_BE_OBJECT');
      const number = (key, min, max, integer = false) => {
        if (value[key] == null) return;
        const parsed = finite(value[key]);
        if (parsed == null) throw new Error('H18_POLICY_' + key.toUpperCase() + '_INVALID');
        this.config[key] = Math.max(min, Math.min(max, integer ? Math.floor(parsed) : parsed));
      };
      number('transferRange', 80, 600);
      number('regroupDistance', 100, 5000);
      number('regroupArrivalRadius', 20, 180);
      number('outcomeTimeoutMs', 2000, 60000, true);
      number('movementTimeoutMs', 3000, 120000, true);
      number('maxActionsPerSession', 1, 50, true);
      number('maxQueue', 1, 50, true);
      number('goldReserve', 0, Number.MAX_SAFE_INTEGER, true);
      if (value.allowRegroup != null) this.config.allowRegroup = value.allowRegroup === true;
      return clone(this.config);
    }

    _snapshot() {
      try { return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _inventory() {
      try { return this.game && typeof this.game.inventorySnapshot === 'function' ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _partySnapshot() {
      try { return this.party && typeof this.party.snapshot === 'function' ? this.party.snapshot() : null; }
      catch (_) { return null; }
    }

    _movementStatus() {
      try { return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null; }
      catch (_) { return null; }
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _ownedTarget(name, snapshot = null) {
      const wanted = cleanText(name || '', 120);
      const party = snapshot || this._partySnapshot();
      if (!wanted || !party || !Array.isArray(party.ownedMembers)) return null;
      return party.ownedMembers.find(member => String(member.name || '') === wanted && !member.local) || null;
    }

    _safeSupplyRow(row) {
      if (!row || !row.name || row.locked || row.giveaway || row.gift || row.expiresAt) return false;
      if (Math.max(0, Number(row.level) || 0) > 0) return false;
      const definition = row.definition;
      if (!definition || typeof definition !== 'object') return false;
      const type = cleanText(definition.type || '', 80).toLowerCase();
      if (!type) return false;
      if (definition.quest === true || definition.cash === true || definition.upgrade === true || definition.compound === true) return false;
      if (EQUIPMENT_TYPES.has(type)) return false;
      return true;
    }

    supplyCatalog() {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return [];
      return (inventory.items || [])
        .filter(row => this._safeSupplyRow(row))
        .map(row => ({
          slot: Number(row.slot),
          name: String(row.name),
          quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
          type: cleanText(row.definition && row.definition.type || '', 80) || null,
          utility: ['pot','elixir','food','scroll','uscroll','cscroll','booster'].includes(cleanText(row.definition && row.definition.type || '', 80).toLowerCase())
        }))
        .sort((a, b) => Number(b.utility) - Number(a.utility) || String(a.name).localeCompare(String(b.name)) || a.slot - b.slot);
    }

    _findSupplyRow(itemName, minQuantity = 1) {
      const wanted = cleanText(itemName || '', 160);
      const required = Math.max(1, Math.floor(Number(minQuantity) || 1));
      if (!wanted) return null;
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || [])
        .filter(row => String(row.name || '') === wanted
          && this._safeSupplyRow(row)
          && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= required)
        .sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0))[0] || null;
    }

    _supplyRowAt(slot, itemName) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || []).find(row =>
        Number(row.slot) === Number(slot)
        && String(row.name || '') === String(itemName || '')
        && this._safeSupplyRow(row)) || null;
    }

    _externalBusy() {
      const rows = [
        ['inventory', this.inventory],
        ['merchant', this.merchant],
        ['bank', this.bank],
        ['trade', this.trade],
        ['gear', this.gear],
        ['upgrade', this.upgrade],
        ['exchangeCraft', this.exchangeCraft]
      ];
      const blockers = [];
      for (const [name, controller] of rows) {
        let status = null;
        try { status = controller && typeof controller.status === 'function' ? controller.status() : null; } catch (_) {}
        if (status && (status.pending || status.request || status.delivery || status.pendingLoot || status.currentAction)) {
          blockers.push({ module: name, reason: 'BUSY' });
        }
        if (status && status.suspended) blockers.push({ module: name, reason: status.suspendedReason || 'SUSPENDED' });
      }
      let economy = null;
      try { economy = this.economy && typeof this.economy.status === 'function' ? this.economy.status() : null; } catch (_) {}
      if (economy && (economy.currentAction || economy.autonomyEnabled)) {
        blockers.push({ module: 'economy', reason: economy.currentAction ? 'BUSY' : 'AUTONOMY_ACTIVE' });
      }
      return blockers;
    }

    queueSupply(targetName, itemName, quantity = 1) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H18_QUEUE_FULL' };
      const party = this._partySnapshot();
      if (!party || !party.coordinationEnabled) return { accepted: false, reason: 'H18_OWNED_PARTY_REQUIRED' };
      const target = this._ownedTarget(targetName, party);
      if (!target) return { accepted: false, reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER' };
      const rawQuantity = finite(quantity);
      if (rawQuantity == null || rawQuantity <= 0 || !Number.isInteger(rawQuantity)) {
        return { accepted: false, reason: 'H18_SUPPLY_QUANTITY_INVALID' };
      }
      const wanted = rawQuantity;
      const anyRow = this._findSupplyRow(itemName, 1);
      if (!anyRow) return { accepted: false, reason: 'H18_SUPPLY_ITEM_NOT_SAFE_OR_AVAILABLE' };
      const row = this._findSupplyRow(itemName, wanted);
      if (!row) return { accepted: false, reason: 'H18_SUPPLY_QUANTITY_UNAVAILABLE' };
      const available = Math.max(1, Math.floor(Number(row.quantity) || 1));
      const request = {
        id: 'h18-request-' + (++this.sequence),
        kind: 'SUPPLY',
        targetName: String(target.name),
        itemName: String(row.name),
        quantity: wanted,
        createdAt: nowIso()
      };
      this.queue.push(request);
      this.metrics.suppliesQueued += 1;
      this.lastAction = { at: nowIso(), type: 'SUPPLY_QUEUED', request: clone(request) };
      return { accepted: true, request: clone(request) };
    }

    queueGold(targetName, amount) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H18_QUEUE_FULL' };
      const party = this._partySnapshot();
      if (!party || !party.coordinationEnabled) return { accepted: false, reason: 'H18_OWNED_PARTY_REQUIRED' };
      const target = this._ownedTarget(targetName, party);
      if (!target) return { accepted: false, reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER' };
      const rawAmount = finite(amount);
      if (rawAmount == null || rawAmount <= 0 || !Number.isInteger(rawAmount)) {
        return { accepted: false, reason: 'H18_GOLD_AMOUNT_INVALID' };
      }
      const wanted = rawAmount;
      const snap = this._snapshot();
      const gold = snap && snap.character ? finite(snap.character.gold) : null;
      if (gold == null || gold - wanted < this.config.goldReserve) return { accepted: false, reason: 'H18_GOLD_RESERVE_BLOCKED' };
      const request = {
        id: 'h18-request-' + (++this.sequence),
        kind: 'GOLD',
        targetName: String(target.name),
        amount: wanted,
        createdAt: nowIso()
      };
      this.queue.push(request);
      this.metrics.goldQueued += 1;
      this.lastAction = { at: nowIso(), type: 'GOLD_QUEUED', request: clone(request) };
      return { accepted: true, request: clone(request) };
    }

    cancelQueue(reason = 'H18_QUEUE_CANCELLED') {
      if (this.currentAction) return { cancelled: false, reason: 'H18_ACTION_ACTIVE' };
      const count = this.queue.length;
      this.queue = [];
      this.lastAction = { at: nowIso(), type: 'QUEUE_CANCELLED', reason: cleanText(reason, 240), count };
      return { cancelled: count > 0, count };
    }

    _distance(a, b) {
      if (!a || !b || !a.map || !b.map || String(a.map) !== String(b.map)) return null;
      const ax = finite(a.x), ay = finite(a.y), bx = finite(b.x), by = finite(b.y);
      if ([ax, ay, bx, by].some(value => value == null)) return null;
      return Math.hypot(ax - bx, ay - by);
    }

    _regroupCandidate(party, snap) {
      if (!this.config.allowRegroup || !party || !party.coordinationEnabled || !snap || !snap.character) return null;
      const local = (party.ownedMembers || []).find(member => member.local);
      if (!local || local.rip) return null;
      const others = (party.ownedMembers || [])
        .filter(member => !member.local && !member.rip && member.visible && member.map && finite(member.x) != null && finite(member.y) != null);
      if (!others.length) return null;
      const leader = others.find(member => String(member.name) === String(party.leader || ''));
      const anchor = leader || others.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))[0];
      const distance = this._distance(snap.character, anchor);
      if (String(snap.character.map || '') === String(anchor.map || '') && distance != null && distance <= this.config.regroupDistance) return null;
      return {
        kind: 'REGROUP',
        targetName: anchor.name,
        destination: { map: anchor.map, x: anchor.x, y: anchor.y },
        distance
      };
    }

    _requestPlan(request, party, snap) {
      const target = request && this._ownedTarget(request.targetName, party);
      if (!target) return { state: 'BLOCKED', reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER', selected: null };
      if (target.rip) return { state: 'WAITING', reason: 'H18_TARGET_DEAD', selected: null };
      if (!target.visible || !target.map || finite(target.x) == null || finite(target.y) == null) {
        return { state: 'WAITING', reason: 'H18_TARGET_NOT_VISIBLE', selected: null };
      }
      const distance = this._distance(snap.character, target);
      if (String(snap.character.map || '') !== String(target.map || '') || distance == null || distance > this.config.transferRange) {
        return {
          state: 'READY',
          reason: 'H18_APPROACH_REQUIRED',
          selected: {
            kind: 'APPROACH',
            requestId: request.id,
            targetName: target.name,
            destination: { map: target.map, x: target.x, y: target.y },
            distance
          }
        };
      }

      if (request.kind === 'SUPPLY') {
        const row = this._findSupplyRow(request.itemName, request.quantity);
        if (!row) return { state: 'BLOCKED', reason: 'H18_SUPPLY_ITEM_NOT_SAFE_OR_AVAILABLE', selected: null };
        const available = Math.max(1, Math.floor(Number(row.quantity) || 1));
        if (available < request.quantity) return { state: 'BLOCKED', reason: 'H18_SUPPLY_QUANTITY_UNAVAILABLE', selected: null };
        if (!this.actions || typeof this.actions.available !== 'function' || !this.actions.available('send_item')) {
          return { state: 'BLOCKED', reason: 'H18_SEND_ITEM_UNAVAILABLE', selected: null };
        }
        return {
          state: 'READY',
          reason: 'H18_SUPPLY_READY',
          selected: {
            kind: 'SUPPLY',
            requestId: request.id,
            targetName: target.name,
            itemName: request.itemName,
            quantity: request.quantity,
            slot: Number(row.slot),
            beforeQuantity: available
          }
        };
      }

      if (request.kind === 'GOLD') {
        if (!this.actions || typeof this.actions.available !== 'function' || !this.actions.available('send_gold')) {
          return { state: 'BLOCKED', reason: 'H18_SEND_GOLD_UNAVAILABLE', selected: null };
        }
        const gold = finite(snap.character.gold);
        if (gold == null || gold - request.amount < this.config.goldReserve) {
          return { state: 'BLOCKED', reason: 'H18_GOLD_RESERVE_BLOCKED', selected: null };
        }
        return {
          state: 'READY',
          reason: 'H18_GOLD_READY',
          selected: {
            kind: 'GOLD',
            requestId: request.id,
            targetName: target.name,
            amount: request.amount,
            beforeGold: gold
          }
        };
      }

      return { state: 'BLOCKED', reason: 'H18_REQUEST_KIND_INVALID', selected: null };
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const party = this._partySnapshot();
      const movement = this._movementStatus();

      const base = {
        autonomyEnabled: this.autonomyEnabled,
        actionsThisSession: this.actionsThisSession,
        maxActionsPerSession: this.config.maxActionsPerSession,
        queue: clone(this.queue),
        party: clone(party)
      };

      if (this.suspendedReason) {
        return this.lastPlan = { ...base, state: 'SUSPENDED', reason: this.suspendedReason, selected: null };
      }
      if (!snap || !snap.available || !snap.character) {
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_CHARACTER_UNAVAILABLE', selected: null };
      }
      if (snap.character.rip === true) {
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_CHARACTER_DEAD', selected: null };
      }
      if (this.canAct && this.canAct('party-logistics') !== true) {
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_RUNTIME_ACTION_BLOCKED', selected: null };
      }
      if (!party || !party.coordinationEnabled) {
        if (party && Array.isArray(party.foreignMemberNames) && party.foreignMemberNames.length) this.metrics.foreignPartyBlocks += 1;
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_OWNED_PARTY_REQUIRED', selected: null };
      }
      if (this._combatActive()) {
        this.metrics.combatBlocks += 1;
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_COMBAT_ACTIVE', selected: null };
      }
      const externalBlockers = this._externalBusy();
      if (externalBlockers.length) {
        this.metrics.ownershipBlocks += 1;
        return this.lastPlan = { ...base, state: 'WAITING', reason: 'H18_EXTERNAL_OWNERSHIP_BUSY', selected: null, blockers: externalBlockers };
      }
      if (this.currentAction) {
        return this.lastPlan = { ...base, state: 'ACTIVE', reason: 'H18_ACTION_ACTIVE', selected: clone(this.currentAction) };
      }
      if (movement && movement.activeOrder) {
        const owner = String(movement.activeOrder.owner || '');
        if (owner === 'party-logistics-h18') {
          return this.lastPlan = { ...base, state: 'WAITING', reason: 'H18_MOVEMENT_OWNED', selected: null };
        }
        this.metrics.movementBlocks += 1;
        return this.lastPlan = { ...base, state: 'WAITING', reason: 'H18_MOVEMENT_BUSY', selected: null };
      }

      const request = this.queue[0] || null;
      if (request) {
        const requestPlan = this._requestPlan(request, party, snap);
        return this.lastPlan = { ...base, ...requestPlan };
      }

      const regroup = this._regroupCandidate(party, snap);
      if (regroup) {
        this.metrics.regroupPlanned += 1;
        return this.lastPlan = { ...base, state: 'READY', reason: 'H18_REGROUP_READY', selected: regroup };
      }

      return this.lastPlan = { ...base, state: 'IDLE', reason: 'H18_NO_LOGISTICS_WORK', selected: null };
    }

    _watch(value, action) {
      if (!value || typeof value.then !== 'function') {
        action.settlement = 'RETURNED';
        action.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'RESOLVED';
        this.currentAction.response = response == null ? null : clone(response);
      }, error => {
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'REJECTED';
        this.currentAction.error = cleanText(error && (error.reason || error.message) || error || 'H18_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dequeueRequest(requestId) {
      if (!requestId) return;
      if (this.queue[0] && String(this.queue[0].id) === String(requestId)) this.queue.shift();
      else this.queue = this.queue.filter(row => String(row.id) !== String(requestId));
    }

    _finishCurrent(outcome, details = {}) {
      const current = this.currentAction;
      this.currentAction = null;
      if (outcome === 'CONFIRMED') {
        this.actionsThisSession += current && current.kind !== 'APPROACH' ? 1 : 0;
        if (current && current.kind === 'SUPPLY') this.metrics.suppliesConfirmed += 1;
        if (current && current.kind === 'GOLD') this.metrics.goldConfirmed += 1;
        if (current && current.kind === 'REGROUP') this.metrics.regroupsConfirmed += 1;
        if (current && ['SUPPLY','GOLD'].includes(current.kind)) this._dequeueRequest(current.requestId);
      } else if (outcome === 'REJECTED') {
        if (current && current.kind === 'SUPPLY') this.metrics.suppliesRejected += 1;
        if (current && current.kind === 'GOLD') this.metrics.goldRejected += 1;
        if (current && current.kind === 'REGROUP') this.metrics.regroupsRejected += 1;
        if (current && ['SUPPLY','GOLD'].includes(current.kind)) this._dequeueRequest(current.requestId);
      } else {
        if (current && current.kind === 'SUPPLY') this.metrics.suppliesUnknown += 1;
        if (current && current.kind === 'GOLD') this.metrics.goldUnknown += 1;
        if (current && ['REGROUP','APPROACH'].includes(current.kind)) this.metrics.regroupsUnknown += 1;
      }
      this.lastAction = {
        at: nowIso(),
        type: 'ACTION_' + outcome,
        action: current ? clone(current) : null,
        details: clone(details)
      };
      return clone(this.lastAction);
    }

    _suspend(reason, details = {}) {
      this.suspendedReason = cleanText(reason || 'H18_UNKNOWN', 300) || 'H18_UNKNOWN';
      const result = this._finishCurrent('UNKNOWN', details);
      this.autonomyEnabled = false;
      this._cancelOwnedMovement(this.suspendedReason);
      return { state: 'SUSPENDED', reason: this.suspendedReason, result };
    }

    _observeMovement(current) {
      const movement = this._movementStatus();
      if (movement && movement.activeOrder
          && String(movement.activeOrder.id || '') === String(current.orderId || '')
          && String(movement.activeOrder.owner || '') === 'party-logistics-h18') {
        return { state: 'WAITING', action: clone(current) };
      }
      const last = movement && movement.lastOrder || null;
      if (last && String(last.id || '') === String(current.orderId || '')
          && String(last.owner || '') === 'party-logistics-h18') {
        const state = String(last.state || '');
        if (state === 'COMPLETED') {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', { movement: clone(last) }) };
        }
        if (['CANCELLED','REJECTED'].includes(state)) {
          return { state: 'REJECTED', result: this._finishCurrent('REJECTED', { movement: clone(last) }) };
        }
        if (['STUCK','UNKNOWN','FAILED_SAFE'].includes(state)) {
          return this._suspend('H18_MOVEMENT_' + state, { movement: clone(last) });
        }
      }
      if (Date.now() >= current.deadlineAtMs) return this._suspend('H18_MOVEMENT_TIMEOUT', { orderId: current.orderId });
      return { state: 'WAITING', action: clone(current) };
    }

    _observeCurrent() {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };
      if (current.kind === 'APPROACH' || current.kind === 'REGROUP') return this._observeMovement(current);

      if (current.settlement === 'REJECTED') {
        return this._suspend('H18_DISPATCH_REJECTED_WITHOUT_OUTCOME', { error: current.error || null });
      }
      if (current.response && current.response.failed === true) {
        return { state: 'REJECTED', result: this._finishCurrent('REJECTED', { response: clone(current.response) }) };
      }

      const settlementFinished = current.settlement !== 'PENDING';
      if (current.kind === 'SUPPLY') {
        const row = this._supplyRowAt(current.slot, current.itemName);
        const after = row ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0;
        if (settlementFinished && current.beforeQuantity - after >= current.quantity) {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', {
            evidence: 'SENDER_INVENTORY_DELTA',
            beforeQuantity: current.beforeQuantity,
            afterQuantity: after
          }) };
        }
      }
      if (current.kind === 'GOLD') {
        const snap = this._snapshot();
        const afterGold = snap && snap.character ? finite(snap.character.gold) : null;
        if (settlementFinished && afterGold != null && current.beforeGold - afterGold >= current.amount) {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', {
            evidence: 'SENDER_GOLD_DELTA',
            beforeGold: current.beforeGold,
            afterGold
          }) };
        }
      }

      if (Date.now() >= current.deadlineAtMs) return this._suspend('H18_' + current.kind + '_UNVERIFIED_TIMEOUT');
      return { state: 'WAITING', action: clone(current) };
    }

    _startMovement(selected) {
      if (!selected || !selected.destination || !this.movement || typeof this.movement.smartMove !== 'function') {
        return { accepted: false, reason: 'H18_MOVEMENT_UNAVAILABLE' };
      }
      let moved = null;
      try {
        moved = this.movement.smartMove(selected.destination, {
          owner: 'party-logistics-h18',
          arrivalRadius: this.config.regroupArrivalRadius
        });
      } catch (error) {
        return { accepted: false, reason: cleanText(error && error.message || error, 300) };
      }
      if (!moved || moved.accepted !== true || !moved.order || !moved.order.id) {
        this.metrics.movementBlocks += 1;
        return { accepted: false, reason: moved && moved.reason || 'H18_MOVEMENT_REJECTED' };
      }
      const now = Date.now();
      const current = {
        id: 'h18-action-' + (++this.sequence),
        kind: selected.kind,
        requestId: selected.requestId || null,
        targetName: selected.targetName || null,
        orderId: moved.order.id,
        startedAt: nowIso(),
        startedAtMs: now,
        deadlineAtMs: now + this.config.movementTimeoutMs
      };
      this.currentAction = current;
      this.metrics.regroupRequests += 1;
      this.lastAction = { at: current.startedAt, type: selected.kind + '_STARTED', action: clone(current) };
      return { accepted: true, action: clone(current), movement: clone(moved) };
    }

    _dispatchSelected(selected) {
      if (!selected || !this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H18_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let actionName;
      let args;
      if (selected.kind === 'SUPPLY') {
        actionName = 'send_item';
        args = [selected.targetName, selected.slot, selected.quantity];
      } else if (selected.kind === 'GOLD') {
        actionName = 'send_gold';
        args = [selected.targetName, selected.amount];
      } else {
        return { accepted: false, reason: 'H18_SELECTED_KIND_UNSUPPORTED' };
      }

      let dispatch;
      try { dispatch = this.actions.dispatch(actionName, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        if (dispatch && dispatch.state === 'UNKNOWN') {
          this.currentAction = {
            id: 'h18-action-' + (++this.sequence),
            kind: selected.kind,
            requestId: selected.requestId || null,
            targetName: selected.targetName || null
          };
          return this._suspend('H18_' + selected.kind + '_DISPATCH_UNKNOWN', { error: dispatch.error || null });
        }
        return { accepted: false, reason: dispatch && dispatch.state || 'H18_ACTION_REJECTED' };
      }

      const now = Date.now();
      const current = {
        id: 'h18-action-' + (++this.sequence),
        kind: selected.kind,
        requestId: selected.requestId || null,
        targetName: selected.targetName,
        itemName: selected.itemName || null,
        quantity: selected.quantity || null,
        slot: selected.slot == null ? null : Number(selected.slot),
        amount: selected.amount || null,
        beforeQuantity: selected.beforeQuantity == null ? null : Number(selected.beforeQuantity),
        beforeGold: selected.beforeGold == null ? null : Number(selected.beforeGold),
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.currentAction = current;
      if (selected.kind === 'SUPPLY') this.metrics.suppliesDispatched += 1;
      if (selected.kind === 'GOLD') this.metrics.goldDispatched += 1;
      this.lastAction = { at: current.dispatchedAt, type: selected.kind + '_DISPATCHED', action: clone(current) };
      this._watch(dispatch.value, current);
      return { accepted: true, action: clone(current) };
    }

    _cancelOwnedMovement(reason) {
      try {
        const status = this._movementStatus();
        if (status && status.activeOrder && String(status.activeOrder.owner || '') === 'party-logistics-h18'
            && this.movement && typeof this.movement.cancel === 'function') {
          this.movement.cancel(cleanText(reason, 180) || 'H18_CANCEL');
        }
      } catch (_) {}
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'IDLE', reason: 'H18_MODULE_INACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.currentAction) {
        const observed = this._observeCurrent();
        if (observed.state !== 'IDLE') return observed;
      }

      const plan = this.plan();
      if (!this.autonomyEnabled) return { state: 'OBSERVE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.metrics.sessionBudgetBlocks += 1;
        this.autonomyEnabled = false;
        this.lastAction = { at: nowIso(), type: 'SESSION_BUDGET_REACHED', actions: this.actionsThisSession };
        return { state: 'COMPLETE', reason: 'H18_SESSION_ACTION_BUDGET_REACHED', plan };
      }
      if (!plan || plan.state !== 'READY' || !plan.selected) {
        return { state: plan && plan.state || 'IDLE', reason: plan && plan.reason || 'H18_NO_LOGISTICS_WORK', plan };
      }

      let result;
      if (plan.selected.kind === 'APPROACH' || plan.selected.kind === 'REGROUP') {
        result = this._startMovement(plan.selected);
      } else {
        result = this._dispatchSelected(plan.selected);
      }

      if (!result || result.accepted !== true) {
        if (result && result.state === 'SUSPENDED') return result;
        const selected = plan.selected || {};
        if (selected.kind === 'SUPPLY') this.metrics.suppliesRejected += 1;
        if (selected.kind === 'GOLD') this.metrics.goldRejected += 1;
        if (selected.kind === 'REGROUP') this.metrics.regroupsRejected += 1;
        if (selected.requestId && ['SUPPLY','GOLD'].includes(selected.kind)) this._dequeueRequest(selected.requestId);
        this.lastAction = {
          at: nowIso(),
          type: 'ACTION_QUEUE_REJECTED',
          selected: clone(selected),
          reason: result && result.reason || 'H18_ACTION_REJECTED'
        };
        return { state: 'REJECTED', reason: this.lastAction.reason, plan, result: clone(result) };
      }

      if (plan.selected.kind !== 'APPROACH') this.metrics.actionsQueued = Number(this.metrics.actionsQueued || 0) + 1;
      return { state: 'QUEUED', plan, result };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        queue: clone(this.queue),
        currentAction: clone(this.currentAction),
        actionsThisSession: this.actionsThisSession,
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics),
        supplyCatalog: this.supplyCatalog()
      };
    }
  }

  ns.PartyLogisticsController = PartyLogisticsController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;
  const PROTOCOL = 'albot-h19-cross-window-v1';

  function nowIso(ms) {
    return new Date(ms == null ? Date.now() : ms).toISOString();
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function errorReason(value, fallback = 'H19_CROSS_WINDOW_UNKNOWN') {
    const raw = value && typeof value === 'object'
      ? value.reason || value.code || value.message
      : value;
    return cleanText(raw || fallback, 300) || fallback;
  }

  class H19CrossWindowLifecycleTransport {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.roster = options.roster || null;
      this.getLocalState = typeof options.getLocalState === 'function'
        ? options.getLocalState
        : () => ({ running: false, runEpoch: 0, emergencyStopLatched: false });
      this.startRuntime = typeof options.startRuntime === 'function'
        ? options.startRuntime
        : async () => { throw new Error('H19_CROSS_WINDOW_START_RUNTIME_UNAVAILABLE'); };
      this.stopRuntime = typeof options.stopRuntime === 'function'
        ? options.stopRuntime
        : async () => { throw new Error('H19_CROSS_WINDOW_STOP_RUNTIME_UNAVAILABLE'); };
      this.getPartyState = typeof options.getPartyState === 'function' ? options.getPartyState : () => null;
      this.leavePartyLocal = typeof options.leavePartyLocal === 'function'
        ? options.leavePartyLocal
        : async () => { throw new Error('H19_CROSS_WINDOW_PARTY_LEAVE_UNAVAILABLE'); };
      this.requestPartyJoinLocal = typeof options.requestPartyJoinLocal === 'function'
        ? options.requestPartyJoinLocal
        : async () => { throw new Error('H19_CROSS_WINDOW_PARTY_REQUEST_UNAVAILABLE'); };
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        heartbeatIntervalMs: Math.max(500, Math.min(10000, Number(options.heartbeatIntervalMs) || 1500)),
        staleMs: Math.max(1500, Math.min(30000, Number(options.staleMs) || 5000)),
        settlementTimeoutMs: Math.max(3000, Math.min(120000, Number(options.settlementTimeoutMs) || 15000)),
        maxPeers: Math.max(4, Math.min(64, Number(options.maxPeers) || 16)),
        maxInboundCommands: Math.max(8, Math.min(256, Number(options.maxInboundCommands) || 64))
      };

      this.setIntervalFn = options.setIntervalFn
        || (this.root && typeof this.root.setInterval === 'function' ? this.root.setInterval.bind(this.root) : null);
      this.clearIntervalFn = options.clearIntervalFn
        || (this.root && typeof this.root.clearInterval === 'function' ? this.root.clearInterval.bind(this.root) : null);
      this.setTimeoutFn = options.setTimeoutFn
        || (this.root && typeof this.root.setTimeout === 'function' ? this.root.setTimeout.bind(this.root) : null);
      this.clearTimeoutFn = options.clearTimeoutFn
        || (this.root && typeof this.root.clearTimeout === 'function' ? this.root.clearTimeout.bind(this.root) : null);

      this.installed = false;
      this.previousOnCm = null;
      this.onCmHandler = null;
      this.heartbeatTimer = null;
      this.sequence = 0;
      this.peers = new Map();
      this.pending = new Map();
      this.inboundCommands = new Map();
      this.partyRecoveryLease = null;
      this.sessionId = cleanText(options.sessionId || this._makeSessionId(), 240);
      this.lastHeartbeatAt = null;
      this.lastError = null;
      this.metrics = {
        heartbeatsSent: 0,
        heartbeatsReceived: 0,
        commandsSent: 0,
        commandsReceived: 0,
        acksSent: 0,
        acksReceived: 0,
        settlementsSent: 0,
        settlementsReceived: 0,
        settlementsSucceeded: 0,
        settlementsFailed: 0,
        transportFailures: 0,
        rejectedUntrusted: 0,
        rejectedWrongTarget: 0,
        rejectedWrongServer: 0,
        rejectedExpired: 0,
        rejectedSessionMismatch: 0,
        duplicates: 0
      };
    }

    _makeSessionId() {
      const local = this._localName() || 'unknown';
      return 'h19:' + local + ':' + String(this.now()) + ':' + String(++this.sequence);
    }

    _log(level, message, data) {
      try {
        if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message, data || {});
      } catch (_) {}
    }

    _roots() {
      const out = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!out.includes(current)) out.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return out;
    }

    _readValue(names) {
      for (const candidate of this._roots()) {
        for (const name of names) {
          try {
            const value = candidate && candidate[name];
            if (value != null && String(value).trim()) return String(value).trim();
          } catch (_) {}
        }
      }
      return null;
    }

    _serverIdentity() {
      return {
        region: cleanText(this._readValue(['server_region', 'serverRegion']) || '', 80) || null,
        identifier: cleanText(this._readValue(['server_identifier', 'serverIdentifier']) || '', 80) || null
      };
    }

    _localName() {
      try {
        const state = this.getLocalState();
        const fromState = cleanText(state && (state.localName || state.characterName) || '', 120);
        if (fromState) return fromState;
      } catch (_) {}
      for (const candidate of this._roots()) {
        try {
          const name = cleanText(candidate && candidate.character && candidate.character.name || '', 120);
          if (name) return name;
        } catch (_) {}
      }
      return null;
    }

    _rosterSnapshot() {
      try {
        return this.roster && typeof this.roster.refresh === 'function'
          ? this.roster.refresh()
          : this.roster && typeof this.roster.status === 'function'
            ? this.roster.status()
            : null;
      } catch (_) {
        return null;
      }
    }

    _ownedNames() {
      const roster = this._rosterSnapshot();
      if (!roster || roster.accountStateAvailable !== true || !Array.isArray(roster.accountCharacters)) {
        const local = this._localName();
        return new Set(local ? [local] : []);
      }
      return new Set(roster.accountCharacters
        .map(row => cleanText(row && row.name || '', 120))
        .filter(Boolean));
    }

    _onlineOwnedNames() {
      const roster = this._rosterSnapshot();
      const owned = this._ownedNames();
      if (!roster || roster.onlineStateAvailable !== true) return new Set();
      const rows = Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames : [];
      return new Set(rows.map(String).filter(name => owned.has(name)));
    }

    _resolveSendCm() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate.send_cm === 'function') {
            return { owner: candidate, fn: candidate.send_cm };
          }
        } catch (_) {}
      }
      return null;
    }

    _baseEnvelope(type, target, extra = {}) {
      const server = this._serverIdentity();
      const at = this.now();
      return {
        schemaVersion: 1,
        protocol: PROTOCOL,
        type,
        messageId: 'h19-cm-' + (++this.sequence) + '-' + String(at),
        senderCharacterName: this._localName(),
        senderSessionId: this.sessionId,
        receiverCharacterName: cleanText(target || '', 120),
        serverRegion: server.region,
        serverIdentifier: server.identifier,
        createdAtMs: at,
        validUntilMs: at + this.config.settlementTimeoutMs,
        ...clone(extra)
      };
    }

    _sendRaw(target, envelope) {
      const name = cleanText(target || '', 120);
      const local = this._localName();
      const owned = this._ownedNames();
      if (!name || name === local || !owned.has(name)) throw new Error('H19_CROSS_WINDOW_TARGET_NOT_OWNED');
      const resolved = this._resolveSendCm();
      if (!resolved) throw new Error('H19_CROSS_WINDOW_SEND_CM_UNAVAILABLE');
      return resolved.fn.call(resolved.owner, name, envelope);
    }

    _sendEnvelope(target, envelope, metric) {
      try {
        const value = this._sendRaw(target, envelope);
        if (metric) this.metrics[metric] += 1;
        return value;
      } catch (error) {
        this.metrics.transportFailures += 1;
        this.lastError = { at: nowIso(this.now()), reason: errorReason(error) };
        this._log('warn', 'H19 Cross-Window CM Versand fehlgeschlagen', {
          target: cleanText(target || '', 120),
          type: envelope && envelope.type || null,
          reason: this.lastError.reason
        });
        throw error;
      }
    }

    _serverMatches(envelope) {
      const local = this._serverIdentity();
      if (local.region && (!envelope.serverRegion || String(envelope.serverRegion) !== local.region)) return false;
      if (local.identifier && (!envelope.serverIdentifier || String(envelope.serverIdentifier) !== local.identifier)) return false;
      return true;
    }

    _isTrustedSender(sender, envelope) {
      const actual = cleanText(sender || '', 120);
      const claimed = cleanText(envelope && envelope.senderCharacterName || '', 120);
      return !!actual && actual === claimed && this._ownedNames().has(actual);
    }

    _validEnvelope(sender, data) {
      const envelope = asObject(data);
      if (!envelope || envelope.protocol !== PROTOCOL || envelope.schemaVersion !== 1) return { ok: false, ignored: true };
      const local = this._localName();
      if (!local || cleanText(envelope.receiverCharacterName || '', 120) !== local) {
        this.metrics.rejectedWrongTarget += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_WRONG_TARGET' };
      }
      if (!this._isTrustedSender(sender, envelope)) {
        this.metrics.rejectedUntrusted += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_UNTRUSTED_SENDER' };
      }
      const now = this.now();
      const created = Number(envelope.createdAtMs);
      const validUntil = Number(envelope.validUntilMs);
      if (!Number.isFinite(created) || !Number.isFinite(validUntil) || now < created - 5000 || now > validUntil) {
        this.metrics.rejectedExpired += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_MESSAGE_EXPIRED' };
      }
      if (!this._serverMatches(envelope)) {
        this.metrics.rejectedWrongServer += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_SERVER_MISMATCH' };
      }
      return { ok: true, envelope };
    }

    _boundedPut(map, key, value, limit) {
      map.set(key, value);
      while (map.size > limit) {
        const first = map.keys().next();
        if (first.done) break;
        map.delete(first.value);
      }
    }

    _updatePeer(name, state, observedAtMs) {
      const target = cleanText(name || '', 120);
      const row = asObject(state);
      if (!target || !row) return null;
      const sessionId = cleanText(row.sessionId || row.senderSessionId || '', 240);
      if (!sessionId) return null;
      const peer = {
        name: target,
        sessionId,
        running: row.running === true,
        runEpoch: Number.isFinite(Number(row.runEpoch)) ? Number(row.runEpoch) : 0,
        emergencyStopLatched: row.emergencyStopLatched === true,
        lifecycleAutonomyEnabled: typeof row.lifecycleAutonomyEnabled === 'boolean' ? row.lifecycleAutonomyEnabled : null,
        version: cleanText(row.version || '', 80) || null,
        profile: row.profile && typeof row.profile === 'object' ? {
          schemaVersion: 1,
          name: cleanText(row.profile.name || target, 120) || target,
          ctype: cleanText(row.profile.ctype || '', 40).toLowerCase() || null,
          level: Number.isFinite(Number(row.profile.level)) ? Number(row.profile.level) : null,
          hp: Number.isFinite(Number(row.profile.hp)) ? Number(row.profile.hp) : null,
          maxHp: Number.isFinite(Number(row.profile.maxHp)) ? Number(row.profile.maxHp) : null,
          mp: Number.isFinite(Number(row.profile.mp)) ? Number(row.profile.mp) : null,
          maxMp: Number.isFinite(Number(row.profile.maxMp)) ? Number(row.profile.maxMp) : null,
          attack: Number.isFinite(Number(row.profile.attack)) ? Number(row.profile.attack) : null,
          armor: Number.isFinite(Number(row.profile.armor)) ? Number(row.profile.armor) : null,
          resistance: Number.isFinite(Number(row.profile.resistance)) ? Number(row.profile.resistance) : null,
          frequency: Number.isFinite(Number(row.profile.frequency)) ? Number(row.profile.frequency) : null,
          speed: Number.isFinite(Number(row.profile.speed)) ? Number(row.profile.speed) : null,
          range: Number.isFinite(Number(row.profile.range)) ? Number(row.profile.range) : null,
          rip: row.profile.rip === true,
          map: cleanText(row.profile.map || '', 120) || null,
          gearScore: Number.isFinite(Number(row.profile.gearScore)) ? Math.max(0, Number(row.profile.gearScore)) : 0,
          trainingMs: Number.isFinite(Number(row.profile.trainingMs)) ? Math.max(0, Number(row.profile.trainingMs)) : 0,
          observedAtMs: Number.isFinite(Number(row.profile.observedAtMs)) ? Number(row.profile.observedAtMs) : Number(observedAtMs) || this.now()
        } : null,
        observedAtMs: Number(observedAtMs) || this.now(),
        aliveUntilMs: (Number(observedAtMs) || this.now()) + this.config.staleMs
      };
      this._boundedPut(this.peers, target, peer, this.config.maxPeers);
      return peer;
    }

    _localStatePayload() {
      let state = {};
      try { state = this.getLocalState() || {}; } catch (_) {}
      return {
        sessionId: this.sessionId,
        running: state.running === true,
        runEpoch: Number.isFinite(Number(state.runEpoch)) ? Number(state.runEpoch) : 0,
        emergencyStopLatched: state.emergencyStopLatched === true,
        lifecycleAutonomyEnabled: typeof state.lifecycleAutonomyEnabled === 'boolean' ? state.lifecycleAutonomyEnabled : null,
        version: cleanText(state.version || '', 80) || null,
        profile: state.profile && typeof state.profile === 'object' ? clone(state.profile) : null
      };
    }

    freshPeer(name) {
      const target = cleanText(name || '', 120);
      if (!target) return null;
      const peer = this.peers.get(target);
      if (!peer) return null;
      const now = this.now();
      if (now > Number(peer.aliveUntilMs || 0)) return null;
      if (!this._ownedNames().has(target)) return null;
      const roster = this._rosterSnapshot();
      if (roster && roster.onlineStateAvailable === true) {
        const online = new Set((roster.onlineCharacterNames || []).map(String));
        if (!online.has(target)) return null;
      }
      return clone(peer);
    }

    freshPeers() {
      const out = [];
      for (const name of this.peers.keys()) {
        const peer = this.freshPeer(name);
        if (peer) out.push(peer);
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    broadcastHeartbeat() {
      if (!this.installed) return { sent: 0, reason: 'H19_CROSS_WINDOW_NOT_INSTALLED' };
      const local = this._localName();
      if (!local) return { sent: 0, reason: 'H19_CROSS_WINDOW_LOCAL_NAME_UNAVAILABLE' };
      const targets = [...this._onlineOwnedNames()].filter(name => name !== local).sort();
      this.lastHeartbeatAt = nowIso(this.now());
      let sent = 0;
      for (const target of targets) {
        const envelope = this._baseEnvelope('HEARTBEAT', target, {
          validUntilMs: this.now() + this.config.staleMs,
          state: this._localStatePayload()
        });
        try {
          const value = this._sendEnvelope(target, envelope, 'heartbeatsSent');
          if (value && typeof value.then === 'function') {
            Promise.resolve(value).catch(() => {});
          }
          sent += 1;
        } catch (_) {}
      }
      return { sent, targets };
    }

    _sendAck(target, command) {
      const envelope = this._baseEnvelope('ACK', target, {
        replyTo: command.messageId,
        commandType: command.commandType,
        targetSessionId: this.sessionId,
        state: this._localStatePayload()
      });
      try {
        const value = this._sendEnvelope(target, envelope, 'acksSent');
        if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
        return true;
      } catch (_) {
        return false;
      }
    }

    _sendSettlement(target, command, success, reason, details = null) {
      const envelope = this._baseEnvelope('SETTLEMENT', target, {
        replyTo: command.messageId,
        commandType: command.commandType,
        targetSessionId: this.sessionId,
        success: success === true,
        reason: cleanText(reason || (success ? 'H19_CROSS_WINDOW_SETTLED' : 'H19_CROSS_WINDOW_SETTLEMENT_FAILED'), 300),
        state: this._localStatePayload(),
        details: details == null ? null : clone(details)
      });
      try {
        const value = this._sendEnvelope(target, envelope, 'settlementsSent');
        if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
        return true;
      } catch (_) {
        return false;
      }
    }

    _handleHeartbeat(envelope) {
      this.metrics.heartbeatsReceived += 1;
      const state = asObject(envelope.state);
      if (!state) return false;
      this._updatePeer(envelope.senderCharacterName, {
        ...state,
        sessionId: envelope.senderSessionId || state.sessionId
      }, this.now());
      return true;
    }

    _handleAck(envelope) {
      const replyTo = cleanText(envelope.replyTo || '', 240);
      const pending = replyTo && this.pending.get(replyTo);
      if (!pending || pending.target !== envelope.senderCharacterName) return false;
      this.metrics.acksReceived += 1;
      pending.acknowledgedAtMs = this.now();
      pending.ackState = clone(envelope.state || null);
      return true;
    }

    _finishPending(messageId, outcome) {
      const pending = this.pending.get(messageId);
      if (!pending) return false;
      this.pending.delete(messageId);
      try {
        if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
      } catch (_) {}
      pending.resolve(outcome);
      return true;
    }

    _handleSettlement(envelope) {
      const replyTo = cleanText(envelope.replyTo || '', 240);
      const pending = replyTo && this.pending.get(replyTo);
      if (!pending || pending.target !== envelope.senderCharacterName) return false;

      const observedSessionId = cleanText(envelope.targetSessionId || envelope.senderSessionId || '', 240);
      const expectedSessionId = cleanText(pending.targetSessionId || '', 240);
      const sessionMatches = !!observedSessionId && observedSessionId === expectedSessionId;
      const reason = cleanText(envelope.reason || '', 300) || null;
      const terminalSessionMismatch = !sessionMatches
        && envelope.success === false
        && reason === 'H19_CROSS_WINDOW_TARGET_SESSION_MISMATCH';

      if (!sessionMatches && !terminalSessionMismatch) {
        this.metrics.rejectedSessionMismatch += 1;
        return false;
      }

      const state = asObject(envelope.state) || {};
      if (observedSessionId) {
        this._updatePeer(envelope.senderCharacterName, {
          ...state,
          sessionId: observedSessionId
        }, this.now());
      }

      this.metrics.settlementsReceived += 1;
      if (envelope.success === true) this.metrics.settlementsSucceeded += 1;
      else this.metrics.settlementsFailed += 1;
      if (terminalSessionMismatch) this.metrics.rejectedSessionMismatch += 1;

      return this._finishPending(replyTo, {
        success: envelope.success === true,
        reason,
        commandType: envelope.commandType || null,
        messageId: replyTo,
        target: envelope.senderCharacterName,
        targetSessionId: expectedSessionId,
        observedTargetSessionId: observedSessionId || null,
        state: clone(state),
        details: clone(envelope.details || null)
      });
    }

    _partySnapshot() {
      try {
        const snapshot = this.getPartyState();
        return snapshot && typeof snapshot === 'object' ? clone(snapshot) : null;
      } catch (_) {
        return null;
      }
    }

    _partyMemberNames(snapshot) {
      return snapshot && Array.isArray(snapshot.memberNames) ? snapshot.memberNames.map(name => String(name)) : [];
    }

    _partyHasOnlyOwned(snapshot) {
      const owned = this._ownedNames();
      return this._partyMemberNames(snapshot).every(name => owned.has(name));
    }

    _delay(ms) {
      const waitMs = Math.max(0, Number(ms) || 0);
      return new Promise(resolve => {
        if (this.setTimeoutFn) this.setTimeoutFn(resolve, waitMs);
        else resolve();
      });
    }

    async _waitForPartyState(predicate, timeoutReason) {
      const pollMs = 100;
      const timeoutMs = Math.max(1000, Math.floor(this.config.settlementTimeoutMs * 0.8));
      const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const snapshot = this._partySnapshot();
        if (snapshot && predicate(snapshot)) return snapshot;
        if (attempt + 1 < attempts) await this._delay(pollMs);
      }
      throw new Error(timeoutReason);
    }

    async _executePartyLeave(sender) {
      const localState = this._localStatePayload();
      const localName = this._localName();
      if (localState.running !== true) throw new Error('H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING');
      if (localState.emergencyStopLatched === true) throw new Error('H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED');
      if (localState.lifecycleAutonomyEnabled == null) throw new Error('H19_CROSS_WINDOW_PARTY_AUTONOMY_STATE_UNAVAILABLE');
      if (localState.lifecycleAutonomyEnabled === true) throw new Error('H19_CROSS_WINDOW_PARTY_AUTONOMY_ACTIVE');

      const existingLease = this.partyRecoveryLease;
      if (existingLease && this.now() <= Number(existingLease.validUntilMs || 0)) {
        throw new Error('H19_CROSS_WINDOW_PARTY_RECOVERY_ALREADY_IN_PROGRESS');
      }
      this.partyRecoveryLease = null;

      const before = this._partySnapshot();
      const members = this._partyMemberNames(before);
      if (!before || !before.partyId || !members.includes(String(localName || ''))) {
        throw new Error('H19_CROSS_WINDOW_PARTY_TARGET_NOT_IN_PARTY');
      }
      if (!this._partyHasOnlyOwned(before)) throw new Error('H19_CROSS_WINDOW_FOREIGN_PARTY_MEMBER_PRESENT');
      if (String(before.leader || '') === String(localName || '')) {
        throw new Error('H19_CROSS_WINDOW_PARTY_LEADER_PROTECTED');
      }
      if (String(before.leader || '') !== String(sender || '')) {
        throw new Error('H19_CROSS_WINDOW_PARTY_SENDER_NOT_LEADER');
      }

      // Establish recovery authority before the irreversible dispatch. If the
      // ActionBoundary reports UNKNOWN after dispatch, this authority remains
      // available for evidence-driven/manual cleanup; it is never auto-retried.
      this.partyRecoveryLease = {
        leader: String(sender || ''),
        targetName: String(localName || ''),
        issuedAtMs: this.now(),
        validUntilMs: this.now() + this.config.settlementTimeoutMs * 2
      };

      try {
        this.leavePartyLocal();
      } catch (error) {
        const reason = errorReason(error, 'H19_CROSS_WINDOW_PARTY_LEAVE_DISPATCH_FAILED');
        if (!reason.includes('H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN')) {
          this.partyRecoveryLease = null;
        }
        throw error;
      }

      const after = await this._waitForPartyState(snapshot => {
        const names = this._partyMemberNames(snapshot);
        return !snapshot.partyId && !names.includes(String(localName || ''));
      }, 'H19_CROSS_WINDOW_PARTY_LEAVE_UNVERIFIED_TIMEOUT');

      return {
        reason: 'H19_CROSS_WINDOW_PARTY_LEFT',
        details: {
          localName,
          previousLeader: before.leader || null,
          memberNames: this._partyMemberNames(after),
          recoveryAuthorityValidUntilMs: this.partyRecoveryLease.validUntilMs
        }
      };
    }

    async _executePartyJoinRequest(sender) {
      const localState = this._localStatePayload();
      const localName = this._localName();
      if (localState.running !== true) throw new Error('H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING');
      if (localState.emergencyStopLatched === true) throw new Error('H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED');
      const lease = this.partyRecoveryLease;
      const authorityValid = !!lease
        && String(lease.leader || '') === String(sender || '')
        && String(lease.targetName || '') === String(localName || '')
        && this.now() <= Number(lease.validUntilMs || 0);
      if (!authorityValid) {
        this.partyRecoveryLease = null;
        throw new Error('H19_CROSS_WINDOW_PARTY_RECOVERY_AUTHORITY_UNAVAILABLE');
      }
      this.partyRecoveryLease = null;
      const before = this._partySnapshot();
      const beforeMembers = this._partyMemberNames(before);
      if (!before) throw new Error('H19_CROSS_WINDOW_PARTY_STATE_UNAVAILABLE');
      if (before.partyId || beforeMembers.includes(String(localName || ''))) throw new Error('H19_CROSS_WINDOW_PARTY_TARGET_ALREADY_IN_PARTY');
      try {
        this.requestPartyJoinLocal(sender);
      } catch (error) {
        const reason = errorReason(error, 'H19_CROSS_WINDOW_PARTY_REQUEST_DISPATCH_FAILED');
        if (!reason.includes('H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN')) {
          this.partyRecoveryLease = lease;
        }
        throw error;
      }
      const after = await this._waitForPartyState(snapshot => {
        const names = this._partyMemberNames(snapshot);
        return !!snapshot.partyId
          && String(snapshot.leader || '') === String(sender || '')
          && names.includes(String(localName || ''))
          && names.includes(String(sender || ''))
          && this._partyHasOnlyOwned(snapshot);
      }, 'H19_CROSS_WINDOW_PARTY_JOIN_UNVERIFIED_TIMEOUT');
      return {
        reason: 'H19_CROSS_WINDOW_PARTY_JOINED',
        details: { localName, leader: after.leader || null, partyId: after.partyId || null, memberNames: this._partyMemberNames(after) }
      };
    }

    _handleCommand(envelope) {
      this.metrics.commandsReceived += 1;
      const commandId = cleanText(envelope.messageId || '', 240);
      const sender = cleanText(envelope.senderCharacterName || '', 120);
      const commandType = cleanText(envelope.commandType || '', 80);
      const supported = new Set(['START_RUNTIME', 'STOP_RUNTIME', 'LEAVE_PARTY', 'REQUEST_PARTY_JOIN']);
      if (!commandId || !sender || !supported.has(commandType)) return false;
      if (cleanText(envelope.targetSessionId || '', 240) !== this.sessionId) {
        this.metrics.rejectedSessionMismatch += 1;
        this._sendSettlement(sender, envelope, false, 'H19_CROSS_WINDOW_TARGET_SESSION_MISMATCH');
        return false;
      }
      const existing = this.inboundCommands.get(commandId);
      if (existing) {
        this.metrics.duplicates += 1;
        this._sendAck(sender, envelope);
        if (existing.settlement) this._sendSettlement(sender, envelope, existing.settlement.success, existing.settlement.reason, existing.settlement.details || null);
        return true;
      }
      const record = { state: 'PROCESSING', settlement: null, receivedAtMs: this.now() };
      this._boundedPut(this.inboundCommands, commandId, record, this.config.maxInboundCommands);
      this._sendAck(sender, envelope);
      Promise.resolve().then(async () => {
        let outcome = null;
        if (commandType === 'START_RUNTIME' || commandType === 'STOP_RUNTIME') {
          const desiredRunning = commandType === 'START_RUNTIME';
          const before = this._localStatePayload();
          if (before.running !== desiredRunning) {
            if (desiredRunning) await this.startRuntime('H19_REMOTE_CM_START:' + sender);
            else await this.stopRuntime('H19_REMOTE_CM_STOP:' + sender);
          }
          const after = this._localStatePayload();
          if (after.running !== desiredRunning) throw new Error('H19_CROSS_WINDOW_LOCAL_RUNTIME_STATE_MISMATCH');
          outcome = {
            reason: desiredRunning ? 'H19_CROSS_WINDOW_RUNTIME_STARTED' : 'H19_CROSS_WINDOW_RUNTIME_STOPPED',
            details: { running: after.running, runEpoch: after.runEpoch }
          };
        } else if (commandType === 'LEAVE_PARTY') {
          outcome = await this._executePartyLeave(sender);
        } else if (commandType === 'REQUEST_PARTY_JOIN') {
          outcome = await this._executePartyJoinRequest(sender);
        }
        record.state = 'SETTLED';
        record.settlement = { success: true, reason: outcome && outcome.reason || 'H19_CROSS_WINDOW_SETTLED', details: outcome && outcome.details || null };
        this._sendSettlement(sender, envelope, true, record.settlement.reason, record.settlement.details);
        try { this.broadcastHeartbeat(); } catch (_) {}
      }).catch(error => {
        record.state = 'SETTLED';
        record.settlement = { success: false, reason: errorReason(error, 'H19_CROSS_WINDOW_LOCAL_EXECUTION_FAILED'), details: null };
        this._sendSettlement(sender, envelope, false, record.settlement.reason);
      });
      return true;
    }

    _receive(sender, data) {
      const checked = this._validEnvelope(sender, data);
      if (!checked.ok) return checked.ignored ? null : false;
      const envelope = checked.envelope;
      if (envelope.type === 'HEARTBEAT') return this._handleHeartbeat(envelope);
      if (envelope.type === 'ACK') return this._handleAck(envelope);
      if (envelope.type === 'SETTLEMENT') return this._handleSettlement(envelope);
      if (envelope.type === 'COMMAND') return this._handleCommand(envelope);
      return false;
    }

    _requestCommand(targetName, commandType, options = {}) {
      const target = cleanText(targetName || '', 120);
      const local = this._localName();
      if (!target || target === local) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_REMOTE_TARGET_REQUIRED' } };
      if (!this._ownedNames().has(target)) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_TARGET_NOT_OWNED' } };
      const peer = options.peer || this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      const envelope = this._baseEnvelope('COMMAND', target, {
        commandType: cleanText(commandType || '', 80),
        targetSessionId: peer.sessionId,
        validUntilMs: this.now() + this.config.settlementTimeoutMs
      });
      const messageId = envelope.messageId;
      let resolvePromise;
      let rejectPromise;
      const value = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
      const pending = {
        messageId, target, targetSessionId: peer.sessionId, commandType: envelope.commandType,
        desiredRunning: Object.prototype.hasOwnProperty.call(options, 'desiredRunning') ? options.desiredRunning === true : null,
        sentAtMs: this.now(), acknowledgedAtMs: null, ackState: null, timer: null, resolve: resolvePromise, reject: rejectPromise
      };
      this.pending.set(messageId, pending);
      if (this.setTimeoutFn) {
        pending.timer = this.setTimeoutFn(() => {
          if (!this.pending.has(messageId)) return;
          this.pending.delete(messageId);
          this.metrics.transportFailures += 1;
          rejectPromise(new Error('H19_CROSS_WINDOW_SETTLEMENT_TIMEOUT'));
        }, this.config.settlementTimeoutMs);
      }
      let transportValue;
      try {
        transportValue = this._sendEnvelope(target, envelope, 'commandsSent');
      } catch (error) {
        this.pending.delete(messageId);
        if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
        return { id: messageId, state: 'UNKNOWN', dispatched: true, value: null, error: { message: errorReason(error) } };
      }
      if (transportValue && typeof transportValue.then === 'function') {
        Promise.resolve(transportValue).catch(error => {
          const stillPending = this.pending.get(messageId);
          if (!stillPending) return;
          this.pending.delete(messageId);
          if (stillPending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(stillPending.timer);
          stillPending.reject(new Error(errorReason(error, 'H19_CROSS_WINDOW_SEND_CM_REJECTED')));
        });
      }
      return { id: messageId, state: 'DISPATCHED', dispatched: true, value, transport: 'send_cm', targetSessionId: peer.sessionId };
    }

    requestRuntimeState(targetName, desiredRunning) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      const desired = desiredRunning === true;
      if (peer.running === desired) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: desired ? 'H19_CROSS_WINDOW_RUNTIME_ALREADY_RUNNING' : 'H19_CROSS_WINDOW_RUNTIME_ALREADY_STOPPED' } };
      }
      return this._requestCommand(target, desired ? 'START_RUNTIME' : 'STOP_RUNTIME', { peer, desiredRunning: desired });
    }

    requestPartyLeave(targetName) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING' } };
      if (peer.emergencyStopLatched === true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED' } };
      return this._requestCommand(target, 'LEAVE_PARTY', { peer });
    }

    requestPartyJoin(targetName) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING' } };
      if (peer.emergencyStopLatched === true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED' } };
      return this._requestCommand(target, 'REQUEST_PARTY_JOIN', { peer });
    }

    install() {
      if (this.installed) return this.status();
      if (!this.root) throw new Error('H19_CROSS_WINDOW_ROOT_UNAVAILABLE');
      this.previousOnCm = typeof this.root.on_cm === 'function' ? this.root.on_cm : null;
      const self = this;
      this.onCmHandler = function h19CrossWindowOnCm(sender, data) {
        const handled = self._receive(sender, data);
        if (handled !== null) return handled;
        if (self.previousOnCm) return self.previousOnCm.apply(this, arguments);
        return undefined;
      };
      this.root.on_cm = this.onCmHandler;
      this.installed = true;
      try { this.broadcastHeartbeat(); } catch (_) {}
      if (this.setIntervalFn) {
        this.heartbeatTimer = this.setIntervalFn(() => {
          try { this.broadcastHeartbeat(); } catch (_) {}
        }, this.config.heartbeatIntervalMs);
        try {
          if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref();
          }
        } catch (_) {}
      }
      return this.status();
    }

    destroy(reason = 'H19_CROSS_WINDOW_DESTROY') {
      if (!this.installed) return this.status();
      this.installed = false;
      try {
        if (this.heartbeatTimer != null && this.clearIntervalFn) this.clearIntervalFn(this.heartbeatTimer);
      } catch (_) {}
      this.heartbeatTimer = null;
      try {
        if (this.root && this.root.on_cm === this.onCmHandler) {
          this.root.on_cm = this.previousOnCm || undefined;
        }
      } catch (_) {}
      this.onCmHandler = null;
      this.previousOnCm = null;

      for (const pending of this.pending.values()) {
        try {
          if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
          pending.reject(new Error(cleanText(reason, 200) || 'H19_CROSS_WINDOW_DESTROYED'));
        } catch (_) {}
      }
      this.pending.clear();
      this.partyRecoveryLease = null;
      return this.status();
    }

    status() {
      const now = this.now();
      const peers = [...this.peers.values()]
        .map(peer => ({
          ...clone(peer),
          fresh: now <= Number(peer.aliveUntilMs || 0),
          ageMs: Math.max(0, now - Number(peer.observedAtMs || now))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        schemaVersion: 1,
        protocol: PROTOCOL,
        installed: this.installed,
        sessionId: this.sessionId,
        localName: this._localName(),
        server: this._serverIdentity(),
        lastHeartbeatAt: this.lastHeartbeatAt,
        peers,
        freshPeers: this.freshPeers(),
        pending: [...this.pending.values()].map(row => ({
          messageId: row.messageId,
          target: row.target,
          targetSessionId: row.targetSessionId,
          commandType: row.commandType,
          desiredRunning: row.desiredRunning,
          sentAtMs: row.sentAtMs,
          acknowledgedAtMs: row.acknowledgedAtMs
        })),
        partyRecoveryLease: clone(this.partyRecoveryLease),
        config: clone(this.config),
        metrics: clone(this.metrics),
        lastError: clone(this.lastError)
      };
    }
  }

  ns.H19CrossWindowLifecycleTransport = H19CrossWindowLifecycleTransport;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function nowIso() { return new Date().toISOString(); }

  function errorReason(value, fallback = 'H19_ACTION_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 300);
    }
    const text = cleanText(value, 300);
    return text || fallback;
  }

  class CharacterLifecycleController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.roster = options.roster;
      this.party = options.party || null;
      this.storage = options.storage || null;
      this.crossWindow = options.crossWindow || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : () => true;

      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(3000, Math.min(120000, Number(options.outcomeTimeoutMs) || 15000)),
        respawnGraceMs: Math.max(12000, Math.min(30000, Number(options.respawnGraceMs) || 13000)),
        maxActionsPerSession: Math.max(1, Math.min(20, Number(options.maxActionsPerSession) || 4)),
        maxQueue: Math.max(1, Math.min(32, Number(options.maxQueue) || 12))
      };

      this.moduleActive = false;
      this.scope = null;
      this.autonomyEnabled = false;
      this.actionsThisSession = 0;
      this.queue = [];
      this.currentAction = null;
      this.suspended = false;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.settlementGeneration = 0;
      this.restoredPending = false;
      this.deathObservedAtMs = null;
      this.partySignals = [];
      this.previousPartyInviteHandler = null;
      this.previousPartyRequestHandler = null;
      this.partyInviteHandler = null;
      this.partyRequestHandler = null;
      this.policyState = {
        desiredActiveNames: [],
        desiredRuntimeRunningNames: [],
        desiredPartyMemberNames: [],
        desiredPartyLeader: null
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        actionsQueued: 0,
        actionsDispatched: 0,
        actionsConfirmed: 0,
        actionsRejected: 0,
        actionsUnknown: 0,
        startsQueued: 0,
        startsConfirmed: 0,
        stopsQueued: 0,
        stopsConfirmed: 0,
        respawnsQueued: 0,
        respawnsConfirmed: 0,
        respawnCooldownBlocks: 0,
        respawnCooldownRejects: 0,
        partyInvitesDispatched: 0,
        partyInvitesConfirmed: 0,
        partyRequestsDispatched: 0,
        partyRequestsConfirmed: 0,
        partyAcceptsDispatched: 0,
        partyAcceptsConfirmed: 0,
        partySignalsObserved: 0,
        partySignalsIgnored: 0,
        partyConflictBlocks: 0,
        reconciliations: 0,
        sessionBudgetBlocks: 0,
        ownershipBlocks: 0,
        safetyBlocks: 0,
        crossWindowDispatches: 0,
        crossWindowConfirms: 0
      };
    }

    _local() {
      try {
        const snapshot = this.game && this.game.snapshot ? this.game.snapshot() : null;
        return snapshot && snapshot.character ? snapshot.character : null;
      } catch (_) {
        return null;
      }
    }

    _localName() {
      const local = this._local();
      return cleanText(local && local.name || '', 120);
    }

    _respawnReadiness() {
      const local = this._local();
      if (!local || !local.name) {
        return { ready: false, reason: 'H19_LOCAL_CHARACTER_UNAVAILABLE', local: null, readyAtMs: null, waitMs: null };
      }
      if (local.rip !== true) {
        this.deathObservedAtMs = null;
        return { ready: false, reason: 'H19_LOCAL_CHARACTER_NOT_DEAD', local: clone(local), readyAtMs: null, waitMs: null };
      }

      const nowMs = Date.now();
      if (!Number.isFinite(this.deathObservedAtMs)) this.deathObservedAtMs = nowMs;
      const readyAtMs = this.deathObservedAtMs + this.config.respawnGraceMs;
      const waitMs = Math.max(0, readyAtMs - nowMs);
      return {
        ready: waitMs <= 0,
        reason: waitMs <= 0 ? 'H19_RESPAWN_READY' : 'H19_RESPAWN_COOLDOWN',
        local: clone(local),
        observedAtMs: this.deathObservedAtMs,
        readyAtMs,
        waitMs
      };
    }

    _partySnapshot() {
      try {
        return this.party && typeof this.party.snapshot === 'function' ? this.party.snapshot() : null;
      } catch (_) {
        return null;
      }
    }

    _partyMemberSet(snapshot = null) {
      const party = snapshot || this._partySnapshot();
      const names = party && Array.isArray(party.memberNames)
        ? party.memberNames
        : party && Array.isArray(party.ownedMemberNames)
          ? party.ownedMemberNames
          : [];
      return new Set(names.map(String));
    }

    _installPartyHooks() {
      if (!this.root || this.partyInviteHandler || this.partyRequestHandler) return;
      try {
        this.previousPartyInviteHandler = typeof this.root.on_party_invite === 'function' ? this.root.on_party_invite : null;
        this.previousPartyRequestHandler = typeof this.root.on_party_request === 'function' ? this.root.on_party_request : null;
      } catch (_) {
        this.previousPartyInviteHandler = null;
        this.previousPartyRequestHandler = null;
      }

      this.partyInviteHandler = name => {
        try {
          if (this.previousPartyInviteHandler) this.previousPartyInviteHandler(name);
        } catch (_) {}
        this._recordPartySignal('INVITE', name);
      };
      this.partyRequestHandler = name => {
        try {
          if (this.previousPartyRequestHandler) this.previousPartyRequestHandler(name);
        } catch (_) {}
        this._recordPartySignal('REQUEST', name);
      };

      try { this.root.on_party_invite = this.partyInviteHandler; } catch (_) {}
      try { this.root.on_party_request = this.partyRequestHandler; } catch (_) {}
    }

    _restorePartyHooks() {
      if (!this.root) return;
      try {
        if (this.root.on_party_invite === this.partyInviteHandler) {
          this.root.on_party_invite = this.previousPartyInviteHandler || function () {};
        }
      } catch (_) {}
      try {
        if (this.root.on_party_request === this.partyRequestHandler) {
          this.root.on_party_request = this.previousPartyRequestHandler || function () {};
        }
      } catch (_) {}
      this.partyInviteHandler = null;
      this.partyRequestHandler = null;
      this.previousPartyInviteHandler = null;
      this.previousPartyRequestHandler = null;
    }

    _recordPartySignal(kind, name) {
      if (!this.moduleActive) return false;
      const targetName = cleanText(name || '', 120);
      if (!targetName) return false;
      const roster = this._roster();
      const owned = this._ownedRow(targetName, roster);
      const desired = new Set(this.policyState.desiredActiveNames.map(String));
      const leader = this.policyState.desiredPartyLeader;
      const allowed = !!owned
        && !!leader
        && desired.has(targetName)
        && (kind === 'INVITE'
          ? String(leader) === targetName
          : String(leader) === this._localName());
      if (!allowed) {
        this.metrics.partySignalsIgnored += 1;
        return false;
      }
      const signal = {
        id: 'h19-party-signal-' + (++this.sequence),
        kind,
        targetName,
        observedAt: nowIso(),
        observedAtMs: Date.now()
      };
      this.partySignals = this.partySignals
        .filter(row => !(row.kind === kind && String(row.targetName) === targetName))
        .slice(-7);
      this.partySignals.push(signal);
      this.metrics.partySignalsObserved += 1;
      return true;
    }

    _storageKey(kind) {
      const localName = this._localName();
      if (!localName) return null;
      return 'albot:h19:' + kind + ':v1:' + localName;
    }

    _readStorage(kind) {
      const key = this._storageKey(kind);
      if (!key || !this.storage || typeof this.storage.get !== 'function') return null;
      try {
        const raw = this.storage.get(key);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }

    _writeStorage(kind, value) {
      const key = this._storageKey(kind);
      if (!key || !this.storage || typeof this.storage.set !== 'function') return false;
      try {
        this.storage.set(key, JSON.stringify(value));
        return true;
      } catch (_) {
        return false;
      }
    }

    _removeStorage(kind) {
      const key = this._storageKey(kind);
      if (!key || !this.storage || typeof this.storage.remove !== 'function') return false;
      try {
        this.storage.remove(key);
        return true;
      } catch (_) {
        return false;
      }
    }

    _persistCurrent() {
      if (!this.currentAction) return this._removeStorage('pending');
      const row = clone(this.currentAction);
      delete row.response;
      delete row.errorObject;
      this._writeStorage('pending', row);
    }

    _persistPolicy() {
      this._writeStorage('policy', {
        desiredActiveNames: clone(this.policyState.desiredActiveNames),
        desiredRuntimeRunningNames: clone(this.policyState.desiredRuntimeRunningNames),
        desiredPartyMemberNames: clone(this.policyState.desiredPartyMemberNames),
        desiredPartyLeader: this.policyState.desiredPartyLeader || null
      });
    }

    _restoreState() {
      if (this.restoredPending) return;
      this.restoredPending = true;

      const policy = this._readStorage('policy');
      if (policy && Array.isArray(policy.desiredActiveNames)) {
        this.policyState.desiredActiveNames = policy.desiredActiveNames
          .map(name => cleanText(name, 120))
          .filter(Boolean);
        this.policyState.desiredRuntimeRunningNames = Array.isArray(policy.desiredRuntimeRunningNames)
          ? policy.desiredRuntimeRunningNames.map(name => cleanText(name, 120)).filter(Boolean)
          : [];
        this.policyState.desiredPartyMemberNames = Array.isArray(policy.desiredPartyMemberNames)
          ? policy.desiredPartyMemberNames.map(name => cleanText(name, 120)).filter(Boolean)
          : [];
        this.policyState.desiredPartyLeader = cleanText(policy.desiredPartyLeader || '', 120) || null;
      }

      const pending = this._readStorage('pending');
      if (pending && pending.kind && pending.id) {
        this.currentAction = {
          ...pending,
          settlement: 'RESTORED',
          restored: true,
          response: null,
          error: null
        };
        this.metrics.reconciliations += 1;
        this.lastAction = {
          at: nowIso(),
          type: 'PENDING_RESTORED',
          actionId: pending.id,
          kind: pending.kind,
          targetName: pending.targetName || null
        };
      }
    }

    start(context) {
      this.settlementGeneration += 1;
      this.moduleActive = true;
      this.scope = context && context.scope || null;
      this._restoreState();
      this._installPartyHooks();
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('character-lifecycle-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return this.status();
    }

    stop(reason = 'H19_MODULE_STOP') {
      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.settlementGeneration += 1;
      if (this.currentAction && (this.currentAction.settlement === 'PENDING' || this.currentAction.settlement === 'PREPARED')) {
        this.currentAction.settlement = 'INTERRUPTED';
        this.currentAction.interruptedAt = nowIso();
        this._persistCurrent();
      }
      this._restorePartyHooks();
      this.scope = null;
      this.lastAction = {
        at: nowIso(),
        type: 'STOP',
        reason: cleanText(reason, 200),
        pendingPreserved: !!this.currentAction
      };
      if (this.currentAction) this._persistCurrent();
      return this.status();
    }

    _roster() {
      try {
        return this.roster && typeof this.roster.refresh === 'function'
          ? this.roster.refresh()
          : this.roster && typeof this.roster.status === 'function'
            ? this.roster.status()
            : null;
      } catch (_) {
        return null;
      }
    }

    _ownedRow(name, roster) {
      const wanted = cleanText(name, 120);
      if (!wanted || !roster || roster.accountStateAvailable !== true || !Array.isArray(roster.accountCharacters)) return null;
      return roster.accountCharacters.find(row => String(row && row.name || '') === wanted) || null;
    }

    _onlineSet(roster) {
      return new Set(roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String) : []);
    }

    _runnerActiveSet(roster) {
      const names = roster && Array.isArray(roster.runnerActiveCharacterNames)
        ? roster.runnerActiveCharacterNames
        : roster && Array.isArray(roster.activeCharacterNames)
          ? roster.activeCharacterNames
          : [];
      return new Set(names.map(String));
    }

    _validateRemoteTarget(name, mode) {
      const roster = this._roster();
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        return { ok: false, reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
      }
      const owned = this._ownedRow(name, roster);
      if (!owned) {
        this.metrics.ownershipBlocks += 1;
        return { ok: false, reason: 'H19_TARGET_NOT_OWNED' };
      }
      const localName = this._localName();
      if (String(owned.name) === String(localName)) {
        return { ok: false, reason: 'H19_REMOTE_TARGET_IS_LOCAL' };
      }

      const targetName = String(owned.name);
      const active = this._onlineSet(roster).has(targetName);
      const runnerActive = this._runnerActiveSet(roster).has(targetName);
      const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
        ? this.crossWindow.freshPeer(targetName)
        : null;

      if (mode === 'STOP') {
        if (!active) return { ok: false, reason: 'H19_TARGET_ALREADY_STOPPED' };
        if (roster.activeStateAvailable === true && runnerActive) {
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'child-character' };
        }
        if (peer) {
          if (peer.running !== true) return { ok: false, reason: 'H19_TARGET_RUNTIME_ALREADY_STOPPED' };
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'cross-window-runtime' };
        }
        if (roster.activeStateAvailable !== true) {
          return { ok: false, reason: 'H19_RUNNER_ACTIVE_STATE_UNAVAILABLE' };
        }
        return { ok: false, reason: 'H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE' };
      }

      if (mode === 'START') {
        if (peer) {
          if (peer.running === true) return { ok: false, reason: 'H19_TARGET_ALREADY_ACTIVE' };
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'cross-window-runtime' };
        }
        if (active) return { ok: false, reason: 'H19_REMOTE_RUNTIME_PEER_UNAVAILABLE' };
        return { ok: true, roster, owned, active, runnerActive, peer: null, transport: 'child-character' };
      }

      return { ok: false, reason: 'H19_REMOTE_MODE_UNSUPPORTED' };
    }

    _enqueue(kind, targetName, details = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H19_MODULE_NOT_ACTIVE' };
      if (this.suspended) return { accepted: false, reason: this.suspendedReason || 'H19_SUSPENDED' };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H19_QUEUE_FULL' };

      if (kind === 'START' || kind === 'STOP') {
        const check = this._validateRemoteTarget(targetName, kind);
        if (!check.ok) return { accepted: false, reason: check.reason };
      }

      if (kind === 'RESPAWN') {
        const local = this._local();
        if (!local || !local.name) return { accepted: false, reason: 'H19_LOCAL_CHARACTER_UNAVAILABLE' };
        if (local.rip !== true) return { accepted: false, reason: 'H19_LOCAL_CHARACTER_NOT_DEAD' };
        targetName = local.name;
      }

      const request = {
        id: 'h19-request-' + (++this.sequence),
        kind,
        targetName: cleanText(targetName, 120) || null,
        queuedAt: nowIso(),
        ...clone(details)
      };
      this.queue.push(request);
      this.metrics.actionsQueued += 1;
      if (kind === 'START') this.metrics.startsQueued += 1;
      if (kind === 'STOP') this.metrics.stopsQueued += 1;
      if (kind === 'RESPAWN') this.metrics.respawnsQueued += 1;
      this.lastAction = { at: request.queuedAt, type: kind + '_QUEUED', requestId: request.id, targetName: request.targetName };
      return { accepted: true, request: clone(request) };
    }

    queueStart(name) { return this._enqueue('START', name); }
    queueStop(name) { return this._enqueue('STOP', name); }
    queueRespawn() { return this._enqueue('RESPAWN', this._localName()); }

    cancelQueued(requestId = null) {
      if (this.currentAction) return { accepted: false, reason: 'H19_ACTION_IN_FLIGHT' };
      if (requestId == null) {
        const count = this.queue.length;
        this.queue = [];
        return { accepted: true, cancelled: count };
      }
      const wanted = String(requestId);
      const before = this.queue.length;
      this.queue = this.queue.filter(row => String(row.id) !== wanted);
      return { accepted: before !== this.queue.length, cancelled: before - this.queue.length };
    }

    captureDesiredActive() {
      const roster = this._roster();
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        return { accepted: false, reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
      }
      const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
      this.policyState.desiredActiveNames = (roster.onlineCharacterNames || [])
        .map(String)
        .filter(name => owned.has(name))
        .sort((a, b) => a.localeCompare(b));
      const freshPeers = this.crossWindow && typeof this.crossWindow.freshPeers === 'function'
        ? this.crossWindow.freshPeers()
        : [];
      this.policyState.desiredRuntimeRunningNames = freshPeers
        .filter(peer => peer && peer.running === true && owned.has(String(peer.name || '')))
        .map(peer => String(peer.name))
        .sort((a, b) => a.localeCompare(b));
      const party = this._partySnapshot();
      const partyMembers = this._partyMemberSet(party);
      this.policyState.desiredPartyMemberNames = [...partyMembers]
        .filter(name => owned.has(name))
        .sort((a, b) => a.localeCompare(b));
      const partyLeader = cleanText(party && party.leader || '', 120);
      this.policyState.desiredPartyLeader = partyLeader
        && owned.has(partyLeader)
        && this.policyState.desiredPartyMemberNames.includes(partyLeader)
        ? partyLeader
        : null;
      this._persistPolicy();
      return {
        accepted: true,
        desiredActiveNames: clone(this.policyState.desiredActiveNames),
        desiredRuntimeRunningNames: clone(this.policyState.desiredRuntimeRunningNames),
        desiredPartyMemberNames: clone(this.policyState.desiredPartyMemberNames),
        desiredPartyLeader: this.policyState.desiredPartyLeader
      };
    }

    setPolicy(next = {}) {
      const roster = this._roster();
      if (Array.isArray(next.desiredActiveNames)) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        const normalized = [...new Set(next.desiredActiveNames.map(name => cleanText(name, 120)).filter(Boolean))];
        if (normalized.some(name => !owned.has(name))) return { accepted: false, reason: 'H19_POLICY_CONTAINS_NON_OWNED_CHARACTER' };
        this.policyState.desiredActiveNames = normalized.sort((a,b) => a.localeCompare(b));
        const activeDesired = new Set(this.policyState.desiredActiveNames.map(String));
        this.policyState.desiredRuntimeRunningNames = this.policyState.desiredRuntimeRunningNames
          .filter(name => activeDesired.has(String(name)));
      }
      if (Array.isArray(next.desiredRuntimeRunningNames)) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        const activeDesired = new Set(this.policyState.desiredActiveNames.map(String));
        const normalizedRuntime = [...new Set(next.desiredRuntimeRunningNames.map(name => cleanText(name, 120)).filter(Boolean))];
        if (normalizedRuntime.some(name => !owned.has(name))) return { accepted: false, reason: 'H19_RUNTIME_POLICY_CONTAINS_NON_OWNED_CHARACTER' };
        if (normalizedRuntime.some(name => !activeDesired.has(name))) return { accepted: false, reason: 'H19_RUNTIME_TARGET_NOT_DESIRED_ACTIVE' };
        this.policyState.desiredRuntimeRunningNames = normalizedRuntime.sort((a,b) => a.localeCompare(b));
      }
      if (Array.isArray(next.desiredPartyMemberNames)) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        const activeDesired = new Set(this.policyState.desiredActiveNames.map(String));
        const normalizedParty = [...new Set(next.desiredPartyMemberNames.map(name => cleanText(name, 120)).filter(Boolean))];
        if (normalizedParty.some(name => !owned.has(name))) return { accepted: false, reason: 'H19_PARTY_POLICY_CONTAINS_NON_OWNED_CHARACTER' };
        if (normalizedParty.some(name => !activeDesired.has(name))) return { accepted: false, reason: 'H19_PARTY_MEMBER_NOT_DESIRED_ACTIVE' };
        this.policyState.desiredPartyMemberNames = normalizedParty.sort((a,b) => a.localeCompare(b));
        if (this.policyState.desiredPartyLeader && !this.policyState.desiredPartyMemberNames.includes(this.policyState.desiredPartyLeader)) {
          this.policyState.desiredPartyLeader = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(next, 'desiredPartyLeader')) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const leader = cleanText(next.desiredPartyLeader || '', 120) || null;
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        if (leader && !owned.has(leader)) return { accepted: false, reason: 'H19_PARTY_LEADER_NOT_OWNED' };
        if (leader && !this.policyState.desiredPartyMemberNames.includes(leader)) return { accepted: false, reason: 'H19_PARTY_LEADER_NOT_DESIRED_MEMBER' };
        this.policyState.desiredPartyLeader = leader;
      }
      if (next.maxActionsPerSession != null) {
        const value = Math.floor(Number(next.maxActionsPerSession));
        if (!Number.isFinite(value) || value < 1 || value > 20) return { accepted: false, reason: 'H19_INVALID_SESSION_BUDGET' };
        this.config.maxActionsPerSession = value;
      }
      this._persistPolicy();
      return { accepted: true, policy: clone({ ...this.policyState, maxActionsPerSession: this.config.maxActionsPerSession }) };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H19_MODULE_NOT_ACTIVE' };
      if (this.suspended) return { accepted: false, reason: this.suspendedReason || 'H19_SUSPENDED' };
      if (options.captureCurrent === true) {
        const captured = this.captureDesiredActive();
        if (!captured.accepted) return captured;
      }
      if (options.maxActions != null) {
        const value = Math.floor(Number(options.maxActions));
        if (!Number.isFinite(value) || value < 1 || value > 20) return { accepted: false, reason: 'H19_INVALID_SESSION_BUDGET' };
        this.config.maxActionsPerSession = value;
      }
      this.actionsThisSession = 0;
      this.autonomyEnabled = true;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STARTED', desiredActiveNames: clone(this.policyState.desiredActiveNames) };
      return { accepted: true, status: this.status() };
    }

    stopAutonomy(reason = 'H19_AUTONOMY_STOP') {
      this.autonomyEnabled = false;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STOPPED', reason: cleanText(reason, 200) };
      return { accepted: true, status: this.status() };
    }

    resetSafety(reason = 'H19_EXPLICIT_RESET') {
      if (this.currentAction) return { accepted: false, reason: 'H19_ACTION_IN_FLIGHT' };
      this.suspended = false;
      this.suspendedReason = null;
      this.lastAction = { at: nowIso(), type: 'SAFETY_RESET', reason: cleanText(reason, 200) };
      return { accepted: true, status: this.status() };
    }

    acknowledgeUnknown(reason = 'H19_EXPLICIT_UNKNOWN_ACK') {
      const current = this.currentAction;
      if (!this.suspended || !current || current.unknownRecorded !== true) {
        return { accepted: false, reason: 'H19_NO_UNKNOWN_ACTION_TO_ACKNOWLEDGE' };
      }
      const acknowledged = clone(current);
      this.settlementGeneration += 1;
      this.currentAction = null;
      this._removeStorage('pending');
      this.lastAction = {
        at: nowIso(),
        type: 'UNKNOWN_ACKNOWLEDGED',
        reason: cleanText(reason, 200),
        actionId: acknowledged.id || null,
        kind: acknowledged.kind || null,
        targetName: acknowledged.targetName || null
      };
      return {
        accepted: true,
        acknowledged,
        safetyResetRequired: true,
        status: this.status()
      };
    }

    _proposalPartySignal(roster) {
      const party = this._partySnapshot();
      const members = this._partyMemberSet(party);
      const foreign = party && Array.isArray(party.foreignMemberNames) ? party.foreignMemberNames : [];
      const leader = this.policyState.desiredPartyLeader;
      if (foreign.length) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_FOREIGN_PARTY_MEMBER_PRESENT' };
      }
      if (party && party.partyId && party.leader && leader && String(party.leader) !== String(leader)) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_DIFFERENT_PARTY_LEADER_ACTIVE' };
      }
      const nowMs = Date.now();
      while (this.partySignals.length) {
        const signal = this.partySignals[0];
        if (!signal || nowMs - Number(signal.observedAtMs || 0) > this.config.outcomeTimeoutMs * 2) {
          this.partySignals.shift();
          continue;
        }
        if (members.has(String(signal.targetName || ''))) {
          this.partySignals.shift();
          continue;
        }
        const active = this._onlineSet(roster);
        if (!active.has(String(signal.targetName || '')) || !this._ownedRow(signal.targetName, roster)) {
          this.partySignals.shift();
          continue;
        }
        if (signal.kind === 'INVITE') {
          return {
            state: 'READY',
            reason: 'H19_OWNED_PARTY_INVITE_OBSERVED',
            request: {
              id: 'h19-auto-accept-invite-' + signal.targetName,
              kind: 'PARTY_ACCEPT_INVITE',
              targetName: signal.targetName,
              queuedAt: nowIso(),
              automatic: true,
              signalId: signal.id
            }
          };
        }
        if (signal.kind === 'REQUEST') {
          return {
            state: 'READY',
            reason: 'H19_OWNED_PARTY_REQUEST_OBSERVED',
            request: {
              id: 'h19-auto-accept-request-' + signal.targetName,
              kind: 'PARTY_ACCEPT_REQUEST',
              targetName: signal.targetName,
              queuedAt: nowIso(),
              automatic: true,
              signalId: signal.id
            }
          };
        }
        this.partySignals.shift();
      }
      return null;
    }

    _proposalFromDesired() {
      const roster = this._roster();
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        return { state: 'BLOCKED', reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
      }

      const signalProposal = this._proposalPartySignal(roster);
      if (signalProposal) return signalProposal;

      const active = this._onlineSet(roster);
      const localName = this._localName();

      for (const name of this.policyState.desiredRuntimeRunningNames) {
        if (name === localName) continue;
        if (!this._ownedRow(name, roster)) continue;
        const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
          ? this.crossWindow.freshPeer(name)
          : null;
        if (!peer) {
          return {
            state: 'BLOCKED',
            reason: 'H19_DESIRED_RUNTIME_PEER_UNAVAILABLE',
            targetName: name
          };
        }
        if (peer.running !== true) {
          return {
            state: 'READY',
            reason: 'H19_DESIRED_REMOTE_RUNTIME_STOPPED',
            request: {
              id: 'h19-auto-runtime-start-' + name,
              kind: 'START',
              targetName: name,
              queuedAt: nowIso(),
              automatic: true,
              transportHint: 'cross-window-runtime'
            }
          };
        }
      }

      const crossWindowManaged = new Set(this.policyState.desiredRuntimeRunningNames.map(String));
      for (const name of this.policyState.desiredActiveNames) {
        if (name === localName) continue;
        if (!this._ownedRow(name, roster)) continue;
        if (crossWindowManaged.has(name)) continue;
        if (!active.has(name)) {
          return {
            state: 'READY',
            reason: 'H19_DESIRED_CHARACTER_OFFLINE',
            request: {
              id: 'h19-auto-start-' + name,
              kind: 'START',
              targetName: name,
              queuedAt: nowIso(),
              automatic: true
            }
          };
        }
      }

      const desiredPartyMembers = this.policyState.desiredPartyMemberNames;
      const leader = this.policyState.desiredPartyLeader;
      if (!leader || !desiredPartyMembers.length) return { state: 'IDLE', reason: 'H19_DESIRED_ACTIVE_SET_HEALTHY' };
      const party = this._partySnapshot();
      const members = this._partyMemberSet(party);
      const foreign = party && Array.isArray(party.foreignMemberNames) ? party.foreignMemberNames : [];
      if (foreign.length) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_FOREIGN_PARTY_MEMBER_PRESENT' };
      }

      if (party && party.partyId && party.leader && String(party.leader) !== String(leader)) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_DIFFERENT_PARTY_LEADER_ACTIVE' };
      }

      if (String(localName) === String(leader)) {
        for (const name of desiredPartyMembers) {
          if (name === localName || !active.has(name) || members.has(name)) continue;
          return {
            state: 'READY',
            reason: 'H19_DESIRED_PARTY_MEMBER_MISSING',
            request: {
              id: 'h19-auto-party-invite-' + name,
              kind: 'PARTY_INVITE',
              targetName: name,
              queuedAt: nowIso(),
              automatic: true
            }
          };
        }
      } else if (desiredPartyMembers.includes(localName) && active.has(String(leader)) && !members.has(String(leader))) {
        return {
          state: 'READY',
          reason: 'H19_DESIRED_PARTY_LEADER_MISSING',
          request: {
            id: 'h19-auto-party-request-' + leader,
            kind: 'PARTY_REQUEST',
            targetName: leader,
            queuedAt: nowIso(),
            automatic: true
          }
        };
      }

      return { state: 'IDLE', reason: 'H19_DESIRED_ACTIVE_AND_PARTY_SET_HEALTHY' };
    }

    plan() {
      this.metrics.plans += 1;
      if (!this.moduleActive) return this.lastPlan = { state: 'BLOCKED', reason: 'H19_MODULE_NOT_ACTIVE' };
      if (this.suspended) return this.lastPlan = { state: 'SUSPENDED', reason: this.suspendedReason || 'H19_SUSPENDED' };
      if (this.currentAction) return this.lastPlan = { state: 'PENDING', reason: 'H19_ACTION_IN_FLIGHT', currentAction: clone(this.currentAction) };
      if (this.queue.length) return this.lastPlan = { state: 'READY', reason: 'H19_QUEUED_ACTION', request: clone(this.queue[0]) };

      const local = this._local();
      if (this.autonomyEnabled && local && local.rip === true) {
        return this.lastPlan = {
          state: 'READY',
          reason: 'H19_LOCAL_DEATH_RECOVERY',
          request: { id: 'h19-auto-respawn-' + this._localName(), kind: 'RESPAWN', targetName: this._localName(), automatic: true }
        };
      }

      if (!this.autonomyEnabled) return this.lastPlan = { state: 'OBSERVE', reason: 'H19_AUTONOMY_DISABLED' };
      return this.lastPlan = this._proposalFromDesired();
    }

    _watchSettlement(value, action) {
      const generation = this.settlementGeneration;
      if (!value || typeof value.then !== 'function') {
        if (!this.moduleActive || generation !== this.settlementGeneration) return;
        action.settlement = 'RETURNED';
        action.response = value == null ? null : clone(value);
        this._persistCurrent();
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.moduleActive || generation !== this.settlementGeneration) return;
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'RESOLVED';
        this.currentAction.response = response == null ? null : clone(response);
        this._persistCurrent();
      }).catch(error => {
        if (!this.moduleActive || generation !== this.settlementGeneration) return;
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'REJECTED';
        this.currentAction.error = errorReason(error, 'H19_ACTION_PROMISE_REJECTED');
        this._persistCurrent();
      });
    }

    _dispatch(request) {
      if (!request) return { accepted: false, reason: 'H19_REQUEST_REQUIRED' };
      if (!this.canAct('h19:' + request.kind.toLowerCase())) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H19_ACTION_GATE_BLOCKED' };
      }

      let actionName;
      let args;
      let before = {};
      if (request.kind === 'START' || request.kind === 'STOP') {
        const check = this._validateRemoteTarget(request.targetName, request.kind);
        if (!check.ok) return { accepted: false, reason: check.reason };
        actionName = request.kind === 'START' ? 'start_character' : 'stop_character';
        args = [request.targetName];
        before = {
          onlineStateAvailable: true,
          targetWasActive: check.active,
          transport: check.transport || 'child-character',
          targetSessionId: check.peer && check.peer.sessionId || null,
          targetRuntimeWasRunning: check.peer ? check.peer.running === true : null
        };
      } else if (request.kind === 'RESPAWN') {
        const readiness = this._respawnReadiness();
        if (!readiness.ready) {
          if (readiness.reason === 'H19_RESPAWN_COOLDOWN') this.metrics.respawnCooldownBlocks += 1;
          return {
            accepted: false,
            state: 'WAIT',
            reason: readiness.reason,
            readyAtMs: readiness.readyAtMs,
            waitMs: readiness.waitMs
          };
        }
        actionName = 'respawn';
        args = [];
        before = {
          targetWasDead: true,
          deathObservedAtMs: readiness.observedAtMs,
          respawnReadyAtMs: readiness.readyAtMs
        };
      } else if (['PARTY_INVITE', 'PARTY_REQUEST', 'PARTY_ACCEPT_INVITE', 'PARTY_ACCEPT_REQUEST'].includes(request.kind)) {
        const roster = this._roster();
        if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
          return { accepted: false, reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
        }
        if (!this._ownedRow(request.targetName, roster)) {
          this.metrics.ownershipBlocks += 1;
          return { accepted: false, reason: 'H19_PARTY_TARGET_NOT_OWNED' };
        }
        if (!this._onlineSet(roster).has(String(request.targetName || ''))) {
          return { accepted: false, reason: 'H19_PARTY_TARGET_NOT_ACTIVE' };
        }
        const party = this._partySnapshot();
        const members = this._partyMemberSet(party);
        if (members.has(String(request.targetName || ''))) {
          return { accepted: false, reason: 'H19_PARTY_TARGET_ALREADY_MEMBER' };
        }
        const mapping = {
          PARTY_INVITE: 'send_party_invite',
          PARTY_REQUEST: 'send_party_request',
          PARTY_ACCEPT_INVITE: 'accept_party_invite',
          PARTY_ACCEPT_REQUEST: 'accept_party_request'
        };
        actionName = mapping[request.kind];
        args = [request.targetName];
        before = {
          partyId: party && party.partyId || null,
          leader: party && party.leader || null,
          memberNames: [...members]
        };
      } else {
        return { accepted: false, reason: 'H19_REQUEST_KIND_UNSUPPORTED' };
      }

      const nowMs = Date.now();
      const action = {
        id: 'h19-action-' + (++this.sequence),
        requestId: request.id,
        kind: request.kind,
        targetName: request.targetName || null,
        automatic: request.automatic === true,
        signalId: request.signalId || null,
        preparedAt: nowIso(),
        preparedAtMs: nowMs,
        deadlineAtMs: nowMs + this.config.outcomeTimeoutMs,
        settlement: 'PREPARED',
        restored: false,
        response: null,
        error: null,
        before,
        transport: before.transport || 'game-action'
      };
      this.currentAction = action;
      this._persistCurrent();

      let dispatched;
      try {
        if ((request.kind === 'START' || request.kind === 'STOP')
            && action.transport === 'cross-window-runtime') {
          if (!this.crossWindow || typeof this.crossWindow.requestRuntimeState !== 'function') {
            throw new Error('H19_CROSS_WINDOW_TRANSPORT_UNAVAILABLE');
          }
          dispatched = this.crossWindow.requestRuntimeState(request.targetName, request.kind === 'START');
          this.metrics.crossWindowDispatches += 1;
        } else {
          dispatched = this.actions.dispatch(actionName, args);
        }
      } catch (error) {
        this.currentAction = null;
        this._removeStorage('pending');
        this.metrics.actionsRejected += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_REJECTED_PRE_DISPATCH', reason: errorReason(error) };
        return { accepted: false, reason: errorReason(error) };
      }

      if (dispatched && dispatched.state === 'UNKNOWN' && dispatched.dispatched === true) {
        action.settlement = 'UNKNOWN';
        action.actionBoundaryId = dispatched.id || null;
        action.error = errorReason(dispatched.error, 'H19_DISPATCH_SYNC_UNKNOWN');
        this.currentAction = action;
        this.metrics.actionsDispatched += 1;
        if (request.kind === 'PARTY_INVITE') this.metrics.partyInvitesDispatched += 1;
        if (request.kind === 'PARTY_REQUEST') this.metrics.partyRequestsDispatched += 1;
        if (request.kind === 'PARTY_ACCEPT_INVITE' || request.kind === 'PARTY_ACCEPT_REQUEST') this.metrics.partyAcceptsDispatched += 1;
        this._persistCurrent();
        return this._suspend('H19_DISPATCH_SYNC_UNKNOWN', { error: action.error });
      }

      if (!dispatched || dispatched.state !== 'DISPATCHED') {
        const reason = dispatched && dispatched.error && dispatched.error.message || 'H19_ACTION_NOT_DISPATCHED';
        this.currentAction = null;
        this._removeStorage('pending');
        this.metrics.actionsRejected += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_REJECTED_PRE_DISPATCH', reason: cleanText(reason, 300) };
        return { accepted: false, reason: cleanText(reason, 300) };
      }

      action.settlement = 'PENDING';
      action.actionBoundaryId = dispatched.id || null;
      this.currentAction = action;
      this.metrics.actionsDispatched += 1;
      if (request.kind === 'PARTY_INVITE') this.metrics.partyInvitesDispatched += 1;
      if (request.kind === 'PARTY_REQUEST') this.metrics.partyRequestsDispatched += 1;
      if (request.kind === 'PARTY_ACCEPT_INVITE' || request.kind === 'PARTY_ACCEPT_REQUEST') this.metrics.partyAcceptsDispatched += 1;
      this._persistCurrent();
      this._watchSettlement(dispatched.value, action);
      this.lastAction = { at: nowIso(), type: request.kind + '_DISPATCHED', actionId: action.id, targetName: action.targetName };
      return { accepted: true, state: 'DISPATCHED', currentAction: clone(action) };
    }

    _confirmCurrent(details = {}) {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };
      this.currentAction = null;
      this._removeStorage('pending');
      this.metrics.actionsConfirmed += 1;
      this.actionsThisSession += 1;
      if (current.kind === 'START') this.metrics.startsConfirmed += 1;
      if (current.kind === 'STOP') this.metrics.stopsConfirmed += 1;
      if (current.kind === 'RESPAWN') this.metrics.respawnsConfirmed += 1;
      if (current.kind === 'PARTY_INVITE') this.metrics.partyInvitesConfirmed += 1;
      if (current.kind === 'PARTY_REQUEST') this.metrics.partyRequestsConfirmed += 1;
      if (current.kind === 'PARTY_ACCEPT_INVITE' || current.kind === 'PARTY_ACCEPT_REQUEST') this.metrics.partyAcceptsConfirmed += 1;
      if ((current.kind === 'PARTY_ACCEPT_INVITE' || current.kind === 'PARTY_REQUEST') && !this.policyState.desiredPartyLeader) {
        this.policyState.desiredPartyLeader = current.targetName || null;
        this._persistPolicy();
      }
      if (current.signalId) this.partySignals = this.partySignals.filter(row => String(row.id) !== String(current.signalId));
      this.lastAction = { at: nowIso(), type: current.kind + '_CONFIRMED', targetName: current.targetName, ...clone(details) };
      return { state: 'CONFIRMED', kind: current.kind, targetName: current.targetName, details: clone(details) };
    }

    _suspend(reason, details = {}) {
      const current = this.currentAction;
      const alreadyRecorded = !!(current && current.unknownRecorded === true);
      this.suspended = true;
      this.suspendedReason = cleanText(reason, 300) || 'H19_SUSPENDED';
      this.autonomyEnabled = false;
      if (!alreadyRecorded) this.metrics.actionsUnknown += 1;
      if (current) {
        current.unknownRecorded = true;
        this.currentAction = current;
        this._persistCurrent();
      }
      this.lastAction = { at: nowIso(), type: 'SUSPENDED', reason: this.suspendedReason, repeated: alreadyRecorded, ...clone(details) };
      if (this.logger) this.logger.error('H19 Lifecycle Recovery suspendiert', this.lastAction);
      return { state: 'UNKNOWN', reason: this.suspendedReason, currentAction: clone(this.currentAction) };
    }

    _observeCurrent() {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };

      const settlementFinished = current.settlement !== 'PENDING' && current.settlement !== 'PREPARED';
      if (current.kind === 'START' || current.kind === 'STOP') {
        if (current.transport === 'cross-window-runtime') {
          const desiredRunning = current.kind === 'START';
          const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
            ? this.crossWindow.freshPeer(current.targetName)
            : null;
          const sameSession = !!peer
            && !!current.before
            && !!current.before.targetSessionId
            && String(peer.sessionId || '') === String(current.before.targetSessionId);
          const responseSuccess = current.response && current.response.success === true;
          const restoredReconciled = current.restored === true && settlementFinished && sameSession;
          if (settlementFinished
              && sameSession
              && peer.running === desiredRunning
              && (responseSuccess || restoredReconciled)) {
            this.metrics.crossWindowConfirms += 1;
            return this._confirmCurrent({
              evidence: restoredReconciled ? 'CROSS_WINDOW_RUNTIME_RECONCILED' : 'CROSS_WINDOW_RUNTIME_SETTLEMENT',
              targetSessionId: peer.sessionId,
              running: peer.running
            });
          }
        } else {
          const roster = this._roster();
          if (roster && roster.onlineStateAvailable === true) {
            const active = this._onlineSet(roster).has(String(current.targetName || ''));
            if (settlementFinished && current.kind === 'START' && active) {
              return this._confirmCurrent({ evidence: 'ACTIVE_ROSTER_PRESENT' });
            }
            if (settlementFinished && current.kind === 'STOP' && !active && current.before && current.before.targetWasActive === true) {
              return this._confirmCurrent({ evidence: 'ACTIVE_ROSTER_ABSENT' });
            }
          }
        }
      } else if (current.kind === 'RESPAWN') {
        const local = this._local();
        if (settlementFinished && local && String(local.name || '') === String(current.targetName || '') && local.rip !== true) {
          return this._confirmCurrent({ evidence: 'LOCAL_CHARACTER_ALIVE' });
        }
      } else if (['PARTY_INVITE', 'PARTY_REQUEST', 'PARTY_ACCEPT_INVITE', 'PARTY_ACCEPT_REQUEST'].includes(current.kind)) {
        const party = this._partySnapshot();
        const members = this._partyMemberSet(party);
        const localName = this._localName();
        if (settlementFinished
          && party
          && party.partyId
          && members.has(String(current.targetName || ''))
          && members.has(String(localName || ''))) {
          return this._confirmCurrent({ evidence: 'PARTY_SNAPSHOT_MEMBERSHIP', partyId: party.partyId, leader: party.leader || null });
        }
      }

      if (current.response && (current.response.failed === true || current.response.success === false)) {
        const reason = current.response.reason || 'H19_SERVER_REJECTED';
        this.currentAction = null;
        this._removeStorage('pending');
        this.metrics.actionsRejected += 1;
        if (current.automatic === true) this.autonomyEnabled = false;
        this.lastAction = {
          at: nowIso(),
          type: current.kind + '_REJECTED',
          reason: cleanText(reason, 300),
          autonomyStopped: current.automatic === true
        };
        return { state: 'REJECTED', reason: cleanText(reason, 300), autonomyStopped: current.automatic === true };
      }

      if (current.settlement === 'REJECTED') {
        const error = cleanText(current.error || '', 300);
        if (current.kind === 'RESPAWN' && error === 'cant_respawn') {
          this.currentAction = null;
          this._removeStorage('pending');
          this.metrics.actionsRejected += 1;
          this.metrics.respawnCooldownRejects += 1;
          this.autonomyEnabled = false;
          this.deathObservedAtMs = Date.now();
          const readyAtMs = this.deathObservedAtMs + this.config.respawnGraceMs;
          this.lastAction = {
            at: nowIso(),
            type: 'RESPAWN_REJECTED',
            reason: 'H19_RESPAWN_COOLDOWN',
            serverReason: error,
            readyAtMs,
            autonomyStopped: true
          };
          return {
            state: 'REJECTED',
            reason: 'H19_RESPAWN_COOLDOWN',
            serverReason: error,
            readyAtMs,
            autonomyStopped: true
          };
        }
        return this._suspend('H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME', { error: current.error || null });
      }

      if (Date.now() >= Number(current.deadlineAtMs || 0)) {
        return this._suspend('H19_' + current.kind + '_UNVERIFIED_TIMEOUT');
      }

      return { state: 'PENDING', currentAction: clone(current) };
    }

    tick() {
      this.metrics.ticks += 1;

      const observed = this._observeCurrent();
      if (observed.state !== 'IDLE') return observed;

      if (this.autonomyEnabled && this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.autonomyEnabled = false;
        this.metrics.sessionBudgetBlocks += 1;
        return { state: 'COMPLETE', reason: 'H19_SESSION_BUDGET_REACHED', actionsThisSession: this.actionsThisSession };
      }

      const plan = this.plan();
      if (plan.state !== 'READY' || !plan.request) return plan;

      const fromQueue = this.queue.length && String(this.queue[0].id) === String(plan.request.id);
      const result = this._dispatch(plan.request);
      if (fromQueue) {
        const ownsDispatchedRequest = !!(this.currentAction && String(this.currentAction.requestId) === String(plan.request.id));
        if (result.accepted || ownsDispatchedRequest) this.queue.shift();
      }
      return result;
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: this.suspended,
        suspendedReason: this.suspendedReason,
        currentAction: clone(this.currentAction),
        queue: clone(this.queue),
        queueLength: this.queue.length,
        actionsThisSession: this.actionsThisSession,
        policy: {
          desiredActiveNames: clone(this.policyState.desiredActiveNames),
          desiredRuntimeRunningNames: clone(this.policyState.desiredRuntimeRunningNames),
          desiredPartyMemberNames: clone(this.policyState.desiredPartyMemberNames),
          desiredPartyLeader: this.policyState.desiredPartyLeader,
          maxActionsPerSession: this.config.maxActionsPerSession
        },
        partySignals: clone(this.partySignals),
        config: clone(this.config),
        respawn: clone(this._respawnReadiness()),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.CharacterLifecycleController = CharacterLifecycleController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  const ROLE_CAPABILITIES = Object.freeze({
    warrior: ['TANK', 'DPS', 'MELEE'],
    priest: ['HEALER', 'HEAL', 'REVIVE', 'SUPPORT', 'DPS', 'RANGED'],
    ranger: ['DPS', 'RANGED'],
    mage: ['DPS', 'AOE', 'RANGED', 'SUPPORT'],
    rogue: ['DPS', 'MELEE'],
    paladin: ['TANK', 'HEAL', 'SUPPORT', 'DPS', 'MELEE'],
    merchant: ['ECONOMY', 'LOGISTICS']
  });

  const TASK_DEFAULTS = Object.freeze({
    FARM: { minMembers: 1, maxMembers: 2, required: ['DPS'], combatOnly: true, progressionWeight: 0.20 },
    QUEST: { minMembers: 1, maxMembers: 2, required: ['DPS'], combatOnly: true, progressionWeight: 0.16 },
    BOSS: { minMembers: 3, maxMembers: 4, required: ['TANK', 'HEALER', 'DPS'], combatOnly: true, progressionWeight: 0 },
    EVENT: { minMembers: 3, maxMembers: 4, required: ['TANK', 'HEALER', 'DPS'], combatOnly: true, progressionWeight: 0 },
    SPECIAL: { minMembers: 2, maxMembers: 4, required: ['HEALER', 'DPS'], combatOnly: true, progressionWeight: 0.04 },
    ECONOMY: { minMembers: 1, maxMembers: 1, required: ['ECONOMY'], combatOnly: false, progressionWeight: 0 }
  });

  function combinations(rows, minSize, maxSize) {
    const out = [];
    const limit = Math.min(rows.length, Math.max(minSize, maxSize));
    const visit = (start, picked) => {
      if (picked.length >= minSize && picked.length <= limit) out.push(picked.slice());
      if (picked.length >= limit) return;
      for (let index = start; index < rows.length; index += 1) {
        picked.push(rows[index]);
        visit(index + 1, picked);
        picked.pop();
      }
    };
    visit(0, []);
    return out;
  }

  class AccountStrategyController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.roster = options.roster || null;
      this.party = options.party || null;
      this.crossWindow = options.crossWindow || null;
      this.gear = options.gear || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.trainingMs = 0;
      this.lastTrainingTickMs = null;
      this.lastProfiles = [];
      this.lastProgression = null;
      this.lastTaskPlan = null;
      this.config = {
        targetCorridor: clamp(options.targetCorridor == null ? 0.08 : options.targetCorridor, 0, 0.5),
        maxProfileAgeMs: Math.max(1500, Math.min(30000, Number(options.maxProfileAgeMs) || 9000)),
        maxCandidates: Math.max(4, Math.min(12, Math.floor(Number(options.maxCandidates) || 8)))
      };
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      return this.status();
    }

    stop() {
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.lastTrainingTickMs = null;
      return this.status();
    }

    setCrossWindow(value) {
      this.crossWindow = value || null;
      return this.status();
    }

    recordTraining(active) {
      const now = this.now();
      if (this.lastTrainingTickMs == null) {
        this.lastTrainingTickMs = now;
        return this.trainingMs;
      }
      const delta = Math.max(0, Math.min(10000, now - this.lastTrainingTickMs));
      this.lastTrainingTickMs = now;
      if (active === true) this.trainingMs += delta;
      return this.trainingMs;
    }

    _localGearScore(character) {
      if (!character || !character.name || !this.game || !this.gear) return 0;
      let equipment = null;
      try { equipment = this.game.equipmentSnapshot(character.name); } catch (_) {}
      if (!equipment || equipment.available === false || !equipment.slots) return 0;
      let total = 0;
      for (const item of Object.values(equipment.slots)) {
        if (!item) continue;
        try {
          const value = Number(this.gear.score(item, character.ctype));
          if (Number.isFinite(value) && value > 0) total += value;
        } catch (_) {}
      }
      return Number(total.toFixed(4));
    }

    localProfile() {
      let snapshot = null;
      try { snapshot = this.game && this.game.snapshot ? this.game.snapshot() : null; } catch (_) {}
      const character = snapshot && snapshot.character;
      if (!character || !character.name) return null;
      const ctype = cleanText(character.ctype || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(character.name, 120),
        ctype,
        level: finite(character.level),
        hp: finite(character.hp),
        maxHp: finite(character.maxHp),
        mp: finite(character.mp),
        maxMp: finite(character.maxMp),
        attack: finite(character.attack),
        armor: finite(character.armor),
        resistance: finite(character.resistance),
        frequency: finite(character.frequency),
        speed: finite(character.speed),
        range: finite(character.range),
        rip: character.rip === true,
        map: cleanText(character.map || '', 120) || null,
        gearScore: this._localGearScore(character),
        trainingMs: Math.max(0, Math.floor(this.trainingMs)),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: this.now()
      };
    }

    _fallbackProfile(row) {
      if (!row || !row.name) return null;
      const ctype = cleanText(row.ctype || row.type || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(row.name, 120),
        ctype,
        level: finite(row.level),
        hp: null,
        maxHp: null,
        mp: null,
        maxMp: null,
        attack: null,
        armor: null,
        resistance: null,
        frequency: null,
        speed: null,
        range: null,
        rip: false,
        map: null,
        gearScore: 0,
        trainingMs: 0,
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: null,
        fallback: true,
        online: row.online === true
      };
    }

    profiles() {
      let roster = null;
      try { roster = this.roster && this.roster.refresh ? this.roster.refresh() : this.roster && this.roster.status ? this.roster.status() : null; } catch (_) {}
      const account = roster && Array.isArray(roster.accountCharacters) ? roster.accountCharacters : [];
      const online = new Set(roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String) : []);
      const byName = new Map();

      for (const row of account) {
        const fallback = this._fallbackProfile(row);
        if (fallback) byName.set(fallback.name, fallback);
      }

      let peers = [];
      try { peers = this.crossWindow && this.crossWindow.freshPeers ? this.crossWindow.freshPeers() : []; } catch (_) {}
      for (const peer of peers) {
        const raw = peer && peer.profile;
        if (!raw || !peer.name) continue;
        const profile = this._normalizeProfile({ ...raw, name: peer.name });
        if (!profile) continue;
        profile.running = peer.running === true;
        profile.emergencyStopLatched = peer.emergencyStopLatched === true;
        profile.sessionId = peer.sessionId || null;
        profile.peerFresh = true;
        profile.observedAtMs = finite(peer.observedAtMs) || profile.observedAtMs;
        byName.set(profile.name, profile);
      }

      const local = this.localProfile();
      if (local) {
        local.running = true;
        local.emergencyStopLatched = false;
        local.peerFresh = true;
        local.local = true;
        byName.set(local.name, local);
        online.add(local.name);
      }

      const rows = [...byName.values()].map(row => ({
        ...row,
        online: online.has(String(row.name)) || row.online === true
      })).sort((a, b) => a.name.localeCompare(b.name));
      this.lastProfiles = clone(rows);
      return clone(rows);
    }

    _normalizeProfile(raw) {
      if (!raw || !raw.name) return null;
      const ctype = cleanText(raw.ctype || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(raw.name, 120),
        ctype,
        level: finite(raw.level),
        hp: finite(raw.hp),
        maxHp: finite(raw.maxHp),
        mp: finite(raw.mp),
        maxMp: finite(raw.maxMp),
        attack: finite(raw.attack),
        armor: finite(raw.armor),
        resistance: finite(raw.resistance),
        frequency: finite(raw.frequency),
        speed: finite(raw.speed),
        range: finite(raw.range),
        rip: raw.rip === true,
        map: cleanText(raw.map || '', 120) || null,
        gearScore: Math.max(0, finite(raw.gearScore) || 0),
        trainingMs: Math.max(0, finite(raw.trainingMs) || 0),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: finite(raw.observedAtMs)
      };
    }

    _scoredProfiles() {
      const rows = this.profiles();
      const usable = rows.filter(row => row.online && row.rip !== true && row.emergencyStopLatched !== true);
      const maxLevel = Math.max(1, ...usable.map(row => finite(row.level) || 1));
      const maxGear = Math.max(1, ...usable.map(row => finite(row.gearScore) || 0));
      const combatRaw = row => {
        const dps = Math.max(0, finite(row.attack) || 0) * Math.max(0.1, finite(row.frequency) || 1);
        const toughness = Math.max(0, finite(row.maxHp) || 0) * 0.01
          + (Math.max(0, finite(row.armor) || 0) + Math.max(0, finite(row.resistance) || 0)) * 0.12;
        return dps + toughness + Math.max(0, finite(row.range) || 0) * 0.02 + Math.max(0, finite(row.speed) || 0) * 0.03;
      };
      const maxCombat = Math.max(1, ...usable.map(combatRaw));
      const totalTraining = usable.reduce((sum, row) => sum + Math.max(0, finite(row.trainingMs) || 0), 0);

      return rows.map(row => {
        const levelProgress = clamp((finite(row.level) || 1) / maxLevel);
        const gearProgress = clamp((finite(row.gearScore) || 0) / maxGear);
        const combatProgress = clamp(combatRaw(row) / maxCombat);
        const survival = row.maxHp && row.hp != null ? clamp(Number(row.hp) / Number(row.maxHp)) : 0.75;
        const strength = clamp(levelProgress * 0.42 + gearProgress * 0.23 + combatProgress * 0.27 + survival * 0.08);
        const trainingShare = totalTraining > 0 ? Math.max(0, finite(row.trainingMs) || 0) / totalTraining : 0;
        return {
          ...row,
          strength: Number(strength.toFixed(6)),
          levelProgress: Number(levelProgress.toFixed(6)),
          gearProgress: Number(gearProgress.toFixed(6)),
          combatProgress: Number(combatProgress.toFixed(6)),
          survival: Number(survival.toFixed(6)),
          trainingShare: Number(trainingShare.toFixed(6))
        };
      });
    }

    progressionPlan() {
      const combat = this._scoredProfiles().filter(row =>
        row.online
        && row.rip !== true
        && row.ctype !== 'merchant'
        && row.capabilities.includes('DPS')
      );
      const strongest = combat.length ? Math.max(...combat.map(row => row.strength)) : 0;
      const ranking = combat.map(row => {
        const gap = Math.max(0, strongest - row.strength - this.config.targetCorridor);
        const trainingDeficit = Math.max(0, 1 - row.trainingShare);
        const catchUp = clamp(gap * 0.72 + trainingDeficit * 0.28);
        return { name: row.name, strength: row.strength, gap, trainingShare: row.trainingShare, catchUp, ctype: row.ctype };
      }).sort((a, b) => b.catchUp - a.catchUp || a.strength - b.strength || a.name.localeCompare(b.name));
      const result = {
        schemaVersion: 1,
        targetCorridor: this.config.targetCorridor,
        strongest,
        selectedCharacterName: ranking[0] && ranking[0].catchUp > 0 ? ranking[0].name : null,
        ranking
      };
      this.lastProgression = clone(result);
      return result;
    }

    optimizeTask(input = {}) {
      const taskType = cleanText(input.type || input.taskType || 'FARM', 40).toUpperCase();
      const defaults = TASK_DEFAULTS[taskType] || TASK_DEFAULTS.FARM;
      const minMembers = Math.max(1, Math.min(4, Math.floor(Number(input.minMembers) || defaults.minMembers)));
      const maxMembers = Math.max(minMembers, Math.min(4, Math.floor(Number(input.maxMembers) || defaults.maxMembers)));
      const required = Array.isArray(input.requiredCapabilities) && input.requiredCapabilities.length
        ? [...new Set(input.requiredCapabilities.map(value => cleanText(value, 40).toUpperCase()).filter(Boolean))]
        : defaults.required.slice();
      const progression = this.progressionPlan();
      const scored = this._scoredProfiles()
        .filter(row => row.online && row.rip !== true && row.emergencyStopLatched !== true)
        .filter(row => !defaults.combatOnly || row.ctype !== 'merchant')
        .slice(0, this.config.maxCandidates);

      const groups = combinations(scored, minMembers, maxMembers);
      const ranking = [];
      for (const members of groups) {
        const capabilities = new Set(members.flatMap(member => member.capabilities || []));
        if (!required.every(capability => capabilities.has(capability))) continue;
        const memberNameSet = new Set(members.map(member => String(member.name)));
        const progressionRequired = (taskType === 'FARM' || taskType === 'QUEST')
          && progression.selectedCharacterName
          && scored.some(row => String(row.name) === String(progression.selectedCharacterName));
        if (progressionRequired && !memberNameSet.has(String(progression.selectedCharacterName))) continue;
        const memberNames = members.map(member => member.name).sort();
        const baseStrength = members.reduce((sum, member) => sum + member.strength, 0);
        const roleDiversity = capabilities.size / 10;
        const containsProgression = progression.selectedCharacterName
          ? memberNames.includes(progression.selectedCharacterName)
          : false;
        const progressionBonus = containsProgression ? defaults.progressionWeight : 0;
        const score = baseStrength + roleDiversity + progressionBonus;
        ranking.push({
          taskType,
          memberNames,
          score: Number(score.toFixed(6)),
          baseStrength: Number(baseStrength.toFixed(6)),
          progressionBonus,
          capabilities: [...capabilities].sort(),
          members: clone(members)
        });
      }

      ranking.sort((a, b) => b.score - a.score
        || b.baseStrength - a.baseStrength
        || a.memberNames.join(',').localeCompare(b.memberNames.join(',')));
      const selected = ranking[0] || null;
      let leaderName = null;
      if (selected) {
        const tank = selected.members.filter(row => row.capabilities.includes('TANK')).sort((a,b) => b.strength - a.strength)[0];
        const healer = selected.members.filter(row => row.capabilities.includes('HEALER')).sort((a,b) => b.strength - a.strength)[0];
        const strongest = selected.members.slice().sort((a,b) => b.strength - a.strength)[0];
        leaderName = tank && tank.name || healer && healer.name || strongest && strongest.name || null;
      }
      const supportMemberNames = this._scoredProfiles()
        .filter(row => row.online && row.rip !== true && row.ctype === 'merchant')
        .map(row => row.name)
        .sort();
      const result = {
        schemaVersion: 1,
        taskType,
        requiredCapabilities: required,
        status: selected ? 'SELECTION_READY' : 'NO_ALLOWED_COMBINATION',
        selected: selected ? {
          memberNames: selected.memberNames,
          score: selected.score,
          baseStrength: selected.baseStrength,
          progressionBonus: selected.progressionBonus,
          capabilities: selected.capabilities
        } : null,
        leaderName,
        supportMemberNames,
        progression,
        ranking: ranking.slice(0, 16).map(row => ({
          memberNames: row.memberNames,
          score: row.score,
          baseStrength: row.baseStrength,
          progressionBonus: row.progressionBonus,
          capabilities: row.capabilities
        }))
      };
      this.lastTaskPlan = clone(result);
      return result;
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        localTrainingMs: Math.max(0, Math.floor(this.trainingMs)),
        profiles: clone(this.lastProfiles),
        progression: clone(this.lastProgression),
        taskPlan: clone(this.lastTaskPlan),
        config: clone(this.config)
      };
    }
  }

  ns.AccountStrategyController = AccountStrategyController;
  ns.ACCOUNT_ROLE_CAPABILITIES = ROLE_CAPABILITIES;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  class FullAutonomyController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.runtime = options.runtime || null;
      this.strategy = options.strategy || null;
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.enabled = false;
      this.startedAt = null;
      this.lastPlan = null;
      this.lastDecision = null;
      this.lastError = null;
      this.started = {
        lifecycle: false,
        farming: false,
        economy: false,
        partyLogistics: false
      };
      this.config = {
        taskType: 'FARM',
        keepSupportInParty: true,
        requireAllOnlineProfiles: true,
        logisticsProbeMs: 30000,
        lifecycleMaxActions: 20,
        economyMaxActions: 100,
        logisticsMaxActions: 10,
        expectedOnlineCount: 4
      };
      this.lastLogisticsProbeAtMs = 0;
      this.desiredCharacterNames = [];
      this.tickResourceId = null;
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      this.tickResourceId = null;
      return this.status();
    }

    stop(reason = 'FULL_AUTONOMY_MODULE_STOP') {
      this.stopAutonomy(reason);
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    configure(options = {}) {
      if (options.taskType != null) this.config.taskType = cleanText(options.taskType, 40).toUpperCase() || 'FARM';
      if (options.keepSupportInParty != null) this.config.keepSupportInParty = options.keepSupportInParty === true;
      if (options.requireAllOnlineProfiles != null) this.config.requireAllOnlineProfiles = options.requireAllOnlineProfiles === true;
      if (options.logisticsProbeMs != null) {
        this.config.logisticsProbeMs = Math.max(5000, Math.min(300000, Math.floor(Number(options.logisticsProbeMs) || 30000)));
      }
      if (options.expectedOnlineCount != null) {
        this.config.expectedOnlineCount = Math.max(1, Math.min(4, Math.floor(Number(options.expectedOnlineCount) || 4)));
      }
      return clone(this.config);
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'FULL_AUTONOMY_MODULE_NOT_ACTIVE', status: this.status() };
      if (!this.runtime || !this.runtime.running) return { accepted: false, reason: 'FULL_AUTONOMY_RUNTIME_NOT_RUNNING', status: this.status() };
      if (this.runtime.stopLatch && this.runtime.stopLatch.status().latched) {
        return { accepted: false, reason: 'FULL_AUTONOMY_EMERGENCY_STOP_LATCHED', status: this.status() };
      }
      this.configure(options);
      const initialOnline = this._onlineNames();
      if (initialOnline.length !== this.config.expectedOnlineCount) {
        return {
          accepted: false,
          reason: 'FULL_AUTONOMY_EXPECTED_ONLINE_COUNT_MISMATCH',
          expectedOnlineCount: this.config.expectedOnlineCount,
          onlineCharacterNames: initialOnline,
          status: this.status()
        };
      }
      this.desiredCharacterNames = initialOnline.slice().sort();
      this.enabled = true;
      this.startedAt = new Date().toISOString();
      this.lastError = null;
      if (this.scope && typeof this.scope.interval === 'function' && !this.tickResourceId) {
        this.tickResourceId = this.scope.interval('full-autonomy-loop', () => this.tick(), 1000, { immediate: false });
      }
      this.lastDecision = { at: this.startedAt, type: 'START', taskType: this.config.taskType };
      const tick = this.tick();
      return { accepted: true, tick, status: this.status() };
    }

    stopAutonomy(reason = 'FULL_AUTONOMY_STOP') {
      const runtime = this.runtime;
      if (runtime) {
        if (this.started.farming) {
          try { runtime.farmIntelligence.stopAutonomy(reason); } catch (_) {}
        }
        if (this.started.economy) {
          try { runtime.economy.stopAutonomy(reason); } catch (_) {}
        }
        if (this.started.partyLogistics) {
          try { runtime.partyLogistics.stopAutonomy(reason); } catch (_) {}
        }
        if (this.started.lifecycle) {
          try { runtime.lifecycle.stopAutonomy(reason); } catch (_) {}
        }
      }
      if (this.tickResourceId && this.scope && typeof this.scope.cancel === 'function') {
        try { this.scope.cancel(this.tickResourceId, reason); } catch (_) {}
      }
      this.tickResourceId = null;
      this.enabled = false;
      this.desiredCharacterNames = [];
      this.started = { lifecycle: false, farming: false, economy: false, partyLogistics: false };
      this.lastDecision = { at: new Date().toISOString(), type: 'STOP', reason: cleanText(reason, 200) };
      return this.status();
    }

    _local() {
      try {
        const snap = this.runtime && this.runtime.game && this.runtime.game.snapshot ? this.runtime.game.snapshot() : null;
        return snap && snap.character || null;
      } catch (_) {
        return null;
      }
    }

    _onlineNames() {
      try {
        const roster = this.runtime && this.runtime.roster && this.runtime.roster.refresh ? this.runtime.roster.refresh() : null;
        return roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String).sort() : [];
      } catch (_) {
        return [];
      }
    }

    _profileReadiness() {
      const profiles = this.strategy ? this.strategy.profiles() : [];
      const local = this._local();
      const online = this._onlineNames();
      const ready = new Set(profiles.filter(row => row && row.online && (row.local || row.peerFresh)).map(row => String(row.name)));
      if (local && local.name) ready.add(String(local.name));
      const missing = this.config.requireAllOnlineProfiles ? online.filter(name => !ready.has(name)) : [];
      return {
        profiles,
        online,
        missing,
        readyNames: [...ready].sort(),
        onlineLimitExceeded: online.length > 4
      };
    }

    _ensureLifecycle(plan, readiness) {
      const lifecycle = this.runtime.lifecycle;
      const status = lifecycle.status();
      if (status.suspended || status.currentAction && status.currentAction.unknownRecorded === true) {
        return { ok: false, reason: status.suspendedReason || 'H19_SUSPENDED' };
      }

      const local = this._local();
      if (!local || !local.name) return { ok: false, reason: 'CHARACTER_UNAVAILABLE' };
      const localName = String(local.name);
      const selected = plan && plan.selected ? plan.selected.memberNames.slice() : [];
      const support = this.config.keepSupportInParty ? (plan.supportMemberNames || []) : [];
      const stableDesired = this.desiredCharacterNames.length
        ? this.desiredCharacterNames.slice()
        : readiness.online.slice();
      const desiredPartyAll = [...new Set([...selected, ...support])]
        .filter(name => stableDesired.includes(String(name)))
        .slice(0, 4)
        .sort();
      const leader = plan.leaderName && desiredPartyAll.includes(plan.leaderName)
        ? plan.leaderName
        : (desiredPartyAll[0] || null);
      if (!leader) return { ok: false, reason: 'FULL_AUTONOMY_PARTY_LEADER_UNAVAILABLE' };

      const coordinator = localName === String(leader);
      const onlineSet = new Set(readiness.online.map(String));
      const desiredActiveNames = coordinator
        ? stableDesired.slice().sort()
        : stableDesired.filter(name => onlineSet.has(String(name))).sort();
      const desiredPartyMembers = desiredPartyAll
        .filter(name => coordinator || onlineSet.has(String(name)))
        .sort();
      if (!desiredPartyMembers.includes(localName) && onlineSet.has(localName) && this.config.keepSupportInParty) {
        if (desiredPartyMembers.length < 4) desiredPartyMembers.push(localName);
      }
      desiredPartyMembers.sort();

      const desiredRuntimeRunningNames = coordinator
        ? readiness.profiles
          .filter(row => row && row.peerFresh && !row.local && stableDesired.includes(String(row.name)))
          .map(row => row.name)
          .sort()
        : [];

      const effectiveLeader = desiredPartyMembers.includes(leader)
        ? leader
        : (desiredPartyMembers[0] || null);
      const policy = lifecycle.setPolicy({
        desiredActiveNames,
        desiredRuntimeRunningNames,
        desiredPartyMemberNames: desiredPartyMembers,
        desiredPartyLeader: effectiveLeader,
        maxActionsPerSession: this.config.lifecycleMaxActions
      });
      if (!policy || policy.accepted !== true) {
        return { ok: false, reason: policy && policy.reason || 'FULL_AUTONOMY_LIFECYCLE_POLICY_REJECTED' };
      }

      let party = null;
      try { party = this.runtime.party && this.runtime.party.snapshot ? this.runtime.party.snapshot() : null; } catch (_) {}
      const memberNames = new Set(party && Array.isArray(party.memberNames) ? party.memberNames.map(String) : []);
      const localPartyHealthy = memberNames.has(localName)
        && effectiveLeader
        && String(party && party.leader || '') === String(effectiveLeader);
      const shouldRunLifecycle = coordinator || !localPartyHealthy;

      const current = lifecycle.status();
      if (shouldRunLifecycle && this.started.lifecycle && current.autonomyEnabled !== true) {
        return {
          ok: false,
          reason: 'FULL_AUTONOMY_LIFECYCLE_STOP_REQUIRES_EXPLICIT_RESTART',
          lifecycleLastAction: clone(current.lastAction),
          actionsThisSession: Number(current.actionsThisSession || 0)
        };
      }
      if (shouldRunLifecycle && current.autonomyEnabled !== true) {
        const started = lifecycle.startAutonomy({ maxActions: this.config.lifecycleMaxActions });
        if (!started || started.accepted !== true) {
          return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_LIFECYCLE_START_REJECTED' };
        }
        this.started.lifecycle = true;
      } else if (!shouldRunLifecycle && this.started.lifecycle && current.autonomyEnabled === true) {
        try { lifecycle.stopAutonomy('FULL_AUTONOMY_PARTY_HEALTHY_NON_COORDINATOR'); } catch (_) {}
        this.started.lifecycle = false;
      }

      return {
        ok: true,
        coordinator,
        coordinatorName: leader,
        desiredActiveNames,
        desiredRuntimeRunningNames,
        partyNames: desiredPartyMembers,
        leader: effectiveLeader
      };
    }

    _ensureCombatRole(plan) {
      const local = this._local();
      if (!local || !local.name) return { ok: false, reason: 'CHARACTER_UNAVAILABLE' };
      const localName = String(local.name);
      const ctype = String(local.ctype || '').toLowerCase();
      const selected = new Set(plan && plan.selected ? plan.selected.memberNames : []);
      const shouldFarm = ctype !== 'merchant' && selected.has(localName);
      const status = this.runtime.farmIntelligence.status();

      if (shouldFarm) {
        if (!status.active) {
          const started = this.runtime.farmIntelligence.startAutonomy({
            owner: 'full-autonomy',
            allowTravel: true
          });
          if (started && started.accepted === true) this.started.farming = true;
          else if (!started || !String(started.reason || '').includes('ALREADY')) {
            return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_FARM_START_REJECTED' };
          }
        }
      } else if (this.started.farming && status.active) {
        try { this.runtime.farmIntelligence.stopAutonomy('FULL_AUTONOMY_NOT_SELECTED'); } catch (_) {}
        this.started.farming = false;
      }
      return { ok: true, shouldFarm, selected: [...selected].sort() };
    }

    _merchantArbitration() {
      const local = this._local();
      if (!local || String(local.ctype || '').toLowerCase() !== 'merchant') return { ok: true, merchant: false };
      const economy = this.runtime.economy;
      const logistics = this.runtime.partyLogistics;
      const economyStatus = economy.status();
      const logisticsStatus = logistics.status();
      if (economyStatus.suspendedReason || logisticsStatus.suspendedReason) {
        return {
          ok: false,
          reason: economyStatus.suspendedReason || logisticsStatus.suspendedReason || 'FULL_AUTONOMY_MERCHANT_SUSPENDED'
        };
      }

      const now = Date.now();
      const logisticsActive = logisticsStatus.autonomyEnabled === true;
      if (logisticsActive) {
        const plan = logistics.plan();
        if (!logisticsStatus.currentAction && (!plan || plan.state !== 'READY')) {
          if (this.started.partyLogistics) {
            try { logistics.stopAutonomy('FULL_AUTONOMY_LOGISTICS_IDLE'); } catch (_) {}
            this.started.partyLogistics = false;
          }
        } else {
          return { ok: true, merchant: true, owner: 'party-logistics', plan: clone(plan) };
        }
      }

      const economyNow = economy.status();
      if (now - this.lastLogisticsProbeAtMs >= this.config.logisticsProbeMs && !economyNow.currentAction) {
        this.lastLogisticsProbeAtMs = now;
        const wasEconomyOwned = this.started.economy && economyNow.autonomyEnabled === true;
        if (wasEconomyOwned) {
          try { economy.stopAutonomy('FULL_AUTONOMY_LOGISTICS_PROBE'); } catch (_) {}
          this.started.economy = false;
        }
        let logisticsPlan = null;
        try { logisticsPlan = logistics.plan(); } catch (_) {}
        if (logisticsPlan && logisticsPlan.state === 'READY') {
          const started = logistics.startAutonomy({ maxActions: this.config.logisticsMaxActions });
          if (started && started.accepted === true) {
            this.started.partyLogistics = true;
            return { ok: true, merchant: true, owner: 'party-logistics', plan: clone(logisticsPlan) };
          }
        }
      }

      const currentEconomy = economy.status();
      const currentLogistics = logistics.status();
      if (!currentLogistics.autonomyEnabled && !currentLogistics.currentAction && !currentEconomy.autonomyEnabled) {
        const started = economy.startAutonomy({ maxActions: this.config.economyMaxActions });
        if (started && started.accepted === true) this.started.economy = true;
        else if (!started || !String(started.reason || '').includes('ALREADY')) {
          return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_ECONOMY_START_REJECTED' };
        }
      }
      return { ok: true, merchant: true, owner: this.runtime.economy.status().autonomyEnabled ? 'economy' : 'idle' };
    }

    tick() {
      if (this.heartbeat) {
        try { this.heartbeat({ phase: 'full-autonomy', enabled: this.enabled, taskType: this.config.taskType }); } catch (_) {}
      }
      if (!this.moduleActive || !this.enabled) return { state: 'IDLE', reason: 'FULL_AUTONOMY_DISABLED' };
      if (!this.runtime || !this.runtime.actionAllowed('full-autonomy')) {
        return { state: 'BLOCKED', reason: 'FULL_AUTONOMY_RUNTIME_ACTION_BLOCKED' };
      }

      try {
        const readiness = this._profileReadiness();
        const local = this._local();
        if (!local) return { state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE' };
        if (readiness.onlineLimitExceeded) {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'BLOCKED',
            reason: 'FULL_AUTONOMY_ONLINE_CHARACTER_LIMIT_EXCEEDED',
            onlineCharacterNames: readiness.online
          };
        }
        if (readiness.missing.length) {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'WARMING',
            reason: 'FULL_AUTONOMY_WAITING_FOR_FRESH_PEERS',
            missingProfiles: readiness.missing
          };
        }

        const plan = this.strategy.optimizeTask({ type: this.config.taskType });
        this.lastPlan = clone(plan);
        if (!plan || plan.status !== 'SELECTION_READY') {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'BLOCKED',
            reason: 'FULL_AUTONOMY_NO_ALLOWED_TASK_PARTY',
            plan: clone(plan)
          };
        }

        const lifecycle = this._ensureLifecycle(plan, readiness);
        if (!lifecycle.ok) {
          this.strategy.recordTraining(false);
          return this.lastDecision = { at: new Date().toISOString(), state: 'BLOCKED', reason: lifecycle.reason };
        }

        const combat = this._ensureCombatRole(plan);
        if (!combat.ok) {
          this.strategy.recordTraining(false);
          return this.lastDecision = { at: new Date().toISOString(), state: 'BLOCKED', reason: combat.reason };
        }

        const merchant = this._merchantArbitration();
        if (!merchant.ok) {
          this.strategy.recordTraining(false);
          return this.lastDecision = { at: new Date().toISOString(), state: 'BLOCKED', reason: merchant.reason };
        }

        const localSelected = plan.selected.memberNames.includes(String(local.name));
        this.strategy.recordTraining(localSelected || String(local.ctype || '').toLowerCase() === 'merchant');
        try {
          if (this.runtime.lifecycleTransport && typeof this.runtime.lifecycleTransport.broadcastHeartbeat === 'function') {
            this.runtime.lifecycleTransport.broadcastHeartbeat();
          }
        } catch (_) {}

        return this.lastDecision = {
          at: new Date().toISOString(),
          state: 'RUNNING',
          reason: 'FULL_AUTONOMY_ROLE_PLAN_ACTIVE',
          local: local.name,
          localRole: String(local.ctype || '').toLowerCase() === 'merchant'
            ? merchant.owner
            : (combat.shouldFarm ? 'combat-farm' : 'standby'),
          taskType: plan.taskType,
          executionMembers: plan.selected.memberNames,
          supportMembers: plan.supportMemberNames,
          desiredParty: lifecycle.partyNames,
          leader: lifecycle.leader,
          lifecycleCoordinator: lifecycle.coordinatorName,
          localLifecycleCoordinator: lifecycle.coordinator === true,
          missingDesiredCharacters: this.desiredCharacterNames.filter(name => !readiness.online.includes(name)),
          progressionTarget: plan.progression && plan.progression.selectedCharacterName || null
        };
      } catch (error) {
        this.lastError = {
          at: new Date().toISOString(),
          reason: cleanText(error && error.message || error, 300)
        };
        if (this.logger) this.logger.error('Full Autonomy tick fehlgeschlagen', this.lastError);
        return this.lastDecision = { at: this.lastError.at, state: 'ERROR', reason: this.lastError.reason };
      }
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        enabled: this.enabled,
        startedAt: this.startedAt,
        config: clone(this.config),
        startedControllers: clone(this.started),
        desiredCharacterNames: clone(this.desiredCharacterNames),
        tickScheduled: !!this.tickResourceId,
        lastPlan: clone(this.lastPlan),
        lastDecision: clone(this.lastDecision),
        lastError: clone(this.lastError)
      };
    }
  }

  ns.FullAutonomyController = FullAutonomyController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const AOE_SKILLS = Object.freeze({
    warrior: Object.freeze(['cleave', 'stomp']),
    ranger: Object.freeze(['5shot', '3shot']),
    mage: Object.freeze(['cburst']),
    rogue: Object.freeze(['fanofknives']),
    priest: Object.freeze([]),
    paladin: Object.freeze([]),
    merchant: Object.freeze([])
  });

  const CLASS_PACK_CAP = Object.freeze({
    warrior: 3,
    ranger: 5,
    mage: 3,
    rogue: 5,
    priest: 1,
    paladin: 1,
    merchant: 0
  });

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function ratio(value, max) {
    const current = finite(value);
    const total = finite(max);
    if (current == null || total == null || total <= 0) return null;
    return Math.max(0, Math.min(1, current / total));
  }

  function errorReason(value, fallback = 'H8_AOE_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 240);
    }
    const text = cleanText(value, 240);
    return text || fallback;
  }

  class AdaptiveFarmingController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.combat = options.combat;
      this.party = options.party || null;
      this.classSkills = options.classSkills || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.config = {
        minGlobalIntervalMs: Math.max(200, Math.min(2000, Number(options.minGlobalIntervalMs) || 450)),
        rejectionBackoffMs: Math.max(1000, Math.min(30000, Number(options.rejectionBackoffMs) || 4000)),
        aoeHpRatio: Math.max(0.55, Math.min(0.95, Number(options.aoeHpRatio) || 0.72)),
        pullHpRatio: Math.max(0.65, Math.min(0.98, Number(options.pullHpRatio) || 0.82)),
        retreatHpRatio: Math.max(0.20, Math.min(0.65, Number(options.retreatHpRatio) || 0.38)),
        maxAggregateAttackToHpRatio: Math.max(0.08, Math.min(0.50, Number(options.maxAggregateAttackToHpRatio) || 0.22)),
        maxAcquireDistance: Math.max(80, Math.min(700, Number(options.maxAcquireDistance) || 320)),
        cburstReserveMp: Math.max(100, Math.min(1000, Number(options.cburstReserveMp) || 200)),
        cburstMaxPerTargetMp: Math.max(25, Math.min(500, Number(options.cburstMaxPerTargetMp) || 120))
      };

      this.moduleActive = false;
      this.heartbeat = null;
      this.session = null;
      this.sequence = 0;
      this.pending = null;
      this.pendingGeneration = 0;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.backoffUntilMs = 0;
      this.lastAttemptAtMs = 0;
      this.lastPlan = null;
      this.lastUse = null;
      this.metrics = {
        sessions: 0,
        plans: 0,
        packsPlanned: 0,
        singleTargetPlans: 0,
        retreatPlans: 0,
        foreignPartyBlocks: 0,
        unsafeZoneBlocks: 0,
        aoeDispatched: 0,
        aoeConfirmed: 0,
        aoeRejected: 0,
        aoeUnknown: 0,
        maxPackObserved: 0
      };
    }

    start(context) {
      this.moduleActive = true;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      return this.status();
    }

    stop(reason = 'H8_MODULE_STOP') {
      this.moduleActive = false;
      this.heartbeat = null;
      this.stopSession(reason);
      return this.status();
    }

    _combatStatus() {
      return this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
    }

    startSession(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H8_MODULE_NOT_ACTIVE', status: this.status() };
      if (this.session && this.session.enabled) return { accepted: false, reason: 'H8_SESSION_ALREADY_ACTIVE', status: this.status() };

      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) return { accepted: false, reason: 'CHARACTER_UNAVAILABLE', status: this.status() };
      if (character.rip === true) return { accepted: false, reason: 'CHARACTER_DEAD', status: this.status() };
      const ctype = String(character.ctype || '').toLowerCase();
      if (ctype === 'merchant') return { accepted: false, reason: 'H8_UNSUPPORTED_CLASS:merchant', status: this.status() };

      const existing = this._combatStatus();
      if (existing && existing.active) {
        return { accepted: false, reason: 'H8_COMBAT_ALREADY_OWNED', combat: existing, status: this.status() };
      }

      const combatStart = this.combat.startSession({
        owner: 'farming-h8',
        monsterType: options.monsterType || null,
        partyAssist: options.partyAssist !== false,
        kiting: true,
        allowContested: false,
        allowUnknownAttack: false,
        maxAcquireDistance: Number(options.maxAcquireDistance) || this.config.maxAcquireDistance,
        maxAttackToHpRatio: options.maxAttackToHpRatio == null ? 0.08 : Number(options.maxAttackToHpRatio),
        retreatHpRatio: options.retreatHpRatio == null ? this.config.retreatHpRatio : Number(options.retreatHpRatio),
        resumeHpRatio: options.resumeHpRatio == null ? 0.68 : Number(options.resumeHpRatio),
        minMpRatio: options.minMpRatio == null ? 0.08 : Number(options.minMpRatio)
      });
      if (!combatStart || combatStart.accepted !== true || !combatStart.session) {
        return { accepted: false, reason: combatStart && combatStart.reason || 'H8_COMBAT_START_FAILED', combat: combatStart || null, status: this.status() };
      }

      const id = 'farm-' + (++this.sequence);
      this.session = {
        id,
        enabled: true,
        owner: cleanText(options.owner || 'adaptive-farming', 80) || 'adaptive-farming',
        combatSessionId: combatStart.session.id,
        monsterType: options.monsterType || null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        reason: null
      };
      this.pendingGeneration += 1;
      this.pending = null;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.backoffUntilMs = 0;
      this.metrics.sessions += 1;
      return { accepted: true, session: clone(this.session), combat: combatStart };
    }

    stopSession(reason = 'H8_SESSION_STOP') {
      const session = this.session;
      this.pendingGeneration += 1;
      this.pending = null;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.backoffUntilMs = 0;

      if (!session) return { stopped: false, reason: 'NO_H8_SESSION' };

      session.enabled = false;
      session.reason = cleanText(reason, 240);
      session.stoppedAt = new Date().toISOString();

      const combat = this._combatStatus();
      if (combat && combat.active && combat.session
        && String(combat.session.id) === String(session.combatSessionId)
        && String(combat.session.owner || '') === 'farming-h8') {
        try { this.combat.stopSession(reason); } catch (_) {}
      }

      const ended = clone(session);
      this.session = null;
      return { stopped: true, session: ended };
    }

    onCombatEnded(combatSessionId, reason = 'COMBAT_ENDED') {
      if (!this.session || String(this.session.combatSessionId) !== String(combatSessionId)) return false;
      this.pendingGeneration += 1;
      this.pending = null;
      this.session.enabled = false;
      this.session.reason = cleanText(reason, 240);
      this.session.stoppedAt = new Date().toISOString();
      this.session = null;
      return true;
    }

    supportedAoeSkills(ctype) {
      const key = cleanText(ctype || '', 60).toLowerCase();
      return (AOE_SKILLS[key] || []).slice();
    }

    liveAoeSkills(ctype) {
      return this.supportedAoeSkills(ctype).map(id => ({
        id,
        definition: this.game && typeof this.game.skillDefinition === 'function' ? this.game.skillDefinition(id) : null
      }));
    }

    _ownedPartyNames(characterName) {
      const names = new Set();
      if (characterName) names.add(String(characterName));
      if (!this.party || typeof this.party.status !== 'function') return names;
      const state = this.party.status();
      const snapshot = state && state.party;
      for (const name of snapshot && snapshot.ownedMemberNames || []) names.add(String(name));
      return names;
    }

    _partyGate() {
      if (!this.party || typeof this.party.status !== 'function') return { allowed: true, foreign: [] };
      const state = this.party.status();
      const snapshot = state && state.party;
      const foreign = snapshot && Array.isArray(snapshot.foreignMemberNames) ? snapshot.foreignMemberNames.slice() : [];
      if (foreign.length) return { allowed: false, reason: 'H8_FOREIGN_PARTY_BLOCK', foreign };
      return { allowed: true, foreign: [] };
    }

    _capacity(character, hpRatio) {
      const ctype = String(character && character.ctype || '').toLowerCase();
      let cap = Number(CLASS_PACK_CAP[ctype] || 1);
      if (hpRatio == null || hpRatio < this.config.pullHpRatio) cap = Math.min(cap, 1);
      return Math.max(0, cap);
    }

    _effectiveSkillRange(definition, character) {
      const direct = finite(definition && definition.range);
      if (direct != null) return direct;
      const base = Math.max(1, finite(character && character.range) || 40);
      const multiplier = finite(definition && definition.rangeMultiplier);
      const bonus = finite(definition && definition.rangeBonus);
      return base * (multiplier == null ? 1 : multiplier) + (bonus == null ? 0 : bonus);
    }

    _allVisibleWithin(range) {
      if (!this.game || typeof this.game.visibleMonsters !== 'function') return [];
      return this.game.visibleMonsters().filter(monster => monster && monster.distance != null && monster.distance <= range);
    }

    _skillReady(id) {
      return this.game && typeof this.game.skillReadiness === 'function'
        ? this.game.skillReadiness(id, null)
        : null;
    }

    _untargetedZoneSafe(skillId, definition, character, pack, safeIds, capacity) {
      const range = this._effectiveSkillRange(definition, character);
      const zone = this._allVisibleWithin(range);
      if (!zone.length) return false;
      if (zone.length > capacity) return false;
      const type = pack[0] && pack[0].mtype || null;
      for (const monster of zone) {
        if (!safeIds.has(String(monster.id))) return false;
        if (type && monster.mtype && String(monster.mtype) !== String(type)) return false;
      }
      return pack.every(monster => monster.distance != null && monster.distance <= range);
    }

    _targetsInSkillRange(pack, definition, character) {
      const range = this._effectiveSkillRange(definition, character);
      return pack.filter(monster => monster.distance != null && monster.distance <= range);
    }

    _decisionForSkill(skillId, character, pack, safeIds, capacity) {
      const definition = this.game.skillDefinition(skillId);
      if (!definition) return null;
      const readiness = this._skillReady(skillId);
      if (!readiness || readiness.allowed !== true) return null;

      if (skillId === 'cleave' || skillId === 'stomp') {
        if (pack.length < 3) return null;
        if (!this._untargetedZoneSafe(skillId, definition, character, pack, safeIds, capacity)) {
          this.metrics.unsafeZoneBlocks += 1;
          return null;
        }
        return {
          skillId,
          targetIds: pack.map(row => String(row.id)),
          args: [skillId],
          reason: skillId === 'cleave' ? 'H8_SAFE_CLEAVE_PACK' : 'H8_SAFE_STOMP_PACK',
          packSize: pack.length,
          readiness
        };
      }

      if (skillId === '5shot' || skillId === '3shot' || skillId === 'fanofknives') {
        const minimum = skillId === '5shot' ? 4 : (skillId === 'fanofknives' ? 3 : 2);
        const hardCap = skillId === '5shot' ? 5 : (skillId === '3shot' ? 3 : (finite(definition.maxTargets) || 5));
        const targets = this._targetsInSkillRange(pack, definition, character).slice(0, Math.min(capacity, hardCap));
        if (targets.length < minimum) return null;
        return {
          skillId,
          targetIds: targets.map(row => String(row.id)),
          args: [skillId, targets.map(row => String(row.id))],
          reason: 'H8_SAFE_MULTI_TARGET_' + skillId.toUpperCase(),
          packSize: targets.length,
          readiness
        };
      }

      if (skillId === 'cburst') {
        const targets = this._targetsInSkillRange(pack, definition, character).slice(0, Math.min(capacity, 3));
        if (targets.length < 2) return null;
        const currentMp = finite(character.mp);
        const maxMp = finite(character.maxMp);
        if (currentMp == null || maxMp == null) return null;
        const reserve = Math.max(this.config.cburstReserveMp, Math.ceil(maxMp * 0.30));
        const usable = Math.max(0, currentMp - reserve);
        const perTarget = Math.floor(Math.min(this.config.cburstMaxPerTargetMp, usable / targets.length));
        if (perTarget < 25) return null;
        const pairs = targets.map(row => [String(row.id), perTarget]);
        return {
          skillId,
          targetIds: targets.map(row => String(row.id)),
          args: ['cburst', pairs],
          reason: 'H8_SAFE_CBURST_PACK',
          packSize: targets.length,
          mpPerTarget: perTarget,
          readiness
        };
      }

      return null;
    }

    _chooseAoe(character, pack, safeCandidates, capacity) {
      const ctype = String(character && character.ctype || '').toLowerCase();
      if (!pack || pack.length < 2) return null;
      const safeIds = new Set((safeCandidates || []).map(row => String(row.id)));
      for (const skillId of this.supportedAoeSkills(ctype)) {
        const decision = this._decisionForSkill(skillId, character, pack, safeIds, capacity);
        if (decision) return decision;
      }
      return null;
    }

    plan() {
      this.metrics.plans += 1;
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) {
        return this._rememberPlan({ state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE', pack: [] });
      }

      const ctype = String(character.ctype || '').toLowerCase();
      if (ctype === 'merchant') {
        return this._rememberPlan({ state: 'OBSERVER_ONLY', reason: 'LOGISTICS_ROLE_NO_COMBAT', pack: [], capacity: 0 });
      }

      const partyGate = this._partyGate();
      if (!partyGate.allowed) {
        this.metrics.foreignPartyBlocks += 1;
        return this._rememberPlan({ state: 'BLOCKED', reason: partyGate.reason, foreign: partyGate.foreign, pack: [] });
      }

      const hpRatio = ratio(character.hp, character.maxHp);
      if (hpRatio != null && hpRatio <= this.config.retreatHpRatio) {
        this.metrics.retreatPlans += 1;
        return this._rememberPlan({ state: 'RETREAT', reason: 'H8_LOW_HP', hpRatio, pack: [], capacity: 0 });
      }

      const combat = this._combatStatus();
      const policy = combat && combat.session && combat.session.policy || {};
      const safe = this.combat && typeof this.combat.safeCandidates === 'function'
        ? this.combat.safeCandidates({ ...policy, maxAcquireDistance: this.config.maxAcquireDistance, allowContested: false, allowUnknownAttack: false })
        : [];
      if (!safe.length) {
        this.metrics.singleTargetPlans += 1;
        return this._rememberPlan({ state: 'NO_TARGET', reason: 'NO_H5_SAFE_CANDIDATES', hpRatio, pack: [], capacity: 0 });
      }

      const owned = this._ownedPartyNames(character.name);
      const engaged = safe.filter(monster => monster.targetId && owned.has(String(monster.targetId)));
      let primary = null;
      const targetId = combat && combat.session && combat.session.targetId;
      if (targetId != null) primary = safe.find(row => String(row.id) === String(targetId)) || null;
      if (!primary && this.party && typeof this.party.preferredTargetId === 'function') {
        const focus = this.party.preferredTargetId();
        if (focus != null) primary = safe.find(row => String(row.id) === String(focus)) || null;
      }
      if (!primary) primary = engaged[0] || safe[0];

      const sameType = safe.filter(row => !primary.mtype || !row.mtype || String(row.mtype) === String(primary.mtype));
      const capacity = this._capacity(character, hpRatio);
      const maxAggregateAttack = Math.max(1, Number(character.maxHp || 0) * this.config.maxAggregateAttackToHpRatio);
      const ordered = [
        ...sameType.filter(row => row.targetId && owned.has(String(row.targetId))),
        ...sameType.filter(row => !(row.targetId && owned.has(String(row.targetId))))
      ].filter((row, index, array) => array.findIndex(other => String(other.id) === String(row.id)) === index);

      const pack = [];
      let aggregateAttack = 0;
      for (const monster of ordered) {
        if (pack.length >= capacity) break;
        const attack = finite(monster.attack);
        if (attack == null) continue;
        if (aggregateAttack + attack > maxAggregateAttack) continue;
        pack.push(monster);
        aggregateAttack += attack;
      }
      if (!pack.some(row => String(row.id) === String(primary.id)) && capacity > 0) {
        const attack = finite(primary.attack);
        if (attack != null && attack <= maxAggregateAttack) {
          while (pack.length >= capacity) {
            const removed = pack.pop();
            aggregateAttack -= finite(removed && removed.attack) || 0;
          }
          while (pack.length && aggregateAttack + attack > maxAggregateAttack) {
            const removed = pack.pop();
            aggregateAttack -= finite(removed && removed.attack) || 0;
          }
          if (aggregateAttack + attack <= maxAggregateAttack) {
            pack.unshift(primary);
            aggregateAttack += attack;
          }
        }
      }

      this.metrics.maxPackObserved = Math.max(this.metrics.maxPackObserved, pack.length);
      if (pack.length <= 1 || hpRatio == null || hpRatio < this.config.aoeHpRatio) {
        this.metrics.singleTargetPlans += 1;
        return this._rememberPlan({
          state: 'SINGLE_TARGET',
          reason: pack.length <= 1 ? 'H8_PACK_TOO_SMALL' : 'H8_HP_BELOW_AOE_THRESHOLD',
          hpRatio,
          capacity,
          aggregateAttack,
          pack: pack.slice(0, 1)
        });
      }

      const aoe = this._chooseAoe(character, pack, safe, capacity);
      if (!aoe) {
        this.metrics.singleTargetPlans += 1;
        return this._rememberPlan({
          state: 'SINGLE_TARGET',
          reason: 'H8_NO_LIVE_READY_AOE_SKILL',
          hpRatio,
          capacity,
          aggregateAttack,
          pack
        });
      }

      this.metrics.packsPlanned += 1;
      return this._rememberPlan({
        state: 'AOE_READY',
        reason: aoe.reason,
        hpRatio,
        capacity,
        aggregateAttack,
        pack,
        aoe
      });
    }

    _rememberPlan(plan) {
      this.lastPlan = {
        at: new Date().toISOString(),
        ...clone(plan),
        pack: (plan.pack || []).map(row => ({
          id: row.id,
          mtype: row.mtype || null,
          distance: row.distance == null ? null : row.distance,
          attack: row.attack == null ? null : row.attack,
          targetId: row.targetId || null
        }))
      };
      return clone(this.lastPlan);
    }

    _knownRejection(reason) {
      const value = String(reason || '').toLowerCase();
      if (!value) return false;
      if (value.includes('disconnect') || value.includes('timeout') || value.includes('network')) return false;
      return ['cooldown', 'no_mp', 'mp', 'too_far', 'range', 'not_found', 'cant_use', 'cannot_use', 'level', 'weapon', 'requirements', 'disabled', 'stunned', 'slot'].some(token => value.includes(token));
    }

    _settle(pending, state, response) {
      if (!pending || !this.pending || this.pending.id !== pending.id) return;
      if (state === 'CONFIRMED') {
        this.metrics.aoeConfirmed += 1;
      } else if (state === 'REJECTED') {
        this.metrics.aoeRejected += 1;
        this.backoffUntilMs = this.now() + this.config.rejectionBackoffMs;
      } else {
        this.metrics.aoeUnknown += 1;
        this.suspendedSessionId = pending.sessionId;
        this.suspendedReason = errorReason(response, 'H8_AOE_UNKNOWN');
      }
      this.lastUse = {
        at: new Date().toISOString(),
        skillId: pending.skillId,
        targetIds: pending.targetIds.slice(),
        packSize: pending.packSize,
        state,
        error: state === 'CONFIRMED' ? null : errorReason(response, state === 'REJECTED' ? 'H8_AOE_REJECTED' : 'H8_AOE_UNKNOWN'),
        response: response == null ? null : clone(response)
      };
      this.pending = null;
    }

    _watch(dispatch, pending, generation) {
      const value = dispatch && dispatch.value;
      if (!value || typeof value.then !== 'function') {
        if (value && typeof value === 'object' && value.failed === true) this._settle(pending, 'REJECTED', value);
        else if (value && typeof value === 'object' && (value.success === true || value.response || value.place)) this._settle(pending, 'CONFIRMED', value);
        else this._settle(pending, 'UNKNOWN', value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (generation !== this.pendingGeneration || !this.pending || this.pending.id !== pending.id) return;
        if (response && typeof response === 'object' && response.failed === true) {
          const reason = errorReason(response, 'H8_AOE_REJECTED');
          this._settle(pending, this._knownRejection(reason) ? 'REJECTED' : 'UNKNOWN', response);
        } else {
          this._settle(pending, 'CONFIRMED', response);
        }
      }, error => {
        if (generation !== this.pendingGeneration || !this.pending || this.pending.id !== pending.id) return;
        const reason = errorReason(error, 'H8_AOE_PROMISE_REJECTED');
        this._settle(pending, this._knownRejection(reason) ? 'REJECTED' : 'UNKNOWN', error);
      }).catch(() => {});
    }

    maybeUse(context = {}) {
      if (this.heartbeat) {
        try { this.heartbeat({ phase: this.session && this.session.enabled ? 'adaptive-farming' : 'adaptive-idle', sessionId: this.session && this.session.id || null }); } catch (_) {}
      }
      if (!this.moduleActive || !this.session || !this.session.enabled) return { handled: false, reason: 'H8_INACTIVE' };
      const combatSession = context.session || null;
      if (!combatSession || String(combatSession.id) !== String(this.session.combatSessionId)) {
        return { handled: false, reason: 'H8_COMBAT_SESSION_MISMATCH' };
      }
      if (this.suspendedSessionId === this.session.id) {
        return { handled: false, suspended: true, reason: this.suspendedReason || 'H8_AOE_SUSPENDED' };
      }
      if (this.pending) return { handled: true, pending: true, skillId: this.pending.skillId };
      if (this.now() < this.backoffUntilMs) return { handled: false, reason: 'H8_AOE_BACKOFF' };
      if (this.classSkills && typeof this.classSkills.status === 'function' && this.classSkills.status().pending) {
        return { handled: false, reason: 'H6_CLASS_SKILL_PENDING' };
      }
      const now = this.now();
      if (now - this.lastAttemptAtMs < this.config.minGlobalIntervalMs) return { handled: false, reason: 'H8_GLOBAL_INTERVAL' };

      const plan = this.plan();
      if (!plan || plan.state !== 'AOE_READY' || !plan.aoe) {
        return { handled: false, reason: plan && plan.reason || 'H8_NO_AOE_PLAN', plan };
      }

      let dispatch;
      try {
        dispatch = this.actions.dispatch('use_skill', plan.aoe.args);
      } catch (error) {
        return { handled: false, reason: errorReason(error, 'H8_AOE_ACTION_BLOCKED'), plan };
      }
      this.lastAttemptAtMs = now;

      if (!dispatch || dispatch.state === 'UNAVAILABLE') {
        return { handled: false, reason: 'H8_USE_SKILL_UNAVAILABLE', plan };
      }
      if (dispatch.state === 'UNKNOWN') {
        this.metrics.aoeDispatched += 1;
        this.metrics.aoeUnknown += 1;
        this.suspendedSessionId = this.session.id;
        this.suspendedReason = errorReason(dispatch.error, 'H8_AOE_DISPATCH_UNKNOWN');
        this.lastUse = {
          at: new Date().toISOString(),
          skillId: plan.aoe.skillId,
          targetIds: plan.aoe.targetIds.slice(),
          packSize: plan.aoe.packSize,
          state: 'UNKNOWN',
          error: this.suspendedReason,
          response: clone(dispatch)
        };
        return { handled: true, unknown: true, skillId: plan.aoe.skillId, targetIds: plan.aoe.targetIds.slice(), plan };
      }

      const pending = {
        id: dispatch.id,
        sessionId: this.session.id,
        skillId: plan.aoe.skillId,
        targetIds: plan.aoe.targetIds.slice(),
        packSize: plan.aoe.packSize,
        dispatchedAt: new Date().toISOString()
      };
      this.pending = pending;
      this.metrics.aoeDispatched += 1;
      const generation = this.pendingGeneration;
      this._watch(dispatch, pending, generation);
      return {
        handled: true,
        pending: !!this.pending,
        skillId: pending.skillId,
        targetIds: pending.targetIds.slice(),
        packSize: pending.packSize,
        plan
      };
    }

    status() {
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const ctype = game && game.character && game.character.ctype || null;
      const combat = this._combatStatus();
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        active: !!(this.session && this.session.enabled),
        session: clone(this.session),
        combatOwned: !!(this.session && combat && combat.active && combat.session && String(combat.session.id) === String(this.session.combatSessionId)),
        currentClass: ctype,
        supportedAoeSkills: this.supportedAoeSkills(ctype),
        liveAoeSkills: this.liveAoeSkills(ctype),
        pending: clone(this.pending),
        suspended: !!(this.session && this.suspendedSessionId === this.session.id),
        suspendedReason: this.suspendedReason,
        backoffUntilMs: this.backoffUntilMs || null,
        lastPlan: clone(this.lastPlan),
        lastUse: clone(this.lastUse),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.AdaptiveFarmingController = AdaptiveFarmingController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function ratio(value, max) {
    const current = finite(value);
    const total = finite(max);
    if (current == null || total == null || total <= 0) return null;
    return Math.max(0, Math.min(1, current / total));
  }

  function errorReason(value, fallback = 'COMBAT_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 240);
    }
    const text = cleanText(value, 240);
    return text || fallback;
  }

  class CombatController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.movement = options.movement;
      this.classSkills = options.classSkills || null;
      this.party = options.party || null;
      this.farming = options.farming || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        tickMs: Math.max(75, Math.min(1000, Number(options.tickMs) || 125)),
        attackOutcomeTimeoutMs: Math.max(750, Math.min(10000, Number(options.attackOutcomeTimeoutMs) || 3000)),
        targetConfirmTimeoutMs: Math.max(500, Math.min(10000, Number(options.targetConfirmTimeoutMs) || 2000)),
        retreatHpRatio: Math.max(0.05, Math.min(0.9, Number(options.retreatHpRatio) || 0.35)),
        resumeHpRatio: Math.max(0.1, Math.min(1, Number(options.resumeHpRatio) || 0.65)),
        minMpRatio: Math.max(0, Math.min(0.9, Number(options.minMpRatio) || 0.05)),
        preferredRangeRatio: Math.max(0.25, Math.min(0.95, Number(options.preferredRangeRatio) || 0.78)),
        kiteTriggerRatio: Math.max(0.05, Math.min(0.8, Number(options.kiteTriggerRatio) || 0.30)),
        kiteStep: Math.max(10, Math.min(120, Number(options.kiteStep) || 35)),
        maxAcquireDistance: Math.max(50, Math.min(1200, Number(options.maxAcquireDistance) || 450)),
        maxAttackToHpRatio: Math.max(0.01, Math.min(0.5, Number(options.maxAttackToHpRatio) || 0.08)),
        minExpectedHitChance: Math.max(0.05, Math.min(0.95, Number(options.minExpectedHitChance) || 0.25))
      };

      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.session = null;
      this.lastSession = null;
      this.sequence = 0;
      this.pendingAttack = null;
      this.targetConfirmDeadlineMs = null;
      this.metrics = {
        sessions: 0,
        targetsAcquired: 0,
        targetChanges: 0,
        attacksDispatched: 0,
        attacksConfirmed: 0,
        attackUnknown: 0,
        killsObserved: 0,
        approaches: 0,
        kites: 0,
        retreats: 0,
        blockedByMovement: 0,
        lowMpWaits: 0,
        rejected: 0
      };
    }

    start(context) {
      this.moduleActive = true;
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (!this.scope) throw new Error('COMBAT_SCOPE_REQUIRED');
      this.scope.interval('combat-loop', () => this._tick(), this.config.tickMs, { immediate: false });
      if (this.heartbeat) this.heartbeat({ phase: 'combat-module-start', session: false });
      return this.status();
    }

    stop(reason = 'COMBAT_MODULE_STOP') {
      this.moduleActive = false;
      this.stopSession(reason);
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    _publicSession(session) {
      if (!session) return null;
      return clone(session);
    }

    _policy(options = {}) {
      return {
        monsterType: cleanText(options.monsterType || options.type || '', 120) || null,
        maxAttack: finite(options.maxAttack),
        maxAttackToHpRatio: Math.max(0.01, Math.min(0.5, Number(options.maxAttackToHpRatio) || this.config.maxAttackToHpRatio)),
        maxAcquireDistance: Math.max(50, Math.min(1200, Number(options.maxAcquireDistance) || this.config.maxAcquireDistance)),
        minExpectedHitChance: Math.max(0.05, Math.min(0.95,
          options.minExpectedHitChance == null ? this.config.minExpectedHitChance : Number(options.minExpectedHitChance))),
        allowContested: options.allowContested === true,
        allowUnknownAttack: options.allowUnknownAttack === true,
        partyAssist: options.partyAssist !== false,
        kiting: options.kiting === true,
        preferredRangeRatio: Math.max(0.25, Math.min(0.95, Number(options.preferredRangeRatio) || this.config.preferredRangeRatio)),
        retreatHpRatio: Math.max(0.05, Math.min(0.9, Number(options.retreatHpRatio) || this.config.retreatHpRatio)),
        resumeHpRatio: Math.max(0.1, Math.min(1, Number(options.resumeHpRatio) || this.config.resumeHpRatio)),
        minMpRatio: Math.max(0, Math.min(0.9, options.minMpRatio == null ? this.config.minMpRatio : Number(options.minMpRatio)))
      };
    }

    startSession(options = {}) {
      if (!this.moduleActive) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'COMBAT_MODULE_NOT_ACTIVE', status: this.status() };
      }
      if (this.session && this.session.enabled) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'COMBAT_SESSION_ALREADY_ACTIVE', status: this.status() };
      }

      const game = this.game && this.game.snapshot ? this.game.snapshot() : null;
      if (!game || !game.available || !game.character) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'CHARACTER_UNAVAILABLE', status: this.status() };
      }
      if (game.character.rip === true) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'CHARACTER_DEAD', status: this.status() };
      }
      if (String(game.character.ctype || '').toLowerCase() === 'merchant') {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'COMBAT_UNSUPPORTED_CLASS:merchant', status: this.status() };
      }

      const id = 'combat-' + (++this.sequence);
      this.session = {
        id,
        enabled: true,
        owner: cleanText(options.owner || 'manual', 80) || 'manual',
        state: 'ACQUIRING',
        reason: null,
        startedAt: new Date().toISOString(),
        startedAtMs: this.now(),
        stoppedAt: null,
        targetId: null,
        targetType: null,
        targetAcquiredAt: null,
        policy: this._policy(options),
        counters: {
          ticks: 0,
          targetsAcquired: 0,
          attacksDispatched: 0,
          attacksConfirmed: 0,
          killsObserved: 0,
          approaches: 0,
          kites: 0,
          retreats: 0
        },
        lastDecision: null,
        lastError: null
      };
      this.pendingAttack = null;
      this.targetConfirmDeadlineMs = null;
      if (this.classSkills && typeof this.classSkills.beginSession === 'function') {
        this.classSkills.beginSession(id);
      }
      this.metrics.sessions += 1;
      if (this.logger) this.logger.warn('Combat-Session gestartet', {
        id,
        owner: this.session.owner,
        policy: this.session.policy
      });
      return { accepted: true, session: this._publicSession(this.session) };
    }

    _combatMovementActive() {
      const movement = this.movement && this.movement.status ? this.movement.status() : null;
      const order = movement && movement.activeOrder;
      return !!(order && String(order.owner || '').startsWith('combat-h5'));
    }

    _foreignMovementActive() {
      const movement = this.movement && this.movement.status ? this.movement.status() : null;
      const order = movement && movement.activeOrder;
      return !!(order && !String(order.owner || '').startsWith('combat-h5'));
    }

    _cancelCombatMovement(reason) {
      if (!this._combatMovementActive()) return false;
      try {
        this.movement.cancel(reason || 'COMBAT_MOVEMENT_CANCEL');
        return true;
      } catch (_) {
        return false;
      }
    }

    _clearGameTarget(reason = 'COMBAT_CLEAR_TARGET') {
      try {
        if (this.actions && this.actions.available('change_target')) {
          this.actions.dispatch('change_target', [null], { cleanup: true });
        }
      } catch (_) {}
      if (this.session) {
        this.session.targetId = null;
        this.session.targetType = null;
        this.session.targetAcquiredAt = null;
        this.targetConfirmDeadlineMs = null;
        this.session.lastDecision = { at: new Date().toISOString(), type: 'TARGET_CLEAR', reason };
      }
    }

    stopSession(reason = 'COMBAT_SESSION_STOP') {
      if (!this.session) {
        this._cancelCombatMovement(reason);
        this.pendingAttack = null;
        return { stopped: false, reason: 'NO_COMBAT_SESSION' };
      }

      const session = this.session;
      session.enabled = false;
      session.state = 'STOPPED';
      session.reason = cleanText(reason, 240);
      session.stoppedAt = new Date().toISOString();
      this._cancelCombatMovement(reason);
      this._clearGameTarget(reason);
      this.pendingAttack = null;
      if (this.classSkills && typeof this.classSkills.endSession === 'function') {
        try { this.classSkills.endSession(reason); } catch (_) {}
      }
      if (this.farming && typeof this.farming.onCombatEnded === 'function') {
        try { this.farming.onCombatEnded(session.id, reason); } catch (_) {}
      }
      this.lastSession = this._publicSession(session);
      this.session = null;

      if (this.logger) this.logger.warn('Combat-Session beendet', {
        id: session.id,
        reason: session.reason,
        counters: session.counters
      });
      return { stopped: true, session: clone(this.lastSession) };
    }

    _fail(state, reason, details) {
      if (!this.session) return;
      this.session.enabled = false;
      this.session.state = state;
      this.session.reason = cleanText(reason, 240);
      this.session.lastError = details ? clone(details) : null;
      this.session.stoppedAt = new Date().toISOString();
      this._cancelCombatMovement(reason);
      this._clearGameTarget(reason);
      this.pendingAttack = null;
      if (this.classSkills && typeof this.classSkills.endSession === 'function') {
        try { this.classSkills.endSession(reason); } catch (_) {}
      }
      if (this.farming && typeof this.farming.onCombatEnded === 'function') {
        try { this.farming.onCombatEnded(this.session.id, reason); } catch (_) {}
      }
      this.lastSession = this._publicSession(this.session);
      if (this.logger) this.logger.error('Combat fail-safe beendet', {
        id: this.session.id,
        state,
        reason,
        details: details || null
      });
      this.session = null;
    }

    _safeMaxAttack(character, policy) {
      if (policy.maxAttack != null) return policy.maxAttack;
      const maxHp = finite(character && character.maxHp);
      if (maxHp == null) return null;
      return Math.max(20, maxHp * policy.maxAttackToHpRatio);
    }

    _damageType(character) {
      const live = cleanText(character && (character.damageType || character.damage_type) || '', 60).toLowerCase();
      if (live) return live;
      const ctype = cleanText(character && character.ctype || '', 60).toLowerCase();
      if (ctype === 'mage' || ctype === 'priest') return 'magical';
      if (['warrior', 'ranger', 'rogue', 'paladin'].includes(ctype)) return 'physical';
      return null;
    }

    _expectedHitChance(character, monster) {
      const definition = this.game && typeof this.game.monsterDefinition === 'function' && monster && monster.mtype
        ? this.game.monsterDefinition(monster.mtype)
        : null;
      if (!definition) return 1;
      const damageType = this._damageType(character);
      const avoidance = Math.max(0, Math.min(100, finite(definition.avoidance) || 0));
      let chance = 1 - avoidance / 100;
      if (damageType === 'physical') {
        const evasion = Math.max(0, Math.min(100, finite(definition.evasion) || 0));
        chance *= 1 - evasion / 100;
      }
      return Math.max(0, Math.min(1, chance));
    }

    safeCandidates(options = {}) {
      const game = this.game && this.game.snapshot ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!character) return [];
      const policy = this._policy(options);
      const maxAttack = this._safeMaxAttack(character, policy);
      return this.game.visibleMonsters({ type: policy.monsterType }).filter(monster => {
        if (!monster || monster.dead || monster.visible === false) return false;
        if (monster.distance == null || monster.distance > policy.maxAcquireDistance) return false;
        if (maxAttack != null && monster.attack == null && !policy.allowUnknownAttack) return false;
        if (maxAttack != null && monster.attack != null && monster.attack > maxAttack) return false;
        const expectedHitChance = this._expectedHitChance(character, monster);
        if (expectedHitChance < policy.minExpectedHitChance) return false;
        monster.expectedHitChance = expectedHitChance;
        if (!policy.allowContested && monster.targetId && monster.targetId !== character.name) {
          const ownedPartyTarget = policy.partyAssist
            && this.party
            && typeof this.party.isOwnedPartyMember === 'function'
            && this.party.isOwnedPartyMember(monster.targetId);
          if (!ownedPartyTarget) return false;
        }
        return true;
      });
    }

    _freshTarget() {
      if (!this.session || !this.session.targetId) return null;
      const monsters = this.game.visibleMonsters({ type: this.session.policy.monsterType });
      return monsters.find(monster => String(monster.id) === String(this.session.targetId)) || null;
    }

    _selectTarget(game) {
      const candidates = this.safeCandidates(this.session.policy);
      if (!candidates.length) {
        this.session.state = 'NO_TARGET';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'NO_TARGET',
          visibleMonsters: this.game.visibleMonsters().length
        };
        return null;
      }

      const preferredId = this.session.policy.partyAssist && this.party && typeof this.party.preferredTargetId === 'function'
        ? this.party.preferredTargetId()
        : null;
      const target = preferredId == null
        ? candidates[0]
        : (candidates.find(candidate => String(candidate.id) === String(preferredId)) || candidates[0]);
      const raw = this.game.entityReference(target.id);
      if (!raw) {
        this.session.state = 'ACQUIRING';
        return null;
      }

      let dispatch;
      try {
        dispatch = this.actions.dispatch('change_target', [raw]);
      } catch (error) {
        this._fail('FAILED_SAFE', errorReason(error, 'COMBAT_CHANGE_TARGET_BLOCKED'));
        return null;
      }
      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        this._fail(dispatch && dispatch.state === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED_SAFE',
          dispatch && dispatch.error ? errorReason(dispatch.error) : 'COMBAT_CHANGE_TARGET_FAILED',
          dispatch || null);
        return null;
      }

      this.session.targetId = String(target.id);
      this.session.targetType = target.mtype || null;
      this.session.targetAcquiredAt = new Date().toISOString();
      this.targetConfirmDeadlineMs = this.now() + this.config.targetConfirmTimeoutMs;
      this.session.state = 'TARGETING';
      this.session.counters.targetsAcquired += 1;
      this.metrics.targetsAcquired += 1;
      this.metrics.targetChanges += 1;
      this.session.lastDecision = {
        at: new Date().toISOString(),
        type: 'TARGET_SELECTED',
        targetId: this.session.targetId,
        targetType: this.session.targetType,
        distance: target.distance,
        attack: target.attack,
        expectedHitChance: target.expectedHitChance == null ? null : target.expectedHitChance
      };
      return target;
    }

    _targetConfirmed(game) {
      if (!this.session || !this.session.targetId) return false;
      if (game && game.target && String(game.target.id) === String(this.session.targetId)) return true;
      return false;
    }

    _watchAttackPromise(sessionId, attackId, value) {
      if (!value || typeof value.then !== 'function') {
        if (this.pendingAttack && this.pendingAttack.attackId === attackId) {
          this.pendingAttack.commandSettlement = 'RETURNED';
        }
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.session || this.session.id !== sessionId) return;
        if (!this.pendingAttack || this.pendingAttack.attackId !== attackId) return;
        if (response && response.failed === true) {
          this.pendingAttack.commandSettlement = 'REJECTED';
          this.pendingAttack.commandError = errorReason(response.reason || response, 'ATTACK_COMMAND_FAILED');
          return;
        }
        this.pendingAttack.commandSettlement = 'RESOLVED';
        this.pendingAttack.commandResponse = response == null ? null : clone(response);
      }, error => {
        if (!this.session || this.session.id !== sessionId) return;
        if (!this.pendingAttack || this.pendingAttack.attackId !== attackId) return;
        this.pendingAttack.commandSettlement = 'REJECTED';
        this.pendingAttack.commandError = errorReason(error, 'ATTACK_COMMAND_REJECTED');
      }).catch(() => {});
    }

    _serverAttackEvidence(pending) {
      if (!pending || pending.commandSettlement !== 'RESOLVED') return null;
      const response = pending.commandResponse;
      if (!response || typeof response !== 'object') return null;
      if (response.failed === true || response.success !== true) return null;
      if (String(response.place || '') !== 'attack') return null;
      if (response.target == null || String(response.target) !== String(pending.targetId)) return null;
      const damage = finite(response.damage);
      if (damage == null || damage <= 0) return null;
      return {
        source: 'attack-game-response',
        damage,
        lethal: pending.baselineHp != null && damage >= pending.baselineHp,
        response: clone(response)
      };
    }

    _observePendingAttack() {
      const pending = this.pendingAttack;
      if (!pending || !this.session) return false;

      if (pending.commandSettlement === 'REJECTED') {
        this.metrics.attackUnknown += 1;
        this._fail('UNKNOWN', pending.commandError || 'ATTACK_COMMAND_REJECTED', clone(pending));
        return true;
      }

      const serverEvidence = this._serverAttackEvidence(pending);
      if (serverEvidence) {
        this.metrics.attacksConfirmed += 1;
        this.session.counters.attacksConfirmed += 1;
        if (serverEvidence.lethal) {
          this.metrics.killsObserved += 1;
          this.session.counters.killsObserved += 1;
        }
        this.pendingAttack = null;
        this.session.state = serverEvidence.lethal ? 'ACQUIRING' : 'ENGAGED';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: serverEvidence.lethal ? 'KILL_CONFIRMED_SERVER' : 'ATTACK_CONFIRMED_SERVER',
          targetId: pending.targetId,
          hpBefore: pending.baselineHp,
          damage: serverEvidence.damage,
          source: serverEvidence.source
        };
        if (serverEvidence.lethal) this._clearGameTarget('TARGET_LETHAL_SERVER_EVIDENCE');
        return true;
      }

      const target = this._freshTarget();
      if (!target) {
        const snap = this.game.snapshot();
        const observed = snap && snap.target && String(snap.target.id) === String(pending.targetId) ? snap.target : null;
        if (observed && observed.dead === true) {
          this.metrics.attacksConfirmed += 1;
          this.metrics.killsObserved += 1;
          this.session.counters.attacksConfirmed += 1;
          this.session.counters.killsObserved += 1;
          this.pendingAttack = null;
          this._clearGameTarget('TARGET_DEAD_AFTER_ATTACK');
          this.session.state = 'ACQUIRING';
          return true;
        }
        if (this.now() >= pending.deadlineAtMs) {
          this.metrics.attackUnknown += 1;
          this._fail('UNKNOWN', 'ATTACK_TARGET_LOST_WITHOUT_DEATH_EVIDENCE', clone(pending));
          return true;
        }
        this.session.state = 'WAITING_ATTACK_OUTCOME';
        return true;
      }

      if (pending.baselineHp != null && target.hp != null && target.hp < pending.baselineHp) {
        this.metrics.attacksConfirmed += 1;
        this.session.counters.attacksConfirmed += 1;
        this.pendingAttack = null;
        this.session.state = 'ENGAGED';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'ATTACK_CONFIRMED',
          targetId: target.id,
          hpBefore: pending.baselineHp,
          hpAfter: target.hp
        };
        return true;
      }

      if (this.now() >= pending.deadlineAtMs) {
        this.metrics.attackUnknown += 1;
        this._fail('UNKNOWN', 'ATTACK_OUTCOME_UNCONFIRMED', clone(pending));
        return true;
      }

      this.session.state = 'WAITING_ATTACK_OUTCOME';
      return true;
    }

    _beginAttack(target) {
      const raw = this.game.entityReference(target.id);
      if (!raw) return false;

      let dispatch;
      try {
        dispatch = this.actions.dispatch('attack', [raw]);
      } catch (error) {
        this._fail('FAILED_SAFE', errorReason(error, 'ATTACK_BLOCKED'));
        return true;
      }

      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        this.metrics.attackUnknown += 1;
        this._fail(dispatch && dispatch.state === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED_SAFE',
          dispatch && dispatch.error ? errorReason(dispatch.error) : 'ATTACK_DISPATCH_FAILED',
          dispatch || null);
        return true;
      }

      this.metrics.attacksDispatched += 1;
      this.session.counters.attacksDispatched += 1;
      this.pendingAttack = {
        attackId: dispatch.id,
        targetId: String(target.id),
        baselineHp: finite(target.hp),
        dispatchedAt: new Date().toISOString(),
        dispatchedAtMs: this.now(),
        deadlineAtMs: this.now() + this.config.attackOutcomeTimeoutMs,
        commandSettlement: 'DISPATCHED',
        commandResponse: null,
        commandError: null
      };
      this.session.state = 'ATTACKING';
      this.session.lastDecision = {
        at: new Date().toISOString(),
        type: 'ATTACK_DISPATCHED',
        attackId: dispatch.id,
        targetId: String(target.id),
        targetHp: finite(target.hp)
      };
      this._watchAttackPromise(this.session.id, dispatch.id, dispatch.value);
      return true;
    }

    _approach(game, target) {
      if (this._foreignMovementActive()) {
        this.metrics.blockedByMovement += 1;
        this.session.state = 'BLOCKED_MOVEMENT';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'MOVEMENT_BUSY',
          targetId: target.id
        };
        return true;
      }
      if (this._combatMovementActive()) {
        this.session.state = 'APPROACHING';
        return true;
      }

      const preferred = Math.max(10, (finite(game.character.range) || 40) * this.session.policy.preferredRangeRatio);
      const result = this.movement.approachCurrentTarget({
        owner: 'combat-h5-approach',
        distance: preferred
      });
      if (result && result.accepted) {
        this.metrics.approaches += 1;
        this.session.counters.approaches += 1;
        this.session.state = result.completed ? 'ENGAGED' : 'APPROACHING';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'APPROACH',
          targetId: target.id,
          preferredDistance: preferred,
          result: clone(result)
        };
      } else {
        this.session.state = 'WAITING_RANGE';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'APPROACH_REJECTED',
          targetId: target.id,
          reason: result && result.reason || 'UNKNOWN'
        };
      }
      return true;
    }

    _kite(game, target) {
      if (!this.session.policy.kiting) return false;
      const range = finite(game.character.range);
      const distance = finite(target.distance);
      if (range == null || distance == null) return false;
      if (distance > range * this.config.kiteTriggerRatio) return false;
      if (this._foreignMovementActive() || this._combatMovementActive()) return false;

      const cx = finite(game.character.x), cy = finite(game.character.y);
      const tx = finite(target.x), ty = finite(target.y);
      if (cx == null || cy == null || tx == null || ty == null) return false;
      const dx = cx - tx;
      const dy = cy - ty;
      const length = Math.hypot(dx, dy);
      if (length <= 0) return false;
      const x = cx + (dx / length) * this.config.kiteStep;
      const y = cy + (dy / length) * this.config.kiteStep;
      const result = this.movement.moveLocal(x, y, {
        owner: 'combat-h5-kite',
        arrivalRadius: 8
      });
      if (result && result.accepted) {
        this.metrics.kites += 1;
        this.session.counters.kites += 1;
        this.session.state = 'KITING';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'KITE',
          targetId: target.id,
          destination: { x, y }
        };
        return true;
      }
      return false;
    }

    _retreat(game, hpRatio) {
      if (!this.session) return;
      if (this.session.state === 'RETREATING' || this.session.state === 'WAITING_RECOVERY') {
        if (this._combatMovementActive()) {
          this.session.state = 'RETREATING';
          return;
        }
        if (hpRatio != null && hpRatio >= this.session.policy.resumeHpRatio) {
          this.session.state = 'ACQUIRING';
          this.session.reason = null;
          return;
        }
        this.session.state = 'WAITING_RECOVERY';
        return;
      }

      this.metrics.retreats += 1;
      this.session.counters.retreats += 1;
      this.session.state = 'RETREATING';
      this.session.reason = 'LOW_HP';
      this.pendingAttack = null;
      this._cancelCombatMovement('COMBAT_LOW_HP_RETREAT');
      this._clearGameTarget('COMBAT_LOW_HP_RETREAT');
      const result = this.movement.safeReturn({ owner: 'combat-h5-retreat' });
      this.session.lastDecision = {
        at: new Date().toISOString(),
        type: 'RETREAT',
        hpRatio,
        result: clone(result)
      };
      if (!result || result.accepted !== true) {
        this._fail('FAILED_SAFE', result && result.reason || 'COMBAT_RETREAT_UNAVAILABLE', result || null);
      }
    }

    _tick() {
      if (this.heartbeat) {
        this.heartbeat({
          phase: this.session && this.session.enabled ? 'combat-active' : 'combat-idle',
          sessionId: this.session && this.session.id || null,
          state: this.session && this.session.state || 'IDLE'
        });
      }
      if (!this.moduleActive || !this.session || !this.session.enabled) return;

      this.session.counters.ticks += 1;
      const game = this.game.snapshot();
      const character = game && game.character;
      if (!game || !game.available || !character) {
        this._fail('FAILED_SAFE', 'CHARACTER_UNAVAILABLE');
        return;
      }
      if (character.rip === true) {
        this._fail('FAILED_SAFE', 'CHARACTER_DEAD');
        return;
      }

      const hpRatio = ratio(character.hp, character.maxHp);
      const mpRatio = ratio(character.mp, character.maxMp);
      if (hpRatio != null && hpRatio <= this.session.policy.retreatHpRatio) {
        this._retreat(game, hpRatio);
        return;
      }
      if (this.session.state === 'RETREATING' || this.session.state === 'WAITING_RECOVERY') {
        this._retreat(game, hpRatio);
        return;
      }
      if (mpRatio != null && mpRatio < this.session.policy.minMpRatio) {
        this.metrics.lowMpWaits += 1;
        this.session.state = 'WAITING_MP';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'LOW_MP_WAIT',
          mpRatio
        };
        return;
      }

      if (this._observePendingAttack()) return;

      if (this.session.policy.partyAssist && this.party && typeof this.party.preferredTargetId === 'function') {
        const preferredId = this.party.preferredTargetId();
        if (preferredId != null && this.session.targetId != null && String(preferredId) !== String(this.session.targetId)) {
          const preferred = this.safeCandidates(this.session.policy)
            .find(candidate => String(candidate.id) === String(preferredId));
          if (preferred) {
            this._clearGameTarget('PARTY_FOCUS_RETARGET');
            this.session.state = 'ACQUIRING';
          }
        }
      }

      let target = this._freshTarget();
      if (!target) {
        if (this.session.targetId) {
          this._clearGameTarget('TARGET_LOST');
        }
        target = this._selectTarget(game);
        if (!target) return;
      }

      if (!this._targetConfirmed(game)) {
        if (this.targetConfirmDeadlineMs != null && this.now() >= this.targetConfirmDeadlineMs) {
          this._fail('FAILED_SAFE', 'TARGET_CONFIRM_TIMEOUT', { targetId: this.session.targetId });
          return;
        }
        this.session.state = 'TARGETING';
        return;
      }

      const readiness = this.game.combatReadiness(target.id);
      if (!readiness.targetAvailable) {
        this._clearGameTarget('TARGET_NOT_FRESH');
        this.session.state = 'ACQUIRING';
        return;
      }

      if (this.classSkills && typeof this.classSkills.maybeUse === 'function') {
        const skill = this.classSkills.maybeUse({
          game,
          target,
          session: this.session,
          readiness
        });
        if (skill && skill.handled) {
          this.session.state = skill.unknown ? 'CLASS_SKILL_UNKNOWN'
            : skill.pending ? 'CLASS_SKILL_PENDING'
              : 'CLASS_SKILL_ACTION';
          this.session.lastDecision = {
            at: new Date().toISOString(),
            type: skill.unknown ? 'CLASS_SKILL_UNKNOWN' : 'CLASS_SKILL',
            skillId: skill.skillId || null,
            targetId: skill.targetId || target.id,
            kind: skill.kind || null,
            reason: skill.reason || null
          };
          return;
        }
      }

      if (this.farming && typeof this.farming.maybeUse === 'function') {
        const aoe = this.farming.maybeUse({
          game,
          target,
          session: this.session,
          readiness
        });
        if (aoe && aoe.handled) {
          this.session.state = aoe.unknown ? 'H8_AOE_UNKNOWN'
            : aoe.pending ? 'H8_AOE_PENDING'
              : 'H8_AOE_ACTION';
          this.session.lastDecision = {
            at: new Date().toISOString(),
            type: aoe.unknown ? 'H8_AOE_UNKNOWN' : 'H8_AOE',
            skillId: aoe.skillId || null,
            targetIds: aoe.targetIds || [],
            packSize: aoe.packSize || 0,
            reason: aoe.reason || null
          };
          return;
        }
      }

      if (!readiness.inRange) {
        this._approach(game, target);
        return;
      }

      if (this._kite(game, target)) return;

      if (readiness.cooldown || !readiness.canAttack) {
        this.session.state = readiness.cooldown ? 'WAITING_COOLDOWN' : 'WAITING_ATTACK_READY';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'ATTACK_NOT_READY',
          targetId: target.id,
          readiness: clone(readiness)
        };
        return;
      }

      this._beginAttack(target);
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        state: this.session && this.session.enabled ? this.session.state : 'IDLE',
        active: !!(this.session && this.session.enabled),
        session: this._publicSession(this.session),
        lastSession: clone(this.lastSession),
        pendingAttack: clone(this.pendingAttack),
        config: clone(this.config),
        metrics: clone(this.metrics),
        safeCandidates: this.moduleActive && this.game ? this.safeCandidates().slice(0, 5) : []
      };
    }
  }

  ns.CombatController = CombatController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function distance(a, b) {
    if (!a || !b) return null;
    const ax = finite(a.x);
    const ay = finite(a.y);
    const bx = finite(b.x);
    const by = finite(b.y);
    if ([ax, ay, bx, by].some(value => value == null)) return null;
    return Math.hypot(ax - bx, ay - by);
  }

  class FarmIntelligenceController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.combat = options.combat;
      this.farming = options.farming;
      this.movement = options.movement;
      this.party = options.party || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        decisionIntervalMs: Math.max(500, Math.min(5000, Number(options.decisionIntervalMs) || 1000)),
        minHoldMs: Math.max(5000, Math.min(300000, Number(options.minHoldMs) || 45000)),
        switchCooldownMs: Math.max(5000, Math.min(300000, Number(options.switchCooldownMs) || 30000)),
        pingPongWindowMs: Math.max(10000, Math.min(600000, Number(options.pingPongWindowMs) || 120000)),
        switchImprovementRatio: Math.max(0.05, Math.min(1, Number(options.switchImprovementRatio) || 0.18)),
        competitionRadius: Math.max(80, Math.min(1000, Number(options.competitionRadius) || 260)),
        spotBucket: Math.max(80, Math.min(500, Number(options.spotBucket) || 180)),
        arrivalRadius: Math.max(20, Math.min(200, Number(options.arrivalRadius) || 70)),
        visibleAcquireDistance: Math.max(150, Math.min(900, Number(options.visibleAcquireDistance) || 500)),
        densityTarget: Math.max(2, Math.min(20, Number(options.densityTarget) || 6)),
        depletionGraceMs: Math.max(1000, Math.min(30000, Number(options.depletionGraceMs) || 5000)),
        minExpectedHitChance: Math.max(0.05, Math.min(0.95, Number(options.minExpectedHitChance) || 0.25))
      };

      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.session = null;
      this.sequence = 0;
      this.currentSelection = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.history = [];
      this.observations = new Map();
      this.suspendedReason = null;
      this.metrics = {
        sessions: 0,
        decisions: 0,
        candidateRows: 0,
        holds: 0,
        switches: 0,
        travelOrders: 0,
        farmingStarts: 0,
        farmingStops: 0,
        depletionEvents: 0,
        respawnsObserved: 0,
        pingPongBlocks: 0,
        ownershipBlocks: 0,
        foreignPartyBlocks: 0,
        unsafeBlocks: 0,
        movementUnknown: 0
      };
    }

    start(context) {
      this.moduleActive = true;
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('farm-intelligence-loop', () => this.tick(), this.config.decisionIntervalMs, { immediate: true });
      }
      return this.status();
    }

    stop(reason = 'H9_MODULE_STOP') {
      this.moduleActive = false;
      this.stopAutonomy(reason);
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H9_MODULE_NOT_ACTIVE', status: this.status() };
      if (this.session && this.session.enabled) return { accepted: false, reason: 'H9_SESSION_ALREADY_ACTIVE', status: this.status() };

      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) return { accepted: false, reason: 'CHARACTER_UNAVAILABLE', status: this.status() };
      if (character.rip === true) return { accepted: false, reason: 'CHARACTER_DEAD', status: this.status() };
      if (String(character.ctype || '').toLowerCase() === 'merchant') {
        return { accepted: false, reason: 'H9_UNSUPPORTED_CLASS:merchant', status: this.status() };
      }

      const farm = this.farming && typeof this.farming.status === 'function' ? this.farming.status() : null;
      if (farm && farm.active && farm.session && String(farm.session.owner || '') !== 'farm-intelligence-h9') {
        this.metrics.ownershipBlocks += 1;
        return { accepted: false, reason: 'H9_FARMING_ALREADY_OWNED', farming: farm, status: this.status() };
      }

      const id = 'farm-intel-' + (++this.sequence);
      this.session = {
        id,
        enabled: true,
        owner: cleanText(options.owner || 'farm-intelligence-h9', 80) || 'farm-intelligence-h9',
        preferredTypes: Array.isArray(options.preferredTypes)
          ? options.preferredTypes.map(value => cleanText(value, 120)).filter(Boolean)
          : [],
        excludedTypes: Array.isArray(options.excludedTypes)
          ? options.excludedTypes.map(value => cleanText(value, 120)).filter(Boolean)
          : [],
        allowTravel: options.allowTravel !== false,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        reason: null
      };
      this.currentSelection = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.history = [];
      this.suspendedReason = null;
      this.metrics.sessions += 1;
      const tick = this.tick();
      return { accepted: true, session: clone(this.session), tick };
    }

    stopAutonomy(reason = 'H9_SESSION_STOP') {
      const session = this.session;
      this._stopOwnedFarming(reason);
      this._stopOwnedMovement(reason);
      if (!session) return { stopped: false, reason: 'NO_H9_SESSION' };
      session.enabled = false;
      session.reason = cleanText(reason, 240);
      session.stoppedAt = new Date().toISOString();
      const ended = clone(session);
      this.session = null;
      this.currentSelection = null;
      this.suspendedReason = null;
      return { stopped: true, session: ended };
    }

    _partyOwnedNames(characterName) {
      const names = new Set();
      if (characterName) names.add(String(characterName));
      if (!this.party || typeof this.party.status !== 'function') return names;
      const party = this.party.status();
      for (const name of party && party.party && party.party.ownedMemberNames || []) names.add(String(name));
      return names;
    }

    _safeVisible(character) {
      if (!this.combat || typeof this.combat.safeCandidates !== 'function') return [];
      return this.combat.safeCandidates({
        maxAcquireDistance: this.config.visibleAcquireDistance,
        maxAttackToHpRatio: 0.08,
        allowContested: false,
        allowUnknownAttack: false,
        partyAssist: true
      }).filter(row => row && (!row.map || !character.map || String(row.map) === String(character.map)));
    }

    _foreignPlayers(character) {
      if (!this.game || typeof this.game.visiblePlayers !== 'function') return [];
      const owned = this._partyOwnedNames(character && character.name);
      return this.game.visiblePlayers({}).filter(player => {
        const name = player && (player.name || player.id);
        return name && !owned.has(String(name));
      });
    }

    _clusterSafeVisible(character) {
      const safe = this._safeVisible(character);
      const groups = new Map();
      const bucket = this.config.spotBucket;
      for (const monster of safe) {
        const mtype = cleanText(monster.mtype || monster.name || '', 120);
        if (!mtype) continue;
        const bx = monster.x == null ? 0 : Math.round(Number(monster.x) / bucket);
        const by = monster.y == null ? 0 : Math.round(Number(monster.y) / bucket);
        const key = String(character.map || 'unknown') + ':' + mtype + ':visible:' + bx + ':' + by;
        if (!groups.has(key)) groups.set(key, { key, map: character.map || null, mtype, rows: [] });
        groups.get(key).rows.push(monster);
      }

      const players = this._foreignPlayers(character);
      return [...groups.values()].map(group => {
        const coords = group.rows.filter(row => finite(row.x) != null && finite(row.y) != null);
        const x = coords.length ? coords.reduce((sum, row) => sum + Number(row.x), 0) / coords.length : finite(character.x);
        const y = coords.length ? coords.reduce((sum, row) => sum + Number(row.y), 0) / coords.length : finite(character.y);
        const competitors = players.filter(player => {
          const d = distance({ x, y }, player);
          return d != null && d <= this.config.competitionRadius;
        }).length;
        return {
          key: group.key,
          source: 'LIVE_SAFE_CLUSTER',
          map: group.map,
          mtype: group.mtype,
          x,
          y,
          visibleSafeCount: group.rows.length,
          spawnCount: null,
          competitors,
          averageDistance: group.rows.reduce((sum, row) => sum + (finite(row.distance) || 0), 0) / Math.max(1, group.rows.length),
          aggregateAttack: group.rows.reduce((sum, row) => sum + (finite(row.attack) || 0), 0),
          definition: this.game && typeof this.game.monsterDefinition === 'function'
            ? this.game.monsterDefinition(group.mtype)
            : null
        };
      });
    }

    _catalogCandidates(character, liveRows) {
      if (!this.game || typeof this.game.farmSpotCatalog !== 'function') return [];
      const catalog = this.game.farmSpotCatalog({ map: character.map, currentOnly: true });
      const players = this._foreignPlayers(character);
      return catalog.map(spot => {
        const duplicate = liveRows.some(row => row.mtype === spot.mtype && distance(row, spot) != null && distance(row, spot) <= this.config.spotBucket * 1.25);
        if (duplicate) return null;
        const competitors = players.filter(player => {
          const d = distance(spot, player);
          return d != null && d <= this.config.competitionRadius;
        }).length;
        return {
          key: 'catalog:' + String(spot.key),
          source: 'LIVE_G_MAP_SPAWN',
          map: spot.map,
          mtype: spot.mtype,
          x: spot.x,
          y: spot.y,
          visibleSafeCount: 0,
          spawnCount: finite(spot.count),
          respawn: finite(spot.respawn),
          competitors,
          averageDistance: distance(character, spot),
          aggregateAttack: null,
          definition: spot.definition || (this.game.monsterDefinition && this.game.monsterDefinition(spot.mtype))
        };
      }).filter(Boolean);
    }

    _observeCandidates(rows) {
      const now = this.now();
      const seen = new Set();
      for (const row of rows) {
        seen.add(row.key);
        const prior = this.observations.get(row.key) || {
          key: row.key,
          mtype: row.mtype,
          map: row.map,
          lastSeenAtMs: null,
          lastCount: 0,
          depletedAtMs: null,
          observedRespawnMs: null
        };
        const count = Number(row.visibleSafeCount || 0);
        if (prior.lastCount > 0 && count === 0 && prior.depletedAtMs == null) {
          prior.depletedAtMs = now;
          this.metrics.depletionEvents += 1;
        }
        if (prior.lastCount === 0 && count > 0 && prior.depletedAtMs != null) {
          prior.observedRespawnMs = Math.max(0, now - prior.depletedAtMs);
          prior.depletedAtMs = null;
          this.metrics.respawnsObserved += 1;
        }
        if (count > 0) prior.lastSeenAtMs = now;
        prior.lastCount = count;
        this.observations.set(row.key, prior);
        row.observation = clone(prior);
      }

      if (this.currentSelection && !seen.has(this.currentSelection.key)) {
        const prior = this.observations.get(this.currentSelection.key);
        if (prior && prior.lastCount > 0) {
          prior.lastCount = 0;
          if (prior.depletedAtMs == null) {
            prior.depletedAtMs = now;
            this.metrics.depletionEvents += 1;
          }
          this.observations.set(prior.key, prior);
        }
      }
    }

    _damageType(character) {
      const live = cleanText(character && (character.damageType || character.damage_type) || '', 60).toLowerCase();
      if (live) return live;
      const ctype = cleanText(character && character.ctype || '', 60).toLowerCase();
      if (ctype === 'mage' || ctype === 'priest') return 'magical';
      if (['warrior', 'ranger', 'rogue', 'paladin'].includes(ctype)) return 'physical';
      return null;
    }

    _expectedHitChance(character, candidate) {
      const definition = candidate && candidate.definition || {};
      const damageType = this._damageType(character);
      const avoidance = Math.max(0, Math.min(100, finite(definition.avoidance) || 0));
      let chance = 1 - avoidance / 100;
      if (damageType === 'physical') {
        const evasion = Math.max(0, Math.min(100, finite(definition.evasion) || 0));
        chance *= 1 - evasion / 100;
      }
      return clamp(chance);
    }

    _rawMetrics(character, candidate) {
      const definition = candidate.definition || {};
      const attack = Math.max(1, finite(character.attack) || 1);
      const frequency = Math.max(0.1, finite(character.frequency) || 1);
      const expectedHitChance = candidate.expectedHitChance == null
        ? this._expectedHitChance(character, candidate)
        : clamp(candidate.expectedHitChance);
      const dps = attack * frequency * expectedHitChance;
      const hp = finite(definition.hp);
      const killSeconds = hp != null && hp > 0 ? Math.max(0.25, hp / dps) : null;
      const xp = Math.max(0, finite(definition.xp) || 0);
      const gold = Math.max(0, finite(definition.gold) || 0);
      const dropSignal = Math.max(0, finite(definition.dropSignal) || 0);
      const visible = Math.max(0, Number(candidate.visibleSafeCount) || 0);
      const spawn = Math.max(0, finite(candidate.spawnCount) || 0);
      const density = visible > 0 ? visible : spawn * 0.55;
      const travelDistance = distance(character, candidate);
      const speed = Math.max(1, finite(character.speed) || 1);
      const travelSeconds = travelDistance == null ? null : travelDistance / speed;
      const observedRespawn = candidate.observation && finite(candidate.observation.observedRespawnMs);
      const declaredRespawn = finite(candidate.respawn);
      const respawnSignal = observedRespawn != null
        ? 1 / (1 + observedRespawn / 30000)
        : declaredRespawn != null
          ? 1 / (1 + Math.max(0, declaredRespawn) / 30)
          : 0.5;
      return {
        xpPerSecond: killSeconds == null ? 0 : xp / killSeconds,
        goldPerSecond: killSeconds == null ? 0 : gold / killSeconds,
        dropSignal,
        expectedHitChance,
        density,
        travelSeconds: travelSeconds == null ? 999 : travelSeconds,
        respawnSignal,
        competitionSignal: 1 / (1 + Math.max(0, Number(candidate.competitors) || 0)),
        safetyConfidence: visible > 0 ? 1 : 0.55
      };
    }

    _scoreCandidates(character, candidates) {
      const rows = candidates.map(candidate => ({ ...candidate, raw: this._rawMetrics(character, candidate) }));
      const max = name => Math.max(0.000001, ...rows.map(row => Number(row.raw[name]) || 0));
      const xpMax = max('xpPerSecond');
      const goldMax = max('goldPerSecond');
      const dropMax = max('dropSignal');
      const densityMax = max('density');

      for (const row of rows) {
        const components = {
          xp: clamp(row.raw.xpPerSecond / xpMax),
          gold: clamp(row.raw.goldPerSecond / goldMax),
          drops: dropMax <= 0.000001 ? 0.5 : clamp(row.raw.dropSignal / dropMax),
          density: clamp(row.raw.density / Math.max(1, densityMax)),
          travel: 1 / (1 + Math.max(0, row.raw.travelSeconds) / 12),
          respawn: clamp(row.raw.respawnSignal),
          competition: clamp(row.raw.competitionSignal),
          safety: clamp(row.raw.safetyConfidence)
        };
        row.components = components;
        row.score = Number((100 * (
          components.xp * 0.24
          + components.gold * 0.12
          + components.drops * 0.10
          + components.density * 0.20
          + components.travel * 0.10
          + components.respawn * 0.08
          + components.competition * 0.06
          + components.safety * 0.10
        )).toFixed(2));
      }
      rows.sort((a, b) => b.score - a.score || b.visibleSafeCount - a.visibleSafeCount || String(a.key).localeCompare(String(b.key)));
      return rows;
    }

    _filteredCandidates(rows, character) {
      const preferred = new Set(this.session && this.session.preferredTypes || []);
      const excluded = new Set(this.session && this.session.excludedTypes || []);
      return rows.filter(row => {
        if (excluded.has(row.mtype)) return false;
        if (preferred.size && !preferred.has(row.mtype)) return false;
        const expectedHitChance = this._expectedHitChance(character, row);
        row.expectedHitChance = expectedHitChance;
        if (expectedHitChance < this.config.minExpectedHitChance) return false;
        return true;
      });
    }

    plan() {
      this.metrics.decisions += 1;
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) return this._rememberPlan({ state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE', candidates: [] });
      if (character.rip === true) return this._rememberPlan({ state: 'BLOCKED', reason: 'CHARACTER_DEAD', candidates: [] });
      if (String(character.ctype || '').toLowerCase() === 'merchant') {
        return this._rememberPlan({ state: 'OBSERVER_ONLY', reason: 'LOGISTICS_ROLE_NO_FARMING', candidates: [] });
      }

      if (this.party && typeof this.party.status === 'function') {
        const party = this.party.status();
        const foreign = party && party.party && Array.isArray(party.party.foreignMemberNames)
          ? party.party.foreignMemberNames.slice()
          : [];
        if (foreign.length) {
          this.metrics.foreignPartyBlocks += 1;
          return this._rememberPlan({
            state: 'BLOCKED',
            reason: 'H9_FOREIGN_PARTY_BLOCK',
            foreign,
            candidates: []
          });
        }
      }

      const live = this._clusterSafeVisible(character);
      const catalog = this._catalogCandidates(character, live);
      let candidates = this._filteredCandidates([...live, ...catalog], character);
      this._observeCandidates(candidates);
      candidates = this._scoreCandidates(character, candidates);
      this.metrics.candidateRows += candidates.length;
      if (!candidates.length) {
        this.metrics.unsafeBlocks += 1;
        return this._rememberPlan({ state: 'NO_CANDIDATE', reason: 'H9_NO_SAFE_OR_KNOWN_CURRENT_MAP_SPOT', candidates: [] });
      }

      const now = this.now();
      let selected = candidates[0];
      let reason = 'H9_BEST_SCORE';
      let switchAllowed = true;
      const current = this.currentSelection
        ? candidates.find(row => row.key === this.currentSelection.key)
        : null;

      if (!current && this.currentSelection) {
        const observation = this.observations.get(this.currentSelection.key);
        const depletedAtMs = observation && finite(observation.depletedAtMs);
        const depletionAgeMs = depletedAtMs == null ? null : Math.max(0, now - depletedAtMs);
        if (depletionAgeMs != null && depletionAgeMs < this.config.depletionGraceMs) {
          this.metrics.holds += 1;
          return this._rememberPlan({
            state: 'WAITING_RESPAWN',
            reason: 'H9_DEPLETION_GRACE',
            selected: null,
            candidates: candidates.slice(0, 12),
            switchAllowed: false,
            currentKey: this.currentSelection.key,
            depletionAgeMs,
            depletionGraceMs: this.config.depletionGraceMs
          });
        }

        const recentPrevious = this.history.length >= 2 ? this.history[this.history.length - 2] : null;
        const returnPingPong = recentPrevious
          && recentPrevious.key === selected.key
          && now - Number(recentPrevious.atMs || 0) <= this.config.pingPongWindowMs;
        if (returnPingPong) {
          const baselineScore = Number(this.currentSelection.score || 0);
          const improvement = (Number(selected.score || 0) - baselineScore) / Math.max(1, baselineScore);
          if (improvement < this.config.switchImprovementRatio * 2) {
            const alternative = candidates.find(row => row.key !== recentPrevious.key);
            this.metrics.pingPongBlocks += 1;
            this.metrics.holds += 1;
            if (alternative) {
              selected = alternative;
              reason = 'H9_ANTI_PINGPONG_REROUTE';
            } else {
              return this._rememberPlan({
                state: 'WAITING_RESPAWN',
                reason: 'H9_ANTI_PINGPONG',
                selected: null,
                candidates: candidates.slice(0, 12),
                switchAllowed: false,
                currentKey: this.currentSelection.key
              });
            }
          }
        }
      }

      if (current && selected.key !== current.key) {
        const heldMs = Math.max(0, now - Number(this.currentSelection.selectedAtMs || 0));
        const sinceSwitch = Math.max(0, now - Number(this.currentSelection.lastSwitchAtMs || this.currentSelection.selectedAtMs || 0));
        const improvement = (selected.score - current.score) / Math.max(1, current.score);
        const recentPrevious = this.history.length >= 2 ? this.history[this.history.length - 2] : null;
        const pingPong = recentPrevious
          && recentPrevious.key === selected.key
          && now - Number(recentPrevious.atMs || 0) <= this.config.pingPongWindowMs;

        if (heldMs < this.config.minHoldMs) {
          selected = current;
          reason = 'H9_HOLD_MIN_DURATION';
          switchAllowed = false;
          this.metrics.holds += 1;
        } else if (sinceSwitch < this.config.switchCooldownMs) {
          selected = current;
          reason = 'H9_SWITCH_COOLDOWN';
          switchAllowed = false;
          this.metrics.holds += 1;
        } else if (pingPong && improvement < this.config.switchImprovementRatio * 2) {
          selected = current;
          reason = 'H9_ANTI_PINGPONG';
          switchAllowed = false;
          this.metrics.holds += 1;
          this.metrics.pingPongBlocks += 1;
        } else if (improvement < this.config.switchImprovementRatio) {
          selected = current;
          reason = 'H9_IMPROVEMENT_TOO_SMALL';
          switchAllowed = false;
          this.metrics.holds += 1;
        }
      }

      return this._rememberPlan({
        state: selected.visibleSafeCount > 0 ? 'FARM_READY' : 'TRAVEL_RECOMMENDED',
        reason,
        selected,
        candidates: candidates.slice(0, 12),
        switchAllowed,
        currentKey: this.currentSelection && this.currentSelection.key || null
      });
    }

    _rememberPlan(plan) {
      this.lastPlan = { at: new Date().toISOString(), ...clone(plan) };
      return clone(this.lastPlan);
    }

    _movementStatus() {
      return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null;
    }

    _farmingStatus() {
      return this.farming && typeof this.farming.status === 'function' ? this.farming.status() : null;
    }

    _ownedMovement(status = this._movementStatus()) {
      const order = status && status.activeOrder;
      return !!(order && String(order.owner || '') === 'farm-intelligence-h9');
    }

    _delegatedCombatMovement(status = this._movementStatus(), farmStatus = this._farmingStatus()) {
      const order = status && status.activeOrder;
      if (!order || !this._ownedFarming(farmStatus)) return false;
      return String(order.owner || '').startsWith('combat-h5');
    }

    _ownedFarming(status = this._farmingStatus()) {
      const session = status && status.session;
      return !!(status && status.active && session && String(session.owner || '') === 'farm-intelligence-h9');
    }

    _stopOwnedMovement(reason) {
      const movement = this._movementStatus();
      if (!this._ownedMovement(movement)) return false;
      try { this.movement.cancel(reason); } catch (_) {}
      return true;
    }

    _stopOwnedFarming(reason) {
      const farm = this._farmingStatus();
      if (!this._ownedFarming(farm)) return false;
      try { this.farming.stopSession(reason); } catch (_) {}
      this.metrics.farmingStops += 1;
      return true;
    }

    _suspend(reason) {
      this.suspendedReason = cleanText(reason, 240) || 'H9_SUSPENDED';
      this._stopOwnedFarming(this.suspendedReason);
      this._stopOwnedMovement(this.suspendedReason);
      this.lastAction = { at: new Date().toISOString(), type: 'SUSPEND', reason: this.suspendedReason };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _samePhysicalSpot(a, b) {
      if (!a || !b) return false;
      if (a.map && b.map && String(a.map) !== String(b.map)) return false;
      if (a.mtype && b.mtype && String(a.mtype) !== String(b.mtype)) return false;
      const d = distance(a, b);
      return d != null && d <= this.config.spotBucket * 1.25;
    }

    _recordSelection(candidate, reason) {
      const now = this.now();
      const previous = this.currentSelection;
      const changed = !!(previous && !this._samePhysicalSpot(previous, candidate));
      this.currentSelection = {
        key: candidate.key,
        map: candidate.map,
        mtype: candidate.mtype,
        x: candidate.x,
        y: candidate.y,
        score: candidate.score,
        source: candidate.source,
        selectedAt: new Date().toISOString(),
        selectedAtMs: changed || !previous ? now : previous.selectedAtMs,
        lastSwitchAtMs: changed ? now : (previous && previous.lastSwitchAtMs || now),
        reason
      };
      if (changed) this.metrics.switches += 1;
      if (!previous || changed) {
        this.history.push({ key: candidate.key, mtype: candidate.mtype, score: candidate.score, atMs: now, reason });
        if (this.history.length > 12) this.history.shift();
      }
      return changed;
    }

    _apply(plan) {
      if (!this.session || !this.session.enabled) return { state: 'IDLE', reason: 'H9_AUTONOMY_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (plan && plan.state === 'BLOCKED') {
        return this._suspend(plan.reason || 'H9_PLAN_BLOCKED');
      }
      if (!plan || !plan.selected) return { state: plan && plan.state || 'BLOCKED', reason: plan && plan.reason || 'H9_PLAN_UNAVAILABLE' };

      const game = this.game.snapshot();
      const character = game && game.character;
      if (!character) return this._suspend('CHARACTER_UNAVAILABLE');

      const movement = this._movementStatus();
      if (movement && movement.lastOrder && String(movement.lastOrder.owner || '') === 'farm-intelligence-h9'
        && ['UNKNOWN', 'FAILED_SAFE'].includes(String(movement.lastOrder.state || ''))) {
        this.metrics.movementUnknown += 1;
        return this._suspend('H9_MOVEMENT_' + String(movement.lastOrder.state));
      }
      if (this._ownedMovement(movement)) {
        return { state: 'TRAVELLING', reason: 'H9_TRAVEL_IN_PROGRESS', order: clone(movement.activeOrder) };
      }
      const farmDuringMovement = this._farmingStatus();
      if (this._delegatedCombatMovement(movement, farmDuringMovement)) {
        return {
          state: 'FARMING',
          reason: 'H9_DELEGATED_COMBAT_MOVEMENT',
          order: clone(movement.activeOrder),
          monsterType: farmDuringMovement.session && farmDuringMovement.session.monsterType || null
        };
      }
      if (movement && movement.activeOrder) {
        this.metrics.ownershipBlocks += 1;
        return this._suspend('H9_FOREIGN_MOVEMENT_OWNERSHIP');
      }

      const candidate = plan.selected;
      const changed = this._recordSelection(candidate, plan.reason);
      const d = distance(character, candidate);
      const needsTravel = candidate.map && character.map && String(candidate.map) !== String(character.map)
        || (d != null && d > this.config.arrivalRadius);

      if (needsTravel && this.session.allowTravel) {
        this._stopOwnedFarming('H9_SPOT_TRAVEL');
        const activeFarm = this._farmingStatus();
        if (activeFarm && activeFarm.active && !this._ownedFarming(activeFarm)) {
          this.metrics.ownershipBlocks += 1;
          return this._suspend('H9_FOREIGN_FARMING_OWNERSHIP');
        }
        const destination = { map: candidate.map || character.map, x: candidate.x, y: candidate.y };
        const move = this.movement.smartMove(destination, {
          owner: 'farm-intelligence-h9',
          arrivalRadius: this.config.arrivalRadius
        });
        if (!move || move.accepted !== true) {
          if (move && String(move.reason || '').includes('UNKNOWN')) {
            this.metrics.movementUnknown += 1;
            return this._suspend(move.reason);
          }
          this.lastAction = { at: new Date().toISOString(), type: 'TRAVEL_REJECTED', candidate: candidate.key, result: clone(move) };
          return { state: 'WAITING', reason: move && move.reason || 'H9_TRAVEL_REJECTED', result: clone(move) };
        }
        this.metrics.travelOrders += 1;
        this.lastAction = { at: new Date().toISOString(), type: 'TRAVEL', candidate: candidate.key, destination, changed };
        return { state: 'TRAVELLING', reason: 'H9_MOVING_TO_SELECTED_SPOT', destination, changed };
      }

      const farm = this._farmingStatus();
      if (farm && farm.active && !this._ownedFarming(farm)) {
        this.metrics.ownershipBlocks += 1;
        return this._suspend('H9_FOREIGN_FARMING_OWNERSHIP');
      }
      if (this._ownedFarming(farm)) {
        const currentType = farm.session && farm.session.monsterType || null;
        if (!changed && String(currentType || '') === String(candidate.mtype || '')) {
          this.lastAction = { at: new Date().toISOString(), type: 'HOLD_FARM', candidate: candidate.key, monsterType: candidate.mtype };
          return { state: 'FARMING', reason: 'H9_EXISTING_FARM_MATCHES', monsterType: candidate.mtype };
        }
        this._stopOwnedFarming('H9_SWITCH_FARM_TARGET');
      }

      const start = this.farming.startSession({
        owner: 'farm-intelligence-h9',
        monsterType: candidate.mtype,
        partyAssist: true,
        maxAcquireDistance: this.config.visibleAcquireDistance
      });
      if (!start || start.accepted !== true) {
        this.lastAction = { at: new Date().toISOString(), type: 'FARM_START_REJECTED', candidate: candidate.key, result: clone(start) };
        return { state: 'WAITING', reason: start && start.reason || 'H9_FARM_START_REJECTED', result: clone(start) };
      }
      this.metrics.farmingStarts += 1;
      this.lastAction = { at: new Date().toISOString(), type: 'FARM_START', candidate: candidate.key, monsterType: candidate.mtype, changed };
      return { state: 'FARMING', reason: 'H9_SELECTED_FARM_STARTED', monsterType: candidate.mtype, changed };
    }

    tick() {
      if (this.heartbeat) {
        try {
          this.heartbeat({
            phase: 'farm-intelligence',
            active: !!(this.session && this.session.enabled),
            selection: this.currentSelection && this.currentSelection.key || null
          });
        } catch (_) {}
      }
      if (!this.moduleActive || !this.session || !this.session.enabled) return { state: 'IDLE' };
      const plan = this.plan();
      return this._apply(plan);
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        active: !!(this.session && this.session.enabled),
        session: clone(this.session),
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        currentSelection: clone(this.currentSelection),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        history: clone(this.history),
        observations: [...this.observations.values()].slice(-20).map(clone),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.FarmIntelligenceController = FarmIntelligenceController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
