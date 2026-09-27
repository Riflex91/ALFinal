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

    _sendSettlement(target, command, success, reason) {
      const envelope = this._baseEnvelope('SETTLEMENT', target, {
        replyTo: command.messageId,
        commandType: command.commandType,
        targetSessionId: this.sessionId,
        success: success === true,
        reason: cleanText(reason || (success ? 'H19_CROSS_WINDOW_SETTLED' : 'H19_CROSS_WINDOW_SETTLEMENT_FAILED'), 300),
        state: this._localStatePayload()
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
        state: clone(state)
      });
    }

    _handleCommand(envelope) {
      this.metrics.commandsReceived += 1;
      const commandId = cleanText(envelope.messageId || '', 240);
      const sender = cleanText(envelope.senderCharacterName || '', 120);
      const desiredRunning = envelope.commandType === 'START_RUNTIME'
        ? true
        : envelope.commandType === 'STOP_RUNTIME'
          ? false
          : null;
      if (!commandId || !sender || desiredRunning == null) return false;
      if (cleanText(envelope.targetSessionId || '', 240) !== this.sessionId) {
        this.metrics.rejectedSessionMismatch += 1;
        this._sendSettlement(sender, envelope, false, 'H19_CROSS_WINDOW_TARGET_SESSION_MISMATCH');
        return false;
      }

      const existing = this.inboundCommands.get(commandId);
      if (existing) {
        this.metrics.duplicates += 1;
        this._sendAck(sender, envelope);
        if (existing.settlement) {
          this._sendSettlement(sender, envelope, existing.settlement.success, existing.settlement.reason);
        }
        return true;
      }

      const record = { state: 'PROCESSING', settlement: null, receivedAtMs: this.now() };
      this._boundedPut(this.inboundCommands, commandId, record, this.config.maxInboundCommands);
      this._sendAck(sender, envelope);

      Promise.resolve().then(async () => {
        const before = this._localStatePayload();
        if (before.running !== desiredRunning) {
          if (desiredRunning) await this.startRuntime('H19_REMOTE_CM_START:' + sender);
          else await this.stopRuntime('H19_REMOTE_CM_STOP:' + sender);
        }
        const after = this._localStatePayload();
        if (after.running !== desiredRunning) {
          throw new Error('H19_CROSS_WINDOW_LOCAL_RUNTIME_STATE_MISMATCH');
        }
        record.state = 'SETTLED';
        record.settlement = {
          success: true,
          reason: desiredRunning ? 'H19_CROSS_WINDOW_RUNTIME_STARTED' : 'H19_CROSS_WINDOW_RUNTIME_STOPPED'
        };
        this._sendSettlement(sender, envelope, true, record.settlement.reason);
        try { this.broadcastHeartbeat(); } catch (_) {}
      }).catch(error => {
        record.state = 'SETTLED';
        record.settlement = { success: false, reason: errorReason(error, 'H19_CROSS_WINDOW_LOCAL_EXECUTION_FAILED') };
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

    requestRuntimeState(targetName, desiredRunning) {
      const target = cleanText(targetName || '', 120);
      const local = this._localName();
      if (!target || target === local) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_REMOTE_TARGET_REQUIRED' } };
      }
      if (!this._ownedNames().has(target)) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_TARGET_NOT_OWNED' } };
      }
      const peer = this.freshPeer(target);
      if (!peer) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H19_CROSS_WINDOW_PEER_NOT_FRESH' } };
      }
      const desired = desiredRunning === true;
      if (peer.running === desired) {
        return {
          id: null,
          state: 'UNAVAILABLE',
          dispatched: false,
          error: { message: desired ? 'H19_CROSS_WINDOW_RUNTIME_ALREADY_RUNNING' : 'H19_CROSS_WINDOW_RUNTIME_ALREADY_STOPPED' }
        };
      }

      const commandType = desired ? 'START_RUNTIME' : 'STOP_RUNTIME';
      const envelope = this._baseEnvelope('COMMAND', target, {
        commandType,
        targetSessionId: peer.sessionId,
        validUntilMs: this.now() + this.config.settlementTimeoutMs
      });
      const messageId = envelope.messageId;

      let resolvePromise;
      let rejectPromise;
      const value = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      const pending = {
        messageId,
        target,
        targetSessionId: peer.sessionId,
        commandType,
        desiredRunning: desired,
        sentAtMs: this.now(),
        acknowledgedAtMs: null,
        ackState: null,
        timer: null,
        resolve: resolvePromise,
        reject: rejectPromise
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
        return {
          id: messageId,
          state: 'UNKNOWN',
          dispatched: true,
          value: null,
          error: { message: errorReason(error) }
        };
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

      return {
        id: messageId,
        state: 'DISPATCHED',
        dispatched: true,
        value,
        transport: 'send_cm',
        targetSessionId: peer.sessionId
      };
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
        config: clone(this.config),
        metrics: clone(this.metrics),
        lastError: clone(this.lastError)
      };
    }
  }

  ns.H19CrossWindowLifecycleTransport = H19CrossWindowLifecycleTransport;
})(typeof globalThis !== 'undefined' ? globalThis : this);
