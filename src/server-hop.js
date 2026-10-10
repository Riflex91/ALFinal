(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.helpers) throw new Error('H38_SERVER_HOP_NAMESPACE_MISSING');
  const clone = ns.helpers.clone;
  const clean = ns.helpers.cleanText;
  const PREFIX = 'albot:h38:server-hop:v1:';
  const FARMER = new Set(['ranger','rogue','mage','priest','warrior','paladin']);
  const safeNames = names => [...new Set((Array.isArray(names) ? names : []).map(x => clean(x, 120)).filter(Boolean))].sort();

  class ServerHopController {
    constructor(options = {}) {
      this.runtime = options.runtime;
      this.root = options.root || root;
      this.storage = options.storage;
      this.game = options.game;
      this.moduleActive = false;
      this.config = {
        enabled: options.enabled !== false,
        observerMs: 1500,
        competitionThreshold: Math.max(2, Number(options.competitionThreshold) || 3),
        sparseSpawnThreshold: Math.max(1, Number(options.sparseSpawnThreshold) || 2),
        congestionHoldMs: Math.max(30000, Number(options.congestionHoldMs) || 120000),
        hopCooldownMs: Math.max(900000, Number(options.hopCooldownMs) || 5400000),
        peerMaxAgeMs: 7000,
        proposalTimeoutMs: 25000,
        commitDelayMs: 9000,
        // Only the two documented, non-PVP EU worlds. No speculative PVP,
        // cross-region or unverified realm navigation.
        targetServers: [{ region: 'EU', identifier: 'I' }, { region: 'EU', identifier: 'II' }]
      };
      this.lastDecision = null;
      this.congestedSinceMs = null;
      this.metrics = { congestionObservations: 0, proposals: 0, prepared: 0, commits: 0, navigations: 0, blocked: 0 };
    }

    _server() {
      try {
        const snap = this.game.snapshot();
        return snap && snap.server && snap.server.region && snap.server.identifier
          ? { region: String(snap.server.region), identifier: String(snap.server.identifier) } : null;
      } catch (_) { return null; }
    }
    _read(key) {
      if (!this.storage || !this.storage.sharedAvailable || !this.storage.sharedAvailable()) return null;
      try { return JSON.parse(this.storage.getShared(PREFIX + key) || 'null'); } catch (_) { return null; }
    }
    _write(key, value) {
      return !!(this.storage && this.storage.sharedAvailable && this.storage.sharedAvailable()
        && this.storage.setShared(PREFIX + key, JSON.stringify(value)) === true);
    }
    _character() {
      try { return this.game.snapshot().character || null; } catch (_) { return null; }
    }
    _full() {
      try { return this.runtime.fullAutonomy.status(); } catch (_) { return null; }
    }
    _desired() {
      const full = this._full();
      return safeNames(full && full.desiredCharacterNames);
    }
    _readiness() {
      const character = this._character();
      const full = this._full();
      const name = clean(character && character.name || '', 120);
      const server = this._server();
      const s = this.runtime;
      const lifecycle = s.lifecycle && s.lifecycle.status();
      const combat = s.combat && s.combat.status();
      const farming = s.farming && s.farming.status();
      const movement = s.movement && s.movement.status();
      const updater = s.safeUpdater && s.safeUpdater.status();
      const desired = this._desired();
      const roster = s.roster && s.roster.refresh();
      const online = safeNames(roster && roster.onlineCharacterNames);
      const safe = this.config.enabled && this.moduleActive && s.running === true
        && s.stopLatch && !s.stopLatch.status().latched
        && server && name && character && !character.rip
        && full && full.enabled === true && desired.length === 4
        && desired.includes(name) && desired.every(n => online.includes(n))
        && lifecycle && !lifecycle.suspended && !lifecycle.currentAction
        && Number(lifecycle.metrics && lifecycle.metrics.actionsUnknown || 0) === 0
        && combat && !combat.pendingAttack && !combat.suspended
        && farming && !farming.pending && !farming.suspended
        && movement && !movement.active
        && updater && !updater.busy
        && !(this.game.snapshot().target);
      const fn = this._changeServerFunction();
      return {
        atMs: Date.now(), name, ctype: String(character && character.ctype || ''),
        server, desired, safe: !!safe && !!fn, switchApiAvailable: !!fn
      };
    }
    _changeServerFunction() {
      for (const r of [this.root, this.root && this.root.parent]) {
        try { if (r && typeof r.change_server === 'function') return r.change_server.bind(r); } catch (_) {}
      }
      return null;
    }
    _target(server) {
      if (!server || server.region !== 'EU') return null;
      const options = this.config.targetServers.filter(s => s.region === server.region
        && s.identifier !== server.identifier && !/PVP|HARDCORE/i.test(s.identifier));
      return options[0] || null;
    }
    _congestion(ready) {
      if (!FARMER.has(ready.ctype) || !ready.safe) return false;
      const full = this._full();
      if (!full || !full.lastPlan || full.lastPlan.leaderName !== ready.name) return false;
      const h9 = this.runtime.farmIntelligence && this.runtime.farmIntelligence.status();
      const row = h9 && h9.lastPlan && h9.lastPlan.selected;
      return !!(row && Number(row.competitors) >= this.config.competitionThreshold
        && Number(row.visibleSafeCount) <= this.config.sparseSpawnThreshold);
    }
    _reportCongestion(ready, now) {
      if (this._congestion(ready)) {
        this.metrics.congestionObservations++;
        if (this.congestedSinceMs == null) this.congestedSinceMs = now;
        this._write('congestion', {
          reporter: ready.name, server: ready.server,
          startedAtMs: this.congestedSinceMs, observedAtMs: now,
          desired: ready.desired
        });
      } else {
        this.congestedSinceMs = null;
        // Clear stale congestion: a leader that sees good spawns must veto hop.
        const state = this._read('congestion');
        if (state && state.reporter === ready.name) this._write('congestion', null);
      }
    }
    handoffActive() {
      const ticket = this._read('proposal');
      if (!ticket || ticket.schemaVersion !== 1 || ticket.state !== 'COMMITTED'
          || Date.now() > ticket.expiresAtMs || !ticket.target) return false;
      const server = this._server();
      if (!server || !ticket.source) return false;
      const involved = (server.region === ticket.source.region && server.identifier === ticket.source.identifier)
        || (server.region === ticket.target.region && server.identifier === ticket.target.identifier);
      if (!involved) return false;
      // Suppress H19's roster recovery while worlds diverge. LocalStorage
      // survives navigation and this check is independent of peer combat state.
      return !safeNames(ticket.desired).every(name => {
        const peer = this._read('peer:' + name);
        return peer && peer.server
          && peer.server.region === ticket.target.region
          && peer.server.identifier === ticket.target.identifier
          && Date.now() - peer.atMs >= 0 && Date.now() - peer.atMs < 12000;
      });
    }
    _lastHop() { return this._read('last-hop'); }
    _freshPeer(name, ready, now) {
      const peer = this._read('peer:' + name);
      return !!(peer && peer.name === name && peer.safe === true
        && now - peer.atMs >= 0 && now - peer.atMs <= this.config.peerMaxAgeMs
        && peer.server && peer.server.region === ready.server.region
        && peer.server.identifier === ready.server.identifier
        && JSON.stringify(peer.desired) === JSON.stringify(ready.desired));
    }
    _isTeamReady(ready, now) {
      return ready.desired.length === 4 && ready.desired.every(name => this._freshPeer(name, ready, now));
    }
    _decision(state, reason, extra = {}) {
      this.lastDecision = { at: new Date().toISOString(), state, reason, ...extra };
      if (state === 'BLOCKED') this.metrics.blocked++;
      return this.lastDecision;
    }
    tick() {
      if (!this.moduleActive || !this.config.enabled) return this._decision('IDLE', 'H38_DISABLED');
      const now = Date.now(), ready = this._readiness();
      if (!ready.name || !ready.server) return this._decision('WAITING', 'H38_NO_CHARACTER_OR_SERVER');
      if (!this._write('peer:' + ready.name, ready)) return this._decision('WAITING', 'H38_SHARED_STORAGE_UNAVAILABLE');

      const pending = this._read('proposal');
      // Never repeat an already-successful navigation after reloading.
      if (pending && pending.schemaVersion === 1 && pending.state === 'COMMITTED'
          && pending.expiresAtMs > now && pending.desired.includes(ready.name)
          && pending.target && pending.source
          && pending.source.region === ready.server.region
          && pending.source.identifier === ready.server.identifier) {
        if (!ready.safe) return this._decision('BLOCKED', 'H38_COMMIT_SAFETY_GATE');
        if (now < pending.switchAtMs) return this._decision('PREPARED', 'H38_COMMIT_WAITING', { switchAtMs: pending.switchAtMs });
        const marker = this._read('executed:' + ready.name);
        if (marker && marker.id === pending.id) return this._decision('WAITING', 'H38_ALREADY_DISPATCHED');
        if (!this._write('executed:' + ready.name, { id: pending.id, atMs: now })) return this._decision('BLOCKED', 'H38_DURABLE_EXECUTION_MARKER_FAILED');
        const change = this._changeServerFunction();
        if (!change) return this._decision('BLOCKED', 'H38_CHANGE_SERVER_API_MISSING');
        this.metrics.navigations++;
        try {
          change(pending.target.region, pending.target.identifier);
          return this._decision('SWITCHING', 'H38_SERVER_CHANGE_DISPATCHED', { target: pending.target });
        } catch (error) {
          return this._decision('BLOCKED', 'H38_SERVER_CHANGE_THROW', { error: clean(error && error.message || error, 200) });
        }
      }
      if (!ready.safe) return this._decision('WAITING', 'H38_LOCAL_NOT_READY');

      const c = this._character();
      if (FARMER.has(String(c.ctype))) this._reportCongestion(ready, now);

      if (pending && pending.schemaVersion === 1 && pending.state === 'PROPOSED'
          && pending.expiresAtMs > now && pending.desired.includes(ready.name)
          && pending.source && pending.source.region === ready.server.region
          && pending.source.identifier === ready.server.identifier) {
        if (JSON.stringify(pending.desired) !== JSON.stringify(ready.desired))
          return this._decision('BLOCKED', 'H38_PROPOSAL_ROSTER_CHANGED');
        this._write('ack:' + ready.name, { id: pending.id, name: ready.name, atMs: now });
        this.metrics.prepared++;
        if (String(c.ctype) === 'merchant') {
          const complete = this._isTeamReady(ready, now)
            && ready.desired.every(name => {
              const ack = this._read('ack:' + name);
              return ack && ack.id === pending.id && now - ack.atMs <= this.config.peerMaxAgeMs;
            });
          if (complete) {
            const committed = { ...pending, state: 'COMMITTED', switchAtMs: now + this.config.commitDelayMs, expiresAtMs: now + 180000 };
            if (this._write('proposal', committed)
                && this._write('last-hop', { atMs: now, source: ready.server, target: pending.target })) {
              this.metrics.commits++;
              return this._decision('COMMITTED', 'H38_QUORUM_CONFIRMED', { target: pending.target });
            }
          }
        }
        return this._decision('PREPARED', 'H38_WAITING_FOR_ALL_FOUR');
      }

      if (String(c.ctype) !== 'merchant') return this._decision('IDLE', 'H38_MERCHANT_COORDINATES');
      if (pending && pending.expiresAtMs > now) return this._decision('WAITING', 'H38_EXISTING_PROPOSAL');
      const report = this._read('congestion');
      if (!report || !report.server || report.server.region !== ready.server.region
          || report.server.identifier !== ready.server.identifier
          || now - report.observedAtMs > this.config.peerMaxAgeMs
          || now - report.startedAtMs < this.config.congestionHoldMs
          || !ready.desired.includes(report.reporter))
        return this._decision('IDLE', 'H38_NO_SUSTAINED_CONGESTION');
      const last = this._lastHop();
      if (last && now - last.atMs < this.config.hopCooldownMs)
        return this._decision('WAITING', 'H38_HOP_COOLDOWN');
      const target = this._target(ready.server);
      if (!target) return this._decision('BLOCKED', 'H38_NO_VERIFIED_PVE_ALTERNATIVE');
      if (!this._isTeamReady(ready, now)) return this._decision('WAITING', 'H38_TEAM_NOT_READY');
      const ticket = {
        schemaVersion: 1, id: ready.name + ':' + now,
        state: 'PROPOSED', source: ready.server, target,
        desired: ready.desired, createdAtMs: now,
        expiresAtMs: now + this.config.proposalTimeoutMs
      };
      if (!this._write('proposal', ticket)) return this._decision('BLOCKED', 'H38_PROPOSAL_WRITE_FAILED');
      this.metrics.proposals++;
      return this._decision('PROPOSED', 'H38_CROWDED_SPAWN_HOP_PROPOSED', { target });
    }

    start(context = {}) {
      this.moduleActive = true;
      if (context.scope && typeof context.scope.interval === 'function')
        context.scope.interval('server-hop-observer', () => this.tick(), this.config.observerMs);
      return this.status();
    }
    stop() { this.moduleActive = false; return this.status(); }
    configure(options = {}) {
      if (options.enabled != null) this.config.enabled = options.enabled === true;
      return this.status();
    }
    status() {
      return { moduleActive: this.moduleActive, enabled: this.config.enabled,
        lastDecision: clone(this.lastDecision), congestionSinceMs: this.congestedSinceMs,
        config: clone(this.config), metrics: clone(this.metrics) };
    }
  }

  ns.ServerHopController = ServerHopController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
