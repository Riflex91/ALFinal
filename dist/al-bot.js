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
