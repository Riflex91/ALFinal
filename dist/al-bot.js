/* AL Bot 0.3.0-h3 | generated file | do not edit dist directly */
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
      return { name: cleanText(c.name, 80), ctype: cleanText(c.ctype || c.type || '', 40).toLowerCase(), online: true, state: 'self' };
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
      const farmers = characters.filter(row => COMBAT_CLASSES.has(row.ctype));
      const merchants = characters.filter(row => row.ctype === 'merchant');
      this.last = {
        observedAt: nowIso(),
        source: account.available ? 'get_characters+get_active_characters' : active.available ? 'get_active_characters-fallback' : 'local-only',
        accountStateAvailable: account.available,
        activeStateAvailable: active.available,
        local,
        characters,
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

    _character() {
      return this._read('character');
    }

    _entities() {
      const value = this._read('entities');
      return value && typeof value === 'object' ? value : {};
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

    _entityByIdOrName(id) {
      if (id == null) return null;
      const wanted = String(id);
      for (const entity of Object.values(this._entities())) {
        if (!entity) continue;
        if (String(entity.id || '') === wanted || String(entity.name || '') === wanted) return entity;
      }
      return null;
    }

    _normalizeEntity(entity, characterMap) {
      if (!entity) return null;
      const pos = this._position(entity);
      return {
        id: entity.id == null ? null : String(entity.id),
        name: entity.name == null ? null : cleanText(entity.name, 120),
        type: entity.type == null ? null : cleanText(entity.type, 80),
        mtype: entity.mtype == null ? null : cleanText(entity.mtype, 120),
        player: safeBoolean(entity.player),
        npc: safeBoolean(entity.npc) || entity.type === 'npc',
        map: entity.map || characterMap || null,
        x: pos.x,
        y: pos.y,
        hp: finite(entity.hp),
        maxHp: finite(entity.max_hp),
        targetId: entity.target == null ? null : String(entity.target),
        dead: safeBoolean(entity.dead) || safeBoolean(entity.rip)
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
      const targetRaw = this._entityByIdOrName(targetId);
      const target = this._normalizeEntity(targetRaw, character.map || null);
      if (target && pos.x != null && pos.y != null && target.x != null && target.y != null) {
        target.distance = Math.hypot(pos.x - target.x, pos.y - target.y);
      } else if (target) {
        target.distance = null;
      }

      const entities = Object.values(this._entities()).filter(Boolean);
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
          range: finite(character.range),
          speed: finite(character.speed),
          frequency: finite(character.frequency),
          moving: safeBoolean(character.moving),
          rip: safeBoolean(character.rip),
          targetId
        },
        target,
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
  if (!ns || !ns.Scheduler) throw new Error('ALBOT_SCHEDULER_MISSING');

  class ALBotRuntime {
    constructor(options = {}) {
      this.version = options.version || '0.3.0-h3';
      this.root = options.root || root;
      this.bootCount = Math.max(1, Number(options.bootCount) || 1);
      this.replacedPrevious = options.replacedPrevious === true;
      this.loadedAt = new Date().toISOString();
      this.startedAt = null;
      this.running = false;
      this.runEpoch = 0;
      this.bus = new ns.EventBus();
      this.storage = new ns.StorageAdapter(this.root);
      this.logger = new ns.Logger({ bus: this.bus, limit: 400 });
      this.stopLatch = new ns.EmergencyStop({ storage: this.storage, logger: this.logger, bus: this.bus });
      this.scheduler = new ns.Scheduler({ root: this.root, logger: this.logger, bus: this.bus });
      this.modules = new ns.ModuleRegistry({ logger: this.logger, scheduler: this.scheduler });
      this.scheduler.setErrorHandler(details => this.modules.handleResourceError(details));
      this.goals = new ns.GoalService({ storage: this.storage, logger: this.logger });
      this.game = new ns.AdventureLandGameAdapter({ root: this.root, logger: this.logger });
      this.knowledge = new ns.KnowledgeService({ logger: this.logger, storage: this.storage });
      this.knowledgeProvider = new ns.WindowsBridgeKnowledgeProvider({ root: this.root, logger: this.logger });
      this.knowledge.setProvider(this.knowledgeProvider);
      this.roster = new ns.CharacterRosterService({ root: this.root, logger: this.logger });
      this.ui = null;
      this.lastError = null;
      this._destroyed = false;
      this._registerCoreModules();
      this._installErrorCapture();
      this.logger.info('AL Bot Runtime erstellt', {
        version: this.version,
        bootCount: this.bootCount,
        replacedPrevious: this.replacedPrevious,
        stopLatched: this.stopLatch.status().latched
      });
    }

    _registerCoreModules() {
      this.modules.register({
        id: 'runtime-health',
        title: 'Runtime Health',
        version: '0.3.0',
        watchdogMs: 4000,
        start: context => {
          context.scope.interval('heartbeat', () => {
            context.heartbeat({
              at: new Date().toISOString(),
              running: this.running,
              runEpoch: this.runEpoch
            });
            try { this.roster.refresh(); } catch (_) {}
          }, 1000, { immediate: true });
        },
        stop: () => {},
        status: () => ({
          purpose: 'runtime-heartbeat',
          runEpoch: this.runEpoch
        })
      });
    }

    _installErrorCapture() {
      if (!this.root || typeof this.root.addEventListener !== 'function') return;
      this._errorHandler = event => {
        const error = event && event.error;
        this.lastError = {
          at: new Date().toISOString(),
          type: 'error',
          message: String(error && error.message || event && event.message || 'Unknown error'),
          stack: error && error.stack || null
        };
        this.logger.error('Unbehandelter JavaScript-Fehler', this.lastError);
      };
      this._rejectionHandler = event => {
        const reason = event && event.reason;
        this.lastError = {
          at: new Date().toISOString(),
          type: 'unhandledrejection',
          message: String(reason && reason.message || reason || 'Unhandled rejection'),
          stack: reason && reason.stack || null
        };
        this.logger.error('Unhandled Promise Rejection', this.lastError);
      };
      this.root.addEventListener('error', this._errorHandler);
      this.root.addEventListener('unhandledrejection', this._rejectionHandler);
    }

    _removeErrorCapture() {
      if (!this.root || typeof this.root.removeEventListener !== 'function') return;
      if (this._errorHandler) this.root.removeEventListener('error', this._errorHandler);
      if (this._rejectionHandler) this.root.removeEventListener('unhandledrejection', this._rejectionHandler);
      this._errorHandler = null;
      this._rejectionHandler = null;
    }

    _runtimeContext() {
      return { runtime: this };
    }

    async start() {
      if (this._destroyed) throw new Error('ALBOT_RUNTIME_DESTROYED');
      if (this.stopLatch.status().latched) throw new Error('ALBOT_START_BLOCKED_BY_EMERGENCY_STOP');
      if (this.running) return this.status();

      this.running = true;
      this.runEpoch += 1;
      this.startedAt = new Date().toISOString();
      this.scheduler.start();
      try { this.roster.refresh(); } catch (_) {}

      await this.modules.startAll(this._runtimeContext());
      this.scheduler.interval('runtime', 'module-watchdog', () => {
        this.modules.checkWatchdogs();
      }, 1000, { immediate: true });

      this.logger.info('AL Bot gestartet', {
        runEpoch: this.runEpoch,
        schedulerGeneration: this.scheduler.status().generation
      });
      this.bus.emit('runtime', this.status());
      return this.status();
    }

    async stop(reason = 'MANUAL_STOP') {
      if (this._destroyed) return this.status();
      this.running = false;
      await this.modules.stopAll(reason);
      this.scheduler.stop(reason);
      this.logger.warn('AL Bot gestoppt', { reason, runEpoch: this.runEpoch });
      this.bus.emit('runtime', this.status());
      return this.status();
    }

    async emergencyStop(reason = 'MANUAL_EMERGENCY_STOP') {
      const stop = this.stopLatch.latch(reason);
      this.running = false;

      // Die Notbremse stoppt zuerst zentral alle Timer/Listener. Modul-Stop-Hooks
      // laufen danach nur noch zur fachlichen Bereinigung.
      this.scheduler.stop('EMERGENCY_STOP');
      await this.modules.stopAll('EMERGENCY_STOP');

      this.bus.emit('emergency-stop', stop);
      return this.status();
    }

    resetEmergencyStop() {
      this.stopLatch.reset();
      return this.status();
    }

    async restartModule(id, reason = 'MANUAL_MODULE_RESTART') {
      if (!this.running || !this.scheduler.status().enabled) throw new Error('ALBOT_RUNTIME_NOT_RUNNING');
      const result = await this.modules.restartOne(id, this._runtimeContext(), reason);
      this.bus.emit('module', result);
      return result;
    }

    async startModule(id) {
      if (!this.running || !this.scheduler.status().enabled) throw new Error('ALBOT_RUNTIME_NOT_RUNNING');
      const result = await this.modules.startOne(id, this._runtimeContext());
      this.bus.emit('module', result);
      return result;
    }

    async stopModule(id, reason = 'MANUAL_MODULE_STOP') {
      const result = await this.modules.stopOne(id, reason);
      this.bus.emit('module', result);
      return result;
    }

    actionAllowed(action = 'action') {
      if (!this.running) return false;
      if (!this.scheduler.status().enabled) return false;
      if (this.stopLatch.status().latched) return false;
      return true;
    }

    assertActionAllowed(action = 'action') {
      if (!this.running || !this.scheduler.status().enabled) throw new Error('ALBOT_RUNTIME_NOT_RUNNING:' + action);
      return this.stopLatch.assertAllowed(action);
    }

    status() {
      let roster;
      try { roster = this.roster.status(); } catch (_) { roster = null; }
      return {
        product: 'AL Bot',
        version: this.version,
        running: this.running,
        loadedAt: this.loadedAt,
        startedAt: this.startedAt,
        runEpoch: this.runEpoch,
        bootCount: this.bootCount,
        replacedPrevious: this.replacedPrevious,
        emergencyStop: this.stopLatch.status(),
        scheduler: this.scheduler.status(),
        modules: this.modules.list(),
        game: this.game.status(),
        knowledge: this.knowledge.status(),
        roster,
        goals: this.goals.list(),
        strategicPriorities: this.goals.getPriorities(),
        lastError: ns.helpers.clone(this.lastError)
      };
    }

    diagnostics() {
      const game = this.game.snapshot();
      return {
        schemaVersion: 3,
        createdAt: new Date().toISOString(),
        runtime: this.status(),
        game,
        character: game && game.character ? ns.helpers.clone(game.character) : null,
        knowledgeSnapshot: this.knowledge.snapshot(),
        logs: this.logger.list(160),
        userAgent: this.root && this.root.navigator && this.root.navigator.userAgent || null
      };
    }

    selfTest() {
      const checks = [];
      const push = (name, ok, details) => checks.push({ name, ok: !!ok, details: details || null });
      const roster = this.roster.refresh();
      const scheduler = this.scheduler.status();
      push('runtime-created', !!this.version, { version: this.version });
      push('emergency-stop-api', typeof this.emergencyStop === 'function' && typeof this.resetEmergencyStop === 'function');
      push('goal-service', Array.isArray(this.goals.list()));
      push('game-adapter', !!this.game.status() && typeof this.game.snapshot === 'function', this.game.status());
      push('knowledge-service', !!this.knowledge.status());
      push('windows-bridge-provider-readonly', this.knowledge.status().provider && this.knowledge.status().provider.readOnly === true, this.knowledge.status().provider);
      push('dynamic-roster-no-hardcoded-names', roster.hardcodedNamesRequired === false, {
        source: roster.source,
        farmers: roster.farmers.map(x => ({ name: x.name, ctype: x.ctype }))
      });
      push('central-scheduler', !!scheduler && typeof scheduler.totalResources === 'number', scheduler);
      push('module-lifecycle', typeof this.modules.startOne === 'function' && typeof this.modules.restartOne === 'function' && typeof this.modules.stopOne === 'function');
      push('hot-reload-cleanup', typeof this.prepareHotReload === 'function');
      return { passed: checks.every(c => c.ok), at: new Date().toISOString(), checks };
    }

    async runStabilityProbe() {
      if (!this.running || !this.scheduler.status().enabled) {
        return { passed: false, reason: 'RUNTIME_NOT_RUNNING', at: new Date().toISOString() };
      }

      const id = 'h2-runtime-probe';
      if (this.modules.has(id)) {
        try { await this.modules.stopOne(id, 'PROBE_RESET'); } catch (_) {}
        try { this.modules.unregister(id, 'PROBE_RESET'); } catch (_) {}
      }

      let beats = 0;
      this.modules.register({
        id,
        title: 'H2 Runtime Probe',
        version: '1.0.0',
        watchdogMs: 1000,
        start: context => {
          context.scope.interval('probe-heartbeat', () => {
            beats += 1;
            context.heartbeat({ beats });
          }, 50, { immediate: true });
        },
        stop: () => {},
        status: () => ({ beats })
      });

      const resourceCounts = [];
      await this.modules.startOne(id, this._runtimeContext());
      resourceCounts.push(this.scheduler.ownerStatus('module:' + id).resources.length);

      for (let i = 0; i < 3; i += 1) {
        await this.modules.restartOne(id, this._runtimeContext(), 'H2_PROBE_RESTART_' + (i + 1));
        resourceCounts.push(this.scheduler.ownerStatus('module:' + id).resources.length);
      }

      await this.modules.stopOne(id, 'H2_PROBE_DONE');
      const resourcesAfterStop = this.scheduler.ownerStatus('module:' + id).resources.length;
      const moduleAfterStop = this.modules.describe(id);
      this.modules.unregister(id, 'H2_PROBE_DONE');

      const passed = resourceCounts.every(count => count === 1)
        && resourcesAfterStop === 0
        && moduleAfterStop
        && moduleAfterStop.state === 'STOPPED';

      const result = {
        passed,
        at: new Date().toISOString(),
        restartResourceCounts: resourceCounts,
        resourcesAfterStop,
        beats,
        scheduler: this.scheduler.status()
      };
      this.logger.info('H2 Runtime-Stabilitätstest abgeschlossen', result);
      return result;
    }

    prepareHotReload(reason = 'HOT_RELOAD') {
      if (this._destroyed) return;
      this.running = false;

      // Zuerst alle zentral verwalteten Ressourcen synchron stoppen. Dadurch kann
      // ein neu geladenes Bundle niemals alte Timer/Listener weiterlaufen lassen.
      this.scheduler.stop(reason);
      this.modules.forceCleanup(reason);

      try { if (this.ui && typeof this.ui.destroy === 'function') this.ui.destroy(); } catch (_) {}
      this.ui = null;
      this._removeErrorCapture();
      this.bus.clear();
      this._destroyed = true;
    }

    destroy() {
      this.prepareHotReload('DESTROY');
    }
  }

  ns.ALBotRuntime = ALBotRuntime;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function formatPosition(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : '-';
  }

  class ControlCenter {
    constructor(runtime) {
      this.runtime = runtime;
      this.root = runtime.root;
      this.uiRoot = this._resolveUiRoot(this.root);
      this.doc = this.uiRoot && this.uiRoot.document ? this.uiRoot.document : this.root.document;
      this.host = null;
      this.interval = null;
      this.activeTab = 'overview';
      this.minimized = false;
      this.devResult = null;
      this._offLog = null;
      this._dragCleanup = null;
    }

    _resolveUiRoot(start) {
      let current = start;
      let best = null;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        try {
          if (current.document && current.document.body) best = current;
        } catch (_) {
          break;
        }
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
      return best || start;
    }

    mount() {
      if (!this.doc || !this.doc.body) return false;
      this.destroy();
      const host = this.doc.createElement('div');
      host.id = 'albot-control-center';
      host.innerHTML = this._shell();
      this.doc.body.appendChild(host);
      this.host = host;
      this._bind();
      this.render();
      const timerRoot = this.uiRoot && typeof this.uiRoot.setInterval === 'function' ? this.uiRoot : this.root;
      this.intervalRoot = timerRoot;
      this.interval = timerRoot.setInterval(() => this._tick(), 1000);
      this._offLog = this.runtime.bus.on('log', () => this.renderLogs());
      return true;
    }

    _shell() {
      return `<style>
#albot-control-center{position:fixed;right:18px;top:18px;width:min(700px,calc(100vw - 36px));height:min(780px,calc(100vh - 36px));min-width:min(480px,calc(100vw - 36px));min-height:min(380px,calc(100vh - 36px));max-width:calc(100vw - 8px);max-height:calc(100vh - 8px);z-index:2147483647;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:12px/1.35 Arial,sans-serif;overflow:hidden;resize:both;display:flex;flex-direction:column}
#albot-control-center *{box-sizing:border-box}#albot-control-center button,#albot-control-center input,#albot-control-center select{font:inherit}
#albot-control-center.albot-minimized{height:auto!important;min-height:0!important;resize:none}
#albot-control-center.albot-minimized .albot-tabs,#albot-control-center.albot-minimized .albot-body,#albot-control-center.albot-minimized .albot-footer{display:none}
.albot-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0b1220;border-bottom:1px solid #374151;cursor:move;user-select:none;flex:none}.albot-title{font-weight:800;font-size:15px;flex:1}.albot-state{font-size:11px;padding:3px 7px;border-radius:999px;background:#374151}.albot-window-btn{background:#374151;color:#fff;border:0;border-radius:7px;padding:6px 9px;font-weight:800;cursor:pointer;line-height:1}.albot-window-btn:hover{background:#4b5563}.albot-stop{background:#b91c1c;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer}.albot-stop:hover{background:#dc2626}
.albot-tabs{display:flex;gap:2px;padding:6px;background:#0f172a;border-bottom:1px solid #374151;overflow:auto;flex:none}.albot-tab{background:#1f2937;color:#d1d5db;border:0;border-radius:6px;padding:6px 9px;cursor:pointer;white-space:nowrap}.albot-tab.active{background:#4b5563;color:white}
.albot-body{padding:10px;overflow:auto;flex:1;min-height:0}.albot-panel{display:none}.albot-panel.active{display:block}.albot-card{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:8px;margin-bottom:8px}.albot-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.albot-k{color:#9ca3af}.albot-v{font-weight:700;word-break:break-word}.albot-row{display:flex;gap:6px;align-items:center;margin:6px 0}.albot-row>*{min-width:0}.albot-row input,.albot-row select{flex:1;background:#111827;color:#e5e7eb;border:1px solid #4b5563;border-radius:6px;padding:6px}.albot-btn{background:#374151;color:#fff;border:0;border-radius:6px;padding:6px 9px;cursor:pointer}.albot-btn:hover{background:#4b5563}.albot-btn:disabled{opacity:.45;cursor:not-allowed}.albot-btn.warn{background:#92400e}.albot-btn.danger{background:#991b1b}.albot-stop-warning{margin-bottom:8px;padding:10px;border:1px solid #ef4444;border-radius:8px;background:#451a1a;color:#fecaca;font-weight:700}.albot-goal{border-left:3px solid #6b7280;padding-left:8px;margin:8px 0}.albot-goal-head{display:flex;align-items:center;gap:8px}.albot-goal-title{flex:1;min-width:0}.albot-goal-delete{width:22px;height:22px;padding:0;border:1px solid #ef4444;border-radius:50%;background:#7f1d1d;color:#fff;font-weight:900;line-height:18px;cursor:pointer;flex:none}.albot-goal-delete:hover{background:#dc2626}.albot-small{font-size:11px;color:#9ca3af}.albot-log{white-space:pre-wrap;background:#030712;border-radius:6px;padding:8px;max-height:250px;overflow:auto;font-family:Consolas,monospace}.albot-ok{color:#86efac}.albot-bad{color:#fca5a5}.albot-muted{color:#9ca3af}.albot-priority-grid{display:grid;grid-template-columns:1fr 120px;gap:6px;align-items:center}.albot-footer{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #374151;background:#0b1220;flex:none}
</style>
<div class="albot-head" id="albot-drag-handle"><div class="albot-title">AL BOT</div><span id="albot-state" class="albot-state">STOPPED</span><button id="albot-minimize" class="albot-window-btn" title="Fenster minimieren" aria-label="Fenster minimieren">—</button><button id="albot-emergency" class="albot-stop">STOP</button></div>
<div class="albot-tabs">
<button class="albot-tab active" data-tab="overview">Übersicht</button><button class="albot-tab" data-tab="priorities">Prioritäten</button><button class="albot-tab" data-tab="knowledge">Knowledge</button><button class="albot-tab" data-tab="logs">Logs</button><button class="albot-tab" data-tab="dev">Entwicklung</button>
</div>
<div class="albot-body">
<section id="albot-panel-overview" class="albot-panel active"></section>
<section id="albot-panel-priorities" class="albot-panel"></section>
<section id="albot-panel-knowledge" class="albot-panel"></section>
<section id="albot-panel-logs" class="albot-panel"></section>
<section id="albot-panel-dev" class="albot-panel"></section>
</div>
<div class="albot-footer"><button id="albot-start" class="albot-btn">Start</button><button id="albot-reset-stop-main" class="albot-btn danger" style="display:none">STOP zurücksetzen</button><button id="albot-stop-normal" class="albot-btn warn">Stop</button><button id="albot-copy" class="albot-btn">Fehlerbericht kopieren</button><button id="albot-hide" class="albot-btn">Ausblenden</button></div>`;
    }

    _bind() {
      this.host.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => { this.activeTab = btn.dataset.tab; this._selectTab(); this.render(); }));
      this.host.querySelector('#albot-emergency').addEventListener('click', async () => { await this.runtime.emergencyStop('GUI_EMERGENCY_STOP'); this.render(); });
      this.host.querySelector('#albot-minimize').addEventListener('click', (event) => { event.stopPropagation(); this.toggleMinimized(); });
      this._installDrag();
      this.host.querySelector('#albot-start').addEventListener('click', async () => { try { await this.runtime.start(); } catch (e) { this.runtime.logger.error('Start fehlgeschlagen', { error: e.message }); } this.render(); });
      this.host.querySelector('#albot-reset-stop-main').addEventListener('click', () => { this.runtime.resetEmergencyStop(); this.render(); });
      this.host.querySelector('#albot-stop-normal').addEventListener('click', async () => { await this.runtime.stop('GUI_MODULE_STOP'); this.render(); });
      this.host.querySelector('#albot-copy').addEventListener('click', () => this.copyDiagnostics());
      this.host.querySelector('#albot-hide').addEventListener('click', () => { this.host.style.display = 'none'; });
    }

    _installDrag() {
      const handle = this.host && this.host.querySelector('#albot-drag-handle');
      if (!handle || !this.uiRoot || typeof this.uiRoot.addEventListener !== 'function') return;

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;

      const move = (event) => {
        if (!dragging || !this.host) return;
        const viewportW = Math.max(1, Number(this.uiRoot.innerWidth) || Number(this.doc.documentElement && this.doc.documentElement.clientWidth) || 1);
        const viewportH = Math.max(1, Number(this.uiRoot.innerHeight) || Number(this.doc.documentElement && this.doc.documentElement.clientHeight) || 1);
        const rect = this.host.getBoundingClientRect();
        const maxLeft = Math.max(0, viewportW - Math.min(rect.width, viewportW));
        const maxTop = Math.max(0, viewportH - Math.min(rect.height, viewportH));
        const left = Math.max(0, Math.min(maxLeft, startLeft + event.clientX - startX));
        const top = Math.max(0, Math.min(maxTop, startTop + event.clientY - startY));
        this.host.style.left = left + 'px';
        this.host.style.top = top + 'px';
        this.host.style.right = 'auto';
      };

      const up = () => {
        if (!dragging) return;
        dragging = false;
        if (this.doc && this.doc.body) this.doc.body.style.userSelect = '';
      };

      const down = (event) => {
        if (event.button !== 0 || !this.host) return;
        if (event.target && event.target.closest && event.target.closest('button,input,select,textarea,a')) return;
        const rect = this.host.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        this.host.style.left = rect.left + 'px';
        this.host.style.top = rect.top + 'px';
        this.host.style.right = 'auto';
        if (this.doc && this.doc.body) this.doc.body.style.userSelect = 'none';
        event.preventDefault();
      };

      handle.addEventListener('mousedown', down);
      this.uiRoot.addEventListener('mousemove', move);
      this.uiRoot.addEventListener('mouseup', up);
      this._dragCleanup = () => {
        handle.removeEventListener('mousedown', down);
        this.uiRoot.removeEventListener('mousemove', move);
        this.uiRoot.removeEventListener('mouseup', up);
        if (this.doc && this.doc.body) this.doc.body.style.userSelect = '';
      };
    }

    toggleMinimized(force) {
      if (!this.host) return false;
      this.minimized = typeof force === 'boolean' ? force : !this.minimized;
      this.host.classList.toggle('albot-minimized', this.minimized);
      const button = this.host.querySelector('#albot-minimize');
      if (button) {
        button.textContent = this.minimized ? '□' : '—';
        button.title = this.minimized ? 'Fenster ausklappen' : 'Fenster minimieren';
        button.setAttribute('aria-label', button.title);
      }
      return this.minimized;
    }

    _selectTab() {
      this.host.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === this.activeTab));
      this.host.querySelectorAll('.albot-panel').forEach(panel => panel.classList.toggle('active', panel.id === 'albot-panel-' + this.activeTab));
    }

    _updateHeader(status) {
      const state = this.host.querySelector('#albot-state');
      state.textContent = status.emergencyStop.latched ? 'EMERGENCY STOP' : status.running ? 'RUNNING' : 'STOPPED';
      state.className = 'albot-state ' + (status.emergencyStop.latched ? 'albot-bad' : status.running ? 'albot-ok' : '');
      const startButton = this.host.querySelector('#albot-start');
      const resetButton = this.host.querySelector('#albot-reset-stop-main');
      if (startButton) {
        startButton.disabled = status.emergencyStop.latched === true;
        startButton.title = status.emergencyStop.latched ? 'Start ist blockiert, bis der globale STOP manuell zurückgesetzt wurde.' : '';
      }
      if (resetButton) resetButton.style.display = status.emergencyStop.latched ? '' : 'none';
    }

    _tick() {
      if (!this.host) return;
      this.runtime.roster.refresh();
      const status = this.runtime.status();
      this._updateHeader(status);
      if (this.activeTab === 'overview') this.renderOverview(status);
      if (this.activeTab === 'knowledge') this.renderKnowledge(status);
      if (this.activeTab === 'logs') this.renderLogs();
      if (this.activeTab === 'dev') this.renderDev(status);
    }

    render() {
      if (!this.host) return;
      this.runtime.roster.refresh();
      const status = this.runtime.status();
      this._updateHeader(status);
      this.renderOverview(status);
      this.renderPriorities(status);
      this.renderKnowledge(status);
      this.renderLogs();
      this.renderDev(status);
    }

    renderOverview(status) {
      const panel = this.host.querySelector('#albot-panel-overview');
      const roster = status.roster || { farmers: [], characters: [] };
      const knowledge = status.knowledge || {};
      const game = status.game || { available: false, character: null, target: null };
      const gameCharacter = game.character || {};
      const scheduler = status.scheduler || { enabled: false, totalResources: 0, generation: 0 };
      panel.innerHTML = `${status.emergencyStop.latched ? '<div class="albot-stop-warning">GLOBALER STOP IST AKTIV. Start ist absichtlich blockiert. Zum Fortfahren unten auf „STOP zurücksetzen“ klicken.</div>' : ''}<div class="albot-card"><b>System</b><div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Version</span><div class="albot-v">${esc(status.version)}</div></div>
<div><span class="albot-k">Runtime</span><div class="albot-v">${status.running ? 'RUNNING' : 'STOPPED'}</div></div>
<div><span class="albot-k">STOP</span><div class="albot-v">${status.emergencyStop.latched ? 'AKTIV' : 'bereit'}</div></div>
<div><span class="albot-k">Knowledge</span><div class="albot-v">${knowledge.provider ? esc(knowledge.provider.state || 'IDLE') : 'nicht konfiguriert'}${knowledge.lastKnownGood ? ' · LKG Gen. '+esc(knowledge.lastKnownGood.generation) : ''}</div></div>
<div><span class="albot-k">Scheduler</span><div class="albot-v">${scheduler.enabled ? 'ACTIVE' : 'STOPPED'} · ${esc(scheduler.totalResources)} Ressourcen</div></div>
<div><span class="albot-k">Scheduler Starts</span><div class="albot-v">${esc(scheduler.generation)}</div></div>
<div><span class="albot-k">Boot / Reload</span><div class="albot-v">#${esc(status.bootCount || 1)}${status.replacedPrevious ? ' · Hot Reload' : ''}</div></div>
<div><span class="albot-k">Runtime Starts</span><div class="albot-v">${esc(status.runEpoch || 0)}</div></div>
</div></div>
<div class="albot-card"><b>Live Game Adapter</b><div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Character</span><div class="albot-v">${game.available ? esc(gameCharacter.name || '-')+' ('+esc(gameCharacter.ctype || '-')+')' : 'nicht verfügbar'}</div></div>
<div><span class="albot-k">Map</span><div class="albot-v">${esc(gameCharacter.map || '-')}</div></div>
<div><span class="albot-k">HP / MP</span><div class="albot-v">${esc(gameCharacter.hp)} / ${esc(gameCharacter.maxHp)} · ${esc(gameCharacter.mp)} / ${esc(gameCharacter.maxMp)}</div></div>
<div><span class="albot-k">Position</span><div class="albot-v">x=${esc(formatPosition(gameCharacter.x))} · y=${esc(formatPosition(gameCharacter.y))}</div></div>
<div><span class="albot-k">Target</span><div class="albot-v">${game.target ? esc(game.target.name || game.target.id || '-') : 'keins'}</div></div>
<div><span class="albot-k">Entities</span><div class="albot-v">${esc(game.world && game.world.entityCount != null ? game.world.entityCount : 0)}</div></div>
</div></div>
<div class="albot-card"><b>Dynamisch erkannte Charaktere</b><div class="albot-small">Quelle: ${esc(roster.source || 'unbekannt')} · keine hartcodierten Namen</div>
<div style="margin-top:6px"><span class="albot-k">Farmer:</span> <span class="albot-v">${roster.farmers && roster.farmers.length ? roster.farmers.map(x => esc(x.name)+' ('+esc(x.ctype)+')').join(', ') : 'keine erkannt'}</span></div>
<div><span class="albot-k">Merchant:</span> <span class="albot-v">${roster.merchant ? esc(roster.merchant.name) : 'nicht erkannt'}</span></div>
<div><span class="albot-k">Aktiv gesamt:</span> <span class="albot-v">${roster.characters ? roster.characters.length : 0}</span></div></div>
<div class="albot-card"><b>Module</b><div class="albot-small">${status.modules.length ? status.modules.map(m => esc(m.id)+': '+esc(m.state)+' / '+esc(m.health || 'UNKNOWN')+' · Ressourcen '+esc(m.resources == null ? 0 : m.resources)).join('<br>') : 'Noch keine Module installiert.'}</div></div>`;
    }

    renderPriorities(status) {
      const panel = this.host.querySelector('#albot-panel-priorities');
      const goals = status.goals || [];
      const p = status.strategicPriorities || {};
      panel.innerHTML = `<div class="albot-card"><b>Neues Ziel</b>
<div class="albot-row"><select id="albot-goal-type"><option value="COLLECT_ITEM">Item sammeln</option><option value="LEVEL">Aufleveln</option><option value="GEAR">Bessere Rüstung/Gear</option><option value="GOLD">Gold verdienen</option><option value="CUSTOM">Sonstiges</option></select><input id="albot-goal-target" placeholder="Ziel / Item / Beschreibung"></div>
<div class="albot-row"><input id="albot-goal-amount" type="number" min="1" placeholder="Menge / Zielwert"><select id="albot-goal-scope"><option value="FARMERS">Erkannte Farmer</option><option value="PARTY">Party</option><option value="ACCOUNT">Account</option><option value="MERCHANT">Merchant</option></select><select id="albot-goal-priority"><option>HIGH</option><option selected>NORMAL</option><option>LOW</option><option>CRITICAL</option></select></div>
<div class="albot-row"><button id="albot-add-goal" class="albot-btn">+ Ziel anlegen</button></div></div>
<div class="albot-card"><b>Aktive Ziele</b>${goals.length ? goals.map(g => `<div class="albot-goal"><div class="albot-goal-head"><div class="albot-goal-title"><b>${esc(g.priority)}</b> · ${esc(g.type)} · ${esc(g.target || '(ohne Text)')}</div><button class="albot-goal-delete" data-goal-delete="${esc(g.id)}" title="Ziel löschen" aria-label="Ziel löschen">×</button></div><div class="albot-small">Scope: ${esc(g.scope)} · Status: ${esc(g.status)}${g.amount != null ? ' · Fortschritt: '+esc(g.progress)+' / '+esc(g.amount) : ''}</div><div class="albot-row"><button class="albot-btn" data-goal-action="${g.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED'}" data-goal-id="${esc(g.id)}">${g.status === 'PAUSED' ? 'Fortsetzen' : 'Pause'}</button><button class="albot-btn danger" data-goal-action="CANCELLED" data-goal-id="${esc(g.id)}">Abbrechen</button></div></div>`).join('') : '<div class="albot-small">Noch keine Ziele.</div>'}</div>
<div class="albot-card"><b>Grundprioritäten</b><div class="albot-priority-grid">${Object.entries(p).map(([k,v]) => `<label>${esc(k)}</label><select data-priority-name="${esc(k)}">${['LOW','NORMAL','HIGH','CRITICAL'].map(x => `<option ${x===v?'selected':''}>${x}</option>`).join('')}</select>`).join('')}</div></div>`;
      const add = panel.querySelector('#albot-add-goal');
      if (add) add.onclick = () => {
        try {
          this.runtime.goals.add({ type: panel.querySelector('#albot-goal-type').value, target: panel.querySelector('#albot-goal-target').value, amount: panel.querySelector('#albot-goal-amount').value, scope: panel.querySelector('#albot-goal-scope').value, priority: panel.querySelector('#albot-goal-priority').value });
          this.render();
        } catch (e) { this.runtime.logger.error('Goal konnte nicht angelegt werden', { error: e.message }); this.render(); }
      };
      panel.querySelectorAll('[data-goal-action]').forEach(btn => btn.onclick = () => { try { this.runtime.goals.setStatus(btn.dataset.goalId, btn.dataset.goalAction); } catch (e) { this.runtime.logger.error('Goal-Status fehlgeschlagen', { error: e.message }); } this.render(); });
      panel.querySelectorAll('[data-goal-delete]').forEach(btn => btn.onclick = () => { try { this.runtime.goals.remove(btn.dataset.goalDelete); } catch (e) { this.runtime.logger.error('Goal konnte nicht gelöscht werden', { error: e.message }); } this.render(); });
      panel.querySelectorAll('[data-priority-name]').forEach(sel => sel.onchange = () => { try { this.runtime.goals.setPriority(sel.dataset.priorityName, sel.value); } catch (e) { this.runtime.logger.error('Priorität konnte nicht geändert werden', { error: e.message }); } this.render(); });
    }

    renderKnowledge(status) {
      const panel = this.host.querySelector('#albot-panel-knowledge');
      if (!panel) return;
      const knowledge = status.knowledge || {};
      const provider = knowledge.provider || {};
      const lkg = knowledge.lastKnownGood || null;
      const error = knowledge.lastRefreshError || provider.lastError || null;
      panel.innerHTML = `<div class="albot-card"><b>Windows Bridge Knowledge</b>
<div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Provider</span><div class="albot-v">${esc(provider.name || 'nicht konfiguriert')}</div></div>
<div><span class="albot-k">Status</span><div class="albot-v">${esc(provider.state || 'IDLE')}</div></div>
<div><span class="albot-k">Modus</span><div class="albot-v">${esc(provider.mode || '-')}</div></div>
<div><span class="albot-k">Read-only</span><div class="albot-v">${provider.readOnly === true ? 'JA' : 'unbekannt'}</div></div>
<div><span class="albot-k">Bridge-Handoff</span><div class="albot-v">${provider.handoffAvailable ? 'verfügbar' : 'nicht verfügbar'}</div></div>
<div><span class="albot-k">Mirror</span><div class="albot-v">${esc(provider.repository || '-')} · ${esc(provider.ref || '-')}</div></div>
</div>
<div class="albot-row"><button id="albot-knowledge-refresh" class="albot-btn">Knowledge aktualisieren</button></div>
${error ? '<div class="albot-small albot-bad">Letzter Refresh: '+esc(error)+'</div>' : '<div class="albot-small">Kein Knowledge-Fehler gemeldet.</div>'}
</div>
<div class="albot-card"><b>Last Known Good</b>
${lkg ? `<div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Generation</span><div class="albot-v">${esc(lkg.generation)}</div></div>
<div><span class="albot-k">Quelle</span><div class="albot-v">${esc(lkg.source || '-')}</div></div>
<div><span class="albot-k">Fakten</span><div class="albot-v">${esc(lkg.factCount == null ? 0 : lkg.factCount)}</div></div>
<div><span class="albot-k">Alter</span><div class="albot-v">${lkg.ageMs == null ? '-' : esc(Math.round(lkg.ageMs / 1000))+' s'}</div></div>
</div><div class="albot-small" style="margin-top:6px">Snapshot: ${esc(lkg.snapshotSha256 || '-')}</div>` : '<div class="albot-small">Noch kein validierter Snapshot gespeichert. Das ist zulässig, solange die Bridge bzw. ihr GitHub-Spiegel noch keinen Snapshot bereitstellt.</div>'}
</div>`;

      const refresh = panel.querySelector('#albot-knowledge-refresh');
      if (refresh) refresh.onclick = async () => {
        refresh.disabled = true;
        refresh.textContent = 'Aktualisiere ...';
        await this.runtime.knowledge.refresh();
        this.renderKnowledge(this.runtime.status());
      };
    }

    renderLogs() {
      if (!this.host) return;
      const panel = this.host.querySelector('#albot-panel-logs');
      const lines = this.runtime.logger.list(100).map(x => `[${x.at}] ${x.level} ${x.message}${x.data == null ? '' : ' '+JSON.stringify(x.data)}`).join('\n');
      panel.innerHTML = `<div class="albot-card"><b>Logs</b><div class="albot-log">${esc(lines || 'Noch keine Logs.')}</div></div>`;
    }

    renderDev(status) {
      const panel = this.host.querySelector('#albot-panel-dev');
      const scheduler = status.scheduler || {};
      const resultText = this.devResult ? JSON.stringify(this.devResult, null, 2) : 'H3 Game Adapter & Knowledge · ' + status.version;
      panel.innerHTML = `<div class="albot-card"><b>Entwicklung</b>
<div class="albot-row"><button id="albot-selftest" class="albot-btn">Selftest</button><button id="albot-stability-test" class="albot-btn">H2 Runtime-Test</button><button id="albot-reset-stop" class="albot-btn danger">STOP zurücksetzen</button><button id="albot-show" class="albot-btn">GUI anzeigen</button></div>
<div class="albot-small">Scheduler: ${scheduler.enabled ? 'ACTIVE' : 'STOPPED'} · Ressourcen: ${esc(scheduler.totalResources || 0)} · Generation: ${esc(scheduler.generation || 0)} · Boot: #${esc(status.bootCount || 1)}</div>
<div id="albot-selftest-result" class="albot-log" style="margin-top:8px;max-height:220px">${esc(resultText)}</div></div>`;
      panel.querySelector('#albot-selftest').onclick = () => {
        this.devResult = this.runtime.selfTest();
        this.renderDev(this.runtime.status());
      };
      panel.querySelector('#albot-stability-test').onclick = async () => {
        this.devResult = { running: true, message: 'H2 Runtime-Test läuft ...' };
        this.renderDev(this.runtime.status());
        this.devResult = await this.runtime.runStabilityProbe();
        this.renderDev(this.runtime.status());
      };
      panel.querySelector('#albot-reset-stop').onclick = () => { this.runtime.resetEmergencyStop(); this.render(); };
      panel.querySelector('#albot-show').onclick = () => { this.host.style.display = 'block'; };
    }

    async copyDiagnostics() {
      const text = JSON.stringify(this.runtime.diagnostics(), null, 2);
      try {
        const nav = this.uiRoot && this.uiRoot.navigator || this.root.navigator;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          await nav.clipboard.writeText(text);
        } else {
          const area = this.doc.createElement('textarea'); area.value = text; area.style.position='fixed'; area.style.opacity='0'; this.doc.body.appendChild(area); area.select(); this.doc.execCommand('copy'); area.remove();
        }
        this.runtime.logger.info('Fehlerbericht in Zwischenablage kopiert');
      } catch (e) { this.runtime.logger.error('Clipboard-Kopie fehlgeschlagen', { error: e.message }); }
      this.renderLogs();
      return text;
    }

    show() { if (this.host) this.host.style.display = 'block'; }
    hide() { if (this.host) this.host.style.display = 'none'; }
    destroy() {
      if (this.interval != null) { try { (this.intervalRoot || this.root).clearInterval(this.interval); } catch (_) {} this.interval = null; }
      if (this._offLog) { try { this._offLog(); } catch (_) {} this._offLog = null; }
      if (this._dragCleanup) { try { this._dragCleanup(); } catch (_) {} this._dragCleanup = null; }
      const old = this.doc && this.doc.getElementById('albot-control-center');
      if (old) old.remove();
      this.host = null;
    }
  }

  ns.ControlCenter = ControlCenter;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.ALBotRuntime) throw new Error('ALBOT_RUNTIME_MISSING');

  function resolveSharedHost(start) {
    let current = start;
    let best = start;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      let parentWindow = null;
      try {
        parentWindow = current.parent && current.parent !== current ? current.parent : null;
        if (parentWindow) void parentWindow.document;
      } catch (_) {
        parentWindow = null;
      }
      if (!parentWindow) break;
      best = parentWindow;
      current = parentWindow;
    }
    return best || start;
  }

  const sharedHost = resolveSharedHost(root);
  let sharedState = null;
  try {
    sharedState = sharedHost.__ALBOT_SHARED_RUNTIME__ && typeof sharedHost.__ALBOT_SHARED_RUNTIME__ === 'object'
      ? sharedHost.__ALBOT_SHARED_RUNTIME__
      : null;
  } catch (_) {}

  const localPrevious = root.ALBot && root.ALBot.__runtime || null;
  const previous = localPrevious || sharedState && sharedState.runtime || null;
  const previousBootCount = Number(sharedState && sharedState.bootCount)
    || Number(previous && previous.bootCount)
    || Number(sharedHost && sharedHost.__ALBOT_BOOT_COUNT__)
    || Number(root.__ALBOT_BOOT_COUNT__)
    || 0;

  if (previous) {
    try {
      if (typeof previous.prepareHotReload === 'function') previous.prepareHotReload('BUNDLE_RELOAD');
      else if (typeof previous.destroy === 'function') previous.destroy();
    } catch (_) {}
  }

  const bootCount = previousBootCount + 1;
  root.__ALBOT_BOOT_COUNT__ = bootCount;
  try { sharedHost.__ALBOT_BOOT_COUNT__ = bootCount; } catch (_) {}

  const runtime = new ns.ALBotRuntime({
    root,
    version: '0.3.0-h3',
    bootCount,
    replacedPrevious: !!previous
  });

  if (root.document && root.document.body && ns.ControlCenter) {
    const ui = new ns.ControlCenter(runtime);
    runtime.ui = ui;
    ui.mount();
  }

  const api = {
    product: 'AL Bot',
    version: runtime.version,
    __runtime: runtime,

    start: () => runtime.start(),
    stop: reason => runtime.stop(reason || 'API_STOP'),
    emergencyStop: reason => runtime.emergencyStop(reason || 'API_EMERGENCY_STOP'),
    resetEmergencyStop: () => runtime.resetEmergencyStop(),
    status: () => runtime.status(),
    selfTest: () => runtime.selfTest(),
    diagnostics: () => runtime.diagnostics(),

    scheduler: {
      status: () => runtime.scheduler.status(),
      owner: owner => runtime.scheduler.ownerStatus(owner)
    },

    modules: {
      register: definition => runtime.modules.register(definition),
      list: () => runtime.modules.list(),
      start: id => runtime.startModule(id),
      stop: (id, reason) => runtime.stopModule(id, reason || 'API_MODULE_STOP'),
      restart: (id, reason) => runtime.restartModule(id, reason || 'API_MODULE_RESTART'),
      unregister: id => runtime.modules.unregister(id, 'API_UNREGISTER')
    },

    goals: {
      add: goal => runtime.goals.add(goal),
      list: () => runtime.goals.list(),
      pause: id => runtime.goals.setStatus(id, 'PAUSED'),
      resume: id => runtime.goals.setStatus(id, 'ACTIVE'),
      cancel: id => runtime.goals.setStatus(id, 'CANCELLED'),
      remove: id => runtime.goals.remove(id),
      setProgress: (id, value) => runtime.goals.setProgress(id, value),
      priorities: () => runtime.goals.getPriorities(),
      setPriority: (name, value) => runtime.goals.setPriority(name, value)
    },

    game: {
      snapshot: () => runtime.game.snapshot(),
      status: () => runtime.game.status()
    },

    knowledge: {
      setProvider: provider => runtime.knowledge.setProvider(provider),
      refresh: () => runtime.knowledge.refresh(),
      status: () => runtime.knowledge.status(),
      snapshot: () => runtime.knowledge.snapshot(),
      fact: id => runtime.knowledge.fact(id)
    },

    roster: {
      refresh: () => runtime.roster.refresh(),
      status: () => runtime.roster.status(),
      farmers: () => runtime.roster.status().farmers,
      merchant: () => runtime.roster.status().merchant
    },

    actions: {
      canAct: action => runtime.actionAllowed(action),
      assertAllowed: action => runtime.assertActionAllowed(action)
    },

    dev: {
      stabilityProbe: () => runtime.runStabilityProbe(),
      knowledgeRefresh: () => runtime.knowledge.refresh()
    },

    ui: {
      show: () => runtime.ui && runtime.ui.show(),
      hide: () => runtime.ui && runtime.ui.hide(),
      render: () => runtime.ui && runtime.ui.render()
    }
  };

  Object.freeze(api.scheduler);
  Object.freeze(api.modules);
  Object.freeze(api.game);
  Object.freeze(api.knowledge);
  Object.freeze(api.roster);
  Object.freeze(api.actions);
  Object.freeze(api.dev);
  Object.freeze(api.ui);

  root.ALBot = api;
  try {
    sharedHost.__ALBOT_SHARED_RUNTIME__ = {
      runtime,
      bootCount,
      runnerRoot: root,
      loadedAt: runtime.loadedAt
    };
  } catch (_) {}

  runtime.logger.info('AL Bot H3 geladen', {
    version: api.version,
    bootCount,
    hotReload: !!previous,
    sharedHost: sharedHost !== root
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

