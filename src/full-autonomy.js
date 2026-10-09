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
        partyLogistics: false,
        encounters: false
      };
      this.config = {
        taskType: 'FARM',
        keepSupportInParty: true,
        requireAllOnlineProfiles: true,
        logisticsProbeMs: 30000,
        standProbeMs: 60000,
        autoManageMerchantStand: true,
        autoManageMerchantWork: true,
        selectionStabilityMs: 12000,
        rotationCooldownMs: 45000,
        lifecycleMaxActions: 20,
        economyMaxActions: 100,
        logisticsMaxActions: 10,
        expectedOnlineCount: 4
      };
      this.lastLogisticsProbeAtMs = 0;
      this.lastStandProbeAtMs = 0;
      this.desiredCharacterNames = [];
      this.selectionCandidateNames = [];
      this.selectionCandidateSinceMs = null;
      this.desiredChangedAtMs = null;
      this.desiredSource = null;
      this.tickResourceId = null;
      this.lifecycleArmed = false;
      this.standManagedByFullAutonomy = false;
      this.merchantWorkManagedByFullAutonomy = false;
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
      if (options.standProbeMs != null) {
        this.config.standProbeMs = Math.max(15000, Math.min(600000, Math.floor(Number(options.standProbeMs) || 60000)));
      }
      if (options.autoManageMerchantStand != null) this.config.autoManageMerchantStand = options.autoManageMerchantStand === true;
      if (options.autoManageMerchantWork != null) this.config.autoManageMerchantWork = options.autoManageMerchantWork === true;
      if (options.selectionStabilityMs != null) {
        this.config.selectionStabilityMs = Math.max(3000, Math.min(120000, Math.floor(Number(options.selectionStabilityMs) || 12000)));
      }
      if (options.rotationCooldownMs != null) {
        this.config.rotationCooldownMs = Math.max(10000, Math.min(600000, Math.floor(Number(options.rotationCooldownMs) || 45000)));
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
      this.selectionCandidateNames = [];
      this.selectionCandidateSinceMs = null;
      this.desiredChangedAtMs = requestedDesired.length === 4 ? Date.now() : null;
      this.desiredSource = requestedDesired.length === 4 ? 'bootstrap-hint' : null;
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
        if (this.started.encounters && runtime.encounters) {
          try { runtime.encounters.stopAutonomy(reason); } catch (_) {}
        }
        if (this.standManagedByFullAutonomy && runtime.merchantStand && typeof runtime.merchantStand.configure === 'function') {
          try { runtime.merchantStand.configure({ autoManage: false }); } catch (_) {}
        }
        if (this.merchantWorkManagedByFullAutonomy && runtime.merchantAutonomy
            && typeof runtime.merchantAutonomy.configure === 'function') {
          try { runtime.merchantAutonomy.configure({ autoManage: false }); } catch (_) {}
        }
      }
      if (this.tickResourceId && this.scope && typeof this.scope.cancel === 'function') {
        try { this.scope.cancel(this.tickResourceId, reason); } catch (_) {}
      }
      this.tickResourceId = null;
      this.enabled = false;
      this.desiredCharacterNames = [];
      this.selectionCandidateNames = [];
      this.selectionCandidateSinceMs = null;
      this.desiredChangedAtMs = null;
      this.desiredSource = null;
      this.lifecycleArmed = false;
      this.standManagedByFullAutonomy = false;
      this.merchantWorkManagedByFullAutonomy = false;
      this.started = { lifecycle: false, farming: false, economy: false, partyLogistics: false, encounters: false };
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

    _normalizeDesired(names) {
      return [...new Set((Array.isArray(names) ? names : [])
        .map(value => cleanText(value, 120))
        .filter(Boolean))].sort();
    }

    _alignPlanToDesired(plan, desiredNames, merchantName, leaderHint = null) {
      const desired = this._normalizeDesired(desiredNames);
      const merchant = cleanText(merchantName || '', 120);
      const farmers = desired.filter(name => name !== merchant);
      const aligned = clone(plan || {});
      aligned.selected = aligned.selected && typeof aligned.selected === 'object' ? clone(aligned.selected) : {};
      aligned.selected.memberNames = farmers.slice();
      aligned.supportMemberNames = merchant ? [merchant] : [];
      const hintedLeader = cleanText(leaderHint || '', 120);
      aligned.leaderName = hintedLeader && farmers.includes(hintedLeader)
        ? hintedLeader
        : (farmers.includes(cleanText(aligned.leaderName || '', 120))
          ? cleanText(aligned.leaderName || '', 120)
          : (farmers[0] || null));
      return aligned;
    }

    _merchantSelectionPeer(merchantName) {
      const local = this._local();
      const merchant = cleanText(merchantName || '', 120);
      if (!local || !merchant || String(local.name) === merchant) return null;
      try {
        const transport = this.runtime && this.runtime.lifecycleTransport;
        const peer = transport && typeof transport.freshPeer === 'function'
          ? transport.freshPeer(merchant)
          : null;
        if (!peer || peer.running !== true || peer.fullAutonomyEnabled !== true) return null;
        if (cleanText(peer.fullAutonomyDesiredSource || '', 80) !== 'merchant-authority') return null;
        if (!Number.isFinite(Number(peer.fullAutonomyDesiredChangedAtMs))
            || Number(peer.fullAutonomyDesiredChangedAtMs) <= 0) return null;
        const desired = this._normalizeDesired(peer.fullAutonomyDesiredCharacterNames);
        if (desired.length !== 4 || !desired.includes(merchant)) return null;
        return {
          peer,
          desired,
          authority: {
            source: 'merchant-authority',
            changedAtMs: Number(peer.fullAutonomyDesiredChangedAtMs),
            sessionId: peer.sessionId || null
          }
        };
      } catch (_) {
        return null;
      }
    }

    _stabilizeAuthoritativeDesired(candidateNames, readiness) {
      const candidate = this._normalizeDesired(candidateNames);
      const current = this._normalizeDesired(this.desiredCharacterNames);
      const now = Date.now();
      if (candidate.length !== 4) return current;

      if (current.length !== 4) {
        this.desiredCharacterNames = candidate.slice();
        this.selectionCandidateNames = [];
        this.selectionCandidateSinceMs = null;
        this.desiredChangedAtMs = now;
        this.desiredSource = 'merchant-authority';
        return candidate;
      }

      if (candidate.join('|') === current.join('|')) {
        this.selectionCandidateNames = [];
        this.selectionCandidateSinceMs = null;
        if (this.desiredSource !== 'merchant-authority') {
          this.desiredSource = 'merchant-authority';
          if (!Number.isFinite(this.desiredChangedAtMs)) this.desiredChangedAtMs = now;
        }
        return current;
      }

      let lifecycleBusy = false;
      try {
        const lifecycle = this.runtime && this.runtime.lifecycle && this.runtime.lifecycle.status
          ? this.runtime.lifecycle.status()
          : null;
        lifecycleBusy = !!(lifecycle && lifecycle.currentAction);
      } catch (_) {}

      const online = new Set(readiness && Array.isArray(readiness.online) ? readiness.online.map(String) : []);
      const currentSet = new Set(current);
      const currentRosterMismatch = current.some(name => !online.has(name))
        || [...online].some(name => !currentSet.has(name));
      if (lifecycleBusy || currentRosterMismatch) {
        this.selectionCandidateNames = [];
        this.selectionCandidateSinceMs = null;
        return current;
      }

      if (Number.isFinite(this.desiredChangedAtMs)
          && now - this.desiredChangedAtMs < this.config.rotationCooldownMs) {
        return current;
      }

      if (this.selectionCandidateNames.join('|') !== candidate.join('|')) {
        this.selectionCandidateNames = candidate.slice();
        this.selectionCandidateSinceMs = now;
        return current;
      }

      if (!Number.isFinite(this.selectionCandidateSinceMs)
          || now - this.selectionCandidateSinceMs < this.config.selectionStabilityMs) {
        return current;
      }

      this.desiredCharacterNames = candidate.slice();
      this.selectionCandidateNames = [];
      this.selectionCandidateSinceMs = null;
      this.desiredChangedAtMs = now;
      this.desiredSource = 'merchant-authority';
      return candidate;
    }

    _profileReadiness() {
      const profiles = this.strategy ? this.strategy.profiles() : [];
      const local = this._local();
      const online = this._onlineNames();
      const ready = new Set(profiles.filter(row => row && row.online
        && (row.local
          ? (this.runtime && this.runtime.running === true && this.enabled === true)
          : (row.peerFresh && row.running === true && row.fullAutonomyEnabled === true)))
        .map(row => String(row.name)));
      if (local && local.name && this.runtime && this.runtime.running === true && this.enabled === true) ready.add(String(local.name));
      const desired = this.desiredCharacterNames.length ? this.desiredCharacterNames.slice() : [];
      const desiredSet = new Set(desired.map(String));
      const missing = this.config.requireAllOnlineProfiles
        ? desired.filter(name => !ready.has(String(name))).sort()
        : [];
      const stoppedNames = profiles
        .filter(row => row && desiredSet.has(String(row.name)) && !row.local && row.peerFresh && row.running !== true)
        .map(row => String(row.name))
        .sort();
      const inactiveAutonomyNames = profiles
        .filter(row => row && desiredSet.has(String(row.name)) && !row.local
          && row.peerFresh && row.running === true && row.fullAutonomyEnabled !== true)
        .map(row => String(row.name))
        .sort();
      const missingPeerNames = profiles
        .filter(row => row && desiredSet.has(String(row.name)) && row.online === true && !row.local && row.peerFresh !== true)
        .map(row => String(row.name))
        .sort();
      const unexpectedOnlineNames = online.filter(name => !desiredSet.has(String(name))).sort();
      return {
        profiles,
        online,
        missing,
        stoppedNames,
        inactiveAutonomyNames,
        missingPeerNames,
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
      const onlineSet = new Set(readiness.online.map(String));
      const onlineDesired = desiredPartyAll
        .filter(name => onlineSet.has(String(name)))
        .sort((a, b) => a.localeCompare(b));
      const currentLeader = cleanText(party && party.leader || '', 120) || null;
      const preferredLeader = plan.leaderName && desiredPartyAll.includes(plan.leaderName)
        ? String(plan.leaderName)
        : (support[0] || desiredPartyAll[0] || null);
      const desiredSetForLeader = new Set(desiredPartyAll.map(String));
      const completeCurrentParty = !!party
        && party.available !== false
        && foreignNames.length === 0
        && memberNames.size === desiredSetForLeader.size
        && [...desiredSetForLeader].every(name => memberNames.has(name))
        && !!currentLeader
        && desiredSetForLeader.has(String(currentLeader));

      const observedPartyLeaders = new Set();
      const observeParty = snapshot => {
        if (!snapshot || snapshot.available === false || !snapshot.partyId) return;
        const foreign = Array.isArray(snapshot.foreignMemberNames)
          ? snapshot.foreignMemberNames.map(String)
          : [];
        const members = Array.isArray(snapshot.memberNames)
          ? snapshot.memberNames.map(String)
          : [];
        const observedLeader = cleanText(snapshot.leader || '', 120) || null;
        if (foreign.length || !observedLeader || !desiredSetForLeader.has(observedLeader)) return;
        if (!members.length || members.some(name => !desiredSetForLeader.has(String(name)))) return;
        observedPartyLeaders.add(observedLeader);
      };
      observeParty(party);
      try {
        const peers = this.runtime.lifecycleTransport
          && typeof this.runtime.lifecycleTransport.freshPeers === 'function'
          ? this.runtime.lifecycleTransport.freshPeers()
          : [];
        for (const peer of peers || []) observeParty(peer && peer.party);
      } catch (_) {}
      const sharedObservedLeader = observedPartyLeaders.size === 1
        ? [...observedPartyLeaders][0]
        : null;
      const selectedLeader = completeCurrentParty
        ? String(currentLeader)
        : (sharedObservedLeader || preferredLeader);
      if (!selectedLeader) return { ok: false, reason: 'FULL_AUTONOMY_PARTY_LEADER_UNAVAILABLE' };

      // Keep an already-complete owned party intact, but make the Merchant the
      // deterministic bootstrap/recovery leader whenever the party is absent or
      // incomplete. This prevents crossed request/invite handshakes while the
      // combat leader remains free to lead farming independently.
      const stableMerchantCoordinator = support[0] && onlineDesired.includes(String(support[0]))
        ? String(support[0])
        : null;
      if (!stableMerchantCoordinator) {
        return {
          ok: false,
          reason: 'FULL_AUTONOMY_MERCHANT_COORDINATOR_UNAVAILABLE',
          merchantName: support[0] || null,
          onlineCharacterNames: readiness.online.slice()
        };
      }
      const effectiveLeader = completeCurrentParty
        ? String(currentLeader)
        : stableMerchantCoordinator;
      const coordinatorName = stableMerchantCoordinator;
      const coordinator = localName === String(coordinatorName);
      const desiredActiveNames = stableDesired.slice();
      const desiredPartyMembers = desiredPartyAll.slice();
      const desiredRuntimeRunningNames = coordinator
        ? readiness.profiles
          .filter(row => row && row.peerFresh && !row.local && stableDesired.includes(String(row.name)))
          .map(row => row.name)
          .sort()
        : [];

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
      const runtimeRecoveryRequired = stoppedDesiredNames.length > 0;
      const rosterRecoveryRequired = offlineDesiredNames.length > 0;
      const rotationRequired = unexpectedOnlineNames.length > 0;
      const partyRecoveryReady = Array.isArray(readiness.missing) && readiness.missing.length === 0;
      const shouldRunLifecycle = coordinator
        && (runtimeRecoveryRequired
          || rosterRecoveryRequired
          || rotationRequired
          || (!partyTopologyHealthy && partyRecoveryReady));
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
        partyRecoveryReady,
        observedPartyLeaders: [...observedPartyLeaders].sort((a, b) => a.localeCompare(b)),
        stoppedDesiredNames,
        offlineDesiredNames,
        unexpectedOnlineNames,
        recoverySafetyBlocked,
        recoveryBlockReason
      };
    }

    _disarmLifecycle(reason = 'FULL_AUTONOMY_WAITING_MERCHANT_AUTHORITY') {
      const lifecycle = this.runtime && this.runtime.lifecycle;
      if (lifecycle && typeof lifecycle.status === 'function') {
        try {
          const status = lifecycle.status();
          if (status && status.autonomyEnabled === true && typeof lifecycle.stopAutonomy === 'function') {
            lifecycle.stopAutonomy(reason);
          }
        } catch (_) {}
      }
      this.started.lifecycle = false;
      this.lifecycleArmed = false;
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
      try {
        const status = this.runtime.encounters && this.runtime.encounters.status ? this.runtime.encounters.status() : null;
        if (this.started.encounters && status && status.autonomyEnabled === true) this.runtime.encounters.stopAutonomy(reason);
      } catch (_) {}
      this.started.farming = false;
      this.started.economy = false;
      this.started.partyLogistics = false;
      this.started.encounters = false;
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
      const requestedEncounter = ['BOSS', 'EVENT'].includes(String(plan && plan.taskType || '').toUpperCase());
      const encounterController = this.runtime.encounters;
      // If no safely actionable event exists for this character, run the
      // normal FARM role instead of idling indefinitely in encounter mode.
      const encounterPlan = requestedEncounter && ctype !== 'merchant'
        && encounterController && typeof encounterController.plan === 'function'
        ? encounterController.plan({ taskType: plan.taskType })
        : null;
      const encounterTask = requestedEncounter && (!encounterPlan || encounterPlan.state === 'READY');
      const shouldEncounter = encounterTask && ctype !== 'merchant' && selected.has(localName);
      const shouldFarm = !encounterTask && ctype !== 'merchant' && selected.has(localName);

      if (encounterTask) {
        const farmStatus = this.runtime.farmIntelligence.status();
        if (farmStatus && farmStatus.active) {
          const owner = farmStatus.session ? String(farmStatus.session.owner || '') : '';
          if (owner && owner !== 'full-autonomy') return { ok: false, reason: 'FULL_AUTONOMY_FOREIGN_FARM_INTELLIGENCE_OWNERSHIP' };
          try { this.runtime.farmIntelligence.stopAutonomy('FULL_AUTONOMY_ENCOUNTER_PRIORITY'); } catch (_) {}
          this.started.farming = false;
        }
        const encounter = this.runtime.encounters;
        const encounterStatus = encounter && encounter.status ? encounter.status() : null;
        if (!encounter || !encounterStatus) return { ok: false, reason: 'FULL_AUTONOMY_ENCOUNTER_CONTROLLER_UNAVAILABLE' };
        if (encounterStatus.suspended) return { ok: false, reason: encounterStatus.suspendedReason || 'FULL_AUTONOMY_ENCOUNTER_SUSPENDED' };
        if (shouldEncounter) {
          if (encounterStatus.autonomyEnabled !== true) {
            const started = encounter.startAutonomy({
              owner: 'full-autonomy',
              taskType: String(plan.taskType).toUpperCase(),
              groupLeaderName: plan && plan.leaderName || null,
              groupMemberNames: plan && plan.selected ? plan.selected.memberNames : []
            });
            if (!started || started.accepted !== true) return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_ENCOUNTER_START_REJECTED' };
          } else if (typeof encounter.configureGroup === 'function') {
            encounter.configureGroup({
              groupLeaderName: plan && plan.leaderName || null,
              groupMemberNames: plan && plan.selected ? plan.selected.memberNames : []
            });
          }
          this.started.encounters = true;
        } else if (encounterStatus.autonomyEnabled === true && this.started.encounters) {
          try { encounter.stopAutonomy('FULL_AUTONOMY_NOT_SELECTED_FOR_ENCOUNTER'); } catch (_) {}
          this.started.encounters = false;
        }
        return { ok: true, shouldFarm: false, shouldEncounter, selected: [...selected].sort() };
      }

      if (this.started.encounters && this.runtime.encounters) {
        try { this.runtime.encounters.stopAutonomy('FULL_AUTONOMY_RETURN_TO_BASE_TASK'); } catch (_) {}
        this.started.encounters = false;
      }
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
      const stand = this.runtime.merchantStand || null;
      const work = this.runtime.merchantAutonomy || null;

      if (stand && this.config.autoManageMerchantStand === true
          && typeof stand.status === 'function' && typeof stand.configure === 'function') {
        const before = stand.status();
        if (before && before.autoManage !== true) {
          stand.configure({ autoManage: true });
          this.standManagedByFullAutonomy = true;
        }
      }
      if (work && this.config.autoManageMerchantWork === true
          && typeof work.status === 'function' && typeof work.configure === 'function') {
        const before = work.status();
        if (before && before.autoManage !== true) {
          work.configure({ autoManage: true });
          this.merchantWorkManagedByFullAutonomy = true;
        }
      }

      const economyStatus = economy.status();
      const logisticsStatus = logistics.status();
      let standStatus = stand && typeof stand.status === 'function' ? stand.status() : null;
      let workStatus = work && typeof work.status === 'function' ? work.status() : null;
      if (economyStatus.suspendedReason || logisticsStatus.suspendedReason
          || (standStatus && standStatus.autoManage && standStatus.suspendedReason)
          || (workStatus && workStatus.autoManage && workStatus.suspendedReason)) {
        return {
          ok: false,
          reason: economyStatus.suspendedReason
            || logisticsStatus.suspendedReason
            || standStatus && standStatus.suspendedReason
            || workStatus && workStatus.suspendedReason
            || 'FULL_AUTONOMY_MERCHANT_SUSPENDED'
        };
      }

      const stopEconomy = reason => {
        const status = economy.status();
        if (status.currentAction) return false;
        if (this.started.economy && status.autonomyEnabled) {
          try { economy.stopAutonomy(reason); } catch (_) {}
          this.started.economy = false;
        }
        return true;
      };
      const stopLogistics = reason => {
        const status = logistics.status();
        if (status.currentAction) return false;
        if (this.started.partyLogistics && status.autonomyEnabled) {
          try { logistics.stopAutonomy(reason); } catch (_) {}
          this.started.partyLogistics = false;
        }
        return true;
      };
      const currentOwner = () => {
        const e = economy.status();
        if (e.currentAction) return { ok: true, merchant: true, owner: 'economy', plan: clone(e.currentAction) };
        const l = logistics.status();
        if (l.currentAction) return { ok: true, merchant: true, owner: 'party-logistics', plan: clone(l.currentAction) };
        return null;
      };

      const now = Date.now();

      // Merchant Work must close an active stand *and observe live closure*
      // before any other owner begins a new travel-capable activity. H12 also
      // has its own fail-closed closure path, but exchanges, production and
      // logistics need the shared handoff barrier.
      // GameAdapter.snapshot() intentionally omits the stand flag. Read
      // verified live character state via the Merchant controller instead.
      const standOpen = !!(work && typeof work._standOpen === 'function'
        && work._standOpen());
      if (standOpen && work && workStatus && workStatus.autoManage
          && typeof work.closeStandForWork === 'function'
          && !economyStatus.currentAction && !logisticsStatus.currentAction
          && !(standStatus && standStatus.pending)) {
        let expectedWork = null;
        try { expectedWork = typeof work.plan === 'function'
          ? work.plan({ backgroundAllowed: true }) : null; } catch (_) {}
        let expectedEconomy = null;
        try { expectedEconomy = typeof economy.plan === 'function' ? economy.plan() : null; } catch (_) {}
        let expectedLogistics = null;
        try { expectedLogistics = typeof logistics.plan === 'function' ? logistics.plan() : null; } catch (_) {}
        const upcomingWork = expectedWork && expectedWork.state === 'READY'
          && expectedWork.selected
          && ['TRAVEL', 'CLOSE_STAND'].includes(expectedWork.selected.kind);
        // Merrit/urgent stand work intentionally needs an open stand until
        // handoff and must not be preempted by a lower-priority economy plan.
        const keepForegroundStand = expectedWork && expectedWork.state === 'READY'
          && expectedWork.selected
          && ['MERRIT', 'SAFETY'].includes(String(expectedWork.selected.priorityClass || ''))
          && !upcomingWork;
        const upcomingEconomy = expectedEconomy && expectedEconomy.state === 'READY'
          && expectedEconomy.selected && expectedEconomy.selected.kind !== 'BANK_DEPOSIT';
        const upcomingLogistics = expectedLogistics && expectedLogistics.state === 'READY';
        if (!keepForegroundStand && (upcomingWork || upcomingEconomy || upcomingLogistics)) {
          const step = work.closeStandForWork();
          const after = work.status();
          if (after.suspendedReason) return { ok: false, reason: after.suspendedReason };
          if (!step || !['DISPATCHED', 'PENDING', 'CONFIRMED'].includes(String(step.state))) {
            return { ok: false, reason: step && step.reason || 'FULL_AUTONOMY_STAND_CLOSE_FAILED' };
          }
          return { ok: true, merchant: true, owner: 'merchant-autonomy', plan: clone(step) };
        }
      }

      // Finish an already-dispatched stand mutation before handing ownership away.
      if (standStatus && standStatus.autoManage && standStatus.pending) {
        const owner = currentOwner();
        if (owner) return owner;
        stopEconomy('FULL_AUTONOMY_MERCHANT_STAND_PENDING');
        stopLogistics('FULL_AUTONOMY_MERCHANT_STAND_PENDING');
        const step = stand.tick();
        standStatus = stand.status();
        if (standStatus.suspendedReason) return { ok: false, reason: standStatus.suspendedReason };
        return { ok: true, merchant: true, owner: 'merchant-stand', plan: clone(step) };
      }

      // Once Merchant Work owns movement or a settlement, H11, stand repricing,
      // logistics and Economy stay out until that work reaches live evidence.
      workStatus = work && typeof work.status === 'function' ? work.status() : null;
      if (workStatus && workStatus.autoManage && workStatus.exclusive === true) {
        const owner = currentOwner();
        if (owner) return owner;
        stopEconomy('FULL_AUTONOMY_MERCHANT_WORK_ACTIVE');
        stopLogistics('FULL_AUTONOMY_MERCHANT_WORK_ACTIVE');
        const step = work.tick({ backgroundAllowed: true });
        workStatus = work.status();
        if (workStatus.suspendedReason) return { ok: false, reason: workStatus.suspendedReason };
        return { ok: true, merchant: true, owner: 'merchant-autonomy', plan: clone(step) };
      }

      // Safety, Merrit, and an Economy speed pre-buff are foreground Merchant work.
      let foregroundPlan = null;
      if (work && workStatus && workStatus.autoManage && typeof work.plan === 'function') {
        try { foregroundPlan = work.plan({ backgroundAllowed: false }); } catch (_) {}
      }
      const foreground = foregroundPlan && foregroundPlan.state === 'READY'
        ? foregroundPlan.selected
        : null;
      if (foreground) {
        const priorityClass = String(foreground.priorityClass || '');
        const e = economy.status();
        const l = logistics.status();
        if (e.currentAction || l.currentAction) return currentOwner();

        const mayPreemptIdleOwners = priorityClass === 'SAFETY' || priorityClass === 'MERRIT';
        const economyPrebuffReady = priorityClass === 'ECONOMY_PREBUFF'
          && e.autonomyEnabled !== true && l.autonomyEnabled !== true;
        if (mayPreemptIdleOwners || economyPrebuffReady) {
          if (mayPreemptIdleOwners) {
            stopEconomy('FULL_AUTONOMY_MERCHANT_FOREGROUND_WORK');
            stopLogistics('FULL_AUTONOMY_MERCHANT_FOREGROUND_WORK');
          }
          const step = work.tick({ backgroundAllowed: false });
          workStatus = work.status();
          if (workStatus.suspendedReason) return { ok: false, reason: workStatus.suspendedReason };
          return { ok: true, merchant: true, owner: 'merchant-autonomy', plan: clone(step) };
        }
      }

      const logisticsActive = logistics.status().autonomyEnabled === true;
      if (logisticsActive) {
        const status = logistics.status();
        const plan = logistics.plan();
        if (!status.currentAction && (!plan || plan.state !== 'READY')) {
          if (this.started.partyLogistics) {
            try { logistics.stopAutonomy('FULL_AUTONOMY_LOGISTICS_IDLE'); } catch (_) {}
            this.started.partyLogistics = false;
          }
        } else {
          return { ok: true, merchant: true, owner: 'party-logistics', plan: clone(plan) };
        }
      }

      let economyNow = economy.status();
      let releasedIdleEconomy = false;
      if (economyNow.autonomyEnabled === true && !economyNow.currentAction) {
        let activeEconomyPlan = null;
        try { activeEconomyPlan = typeof economy.plan === 'function' ? economy.plan() : null; } catch (_) {}
        const activeEconomyIdle = !!(activeEconomyPlan
          && activeEconomyPlan.state === 'IDLE'
          && activeEconomyPlan.reason === 'H17_NO_SAFE_ECONOMY_ACTION'
          && !activeEconomyPlan.selected);
        if (activeEconomyIdle) {
          try { economy.stopAutonomy('FULL_AUTONOMY_ECONOMY_IDLE_HANDOFF'); } catch (_) {}
          this.started.economy = false;
          releasedIdleEconomy = true;
          economyNow = economy.status();
        }
      }

      if (now - this.lastLogisticsProbeAtMs >= this.config.logisticsProbeMs && !economyNow.currentAction) {
        this.lastLogisticsProbeAtMs = now;
        // Only H28 explicitly reserved gear may enter H18 delivery. An
        // advisory remote snapshot never authorizes send_item by itself.
        try {
          const gear = this.runtime.gear;
          const future = this.runtime.gearProgression;
          // Never duplicate a delivery already queued or underway. H18 may
          // be travelling across maps for longer than the 30s probe interval.
          const deliveryStatus = logistics.status();
          const idleDelivery = !(deliveryStatus.currentAction)
            && !(Array.isArray(deliveryStatus.queue) && deliveryStatus.queue.length);
          if (idleDelivery && gear && future && typeof gear.plan === 'function'
              && typeof future.deliveryAuthorization === 'function') {
            const proposals = gear.plan().group.proposals || [];
            for (const candidate of proposals) {
              const authorization = future.deliveryAuthorization(candidate.item, candidate.targetName);
              if (!authorization || authorization.allowed !== true) continue;
              const queued = logistics.queueGearDelivery(candidate.targetName, candidate.inventorySlot);
              if (queued && queued.accepted === true) break;
            }
          }
        } catch (_) {}
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

      // Normal stand management remains above background gathering/market work.
      standStatus = stand && typeof stand.status === 'function' ? stand.status() : null;
      const economyBeforeStand = economy.status();
      const logisticsBeforeStand = logistics.status();
      if (standStatus && standStatus.autoManage
          && (releasedIdleEconomy || now - this.lastStandProbeAtMs >= this.config.standProbeMs)
          && !economyBeforeStand.currentAction
          && !logisticsBeforeStand.currentAction
          && !logisticsBeforeStand.autonomyEnabled) {
        this.lastStandProbeAtMs = now;
        if (this.started.economy && economyBeforeStand.autonomyEnabled) {
          try { economy.stopAutonomy('FULL_AUTONOMY_MERCHANT_STAND_PROBE'); } catch (_) {}
          this.started.economy = false;
        }
        const standStep = stand.tick();
        standStatus = stand.status();
        if (standStatus.suspendedReason) return { ok: false, reason: standStatus.suspendedReason };
        if (standStatus.pending || (standStep && ['DISPATCHED', 'PENDING', 'CONFIRMED'].includes(String(standStep.state || '')))) {
          return { ok: true, merchant: true, owner: 'merchant-stand', plan: clone(standStep) };
        }
      }

      const currentEconomy = economy.status();
      const currentLogistics = logistics.status();
      let economyPlan = null;
      let noSafeEconomyAction = false;
      if (!currentLogistics.autonomyEnabled && !currentLogistics.currentAction && !currentEconomy.autonomyEnabled) {
        try { economyPlan = typeof economy.plan === 'function' ? economy.plan() : null; } catch (_) {}
        noSafeEconomyAction = !!(economyPlan
          && economyPlan.state === 'IDLE'
          && economyPlan.reason === 'H17_NO_SAFE_ECONOMY_ACTION'
          && !economyPlan.selected);

        // Ponty, Giveaways, useful wishlists and Fishing/Mining are free-time work.
        if (noSafeEconomyAction && work && typeof work.plan === 'function') {
          let backgroundPlan = null;
          try { backgroundPlan = work.plan({ backgroundAllowed: true }); } catch (_) {}
          if (backgroundPlan && ['READY', 'PENDING', 'CHILD_ACTIVE'].includes(String(backgroundPlan.state || ''))) {
            const step = work.tick({ backgroundAllowed: true });
            workStatus = work.status();
            if (workStatus.suspendedReason) return { ok: false, reason: workStatus.suspendedReason };
            if (step && String(step.state || '') !== 'IDLE') {
              return { ok: true, merchant: true, owner: 'merchant-autonomy', plan: clone(step) };
            }
          }
        }

        if (!noSafeEconomyAction) {
          const started = economy.startAutonomy({ maxActions: this.config.economyMaxActions });
          if (started && started.accepted === true) this.started.economy = true;
          else if (!started || !String(started.reason || '').includes('ALREADY')) {
            return { ok: false, reason: started && started.reason || 'FULL_AUTONOMY_ECONOMY_START_REJECTED' };
          }
        } else {
          this.started.economy = false;
        }
      }

      return {
        ok: true,
        merchant: true,
        owner: this.runtime.economy.status().autonomyEnabled ? 'economy' : 'idle',
        plan: economyPlan ? clone(economyPlan) : null
      };
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

        let initialFarmStatus = null;
        try {
          initialFarmStatus = this.runtime.farmIntelligence && typeof this.runtime.farmIntelligence.status === 'function'
            ? this.runtime.farmIntelligence.status()
            : null;
        } catch (_) {}
        if (initialFarmStatus && initialFarmStatus.active) {
          const initialFarmOwner = initialFarmStatus.session ? String(initialFarmStatus.session.owner || '') : '';
          if (initialFarmOwner !== 'full-autonomy') {
            this.strategy.recordTraining(false);
            return this.lastDecision = {
              at: new Date().toISOString(),
              state: 'BLOCKED',
              reason: 'FULL_AUTONOMY_FOREIGN_FARM_INTELLIGENCE_OWNERSHIP',
              foreignOwner: initialFarmOwner || null
            };
          }
        }

        if (initialReadiness.onlineLimitExceeded) {
          this.strategy.recordTraining(false);
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'BLOCKED',
            reason: 'FULL_AUTONOMY_ONLINE_CHARACTER_LIMIT_EXCEEDED',
            onlineCharacterNames: initialReadiness.online
          };
        }

        const encounterPriority = this.runtime.encounters && typeof this.runtime.encounters.preferredTask === 'function'
          ? this.runtime.encounters.preferredTask()
          : null;
        const effectiveTaskType = encounterPriority && encounterPriority.taskType || this.config.taskType;
        let plan = this.strategy.optimizeTask({ type: effectiveTaskType });
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
        let quartet = this._desiredQuartet(plan);
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

        const merchantName = quartet.support && quartet.support[0] ? String(quartet.support[0]) : null;
        const previousDesired = this._normalizeDesired(this.desiredCharacterNames);
        let readiness = this._profileReadiness();
        const localName = String(local.name || '');
        const merchantPeerSelection = this._merchantSelectionPeer(merchantName);
        let nextDesired;
        let selectionSource;
        if (merchantPeerSelection) {
          nextDesired = merchantPeerSelection.desired.slice();
          plan = this._alignPlanToDesired(
            plan,
            nextDesired,
            merchantName,
            merchantPeerSelection.peer.fullAutonomyLeaderName || null
          );
          quartet = this._desiredQuartet(plan);
          this.desiredCharacterNames = nextDesired.slice();
          this.selectionCandidateNames = [];
          this.selectionCandidateSinceMs = null;
          this.desiredSource = 'merchant-peer';
          selectionSource = 'merchant-peer';
        } else if (localName === String(merchantName || '')) {
          nextDesired = this._stabilizeAuthoritativeDesired(quartet.names, readiness);
          plan = this._alignPlanToDesired(plan, nextDesired, merchantName, plan.leaderName || null);
          quartet = this._desiredQuartet(plan);
          selectionSource = 'merchant-authority';
        } else {
          this._disarmLifecycle('FULL_AUTONOMY_WAITING_MERCHANT_AUTHORITY');
          try {
            if (this.runtime.lifecycleTransport && typeof this.runtime.lifecycleTransport.broadcastHeartbeat === 'function') {
              this.runtime.lifecycleTransport.broadcastHeartbeat();
            }
          } catch (_) {}
          const merchantOnline = readiness.online.includes(String(merchantName || ''));
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'WARMING',
            reason: merchantOnline
              ? 'FULL_AUTONOMY_WAITING_MERCHANT_SELECTION'
              : 'FULL_AUTONOMY_WAITING_MERCHANT_AUTHORITY',
            merchantName,
            onlineCharacterNames: readiness.online,
            missingProfiles: [...new Set([...(readiness.missing || []), merchantName].filter(Boolean))].sort(),
            missingPeerNames: [...new Set([...(readiness.missingPeerNames || []), merchantName].filter(Boolean))].sort(),
            lifecycleArmed: false
          };
        }

        const selectionChanged = nextDesired.join('|') !== previousDesired.join('|');
        this.desiredCharacterNames = nextDesired.slice();
        this.lastPlan = clone(plan);
        readiness = this._profileReadiness();
        let desiredSet = new Set(nextDesired);
        let onlineDesiredCount = readiness.online.filter(name => desiredSet.has(String(name))).length;
        let requiresRotation = readiness.unexpectedOnlineNames.length > 0
          || onlineDesiredCount !== 4
          || readiness.missing.length > 0;
        const rotationFallback = null;

        if (requiresRotation && this.runtime.lifecycle
            && typeof this.runtime.lifecycle.characterRotationReadiness === 'function') {
          const rotationReadiness = this.runtime.lifecycle.characterRotationReadiness(nextDesired);
          if (!rotationReadiness || rotationReadiness.ready !== true) {
            this.strategy.recordTraining(false);
            return this.lastDecision = {
              at: new Date().toISOString(),
              state: 'BLOCKED',
              reason: 'FULL_AUTONOMY_ROTATION_UNAVAILABLE',
              expectedOnlineCount: 4,
              requestedDesiredCharacterNames: nextDesired,
              onlineCharacterNames: readiness.online,
              rotationReadiness: clone(rotationReadiness)
            };
          }
        }

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
                : (readiness.missingPeerNames && readiness.missingPeerNames.length
                  ? 'FULL_AUTONOMY_WAITING_REMOTE_BOT'
                  : (readiness.inactiveAutonomyNames && readiness.inactiveAutonomyNames.length
                    ? 'FULL_AUTONOMY_WAITING_REMOTE_FULL_AUTONOMY'
                    : 'FULL_AUTONOMY_RECOVERING_STOPPED_OR_STALE_PEER'))),
            expectedOnlineCount: 4,
            desiredCharacterNames: nextDesired,
            onlineCharacterNames: readiness.online,
            missingProfiles: readiness.missing,
            missingPeerNames: readiness.missingPeerNames || [],
            inactiveFullAutonomyNames: readiness.inactiveAutonomyNames || [],
            unexpectedOnlineNames: lifecycle.unexpectedOnlineNames || readiness.unexpectedOnlineNames,
            lifecycleRecoveryRequired: lifecycle.recoveryRequired === true,
            runtimeRecoveryRequired: lifecycle.runtimeRecoveryRequired === true,
            rosterRecoveryRequired: lifecycle.rosterRecoveryRequired === true,
            rotationRequired: lifecycle.rotationRequired === true,
            stoppedDesiredNames: lifecycle.stoppedDesiredNames || readiness.stoppedNames,
            offlineDesiredNames: lifecycle.offlineDesiredNames || [],
            lifecycleCoordinator: lifecycle.coordinatorName,
            progressionTarget: plan.progression && plan.progression.selectedCharacterName || null,
            desiredSelectionSource: selectionSource
          };
        }

        const lifecycle = this._ensureLifecycle(plan, readiness);
        if (!lifecycle.ok) {
          this.strategy.recordTraining(false);
          return this.lastDecision = { at: new Date().toISOString(), state: 'BLOCKED', reason: lifecycle.reason };
        }

        if (!lifecycle.partyTopologyHealthy) {
          this.strategy.recordTraining(false);
          try {
            const farmStatus = this.runtime.farmIntelligence && this.runtime.farmIntelligence.status
              ? this.runtime.farmIntelligence.status()
              : null;
            if (farmStatus && farmStatus.active && farmStatus.session
                && String(farmStatus.session.owner || '') === 'full-autonomy') {
              this.runtime.farmIntelligence.stopAutonomy('FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY');
              this.started.farming = false;
            }
          } catch (_) {}
          return this.lastDecision = {
            at: new Date().toISOString(),
            state: 'WARMING',
            reason: 'FULL_AUTONOMY_WAITING_PARTY_TOPOLOGY',
            local: local.name,
            taskType: plan.taskType,
            executionMembers: plan.selected.memberNames,
            supportMembers: plan.supportMemberNames,
            desiredParty: lifecycle.partyNames,
            executionLeader: plan.leaderName || null,
            partyLeader: lifecycle.leader || null,
            lifecycleCoordinator: lifecycle.coordinatorName,
            localLifecycleCoordinator: lifecycle.coordinator === true,
            lifecycleRecoveryRequired: lifecycle.recoveryRequired === true,
            lifecycleRecoveryBlocked: lifecycle.recoverySafetyBlocked === true,
            lifecycleRecoveryBlockReason: lifecycle.recoveryBlockReason || null,
            partyTopologyHealthy: false,
            missingDesiredCharacters: this.desiredCharacterNames.filter(name => !readiness.online.includes(name)),
            desiredSelectionSource: selectionSource
          };
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
            : (combat.shouldEncounter ? 'combat-encounter' : (combat.shouldFarm ? 'combat-farm' : 'standby')),
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
          progressionTarget: plan.progression && plan.progression.selectedCharacterName || null,
          rotationFallback: clone(rotationFallback),
          desiredSelectionSource: selectionSource
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
        selectionCandidateNames: clone(this.selectionCandidateNames),
        selectionCandidateSinceMs: this.selectionCandidateSinceMs,
        desiredChangedAtMs: this.desiredChangedAtMs,
        desiredSource: this.desiredSource,
        tickScheduled: !!this.tickResourceId,
        lifecycleArmed: this.lifecycleArmed,
        standManagedByFullAutonomy: this.standManagedByFullAutonomy,
        lastPlan: clone(this.lastPlan),
        lastDecision: clone(this.lastDecision),
        lastError: clone(this.lastError)
      };
    }
  }

  ns.FullAutonomyController = FullAutonomyController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
