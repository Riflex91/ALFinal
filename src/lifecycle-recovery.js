(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function nowIso() { return new Date().toISOString(); }

  function errorReason(value, fallback = 'H19_ACTION_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 300);
    }
    const text = cleanText(value, 300);
    return text || fallback;
  }

  function transientStartRejection(value) {
    const normalized = cleanText(value, 300).trim().toLowerCase().replace(/[\s.-]+/g, '_');
    return normalized === 'authorization_in_progress'
      || normalized.includes('authorization_in_progress');
  }

  function transientPartyRejection(value) {
    const normalized = cleanText(value, 300).trim().toLowerCase().replace(/[\s.-]+/g, '_');
    return normalized === 'invalid'
      || normalized.includes('not_online')
      || normalized.includes('not_found')
      || normalized.includes('different_server')
      || normalized.includes('server_mismatch');
  }

  class CharacterLifecycleController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.roster = options.roster;
      this.party = options.party || null;
      this.storage = options.storage || null;
      this.crossWindow = options.crossWindow || null;
      this.navigateCharacterLocal = typeof options.navigateCharacterLocal === 'function'
        ? options.navigateCharacterLocal
        : null;
      this.canNavigateCharacterLocal = typeof options.canNavigateCharacterLocal === 'function'
        ? options.canNavigateCharacterLocal
        : () => false;
      this.sessionId = cleanText(
        options.sessionId || this.crossWindow && this.crossWindow.sessionId || '',
        240
      ) || ('h19-session-' + Date.now());
      this.canAct = typeof options.canAct === 'function' ? options.canAct : () => true;

      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(3000, Math.min(120000, Number(options.outcomeTimeoutMs) || 15000)),
        startOutcomeTimeoutMs: Math.max(15000, Math.min(120000, Number(options.startOutcomeTimeoutMs) || 60000)),
        browserSwapTimeoutMs: Math.max(20000, Math.min(180000, Number(options.browserSwapTimeoutMs) || 90000)),
        browserSwapSessionRecoveryLimit: Math.max(1, Math.min(3,
          Number.isFinite(Number(options.browserSwapSessionRecoveryLimit))
            ? Math.floor(Number(options.browserSwapSessionRecoveryLimit))
            : 1
        )),
        startRetryBackoffMs: Math.max(750, Math.min(15000, Number(options.startRetryBackoffMs) || 2000)),
        partyRetryBackoffMs: Math.max(1500, Math.min(30000, Number(options.partyRetryBackoffMs) || 5000)),
        respawnGraceMs: Math.max(12000, Math.min(30000, Number(options.respawnGraceMs) || 13000)),
        maxActionsPerSession: Math.max(1, Math.min(20, Number(options.maxActionsPerSession) || 4)),
        maxQueue: Math.max(1, Math.min(32, Number(options.maxQueue) || 12))
      };

      this.moduleActive = false;
      this.scope = null;
      this.autonomyEnabled = false;
      this.actionsThisSession = 0;
      this.queue = [];
      this.currentAction = null;
      this.suspended = false;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.settlementGeneration = 0;
      this.restoredPending = false;
      this.deathObservedAtMs = null;
      this.partySignals = [];
      this.transientStartRetries = new Map();
      this.partyRetryBackoffs = new Map();
      this.browserSwapRecoveryAttempts = new Map();
      this.pendingBrowserSwapRecoveryKey = null;
      this.previousPartyInviteHandler = null;
      this.previousPartyRequestHandler = null;
      this.partyInviteHandler = null;
      this.partyRequestHandler = null;
      this.policyState = {
        desiredActiveNames: [],
        desiredRuntimeRunningNames: [],
        desiredPartyMemberNames: [],
        desiredPartyLeader: null
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        actionsQueued: 0,
        actionsDispatched: 0,
        actionsConfirmed: 0,
        actionsRejected: 0,
        actionsUnknown: 0,
        transientStartRejects: 0,
        transientStartRetryBlocks: 0,
        startsQueued: 0,
        startsConfirmed: 0,
        stopsQueued: 0,
        stopsConfirmed: 0,
        respawnsQueued: 0,
        respawnsConfirmed: 0,
        respawnCooldownBlocks: 0,
        respawnCooldownRejects: 0,
        partyInvitesDispatched: 0,
        partyInvitesConfirmed: 0,
        partyPeerBlocks: 0,
        partyTransientRejects: 0,
        partyRetryBlocks: 0,
        partyRequestsDispatched: 0,
        partyRequestsConfirmed: 0,
        partyAcceptsDispatched: 0,
        partyAcceptsConfirmed: 0,
        partySignalsObserved: 0,
        partySignalsIgnored: 0,
        partyConflictBlocks: 0,
        reconciliations: 0,
        sessionBudgetBlocks: 0,
        ownershipBlocks: 0,
        safetyBlocks: 0,
        crossWindowDispatches: 0,
        crossWindowConfirms: 0,
        crossWindowCharacterDisconnects: 0,
        browserSwapsDispatched: 0,
        browserSwapsConfirmed: 0,
        browserSwapSessionRecoveries: 0,
        browserSwapRecoveryBlocks: 0,
        lateOutcomeRecoveries: 0,
        rotationCapabilityBlocks: 0,
        stalePendingDiscarded: 0,
        stalePendingReconciled: 0
      };
    }

    _local() {
      try {
        const snapshot = this.game && this.game.snapshot ? this.game.snapshot() : null;
        return snapshot && snapshot.character ? snapshot.character : null;
      } catch (_) {
        return null;
      }
    }

    _localName() {
      const local = this._local();
      return cleanText(local && local.name || '', 120);
    }

    _browserSwapRecoveryKey(targetName, desiredName) {
      const from = cleanText(targetName || '', 120);
      const to = cleanText(desiredName || '', 120);
      return from && to ? from + '->' + to : '';
    }

    _browserSwapRecoveryCount(targetName, desiredName) {
      const key = this._browserSwapRecoveryKey(targetName, desiredName);
      return key ? Number(this.browserSwapRecoveryAttempts.get(key) || 0) : 0;
    }

    _respawnReadiness() {
      const local = this._local();
      if (!local || !local.name) {
        return { ready: false, reason: 'H19_LOCAL_CHARACTER_UNAVAILABLE', local: null, readyAtMs: null, waitMs: null };
      }
      if (local.rip !== true) {
        this.deathObservedAtMs = null;
        return { ready: false, reason: 'H19_LOCAL_CHARACTER_NOT_DEAD', local: clone(local), readyAtMs: null, waitMs: null };
      }

      const nowMs = Date.now();
      if (!Number.isFinite(this.deathObservedAtMs)) this.deathObservedAtMs = nowMs;
      const readyAtMs = this.deathObservedAtMs + this.config.respawnGraceMs;
      const waitMs = Math.max(0, readyAtMs - nowMs);
      return {
        ready: waitMs <= 0,
        reason: waitMs <= 0 ? 'H19_RESPAWN_READY' : 'H19_RESPAWN_COOLDOWN',
        local: clone(local),
        observedAtMs: this.deathObservedAtMs,
        readyAtMs,
        waitMs
      };
    }

    _partySnapshot() {
      try {
        return this.party && typeof this.party.snapshot === 'function' ? this.party.snapshot() : null;
      } catch (_) {
        return null;
      }
    }

    _partyMemberSet(snapshot = null) {
      const party = snapshot || this._partySnapshot();
      const names = party && Array.isArray(party.memberNames)
        ? party.memberNames
        : party && Array.isArray(party.ownedMemberNames)
          ? party.ownedMemberNames
          : [];
      return new Set(names.map(String));
    }

    _installPartyHooks() {
      if (!this.root || this.partyInviteHandler || this.partyRequestHandler) return;
      try {
        this.previousPartyInviteHandler = typeof this.root.on_party_invite === 'function' ? this.root.on_party_invite : null;
        this.previousPartyRequestHandler = typeof this.root.on_party_request === 'function' ? this.root.on_party_request : null;
      } catch (_) {
        this.previousPartyInviteHandler = null;
        this.previousPartyRequestHandler = null;
      }

      this.partyInviteHandler = name => {
        try {
          if (this.previousPartyInviteHandler) this.previousPartyInviteHandler(name);
        } catch (_) {}
        this._recordPartySignal('INVITE', name);
      };
      this.partyRequestHandler = name => {
        try {
          if (this.previousPartyRequestHandler) this.previousPartyRequestHandler(name);
        } catch (_) {}
        this._recordPartySignal('REQUEST', name);
      };

      try { this.root.on_party_invite = this.partyInviteHandler; } catch (_) {}
      try { this.root.on_party_request = this.partyRequestHandler; } catch (_) {}
    }

    _restorePartyHooks() {
      if (!this.root) return;
      try {
        if (this.root.on_party_invite === this.partyInviteHandler) {
          this.root.on_party_invite = this.previousPartyInviteHandler || function () {};
        }
      } catch (_) {}
      try {
        if (this.root.on_party_request === this.partyRequestHandler) {
          this.root.on_party_request = this.previousPartyRequestHandler || function () {};
        }
      } catch (_) {}
      this.partyInviteHandler = null;
      this.partyRequestHandler = null;
      this.previousPartyInviteHandler = null;
      this.previousPartyRequestHandler = null;
    }

    _recordPartySignal(kind, name) {
      if (!this.moduleActive) return false;
      const targetName = cleanText(name || '', 120);
      if (!targetName) return false;
      const roster = this._roster();
      const owned = this._ownedRow(targetName, roster);
      const desired = new Set(this.policyState.desiredActiveNames.map(String));
      const leader = this.policyState.desiredPartyLeader;
      const allowed = !!owned
        && !!leader
        && desired.has(targetName)
        && (kind === 'INVITE'
          ? String(leader) === targetName
          : String(leader) === this._localName());
      if (!allowed) {
        this.metrics.partySignalsIgnored += 1;
        return false;
      }
      const signal = {
        id: 'h19-party-signal-' + (++this.sequence),
        kind,
        targetName,
        observedAt: nowIso(),
        observedAtMs: Date.now()
      };
      this.partySignals = this.partySignals
        .filter(row => !(row.kind === kind && String(row.targetName) === targetName))
        .slice(-7);
      this.partySignals.push(signal);
      this.metrics.partySignalsObserved += 1;
      return true;
    }

    _storageKey(kind) {
      const localName = this._localName();
      if (!localName) return null;
      return 'albot:h19:' + kind + ':v1:' + localName;
    }

    _readStorage(kind) {
      const key = this._storageKey(kind);
      if (!key || !this.storage || typeof this.storage.get !== 'function') return null;
      try {
        const raw = this.storage.get(key);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }

    _writeStorage(kind, value) {
      const key = this._storageKey(kind);
      if (!key || !this.storage || typeof this.storage.set !== 'function') return false;
      try {
        this.storage.set(key, JSON.stringify(value));
        return true;
      } catch (_) {
        return false;
      }
    }

    _removeStorage(kind) {
      const key = this._storageKey(kind);
      if (!key || !this.storage || typeof this.storage.remove !== 'function') return false;
      try {
        this.storage.remove(key);
        return true;
      } catch (_) {
        return false;
      }
    }

    _persistCurrent() {
      if (!this.currentAction) return this._removeStorage('pending');
      const row = clone(this.currentAction);
      row.ownerSessionId = this.sessionId;
      delete row.response;
      delete row.errorObject;
      this._writeStorage('pending', row);
    }

    _persistPolicy() {
      this._writeStorage('policy', {
        desiredActiveNames: clone(this.policyState.desiredActiveNames),
        desiredRuntimeRunningNames: clone(this.policyState.desiredRuntimeRunningNames),
        desiredPartyMemberNames: clone(this.policyState.desiredPartyMemberNames),
        desiredPartyLeader: this.policyState.desiredPartyLeader || null
      });
    }

    _restoreState() {
      if (this.restoredPending) return;
      this.restoredPending = true;

      const policy = this._readStorage('policy');
      if (policy && Array.isArray(policy.desiredActiveNames)) {
        this.policyState.desiredActiveNames = policy.desiredActiveNames
          .map(name => cleanText(name, 120))
          .filter(Boolean);
        this.policyState.desiredRuntimeRunningNames = Array.isArray(policy.desiredRuntimeRunningNames)
          ? policy.desiredRuntimeRunningNames.map(name => cleanText(name, 120)).filter(Boolean)
          : [];
        this.policyState.desiredPartyMemberNames = Array.isArray(policy.desiredPartyMemberNames)
          ? policy.desiredPartyMemberNames.map(name => cleanText(name, 120)).filter(Boolean)
          : [];
        this.policyState.desiredPartyLeader = cleanText(policy.desiredPartyLeader || '', 120) || null;
      }

      const pending = this._readStorage('pending');
      if (pending && pending.kind && pending.id) {
        const sameSession = !!pending.ownerSessionId && String(pending.ownerSessionId) === String(this.sessionId);
        if (!sameSession) {
          const liveOutcome = this._pendingLiveOutcome(pending);
          this._removeStorage('pending');
          this.metrics.reconciliations += 1;
          if (liveOutcome.confirmed) {
            this.metrics.stalePendingReconciled += 1;
            this.lastAction = {
              at: nowIso(),
              type: 'STALE_PENDING_RECONCILED',
              actionId: pending.id,
              kind: pending.kind,
              targetName: pending.targetName || null,
              evidence: liveOutcome.evidence || null,
              previousSessionId: pending.ownerSessionId || null,
              currentSessionId: this.sessionId
            };
          } else {
            this.metrics.stalePendingDiscarded += 1;
            this.lastAction = {
              at: nowIso(),
              type: 'STALE_PENDING_DISCARDED',
              actionId: pending.id,
              kind: pending.kind,
              targetName: pending.targetName || null,
              reason: liveOutcome.reason || 'H19_STALE_PENDING_NO_LIVE_OUTCOME',
              previousSessionId: pending.ownerSessionId || null,
              currentSessionId: this.sessionId
            };
          }
        } else {
          this.currentAction = {
            ...pending,
            settlement: 'RESTORED',
            restored: true,
            response: null,
            error: null
          };
          this.metrics.reconciliations += 1;
          this.lastAction = {
            at: nowIso(),
            type: 'PENDING_RESTORED',
            actionId: pending.id,
            kind: pending.kind,
            targetName: pending.targetName || null,
            ownerSessionId: pending.ownerSessionId
          };
        }
      }
    }

    start(context) {
      this.settlementGeneration += 1;
      this.moduleActive = true;
      this.scope = context && context.scope || null;
      this._restoreState();
      this._installPartyHooks();
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('character-lifecycle-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return this.status();
    }

    stop(reason = 'H19_MODULE_STOP') {
      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.settlementGeneration += 1;
      if (this.currentAction && (this.currentAction.settlement === 'PENDING' || this.currentAction.settlement === 'PREPARED')) {
        this.currentAction.settlement = 'INTERRUPTED';
        this.currentAction.interruptedAt = nowIso();
        this._persistCurrent();
      }
      this._restorePartyHooks();
      this.scope = null;
      this.lastAction = {
        at: nowIso(),
        type: 'STOP',
        reason: cleanText(reason, 200),
        pendingPreserved: !!this.currentAction
      };
      if (this.currentAction) this._persistCurrent();
      return this.status();
    }

    _roster() {
      try {
        return this.roster && typeof this.roster.refresh === 'function'
          ? this.roster.refresh()
          : this.roster && typeof this.roster.status === 'function'
            ? this.roster.status()
            : null;
      } catch (_) {
        return null;
      }
    }

    _ownedRow(name, roster) {
      const wanted = cleanText(name, 120);
      if (!wanted || !roster || roster.accountStateAvailable !== true || !Array.isArray(roster.accountCharacters)) return null;
      return roster.accountCharacters.find(row => String(row && row.name || '') === wanted) || null;
    }

    _onlineSet(roster) {
      return new Set(roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String) : []);
    }

    _runnerActiveSet(roster) {
      const names = roster && Array.isArray(roster.runnerActiveCharacterNames)
        ? roster.runnerActiveCharacterNames
        : roster && Array.isArray(roster.activeCharacterNames)
          ? roster.activeCharacterNames
          : [];
      return new Set(names.map(String));
    }

    _startEvidenceSet(roster) {
      return new Set([
        ...this._onlineSet(roster),
        ...this._runnerActiveSet(roster)
      ]);
    }

    _actionAvailable(actionName) {
      if (!this.actions) return false;
      if (typeof this.actions.available === 'function') {
        try { return this.actions.available(actionName) === true; } catch (_) { return false; }
      }
      return typeof this.actions.dispatch === 'function';
    }

    _pendingLiveOutcome(pending) {
      if (!pending || !pending.kind) return { confirmed: false, reason: 'H19_STALE_PENDING_INVALID' };
      const kind = String(pending.kind);
      const targetName = cleanText(pending.targetName || '', 120);
      if (kind === 'BROWSER_SWAP') {
        const roster = this._roster();
        if (!roster || roster.onlineStateAvailable !== true) {
          return { confirmed: false, reason: 'H25_STALE_BROWSER_SWAP_ROSTER_UNAVAILABLE' };
        }
        const oldGone = !this._onlineSet(roster).has(targetName);
        const desiredName = cleanText(pending.desiredName || '', 120);
        const desiredPresent = !!desiredName && this._startEvidenceSet(roster).has(desiredName);
        const desiredPeer = desiredName && this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
          ? this.crossWindow.freshPeer(desiredName)
          : null;
        const desiredRuntimeRunning = !!(desiredPeer && desiredPeer.running === true);
        const desiredFullAutonomyEnabled = !!(desiredPeer && desiredPeer.fullAutonomyEnabled === true);
        if (oldGone && desiredRuntimeRunning && desiredFullAutonomyEnabled) {
          return {
            confirmed: true,
            evidence: 'STALE_BROWSER_SWAP_NEW_RUNTIME_READY',
            desiredCharacterPresent: desiredPresent,
            desiredRuntimeRunning: true,
            desiredFullAutonomyEnabled: true,
            desiredSessionId: desiredPeer.sessionId || null
          };
        }
        return {
          confirmed: false,
          reason: desiredPresent
            ? desiredPeer
              ? desiredRuntimeRunning
                ? 'H26_STALE_BROWSER_SWAP_FULL_AUTONOMY_NOT_READY'
                : 'H26_STALE_BROWSER_SWAP_RUNTIME_NOT_RUNNING'
              : 'H26_STALE_BROWSER_SWAP_RUNTIME_NOT_LOADED'
            : 'H25_STALE_BROWSER_SWAP_OUTCOME_UNVERIFIED'
        };
      }
      if (kind === 'START' || kind === 'STOP') {
        if (pending.transport === 'cross-window-runtime') {
          const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
            ? this.crossWindow.freshPeer(targetName)
            : null;
          const desiredRunning = kind === 'START';
          if (peer && peer.running === desiredRunning) {
            return { confirmed: true, evidence: 'STALE_CROSS_WINDOW_RUNTIME_STATE' };
          }
          return { confirmed: false, reason: 'H19_STALE_RUNTIME_OUTCOME_UNVERIFIED' };
        }
        const roster = this._roster();
        if (!roster || roster.onlineStateAvailable !== true) {
          return { confirmed: false, reason: 'H19_STALE_ROSTER_UNAVAILABLE' };
        }
        const online = this._onlineSet(roster).has(targetName);
        const startPresent = this._startEvidenceSet(roster).has(targetName);
        if (kind === 'START' && startPresent) return { confirmed: true, evidence: online ? 'STALE_ACTIVE_ROSTER_PRESENT' : 'STALE_RUNNER_START_STATE_PRESENT' };
        if (kind === 'STOP' && !online) return { confirmed: true, evidence: 'STALE_ACTIVE_ROSTER_ABSENT' };
        return { confirmed: false, reason: 'H19_STALE_CHARACTER_OUTCOME_UNVERIFIED' };
      }
      if (kind === 'RESPAWN') {
        const local = this._local();
        if (local && local.rip !== true) return { confirmed: true, evidence: 'STALE_LOCAL_CHARACTER_ALIVE' };
        return { confirmed: false, reason: 'H19_STALE_RESPAWN_OUTCOME_UNVERIFIED' };
      }
      if (['PARTY_INVITE', 'PARTY_REQUEST', 'PARTY_ACCEPT_INVITE', 'PARTY_ACCEPT_REQUEST'].includes(kind)) {
        const party = this._partySnapshot();
        const members = this._partyMemberSet(party);
        const localName = this._localName();
        if (party && party.partyId && members.has(targetName) && members.has(localName)) {
          return { confirmed: true, evidence: 'STALE_PARTY_SNAPSHOT_MEMBERSHIP' };
        }
        return { confirmed: false, reason: 'H19_STALE_PARTY_OUTCOME_UNVERIFIED' };
      }
      return { confirmed: false, reason: 'H19_STALE_PENDING_KIND_UNSUPPORTED' };
    }

    characterRotationReadiness(desiredNames = []) {
      const roster = this._roster();
      const desired = [...new Set((Array.isArray(desiredNames) ? desiredNames : [])
        .map(name => cleanText(name, 120))
        .filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        this.metrics.rotationCapabilityBlocks += 1;
        return { ready: false, reason: 'H19_ROTATION_ROSTER_UNAVAILABLE', desiredCharacterNames: desired };
      }
      if (roster.activeStateAvailable !== true) {
        this.metrics.rotationCapabilityBlocks += 1;
        return { ready: false, reason: 'H19_ROTATION_RUNNER_STATE_UNAVAILABLE', desiredCharacterNames: desired };
      }

      const owned = new Set((roster.accountCharacters || []).map(row => String(row && row.name || '')).filter(Boolean));
      if (desired.some(name => !owned.has(name))) {
        this.metrics.rotationCapabilityBlocks += 1;
        return { ready: false, reason: 'H19_ROTATION_TARGET_NOT_OWNED', desiredCharacterNames: desired };
      }

      const online = this._onlineSet(roster);
      const runnerActive = this._runnerActiveSet(roster);
      const startEvidence = this._startEvidenceSet(roster);
      const localName = this._localName();
      const unexpectedOnlineNames = [...online]
        .filter(name => owned.has(String(name)) && !desired.includes(String(name)))
        .sort((a, b) => a.localeCompare(b));
      const missingDesiredNames = desired.filter(name => !startEvidence.has(String(name))).sort((a, b) => a.localeCompare(b));
      const blockers = [];
      const remoteDisconnectNames = [];
      const browserSwapPairs = [];
      const stopActionAvailable = this._actionAvailable('stop_character');
      const startActionAvailable = this._actionAvailable('start_character');
      const remainingMissing = missingDesiredNames.slice();
      const occupiedCharacterNames = [...startEvidence]
        .filter(name => owned.has(String(name)))
        .sort((a, b) => a.localeCompare(b));

      for (const name of unexpectedOnlineNames) {
        if (String(name) === String(localName)) {
          blockers.push(remainingMissing.length
            ? 'H27_ROTATION_LOCAL_REPLACEMENT_REQUIRES_MERCHANT_COORDINATOR:' + name
            : 'H19_ROTATION_WOULD_STOP_LOCAL:' + name);
          continue;
        }
        if (runnerActive.has(String(name))) {
          if (!stopActionAvailable) blockers.push('H19_ROTATION_STOP_ACTION_UNAVAILABLE:' + name);
          continue;
        }
        const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
          ? this.crossWindow.freshPeer(name)
          : null;
        if (remainingMissing.length) {
          const desiredCandidate = String(remainingMissing[0] || '');
          const recoveryAttempts = this._browserSwapRecoveryCount(name, desiredCandidate);
          const recoveryKey = this._browserSwapRecoveryKey(name, desiredCandidate);
          const retryPermit = !!recoveryKey && this.pendingBrowserSwapRecoveryKey === recoveryKey;
          if (recoveryAttempts >= this.config.browserSwapSessionRecoveryLimit && !retryPermit) {
            blockers.push('H31_BROWSER_SWAP_RETRY_LIMIT_REACHED:' + name + '->' + desiredCandidate);
            continue;
          }
          if (peer && peer.running === true
              && peer.characterNavigateCapable === true
              && peer.characterDisconnectCapable === true
              && this.crossWindow && typeof this.crossWindow.requestCharacterNavigation === 'function') {
            browserSwapPairs.push({ from: String(name), to: String(remainingMissing.shift()) });
            continue;
          }
          blockers.push('H25_ROTATION_BROWSER_NAVIGATION_UNAVAILABLE:' + name);
          continue;
        }
        if (peer && peer.running === true && peer.characterDisconnectCapable === true) {
          remoteDisconnectNames.push(String(name));
          continue;
        }
        blockers.push('H19_ROTATION_STOP_NOT_RUNNER_CONTROLLABLE:' + name);
      }

      if (remainingMissing.length && occupiedCharacterNames.length >= 4) {
        blockers.push('H27_ACCOUNT_CHARACTER_SLOT_LIMIT_REACHED');
      } else if (remainingMissing.length && !startActionAvailable) {
        blockers.push('H19_ROTATION_START_ACTION_UNAVAILABLE');
      }

      const ready = blockers.length === 0;
      if (!ready) this.metrics.rotationCapabilityBlocks += 1;
      return {
        ready,
        reason: ready ? 'H25_ROTATION_CHARACTER_CONTROL_READY' : blockers[0],
        blockers,
        desiredCharacterNames: desired,
        onlineCharacterNames: [...online].sort((a, b) => a.localeCompare(b)),
        runnerActiveCharacterNames: [...runnerActive].sort((a, b) => a.localeCompare(b)),
        startEvidenceCharacterNames: [...startEvidence].sort((a, b) => a.localeCompare(b)),
        browserSwapPairs: clone(browserSwapPairs),
        remoteDisconnectNames: remoteDisconnectNames.sort((a, b) => a.localeCompare(b)),
        occupiedCharacterNames,
        unexpectedOnlineNames,
        missingDesiredNames,
        stopActionAvailable,
        startActionAvailable
      };
    }

    _validateRemoteTarget(name, mode, options = {}) {
      const roster = this._roster();
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        return { ok: false, reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
      }
      const owned = this._ownedRow(name, roster);
      if (!owned) {
        this.metrics.ownershipBlocks += 1;
        return { ok: false, reason: 'H19_TARGET_NOT_OWNED' };
      }
      const localName = this._localName();
      const isLocal = String(owned.name) === String(localName);
      if (isLocal && mode !== 'BROWSER_SWAP') {
        return { ok: false, reason: 'H19_REMOTE_TARGET_IS_LOCAL' };
      }

      const targetName = String(owned.name);
      const active = this._onlineSet(roster).has(targetName);
      const runnerActive = this._runnerActiveSet(roster).has(targetName);
      const startPresent = this._startEvidenceSet(roster).has(targetName);
      const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
        ? this.crossWindow.freshPeer(targetName)
        : null;

      if (mode === 'STOP') {
        if (!active) return { ok: false, reason: 'H19_TARGET_ALREADY_STOPPED' };
        if (options.requireCharacterStateChange === true) {
          if (roster.activeStateAvailable !== true) return { ok: false, reason: 'H19_ROTATION_RUNNER_STATE_UNAVAILABLE' };
          if (runnerActive) {
            if (!this._actionAvailable('stop_character')) return { ok: false, reason: 'H19_ROTATION_STOP_ACTION_UNAVAILABLE' };
            return { ok: true, roster, owned, active, runnerActive, peer, transport: 'child-character' };
          }
          if (peer && peer.running === true && peer.characterDisconnectCapable === true
              && this.crossWindow && typeof this.crossWindow.requestCharacterDisconnect === 'function') {
            return { ok: true, roster, owned, active, runnerActive, peer, transport: 'cross-window-character-disconnect' };
          }
          return { ok: false, reason: 'H19_ROTATION_STOP_NOT_RUNNER_CONTROLLABLE' };
        }
        if (roster.activeStateAvailable === true && runnerActive) {
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'child-character' };
        }
        if (peer) {
          if (peer.running !== true) return { ok: false, reason: 'H19_TARGET_RUNTIME_ALREADY_STOPPED' };
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'cross-window-runtime' };
        }
        if (roster.activeStateAvailable !== true) {
          return { ok: false, reason: 'H19_RUNNER_ACTIVE_STATE_UNAVAILABLE' };
        }
        return { ok: false, reason: 'H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE' };
      }

      if (mode === 'BROWSER_SWAP') {
        const desiredName = cleanText(options.desiredName || '', 120);
        const desiredOwned = this._ownedRow(desiredName, roster);
        const desiredPresent = desiredName ? this._startEvidenceSet(roster).has(desiredName) : false;
        if (!active) return { ok: false, reason: 'H25_BROWSER_SWAP_SOURCE_NOT_ONLINE' };
        if (!desiredName || !desiredOwned || desiredName === targetName) return { ok: false, reason: 'H25_BROWSER_SWAP_TARGET_INVALID' };
        if (desiredPresent) return { ok: false, reason: 'H25_BROWSER_SWAP_TARGET_ALREADY_PRESENT' };
        if (isLocal) {
          return { ok: false, reason: 'H27_LOCAL_BROWSER_SWAP_REQUIRES_REMOTE_MERCHANT_COORDINATOR' };
        }
        if (!peer || peer.running !== true
            || peer.characterNavigateCapable !== true
            || peer.characterDisconnectCapable !== true
            || !this.crossWindow || typeof this.crossWindow.requestCharacterNavigation !== 'function') {
          return { ok: false, reason: 'H25_BROWSER_SWAP_NAVIGATION_UNAVAILABLE' };
        }
        return { ok: true, roster, owned, active, runnerActive, peer, desiredOwned, desiredName, transport: 'cross-window-browser-navigation' };
      }

      if (mode === 'START') {
        const occupiedCharacterNames = [...this._startEvidenceSet(roster)]
          .filter(name => this._ownedRow(name, roster))
          .sort((a, b) => a.localeCompare(b));
        if (!startPresent && occupiedCharacterNames.length >= 4) {
          return {
            ok: false,
            reason: 'H27_ACCOUNT_CHARACTER_SLOT_LIMIT_REACHED',
            occupiedCharacterNames
          };
        }
        if (options.requireCharacterStateChange === true) {
          if (startPresent) return { ok: false, reason: 'H19_TARGET_ALREADY_ACTIVE' };
          if (!this._actionAvailable('start_character')) return { ok: false, reason: 'H19_ROTATION_START_ACTION_UNAVAILABLE' };
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'child-character' };
        }
        if (peer) {
          if (peer.running === true) return { ok: false, reason: 'H19_TARGET_ALREADY_ACTIVE' };
          return { ok: true, roster, owned, active, runnerActive, peer, transport: 'cross-window-runtime' };
        }
        if (startPresent) return { ok: false, reason: 'H19_REMOTE_RUNTIME_PEER_UNAVAILABLE' };
        return { ok: true, roster, owned, active, runnerActive, peer: null, transport: 'child-character' };
      }

      return { ok: false, reason: 'H19_REMOTE_MODE_UNSUPPORTED' };
    }

    _enqueue(kind, targetName, details = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H19_MODULE_NOT_ACTIVE' };
      if (this.suspended) return { accepted: false, reason: this.suspendedReason || 'H19_SUSPENDED' };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H19_QUEUE_FULL' };

      if (kind === 'START' || kind === 'STOP') {
        const check = this._validateRemoteTarget(targetName, kind, {
          requireCharacterStateChange: details.requireCharacterStateChange === true
        });
        if (!check.ok) return { accepted: false, reason: check.reason };
      }

      if (kind === 'RESPAWN') {
        const local = this._local();
        if (!local || !local.name) return { accepted: false, reason: 'H19_LOCAL_CHARACTER_UNAVAILABLE' };
        if (local.rip !== true) return { accepted: false, reason: 'H19_LOCAL_CHARACTER_NOT_DEAD' };
        targetName = local.name;
      }

      const request = {
        id: 'h19-request-' + (++this.sequence),
        kind,
        targetName: cleanText(targetName, 120) || null,
        queuedAt: nowIso(),
        ...clone(details)
      };
      this.queue.push(request);
      this.metrics.actionsQueued += 1;
      if (kind === 'START') this.metrics.startsQueued += 1;
      if (kind === 'STOP') this.metrics.stopsQueued += 1;
      if (kind === 'RESPAWN') this.metrics.respawnsQueued += 1;
      this.lastAction = { at: request.queuedAt, type: kind + '_QUEUED', requestId: request.id, targetName: request.targetName };
      return { accepted: true, request: clone(request) };
    }

    queueStart(name) { return this._enqueue('START', name); }
    queueStop(name) { return this._enqueue('STOP', name); }
    queueRespawn() { return this._enqueue('RESPAWN', this._localName()); }

    cancelQueued(requestId = null) {
      if (this.currentAction) return { accepted: false, reason: 'H19_ACTION_IN_FLIGHT' };
      if (requestId == null) {
        const count = this.queue.length;
        this.queue = [];
        return { accepted: true, cancelled: count };
      }
      const wanted = String(requestId);
      const before = this.queue.length;
      this.queue = this.queue.filter(row => String(row.id) !== wanted);
      return { accepted: before !== this.queue.length, cancelled: before - this.queue.length };
    }

    captureDesiredActive() {
      const roster = this._roster();
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        return { accepted: false, reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
      }
      const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
      this.policyState.desiredActiveNames = (roster.onlineCharacterNames || [])
        .map(String)
        .filter(name => owned.has(name))
        .sort((a, b) => a.localeCompare(b));
      const freshPeers = this.crossWindow && typeof this.crossWindow.freshPeers === 'function'
        ? this.crossWindow.freshPeers()
        : [];
      this.policyState.desiredRuntimeRunningNames = freshPeers
        .filter(peer => peer && peer.running === true && owned.has(String(peer.name || '')))
        .map(peer => String(peer.name))
        .sort((a, b) => a.localeCompare(b));
      const party = this._partySnapshot();
      const partyMembers = this._partyMemberSet(party);
      this.policyState.desiredPartyMemberNames = [...partyMembers]
        .filter(name => owned.has(name))
        .sort((a, b) => a.localeCompare(b));
      const partyLeader = cleanText(party && party.leader || '', 120);
      this.policyState.desiredPartyLeader = partyLeader
        && owned.has(partyLeader)
        && this.policyState.desiredPartyMemberNames.includes(partyLeader)
        ? partyLeader
        : null;
      this._persistPolicy();
      return {
        accepted: true,
        desiredActiveNames: clone(this.policyState.desiredActiveNames),
        desiredRuntimeRunningNames: clone(this.policyState.desiredRuntimeRunningNames),
        desiredPartyMemberNames: clone(this.policyState.desiredPartyMemberNames),
        desiredPartyLeader: this.policyState.desiredPartyLeader
      };
    }

    setPolicy(next = {}) {
      const roster = this._roster();
      const previousDesiredKey = this.policyState.desiredActiveNames.join('\u0000');
      if (Array.isArray(next.desiredActiveNames)) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        const normalized = [...new Set(next.desiredActiveNames.map(name => cleanText(name, 120)).filter(Boolean))];
        if (normalized.some(name => !owned.has(name))) return { accepted: false, reason: 'H19_POLICY_CONTAINS_NON_OWNED_CHARACTER' };
        this.policyState.desiredActiveNames = normalized.sort((a,b) => a.localeCompare(b));
        const activeDesired = new Set(this.policyState.desiredActiveNames.map(String));
        this.policyState.desiredRuntimeRunningNames = this.policyState.desiredRuntimeRunningNames
          .filter(name => activeDesired.has(String(name)));
      }
      if (Array.isArray(next.desiredRuntimeRunningNames)) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        const activeDesired = new Set(this.policyState.desiredActiveNames.map(String));
        const normalizedRuntime = [...new Set(next.desiredRuntimeRunningNames.map(name => cleanText(name, 120)).filter(Boolean))];
        if (normalizedRuntime.some(name => !owned.has(name))) return { accepted: false, reason: 'H19_RUNTIME_POLICY_CONTAINS_NON_OWNED_CHARACTER' };
        if (normalizedRuntime.some(name => !activeDesired.has(name))) return { accepted: false, reason: 'H19_RUNTIME_TARGET_NOT_DESIRED_ACTIVE' };
        this.policyState.desiredRuntimeRunningNames = normalizedRuntime.sort((a,b) => a.localeCompare(b));
      }
      if (Array.isArray(next.desiredPartyMemberNames)) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        const activeDesired = new Set(this.policyState.desiredActiveNames.map(String));
        const normalizedParty = [...new Set(next.desiredPartyMemberNames.map(name => cleanText(name, 120)).filter(Boolean))];
        if (normalizedParty.some(name => !owned.has(name))) return { accepted: false, reason: 'H19_PARTY_POLICY_CONTAINS_NON_OWNED_CHARACTER' };
        if (normalizedParty.some(name => !activeDesired.has(name))) return { accepted: false, reason: 'H19_PARTY_MEMBER_NOT_DESIRED_ACTIVE' };
        this.policyState.desiredPartyMemberNames = normalizedParty.sort((a,b) => a.localeCompare(b));
        if (this.policyState.desiredPartyLeader && !this.policyState.desiredPartyMemberNames.includes(this.policyState.desiredPartyLeader)) {
          this.policyState.desiredPartyLeader = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(next, 'desiredPartyLeader')) {
        if (!roster || roster.accountStateAvailable !== true) return { accepted: false, reason: 'H19_ACCOUNT_ROSTER_UNAVAILABLE' };
        const leader = cleanText(next.desiredPartyLeader || '', 120) || null;
        const owned = new Set((roster.accountCharacters || []).map(row => String(row.name || '')));
        if (leader && !owned.has(leader)) return { accepted: false, reason: 'H19_PARTY_LEADER_NOT_OWNED' };
        if (leader && !this.policyState.desiredPartyMemberNames.includes(leader)) return { accepted: false, reason: 'H19_PARTY_LEADER_NOT_DESIRED_MEMBER' };
        this.policyState.desiredPartyLeader = leader;
      }
      if (next.maxActionsPerSession != null) {
        const value = Math.floor(Number(next.maxActionsPerSession));
        if (!Number.isFinite(value) || value < 1 || value > 20) return { accepted: false, reason: 'H19_INVALID_SESSION_BUDGET' };
        this.config.maxActionsPerSession = value;
      }
      const nextDesiredKey = this.policyState.desiredActiveNames.join('\u0000');
      if (nextDesiredKey !== previousDesiredKey) {
        this.browserSwapRecoveryAttempts.clear();
        this.pendingBrowserSwapRecoveryKey = null;
      }
      this._persistPolicy();
      return { accepted: true, policy: clone({ ...this.policyState, maxActionsPerSession: this.config.maxActionsPerSession }) };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H19_MODULE_NOT_ACTIVE' };
      if (this.suspended) return { accepted: false, reason: this.suspendedReason || 'H19_SUSPENDED' };
      if (options.captureCurrent === true) {
        const captured = this.captureDesiredActive();
        if (!captured.accepted) return captured;
      }
      if (options.maxActions != null) {
        const value = Math.floor(Number(options.maxActions));
        if (!Number.isFinite(value) || value < 1 || value > 20) return { accepted: false, reason: 'H19_INVALID_SESSION_BUDGET' };
        this.config.maxActionsPerSession = value;
      }
      this.actionsThisSession = 0;
      this.autonomyEnabled = true;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STARTED', desiredActiveNames: clone(this.policyState.desiredActiveNames) };
      return { accepted: true, status: this.status() };
    }

    stopAutonomy(reason = 'H19_AUTONOMY_STOP') {
      this.autonomyEnabled = false;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STOPPED', reason: cleanText(reason, 200) };
      return { accepted: true, status: this.status() };
    }

    resetSafety(reason = 'H19_EXPLICIT_RESET') {
      if (this.currentAction) return { accepted: false, reason: 'H19_ACTION_IN_FLIGHT' };
      this.suspended = false;
      this.suspendedReason = null;
      this.lastAction = { at: nowIso(), type: 'SAFETY_RESET', reason: cleanText(reason, 200) };
      return { accepted: true, status: this.status() };
    }

    acknowledgeUnknown(reason = 'H19_EXPLICIT_UNKNOWN_ACK') {
      const current = this.currentAction;
      if (!this.suspended || !current || current.unknownRecorded !== true) {
        return { accepted: false, reason: 'H19_NO_UNKNOWN_ACTION_TO_ACKNOWLEDGE' };
      }
      const acknowledged = clone(current);
      this.settlementGeneration += 1;
      this.currentAction = null;
      this._removeStorage('pending');
      this.lastAction = {
        at: nowIso(),
        type: 'UNKNOWN_ACKNOWLEDGED',
        reason: cleanText(reason, 200),
        actionId: acknowledged.id || null,
        kind: acknowledged.kind || null,
        targetName: acknowledged.targetName || null
      };
      return {
        accepted: true,
        acknowledged,
        safetyResetRequired: true,
        status: this.status()
      };
    }

    _proposalPartySignal(roster) {
      const party = this._partySnapshot();
      const members = this._partyMemberSet(party);
      const foreign = party && Array.isArray(party.foreignMemberNames) ? party.foreignMemberNames : [];
      const leader = this.policyState.desiredPartyLeader;
      if (foreign.length) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_FOREIGN_PARTY_MEMBER_PRESENT' };
      }
      if (party && party.partyId && party.leader && leader && String(party.leader) !== String(leader)) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_DIFFERENT_PARTY_LEADER_ACTIVE' };
      }
      const nowMs = Date.now();
      while (this.partySignals.length) {
        const signal = this.partySignals[0];
        if (!signal || nowMs - Number(signal.observedAtMs || 0) > this.config.outcomeTimeoutMs * 2) {
          this.partySignals.shift();
          continue;
        }
        if (members.has(String(signal.targetName || ''))) {
          this.partySignals.shift();
          continue;
        }
        const active = this._onlineSet(roster);
        if (!active.has(String(signal.targetName || '')) || !this._ownedRow(signal.targetName, roster)) {
          this.partySignals.shift();
          continue;
        }
        if (signal.kind === 'INVITE') {
          return {
            state: 'READY',
            reason: 'H19_OWNED_PARTY_INVITE_OBSERVED',
            request: {
              id: 'h19-auto-accept-invite-' + signal.targetName,
              kind: 'PARTY_ACCEPT_INVITE',
              targetName: signal.targetName,
              queuedAt: nowIso(),
              automatic: true,
              signalId: signal.id
            }
          };
        }
        if (signal.kind === 'REQUEST') {
          return {
            state: 'READY',
            reason: 'H19_OWNED_PARTY_REQUEST_OBSERVED',
            request: {
              id: 'h19-auto-accept-request-' + signal.targetName,
              kind: 'PARTY_ACCEPT_REQUEST',
              targetName: signal.targetName,
              queuedAt: nowIso(),
              automatic: true,
              signalId: signal.id
            }
          };
        }
        this.partySignals.shift();
      }
      return null;
    }

    _proposalFromDesired() {
      const roster = this._roster();
      if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
        return { state: 'BLOCKED', reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
      }

      const active = this._onlineSet(roster);
      const startEvidence = this._startEvidenceSet(roster);
      const localName = this._localName();
      const desiredActive = new Set(this.policyState.desiredActiveNames.map(String));

      // Separate browser windows are rotated in-place: navigate the outgoing
      // browser directly to the missing desired character on the same server.
      // This avoids disconnect/reconnect races and avoids mixing the browser
      // model with child-runner start_character().
      const undesiredActive = [...active]
        .filter(name => this._ownedRow(name, roster) && !desiredActive.has(String(name)))
        .sort((a, b) => a.localeCompare(b));
      const runnerActive = this._runnerActiveSet(roster);
      const missingDesired = [...desiredActive]
        .filter(name => this._ownedRow(name, roster) && !startEvidence.has(String(name)))
        .sort((a, b) => a.localeCompare(b));
      const remainingMissing = missingDesired.slice();
      for (const name of undesiredActive) {
        if (String(name) === String(localName)) {
          return {
            state: 'BLOCKED',
            reason: remainingMissing.length
              ? 'H27_ROTATION_LOCAL_REPLACEMENT_REQUIRES_MERCHANT_COORDINATOR:' + name
              : 'H19_ROTATION_WOULD_STOP_LOCAL:' + name
          };
        }
        const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
          ? this.crossWindow.freshPeer(name)
          : null;
        if (!runnerActive.has(String(name))
            && remainingMissing.length
            && peer && peer.running === true
            && peer.characterNavigateCapable === true
            && peer.characterDisconnectCapable === true
            && this.crossWindow && typeof this.crossWindow.requestCharacterNavigation === 'function') {
          const desiredName = String(remainingMissing[0] || '');
          const recoveryAttempts = this._browserSwapRecoveryCount(name, desiredName);
          const recoveryKey = this._browserSwapRecoveryKey(name, desiredName);
          const retryPermit = !!recoveryKey && this.pendingBrowserSwapRecoveryKey === recoveryKey;
          if (recoveryAttempts >= this.config.browserSwapSessionRecoveryLimit && !retryPermit) {
            return {
              state: 'BLOCKED',
              reason: 'H31_BROWSER_SWAP_RETRY_LIMIT_REACHED:' + name + '->' + desiredName,
              targetName: name,
              desiredName,
              recoveryAttempts,
              recoveryLimit: this.config.browserSwapSessionRecoveryLimit
            };
          }
          remainingMissing.shift();
          return {
            state: 'READY',
            reason: 'H25_BROWSER_CHARACTER_ROTATION',
            request: {
              id: 'h25-auto-browser-swap-' + name + '-to-' + desiredName,
              kind: 'BROWSER_SWAP',
              targetName: name,
              desiredName,
              queuedAt: nowIso(),
              automatic: true,
              requireCharacterStateChange: true
            }
          };
        }
        return {
          state: 'READY',
          reason: 'H19_UNDESIRED_CHARACTER_ACTIVE',
          request: {
            id: 'h19-auto-stop-' + name,
            kind: 'STOP',
            targetName: name,
            queuedAt: nowIso(),
            automatic: true,
            requireCharacterStateChange: true
          }
        };
      }

      for (const name of this.policyState.desiredRuntimeRunningNames) {
        if (name === localName) continue;
        if (!this._ownedRow(name, roster)) continue;
        const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
          ? this.crossWindow.freshPeer(name)
          : null;
        if (!peer) {
          return {
            state: 'BLOCKED',
            reason: 'H19_DESIRED_RUNTIME_PEER_UNAVAILABLE',
            targetName: name
          };
        }
        if (peer.running !== true) {
          return {
            state: 'READY',
            reason: 'H19_DESIRED_REMOTE_RUNTIME_STOPPED',
            request: {
              id: 'h19-auto-runtime-start-' + name,
              kind: 'START',
              targetName: name,
              queuedAt: nowIso(),
              automatic: true,
              transportHint: 'cross-window-runtime'
            }
          };
        }
      }

      const crossWindowManaged = new Set(this.policyState.desiredRuntimeRunningNames.map(String));
      for (const name of this.policyState.desiredActiveNames) {
        if (name === localName) continue;
        if (!this._ownedRow(name, roster)) continue;
        if (crossWindowManaged.has(name)) continue;
        if (!startEvidence.has(name)) {
          const occupiedCharacterNames = [...startEvidence]
            .filter(value => this._ownedRow(value, roster))
            .sort((a, b) => a.localeCompare(b));
          if (occupiedCharacterNames.length >= 4) {
            return {
              state: 'BLOCKED',
              reason: 'H27_ACCOUNT_CHARACTER_SLOT_LIMIT_REACHED',
              targetName: name,
              occupiedCharacterNames
            };
          }
          const retry = this.transientStartRetries.get(String(name)) || null;
          if (retry && Number(retry.retryAtMs || 0) > Date.now()) {
            this.metrics.transientStartRetryBlocks += 1;
            return {
              state: 'WAITING',
              reason: 'H19_START_AUTHORIZATION_IN_PROGRESS',
              targetName: name,
              retryAtMs: Number(retry.retryAtMs)
            };
          }
          if (retry && Number(retry.retryAtMs || 0) <= Date.now()) this.transientStartRetries.delete(String(name));
          return {
            state: 'READY',
            reason: 'H19_DESIRED_CHARACTER_OFFLINE',
            request: {
              id: 'h19-auto-start-' + name,
              kind: 'START',
              targetName: name,
              queuedAt: nowIso(),
              automatic: true,
              requireCharacterStateChange: true
            }
          };
        }
      }

      // Only reconcile party invitations/leader topology after the desired
      // four-character active/runtime set is healthy. During a farmer rotation
      // the old party leader may still be visible in a stale party snapshot.
      const signalProposal = this._proposalPartySignal(roster);
      if (signalProposal) return signalProposal;

      const desiredPartyMembers = this.policyState.desiredPartyMemberNames;
      const leader = this.policyState.desiredPartyLeader;
      if (!leader || !desiredPartyMembers.length) return { state: 'IDLE', reason: 'H19_DESIRED_ACTIVE_SET_HEALTHY' };
      const party = this._partySnapshot();
      const members = this._partyMemberSet(party);
      const foreign = party && Array.isArray(party.foreignMemberNames) ? party.foreignMemberNames : [];
      if (foreign.length) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_FOREIGN_PARTY_MEMBER_PRESENT' };
      }

      if (party && party.partyId && party.leader && String(party.leader) !== String(leader)) {
        this.metrics.partyConflictBlocks += 1;
        return { state: 'BLOCKED', reason: 'H19_DIFFERENT_PARTY_LEADER_ACTIVE' };
      }

      if (String(localName) === String(leader)) {
        const peerUnavailableNames = [];
        const retryBlockedNames = [];
        for (const name of desiredPartyMembers) {
          if (name === localName || !active.has(name) || members.has(name)) continue;

          const retry = this.partyRetryBackoffs.get(String(name)) || null;
          if (retry && Number(retry.retryAtMs || 0) > Date.now()) {
            retryBlockedNames.push(String(name));
            this.metrics.partyRetryBlocks += 1;
            continue;
          }
          if (retry) this.partyRetryBackoffs.delete(String(name));

          if (this.crossWindow && typeof this.crossWindow.freshPeer === 'function') {
            const peer = this.crossWindow.freshPeer(name);
            if (!peer || peer.running !== true) {
              peerUnavailableNames.push(String(name));
              this.metrics.partyPeerBlocks += 1;
              continue;
            }
          }

          return {
            state: 'READY',
            reason: 'H19_DESIRED_PARTY_MEMBER_MISSING',
            request: {
              id: 'h19-auto-party-invite-' + name,
              kind: 'PARTY_INVITE',
              targetName: name,
              queuedAt: nowIso(),
              automatic: true
            }
          };
        }
        if (peerUnavailableNames.length || retryBlockedNames.length) {
          return {
            state: 'WAITING',
            reason: peerUnavailableNames.length
              ? 'H33_PARTY_MEMBER_PEER_UNAVAILABLE'
              : 'H33_PARTY_MEMBER_RETRY_BACKOFF',
            peerUnavailableNames,
            retryBlockedNames
          };
        }
      } else if (desiredPartyMembers.includes(localName) && active.has(String(leader)) && !members.has(String(leader))) {
        return {
          state: 'READY',
          reason: 'H19_DESIRED_PARTY_LEADER_MISSING',
          request: {
            id: 'h19-auto-party-request-' + leader,
            kind: 'PARTY_REQUEST',
            targetName: leader,
            queuedAt: nowIso(),
            automatic: true
          }
        };
      }

      return { state: 'IDLE', reason: 'H19_DESIRED_ACTIVE_AND_PARTY_SET_HEALTHY' };
    }

    plan() {
      this.metrics.plans += 1;
      if (!this.moduleActive) return this.lastPlan = { state: 'BLOCKED', reason: 'H19_MODULE_NOT_ACTIVE' };
      if (this.suspended) return this.lastPlan = { state: 'SUSPENDED', reason: this.suspendedReason || 'H19_SUSPENDED' };
      if (this.currentAction) return this.lastPlan = { state: 'PENDING', reason: 'H19_ACTION_IN_FLIGHT', currentAction: clone(this.currentAction) };
      if (this.queue.length) return this.lastPlan = { state: 'READY', reason: 'H19_QUEUED_ACTION', request: clone(this.queue[0]) };

      const local = this._local();
      if (this.autonomyEnabled && local && local.rip === true) {
        return this.lastPlan = {
          state: 'READY',
          reason: 'H19_LOCAL_DEATH_RECOVERY',
          request: { id: 'h19-auto-respawn-' + this._localName(), kind: 'RESPAWN', targetName: this._localName(), automatic: true }
        };
      }

      if (!this.autonomyEnabled) {
        // Non-coordinator windows stay passive for proactive lifecycle recovery,
        // but they must still finish a validated inbound owned-party handshake.
        // Otherwise the coordinator can invite forever while the target only
        // observes the signal and never accepts it.
        const roster = this._roster();
        if (roster && roster.accountStateAvailable === true && roster.onlineStateAvailable === true) {
          const signalProposal = this._proposalPartySignal(roster);
          if (signalProposal) return this.lastPlan = signalProposal;
        }
        return this.lastPlan = { state: 'OBSERVE', reason: 'H19_AUTONOMY_DISABLED' };
      }
      return this.lastPlan = this._proposalFromDesired();
    }

    _watchSettlement(value, action) {
      const generation = this.settlementGeneration;
      if (!value || typeof value.then !== 'function') {
        if (!this.moduleActive || generation !== this.settlementGeneration) return;
        action.settlement = 'RETURNED';
        action.response = value == null ? null : clone(value);
        this._persistCurrent();
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.moduleActive || generation !== this.settlementGeneration) return;
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'RESOLVED';
        this.currentAction.response = response == null ? null : clone(response);
        this._persistCurrent();
      }).catch(error => {
        if (!this.moduleActive || generation !== this.settlementGeneration) return;
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'REJECTED';
        this.currentAction.error = errorReason(error, 'H19_ACTION_PROMISE_REJECTED');
        this._persistCurrent();
      });
    }

    _dispatch(request) {
      if (!request) return { accepted: false, reason: 'H19_REQUEST_REQUIRED' };
      if (!this.canAct('h19:' + request.kind.toLowerCase())) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H19_ACTION_GATE_BLOCKED' };
      }

      let actionName;
      let args;
      let before = {};
      if (request.kind === 'BROWSER_SWAP') {
        const check = this._validateRemoteTarget(request.targetName, 'BROWSER_SWAP', {
          desiredName: request.desiredName
        });
        if (!check.ok) return { accepted: false, reason: check.reason };
        actionName = null;
        args = [];
        before = {
          onlineStateAvailable: true,
          targetWasActive: check.active,
          desiredWasPresent: this._startEvidenceSet(check.roster).has(String(check.desiredName)),
          transport: check.transport,
          targetSessionId: check.peer && check.peer.sessionId || null
        };
      } else if (request.kind === 'START' || request.kind === 'STOP') {
        const check = this._validateRemoteTarget(request.targetName, request.kind, {
          requireCharacterStateChange: request.requireCharacterStateChange === true
        });
        if (!check.ok) return { accepted: false, reason: check.reason };
        actionName = request.kind === 'START' ? 'start_character' : 'stop_character';
        args = [request.targetName];
        before = {
          onlineStateAvailable: true,
          targetWasActive: check.active,
          transport: check.transport || 'child-character',
          targetSessionId: check.peer && check.peer.sessionId || null,
          targetRuntimeWasRunning: check.peer ? check.peer.running === true : null,
          requireCharacterStateChange: request.requireCharacterStateChange === true
        };
      } else if (request.kind === 'RESPAWN') {
        const readiness = this._respawnReadiness();
        if (!readiness.ready) {
          if (readiness.reason === 'H19_RESPAWN_COOLDOWN') this.metrics.respawnCooldownBlocks += 1;
          return {
            accepted: false,
            state: 'WAIT',
            reason: readiness.reason,
            readyAtMs: readiness.readyAtMs,
            waitMs: readiness.waitMs
          };
        }
        actionName = 'respawn';
        args = [];
        before = {
          targetWasDead: true,
          deathObservedAtMs: readiness.observedAtMs,
          respawnReadyAtMs: readiness.readyAtMs
        };
      } else if (['PARTY_INVITE', 'PARTY_REQUEST', 'PARTY_ACCEPT_INVITE', 'PARTY_ACCEPT_REQUEST'].includes(request.kind)) {
        const roster = this._roster();
        if (!roster || roster.accountStateAvailable !== true || roster.onlineStateAvailable !== true) {
          return { accepted: false, reason: 'H19_ROSTER_LIVE_STATE_UNAVAILABLE' };
        }
        if (!this._ownedRow(request.targetName, roster)) {
          this.metrics.ownershipBlocks += 1;
          return { accepted: false, reason: 'H19_PARTY_TARGET_NOT_OWNED' };
        }
        if (!this._onlineSet(roster).has(String(request.targetName || ''))) {
          return { accepted: false, reason: 'H19_PARTY_TARGET_NOT_ACTIVE' };
        }
        const party = this._partySnapshot();
        const members = this._partyMemberSet(party);
        if (members.has(String(request.targetName || ''))) {
          return { accepted: false, reason: 'H19_PARTY_TARGET_ALREADY_MEMBER' };
        }
        const mapping = {
          PARTY_INVITE: 'send_party_invite',
          PARTY_REQUEST: 'send_party_request',
          PARTY_ACCEPT_INVITE: 'accept_party_invite',
          PARTY_ACCEPT_REQUEST: 'accept_party_request'
        };
        actionName = mapping[request.kind];
        args = [request.targetName];
        before = {
          partyId: party && party.partyId || null,
          leader: party && party.leader || null,
          memberNames: [...members]
        };
      } else {
        return { accepted: false, reason: 'H19_REQUEST_KIND_UNSUPPORTED' };
      }

      const nowMs = Date.now();
      const action = {
        id: 'h19-action-' + (++this.sequence),
        requestId: request.id,
        kind: request.kind,
        targetName: request.targetName || null,
        desiredName: request.desiredName || null,
        automatic: request.automatic === true,
        requireCharacterStateChange: request.requireCharacterStateChange === true,
        signalId: request.signalId || null,
        preparedAt: nowIso(),
        preparedAtMs: nowMs,
        deadlineAtMs: nowMs + (request.kind === 'BROWSER_SWAP'
          ? this.config.browserSwapTimeoutMs
          : request.kind === 'START'
            ? this.config.startOutcomeTimeoutMs
            : this.config.outcomeTimeoutMs),
        settlement: 'PREPARED',
        restored: false,
        response: null,
        error: null,
        before,
        transport: before.transport || 'game-action'
      };
      this.currentAction = action;
      this._persistCurrent();

      let dispatched;
      try {
        if (request.kind === 'BROWSER_SWAP' && action.transport === 'local-browser-navigation') {
          if (!this.navigateCharacterLocal) throw new Error('H25_LOCAL_BROWSER_NAVIGATION_TRANSPORT_UNAVAILABLE');
          const value = this.navigateCharacterLocal(request.desiredName);
          dispatched = {
            id: 'h25-local-navigation-' + this.sequence,
            state: 'DISPATCHED',
            dispatched: true,
            value: Promise.resolve({ success: true, reason: 'H25_LOCAL_BROWSER_NAVIGATION_ACCEPTED', details: value || null })
          };
          this.metrics.browserSwapsDispatched += 1;
        } else if (request.kind === 'BROWSER_SWAP' && action.transport === 'cross-window-browser-navigation') {
          if (!this.crossWindow || typeof this.crossWindow.requestCharacterNavigation !== 'function') {
            throw new Error('H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TRANSPORT_UNAVAILABLE');
          }
          dispatched = this.crossWindow.requestCharacterNavigation(request.targetName, request.desiredName);
          this.metrics.crossWindowDispatches += 1;
          this.metrics.browserSwapsDispatched += 1;
        } else if ((request.kind === 'START' || request.kind === 'STOP')
            && action.transport === 'cross-window-runtime') {
          if (!this.crossWindow || typeof this.crossWindow.requestRuntimeState !== 'function') {
            throw new Error('H19_CROSS_WINDOW_TRANSPORT_UNAVAILABLE');
          }
          dispatched = this.crossWindow.requestRuntimeState(request.targetName, request.kind === 'START');
          this.metrics.crossWindowDispatches += 1;
        } else if (request.kind === 'STOP' && action.transport === 'cross-window-character-disconnect') {
          if (!this.crossWindow || typeof this.crossWindow.requestCharacterDisconnect !== 'function') {
            throw new Error('H24_CROSS_WINDOW_CHARACTER_DISCONNECT_TRANSPORT_UNAVAILABLE');
          }
          dispatched = this.crossWindow.requestCharacterDisconnect(request.targetName);
          this.metrics.crossWindowDispatches += 1;
          this.metrics.crossWindowCharacterDisconnects += 1;
        } else {
          dispatched = this.actions.dispatch(actionName, args);
        }
      } catch (error) {
        this.currentAction = null;
        this._removeStorage('pending');
        this.metrics.actionsRejected += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_REJECTED_PRE_DISPATCH', reason: errorReason(error) };
        return { accepted: false, reason: errorReason(error) };
      }

      if (dispatched && dispatched.state === 'UNKNOWN' && dispatched.dispatched === true) {
        action.settlement = 'UNKNOWN';
        action.actionBoundaryId = dispatched.id || null;
        action.error = errorReason(dispatched.error, 'H19_DISPATCH_SYNC_UNKNOWN');
        this.currentAction = action;
        this.metrics.actionsDispatched += 1;
        if (request.kind === 'PARTY_INVITE') this.metrics.partyInvitesDispatched += 1;
        if (request.kind === 'PARTY_REQUEST') this.metrics.partyRequestsDispatched += 1;
        if (request.kind === 'PARTY_ACCEPT_INVITE' || request.kind === 'PARTY_ACCEPT_REQUEST') this.metrics.partyAcceptsDispatched += 1;
        this._persistCurrent();
        return this._suspend('H19_DISPATCH_SYNC_UNKNOWN', { error: action.error });
      }

      if (!dispatched || dispatched.state !== 'DISPATCHED') {
        const reason = dispatched && dispatched.error && dispatched.error.message || 'H19_ACTION_NOT_DISPATCHED';
        this.currentAction = null;
        this._removeStorage('pending');
        this.metrics.actionsRejected += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_REJECTED_PRE_DISPATCH', reason: cleanText(reason, 300) };
        return { accepted: false, reason: cleanText(reason, 300) };
      }

      action.settlement = 'PENDING';
      action.actionBoundaryId = dispatched.id || null;
      this.currentAction = action;
      if (request.kind === 'BROWSER_SWAP') {
        const recoveryKey = this._browserSwapRecoveryKey(request.targetName, request.desiredName);
        if (recoveryKey && this.pendingBrowserSwapRecoveryKey === recoveryKey) {
          const attempts = Number(this.browserSwapRecoveryAttempts.get(recoveryKey) || 0);
          this.browserSwapRecoveryAttempts.set(recoveryKey, attempts + 1);
          this.pendingBrowserSwapRecoveryKey = null;
        }
      }
      this.metrics.actionsDispatched += 1;
      if (request.kind === 'PARTY_INVITE') this.metrics.partyInvitesDispatched += 1;
      if (request.kind === 'PARTY_REQUEST') this.metrics.partyRequestsDispatched += 1;
      if (request.kind === 'PARTY_ACCEPT_INVITE' || request.kind === 'PARTY_ACCEPT_REQUEST') this.metrics.partyAcceptsDispatched += 1;
      this._persistCurrent();
      this._watchSettlement(dispatched.value, action);
      this.lastAction = { at: nowIso(), type: request.kind + '_DISPATCHED', actionId: action.id, targetName: action.targetName };
      return { accepted: true, state: 'DISPATCHED', currentAction: clone(action) };
    }

    _confirmCurrent(details = {}) {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };
      this.currentAction = null;
      this._removeStorage('pending');
      this.metrics.actionsConfirmed += 1;
      this.actionsThisSession += 1;
      if (current.kind === 'START') this.metrics.startsConfirmed += 1;
      if (current.kind === 'STOP') this.metrics.stopsConfirmed += 1;
      if (current.kind === 'BROWSER_SWAP') {
        this.metrics.browserSwapsConfirmed += 1;
        const recoveryKey = this._browserSwapRecoveryKey(current.targetName, current.desiredName);
        if (recoveryKey) {
          this.browserSwapRecoveryAttempts.delete(recoveryKey);
          if (this.pendingBrowserSwapRecoveryKey === recoveryKey) this.pendingBrowserSwapRecoveryKey = null;
        }
      }
      if (current.kind === 'RESPAWN') this.metrics.respawnsConfirmed += 1;
      if (current.kind === 'PARTY_INVITE') this.metrics.partyInvitesConfirmed += 1;
      if (current.kind === 'PARTY_REQUEST') this.metrics.partyRequestsConfirmed += 1;
      if (current.kind === 'PARTY_ACCEPT_INVITE' || current.kind === 'PARTY_ACCEPT_REQUEST') this.metrics.partyAcceptsConfirmed += 1;
      if ((current.kind === 'PARTY_ACCEPT_INVITE' || current.kind === 'PARTY_REQUEST') && !this.policyState.desiredPartyLeader) {
        this.policyState.desiredPartyLeader = current.targetName || null;
        this._persistPolicy();
      }
      if (current.signalId) this.partySignals = this.partySignals.filter(row => String(row.id) !== String(current.signalId));
      const timeoutReason = 'H19_' + current.kind + '_UNVERIFIED_TIMEOUT';
      const lateConfirmed = current.unknownRecorded === true
        && this.suspended === true
        && this.suspendedReason === timeoutReason;
      if (lateConfirmed) {
        this.suspended = false;
        this.suspendedReason = null;
        if (current.automatic === true) this.autonomyEnabled = true;
        this.metrics.lateOutcomeRecoveries += 1;
      }
      this.lastAction = {
        at: nowIso(),
        type: current.kind + '_CONFIRMED',
        targetName: current.targetName,
        desiredName: current.desiredName || null,
        lateConfirmed,
        ...clone(details)
      };
      return {
        state: 'CONFIRMED',
        kind: current.kind,
        targetName: current.targetName,
        desiredName: current.desiredName || null,
        lateConfirmed,
        details: clone(details)
      };
    }

    _suspend(reason, details = {}) {
      const current = this.currentAction;
      const alreadyRecorded = !!(current && current.unknownRecorded === true);
      this.suspended = true;
      this.suspendedReason = cleanText(reason, 300) || 'H19_SUSPENDED';
      this.autonomyEnabled = false;
      if (!alreadyRecorded) this.metrics.actionsUnknown += 1;
      if (current) {
        current.unknownRecorded = true;
        this.currentAction = current;
        this._persistCurrent();
      }
      this.lastAction = { at: nowIso(), type: 'SUSPENDED', reason: this.suspendedReason, repeated: alreadyRecorded, ...clone(details) };
      if (!alreadyRecorded && this.logger) this.logger.error('H19 Lifecycle Recovery suspendiert', this.lastAction);
      return { state: 'UNKNOWN', reason: this.suspendedReason, currentAction: clone(this.currentAction) };
    }

    _observeCurrent() {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };

      const settlementFinished = current.settlement !== 'PENDING' && current.settlement !== 'PREPARED';
      if (current.kind === 'BROWSER_SWAP') {
        const roster = this._roster();
        if (roster && roster.onlineStateAvailable === true) {
          const oldGone = !this._onlineSet(roster).has(String(current.targetName || ''));
          const desiredName = String(current.desiredName || '');
          const desiredPresent = !!desiredName && this._startEvidenceSet(roster).has(desiredName);
          const desiredPeer = desiredName && this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
            ? this.crossWindow.freshPeer(desiredName)
            : null;
          const desiredRuntimeRunning = !!(desiredPeer && desiredPeer.running === true);
          const desiredFullAutonomyEnabled = !!(desiredPeer && desiredPeer.fullAutonomyEnabled === true);
          if (oldGone && desiredRuntimeRunning && desiredFullAutonomyEnabled) {
            this.metrics.crossWindowConfirms += 1;
            return this._confirmCurrent({
              evidence: 'BROWSER_SWAP_NEW_RUNTIME_READY',
              oldCharacterOffline: true,
              desiredCharacterPresent: desiredPresent,
              desiredRuntimeLoaded: true,
              desiredRuntimeRunning: true,
              desiredFullAutonomyEnabled: true,
              desiredSessionId: desiredPeer.sessionId || null
            });
          }

          // A browser rotation can destroy/reload the outgoing target runtime
          // before its command settlement comes back. If the same character is
          // now live under a new session while the desired replacement is still
          // absent, the old action boundary can never settle. Reconcile it as
          // stale and immediately re-plan against the fresh target session.
          const targetName = String(current.targetName || '');
          const targetPeer = targetName && this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
            ? this.crossWindow.freshPeer(targetName)
            : null;
          const previousTargetSessionId = current.before && current.before.targetSessionId
            ? String(current.before.targetSessionId)
            : '';
          const targetSessionId = targetPeer && targetPeer.sessionId
            ? String(targetPeer.sessionId)
            : '';
          const targetSessionReplaced = !!previousTargetSessionId
            && !!targetSessionId
            && targetSessionId !== previousTargetSessionId;
          const targetStillOnline = !!targetName && this._onlineSet(roster).has(targetName);
          const targetRetryCapable = !!(targetPeer
            && targetPeer.running === true
            && targetPeer.characterNavigateCapable === true
            && targetPeer.characterDisconnectCapable === true);

          if (targetSessionReplaced && targetStillOnline && !desiredPresent && targetRetryCapable) {
            const recoveryKey = this._browserSwapRecoveryKey(targetName, desiredName);
            const previousRecoveries = recoveryKey
              ? Number(this.browserSwapRecoveryAttempts.get(recoveryKey) || 0)
              : 0;
            const recoveryLimit = this.config.browserSwapSessionRecoveryLimit;

            this.currentAction = null;
            this._removeStorage('pending');
            this.metrics.reconciliations += 1;
            this.metrics.stalePendingDiscarded += 1;

            const resumedAutonomy = current.automatic === true;
            if (resumedAutonomy) {
              this.suspended = false;
              this.suspendedReason = null;
              this.autonomyEnabled = true;
            }

            if (previousRecoveries >= recoveryLimit) {
              if (this.pendingBrowserSwapRecoveryKey === recoveryKey) this.pendingBrowserSwapRecoveryKey = null;
              this.metrics.browserSwapRecoveryBlocks += 1;
              this.lastAction = {
                at: nowIso(),
                type: 'BROWSER_SWAP_RECOVERY_LIMIT_REACHED',
                actionId: current.id || null,
                requestId: current.requestId || null,
                targetName,
                desiredName: desiredName || null,
                previousTargetSessionId,
                targetSessionId,
                recoveryAttempts: previousRecoveries,
                recoveryLimit,
                autonomyResumed: resumedAutonomy
              };
              return {
                state: 'BLOCKED',
                reason: 'H31_BROWSER_SWAP_RETRY_LIMIT_REACHED:' + targetName + '->' + desiredName,
                targetName,
                desiredName: desiredName || null,
                recoveryAttempts: previousRecoveries,
                recoveryLimit,
                autonomyResumed: resumedAutonomy
              };
            }

            if (recoveryKey) this.pendingBrowserSwapRecoveryKey = recoveryKey;
            this.metrics.browserSwapSessionRecoveries += 1;
            this.lastAction = {
              at: nowIso(),
              type: 'BROWSER_SWAP_TARGET_SESSION_REPLACED_RETRY',
              actionId: current.id || null,
              requestId: current.requestId || null,
              targetName,
              desiredName: desiredName || null,
              previousTargetSessionId,
              targetSessionId,
              recoveryAttempts: previousRecoveries,
              retryPermitGranted: !!recoveryKey,
              recoveryLimit,
              previousSettlement: current.settlement || null,
              previousError: current.error || null,
              autonomyResumed: resumedAutonomy
            };
            return {
              state: 'IDLE',
              reason: 'H30_BROWSER_SWAP_TARGET_SESSION_REPLACED_RETRY',
              targetName,
              desiredName: desiredName || null,
              previousTargetSessionId,
              targetSessionId,
              recoveryAttempts: previousRecoveries,
              retryPermitGranted: !!recoveryKey,
              recoveryLimit,
              autonomyResumed: resumedAutonomy
            };
          }
        }
      } else if (current.kind === 'START' || current.kind === 'STOP') {
        if (current.transport === 'cross-window-character-disconnect') {
          const roster = this._roster();
          if (roster && roster.onlineStateAvailable === true) {
            const active = this._onlineSet(roster).has(String(current.targetName || ''));
            if (!active && current.before && current.before.targetWasActive === true) {
              // Account-wide offline truth is the terminal mutation evidence.
              // It is intentionally sufficient even if the CM settlement was
              // lost because the target disconnected immediately afterwards.
              this.metrics.crossWindowConfirms += 1;
              return this._confirmCurrent({ evidence: 'ACTIVE_ROSTER_ABSENT_AFTER_REMOTE_SELF_DISCONNECT' });
            }
          }
        } else if (current.transport === 'cross-window-runtime') {
          const desiredRunning = current.kind === 'START';
          const peer = this.crossWindow && typeof this.crossWindow.freshPeer === 'function'
            ? this.crossWindow.freshPeer(current.targetName)
            : null;
          const sameSession = !!peer
            && !!current.before
            && !!current.before.targetSessionId
            && String(peer.sessionId || '') === String(current.before.targetSessionId);
          const responseSuccess = current.response && current.response.success === true;
          const restoredReconciled = current.restored === true && settlementFinished && sameSession;
          if (settlementFinished
              && sameSession
              && peer.running === desiredRunning
              && (responseSuccess || restoredReconciled)) {
            this.metrics.crossWindowConfirms += 1;
            return this._confirmCurrent({
              evidence: restoredReconciled ? 'CROSS_WINDOW_RUNTIME_RECONCILED' : 'CROSS_WINDOW_RUNTIME_SETTLEMENT',
              targetSessionId: peer.sessionId,
              running: peer.running
            });
          }
          const replacedSession = !!peer
            && !!current.before
            && !!current.before.targetSessionId
            && !!peer.sessionId
            && String(peer.sessionId) !== String(current.before.targetSessionId);
          if (replacedSession && peer.running === desiredRunning) {
            this.metrics.crossWindowConfirms += 1;
            return this._confirmCurrent({
              evidence: 'CROSS_WINDOW_RUNTIME_REPLACED_SESSION_LIVE_STATE',
              previousTargetSessionId: current.before.targetSessionId,
              targetSessionId: peer.sessionId,
              running: peer.running
            });
          }
        } else {
          const roster = this._roster();
          if (roster && roster.onlineStateAvailable === true) {
            const active = this._onlineSet(roster).has(String(current.targetName || ''));
            const startPresent = this._startEvidenceSet(roster).has(String(current.targetName || ''));
            if (settlementFinished && current.kind === 'START' && startPresent) {
              return this._confirmCurrent({ evidence: active ? 'ACTIVE_ROSTER_PRESENT' : 'RUNNER_START_STATE_PRESENT' });
            }
            if (settlementFinished && current.kind === 'STOP' && !active && current.before && current.before.targetWasActive === true) {
              return this._confirmCurrent({ evidence: 'ACTIVE_ROSTER_ABSENT' });
            }
          }
        }
      } else if (current.kind === 'RESPAWN') {
        const local = this._local();
        if (settlementFinished && local && String(local.name || '') === String(current.targetName || '') && local.rip !== true) {
          return this._confirmCurrent({ evidence: 'LOCAL_CHARACTER_ALIVE' });
        }
      } else if (['PARTY_INVITE', 'PARTY_REQUEST', 'PARTY_ACCEPT_INVITE', 'PARTY_ACCEPT_REQUEST'].includes(current.kind)) {
        const party = this._partySnapshot();
        const members = this._partyMemberSet(party);
        const localName = this._localName();
        if (settlementFinished
          && party
          && party.partyId
          && members.has(String(current.targetName || ''))
          && members.has(String(localName || ''))) {
          return this._confirmCurrent({ evidence: 'PARTY_SNAPSHOT_MEMBERSHIP', partyId: party.partyId, leader: party.leader || null });
        }
      }

      if (current.response && (current.response.failed === true || current.response.success === false)) {
        const reason = current.response.reason || 'H19_SERVER_REJECTED';
        this.currentAction = null;
        this._removeStorage('pending');
        this.metrics.actionsRejected += 1;
        if (current.automatic === true) this.autonomyEnabled = false;
        this.lastAction = {
          at: nowIso(),
          type: current.kind + '_REJECTED',
          reason: cleanText(reason, 300),
          autonomyStopped: current.automatic === true
        };
        return { state: 'REJECTED', reason: cleanText(reason, 300), autonomyStopped: current.automatic === true };
      }

      if (current.settlement === 'REJECTED') {
        const error = cleanText(current.error || '', 300);
        if (current.kind === 'START' && current.requireCharacterStateChange === true && transientStartRejection(error)) {
          const targetName = cleanText(current.targetName || '', 120);
          const retryAtMs = Date.now() + this.config.startRetryBackoffMs;
          this.currentAction = null;
          this._removeStorage('pending');
          this.metrics.actionsRejected += 1;
          this.metrics.transientStartRejects += 1;
          if (targetName) this.transientStartRetries.set(targetName, { retryAtMs, error });
          this.lastAction = {
            at: nowIso(),
            type: 'START_TRANSIENT_REJECTED',
            reason: 'H19_START_AUTHORIZATION_IN_PROGRESS',
            serverReason: error,
            targetName: targetName || null,
            retryAtMs,
            autonomyStopped: false
          };
          return {
            state: 'WAITING',
            reason: 'H19_START_AUTHORIZATION_IN_PROGRESS',
            serverReason: error,
            targetName: targetName || null,
            retryAtMs,
            autonomyStopped: false
          };
        }
        if (['PARTY_INVITE', 'PARTY_REQUEST'].includes(current.kind) && transientPartyRejection(error)) {
          const targetName = cleanText(current.targetName || '', 120);
          const retryAtMs = Date.now() + this.config.partyRetryBackoffMs;
          this.currentAction = null;
          this._removeStorage('pending');
          this.metrics.actionsRejected += 1;
          this.metrics.partyTransientRejects += 1;
          if (targetName) this.partyRetryBackoffs.set(targetName, { retryAtMs, error });
          if (current.automatic === true) this.autonomyEnabled = true;
          this.lastAction = {
            at: nowIso(),
            type: current.kind + '_TRANSIENT_REJECTED',
            reason: 'H33_PARTY_TARGET_TRANSIENTLY_UNAVAILABLE',
            serverReason: error,
            targetName: targetName || null,
            retryAtMs,
            autonomyStopped: false
          };
          return {
            state: 'WAITING',
            reason: 'H33_PARTY_TARGET_TRANSIENTLY_UNAVAILABLE',
            serverReason: error,
            targetName: targetName || null,
            retryAtMs,
            autonomyStopped: false
          };
        }
                if (current.kind === 'RESPAWN' && error === 'cant_respawn') {
          this.currentAction = null;
          this._removeStorage('pending');
          this.metrics.actionsRejected += 1;
          this.metrics.respawnCooldownRejects += 1;
          this.autonomyEnabled = false;
          this.deathObservedAtMs = Date.now();
          const readyAtMs = this.deathObservedAtMs + this.config.respawnGraceMs;
          this.lastAction = {
            at: nowIso(),
            type: 'RESPAWN_REJECTED',
            reason: 'H19_RESPAWN_COOLDOWN',
            serverReason: error,
            readyAtMs,
            autonomyStopped: true
          };
          return {
            state: 'REJECTED',
            reason: 'H19_RESPAWN_COOLDOWN',
            serverReason: error,
            readyAtMs,
            autonomyStopped: true
          };
        }
        return this._suspend('H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME', { error: current.error || null });
      }

      if (Date.now() >= Number(current.deadlineAtMs || 0)) {
        return this._suspend('H19_' + current.kind + '_UNVERIFIED_TIMEOUT');
      }

      return { state: 'PENDING', currentAction: clone(current) };
    }

    tick() {
      this.metrics.ticks += 1;

      const observed = this._observeCurrent();
      if (observed.state !== 'IDLE') return observed;

      if (this.autonomyEnabled && this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.autonomyEnabled = false;
        this.metrics.sessionBudgetBlocks += 1;
        return { state: 'COMPLETE', reason: 'H19_SESSION_BUDGET_REACHED', actionsThisSession: this.actionsThisSession };
      }

      const plan = this.plan();
      if (plan.state !== 'READY' || !plan.request) return plan;

      const fromQueue = this.queue.length && String(this.queue[0].id) === String(plan.request.id);
      const result = this._dispatch(plan.request);
      if (fromQueue) {
        const ownsDispatchedRequest = !!(this.currentAction && String(this.currentAction.requestId) === String(plan.request.id));
        if (result.accepted || ownsDispatchedRequest) this.queue.shift();
      }
      return result;
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: this.suspended,
        suspendedReason: this.suspendedReason,
        currentAction: clone(this.currentAction),
        queue: clone(this.queue),
        queueLength: this.queue.length,
        actionsThisSession: this.actionsThisSession,
        policy: {
          desiredActiveNames: clone(this.policyState.desiredActiveNames),
          desiredRuntimeRunningNames: clone(this.policyState.desiredRuntimeRunningNames),
          desiredPartyMemberNames: clone(this.policyState.desiredPartyMemberNames),
          desiredPartyLeader: this.policyState.desiredPartyLeader,
          maxActionsPerSession: this.config.maxActionsPerSession
        },
        partySignals: clone(this.partySignals),
        config: clone(this.config),
        respawn: clone(this._respawnReadiness()),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        browserSwapRecoveryAttempts: [...this.browserSwapRecoveryAttempts.entries()]
          .map(([key, attempts]) => ({ key, attempts }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        pendingBrowserSwapRecoveryKey: this.pendingBrowserSwapRecoveryKey,
        metrics: clone(this.metrics)
      };
    }
  }

  ns.CharacterLifecycleController = CharacterLifecycleController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
