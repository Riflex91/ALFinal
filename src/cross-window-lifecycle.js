(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;
  const PROTOCOL = 'albot-h19-cross-window-v1';

  function nowIso(ms) {
    return new Date(ms == null ? Date.now() : ms).toISOString();
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function errorReason(value, fallback = 'H19_CROSS_WINDOW_UNKNOWN') {
    const raw = value && typeof value === 'object'
      ? value.reason || value.code || value.message
      : value;
    return cleanText(raw || fallback, 300) || fallback;
  }

  class H19CrossWindowLifecycleTransport {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.roster = options.roster || null;
      this.getLocalState = typeof options.getLocalState === 'function'
        ? options.getLocalState
        : () => ({ running: false, runEpoch: 0, emergencyStopLatched: false });
      this.startRuntime = typeof options.startRuntime === 'function'
        ? options.startRuntime
        : async () => { throw new Error('H19_CROSS_WINDOW_START_RUNTIME_UNAVAILABLE'); };
      this.stopRuntime = typeof options.stopRuntime === 'function'
        ? options.stopRuntime
        : async () => { throw new Error('H19_CROSS_WINDOW_STOP_RUNTIME_UNAVAILABLE'); };
      this.getPartyState = typeof options.getPartyState === 'function' ? options.getPartyState : () => null;
      this.leavePartyLocal = typeof options.leavePartyLocal === 'function'
        ? options.leavePartyLocal
        : async () => { throw new Error('H19_CROSS_WINDOW_PARTY_LEAVE_UNAVAILABLE'); };
      this.requestPartyJoinLocal = typeof options.requestPartyJoinLocal === 'function'
        ? options.requestPartyJoinLocal
        : async () => { throw new Error('H19_CROSS_WINDOW_PARTY_REQUEST_UNAVAILABLE'); };
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        heartbeatIntervalMs: Math.max(500, Math.min(10000, Number(options.heartbeatIntervalMs) || 1500)),
        staleMs: Math.max(1500, Math.min(30000, Number(options.staleMs) || 5000)),
        settlementTimeoutMs: Math.max(3000, Math.min(120000, Number(options.settlementTimeoutMs) || 15000)),
        maxPeers: Math.max(4, Math.min(64, Number(options.maxPeers) || 16)),
        maxInboundCommands: Math.max(8, Math.min(256, Number(options.maxInboundCommands) || 64))
      };

      this.setIntervalFn = options.setIntervalFn
        || (this.root && typeof this.root.setInterval === 'function' ? this.root.setInterval.bind(this.root) : null);
      this.clearIntervalFn = options.clearIntervalFn
        || (this.root && typeof this.root.clearInterval === 'function' ? this.root.clearInterval.bind(this.root) : null);
      this.setTimeoutFn = options.setTimeoutFn
        || (this.root && typeof this.root.setTimeout === 'function' ? this.root.setTimeout.bind(this.root) : null);
      this.clearTimeoutFn = options.clearTimeoutFn
        || (this.root && typeof this.root.clearTimeout === 'function' ? this.root.clearTimeout.bind(this.root) : null);

      this.installed = false;
      this.previousOnCm = null;
      this.onCmHandler = null;
      this.heartbeatTimer = null;
      this.sequence = 0;
      this.peers = new Map();
      this.pending = new Map();
      this.inboundCommands = new Map();
      this.partyRecoveryLease = null;
      this.sessionId = cleanText(options.sessionId || this._makeSessionId(), 240);
      this.lastHeartbeatAt = null;
      this.lastError = null;
      this.metrics = {
        heartbeatsSent: 0,
        heartbeatsReceived: 0,
        commandsSent: 0,
        commandsReceived: 0,
        acksSent: 0,
        acksReceived: 0,
        settlementsSent: 0,
        settlementsReceived: 0,
        settlementsSucceeded: 0,
        settlementsFailed: 0,
        transportFailures: 0,
        rejectedUntrusted: 0,
        rejectedWrongTarget: 0,
        rejectedWrongServer: 0,
        rejectedExpired: 0,
        rejectedSessionMismatch: 0,
        duplicates: 0
      };
    }

    _makeSessionId() {
      const local = this._localName() || 'unknown';
      return 'h19:' + local + ':' + String(this.now()) + ':' + String(++this.sequence);
    }

    _log(level, message, data) {
      try {
        if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message, data || {});
      } catch (_) {}
    }

    _roots() {
      const out = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!out.includes(current)) out.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return out;
    }

    _readValue(names) {
      for (const candidate of this._roots()) {
        for (const name of names) {
          try {
            const value = candidate && candidate[name];
            if (value != null && String(value).trim()) return String(value).trim();
          } catch (_) {}
        }
      }
      return null;
    }

    _serverIdentity() {
      return {
        region: cleanText(this._readValue(['server_region', 'serverRegion']) || '', 80) || null,
        identifier: cleanText(this._readValue(['server_identifier', 'serverIdentifier']) || '', 80) || null
      };
    }

    _localName() {
      try {
        const state = this.getLocalState();
        const fromState = cleanText(state && (state.localName || state.characterName) || '', 120);
        if (fromState) return fromState;
      } catch (_) {}
      for (const candidate of this._roots()) {
        try {
          const name = cleanText(candidate && candidate.character && candidate.character.name || '', 120);
          if (name) return name;
        } catch (_) {}
      }
      return null;
    }

    _rosterSnapshot() {
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

    _ownedNames() {
      const roster = this._rosterSnapshot();
      if (!roster || roster.accountStateAvailable !== true || !Array.isArray(roster.accountCharacters)) {
        const local = this._localName();
        return new Set(local ? [local] : []);
      }
      return new Set(roster.accountCharacters
        .map(row => cleanText(row && row.name || '', 120))
        .filter(Boolean));
    }

    _onlineOwnedNames() {
      const roster = this._rosterSnapshot();
      const owned = this._ownedNames();
      if (!roster || roster.onlineStateAvailable !== true) return new Set();
      const rows = Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames : [];
      return new Set(rows.map(String).filter(name => owned.has(name)));
    }

    _resolveSendCm() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate.send_cm === 'function') {
            return { owner: candidate, fn: candidate.send_cm };
          }
        } catch (_) {}
      }
      return null;
    }

    _baseEnvelope(type, target, extra = {}) {
      const server = this._serverIdentity();
      const at = this.now();
      return {
        schemaVersion: 1,
        protocol: PROTOCOL,
        type,
        messageId: 'h19-cm-' + (++this.sequence) + '-' + String(at),
        senderCharacterName: this._localName(),
        senderSessionId: this.sessionId,
        receiverCharacterName: cleanText(target || '', 120),
        serverRegion: server.region,
        serverIdentifier: server.identifier,
        createdAtMs: at,
        validUntilMs: at + this.config.settlementTimeoutMs,
        ...clone(extra)
      };
    }

    _sendRaw(target, envelope) {
      const name = cleanText(target || '', 120);
      const local = this._localName();
      const owned = this._ownedNames();
      if (!name || name === local || !owned.has(name)) throw new Error('H19_CROSS_WINDOW_TARGET_NOT_OWNED');
      const resolved = this._resolveSendCm();
      if (!resolved) throw new Error('H19_CROSS_WINDOW_SEND_CM_UNAVAILABLE');
      return resolved.fn.call(resolved.owner, name, envelope);
    }

    _sendEnvelope(target, envelope, metric) {
      try {
        const value = this._sendRaw(target, envelope);
        if (metric) this.metrics[metric] += 1;
        return value;
      } catch (error) {
        this.metrics.transportFailures += 1;
        this.lastError = { at: nowIso(this.now()), reason: errorReason(error) };
        this._log('warn', 'H19 Cross-Window CM Versand fehlgeschlagen', {
          target: cleanText(target || '', 120),
          type: envelope && envelope.type || null,
          reason: this.lastError.reason
        });
        throw error;
      }
    }

    _serverMatches(envelope) {
      const local = this._serverIdentity();
      if (local.region && (!envelope.serverRegion || String(envelope.serverRegion) !== local.region)) return false;
      if (local.identifier && (!envelope.serverIdentifier || String(envelope.serverIdentifier) !== local.identifier)) return false;
      return true;
    }

    _isTrustedSender(sender, envelope) {
      const actual = cleanText(sender || '', 120);
      const claimed = cleanText(envelope && envelope.senderCharacterName || '', 120);
      return !!actual && actual === claimed && this._ownedNames().has(actual);
    }

    _validEnvelope(sender, data) {
      const envelope = asObject(data);
      if (!envelope || envelope.protocol !== PROTOCOL || envelope.schemaVersion !== 1) return { ok: false, ignored: true };
      const local = this._localName();
      if (!local || cleanText(envelope.receiverCharacterName || '', 120) !== local) {
        this.metrics.rejectedWrongTarget += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_WRONG_TARGET' };
      }
      if (!this._isTrustedSender(sender, envelope)) {
        this.metrics.rejectedUntrusted += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_UNTRUSTED_SENDER' };
      }
      const now = this.now();
      const created = Number(envelope.createdAtMs);
      const validUntil = Number(envelope.validUntilMs);
      if (!Number.isFinite(created) || !Number.isFinite(validUntil) || now < created - 5000 || now > validUntil) {
        this.metrics.rejectedExpired += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_MESSAGE_EXPIRED' };
      }
      if (!this._serverMatches(envelope)) {
        this.metrics.rejectedWrongServer += 1;
        return { ok: false, reason: 'H19_CROSS_WINDOW_SERVER_MISMATCH' };
      }
      return { ok: true, envelope };
    }

    _boundedPut(map, key, value, limit) {
      map.set(key, value);
      while (map.size > limit) {
        const first = map.keys().next();
        if (first.done) break;
        map.delete(first.value);
      }
    }

    _updatePeer(name, state, observedAtMs) {
      const target = cleanText(name || '', 120);
      const row = asObject(state);
      if (!target || !row) return null;
      const sessionId = cleanText(row.sessionId || row.senderSessionId || '', 240);
      if (!sessionId) return null;
      const peer = {
        name: target,
        sessionId,
        running: row.running === true,
        runEpoch: Number.isFinite(Number(row.runEpoch)) ? Number(row.runEpoch) : 0,
        emergencyStopLatched: row.emergencyStopLatched === true,
        lifecycleAutonomyEnabled: typeof row.lifecycleAutonomyEnabled === 'boolean' ? row.lifecycleAutonomyEnabled : null,
        version: cleanText(row.version || '', 80) || null,
        observedAtMs: Number(observedAtMs) || this.now(),
        aliveUntilMs: (Number(observedAtMs) || this.now()) + this.config.staleMs
      };
      this._boundedPut(this.peers, target, peer, this.config.maxPeers);
      return peer;
    }

    _localStatePayload() {
      let state = {};
      try { state = this.getLocalState() || {}; } catch (_) {}
      return {
        sessionId: this.sessionId,
        running: state.running === true,
        runEpoch: Number.isFinite(Number(state.runEpoch)) ? Number(state.runEpoch) : 0,
        emergencyStopLatched: state.emergencyStopLatched === true,
        lifecycleAutonomyEnabled: typeof state.lifecycleAutonomyEnabled === 'boolean' ? state.lifecycleAutonomyEnabled : null,
        version: cleanText(state.version || '', 80) || null
      };
    }

    freshPeer(name) {
      const target = cleanText(name || '', 120);
      if (!target) return null;
      const peer = this.peers.get(target);
      if (!peer) return null;
      const now = this.now();
      if (now > Number(peer.aliveUntilMs || 0)) return null;
      if (!this._ownedNames().has(target)) return null;
      const roster = this._rosterSnapshot();
      if (roster && roster.onlineStateAvailable === true) {
        const online = new Set((roster.onlineCharacterNames || []).map(String));
        if (!online.has(target)) return null;
      }
      return clone(peer);
    }

    freshPeers() {
      const out = [];
      for (const name of this.peers.keys()) {
        const peer = this.freshPeer(name);
        if (peer) out.push(peer);
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    broadcastHeartbeat() {
      if (!this.installed) return { sent: 0, reason: 'H19_CROSS_WINDOW_NOT_INSTALLED' };
      const local = this._localName();
      if (!local) return { sent: 0, reason: 'H19_CROSS_WINDOW_LOCAL_NAME_UNAVAILABLE' };
      const targets = [...this._onlineOwnedNames()].filter(name => name !== local).sort();
      this.lastHeartbeatAt = nowIso(this.now());
      let sent = 0;
      for (const target of targets) {
        const envelope = this._baseEnvelope('HEARTBEAT', target, {
          validUntilMs: this.now() + this.config.staleMs,
          state: this._localStatePayload()
        });
        try {
          const value = this._sendEnvelope(target, envelope, 'heartbeatsSent');
          if (value && typeof value.then === 'function') {
            Promise.resolve(value).catch(() => {});
          }
          sent += 1;
        } catch (_) {}
      }
      return { sent, targets };
    }

    _sendAck(target, command) {
      const envelope = this._baseEnvelope('ACK', target, {
        replyTo: command.messageId,
        commandType: command.commandType,
        targetSessionId: this.sessionId,
        state: this._localStatePayload()
      });
      try {
        const value = this._sendEnvelope(target, envelope, 'acksSent');
        if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
        return true;
      } catch (_) {
        return false;
      }
    }

    _sendSettlement(target, command, success, reason, details = null) {
      const envelope = this._baseEnvelope('SETTLEMENT', target, {
        replyTo: command.messageId,
        commandType: command.commandType,
        targetSessionId: this.sessionId,
        success: success === true,
        reason: cleanText(reason || (success ? 'H19_CROSS_WINDOW_SETTLED' : 'H19_CROSS_WINDOW_SETTLEMENT_FAILED'), 300),
        state: this._localStatePayload(),
        details: details == null ? null : clone(details)
      });
      try {
        const value = this._sendEnvelope(target, envelope, 'settlementsSent');
        if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
        return true;
      } catch (_) {
        return false;
      }
    }

    _handleHeartbeat(envelope) {
      this.metrics.heartbeatsReceived += 1;
      const state = asObject(envelope.state);
      if (!state) return false;
      this._updatePeer(envelope.senderCharacterName, {
        ...state,
        sessionId: envelope.senderSessionId || state.sessionId
      }, this.now());
      return true;
    }

    _handleAck(envelope) {
      const replyTo = cleanText(envelope.replyTo || '', 240);
      const pending = replyTo && this.pending.get(replyTo);
      if (!pending || pending.target !== envelope.senderCharacterName) return false;
      this.metrics.acksReceived += 1;
      pending.acknowledgedAtMs = this.now();
      pending.ackState = clone(envelope.state || null);
      return true;
    }

    _finishPending(messageId, outcome) {
      const pending = this.pending.get(messageId);
      if (!pending) return false;
      this.pending.delete(messageId);
      try {
        if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
      } catch (_) {}
      pending.resolve(outcome);
      return true;
    }

    _handleSettlement(envelope) {
      const replyTo = cleanText(envelope.replyTo || '', 240);
      const pending = replyTo && this.pending.get(replyTo);
      if (!pending || pending.target !== envelope.senderCharacterName) return false;

      const observedSessionId = cleanText(envelope.targetSessionId || envelope.senderSessionId || '', 240);
      const expectedSessionId = cleanText(pending.targetSessionId || '', 240);
      const sessionMatches = !!observedSessionId && observedSessionId === expectedSessionId;
      const reason = cleanText(envelope.reason || '', 300) || null;
      const terminalSessionMismatch = !sessionMatches
        && envelope.success === false
        && reason === 'H19_CROSS_WINDOW_TARGET_SESSION_MISMATCH';

      if (!sessionMatches && !terminalSessionMismatch) {
        this.metrics.rejectedSessionMismatch += 1;
        return false;
      }

      const state = asObject(envelope.state) || {};
      if (observedSessionId) {
        this._updatePeer(envelope.senderCharacterName, {
          ...state,
          sessionId: observedSessionId
        }, this.now());
      }

      this.metrics.settlementsReceived += 1;
      if (envelope.success === true) this.metrics.settlementsSucceeded += 1;
      else this.metrics.settlementsFailed += 1;
      if (terminalSessionMismatch) this.metrics.rejectedSessionMismatch += 1;

      return this._finishPending(replyTo, {
        success: envelope.success === true,
        reason,
        commandType: envelope.commandType || null,
        messageId: replyTo,
        target: envelope.senderCharacterName,
        targetSessionId: expectedSessionId,
        observedTargetSessionId: observedSessionId || null,
        state: clone(state),
        details: clone(envelope.details || null)
      });
    }

    _partySnapshot() {
      try {
        const snapshot = this.getPartyState();
        return snapshot && typeof snapshot === 'object' ? clone(snapshot) : null;
      } catch (_) {
        return null;
      }
    }

    _partyMemberNames(snapshot) {
      return snapshot && Array.isArray(snapshot.memberNames) ? snapshot.memberNames.map(name => String(name)) : [];
    }

    _partyHasOnlyOwned(snapshot) {
      const owned = this._ownedNames();
      return this._partyMemberNames(snapshot).every(name => owned.has(name));
    }

    _delay(ms) {
      const waitMs = Math.max(0, Number(ms) || 0);
      return new Promise(resolve => {
        if (this.setTimeoutFn) this.setTimeoutFn(resolve, waitMs);
        else resolve();
      });
    }

    async _waitForPartyState(predicate, timeoutReason) {
      const pollMs = 100;
      const timeoutMs = Math.max(1000, Math.floor(this.config.settlementTimeoutMs * 0.8));
      const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const snapshot = this._partySnapshot();
        if (snapshot && predicate(snapshot)) return snapshot;
        if (attempt + 1 < attempts) await this._delay(pollMs);
      }
      throw new Error(timeoutReason);
    }

    async _executePartyLeave(sender) {
      const localState = this._localStatePayload();
      const localName = this._localName();
      if (localState.running !== true) throw new Error('H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING');
      if (localState.emergencyStopLatched === true) throw new Error('H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED');
      if (localState.lifecycleAutonomyEnabled == null) throw new Error('H19_CROSS_WINDOW_PARTY_AUTONOMY_STATE_UNAVAILABLE');
      if (localState.lifecycleAutonomyEnabled === true) throw new Error('H19_CROSS_WINDOW_PARTY_AUTONOMY_ACTIVE');

      const existingLease = this.partyRecoveryLease;
      if (existingLease && this.now() <= Number(existingLease.validUntilMs || 0)) {
        throw new Error('H19_CROSS_WINDOW_PARTY_RECOVERY_ALREADY_IN_PROGRESS');
      }
      this.partyRecoveryLease = null;

      const before = this._partySnapshot();
      const members = this._partyMemberNames(before);
      if (!before || !before.partyId || !members.includes(String(localName || ''))) {
        throw new Error('H19_CROSS_WINDOW_PARTY_TARGET_NOT_IN_PARTY');
      }
      if (!this._partyHasOnlyOwned(before)) throw new Error('H19_CROSS_WINDOW_FOREIGN_PARTY_MEMBER_PRESENT');
      if (String(before.leader || '') === String(localName || '')) {
        throw new Error('H19_CROSS_WINDOW_PARTY_LEADER_PROTECTED');
      }
      if (String(before.leader || '') !== String(sender || '')) {
        throw new Error('H19_CROSS_WINDOW_PARTY_SENDER_NOT_LEADER');
      }

      // Establish recovery authority before the irreversible dispatch. If the
      // ActionBoundary reports UNKNOWN after dispatch, this authority remains
      // available for evidence-driven/manual cleanup; it is never auto-retried.
      this.partyRecoveryLease = {
        leader: String(sender || ''),
        targetName: String(localName || ''),
        issuedAtMs: this.now(),
        validUntilMs: this.now() + this.config.settlementTimeoutMs * 2
      };

      try {
        this.leavePartyLocal();
      } catch (error) {
        const reason = errorReason(error, 'H19_CROSS_WINDOW_PARTY_LEAVE_DISPATCH_FAILED');
        if (!reason.includes('H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN')) {
          this.partyRecoveryLease = null;
        }
        throw error;
      }

      const after = await this._waitForPartyState(snapshot => {
        const names = this._partyMemberNames(snapshot);
        return !snapshot.partyId && !names.includes(String(localName || ''));
      }, 'H19_CROSS_WINDOW_PARTY_LEAVE_UNVERIFIED_TIMEOUT');

      return {
        reason: 'H19_CROSS_WINDOW_PARTY_LEFT',
        details: {
          localName,
          previousLeader: before.leader || null,
          memberNames: this._partyMemberNames(after),
          recoveryAuthorityValidUntilMs: this.partyRecoveryLease.validUntilMs
        }
      };
    }

    async _executePartyJoinRequest(sender) {
      const localState = this._localStatePayload();
      const localName = this._localName();
      if (localState.running !== true) throw new Error('H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING');
      if (localState.emergencyStopLatched === true) throw new Error('H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED');
      const lease = this.partyRecoveryLease;
      const authorityValid = !!lease
        && String(lease.leader || '') === String(sender || '')
        && String(lease.targetName || '') === String(localName || '')
        && this.now() <= Number(lease.validUntilMs || 0);
      if (!authorityValid) {
        this.partyRecoveryLease = null;
        throw new Error('H19_CROSS_WINDOW_PARTY_RECOVERY_AUTHORITY_UNAVAILABLE');
      }
      this.partyRecoveryLease = null;
      const before = this._partySnapshot();
      const beforeMembers = this._partyMemberNames(before);
      if (!before) throw new Error('H19_CROSS_WINDOW_PARTY_STATE_UNAVAILABLE');
      if (before.partyId || beforeMembers.includes(String(localName || ''))) throw new Error('H19_CROSS_WINDOW_PARTY_TARGET_ALREADY_IN_PARTY');
      try {
        this.requestPartyJoinLocal(sender);
      } catch (error) {
        const reason = errorReason(error, 'H19_CROSS_WINDOW_PARTY_REQUEST_DISPATCH_FAILED');
        if (!reason.includes('H19_CROSS_WINDOW_PARTY_ACTION_UNKNOWN')) {
          this.partyRecoveryLease = lease;
        }
        throw error;
      }
      const after = await this._waitForPartyState(snapshot => {
        const names = this._partyMemberNames(snapshot);
        return !!snapshot.partyId
          && String(snapshot.leader || '') === String(sender || '')
          && names.includes(String(localName || ''))
          && names.includes(String(sender || ''))
          && this._partyHasOnlyOwned(snapshot);
      }, 'H19_CROSS_WINDOW_PARTY_JOIN_UNVERIFIED_TIMEOUT');
      return {
        reason: 'H19_CROSS_WINDOW_PARTY_JOINED',
        details: { localName, leader: after.leader || null, partyId: after.partyId || null, memberNames: this._partyMemberNames(after) }
      };
    }

    _handleCommand(envelope) {
      this.metrics.commandsReceived += 1;
      const commandId = cleanText(envelope.messageId || '', 240);
      const sender = cleanText(envelope.senderCharacterName || '', 120);
      const commandType = cleanText(envelope.commandType || '', 80);
      const supported = new Set(['START_RUNTIME', 'STOP_RUNTIME', 'LEAVE_PARTY', 'REQUEST_PARTY_JOIN']);
      if (!commandId || !sender || !supported.has(commandType)) return false;
      if (cleanText(envelope.targetSessionId || '', 240) !== this.sessionId) {
        this.metrics.rejectedSessionMismatch += 1;
        this._sendSettlement(sender, envelope, false, 'H19_CROSS_WINDOW_TARGET_SESSION_MISMATCH');
        return false;
      }
      const existing = this.inboundCommands.get(commandId);
      if (existing) {
        this.metrics.duplicates += 1;
        this._sendAck(sender, envelope);
        if (existing.settlement) this._sendSettlement(sender, envelope, existing.settlement.success, existing.settlement.reason, existing.settlement.details || null);
        return true;
      }
      const record = { state: 'PROCESSING', settlement: null, receivedAtMs: this.now() };
      this._boundedPut(this.inboundCommands, commandId, record, this.config.maxInboundCommands);
      this._sendAck(sender, envelope);
      Promise.resolve().then(async () => {
        let outcome = null;
        if (commandType === 'START_RUNTIME' || commandType === 'STOP_RUNTIME') {
          const desiredRunning = commandType === 'START_RUNTIME';
          const before = this._localStatePayload();
          if (before.running !== desiredRunning) {
            if (desiredRunning) await this.startRuntime('H19_REMOTE_CM_START:' + sender);
            else await this.stopRuntime('H19_REMOTE_CM_STOP:' + sender);
          }
          const after = this._localStatePayload();
          if (after.running !== desiredRunning) throw new Error('H19_CROSS_WINDOW_LOCAL_RUNTIME_STATE_MISMATCH');
          outcome = {
            reason: desiredRunning ? 'H19_CROSS_WINDOW_RUNTIME_STARTED' : 'H19_CROSS_WINDOW_RUNTIME_STOPPED',
            details: { running: after.running, runEpoch: after.runEpoch }
          };
        } else if (commandType === 'LEAVE_PARTY') {
          outcome = await this._executePartyLeave(sender);
        } else if (commandType === 'REQUEST_PARTY_JOIN') {
          outcome = await this._executePartyJoinRequest(sender);
        }
        record.state = 'SETTLED';
        record.settlement = { success: true, reason: outcome && outcome.reason || 'H19_CROSS_WINDOW_SETTLED', details: outcome && outcome.details || null };
        this._sendSettlement(sender, envelope, true, record.settlement.reason, record.settlement.details);
        try { this.broadcastHeartbeat(); } catch (_) {}
      }).catch(error => {
        record.state = 'SETTLED';
        record.settlement = { success: false, reason: errorReason(error, 'H19_CROSS_WINDOW_LOCAL_EXECUTION_FAILED'), details: null };
        this._sendSettlement(sender, envelope, false, record.settlement.reason);
      });
      return true;
    }

    _receive(sender, data) {
      const checked = this._validEnvelope(sender, data);
      if (!checked.ok) return checked.ignored ? null : false;
      const envelope = checked.envelope;
      if (envelope.type === 'HEARTBEAT') return this._handleHeartbeat(envelope);
      if (envelope.type === 'ACK') return this._handleAck(envelope);
      if (envelope.type === 'SETTLEMENT') return this._handleSettlement(envelope);
      if (envelope.type === 'COMMAND') return this._handleCommand(envelope);
      return false;
    }

    _requestCommand(targetName, commandType, options = {}) {
      const target = cleanText(targetName || '', 120);
      const local = this._localName();
      if (!target || target === local) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_REMOTE_TARGET_REQUIRED' } };
      if (!this._ownedNames().has(target)) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_TARGET_NOT_OWNED' } };
      const peer = options.peer || this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      const envelope = this._baseEnvelope('COMMAND', target, {
        commandType: cleanText(commandType || '', 80),
        targetSessionId: peer.sessionId,
        validUntilMs: this.now() + this.config.settlementTimeoutMs
      });
      const messageId = envelope.messageId;
      let resolvePromise;
      let rejectPromise;
      const value = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
      const pending = {
        messageId, target, targetSessionId: peer.sessionId, commandType: envelope.commandType,
        desiredRunning: Object.prototype.hasOwnProperty.call(options, 'desiredRunning') ? options.desiredRunning === true : null,
        sentAtMs: this.now(), acknowledgedAtMs: null, ackState: null, timer: null, resolve: resolvePromise, reject: rejectPromise
      };
      this.pending.set(messageId, pending);
      if (this.setTimeoutFn) {
        pending.timer = this.setTimeoutFn(() => {
          if (!this.pending.has(messageId)) return;
          this.pending.delete(messageId);
          this.metrics.transportFailures += 1;
          rejectPromise(new Error('H19_CROSS_WINDOW_SETTLEMENT_TIMEOUT'));
        }, this.config.settlementTimeoutMs);
      }
      let transportValue;
      try {
        transportValue = this._sendEnvelope(target, envelope, 'commandsSent');
      } catch (error) {
        this.pending.delete(messageId);
        if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
        return { id: messageId, state: 'UNKNOWN', dispatched: true, value: null, error: { message: errorReason(error) } };
      }
      if (transportValue && typeof transportValue.then === 'function') {
        Promise.resolve(transportValue).catch(error => {
          const stillPending = this.pending.get(messageId);
          if (!stillPending) return;
          this.pending.delete(messageId);
          if (stillPending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(stillPending.timer);
          stillPending.reject(new Error(errorReason(error, 'H19_CROSS_WINDOW_SEND_CM_REJECTED')));
        });
      }
      return { id: messageId, state: 'DISPATCHED', dispatched: true, value, transport: 'send_cm', targetSessionId: peer.sessionId };
    }

    requestRuntimeState(targetName, desiredRunning) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      const desired = desiredRunning === true;
      if (peer.running === desired) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: desired ? 'H19_CROSS_WINDOW_RUNTIME_ALREADY_RUNNING' : 'H19_CROSS_WINDOW_RUNTIME_ALREADY_STOPPED' } };
      }
      return this._requestCommand(target, desired ? 'START_RUNTIME' : 'STOP_RUNTIME', { peer, desiredRunning: desired });
    }

    requestPartyLeave(targetName) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING' } };
      if (peer.emergencyStopLatched === true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED' } };
      return this._requestCommand(target, 'LEAVE_PARTY', { peer });
    }

    requestPartyJoin(targetName) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_RUNTIME_NOT_RUNNING' } };
      if (peer.emergencyStopLatched === true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PARTY_EMERGENCY_STOP_LATCHED' } };
      return this._requestCommand(target, 'REQUEST_PARTY_JOIN', { peer });
    }

    install() {
      if (this.installed) return this.status();
      if (!this.root) throw new Error('H19_CROSS_WINDOW_ROOT_UNAVAILABLE');
      this.previousOnCm = typeof this.root.on_cm === 'function' ? this.root.on_cm : null;
      const self = this;
      this.onCmHandler = function h19CrossWindowOnCm(sender, data) {
        const handled = self._receive(sender, data);
        if (handled !== null) return handled;
        if (self.previousOnCm) return self.previousOnCm.apply(this, arguments);
        return undefined;
      };
      this.root.on_cm = this.onCmHandler;
      this.installed = true;
      try { this.broadcastHeartbeat(); } catch (_) {}
      if (this.setIntervalFn) {
        this.heartbeatTimer = this.setIntervalFn(() => {
          try { this.broadcastHeartbeat(); } catch (_) {}
        }, this.config.heartbeatIntervalMs);
        try {
          if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref();
          }
        } catch (_) {}
      }
      return this.status();
    }

    destroy(reason = 'H19_CROSS_WINDOW_DESTROY') {
      if (!this.installed) return this.status();
      this.installed = false;
      try {
        if (this.heartbeatTimer != null && this.clearIntervalFn) this.clearIntervalFn(this.heartbeatTimer);
      } catch (_) {}
      this.heartbeatTimer = null;
      try {
        if (this.root && this.root.on_cm === this.onCmHandler) {
          this.root.on_cm = this.previousOnCm || undefined;
        }
      } catch (_) {}
      this.onCmHandler = null;
      this.previousOnCm = null;

      for (const pending of this.pending.values()) {
        try {
          if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
          pending.reject(new Error(cleanText(reason, 200) || 'H19_CROSS_WINDOW_DESTROYED'));
        } catch (_) {}
      }
      this.pending.clear();
      this.partyRecoveryLease = null;
      return this.status();
    }

    status() {
      const now = this.now();
      const peers = [...this.peers.values()]
        .map(peer => ({
          ...clone(peer),
          fresh: now <= Number(peer.aliveUntilMs || 0),
          ageMs: Math.max(0, now - Number(peer.observedAtMs || now))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        schemaVersion: 1,
        protocol: PROTOCOL,
        installed: this.installed,
        sessionId: this.sessionId,
        localName: this._localName(),
        server: this._serverIdentity(),
        lastHeartbeatAt: this.lastHeartbeatAt,
        peers,
        freshPeers: this.freshPeers(),
        pending: [...this.pending.values()].map(row => ({
          messageId: row.messageId,
          target: row.target,
          targetSessionId: row.targetSessionId,
          commandType: row.commandType,
          desiredRunning: row.desiredRunning,
          sentAtMs: row.sentAtMs,
          acknowledgedAtMs: row.acknowledgedAtMs
        })),
        partyRecoveryLease: clone(this.partyRecoveryLease),
        config: clone(this.config),
        metrics: clone(this.metrics),
        lastError: clone(this.lastError)
      };
    }
  }

  ns.H19CrossWindowLifecycleTransport = H19CrossWindowLifecycleTransport;
})(typeof globalThis !== 'undefined' ? globalThis : this);
