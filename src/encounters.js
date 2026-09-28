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

  function nowIso() { return new Date().toISOString(); }
  function bool(value) {
    return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
  }

  class EncounterController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.storage = options.storage || null;
      this.game = options.game || null;
      this.movement = options.movement || null;
      this.combat = options.combat || null;
      this.party = options.party || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : () => true;
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.autonomyEnabled = false;
      this.suspendedReason = null;
      this.session = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.announcements = new Map();
      this.knownEvents = new Map();
      this.disabled = { boss: new Set(), event: new Set() };
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        eventTtlMs: Math.max(60000, Math.min(21600000, Number(options.eventTtlMs) || 1800000)),
        approachDistance: Math.max(100, Math.min(1200, Number(options.approachDistance) || 650)),
        maxAttackToHpRatio: Math.max(0.05, Math.min(0.8, Number(options.maxAttackToHpRatio) || 0.32))
      };
      this.metrics = { ticks: 0, plans: 0, combatStarts: 0, travelOrders: 0, suspensions: 0 };
      this._loadPreferences();
    }

    _prefKey() { return 'albot:encounter-preferences:v1'; }

    _loadPreferences() {
      if (!this.storage || typeof this.storage.get !== 'function') return;
      try {
        const raw = this.storage.get(this._prefKey());
        if (!raw) return;
        const value = JSON.parse(raw);
        for (const kind of ['boss', 'event']) {
          const rows = Array.isArray(value && value.disabled && value.disabled[kind]) ? value.disabled[kind] : [];
          this.disabled[kind] = new Set(rows.map(x => cleanText(x, 160)).filter(Boolean));
        }
        const known = value && value.knownEvents && typeof value.knownEvents === 'object' ? value.knownEvents : {};
        for (const [id, row] of Object.entries(known)) this.knownEvents.set(id, clone(row));
      } catch (_) {}
    }

    _persistPreferences() {
      if (!this.storage || typeof this.storage.set !== 'function') return;
      const knownEvents = {};
      for (const [id, row] of this.knownEvents.entries()) knownEvents[id] = clone(row);
      this.storage.set(this._prefKey(), JSON.stringify({
        schemaVersion: 1,
        disabled: {
          boss: [...this.disabled.boss].sort(),
          event: [...this.disabled.event].sort()
        },
        knownEvents
      }));
    }

    _roots() {
      const out = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!out.includes(current)) out.push(current);
        let next = null;
        try {
          next = current.parent && current.parent !== current ? current.parent : null;
          if (next) void next.document;
        } catch (_) { next = null; }
        if (!next) break;
        current = next;
      }
      return out;
    }

    _read(name) {
      for (const candidate of this._roots()) {
        try { if (candidate && candidate[name] != null) return candidate[name]; } catch (_) {}
      }
      return null;
    }

    _eventEmitter() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && candidate.game && typeof candidate.game.on === 'function') return candidate.game;
        } catch (_) {}
      }
      return null;
    }

    _onAnnouncement(payload) {
      const raw = payload && typeof payload === 'object' ? payload : {};
      const id = cleanText(raw.name || raw.event || raw.id || raw.type || '', 160);
      if (!id) return;
      const row = {
        id,
        name: cleanText(raw.name || id, 160) || id,
        map: cleanText(raw.map || '', 120) || null,
        x: finite(raw.x),
        y: finite(raw.y),
        active: raw.live === false || raw.active === false ? false : true,
        source: 'game-event',
        observedAt: nowIso(),
        observedAtMs: Date.now()
      };
      this.announcements.set(id, row);
      this.knownEvents.set(id, row);
      this._persistPreferences();
      if (this.logger) this.logger.info('Encounter-Event erkannt', row);
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('encounter-tick', () => this.tick(), this.config.tickMs, { immediate: false });
      }
      const emitter = this._eventEmitter();
      if (emitter) {
        const handler = payload => this._onAnnouncement(payload);
        try {
          emitter.on('event', handler);
          if (this.scope && typeof this.scope.cleanup === 'function') {
            this.scope.cleanup('encounter-game-event', () => {
              try {
                if (typeof emitter.off === 'function') emitter.off('event', handler);
                else if (typeof emitter.removeListener === 'function') emitter.removeListener('event', handler);
              } catch (_) {}
            });
          }
        } catch (_) {}
      }
      return this.status();
    }

    stop(reason = 'ENCOUNTER_MODULE_STOP') {
      this.stopAutonomy(reason);
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    _serverEvents() {
      const S = this._read('S');
      if (!S || typeof S !== 'object') return [];
      const rows = [];
      for (const [id, raw] of Object.entries(S)) {
        if (!raw || typeof raw !== 'object') continue;
        const active = bool(raw.live) || bool(raw.active) || bool(raw.running);
        const looksEvent = active || raw.map != null || raw.x != null || raw.y != null;
        if (!looksEvent) continue;
        rows.push({
          id: cleanText(id, 160),
          name: cleanText(raw.name || id, 160) || cleanText(id, 160),
          map: cleanText(raw.map || '', 120) || null,
          x: finite(raw.x),
          y: finite(raw.y),
          active,
          source: 'server-state',
          observedAt: nowIso(),
          observedAtMs: Date.now()
        });
      }
      return rows;
    }

    _visibleBosses() {
      const monsters = this.game && typeof this.game.visibleMonsters === 'function' ? this.game.visibleMonsters() : [];
      return (monsters || []).filter(row => {
        if (!row || !row.mtype) return false;
        const def = this.game && typeof this.game.monsterDefinition === 'function' ? this.game.monsterDefinition(row.mtype) : null;
        return !!(def && def.boss === true);
      });
    }

    _bossCatalog() {
      const G = this._read('G');
      const defs = G && G.monsters && typeof G.monsters === 'object' ? G.monsters : {};
      const visible = this._visibleBosses();
      const visibleByType = new Map();
      for (const row of visible) {
        const key = String(row.mtype);
        const current = visibleByType.get(key);
        if (!current || Number(row.distance || Infinity) < Number(current.distance || Infinity)) visibleByType.set(key, row);
      }
      const rows = [];
      for (const [id, raw] of Object.entries(defs)) {
        if (!raw || raw.boss !== true) continue;
        const seen = visibleByType.get(String(id)) || null;
        rows.push({
          kind: 'boss',
          id: String(id),
          name: cleanText(raw.name || id, 160) || String(id),
          enabled: !this.disabled.boss.has(String(id)),
          active: !!seen,
          visible: !!seen,
          map: seen && seen.map || null,
          x: seen && finite(seen.x),
          y: seen && finite(seen.y),
          distance: seen && finite(seen.distance),
          cooperative: raw.cooperative === true,
          hp: seen && finite(seen.hp),
          maxHp: seen && finite(seen.maxHp),
          source: seen ? 'live-visible' : 'game-data'
        });
      }
      rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      return rows;
    }

    _eventCatalog() {
      const now = Date.now();
      const merged = new Map();
      for (const [id, row] of this.knownEvents.entries()) merged.set(id, { ...clone(row), active: false, source: 'known' });
      for (const row of this._serverEvents()) {
        merged.set(row.id, { ...(merged.get(row.id) || {}), ...row });
        this.knownEvents.set(row.id, clone(row));
      }
      for (const [id, row] of this.announcements.entries()) {
        const fresh = now - Number(row.observedAtMs || 0) <= this.config.eventTtlMs;
        merged.set(id, { ...(merged.get(id) || {}), ...clone(row), active: row.active !== false && fresh });
      }
      const rows = [];
      for (const [id, raw] of merged.entries()) {
        rows.push({
          kind: 'event',
          id,
          name: cleanText(raw.name || id, 160) || id,
          enabled: !this.disabled.event.has(id),
          active: raw.active === true,
          map: raw.map || null,
          x: finite(raw.x),
          y: finite(raw.y),
          source: raw.source || 'known',
          observedAt: raw.observedAt || null
        });
      }
      this._persistPreferences();
      rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      return rows;
    }

    catalog() {
      return { schemaVersion: 1, bosses: this._bossCatalog(), events: this._eventCatalog(), defaultEnabled: true };
    }

    setEnabled(kind, id, enabled) {
      const key = String(kind || '').toLowerCase();
      const name = cleanText(id, 160);
      if (!['boss', 'event'].includes(key) || !name) return { accepted: false, reason: 'ENCOUNTER_PREFERENCE_INVALID' };
      if (enabled === false) this.disabled[key].add(name);
      else this.disabled[key].delete(name);
      this._persistPreferences();
      return { accepted: true, kind: key, id: name, enabled: !this.disabled[key].has(name) };
    }

    setAll(kind, enabled) {
      const key = String(kind || '').toLowerCase();
      if (!['boss', 'event'].includes(key)) return { accepted: false, reason: 'ENCOUNTER_KIND_INVALID' };
      const rows = key === 'boss' ? this._bossCatalog() : this._eventCatalog();
      if (enabled === false) for (const row of rows) this.disabled[key].add(row.id);
      else this.disabled[key].clear();
      this._persistPreferences();
      return { accepted: true, kind: key, enabled: enabled !== false, count: rows.length };
    }

    preferredTask() {
      const catalog = this.catalog();
      const event = catalog.events.find(row => row.active && row.enabled);
      if (event) return { taskType: 'EVENT', encounter: clone(event) };
      const boss = catalog.bosses.find(row => row.active && row.enabled);
      if (boss) return { taskType: 'BOSS', encounter: clone(boss) };
      return null;
    }

    _monsterTypeFor(row) {
      if (!row) return null;
      if (row.kind === 'boss') return row.id;
      const def = this.game && typeof this.game.monsterDefinition === 'function' ? this.game.monsterDefinition(row.id) : null;
      return def ? row.id : null;
    }

    plan(options = {}) {
      this.metrics.plans += 1;
      const catalog = this.catalog();
      const requested = cleanText(options.taskType || this.session && this.session.taskType || '', 40).toUpperCase();
      const candidates = requested === 'BOSS'
        ? catalog.bosses.filter(row => row.active && row.enabled)
        : requested === 'EVENT'
          ? catalog.events.filter(row => row.active && row.enabled)
          : [...catalog.events.filter(row => row.active && row.enabled), ...catalog.bosses.filter(row => row.active && row.enabled)];
      const selected = candidates[0] || null;
      if (!selected) {
        this.lastPlan = { state: 'WAITING', reason: 'NO_ENABLED_ACTIVE_ENCOUNTER', taskType: requested || null, selected: null };
        return clone(this.lastPlan);
      }
      const monsterType = this._monsterTypeFor(selected);
      const visible = monsterType && this.game && typeof this.game.visibleMonsters === 'function'
        ? this.game.visibleMonsters({ type: monsterType })
        : [];
      const target = (visible || []).sort((a, b) => Number(a.distance || Infinity) - Number(b.distance || Infinity))[0] || null;
      const hp = finite(target && target.hp);
      const maxHp = finite(target && (target.maxHp || target.max_hp));
      const ratio = hp != null && maxHp != null && maxHp > 0 ? hp / maxHp : null;
      const phase = ratio == null ? null : ratio > 0.75 ? 1 : ratio > 0.5 ? 2 : ratio > 0.25 ? 3 : 4;
      this.lastPlan = {
        state: 'READY',
        reason: 'ENCOUNTER_ACTIVE',
        taskType: selected.kind === 'event' ? 'EVENT' : 'BOSS',
        selected: clone(selected),
        monsterType,
        location: { map: selected.map || target && target.map || null, x: finite(selected.x), y: finite(selected.y) },
        visibleTargetId: target && target.id || null,
        visible: !!target,
        phase,
        hpRatio: ratio
      };
      return clone(this.lastPlan);
    }

    configureGroup(options = {}) {
      if (!this.session) return { changed: false, reason: 'ENCOUNTER_SESSION_NOT_ACTIVE' };
      this.session.groupLeaderName = cleanText(options.groupLeaderName || '', 120) || null;
      this.session.groupMemberNames = [...new Set((Array.isArray(options.groupMemberNames) ? options.groupMemberNames : []).map(String))].sort();
      return { changed: true, groupLeaderName: this.session.groupLeaderName, groupMemberNames: clone(this.session.groupMemberNames) };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'ENCOUNTER_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      const taskType = cleanText(options.taskType || '', 40).toUpperCase();
      if (!['BOSS', 'EVENT'].includes(taskType)) return { accepted: false, reason: 'ENCOUNTER_TASK_TYPE_INVALID' };
      this.autonomyEnabled = true;
      this.session = {
        owner: cleanText(options.owner || 'manual', 80) || 'manual',
        taskType,
        groupLeaderName: cleanText(options.groupLeaderName || '', 120) || null,
        groupMemberNames: [...new Set((Array.isArray(options.groupMemberNames) ? options.groupMemberNames : []).map(String))].sort(),
        startedAt: nowIso()
      };
      return { accepted: true, status: this.status() };
    }

    _ownedMovement() {
      const status = this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null;
      const order = status && (status.activeOrder || status.active);
      return order && String(order.owner || '').startsWith('encounter-h23') ? order : null;
    }

    stopAutonomy(reason = 'ENCOUNTER_AUTONOMY_STOP') {
      const owner = this.session && this.session.owner;
      this.autonomyEnabled = false;
      if (this.combat && typeof this.combat.status === 'function') {
        const status = this.combat.status();
        if (status && status.session && String(status.session.owner || '').startsWith('encounter-h23')) {
          try { this.combat.stopSession(reason); } catch (_) {}
        }
      }
      if (this._ownedMovement() && this.movement && typeof this.movement.cancel === 'function') {
        try { this.movement.cancel(reason); } catch (_) {}
      }
      this.session = null;
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 200), owner: owner || null };
      return this.status();
    }

    resetSafety(reason = 'ENCOUNTER_EXPLICIT_RESET') {
      this.suspendedReason = null;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 200) };
      return this.status();
    }

    _suspend(reason) {
      this.suspendedReason = cleanText(reason || 'ENCOUNTER_SUSPENDED', 240);
      this.metrics.suspensions += 1;
      this.stopAutonomy(this.suspendedReason);
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    tick() {
      this.metrics.ticks += 1;
      if (this.heartbeat) {
        try { this.heartbeat({ phase: 'encounter', enabled: this.autonomyEnabled, taskType: this.session && this.session.taskType || null }); } catch (_) {}
      }
      if (!this.moduleActive || !this.autonomyEnabled || !this.session) return { state: 'IDLE', reason: 'ENCOUNTER_AUTONOMY_DISABLED' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (this.canAct('encounter') !== true) return { state: 'BLOCKED', reason: 'ENCOUNTER_RUNTIME_ACTION_BLOCKED' };

      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!character || character.rip === true) return { state: 'BLOCKED', reason: character && character.rip ? 'CHARACTER_DEAD' : 'CHARACTER_UNAVAILABLE' };
      if (String(character.ctype || '').toLowerCase() === 'merchant') return { state: 'OBSERVER_ONLY', reason: 'MERCHANT_NO_ENCOUNTER_COMBAT' };

      const plan = this.plan({ taskType: this.session.taskType });
      if (!plan || plan.state !== 'READY') return plan;

      const combatStatus = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
      const combatSession = combatStatus && combatStatus.session;
      if (combatStatus && combatStatus.lastSession && String(combatStatus.lastSession.owner || '').startsWith('encounter-h23')
          && combatStatus.lastSession.state === 'UNKNOWN') {
        return this._suspend(combatStatus.lastSession.reason || 'ENCOUNTER_COMBAT_UNKNOWN');
      }

      if (plan.monsterType && plan.visible) {
        if (!combatSession) {
          const definition = this.game && typeof this.game.monsterDefinition === 'function'
            ? this.game.monsterDefinition(plan.monsterType)
            : null;
          const started = this.combat.startSession({
            owner: 'encounter-h23:' + plan.taskType.toLowerCase(),
            monsterType: plan.monsterType,
            maxAcquireDistance: this.config.approachDistance,
            maxAttackToHpRatio: this.config.maxAttackToHpRatio,
            allowContested: !!(definition && definition.cooperative === true),
            partyAssist: true,
            kiting: false,
            leaderOwnedPulls: true,
            groupLeaderName: this.session.groupLeaderName,
            groupMemberNames: this.session.groupMemberNames
          });
          if (!started || started.accepted !== true) return { state: 'BLOCKED', reason: started && started.reason || 'ENCOUNTER_COMBAT_START_REJECTED' };
          this.metrics.combatStarts += 1;
          this.lastAction = { at: nowIso(), type: 'COMBAT_START', encounter: plan.selected.id, monsterType: plan.monsterType };
        } else if (String(combatSession.owner || '').startsWith('encounter-h23') && typeof this.combat.configureGroup === 'function') {
          this.combat.configureGroup({
            groupLeaderName: this.session.groupLeaderName,
            groupMemberNames: this.session.groupMemberNames
          });
        }
        return { state: 'ENGAGED', reason: 'ENCOUNTER_VISIBLE_COMBAT', plan };
      }

      const location = plan.location || {};
      const sameMap = !location.map || String(location.map) === String(character.map || '');
      const distance = sameMap && location.x != null && location.y != null && finite(character.x) != null && finite(character.y) != null
        ? Math.hypot(Number(character.x) - Number(location.x), Number(character.y) - Number(location.y))
        : null;
      if ((!sameMap || distance == null || distance > 90) && !this._ownedMovement()) {
        const destination = location.map && location.x != null && location.y != null
          ? { map: location.map, x: location.x, y: location.y }
          : location.map || plan.monsterType;
        if (destination) {
          const moved = this.movement.smartMove(destination, { owner: 'encounter-h23-travel' });
          if (moved && moved.accepted === true) {
            this.metrics.travelOrders += 1;
            this.lastAction = { at: nowIso(), type: 'TRAVEL', encounter: plan.selected.id, destination: clone(destination) };
            return { state: 'TRAVELLING', reason: 'ENCOUNTER_TRAVEL', plan };
          }
          if (moved && moved.state === 'UNKNOWN') return this._suspend(moved.reason || 'ENCOUNTER_MOVEMENT_UNKNOWN');
        }
      }
      return { state: 'WAITING', reason: 'ENCOUNTER_TARGET_NOT_VISIBLE', plan };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        session: clone(this.session),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        catalog: this.catalog(),
        metrics: clone(this.metrics),
        policies: {
          allNewBossesAndEventsEnabledByDefault: true,
          liveStateBeatsPersistedKnowledge: true,
          unknownSuspendsWithoutBlindRetry: true
        }
      };
    }
  }

  ns.EncounterController = EncounterController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
