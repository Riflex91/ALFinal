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
      this.storage = options.storage || null;
      this.getLocalState = typeof options.getLocalState === 'function'
        ? options.getLocalState
        : () => ({ running: false, runEpoch: 0, emergencyStopLatched: false });
      this.startRuntime = typeof options.startRuntime === 'function'
        ? options.startRuntime
        : async () => { throw new Error('H19_CROSS_WINDOW_START_RUNTIME_UNAVAILABLE'); };
      this.stopRuntime = typeof options.stopRuntime === 'function'
        ? options.stopRuntime
        : async () => { throw new Error('H19_CROSS_WINDOW_STOP_RUNTIME_UNAVAILABLE'); };
      this.disconnectLocal = typeof options.disconnectLocal === 'function'
        ? options.disconnectLocal
        : () => { throw new Error('H24_CROSS_WINDOW_CHARACTER_DISCONNECT_UNAVAILABLE'); };
      this.navigateCharacterLocal = typeof options.navigateCharacterLocal === 'function'
        ? options.navigateCharacterLocal
        : () => { throw new Error('H25_CROSS_WINDOW_CHARACTER_NAVIGATION_UNAVAILABLE'); };
      this.getPartyState = typeof options.getPartyState === 'function' ? options.getPartyState : () => null;
      this.leavePartyLocal = typeof options.leavePartyLocal === 'function'
        ? options.leavePartyLocal
        : async () => { throw new Error('H19_CROSS_WINDOW_PARTY_LEAVE_UNAVAILABLE'); };
      this.requestPartyJoinLocal = typeof options.requestPartyJoinLocal === 'function'
        ? options.requestPartyJoinLocal
        : async () => { throw new Error('H19_CROSS_WINDOW_PARTY_REQUEST_UNAVAILABLE'); };
      this.prepareUpdateLocal = typeof options.prepareUpdateLocal === 'function'
        ? options.prepareUpdateLocal
        : async () => { throw new Error('H22_CROSS_WINDOW_UPDATE_PREPARE_UNAVAILABLE'); };
      this.commitUpdateLocal = typeof options.commitUpdateLocal === 'function'
        ? options.commitUpdateLocal
        : async () => { throw new Error('H22_CROSS_WINDOW_UPDATE_COMMIT_UNAVAILABLE'); };
      this.cancelUpdateLocal = typeof options.cancelUpdateLocal === 'function'
        ? options.cancelUpdateLocal
        : async () => ({ accepted: true, cancelled: false });
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
      this.characterCmEmitter = null;
      this.characterCmHandler = null;
      this.characterCmListenerId = null;
      this.receiveMode = null;
      this.heartbeatTimer = null;
      this.sequence = 0;
      this.peers = new Map();
      this.sharedSeenMessageIds = new Map();
      this.browserChannel = null;
      this.browserChannelName = null;
      this.browserChannelHandler = null;
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
        sharedStatePublishes: 0,
        sharedPeerLoads: 0,
        sharedMessagesPublished: 0,
        sharedMessagesReceived: 0,
        browserChannelPublishes: 0,
        browserChannelReceived: 0,
        browserChannelInstallFailures: 0,
        sendCmFailures: 0,
        sendCmSkippedForLocalTransport: 0,
        localTransportPreferred: 0,
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

    _sharedStorageAvailable() {
      if (!this.storage
          || typeof this.storage.sharedAvailable !== 'function'
          || typeof this.storage.getShared !== 'function'
          || typeof this.storage.setShared !== 'function') return false;
      try { return this.storage.sharedAvailable() === true; } catch (_) { return false; }
    }

    _sharedScope() {
      const server = this._serverIdentity();
      const region = encodeURIComponent(cleanText(server.region || 'unknown', 80));
      const identifier = encodeURIComponent(cleanText(server.identifier || 'unknown', 80));
      return region + ':' + identifier;
    }

    _sharedStateKey(name) {
      return 'albot:h28:cross-window-state:v1:' + this._sharedScope() + ':' + encodeURIComponent(cleanText(name || '', 120));
    }

    _sharedMailboxKey(name) {
      return 'albot:h28:cross-window-mailbox:v1:' + this._sharedScope() + ':' + encodeURIComponent(cleanText(name || '', 120));
    }

    _sharedRead(key, fallback) {
      if (!this._sharedStorageAvailable()) return fallback;
      try {
        const raw = this.storage.getShared(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch (_) {
        return fallback;
      }
    }

    _sharedWrite(key, value) {
      if (!this._sharedStorageAvailable()) return false;
      try {
        return this.storage.setShared(key, JSON.stringify(value)) !== false;
      } catch (_) {
        return false;
      }
    }

    _publishSharedState(state = null) {
      const local = this._localName();
      if (!local || !this._sharedStorageAvailable()) return false;
      const server = this._serverIdentity();
      const at = this.now();
      const payload = {
        schemaVersion: 1,
        protocol: PROTOCOL,
        transport: 'shared-storage',
        characterName: local,
        sessionId: this.sessionId,
        serverRegion: server.region,
        serverIdentifier: server.identifier,
        observedAtMs: at,
        validUntilMs: at + this.config.staleMs,
        state: clone(state || this._localStatePayload())
      };
      const written = this._sharedWrite(this._sharedStateKey(local), payload);
      if (written) this.metrics.sharedStatePublishes += 1;
      return written;
    }

    _loadSharedPeer(name) {
      const target = cleanText(name || '', 120);
      if (!target || target === this._localName() || !this._ownedNames().has(target)) return null;
      const row = this._sharedRead(this._sharedStateKey(target), null);
      if (!row || row.schemaVersion !== 1 || row.protocol !== PROTOCOL || row.transport !== 'shared-storage') return null;
      if (cleanText(row.characterName || '', 120) !== target) return null;
      const server = this._serverIdentity();
      if (server.region && cleanText(row.serverRegion || '', 80) !== server.region) return null;
      if (server.identifier && cleanText(row.serverIdentifier || '', 80) !== server.identifier) return null;
      const observedAtMs = Number(row.observedAtMs);
      const validUntilMs = Number(row.validUntilMs);
      const now = this.now();
      if (!Number.isFinite(observedAtMs) || !Number.isFinite(validUntilMs)
          || now < observedAtMs - 5000 || now > validUntilMs) return null;
      const state = asObject(row.state);
      if (!state) return null;
      const peer = this._updatePeer(target, {
        ...state,
        sessionId: row.sessionId || state.sessionId
      }, observedAtMs);
      if (peer) this.metrics.sharedPeerLoads += 1;
      return peer;
    }

    _publishSharedEnvelope(target, envelope) {
      const name = cleanText(target || '', 120);
      if (!name || !envelope || !this._sharedStorageAvailable()) return false;
      const now = this.now();
      const key = this._sharedMailboxKey(name);
      const existing = this._sharedRead(key, []);
      const rows = (Array.isArray(existing) ? existing : [])
        .filter(row => row && Number(row.validUntilMs) >= now - 1000)
        .filter(row => cleanText(row.messageId || '', 240) !== cleanText(envelope.messageId || '', 240))
        .slice(-63);
      rows.push(clone(envelope));
      const written = this._sharedWrite(key, rows);
      if (written) this.metrics.sharedMessagesPublished += 1;
      return written;
    }

    _pollSharedMailbox() {
      const local = this._localName();
      if (!local || !this._sharedStorageAvailable()) return { received: 0, reason: 'H28_SHARED_STORAGE_UNAVAILABLE' };
      const now = this.now();
      const rows = this._sharedRead(this._sharedMailboxKey(local), []);
      if (!Array.isArray(rows) || !rows.length) return { received: 0 };
      let received = 0;
      for (const envelope of rows) {
        if (!envelope || envelope.protocol !== PROTOCOL || envelope.schemaVersion !== 1) continue;
        const messageId = cleanText(envelope.messageId || '', 240);
        if (!messageId || this.sharedSeenMessageIds.has(messageId)) continue;
        if (Number.isFinite(Number(envelope.validUntilMs)) && now > Number(envelope.validUntilMs)) continue;
        if (cleanText(envelope.receiverCharacterName || '', 120) !== local) continue;
        this._boundedPut(this.sharedSeenMessageIds, messageId, now, Math.max(64, this.config.maxInboundCommands * 4));
        this.metrics.sharedMessagesReceived += 1;
        received += 1;
        try { this._receive(envelope.senderCharacterName, envelope); } catch (_) {}
      }
      return { received };
    }

    _resolveBroadcastChannelCtor() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate.BroadcastChannel === 'function') return candidate.BroadcastChannel;
        } catch (_) {}
      }
      return null;
    }

    _browserChannelKey() {
      return 'albot-h29-cross-window-v1:' + this._sharedScope();
    }

    _browserFrameValid(frame) {
      const row = asObject(frame);
      if (!row || row.schemaVersion !== 1 || row.protocol !== PROTOCOL) return false;
      const server = this._serverIdentity();
      if (server.region && cleanText(row.serverRegion || '', 80) !== server.region) return false;
      if (server.identifier && cleanText(row.serverIdentifier || '', 80) !== server.identifier) return false;
      const created = Number(row.createdAtMs);
      const validUntil = Number(row.validUntilMs);
      const now = this.now();
      if (!Number.isFinite(created) || !Number.isFinite(validUntil)
          || now < created - 5000 || now > validUntil) return false;
      return true;
    }

    _handleBrowserChannelMessage(event) {
      const frame = asObject(event && event.data);
      if (!this._browserFrameValid(frame)) return false;
      const local = this._localName();
      const sender = cleanText(frame.senderCharacterName || '', 120);
      if (!sender || sender === local || !this._ownedNames().has(sender)) return false;

      if (frame.kind === 'STATE') {
        const state = asObject(frame.state);
        if (!state) return false;
        this._updatePeer(sender, {
          ...state,
          sessionId: frame.sessionId || state.sessionId
        }, Number(frame.createdAtMs));
        this.metrics.browserChannelReceived += 1;
        return true;
      }

      if (frame.kind === 'ENVELOPE') {
        const envelope = asObject(frame.envelope);
        if (!envelope) return false;
        this.metrics.browserChannelReceived += 1;
        try { this._receive(sender, envelope); } catch (_) {}
        return true;
      }
      return false;
    }

    _installBrowserChannel() {
      if (this.browserChannel) return true;
      const Ctor = this._resolveBroadcastChannelCtor();
      if (!Ctor) return false;
      try {
        const channel = new Ctor(this._browserChannelKey());
        const handler = event => this._handleBrowserChannelMessage(event);
        if (typeof channel.addEventListener === 'function') channel.addEventListener('message', handler);
        else channel.onmessage = handler;
        this.browserChannel = channel;
        this.browserChannelName = this._browserChannelKey();
        this.browserChannelHandler = handler;
        return true;
      } catch (error) {
        this.metrics.browserChannelInstallFailures += 1;
        this._log('warn', 'H29 Browser-Channel konnte nicht installiert werden', {
          reason: errorReason(error, 'H29_BROWSER_CHANNEL_INSTALL_FAILED')
        });
        return false;
      }
    }

    _publishBrowserState(state = null) {
      if (!this.browserChannel) return false;
      const local = this._localName();
      if (!local) return false;
      const server = this._serverIdentity();
      const now = this.now();
      try {
        this.browserChannel.postMessage({
          schemaVersion: 1,
          protocol: PROTOCOL,
          kind: 'STATE',
          senderCharacterName: local,
          sessionId: this.sessionId,
          serverRegion: server.region,
          serverIdentifier: server.identifier,
          createdAtMs: now,
          validUntilMs: now + this.config.staleMs,
          state: clone(state || this._localStatePayload())
        });
        this.metrics.browserChannelPublishes += 1;
        return true;
      } catch (_) {
        return false;
      }
    }

    _publishBrowserEnvelope(envelope) {
      if (!this.browserChannel || !envelope) return false;
      const local = this._localName();
      if (!local) return false;
      const server = this._serverIdentity();
      const now = this.now();
      try {
        this.browserChannel.postMessage({
          schemaVersion: 1,
          protocol: PROTOCOL,
          kind: 'ENVELOPE',
          senderCharacterName: local,
          sessionId: this.sessionId,
          serverRegion: server.region,
          serverIdentifier: server.identifier,
          createdAtMs: now,
          validUntilMs: Number(envelope.validUntilMs) || now + this.config.settlementTimeoutMs,
          envelope: clone(envelope)
        });
        this.metrics.browserChannelPublishes += 1;
        return true;
      } catch (_) {
        return false;
      }
    }

    _destroyBrowserChannel() {
      const channel = this.browserChannel;
      const handler = this.browserChannelHandler;
      this.browserChannel = null;
      this.browserChannelHandler = null;
      this.browserChannelName = null;
      if (!channel) return;
      try {
        if (handler && typeof channel.removeEventListener === 'function') channel.removeEventListener('message', handler);
        else if (channel.onmessage === handler) channel.onmessage = null;
      } catch (_) {}
      try { if (typeof channel.close === 'function') channel.close(); } catch (_) {}
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

    _resolveCharacterCmEmitter() {
      for (const candidate of this._roots()) {
        try {
          const character = candidate && candidate.character;
          if (character && typeof character.on === 'function') return character;
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
      const sharedPublished = envelope && envelope.type === 'HEARTBEAT'
        ? this._publishSharedState(envelope.state)
        : this._publishSharedEnvelope(target, envelope);
      const browserPublished = envelope && envelope.type === 'HEARTBEAT'
        ? this._publishBrowserState(envelope.state)
        : this._publishBrowserEnvelope(envelope);
      const fallbackPublished = sharedPublished || browserPublished;
      if (fallbackPublished) {
        this.metrics.localTransportPreferred += 1;
        this.metrics.sendCmSkippedForLocalTransport += 1;
        if (metric) this.metrics[metric] += 1;
        return null;
      }

      let value = null;
      try {
        value = this._sendRaw(target, envelope);
      } catch (error) {
        this.metrics.sendCmFailures += 1;
        this.lastError = { at: nowIso(this.now()), reason: errorReason(error) };
        this.metrics.transportFailures += 1;
        this._log('warn', 'H19 Cross-Window CM Versand fehlgeschlagen', {
          target: cleanText(target || '', 120),
          type: envelope && envelope.type || null,
          reason: this.lastError.reason
        });
        throw error;
      }
      if (metric) this.metrics[metric] += 1;
      return value;
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
        fullAutonomyEnabled: typeof row.fullAutonomyEnabled === 'boolean' ? row.fullAutonomyEnabled : null,
        fullAutonomyDesiredCharacterNames: Array.isArray(row.fullAutonomyDesiredCharacterNames)
          ? [...new Set(row.fullAutonomyDesiredCharacterNames.map(name => cleanText(name, 120)).filter(Boolean))].sort().slice(0, 4)
          : [],
        fullAutonomyDesiredSource: cleanText(row.fullAutonomyDesiredSource || '', 80) || null,
        fullAutonomyDesiredChangedAtMs: Number.isFinite(Number(row.fullAutonomyDesiredChangedAtMs))
          ? Number(row.fullAutonomyDesiredChangedAtMs)
          : null,
        fullAutonomyLeaderName: cleanText(row.fullAutonomyLeaderName || '', 120) || null,
        characterDisconnectCapable: row.characterDisconnectCapable === true,
        characterNavigateCapable: row.characterNavigateCapable === true,
        version: cleanText(row.version || '', 80) || null,
        party: row.party && typeof row.party === 'object' ? {
          available: row.party.available !== false,
          partyId: cleanText(row.party.partyId || '', 160) || null,
          leader: cleanText(row.party.leader || '', 120) || null,
          memberNames: Array.isArray(row.party.memberNames)
            ? [...new Set(row.party.memberNames.map(name => cleanText(name, 120)).filter(Boolean))].slice(0, 8)
            : [],
          foreignMemberNames: Array.isArray(row.party.foreignMemberNames)
            ? [...new Set(row.party.foreignMemberNames.map(name => cleanText(name, 120)).filter(Boolean))].slice(0, 8)
            : []
        } : null,
        profile: row.profile && typeof row.profile === 'object' ? {
          schemaVersion: 1,
          name: cleanText(row.profile.name || target, 120) || target,
          ctype: cleanText(row.profile.ctype || '', 40).toLowerCase() || null,
          level: Number.isFinite(Number(row.profile.level)) ? Number(row.profile.level) : null,
          hp: Number.isFinite(Number(row.profile.hp)) ? Number(row.profile.hp) : null,
          maxHp: Number.isFinite(Number(row.profile.maxHp)) ? Number(row.profile.maxHp) : null,
          mp: Number.isFinite(Number(row.profile.mp)) ? Number(row.profile.mp) : null,
          maxMp: Number.isFinite(Number(row.profile.maxMp)) ? Number(row.profile.maxMp) : null,
          attack: Number.isFinite(Number(row.profile.attack)) ? Number(row.profile.attack) : null,
          armor: Number.isFinite(Number(row.profile.armor)) ? Number(row.profile.armor) : null,
          resistance: Number.isFinite(Number(row.profile.resistance)) ? Number(row.profile.resistance) : null,
          frequency: Number.isFinite(Number(row.profile.frequency)) ? Number(row.profile.frequency) : null,
          speed: Number.isFinite(Number(row.profile.speed)) ? Number(row.profile.speed) : null,
          range: Number.isFinite(Number(row.profile.range)) ? Number(row.profile.range) : null,
          rip: row.profile.rip === true,
          map: cleanText(row.profile.map || '', 120) || null,
          gold: Number.isFinite(Number(row.profile.gold)) ? Math.max(0, Number(row.profile.gold)) : null,
          gearScore: Number.isFinite(Number(row.profile.gearScore)) ? Math.max(0, Number(row.profile.gearScore)) : 0,
          equipment: row.profile.equipment && typeof row.profile.equipment === 'object'
            ? Object.fromEntries(Object.entries(row.profile.equipment).slice(0, 20).map(([slot, item]) => {
                const key = cleanText(slot, 40);
                if (!key || !item || typeof item !== 'object' || !item.name) return null;
                return [key, {
                  name: cleanText(item.name, 160),
                  level: Math.max(0, Math.floor(Number(item.level) || 0)),
                  statType: cleanText(item.statType != null ? item.statType : item.stat_type || '', 80) || null,
                  property: item.property == null ? (item.p == null ? null : clone(item.p)) : clone(item.property)
                }];
              }).filter(Boolean))
            : null,
          trainingMs: Number.isFinite(Number(row.profile.trainingMs)) ? Math.max(0, Number(row.profile.trainingMs)) : 0,
          observedAtMs: Number.isFinite(Number(row.profile.observedAtMs)) ? Number(row.profile.observedAtMs) : Number(observedAtMs) || this.now()
        } : null,
        observation: row.observation && typeof row.observation === 'object' ? {
          schemaVersion: 1,
          observedAt: cleanText(row.observation.observedAt || '', 80) || null,
          observedAtMs: Number.isFinite(Number(row.observation.observedAtMs)) ? Number(row.observation.observedAtMs) : Number(observedAtMs) || this.now(),
          state: cleanText(row.observation.state || '', 24).toUpperCase() || null,
          verdict: cleanText(row.observation.verdict || '', 16).toUpperCase() || null,
          reasons: Array.isArray(row.observation.reasons)
            ? row.observation.reasons.map(value => cleanText(value, 180)).filter(Boolean).slice(0, 8)
            : [],
          seq: Number.isFinite(Number(row.observation.seq)) ? Math.max(0, Number(row.observation.seq)) : 0,
          classificationOnly: true,
          actionAuthority: false
        } : null,
        updateProtection: row.updateProtection && typeof row.updateProtection === 'object' ? {
          schemaVersion: 1,
          protocol: cleanText(row.updateProtection.protocol || '', 80) || null,
          coordinatedUpdateCapable: row.updateProtection.coordinatedUpdateCapable === true,
          blocked: row.updateProtection.blocked === true,
          event: row.updateProtection.event === true,
          boss: row.updateProtection.boss === true,
          taskType: cleanText(row.updateProtection.taskType || '', 40).toUpperCase() || null,
          targetType: cleanText(row.updateProtection.targetType || '', 120) || null,
          observedAtMs: Number.isFinite(Number(row.updateProtection.observedAtMs))
            ? Number(row.updateProtection.observedAtMs)
            : Number(observedAtMs) || this.now()
        } : null,
        observedAtMs: Number(observedAtMs) || this.now(),
        aliveUntilMs: (Number(observedAtMs) || this.now()) + this.config.staleMs
      };
      this._boundedPut(this.peers, target, peer, this.config.maxPeers);
      return peer;
    }

    _localStatePayload() {
      let state = {};
      try { state = this.getLocalState() || {}; } catch (_) {}
      let party = null;
      try { party = this._partySnapshot(); } catch (_) {}
      return {
        sessionId: this.sessionId,
        running: state.running === true,
        runEpoch: Number.isFinite(Number(state.runEpoch)) ? Number(state.runEpoch) : 0,
        emergencyStopLatched: state.emergencyStopLatched === true,
        lifecycleAutonomyEnabled: typeof state.lifecycleAutonomyEnabled === 'boolean' ? state.lifecycleAutonomyEnabled : null,
        fullAutonomyEnabled: typeof state.fullAutonomyEnabled === 'boolean' ? state.fullAutonomyEnabled : null,
        fullAutonomyDesiredCharacterNames: Array.isArray(state.fullAutonomyDesiredCharacterNames)
          ? [...new Set(state.fullAutonomyDesiredCharacterNames.map(name => cleanText(name, 120)).filter(Boolean))].sort().slice(0, 4)
          : [],
        fullAutonomyDesiredSource: cleanText(state.fullAutonomyDesiredSource || '', 80) || null,
        fullAutonomyDesiredChangedAtMs: Number.isFinite(Number(state.fullAutonomyDesiredChangedAtMs))
          ? Number(state.fullAutonomyDesiredChangedAtMs)
          : null,
        fullAutonomyLeaderName: cleanText(state.fullAutonomyLeaderName || '', 120) || null,
        characterDisconnectCapable: state.characterDisconnectCapable === true,
        characterNavigateCapable: state.characterNavigateCapable === true,
        version: cleanText(state.version || '', 80) || null,
        party: party && typeof party === 'object' ? {
          available: party.available !== false,
          partyId: cleanText(party.partyId || '', 160) || null,
          leader: cleanText(party.leader || '', 120) || null,
          memberNames: Array.isArray(party.memberNames)
            ? [...new Set(party.memberNames.map(name => cleanText(name, 120)).filter(Boolean))].slice(0, 8)
            : [],
          foreignMemberNames: Array.isArray(party.foreignMemberNames)
            ? [...new Set(party.foreignMemberNames.map(name => cleanText(name, 120)).filter(Boolean))].slice(0, 8)
            : []
        } : null,
        profile: state.profile && typeof state.profile === 'object' ? clone(state.profile) : null,
        observation: state.observation && typeof state.observation === 'object' ? {
          schemaVersion: 1,
          observedAt: cleanText(state.observation.observedAt || '', 80) || null,
          observedAtMs: Number.isFinite(Number(state.observation.observedAtMs)) ? Number(state.observation.observedAtMs) : this.now(),
          state: cleanText(state.observation.state || '', 24).toUpperCase() || null,
          verdict: cleanText(state.observation.verdict || '', 16).toUpperCase() || null,
          reasons: Array.isArray(state.observation.reasons)
            ? state.observation.reasons.map(value => cleanText(value, 180)).filter(Boolean).slice(0, 8)
            : [],
          seq: Number.isFinite(Number(state.observation.seq)) ? Math.max(0, Number(state.observation.seq)) : 0,
          classificationOnly: true,
          actionAuthority: false
        } : null,
        updateProtection: state.updateProtection && typeof state.updateProtection === 'object'
          ? clone(state.updateProtection)
          : null
      };
    }

    freshPeer(name) {
      const target = cleanText(name || '', 120);
      if (!target) return null;
      this._loadSharedPeer(target);
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
      const local = this._localName();
      const names = new Set([...this.peers.keys(), ...this._ownedNames()]);
      for (const name of names) {
        if (!name || String(name) === String(local || '')) continue;
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
      const sharedState = this._localStatePayload();
      this._publishSharedState(sharedState);
      let sent = 0;
      for (const target of targets) {
        const envelope = this._baseEnvelope('HEARTBEAT', target, {
          validUntilMs: this.now() + this.config.staleMs,
          state: sharedState
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

    async _waitForOwnedCharacterOffline(characterName, timeoutMs = 6000) {
      const target = cleanText(characterName || '', 120);
      if (!target) throw new Error('H27_BROWSER_SWAP_SOURCE_REQUIRED');
      const pollMs = 100;
      const attempts = Math.max(1, Math.ceil(Math.max(1000, Number(timeoutMs) || 6000) / pollMs));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!this._onlineOwnedNames().has(target)) {
          return { offline: true, characterName: target, attempts: attempt + 1 };
        }
        if (attempt + 1 < attempts) await this._delay(pollMs);
      }
      throw new Error('H27_BROWSER_SWAP_SOURCE_OFFLINE_TIMEOUT');
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
      const supported = new Set([
        'START_RUNTIME', 'STOP_RUNTIME', 'DISCONNECT_CHARACTER', 'NAVIGATE_CHARACTER',
        'LEAVE_PARTY', 'REQUEST_PARTY_JOIN', 'PREPARE_UPDATE', 'COMMIT_UPDATE', 'CANCEL_UPDATE'
      ]);
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
        } else if (commandType === 'DISCONNECT_CHARACTER') {
          const before = this._localStatePayload();
          if (before.running !== true) throw new Error('H24_CROSS_WINDOW_CHARACTER_RUNTIME_NOT_RUNNING');
          if (before.emergencyStopLatched === true) throw new Error('H24_CROSS_WINDOW_CHARACTER_EMERGENCY_STOP_LATCHED');
          if (before.characterDisconnectCapable !== true) throw new Error('H24_CROSS_WINDOW_CHARACTER_DISCONNECT_CAPABILITY_MISSING');
          if (!this.setTimeoutFn) throw new Error('H24_CROSS_WINDOW_CHARACTER_DISCONNECT_TIMER_UNAVAILABLE');
          this.setTimeoutFn(() => {
            try { this.disconnectLocal('H24_REMOTE_CHARACTER_ROTATION:' + sender); }
            catch (error) {
              this.lastError = { at: nowIso(this.now()), reason: errorReason(error, 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_FAILED') };
              this._log('error', 'H24 Cross-Window Character Disconnect fehlgeschlagen', this.lastError);
            }
          }, 100);
          outcome = {
            reason: 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_ACCEPTED',
            details: { characterName: this._localName(), completionEvidence: 'ACCOUNT_ROSTER_OFFLINE_REQUIRED' }
          };
        } else if (commandType === 'NAVIGATE_CHARACTER') {
          const before = this._localStatePayload();
          const desiredCharacterName = cleanText(envelope.payload && envelope.payload.desiredCharacterName || '', 120);
          if (before.running !== true) throw new Error('H25_CROSS_WINDOW_CHARACTER_RUNTIME_NOT_RUNNING');
          if (before.emergencyStopLatched === true) throw new Error('H25_CROSS_WINDOW_CHARACTER_EMERGENCY_STOP_LATCHED');
          if (before.characterNavigateCapable !== true) throw new Error('H25_CROSS_WINDOW_CHARACTER_NAVIGATION_CAPABILITY_MISSING');
          if (before.characterDisconnectCapable !== true) throw new Error('H27_CROSS_WINDOW_CHARACTER_DISCONNECT_CAPABILITY_MISSING');
          const sourceCharacterName = this._localName();
          if (!desiredCharacterName || desiredCharacterName === sourceCharacterName) throw new Error('H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TARGET_INVALID');
          if (!this._ownedNames().has(desiredCharacterName)) throw new Error('H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TARGET_NOT_OWNED');
          if (this._onlineOwnedNames().has(desiredCharacterName)) throw new Error('H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TARGET_ALREADY_ONLINE');

          // Do not wait for disconnect settlement/offline evidence here. Adventure
          // Land can reload the outgoing character page as soon as disconnect is
          // dispatched; any delayed timer owned by that page is then destroyed
          // before it can navigate to the replacement. Dispatch disconnect and
          // browser navigation atomically in the same JS turn. Runtime navigation
          // still enforces the four-slot limit by reserving only this validated
          // outgoing source slot.
          const disconnect = this.disconnectLocal('H31_ATOMIC_BROWSER_ROTATION:' + sender);
          const navigation = this.navigateCharacterLocal(
            desiredCharacterName,
            'H31_ATOMIC_BROWSER_ROTATION:' + sender,
            {
              disconnectDispatched: true,
              sourceCharacterName
            }
          );
          if (navigation && navigation.accepted === false) {
            throw new Error(navigation.reason || 'H31_ATOMIC_BROWSER_NAVIGATION_REJECTED');
          }
          if (navigation && typeof navigation.then === 'function') {
            Promise.resolve(navigation).catch(error => {
              this.lastError = { at: nowIso(this.now()), reason: errorReason(error, 'H31_ATOMIC_BROWSER_NAVIGATION_FAILED') };
              this._log('error', 'H31 atomare Browser-Navigation fehlgeschlagen', this.lastError);
            });
          }
          outcome = {
            reason: 'H31_CROSS_WINDOW_ATOMIC_BROWSER_ROTATION_ACCEPTED',
            details: {
              fromCharacterName: sourceCharacterName,
              desiredCharacterName,
              disconnectDispatched: true,
              disconnectActionBoundaryId: disconnect && disconnect.actionBoundaryId || null,
              navigationDispatched: true,
              sourceOfflineConfirmed: false,
              completionEvidence: 'NEW_CHARACTER_RUNTIME_READY'
            }
          };
        } else if (commandType === 'LEAVE_PARTY') {
          outcome = await this._executePartyLeave(sender);
        } else if (commandType === 'REQUEST_PARTY_JOIN') {
          outcome = await this._executePartyJoinRequest(sender);
        } else if (commandType === 'PREPARE_UPDATE') {
          const result = await this.prepareUpdateLocal(clone(envelope.payload || {}), sender);
          if (!result || result.accepted !== true) {
            throw new Error(result && result.reason || 'H22_CROSS_WINDOW_UPDATE_PREPARE_REJECTED');
          }
          outcome = { reason: 'H22_CROSS_WINDOW_UPDATE_PREPARED', details: clone(result) };
        } else if (commandType === 'COMMIT_UPDATE') {
          const result = await this.commitUpdateLocal(clone(envelope.payload || {}), sender);
          if (!result || result.accepted !== true) {
            throw new Error(result && result.reason || 'H22_CROSS_WINDOW_UPDATE_COMMIT_REJECTED');
          }
          outcome = { reason: 'H22_CROSS_WINDOW_UPDATE_COMMITTED', details: clone(result) };
        } else if (commandType === 'CANCEL_UPDATE') {
          const result = await this.cancelUpdateLocal(clone(envelope.payload || {}), sender);
          outcome = { reason: 'H22_CROSS_WINDOW_UPDATE_CANCELLED', details: clone(result || {}) };
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
      const settlementTimeoutMs = Math.max(1000, Math.min(
        this.config.settlementTimeoutMs,
        Number(options.settlementTimeoutMs) || this.config.settlementTimeoutMs
      ));
      const envelope = this._baseEnvelope('COMMAND', target, {
        commandType: cleanText(commandType || '', 80),
        targetSessionId: peer.sessionId,
        validUntilMs: this.now() + settlementTimeoutMs,
        ...(options.payload && typeof options.payload === 'object' ? { payload: clone(options.payload) } : {})
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
        }, settlementTimeoutMs);
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

    requestCharacterDisconnect(targetName) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H24_CROSS_WINDOW_CHARACTER_PEER_NOT_FRESH' } };
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H24_CROSS_WINDOW_CHARACTER_RUNTIME_NOT_RUNNING' } };
      if (peer.emergencyStopLatched === true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H24_CROSS_WINDOW_CHARACTER_EMERGENCY_STOP_LATCHED' } };
      if (peer.characterDisconnectCapable !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H24_CROSS_WINDOW_CHARACTER_DISCONNECT_CAPABILITY_MISSING' } };
      return this._requestCommand(target, 'DISCONNECT_CHARACTER', {
        peer,
        settlementTimeoutMs: Math.min(this.config.settlementTimeoutMs, 5000)
      });
    }

    requestCharacterNavigation(targetName, desiredCharacterName) {
      const target = cleanText(targetName || '', 120);
      const desired = cleanText(desiredCharacterName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_PEER_NOT_FRESH' } };
      if (!desired || desired === target || desired === this._localName() || !this._ownedNames().has(desired)) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TARGET_INVALID' } };
      }
      if (this._onlineOwnedNames().has(desired)) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_TARGET_ALREADY_ONLINE' } };
      }
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_RUNTIME_NOT_RUNNING' } };
      if (peer.emergencyStopLatched === true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_EMERGENCY_STOP_LATCHED' } };
      if (peer.characterNavigateCapable !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H25_CROSS_WINDOW_CHARACTER_NAVIGATION_CAPABILITY_MISSING' } };
      if (peer.characterDisconnectCapable !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H27_CROSS_WINDOW_CHARACTER_DISCONNECT_CAPABILITY_MISSING' } };
      return this._requestCommand(target, 'NAVIGATE_CHARACTER', {
        peer,
        payload: { desiredCharacterName: desired },
        settlementTimeoutMs: Math.min(this.config.settlementTimeoutMs, 5000)
      });
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

    _requestUpdateCommand(targetName, commandType, payload = {}) {
      const target = cleanText(targetName || '', 120);
      const peer = this.freshPeer(target);
      if (!peer) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H22_CROSS_WINDOW_UPDATE_PEER_NOT_FRESH' } };
      if (peer.running !== true) return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H22_CROSS_WINDOW_UPDATE_RUNTIME_NOT_RUNNING' } };
      if (!peer.updateProtection || peer.updateProtection.coordinatedUpdateCapable !== true) {
        return { id: null, state: 'UNAVAILABLE', dispatched: false, error: { message: 'H22_CROSS_WINDOW_UPDATE_CAPABILITY_MISSING' } };
      }
      return this._requestCommand(target, commandType, {
        peer,
        payload,
        settlementTimeoutMs: commandType === 'PREPARE_UPDATE'
          ? this.config.settlementTimeoutMs
          : Math.min(this.config.settlementTimeoutMs, 4000)
      });
    }

    requestUpdatePrepare(targetName, payload = {}) {
      return this._requestUpdateCommand(targetName, 'PREPARE_UPDATE', payload);
    }

    requestUpdateCommit(targetName, payload = {}) {
      return this._requestUpdateCommand(targetName, 'COMMIT_UPDATE', payload);
    }

    requestUpdateCancel(targetName, payload = {}) {
      return this._requestUpdateCommand(targetName, 'CANCEL_UPDATE', payload);
    }

    install() {
      if (this.installed) return this.status();
      if (!this.root) throw new Error('H19_CROSS_WINDOW_ROOT_UNAVAILABLE');
      const self = this;
      const characterEmitter = this._resolveCharacterCmEmitter();
      if (characterEmitter) {
        try {
          this.characterCmHandler = function h26CrossWindowCharacterCm(packet) {
            const data = asObject(packet);
            const sender = cleanText(data && data.name || '', 120);
            if (!sender || !data || !Object.prototype.hasOwnProperty.call(data, 'message')) return undefined;
            return self._receive(sender, data.message);
          };
          this.characterCmListenerId = characterEmitter.on('cm', this.characterCmHandler);
          this.characterCmEmitter = characterEmitter;
          this.receiveMode = 'character-event';
        } catch (error) {
          this.characterCmEmitter = null;
          this.characterCmHandler = null;
          this.characterCmListenerId = null;
          this._log('warn', 'H26 Character-CM-Listener konnte nicht installiert werden', {
            reason: errorReason(error, 'H26_CHARACTER_CM_LISTENER_INSTALL_FAILED')
          });
        }
      }
      if (!this.receiveMode) {
        this.previousOnCm = typeof this.root.on_cm === 'function' ? this.root.on_cm : null;
        this.onCmHandler = function h19CrossWindowOnCm(sender, data) {
          const handled = self._receive(sender, data);
          if (handled !== null) return handled;
          if (self.previousOnCm) return self.previousOnCm.apply(this, arguments);
          return undefined;
        };
        this.root.on_cm = this.onCmHandler;
        this.receiveMode = 'legacy-on_cm';
      }
      this.installed = true;
      try { this._installBrowserChannel(); } catch (_) {}
      try { this._pollSharedMailbox(); } catch (_) {}
      try { this.broadcastHeartbeat(); } catch (_) {}
      if (this.setIntervalFn) {
        this.heartbeatTimer = this.setIntervalFn(() => {
          try { this._pollSharedMailbox(); } catch (_) {}
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
        if (this.characterCmEmitter && this.characterCmListenerId != null
            && typeof this.characterCmEmitter.remove === 'function') {
          this.characterCmEmitter.remove(this.characterCmListenerId);
        } else if (this.characterCmEmitter && this.characterCmHandler
            && typeof this.characterCmEmitter.off === 'function') {
          this.characterCmEmitter.off('cm', this.characterCmHandler);
        }
      } catch (_) {}
      this.characterCmEmitter = null;
      this.characterCmHandler = null;
      this.characterCmListenerId = null;
      try {
        if (this.root && this.root.on_cm === this.onCmHandler) {
          this.root.on_cm = this.previousOnCm || undefined;
        }
      } catch (_) {}
      this.onCmHandler = null;
      this.previousOnCm = null;
      this.receiveMode = null;
      this._destroyBrowserChannel();

      for (const pending of this.pending.values()) {
        try {
          if (pending.timer != null && this.clearTimeoutFn) this.clearTimeoutFn(pending.timer);
          pending.reject(new Error(cleanText(reason, 200) || 'H19_CROSS_WINDOW_DESTROYED'));
        } catch (_) {}
      }
      this.pending.clear();
      this.partyRecoveryLease = null;
      this.sharedSeenMessageIds.clear();
      if (this._sharedStorageAvailable()) {
        try {
          const key = this._sharedStateKey(this._localName());
          const row = this._sharedRead(key, null);
          if (row && cleanText(row.sessionId || '', 240) === this.sessionId
              && typeof this.storage.removeShared === 'function') {
            this.storage.removeShared(key);
          }
        } catch (_) {}
      }
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
        receiveMode: this.receiveMode,
        sharedStorageFallback: this._sharedStorageAvailable(),
        browserChannelFallback: !!this.browserChannel,
        browserChannelName: this.browserChannelName,
        transportPolicy: {
          localCrossWindowPrimary: true,
          sendCmFallbackOnly: true
        },
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
