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
