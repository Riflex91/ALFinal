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
      this.farmIntelligence = options.farmIntelligence || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        tickMs: Math.max(75, Math.min(1000, Number(options.tickMs) || 125)),
        attackOutcomeTimeoutMs: Math.max(750, Math.min(10000, Number(options.attackOutcomeTimeoutMs) || 3000)),
        targetConfirmTimeoutMs: Math.max(500, Math.min(10000, Number(options.targetConfirmTimeoutMs) || 2000)),
        retreatHpRatio: Math.max(0.05, Math.min(0.9, Number(options.retreatHpRatio) || 0.35)),
        resumeHpRatio: Math.max(0.1, Math.min(1, Number(options.resumeHpRatio) || 0.65)),
        minMpRatio: Math.max(0, Math.min(0.9, Number(options.minMpRatio) || 0.05)),
        preferredRangeRatio: Math.max(0.25, Math.min(0.95, Number(options.preferredRangeRatio) || 0.78)),
        kiteTriggerRatio: Math.max(0.05, Math.min(0.8, Number(options.kiteTriggerRatio) || 0.62)),
        kiteStep: Math.max(10, Math.min(120, Number(options.kiteStep) || 35)),
        kiteDesiredRangeRatio: Math.max(0.55, Math.min(0.90, Number(options.kiteDesiredRangeRatio) || 0.72)),
        kiteMaxRangeRatio: Math.max(0.65, Math.min(0.95, Number(options.kiteMaxRangeRatio) || 0.82)),
        kiteMonsterBuffer: Math.max(8, Math.min(80, Number(options.kiteMonsterBuffer) || 20)),
        kiteSpeedBufferSeconds: Math.max(0.2, Math.min(1.5, Number(options.kiteSpeedBufferSeconds) || 0.50)),
        kiteStepSeconds: Math.max(0.3, Math.min(1.2, Number(options.kiteStepSeconds) || 0.65)),
        groupHardKiteTether: Math.max(150, Math.min(350, Number(options.groupHardKiteTether) || 195)),
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
      this.orbitDirectionByCharacter = new Map();
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
        rejected: 0,
        kiteNoAggroHolds: 0,
        meleeKiteBypasses: 0,
        kiteOrbitMoves: 0,
        kiteTerrainBlocks: 0,
        kiteGroupTetherBlocks: 0
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
        leaderOwnedPulls: options.leaderOwnedPulls === true,
        groupLeaderName: cleanText(options.groupLeaderName || '', 120) || null,
        groupMemberNames: Array.isArray(options.groupMemberNames)
          ? [...new Set(options.groupMemberNames.map(value => cleanText(value, 120)).filter(Boolean))].sort()
          : [],
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
      if (state === 'UNKNOWN' && this.farmIntelligence && typeof this.farmIntelligence.suspendFromCombatUnknown === 'function') {
        try { this.farmIntelligence.suspendFromCombatUnknown(reason, details || null); } catch (_) {}
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
      const localName = game && game.character && game.character.name ? String(game.character.name) : '';
      const groupNames = new Set((this.session.policy.groupMemberNames || []).map(String));
      const followerMirrorOnly = this.session.policy.leaderOwnedPulls === true
        && this.session.policy.groupLeaderName
        && localName
        && localName !== String(this.session.policy.groupLeaderName);
      const preferred = preferredId == null
        ? null
        : candidates.find(candidate => String(candidate.id) === String(preferredId)) || null;
      const preferredSharedAggro = preferred && preferred.targetId && groupNames.has(String(preferred.targetId))
        ? preferred
        : null;
      const sharedAggro = candidates.find(candidate => candidate.targetId && groupNames.has(String(candidate.targetId))) || null;
      const target = followerMirrorOnly ? (preferredSharedAggro || sharedAggro) : (preferred || candidates[0]);
      if (!target) {
        this.session.state = 'WAITING_GROUP_TARGET';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: 'GROUP_FOLLOWER_WAIT',
          leaderName: this.session.policy.groupLeaderName,
          preferredTargetId: preferredId || null
        };
        return null;
      }
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

    _orbitDirection(character) {
      const name = String(character && character.name || 'local');
      if (this.orbitDirectionByCharacter.has(name)) return this.orbitDirectionByCharacter.get(name);
      let hash = 0;
      for (let index = 0; index < name.length; index += 1) hash = ((hash * 31) + name.charCodeAt(index)) | 0;
      const direction = (Math.abs(hash) % 2) ? 1 : -1;
      this.orbitDirectionByCharacter.set(name, direction);
      return direction;
    }

    _segmentSafe(a, b, target, minimumDistance, options = {}) {
      const ax = finite(a && a.x), ay = finite(a && a.y);
      const bx = finite(b && b.x), by = finite(b && b.y);
      const tx = finite(target && target.x), ty = finite(target && target.y);
      if ([ax, ay, bx, by, tx, ty].some(value => value == null)) return false;
      const startDistance = Math.hypot(ax - tx, ay - ty);
      let previousDistance = startDistance;
      const escapingFromInside = options.allowStartInside === true && startDistance < minimumDistance;
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const d = Math.hypot(x - tx, y - ty);
        if (escapingFromInside) {
          if (d <= previousDistance + 0.5) return false;
          previousDistance = d;
          continue;
        }
        if (d < minimumDistance) return false;
      }
      return escapingFromInside ? previousDistance > startDistance + 2 : true;
    }

    _groupTetherAllows(character, destination) {
      const policy = this.session && this.session.policy || {};
      if (policy.leaderOwnedPulls !== true || !Array.isArray(policy.groupMemberNames) || policy.groupMemberNames.length < 2) return true;
      let status = null;
      try { status = this.party && typeof this.party.status === 'function' ? this.party.status() : null; } catch (_) {}
      const party = status && status.party || null;
      const expectedNames = policy.groupMemberNames.map(String).filter(name => name !== String(character.name || ''));
      const members = party && Array.isArray(party.ownedMembers)
        ? party.ownedMembers.filter(row => row && expectedNames.includes(String(row.name)))
        : [];
      if (members.length !== expectedNames.length) return false;
      for (const name of expectedNames) {
        const row = members.find(member => String(member.name) === name);
        if (!row || finite(row.x) == null || finite(row.y) == null) return false;
        if (!row.map || !character.map || String(row.map) !== String(character.map)) return false;
      }
      const currentMax = Math.max(0, ...members.map(row => {
        const x = finite(row.x), y = finite(row.y);
        return Math.hypot(Number(character.x) - x, Number(character.y) - y);
      }));
      const proposedMax = Math.max(0, ...members.map(row => {
        if (row.map && character.map && String(row.map) !== String(character.map)) return Number.POSITIVE_INFINITY;
        const x = finite(row.x), y = finite(row.y);
        return x == null || y == null ? Number.POSITIVE_INFINITY : Math.hypot(Number(destination.x) - x, Number(destination.y) - y);
      }));
      if (proposedMax <= this.config.groupHardKiteTether) return true;
      return currentMax > this.config.groupHardKiteTether && proposedMax < currentMax;
    }

    _kiteWaypoint(character, target) {
      const range = finite(character && character.range);
      const cx = finite(character && character.x), cy = finite(character && character.y);
      const tx = finite(target && target.x), ty = finite(target && target.y);
      if ([range, cx, cy, tx, ty].some(value => value == null) || range < 60) return null;

      let definition = null;
      try { definition = this.game && this.game.monsterDefinition ? this.game.monsterDefinition(target.mtype) : null; } catch (_) {}
      const monsterRange = Math.max(0, finite(target.range) || finite(definition && definition.range) || 25);
      const monsterSpeed = Math.max(1, finite(target.speed) || finite(definition && definition.speed) || 40);
      const hardSafeDistance = monsterRange + this.config.kiteMonsterBuffer + monsterSpeed * this.config.kiteSpeedBufferSeconds;
      const maxRangeDistance = range * this.config.kiteMaxRangeRatio;
      if (hardSafeDistance + 8 >= maxRangeDistance) return null;

      const currentDistance = Math.hypot(cx - tx, cy - ty);
      const desiredDistance = Math.min(maxRangeDistance, Math.max(range * this.config.kiteDesiredRangeRatio, hardSafeDistance + 16));
      const speed = Math.max(1, finite(character.speed) || 40);
      const preferred = this._orbitDirection(character);
      const canMove = (x, y) => {
        try {
          const value = this.movement && typeof this.movement._canMoveTo === 'function' ? this.movement._canMoveTo(x, y) : null;
          return value !== false;
        } catch (_) { return false; }
      };
      const candidates = [];

      if (currentDistance < hardSafeDistance + 4) {
        const step = Math.max(8, Math.min(Math.max(1, desiredDistance - currentDistance), speed * this.config.kiteStepSeconds, Math.max(20, maxRangeDistance * 0.25)));
        const base = Math.atan2(cy - ty, cx - tx);
        for (const offsetDeg of [preferred * 12, preferred * 22, 0, -preferred * 12, -preferred * 22]) {
          const angle = base + offsetDeg * Math.PI / 180;
          const x = cx + Math.cos(angle) * step;
          const y = cy + Math.sin(angle) * step;
          const afterDistance = Math.hypot(x - tx, y - ty);
          if (!canMove(x, y) || afterDistance <= currentDistance + 2 || afterDistance > maxRangeDistance) continue;
          if (!this._segmentSafe(character, { x, y }, target, hardSafeDistance, { allowStartInside: true })) continue;
          candidates.push({ x, y, afterDistance, direction: offsetDeg === 0 ? preferred : Math.sign(offsetDeg), escape: true, score: Math.abs(desiredDistance - afterDistance) + Math.abs(offsetDeg) * 0.02 });
        }
      } else {
        const chordTarget = Math.max(10, Math.min(speed * this.config.kiteStepSeconds, range * 0.22));
        const ratioValue = Math.min(0.98, chordTarget / Math.max(1, 2 * desiredDistance));
        const baseDelta = Math.max(8 * Math.PI / 180, Math.min(28 * Math.PI / 180, 2 * Math.asin(ratioValue)));
        const currentAngle = Math.atan2(cy - ty, cx - tx);
        for (const direction of [preferred, -preferred]) {
          for (const scale of [1, 0.72, 0.48]) {
            const angle = currentAngle + baseDelta * scale * direction;
            for (const radius of [desiredDistance, Math.max(hardSafeDistance + 8, Math.min(maxRangeDistance, currentDistance))]) {
              const x = tx + Math.cos(angle) * radius;
              const y = ty + Math.sin(angle) * radius;
              if (!canMove(x, y)) continue;
              if (!this._segmentSafe(character, { x, y }, target, hardSafeDistance)) continue;
              const step = Math.hypot(x - cx, y - cy);
              if (step < 4) continue;
              candidates.push({
                x, y, afterDistance: Math.hypot(x - tx, y - ty), direction, escape: false,
                score: Math.abs(desiredDistance - Math.hypot(x - tx, y - ty)) + (direction === preferred ? 0 : 8) + Math.abs(1 - scale) * 4
              });
            }
          }
        }
      }

      candidates.sort((a, b) => a.score - b.score);
      for (const candidate of candidates) {
        if (!this._groupTetherAllows(character, candidate)) {
          this.metrics.kiteGroupTetherBlocks += 1;
          continue;
        }
        this.orbitDirectionByCharacter.set(String(character.name || 'local'), candidate.direction);
        return candidate;
      }
      return null;
    }

    _kite(game, target) {
      if (!this.session.policy.kiting) return false;
      const character = game && game.character;
      const ctype = String(character && character.ctype || '').toLowerCase();
      if (['warrior', 'paladin', 'rogue'].includes(ctype)) {
        this.metrics.meleeKiteBypasses += 1;
        return false;
      }
      if (!character || !target || String(target.targetId || '') !== String(character.name || '')) {
        this.metrics.kiteNoAggroHolds += 1;
        return false;
      }
      if (this._foreignMovementActive() || this._combatMovementActive()) return false;

      const waypoint = this._kiteWaypoint(character, target);
      if (!waypoint) {
        this.metrics.kiteTerrainBlocks += 1;
        return false;
      }
      const result = this.movement.moveLocal(waypoint.x, waypoint.y, {
        owner: 'combat-h5-kite',
        arrivalRadius: 8
      });
      if (result && result.accepted) {
        this.metrics.kites += 1;
        this.metrics.kiteOrbitMoves += 1;
        this.session.counters.kites += 1;
        this.session.state = 'KITING';
        this.session.lastDecision = {
          at: new Date().toISOString(),
          type: waypoint.escape ? 'KITE_ESCAPE' : 'KITE_ORBIT',
          targetId: target.id,
          destination: { x: waypoint.x, y: waypoint.y },
          afterDistance: waypoint.afterDistance,
          groupTether: this.session.policy.leaderOwnedPulls === true
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

      const localName = String(character.name || '');
      const groupNames = new Set((this.session.policy.groupMemberNames || []).map(String));
      const followerMirrorOnly = this.session.policy.leaderOwnedPulls === true
        && this.session.policy.groupLeaderName
        && localName !== String(this.session.policy.groupLeaderName);

      if (this.session.policy.partyAssist && this.party && typeof this.party.preferredTargetId === 'function') {
        const preferredId = this.party.preferredTargetId();
        if (preferredId != null && this.session.targetId != null && String(preferredId) !== String(this.session.targetId)) {
          const preferred = this.safeCandidates(this.session.policy)
            .find(candidate => String(candidate.id) === String(preferredId));
          const preferredAllowed = preferred && (!followerMirrorOnly
            || (preferred.targetId && groupNames.has(String(preferred.targetId))));
          if (preferredAllowed) {
            this._clearGameTarget('PARTY_FOCUS_RETARGET');
            this.session.state = 'ACQUIRING';
          }
        }
      }

      let target = this._freshTarget();
      if (target && followerMirrorOnly
        && !(target.targetId && groupNames.has(String(target.targetId)))) {
        this._clearGameTarget('GROUP_FOLLOWER_STALE_FOCUS');
        target = null;
        this.session.state = 'ACQUIRING';
      }
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

      if (this._kite(game, target)) {
        if (!readiness.cooldown && readiness.canAttack) this._beginAttack(target);
        return;
      }

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
