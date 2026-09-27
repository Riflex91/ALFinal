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
      this.lifecycleArmed = false;
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
      const waitForRoster = options.waitForRoster === true;
      if (initialOnline.length > this.config.expectedOnlineCount
          || (!waitForRoster && initialOnline.length !== this.config.expectedOnlineCount)) {
        return {
          accepted: false,
          reason: 'FULL_AUTONOMY_EXPECTED_ONLINE_COUNT_MISMATCH',
          expectedOnlineCount: this.config.expectedOnlineCount,
          onlineCharacterNames: initialOnline,
          status: this.status()
        };
      }
      this.desiredCharacterNames = initialOnline.length === this.config.expectedOnlineCount
        ? initialOnline.slice().sort()
        : [];
      this.lifecycleArmed = false;
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
      this.lifecycleArmed = false;
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
      const local = this._local();
      if (!local || !local.name) return { ok: false, reason: 'CHARACTER_UNAVAILABLE' };
      const localName = String(local.name);
      const selected = plan && plan.selected ? plan.selected.memberNames.slice() : [];
      const support = this.config.keepSupportInParty ? (plan.supportMemberNames || []) : [];
      const stableDesired = this.desiredCharacterNames.length
        ? this.desiredCharacterNames.slice()
        : readiness.online.slice();
      const desiredPartyAll = (this.config.keepSupportInParty
        ? stableDesired.slice()
        : [...new Set([...selected, ...support])])
        .filter(name => stableDesired.includes(String(name)))
        .slice(0, 4)
        .sort();

      let party = null;
      try { party = this.runtime.party && this.runtime.party.snapshot ? this.runtime.party.snapshot() : null; } catch (_) {}
      const memberNames = new Set(party && Array.isArray(party.memberNames) ? party.memberNames.map(String) : []);
      const foreignNames = party && Array.isArray(party.foreignMemberNames)
        ? party.foreignMemberNames.map(String)
        : [];
      const currentLeader = cleanText(party && party.leader || '', 120) || null;
      const preferredLeader = plan.leaderName && desiredPartyAll.includes(plan.leaderName)
        ? plan.leaderName
        : (desiredPartyAll[0] || null);
      const leader = currentLeader
        && desiredPartyAll.includes(currentLeader)
        && foreignNames.length === 0
        ? currentLeader
        : preferredLeader;
      if (!leader) return { ok: false, reason: 'FULL_AUTONOMY_PARTY_LEADER_UNAVAILABLE' };

      const coordinator = localName === String(leader);
      const onlineSet = new Set(readiness.online.map(String));
      const desiredActiveNames = coordinator
        ? stableDesired.slice().sort()
        : stableDesired.filter(name => onlineSet.has(String(name))).sort();
      const desiredPartyMembers = desiredPartyAll
        .filter(name => coordinator || onlineSet.has(String(name)))
        .sort();
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

      const desiredSet = new Set(desiredPartyMembers.map(String));
      const partyTopologyHealthy = !!party
        && party.available !== false
        && foreignNames.length === 0
        && memberNames.size === desiredSet.size
        && [...desiredSet].every(name => memberNames.has(name))
        && !!effectiveLeader
        && String(party.leader || '') === String(effectiveLeader);
      const localInParty = memberNames.has(localName);
      const shouldRunLifecycle = coordinator ? !partyTopologyHealthy : !localInParty;
      const current = lifecycle.status();
      const recoverySafetyBlocked = current.suspended === true
        || !!(current.currentAction && current.currentAction.unknownRecorded === true);
      const recoveryBlockReason = current.suspendedReason
        || (current.currentAction && current.currentAction.unknownRecorded === true ? 'H19_ACTION_UNKNOWN' : null);

      if (shouldRunLifecycle && recoverySafetyBlocked) {
        return { ok: false, reason: recoveryBlockReason || 'H19_SUSPENDED' };
      }

      if (shouldRunLifecycle && this.lifecycleArmed && current.autonomyEnabled !== true) {
        return {
          ok: false,
          reason: 'FULL_AUTONOMY_LIFECYCLE_STOP_REQUIRES_EXPLICIT_RESTART',
          lifecycleLastAction: clone(current.lastAction),
          actionsThisSession: Number(current.actionsThisSession || 0)
        };
      }
      if (shouldRunLifecycle && current.autonomyEnabled === true) {
        this.lifecycleArmed = true;
      } else if (shouldRunLifecycle) {
        const started = lifecycle.startAutonomy({ maxActions: this.config.lifecycleMaxActions });
        if (!started || started.accepted !== true) {
          return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_LIFECYCLE_START_REJECTED' };
        }
        this.started.lifecycle = true;
        this.lifecycleArmed = true;
      } else if (!coordinator && this.started.lifecycle && current.autonomyEnabled === true) {
        try { lifecycle.stopAutonomy('FULL_AUTONOMY_PARTY_HEALTHY_NON_COORDINATOR'); } catch (_) {}
        this.started.lifecycle = false;
        this.lifecycleArmed = false;
      }

      return {
        ok: true,
        coordinator,
        coordinatorName: leader,
        desiredActiveNames,
        desiredRuntimeRunningNames,
        partyNames: desiredPartyMembers,
        leader: effectiveLeader,
        partyTopologyHealthy,
        recoveryRequired: shouldRunLifecycle,
        recoverySafetyBlocked,
        recoveryBlockReason
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
        if (readiness.online.length < this.config.expectedOnlineCount) {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'WARMING',
            reason: 'FULL_AUTONOMY_WAITING_FOR_EXPECTED_ONLINE_COUNT',
            expectedOnlineCount: this.config.expectedOnlineCount,
            onlineCharacterNames: readiness.online
          };
        }
        if (!this.desiredCharacterNames.length) {
          this.desiredCharacterNames = readiness.online.slice().sort();
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
          lifecycleRecoveryRequired: lifecycle.recoveryRequired === true,
          lifecycleRecoveryBlocked: lifecycle.recoverySafetyBlocked === true,
          lifecycleRecoveryBlockReason: lifecycle.recoveryBlockReason || null,
          partyTopologyHealthy: lifecycle.partyTopologyHealthy === true,
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
        lifecycleArmed: this.lifecycleArmed,
        lastPlan: clone(this.lastPlan),
        lastDecision: clone(this.lastDecision),
        lastError: clone(this.lastError)
      };
    }
  }

  ns.FullAutonomyController = FullAutonomyController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
