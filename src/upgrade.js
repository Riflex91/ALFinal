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

  function nowIso() {
    return new Date().toISOString();
  }

  function stableProperty(value) {
    if (value == null) return '';
    try {
      if (typeof value !== 'object') return String(value);
      const ordered = {};
      for (const key of Object.keys(value).sort()) ordered[key] = value[key];
      return JSON.stringify(ordered);
    } catch (_) {
      return String(value);
    }
  }

  class UpgradeCompoundController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.combat = options.combat || null;
      this.gearProgression = options.gearProgression || null;
      this.bank = options.bank || null;
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.riskPreview = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.attemptsThisSession = 0;
      this.attemptSessionGeneration = 0;
      this.attemptSessionStartedAt = null;
      this.attemptSessionReason = null;
      this.riskHolds = new Map();
      this.lastMutationRiskDecision = null;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 8000)),
        settleGraceMs: Math.max(100, Math.min(3000, Number(options.settleGraceMs) || 500)),
        maxAttemptsPerSession: Math.max(1, Math.min(100, finite(options.maxAttemptsPerSession) == null ? 12 : finite(options.maxAttemptsPerSession))),
        maxUpgradeLevel: Math.max(0, Math.min(20, finite(options.maxUpgradeLevel) == null ? 7 : finite(options.maxUpgradeLevel))),
        maxCompoundLevel: Math.max(0, Math.min(20, finite(options.maxCompoundLevel) == null ? 10 : finite(options.maxCompoundLevel))),
        maxItemValueAtRisk: Math.max(0, finite(options.maxItemValueAtRisk) == null ? 250000 : finite(options.maxItemValueAtRisk)),
        maxConsumableCost: Math.max(0, finite(options.maxConsumableCost) == null ? 250000 : finite(options.maxConsumableCost)),
        mutationRiskHoldMs: Math.max(10000, Math.min(10 * 60 * 1000, finite(options.mutationRiskHoldMs) == null ? 60000 : finite(options.mutationRiskHoldMs))),
        mutationRiskLevelStep: Math.max(0, Math.min(0.15, finite(options.mutationRiskLevelStep) == null ? 0.05 : finite(options.mutationRiskLevelStep))),
        speculativeMinChanceNoSpare: Math.max(0, Math.min(1, finite(options.speculativeMinChanceNoSpare) == null ? 0.60 : finite(options.speculativeMinChanceNoSpare))),
        speculativeMinChanceOneSpare: Math.max(0, Math.min(1, finite(options.speculativeMinChanceOneSpare) == null ? 0.35 : finite(options.speculativeMinChanceOneSpare))),
        speculativeMinChanceManySpares: Math.max(0, Math.min(1, finite(options.speculativeMinChanceManySpares) == null ? 0.20 : finite(options.speculativeMinChanceManySpares))),
        upgradeValueCap: Math.max(1, finite(options.upgradeValueCap) == null ? 2000000 : finite(options.upgradeValueCap)),
        compoundValueCap: Math.max(1, finite(options.compoundValueCap) == null ? 500000 : finite(options.compoundValueCap)),
        offeringMode: ['DISABLED', 'OPTIONAL', 'REQUIRED'].includes(String(options.offeringMode || '').toUpperCase())
          ? String(options.offeringMode).toUpperCase() : 'DISABLED',
        offeringFromLevel: Math.max(0, Math.min(20, finite(options.offeringFromLevel) == null ? 7 : finite(options.offeringFromLevel))),
        offeringNames: Array.isArray(options.offeringNames) && options.offeringNames.length
          ? options.offeringNames.map(value => cleanText(value, 80)).filter(Boolean)
          : ['offeringp', 'offering']
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        upgradeCandidates: 0,
        compoundCandidates: 0,
        upgradesDispatched: 0,
        upgradesSucceeded: 0,
        upgradesFailed: 0,
        upgradesRejected: 0,
        upgradesUnknown: 0,
        compoundsDispatched: 0,
        compoundsSucceeded: 0,
        compoundsFailed: 0,
        compoundsRejected: 0,
        compoundsUnknown: 0,
        budgetBlocks: 0,
        safetyBlocks: 0,
        progressionBlocks: 0,
        mutationRiskChecks: 0,
        mutationRiskAccepted: 0,
        mutationRiskHolds: 0,
        mutationRiskHoldSkips: 0,
        mutationAuthoritativePreviews: 0,
        mutationAuthoritativeAccepted: 0,
        mutationAuthoritativeHolds: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H15_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('upgrade-compound-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    beginAutonomySession(reason = 'H15_AUTONOMY_SESSION_START') {
      if (!this.moduleActive) return { accepted: false, reason: 'H15_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.pending || this.request || this.riskPreview) {
        return { accepted: false, reason: 'H15_SESSION_ACTIVE_MUTATION' };
      }
      this.attemptsThisSession = 0;
      this.attemptSessionGeneration += 1;
      this.attemptSessionStartedAt = nowIso();
      this.attemptSessionReason = cleanText(reason, 240) || 'H15_AUTONOMY_SESSION_START';
      return {
        accepted: true,
        generation: this.attemptSessionGeneration,
        startedAt: this.attemptSessionStartedAt,
        maxAttempts: this.config.maxAttemptsPerSession
      };
    }

    stop(reason = 'H15_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.riskPreview = null;
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H15_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.riskPreview = null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      this.riskHolds.clear();
      this.lastMutationRiskDecision = null;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H15_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this.riskPreview = null;
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H15_POLICY_MUST_BE_OBJECT');
      if (value.maxAttemptsPerSession != null) this.config.maxAttemptsPerSession = Math.max(1, Math.min(100, Math.floor(Number(value.maxAttemptsPerSession) || 1)));
      if (value.maxUpgradeLevel != null) this.config.maxUpgradeLevel = Math.max(0, Math.min(20, Math.floor(Number(value.maxUpgradeLevel) || 0)));
      if (value.maxCompoundLevel != null) this.config.maxCompoundLevel = Math.max(0, Math.min(20, Math.floor(Number(value.maxCompoundLevel) || 0)));
      if (value.maxItemValueAtRisk != null) this.config.maxItemValueAtRisk = Math.max(0, Number(value.maxItemValueAtRisk) || 0);
      if (value.maxConsumableCost != null) this.config.maxConsumableCost = Math.max(0, Number(value.maxConsumableCost) || 0);
      if (value.mutationRiskHoldMs != null) this.config.mutationRiskHoldMs = Math.max(10000, Math.min(10 * 60 * 1000, Number(value.mutationRiskHoldMs) || 10000));
      if (value.mutationRiskLevelStep != null) this.config.mutationRiskLevelStep = Math.max(0, Math.min(0.15, Number(value.mutationRiskLevelStep) || 0));
      if (value.speculativeMinChanceNoSpare != null) this.config.speculativeMinChanceNoSpare = Math.max(0, Math.min(1, Number(value.speculativeMinChanceNoSpare) || 0));
      if (value.speculativeMinChanceOneSpare != null) this.config.speculativeMinChanceOneSpare = Math.max(0, Math.min(1, Number(value.speculativeMinChanceOneSpare) || 0));
      if (value.speculativeMinChanceManySpares != null) this.config.speculativeMinChanceManySpares = Math.max(0, Math.min(1, Number(value.speculativeMinChanceManySpares) || 0));
      if (value.upgradeValueCap != null) this.config.upgradeValueCap = Math.max(1, Number(value.upgradeValueCap) || 1);
      if (value.compoundValueCap != null) this.config.compoundValueCap = Math.max(1, Number(value.compoundValueCap) || 1);
      if (value.offeringFromLevel != null) this.config.offeringFromLevel = Math.max(0, Math.min(20, Math.floor(Number(value.offeringFromLevel) || 0)));
      if (value.offeringMode != null) {
        const mode = String(value.offeringMode).toUpperCase();
        if (!['DISABLED', 'OPTIONAL', 'REQUIRED'].includes(mode)) throw new Error('H15_OFFERING_MODE_INVALID');
        this.config.offeringMode = mode;
      }
      if (Array.isArray(value.offeringNames)) {
        const names = value.offeringNames.map(row => cleanText(row, 80)).filter(Boolean);
        if (!names.length) throw new Error('H15_OFFERING_NAMES_EMPTY');
        this.config.offeringNames = names;
      }
      return clone(this.config);
    }

    _snapshot() {
      try { return this.game && this.game.snapshot ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _inventory() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _definition(name) {
      try {
        if (this.game && this.game.equipmentDefinition) {
          const equipment = this.game.equipmentDefinition(name);
          if (equipment) return equipment;
        }
        return this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null;
      } catch (_) {
        return null;
      }
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _safeItem(row) {
      return !!(row && row.name && row.locked !== true && row.giveaway !== true && !row.expiresAt);
    }

    _safeDefinition(definition) {
      return !!(definition && definition.quest !== true && definition.cash !== true);
    }

    _propertyKey(row) {
      return [
        cleanText(row && row.name || '', 160),
        cleanText(row && (row.statType != null ? row.statType : row.stat_type) || '', 80),
        stableProperty(row && (row.property != null ? row.property : row.p))
      ].join('|');
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return this._propertyKey(row) + '|' + Math.max(0, Number(row.level) || 0);
    }

    _quantityByName(inventory, name) {
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || []).reduce((sum, row) =>
        String(row.name) === String(name) ? sum + Math.max(1, Number(row.quantity) || 1) : sum, 0);
    }

    _countIdentityAtLevel(inventory, identityKey, level) {
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || []).reduce((sum, row) => {
        if (this._propertyKey(row) !== identityKey) return sum;
        if (Math.max(0, Number(row.level) || 0) !== Math.max(0, Number(level) || 0)) return sum;
        return sum + Math.max(1, Number(row.quantity) || 1);
      }, 0);
    }

    _rowAt(inventory, slot) {
      return inventory && (inventory.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _riskKey(kind, row) {
      return [
        String(kind || '').toUpperCase(),
        this._propertyKey(row),
        Math.max(0, Number(row && row.level) || 0)
      ].join('|');
    }

    _activeRiskHold(kind, row) {
      const key = this._riskKey(kind, row);
      const hold = this.riskHolds.get(key) || null;
      if (!hold) return null;
      if (Number(hold.untilMs || 0) <= Date.now()) {
        this.riskHolds.delete(key);
        return null;
      }
      this.metrics.mutationRiskHoldSkips += 1;
      return clone(hold);
    }

    _bankRows() {
      if (!this.bank || typeof this.bank.plan !== 'function') return [];
      try {
        const plan = this.bank.plan();
        const rows = [];
        for (const pack of plan && Array.isArray(plan.packs) ? plan.packs : []) {
          for (const row of pack && Array.isArray(pack.items) ? pack.items : []) {
            if (row) rows.push(row);
          }
        }
        return rows;
      } catch (_) {
        return [];
      }
    }

    _replacementStock(kind, row, inventory, inputSlots = []) {
      const excluded = new Set((inputSlots || []).map(Number));
      const identityKey = this._propertyKey(row);
      const level = Math.max(0, Number(row && row.level) || 0);
      let localUnits = 0;
      for (const candidate of inventory && inventory.items || []) {
        if (!candidate || excluded.has(Number(candidate.slot))) continue;
        if (!this._safeItem(candidate) || this._propertyKey(candidate) !== identityKey) continue;
        if (Math.max(0, Number(candidate.level) || 0) < level) continue;
        localUnits += Math.max(1, Math.floor(Number(candidate.quantity) || 1));
      }
      let bankUnits = 0;
      for (const candidate of this._bankRows()) {
        if (!candidate || String(candidate.name || '') !== String(row && row.name || '')) continue;
        if (candidate.locked === true || candidate.giveaway === true) continue;
        if (Math.max(0, Number(candidate.level) || 0) < level) continue;
        bankUnits += Math.max(1, Math.floor(Number(candidate.quantity) || 1));
      }
      const spareUnits = localUnits + bankUnits;
      return {
        localUnits,
        bankUnits,
        spareUnits,
        spareEquivalents: String(kind || '').toUpperCase() === 'COMPOUND'
          ? Math.floor(spareUnits / 3)
          : spareUnits
      };
    }

    _normalizeMutationChance(response) {
      const raw = typeof response === 'number'
        ? response
        : response && response.chance != null
          ? Number(response.chance)
          : response && response.success_chance != null
            ? Number(response.success_chance)
            : response && response.data && response.data.chance != null
              ? Number(response.data.chance)
              : null;
      if (!Number.isFinite(raw) || raw < 0) return null;
      if (raw <= 1) return raw;
      if (raw <= 100) return raw / 100;
      return null;
    }

    _mutationChance(kind, evaluation, targetLevel) {
      const wanted = Math.max(0, Number(targetLevel) || 0);
      const future = evaluation && evaluation.futureGear || null;
      const curve = future && Array.isArray(future.curve) ? future.curve : [];
      const step = curve.find(row => Math.max(0, Number(row && row.level) || 0) === wanted);
      const futureChance = finite(step && step.stepChance);
      if (futureChance != null && futureChance >= 0 && futureChance <= 1) return futureChance;
      const economicChance = finite(evaluation && evaluation.economic && evaluation.economic.nextChance);
      if (economicChance != null && economicChance >= 0 && economicChance <= 1) return economicChance;
      return null;
    }

    _mutationRiskDecision(kind, row, definition, inventory, inputSlots, evaluation, targetLevel, options = {}) {
      // H15 can still be used as a low-level/manual controller in isolation.
      // Production autonomy always wires FutureGearEconomyEvaluator; apply the
      // V3 risk policy whenever that authority exists.
      if (!this.gearProgression) {
        return {
          at: nowIso(),
          allowed: true,
          reason: 'MUTATION_RISK_NOT_REQUIRED_WITHOUT_AUTONOMOUS_PROGRESSION',
          kind: String(kind || '').toUpperCase(),
          item: row && row.name || null,
          level: Math.max(0, Number(row && row.level) || 0),
          targetLevel: Math.max(0, Number(targetLevel) || 0),
          chance: null,
          minChance: null,
          replacement: null,
          usefulNow: false,
          threshold: null
        };
      }
      const activeHold = this._activeRiskHold(kind, row);
      if (activeHold) {
        const held = clone(activeHold.decision) || {};
        const decision = {
          ...held,
          allowed: false,
          reason: held.reason || 'MUTATION_RISK_EXCEEDS_POLICY',
          held: true,
          holdUntilMs: activeHold.untilMs
        };
        this.lastMutationRiskDecision = clone(decision);
        return decision;
      }
      const replacement = this._replacementStock(kind, row, inventory, inputSlots);
      const spare = Math.max(0, finite(replacement.spareEquivalents) || 0);
      const base = spare >= 2
        ? this.config.speculativeMinChanceManySpares
        : spare >= 1
          ? this.config.speculativeMinChanceOneSpare
          : this.config.speculativeMinChanceNoSpare;
      const level = Math.max(0, Number(row && row.level) || 0);
      const levelPenalty = Math.min(0.30, level * this.config.mutationRiskLevelStep);
      const compoundPenalty = String(kind || '').toUpperCase() === 'COMPOUND' ? 0.05 : 0;
      const future = evaluation && evaluation.futureGear || null;
      const usefulNow = !!(future && future.observedMeaningful === true);
      const partyPenalty = usefulNow ? 0.12 : 0;
      const value = Math.max(0, finite(definition && (definition.g != null ? definition.g : definition.gold)) || 0);
      const valueCap = String(kind || '').toUpperCase() === 'COMPOUND'
        ? this.config.compoundValueCap
        : this.config.upgradeValueCap;
      const valuePenalty = Math.min(0.08, (value / Math.max(1, valueCap)) * 0.08);
      const currentScore = Math.max(1, Math.abs(finite(future && future.currentScore) || 0));
      const improvement = Math.max(0, finite(future && future.improvement) || 0);
      const futureImprovementRatio = Math.max(0, Math.min(1, improvement / currentScore));
      const benefitCredit = Math.min(0.10, Math.max(0, futureImprovementRatio - 0.05) * 0.50);
      const minChance = Math.max(0.05, Math.min(0.995,
        base + levelPenalty + compoundPenalty + partyPenalty + valuePenalty - benefitCredit));
      const chance = options.chanceProvided === true
        ? this._normalizeMutationChance(options.chance)
        : this._mutationChance(kind, evaluation, targetLevel);
      let accountPolicy = null;
      if (this.gearProgression && typeof this.gearProgression.mutationRiskPolicy === 'function') {
        try {
          accountPolicy = this.gearProgression.mutationRiskPolicy(
            kind,
            row,
            definition,
            evaluation,
            targetLevel,
            chance,
            { itemCount: String(kind || '').toUpperCase() === 'COMPOUND' ? 3 : 1 }
          );
        } catch (_) {
          accountPolicy = {
            allowed: false,
            reason: 'ACCOUNT_MUTATION_RISK_POLICY_UNAVAILABLE',
            minChance: null
          };
        }
      }
      const accountMinChance = finite(accountPolicy && accountPolicy.minChance);
      const effectiveMinChance = Math.max(minChance, accountMinChance == null ? 0 : accountMinChance);
      const accountAllowed = !accountPolicy || accountPolicy.allowed === true;
      const allowed = accountAllowed && chance != null && chance >= effectiveMinChance;
      const decision = {
        at: nowIso(),
        allowed,
        reason: allowed
          ? 'MUTATION_RISK_ACCEPTED'
          : accountPolicy && accountPolicy.allowed !== true
            ? accountPolicy.reason || 'ACCOUNT_MUTATION_RISK_BLOCKED'
            : chance == null
              ? 'MUTATION_CHANCE_UNAVAILABLE'
              : 'MUTATION_RISK_EXCEEDS_POLICY',
        kind: String(kind || '').toUpperCase(),
        item: row && row.name || null,
        level,
        targetLevel: Math.max(0, Number(targetLevel) || 0),
        chance,
        minChance: effectiveMinChance,
        accountPolicy: accountPolicy ? clone(accountPolicy) : null,
        replacement,
        usefulNow,
        serverAuthoritative: options.serverAuthoritative === true,
        threshold: {
          base,
          levelPenalty,
          compoundPenalty,
          partyPenalty,
          valuePenalty,
          benefitCredit,
          futureImprovementRatio,
          spareEquivalents: spare,
          localMinChance: minChance,
          accountMinChance
        }
      };
      this.metrics.mutationRiskChecks += 1;
      if (allowed) {
        this.metrics.mutationRiskAccepted += 1;
      } else {
        this.metrics.mutationRiskHolds += 1;
        const key = this._riskKey(kind, row);
        this.riskHolds.set(key, {
          key,
          untilMs: Date.now() + this.config.mutationRiskHoldMs,
          decision: clone(decision)
        });
      }
      this.lastMutationRiskDecision = clone(decision);
      return decision;
    }

    _grade(definition, level) {
      const grades = definition && Array.isArray(definition.grades) ? definition.grades : null;
      if (!grades || !grades.length) return 0;
      const current = Math.max(0, Number(level) || 0);
      if (grades.length >= 2) {
        if (current < Number(grades[0])) return 0;
        if (current < Number(grades[1])) return 1;
        return 2;
      }
      return current < Number(grades[0]) ? 0 : 1;
    }

    _scrollName(kind, grade) {
      const safeGrade = Math.max(0, Math.min(2, Number(grade) || 0));
      return (kind === 'COMPOUND' ? 'cscroll' : 'scroll') + safeGrade;
    }

    _findConsumable(inventory, name, excluded = new Set()) {
      return (inventory.items || []).find(row =>
        !excluded.has(Number(row.slot))
        && String(row.name) === String(name)
        && this._safeItem(row)
        && Math.max(1, Number(row.quantity) || 1) >= 1) || null;
    }

    _offeringFor(inventory, level, excluded = new Set(), force = null) {
      const shouldUse = force === true
        || (force == null && this.config.offeringMode !== 'DISABLED' && Number(level) >= this.config.offeringFromLevel);
      if (!shouldUse) return { required: false, row: null };
      for (const name of this.config.offeringNames) {
        const row = this._findConsumable(inventory, name, excluded);
        if (row) return { required: this.config.offeringMode === 'REQUIRED' || force === true, row };
      }
      return { required: this.config.offeringMode === 'REQUIRED' || force === true, row: null };
    }

    _estimatedItemValue(row, definition) {
      const base = Math.max(0, finite(definition && definition.g) || 0);
      const level = Math.max(0, Number(row && row.level) || 0);
      return Math.round(base * Math.pow(1.75, level));
    }

    _budget(row, definition, scroll, offering, targetLevel, kind = 'UPGRADE', itemCount = 1) {
      const itemValueAtRisk = this._estimatedItemValue(row, definition) * Math.max(1, Math.floor(Number(itemCount) || 1));
      const scrollDef = scroll ? this._definition(scroll.name) : null;
      const offeringDef = offering ? this._definition(offering.name) : null;
      const consumableCost = Math.max(0, finite(scrollDef && scrollDef.g) || 0)
        + Math.max(0, finite(offeringDef && offeringDef.g) || 0);
      const maxLevel = kind === 'COMPOUND' ? this.config.maxCompoundLevel : this.config.maxUpgradeLevel;
      if (Number(targetLevel) > maxLevel) return { ok: false, reason: 'H15_TARGET_LEVEL_OVER_BUDGET', itemValueAtRisk, consumableCost };
      if (itemValueAtRisk > this.config.maxItemValueAtRisk) return { ok: false, reason: 'H15_ITEM_VALUE_OVER_BUDGET', itemValueAtRisk, consumableCost };
      if (consumableCost > this.config.maxConsumableCost) return { ok: false, reason: 'H15_CONSUMABLE_COST_OVER_BUDGET', itemValueAtRisk, consumableCost };
      return { ok: true, itemValueAtRisk, consumableCost };
    }

    _progressionPlan(inventory) {
      if (!this.gearProgression || typeof this.gearProgression.evaluateInventory !== 'function') return null;
      try { return this.gearProgression.evaluateInventory(inventory); }
      catch (_) { return { state: 'BLOCKED', reason: 'H15_FUTURE_GEAR_EVALUATION_FAILED', evaluations: [] }; }
    }

    _mutationGate(row, kind, inventory, progressionPlan = null) {
      if (!this.gearProgression) return { ok: true, evaluation: null };
      const plan = progressionPlan || this._progressionPlan(inventory);
      if (!plan || plan.state !== 'READY') {
        return { ok: false, reason: plan && plan.reason || 'H15_FUTURE_GEAR_EVALUATION_REQUIRED', evaluation: null };
      }
      const evaluation = (plan.evaluations || []).find(candidate =>
        Number(candidate.slot) === Number(row && row.slot)
        && String(candidate.item || '') === String(row && row.name || '')
        && Math.max(0, Number(candidate.observedLevel) || 0) === Math.max(0, Number(row && row.level) || 0)
      ) || null;
      if (!evaluation || evaluation.checked !== true) {
        return { ok: false, reason: 'H15_FUTURE_GEAR_EVALUATION_REQUIRED', evaluation };
      }
      if (String(evaluation.action || '').toUpperCase() !== String(kind || '').toUpperCase()) {
        return {
          ok: false,
          reason: 'H15_MUTATION_NOT_RECOMMENDED',
          recommendedAction: evaluation.action || null,
          evaluation
        };
      }
      return { ok: true, evaluation };
    }

    _upgradeCandidate(row, inventory, options = {}) {
      if (!this._safeItem(row)) return { ok: false, reason: 'H15_ITEM_NOT_AUTOMATION_SAFE' };
      const definition = this._definition(row.name);
      if (!definition || definition.upgradeable !== true) return { ok: false, reason: 'H15_ITEM_NOT_UPGRADEABLE' };
      if (!this._safeDefinition(definition)) return { ok: false, reason: 'H15_ITEM_DEFINITION_PROTECTED' };
      const progression = this._mutationGate(row, 'UPGRADE', inventory, options.progressionPlan || null);
      if (!progression.ok) return { ok: false, reason: progression.reason, progression: progression.evaluation || null, recommendedAction: progression.recommendedAction || null };
      const level = Math.max(0, Number(row.level) || 0);
      const targetLevel = level + 1;
      const grade = this._grade(definition, level);
      const risk = this._mutationRiskDecision('UPGRADE', row, definition, inventory, [Number(row.slot)], progression.evaluation, targetLevel);
      if (!risk.allowed) return {
        ok: false,
        reason: risk.reason,
        itemSlot: Number(row.slot),
        itemName: row.name,
        fromLevel: level,
        targetLevel,
        risk,
        progression: progression.evaluation ? clone(progression.evaluation) : null
      };
      const excluded = new Set([Number(row.slot)]);
      const scrollName = this._scrollName('UPGRADE', grade);
      const scroll = this._findConsumable(inventory, scrollName, excluded);
      if (!scroll) return {
        ok: false,
        reason: 'H15_UPGRADE_SCROLL_MISSING',
        itemSlot: Number(row.slot),
        itemName: row.name,
        fromLevel: level,
        targetLevel,
        scrollName,
        grade,
        progression: progression.evaluation ? clone(progression.evaluation) : null
      };
      excluded.add(Number(scroll.slot));
      const offering = this._offeringFor(inventory, level, excluded, options.useOffering == null ? null : options.useOffering === true);
      if (offering.required && !offering.row) return { ok: false, reason: 'H15_REQUIRED_OFFERING_MISSING', scrollName, grade };
      const budget = this._budget(row, definition, scroll, offering.row, targetLevel, 'UPGRADE', 1);
      if (!budget.ok) return { ok: false, reason: budget.reason, budget, scrollName, grade };
      return {
        ok: true,
        kind: 'UPGRADE',
        item: clone(row),
        itemSlot: Number(row.slot),
        fingerprint: this._fingerprint(row),
        identityKey: this._propertyKey(row),
        definition: clone(definition),
        fromLevel: level,
        targetLevel,
        grade,
        scroll: clone(scroll),
        scrollName,
        offering: offering.row ? clone(offering.row) : null,
        budget,
        risk: clone(risk),
        progression: progression.evaluation ? clone(progression.evaluation) : null
      };
    }

    _compoundCandidate(rows, inventory, options = {}) {
      if (!Array.isArray(rows) || rows.length !== 3) return { ok: false, reason: 'H15_COMPOUND_NEEDS_THREE_ITEMS' };
      if (rows.some(row => !this._safeItem(row))) return { ok: false, reason: 'H15_ITEM_NOT_AUTOMATION_SAFE' };
      const fingerprints = rows.map(row => this._fingerprint(row));
      if (!fingerprints[0] || !fingerprints.every(value => value === fingerprints[0])) {
        return { ok: false, reason: 'H15_COMPOUND_ITEMS_NOT_IDENTICAL' };
      }
      const definition = this._definition(rows[0].name);
      if (!definition || definition.compoundable !== true) return { ok: false, reason: 'H15_ITEM_NOT_COMPOUNDABLE' };
      if (!this._safeDefinition(definition)) return { ok: false, reason: 'H15_ITEM_DEFINITION_PROTECTED' };
      const progression = this._mutationGate(rows[0], 'COMPOUND', inventory, options.progressionPlan || null);
      if (!progression.ok) return { ok: false, reason: progression.reason, progression: progression.evaluation || null, recommendedAction: progression.recommendedAction || null };
      const level = Math.max(0, Number(rows[0].level) || 0);
      const targetLevel = level + 1;
      const grade = this._grade(definition, level);
      const sourceSlots = rows.map(row => Number(row.slot)).sort((a, b) => a - b);
      const risk = this._mutationRiskDecision('COMPOUND', rows[0], definition, inventory, sourceSlots, progression.evaluation, targetLevel);
      if (!risk.allowed) return {
        ok: false,
        reason: risk.reason,
        itemSlots: sourceSlots,
        itemName: rows[0].name,
        fromLevel: level,
        targetLevel,
        risk,
        progression: progression.evaluation ? clone(progression.evaluation) : null
      };
      const excluded = new Set(sourceSlots);
      const scrollName = this._scrollName('COMPOUND', grade);
      const scroll = this._findConsumable(inventory, scrollName, excluded);
      if (!scroll) return {
        ok: false,
        reason: 'H15_COMPOUND_SCROLL_MISSING',
        itemSlots: sourceSlots,
        itemName: rows[0].name,
        fromLevel: level,
        targetLevel,
        scrollName,
        grade,
        progression: progression.evaluation ? clone(progression.evaluation) : null
      };
      excluded.add(Number(scroll.slot));
      const offering = this._offeringFor(inventory, level, excluded, options.useOffering == null ? null : options.useOffering === true);
      if (offering.required && !offering.row) return { ok: false, reason: 'H15_REQUIRED_OFFERING_MISSING', scrollName, grade };
      const budget = this._budget(rows[0], definition, scroll, offering.row, targetLevel, 'COMPOUND', 3);
      if (!budget.ok) return { ok: false, reason: budget.reason, budget, scrollName, grade };
      return {
        ok: true,
        kind: 'COMPOUND',
        items: clone(rows),
        itemSlots: sourceSlots,
        fingerprint: fingerprints[0],
        identityKey: this._propertyKey(rows[0]),
        definition: clone(definition),
        fromLevel: level,
        targetLevel,
        grade,
        scroll: clone(scroll),
        scrollName,
        offering: offering.row ? clone(offering.row) : null,
        budget,
        risk: clone(risk),
        progression: progression.evaluation ? clone(progression.evaluation) : null
      };
    }

    plan() {
      this.metrics.plans += 1;
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) {
        this.lastPlan = { state: 'BLOCKED', reason: 'H15_INVENTORY_UNAVAILABLE' };
        return clone(this.lastPlan);
      }
      const rows = inventory.items || [];
      const progressionPlan = this._progressionPlan(inventory);
      const upgradeCandidates = [];
      const materialNeeds = [];
      for (const row of rows) {
        const candidate = this._upgradeCandidate(row, inventory, { progressionPlan });
        if (candidate.ok) upgradeCandidates.push(candidate);
        else if (candidate.reason === 'H15_UPGRADE_SCROLL_MISSING' && candidate.scrollName) {
          materialNeeds.push({
            kind: 'UPGRADE_SCROLL',
            mutationKind: 'UPGRADE',
            itemSlot: candidate.itemSlot,
            itemName: candidate.itemName,
            fromLevel: candidate.fromLevel,
            targetLevel: candidate.targetLevel,
            consumableName: candidate.scrollName,
            grade: candidate.grade,
            quantity: 1,
            progression: candidate.progression ? clone(candidate.progression) : null
          });
        } else if (this.gearProgression && ['H15_FUTURE_GEAR_EVALUATION_REQUIRED', 'H15_FUTURE_GEAR_EVALUATION_FAILED', 'H15_MUTATION_NOT_RECOMMENDED'].includes(candidate.reason)) {
          this.metrics.progressionBlocks += 1;
        }
      }

      const groups = new Map();
      for (const row of rows) {
        if (!this._safeItem(row)) continue;
        const definition = this._definition(row.name);
        if (!definition || definition.compoundable !== true) continue;
        const key = this._fingerprint(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const compoundCandidates = [];
      for (const rowsForKey of groups.values()) {
        const sorted = rowsForKey.slice().sort((a, b) => Number(a.slot) - Number(b.slot));
        for (let offset = 0; offset + 2 < sorted.length; offset += 3) {
          const candidate = this._compoundCandidate(sorted.slice(offset, offset + 3), inventory, { progressionPlan });
          if (candidate.ok) compoundCandidates.push(candidate);
          else if (candidate.reason === 'H15_COMPOUND_SCROLL_MISSING' && candidate.scrollName) {
            materialNeeds.push({
              kind: 'COMPOUND_SCROLL',
              mutationKind: 'COMPOUND',
              itemSlots: clone(candidate.itemSlots || []),
              itemName: candidate.itemName,
              fromLevel: candidate.fromLevel,
              targetLevel: candidate.targetLevel,
              consumableName: candidate.scrollName,
              grade: candidate.grade,
              quantity: 1,
              progression: candidate.progression ? clone(candidate.progression) : null
            });
          } else if (this.gearProgression && ['H15_FUTURE_GEAR_EVALUATION_REQUIRED', 'H15_FUTURE_GEAR_EVALUATION_FAILED', 'H15_MUTATION_NOT_RECOMMENDED'].includes(candidate.reason)) {
            this.metrics.progressionBlocks += 1;
          }
        }
      }

      upgradeCandidates.sort((a, b) => a.budget.itemValueAtRisk - b.budget.itemValueAtRisk || a.fromLevel - b.fromLevel || a.itemSlot - b.itemSlot);
      compoundCandidates.sort((a, b) => a.budget.itemValueAtRisk - b.budget.itemValueAtRisk || a.fromLevel - b.fromLevel || a.itemSlots[0] - b.itemSlots[0]);
      materialNeeds.sort((a, b) =>
        String(a.consumableName || '').localeCompare(String(b.consumableName || ''))
        || Number(a.fromLevel || 0) - Number(b.fromLevel || 0)
        || Number(a.itemSlot == null ? (a.itemSlots && a.itemSlots[0]) : a.itemSlot) - Number(b.itemSlot == null ? (b.itemSlots && b.itemSlots[0]) : b.itemSlot));

      this.metrics.upgradeCandidates = upgradeCandidates.length;
      this.metrics.compoundCandidates = compoundCandidates.length;
      const reserved = new Set();
      if (this.request) {
        for (const slot of this.request.itemSlots || [this.request.itemSlot]) if (slot != null) reserved.add(Number(slot));
        if (this.request.scrollSlot != null) reserved.add(Number(this.request.scrollSlot));
        if (this.request.offeringSlot != null) reserved.add(Number(this.request.offeringSlot));
      }
      if (this.pending) {
        for (const slot of this.pending.itemSlots || [this.pending.itemSlot]) if (slot != null) reserved.add(Number(slot));
        if (this.pending.scrollSlot != null) reserved.add(Number(this.pending.scrollSlot));
        if (this.pending.offeringSlot != null) reserved.add(Number(this.pending.offeringSlot));
      }

      this.lastPlan = {
        state: 'READY',
        reason: 'H15_PLAN_READY',
        inventory: {
          capacity: inventory.capacity,
          usedSlots: inventory.usedSlots,
          freeSlots: inventory.freeSlots
        },
        workspace: {
          reservedSlots: Array.from(reserved).sort((a, b) => a - b),
          requestActive: !!this.request,
          pendingActive: !!this.pending
        },
        policy: clone(this.config),
        futureGearEvaluation: progressionPlan ? clone(progressionPlan) : null,
        upgradeCandidates: clone(upgradeCandidates),
        compoundCandidates: clone(compoundCandidates),
        materialNeeds: clone(materialNeeds)
      };
      return clone(this.lastPlan);
    }

    _queue(candidate, options = {}) {
      if (!candidate || candidate.ok !== true) return { accepted: false, reason: candidate && candidate.reason || 'H15_CANDIDATE_INVALID' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.pending || this.request) return { accepted: false, reason: 'H15_BUSY' };
      if (this.attemptsThisSession >= this.config.maxAttemptsPerSession) {
        this.metrics.budgetBlocks += 1;
        return { accepted: false, reason: 'H15_SESSION_ATTEMPT_BUDGET_EXHAUSTED' };
      }
      this.request = {
        id: 'h15-request-' + (++this.sequence),
        kind: candidate.kind,
        itemSlot: candidate.itemSlot == null ? null : Number(candidate.itemSlot),
        itemSlots: candidate.itemSlots ? candidate.itemSlots.map(Number) : null,
        fingerprint: candidate.fingerprint,
        identityKey: candidate.identityKey,
        fromLevel: candidate.fromLevel,
        targetLevel: candidate.targetLevel,
        scrollSlot: Number(candidate.scroll.slot),
        scrollName: candidate.scrollName,
        offeringSlot: candidate.offering ? Number(candidate.offering.slot) : null,
        offeringName: candidate.offering ? candidate.offering.name : null,
        budget: clone(candidate.budget),
        risk: candidate.risk ? clone(candidate.risk) : null,
        progression: candidate.progression ? clone(candidate.progression) : null,
        queuedAt: nowIso(),
        useOffering: options.useOffering === true
      };
      this.lastAction = { at: nowIso(), type: candidate.kind + '_QUEUED', requestId: this.request.id };
      return { accepted: true, request: clone(this.request) };
    }

    queueUpgrade(itemSlot, options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { accepted: false, reason: 'H15_INVENTORY_UNAVAILABLE' };
      const row = this._rowAt(inventory, itemSlot);
      if (!row) return { accepted: false, reason: 'H15_UPGRADE_SOURCE_MISSING' };
      const candidate = this._upgradeCandidate(row, inventory, options);
      if (!candidate.ok && String(candidate.reason || '').includes('BUDGET')) this.metrics.budgetBlocks += 1;
      if (!candidate.ok && !String(candidate.reason || '').includes('SCROLL') && !String(candidate.reason || '').includes('OFFERING')) this.metrics.safetyBlocks += 1;
      return this._queue(candidate, options);
    }

    queueCompound(itemSlots, options = {}) {
      if (!Array.isArray(itemSlots) || itemSlots.length !== 3) return { accepted: false, reason: 'H15_COMPOUND_NEEDS_THREE_ITEMS' };
      const slots = itemSlots.map(Number);
      if (new Set(slots).size !== 3) return { accepted: false, reason: 'H15_COMPOUND_SLOTS_MUST_BE_UNIQUE' };
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { accepted: false, reason: 'H15_INVENTORY_UNAVAILABLE' };
      const rows = slots.map(slot => this._rowAt(inventory, slot));
      if (rows.some(row => !row)) return { accepted: false, reason: 'H15_COMPOUND_SOURCE_MISSING' };
      const candidate = this._compoundCandidate(rows, inventory, options);
      if (!candidate.ok && String(candidate.reason || '').includes('BUDGET')) this.metrics.budgetBlocks += 1;
      if (!candidate.ok && !String(candidate.reason || '').includes('SCROLL') && !String(candidate.reason || '').includes('OFFERING')) this.metrics.safetyBlocks += 1;
      return this._queue(candidate, options);
    }

    queueBest(kind = null) {
      const plan = this.plan();
      if (!plan || plan.state !== 'READY') return { accepted: false, reason: plan && plan.reason || 'H15_PLAN_UNAVAILABLE' };
      const wanted = kind == null ? null : String(kind).toUpperCase();
      if (wanted === 'COMPOUND') {
        const candidate = plan.compoundCandidates[0];
        return candidate ? this.queueCompound(candidate.itemSlots) : { accepted: false, reason: 'H15_NO_COMPOUND_CANDIDATE' };
      }
      if (wanted === 'UPGRADE') {
        const candidate = plan.upgradeCandidates[0];
        return candidate ? this.queueUpgrade(candidate.itemSlot) : { accepted: false, reason: 'H15_NO_UPGRADE_CANDIDATE' };
      }
      const choices = [];
      if (plan.upgradeCandidates[0]) choices.push(plan.upgradeCandidates[0]);
      if (plan.compoundCandidates[0]) choices.push(plan.compoundCandidates[0]);
      choices.sort((a, b) => a.budget.itemValueAtRisk - b.budget.itemValueAtRisk);
      const candidate = choices[0];
      if (!candidate) return { accepted: false, reason: 'H15_NO_SAFE_CANDIDATE' };
      return candidate.kind === 'UPGRADE' ? this.queueUpgrade(candidate.itemSlot) : this.queueCompound(candidate.itemSlots);
    }

    _writeAllowed() {
      const snap = this._snapshot();
      if (!snap || !snap.available || !snap.character) return { ok: false, reason: 'H15_CHARACTER_UNAVAILABLE' };
      if (snap.character.rip === true) return { ok: false, reason: 'H15_CHARACTER_DEAD' };
      if (this._combatActive()) {
        this.metrics.safetyBlocks += 1;
        return { ok: false, reason: 'H15_COMBAT_ACTIVE' };
      }
      return { ok: true, snapshot: snap };
    }

    _metric(kind, suffix) {
      const prefix = kind === 'COMPOUND' ? 'compounds' : 'upgrades';
      const key = prefix + suffix;
      if (Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.suspendedReason = cleanText(reason || ('H15_' + kind + '_UNKNOWN'), 300);
      this.pending = null;
      this.request = null;
      this.lastAction = { at: nowIso(), type: kind + '_UNKNOWN', reason: this.suspendedReason };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _watch(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        pending.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.pending || this.pending.id !== pending.id) return;
        this.pending.settlement = 'RESOLVED';
        this.pending.response = response == null ? null : clone(response);
      }, error => {
        if (!this.pending || this.pending.id !== pending.id) return;
        this.pending.settlement = 'REJECTED';
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H15_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _riskPreviewArgs(request) {
      return request.kind === 'COMPOUND'
        ? request.itemSlots.concat([request.scrollSlot, request.offeringSlot])
        : [request.itemSlot, request.scrollSlot, request.offeringSlot];
    }

    _watchRiskPreview(value, preview) {
      if (!value || typeof value.then !== 'function') {
        preview.settlement = 'RETURNED';
        preview.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.riskPreview || this.riskPreview.id !== preview.id) return;
        this.riskPreview.settlement = 'RESOLVED';
        this.riskPreview.response = response == null ? null : clone(response);
      }, error => {
        if (!this.riskPreview || this.riskPreview.id !== preview.id) return;
        this.riskPreview.settlement = 'REJECTED';
        this.riskPreview.error = cleanText(error && (error.reason || error.message) || error || 'MUTATION_CHANCE_UNAVAILABLE', 500);
      }).catch(() => {});
    }

    _beginAuthoritativeRiskPreview(request) {
      if (!this.gearProgression || !this.actions || typeof this.actions.previewMutation !== 'function') return null;
      let result;
      try {
        result = this.actions.previewMutation(
          request.kind === 'COMPOUND' ? 'compound' : 'upgrade',
          this._riskPreviewArgs(request)
        );
      } catch (error) {
        result = { state: 'UNKNOWN', value: null, error: { message: cleanText(error && error.message || error, 300) } };
      }
      this.metrics.mutationAuthoritativePreviews += 1;
      if (!result || result.state !== 'PREVIEWED') {
        const reason = result && result.state === 'BLOCKED'
          ? 'H15_MUTATION_CHANCE_PREVIEW_BLOCKED'
          : result && result.state === 'UNAVAILABLE'
            ? 'H15_MUTATION_CHANCE_PREVIEW_UNAVAILABLE'
            : 'H15_MUTATION_CHANCE_PREVIEW_UNKNOWN';
        const inventory = this._inventory();
        const row = inventory && this._rowAt(inventory, request.kind === 'COMPOUND' ? request.itemSlots[0] : request.itemSlot);
        const definition = row ? this._definition(row.name) : null;
        const risk = row && definition
          ? this._mutationRiskDecision(
              request.kind, row, definition, inventory,
              request.kind === 'COMPOUND' ? request.itemSlots : [request.itemSlot],
              request.progression, request.targetLevel,
              { chanceProvided: true, chance: null, serverAuthoritative: true }
            )
          : null;
        this.metrics.mutationAuthoritativeHolds += 1;
        this.request = null;
        this.riskPreview = null;
        this.lastAction = { at: nowIso(), type: request.kind + '_BLOCKED', reason, risk: risk ? clone(risk) : null };
        return { state: 'BLOCKED', reason, risk: risk ? clone(risk) : null };
      }
      const preview = {
        id: 'h15-risk-preview-' + (++this.sequence),
        requestId: request.id,
        kind: request.kind,
        startedAt: nowIso(),
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.riskPreview = preview;
      this.lastAction = { at: preview.startedAt, type: request.kind + '_RISK_PREVIEW_STARTED', requestId: request.id };
      this._watchRiskPreview(result.value, preview);
      if (preview.settlement !== 'PENDING') return this._observeRiskPreview();
      return { state: 'RISK_PENDING', preview: clone(preview) };
    }

    _observeRiskPreview() {
      const preview = this.riskPreview;
      const request = this.request;
      if (!preview || !request || preview.requestId !== request.id) {
        this.riskPreview = null;
        return { state: 'BLOCKED', reason: 'H15_MUTATION_CHANCE_PREVIEW_ORPHANED' };
      }
      if (preview.settlement === 'PENDING') return { state: 'RISK_PENDING', preview: clone(preview) };

      const inventory = this._inventory();
      const itemSlot = request.kind === 'COMPOUND' ? request.itemSlots[0] : request.itemSlot;
      const row = inventory && this._rowAt(inventory, itemSlot);
      const definition = row ? this._definition(row.name) : null;
      if (!inventory || inventory.available === false || !row || !definition || this._fingerprint(row) !== request.fingerprint) {
        this.riskPreview = null;
        this.request = null;
        this.lastAction = { at: nowIso(), type: request.kind + '_BLOCKED', reason: 'H15_SOURCE_CHANGED_DURING_RISK_PREVIEW' };
        return { state: 'BLOCKED', reason: 'H15_SOURCE_CHANGED_DURING_RISK_PREVIEW' };
      }

      const chance = preview.settlement === 'REJECTED' ? null : this._normalizeMutationChance(preview.response);
      const risk = this._mutationRiskDecision(
        request.kind, row, definition, inventory,
        request.kind === 'COMPOUND' ? request.itemSlots : [request.itemSlot],
        request.progression, request.targetLevel,
        { chanceProvided: true, chance, serverAuthoritative: true }
      );
      this.riskPreview = null;
      if (!risk.allowed) {
        this.metrics.mutationAuthoritativeHolds += 1;
        this.request = null;
        const reason = risk.reason === 'MUTATION_CHANCE_UNAVAILABLE'
          ? 'H15_MUTATION_CHANCE_UNAVAILABLE'
          : risk.reason;
        this.lastAction = { at: nowIso(), type: request.kind + '_BLOCKED', reason, risk: clone(risk) };
        return { state: 'BLOCKED', reason, risk: clone(risk) };
      }

      this.metrics.mutationAuthoritativeAccepted += 1;
      this.request.authoritativeRisk = clone(risk);
      this.lastAction = { at: nowIso(), type: request.kind + '_RISK_ACCEPTED', requestId: request.id, risk: clone(risk) };
      return { state: 'RISK_ACCEPTED', risk: clone(risk) };
    }

    _dispatch(request, inventory) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') return { accepted: false, reason: 'H15_ACTION_BOUNDARY_UNAVAILABLE' };
      const beforeScrollQuantity = this._quantityByName(inventory, request.scrollName);
      const beforeOfferingQuantity = request.offeringName ? this._quantityByName(inventory, request.offeringName) : null;
      const beforeSameLevel = this._countIdentityAtLevel(inventory, request.identityKey, request.fromLevel);
      const beforeNextLevel = this._countIdentityAtLevel(inventory, request.identityKey, request.targetLevel);
      const args = request.kind === 'COMPOUND'
        ? request.itemSlots.concat([request.scrollSlot, request.offeringSlot])
        : [request.itemSlot, request.scrollSlot, request.offeringSlot];
      let result;
      try { result = this.actions.dispatch(request.kind === 'COMPOUND' ? 'compound' : 'upgrade', args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(request.kind, result.error && result.error.message || 'H15_DISPATCH_UNKNOWN');
        this._metric(request.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H15_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'h15-pending-' + (++this.sequence),
        ...request,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        evidenceAtMs: null,
        settlement: 'PENDING',
        response: null,
        error: null,
        beforeScrollQuantity,
        beforeOfferingQuantity,
        beforeSameLevel,
        beforeNextLevel
      };
      this.pending = pending;
      this.attemptsThisSession += 1;
      this._metric(request.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: request.kind + '_DISPATCHED', requestId: request.id };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _complete(pending, outcome, details = {}) {
      this.pending = null;
      this.request = null;
      this._metric(pending.kind, outcome === 'SUCCEEDED' ? 'Succeeded' : 'Failed');
      this.lastAction = {
        at: nowIso(),
        type: pending.kind + '_' + outcome,
        fromLevel: pending.fromLevel,
        targetLevel: pending.targetLevel,
        ...clone(details)
      };
      return true;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) {
        if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H15_INVENTORY_UNAVAILABLE_DURING_OUTCOME');
        return false;
      }
      const afterScroll = this._quantityByName(inventory, pending.scrollName);
      const scrollConsumed = afterScroll != null && pending.beforeScrollQuantity != null && afterScroll <= pending.beforeScrollQuantity - 1;
      const afterOffering = pending.offeringName ? this._quantityByName(inventory, pending.offeringName) : null;
      const offeringConsumed = !pending.offeringName
        || (afterOffering != null && pending.beforeOfferingQuantity != null && afterOffering <= pending.beforeOfferingQuantity - 1);
      const afterNextLevel = this._countIdentityAtLevel(inventory, pending.identityKey, pending.targetLevel);
      const successObserved = afterNextLevel != null && pending.beforeNextLevel != null && afterNextLevel >= pending.beforeNextLevel + 1;

      if (successObserved && scrollConsumed && offeringConsumed) {
        return this._complete(pending, 'SUCCEEDED', { evidence: 'INVENTORY_LEVEL_DELTA' });
      }

      if (scrollConsumed && offeringConsumed) {
        if (pending.evidenceAtMs == null) pending.evidenceAtMs = Date.now();
        if (Date.now() - pending.evidenceAtMs >= this.config.settleGraceMs) {
          return this._complete(pending, 'FAILED', {
            evidence: 'CONSUMABLE_DELTA_WITHOUT_LEVEL_GAIN',
            afterSameLevel: this._countIdentityAtLevel(inventory, pending.identityKey, pending.fromLevel)
          });
        }
      }

      if (pending.settlement === 'RESOLVED'
          && pending.response
          && typeof pending.response === 'object'
          && typeof pending.response.success === 'boolean'
          && Date.now() - Number(pending.dispatchedAtMs || 0) >= this.config.settleGraceMs) {
        // Since the 2026 CODE API update, public async functions settle on the
        // real server result. Keep inventory deltas as the strongest evidence,
        // but accept an explicit server success/failure when redraw/inventory
        // propagation lags behind the Promise settlement.
        if (pending.response.success === true) {
          return this._complete(pending, 'SUCCEEDED', {
            evidence: 'SERVER_SETTLEMENT_SUCCESS'
          });
        }
        return this._complete(pending, 'FAILED', {
          evidence: 'SERVER_SETTLEMENT_FAILURE',
          serverReason: cleanText(
            pending.response.reason || pending.response.message || pending.response.code || 'SERVER_REJECTED',
            240
          )
        });
      }
      if (pending.settlement === 'REJECTED') {
        return this._suspend(pending.kind, pending.error || 'H15_ACTION_REJECTED_WITHOUT_LIVE_OUTCOME');
      }
      if (Date.now() >= pending.deadlineAtMs) {
        return this._suspend(pending.kind, 'H15_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      }
      return false;
    }

    _revalidate(request, inventory) {
      const gate = this._writeAllowed();
      if (!gate.ok) return gate;
      if (this.attemptsThisSession >= this.config.maxAttemptsPerSession) return { ok: false, reason: 'H15_SESSION_ATTEMPT_BUDGET_EXHAUSTED' };

      const itemSlots = request.kind === 'COMPOUND' ? request.itemSlots : [request.itemSlot];
      const rows = itemSlots.map(slot => this._rowAt(inventory, slot));
      if (rows.some(row => !row)) return { ok: false, reason: 'H15_SOURCE_CHANGED' };
      if (rows.some(row => this._fingerprint(row) !== request.fingerprint)) return { ok: false, reason: 'H15_SOURCE_CHANGED' };
      if (rows.some(row => !this._safeItem(row))) return { ok: false, reason: 'H15_ITEM_NOT_AUTOMATION_SAFE' };

      const scroll = this._rowAt(inventory, request.scrollSlot);
      if (!scroll || String(scroll.name) !== String(request.scrollName) || !this._safeItem(scroll)) {
        return { ok: false, reason: 'H15_SCROLL_SOURCE_CHANGED' };
      }
      if (request.offeringSlot != null) {
        const offering = this._rowAt(inventory, request.offeringSlot);
        if (!offering || String(offering.name) !== String(request.offeringName) || !this._safeItem(offering)) {
          return { ok: false, reason: 'H15_OFFERING_SOURCE_CHANGED' };
        }
      }

      const definition = this._definition(rows[0].name);
      if (!this._safeDefinition(definition)) return { ok: false, reason: 'H15_ITEM_DEFINITION_PROTECTED' };
      const progression = this._mutationGate(rows[0], request.kind, inventory, this._progressionPlan(inventory));
      if (!progression.ok) {
        this.metrics.progressionBlocks += 1;
        return { ok: false, reason: progression.reason };
      }
      const budget = this._budget(rows[0], definition, scroll,
        request.offeringSlot == null ? null : this._rowAt(inventory, request.offeringSlot),
        request.targetLevel, request.kind, request.kind === 'COMPOUND' ? 3 : 1);
      if (!budget.ok) return { ok: false, reason: budget.reason };
      const risk = this._mutationRiskDecision(request.kind, rows[0], definition, inventory, itemSlots, progression.evaluation, request.targetLevel);
      if (!risk.allowed) return { ok: false, reason: risk.reason, risk };
      return { ok: true, risk };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H15_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      if (this.riskPreview) {
        return this._observeRiskPreview();
      }

      const request = this.request;
      if (!request) return this.plan();
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { state: 'BLOCKED', reason: 'H15_INVENTORY_UNAVAILABLE' };
      const valid = this._revalidate(request, inventory);
      if (!valid.ok) {
        this.request = null;
        if (String(valid.reason || '').includes('BUDGET')) this.metrics.budgetBlocks += 1;
        else this.metrics.safetyBlocks += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_BLOCKED', reason: valid.reason };
        return { state: 'BLOCKED', reason: valid.reason };
      }
      if (this.gearProgression
          && this.actions
          && typeof this.actions.previewMutation === 'function'
          && !request.authoritativeRisk) {
        return this._beginAuthoritativeRiskPreview(request);
      }
      return this._dispatch(request, inventory);
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        attemptsThisSession: this.attemptsThisSession,
        attemptSession: {
          generation: this.attemptSessionGeneration,
          startedAt: this.attemptSessionStartedAt,
          reason: this.attemptSessionReason
        },
        pending: clone(this.pending),
        request: clone(this.request),
        riskPreview: clone(this.riskPreview),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        lastMutationRiskDecision: clone(this.lastMutationRiskDecision),
        riskHolds: Array.from(this.riskHolds.values())
          .filter(row => Number(row && row.untilMs || 0) > Date.now())
          .map(clone),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.UpgradeCompoundController = UpgradeCompoundController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
