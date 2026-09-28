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
      // Full Live invariant: one Merchant is always the fourth party member.
      this.config.keepSupportInParty = true;
      if (options.requireAllOnlineProfiles != null) this.config.requireAllOnlineProfiles = options.requireAllOnlineProfiles === true;
      if (options.logisticsProbeMs != null) {
        this.config.logisticsProbeMs = Math.max(5000, Math.min(300000, Math.floor(Number(options.logisticsProbeMs) || 30000)));
      }
      // Adventure Land Full Live is always a four-character group: 3 farmers + 1 Merchant.
      this.config.expectedOnlineCount = 4;
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
      const requestedDesired = Array.isArray(options.desiredCharacterNames)
        ? [...new Set(options.desiredCharacterNames.map(value => cleanText(value, 120)).filter(Boolean))].sort()
        : [];
      if (requestedDesired.length && requestedDesired.length !== 4) {
        return {
          accepted: false,
          reason: 'FULL_AUTONOMY_DESIRED_ROSTER_INVALID',
          expectedOnlineCount: 4,
          desiredCharacterNames: requestedDesired,
          status: this.status()
        };
      }
      if (initialOnline.length > 4) {
        return {
          accepted: false,
          reason: 'FULL_AUTONOMY_ONLINE_CHARACTER_LIMIT_EXCEEDED',
          expectedOnlineCount: 4,
          onlineCharacterNames: initialOnline,
          status: this.status()
        };
      }
      // A supplied desired quartet is only a bootstrap hint (for H19 re-arm).
      // The strategy recomputes 3 farmers + 1 merchant on every tick.
      this.desiredCharacterNames = requestedDesired.slice();
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
      const ready = new Set(profiles.filter(row => row && row.online
        && (row.local ? (this.runtime && this.runtime.running === true) : (row.peerFresh && row.running === true)))
        .map(row => String(row.name)));
      if (local && local.name && this.runtime && this.runtime.running === true) ready.add(String(local.name));
      const desired = this.desiredCharacterNames.length ? this.desiredCharacterNames.slice() : [];
      const desiredSet = new Set(desired.map(String));
      const missing = this.config.requireAllOnlineProfiles
        ? desired.filter(name => !ready.has(String(name))).sort()
        : [];
      const stoppedNames = profiles
        .filter(row => row && desiredSet.has(String(row.name)) && !row.local && row.peerFresh && row.running !== true)
        .map(row => String(row.name))
        .sort();
      const unexpectedOnlineNames = online.filter(name => !desiredSet.has(String(name))).sort();
      return {
        profiles,
        online,
        missing,
        stoppedNames,
        unexpectedOnlineNames,
        readyNames: [...ready].sort(),
        onlineLimitExceeded: online.length > 4
      };
    }

    _desiredQuartet(plan) {
      const selected = [...new Set(plan && plan.selected && Array.isArray(plan.selected.memberNames)
        ? plan.selected.memberNames.map(String)
        : [])];
      const support = this.config.keepSupportInParty
        ? [...new Set(Array.isArray(plan && plan.supportMemberNames) ? plan.supportMemberNames.map(String) : [])]
        : [];

      if (selected.length !== 3 || support.length !== 1) {
        return {
          ok: false,
          reason: 'FULL_AUTONOMY_REQUIRES_THREE_FARMERS_AND_ONE_MERCHANT',
          selected: selected.slice().sort(),
          support: support.slice().sort()
        };
      }

      const names = [...new Set([...selected, ...support])].sort();
      if (names.length !== 4) {
        return {
          ok: false,
          reason: 'FULL_AUTONOMY_DESIRED_QUARTET_INVALID',
          selected: selected.slice().sort(),
          support: support.slice().sort(),
          desiredCharacterNames: names
        };
      }

      return {
        ok: true,
        selected: selected.slice().sort(),
        support: support.slice().sort(),
        standby: [],
        names
      };
    }

    _ensureLifecycle(plan, readiness) {
      const lifecycle = this.runtime.lifecycle;
      const local = this._local();
      if (!local || !local.name) return { ok: false, reason: 'CHARACTER_UNAVAILABLE' };
      const localName = String(local.name);
      const selected = plan && plan.selected && Array.isArray(plan.selected.memberNames)
        ? [...new Set(plan.selected.memberNames.map(String))]
        : [];
      const support = this.config.keepSupportInParty
        ? [...new Set(Array.isArray(plan && plan.supportMemberNames) ? plan.supportMemberNames.map(String) : [])]
        : [];
      if (selected.length !== 3 || support.length !== 1) {
        return { ok: false, reason: 'FULL_AUTONOMY_REQUIRES_THREE_FARMERS_AND_ONE_MERCHANT' };
      }
      const stableDesired = this.desiredCharacterNames.slice().sort();
      if (stableDesired.length !== 4
          || !selected.every(name => stableDesired.includes(String(name)))
          || !support.every(name => stableDesired.includes(String(name)))) {
        return { ok: false, reason: 'FULL_AUTONOMY_DESIRED_QUARTET_INVALID' };
      }
      const desiredPartyAll = stableDesired.slice();

      let party = null;
      try { party = this.runtime.party && this.runtime.party.snapshot ? this.runtime.party.snapshot() : null; } catch (_) {}
      const memberNames = new Set(party && Array.isArray(party.memberNames) ? party.memberNames.map(String) : []);
      const foreignNames = party && Array.isArray(party.foreignMemberNames)
        ? party.foreignMemberNames.map(String)
        : [];
      const currentLeader = cleanText(party && party.leader || '', 120) || null;
      const onlineSet = new Set(readiness.online.map(String));
      const onlineDesired = desiredPartyAll.filter(name => onlineSet.has(String(name)));
      const preferredLeader = plan.leaderName && desiredPartyAll.includes(plan.leaderName)
        ? plan.leaderName
        : (support[0] || desiredPartyAll[0] || null);
      const leader = currentLeader
        && desiredPartyAll.includes(currentLeader)
        && foreignNames.length === 0
        ? currentLeader
        : (onlineDesired.includes(preferredLeader)
          ? preferredLeader
          : (onlineDesired.includes(support[0]) ? support[0] : (onlineDesired[0] || preferredLeader)));
      if (!leader) return { ok: false, reason: 'FULL_AUTONOMY_PARTY_LEADER_UNAVAILABLE' };

      const coordinatorName = onlineSet.has(String(leader))
        ? leader
        : (onlineDesired.includes(support[0]) ? support[0] : (onlineDesired[0] || currentLeader || localName));
      const coordinator = localName === String(coordinatorName);
      const desiredActiveNames = stableDesired.slice();
      const desiredPartyMembers = desiredPartyAll.slice();
      const desiredRuntimeRunningNames = coordinator
        ? readiness.profiles
          .filter(row => row && row.peerFresh && !row.local && stableDesired.includes(String(row.name)))
          .map(row => row.name)
          .sort()
        : [];

      const effectiveLeader = leader;
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
      const stoppedDesiredNames = readiness.profiles
        .filter(row => row && stableDesired.includes(String(row.name)) && !row.local
          && row.peerFresh && row.running !== true)
        .map(row => String(row.name))
        .sort();
      const offlineDesiredNames = stableDesired.filter(name => !onlineSet.has(String(name))).sort();
      const unexpectedOnlineNames = readiness.online.filter(name => !stableDesired.includes(String(name))).sort();
      const runtimeRecoveryRequired = coordinator && stoppedDesiredNames.length > 0;
      const rosterRecoveryRequired = coordinator && offlineDesiredNames.length > 0;
      const rotationRequired = coordinator && unexpectedOnlineNames.length > 0;
      const shouldRunLifecycle = coordinator
        && (!partyTopologyHealthy || runtimeRecoveryRequired || rosterRecoveryRequired || rotationRequired);
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
        coordinatorName,
        desiredActiveNames,
        desiredRuntimeRunningNames,
        partyNames: desiredPartyMembers,
        leader: effectiveLeader,
        partyTopologyHealthy,
        recoveryRequired: shouldRunLifecycle,
        runtimeRecoveryRequired,
        rosterRecoveryRequired,
        rotationRequired,
        stoppedDesiredNames,
        offlineDesiredNames,
        unexpectedOnlineNames,
        recoverySafetyBlocked,
        recoveryBlockReason
      };
    }

    _pauseOwnedRoleWork(reason = 'FULL_AUTONOMY_RECOVERY_PAUSE') {
      try {
        const status = this.runtime.farmIntelligence.status();
        if (status && status.active && status.session && String(status.session.owner || '') === 'full-autonomy') {
          this.runtime.farmIntelligence.stopAutonomy(reason);
        }
      } catch (_) {}
      try {
        const status = this.runtime.economy.status();
        if (this.started.economy && status && status.autonomyEnabled === true) this.runtime.economy.stopAutonomy(reason);
      } catch (_) {}
      try {
        const status = this.runtime.partyLogistics.status();
        if (this.started.partyLogistics && status && status.autonomyEnabled === true) this.runtime.partyLogistics.stopAutonomy(reason);
      } catch (_) {}
      this.started.farming = false;
      this.started.economy = false;
      this.started.partyLogistics = false;
    }

    _recoveryPlan(readiness) {
      const stableDesired = this.desiredCharacterNames.length ? this.desiredCharacterNames.slice() : readiness.online.slice();
      const profiles = readiness.profiles || [];
      const combat = profiles
        .filter(row => row && stableDesired.includes(String(row.name)) && String(row.ctype || '').toLowerCase() !== 'merchant')
        .map(row => String(row.name))
        .sort();
      const support = profiles
        .filter(row => row && stableDesired.includes(String(row.name)) && String(row.ctype || '').toLowerCase() === 'merchant')
        .map(row => String(row.name))
        .sort();
      let party = null;
      try { party = this.runtime.party && this.runtime.party.snapshot ? this.runtime.party.snapshot() : null; } catch (_) {}
      const currentLeader = cleanText(party && party.leader || '', 120);
      const warrior = profiles.find(row => row && stableDesired.includes(String(row.name)) && String(row.ctype || '').toLowerCase() === 'warrior');
      const leaderName = currentLeader && stableDesired.includes(currentLeader)
        ? currentLeader
        : (warrior && String(warrior.name) || combat[0] || stableDesired[0] || null);
      return {
        taskType: this.config.taskType,
        selected: { memberNames: combat },
        supportMemberNames: support,
        leaderName
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
      const sessionOwner = status && status.session ? String(status.session.owner || '') : '';
      const fullAutonomyOwns = status && status.active && sessionOwner === 'full-autonomy';

      if (shouldFarm && status && status.active && !fullAutonomyOwns) {
        return { ok: false, reason: 'FULL_AUTONOMY_FOREIGN_FARM_INTELLIGENCE_OWNERSHIP' };
      }
      if (shouldFarm && status.suspended === true) {
        return { ok: false, reason: status.suspendedReason || 'FULL_AUTONOMY_FARM_INTELLIGENCE_SUSPENDED' };
      }
      if (shouldFarm && typeof this.runtime.farmIntelligence.configureGroup === 'function') {
        this.runtime.farmIntelligence.configureGroup({
          groupLeaderName: plan && plan.leaderName || null,
          groupMemberNames: plan && plan.selected ? plan.selected.memberNames : []
        });
      }

      if (shouldFarm) {
        if (!status.active) {
          const started = this.runtime.farmIntelligence.startAutonomy({
            owner: 'full-autonomy',
            allowTravel: true,
            groupLeaderName: plan && plan.leaderName || null,
            groupMemberNames: plan && plan.selected ? plan.selected.memberNames : []
          });
          if (started && started.accepted === true) this.started.farming = true;
          else if (!started || !String(started.reason || '').includes('ALREADY')) {
            return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_FARM_START_REJECTED' };
          }
        } else {
          this.started.farming = true;
        }
      } else if (status && status.active) {
        if (fullAutonomyOwns) {
          try { this.runtime.farmIntelligence.stopAutonomy('FULL_AUTONOMY_NOT_SELECTED'); } catch (_) {}
          this.started.farming = false;
        } else {
          return { ok: false, reason: 'FULL_AUTONOMY_FOREIGN_FARM_INTELLIGENCE_OWNERSHIP' };
        }
      } else {
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
        const initialReadiness = this._profileReadiness();
        const local = this._local();
        if (!local) return { state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE' };
        if (initialReadiness.onlineLimitExceeded) {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'BLOCKED',
            reason: 'FULL_AUTONOMY_ONLINE_CHARACTER_LIMIT_EXCEEDED',
            onlineCharacterNames: initialReadiness.online
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
        const quartet = this._desiredQuartet(plan);
        if (!quartet.ok) {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'BLOCKED',
            reason: quartet.reason,
            executionMembers: quartet.selected || [],
            supportMembers: quartet.support || [],
            standbyMembers: quartet.standby || [],
            desiredCharacterNames: quartet.desiredCharacterNames || [],
            plan: clone(plan)
          };
        }

        const nextDesired = quartet.names.slice();
        const selectionChanged = nextDesired.join('|') !== this.desiredCharacterNames.slice().sort().join('|');
        this.desiredCharacterNames = nextDesired;
        const readiness = this._profileReadiness();
        const desiredSet = new Set(nextDesired);
        const onlineDesiredCount = readiness.online.filter(name => desiredSet.has(String(name))).length;
        const requiresRotation = readiness.unexpectedOnlineNames.length > 0
          || onlineDesiredCount !== 4
          || readiness.missing.length > 0;

        if (requiresRotation) {
          this.strategy.recordTraining(false);
          this._pauseOwnedRoleWork(selectionChanged ? 'FULL_AUTONOMY_SELECTION_ROTATION' : 'FULL_AUTONOMY_LIFECYCLE_RECOVERY');
          const lifecycle = this._ensureLifecycle(plan, readiness);
          if (!lifecycle.ok) {
            return this.lastDecision = {
              at: new Date().toISOString(),
              state: 'BLOCKED',
              reason: lifecycle.reason,
              expectedOnlineCount: 4,
              desiredCharacterNames: nextDesired,
              onlineCharacterNames: readiness.online,
              missingProfiles: readiness.missing,
              unexpectedOnlineNames: readiness.unexpectedOnlineNames
            };
          }
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'WARMING',
            reason: lifecycle.rotationRequired
              ? 'FULL_AUTONOMY_ROTATING_ACTIVITY_GROUP'
              : (lifecycle.rosterRecoveryRequired
                ? 'FULL_AUTONOMY_RECOVERING_EXPECTED_ROSTER'
                : 'FULL_AUTONOMY_RECOVERING_STOPPED_OR_STALE_PEER'),
            expectedOnlineCount: 4,
            desiredCharacterNames: nextDesired,
            onlineCharacterNames: readiness.online,
            missingProfiles: readiness.missing,
            unexpectedOnlineNames: lifecycle.unexpectedOnlineNames || readiness.unexpectedOnlineNames,
            lifecycleRecoveryRequired: lifecycle.recoveryRequired === true,
            runtimeRecoveryRequired: lifecycle.runtimeRecoveryRequired === true,
            rosterRecoveryRequired: lifecycle.rosterRecoveryRequired === true,
            rotationRequired: lifecycle.rotationRequired === true,
            stoppedDesiredNames: lifecycle.stoppedDesiredNames || readiness.stoppedNames,
            offlineDesiredNames: lifecycle.offlineDesiredNames || [],
            lifecycleCoordinator: lifecycle.coordinatorName,
            progressionTarget: plan.progression && plan.progression.selectedCharacterName || null
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
          standbyMembers: [],
          desiredParty: lifecycle.partyNames,
          executionLeader: plan.leaderName || null,
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
