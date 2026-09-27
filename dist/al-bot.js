

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

  class LootInventoryController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.goals = options.goals || null;
      this.partyLogistics = options.partyLogistics || null;
      this.moduleActive = false;
      this.scope = null;
      this.pendingLoot = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        reserveFreeSlots: Math.max(1, Math.min(12, Number(options.reserveFreeSlots) || 2)),
        lootOutcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.lootOutcomeTimeoutMs) || 5000))
      };
      this.rules = {
        keepNames: new Set(),
        reserveNames: new Set(),
        sellNames: new Set(),
        bankNames: new Set(),
        exchangeNames: new Set()
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        lootDispatched: 0,
        lootConfirmed: 0,
        lootKnownRejected: 0,
        lootUnknown: 0,
        inventoryFullBlocks: 0,
        protectedItems: 0,
        reserveItems: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H10_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('loot-inventory-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H10_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pendingLoot = null;
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'STOP',
        reason: cleanText(reason, 240)
      };
      return { stopped: true };
    }

    resetSafety(reason = 'H10_EXPLICIT_RESET') {
      this.pendingLoot = null;
      this.suspendedReason = null;
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'RESET',
        reason: cleanText(reason, 240)
      };
      return this.status();
    }

    setRules(rules = {}) {
      for (const key of Object.keys(this.rules)) {
        if (!Array.isArray(rules[key])) continue;
        this.rules[key] = new Set(rules[key].map(value => cleanText(value, 160)).filter(Boolean));
      }
      return this.ruleSnapshot();
    }

    ruleSnapshot() {
      return Object.fromEntries(Object.entries(this.rules).map(([key, value]) => [key, [...value]]));
    }

    _activeGoalTargets() {
      const names = new Set();
      if (!this.goals || typeof this.goals.list !== 'function') return names;
      let rows = [];
      try { rows = this.goals.list() || []; } catch (_) {}
      for (const goal of rows) {
        if (!goal || !['ACTIVE', 'PAUSED'].includes(String(goal.status || 'ACTIVE'))) continue;
        if (String(goal.type || '').toUpperCase() !== 'COLLECT_ITEM') continue;
        const target = cleanText(goal.target || '', 160);
        if (target) names.add(target);
      }
      return names;
    }

    _classify(item, goalTargets) {
      const definition = item && item.definition || {};
      const name = cleanText(item && item.name || '', 160);
      const level = finite(item && item.level) || 0;
      const type = cleanText(definition.type || '', 80).toLowerCase();
      const explicit = [
        ['reserveNames', 'RESERVE', 'RULE_RESERVE'],
        ['keepNames', 'KEEP', 'RULE_KEEP'],
        ['exchangeNames', 'EXCHANGE', 'RULE_EXCHANGE'],
        ['bankNames', 'BANK', 'RULE_BANK'],
        ['sellNames', 'SELL', 'RULE_SELL']
      ];
      for (const [rule, disposition, reason] of explicit) {
        if (this.rules[rule].has(name)) return { disposition, reason, protected: disposition !== 'SELL' };
      }

      if (item.locked) return { disposition: 'PROTECT', reason: 'ITEM_LOCKED', protected: true };
      if (item.giveaway) return { disposition: 'PROTECT', reason: 'ITEM_GIVEAWAY', protected: true };
      if (item.expiresAt) return { disposition: 'PROTECT', reason: 'ITEM_EXPIRING', protected: true };
      if (level > 0) return { disposition: 'PROTECT', reason: 'LEVELED_ITEM', protected: true };
      if (goalTargets.has(name)) return { disposition: 'RESERVE', reason: 'ACTIVE_COLLECTION_GOAL', protected: true };
      if (type === 'quest' || definition.quest === true) {
        return { disposition: 'RESERVE', reason: 'QUEST_ITEM', protected: true };
      }

      const equipmentTypes = new Set([
        'weapon', 'shield', 'helmet', 'coat', 'pants', 'gloves', 'shoes',
        'cape', 'ring', 'earring', 'amulet', 'belt', 'orb', 'source', 'quiver'
      ]);
      if (equipmentTypes.has(type) || definition.upgrade || definition.compound) {
        return { disposition: 'PROTECT', reason: 'GEAR_OR_UPGRADE_ITEM', protected: true };
      }

      if (definition.e != null || definition.exchange === true) {
        return { disposition: 'EXCHANGE', reason: 'LIVE_ITEM_EXCHANGEABLE', protected: true };
      }

      if (['pot', 'elixir', 'food', 'scroll', 'booster'].includes(type)) {
        return { disposition: 'KEEP', reason: 'CONSUMABLE_OR_UTILITY', protected: true };
      }

      return { disposition: 'BANK', reason: 'SAFE_DEFAULT_UNKNOWN_VALUE', protected: true };
    }

    plan() {
      this.metrics.plans += 1;
      const inventory = this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : { available: false, reason: 'INVENTORY_ADAPTER_UNAVAILABLE', items: [] };
      const chests = this.game && typeof this.game.chestSnapshot === 'function'
        ? this.game.chestSnapshot()
        : { available: false, chests: [] };
      const goalTargets = this._activeGoalTargets();
      const items = (inventory.items || []).map(item => {
        const classification = this._classify(item, goalTargets);
        return { ...item, ...classification };
      });
      const counts = {};
      for (const row of items) counts[row.disposition] = (counts[row.disposition] || 0) + 1;
      this.metrics.protectedItems = items.filter(row => row.protected).length;
      this.metrics.reserveItems = items.filter(row => row.disposition === 'RESERVE').length;

      const freeSlots = finite(inventory.freeSlots);
      const lootable = (chests.chests || []).filter(chest => {
        const count = finite(chest.items);
        if (freeSlots == null || count == null) return false;
        return count <= Math.max(0, freeSlots - this.config.reserveFreeSlots);
      });
      const plan = {
        state: inventory.available === false ? 'BLOCKED' : 'READY',
        reason: inventory.available === false ? inventory.reason || 'INVENTORY_UNAVAILABLE' : 'H10_INVENTORY_READY',
        inventory: {
          capacity: inventory.capacity,
          usedSlots: inventory.usedSlots,
          freeSlots: inventory.freeSlots,
          reportedEmptySlots: inventory.reportedEmptySlots
        },
        items,
        counts,
        chests: clone(chests.chests || []),
        lootableChestIds: lootable.map(row => row.id),
        reserveFreeSlots: this.config.reserveFreeSlots
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _watchLoot(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        pending.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.pendingLoot || this.pendingLoot.id !== pending.id) return;
        this.pendingLoot.settlement = 'RESOLVED';
        this.pendingLoot.response = response == null ? null : clone(response);
      }, error => {
        if (!this.pendingLoot || this.pendingLoot.id !== pending.id) return;
        this.pendingLoot.settlement = 'REJECTED';
        this.pendingLoot.error = cleanText(error && error.message || error || 'H10_LOOT_REJECTED', 500);
      }).catch(() => {});
    }

    _observePendingLoot() {
      const pending = this.pendingLoot;
      if (!pending) return false;
      if (pending.settlement === 'PENDING') {
        const deadlineAtMs = finite(pending.deadlineAtMs);
        if (deadlineAtMs == null || Date.now() < deadlineAtMs) return false;
        this.pendingLoot = null;
        this.metrics.lootUnknown += 1;
        this.suspendedReason = 'H10_LOOT_OUTCOME_TIMEOUT';
        this.lastAction = {
          at: new Date().toISOString(),
          type: 'LOOT_UNKNOWN',
          reason: this.suspendedReason,
          chestId: pending.chestId
        };
        return true;
      }
      this.pendingLoot = null;

      if (pending.settlement === 'REJECTED') {
        this.metrics.lootUnknown += 1;
        this.suspendedReason = pending.error || 'H10_LOOT_UNKNOWN';
        this.lastAction = { at: new Date().toISOString(), type: 'LOOT_UNKNOWN', reason: this.suspendedReason };
        return true;
      }

      const response = pending.response;
      const responseReason = cleanText(response && response.reason || '', 240);
      if (response && response.failed === true) {
        this.metrics.lootKnownRejected += 1;
        this.lastAction = {
          at: new Date().toISOString(),
          type: 'LOOT_REJECTED',
          reason: responseReason || 'H10_LOOT_REJECTED'
        };
        return true;
      }
      if (response && (response.success === false || ['nothing_to_loot', 'safety'].includes(responseReason))) {
        this.metrics.lootKnownRejected += 1;
        this.lastAction = {
          at: new Date().toISOString(),
          type: 'LOOT_SKIPPED',
          reason: responseReason || 'H10_LOOT_SKIPPED'
        };
        return true;
      }

      this.metrics.lootConfirmed += 1;
      this.lastAction = { at: new Date().toISOString(), type: 'LOOT_CONFIRMED', chestId: pending.chestId };
      return true;
    }

    tick() {
      this.metrics.ticks += 1;
      this._observePendingLoot();
      const plan = this.plan();

      if (!this.moduleActive) return { state: 'IDLE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.pendingLoot) return { state: 'LOOT_PENDING', chestId: this.pendingLoot.chestId, plan };
      let logistics = null;
      try { logistics = this.partyLogistics && typeof this.partyLogistics.status === 'function' ? this.partyLogistics.status() : null; } catch (_) {}
      if (logistics && ((Array.isArray(logistics.queue) && logistics.queue.length)
          || logistics.currentAction && ['SUPPLY','GOLD','APPROACH'].includes(String(logistics.currentAction.kind || '')))) {
        return { state: 'WAITING', reason: 'H10_PARTY_LOGISTICS_OWNERSHIP', plan };
      }
      if (plan.state !== 'READY') return { state: plan.state, reason: plan.reason, plan };

      const freeSlots = finite(plan.inventory.freeSlots);
      if ((plan.chests || []).length && (freeSlots == null || freeSlots <= this.config.reserveFreeSlots)) {
        this.metrics.inventoryFullBlocks += 1;
        return { state: 'INVENTORY_PRESSURE', reason: 'H10_FREE_SLOT_RESERVE_REACHED', plan };
      }
      const chestId = plan.lootableChestIds[0];
      if (!chestId) return { state: 'READY', reason: 'H10_NOTHING_SAFE_TO_LOOT', plan };
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { state: 'BLOCKED', reason: 'H10_ACTION_BOUNDARY_UNAVAILABLE', plan };
      }

      const result = this.actions.dispatch('loot', [chestId]);
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          this.metrics.lootUnknown += 1;
          this.suspendedReason = result.error && result.error.message || 'H10_LOOT_UNKNOWN';
          return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
        }
        this.metrics.lootKnownRejected += 1;
        return { state: 'WAITING', reason: result && result.state || 'H10_LOOT_REJECTED', plan };
      }

      const dispatchedAtMs = Date.now();
      const pending = {
        id: 'loot-' + (++this.sequence),
        chestId: String(chestId),
        dispatchedAt: new Date(dispatchedAtMs).toISOString(),
        dispatchedAtMs,
        deadlineAtMs: dispatchedAtMs + this.config.lootOutcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pendingLoot = pending;
      this.metrics.lootDispatched += 1;
      this.lastAction = { at: pending.dispatchedAt, type: 'LOOT_DISPATCHED', chestId: pending.chestId };
      this._watchLoot(result.value, pending);
      return { state: 'LOOT_PENDING', chestId: pending.chestId, plan };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pendingLoot: clone(this.pendingLoot),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        rules: this.ruleSnapshot(),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.LootInventoryController = LootInventoryController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;
  const COMBAT_CLASSES = ns.helpers.COMBAT_CLASSES;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  const EQUIPMENT_TYPES = new Set([
    'weapon', 'shield', 'helmet', 'coat', 'pants', 'gloves', 'shoes',
    'cape', 'ring', 'earring', 'amulet', 'belt', 'orb', 'source', 'quiver'
  ]);

  class MerchantController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.roster = options.roster || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.partyLogistics = options.partyLogistics || null;
      this.moduleActive = false;
      this.scope = null;
      this.suspendedReason = null;
      this.pending = null;
      this.delivery = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.backoffUntilMs = null;
      this.sequence = 0;
      this.serviceTarget = null;
      this.serviceHistory = [];
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        transferRange: Math.max(80, Math.min(1000, Number(options.transferRange) || 320)),
        transferOutcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.transferOutcomeTimeoutMs) || 5000)),
        mluckOutcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.mluckOutcomeTimeoutMs) || 5000)),
        mluckRefreshMs: Math.max(5000, Math.min(10 * 60 * 1000, Number(options.mluckRefreshMs) || 30000)),
        pressureMarginSlots: Math.max(1, Math.min(12, Number(options.pressureMarginSlots) || 2)),
        merchantReserveSlots: Math.max(1, Math.min(12, Number(options.merchantReserveSlots) || 2)),
        serviceHoldMs: Math.max(1000, Math.min(60000, Number(options.serviceHoldMs) || 8000)),
        switchCooldownMs: Math.max(500, Math.min(60000, Number(options.switchCooldownMs) || 5000)),
        pingPongWindowMs: Math.max(2000, Math.min(120000, Number(options.pingPongWindowMs) || 30000)),
        rejectionBackoffMs: Math.max(500, Math.min(60000, Number(options.rejectionBackoffMs) || 4000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        pressureHigh: 0,
        pressureCritical: 0,
        handoffsPlanned: 0,
        transfersDispatched: 0,
        transfersConfirmed: 0,
        transfersRejected: 0,
        transfersUnknown: 0,
        mluckPlanned: 0,
        mluckDispatched: 0,
        mluckConfirmed: 0,
        mluckRejected: 0,
        mluckUnknown: 0,
        movementRequests: 0,
        movementBlocks: 0,
        ownershipBlocks: 0,
        foreignTargetBlocks: 0,
        pingPongBlocks: 0,
        switchCooldownBlocks: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H11_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('merchant-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H11_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.delivery = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'merchant-h11') {
          this.movement.cancel(cleanText(reason, 180) || 'H11_MODULE_STOP');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H11_EXPLICIT_RESET') {
      this.pending = null;
      this.suspendedReason = null;
      this.backoffUntilMs = null;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _roster() {
      try {
        return this.roster && typeof this.roster.status === 'function' ? this.roster.status() : null;
      } catch (_) {
        return null;
      }
    }

    _role() {
      const snap = this._snapshot();
      const ctype = cleanText(snap && snap.character && snap.character.ctype || '', 60).toLowerCase();
      if (ctype === 'merchant') return 'MERCHANT';
      if (COMBAT_CLASSES && COMBAT_CLASSES.has(ctype)) return 'FARMER';
      return ctype ? 'OBSERVER' : 'UNAVAILABLE';
    }

    _ownedNames() {
      const roster = this._roster();
      return new Set((roster && roster.characters || []).map(row => cleanText(row && row.name || '', 120)).filter(Boolean));
    }

    _owned(name) {
      const wanted = cleanText(name || '', 120);
      if (!wanted) return false;
      return this._ownedNames().has(wanted);
    }

    _ownedFarmerNames() {
      const roster = this._roster();
      return new Set((roster && roster.farmers || []).map(row => cleanText(row && row.name || '', 120)).filter(Boolean));
    }

    _merchantName() {
      const roster = this._roster();
      return cleanText(roster && roster.merchant && roster.merchant.name || '', 120) || null;
    }

    _visibleOwnedPlayers() {
      const owned = this._ownedNames();
      const visible = this.game && typeof this.game.visiblePlayers === 'function'
        ? this.game.visiblePlayers({})
        : [];
      return (visible || []).filter(row => row && row.name && owned.has(String(row.name)));
    }

    _visibleOwnedFarmers() {
      const farmers = this._ownedFarmerNames();
      return this._visibleOwnedPlayers().filter(row => farmers.has(String(row.name)));
    }

    _inventoryPlan() {
      try {
        if (this.inventory && typeof this.inventory.plan === 'function') return this.inventory.plan();
      } catch (_) {}
      const snapshot = this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : null;
      return snapshot ? {
        state: snapshot.available === false ? 'BLOCKED' : 'READY',
        reason: snapshot.reason || null,
        inventory: snapshot,
        items: snapshot.items || [],
        reserveFreeSlots: 2
      } : null;
    }

    _pressure(plan, role) {
      const slots = plan && plan.inventory || {};
      const free = finite(slots.freeSlots);
      const reserve = role === 'MERCHANT'
        ? this.config.merchantReserveSlots
        : Math.max(1, finite(plan && plan.reserveFreeSlots) || 2);
      if (free == null) return { state: 'UNKNOWN', freeSlots: null, reserveFreeSlots: reserve };
      if (free <= reserve) return { state: 'CRITICAL', freeSlots: free, reserveFreeSlots: reserve };
      if (free <= reserve + this.config.pressureMarginSlots) {
        return { state: 'HIGH', freeSlots: free, reserveFreeSlots: reserve };
      }
      return { state: 'NORMAL', freeSlots: free, reserveFreeSlots: reserve };
    }

    _transferSafe(row, options = {}) {
      if (!row || !row.name) return false;
      if (row.locked || row.giveaway || row.gift || row.expiresAt) return false;
      if ((finite(row.level) || 0) > 0) return false;
      const definition = row.definition || {};
      const type = cleanText(definition.type || '', 80).toLowerCase();
      if (definition.quest === true || definition.upgrade === true || definition.compound === true) return false;
      if (EQUIPMENT_TYPES.has(type)) return false;
      const disposition = cleanText(row.disposition || '', 40).toUpperCase();
      if (disposition === 'BANK' || disposition === 'EXCHANGE') return true;
      if (options.allowUtility === true && disposition === 'KEEP'
        && ['pot', 'elixir', 'food', 'scroll', 'booster'].includes(type)) return true;
      return false;
    }

    _handoffCandidates(plan, options = {}) {
      return (plan && plan.items || [])
        .filter(row => this._transferSafe(row, options))
        .sort((a, b) => {
          const ad = String(a.disposition || '') === 'BANK' ? 0 : String(a.disposition || '') === 'EXCHANGE' ? 1 : 2;
          const bd = String(b.disposition || '') === 'BANK' ? 0 : String(b.disposition || '') === 'EXCHANGE' ? 1 : 2;
          if (ad !== bd) return ad - bd;
          return Number(a.slot || 0) - Number(b.slot || 0);
        });
    }

    _findVisible(name) {
      const wanted = cleanText(name || '', 120);
      return this._visibleOwnedPlayers().find(row => String(row.name) === wanted) || null;
    }

    _trimServiceHistory(now = Date.now()) {
      const cutoff = now - this.config.pingPongWindowMs;
      this.serviceHistory = this.serviceHistory.filter(row => row.atMs >= cutoff).slice(-12);
    }

    _claimTarget(name, purpose) {
      const wanted = cleanText(name || '', 120);
      if (!wanted) return { ok: false, reason: 'H11_TARGET_REQUIRED' };
      const now = Date.now();
      this._trimServiceHistory(now);
      const current = this.serviceTarget;
      if (current && current.name === wanted) {
        return { ok: true, target: clone(current), changed: false };
      }
      if (current && now - current.switchedAtMs < this.config.switchCooldownMs) {
        this.metrics.switchCooldownBlocks += 1;
        return { ok: false, reason: 'H11_SERVICE_SWITCH_COOLDOWN', current: clone(current) };
      }
      const previous = this.serviceHistory[this.serviceHistory.length - 1] || null;
      const olderSame = this.serviceHistory.slice(0, -1).reverse().find(row => row.name === wanted);
      if (previous && previous.name !== wanted && olderSame && now - olderSame.atMs < this.config.pingPongWindowMs) {
        this.metrics.pingPongBlocks += 1;
        return { ok: false, reason: 'H11_SERVICE_PINGPONG_BLOCKED', previous: previous.name };
      }
      this.serviceTarget = {
        name: wanted,
        purpose: cleanText(purpose || 'SERVICE', 80),
        sinceMs: now,
        switchedAtMs: now
      };
      this.serviceHistory.push({ name: wanted, purpose: this.serviceTarget.purpose, atMs: now });
      this._trimServiceHistory(now);
      return { ok: true, target: clone(this.serviceTarget), changed: true };
    }

    _releaseTarget(reason = 'H11_SERVICE_RELEASE') {
      if (!this.serviceTarget) return;
      this.lastAction = {
        at: nowIso(),
        type: 'SERVICE_RELEASE',
        target: this.serviceTarget.name,
        reason: cleanText(reason, 180)
      };
      this.serviceTarget = null;
    }

    _approach(target) {
      if (!target || target.distance == null || target.distance <= this.config.transferRange) {
        return { ready: true, reason: 'H11_TARGET_IN_RANGE' };
      }
      if (!this.movement || typeof this.movement.status !== 'function') {
        return { ready: false, reason: 'H11_MOVEMENT_UNAVAILABLE' };
      }
      const status = this.movement.status();
      if (status.activeOrder) {
        if (String(status.activeOrder.owner || '') === 'merchant-h11') {
          return { ready: false, reason: 'H11_SERVICE_TRAVEL_ACTIVE', order: status.activeOrder };
        }
        this.metrics.movementBlocks += 1;
        return { ready: false, reason: 'H11_MOVEMENT_BUSY' };
      }
      if (finite(target.x) == null || finite(target.y) == null) {
        return { ready: false, reason: 'H11_TARGET_POSITION_UNAVAILABLE' };
      }
      let result = null;
      try {
        result = this.movement.moveLocal(target.x, target.y, {
          owner: 'merchant-h11',
          arrivalRadius: Math.min(90, Math.max(30, this.config.transferRange * 0.35))
        });
        if (!result || result.accepted !== true) {
          result = this.movement.smartMove({ map: target.map, x: target.x, y: target.y }, {
            owner: 'merchant-h11',
            arrivalRadius: Math.min(90, Math.max(30, this.config.transferRange * 0.35))
          });
        }
      } catch (error) {
        result = { accepted: false, reason: cleanText(error && error.message || error, 240) };
      }
      if (result && result.accepted) this.metrics.movementRequests += 1;
      else this.metrics.movementBlocks += 1;
      return {
        ready: false,
        reason: result && result.accepted ? 'H11_SERVICE_TRAVEL_STARTED' : (result && result.reason || 'H11_SERVICE_TRAVEL_REJECTED'),
        movement: clone(result)
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
        pending.error = cleanText(error && error.message || error || 'H11_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _suspendUnknown(kind, reason) {
      this.pending = null;
      this.suspendedReason = cleanText(reason || 'H11_UNKNOWN', 500) || 'H11_UNKNOWN';
      if (kind === 'MLUCK') this.metrics.mluckUnknown += 1;
      else this.metrics.transfersUnknown += 1;
      this.lastAction = { at: nowIso(), type: kind + '_UNKNOWN', reason: this.suspendedReason };
      return true;
    }

    _transferObserved(pending) {
      const snapshot = this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : null;
      if (!snapshot || snapshot.available === false) return false;
      const items = snapshot.items || [];
      const row = items.find(item => Number(item.slot) === Number(pending.slot));
      if (!row || String(row.name || '') !== String(pending.itemName || '')) return true;
      const after = finite(row.quantity) || 0;
      return pending.beforeQuantity - after >= pending.quantity;
    }

    _mluckObserved(pending) {
      if (!this.game || typeof this.game.playerCondition !== 'function') return false;
      const condition = this.game.playerCondition(pending.targetName, 'mluck');
      if (!condition || !condition.active) return false;

      const before = pending.beforeCondition || null;
      if (!before || before.active !== true) return true;

      const beforeRemaining = finite(before.remainingMs);
      const afterRemaining = finite(condition.remainingMs);
      if (beforeRemaining != null && afterRemaining != null && afterRemaining > beforeRemaining + 1000) return true;

      const beforeSource = cleanText(before.source || '', 120);
      const afterSource = cleanText(condition.source || '', 120);
      if (beforeSource && afterSource && beforeSource !== afterSource) return true;

      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      const now = Date.now();

      if (pending.settlement === 'REJECTED') {
        return this._suspendUnknown(pending.kind, pending.error || 'H11_ACTION_REJECTED');
      }

      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.backoffUntilMs = now + this.config.rejectionBackoffMs;
        if (pending.kind === 'MLUCK') this.metrics.mluckRejected += 1;
        else this.metrics.transfersRejected += 1;
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H11_ACTION_REJECTED', 240)
        };
        return true;
      }

      const confirmed = pending.kind === 'MLUCK'
        ? this._mluckObserved(pending)
        : this._transferObserved(pending);
      if (confirmed) {
        this.pending = null;
        if (pending.kind === 'MLUCK') this.metrics.mluckConfirmed += 1;
        else this.metrics.transfersConfirmed += 1;
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_CONFIRMED',
          target: pending.targetName,
          itemName: pending.itemName || null,
          quantity: pending.quantity || null
        };
        if (pending.kind === 'DELIVERY') this.delivery = null;
        return true;
      }

      if (now >= pending.deadlineAtMs) {
        const reason = pending.kind === 'MLUCK' ? 'H11_MLUCK_UNVERIFIED_TIMEOUT' : 'H11_TRANSFER_UNVERIFIED_TIMEOUT';
        return this._suspendUnknown(pending.kind, reason);
      }
      return false;
    }

    _dispatchTransfer(kind, targetName, row, quantity) {
      const target = cleanText(targetName || '', 120);
      if (!this._owned(target)) {
        this.metrics.foreignTargetBlocks += 1;
        return { accepted: false, reason: 'H11_FOREIGN_TARGET_BLOCKED' };
      }
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H11_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      const sendQuantity = Math.max(1, Math.min(Math.floor(Number(quantity) || 1), Math.floor(Number(row.quantity) || 1)));
      let result;
      try {
        result = this.actions.dispatch('send_item', [target, Number(row.slot), sendQuantity]);
      } catch (error) {
        return { accepted: false, reason: cleanText(error && error.message || error, 300) };
      }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          this._suspendUnknown(kind, result.error && result.error.message || 'H11_TRANSFER_DISPATCH_UNKNOWN');
          return { accepted: false, reason: this.suspendedReason };
        }
        this.metrics.transfersRejected += 1;
        return { accepted: false, reason: result && result.state || 'H11_TRANSFER_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'merchant-' + (++this.sequence),
        kind,
        targetName: target,
        slot: Number(row.slot),
        itemName: String(row.name),
        quantity: sendQuantity,
        beforeQuantity: Math.floor(Number(row.quantity) || 1),
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.transferOutcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this.metrics.transfersDispatched += 1;
      this.lastAction = {
        at: pending.dispatchedAt,
        type: kind + '_DISPATCHED',
        target,
        itemName: pending.itemName,
        quantity: sendQuantity
      };
      this._watch(result.value, pending);
      return { accepted: true, pending: clone(pending) };
    }

    _dispatchMluck(target) {
      if (!target || !target.name) return { accepted: false, reason: 'H11_MLUCK_TARGET_UNAVAILABLE' };
      const claim = this._claimTarget(target.name, 'MLUCK');
      if (!claim.ok) return { accepted: false, reason: claim.reason };
      const condition = this.game && typeof this.game.playerCondition === 'function'
        ? this.game.playerCondition(target.name, 'mluck')
        : null;
      if (condition && condition.active
        && (condition.remainingMs == null || condition.remainingMs > this.config.mluckRefreshMs)) {
        return { accepted: false, reason: 'H11_MLUCK_ALREADY_HEALTHY' };
      }
      const readiness = this.game && typeof this.game.skillReadiness === 'function'
        ? this.game.skillReadiness('mluck', target.name)
        : null;
      if (!readiness || readiness.available === false) return { accepted: false, reason: 'H11_MLUCK_UNAVAILABLE' };
      if (!readiness.allowed) return { accepted: false, reason: (readiness.reasons || []).join('|') || 'H11_MLUCK_NOT_READY' };
      let result;
      try {
        result = this.actions.dispatch('use_skill', ['mluck', target.name]);
      } catch (error) {
        return { accepted: false, reason: cleanText(error && error.message || error, 300) };
      }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          this._suspendUnknown('MLUCK', result.error && result.error.message || 'H11_MLUCK_DISPATCH_UNKNOWN');
          return { accepted: false, reason: this.suspendedReason };
        }
        this.metrics.mluckRejected += 1;
        return { accepted: false, reason: result && result.state || 'H11_MLUCK_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'merchant-' + (++this.sequence),
        kind: 'MLUCK',
        targetName: target.name,
        beforeCondition: condition ? clone(condition) : null,
        itemName: null,
        quantity: null,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.mluckOutcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this.metrics.mluckDispatched += 1;
      this.lastAction = { at: pending.dispatchedAt, type: 'MLUCK_DISPATCHED', target: target.name };
      this._watch(result.value, pending);
      return { accepted: true, pending: clone(pending) };
    }

    queueDelivery(targetName, itemName, quantity = 1) {
      const role = this._role();
      if (role !== 'MERCHANT') return { accepted: false, reason: 'H11_DELIVERY_REQUIRES_LOCAL_MERCHANT' };
      const target = cleanText(targetName || '', 120);
      if (!this._ownedFarmerNames().has(target)) {
        this.metrics.foreignTargetBlocks += 1;
        return { accepted: false, reason: 'H11_DELIVERY_TARGET_NOT_OWNED_FARMER' };
      }
      const name = cleanText(itemName || '', 160);
      const wanted = Math.max(1, Math.floor(Number(quantity) || 1));
      if (!name) return { accepted: false, reason: 'H11_DELIVERY_ITEM_REQUIRED' };
      const itemPlan = this._inventoryPlan();
      const row = (itemPlan && itemPlan.items || []).find(item =>
        String(item.name || '') === name && this._transferSafe(item, { allowUtility: true }));
      if (!row) return { accepted: false, reason: 'H11_DELIVERY_ITEM_NOT_SAFE_OR_AVAILABLE' };
      if ((Math.floor(Number(row.quantity) || 0)) < wanted) {
        return { accepted: false, reason: 'H11_DELIVERY_QUANTITY_UNAVAILABLE' };
      }
      this.delivery = {
        id: 'delivery-' + (++this.sequence),
        targetName: target,
        itemName: name,
        quantity: wanted,
        createdAt: nowIso(),
        createdAtMs: Date.now()
      };
      return { accepted: true, delivery: clone(this.delivery) };
    }

    cancelDelivery(reason = 'H11_DELIVERY_CANCELLED') {
      if (!this.delivery) return { cancelled: false, reason: 'H11_NO_DELIVERY' };
      const delivery = this.delivery;
      this.delivery = null;
      this.lastAction = {
        at: nowIso(),
        type: 'DELIVERY_CANCELLED',
        target: delivery.targetName,
        reason: cleanText(reason, 180)
      };
      return { cancelled: true, delivery: clone(delivery) };
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const role = this._role();
      const plan = this._inventoryPlan();
      const pressure = this._pressure(plan, role);
      const visibleOwned = this._visibleOwnedPlayers();
      const visibleFarmers = this._visibleOwnedFarmers();
      const merchantName = this._merchantName();
      const localName = cleanText(snap && snap.character && snap.character.name || '', 120) || null;
      const candidates = this._handoffCandidates(plan, { allowUtility: role === 'MERCHANT' });
      let service = { type: 'IDLE', reason: 'H11_NO_SERVICE_NEEDED' };

      if (!snap || !snap.available || !snap.character) {
        service = { type: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE' };
      } else if (role === 'FARMER') {
        if (pressure.state === 'CRITICAL' || pressure.state === 'HIGH') {
          const merchant = merchantName && visibleOwned.find(row => String(row.name) === merchantName);
          if (!merchantName) service = { type: 'BLOCKED', reason: 'H11_OWN_MERCHANT_UNAVAILABLE' };
          else if (!merchant) service = { type: 'WAIT', reason: 'H11_OWN_MERCHANT_NOT_VISIBLE', targetName: merchantName };
          else if (!candidates.length) service = { type: 'BLOCKED', reason: 'H11_NO_SAFE_HANDOFF_ITEM', targetName: merchantName };
          else service = {
            type: 'HANDOFF',
            reason: 'H11_INVENTORY_PRESSURE_HANDOFF',
            targetName: merchantName,
            target: merchant,
            item: candidates[0]
          };
        }
      } else if (role === 'MERCHANT') {
        if (this.delivery) {
          const target = visibleFarmers.find(row => String(row.name) === String(this.delivery.targetName));
          service = {
            type: 'DELIVERY',
            reason: target ? 'H11_EXPLICIT_DELIVERY' : 'H11_DELIVERY_TARGET_NOT_VISIBLE',
            targetName: this.delivery.targetName,
            target: target || null,
            delivery: clone(this.delivery)
          };
        } else {
          const needsMluck = visibleFarmers.filter(row => {
            const condition = this.game && typeof this.game.playerCondition === 'function'
              ? this.game.playerCondition(row.name, 'mluck')
              : null;
            return !(condition && condition.active
              && (condition.remainingMs == null || condition.remainingMs > this.config.mluckRefreshMs));
          });
          if (needsMluck.length) {
            needsMluck.sort((a, b) => {
              const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
              const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
              return ad - bd;
            });
            service = {
              type: 'MLUCK',
              reason: 'H11_MLUCK_REFRESH_NEEDED',
              targetName: needsMluck[0].name,
              target: needsMluck[0]
            };
          }
        }
      } else {
        service = { type: 'OBSERVER', reason: 'H11_ROLE_NOT_SERVICE_CAPABLE' };
      }

      const output = {
        state: this.suspendedReason ? 'SUSPENDED' : 'READY',
        reason: this.suspendedReason || 'H11_PLAN_READY',
        localName,
        role,
        pressure,
        merchantName,
        visibleOwnedPlayers: visibleOwned.map(row => ({
          name: row.name, ctype: row.ctype, map: row.map, distance: row.distance
        })),
        visibleOwnedFarmers: visibleFarmers.map(row => ({
          name: row.name, ctype: row.ctype, map: row.map, distance: row.distance
        })),
        handoffCandidates: candidates.map(row => ({
          slot: row.slot,
          name: row.name,
          quantity: row.quantity,
          disposition: row.disposition,
          reason: row.reason
        })),
        delivery: clone(this.delivery),
        service
      };
      this.lastPlan = clone(output);
      return clone(output);
    }

    tick() {
      this.metrics.ticks += 1;
      this._observePending();
      const plan = this.plan();

      if (!this.moduleActive) return { state: 'IDLE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.pending) return { state: 'PENDING', pending: clone(this.pending), plan };
      if (this.backoffUntilMs && Date.now() < this.backoffUntilMs) {
        return { state: 'BACKOFF', untilMs: this.backoffUntilMs, plan };
      }
      let logistics = null;
      try { logistics = this.partyLogistics && typeof this.partyLogistics.status === 'function' ? this.partyLogistics.status() : null; } catch (_) {}
      if (logistics && (logistics.autonomyEnabled || logistics.currentAction
          || Array.isArray(logistics.queue) && logistics.queue.length)) {
        this.metrics.ownershipBlocks += 1;
        return { state: 'WAITING', reason: 'H11_PARTY_LOGISTICS_OWNERSHIP', plan };
      }

      if (plan.pressure.state === 'CRITICAL') this.metrics.pressureCritical += 1;
      else if (plan.pressure.state === 'HIGH') this.metrics.pressureHigh += 1;

      const service = plan.service || {};
      if (service.type === 'HANDOFF') {
        this.metrics.handoffsPlanned += 1;
        const claim = this._claimTarget(service.targetName, 'HANDOFF');
        if (!claim.ok) return { state: 'WAITING', reason: claim.reason, plan };
        const approach = this._approach(service.target);
        if (!approach.ready) return { state: 'WAITING', reason: approach.reason, movement: approach.movement || null, plan };
        return { state: 'DISPATCHED', result: this._dispatchTransfer('HANDOFF', service.targetName, service.item, service.item.quantity), plan };
      }

      if (service.type === 'DELIVERY') {
        if (!service.target) return { state: 'WAITING', reason: service.reason, plan };
        const claim = this._claimTarget(service.targetName, 'DELIVERY');
        if (!claim.ok) return { state: 'WAITING', reason: claim.reason, plan };
        const approach = this._approach(service.target);
        if (!approach.ready) return { state: 'WAITING', reason: approach.reason, movement: approach.movement || null, plan };
        const itemPlan = this._inventoryPlan();
        const row = (itemPlan && itemPlan.items || []).find(item =>
          String(item.name || '') === String(service.delivery.itemName || '')
          && this._transferSafe(item, { allowUtility: true }));
        if (!row) return { state: 'BLOCKED', reason: 'H11_DELIVERY_ITEM_NOT_SAFE_OR_AVAILABLE', plan };
        const quantity = Math.min(service.delivery.quantity, Math.floor(Number(row.quantity) || 0));
        if (quantity < 1) return { state: 'BLOCKED', reason: 'H11_DELIVERY_QUANTITY_UNAVAILABLE', plan };
        return { state: 'DISPATCHED', result: this._dispatchTransfer('DELIVERY', service.targetName, row, quantity), plan };
      }

      if (service.type === 'MLUCK') {
        this.metrics.mluckPlanned += 1;
        const approach = this._approach(service.target);
        if (!approach.ready) return { state: 'WAITING', reason: approach.reason, movement: approach.movement || null, plan };
        const result = this._dispatchMluck(service.target);
        return { state: result.accepted ? 'DISPATCHED' : 'WAITING', reason: result.reason || null, result, plan };
      }

      if (service.type === 'BLOCKED') return { state: 'BLOCKED', reason: service.reason, plan };
      if (service.type === 'WAIT') return { state: 'WAITING', reason: service.reason, plan };
      return { state: 'READY', reason: service.reason || 'H11_NO_SERVICE_NEEDED', plan };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        delivery: clone(this.delivery),
        serviceTarget: clone(this.serviceTarget),
        serviceHistory: clone(this.serviceHistory.slice(-8)),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        backoffUntilMs: this.backoffUntilMs,
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.MerchantController = MerchantController;
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

  function nowIso() {
    return new Date().toISOString();
  }

  function stableProperty(value) {
    if (value == null) return '';
    try { return JSON.stringify(value, Object.keys(value).sort()); }
    catch (_) { return String(value); }
  }

  class BankController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.moduleActive = false;
      this.scope = null;
      this.suspendedReason = null;
      this.pending = null;
      this.request = null;
      this.sequence = 0;
      this.lastPlan = null;
      this.lastAction = null;
      this.reservations = {};
      this.workspace = { preferredPack: null };
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 6000)),
        bankMountTimeoutMs: Math.max(3000, Math.min(120000, Number(options.bankMountTimeoutMs) || 45000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        searches: 0,
        movementRequests: 0,
        movementUnknown: 0,
        depositsDispatched: 0,
        depositsConfirmed: 0,
        depositsRejected: 0,
        depositsUnknown: 0,
        withdrawalsDispatched: 0,
        withdrawalsConfirmed: 0,
        withdrawalsRejected: 0,
        withdrawalsUnknown: 0,
        goldDepositsDispatched: 0,
        goldDepositsConfirmed: 0,
        goldDepositsRejected: 0,
        goldDepositsUnknown: 0,
        goldWithdrawalsDispatched: 0,
        goldWithdrawalsConfirmed: 0,
        goldWithdrawalsRejected: 0,
        goldWithdrawalsUnknown: 0,
        reconciliations: 0,
        reconciliationFailures: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H12_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('bank-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H12_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
          this.movement.cancel(cleanText(reason, 180) || 'H12_MODULE_STOP');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H12_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
          this.movement.cancel(cleanText(reason, 180) || 'H12_EXPLICIT_RESET');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H12_REQUEST_CANCELLED') {
      this.request = null;
      this.pending = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
          this.movement.cancel(cleanText(reason, 180) || 'H12_REQUEST_CANCELLED');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    setReservations(reservations = {}) {
      const next = {};
      if (reservations && typeof reservations === 'object') {
        for (const [name, raw] of Object.entries(reservations)) {
          const itemName = cleanText(name, 160);
          const quantity = Math.max(0, Math.floor(Number(raw) || 0));
          if (itemName && quantity > 0) next[itemName] = quantity;
        }
      }
      this.reservations = next;
      return clone(this.reservations);
    }

    setWorkspace(options = {}) {
      const preferredPack = cleanText(options && options.preferredPack || '', 120) || null;
      this.workspace = { preferredPack };
      return clone(this.workspace);
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _inventoryPlan() {
      try {
        if (this.inventory && typeof this.inventory.plan === 'function') return this.inventory.plan();
      } catch (_) {}
      return null;
    }

    _inventorySnapshot() {
      try {
        if (this.game && typeof this.game.inventorySnapshot === 'function') return this.game.inventorySnapshot();
      } catch (_) {}
      return null;
    }

    _bankSnapshot() {
      try {
        if (this.game && typeof this.game.bankSnapshot === 'function') return this.game.bankSnapshot();
      } catch (_) {}
      return null;
    }

    _localMerchant() {
      const snap = this._snapshot();
      return !!(snap && snap.available && snap.character
        && String(snap.character.ctype || '').toLowerCase() === 'merchant'
        && snap.character.rip !== true);
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return [
        String(row.name),
        String(Math.max(0, Number(row.level) || 0)),
        cleanText(row.statType || '', 80),
        stableProperty(row.property)
      ].join('|');
    }

    _quantityInInventory(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _quantityInBank(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.packs || []).reduce((sum, pack) =>
        sum + (pack.items || []).reduce((inner, row) =>
          inner + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0), 0);
    }

    _bankItem(snapshot, packName, slot) {
      if (!snapshot || snapshot.available === false) return null;
      const pack = (snapshot.packs || []).find(row => String(row.name) === String(packName));
      return pack && (pack.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _inventoryItem(snapshot, slot) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _safeDepositRows() {
      const plan = this._inventoryPlan();
      if (!plan || plan.state !== 'READY') return [];
      return (plan.items || []).filter(row =>
        row && row.name
        && String(row.disposition || '').toUpperCase() === 'BANK'
        && row.locked !== true
        && row.giveaway !== true
        && row.gift !== true
        && !row.expiresAt
        && Math.max(0, Number(row.level) || 0) === 0
        && !(row.definition && (row.definition.quest === true || row.definition.upgrade === true || row.definition.compound === true))
      );
    }

    _ledger(inventory, bank) {
      const rows = new Map();
      const add = (row, location) => {
        const fingerprint = this._fingerprint(row);
        if (!fingerprint) return;
        if (!rows.has(fingerprint)) rows.set(fingerprint, {
          fingerprint,
          name: row.name,
          level: Math.max(0, Number(row.level) || 0),
          inventoryQuantity: 0,
          bankQuantity: 0,
          locations: []
        });
        const entry = rows.get(fingerprint);
        const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
        if (location.kind === 'inventory') entry.inventoryQuantity += quantity;
        else entry.bankQuantity += quantity;
        entry.locations.push({ ...location, quantity });
      };
      if (inventory && inventory.available !== false) {
        for (const row of inventory.items || []) add(row, { kind: 'inventory', slot: row.slot });
      }
      if (bank && bank.available !== false) {
        for (const pack of bank.packs || []) {
          for (const row of pack.items || []) add(row, { kind: 'bank', pack: pack.name, slot: row.slot });
        }
      }
      return [...rows.values()];
    }

    reconcile() {
      const inventory = this._inventorySnapshot();
      const bank = this._bankSnapshot();
      this.metrics.reconciliations += 1;
      const available = !!(inventory && inventory.available !== false && bank && bank.available !== false);
      if (!available) this.metrics.reconciliationFailures += 1;
      return {
        available,
        reason: !inventory || inventory.available === false
          ? 'H12_INVENTORY_UNAVAILABLE'
          : !bank || bank.available === false
            ? 'H12_BANK_NOT_MOUNTED'
            : null,
        inventory: clone(inventory),
        bank: clone(bank),
        ledger: available ? this._ledger(inventory, bank) : []
      };
    }

    search(itemName) {
      const wanted = cleanText(itemName || '', 160);
      this.metrics.searches += 1;
      const bank = this._bankSnapshot();
      if (!wanted || !bank || bank.available === false) return [];
      const out = [];
      for (const pack of bank.packs || []) {
        for (const row of pack.items || []) {
          if (String(row.name) === wanted) out.push(clone(row));
        }
      }
      return out;
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const bank = this._bankSnapshot();
      const inventory = this._inventorySnapshot();
      const safeDepositRows = this._safeDepositRows();
      const packs = bank && bank.available !== false ? bank.packs || [] : [];
      const plan = {
        state: !snap || !snap.available || !snap.character
          ? 'BLOCKED'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'BLOCKED'
            : bank && bank.available !== false
              ? 'READY'
              : 'NEEDS_BANK',
        reason: !snap || !snap.available || !snap.character
          ? 'CHARACTER_UNAVAILABLE'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'H12_REQUIRES_MERCHANT'
            : bank && bank.available !== false
              ? 'H12_BANK_READY'
              : 'H12_BANK_NOT_MOUNTED',
        character: snap && snap.character ? {
          name: snap.character.name,
          ctype: snap.character.ctype,
          map: snap.character.map
        } : null,
        bank: bank ? {
          available: bank.available,
          reason: bank.reason,
          map: bank.map,
          gold: bank.gold,
          capacity: bank.capacity,
          usedSlots: bank.usedSlots,
          freeSlots: bank.freeSlots
        } : null,
        packs: clone(packs),
        safeDepositRows: clone(safeDepositRows),
        reservations: clone(this.reservations),
        workspace: clone(this.workspace),
        reconciliation: inventory && inventory.available !== false && bank && bank.available !== false
          ? this._ledger(inventory, bank)
          : []
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _workspaceSlot(bank, preferredPack) {
      if (!bank || bank.available === false) return null;
      const wanted = cleanText(preferredPack || this.workspace.preferredPack || '', 120);
      let packs = (bank.packs || []).slice();
      if (wanted) packs = packs.sort((a, b) => (String(a.name) === wanted ? -1 : String(b.name) === wanted ? 1 : 0));
      for (const pack of packs) {
        if (!bank.map || !pack.map || String(pack.map) !== String(bank.map)) continue;
        const occupied = new Set((pack.items || []).map(row => Number(row.slot)));
        const capacity = Math.max(0, Number(pack.capacity) || 0);
        for (let slot = 0; slot < capacity; slot += 1) {
          if (!occupied.has(slot)) return { pack: String(pack.name), slot };
        }
      }
      return null;
    }

    queueMount() {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const bank = this._bankSnapshot();
      if (bank && bank.available !== false) {
        this.lastAction = { at: nowIso(), type: 'BANK_ALREADY_MOUNTED', map: bank.map || null };
        return { accepted: true, state: 'READY', alreadyMounted: true, bank: clone(bank) };
      }
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind: 'MOUNT',
        travelRequested: false,
        bankTravelStartedAtMs: null,
        createdAt: nowIso()
      };
      this.lastAction = { at: nowIso(), type: 'MOUNT_QUEUED' };
      return { accepted: true, request: clone(this.request) };
    }

    queueDeposit(itemName, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const wanted = cleanText(itemName || '', 160);
      const slotWanted = finite(options.inventorySlot);
      const candidates = this._safeDepositRows().filter(row =>
        String(row.name) === wanted && (slotWanted == null || Number(row.slot) === slotWanted));
      const row = candidates[0];
      if (!row) return { accepted: false, reason: 'H12_DEPOSIT_ITEM_NOT_SAFE_OR_AVAILABLE' };
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind: 'DEPOSIT',
        itemName: row.name,
        fingerprint: this._fingerprint(row),
        inventorySlot: Number(row.slot),
        beforeQuantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
        preferredPack: cleanText(options.preferredPack || '', 120) || null,
        travelRequested: false,
        bankTravelStartedAtMs: null,
        createdAt: nowIso()
      };
      this.lastAction = { at: nowIso(), type: 'DEPOSIT_QUEUED', itemName: row.name, slot: row.slot };
      return { accepted: true, request: clone(this.request) };
    }

    queueWithdraw(packName, bankSlot, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const pack = cleanText(packName || '', 120);
      const slot = finite(bankSlot);
      if (!pack || slot == null) return { accepted: false, reason: 'H12_WITHDRAW_LOCATION_REQUIRED' };
      const bank = this._bankSnapshot();
      if (!bank || bank.available === false) return { accepted: false, reason: 'H12_BANK_NOT_MOUNTED' };
      const packView = (bank.packs || []).find(entry => String(entry.name) === pack) || null;
      if (!packView || !bank.map || !packView.map || String(packView.map) !== String(bank.map)) {
        return { accepted: false, reason: 'H12_WITHDRAW_WRONG_OR_UNKNOWN_BANK_MAP' };
      }
      const row = this._bankItem(bank, pack, slot);
      if (!row) return { accepted: false, reason: 'H12_WITHDRAW_ITEM_NOT_FOUND' };
      const reserved = Math.max(0, Math.floor(Number(this.reservations[row.name]) || 0));
      const totalInBank = this._quantityInBank(bank, this._fingerprint(row));
      const stackQuantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
      if (totalInBank != null && totalInBank - stackQuantity < reserved) {
        return { accepted: false, reason: 'H12_BANK_RESERVATION_BLOCKED' };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H12_INVENTORY_FULL_OR_UNAVAILABLE' };
      }
      let inventorySlot = finite(options.inventorySlot);
      if (inventorySlot != null && this._inventoryItem(inventory, inventorySlot)) {
        return { accepted: false, reason: 'H12_WITHDRAW_TARGET_SLOT_OCCUPIED' };
      }
      if (inventorySlot == null) {
        const occupied = new Set((inventory.items || []).map(item => Number(item.slot)));
        for (let i = 0; i < Number(inventory.capacity || 0); i += 1) {
          if (!occupied.has(i)) { inventorySlot = i; break; }
        }
      }
      if (inventorySlot == null) return { accepted: false, reason: 'H12_INVENTORY_FULL_OR_UNAVAILABLE' };
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind: 'WITHDRAW',
        itemName: row.name,
        fingerprint: this._fingerprint(row),
        pack,
        bankSlot: slot,
        inventorySlot,
        beforeQuantity: stackQuantity,
        createdAt: nowIso()
      };
      this.lastAction = { at: nowIso(), type: 'WITHDRAW_QUEUED', itemName: row.name, pack, bankSlot: slot };
      return { accepted: true, request: clone(this.request) };
    }

    queueGoldDeposit(amount) {
      return this._queueGold('GOLD_DEPOSIT', amount);
    }

    queueGoldWithdraw(amount) {
      return this._queueGold('GOLD_WITHDRAW', amount);
    }

    _queueGold(kind, amount) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const bank = this._bankSnapshot();
      const snap = this._snapshot();
      const requested = finite(amount);
      if (requested == null || requested <= 0 || !Number.isInteger(requested)) {
        return { accepted: false, reason: 'H12_GOLD_AMOUNT_INVALID' };
      }
      const value = requested;
      if (!bank || bank.available === false || finite(bank.gold) == null) {
        return { accepted: false, reason: 'H12_BANK_GOLD_UNOBSERVABLE' };
      }
      if (!snap || !snap.character || finite(snap.character.gold) == null) {
        return { accepted: false, reason: 'H12_CHARACTER_GOLD_UNOBSERVABLE' };
      }
      if (kind === 'GOLD_DEPOSIT' && Number(snap.character.gold) < value) {
        return { accepted: false, reason: 'H12_GOLD_DEPOSIT_AMOUNT_UNAVAILABLE' };
      }
      if (kind === 'GOLD_WITHDRAW' && Number(bank.gold) < value) {
        return { accepted: false, reason: 'H12_GOLD_WITHDRAW_AMOUNT_UNAVAILABLE' };
      }
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind,
        amount: value,
        beforeBankGold: Number(bank.gold),
        beforeCharacterGold: Number(snap.character.gold),
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
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
        this.pending.error = cleanText(error && error.message || error && error.reason || error || 'H12_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _metric(kind, suffix) {
      const names = {
        DEPOSIT: 'deposits',
        WITHDRAW: 'withdrawals',
        GOLD_DEPOSIT: 'goldDeposits',
        GOLD_WITHDRAW: 'goldWithdrawals'
      };
      const key = (names[kind] || '') + suffix;
      if (Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.pending = null;
      this.request = null;
      this.suspendedReason = cleanText(reason || 'H12_UNKNOWN', 240) || 'H12_UNKNOWN';
      this.lastAction = { at: nowIso(), type: kind + '_UNKNOWN', reason: this.suspendedReason };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _observed(pending) {
      const inventory = this._inventorySnapshot();
      const bank = this._bankSnapshot();
      if (!inventory || inventory.available === false || !bank || bank.available === false) return false;

      if (pending.kind === 'DEPOSIT') {
        const invQty = this._quantityInInventory(inventory, pending.fingerprint);
        const bankQty = this._quantityInBank(bank, pending.fingerprint);
        if (invQty == null || bankQty == null) return false;
        const target = this._bankItem(bank, pending.pack, pending.bankSlot);
        return invQty <= pending.beforeInventoryQuantity - pending.quantity
          && bankQty >= pending.beforeBankQuantity + pending.quantity
          && !!target
          && this._fingerprint(target) === pending.fingerprint;
      }

      if (pending.kind === 'WITHDRAW') {
        const invQty = this._quantityInInventory(inventory, pending.fingerprint);
        const bankQty = this._quantityInBank(bank, pending.fingerprint);
        if (invQty == null || bankQty == null) return false;
        const target = this._inventoryItem(inventory, pending.inventorySlot);
        return invQty >= pending.beforeInventoryQuantity + pending.quantity
          && bankQty <= pending.beforeBankQuantity - pending.quantity
          && !!target
          && this._fingerprint(target) === pending.fingerprint;
      }

      const snap = this._snapshot();
      const bankGold = finite(bank.gold);
      const characterGold = snap && snap.character && finite(snap.character.gold);
      if (bankGold == null || characterGold == null) return false;
      if (pending.kind === 'GOLD_DEPOSIT') {
        return bankGold >= pending.beforeBankGold + pending.amount
          && characterGold <= pending.beforeCharacterGold - pending.amount;
      }
      if (pending.kind === 'GOLD_WITHDRAW') {
        return bankGold <= pending.beforeBankGold - pending.amount
          && characterGold >= pending.beforeCharacterGold + pending.amount;
      }
      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.settlement === 'REJECTED') {
        return this._suspend(pending.kind, pending.error || 'H12_ACTION_REJECTED');
      }
      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Rejected');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H12_ACTION_REJECTED', 240)
        };
        return true;
      }
      if (this._observed(pending)) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Confirmed');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_CONFIRMED',
          itemName: pending.itemName || null,
          pack: pending.pack || null,
          bankSlot: pending.bankSlot == null ? null : pending.bankSlot,
          inventorySlot: pending.inventorySlot == null ? null : pending.inventorySlot,
          amount: pending.amount || null
        };
        return true;
      }
      if (Date.now() >= pending.deadlineAtMs) {
        return this._suspend(pending.kind, 'H12_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      }
      return false;
    }

    _dispatch(action, args, pendingBase) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H12_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          return this._suspend(pendingBase.kind, result.error && result.error.message || 'H12_DISPATCH_UNKNOWN');
        }
        this._metric(pendingBase.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H12_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'bank-pending-' + (++this.sequence),
        ...pendingBase,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this._metric(pending.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: pending.kind + '_DISPATCHED' };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _ensureBankMounted(request) {
      const bank = this._bankSnapshot();
      if (bank && bank.available !== false) return { ready: true, bank };

      const now = Date.now();
      if (request.bankTravelStartedAtMs != null && now - request.bankTravelStartedAtMs >= this.config.bankMountTimeoutMs) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, 'H12_BANK_MOUNT_TIMEOUT');
      }

      let movement = null;
      try { movement = this.movement && this.movement.status ? this.movement.status() : null; } catch (_) {}
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '') === 'bank-h12') return { ready: false, waiting: true };
        return { ready: false, waiting: true, reason: 'H12_MOVEMENT_OWNED_BY_OTHER' };
      }

      if (request.travelRequested) return { ready: false, waiting: true };

      if (!this.movement || typeof this.movement.smartMove !== 'function') {
        return this._suspend(request.kind, 'H12_MOVEMENT_UNAVAILABLE');
      }
      const moved = this.movement.smartMove('bank', { owner: 'bank-h12' });
      if (!moved || moved.accepted !== true) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, moved && moved.reason || 'H12_BANK_MOVE_REJECTED');
      }
      request.travelRequested = true;
      request.bankTravelStartedAtMs = now;
      this.metrics.movementRequests += 1;
      this.lastAction = { at: nowIso(), type: 'BANK_MOVE_REQUESTED' };
      return { ready: false, waiting: true };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H12_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();

      if (!this._localMerchant()) {
        this.request = null;
        return { state: 'BLOCKED', reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      }

      const mounted = this._ensureBankMounted(request);
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (!mounted || mounted.ready !== true) return { state: 'WAITING_BANK', reason: mounted && mounted.reason || 'H12_BANK_TRAVEL' };
      const bank = mounted.bank;
      if (request.kind === 'MOUNT') {
        this.request = null;
        this.lastAction = {
          at: nowIso(),
          type: 'BANK_MOUNTED',
          map: bank.map || null,
          packs: (bank.packs || []).length,
          usedSlots: Number(bank.usedSlots || 0)
        };
        return {
          state: 'READY',
          reason: 'H12_BANK_READY',
          bank: {
            map: bank.map || null,
            packs: (bank.packs || []).length,
            usedSlots: Number(bank.usedSlots || 0),
            freeSlots: Number(bank.freeSlots || 0)
          }
        };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) {
        return { state: 'BLOCKED', reason: 'H12_INVENTORY_UNAVAILABLE' };
      }

      if (request.kind === 'DEPOSIT') {
        const current = this._inventoryItem(inventory, request.inventorySlot);
        if (!current || this._fingerprint(current) !== request.fingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_DEPOSIT_SOURCE_CHANGED' };
        }
        const workspace = this._workspaceSlot(bank, request.preferredPack);
        if (!workspace) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_BANK_NO_WORKSPACE_SLOT' };
        }
        const beforeInventoryQuantity = this._quantityInInventory(inventory, request.fingerprint);
        const beforeBankQuantity = this._quantityInBank(bank, request.fingerprint);
        if (beforeInventoryQuantity == null || beforeBankQuantity == null) {
          return { state: 'BLOCKED', reason: 'H12_RECONCILIATION_UNAVAILABLE' };
        }
        const quantity = Math.max(1, Math.floor(Number(current.quantity) || 1));
        return this._dispatch('bank_store', [request.inventorySlot, workspace.pack, workspace.slot], {
          kind: 'DEPOSIT',
          itemName: current.name,
          fingerprint: request.fingerprint,
          quantity,
          inventorySlot: request.inventorySlot,
          pack: workspace.pack,
          bankSlot: workspace.slot,
          beforeInventoryQuantity,
          beforeBankQuantity
        });
      }

      if (request.kind === 'WITHDRAW') {
        const current = this._bankItem(bank, request.pack, request.bankSlot);
        if (!current || this._fingerprint(current) !== request.fingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_WITHDRAW_SOURCE_CHANGED' };
        }
        if (this._inventoryItem(inventory, request.inventorySlot)) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_WITHDRAW_TARGET_SLOT_OCCUPIED' };
        }
        const beforeInventoryQuantity = this._quantityInInventory(inventory, request.fingerprint);
        const beforeBankQuantity = this._quantityInBank(bank, request.fingerprint);
        if (beforeInventoryQuantity == null || beforeBankQuantity == null) {
          return { state: 'BLOCKED', reason: 'H12_RECONCILIATION_UNAVAILABLE' };
        }
        const quantity = Math.max(1, Math.floor(Number(current.quantity) || 1));
        return this._dispatch('bank_retrieve', [request.pack, request.bankSlot, request.inventorySlot], {
          kind: 'WITHDRAW',
          itemName: current.name,
          fingerprint: request.fingerprint,
          quantity,
          inventorySlot: request.inventorySlot,
          pack: request.pack,
          bankSlot: request.bankSlot,
          beforeInventoryQuantity,
          beforeBankQuantity
        });
      }

      if (request.kind === 'GOLD_DEPOSIT') {
        const snap = this._snapshot();
        const liveBankGold = finite(bank.gold);
        const characterGold = snap && snap.character && finite(snap.character.gold);
        if (liveBankGold == null || characterGold == null) return this._suspend(request.kind, 'H12_GOLD_OBSERVATION_LOST');
        return this._dispatch('bank_deposit', [request.amount], {
          kind: request.kind,
          amount: request.amount,
          beforeBankGold: liveBankGold,
          beforeCharacterGold: characterGold
        });
      }

      if (request.kind === 'GOLD_WITHDRAW') {
        const snap = this._snapshot();
        const liveBankGold = finite(bank.gold);
        const characterGold = snap && snap.character && finite(snap.character.gold);
        if (liveBankGold == null || characterGold == null) return this._suspend(request.kind, 'H12_GOLD_OBSERVATION_LOST');
        return this._dispatch('bank_withdraw', [request.amount], {
          kind: request.kind,
          amount: request.amount,
          beforeBankGold: liveBankGold,
          beforeCharacterGold: characterGold
        });
      }

      this.request = null;
      return { state: 'BLOCKED', reason: 'H12_REQUEST_UNKNOWN' };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        request: clone(this.request),
        workspace: clone(this.workspace),
        reservations: clone(this.reservations),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.BankController = BankController;
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

  function nowIso() {
    return new Date().toISOString();
  }

  function stableProperty(value) {
    if (value == null) return '';
    try { return JSON.stringify(value, Object.keys(value).sort()); }
    catch (_) { return String(value); }
  }

  class TradeController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.moduleActive = false;
      this.scope = null;
      this.suspendedReason = null;
      this.pending = null;
      this.request = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 6000)),
        npcRange: Math.max(80, Math.min(600, Number(options.npcRange) || 240)),
        movementTimeoutMs: Math.max(3000, Math.min(120000, Number(options.movementTimeoutMs) || 45000)),
        goldReserve: Math.max(0, Math.floor(Number(options.goldReserve) || 10000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        analyses: 0,
        acquisitionsPlanned: 0,
        npcBuysDispatched: 0,
        npcBuysConfirmed: 0,
        npcBuysRejected: 0,
        npcBuysUnknown: 0,
        npcSellsDispatched: 0,
        npcSellsConfirmed: 0,
        npcSellsRejected: 0,
        npcSellsUnknown: 0,
        marketBuysDispatched: 0,
        marketBuysConfirmed: 0,
        marketBuysRejected: 0,
        marketBuysUnknown: 0,
        marketSellsDispatched: 0,
        marketSellsConfirmed: 0,
        marketSellsRejected: 0,
        marketSellsUnknown: 0,
        priceBlocks: 0,
        safetyBlocks: 0,
        movementRequests: 0,
        movementUnknown: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H13_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('trade-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H13_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H13_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H13_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    _cancelOwnedMovement(reason) {
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'trade-h13') {
          this.movement.cancel(cleanText(reason, 180) || 'H13_CANCEL');
        }
      } catch (_) {}
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _inventorySnapshot() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _inventoryPlan() {
      try { return this.inventory && this.inventory.plan ? this.inventory.plan() : null; }
      catch (_) { return null; }
    }

    _marketSnapshot() {
      try { return this.game && this.game.marketSnapshot ? this.game.marketSnapshot() : null; }
      catch (_) { return null; }
    }

    _merchantReady() {
      const snap = this._snapshot();
      return !!(snap && snap.available && snap.character
        && String(snap.character.ctype || '').toLowerCase() === 'merchant'
        && snap.character.rip !== true);
    }

    _characterGold() {
      const snap = this._snapshot();
      return snap && snap.character ? finite(snap.character.gold) : null;
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return [
        String(row.name),
        String(Math.max(0, Number(row.level) || 0)),
        cleanText(row.statType != null ? row.statType : row.stat_type || '', 80),
        stableProperty(row.property != null ? row.property : row.p)
      ].join('|');
    }

    _quantity(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _quantityByName(snapshot, name, level = 0) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)
          ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _safeSellRows() {
      const plan = this._inventoryPlan();
      if (!plan || plan.state !== 'READY') return [];
      return (plan.items || []).filter(row =>
        row && row.name
        && String(row.disposition || '').toUpperCase() === 'SELL'
        && row.locked !== true
        && row.giveaway !== true
        && row.gift !== true
        && !row.expiresAt
        && Math.max(0, Number(row.level) || 0) === 0
        && !(row.definition && (row.definition.quest === true || row.definition.upgrade === true || row.definition.compound === true))
      );
    }

    marketAnalysis(itemName = null, options = {}) {
      this.metrics.analyses += 1;
      const market = this._marketSnapshot();
      const wanted = cleanText(itemName || '', 160);
      const level = finite(options.level);
      if (!market || market.available === false) {
        return { available: false, reason: market && market.reason || 'H13_MARKET_UNAVAILABLE', asks: [], bids: [] };
      }
      const rows = (market.listings || []).filter(row => {
        if (row.giveaway) return false;
        if (wanted && String(row.name) !== wanted) return false;
        if (level != null && Number(row.level || 0) !== level) return false;
        return finite(row.price) != null && finite(row.price) > 0;
      });
      const asks = rows.filter(row => row.buying !== true).sort((a, b) => Number(a.price) - Number(b.price));
      const bids = rows.filter(row => row.buying === true).sort((a, b) => Number(b.price) - Number(a.price));
      return {
        available: true,
        itemName: wanted || null,
        level,
        asks: clone(asks),
        bids: clone(bids),
        bestAsk: asks[0] ? clone(asks[0]) : null,
        bestBid: bids[0] ? clone(bids[0]) : null,
        spread: asks[0] && bids[0]
          && String(asks[0].name) === String(bids[0].name)
          && Number(asks[0].level || 0) === Number(bids[0].level || 0)
          ? Number(asks[0].price) - Number(bids[0].price)
          : null
      };
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const inventory = this._inventorySnapshot();
      const market = this._marketSnapshot();
      const plan = {
        state: !snap || !snap.available || !snap.character
          ? 'BLOCKED'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'BLOCKED'
            : 'READY',
        reason: !snap || !snap.available || !snap.character
          ? 'CHARACTER_UNAVAILABLE'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'H13_REQUIRES_MERCHANT'
            : 'H13_READY',
        character: snap && snap.character ? {
          name: snap.character.name,
          ctype: snap.character.ctype,
          map: snap.character.map,
          gold: snap.character.gold
        } : null,
        inventory: inventory ? {
          available: inventory.available,
          freeSlots: inventory.freeSlots,
          usedSlots: inventory.usedSlots,
          capacity: inventory.capacity
        } : null,
        safeSellRows: clone(this._safeSellRows()),
        market: market ? {
          available: market.available,
          listingCount: (market.listings || []).length,
          sellerCount: (market.players || []).length
        } : null,
        goldReserve: this.config.goldReserve
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    queueNpcBuy(itemName, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const name = cleanText(itemName || '', 160);
      const q = finite(quantity);
      const maxUnitPrice = finite(options.maxUnitPrice);
      if (!name || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_BUY_QUANTITY_INVALID' };
      if (maxUnitPrice == null || maxUnitPrice <= 0) return { accepted: false, reason: 'H13_MAX_UNIT_PRICE_REQUIRED' };
      const definition = this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null;
      const unitPrice = definition && finite(definition.g);
      if (unitPrice == null || unitPrice <= 0) return { accepted: false, reason: 'H13_NPC_PRICE_UNAVAILABLE' };
      if (unitPrice > maxUnitPrice) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_NPC_PRICE_ABOVE_LIMIT', unitPrice, maxUnitPrice };
      }
      const sources = this.game && this.game.npcShopSources ? this.game.npcShopSources(name) : [];
      const source = (sources || []).find(row => row && row.location);
      if (!source) return { accepted: false, reason: 'H13_NPC_SOURCE_UNAVAILABLE' };
      const gold = this._characterGold();
      const totalCost = unitPrice * q;
      if (gold == null || gold - totalCost < this.config.goldReserve) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_GOLD_RESERVE_BLOCKED', gold, totalCost, reserve: this.config.goldReserve };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H13_INVENTORY_FULL_OR_UNAVAILABLE' };
      }
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'NPC_BUY',
        itemName: name,
        level: 0,
        quantity: q,
        unitPrice,
        maxUnitPrice,
        totalCost,
        npcId: source.npcId,
        location: clone(source.location),
        travelStartedAtMs: null,
        createdAt: nowIso()
      };
      this.metrics.acquisitionsPlanned += 1;
      return { accepted: true, request: clone(this.request) };
    }

    queueNpcSell(slot, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const wantedSlot = finite(slot);
      const q = finite(quantity);
      if (wantedSlot == null || q == null || q <= 0 || !Number.isInteger(q)) {
        return { accepted: false, reason: 'H13_SELL_ARGUMENT_INVALID' };
      }
      const row = this._safeSellRows().find(item => Number(item.slot) === wantedSlot);
      if (!row) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H13_SELL_ITEM_NOT_SAFE' };
      }
      if (q > Math.max(1, Math.floor(Number(row.quantity) || 1))) return { accepted: false, reason: 'H13_SELL_QUANTITY_UNAVAILABLE' };
      const npcId = cleanText(options.npcId || 'fancypots', 120);
      const location = this.game && this.game.npcLocation ? this.game.npcLocation(npcId) : null;
      if (!location) return { accepted: false, reason: 'H13_SELL_NPC_UNAVAILABLE' };
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'NPC_SELL',
        itemName: row.name,
        fingerprint: this._fingerprint(row),
        inventorySlot: Number(row.slot),
        quantity: q,
        npcId,
        location: clone(location),
        travelStartedAtMs: null,
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueMarketBuy(playerName, tradeSlot, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const name = cleanText(playerName || '', 120);
      const slot = cleanText(tradeSlot || '', 80);
      const q = finite(quantity);
      const maxUnitPrice = finite(options.maxUnitPrice);
      if (!name || !slot || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_MARKET_BUY_ARGUMENT_INVALID' };
      if (maxUnitPrice == null || maxUnitPrice <= 0) return { accepted: false, reason: 'H13_MAX_UNIT_PRICE_REQUIRED' };
      const analysis = this._marketSnapshot();
      const listing = analysis && (analysis.listings || []).find(row =>
        String(row.playerName) === name && String(row.slot) === slot);
      if (!listing || listing.buying === true || listing.giveaway) return { accepted: false, reason: 'H13_MARKET_ASK_NOT_AVAILABLE' };
      if (!listing.rid) return { accepted: false, reason: 'H13_MARKET_RID_UNAVAILABLE' };
      if (q > Math.max(1, Math.floor(Number(listing.quantity) || 1))) return { accepted: false, reason: 'H13_MARKET_QUANTITY_UNAVAILABLE' };
      const unitPrice = finite(listing.price);
      if (unitPrice == null || unitPrice <= 0 || unitPrice > maxUnitPrice) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_MARKET_PRICE_ABOVE_LIMIT', unitPrice, maxUnitPrice };
      }
      const gold = this._characterGold();
      const totalCost = unitPrice * q;
      if (gold == null || gold - totalCost < this.config.goldReserve) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_GOLD_RESERVE_BLOCKED', gold, totalCost, reserve: this.config.goldReserve };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H13_INVENTORY_FULL_OR_UNAVAILABLE' };
      }
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'MARKET_BUY',
        playerName: name,
        tradeSlot: slot,
        rid: String(listing.rid),
        itemName: listing.name,
        level: Number(listing.level) || 0,
        quantity: q,
        unitPrice,
        maxUnitPrice,
        totalCost,
        createdAt: nowIso()
      };
      this.metrics.acquisitionsPlanned += 1;
      return { accepted: true, request: clone(this.request) };
    }

    queueMarketSell(playerName, tradeSlot, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const name = cleanText(playerName || '', 120);
      const slot = cleanText(tradeSlot || '', 80);
      const q = finite(quantity);
      const minUnitPrice = finite(options.minUnitPrice);
      if (!name || !slot || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_MARKET_SELL_ARGUMENT_INVALID' };
      if (minUnitPrice == null || minUnitPrice < 0) return { accepted: false, reason: 'H13_MIN_UNIT_PRICE_REQUIRED' };
      const market = this._marketSnapshot();
      const listing = market && (market.listings || []).find(row =>
        String(row.playerName) === name && String(row.slot) === slot);
      if (!listing || listing.buying !== true || listing.giveaway) return { accepted: false, reason: 'H13_MARKET_BID_NOT_AVAILABLE' };
      if (!listing.rid) return { accepted: false, reason: 'H13_MARKET_RID_UNAVAILABLE' };
      if (q > Math.max(1, Math.floor(Number(listing.quantity) || 1))) {
        return { accepted: false, reason: 'H13_MARKET_BID_QUANTITY_UNAVAILABLE' };
      }
      const unitPrice = finite(listing.price);
      if (unitPrice == null || unitPrice < minUnitPrice) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_MARKET_BID_BELOW_LIMIT', unitPrice, minUnitPrice };
      }
      const listingFingerprint = this._fingerprint(listing);
      const sellRow = this._safeSellRows().find(row =>
        this._fingerprint(row) === listingFingerprint
        && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= q);
      if (!sellRow) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H13_MARKET_SELL_ITEM_NOT_SAFE_OR_AVAILABLE' };
      }
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'MARKET_SELL',
        playerName: name,
        tradeSlot: slot,
        rid: String(listing.rid),
        itemName: listing.name,
        fingerprint: listingFingerprint,
        level: Number(listing.level) || 0,
        quantity: q,
        unitPrice,
        minUnitPrice,
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueAcquire(itemName, quantity = 1, options = {}) {
      const name = cleanText(itemName || '', 160);
      const q = finite(quantity);
      const maxUnitPrice = finite(options.maxUnitPrice);
      if (!name || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_ACQUIRE_ARGUMENT_INVALID' };
      if (maxUnitPrice == null || maxUnitPrice <= 0) return { accepted: false, reason: 'H13_MAX_UNIT_PRICE_REQUIRED' };
      const definition = this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null;
      const npcPrice = definition && finite(definition.g);
      const sources = this.game && this.game.npcShopSources ? this.game.npcShopSources(name) : [];
      const npcAvailable = npcPrice != null && npcPrice > 0 && npcPrice <= maxUnitPrice && (sources || []).some(row => row.location);
      const analysis = this.marketAnalysis(name, { level: options.level == null ? 0 : options.level });
      const eligibleAsk = (analysis.asks || []).find(row =>
        Number(row.price) <= maxUnitPrice
        && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= q) || null;
      if (npcAvailable && (!eligibleAsk || npcPrice <= Number(eligibleAsk.price))) {
        return this.queueNpcBuy(name, q, { maxUnitPrice });
      }
      if (eligibleAsk) {
        return this.queueMarketBuy(eligibleAsk.playerName, eligibleAsk.slot, q, { maxUnitPrice });
      }
      this.metrics.priceBlocks += 1;
      return {
        accepted: false,
        reason: 'H13_NO_ACQUISITION_WITHIN_PRICE_LIMIT',
        npcPrice,
        bestAsk: clone(analysis.bestAsk),
        eligibleAsk: null
      };
    }

    _metric(kind, suffix) {
      const prefix = {
        NPC_BUY: 'npcBuys',
        NPC_SELL: 'npcSells',
        MARKET_BUY: 'marketBuys',
        MARKET_SELL: 'marketSells'
      }[kind];
      const key = prefix ? prefix + suffix : null;
      if (key && Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.pending = null;
      this.request = null;
      this.suspendedReason = cleanText(reason || 'H13_UNKNOWN', 240) || 'H13_UNKNOWN';
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
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H13_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dispatch(action, args, pendingBase) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H13_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(pendingBase.kind, result.error && result.error.message || 'H13_DISPATCH_UNKNOWN');
        this._metric(pendingBase.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H13_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'trade-pending-' + (++this.sequence),
        ...pendingBase,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this._metric(pending.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: pending.kind + '_DISPATCHED' };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _observed(pending) {
      const inventory = this._inventorySnapshot();
      const gold = this._characterGold();
      if (!inventory || inventory.available === false || gold == null) return false;

      if (pending.kind === 'NPC_BUY' || pending.kind === 'MARKET_BUY') {
        const afterQuantity = this._quantityByName(inventory, pending.itemName, pending.level || 0);
        return afterQuantity != null
          && afterQuantity >= pending.beforeQuantity + pending.quantity
          && gold <= pending.beforeGold - pending.totalCost;
      }

      if (pending.kind === 'NPC_SELL' || pending.kind === 'MARKET_SELL') {
        const afterQuantity = this._quantity(inventory, pending.fingerprint);
        return afterQuantity != null
          && afterQuantity <= pending.beforeQuantity - pending.quantity
          && gold > pending.beforeGold;
      }
      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.settlement === 'REJECTED') return this._suspend(pending.kind, pending.error || 'H13_ACTION_REJECTED');
      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Rejected');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H13_ACTION_REJECTED', 240)
        };
        return true;
      }
      if (this._observed(pending)) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Confirmed');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_CONFIRMED',
          itemName: pending.itemName,
          quantity: pending.quantity,
          unitPrice: pending.unitPrice == null ? null : pending.unitPrice,
          playerName: pending.playerName || null,
          tradeSlot: pending.tradeSlot || null
        };
        return true;
      }
      if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H13_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      return false;
    }

    _distanceTo(location) {
      const snap = this._snapshot();
      const c = snap && snap.character;
      if (!c || !location) return null;
      if (location.map && c.map && String(location.map) !== String(c.map)) return Infinity;
      const cx = finite(c.x), cy = finite(c.y), x = finite(location.x), y = finite(location.y);
      return cx == null || cy == null || x == null || y == null ? null : Math.hypot(cx - x, cy - y);
    }

    _ensureNpc(request) {
      const distance = this._distanceTo(request.location);
      if (distance != null && distance <= this.config.npcRange) return { ready: true };
      const now = Date.now();
      if (request.travelStartedAtMs != null && now - request.travelStartedAtMs >= this.config.movementTimeoutMs) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, 'H13_NPC_MOVEMENT_TIMEOUT');
      }
      let movement = null;
      try { movement = this.movement && this.movement.status ? this.movement.status() : null; } catch (_) {}
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '') === 'trade-h13') return { ready: false, waiting: true };
        return { ready: false, waiting: true, reason: 'H13_MOVEMENT_OWNED_BY_OTHER' };
      }
      if (request.travelStartedAtMs != null) return { ready: false, waiting: true };
      if (!this.movement || typeof this.movement.smartMove !== 'function') return this._suspend(request.kind, 'H13_MOVEMENT_UNAVAILABLE');
      const moved = this.movement.smartMove(request.location, { owner: 'trade-h13' });
      if (!moved || moved.accepted !== true) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, moved && moved.reason || 'H13_NPC_MOVE_REJECTED');
      }
      request.travelStartedAtMs = now;
      this.metrics.movementRequests += 1;
      this.lastAction = { at: nowIso(), type: 'NPC_MOVE_REQUESTED', npcId: request.npcId };
      return { ready: false, waiting: true };
    }

    _marketListingStillMatches(request, buying) {
      const market = this._marketSnapshot();
      if (!market || market.available === false) return null;
      return (market.listings || []).find(row =>
        String(row.playerName) === String(request.playerName)
        && String(row.slot) === String(request.tradeSlot)
        && String(row.rid || '') === String(request.rid || '')
        && row.buying === buying
        && String(row.name) === String(request.itemName)
        && Number(row.price) === Number(request.unitPrice)
      ) || null;
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H13_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();
      if (!this._merchantReady()) {
        this.request = null;
        return { state: 'BLOCKED', reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      }

      if (request.kind === 'NPC_BUY' || request.kind === 'NPC_SELL') {
        const near = this._ensureNpc(request);
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        if (!near || near.ready !== true) return { state: 'WAITING_NPC', reason: near && near.reason || 'H13_NPC_TRAVEL' };
      }

      const inventory = this._inventorySnapshot();
      const beforeGold = this._characterGold();
      if (!inventory || inventory.available === false || beforeGold == null) return { state: 'BLOCKED', reason: 'H13_OBSERVATION_UNAVAILABLE' };

      if (request.kind === 'NPC_BUY') {
        const beforeQuantity = this._quantityByName(inventory, request.itemName, request.level || 0);
        if (beforeQuantity == null) return { state: 'BLOCKED', reason: 'H13_INVENTORY_OBSERVATION_UNAVAILABLE' };
        if (beforeGold - request.totalCost < this.config.goldReserve) {
          this.request = null;
          this.metrics.priceBlocks += 1;
          return {
            state: 'BLOCKED',
            reason: 'H13_GOLD_RESERVE_CHANGED',
            gold: beforeGold,
            totalCost: request.totalCost,
            reserve: this.config.goldReserve
          };
        }
        return this._dispatch('buy_with_gold', [request.itemName, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          level: request.level || 0,
          quantity: request.quantity,
          unitPrice: request.unitPrice,
          totalCost: request.totalCost,
          beforeQuantity,
          beforeGold
        });
      }

      if (request.kind === 'NPC_SELL') {
        const safeCurrent = this._safeSellRows().find(row =>
          Number(row.slot) === Number(request.inventorySlot)
          && this._fingerprint(row) === request.fingerprint
          && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= request.quantity);
        if (!safeCurrent) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          return { state: 'BLOCKED', reason: 'H13_SELL_ITEM_NO_LONGER_SAFE' };
        }
        const beforeQuantity = this._quantity(inventory, request.fingerprint);
        return this._dispatch('sell', [request.inventorySlot, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          fingerprint: request.fingerprint,
          quantity: request.quantity,
          beforeQuantity,
          beforeGold
        });
      }

      if (request.kind === 'MARKET_BUY') {
        if (beforeGold - request.totalCost < this.config.goldReserve) {
          this.request = null;
          this.metrics.priceBlocks += 1;
          return {
            state: 'BLOCKED',
            reason: 'H13_GOLD_RESERVE_CHANGED',
            gold: beforeGold,
            totalCost: request.totalCost,
            reserve: this.config.goldReserve
          };
        }
        const listing = this._marketListingStillMatches(request, false);
        if (!listing
          || Number(listing.price) > Number(request.maxUnitPrice)
          || Math.max(1, Math.floor(Number(listing.quantity) || 1)) < request.quantity) {
          this.request = null;
          this.metrics.priceBlocks += 1;
          return { state: 'BLOCKED', reason: 'H13_MARKET_ASK_CHANGED' };
        }
        const target = this.game && this.game.playerReference ? this.game.playerReference(request.playerName) : null;
        if (!target || !target.slots || !target.slots[request.tradeSlot]) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H13_MARKET_TARGET_UNAVAILABLE' };
        }
        const beforeQuantity = this._quantityByName(inventory, request.itemName, request.level || 0);
        return this._dispatch('trade_buy', [target, request.tradeSlot, request.rid, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          level: request.level || 0,
          playerName: request.playerName,
          tradeSlot: request.tradeSlot,
          rid: request.rid,
          quantity: request.quantity,
          unitPrice: request.unitPrice,
          totalCost: request.totalCost,
          beforeQuantity,
          beforeGold
        });
      }

      if (request.kind === 'MARKET_SELL') {
        const listing = this._marketListingStillMatches(request, true);
        if (!listing
          || Number(listing.price) < Number(request.minUnitPrice)
          || Math.max(1, Math.floor(Number(listing.quantity) || 1)) < request.quantity) {
          this.request = null;
          this.metrics.priceBlocks += 1;
          return { state: 'BLOCKED', reason: 'H13_MARKET_BID_CHANGED' };
        }
        const target = this.game && this.game.playerReference ? this.game.playerReference(request.playerName) : null;
        if (!target || !target.slots || !target.slots[request.tradeSlot]) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H13_MARKET_TARGET_UNAVAILABLE' };
        }
        const safeCurrent = this._safeSellRows().find(row =>
          this._fingerprint(row) === request.fingerprint
          && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= request.quantity);
        if (!safeCurrent) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          return { state: 'BLOCKED', reason: 'H13_MARKET_SELL_ITEM_NO_LONGER_SAFE' };
        }
        const beforeQuantity = this._quantity(inventory, request.fingerprint);
        return this._dispatch('trade_sell', [target, request.tradeSlot, request.rid, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          fingerprint: request.fingerprint,
          playerName: request.playerName,
          tradeSlot: request.tradeSlot,
          rid: request.rid,
          quantity: request.quantity,
          unitPrice: request.unitPrice,
          beforeQuantity,
          beforeGold
        });
      }

      this.request = null;
      return { state: 'BLOCKED', reason: 'H13_REQUEST_UNKNOWN' };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        request: clone(this.request),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.TradeController = TradeController;
})(typeof globalThis !== 'undefined' ? globalThis : this);


(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const GEAR_SLOTS = Object.freeze([
    'helmet', 'coat', 'pants', 'gloves', 'shoes', 'cape', 'belt',
    'amulet', 'orb', 'ring1', 'ring2', 'earring1', 'earring2',
    'mainhand', 'offhand'
  ]);

  const PRIMARY_STAT = Object.freeze({
    warrior: 'str',
    paladin: 'str',
    ranger: 'dex',
    rogue: 'dex',
    mage: 'int',
    priest: 'int',
    merchant: 'int'
  });

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
      const keys = Object.keys(value).sort();
      const ordered = {};
      for (const key of keys) ordered[key] = value[key];
      return JSON.stringify(ordered);
    } catch (_) {
      return String(value);
    }
  }

  class GearController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.inventory = options.inventory || null;
      this.roster = options.roster || null;
      this.combat = options.combat || null;
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.goals = [];
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 6000)),
        improvementEpsilon: Math.max(0, Number(options.improvementEpsilon) || 0.01)
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        localImprovements: 0,
        groupProposals: 0,
        equipsDispatched: 0,
        equipsConfirmed: 0,
        equipsRejected: 0,
        equipsUnknown: 0,
        unequipsDispatched: 0,
        unequipsConfirmed: 0,
        unequipsRejected: 0,
        unequipsUnknown: 0,
        deliveriesDispatched: 0,
        deliveriesConfirmed: 0,
        deliveriesRejected: 0,
        deliveriesUnknown: 0,
        safetyBlocks: 0,
        twoHandBlocks: 0,
        combatBlocks: 0,
        goalEvaluations: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H14_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('gear-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H14_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H14_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H14_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    setGoals(rows = []) {
      if (!Array.isArray(rows)) throw new Error('H14_GOALS_MUST_BE_ARRAY');
      const next = [];
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const targetName = cleanText(raw.targetName || raw.characterName || '', 120);
        const slot = cleanText(raw.slot || '', 40);
        const itemName = cleanText(raw.itemName || raw.name || '', 160);
        const minLevel = Math.max(0, Math.floor(finite(raw.minLevel) || 0));
        const priority = Math.max(0, Math.floor(finite(raw.priority) || 0));
        if (!targetName || !GEAR_SLOTS.includes(slot)) continue;
        if (!itemName && minLevel <= 0) continue;
        next.push({
          id: cleanText(raw.id || ('gear-goal-' + (next.length + 1)), 120),
          targetName,
          slot,
          itemName: itemName || null,
          minLevel,
          priority
        });
      }
      this.goals = next;
      return clone(this.goals);
    }

    goalSnapshot() {
      return clone(this.goals);
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _inventorySnapshot() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _equipmentSnapshot(name = null) {
      try { return this.game && this.game.equipmentSnapshot ? this.game.equipmentSnapshot(name) : null; }
      catch (_) { return null; }
    }

    _roster() {
      try {
        if (!this.roster) return null;
        if (typeof this.roster.refresh === 'function') return this.roster.refresh();
        if (typeof this.roster.status === 'function') return this.roster.status();
      } catch (_) {}
      return null;
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _equipmentDefinition(name) {
      try { return this.game && this.game.equipmentDefinition ? this.game.equipmentDefinition(name) : null; }
      catch (_) { return null; }
    }

    _classProfile(ctype) {
      try { return this.game && this.game.classEquipmentProfile ? this.game.classEquipmentProfile(ctype) : null; }
      catch (_) { return null; }
    }

    _normalizedItem(row) {
      if (!row || !row.name) return null;
      const definition = this._equipmentDefinition(row.name);
      if (!definition) return null;
      return { ...row, definition };
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return [
        String(row.name),
        String(Math.max(0, Number(row.level) || 0)),
        cleanText(row.statType != null ? row.statType : row.stat_type || '', 80),
        stableProperty(row.property != null ? row.property : row.p)
      ].join('|');
    }

    _quantity(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false || !fingerprint) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _primary(ctype) {
      return PRIMARY_STAT[String(ctype || '').toLowerCase()] || null;
    }

    score(row, ctype) {
      const item = this._normalizedItem(row);
      if (!item || !item.definition) return Number.NEGATIVE_INFINITY;
      const definition = item.definition;
      const level = Math.max(0, Number(item.level) || 0);
      const primary = this._primary(ctype);
      const weights = {
        attack: 8,
        armor: 2,
        resistance: 2,
        hp: 1.2,
        mp: 1,
        speed: 1.5,
        range: 2,
        str: primary === 'str' ? 6 : 1,
        dex: primary === 'dex' ? 6 : 1,
        int: primary === 'int' ? 6 : 1,
        vit: 2,
        stat: 6
      };
      let score = 0;
      for (const [stat, weight] of Object.entries(weights)) {
        const base = finite(definition.stats && definition.stats[stat]) || 0;
        const growth = finite(definition.upgradeGrowth && definition.upgradeGrowth[stat]) || 0;
        score += (base + growth * level) * weight;
      }
      if (primary && cleanText(item.statType || '', 80).toLowerCase() === primary) score += 25;
      score += level * 0.01;
      return Number(score.toFixed(4));
    }

    _canEquip(row, slot, ctype) {
      const item = this._normalizedItem(row);
      if (!item || !item.definition || !GEAR_SLOTS.includes(slot)) return { ok: false, reason: 'H14_NOT_EQUIPMENT' };
      const def = item.definition;
      const type = String(def.type || '').toLowerCase();
      const profile = this._classProfile(ctype);
      if ((def.classes || []).length && !def.classes.includes(String(ctype || '').toLowerCase())) {
        return { ok: false, reason: 'H14_CLASS_RESTRICTED' };
      }

      if (type === 'ring') return { ok: slot === 'ring1' || slot === 'ring2', reason: 'H14_RING_SLOT' };
      if (type === 'earring') return { ok: slot === 'earring1' || slot === 'earring2', reason: 'H14_EARRING_SLOT' };

      if (['shield', 'source', 'quiver', 'misc_offhand'].includes(type)) {
        const ok = slot === 'offhand' && !!(profile && profile.offhand && profile.offhand.includes(type));
        return { ok, reason: ok ? null : 'H14_OFFHAND_NOT_ALLOWED', handMode: 'offhand' };
      }

      if (['weapon', 'tool'].includes(type)) {
        const wtype = String(def.wtype || type).toLowerCase();
        if (slot === 'offhand') {
          const ok = !!(profile && profile.offhand && profile.offhand.includes(wtype));
          return { ok, reason: ok ? null : 'H14_OFFHAND_WEAPON_NOT_ALLOWED', handMode: 'offhand' };
        }
        if (slot !== 'mainhand') return { ok: false, reason: 'H14_WEAPON_REQUIRES_HAND' };
        const doublehand = !!(profile && profile.doublehand && profile.doublehand.includes(wtype));
        const mainhand = !!(profile && profile.mainhand && profile.mainhand.includes(wtype));
        return {
          ok: doublehand || mainhand,
          reason: doublehand || mainhand ? null : 'H14_MAINHAND_WEAPON_NOT_ALLOWED',
          handMode: doublehand ? 'doublehand' : 'mainhand'
        };
      }

      return { ok: type === slot, reason: type === slot ? null : 'H14_SLOT_TYPE_MISMATCH' };
    }

    _handConflict(row, slot, equipment, ctype) {
      const allowed = this._canEquip(row, slot, ctype);
      if (!allowed.ok) return { blocked: true, reason: allowed.reason };
      if (slot === 'mainhand' && allowed.handMode === 'doublehand' && equipment && equipment.slots && equipment.slots.offhand) {
        return { blocked: true, reason: 'H14_TWO_HAND_WOULD_DISPLACE_OFFHAND' };
      }
      if (slot === 'offhand' && equipment && equipment.slots && equipment.slots.mainhand) {
        const main = equipment.slots.mainhand;
        const mainAllowed = this._canEquip(main, 'mainhand', ctype);
        if (mainAllowed.ok && mainAllowed.handMode === 'doublehand') {
          return { blocked: true, reason: 'H14_OFFHAND_BLOCKED_BY_TWO_HAND' };
        }
      }
      return { blocked: false, reason: null };
    }

    _inventoryGear() {
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) return [];
      return (inventory.items || [])
        .filter(row => row && row.locked !== true && row.giveaway !== true && row.gift !== true && !row.expiresAt)
        .map(row => this._normalizedItem(row))
        .filter(Boolean);
    }

    _slotPlan(slot, ctype, equipment, inventoryRows, usedInventorySlots = null) {
      const current = equipment && equipment.slots ? equipment.slots[slot] || null : null;
      const currentScore = current ? this.score(current, ctype) : Number.NEGATIVE_INFINITY;
      const candidates = [];
      for (const row of inventoryRows) {
        if (usedInventorySlots && usedInventorySlots.has(Number(row.slot))) continue;
        const allowed = this._canEquip(row, slot, ctype);
        if (!allowed.ok) continue;
        const score = this.score(row, ctype);
        if (!Number.isFinite(score)) continue;
        candidates.push({
          inventorySlot: Number(row.slot),
          item: clone(row),
          score,
          fingerprint: this._fingerprint(row),
          handMode: allowed.handMode || null
        });
      }
      candidates.sort((a, b) => b.score - a.score || a.inventorySlot - b.inventorySlot);
      const best = candidates[0] || null;
      const delta = best
        ? (current == null ? best.score : best.score - currentScore)
        : null;
      const conflict = best ? this._handConflict(best.item, slot, equipment, ctype) : { blocked: false, reason: null };
      return {
        slot,
        current: current ? clone(current) : null,
        currentScore: Number.isFinite(currentScore) ? currentScore : null,
        bestInventory: best ? clone(best) : null,
        improvement: !!(best && (current == null || delta > this.config.improvementEpsilon)),
        delta: best && Number.isFinite(delta) ? Number(delta.toFixed(4)) : null,
        safeSwitch: !!(best && !conflict.blocked),
        blockReason: conflict.blocked ? conflict.reason : null,
        candidates: candidates.map(row => ({
          inventorySlot: row.inventorySlot,
          item: clone(row.item),
          score: row.score,
          fingerprint: row.fingerprint,
          handMode: row.handMode
        }))
      };
    }

    _localPlan(inventoryRows) {
      const snap = this._snapshot();
      const local = snap && snap.character;
      const equipment = local && local.name ? this._equipmentSnapshot(local.name) : null;
      if (!local || !equipment || equipment.available === false) {
        return {
          state: 'BLOCKED',
          reason: 'H14_LOCAL_EQUIPMENT_UNAVAILABLE',
          character: local ? clone(local) : null,
          equipment: equipment ? clone(equipment) : null,
          slots: [],
          improvements: [],
          replacements: [],
          upgradeCandidates: []
        };
      }
      const ctype = local.ctype;
      const slots = GEAR_SLOTS.map(slot => this._slotPlan(slot, ctype, equipment, inventoryRows));
      const improvements = slots
        .filter(row => row.improvement && row.safeSwitch)
        .sort((a, b) => (b.delta || 0) - (a.delta || 0));
      const replacements = slots.map(row => ({
        slot: row.slot,
        current: clone(row.current),
        currentScore: row.currentScore,
        bestInventory: clone(row.bestInventory),
        bestInventoryScore: row.bestInventory ? row.bestInventory.score : null,
        delta: row.delta,
        improvement: row.improvement,
        safeSwitch: row.safeSwitch,
        blockReason: row.blockReason
      }));
      const upgradeCandidates = [];
      const pushUpgrade = (row, source, slot) => {
        const item = this._normalizedItem(row);
        if (!item || !item.definition) return;
        if (!item.definition.upgradeable && !item.definition.compoundable) return;
        upgradeCandidates.push({
          source,
          slot: slot == null ? null : slot,
          inventorySlot: source === 'inventory' ? Number(item.slot) : null,
          item: clone(item),
          score: this.score(item, ctype),
          level: Math.max(0, Number(item.level) || 0),
          upgradeable: !!item.definition.upgradeable,
          compoundable: !!item.definition.compoundable
        });
      };
      for (const row of inventoryRows) pushUpgrade(row, 'inventory', null);
      for (const [slot, row] of Object.entries(equipment.slots || {})) pushUpgrade(row, 'equipped', slot);
      upgradeCandidates.sort((a, b) => b.score - a.score || b.level - a.level);
      return {
        state: 'READY',
        reason: 'H14_LOCAL_GEAR_READY',
        character: clone(local),
        equipment: clone(equipment),
        slots,
        improvements,
        replacements,
        upgradeCandidates
      };
    }

    _priorityTargets(roster) {
      if (!roster) return [];
      const rows = [];
      for (const farmer of roster.farmers || []) {
        rows.push({ name: farmer.name, ctype: farmer.ctype, role: 'FARMER', priority: 100 });
      }
      if (roster.merchant) {
        rows.push({ name: roster.merchant.name, ctype: roster.merchant.ctype, role: 'MERCHANT', priority: 10 });
      }
      rows.sort((a, b) => b.priority - a.priority || String(a.name).localeCompare(String(b.name)));
      return rows;
    }

    _groupPlan(inventoryRows, roster, localName, localCtype) {
      const targets = this._priorityTargets(roster);
      const usedInventorySlots = new Set();
      const proposals = [];
      const targetRows = [];
      for (const target of targets) {
        const equipment = this._equipmentSnapshot(target.name);
        const visible = !!(equipment && equipment.available !== false);
        targetRows.push({ ...target, visible, equipment: visible ? clone(equipment) : null });
        if (!visible || target.name === localName || String(localCtype || '').toLowerCase() !== 'merchant') continue;

        const transferRows = inventoryRows.filter(row =>
          !row.locked && !row.giveaway && !row.gift && !row.expiresAt);
        const slotPlans = GEAR_SLOTS.map(slot =>
          this._slotPlan(slot, target.ctype, equipment, transferRows, usedInventorySlots));
        const assignedTargetSlots = new Set();

        while (true) {
          let bestChoice = null;
          for (const slotPlan of slotPlans) {
            if (assignedTargetSlots.has(slotPlan.slot)) continue;
            let choice = null;
            for (const candidate of slotPlan.candidates || []) {
              if (usedInventorySlots.has(candidate.inventorySlot)) continue;
              const conflict = this._handConflict(candidate.item, slotPlan.slot, equipment, target.ctype);
              if (conflict.blocked) continue;
              const delta = slotPlan.current == null
                ? candidate.score
                : candidate.score - Number(slotPlan.currentScore || 0);
              if (slotPlan.current != null && delta <= this.config.improvementEpsilon) continue;
              choice = {
                targetName: target.name,
                targetCtype: target.ctype,
                role: target.role,
                priority: target.priority,
                slot: slotPlan.slot,
                inventorySlot: candidate.inventorySlot,
                item: clone(candidate.item),
                fingerprint: candidate.fingerprint,
                score: candidate.score,
                currentScore: slotPlan.currentScore,
                delta: Number(delta.toFixed(4))
              };
              break;
            }
            if (!choice) continue;
            if (!bestChoice
              || choice.delta > bestChoice.delta
              || (choice.delta === bestChoice.delta && choice.inventorySlot < bestChoice.inventorySlot)) {
              bestChoice = choice;
            }
          }
          if (!bestChoice) break;
          assignedTargetSlots.add(bestChoice.slot);
          usedInventorySlots.add(bestChoice.inventorySlot);
          proposals.push(bestChoice);
        }
      }
      proposals.sort((a, b) => b.priority - a.priority || (b.delta || 0) - (a.delta || 0));
      return { targets: targetRows, proposals };
    }

    _goalPlan(roster, inventoryRows) {
      const results = [];
      const local = this._snapshot();
      const localName = local && local.character && local.character.name;
      for (const goal of this.goals) {
        this.metrics.goalEvaluations += 1;
        const target = (this._priorityTargets(roster)).find(row => row.name === goal.targetName) || null;
        const equipment = this._equipmentSnapshot(goal.targetName);
        const equipped = equipment && equipment.available !== false ? equipment.slots[goal.slot] || null : null;
        const achieved = !!(equipped
          && (!goal.itemName || String(equipped.name) === String(goal.itemName))
          && Math.max(0, Number(equipped.level) || 0) >= goal.minLevel);
        let inventoryMatch = null;
        if (!achieved) {
          const targetCtype = target && target.ctype || equipment && equipment.character && equipment.character.ctype;
          inventoryMatch = inventoryRows.find(row =>
            (!goal.itemName || String(row.name) === String(goal.itemName))
            && Math.max(0, Number(row.level) || 0) >= goal.minLevel
            && this._canEquip(row, goal.slot, targetCtype).ok) || null;
        }
        const localCtype = local && local.character && local.character.ctype;
        const readyToEquip = !!(inventoryMatch && goal.targetName === localName);
        const readyToDeliver = !!(inventoryMatch
          && goal.targetName !== localName
          && String(localCtype || '').toLowerCase() === 'merchant'
          && target && target.role === 'FARMER'
          && equipment && equipment.available !== false
          && !inventoryMatch.locked && !inventoryMatch.giveaway && !inventoryMatch.gift && !inventoryMatch.expiresAt);
        results.push({
          ...clone(goal),
          role: target && target.role || null,
          targetPriority: target && target.priority || 0,
          visible: !!(equipment && equipment.available !== false),
          equipped: equipped ? clone(equipped) : null,
          achieved,
          localInventoryMatch: inventoryMatch ? clone(inventoryMatch) : null,
          state: achieved ? 'ACHIEVED' : readyToEquip ? 'READY_TO_EQUIP' : readyToDeliver ? 'READY_TO_DELIVER' : 'NEEDS_ACQUISITION'
        });
      }
      results.sort((a, b) => b.targetPriority - a.targetPriority || b.priority - a.priority || String(a.id).localeCompare(String(b.id)));
      return results;
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const inventory = this._inventorySnapshot();
      const roster = this._roster();
      if (!snap || !snap.available || !snap.character) {
        const blocked = { state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE' };
        this.lastPlan = blocked;
        return clone(blocked);
      }
      if (!inventory || inventory.available === false) {
        const blocked = { state: 'BLOCKED', reason: 'H14_INVENTORY_UNAVAILABLE' };
        this.lastPlan = blocked;
        return clone(blocked);
      }
      const inventoryRows = this._inventoryGear();
      const local = this._localPlan(inventoryRows);
      const group = this._groupPlan(inventoryRows, roster, snap.character.name, snap.character.ctype);
      const goals = this._goalPlan(roster, inventoryRows);
      this.metrics.localImprovements = local.improvements ? local.improvements.length : 0;
      this.metrics.groupProposals = group.proposals.length;
      const plan = {
        state: local.state === 'READY' ? 'READY' : local.state,
        reason: local.state === 'READY' ? 'H14_GEAR_READY' : local.reason,
        local,
        group,
        goals,
        farmerPriority: 100,
        merchantPriority: 10
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _localWriteAllowed() {
      if (this._combatActive()) {
        this.metrics.combatBlocks += 1;
        return { ok: false, reason: 'H14_COMBAT_ACTIVE' };
      }
      const snap = this._snapshot();
      if (!snap || !snap.available || !snap.character || snap.character.rip) {
        return { ok: false, reason: 'H14_CHARACTER_UNAVAILABLE_OR_DEAD' };
      }
      return { ok: true };
    }

    queueEquip(inventorySlot, targetSlot) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H14_BUSY' };
      const gate = this._localWriteAllowed();
      if (!gate.ok) return { accepted: false, reason: gate.reason };
      const slot = Number(inventorySlot);
      const target = cleanText(targetSlot || '', 40);
      if (!Number.isInteger(slot) || slot < 0 || !GEAR_SLOTS.includes(target)) {
        return { accepted: false, reason: 'H14_EQUIP_ARGUMENT_INVALID' };
      }
      const snap = this._snapshot();
      const inventory = this._inventorySnapshot();
      const equipment = this._equipmentSnapshot(snap.character.name);
      const row = inventory && (inventory.items || []).find(item => Number(item.slot) === slot);
      if (!row) return { accepted: false, reason: 'H14_EQUIP_ITEM_NOT_FOUND' };
      if (row.locked === true || row.giveaway === true || row.gift === true || row.expiresAt) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H14_EQUIP_ITEM_NOT_AUTOMATION_SAFE' };
      }
      const normalized = this._normalizedItem(row);
      const allowed = this._canEquip(normalized, target, snap.character.ctype);
      if (!allowed.ok) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: allowed.reason };
      }
      const conflict = this._handConflict(normalized, target, equipment, snap.character.ctype);
      if (conflict.blocked) {
        if (String(conflict.reason).includes('TWO_HAND')) this.metrics.twoHandBlocks += 1;
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: conflict.reason };
      }
      const current = equipment && equipment.slots ? equipment.slots[target] || null : null;
      const candidateFingerprint = this._fingerprint(normalized);
      if (current && this._fingerprint(current) === candidateFingerprint) {
        return { accepted: false, reason: 'H14_ALREADY_EQUIPPED' };
      }
      this.request = {
        id: 'gear-request-' + (++this.sequence),
        kind: 'EQUIP',
        inventorySlot: slot,
        targetSlot: target,
        candidateFingerprint,
        candidate: clone(normalized),
        currentFingerprint: this._fingerprint(current),
        current: current ? clone(current) : null,
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueBestLocal(slot = null) {
      const plan = this.plan();
      if (plan.state !== 'READY') return { accepted: false, reason: plan.reason };
      const wanted = slot == null ? null : cleanText(slot, 40);
      const proposal = (plan.local.improvements || []).find(row => !wanted || row.slot === wanted);
      if (!proposal || !proposal.bestInventory) return { accepted: false, reason: 'H14_NO_SAFE_LOCAL_IMPROVEMENT' };
      return this.queueEquip(proposal.bestInventory.inventorySlot, proposal.slot);
    }

    queueUnequip(targetSlot) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H14_BUSY' };
      const gate = this._localWriteAllowed();
      if (!gate.ok) return { accepted: false, reason: gate.reason };
      const target = cleanText(targetSlot || '', 40);
      if (!GEAR_SLOTS.includes(target)) return { accepted: false, reason: 'H14_UNEQUIP_ARGUMENT_INVALID' };
      const snap = this._snapshot();
      const equipment = this._equipmentSnapshot(snap.character.name);
      const inventory = this._inventorySnapshot();
      const current = equipment && equipment.slots ? equipment.slots[target] || null : null;
      if (!current) return { accepted: false, reason: 'H14_SLOT_ALREADY_EMPTY' };
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H14_UNEQUIP_NEEDS_FREE_SLOT' };
      }
      this.request = {
        id: 'gear-request-' + (++this.sequence),
        kind: 'UNEQUIP',
        targetSlot: target,
        currentFingerprint: this._fingerprint(current),
        current: clone(current),
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueDelivery(targetName, inventorySlot) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H14_BUSY' };
      const snap = this._snapshot();
      if (!snap || !snap.character || String(snap.character.ctype || '').toLowerCase() !== 'merchant') {
        return { accepted: false, reason: 'H14_DELIVERY_REQUIRES_MERCHANT' };
      }
      const target = cleanText(targetName || '', 120);
      const slot = Number(inventorySlot);
      if (!target || !Number.isInteger(slot) || slot < 0) return { accepted: false, reason: 'H14_DELIVERY_ARGUMENT_INVALID' };
      const roster = this._roster();
      const farmer = roster && (roster.farmers || []).find(row => String(row.name) === target);
      if (!farmer) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H14_DELIVERY_TARGET_NOT_OWN_FARMER' };
      }
      const targetEquipment = this._equipmentSnapshot(target);
      if (!targetEquipment || targetEquipment.available === false) return { accepted: false, reason: 'H14_DELIVERY_TARGET_NOT_VISIBLE' };
      const inventory = this._inventorySnapshot();
      const row = inventory && (inventory.items || []).find(item => Number(item.slot) === slot);
      if (!row) return { accepted: false, reason: 'H14_DELIVERY_ITEM_NOT_FOUND' };
      if (row.locked || row.giveaway || row.gift || row.expiresAt) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H14_DELIVERY_ITEM_NOT_TRANSFER_SAFE' };
      }
      const normalized = this._normalizedItem(row);
      if (!normalized) return { accepted: false, reason: 'H14_DELIVERY_ITEM_NOT_GEAR' };

      let best = null;
      for (const gearSlot of GEAR_SLOTS) {
        const allowed = this._canEquip(normalized, gearSlot, farmer.ctype);
        if (!allowed.ok) continue;
        const current = targetEquipment.slots && targetEquipment.slots[gearSlot] || null;
        const currentScore = current ? this.score(current, farmer.ctype) : Number.NEGATIVE_INFINITY;
        const score = this.score(normalized, farmer.ctype);
        const delta = score - currentScore;
        if (!(current == null || delta > this.config.improvementEpsilon)) continue;
        if (!best || delta > best.delta) best = { slot: gearSlot, current, currentScore, score, delta };
      }
      if (!best) return { accepted: false, reason: 'H14_DELIVERY_NOT_AN_IMPROVEMENT' };
      this.request = {
        id: 'gear-request-' + (++this.sequence),
        kind: 'DELIVERY',
        targetName: target,
        targetCtype: farmer.ctype,
        inventorySlot: slot,
        candidateFingerprint: this._fingerprint(normalized),
        candidate: clone(normalized),
        targetSlot: best.slot,
        scoreDelta: Number(best.delta.toFixed(4)),
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    _metric(kind, suffix) {
      const prefix = { EQUIP: 'equips', UNEQUIP: 'unequips', DELIVERY: 'deliveries' }[kind];
      const key = prefix ? prefix + suffix : null;
      if (key && Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.pending = null;
      this.request = null;
      this.suspendedReason = cleanText(reason || 'H14_UNKNOWN', 240) || 'H14_UNKNOWN';
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
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H14_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dispatch(action, args, pendingBase) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H14_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(pendingBase.kind, result.error && result.error.message || 'H14_DISPATCH_UNKNOWN');
        this._metric(pendingBase.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H14_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'gear-pending-' + (++this.sequence),
        ...pendingBase,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this._metric(pending.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: pending.kind + '_DISPATCHED' };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _observed(pending) {
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) return false;
      const snap = this._snapshot();
      const localName = snap && snap.character && snap.character.name;
      const equipment = localName ? this._equipmentSnapshot(localName) : null;

      if (pending.kind === 'EQUIP') {
        if (!equipment || equipment.available === false) return false;
        const equipped = equipment.slots && equipment.slots[pending.targetSlot] || null;
        if (!equipped || this._fingerprint(equipped) !== pending.candidateFingerprint) return false;
        const candidateAfter = this._quantity(inventory, pending.candidateFingerprint);
        if (candidateAfter == null || candidateAfter > pending.beforeCandidateQuantity - 1) return false;
        if (pending.currentFingerprint) {
          const oldAfter = this._quantity(inventory, pending.currentFingerprint);
          if (oldAfter == null || oldAfter < pending.beforeCurrentQuantity + 1) return false;
        }
        return true;
      }

      if (pending.kind === 'UNEQUIP') {
        if (!equipment || equipment.available === false) return false;
        const equipped = equipment.slots && equipment.slots[pending.targetSlot] || null;
        if (equipped) return false;
        const after = this._quantity(inventory, pending.currentFingerprint);
        return after != null && after >= pending.beforeCurrentQuantity + 1;
      }

      if (pending.kind === 'DELIVERY') {
        const after = this._quantity(inventory, pending.candidateFingerprint);
        return after != null && after <= pending.beforeCandidateQuantity - 1;
      }
      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.settlement === 'REJECTED') return this._suspend(pending.kind, pending.error || 'H14_ACTION_REJECTED');
      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Rejected');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H14_ACTION_REJECTED', 240)
        };
        return true;
      }
      if (this._observed(pending)) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Confirmed');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_CONFIRMED',
          targetSlot: pending.targetSlot || null,
          targetName: pending.targetName || null,
          fingerprint: pending.candidateFingerprint || pending.currentFingerprint || null
        };
        return true;
      }
      if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H14_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      return false;
    }

    _revalidateDelivery(request, inventory) {
      const snap = this._snapshot();
      if (!snap || !snap.character || String(snap.character.ctype || '').toLowerCase() !== 'merchant') {
        return { ok: false, reason: 'H14_DELIVERY_REQUIRES_MERCHANT' };
      }
      const roster = this._roster();
      const farmer = roster && (roster.farmers || []).find(row => String(row.name) === String(request.targetName));
      if (!farmer) return { ok: false, reason: 'H14_DELIVERY_TARGET_NOT_OWN_FARMER' };
      const row = (inventory.items || []).find(item => Number(item.slot) === Number(request.inventorySlot));
      if (!row || this._fingerprint(row) !== request.candidateFingerprint) return { ok: false, reason: 'H14_DELIVERY_SOURCE_CHANGED' };
      if (row.locked || row.giveaway || row.gift || row.expiresAt) return { ok: false, reason: 'H14_DELIVERY_ITEM_NOT_TRANSFER_SAFE' };
      const targetEquipment = this._equipmentSnapshot(request.targetName);
      if (!targetEquipment || targetEquipment.available === false) return { ok: false, reason: 'H14_DELIVERY_TARGET_NOT_VISIBLE' };
      const current = targetEquipment.slots && targetEquipment.slots[request.targetSlot] || null;
      const currentScore = current ? this.score(current, farmer.ctype) : Number.NEGATIVE_INFINITY;
      const candidateScore = this.score(row, farmer.ctype);
      if (!(current == null || candidateScore - currentScore > this.config.improvementEpsilon)) {
        return { ok: false, reason: 'H14_DELIVERY_NO_LONGER_IMPROVEMENT' };
      }
      return { ok: true, row, farmer };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H14_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();

      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) return { state: 'BLOCKED', reason: 'H14_INVENTORY_UNAVAILABLE' };

      if (request.kind === 'EQUIP') {
        const gate = this._localWriteAllowed();
        if (!gate.ok) {
          this.request = null;
          return { state: 'BLOCKED', reason: gate.reason };
        }
        const snap = this._snapshot();
        const equipment = this._equipmentSnapshot(snap.character.name);
        const row = (inventory.items || []).find(item => Number(item.slot) === Number(request.inventorySlot));
        if (!row || this._fingerprint(row) !== request.candidateFingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H14_EQUIP_SOURCE_CHANGED' };
        }
        if (row.locked === true || row.giveaway === true || row.gift === true || row.expiresAt) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          return { state: 'BLOCKED', reason: 'H14_EQUIP_ITEM_NOT_AUTOMATION_SAFE' };
        }
        const allowed = this._canEquip(row, request.targetSlot, snap.character.ctype);
        const conflict = this._handConflict(row, request.targetSlot, equipment, snap.character.ctype);
        if (!allowed.ok || conflict.blocked) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          if (conflict.blocked && String(conflict.reason).includes('TWO_HAND')) this.metrics.twoHandBlocks += 1;
          return { state: 'BLOCKED', reason: conflict.blocked ? conflict.reason : allowed.reason };
        }
        const current = equipment.slots && equipment.slots[request.targetSlot] || null;
        if (this._fingerprint(current) !== request.currentFingerprint) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          return { state: 'BLOCKED', reason: 'H14_EQUIP_TARGET_CHANGED' };
        }
        const beforeCandidateQuantity = this._quantity(inventory, request.candidateFingerprint);
        const beforeCurrentQuantity = request.currentFingerprint ? this._quantity(inventory, request.currentFingerprint) : 0;
        return this._dispatch('equip', [request.inventorySlot, request.targetSlot], {
          kind: request.kind,
          targetSlot: request.targetSlot,
          candidateFingerprint: request.candidateFingerprint,
          currentFingerprint: this._fingerprint(current),
          beforeCandidateQuantity,
          beforeCurrentQuantity: beforeCurrentQuantity == null ? 0 : beforeCurrentQuantity
        });
      }

      if (request.kind === 'UNEQUIP') {
        const gate = this._localWriteAllowed();
        if (!gate.ok) {
          this.request = null;
          return { state: 'BLOCKED', reason: gate.reason };
        }
        const snap = this._snapshot();
        const equipment = this._equipmentSnapshot(snap.character.name);
        const current = equipment.slots && equipment.slots[request.targetSlot] || null;
        if (!current || this._fingerprint(current) !== request.currentFingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H14_UNEQUIP_SOURCE_CHANGED' };
        }
        if (Number(inventory.freeSlots) <= 0) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H14_UNEQUIP_NEEDS_FREE_SLOT' };
        }
        const beforeCurrentQuantity = this._quantity(inventory, request.currentFingerprint);
        return this._dispatch('unequip', [request.targetSlot], {
          kind: request.kind,
          targetSlot: request.targetSlot,
          currentFingerprint: request.currentFingerprint,
          beforeCurrentQuantity: beforeCurrentQuantity == null ? 0 : beforeCurrentQuantity
        });
      }

      if (request.kind === 'DELIVERY') {
        const valid = this._revalidateDelivery(request, inventory);
        if (!valid.ok) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          return { state: 'BLOCKED', reason: valid.reason };
        }
        const beforeCandidateQuantity = this._quantity(inventory, request.candidateFingerprint);
        return this._dispatch('send_item', [request.targetName, request.inventorySlot, 1], {
          kind: request.kind,
          targetName: request.targetName,
          targetSlot: request.targetSlot,
          candidateFingerprint: request.candidateFingerprint,
          beforeCandidateQuantity
        });
      }

      this.request = null;
      return { state: 'BLOCKED', reason: 'H14_REQUEST_UNKNOWN' };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        request: clone(this.request),
        goals: clone(this.goals),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.GearController = GearController;
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
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.attemptsThisSession = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 8000)),
        settleGraceMs: Math.max(100, Math.min(3000, Number(options.settleGraceMs) || 500)),
        maxAttemptsPerSession: Math.max(1, Math.min(100, finite(options.maxAttemptsPerSession) == null ? 12 : finite(options.maxAttemptsPerSession))),
        maxUpgradeLevel: Math.max(0, Math.min(20, finite(options.maxUpgradeLevel) == null ? 8 : finite(options.maxUpgradeLevel))),
        maxCompoundLevel: Math.max(0, Math.min(20, finite(options.maxCompoundLevel) == null ? 4 : finite(options.maxCompoundLevel))),
        maxItemValueAtRisk: Math.max(0, finite(options.maxItemValueAtRisk) == null ? 250000 : finite(options.maxItemValueAtRisk)),
        maxConsumableCost: Math.max(0, finite(options.maxConsumableCost) == null ? 250000 : finite(options.maxConsumableCost)),
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
        safetyBlocks: 0
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

    stop(reason = 'H15_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H15_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H15_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
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
      return !!(row && row.name && row.locked !== true && row.giveaway !== true && row.gift !== true && !row.expiresAt);
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

    _upgradeCandidate(row, inventory, options = {}) {
      if (!this._safeItem(row)) return { ok: false, reason: 'H15_ITEM_NOT_AUTOMATION_SAFE' };
      const definition = this._definition(row.name);
      if (!definition || definition.upgradeable !== true) return { ok: false, reason: 'H15_ITEM_NOT_UPGRADEABLE' };
      if (!this._safeDefinition(definition)) return { ok: false, reason: 'H15_ITEM_DEFINITION_PROTECTED' };
      const level = Math.max(0, Number(row.level) || 0);
      const targetLevel = level + 1;
      const grade = this._grade(definition, level);
      const excluded = new Set([Number(row.slot)]);
      const scrollName = this._scrollName('UPGRADE', grade);
      const scroll = this._findConsumable(inventory, scrollName, excluded);
      if (!scroll) return { ok: false, reason: 'H15_UPGRADE_SCROLL_MISSING', scrollName, grade };
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
        budget
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
      const level = Math.max(0, Number(rows[0].level) || 0);
      const targetLevel = level + 1;
      const grade = this._grade(definition, level);
      const sourceSlots = rows.map(row => Number(row.slot)).sort((a, b) => a - b);
      const excluded = new Set(sourceSlots);
      const scrollName = this._scrollName('COMPOUND', grade);
      const scroll = this._findConsumable(inventory, scrollName, excluded);
      if (!scroll) return { ok: false, reason: 'H15_COMPOUND_SCROLL_MISSING', scrollName, grade };
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
        budget
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
      const upgradeCandidates = [];
      for (const row of rows) {
        const candidate = this._upgradeCandidate(row, inventory);
        if (candidate.ok) upgradeCandidates.push(candidate);
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
          const candidate = this._compoundCandidate(sorted.slice(offset, offset + 3), inventory);
          if (candidate.ok) compoundCandidates.push(candidate);
        }
      }

      upgradeCandidates.sort((a, b) => a.budget.itemValueAtRisk - b.budget.itemValueAtRisk || a.fromLevel - b.fromLevel || a.itemSlot - b.itemSlot);
      compoundCandidates.sort((a, b) => a.budget.itemValueAtRisk - b.budget.itemValueAtRisk || a.fromLevel - b.fromLevel || a.itemSlots[0] - b.itemSlots[0]);

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
        upgradeCandidates: clone(upgradeCandidates),
        compoundCandidates: clone(compoundCandidates)
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
      const budget = this._budget(rows[0], definition, scroll,
        request.offeringSlot == null ? null : this._rowAt(inventory, request.offeringSlot),
        request.targetLevel, request.kind, request.kind === 'COMPOUND' ? 3 : 1);
      if (!budget.ok) return { ok: false, reason: budget.reason };
      return { ok: true };
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
      return this._dispatch(request, inventory);
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        attemptsThisSession: this.attemptsThisSession,
        pending: clone(this.pending),
        request: clone(this.request),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.UpgradeCompoundController = UpgradeCompoundController;
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

  class ExchangeCraftController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.bank = options.bank || null;
      this.trade = options.trade || null;
      this.combat = options.combat || null;
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.attemptsThisSession = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, finite(options.tickMs) == null ? 750 : finite(options.tickMs))),
        outcomeTimeoutMs: Math.max(1500, Math.min(60000, finite(options.outcomeTimeoutMs) == null ? 15000 : finite(options.outcomeTimeoutMs))),
        movementTimeoutMs: Math.max(3000, Math.min(120000, finite(options.movementTimeoutMs) == null ? 60000 : finite(options.movementTimeoutMs))),
        maxAttemptsPerSession: Math.max(1, Math.min(100, Math.floor(finite(options.maxAttemptsPerSession) == null ? 12 : finite(options.maxAttemptsPerSession)))),
        maxExchangeValueAtRisk: Math.max(0, finite(options.maxExchangeValueAtRisk) == null ? 100000 : finite(options.maxExchangeValueAtRisk)),
        maxCraftGoldCost: Math.max(0, finite(options.maxCraftGoldCost) == null ? 250000 : finite(options.maxCraftGoldCost)),
        maxCraftInputValueAtRisk: Math.max(0, finite(options.maxCraftInputValueAtRisk) == null ? 250000 : finite(options.maxCraftInputValueAtRisk)),
        goldReserve: Math.max(0, Math.floor(finite(options.goldReserve) == null ? 10000 : finite(options.goldReserve))),
        maxProductionDepth: Math.max(1, Math.min(12, Math.floor(finite(options.maxProductionDepth) == null ? 6 : finite(options.maxProductionDepth)))),
        allowQuestEvent: options.allowQuestEvent === true
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        productionPlans: 0,
        exchangeCandidates: 0,
        craftCandidates: 0,
        exchangesDispatched: 0,
        exchangesConfirmed: 0,
        exchangesRejected: 0,
        exchangesUnknown: 0,
        craftsDispatched: 0,
        craftsConfirmed: 0,
        craftsRejected: 0,
        craftsUnknown: 0,
        movementRequests: 0,
        movementBlocks: 0,
        budgetBlocks: 0,
        safetyBlocks: 0,
        materialDelegations: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H16_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('exchange-craft-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H16_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H16_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H16_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H16_POLICY_MUST_BE_OBJECT');
      const number = (key, min, max, integer = false) => {
        if (value[key] == null) return;
        const parsed = finite(value[key]);
        if (parsed == null) throw new Error('H16_POLICY_' + key.toUpperCase() + '_INVALID');
        this.config[key] = Math.max(min, Math.min(max, integer ? Math.floor(parsed) : parsed));
      };
      number('maxAttemptsPerSession', 1, 100, true);
      number('maxExchangeValueAtRisk', 0, Number.MAX_SAFE_INTEGER);
      number('maxCraftGoldCost', 0, Number.MAX_SAFE_INTEGER);
      number('maxCraftInputValueAtRisk', 0, Number.MAX_SAFE_INTEGER);
      number('goldReserve', 0, Number.MAX_SAFE_INTEGER, true);
      number('maxProductionDepth', 1, 12, true);
      if (value.allowQuestEvent != null) this.config.allowQuestEvent = value.allowQuestEvent === true;
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

    _bankSnapshot() {
      try { return this.game && this.game.bankSnapshot ? this.game.bankSnapshot() : null; }
      catch (_) { return null; }
    }

    _definition(name) {
      try { return this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null; }
      catch (_) { return null; }
    }

    _recipe(name) {
      try { return this.game && this.game.craftDefinition ? this.game.craftDefinition(name) : null; }
      catch (_) { return null; }
    }

    _recipes() {
      try { return this.game && this.game.craftCatalog ? this.game.craftCatalog() : []; }
      catch (_) { return []; }
    }

    _combatActive() {
      try {
        const status = this.combat && this.combat.status ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _localReady() {
      const snap = this._snapshot();
      if (!snap || !snap.available || !snap.character) return { ok: false, reason: 'H16_CHARACTER_UNAVAILABLE' };
      if (snap.character.rip === true) return { ok: false, reason: 'H16_CHARACTER_DEAD' };
      if (this._combatActive()) return { ok: false, reason: 'H16_COMBAT_ACTIVE' };
      return { ok: true, snapshot: snap };
    }

    _safeItem(row) {
      return !!(row && row.name && row.locked !== true && row.giveaway !== true && row.gift !== true && !row.expiresAt);
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return [
        String(row.name),
        String(Math.max(0, Number(row.level) || 0)),
        cleanText(row.statType != null ? row.statType : row.stat_type || '', 80),
        stableProperty(row.property != null ? row.property : row.p)
      ].join('|');
    }

    _quantity(inventory, name, level = 0) {
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || []).reduce((sum, row) =>
        String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)
          ? sum + Math.max(1, Math.floor(Number(row.quantity) || 1))
          : sum, 0);
    }

    _bankQuantity(bank, name, level = 0) {
      if (!bank || bank.available === false) return 0;
      let total = 0;
      for (const pack of bank.packs || []) {
        for (const row of pack.items || []) {
          if (String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)) {
            total += Math.max(1, Math.floor(Number(row.quantity) || 1));
          }
        }
      }
      return total;
    }

    _rowAt(inventory, slot) {
      return inventory && (inventory.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _itemValue(name, level = 0) {
      const definition = this._definition(name);
      const base = definition && finite(definition.g);
      if (base == null) return null;
      return Math.round(Math.max(0, base) * Math.pow(1.75, Math.max(0, Number(level) || 0)));
    }

    _questEvent(definition, recipe = null) {
      return !!(definition && definition.quest === true || recipe && recipe.quest);
    }

    exchangeCandidates(options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return [];
      const allowQuestEvent = options.allowQuestEvent === true || this.config.allowQuestEvent;
      const out = [];
      for (const row of inventory.items || []) {
        if (!this._safeItem(row)) continue;
        const definition = this._definition(row.name);
        const required = definition && finite(definition.e);
        if (!definition || required == null || required <= 0 || !Number.isInteger(required)) continue;
        if (definition.cash === true) continue;
        const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
        if (quantity < required) continue;
        const unitValue = this._itemValue(row.name, row.level);
        const valueAtRisk = unitValue == null ? null : unitValue * required;
        const questEvent = this._questEvent(definition);
        const budgetOk = valueAtRisk != null && valueAtRisk <= this.config.maxExchangeValueAtRisk;
        out.push({
          kind: 'EXCHANGE',
          item: clone(row),
          inventorySlot: Number(row.slot),
          itemName: row.name,
          level: Math.max(0, Number(row.level) || 0),
          fingerprint: this._fingerprint(row),
          requiredQuantity: required,
          availableQuantity: quantity,
          valueAtRisk,
          questEvent,
          requiresExplicitQuestEvent: questEvent && !allowQuestEvent,
          safe: budgetOk && (!questEvent || allowQuestEvent),
          reason: valueAtRisk == null
            ? 'H16_EXCHANGE_VALUE_UNAVAILABLE'
            : !budgetOk
              ? 'H16_EXCHANGE_VALUE_OVER_BUDGET'
              : questEvent && !allowQuestEvent
                ? 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN'
                : 'H16_EXCHANGE_READY'
        });
      }
      out.sort((a, b) =>
        (a.safe === b.safe ? 0 : a.safe ? -1 : 1)
        || Number(a.valueAtRisk == null ? Number.MAX_SAFE_INTEGER : a.valueAtRisk)
          - Number(b.valueAtRisk == null ? Number.MAX_SAFE_INTEGER : b.valueAtRisk)
        || a.inventorySlot - b.inventorySlot);
      return out;
    }

    _craftSource(recipe, inventory, options = {}) {
      if (!recipe || !Array.isArray(recipe.items) || !recipe.items.length) return { ok: false, reason: 'H16_CRAFT_RECIPE_INVALID' };
      const allowQuestEvent = options.allowQuestEvent === true || this.config.allowQuestEvent;
      if (recipe.quest && !allowQuestEvent) return { ok: false, reason: 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN' };
      const sources = [];
      let inputValueAtRisk = 0;
      for (const ingredient of recipe.items) {
        const required = Math.max(1, Math.floor(Number(ingredient.quantity) || 1));
        const level = Math.max(0, Number(ingredient.level) || 0);
        const matching = (inventory.items || [])
          .filter(row => String(row.name) === String(ingredient.name)
            && Math.max(0, Number(row.level) || 0) === level
            && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= required)
          .sort((a, b) => Number(a.slot) - Number(b.slot));
        const first = matching[0];
        if (!first) return { ok: false, reason: 'H16_CRAFT_MATERIAL_MISSING', ingredient: clone(ingredient) };
        if (!this._safeItem(first)) return { ok: false, reason: 'H16_CRAFT_AUTO_SOURCE_PROTECTED', ingredient: clone(ingredient), slot: first.slot };
        const unitValue = this._itemValue(ingredient.name, level);
        if (unitValue == null) return { ok: false, reason: 'H16_CRAFT_INPUT_VALUE_UNAVAILABLE', ingredient: clone(ingredient) };
        inputValueAtRisk += unitValue * required;
        sources.push({
          slot: Number(first.slot),
          name: first.name,
          level,
          requiredQuantity: required,
          fingerprint: this._fingerprint(first)
        });
      }
      const cost = Math.max(0, finite(recipe.cost) || 0);
      if (cost > this.config.maxCraftGoldCost) return { ok: false, reason: 'H16_CRAFT_GOLD_COST_OVER_BUDGET', cost, inputValueAtRisk };
      if (inputValueAtRisk > this.config.maxCraftInputValueAtRisk) {
        return { ok: false, reason: 'H16_CRAFT_INPUT_VALUE_OVER_BUDGET', cost, inputValueAtRisk };
      }
      const snap = this._snapshot();
      const gold = snap && snap.character && finite(snap.character.gold);
      if (gold == null || gold - cost < this.config.goldReserve) {
        return { ok: false, reason: 'H16_CRAFT_GOLD_RESERVE_BLOCKED', cost, gold, reserve: this.config.goldReserve };
      }
      return { ok: true, sources, cost, inputValueAtRisk };
    }

    craftCandidates(options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return [];
      const out = [];
      for (const recipe of this._recipes()) {
        const source = this._craftSource(recipe, inventory, options);
        const definition = this._definition(recipe.name);
        out.push({
          kind: 'CRAFT',
          itemName: recipe.name,
          recipe: clone(recipe),
          definition: clone(definition),
          questEvent: !!recipe.quest,
          safe: source.ok === true,
          reason: source.reason || 'H16_CRAFT_READY',
          sources: source.sources || [],
          cost: source.cost == null ? Math.max(0, finite(recipe.cost) || 0) : source.cost,
          inputValueAtRisk: source.inputValueAtRisk == null ? null : source.inputValueAtRisk,
          exchangeableOutput: !!(definition && finite(definition.e) != null && finite(definition.e) > 0)
        });
      }
      out.sort((a, b) =>
        (a.safe === b.safe ? 0 : a.safe ? -1 : 1)
        || Number(a.cost || 0) - Number(b.cost || 0)
        || String(a.itemName).localeCompare(String(b.itemName)));
      return out;
    }

    _stockMap(options = {}) {
      const map = new Map();
      const add = (name, level, quantity) => {
        const key = String(name) + '|' + Math.max(0, Number(level) || 0);
        map.set(key, (map.get(key) || 0) + Math.max(0, Math.floor(Number(quantity) || 0)));
      };
      const inventory = this._inventory();
      if (inventory && inventory.available !== false) {
        for (const row of inventory.items || []) add(row.name, row.level, Math.max(1, Number(row.quantity) || 1));
      }
      if (options.includeBank !== false) {
        const bank = this._bankSnapshot();
        if (bank && bank.available !== false) {
          for (const pack of bank.packs || []) {
            for (const row of pack.items || []) add(row.name, row.level, Math.max(1, Number(row.quantity) || 1));
          }
        }
      }
      return map;
    }

    _bankMaterialRows(name, level = 0) {
      const bank = this._bankSnapshot();
      if (!bank || bank.available === false) return [];
      let reservations = {};
      try {
        const status = this.bank && typeof this.bank.status === 'function' ? this.bank.status() : null;
        reservations = status && status.reservations && typeof status.reservations === 'object'
          ? status.reservations
          : {};
      } catch (_) {}
      const wantedLevel = Math.max(0, Number(level) || 0);
      const rows = [];
      for (const pack of bank.packs || []) {
        for (const row of pack.items || []) {
          if (String(row.name) !== String(name)
              || Math.max(0, Number(row.level) || 0) !== wantedLevel) continue;
          rows.push({
            pack: pack.name,
            map: pack.map || null,
            slot: row.slot,
            quantity: Math.max(1, Number(row.quantity) || 1),
            fingerprint: this._fingerprint(row),
            safe: this._safeItem(row),
            locked: row.locked === true,
            giveaway: row.giveaway === true,
            gift: row.gift === true,
            expiresAt: row.expiresAt == null ? null : row.expiresAt
          });
        }
      }
      const reservedQuantity = Math.max(0, Math.floor(Number(reservations[name]) || 0));
      const totals = new Map();
      for (const row of rows) {
        const key = String(row.fingerprint || '');
        totals.set(key, (totals.get(key) || 0) + row.quantity);
      }
      return rows.map(row => {
        const fingerprintQuantity = totals.get(String(row.fingerprint || '')) || 0;
        const remainingAfterWholeStack = Math.max(0, fingerprintQuantity - row.quantity);
        const mountedMapMatch = !!(row.map && bank.map && String(row.map) === String(bank.map));
        return {
          ...row,
          reservedQuantity,
          fingerprintQuantity,
          remainingAfterWholeStack,
          mountedMapMatch,
          withdrawable: row.safe === true
            && mountedMapMatch
            && remainingAfterWholeStack >= reservedQuantity
        };
      });
    }

    _materialSource(name, level, quantity) {
      const bankRows = this._bankMaterialRows(name, level);
      let npcSources = [];
      try { npcSources = this.game && this.game.npcShopSources ? this.game.npcShopSources(name) || [] : []; } catch (_) {}
      let market = null;
      try { market = this.trade && this.trade.marketAnalysis ? this.trade.marketAnalysis(name, { level }) : null; } catch (_) {}
      return {
        itemName: name,
        level,
        quantity,
        bankRows: clone(bankRows),
        npcSources: clone(npcSources),
        npcPrice: finite(this._definition(name) && this._definition(name).g),
        bestMarketAsk: market && market.bestAsk ? clone(market.bestAsk) : null
      };
    }

    productionPlan(itemName, quantity = 1, options = {}) {
      this.metrics.productionPlans += 1;
      const targetName = cleanText(itemName || '', 160);
      const targetQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
      if (!targetName) return { state: 'BLOCKED', reason: 'H16_PRODUCTION_TARGET_REQUIRED' };
      const stock = this._stockMap(options);
      const stages = [];
      const missing = new Map();
      const protectedRecipes = [];
      let totalCraftGold = 0;
      const maxDepth = this.config.maxProductionDepth;
      const allowQuestEvent = options.allowQuestEvent === true || this.config.allowQuestEvent;

      const consume = (name, level, needed) => {
        const key = String(name) + '|' + Math.max(0, Number(level) || 0);
        const available = stock.get(key) || 0;
        const used = Math.min(available, needed);
        if (used > 0) stock.set(key, available - used);
        return needed - used;
      };

      const ensure = (name, level, needed, depth, path, allowStock = true) => {
        let remaining = allowStock ? consume(name, level, needed) : needed;
        if (remaining <= 0) return;
        if (depth > maxDepth || path.includes(name) || level > 0) {
          const key = String(name) + '|' + Math.max(0, Number(level) || 0);
          missing.set(key, (missing.get(key) || 0) + remaining);
          return;
        }
        const recipe = this._recipe(name);
        if (!recipe) {
          const key = String(name) + '|' + Math.max(0, Number(level) || 0);
          missing.set(key, (missing.get(key) || 0) + remaining);
          return;
        }
        if (recipe.quest && !allowQuestEvent) {
          protectedRecipes.push({ name, quest: recipe.quest, quantity: remaining });
          return;
        }
        const runs = remaining;
        for (const ingredient of recipe.items || []) {
          ensure(
            ingredient.name,
            Math.max(0, Number(ingredient.level) || 0),
            Math.max(1, Math.floor(Number(ingredient.quantity) || 1)) * runs,
            depth + 1,
            path.concat([name]),
            true
          );
        }
        const cost = Math.max(0, finite(recipe.cost) || 0) * runs;
        totalCraftGold += cost;
        stages.push({
          itemName: name,
          runs,
          cost,
          quest: recipe.quest || null,
          ingredients: clone(recipe.items || [])
        });
      };

      ensure(targetName, 0, targetQuantity, 0, [], false);
      const missingRows = Array.from(missing.entries()).map(([key, q]) => {
        const split = key.lastIndexOf('|');
        const name = key.slice(0, split);
        const level = Number(key.slice(split + 1)) || 0;
        return this._materialSource(name, level, q);
      });

      const snapshot = this._snapshot();
      const liveGold = snapshot && snapshot.character ? finite(snapshot.character.gold) : null;
      const craftCostOverBudget = totalCraftGold > this.config.maxCraftGoldCost * Math.max(1, targetQuantity);
      const goldUnavailable = liveGold == null;
      const goldReserveBlocked = liveGold != null && liveGold - totalCraftGold < this.config.goldReserve;
      const state = protectedRecipes.length
        ? 'BLOCKED'
        : missingRows.length
          ? 'NEEDS_MATERIALS'
          : craftCostOverBudget || goldUnavailable || goldReserveBlocked
            ? 'BLOCKED'
            : 'READY';
      const reason = protectedRecipes.length
        ? 'H16_PRODUCTION_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN'
        : missingRows.length
          ? 'H16_PRODUCTION_NEEDS_MATERIALS'
          : craftCostOverBudget
            ? 'H16_PRODUCTION_COST_OVER_BUDGET'
            : goldUnavailable
              ? 'H16_PRODUCTION_GOLD_UNAVAILABLE'
              : goldReserveBlocked
                ? 'H16_PRODUCTION_GOLD_RESERVE_BLOCKED'
                : 'H16_PRODUCTION_READY';

      return {
        state,
        reason,
        target: { itemName: targetName, quantity: targetQuantity },
        includeBank: options.includeBank !== false,
        allowQuestEvent,
        maxDepth,
        stages,
        missing: missingRows,
        protectedRecipes,
        totalCraftGold,
        gold: liveGold,
        goldReserve: this.config.goldReserve
      };
    }

    plan() {
      this.metrics.plans += 1;
      const exchangeCandidates = this.exchangeCandidates();
      const craftCandidates = this.craftCandidates();
      this.metrics.exchangeCandidates = exchangeCandidates.length;
      this.metrics.craftCandidates = craftCandidates.length;
      this.lastPlan = {
        state: 'READY',
        reason: 'H16_PLAN_READY',
        exchangeCandidates,
        craftCandidates,
        requestActive: !!this.request,
        pendingActive: !!this.pending,
        policy: clone(this.config)
      };
      return clone(this.lastPlan);
    }

    _queue(request) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H16_BUSY' };
      if (this.attemptsThisSession >= this.config.maxAttemptsPerSession) {
        this.metrics.budgetBlocks += 1;
        return { accepted: false, reason: 'H16_SESSION_ATTEMPT_BUDGET_EXHAUSTED' };
      }
      this.request = {
        id: 'h16-request-' + (++this.sequence),
        createdAt: nowIso(),
        travelRequested: false,
        travelStartedAtMs: null,
        ...clone(request)
      };
      this.lastAction = { at: nowIso(), type: request.kind + '_QUEUED', requestId: this.request.id };
      return { accepted: true, request: clone(this.request) };
    }

    queueExchange(inventorySlot, options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { accepted: false, reason: 'H16_INVENTORY_UNAVAILABLE' };
      const slot = finite(inventorySlot);
      if (slot == null) return { accepted: false, reason: 'H16_EXCHANGE_SLOT_REQUIRED' };
      const candidate = this.exchangeCandidates({ allowQuestEvent: options.allowQuestEvent === true })
        .find(row => Number(row.inventorySlot) === Number(slot));
      if (!candidate) return { accepted: false, reason: 'H16_EXCHANGE_CANDIDATE_UNAVAILABLE' };
      if (!candidate.safe) {
        if (String(candidate.reason).includes('BUDGET') || String(candidate.reason).includes('VALUE')) this.metrics.budgetBlocks += 1;
        else this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: candidate.reason };
      }
      const destination = this.game && this.game.npcLocation ? this.game.npcLocation('exchange') : null;
      if (!destination) return { accepted: false, reason: 'H16_EXCHANGE_NPC_LOCATION_UNAVAILABLE' };
      return this._queue({
        kind: 'EXCHANGE',
        inventorySlot: candidate.inventorySlot,
        itemName: candidate.itemName,
        level: candidate.level,
        fingerprint: candidate.fingerprint,
        requiredQuantity: candidate.requiredQuantity,
        valueAtRisk: candidate.valueAtRisk,
        questEvent: candidate.questEvent,
        allowQuestEvent: options.allowQuestEvent === true,
        destination: clone(destination)
      });
    }

    queueCraft(itemName, options = {}) {
      const name = cleanText(itemName || '', 160);
      const inventory = this._inventory();
      if (!name || !inventory || inventory.available === false) return { accepted: false, reason: 'H16_CRAFT_TARGET_UNAVAILABLE' };
      const recipe = this._recipe(name);
      if (!recipe) return { accepted: false, reason: 'H16_CRAFT_RECIPE_UNAVAILABLE' };
      const source = this._craftSource(recipe, inventory, { allowQuestEvent: options.allowQuestEvent === true });
      if (!source.ok) {
        if (String(source.reason).includes('BUDGET') || String(source.reason).includes('VALUE') || String(source.reason).includes('GOLD')) this.metrics.budgetBlocks += 1;
        else this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: source.reason, details: clone(source) };
      }
      const destination = this.game && this.game.npcLocation ? this.game.npcLocation('craftsman') : null;
      if (!destination) return { accepted: false, reason: 'H16_CRAFT_NPC_LOCATION_UNAVAILABLE' };
      return this._queue({
        kind: 'CRAFT',
        itemName: name,
        recipe: clone(recipe),
        sources: clone(source.sources),
        cost: source.cost,
        inputValueAtRisk: source.inputValueAtRisk,
        questEvent: !!recipe.quest,
        allowQuestEvent: options.allowQuestEvent === true,
        destination: clone(destination)
      });
    }

    queueBest(kind = null) {
      const plan = this.plan();
      const wanted = kind == null ? null : String(kind).toUpperCase();
      if (wanted === 'EXCHANGE') {
        const candidate = (plan.exchangeCandidates || []).find(row => row.safe);
        return candidate ? this.queueExchange(candidate.inventorySlot) : { accepted: false, reason: 'H16_NO_SAFE_EXCHANGE_CANDIDATE' };
      }
      if (wanted === 'CRAFT') {
        const candidate = (plan.craftCandidates || []).find(row => row.safe);
        return candidate ? this.queueCraft(candidate.itemName) : { accepted: false, reason: 'H16_NO_SAFE_CRAFT_CANDIDATE' };
      }
      const craft = (plan.craftCandidates || []).find(row => row.safe);
      if (craft) return this.queueCraft(craft.itemName);
      const exchange = (plan.exchangeCandidates || []).find(row => row.safe);
      return exchange ? this.queueExchange(exchange.inventorySlot) : { accepted: false, reason: 'H16_NO_SAFE_CANDIDATE' };
    }

    queueMaterialAcquire(itemName, quantity = 1, options = {}) {
      const name = cleanText(itemName || '', 160);
      const rawQuantity = finite(quantity);
      if (!name) return { accepted: false, reason: 'H16_MATERIAL_NAME_REQUIRED' };
      if (rawQuantity == null || rawQuantity <= 0 || !Number.isInteger(rawQuantity)) {
        return { accepted: false, reason: 'H16_MATERIAL_QUANTITY_INVALID' };
      }
      const q = rawQuantity;

      let lastRecoverableBankReject = null;
      if (options.allowBank !== false && this.bank && typeof this.bank.queueWithdraw === 'function') {
        const recoverableBankReasons = new Set([
          'H12_WITHDRAW_WRONG_OR_UNKNOWN_BANK_MAP',
          'H12_BANK_RESERVATION_BLOCKED',
          'H12_WITHDRAW_ITEM_NOT_FOUND'
        ]);
        const minBankStackQuantity = Math.max(
          q,
          Math.floor(finite(options.minBankStackQuantity) == null ? q : finite(options.minBankStackQuantity))
        );
        const bankRows = this._bankMaterialRows(name, options.level || 0)
          .filter(row => row.withdrawable === true && row.quantity >= minBankStackQuantity);
        for (const row of bankRows) {
          const result = this.bank.queueWithdraw(row.pack, row.slot);
          if (result && result.accepted) {
            this.metrics.materialDelegations += 1;
            return {
              ...clone(result),
              delegatedTo: 'bank',
              source: { pack: row.pack, map: row.map || null, slot: row.slot }
            };
          }
          const reason = result && result.reason || 'H16_BANK_WITHDRAW_REJECTED';
          if (!recoverableBankReasons.has(String(reason))) {
            return {
              ...clone(result || { accepted: false, reason }),
              delegatedTo: 'bank',
              source: { pack: row.pack, map: row.map || null, slot: row.slot }
            };
          }
          lastRecoverableBankReject = {
            ...clone(result || { accepted: false, reason }),
            delegatedTo: 'bank',
            source: { pack: row.pack, map: row.map || null, slot: row.slot }
          };
        }
      }

      if (this.trade && typeof this.trade.queueAcquire === 'function') {
        const maxUnitPrice = finite(options.maxUnitPrice);
        if (maxUnitPrice == null || maxUnitPrice <= 0) {
          return { accepted: false, reason: 'H16_MAX_UNIT_PRICE_REQUIRED_FOR_TRADE_ACQUISITION' };
        }
        const result = this.trade.queueAcquire(name, q, { maxUnitPrice, level: options.level || 0 });
        if (result && result.accepted) this.metrics.materialDelegations += 1;
        return { ...clone(result), delegatedTo: 'trade' };
      }

      if (lastRecoverableBankReject) return lastRecoverableBankReject;
      return { accepted: false, reason: 'H16_MATERIAL_ACQUISITION_UNAVAILABLE' };
    }

    _cancelOwnedMovement(reason) {
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'exchange-craft-h16') {
          this.movement.cancel(cleanText(reason, 180) || 'H16_CANCEL');
        }
      } catch (_) {}
    }

    _ensureTravel(request) {
      let movement = null;
      try { movement = this.movement && this.movement.status ? this.movement.status() : null; } catch (_) {}
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '') === 'exchange-craft-h16'
            && (!request.travelOrderId || String(movement.activeOrder.id) === String(request.travelOrderId))) {
          return { ready: false, waiting: true };
        }
        this.metrics.movementBlocks += 1;
        return { ready: false, waiting: true, reason: 'H16_MOVEMENT_OWNED_BY_OTHER' };
      }
      if (request.travelRequested) {
        const last = movement && movement.lastOrder || null;
        if (last && String(last.id || '') === String(request.travelOrderId || '')
            && String(last.owner || '') === 'exchange-craft-h16') {
          if (last.state === 'COMPLETED') return { ready: true };
          if (['CANCELLED', 'STUCK', 'UNKNOWN', 'FAILED_SAFE'].includes(String(last.state || ''))) {
            return this._suspend(request.kind, 'H16_MOVEMENT_' + String(last.state || 'UNKNOWN'));
          }
        }
        if (Date.now() - request.travelStartedAtMs > this.config.movementTimeoutMs) {
          return this._suspend(request.kind, 'H16_MOVEMENT_TIMEOUT');
        }
        return { ready: false, waiting: true, reason: 'H16_WAITING_FOR_ARRIVAL_EVIDENCE' };
      }
      if (!request.destination) return this._suspend(request.kind, 'H16_DESTINATION_UNAVAILABLE');
      if (!this.movement || typeof this.movement.smartMove !== 'function') {
        return this._suspend(request.kind, 'H16_MOVEMENT_UNAVAILABLE');
      }
      const moved = this.movement.smartMove(request.destination, { owner: 'exchange-craft-h16' });
      if (!moved || moved.accepted !== true || !moved.order || !moved.order.id) {
        this.metrics.movementBlocks += 1;
        return this._suspend(request.kind, moved && moved.reason || 'H16_MOVEMENT_REJECTED');
      }
      request.travelRequested = true;
      request.travelStartedAtMs = Date.now();
      request.travelOrderId = moved.order.id;
      this.metrics.movementRequests += 1;
      this.lastAction = { at: nowIso(), type: request.kind + '_MOVE_REQUESTED', destination: request.destination, orderId: request.travelOrderId };
      return { ready: false, waiting: true };
    }

    _metric(kind, suffix) {
      const prefix = kind === 'CRAFT' ? 'crafts' : 'exchanges';
      const key = prefix + suffix;
      if (Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.suspendedReason = cleanText(reason || ('H16_' + kind + '_UNKNOWN'), 300);
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(this.suspendedReason);
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
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H16_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dispatch(request, inventory) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') return { accepted: false, reason: 'H16_ACTION_BOUNDARY_UNAVAILABLE' };
      let action = null;
      let args = null;
      const beforeGold = this._snapshot() && this._snapshot().character ? finite(this._snapshot().character.gold) : null;
      const pendingBase = {
        kind: request.kind,
        itemName: request.itemName,
        beforeGold
      };
      if (request.kind === 'EXCHANGE') {
        action = 'exchange';
        args = [request.inventorySlot];
        pendingBase.inventorySlot = request.inventorySlot;
        pendingBase.level = request.level;
        pendingBase.requiredQuantity = request.requiredQuantity;
        pendingBase.beforeSourceQuantity = this._quantity(inventory, request.itemName, request.level);
        pendingBase.valueAtRisk = request.valueAtRisk;
      } else if (request.kind === 'CRAFT') {
        action = 'auto_craft';
        args = [request.itemName];
        pendingBase.recipe = clone(request.recipe);
        pendingBase.sources = clone(request.sources);
        pendingBase.cost = request.cost;
        pendingBase.inputValueAtRisk = request.inputValueAtRisk;
        pendingBase.beforeOutputQuantity = this._quantity(inventory, request.itemName, 0);
        pendingBase.beforeIngredients = (request.recipe.items || []).map(ingredient => ({
          name: ingredient.name,
          level: Math.max(0, Number(ingredient.level) || 0),
          requiredQuantity: Math.max(1, Math.floor(Number(ingredient.quantity) || 1)),
          quantity: this._quantity(inventory, ingredient.name, ingredient.level || 0)
        }));
      } else {
        return { accepted: false, reason: 'H16_REQUEST_KIND_INVALID' };
      }

      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(request.kind, result.error && result.error.message || 'H16_DISPATCH_UNKNOWN');
        this._metric(request.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H16_ACTION_REJECTED' };
      }

      const now = Date.now();
      const pending = {
        id: 'h16-pending-' + (++this.sequence),
        ...pendingBase,
        requestId: request.id,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this.attemptsThisSession += 1;
      this._metric(request.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: request.kind + '_DISPATCHED', requestId: request.id };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _knownReject(pending, reason) {
      this.pending = null;
      this.request = null;
      this._metric(pending.kind, 'Rejected');
      this.lastAction = { at: nowIso(), type: pending.kind + '_REJECTED', reason: cleanText(reason || 'H16_ACTION_REJECTED', 300) };
      return true;
    }

    _confirmed(pending, details = {}) {
      this.pending = null;
      this.request = null;
      this._metric(pending.kind, 'Confirmed');
      this.lastAction = { at: nowIso(), type: pending.kind + '_CONFIRMED', ...clone(details) };
      return true;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) {
        if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H16_INVENTORY_UNAVAILABLE_DURING_OUTCOME');
        return false;
      }

      const settlementFinished = pending.settlement !== 'PENDING';

      if (pending.kind === 'EXCHANGE') {
        const after = this._quantity(inventory, pending.itemName, pending.level || 0);
        if (settlementFinished && after != null && pending.beforeSourceQuantity != null && after <= pending.beforeSourceQuantity - pending.requiredQuantity) {
          return this._confirmed(pending, {
            itemName: pending.itemName,
            evidence: 'EXCHANGE_SOURCE_QUANTITY_DELTA',
            reward: pending.response && pending.response.reward || null
          });
        }
      }

      if (pending.kind === 'CRAFT') {
        const output = this._quantity(inventory, pending.itemName, 0);
        const outputIncreased = output != null && pending.beforeOutputQuantity != null && output >= pending.beforeOutputQuantity + 1;
        const ingredientsConsumed = (pending.beforeIngredients || []).every(before => {
          const after = this._quantity(inventory, before.name, before.level);
          return after != null && before.quantity != null && after <= before.quantity - before.requiredQuantity;
        });
        const snap = this._snapshot();
        const gold = snap && snap.character ? finite(snap.character.gold) : null;
        const goldOk = Number(pending.cost || 0) <= 0
          || (gold != null && pending.beforeGold != null && gold <= pending.beforeGold - Number(pending.cost || 0));
        if (settlementFinished && outputIncreased && ingredientsConsumed && goldOk) {
          return this._confirmed(pending, { itemName: pending.itemName, evidence: 'CRAFT_OUTPUT_AND_INPUT_DELTAS' });
        }
      }

      if (pending.response && (pending.response.failed === true || pending.response.success === false)) {
        return this._knownReject(pending, pending.response.reason || 'H16_ACTION_REJECTED');
      }
      if (pending.settlement === 'REJECTED') {
        return this._suspend(pending.kind, pending.error || 'H16_ACTION_REJECTED_WITHOUT_LIVE_OUTCOME');
      }
      if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H16_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      return false;
    }

    _revalidateExchange(request, inventory) {
      const row = this._rowAt(inventory, request.inventorySlot);
      if (!row || this._fingerprint(row) !== request.fingerprint) return { ok: false, reason: 'H16_EXCHANGE_SOURCE_CHANGED' };
      if (!this._safeItem(row)) return { ok: false, reason: 'H16_EXCHANGE_SOURCE_PROTECTED' };
      const definition = this._definition(row.name);
      const required = definition && finite(definition.e);
      if (required == null || required !== request.requiredQuantity) return { ok: false, reason: 'H16_EXCHANGE_DEFINITION_CHANGED' };
      if (Math.max(1, Number(row.quantity) || 1) < required) return { ok: false, reason: 'H16_EXCHANGE_QUANTITY_CHANGED' };
      if (definition.cash === true) return { ok: false, reason: 'H16_EXCHANGE_CASH_ITEM_BLOCKED' };
      if (this._questEvent(definition) && !(request.allowQuestEvent || this.config.allowQuestEvent)) {
        return { ok: false, reason: 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN' };
      }
      const value = this._itemValue(row.name, row.level);
      const risk = value == null ? null : value * required;
      if (risk == null || risk > this.config.maxExchangeValueAtRisk) return { ok: false, reason: 'H16_EXCHANGE_VALUE_OVER_BUDGET' };
      return { ok: true };
    }

    _revalidateCraft(request, inventory) {
      const recipe = this._recipe(request.itemName);
      if (!recipe || JSON.stringify(recipe.items || []) !== JSON.stringify(request.recipe.items || [])) {
        return { ok: false, reason: 'H16_CRAFT_RECIPE_CHANGED' };
      }
      const source = this._craftSource(recipe, inventory, { allowQuestEvent: request.allowQuestEvent === true });
      if (!source.ok) return { ok: false, reason: source.reason };
      const expected = (request.sources || []).map(row => row.slot).join(',');
      const current = (source.sources || []).map(row => row.slot).join(',');
      if (expected !== current) return { ok: false, reason: 'H16_CRAFT_AUTO_SOURCE_CHANGED' };
      return { ok: true };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H16_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();

      const gate = this._localReady();
      if (!gate.ok) {
        this.request = null;
        this._cancelOwnedMovement(gate.reason || 'H16_SAFETY_GATE_BLOCKED');
        this.metrics.safetyBlocks += 1;
        return { state: 'BLOCKED', reason: gate.reason };
      }
      if (this.attemptsThisSession >= this.config.maxAttemptsPerSession) {
        this.request = null;
        this.metrics.budgetBlocks += 1;
        return { state: 'BLOCKED', reason: 'H16_SESSION_ATTEMPT_BUDGET_EXHAUSTED' };
      }

      const travel = this._ensureTravel(request);
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (!travel || travel.ready !== true) return { state: 'WAITING_TRAVEL', reason: travel && travel.reason || 'H16_TRAVEL' };

      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { state: 'BLOCKED', reason: 'H16_INVENTORY_UNAVAILABLE' };
      const valid = request.kind === 'EXCHANGE'
        ? this._revalidateExchange(request, inventory)
        : request.kind === 'CRAFT'
          ? this._revalidateCraft(request, inventory)
          : { ok: false, reason: 'H16_REQUEST_KIND_INVALID' };
      if (!valid.ok) {
        this.request = null;
        this.metrics.safetyBlocks += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_BLOCKED', reason: valid.reason };
        return { state: 'BLOCKED', reason: valid.reason };
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
        pending: clone(this.pending),
        request: clone(this.request),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.ExchangeCraftController = ExchangeCraftController;
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

  function nowIso() {
    return new Date().toISOString();
  }

  const DEFAULT_PRIORITIES = Object.freeze({
    BANK_MOUNT: 110,
    BANK_DEPOSIT: 100,
    GEAR_EQUIP: 90,
    MARKET_SELL: 75,
    EXCHANGE: 70,
    CRAFT: 65,
    UPGRADE: 55,
    COMPOUND: 50,
    NPC_SELL: 40
  });

  const DEFAULT_KINDS = Object.freeze({
    BANK_MOUNT: true,
    BANK_DEPOSIT: true,
    GEAR_EQUIP: true,
    MARKET_SELL: true,
    EXCHANGE: true,
    CRAFT: true,
    UPGRADE: true,
    COMPOUND: true,
    NPC_SELL: true
  });

  class EconomyController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.movement = options.movement || null;
      this.combat = options.combat || null;
      this.inventory = options.inventory || null;
      this.merchant = options.merchant || null;
      this.bank = options.bank || null;
      this.trade = options.trade || null;
      this.gear = options.gear || null;
      this.upgrade = options.upgrade || null;
      this.exchangeCraft = options.exchangeCraft || null;
      this.partyLogistics = options.partyLogistics || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : null;

      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.scope = null;
      this.suspendedReason = null;
      this.currentAction = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.rejectionBackoff = new Map();

      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 1000)),
        actionCooldownMs: Math.max(0, Math.min(60000, Number(options.actionCooldownMs) || 1500)),
        rejectionBackoffMs: Math.max(1000, Math.min(300000, Number(options.rejectionBackoffMs) || 15000)),
        actionTimeoutMs: Math.max(5000, Math.min(300000, Number(options.actionTimeoutMs) || 120000)),
        maxActionsPerSession: Math.max(1, Math.min(100, Math.floor(Number(options.maxActionsPerSession) || 12))),
        minMarketPremiumRatio: Math.max(1, Math.min(10, finite(options.minMarketPremiumRatio) == null ? 1 : finite(options.minMarketPremiumRatio))),
        priorities: { ...DEFAULT_PRIORITIES, ...(options.priorities || {}) },
        allowKinds: { ...DEFAULT_KINDS, ...(options.allowKinds || {}) }
      };

      this.metrics = {
        ticks: 0,
        plans: 0,
        proposals: 0,
        conflictBlocks: 0,
        combatBlocks: 0,
        movementBlocks: 0,
        actionsQueued: 0,
        actionsConfirmed: 0,
        actionsRejected: 0,
        actionsUnknown: 0,
        rejectionBackoffs: 0,
        sessionBudgetBlocks: 0,
        byKind: {}
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H17_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      this.autonomyEnabled = false;
      this.currentAction = null;
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.rejectionBackoff.clear();
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('economy-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H17_MODULE_STOP') {
      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.scope = null;
      this.currentAction = null;
      this.cooldownUntilMs = null;
      this.rejectionBackoff.clear();
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H17_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.currentAction) return { accepted: false, reason: 'H17_ACTION_ACTIVE' };
      if (this.canAct && this.canAct('economy') !== true) return { accepted: false, reason: 'H17_RUNTIME_ACTION_BLOCKED' };
      if (options.maxActions != null) {
        this.config.maxActionsPerSession = Math.max(1, Math.min(100, Math.floor(Number(options.maxActions) || 1)));
      }
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.autonomyEnabled = true;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STARTED', maxActions: this.config.maxActionsPerSession };
      return { accepted: true, status: this.status() };
    }

    stopAutonomy(reason = 'H17_AUTONOMY_STOP') {
      this.autonomyEnabled = false;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STOPPED', reason: cleanText(reason, 240) };
      return this.status();
    }

    resetSafety(reason = 'H17_EXPLICIT_RESET') {
      if (this.currentAction) {
        this.lastAction = { at: nowIso(), type: 'RESET_BLOCKED', reason: 'H17_ACTION_ACTIVE' };
        return { ...this.status(), reset: false, reason: 'H17_ACTION_ACTIVE' };
      }
      this.suspendedReason = null;
      this.autonomyEnabled = false;
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.rejectionBackoff.clear();
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H17_POLICY_MUST_BE_OBJECT');
      if (value.maxActionsPerSession != null) this.config.maxActionsPerSession = Math.max(1, Math.min(100, Math.floor(Number(value.maxActionsPerSession) || 1)));
      if (value.actionCooldownMs != null) this.config.actionCooldownMs = Math.max(0, Math.min(60000, Math.floor(Number(value.actionCooldownMs) || 0)));
      if (value.rejectionBackoffMs != null) this.config.rejectionBackoffMs = Math.max(1000, Math.min(300000, Math.floor(Number(value.rejectionBackoffMs) || 1000)));
      if (value.actionTimeoutMs != null) this.config.actionTimeoutMs = Math.max(5000, Math.min(300000, Math.floor(Number(value.actionTimeoutMs) || 5000)));
      if (value.minMarketPremiumRatio != null) this.config.minMarketPremiumRatio = Math.max(1, Math.min(10, Number(value.minMarketPremiumRatio) || 1));
      if (value.priorities && typeof value.priorities === 'object') {
        for (const [kind, priority] of Object.entries(value.priorities)) {
          if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRIORITIES, kind)) continue;
          this.config.priorities[kind] = Math.max(0, Math.min(1000, Math.floor(Number(priority) || 0)));
        }
      }
      if (value.allowKinds && typeof value.allowKinds === 'object') {
        for (const [kind, allowed] of Object.entries(value.allowKinds)) {
          if (!Object.prototype.hasOwnProperty.call(DEFAULT_KINDS, kind)) continue;
          this.config.allowKinds[kind] = allowed === true;
        }
      }
      return clone(this.config);
    }

    _snapshot() {
      try { return this.game && this.game.snapshot ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _movementStatus() {
      try { return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null; }
      catch (_) { return null; }
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || (status.state && !['IDLE', 'STOPPED'].includes(String(status.state)))));
      } catch (_) {
        return false;
      }
    }

    _callPlan(controller) {
      try { return controller && typeof controller.plan === 'function' ? controller.plan() : null; }
      catch (error) { return { state: 'BLOCKED', reason: cleanText(error && error.message || error, 240) }; }
    }

    _status(controller) {
      try { return controller && typeof controller.status === 'function' ? controller.status() : null; }
      catch (_) { return null; }
    }

    _lastActionSignature(status) {
      const row = status && status.lastAction;
      if (!row) return null;
      return [row.at || '', row.type || '', row.reason || ''].join('|');
    }

    _childRows() {
      return [
        { name: 'inventory', controller: this.inventory },
        { name: 'merchant', controller: this.merchant },
        { name: 'bank', controller: this.bank },
        { name: 'trade', controller: this.trade },
        { name: 'gear', controller: this.gear },
        { name: 'upgrade', controller: this.upgrade },
        { name: 'exchangeCraft', controller: this.exchangeCraft },
        { name: 'partyLogistics', controller: this.partyLogistics }
      ];
    }

    _childSnapshot() {
      const output = {};
      for (const row of this._childRows()) output[row.name] = this._status(row.controller);
      return output;
    }

    _childBusy(child) {
      return !!(child && (
        child.pending
        || child.request
        || child.delivery
        || child.pendingLoot
        || child.currentAction
        || child.autonomyEnabled
        || Array.isArray(child.queue) && child.queue.length
      ));
    }

    _proposal(kind, module, details = {}) {
      if (this.config.allowKinds[kind] !== true) return null;
      const id = 'h17-proposal-' + kind + '-' + cleanText(details.key || details.itemName || details.slot || '', 120);
      const blockedUntil = Number(this.rejectionBackoff.get(id) || 0);
      if (blockedUntil > Date.now()) return null;
      if (blockedUntil) this.rejectionBackoff.delete(id);
      return {
        id,
        kind,
        module,
        priority: Number(this.config.priorities[kind] || 0),
        risk: Math.max(0, finite(details.risk) || 0),
        ...clone(details)
      };
    }

    _marketSellProposal(row) {
      if (!row || !row.name || !this.trade || typeof this.trade.marketAnalysis !== 'function') return null;
      let analysis = null;
      try { analysis = this.trade.marketAnalysis(row.name, { level: Math.max(0, Number(row.level) || 0) }); } catch (_) {}
      const bid = analysis && analysis.bestBid || null;
      const price = finite(bid && bid.price);
      const definition = this.game && typeof this.game.itemDefinition === 'function' ? this.game.itemDefinition(row.name) : null;
      const npcPrice = finite(definition && definition.g);
      if (!bid || !bid.rid || price == null || price <= 0 || npcPrice == null || npcPrice < 0) return null;
      const minimum = npcPrice * this.config.minMarketPremiumRatio;
      if (price < minimum) return null;
      const quantity = Math.min(
        Math.max(1, Math.floor(Number(row.quantity) || 1)),
        Math.max(1, Math.floor(Number(bid.quantity) || 1))
      );
      return this._proposal('MARKET_SELL', 'trade', {
        key: row.name + ':' + row.slot,
        itemName: row.name,
        inventorySlot: Number(row.slot),
        quantity,
        playerName: bid.playerName,
        tradeSlot: bid.slot,
        minUnitPrice: minimum,
        unitPrice: price,
        risk: 0
      });
    }

    _npcSellProposal(row) {
      if (!row || !row.name) return null;
      let location = null;
      try { location = this.game && typeof this.game.npcLocation === 'function' ? this.game.npcLocation('fancypots') : null; } catch (_) {}
      if (!location) return null;
      return this._proposal('NPC_SELL', 'trade', {
        key: row.name + ':' + row.slot,
        itemName: row.name,
        inventorySlot: Number(row.slot),
        quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
        risk: 0
      });
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const children = this._childSnapshot();
      const movement = this._movementStatus();
      const proposals = [];
      const blockers = [];

      if (this.suspendedReason) {
        const plan = { state: 'SUSPENDED', reason: this.suspendedReason, selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (!snap || !snap.available || !snap.character) {
        const plan = { state: 'BLOCKED', reason: 'H17_CHARACTER_UNAVAILABLE', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (snap.character.rip === true) {
        const plan = { state: 'BLOCKED', reason: 'H17_CHARACTER_DEAD', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (String(snap.character.ctype || '').toLowerCase() !== 'merchant') {
        const plan = { state: 'BLOCKED', reason: 'H17_REQUIRES_MERCHANT', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (this.canAct && this.canAct('economy') !== true) {
        const plan = { state: 'BLOCKED', reason: 'H17_RUNTIME_ACTION_BLOCKED', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (this._combatActive()) {
        this.metrics.combatBlocks += 1;
        const plan = { state: 'BLOCKED', reason: 'H17_COMBAT_ACTIVE', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      for (const [name, status] of Object.entries(children)) {
        if (status && status.suspended) blockers.push({ module: name, reason: status.suspendedReason || status.reason || 'SUSPENDED' });
      }
      if (blockers.length) {
        const plan = { state: 'BLOCKED', reason: 'H17_CHILD_SUSPENDED', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      if (!this.currentAction && movement && movement.activeOrder) {
        this.metrics.movementBlocks += 1;
        const plan = {
          state: 'WAITING',
          reason: 'H17_MOVEMENT_OWNED',
          selected: null,
          proposals,
          blockers: [{ module: 'movement', reason: 'ACTIVE_ORDER', owner: movement.activeOrder.owner || null }],
          children
        };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      const busyChildren = Object.entries(children)
        .filter(([, status]) => this._childBusy(status))
        .map(([module, status]) => ({ module, reason: 'BUSY', lastAction: status && status.lastAction || null }));
      if (!this.currentAction && busyChildren.length) {
        this.metrics.conflictBlocks += 1;
        const plan = { state: 'WAITING', reason: 'H17_CHILD_BUSY', selected: null, proposals, blockers: busyChildren, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      const merchantPlan = this._callPlan(this.merchant);
      const bankPlan = this._callPlan(this.bank);
      const tradePlan = this._callPlan(this.trade);
      const gearPlan = this._callPlan(this.gear);
      const upgradePlan = this._callPlan(this.upgrade);
      const exchangePlan = this._callPlan(this.exchangeCraft);

      const pressure = merchantPlan && merchantPlan.pressure && merchantPlan.pressure.state || 'NORMAL';
      const bankRows = bankPlan && bankPlan.safeDepositRows || [];
      if (['HIGH', 'CRITICAL'].includes(String(pressure)) && bankRows.length) {
        if (bankPlan && bankPlan.state === 'NEEDS_BANK') {
          const proposal = this._proposal('BANK_MOUNT', 'bank', { key: 'bank', pressure, risk: 0 });
          if (proposal) proposals.push(proposal);
        } else if (bankPlan && bankPlan.state === 'READY') {
          const row = bankRows[0];
          const proposal = this._proposal('BANK_DEPOSIT', 'bank', {
            key: row.name + ':' + row.slot,
            itemName: row.name,
            inventorySlot: Number(row.slot),
            quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
            pressure,
            risk: 0
          });
          if (proposal) proposals.push(proposal);
        }
      }

      const improvement = gearPlan && gearPlan.local && (gearPlan.local.improvements || [])[0] || null;
      if (improvement && improvement.bestInventory) {
        const proposal = this._proposal('GEAR_EQUIP', 'gear', {
          key: improvement.slot,
          slot: improvement.slot,
          inventorySlot: Number(improvement.bestInventory.inventorySlot),
          itemName: improvement.bestInventory.item && improvement.bestInventory.item.name || null,
          delta: finite(improvement.delta) || 0,
          risk: Math.max(0, finite(improvement.bestInventory.item && improvement.bestInventory.item.definition && improvement.bestInventory.item.definition.g) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const safeExchange = exchangePlan && (exchangePlan.exchangeCandidates || []).find(row => row && row.safe === true) || null;
      if (safeExchange) {
        const proposal = this._proposal('EXCHANGE', 'exchangeCraft', {
          key: safeExchange.itemName + ':' + safeExchange.inventorySlot,
          itemName: safeExchange.itemName,
          inventorySlot: Number(safeExchange.inventorySlot),
          quantity: Math.max(1, Math.floor(Number(safeExchange.requiredQuantity) || 1)),
          risk: Math.max(0, finite(safeExchange.valueAtRisk) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const safeCraft = exchangePlan && (exchangePlan.craftCandidates || []).find(row => row && row.safe === true) || null;
      if (safeCraft) {
        const proposal = this._proposal('CRAFT', 'exchangeCraft', {
          key: safeCraft.itemName,
          itemName: safeCraft.itemName,
          risk: Math.max(0, finite(safeCraft.inputValueAtRisk) || 0),
          goldCost: Math.max(0, finite(safeCraft.cost) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const upgradeCandidate = upgradePlan && (upgradePlan.upgradeCandidates || [])[0] || null;
      if (upgradeCandidate) {
        const proposal = this._proposal('UPGRADE', 'upgrade', {
          key: String(upgradeCandidate.itemSlot),
          inventorySlot: Number(upgradeCandidate.itemSlot),
          itemName: upgradeCandidate.itemName || upgradeCandidate.name || null,
          fromLevel: Number(upgradeCandidate.fromLevel || 0),
          risk: Math.max(0, finite(upgradeCandidate.budget && upgradeCandidate.budget.itemValueAtRisk) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const compoundCandidate = upgradePlan && (upgradePlan.compoundCandidates || [])[0] || null;
      if (compoundCandidate) {
        const proposal = this._proposal('COMPOUND', 'upgrade', {
          key: (compoundCandidate.itemSlots || []).join(','),
          inventorySlots: clone(compoundCandidate.itemSlots || []),
          itemName: compoundCandidate.itemName || compoundCandidate.name || null,
          fromLevel: Number(compoundCandidate.fromLevel || 0),
          risk: Math.max(0, finite(compoundCandidate.budget && compoundCandidate.budget.itemValueAtRisk) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const sellRow = tradePlan && (tradePlan.safeSellRows || [])[0] || null;
      if (sellRow) {
        const market = this._marketSellProposal(sellRow);
        const npc = this._npcSellProposal(sellRow);
        if (market) proposals.push(market);
        else if (npc) proposals.push(npc);
      }

      proposals.sort((a, b) =>
        Number(b.priority || 0) - Number(a.priority || 0)
        || Number(a.risk || 0) - Number(b.risk || 0)
        || String(a.kind).localeCompare(String(b.kind))
        || String(a.id).localeCompare(String(b.id)));

      this.metrics.proposals += proposals.length;
      const selected = proposals[0] || null;
      const plan = {
        state: selected ? 'READY' : 'IDLE',
        reason: selected ? 'H17_PLAN_READY' : 'H17_NO_SAFE_ECONOMY_ACTION',
        character: {
          name: snap.character.name,
          ctype: snap.character.ctype,
          map: snap.character.map,
          gold: snap.character.gold
        },
        autonomyEnabled: this.autonomyEnabled,
        actionsThisSession: this.actionsThisSession,
        maxActionsPerSession: this.config.maxActionsPerSession,
        pressure,
        selected: selected ? clone(selected) : null,
        proposals: clone(proposals),
        blockers: clone(blockers),
        children: clone(children)
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _childController(module) {
      return {
        bank: this.bank,
        trade: this.trade,
        gear: this.gear,
        upgrade: this.upgrade,
        exchangeCraft: this.exchangeCraft
      }[module] || null;
    }

    _queueProposal(proposal) {
      if (!proposal) return { accepted: false, reason: 'H17_PROPOSAL_REQUIRED' };
      let result = null;
      if (proposal.kind === 'BANK_MOUNT') result = this.bank && this.bank.queueMount ? this.bank.queueMount() : null;
      else if (proposal.kind === 'BANK_DEPOSIT') result = this.bank && this.bank.queueDeposit
        ? this.bank.queueDeposit(proposal.itemName, { inventorySlot: proposal.inventorySlot }) : null;
      else if (proposal.kind === 'GEAR_EQUIP') result = this.gear && this.gear.queueEquip
        ? this.gear.queueEquip(proposal.inventorySlot, proposal.slot) : null;
      else if (proposal.kind === 'MARKET_SELL') result = this.trade && this.trade.queueMarketSell
        ? this.trade.queueMarketSell(proposal.playerName, proposal.tradeSlot, proposal.quantity, { minUnitPrice: proposal.minUnitPrice }) : null;
      else if (proposal.kind === 'NPC_SELL') result = this.trade && this.trade.queueNpcSell
        ? this.trade.queueNpcSell(proposal.inventorySlot, proposal.quantity) : null;
      else if (proposal.kind === 'UPGRADE') result = this.upgrade && this.upgrade.queueUpgrade
        ? this.upgrade.queueUpgrade(proposal.inventorySlot) : null;
      else if (proposal.kind === 'COMPOUND') result = this.upgrade && this.upgrade.queueCompound
        ? this.upgrade.queueCompound(proposal.inventorySlots) : null;
      else if (proposal.kind === 'EXCHANGE') result = this.exchangeCraft && this.exchangeCraft.queueExchange
        ? this.exchangeCraft.queueExchange(proposal.inventorySlot) : null;
      else if (proposal.kind === 'CRAFT') result = this.exchangeCraft && this.exchangeCraft.queueCraft
        ? this.exchangeCraft.queueCraft(proposal.itemName) : null;
      else return { accepted: false, reason: 'H17_PROPOSAL_KIND_UNSUPPORTED' };

      if (!result) return { accepted: false, reason: 'H17_CHILD_QUEUE_UNAVAILABLE' };
      if (result.accepted !== true) return clone(result);

      if (proposal.kind === 'BANK_MOUNT' && result.alreadyMounted === true) {
        this.actionsThisSession += 1;
        this.metrics.actionsQueued += 1;
        this.metrics.actionsConfirmed += 1;
        this.metrics.byKind[proposal.kind] = Number(this.metrics.byKind[proposal.kind] || 0) + 1;
        this.cooldownUntilMs = Date.now() + this.config.actionCooldownMs;
        this.lastAction = {
          at: nowIso(),
          type: 'ACTION_CONFIRMED',
          action: {
            id: 'h17-action-' + (++this.sequence),
            kind: proposal.kind,
            module: proposal.module,
            proposal: clone(proposal)
          },
          details: { immediate: true, child: clone(result) }
        };
        return { accepted: true, immediate: true, result: clone(this.lastAction) };
      }

      const child = this._status(this._childController(proposal.module));
      const now = Date.now();
      this.currentAction = {
        id: 'h17-action-' + (++this.sequence),
        kind: proposal.kind,
        module: proposal.module,
        proposal: clone(proposal),
        queuedAt: nowIso(),
        queuedAtMs: now,
        deadlineAtMs: now + this.config.actionTimeoutMs,
        beforeLastAction: this._lastActionSignature(child)
      };
      this.actionsThisSession += 1;
      this.metrics.actionsQueued += 1;
      this.metrics.byKind[proposal.kind] = Number(this.metrics.byKind[proposal.kind] || 0) + 1;
      this.lastAction = { at: nowIso(), type: 'ACTION_QUEUED', action: clone(this.currentAction) };
      return { accepted: true, action: clone(this.currentAction), child: clone(result) };
    }

    queueSelected() {
      if (!this.moduleActive) return { accepted: false, reason: 'H17_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.currentAction) return { accepted: false, reason: 'H17_ACTION_ACTIVE' };
      if (this.canAct && this.canAct('economy') !== true) return { accepted: false, reason: 'H17_RUNTIME_ACTION_BLOCKED' };
      if (this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.metrics.sessionBudgetBlocks += 1;
        return { accepted: false, reason: 'H17_SESSION_ACTION_BUDGET_EXHAUSTED' };
      }
      const plan = this.plan();
      if (!plan || plan.state !== 'READY' || !plan.selected) {
        return { accepted: false, reason: plan && plan.reason || 'H17_PLAN_UNAVAILABLE' };
      }
      return this._queueProposal(plan.selected);
    }

    _finishCurrent(outcome, details = {}) {
      const current = this.currentAction;
      this.currentAction = null;
      this.cooldownUntilMs = Date.now() + this.config.actionCooldownMs;
      if (outcome === 'CONFIRMED') this.metrics.actionsConfirmed += 1;
      else if (outcome === 'REJECTED') this.metrics.actionsRejected += 1;
      else this.metrics.actionsUnknown += 1;
      this.lastAction = {
        at: nowIso(),
        type: 'ACTION_' + outcome,
        action: current ? clone(current) : null,
        details: clone(details)
      };
      return clone(this.lastAction);
    }

    _observeCurrent() {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };
      const child = this._status(this._childController(current.module));
      if (!child) {
        this.suspendedReason = 'H17_CHILD_STATUS_UNAVAILABLE';
        this._finishCurrent('UNKNOWN', { module: current.module });
        return { state: 'SUSPENDED', reason: this.suspendedReason };
      }
      if (child.suspended) {
        this.suspendedReason = 'H17_CHILD_SUSPENDED:' + cleanText(child.suspendedReason || current.module, 160);
        this._finishCurrent('UNKNOWN', { module: current.module, reason: child.suspendedReason || null });
        return { state: 'SUSPENDED', reason: this.suspendedReason };
      }
      if (this._childBusy(child)) return { state: 'WAITING', action: clone(current) };

      const after = this._lastActionSignature(child);
      if (after && after !== current.beforeLastAction) {
        const type = String(child.lastAction && child.lastAction.type || '');
        if (type.includes('UNKNOWN')) {
          this.suspendedReason = 'H17_CHILD_UNKNOWN:' + current.module;
          this._finishCurrent('UNKNOWN', { childLastAction: clone(child.lastAction) });
          return { state: 'SUSPENDED', reason: this.suspendedReason };
        }
        if (type.includes('CONFIRMED') || type.includes('SUCCEEDED') || type === 'BANK_ALREADY_MOUNTED' || type === 'BANK_MOUNTED') {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', { childLastAction: clone(child.lastAction) }) };
        }
        if (type.includes('REJECTED') || type.includes('FAILED') || type.includes('CANCELLED') || type.includes('BLOCKED')) {
          return { state: 'REJECTED', result: this._finishCurrent('REJECTED', { childLastAction: clone(child.lastAction) }) };
        }
      }

      if (Date.now() >= current.deadlineAtMs) {
        this.suspendedReason = 'H17_CHILD_COMPLETION_UNOBSERVABLE';
        this._finishCurrent('UNKNOWN', { module: current.module });
        return { state: 'SUSPENDED', reason: this.suspendedReason };
      }
      return { state: 'WAITING', action: clone(current) };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'IDLE', reason: 'H17_MODULE_INACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.currentAction) {
        const observed = this._observeCurrent();
        if (observed.state !== 'IDLE') return observed;
      }

      const plan = this.plan();
      if (!this.autonomyEnabled) return { state: 'OBSERVE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.cooldownUntilMs && Date.now() < this.cooldownUntilMs) {
        return { state: 'COOLDOWN', untilMs: this.cooldownUntilMs, plan };
      }
      if (this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.metrics.sessionBudgetBlocks += 1;
        this.autonomyEnabled = false;
        this.lastAction = { at: nowIso(), type: 'SESSION_BUDGET_REACHED', actions: this.actionsThisSession };
        return { state: 'COMPLETE', reason: 'H17_SESSION_ACTION_BUDGET_REACHED', plan };
      }
      if (!plan || plan.state !== 'READY' || !plan.selected) {
        return { state: plan && plan.state || 'IDLE', reason: plan && plan.reason || 'H17_NO_SAFE_ECONOMY_ACTION', plan };
      }
      const queued = this._queueProposal(plan.selected);
      if (!queued || queued.accepted !== true) {
        this.metrics.actionsRejected += 1;
        this.metrics.rejectionBackoffs += 1;
        this.cooldownUntilMs = Date.now() + this.config.actionCooldownMs;
        this.rejectionBackoff.set(plan.selected.id, Date.now() + this.config.rejectionBackoffMs);
        this.lastAction = {
          at: nowIso(),
          type: 'ACTION_QUEUE_REJECTED',
          proposal: clone(plan.selected),
          reason: queued && queued.reason || 'H17_CHILD_QUEUE_REJECTED'
        };
        return {
          state: 'REJECTED',
          reason: this.lastAction.reason,
          cooldownUntilMs: this.cooldownUntilMs,
          plan,
          result: clone(queued)
        };
      }
      return { state: 'QUEUED', plan, result: queued };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        currentAction: clone(this.currentAction),
        actionsThisSession: this.actionsThisSession,
        cooldownUntilMs: this.cooldownUntilMs,
        rejectionBackoff: Array.from(this.rejectionBackoff.entries()).map(([proposalId, untilMs]) => ({ proposalId, untilMs })),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.EconomyController = EconomyController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
