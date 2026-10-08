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
      this.actions = options.actions || null;
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
      this.lastAnniversaryAttempt = null;
      // Track arrived-but-invisible event targets across autonomy role switches.
      // Never persist a temporary cooldown as a user event preference.
      this.absentEventTargets = new Map();
      this.announcements = new Map();
      this.knownEvents = new Map();
      // Opt-in only: newly discovered encounters never preempt FARM.
      this.enabled = { boss: new Set(), event: new Set() };
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        eventTtlMs: Math.max(60000, Math.min(21600000, Number(options.eventTtlMs) || 1800000)),
        approachDistance: Math.max(100, Math.min(1200, Number(options.approachDistance) || 650)),
        maxAttackToHpRatio: Math.max(0.05, Math.min(0.8, Number(options.maxAttackToHpRatio) || 0.32)),
        anniversaryArrivalRadius: Math.max(20, Math.min(75, Number(options.anniversaryArrivalRadius) || 55)),
        anniversaryRetryMs: Math.max(10000, Math.min(60000, Number(options.anniversaryRetryMs) || 12000)),
        absentTargetWaitMs: Math.max(1000, Math.min(120000, Number(options.absentTargetWaitMs) || 15000)),
        absentTargetCooldownMs: Math.max(10000, Math.min(3600000, Number(options.absentTargetCooldownMs) || 300000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        combatStarts: 0,
        travelOrders: 0,
        suspensions: 0,
        anniversaryVisitsDispatched: 0,
        anniversaryVisitsConfirmed: 0,
        anniversaryVisitsRejected: 0,
        absentTargetCooldowns: 0
      };
      this._loadPreferences();
    }

    _prefKey() { return 'albot:encounter-preferences:v1'; }

    _loadPreferences() {
      if (!this.storage || typeof this.storage.get !== 'function') return;
      try {
        const raw = this.storage.get(this._prefKey());
        if (!raw) return;
        const value = JSON.parse(raw);
        // v1 persisted *opt-outs* while encounters defaulted on. They cannot
        // prove an explicit opt-in. Fail closed on migration; users can opt in
        // again via setEnabled()/setAll() on v2.
        if (value && Number(value.schemaVersion) >= 2) {
          for (const kind of ['boss', 'event']) {
            const rows = Array.isArray(value.enabled && value.enabled[kind]) ? value.enabled[kind] : [];
            this.enabled[kind] = new Set(rows.map(x => cleanText(x, 160)).filter(Boolean));
          }
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
        schemaVersion: 2,
        enabled: {
          boss: [...this.enabled.boss].sort(),
          event: [...this.enabled.event].sort()
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
          live: bool(raw.live),
          eventTargetId: cleanText(raw.id || '', 160) || null,
          target: cleanText(raw.target || '', 160) || null,
          round: raw.round == null ? null : raw.round,
          expires: finite(raw.expires),
          next: finite(raw.next),
          available: raw.available !== false,
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
          enabled: this.enabled.boss.has(String(id)),
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

    _rawCharacter() {
      return this._read('character');
    }

    _serverIdentity() {
      const region = cleanText(this._read('server_region') || '', 80) || null;
      const identifier = cleanText(this._read('server_identifier') || '', 80) || null;
      return {
        region,
        identifier,
        realm: region && identifier ? region + ' ' + identifier : null
      };
    }

    _anniversaryReadiness() {
      const S = this._read('S');
      const state = S && typeof S === 'object' && S.anniversary && typeof S.anniversary === 'object'
        ? S.anniversary
        : null;
      const character = this._rawCharacter();
      const server = this._serverIdentity();
      const now = Date.now();
      const targetId = cleanText(state && state.id || '', 160) || null;
      const targetName = cleanText(state && state.target || '', 160) || null;
      const map = cleanText(state && state.map || '', 120) || null;
      const x = finite(state && state.x);
      const y = finite(state && state.y);
      const round = state && state.round != null ? state.round : null;
      const expires = finite(state && state.expires);
      const ticket = character && character.s && character.s.anniversary_visit && typeof character.s.anniversary_visit === 'object'
        ? character.s.anniversary_visit
        : null;
      const visitStatus = character && character.anniversary && typeof character.anniversary === 'object'
        ? character.anniversary
        : null;

      let reason = null;
      if (!state || !bool(state.active)) reason = 'ANNIVERSARY_INACTIVE';
      else if (!bool(state.live) || !targetId || round == null) reason = 'ANNIVERSARY_NO_LIVE_VISIT';
      else if (expires == null || now >= expires) reason = 'ANNIVERSARY_ROUND_EXPIRED';
      else if (state.available === false) reason = 'ANNIVERSARY_TARGET_UNAVAILABLE';
      else if (!map || x == null || y == null) reason = 'ANNIVERSARY_LOCATION_UNAVAILABLE';
      else if (!character || !character.name) reason = 'ANNIVERSARY_CHARACTER_UNAVAILABLE';
      else if (character.s && character.s.hopsickness) reason = 'ANNIVERSARY_HOPSICKNESS';
      else if (character.s && character.s.realmfatigue) reason = 'ANNIVERSARY_REALMFATIGUE';
      else if (!server.realm) reason = 'ANNIVERSARY_REALM_UNAVAILABLE';
      else if (visitStatus
          && String(visitStatus.realm || '') === server.realm
          && String(visitStatus.round == null ? '' : visitStatus.round) === String(round)
          && cleanText(visitStatus.reason || '', 80).toLowerCase()
          && cleanText(visitStatus.reason || '', 80).toLowerCase() !== 'ready') {
        reason = 'ANNIVERSARY_VISIT_' + cleanText(visitStatus.reason || 'BLOCKED', 80).toUpperCase();
      } else if (!ticket) reason = 'ANNIVERSARY_NO_VISIT_TICKET';
      else if (finite(ticket.ms) == null || finite(ticket.ms) <= 0) reason = 'ANNIVERSARY_VISIT_TICKET_EMPTY';
      else if (ticket.round == null || String(ticket.round) !== String(round)) reason = 'ANNIVERSARY_VISIT_TICKET_ROUND_MISMATCH';
      else if (cleanText(ticket.realm || '', 160) !== server.realm) reason = 'ANNIVERSARY_VISIT_TICKET_REALM_MISMATCH';
      else if (finite(ticket.expires) == null || now >= finite(ticket.expires)) reason = 'ANNIVERSARY_VISIT_TICKET_EXPIRED';

      return {
        schemaVersion: 1,
        active: !!(state && bool(state.active)),
        live: !!(state && bool(state.live)),
        actionable: reason == null,
        reason,
        targetId,
        targetName,
        map,
        x,
        y,
        round,
        expires,
        next: finite(state && state.next),
        available: state ? state.available !== false : false,
        realm: server.realm,
        ticket: ticket ? {
          ms: finite(ticket.ms),
          round: ticket.round == null ? null : ticket.round,
          realm: cleanText(ticket.realm || '', 160) || null,
          expires: finite(ticket.expires)
        } : null,
        visitStatus: visitStatus ? {
          realm: cleanText(visitStatus.realm || '', 160) || null,
          round: visitStatus.round == null ? null : visitStatus.round,
          target: cleanText(visitStatus.target || '', 160) || null,
          reason: cleanText(visitStatus.reason || '', 80) || null
        } : null
      };
    }

    _anniversaryInventoryStatus() {
      const character = this._rawCharacter() || {};
      const items = Array.isArray(character.items) ? character.items : [];
      const sliceNames = ['slice_strawberry', 'slice_citrus', 'slice_honey', 'slice_mint', 'slice_blueberry', 'slice_nightberry'];
      const count = name => items.reduce((sum, item) => {
        if (!item || String(item.name || '') !== name) return sum;
        return sum + Math.max(1, Number(item.q) || 1);
      }, 0);
      const slices = Object.fromEntries(sliceNames.map(name => [name, count(name)]));
      const G = this._read('G');
      const recipe = G && G.craft && G.craft.sixcake && typeof G.craft.sixcake === 'object' ? G.craft.sixcake : null;
      const requirements = recipe && Array.isArray(recipe.items)
        ? recipe.items.map(row => ({
            quantity: Math.max(1, Number(row && row[0]) || 1),
            name: cleanText(row && row[1] || '', 160) || null,
            level: Math.max(0, Number(row && row[2]) || 0)
          })).filter(row => row.name)
        : sliceNames.map(name => ({ quantity: 1, name, level: 0 }));
      const gold = finite(character.gold) || 0;
      const cost = recipe ? Math.max(0, finite(recipe.cost) || 0) : 100000;
      const sixcakeReady = requirements.every(row => count(row.name) >= row.quantity) && gold >= cost;
      return {
        slices,
        sixcake: count('sixcake'),
        anniversaryGift: count('anniversarygift'),
        sixcakeRecipe: { cost, requirements, ready: sixcakeReady },
        anniversaryKissActive: !!(character.s && character.s.anniversary_kiss)
      };
    }

    _anniversaryStatus() {
      const visit = this._anniversaryReadiness();
      let workshop = null;
      try {
        workshop = this.game && typeof this.game.npcLocation === 'function'
          ? this.game.npcLocation('anniversary_baker')
          : null;
      } catch (_) {}
      if (!workshop) workshop = { npcId: 'anniversary_baker', map: 'main', x: 64, y: -88 };
      return {
        schemaVersion: 1,
        visit,
        workshop,
        inventory: this._anniversaryInventoryStatus(),
        policies: {
          automaticVisitEnabled: true,
          automaticCraftingEnabled: false,
          automaticRewardOpeningEnabled: false,
          reason: 'ANNIVERSARY_VALUE_SPEND_REQUIRES_EXPLICIT_POLICY'
        }
      };
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
          enabled: this.enabled.event.has(id),
          active: raw.active === true,
          live: raw.live === true,
          map: raw.map || null,
          x: finite(raw.x),
          y: finite(raw.y),
          eventTargetId: cleanText(raw.eventTargetId || '', 160) || null,
          target: cleanText(raw.target || '', 160) || null,
          round: raw.round == null ? null : raw.round,
          expires: finite(raw.expires),
          next: finite(raw.next),
          available: raw.available !== false,
          source: raw.source || 'known',
          observedAt: raw.observedAt || null
        });
      }
      this._persistPreferences();
      rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      return rows;
    }

    catalog() {
      return { schemaVersion: 2, bosses: this._bossCatalog(), events: this._eventCatalog(), defaultEnabled: false };
    }

    setEnabled(kind, id, enabled) {
      const key = String(kind || '').toLowerCase();
      const name = cleanText(id, 160);
      if (!['boss', 'event'].includes(key) || !name) return { accepted: false, reason: 'ENCOUNTER_PREFERENCE_INVALID' };
      if (enabled === true) this.enabled[key].add(name);
      else this.enabled[key].delete(name);
      if (key === 'event') this.absentEventTargets.delete(name);
      this._persistPreferences();
      return { accepted: true, kind: key, id: name, enabled: this.enabled[key].has(name) };
    }

    setAll(kind, enabled) {
      const key = String(kind || '').toLowerCase();
      if (!['boss', 'event'].includes(key)) return { accepted: false, reason: 'ENCOUNTER_KIND_INVALID' };
      const rows = key === 'boss' ? this._bossCatalog() : this._eventCatalog();
      // Bulk opt-in covers only currently known IDs, not future discoveries.
      this.enabled[key].clear();
      if (enabled === true) for (const row of rows) this.enabled[key].add(row.id);
      if (key === 'event') this.absentEventTargets.clear();
      this._persistPreferences();
      return { accepted: true, kind: key, enabled: enabled === true, count: rows.length };
    }

    preferredTask() {
      const catalog = this.catalog();
      for (const event of catalog.events.filter(row => row.active && row.enabled)) {
        const actionability = this._eventActionability(event);
        if (actionability.actionable) {
          return { taskType: 'EVENT', encounter: clone(event), actionability: clone(actionability) };
        }
      }
      const boss = catalog.bosses.find(row => row.active && row.enabled);
      if (boss) return { taskType: 'BOSS', encounter: clone(boss) };
      return null;
    }

    _absentTargetActionability(row, hasVisibleMonster) {
      const id = cleanText(row && row.id || '', 160);
      if (!id) return null;
      if (hasVisibleMonster) {
        // An actual live target ends the absence hold immediately; Combat's
        // separate safe-candidate check still decides whether we may fight.
        this.absentEventTargets.delete(id);
        return null;
      }

      const signature = JSON.stringify([
        id, row.map || null, row.x, row.y, row.round,
        row.eventTargetId || null, row.target || null
      ]);
      const previous = this.absentEventTargets.get(id);
      if (previous && previous.signature !== signature) this.absentEventTargets.delete(id);
      const observation = this.absentEventTargets.get(id);
      const now = Date.now();
      if (observation && observation.retryAtMs > now) {
        return {
          actionable: false,
          reason: 'ENCOUNTER_TARGET_ABSENT_COOLDOWN',
          retryAt: new Date(observation.retryAtMs).toISOString()
        };
      }

      const locationKnown = !!row.map && row.x != null && row.y != null
        && finite(row.x) != null && finite(row.y) != null;
      let character = null;
      try {
        const snapshot = this.game && typeof this.game.snapshot === 'function'
          ? this.game.snapshot() : null;
        character = snapshot && snapshot.character || null;
      } catch (_) {}
      const positionKnown = character && character.x != null && character.y != null
        && finite(character.x) != null && finite(character.y) != null;
      const atLocation = !!(locationKnown && positionKnown
        && String(character.map || '') === String(row.map)
        && Math.hypot(Number(character.x) - Number(row.x), Number(character.y) - Number(row.y)) <= 90);
      if (!atLocation) {
        // Travel to a known event location is still allowed; only a confirmed
        // arrival with no matching monster starts the bounded waiting period.
        if (observation) this.absentEventTargets.delete(id);
        return null;
      }

      const arrivedAtMs = observation && !observation.retryAtMs ? observation.arrivedAtMs : now;
      if (now - arrivedAtMs < this.config.absentTargetWaitMs) {
        this.absentEventTargets.set(id, { signature, arrivedAtMs, retryAtMs: 0 });
        return {
          actionable: true,
          reason: 'ENCOUNTER_WAITING_FOR_VISIBLE_TARGET',
          waitRemainingMs: this.config.absentTargetWaitMs - (now - arrivedAtMs)
        };
      }

      const retryAtMs = now + this.config.absentTargetCooldownMs;
      this.absentEventTargets.set(id, { signature, arrivedAtMs, retryAtMs });
      this.metrics.absentTargetCooldowns += 1;
      this.lastAction = {
        at: nowIso(),
        type: 'EVENT_TARGET_ABSENT',
        encounter: id,
        reason: 'ENCOUNTER_TARGET_ABSENT_COOLDOWN',
        retryAt: new Date(retryAtMs).toISOString()
      };
      return {
        actionable: false,
        reason: 'ENCOUNTER_TARGET_ABSENT_COOLDOWN',
        retryAt: new Date(retryAtMs).toISOString()
      };
    }

    _eventActionability(row) {
      if (!row || row.active !== true || row.enabled === false) {
        return { actionable: false, reason: 'ENCOUNTER_NOT_ACTIVE_OR_DISABLED' };
      }
      if (String(row.id || '').toLowerCase() === 'anniversary') {
        const visit = this._anniversaryReadiness();
        return {
          actionable: visit.actionable === true,
          reason: visit.reason,
          interaction: 'ANNIVERSARY_VISIT',
          visit
        };
      }
      const monsterType = this._monsterTypeFor(row);
      const visible = monsterType && this.game && typeof this.game.visibleMonsters === 'function'
        ? this.game.visibleMonsters({ type: monsterType })
        : [];
      const hasVisibleMonster = Array.isArray(visible) && visible.length > 0;
      const hasLocation = !!row.map && row.x != null && row.y != null
        && finite(row.x) != null && finite(row.y) != null;
      const missingTarget = this._absentTargetActionability(row, hasVisibleMonster);
      if (missingTarget && missingTarget.actionable === false) {
        return { ...missingTarget, monsterType: monsterType || null };
      }
      // Visibility alone does not make a boss safely attackable. In particular,
      // high-damage live events must not lock Full Autonomy into a no-target
      // combat session that prevents normal farming.
      const local = this.game && typeof this.game.snapshot === 'function'
        ? this.game.snapshot().character : null;
      if (hasVisibleMonster && local && String(local.ctype || '').toLowerCase() !== 'merchant'
          && this.combat && typeof this.combat.safeCandidates === 'function') {
        const definition = this.game && typeof this.game.monsterDefinition === 'function'
          ? this.game.monsterDefinition(monsterType) : null;
        const safe = this.combat.safeCandidates({
          monsterType,
          maxAcquireDistance: 1200,
          maxAttackToHpRatio: this.config.maxAttackToHpRatio,
          allowContested: !!(definition && definition.cooperative === true),
          partyAssist: true
        });
        if (!safe.length && visible.some(monster =>
          monster.distance == null || monster.distance <= 1200)) {
          return { actionable: false, reason: 'ENCOUNTER_VISIBLE_NO_SAFE_TARGET', monsterType };
        }
      }
      return {
        actionable: hasVisibleMonster || hasLocation,
        reason: hasVisibleMonster ? 'ENCOUNTER_VISIBLE_MONSTER'
          : missingTarget ? missingTarget.reason
            : (hasLocation ? 'ENCOUNTER_LOCATION_AVAILABLE' : 'ENCOUNTER_ACTIVE_NOT_ACTIONABLE'),
        monsterType: monsterType || null
      };
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
      const selected = candidates.find(row => row.kind === 'boss' || this._eventActionability(row).actionable) || null;
      if (!selected) {
        const active = candidates[0] || null;
        this.lastPlan = {
          state: 'WAITING',
          reason: active ? 'ENCOUNTER_ACTIVE_NOT_ACTIONABLE' : 'NO_ENABLED_ACTIVE_ENCOUNTER',
          taskType: requested || null,
          selected: clone(active),
          actionability: active && active.kind === 'event' ? clone(this._eventActionability(active)) : null
        };
        return clone(this.lastPlan);
      }
      if (selected.kind === 'event' && String(selected.id || '').toLowerCase() === 'anniversary') {
        const visit = this._anniversaryReadiness();
        if (!visit.actionable) {
          this.lastPlan = {
            state: 'WAITING',
            reason: visit.reason || 'ANNIVERSARY_VISIT_NOT_ACTIONABLE',
            taskType: 'EVENT',
            selected: clone(selected),
            interaction: 'ANNIVERSARY_VISIT',
            visit
          };
          return clone(this.lastPlan);
        }
        this.lastPlan = {
          state: 'READY',
          reason: 'ANNIVERSARY_VISIT_READY',
          taskType: 'EVENT',
          selected: clone(selected),
          interaction: 'ANNIVERSARY_VISIT',
          monsterType: null,
          location: { map: visit.map, x: visit.x, y: visit.y },
          targetId: visit.targetId,
          targetName: visit.targetName,
          round: visit.round,
          expires: visit.expires,
          visibleTargetId: null,
          visible: false,
          phase: null,
          hpRatio: null,
          visit
        };
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

    _tickAnniversary(plan, character) {
      const visit = this._anniversaryReadiness();
      if (!visit.actionable) {
        return { state: 'WAITING', reason: visit.reason || 'ANNIVERSARY_VISIT_NOT_ACTIONABLE', plan: clone(plan) };
      }

      const activeMovement = this._ownedMovement();
      if (activeMovement) {
        return { state: 'TRAVELLING', reason: 'ANNIVERSARY_TRAVEL_IN_PROGRESS', plan: clone(plan) };
      }

      const sameMap = String(character.map || '') === String(visit.map || '');
      const cx = finite(character.x), cy = finite(character.y);
      const distance = sameMap && cx != null && cy != null
        ? Math.hypot(cx - Number(visit.x), cy - Number(visit.y))
        : null;
      let visibleTarget = null;
      try {
        const players = this.game && typeof this.game.visiblePlayers === 'function'
          ? this.game.visiblePlayers({ radius: 100 })
          : [];
        visibleTarget = (players || []).find(row => {
          const id = cleanText(row && row.id || '', 160);
          const name = cleanText(row && row.name || '', 160);
          return (visit.targetId && id === visit.targetId) || (visit.targetName && name === visit.targetName);
        }) || null;
      } catch (_) {}

      if (!sameMap || distance == null || distance > 70 || !visibleTarget || finite(visibleTarget.distance) == null || finite(visibleTarget.distance) > 80) {
        const moved = this.movement && typeof this.movement.smartMove === 'function'
          ? this.movement.smartMove(
              { map: visit.map, x: visit.x, y: visit.y },
              { owner: 'encounter-h23:anniversary', arrivalRadius: this.config.anniversaryArrivalRadius }
            )
          : null;
        if (moved && moved.accepted === true) {
          this.metrics.travelOrders += 1;
          this.lastAction = {
            at: nowIso(),
            type: 'ANNIVERSARY_TRAVEL',
            round: visit.round,
            targetId: visit.targetId,
            targetName: visit.targetName,
            destination: { map: visit.map, x: visit.x, y: visit.y }
          };
          return { state: 'TRAVELLING', reason: 'ANNIVERSARY_TRAVEL', plan: clone(plan) };
        }
        if (moved && moved.state === 'UNKNOWN') return this._suspend(moved.reason || 'ANNIVERSARY_MOVEMENT_UNKNOWN');
        return { state: 'WAITING', reason: 'ANNIVERSARY_TARGET_NOT_VISIBLE', plan: clone(plan) };
      }

      const now = Date.now();
      const previous = this.lastAnniversaryAttempt;
      if (previous
          && String(previous.round) === String(visit.round)
          && String(previous.targetId || '') === String(visit.targetId || '')
          && now - Number(previous.atMs || 0) < this.config.anniversaryRetryMs) {
        return { state: 'WAITING', reason: 'ANNIVERSARY_KISS_SETTLING', plan: clone(plan) };
      }
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { state: 'BLOCKED', reason: 'ANNIVERSARY_ACTION_BOUNDARY_UNAVAILABLE', plan: clone(plan) };
      }

      let dispatched = null;
      try {
        dispatched = this.actions.dispatch('use_skill', ['ikissyou', visit.targetId]);
      } catch (error) {
        this.metrics.anniversaryVisitsRejected += 1;
        this.lastAnniversaryAttempt = { round: visit.round, targetId: visit.targetId, atMs: now, state: 'REJECTED' };
        this.lastAction = { at: nowIso(), type: 'ANNIVERSARY_KISS', state: 'REJECTED', reason: cleanText(error && error.message || error, 240) };
        return { state: 'WAITING', reason: 'ANNIVERSARY_KISS_REJECTED', plan: clone(plan) };
      }
      if (!dispatched || dispatched.dispatched !== true) {
        this.metrics.anniversaryVisitsRejected += 1;
        this.lastAnniversaryAttempt = { round: visit.round, targetId: visit.targetId, atMs: now, state: 'REJECTED' };
        return { state: 'WAITING', reason: dispatched && dispatched.error && dispatched.error.message || 'ANNIVERSARY_KISS_DISPATCH_REJECTED', plan: clone(plan) };
      }

      this.metrics.anniversaryVisitsDispatched += 1;
      this.lastAnniversaryAttempt = { round: visit.round, targetId: visit.targetId, atMs: now, state: 'DISPATCHED' };
      this.lastAction = {
        at: nowIso(),
        type: 'ANNIVERSARY_KISS',
        state: 'DISPATCHED',
        round: visit.round,
        targetId: visit.targetId,
        targetName: visit.targetName
      };

      const promise = dispatched.value;
      if (promise && typeof promise.then === 'function') {
        Promise.resolve(promise).then(result => {
          const rejected = !!(result && (result.failed === true || result.rewarded === false));
          if (rejected) this.metrics.anniversaryVisitsRejected += 1;
          else this.metrics.anniversaryVisitsConfirmed += 1;
          this.lastAnniversaryAttempt = {
            round: visit.round,
            targetId: visit.targetId,
            atMs: now,
            state: rejected ? 'REJECTED' : 'CONFIRMED'
          };
          this.lastAction = {
            at: nowIso(),
            type: 'ANNIVERSARY_KISS',
            state: rejected ? 'REJECTED' : 'CONFIRMED',
            round: visit.round,
            targetId: visit.targetId,
            targetName: visit.targetName,
            result: clone(result)
          };
        }).catch(error => {
          this.metrics.anniversaryVisitsRejected += 1;
          this.lastAnniversaryAttempt = { round: visit.round, targetId: visit.targetId, atMs: now, state: 'REJECTED' };
          this.lastAction = {
            at: nowIso(),
            type: 'ANNIVERSARY_KISS',
            state: 'REJECTED',
            round: visit.round,
            targetId: visit.targetId,
            targetName: visit.targetName,
            reason: cleanText(error && error.message || error, 240)
          };
        });
      }
      return { state: 'INTERACTING', reason: 'ANNIVERSARY_KISS_DISPATCHED', plan: clone(plan) };
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

      const plan = this.plan({ taskType: this.session.taskType });
      if (!plan || plan.state !== 'READY') return plan;
      if (plan.interaction === 'ANNIVERSARY_VISIT') return this._tickAnniversary(plan, character);
      if (String(character.ctype || '').toLowerCase() === 'merchant') return { state: 'OBSERVER_ONLY', reason: 'MERCHANT_NO_ENCOUNTER_COMBAT' };

      const combatStatus = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
      const combatSession = combatStatus && combatStatus.session;
      if (combatStatus && combatStatus.lastSession && String(combatStatus.lastSession.owner || '').startsWith('encounter-h23')
          && combatStatus.lastSession.state === 'UNKNOWN') {
        return this._suspend(combatStatus.lastSession.reason || 'ENCOUNTER_COMBAT_UNKNOWN');
      }

      const definition = plan.monsterType && this.game && typeof this.game.monsterDefinition === 'function'
        ? this.game.monsterDefinition(plan.monsterType) : null;
      const safeTargets = plan.monsterType && this.combat && typeof this.combat.safeCandidates === 'function'
        ? this.combat.safeCandidates({
          monsterType: plan.monsterType,
          maxAcquireDistance: this.config.approachDistance,
          maxAttackToHpRatio: this.config.maxAttackToHpRatio,
          allowContested: !!(definition && definition.cooperative === true),
          partyAssist: true
        }) : [];
      if (combatSession && String(combatSession.owner || '').startsWith('encounter-h23')
          && String(combatSession.policy && combatSession.policy.monsterType || '') !== String(plan.monsterType || '')) {
        this.combat.stopSession('ENCOUNTER_TARGET_ROTATION');
      }

      if (plan.monsterType && plan.visible && safeTargets.length) {
        if (!combatSession || String(combatSession.policy && combatSession.policy.monsterType || '') !== String(plan.monsterType)) {
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
        lastAnniversaryAttempt: clone(this.lastAnniversaryAttempt),
        absentTargetObservations: [...this.absentEventTargets.entries()].map(([id, value]) => ({
          eventId: id,
          arrivedAt: value.arrivedAtMs ? new Date(value.arrivedAtMs).toISOString() : null,
          retryAt: value.retryAtMs ? new Date(value.retryAtMs).toISOString() : null,
          coolingDown: Number(value.retryAtMs || 0) > Date.now()
        })),
        anniversary: this._anniversaryStatus(),
        catalog: this.catalog(),
        metrics: clone(this.metrics),
        policies: {
          allNewBossesAndEventsEnabledByDefault: false,
          explicitEncounterOptInRequired: true,
          liveStateBeatsPersistedKnowledge: true,
          unknownSuspendsWithoutBlindRetry: true
        }
      };
    }
  }

  ns.EncounterController = EncounterController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
