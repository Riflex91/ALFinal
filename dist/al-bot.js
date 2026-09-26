/* AL Bot 0.7.0-h7 | generated file | do not edit dist directly */\n(function (root) {
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
\n\n(function (root) {
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
\n\n(function (root) {
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
          range: finite(character.range),
          speed: finite(character.speed),
          frequency: finite(character.frequency),
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
\n\n(function (root) {
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
\n\n(function (root) {
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
    change_target: Object.freeze({ publicName: 'change_target', family: 'combat-target' })
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
        const value = resolved.fn.apply(resolved.owner, args);
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
\n\n(function (root) {
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
\n\n(function (root) {
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
\n\n(function (root) {
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
\n\n(function (root) {
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
          pack.unshift(primary);
          if (pack.length > capacity) pack.pop();
          aggregateAttack = pack.reduce((sum, row) => sum + (finite(row.attack) || 0), 0);
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
\n\n(function (root) {
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
        maxAttackToHpRatio: Math.max(0.01, Math.min(0.5, Number(options.maxAttackToHpRatio) || 0.08))
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
        attack: target.attack
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
\n\n(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function errorDetails(error) {
    return {
      name: cleanText(error && error.name || 'Error', 80),
      message: cleanText(error && error.message || error || 'Unknown error', 600),
      stack: error && error.stack ? String(error.stack).slice(0, 4000) : null
    };
  }

  class LiveTestRunner {
    constructor(options = {}) {
      this.runtime = options.runtime || null;
      this.logger = options.logger || null;
      this.bus = options.bus || null;
      this.suites = new Map();
      this.recommendedId = null;
      this.sequence = 0;
      this.current = null;
      this.lastRun = null;
      this.cancelRequested = false;
    }

    register(definition) {
      if (!definition || typeof definition !== 'object') throw new Error('LIVE_TEST_DEFINITION_REQUIRED');
      const id = cleanText(definition.id, 100);
      if (!id) throw new Error('LIVE_TEST_ID_REQUIRED');
      if (this.suites.has(id)) throw new Error('LIVE_TEST_DUPLICATE:' + id);
      const steps = Array.isArray(definition.steps) ? definition.steps : [];
      if (!steps.length) throw new Error('LIVE_TEST_STEPS_REQUIRED:' + id);
      for (const step of steps) {
        if (!step || typeof step.run !== 'function') throw new Error('LIVE_TEST_STEP_RUN_REQUIRED:' + id);
      }
      const suite = {
        id,
        title: cleanText(definition.title || id, 160),
        description: cleanText(definition.description || '', 500),
        version: cleanText(definition.version || '1', 40),
        autoStartRuntime: definition.autoStartRuntime !== false,
        restoreRuntimeState: definition.restoreRuntimeState !== false,
        prepare: typeof definition.prepare === 'function' ? definition.prepare : null,
        cleanup: typeof definition.cleanup === 'function' ? definition.cleanup : null,
        steps: steps.map((step, index) => ({
          id: cleanText(step.id || ('step-' + (index + 1)), 100),
          title: cleanText(step.title || step.id || ('Schritt ' + (index + 1)), 180),
          timeoutMs: Math.max(250, Math.min(10 * 60 * 1000, Number(step.timeoutMs) || 30000)),
          run: step.run
        }))
      };
      this.suites.set(id, suite);
      if (definition.recommended === true || !this.recommendedId) this.recommendedId = id;
      return this.describe(id);
    }

    setRecommended(id) {
      if (!this.suites.has(id)) throw new Error('LIVE_TEST_UNKNOWN:' + id);
      this.recommendedId = id;
      return this.describe(id);
    }

    list() {
      return Array.from(this.suites.values()).map(suite => ({
        id: suite.id,
        title: suite.title,
        description: suite.description,
        version: suite.version,
        recommended: suite.id === this.recommendedId,
        steps: suite.steps.map(step => ({ id: step.id, title: step.title, timeoutMs: step.timeoutMs }))
      }));
    }

    describe(id) {
      const suite = this.suites.get(id);
      if (!suite) return null;
      return this.list().find(row => row.id === id) || null;
    }

    _emit() {
      if (this.bus) {
        try { this.bus.emit('live-test', this.status()); } catch (_) {}
      }
    }

    _publicRun(run) {
      if (!run) return null;
      return clone({
        id: run.id,
        suiteId: run.suiteId,
        title: run.title,
        state: run.state,
        reason: run.reason,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        runtimeWasRunning: run.runtimeWasRunning,
        runtimeAutoStarted: run.runtimeAutoStarted,
        currentStepId: run.currentStepId,
        steps: run.steps,
        cleanup: run.cleanup
      });
    }

    _assertNotCancelled() {
      if (this.cancelRequested) throw new Error('LIVE_TEST_CANCELLED');
      if (this.runtime && this.runtime.stopLatch && this.runtime.stopLatch.status().latched) {
        throw new Error('LIVE_TEST_EMERGENCY_STOP_LATCHED');
      }
    }

    _context(run, suite) {
      const sleep = ms => new Promise((resolve, reject) => {
        const delay = Math.max(0, Number(ms) || 0);
        const timerRoot = this.runtime && this.runtime.root || root;
        const set = timerRoot && typeof timerRoot.setTimeout === 'function' ? timerRoot.setTimeout.bind(timerRoot) : setTimeout;
        set(() => {
          try {
            this._assertNotCancelled();
            resolve();
          } catch (error) {
            reject(error);
          }
        }, delay);
      });

      const waitFor = async (predicate, options = {}) => {
        const timeoutMs = Math.max(100, Math.min(10 * 60 * 1000, Number(options.timeoutMs) || 10000));
        const pollMs = Math.max(25, Math.min(2000, Number(options.pollMs) || 100));
        const started = Date.now();
        let lastValue = null;
        while (Date.now() - started <= timeoutMs) {
          this._assertNotCancelled();
          lastValue = await predicate();
          if (lastValue) return lastValue;
          await sleep(pollMs);
        }
        const label = cleanText(options.label || 'condition', 120);
        throw new Error('LIVE_TEST_WAIT_TIMEOUT:' + label);
      };

      return {
        runtime: this.runtime,
        suite: this.describe(suite.id),
        run: () => this._publicRun(run),
        assert: (condition, message = 'LIVE_TEST_ASSERTION_FAILED') => {
          if (!condition) throw new Error(cleanText(message, 300) || 'LIVE_TEST_ASSERTION_FAILED');
          return true;
        },
        assertNotCancelled: () => this._assertNotCancelled(),
        sleep,
        waitFor,
        game: () => this.runtime && this.runtime.game ? this.runtime.game.snapshot() : null,
        status: () => this.runtime ? this.runtime.status() : null,
        note: details => {
          const step = run.steps.find(row => row.id === run.currentStepId);
          if (step) step.details = clone(details);
          this._emit();
        }
      };
    }

    async _runStep(run, suite, step, context) {
      const row = run.steps.find(candidate => candidate.id === step.id);
      row.state = 'RUNNING';
      row.startedAt = new Date().toISOString();
      run.currentStepId = step.id;
      this._emit();

      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        const timerRoot = this.runtime && this.runtime.root || root;
        const set = timerRoot && typeof timerRoot.setTimeout === 'function' ? timerRoot.setTimeout.bind(timerRoot) : setTimeout;
        timer = set(() => reject(new Error('LIVE_TEST_STEP_TIMEOUT:' + step.id)), step.timeoutMs);
      });

      try {
        this._assertNotCancelled();
        const result = await Promise.race([
          Promise.resolve().then(() => step.run(context)),
          timeoutPromise
        ]);
        this._assertNotCancelled();
        row.state = 'PASSED';
        row.finishedAt = new Date().toISOString();
        row.result = result == null ? null : clone(result);
        row.error = null;
      } catch (error) {
        row.state = this.cancelRequested ? 'CANCELLED' : 'FAILED';
        row.finishedAt = new Date().toISOString();
        row.error = errorDetails(error);
        throw error;
      } finally {
        if (timer != null) {
          const timerRoot = this.runtime && this.runtime.root || root;
          const clear = timerRoot && typeof timerRoot.clearTimeout === 'function' ? timerRoot.clearTimeout.bind(timerRoot) : clearTimeout;
          try { clear(timer); } catch (_) {}
        }
        this._emit();
      }
    }

    async start(id) {
      if (this.current && this.current.state === 'RUNNING') throw new Error('LIVE_TEST_ALREADY_RUNNING');
      const suiteId = id || this.recommendedId;
      const suite = this.suites.get(suiteId);
      if (!suite) throw new Error('LIVE_TEST_UNKNOWN:' + cleanText(suiteId, 100));
      if (!this.runtime) throw new Error('LIVE_TEST_RUNTIME_MISSING');
      if (this.runtime.stopLatch.status().latched) throw new Error('LIVE_TEST_EMERGENCY_STOP_LATCHED');

      this.cancelRequested = false;
      const runtimeWasRunning = this.runtime.running === true;
      const run = {
        id: 'live-test-' + (++this.sequence),
        suiteId: suite.id,
        title: suite.title,
        state: 'RUNNING',
        reason: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        runtimeWasRunning,
        runtimeAutoStarted: false,
        currentStepId: null,
        cleanup: { attempted: false, ok: null, error: null },
        steps: suite.steps.map(step => ({
          id: step.id,
          title: step.title,
          state: 'PENDING',
          startedAt: null,
          finishedAt: null,
          details: null,
          result: null,
          error: null
        }))
      };
      this.current = run;
      this._emit();
      if (this.logger) this.logger.warn('Live-Test gestartet', { id: run.id, suite: suite.id, title: suite.title });

      const context = this._context(run, suite);
      try {
        if (!runtimeWasRunning && suite.autoStartRuntime) {
          await this.runtime.start();
          run.runtimeAutoStarted = true;
          this._emit();
        }
        this._assertNotCancelled();
        if (suite.prepare) await suite.prepare(context);

        for (const step of suite.steps) {
          await this._runStep(run, suite, step, context);
        }

        run.state = 'PASSED';
        run.reason = 'ALL_STEPS_PASSED';
      } catch (error) {
        run.state = this.cancelRequested ? 'CANCELLED' : 'FAILED';
        run.reason = cleanText(error && error.message || error || 'LIVE_TEST_FAILED', 300);
        for (const row of run.steps) {
          if (row.state === 'PENDING') row.state = 'SKIPPED';
        }
      } finally {
        run.cleanup.attempted = true;
        try {
          if (suite.cleanup) await suite.cleanup(context, run.state);
          if (run.runtimeAutoStarted && suite.restoreRuntimeState && this.runtime.running) {
            await this.runtime.stop('LIVE_TEST_AUTO_RESTORE');
          }
          run.cleanup.ok = true;
        } catch (cleanupError) {
          run.cleanup.ok = false;
          run.cleanup.error = errorDetails(cleanupError);
          if (run.state === 'PASSED') {
            run.state = 'FAILED';
            run.reason = 'LIVE_TEST_CLEANUP_FAILED:' + run.cleanup.error.message;
          }
        }

        run.finishedAt = new Date().toISOString();
        run.currentStepId = null;
        this.lastRun = this._publicRun(run);
        this.current = null;
        this._emit();
        if (this.logger) {
          const data = { id: run.id, suite: suite.id, state: run.state, reason: run.reason };
          if (run.state === 'PASSED') this.logger.info('Live-Test beendet: BESTANDEN', data);
          else this.logger.error('Live-Test beendet: ' + run.state, data);
        }
      }

      return clone(this.lastRun);
    }

    startRecommended() {
      return this.start(this.recommendedId);
    }

    cancel(reason = 'MANUAL_TEST_CANCEL') {
      if (!this.current || this.current.state !== 'RUNNING') {
        return { cancelled: false, reason: 'NO_RUNNING_LIVE_TEST' };
      }
      this.cancelRequested = true;
      this.current.reason = cleanText(reason, 200);
      this._emit();
      if (this.logger) this.logger.warn('Live-Test Abbruch angefordert', {
        id: this.current.id,
        suite: this.current.suiteId,
        reason: this.current.reason
      });
      return { cancelled: true, id: this.current.id, suiteId: this.current.suiteId };
    }

    status() {
      return {
        schemaVersion: 1,
        recommendedId: this.recommendedId,
        recommended: this.describe(this.recommendedId),
        running: !!(this.current && this.current.state === 'RUNNING'),
        current: this._publicRun(this.current),
        lastRun: clone(this.lastRun),
        suites: this.list()
      };
    }
  }

  ns.LiveTestRunner = LiveTestRunner;
})(typeof globalThis !== 'undefined' ? globalThis : this);
\n\n(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.Scheduler) throw new Error('ALBOT_SCHEDULER_MISSING');

  class ALBotRuntime {
    constructor(options = {}) {
      this.version = options.version || '0.7.0-h7';
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
      this.actions = new ns.GameActionBoundary({
        root: this.root,
        logger: this.logger,
        assertAllowed: action => this.assertActionAllowed(action)
      });
      this.movement = new ns.MovementController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions
      });
      this.classSkills = new ns.ClassSkillController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions
      });
      this.combat = new ns.CombatController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        movement: this.movement,
        classSkills: this.classSkills
      });
      this.knowledge = new ns.KnowledgeService({ logger: this.logger, storage: this.storage });
      this.knowledgeProvider = new ns.WindowsBridgeKnowledgeProvider({ root: this.root, logger: this.logger });
      this.knowledge.setProvider(this.knowledgeProvider);
      this.roster = new ns.CharacterRosterService({ root: this.root, logger: this.logger });
      this.party = new ns.PartyCoordinator({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        roster: this.roster
      });
      this.farming = new ns.AdaptiveFarmingController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        combat: this.combat,
        party: this.party,
        classSkills: this.classSkills
      });
      this.combat.party = this.party;
      this.combat.farming = this.farming;
      this.liveTests = new ns.LiveTestRunner({
        runtime: this,
        logger: this.logger,
        bus: this.bus
      });
      this.ui = null;
      this.lastError = null;
      this._destroyed = false;
      this._registerCoreModules();
      this._registerLiveTests();
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
        version: '0.7.0',
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

      this.modules.register({
        id: 'movement',
        title: 'Movement',
        version: '0.7.0',
        start: context => this.movement.start(context),
        stop: reason => this.movement.stop(reason),
        status: () => this.movement.status()
      });

      this.modules.register({
        id: 'class-skills',
        title: 'Class Skills',
        version: '0.7.0',
        start: () => this.classSkills.start(),
        stop: reason => this.classSkills.stop(reason),
        status: () => this.classSkills.status()
      });

      this.modules.register({
        id: 'party',
        title: 'Party',
        version: '0.7.0',
        start: context => this.party.start(context),
        stop: reason => this.party.stop(reason),
        status: () => this.party.status()
      });

      this.modules.register({
        id: 'combat',
        title: 'Combat',
        version: '0.7.0',
        start: context => this.combat.start(context),
        stop: reason => this.combat.stop(reason),
        status: () => this.combat.status()
      });

      this.modules.register({
        id: 'adaptive-farming',
        title: 'Adaptive Farming',
        version: '0.8.0',
        start: context => this.farming.start(context),
        stop: reason => this.farming.stop(reason),
        status: () => this.farming.status()
      });
    }

    _registerLiveTests() {
      let baseline = null;
      let livePlan = null;
      let h6Baseline = null;
      let h6Plan = null;
      let h7Baseline = null;
      let h7Plan = null;
      this.liveTests.register({
        id: 'h5-combat',
        title: 'H5 – Einfacher Kampf',
        description: 'Ein-Klick-Live-Test für Targeting, Range, Cooldown, bestätigte Angriffe, Cleanup und Fail-Safe.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.combat.stopSession('H5_LIVE_TEST_RESET'); } catch (_) {}
          livePlan = null;
          const metrics = runtime.combat.status().metrics;
          baseline = {
            targetsAcquired: metrics.targetsAcquired,
            attacksDispatched: metrics.attacksDispatched,
            attacksConfirmed: metrics.attacksConfirmed,
            attackUnknown: metrics.attackUnknown,
            killsObserved: metrics.killsObserved
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.combat.stopSession('H5_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Combat-Sicherheit und sichtbares Ziel prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              assert(runtime.actions.available('attack'), 'ATTACK_API_UNAVAILABLE');
              assert(runtime.actions.available('change_target'), 'CHANGE_TARGET_API_UNAVAILABLE');
              const combatModule = runtime.modules.describe('combat');
              assert(combatModule && combatModule.state === 'ACTIVE', 'COMBAT_MODULE_NOT_ACTIVE');
              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');

              const attackBudget = Math.max(5, Math.min(maxHp * 0.08, currentHp * 0.08));
              const candidates = runtime.combat.safeCandidates({
                maxAcquireDistance: 450,
                maxAttack: attackBudget
              });
              assert(candidates.length > 0, 'NO_SAFE_VISIBLE_MONSTER_FOR_CURRENT_HP');
              const target = candidates[0];
              const targetAttack = Number(target.attack);
              assert(Number.isFinite(targetAttack) && targetAttack >= 0, 'TARGET_ATTACK_UNAVAILABLE');

              const absoluteRetreatHp = Math.max(100, targetAttack * 20);
              const minimumStartHp = Math.max(150, targetAttack * 25);
              assert(currentHp >= minimumStartHp,
                'HP_TOO_LOW_FOR_SAFE_H5_TEST:' + Math.round(currentHp) + '<' + Math.round(minimumStartHp));

              const retreatHpRatio = Math.max(0.05, Math.min(0.35, absoluteRetreatHp / maxHp));
              const resumeHpRatio = Math.max(
                retreatHpRatio + 0.05,
                Math.min(0.65, retreatHpRatio * 1.75)
              );

              livePlan = {
                monsterType: target.mtype || null,
                maxAttack: attackBudget,
                retreatHpRatio,
                resumeHpRatio,
                targetId: target.id,
                targetAttack,
                startingHp: currentHp,
                maxHp
              };

              return {
                character: game.character.name,
                hp: currentHp,
                maxHp,
                target: target.name || target.mtype || target.id,
                mtype: target.mtype,
                distance: target.distance,
                attack: target.attack,
                attackBudget,
                retreatHp: Math.round(maxHp * retreatHpRatio),
                retreatHpRatio
              };
            }
          },
          {
            id: 'start-combat',
            title: 'Autonome Combat-Session starten und Target bestätigen',
            timeoutMs: 10000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(livePlan, 'H5_LIVE_TEST_PLAN_MISSING');
              const result = runtime.combat.startSession({
                owner: 'live-test-h5',
                monsterType: livePlan.monsterType || undefined,
                maxAcquireDistance: 450,
                maxAttack: livePlan.maxAttack,
                retreatHpRatio: livePlan.retreatHpRatio,
                resumeHpRatio: livePlan.resumeHpRatio,
                minMpRatio: 0,
                kiting: false
              });
              assert(result && result.accepted === true, result && result.reason || 'COMBAT_SESSION_START_FAILED');
              const status = await waitFor(() => {
                const current = runtime.combat.status();
                if (current.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(current.lastSession.state)) {
                  throw new Error(current.lastSession.reason || current.lastSession.state);
                }
                return current.session && current.session.targetId ? current : null;
              }, { timeoutMs: 8000, pollMs: 100, label: 'target-acquisition' });
              return {
                sessionId: status.session.id,
                targetId: status.session.targetId,
                targetType: status.session.targetType
              };
            }
          },
          {
            id: 'confirmed-attack',
            title: 'Mindestens einen Angriff durch Live-Evidence bestätigen',
            timeoutMs: 35000,
            run: async ({ runtime, assert, waitFor }) => {
              const result = await waitFor(() => {
                const current = runtime.combat.status();
                if (current.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(current.lastSession.state)) {
                  throw new Error(current.lastSession.reason || current.lastSession.state);
                }
                const confirmed = current.metrics.attacksConfirmed - baseline.attacksConfirmed;
                const killed = current.metrics.killsObserved - baseline.killsObserved;
                return confirmed > 0 || killed > 0 ? current : null;
              }, { timeoutMs: 30000, pollMs: 125, label: 'confirmed-attack' });
              assert(result.metrics.attackUnknown === baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_TEST');
              return {
                targetsAcquired: result.metrics.targetsAcquired - baseline.targetsAcquired,
                attacksDispatched: result.metrics.attacksDispatched - baseline.attacksDispatched,
                attacksConfirmed: result.metrics.attacksConfirmed - baseline.attacksConfirmed,
                killsObserved: result.metrics.killsObserved - baseline.killsObserved
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Combat fünf Sekunden ohne UNKNOWN/Fail-Safe beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const current = runtime.combat.status();
              assert(current.metrics.attackUnknown === baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_STABILITY_WINDOW');
              assert(!(current.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(current.lastSession.state)), current.lastSession && current.lastSession.reason || 'COMBAT_FAILED');
              return {
                active: current.active,
                state: current.state,
                attacksConfirmed: current.metrics.attacksConfirmed - baseline.attacksConfirmed,
                killsObserved: current.metrics.killsObserved - baseline.killsObserved,
                approaches: current.metrics.approaches
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Combat sauber stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.combat.stopSession('H5_LIVE_TEST_COMPLETE');
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              assert(combat.active === false, 'COMBAT_STILL_ACTIVE_AFTER_STOP');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')), 'COMBAT_MOVEMENT_STILL_ACTIVE');
              return {
                combatActive: combat.active,
                movementActive: movement.active,
                lastSession: combat.lastSession && {
                  state: combat.lastSession.state,
                  reason: combat.lastSession.reason,
                  counters: combat.lastSession.counters
                }
              };
            }
          }
        ]
      });

      this.liveTests.register({
        id: 'h6-class-logic',
        title: 'H6 – Klassenlogik',
        description: 'Ein-Klick-Live-Test für klassenspezifische Skills, Cooldown-/MP-Planung, Defensive/Support und Anti-Spam.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.combat.stopSession('H6_LIVE_TEST_RESET'); } catch (_) {}
          h6Plan = null;
          const skillMetrics = runtime.classSkills.status().metrics;
          const combatMetrics = runtime.combat.status().metrics;
          h6Baseline = {
            dispatched: skillMetrics.dispatched,
            confirmed: skillMetrics.confirmed,
            rejected: skillMetrics.rejected,
            unknown: skillMetrics.unknown,
            spamSkips: skillMetrics.spamSkips,
            cooldownSkips: skillMetrics.cooldownSkips,
            attackUnknown: combatMetrics.attackUnknown
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.combat.stopSession('H6_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Klasse, Live-Skills und sicheren Gegner prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              assert(runtime.actions.available('use_skill'), 'USE_SKILL_API_UNAVAILABLE');

              const classModule = runtime.modules.describe('class-skills');
              assert(classModule && classModule.state === 'ACTIVE', 'CLASS_SKILL_MODULE_NOT_ACTIVE');

              const ctype = String(game.character.ctype || '').toLowerCase();
              const supported = runtime.classSkills.supportedSkills(ctype);
              assert(supported.length > 0, 'CLASS_NOT_SUPPORTED_BY_H6:' + ctype);
              const liveSkills = runtime.classSkills.liveSkillSummary(ctype).filter(row => row.available);
              assert(liveSkills.length > 0, 'NO_SUPPORTED_LIVE_SKILL_FOR_CLASS:' + ctype);

              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');

              const attackBudget = Math.max(5, Math.min(maxHp * 0.08, currentHp * 0.08));
              const candidates = runtime.combat.safeCandidates({
                maxAcquireDistance: 450,
                maxAttack: attackBudget
              });
              assert(candidates.length > 0, 'NO_SAFE_VISIBLE_MONSTER_FOR_H6');

              let chosen = null;
              let preview = null;
              for (const candidate of candidates) {
                const decision = runtime.classSkills.preview(candidate.id);
                if (decision) {
                  chosen = candidate;
                  preview = decision;
                  break;
                }
              }
              assert(chosen && preview, 'NO_SAFE_CLASS_SKILL_OPPORTUNITY:' + ctype);

              const targetAttack = Number(chosen.attack);
              assert(Number.isFinite(targetAttack) && targetAttack >= 0, 'TARGET_ATTACK_UNAVAILABLE');
              const absoluteRetreatHp = Math.max(100, targetAttack * 20);
              const minimumStartHp = Math.max(150, targetAttack * 25);
              assert(currentHp >= minimumStartHp,
                'HP_TOO_LOW_FOR_SAFE_H6_TEST:' + Math.round(currentHp) + '<' + Math.round(minimumStartHp));

              const retreatHpRatio = Math.max(0.05, Math.min(0.35, absoluteRetreatHp / maxHp));
              const resumeHpRatio = Math.max(
                retreatHpRatio + 0.05,
                Math.min(0.65, retreatHpRatio * 1.75)
              );

              h6Plan = {
                characterClass: ctype,
                monsterType: chosen.mtype || null,
                maxAttack: attackBudget,
                retreatHpRatio,
                resumeHpRatio,
                previewSkillId: preview.skillId,
                previewReason: preview.reason
              };

              return {
                character: game.character.name,
                characterClass: ctype,
                supportedSkills: supported,
                liveSkills: liveSkills.map(row => row.id),
                previewSkillId: preview.skillId,
                previewReason: preview.reason,
                target: chosen.name || chosen.mtype || chosen.id,
                distance: chosen.distance,
                attack: chosen.attack,
                retreatHp: Math.round(maxHp * retreatHpRatio)
              };
            }
          },
          {
            id: 'start-combat',
            title: 'Combat mit H6-Klassenlogik starten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h6Plan, 'H6_LIVE_TEST_PLAN_MISSING');
              const result = runtime.combat.startSession({
                owner: 'live-test-h6',
                monsterType: h6Plan.monsterType || undefined,
                maxAcquireDistance: 450,
                maxAttack: h6Plan.maxAttack,
                retreatHpRatio: h6Plan.retreatHpRatio,
                resumeHpRatio: h6Plan.resumeHpRatio,
                minMpRatio: 0,
                kiting: false
              });
              assert(result && result.accepted === true, result && result.reason || 'H6_COMBAT_SESSION_START_FAILED');
              const status = await waitFor(() => {
                const combat = runtime.combat.status();
                if (combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)) {
                  throw new Error(combat.lastSession.reason || combat.lastSession.state);
                }
                return combat.session && combat.session.targetId ? combat : null;
              }, { timeoutMs: 8000, pollMs: 100, label: 'h6-target-acquisition' });
              return {
                sessionId: status.session.id,
                targetId: status.session.targetId,
                targetType: status.session.targetType
              };
            }
          },
          {
            id: 'class-skill',
            title: 'Mindestens einen klassenspezifischen Skill serverbestätigt einsetzen',
            timeoutMs: 20000,
            run: async ({ runtime, assert, waitFor }) => {
              const status = await waitFor(() => {
                const skills = runtime.classSkills.status();
                if (skills.metrics.unknown > h6Baseline.unknown) {
                  throw new Error(skills.suspendedReason || 'CLASS_SKILL_UNKNOWN');
                }
                return skills.metrics.confirmed > h6Baseline.confirmed ? skills : null;
              }, { timeoutMs: 15000, pollMs: 100, label: 'confirmed-class-skill' });

              assert(status.lastUse && status.lastUse.state === 'CONFIRMED', 'CLASS_SKILL_NOT_CONFIRMED');
              return {
                skillId: status.lastUse.skillId,
                kind: status.lastUse.kind,
                reason: status.lastUse.reason,
                damage: status.lastUse.damage,
                lethal: status.lastUse.lethal,
                dispatched: status.metrics.dispatched - h6Baseline.dispatched,
                confirmed: status.metrics.confirmed - h6Baseline.confirmed
              };
            }
          },
          {
            id: 'anti-spam-window',
            title: 'Klassenlogik fünf Sekunden ohne Skill-Spam/UNKNOWN beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const skills = runtime.classSkills.status();
              const combat = runtime.combat.status();

              assert(skills.metrics.unknown === h6Baseline.unknown, 'CLASS_SKILL_UNKNOWN_DURING_STABILITY_WINDOW');
              assert(combat.metrics.attackUnknown === h6Baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_H6_STABILITY_WINDOW');
              assert(!(combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)),
                combat.lastSession && combat.lastSession.reason || 'COMBAT_FAILED_DURING_H6');

              const dispatched = skills.metrics.dispatched - h6Baseline.dispatched;
              const confirmed = skills.metrics.confirmed - h6Baseline.confirmed;
              const rejected = skills.metrics.rejected - h6Baseline.rejected;
              const pending = skills.pending ? 1 : 0;
              assert(dispatched <= confirmed + rejected + pending, 'CLASS_SKILL_DISPATCH_ACCOUNTING_INVALID');
              assert(dispatched <= 12, 'CLASS_SKILL_SPAM_GUARD_EXCEEDED:' + dispatched);

              return {
                class: skills.currentClass,
                dispatched,
                confirmed,
                rejected,
                pending,
                spamSkips: skills.metrics.spamSkips - h6Baseline.spamSkips,
                cooldownSkips: skills.metrics.cooldownSkips - h6Baseline.cooldownSkips,
                suspended: skills.suspended
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Klassenlogik und Combat sauber freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.combat.stopSession('H6_LIVE_TEST_COMPLETE');
              const combat = runtime.combat.status();
              const skills = runtime.classSkills.status();
              const movement = runtime.movement.status();

              assert(combat.active === false, 'H6_COMBAT_STILL_ACTIVE_AFTER_STOP');
              assert(skills.pending == null, 'H6_CLASS_SKILL_STILL_PENDING_AFTER_STOP');
              assert(skills.sessionId == null, 'H6_CLASS_SKILL_SESSION_STILL_OWNED');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')),
                'H6_COMBAT_MOVEMENT_STILL_ACTIVE');

              return {
                combatActive: combat.active,
                classSkillPending: !!skills.pending,
                classSkillSessionId: skills.sessionId,
                movementActive: movement.active,
                skillMetrics: {
                  dispatched: skills.metrics.dispatched - h6Baseline.dispatched,
                  confirmed: skills.metrics.confirmed - h6Baseline.confirmed,
                  rejected: skills.metrics.rejected - h6Baseline.rejected,
                  unknown: skills.metrics.unknown - h6Baseline.unknown
                }
              };
            }
          }
        ]
      });

      this.liveTests.register({
        id: 'h7-party',
        title: 'H7 – Party',
        description: 'Ein-Klick-Live-Test für dynamische Party-Erkennung, Rollen, Focus Fire, Assist, Support-Sicht und Cleanup.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.combat.stopSession('H7_LIVE_TEST_RESET'); } catch (_) {}
          h7Plan = null;
          const party = runtime.party.status();
          const combat = runtime.combat.status();
          h7Baseline = {
            focusChanges: party.metrics.focusChanges,
            focusPingPongs: party.metrics.focusPingPongs,
            supportUnknown: party.metrics.supportUnknown,
            supportConfirmed: party.metrics.supportConfirmed,
            attackUnknown: combat.metrics.attackUnknown,
            attacksConfirmed: combat.metrics.attacksConfirmed
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.combat.stopSession('H7_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Eigene aktive Party, Rollen und sicheren Gegner prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const partyModule = runtime.modules.describe('party');
              assert(partyModule && partyModule.state === 'ACTIVE', 'PARTY_MODULE_NOT_ACTIVE');
              const party = runtime.party.snapshot();
              assert(party.available && party.size >= 2, 'H7_NEEDS_ACTIVE_PARTY_OF_AT_LEAST_2');
              assert(party.foreignMemberNames.length === 0,
                'H7_FOREIGN_PARTY_MEMBER_BLOCK:' + party.foreignMemberNames.join(','));
              assert(party.coordinationEnabled === true, 'H7_PARTY_COORDINATION_NOT_READY');
              assert(party.ownedMembers.filter(member => !member.rip).length >= 2, 'H7_NEEDS_2_LIVING_OWNED_PARTY_MEMBERS');

              const game = runtime.game.snapshot();
              assert(game && game.available && game.character && !game.character.rip, 'CHARACTER_UNAVAILABLE');
              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');

              const observerOnly = party.localRole === 'LOGISTICS'
                || String(game.character.ctype || '').toLowerCase() === 'merchant';

              if (observerOnly) {
                h7Plan = { observerOnly: true };
                return {
                  local: game.character.name,
                  localRole: party.localRole,
                  leader: party.leader,
                  partySize: party.size,
                  observerOnly: true,
                  ownedMembers: party.ownedMembers.map(member => ({
                    name: member.name,
                    ctype: member.ctype,
                    role: member.role,
                    visible: member.visible,
                    rip: member.rip
                  })),
                  target: null,
                  targetId: null
                };
              }

              const attackBudget = Math.max(5, Math.min(maxHp * 0.08, currentHp * 0.08));
              const candidates = runtime.combat.safeCandidates({ maxAcquireDistance: 450, maxAttack: attackBudget });
              assert(candidates.length > 0, 'NO_SAFE_VISIBLE_MONSTER_FOR_H7');
              const chosen = candidates[0];
              const targetAttack = Number(chosen.attack);
              assert(Number.isFinite(targetAttack) && targetAttack >= 0, 'TARGET_ATTACK_UNAVAILABLE');
              const absoluteRetreatHp = Math.max(100, targetAttack * 20);
              const minimumStartHp = Math.max(150, targetAttack * 25);
              assert(currentHp >= minimumStartHp,
                'HP_TOO_LOW_FOR_SAFE_H7_TEST:' + Math.round(currentHp) + '<' + Math.round(minimumStartHp));

              const retreatHpRatio = Math.max(0.05, Math.min(0.35, absoluteRetreatHp / maxHp));
              const resumeHpRatio = Math.max(retreatHpRatio + 0.05, Math.min(0.65, retreatHpRatio * 1.75));
              h7Plan = {
                observerOnly: false,
                monsterType: chosen.mtype || null,
                maxAttack: attackBudget,
                retreatHpRatio,
                resumeHpRatio
              };

              return {
                local: game.character.name,
                localRole: party.localRole,
                leader: party.leader,
                partySize: party.size,
                observerOnly: false,
                ownedMembers: party.ownedMembers.map(member => ({
                  name: member.name,
                  ctype: member.ctype,
                  role: member.role,
                  visible: member.visible,
                  rip: member.rip
                })),
                target: chosen.name || chosen.mtype || chosen.id,
                targetId: chosen.id
              };
            }
          },
          {
            id: 'focus-fire',
            title: 'Party-Focus/Assist prüfen und bei Combat-Rollen konvergieren lassen',
            timeoutMs: 15000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h7Plan, 'H7_LIVE_TEST_PLAN_MISSING');
              if (h7Plan.observerOnly) {
                const party = runtime.party.status();
                assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST');
                return {
                  observerOnly: true,
                  reason: 'LOGISTICS_ROLE_NO_COMBAT',
                  focusTargetId: party.focus.targetId || null,
                  focusSource: party.focus.source || null,
                  combatTargetId: null,
                  combatState: 'NOT_STARTED'
                };
              }
              const result = runtime.combat.startSession({
                owner: 'live-test-h7',
                monsterType: h7Plan.monsterType || undefined,
                maxAcquireDistance: 450,
                maxAttack: h7Plan.maxAttack,
                retreatHpRatio: h7Plan.retreatHpRatio,
                resumeHpRatio: h7Plan.resumeHpRatio,
                minMpRatio: 0,
                kiting: false,
                partyAssist: true
              });
              assert(result && result.accepted === true, result && result.reason || 'H7_COMBAT_SESSION_START_FAILED');

              const converged = await waitFor(() => {
                const party = runtime.party.status();
                const combat = runtime.combat.status();
                if (party.support.suspended) throw new Error(party.support.suspendedReason || 'PARTY_SUPPORT_UNKNOWN');
                if (combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)) {
                  throw new Error(combat.lastSession.reason || combat.lastSession.state);
                }
                if (!party.focus.targetId || !combat.session || !combat.session.targetId) return null;
                return String(party.focus.targetId) === String(combat.session.targetId)
                  ? { party, combat }
                  : null;
              }, { timeoutMs: 12000, pollMs: 125, label: 'party-focus-convergence' });

              return {
                focusTargetId: converged.party.focus.targetId,
                focusSource: converged.party.focus.source,
                combatTargetId: converged.combat.session.targetId,
                combatState: converged.combat.state
              };
            }
          },
          {
            id: 'party-health',
            title: 'Party-Health, Healing- und Recovery-Basis prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const party = runtime.party.status();
              assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST');
              assert(party.metrics.supportUnknown === h7Baseline.supportUnknown, 'PARTY_SUPPORT_UNKNOWN_DURING_TEST');
              const downed = party.party.ownedMembers.filter(member => member.rip).map(member => member.name);
              const injured = party.party.ownedMembers
                .filter(member => !member.rip && member.hpRatio != null && member.hpRatio < 0.999)
                .map(member => ({ name: member.name, hpRatio: member.hpRatio }));
              return {
                localRole: party.party.localRole,
                injured,
                downed,
                partyBuffSkills: party.partyBuffSkills,
                supportConfirmed: party.metrics.supportConfirmed - h7Baseline.supportConfirmed,
                supportPending: !!party.support.pending
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Fünf Sekunden Focus-Fire ohne UNKNOWN/Pingpong beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const party = runtime.party.status();
              const combat = runtime.combat.status();
              assert(party.metrics.supportUnknown === h7Baseline.supportUnknown, 'PARTY_SUPPORT_UNKNOWN_DURING_STABILITY_WINDOW');
              if (!(h7Plan && h7Plan.observerOnly)) {
                assert(combat.metrics.attackUnknown === h7Baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_H7_STABILITY_WINDOW');
              }
              assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST_DURING_STABILITY_WINDOW');
              const focusChanges = party.metrics.focusChanges - h7Baseline.focusChanges;
              const focusPingPongs = party.metrics.focusPingPongs - h7Baseline.focusPingPongs;
              assert(focusPingPongs === 0, 'PARTY_FOCUS_PINGPONG_DETECTED:' + focusPingPongs);
              return {
                observerOnly: !!(h7Plan && h7Plan.observerOnly),
                focusTargetId: party.focus.targetId,
                focusSource: party.focus.source,
                focusChanges,
                focusPingPongs,
                attacksConfirmed: combat.metrics.attacksConfirmed - h7Baseline.attacksConfirmed,
                supportConfirmed: party.metrics.supportConfirmed - h7Baseline.supportConfirmed,
                supportUnknown: party.metrics.supportUnknown - h7Baseline.supportUnknown
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Party-Combat sauber stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.combat.stopSession('H7_LIVE_TEST_COMPLETE');
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              const party = runtime.party.status();
              assert(combat.active === false, 'H7_COMBAT_STILL_ACTIVE_AFTER_STOP');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')),
                'H7_COMBAT_MOVEMENT_STILL_ACTIVE');
              assert(party.support.pending == null, 'H7_PARTY_SUPPORT_STILL_PENDING');
              return {
                combatActive: combat.active,
                movementActive: movement.active,
                supportPending: !!party.support.pending,
                focusTargetId: party.focus.targetId,
                partySize: party.party.size
              };
            }
          }
        ]
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
      try { this.liveTests.cancel('EMERGENCY_STOP'); } catch (_) {}

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
        actions: this.actions.status(),
        movement: this.movement.status(),
        classSkills: this.classSkills.status(),
        party: this.party.status(),
        combat: this.combat.status(),
        farming: this.farming.status(),
        liveTests: this.liveTests.status(),
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
        actionBoundary: this.actions.status(),
        movement: this.movement.status(),
        classSkills: this.classSkills.status(),
        party: this.party.status(),
        combat: this.combat.status(),
        farming: this.farming.status(),
        liveTests: this.liveTests.status(),
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
      push('action-boundary', !!this.actions.status() && this.actions.status().supportedActions.includes('move') && this.actions.status().supportedActions.includes('smart_move'), this.actions.status());
      push('movement-controller', !!this.movement.status() && typeof this.movement.moveLocal === 'function' && typeof this.movement.smartMove === 'function', this.movement.status());
      push('class-skill-controller', !!this.classSkills.status() && typeof this.classSkills.maybeUse === 'function', this.classSkills.status());
      push('party-coordinator', !!this.party.status() && typeof this.party.preferredTargetId === 'function', this.party.status());
      push('combat-controller', !!this.combat.status() && typeof this.combat.startSession === 'function' && typeof this.combat.stopSession === 'function', this.combat.status());
      push('adaptive-farming-controller', !!this.farming.status() && typeof this.farming.plan === 'function' && typeof this.farming.startSession === 'function', this.farming.status());
      push('live-test-runner', !!this.liveTests.status() && typeof this.liveTests.startRecommended === 'function', this.liveTests.status());
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
      try { this.liveTests.cancel(reason); } catch (_) {}

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
\n\n(function (root) {
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
      this.navigationResult = null;
      this.combatResult = null;
      this.liveTestClipboard = null;
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
<button class="albot-tab active" data-tab="overview">Übersicht</button><button class="albot-tab" data-tab="priorities">Prioritäten</button><button class="albot-tab" data-tab="navigation">Bewegung</button><button class="albot-tab" data-tab="combat">Combat</button><button class="albot-tab" data-tab="party">Party</button><button class="albot-tab" data-tab="live-test">Live-Test</button><button class="albot-tab" data-tab="knowledge">Knowledge</button><button class="albot-tab" data-tab="logs">Logs</button><button class="albot-tab" data-tab="dev">Entwicklung</button>
</div>
<div class="albot-body">
<section id="albot-panel-overview" class="albot-panel active"></section>
<section id="albot-panel-priorities" class="albot-panel"></section>
<section id="albot-panel-navigation" class="albot-panel"></section>
<section id="albot-panel-combat" class="albot-panel"></section>
<section id="albot-panel-party" class="albot-panel"></section>
<section id="albot-panel-live-test" class="albot-panel"></section>
<section id="albot-panel-knowledge" class="albot-panel"></section>
<section id="albot-panel-logs" class="albot-panel"></section>
<section id="albot-panel-dev" class="albot-panel"></section>
</div>
<div class="albot-footer"><button id="albot-test-start-main" class="albot-btn">Test starten</button><button id="albot-start" class="albot-btn">Start</button><button id="albot-reset-stop-main" class="albot-btn danger" style="display:none">STOP zurücksetzen</button><button id="albot-stop-normal" class="albot-btn warn">Stop</button><button id="albot-copy" class="albot-btn">Fehlerbericht kopieren</button><button id="albot-hide" class="albot-btn">Ausblenden</button></div>`;
    }

    _bind() {
      this.host.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => { this.activeTab = btn.dataset.tab; this._selectTab(); this.render(); }));
      this.host.querySelector('#albot-emergency').addEventListener('click', async () => { await this.runtime.emergencyStop('GUI_EMERGENCY_STOP'); this.render(); });
      this.host.querySelector('#albot-minimize').addEventListener('click', (event) => { event.stopPropagation(); this.toggleMinimized(); });
      this._installDrag();
      this.host.querySelector('#albot-test-start-main').addEventListener('click', () => this.runRecommendedLiveTest());
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
      const testButton = this.host.querySelector('#albot-test-start-main');
      const resetButton = this.host.querySelector('#albot-reset-stop-main');
      if (startButton) {
        startButton.disabled = status.emergencyStop.latched === true;
        startButton.title = status.emergencyStop.latched ? 'Start ist blockiert, bis der globale STOP manuell zurückgesetzt wurde.' : '';
      }
      if (testButton) {
        const liveTests = status.liveTests || {};
        testButton.disabled = status.emergencyStop.latched === true || liveTests.running === true || !liveTests.recommended;
        testButton.title = status.emergencyStop.latched
          ? 'Live-Test ist blockiert, bis der globale STOP manuell zurückgesetzt wurde.'
          : liveTests.running
            ? 'Live-Test läuft bereits.'
            : !liveTests.recommended
              ? 'Noch keine empfohlene Live-Testsuite registriert.'
              : 'Empfohlenen Live-Test automatisch ausführen.';
      }
      if (resetButton) resetButton.style.display = status.emergencyStop.latched ? '' : 'none';
    }

    _tick() {
      if (!this.host) return;
      this.runtime.roster.refresh();
      const status = this.runtime.status();
      this._updateHeader(status);
      if (this.activeTab === 'overview') this.renderOverview(status);
      if (this.activeTab === 'navigation') {
        const panel = this.host.querySelector('#albot-panel-navigation');
        const focused = panel && this.doc && this.doc.activeElement && panel.contains(this.doc.activeElement);
        if (!focused) this.renderNavigation(status);
      }
      if (this.activeTab === 'combat') {
        const panel = this.host.querySelector('#albot-panel-combat');
        const focused = panel && this.doc && this.doc.activeElement && panel.contains(this.doc.activeElement);
        if (!focused) this.renderCombat(status);
      }
      if (this.activeTab === 'party') this.renderParty(status);
      if (this.activeTab === 'live-test') this.renderLiveTest(status);
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
      this.renderNavigation(status);
      this.renderCombat(status);
      this.renderParty(status);
      this.renderLiveTest(status);
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

    renderNavigation(status) {
      const panel = this.host.querySelector('#albot-panel-navigation');
      if (!panel) return;
      const movement = status.movement || {};
      const game = status.game || {};
      const character = game.character || {};
      const active = movement.activeOrder || null;
      const last = movement.lastOrder || null;
      const safe = movement.safePoint || null;
      const resultText = this.navigationResult ? JSON.stringify(this.navigationResult, null, 2) : 'Noch keine manuelle H4-Bewegungsaktion.';

      panel.innerHTML = `<div class="albot-card"><b>H4 Bewegung</b>
<div class="albot-small">Alle Aktionen laufen über die zentrale Action-Grenze. Arrival wird aus der beobachteten Position bestätigt; ein Return von smart_move allein gilt nicht als Ankunft.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Modul</span><div class="albot-v">${movement.enabled ? 'ACTIVE' : 'STOPPED'}</div></div>
<div><span class="albot-k">Zustand</span><div class="albot-v">${esc(movement.state || 'IDLE')}</div></div>
<div><span class="albot-k">Map</span><div class="albot-v">${esc(character.map || '-')}</div></div>
<div><span class="albot-k">Position</span><div class="albot-v">x=${esc(formatPosition(character.x))} · y=${esc(formatPosition(character.y))}</div></div>
<div><span class="albot-k">Aktiver Auftrag</span><div class="albot-v">${active ? esc(active.kind)+' · '+esc(active.id) : 'keiner'}</div></div>
<div><span class="albot-k">Safe Point</span><div class="albot-v">${safe ? esc(safe.map)+' · '+esc(formatPosition(safe.x))+', '+esc(formatPosition(safe.y)) : 'nicht gesetzt'}</div></div>
</div></div>

<div class="albot-card"><b>Kontrollierter Zielpunkt</b>
<div class="albot-row"><input id="albot-nav-map" value="${esc(character.map || '')}" placeholder="Map"><input id="albot-nav-x" type="number" step="0.01" placeholder="x"><input id="albot-nav-y" type="number" step="0.01" placeholder="y"></div>
<div class="albot-row"><button id="albot-nav-local" class="albot-btn">Lokal bewegen</button><button id="albot-nav-smart" class="albot-btn">Smart Move</button><button id="albot-nav-retarget" class="albot-btn">Retarget</button><button id="albot-nav-cancel" class="albot-btn danger">Bewegung abbrechen</button></div>
</div>

<div class="albot-card"><b>Zielannäherung & Safe Return</b>
<div class="albot-row"><input id="albot-nav-distance" type="number" min="0" step="1" placeholder="Abstand zum ausgewählten Target"><button id="albot-nav-approach" class="albot-btn">Target annähern</button></div>
<div class="albot-row"><button id="albot-nav-safe-capture" class="albot-btn">Safe Point hier setzen</button><button id="albot-nav-safe-return" class="albot-btn">Zum Safe Point zurück</button></div>
</div>

<div class="albot-card"><b>Letzter Status</b>
<div class="albot-small">${last ? 'Letzter Auftrag: '+esc(last.state)+' · '+esc(last.reason || '-') : 'Noch kein abgeschlossener Auftrag.'}</div>
<div class="albot-log" style="margin-top:8px;max-height:220px">${esc(resultText)}</div>
</div>`;

      const readDestination = () => {
        const map = panel.querySelector('#albot-nav-map').value.trim();
        const xRaw = panel.querySelector('#albot-nav-x').value;
        const yRaw = panel.querySelector('#albot-nav-y').value;
        const x = xRaw === '' ? null : Number(xRaw);
        const y = yRaw === '' ? null : Number(yRaw);
        return { map: map || character.map || null, x, y };
      };
      const run = fn => {
        try { this.navigationResult = fn(); }
        catch (error) { this.navigationResult = { accepted: false, reason: String(error && error.message || error) }; }
        this.renderNavigation(this.runtime.status());
      };

      panel.querySelector('#albot-nav-local').onclick = () => {
        const destination = readDestination();
        run(() => this.runtime.movement.moveLocal(destination.x, destination.y, { owner: 'gui-h4-local' }));
      };
      panel.querySelector('#albot-nav-smart').onclick = () => {
        const destination = readDestination();
        run(() => this.runtime.movement.smartMove(destination, { owner: 'gui-h4-smart' }));
      };
      panel.querySelector('#albot-nav-retarget').onclick = () => {
        const destination = readDestination();
        run(() => this.runtime.movement.retarget(destination, { owner: 'gui-h4-retarget' }));
      };
      panel.querySelector('#albot-nav-cancel').onclick = () => run(() => this.runtime.movement.cancel('GUI_MOVEMENT_CANCEL'));
      panel.querySelector('#albot-nav-approach').onclick = () => {
        const raw = panel.querySelector('#albot-nav-distance').value;
        run(() => this.runtime.movement.approachCurrentTarget({
          owner: 'gui-h4-target-approach',
          distance: raw === '' ? undefined : Number(raw)
        }));
      };
      panel.querySelector('#albot-nav-safe-capture').onclick = () => run(() => this.runtime.movement.captureSafePoint('GUI'));
      panel.querySelector('#albot-nav-safe-return').onclick = () => run(() => this.runtime.movement.safeReturn({ owner: 'gui-h4-safe-return' }));
    }

    renderCombat(status) {
      const panel = this.host.querySelector('#albot-panel-combat');
      if (!panel) return;
      const combat = status.combat || {};
      const session = combat.session || null;
      const metrics = combat.metrics || {};
      const classSkills = status.classSkills || {};
      const skillMetrics = classSkills.metrics || {};
      const pendingSkill = classSkills.pending || null;
      const liveSkills = Array.isArray(classSkills.liveSkills) ? classSkills.liveSkills.filter(row => row.available).map(row => row.id) : [];
      const pending = combat.pendingAttack || null;
      const candidates = Array.isArray(combat.safeCandidates) ? combat.safeCandidates : [];
      const resultText = this.combatResult ? JSON.stringify(this.combatResult, null, 2) : 'Noch keine manuelle H6-Combat-Session.';

      panel.innerHTML = `<div class="albot-card"><b>H5/H6 Combat & Klassenlogik</b>
<div class="albot-small">H5 stellt Targeting, Movement und Basisangriff bereit. H6 ergänzt klassenspezifische Skills mit Live-Readiness, MP-Reserve, Cooldown-Prüfung und Anti-Spam. Party- und AoE-Logik folgen erst in H7/H8.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Modul</span><div class="albot-v">${combat.moduleActive ? 'ACTIVE' : 'STOPPED'}</div></div>
<div><span class="albot-k">Combat</span><div class="albot-v">${esc(combat.state || 'IDLE')}</div></div>
<div><span class="albot-k">Target</span><div class="albot-v">${session && session.targetId ? esc(session.targetType || session.targetId) : 'keins'}</div></div>
<div><span class="albot-k">Attack Outcome</span><div class="albot-v">${pending ? esc(pending.commandSettlement || 'PENDING') : 'kein offener Angriff'}</div></div>
<div><span class="albot-k">Angriffe bestätigt</span><div class="albot-v">${esc(metrics.attacksConfirmed || 0)}</div></div>
<div><span class="albot-k">UNKNOWN</span><div class="albot-v">${esc(metrics.attackUnknown || 0)}</div></div>
<div><span class="albot-k">Approaches</span><div class="albot-v">${esc(metrics.approaches || 0)}</div></div>
<div><span class="albot-k">Retreats</span><div class="albot-v">${esc(metrics.retreats || 0)}</div></div>
</div></div>

<div class="albot-card"><b>H6 Klassen-Skills</b>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Klasse</span><div class="albot-v">${esc(classSkills.currentClass || '-')}</div></div>
<div><span class="albot-k">Live Skills</span><div class="albot-v">${liveSkills.length ? liveSkills.map(esc).join(', ') : 'keine'}</div></div>
<div><span class="albot-k">Pending</span><div class="albot-v">${pendingSkill ? esc(pendingSkill.skillId) : 'keiner'}</div></div>
<div><span class="albot-k">Bestätigt</span><div class="albot-v">${esc(skillMetrics.confirmed || 0)}</div></div>
<div><span class="albot-k">Abgelehnt</span><div class="albot-v">${esc(skillMetrics.rejected || 0)}</div></div>
<div><span class="albot-k">UNKNOWN</span><div class="albot-v">${esc(skillMetrics.unknown || 0)}</div></div>
<div><span class="albot-k">Anti-Spam Skips</span><div class="albot-v">${esc(skillMetrics.spamSkips || 0)}</div></div>
<div><span class="albot-k">Suspendiert</span><div class="albot-v">${classSkills.suspended ? 'JA · '+esc(classSkills.suspendedReason || '-') : 'NEIN'}</div></div>
</div>
<div class="albot-small" style="margin-top:8px">Letzter Skill: ${classSkills.lastUse ? esc(classSkills.lastUse.skillId)+' · '+esc(classSkills.lastUse.state)+' · '+esc(classSkills.lastUse.reason || '-') : 'noch keiner'}</div>
</div>

<div class="albot-card"><b>Manuelle H6-Session</b>
<div class="albot-row"><input id="albot-combat-type" placeholder="Monster-Typ optional, z.B. goo"><input id="albot-combat-maxattack" type="number" min="0" step="1" placeholder="Max. Monster-Angriff optional"></div>
<div class="albot-row"><label class="albot-small"><input id="albot-combat-kiting" type="checkbox"> Kiting-Grundlage aktivieren</label></div>
<div class="albot-row"><button id="albot-combat-start" class="albot-btn" ${combat.active ? 'disabled' : ''}>Combat starten</button><button id="albot-combat-stop" class="albot-btn warn" ${combat.active ? '' : 'disabled'}>Combat stoppen</button></div>
<div class="albot-small">Sichere sichtbare Kandidaten: ${candidates.length ? candidates.map(row => esc(row.mtype || row.name || row.id)+' ('+esc(row.distance == null ? '?' : Math.round(row.distance))+')').join(', ') : 'keine'}</div>
</div>

<div class="albot-card"><b>Letztes Ergebnis</b><div class="albot-log">${esc(resultText)}</div></div>`;

      const run = fn => {
        try { this.combatResult = fn(); }
        catch (error) { this.combatResult = { accepted: false, reason: String(error && error.message || error) }; }
        this.renderCombat(this.runtime.status());
      };

      const start = panel.querySelector('#albot-combat-start');
      if (start) start.onclick = () => {
        const type = panel.querySelector('#albot-combat-type').value.trim();
        const maxRaw = panel.querySelector('#albot-combat-maxattack').value;
        const kiting = panel.querySelector('#albot-combat-kiting').checked;
        run(() => this.runtime.combat.startSession({
          owner: 'gui-h6-combat',
          monsterType: type || undefined,
          maxAttack: maxRaw === '' ? undefined : Number(maxRaw),
          kiting
        }));
      };
      const stop = panel.querySelector('#albot-combat-stop');
      if (stop) stop.onclick = () => run(() => this.runtime.combat.stopSession('GUI_COMBAT_STOP'));
    }

    renderParty(status) {
      const panel = this.host.querySelector('#albot-panel-party');
      if (!panel) return;
      const partyStatus = status.party || {};
      const party = partyStatus.party || {};
      const focus = partyStatus.focus || {};
      const support = partyStatus.support || {};
      const metrics = partyStatus.metrics || {};
      const members = Array.isArray(party.members) ? party.members : [];
      panel.innerHTML = `<div class="albot-card"><b>H7 Party</b>
<div class="albot-small">Koordination ist nur aktiv, wenn mindestens zwei eigene Party-Mitglieder erkannt wurden und kein fremdes Mitglied enthalten ist. Focus Fire basiert auf frischen sichtbaren Targets; Healing/Revive laufen nur über bestätigte Live-Readiness.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Party</span><div class="albot-v">${party.available ? esc(party.size)+' Mitglieder' : 'keine'}</div></div>
<div><span class="albot-k">Koordination</span><div class="albot-v">${party.coordinationEnabled ? 'AKTIV' : 'BLOCKIERT / SOLO'}</div></div>
<div><span class="albot-k">Leader</span><div class="albot-v">${esc(party.leader || '-')}</div></div>
<div><span class="albot-k">Lokale Rolle</span><div class="albot-v">${esc(party.localRole || '-')}</div></div>
<div><span class="albot-k">Focus Target</span><div class="albot-v">${esc(focus.targetId || '-')}</div></div>
<div><span class="albot-k">Focus Quelle</span><div class="albot-v">${esc(focus.source || '-')}</div></div>
<div><span class="albot-k">Support</span><div class="albot-v">${support.suspended ? 'SUSPENDIERT' : support.pending ? 'PENDING' : 'bereit'}</div></div>
<div><span class="albot-k">Support bestätigt</span><div class="albot-v">${esc(metrics.supportConfirmed || 0)}</div></div>
</div></div>
<div class="albot-card"><b>Party-Mitglieder & Rollen</b>
${members.length ? members.map(member => '<div class="albot-small"><b>'+esc(member.name)+'</b> · '+esc(member.ctype || '?')+' · '+esc(member.role || 'UNKNOWN')+' · '+(member.owned ? 'OWNED' : 'FOREIGN')+' · '+(member.rip ? 'DOWN' : member.hpRatio == null ? 'HP ?' : 'HP '+esc(Math.round(member.hpRatio*100))+'%')+' · Target '+esc(member.targetId || '-')+'</div>').join('') : '<div class="albot-small">Keine Party-Mitglieder erkannt.</div>'}
</div>
<div class="albot-card"><b>Support / Recovery</b>
<div class="albot-small">Party-Buffs/Auras aus Live-Skills: ${partyStatus.partyBuffSkills && partyStatus.partyBuffSkills.length ? partyStatus.partyBuffSkills.map(esc).join(', ') : 'keine für lokale Klasse erkannt'}</div>
<div class="albot-small">Heal Dispatches: ${esc(metrics.healsDispatched || 0)} · Party Heal: ${esc(metrics.partyHealsDispatched || 0)} · Revive: ${esc(metrics.revivesDispatched || 0)} · UNKNOWN: ${esc(metrics.supportUnknown || 0)} · Focus-Pingpong: ${esc(metrics.focusPingPongs || 0)}</div>
${party.foreignMemberNames && party.foreignMemberNames.length ? '<div class="albot-small albot-bad">Fremde Party-Mitglieder blockieren automatische Koordination: '+party.foreignMemberNames.map(esc).join(', ')+'</div>' : ''}
${support.suspended ? '<div class="albot-small albot-bad">Support suspendiert: '+esc(support.suspendedReason || '-')+'</div>' : ''}
</div>`;
    }

    async runRecommendedLiveTest() {
      const state = this.runtime.status();
      if (state.emergencyStop && state.emergencyStop.latched) {
        this.runtime.logger.warn('Live-Test durch globalen STOP blockiert');
        this.activeTab = 'live-test';
        this._selectTab();
        this.renderLiveTest(state);
        return null;
      }
      this.activeTab = 'live-test';
      this._selectTab();
      this.liveTestClipboard = { pending: true, copied: false, error: null };
      this.render();
      let result = null;
      try {
        result = await this.runtime.liveTests.startRecommended();
      } catch (error) {
        this.runtime.logger.error('Live-Test konnte nicht gestartet werden', { error: String(error && error.message || error) });
      }
      const copy = await this.copyDiagnostics();
      this.liveTestClipboard = { pending: false, copied: copy.copied === true, error: copy.error || null };
      this.render();
      return result;
    }

    renderLiveTest(status) {
      const panel = this.host.querySelector('#albot-panel-live-test');
      if (!panel) return;
      const tests = status.liveTests || {};
      const recommended = tests.recommended || null;
      const run = tests.current || tests.lastRun || null;
      const running = tests.running === true;
      const state = run ? run.state : 'BEREIT';
      const stateClass = state === 'PASSED' ? 'albot-ok' : (state === 'FAILED' || state === 'CANCELLED' ? 'albot-bad' : '');
      const clipboard = this.liveTestClipboard;
      const clipboardText = clipboard == null
        ? 'Nach Testende wird der vollständige Fehlerbericht automatisch in die Zwischenablage kopiert.'
        : clipboard.copied
          ? 'Test beendet · Fehlerbericht automatisch in die Zwischenablage kopiert.'
          : clipboard.pending
            ? 'Test läuft · Bericht wird nach Abschluss automatisch kopiert.'
            : 'Test beendet · automatische Zwischenablage-Kopie fehlgeschlagen: ' + esc(clipboard.error || 'unbekannt');

      const steps = run && Array.isArray(run.steps) ? run.steps : recommended && Array.isArray(recommended.steps)
        ? recommended.steps.map(step => ({ ...step, state: 'PENDING' }))
        : [];

      panel.innerHTML = `<div class="albot-card"><b>Ein-Klick-Live-Test</b>
<div class="albot-small">Ab H5 laufen Live-Tests automatisch als definierte Schrittfolge. Du musst nur „Test starten“ drücken. Bei einem Fehler wird fail-safe abgebrochen; der globale rote STOP bleibt jederzeit verfügbar.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Testsuite</span><div class="albot-v">${recommended ? esc(recommended.title) : 'noch nicht registriert'}</div></div>
<div><span class="albot-k">Status</span><div class="albot-v ${stateClass}">${esc(state)}</div></div>
<div><span class="albot-k">Aktueller Schritt</span><div class="albot-v">${run && run.currentStepId ? esc(run.currentStepId) : '-'}</div></div>
<div><span class="albot-k">Runtime</span><div class="albot-v">${status.running ? 'RUNNING' : 'STOPPED'}</div></div>
</div>
<div class="albot-row"><button id="albot-live-test-start" class="albot-btn" ${running || !recommended ? 'disabled' : ''}>Test starten</button>${running ? '<span class="albot-small">Test läuft automatisch …</span>' : ''}</div>
<div class="albot-small ${clipboard && clipboard.copied ? 'albot-ok' : clipboard && !clipboard.pending ? 'albot-bad' : ''}">${clipboardText}</div>
</div>

<div class="albot-card"><b>Testschritte</b>
${steps.length ? steps.map((step, index) => {
  const stepClass = step.state === 'PASSED' ? 'albot-ok' : (step.state === 'FAILED' || step.state === 'CANCELLED' ? 'albot-bad' : 'albot-muted');
  const details = step.error ? ' · '+esc(step.error.message || step.error) : step.result != null ? ' · '+esc(JSON.stringify(step.result)) : '';
  return '<div class="'+stepClass+'">'+esc(index + 1)+'. '+esc(step.title || step.id)+' — '+esc(step.state || 'PENDING')+details+'</div>';
}).join('') : '<div class="albot-small">Für den aktuellen Entwicklungsstand ist noch keine Live-Testsuite registriert.</div>'}
</div>

${run ? `<div class="albot-card"><b>Letztes Testergebnis</b>
<div class="${stateClass}"><b>${state === 'PASSED' ? 'TEST BEENDET – BESTANDEN' : state === 'RUNNING' ? 'TEST LÄUFT' : 'TEST BEENDET – '+esc(state)}</b></div>
<div class="albot-small">Grund: ${esc(run.reason || '-')}</div>
<div class="albot-small">Start: ${esc(run.startedAt || '-')} · Ende: ${esc(run.finishedAt || '-')}</div>
</div>` : ''}`;

      const start = panel.querySelector('#albot-live-test-start');
      if (start) start.onclick = () => this.runRecommendedLiveTest();
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
      const resultText = this.devResult ? JSON.stringify(this.devResult, null, 2) : 'H7 Party · ' + status.version;
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
        this.renderLogs();
        return { copied: true, text, error: null };
      } catch (e) {
        this.runtime.logger.error('Clipboard-Kopie fehlgeschlagen', { error: e.message });
        this.renderLogs();
        return { copied: false, text, error: String(e && e.message || e) };
      }
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
\n\n(function (root) {
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
    version: '0.7.0-h7',
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

    movement: {
      status: () => runtime.movement.status(),
      local: (x, y, options) => runtime.movement.moveLocal(x, y, options || {}),
      smart: (destination, options) => runtime.movement.smartMove(destination, options || {}),
      approachTarget: options => runtime.movement.approachCurrentTarget(options || {}),
      retarget: (destination, options) => runtime.movement.retarget(destination, options || {}),
      cancel: reason => runtime.movement.cancel(reason || 'API_MOVEMENT_CANCEL'),
      captureSafePoint: source => runtime.movement.captureSafePoint(source || 'API'),
      safeReturn: options => runtime.movement.safeReturn(options || {})
    },

    combat: {
      status: () => runtime.combat.status(),
      start: options => runtime.combat.startSession(options || {}),
      stop: reason => runtime.combat.stopSession(reason || 'API_COMBAT_STOP'),
      candidates: options => runtime.combat.safeCandidates(options || {})
    },

    classSkills: {
      status: () => runtime.classSkills.status(),
      supported: ctype => runtime.classSkills.supportedSkills(ctype),
      live: ctype => runtime.classSkills.liveSkillSummary(ctype),
      preview: targetId => runtime.classSkills.preview(targetId)
    },

    party: {
      status: () => runtime.party.status(),
      snapshot: () => runtime.party.snapshot(),
      focusTarget: () => runtime.party.preferredTargetId()
    },

    farming: {
      status: () => runtime.farming.status(),
      start: options => runtime.farming.startSession(options || {}),
      stop: reason => runtime.farming.stopSession(reason || 'API_H8_STOP'),
      plan: () => runtime.farming.plan(),
      supportedAoeSkills: ctype => runtime.farming.supportedAoeSkills(ctype),
      liveAoeSkills: ctype => runtime.farming.liveAoeSkills(ctype)
    },

    liveTests: {
      status: () => runtime.liveTests.status(),
      list: () => runtime.liveTests.list(),
      start: id => runtime.liveTests.start(id),
      startRecommended: () => runtime.liveTests.startRecommended(),
      cancel: reason => runtime.liveTests.cancel(reason || 'API_LIVE_TEST_CANCEL')
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
  Object.freeze(api.movement);
  Object.freeze(api.combat);
  Object.freeze(api.classSkills);
  Object.freeze(api.party);
  Object.freeze(api.farming);
  Object.freeze(api.liveTests);
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

  runtime.logger.info('AL Bot H7 geladen', {
    version: api.version,
    bootCount,
    hotReload: !!previous,
    sharedHost: sharedHost !== root
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
\n