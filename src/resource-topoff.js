(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const RELEVANT_SKILLS = Object.freeze({
    warrior: Object.freeze(['hardshell', 'charge', 'taunt', 'warcry', 'cleave', 'stomp']),
    priest: Object.freeze(['heal', 'partyheal', 'revive', 'curse', 'darkblessing']),
    ranger: Object.freeze(['huntersmark', 'supershot', '5shot', '3shot']),
    mage: Object.freeze(['burst', 'cburst']),
    rogue: Object.freeze(['invis', 'mentalburst', 'quickpunch', 'fanofknives']),
    paladin: Object.freeze(['selfheal', 'smash']),
    merchant: Object.freeze(['mluck'])
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

  function rejectionText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return cleanText(value, 500);
    if (typeof value !== 'object') return cleanText(value, 500);
    const keys = ['reason', 'message', 'code', 'type', 'name'];
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return cleanText(candidate, 500);
    }
    const nested = value.error || value.response;
    if (nested && typeof nested === 'object') {
      for (const key of keys) {
        const candidate = nested[key];
        if (typeof candidate === 'string' && candidate.trim()) return cleanText(candidate, 500);
      }
    }
    try { return cleanText(JSON.stringify(value), 500); } catch (_) {}
    return cleanText(value, 500);
  }

  function restoreAmount(meta, resource) {
    const gives = meta && meta.gives;
    if (Array.isArray(gives)) {
      let best = null;
      for (const row of gives) {
        if (!Array.isArray(row) || String(row[0] || '').toLowerCase() !== resource) continue;
        const amount = finite(row[1]);
        if (amount != null && amount > 0) best = best == null ? amount : Math.max(best, amount);
      }
      return best;
    }
    if (gives && typeof gives === 'object') {
      const amount = finite(gives[resource]);
      return amount != null && amount > 0 ? amount : null;
    }
    return null;
  }

  class ResourceTopoffController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.classSkills = options.classSkills || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.config = {
        tickMs: Math.max(100, Math.min(1000, Number(options.tickMs) || 250)),
        targetRatio: Math.max(0.90, Math.min(1, Number(options.targetRatio) || 1)),
        criticalHpRatio: Math.max(0.40, Math.min(0.90, Number(options.criticalHpRatio) || 0.72)),
        operationalHpRatio: Math.max(0.40, Math.min(0.95, Number(options.operationalHpRatio) || 0.75)),
        baseMpRatio: Math.max(0.10, Math.min(0.80, Number(options.baseMpRatio) || 0.28)),
        skillReserveRatio: Math.max(0, Math.min(0.50, Number(options.skillReserveRatio) || 0.10)),
        minPotionUtilization: Math.max(0.25, Math.min(1, Number(options.minPotionUtilization) || 0.50)),
        cooldownMs: Math.max(500, Math.min(3000, Number(options.cooldownMs) || 650)),
        outcomeTimeoutMs: Math.max(1000, Math.min(10000, Number(options.outcomeTimeoutMs) || 3000))
      };
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.lastAttemptAtMs = -Infinity;
      this.backoffUntilMs = 0;
      this.pending = null;
      this.suspendedReason = null;
      this.lastDecision = null;
      this.lastUse = null;
      this.lastSupply = null;
      this.metrics = {
        ticks: 0,
        evaluations: 0,
        hpRequests: 0,
        mpRequests: 0,
        confirmed: 0,
        rejected: 0,
        unknown: 0,
        cooldownWaits: 0,
        potionUnavailable: 0,
        overhealAvoided: 0,
        operationalBypasses: 0,
        skillReserveTriggers: 0
      };
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('resource-topoff-loop', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return this.status();
    }

    stop(reason = 'RESOURCE_TOPOFF_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.lastDecision = {
        at: new Date().toISOString(),
        state: this.pending ? 'STOPPED_WITH_PENDING_PRESERVED' : 'STOPPED',
        reason: cleanText(reason, 240),
        pending: this.pending ? clone(this.pending) : null
      };
      return this.status();
    }

    resetSafety(reason = 'RESOURCE_TOPOFF_EXPLICIT_RESET') {
      if (this.pending) {
        return {
          ...this.status(),
          reset: false,
          reason: 'RESOURCE_TOPOFF_PENDING_OUTCOME_REQUIRES_RECONCILIATION'
        };
      }
      this.suspendedReason = null;
      this.backoffUntilMs = 0;
      this.lastDecision = { at: new Date().toISOString(), state: 'RESET', reason: cleanText(reason, 240) };
      return { ...this.status(), reset: true };
    }

    _gameData() {
      try {
        if (this.game && typeof this.game._gameData === 'function') return this.game._gameData() || {};
      } catch (_) {}
      try {
        const value = this.root && (this.root.G || this.root.parent && this.root.parent.G);
        return value && typeof value === 'object' ? value : {};
      } catch (_) {
        return {};
      }
    }

    _snapshot() {
      try { return this.game && this.game.snapshot ? this.game.snapshot() : null; } catch (_) { return null; }
    }

    _inventory() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; } catch (_) { return null; }
    }

    _supply(inventory = this._inventory()) {
      const available = !!(inventory && inventory.available !== false && Array.isArray(inventory.items));
      const items = available ? inventory.items : [];
      const hpRows = items.filter(row => row && /^hpot/i.test(String(row.name || '')));
      const mpRows = items.filter(row => row && /^mpot/i.test(String(row.name || '')));
      const count = rows => rows.reduce((sum, row) => sum + Math.max(1, Math.floor(Number(row.quantity) || 1)), 0);
      const status = {
        available,
        hpPotions: count(hpRows),
        mpPotions: count(mpRows),
        hpReady: available && hpRows.length > 0,
        mpReady: available && mpRows.length > 0,
        hpItems: hpRows.map(row => ({ name: row.name, quantity: row.quantity })),
        mpItems: mpRows.map(row => ({ name: row.name, quantity: row.quantity }))
      };
      status.ready = status.hpReady && status.mpReady;
      this.lastSupply = clone(status);
      return status;
    }

    supply() {
      return clone(this._supply());
    }

    _potionRestore(inventory, action) {
      const resource = action === 'use_hp' ? 'hp' : action === 'use_mp' ? 'mp' : null;
      if (!resource) return null;
      const prefix = resource === 'hp' ? /^hpot/i : /^mpot/i;
      const items = inventory && Array.isArray(inventory.items) ? inventory.items : [];
      const definitions = this._gameData().items || {};
      let best = null;
      for (const row of items) {
        if (!row || !prefix.test(String(row.name || ''))) continue;
        const amount = restoreAmount(definitions[row.name], resource);
        if (amount != null) best = best == null ? amount : Math.max(best, amount);
      }
      return best;
    }

    _skillReserve(character) {
      const ctype = cleanText(character && character.ctype || '', 60).toLowerCase();
      const maxMp = Math.max(0, finite(character && character.maxMp) || 0);
      const ids = RELEVANT_SKILLS[ctype] || [];
      const rows = [];
      let maxCost = 0;
      for (const id of ids) {
        let definition = null;
        try { definition = this.game && this.game.skillDefinition ? this.game.skillDefinition(id) : null; } catch (_) {}
        if (!definition) continue;
        const cost = Math.max(0, finite(definition.mp) || 0);
        rows.push({ id, mp: cost });
        maxCost = Math.max(maxCost, cost);
      }
      const requiredMp = maxMp > 0
        ? Math.min(maxMp, Math.max(maxMp * this.config.baseMpRatio, maxCost + maxMp * this.config.skillReserveRatio))
        : maxCost;
      return {
        ctype,
        maxSkillCost: maxCost,
        requiredMp: Math.ceil(requiredMp),
        requiredRatio: maxMp > 0 ? Math.min(1, requiredMp / maxMp) : null,
        skills: rows
      };
    }

    _resourceEvidence(action) {
      const snap = this._snapshot();
      const character = snap && snap.character;
      const inventory = this._inventory();
      const supply = this._supply(inventory);
      return {
        hp: finite(character && character.hp),
        mp: finite(character && character.mp),
        inventoryAvailable: supply.available === true,
        hpPotions: supply.hpPotions,
        mpPotions: supply.mpPotions
      };
    }

    _watch(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        pending.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.pending || this.pending.id !== pending.id) return;
        pending.settlement = 'RESOLVED';
        pending.response = response == null ? null : clone(response);
      }, error => {
        if (!this.pending || this.pending.id !== pending.id) return;
        pending.settlement = 'REJECTED';
        pending.error = rejectionText(error) || 'RESOURCE_TOPOFF_REJECTED';
      }).catch(() => {});
    }

    _knownRejection(value) {
      const text = rejectionText(value).toLowerCase();
      return /cooldown|safet|no_mp|no_hp|full|not_ready|cant_use|cannot_use|unavailable/.test(text);
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      const after = this._resourceEvidence(pending.action);
      const resourceIncreased = pending.resource === 'hp'
        ? after.hp != null && pending.before.hp != null && after.hp > pending.before.hp
        : after.mp != null && pending.before.mp != null && after.mp > pending.before.mp;
      const inventoryComparable = pending.before.inventoryAvailable === true && after.inventoryAvailable === true;
      const potionDecreased = inventoryComparable && (pending.resource === 'hp'
        ? after.hpPotions < pending.before.hpPotions
        : after.mpPotions < pending.before.mpPotions);

      const response = pending.response && typeof pending.response === 'object' ? pending.response : null;
      const explicitUseConfirmed = !!(response && (
        response.used === true
        || response.consumed === true
        || response.potionUsed === true
        || (response.success === true && ['use_hp', 'use_mp'].includes(String(response.action || response.place || '').toLowerCase()))
      ));

      if (potionDecreased || explicitUseConfirmed) {
        this.pending = null;
        this.metrics.confirmed += 1;
        this.lastUse = {
          at: new Date().toISOString(),
          action: pending.action,
          state: 'CONFIRMED',
          resourceIncreased,
          potionDecreased,
          inventoryComparable,
          explicitUseConfirmed
        };
        return true;
      }

      if (pending.settlement === 'REJECTED' || (pending.response && (pending.response.failed === true || pending.response.success === false || pending.response.used === false))) {
        const detail = pending.error || pending.response || 'RESOURCE_TOPOFF_REJECTED';
        if (this._knownRejection(detail)) {
          this.pending = null;
          this.metrics.rejected += 1;
          this.backoffUntilMs = this.now() + this.config.cooldownMs;
          this.lastUse = { at: new Date().toISOString(), action: pending.action, state: 'REJECTED', reason: cleanText(detail && (detail.reason || detail.message) || detail, 240) };
          return true;
        }
        this.pending = null;
        this.suspendedReason = 'RESOURCE_TOPOFF_ACTION_UNKNOWN';
        this.metrics.unknown += 1;
        this.lastUse = { at: new Date().toISOString(), action: pending.action, state: 'UNKNOWN', reason: cleanText(detail && (detail.reason || detail.message) || detail, 240) };
        return true;
      }

      if (this.now() >= pending.deadlineAtMs) {
        this.pending = null;
        this.suspendedReason = 'RESOURCE_TOPOFF_UNVERIFIED_TIMEOUT';
        this.metrics.unknown += 1;
        this.lastUse = { at: new Date().toISOString(), action: pending.action, state: 'UNKNOWN', reason: this.suspendedReason };
        return true;
      }
      return false;
    }

    _candidate(action, character, inventory, skillReserve) {
      const resource = action === 'use_hp' ? 'hp' : 'mp';
      const current = Math.max(0, finite(character && character[resource]) || 0);
      const maximum = Math.max(current, finite(character && character[resource === 'hp' ? 'maxHp' : 'maxMp']) || current);
      const observedRatio = maximum > 0 ? current / maximum : 1;
      const deficit = Math.max(0, maximum - current);
      const restore = this._potionRestore(inventory, action);
      const utilization = restore != null && restore > 0 ? Math.min(1, deficit / restore) : null;
      const operationalRatio = action === 'use_hp'
        ? this.config.operationalHpRatio
        : Math.max(this.config.baseMpRatio, finite(skillReserve && skillReserve.requiredRatio) || 0);
      const critical = action === 'use_hp' && observedRatio <= this.config.criticalHpRatio;
      const operationalRequired = observedRatio < operationalRatio;
      const viable = critical || operationalRequired || utilization == null || utilization >= this.config.minPotionUtilization;
      return { action, resource, current, maximum, ratio: observedRatio, deficit, restore, utilization, operationalRatio, critical, operationalRequired, viable };
    }

    tick() {
      this.metrics.ticks += 1;
      if (this.heartbeat) {
        try { this.heartbeat({ phase: 'resource-topoff', pending: !!this.pending, suspended: !!this.suspendedReason }); } catch (_) {}
      }
      if (!this.moduleActive) return { state: 'IDLE', reason: 'RESOURCE_TOPOFF_MODULE_INACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (this.pending) {
        this._observePending();
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) }
          : (this.suspendedReason ? { state: 'SUSPENDED', reason: this.suspendedReason } : { state: 'OBSERVED' });
      }
      const now = this.now();
      if (now < this.backoffUntilMs || now - this.lastAttemptAtMs < this.config.cooldownMs) {
        this.metrics.cooldownWaits += 1;
        return { state: 'WAITING', reason: 'RESOURCE_TOPOFF_COOLDOWN' };
      }

      const snap = this._snapshot();
      const character = snap && snap.character;
      if (!snap || !snap.available || !character) return { state: 'WAITING', reason: 'CHARACTER_UNAVAILABLE' };
      if (character.rip === true) return { state: 'WAITING', reason: 'CHARACTER_DEAD' };

      this.metrics.evaluations += 1;
      const inventory = this._inventory();
      const supply = this._supply(inventory);
      const hpRatio = ratio(character.hp, character.maxHp);
      const mpRatio = ratio(character.mp, character.maxMp);
      const skillReserve = this._skillReserve(character);
      const mpReserveRequired = finite(character.mp) != null && finite(skillReserve.requiredMp) != null
        && Number(character.mp) < Number(skillReserve.requiredMp);
      if (mpReserveRequired) this.metrics.skillReserveTriggers += 1;

      const hpNeeded = hpRatio != null && hpRatio < this.config.targetRatio;
      const mpNeeded = mpRatio != null && mpRatio < this.config.targetRatio;
      if (!hpNeeded && !mpNeeded) {
        this.lastDecision = { at: new Date().toISOString(), state: 'READY', reason: 'RESOURCE_TOPOFF_FULL', skillReserve };
        return clone(this.lastDecision);
      }

      const hp = hpNeeded && supply.hpReady ? this._candidate('use_hp', character, inventory, skillReserve) : null;
      const mp = mpNeeded && supply.mpReady ? this._candidate('use_mp', character, inventory, skillReserve) : null;
      const ordered = [];
      if (hp && hp.critical) ordered.push(hp);
      if (mp && mpReserveRequired) ordered.push(mp);
      if (hp && mp && !ordered.includes(hp) && !ordered.includes(mp)) {
        if ((1 - mp.ratio) >= (1 - hp.ratio)) ordered.push(mp, hp);
        else ordered.push(hp, mp);
      } else {
        if (hp && !ordered.includes(hp)) ordered.push(hp);
        if (mp && !ordered.includes(mp)) ordered.push(mp);
      }

      const selected = ordered.find(row => row.viable) || null;
      if (!selected) {
        if ((hpNeeded && !supply.hpReady) || (mpReserveRequired && !supply.mpReady)) this.metrics.potionUnavailable += 1;
        else this.metrics.overhealAvoided += 1;
        const reason = mpReserveRequired && !supply.mpReady
          ? 'RESOURCE_TOPOFF_MP_POTION_UNAVAILABLE'
          : hpNeeded && !supply.hpReady && hpRatio <= this.config.operationalHpRatio
            ? 'RESOURCE_TOPOFF_HP_POTION_UNAVAILABLE'
            : 'RESOURCE_TOPOFF_UTILIZATION_HOLD';
        this.lastDecision = { at: new Date().toISOString(), state: 'WAITING', reason, hpRatio, mpRatio, skillReserve, supply };
        return clone(this.lastDecision);
      }

      if (selected.operationalRequired && selected.utilization != null && selected.utilization < this.config.minPotionUtilization) {
        this.metrics.operationalBypasses += 1;
      }

      const before = this._resourceEvidence(selected.action);
      let dispatch;
      try { dispatch = this.actions && this.actions.dispatch ? this.actions.dispatch(selected.action, []) : null; }
      catch (error) {
        this.lastDecision = { at: new Date().toISOString(), state: 'BLOCKED', reason: cleanText(error && error.message || error, 300) };
        return clone(this.lastDecision);
      }
      this.lastAttemptAtMs = now;
      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        if (dispatch && dispatch.state === 'UNKNOWN') {
          this.suspendedReason = 'RESOURCE_TOPOFF_DISPATCH_UNKNOWN';
          this.metrics.unknown += 1;
          this.lastUse = { at: new Date().toISOString(), action: selected.action, state: 'UNKNOWN', reason: dispatch.error && dispatch.error.message || this.suspendedReason };
          return { state: 'SUSPENDED', reason: this.suspendedReason };
        }
        this.metrics.rejected += 1;
        this.backoffUntilMs = now + this.config.cooldownMs;
        return { state: 'WAITING', reason: dispatch && dispatch.state || 'RESOURCE_TOPOFF_NOT_DISPATCHED' };
      }

      const pending = {
        id: dispatch.id,
        action: selected.action,
        resource: selected.resource,
        before,
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null,
        decision: clone(selected),
        skillReserve: clone(skillReserve)
      };
      this.pending = pending;
      if (selected.action === 'use_hp') this.metrics.hpRequests += 1;
      else this.metrics.mpRequests += 1;
      this._watch(dispatch.value, pending);
      this.lastDecision = { at: new Date().toISOString(), state: 'DISPATCHED', action: selected.action, reason: mpReserveRequired && selected.action === 'use_mp' ? 'SKILL_MP_RESERVE' : 'RESOURCE_TOPOFF', skillReserve };
      return clone(this.lastDecision);
    }

    status() {
      const snap = this._snapshot();
      const character = snap && snap.character;
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        supply: clone(this.lastSupply || this._supply()),
        skillReserve: character ? this._skillReserve(character) : null,
        lastDecision: clone(this.lastDecision),
        lastUse: clone(this.lastUse),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.ResourceTopoffController = ResourceTopoffController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
