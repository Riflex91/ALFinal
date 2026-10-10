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
        splitRejoinPeerMaxAgeMs: 15000,
        splitRejoinTicketMs: 120000,
        splitRejoinCooldownMs: 300000,
        // A current, authoritative get_servers() catalog is required before
        // navigation. The target list contains only explicitly non-PVP EU/US
        // realms. Never guess server identifiers or assume unknown PVP flags.
        catalogRefreshMs: 300000,
        catalogMaxAgeMs: 900000,
        targetServers: []
      };
      this.lastDecision = null;
      this.congestedSinceMs = null;
      this.catalogUpdatedAtMs = null;
      this.catalogPending = false;
      this.catalogError = null;
      this.catalogRequestId = 0;
      this.metrics = { congestionObservations: 0, proposals: 0, prepared: 0, commits: 0, navigations: 0, blocked: 0,
        splitRejoinProposals: 0, splitRejoinNavigations: 0, splitRejoinCompleted: 0 };
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
      const owned = safeNames(roster && roster.accountCharacters && roster.accountCharacters.map(row => row.name));
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
      // Split-party recovery requires a fresh owned four-character roster,
      // but must not require an already assembled party or H19 peers.
      const rejoinSafe = this.config.enabled && this.moduleActive && s.running === true
        && s.stopLatch && !s.stopLatch.status().latched
        && !!fn && !!name && !!server && !character.rip
        && full && full.enabled === true
        && roster && roster.accountStateAvailable === true
        && roster.onlineStateAvailable === true
        && online.length === 4 && owned.length >= 4
        && online.every(n => owned.includes(n)) && online.includes(name)
        && lifecycle && !lifecycle.suspended && !lifecycle.currentAction
        && Number(lifecycle.metrics && lifecycle.metrics.actionsUnknown || 0) === 0
        && combat && !combat.pendingAttack && !combat.suspended
        && farming && !farming.pending && !farming.suspended
        && movement && !movement.active && updater && !updater.busy
        && !(this.game.snapshot().target);
      return {
        atMs: Date.now(), name, ctype: String(character && character.ctype || ''),
        server, desired, online, rejoinSafe: !!rejoinSafe,
        safe: !!safe && !!fn, switchApiAvailable: !!fn
      };
    }
    _changeServerFunction() {
      for (const r of [this.root, this.root && this.root.parent]) {
        try { if (r && typeof r.change_server === 'function') return r.change_server.bind(r); } catch (_) {}
      }
      return null;
    }
    _gameServerCatalogFunction() {
      for (const r of [this.root, this.root && this.root.parent]) {
        try { if (r && typeof r.get_servers === 'function') return r.get_servers.bind(r); } catch (_) {}
      }
      return null;
    }
    _normalizeGameServerCatalog(response) {
      const rows = Array.isArray(response) ? response
        : response && Array.isArray(response.servers) ? response.servers
        : response && response.data && Array.isArray(response.data.servers) ? response.data.servers
        : response && response.servers && typeof response.servers === 'object'
          ? Object.values(response.servers) : [];
      const out = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const region = String(row.region || row.server_region || row.serverRegion || '').trim().toUpperCase();
        const identifier = String(row.identifier || row.server_identifier || row.serverIdentifier || row.name || '').trim().toUpperCase();
        if (!['EU', 'US'].includes(region) || !/^[IVXLCDM]{1,10}$/.test(identifier)) continue;
        // The server API is authoritative for PVP classification. Unknown
        // PVP metadata is NOT enough evidence for a safe automatic hop.
        const explicitlyPve = row.pvp === false || row.pvp === 0
          || row.is_pvp === false || row.isPvp === false
          || String(row.type || '').toLowerCase() === 'pve';
        // H39: the server name itself is a hard PVP deny rule.
        // Even contradictory metadata (pvp: false / type: pve) cannot
        // override a name containing "pvp" at any position or case.
        const serverName = String(row.name || row.server_name || row.serverName || '');
        const pvpInName = serverName.toLowerCase().includes('pvp');
        const forbidden = pvpInName || row.pvp === true || row.is_pvp === true || row.isPvp === true
          || row.hardcore === true || row.isHardcore === true
          || /PVP|HARDCORE/i.test(String(row.type || '') + ' ' + identifier)
          || /HARDCORE/i.test(serverName);
        if (!explicitlyPve || forbidden) continue;
        if (!out.some(s => s.region === region && s.identifier === identifier)) out.push({ region, identifier });
      }
      // Stable iteration order allows round-robin between both continents.
      const romanValue = value => {
        const weights = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let total = 0, previous = 0;
        for (const c of String(value).split('').reverse()) {
          const n = weights[c] || 0;
          total += n < previous ? -n : n;
          previous = n;
        }
        return total;
      };
      return out.sort((a, b) => a.region.localeCompare(b.region)
        || romanValue(a.identifier) - romanValue(b.identifier)
        || a.identifier.localeCompare(b.identifier));
    }
    _refreshGameServerCatalog() {
      const character = this._character();
      if (!this.moduleActive || !character || String(character.ctype) !== 'merchant') return;
      const now = Date.now();
      if (this.catalogPending || this.catalogUpdatedAtMs != null
          && now - this.catalogUpdatedAtMs < this.config.catalogRefreshMs) return;
      const getServers = this._gameServerCatalogFunction();
      if (!getServers) {
        this.catalogError = 'H39_GET_SERVERS_API_UNAVAILABLE';
        this.config.targetServers = [];
        this.catalogUpdatedAtMs = now;
        return;
      }
      const requestId = ++this.catalogRequestId;
      this.catalogPending = true;
      let result;
      try { result = getServers(); } catch (error) {
        this.catalogPending = false;
        this.config.targetServers = [];
        this.catalogUpdatedAtMs = now;
        this.catalogError = 'H39_GET_SERVERS_CALL_FAILED:' + clean(error && error.message || error, 120);
        return;
      }
      Promise.resolve(result).then(servers => {
        if (!this.moduleActive || requestId !== this.catalogRequestId) return;
        this.catalogUpdatedAtMs = Date.now();
        this.config.targetServers = this._normalizeGameServerCatalog(servers);
        this.catalogError = this.config.targetServers.length ? null : 'H39_NO_VERIFIED_PVE_SERVERS';
      }, error => {
        if (!this.moduleActive || requestId !== this.catalogRequestId) return;
        this.catalogUpdatedAtMs = Date.now();
        this.config.targetServers = [];
        this.catalogError = 'H39_GET_SERVERS_REJECTED:' + clean(error && error.message || error, 120);
      }).then(() => {
        if (requestId === this.catalogRequestId) this.catalogPending = false;
      });
    }
    _target(server) {
      if (!server || !['EU', 'US'].includes(server.region)
          || this.catalogPending || !this.catalogUpdatedAtMs
          || Date.now() - this.catalogUpdatedAtMs > this.config.catalogMaxAgeMs) return null;
      const list = this.config.targetServers;
      if (!Array.isArray(list) || list.length < 2) return null;
      const current = list.findIndex(s => s.region === server.region && s.identifier === server.identifier);
      // The current server may have been omitted from a degraded catalog:
      // fail closed instead of choosing an unrelated realm.
      if (current < 0) return null;
      // Round-robin over EU and US worlds, never PVP, including cross-region
      // transitions when reaching the end of one continent's catalog.
      for (let offset = 1; offset < list.length; offset++) {
        const candidate = list[(current + offset) % list.length];
        if (candidate && (candidate.region !== server.region || candidate.identifier !== server.identifier))
          return { region: candidate.region, identifier: candidate.identifier };
      }
      return null;
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
    _standardPveServer(server) {
      // H42 self-repair targets only the already-observed live majority
      // server, and only normal EU/US Roman-numeral worlds. Any "pvp" or
      // Hardcore name, identifier or region must be rejected.
      if (!server || !['EU', 'US'].includes(String(server.region || '').toUpperCase())) return false;
      const id = String(server.identifier || '').toUpperCase();
      const name = String(server.name || '');
      return /^[IVXLCDM]{1,10}$/.test(id) && !/pvp|hardcore/i.test(id + ' ' + name);
    }
    _sameServer(a, b) {
      return !!(a && b && a.region === b.region && a.identifier === b.identifier);
    }
    _splitRejoinPeer(name, online, now) {
      const peer = this._read('peer:' + name);
      return peer && peer.name === name && peer.rejoinSafe === true
        && peer.server && this._standardPveServer(peer.server)
        && now >= peer.atMs && now - peer.atMs <= this.config.splitRejoinPeerMaxAgeMs
        && JSON.stringify(safeNames(peer.online)) === JSON.stringify(online)
        ? peer : null;
    }
    _splitRejoinActive(ticket, now = Date.now()) {
      if (!ticket || ticket.version !== 1 || ticket.state !== 'COMMITTED'
          || now > ticket.expiresAtMs || !this._standardPveServer(ticket.target)
          || !Array.isArray(ticket.names) || ticket.names.length !== 4) return false;
      return !ticket.names.every(name => {
        const peer = this._read('peer:' + name);
        return peer && peer.server && this._sameServer(peer.server, ticket.target)
          && now >= peer.atMs && now - peer.atMs < this.config.splitRejoinPeerMaxAgeMs;
      });
    }
    _splitRejoin(ready, now) {
      const ticket = this._read('rejoin');
      if (ticket && ticket.version === 1 && ticket.state === 'COMMITTED'
          && now <= ticket.expiresAtMs && this._standardPveServer(ticket.target)) {
        if (!safeNames(ticket.names).includes(ready.name)) return this._decision('BLOCKED', 'H42_REJOIN_UNOWNED_LOCAL');
        if (this._sameServer(ready.server, ticket.target)) {
          if (!this._splitRejoinActive(ticket, now)) {
            if (ready.ctype === 'merchant') {
              this._write('rejoin', { ...ticket, state: 'COMPLETE', completedAtMs: now });
              this.metrics.splitRejoinCompleted++;
            }
            return this._decision('IDLE', 'H42_REJOIN_COMPLETE');
          }
          return this._decision('WAITING', 'H42_REJOIN_WAIT_FOR_PEERS', { target: ticket.target });
        }
        if (!ready.rejoinSafe) return this._decision('BLOCKED', 'H42_REJOIN_H19_SAFETY_GATE');
        if (!ready.online || JSON.stringify(safeNames(ready.online)) !== JSON.stringify(safeNames(ticket.names)))
          return this._decision('BLOCKED', 'H42_REJOIN_ROSTER_CHANGED');
        const source = ticket.sources && ticket.sources[ready.name];
        if (!source || !this._sameServer(source, ready.server))
          return this._decision('BLOCKED', 'H42_REJOIN_SOURCE_CHANGED');
        const last = this._read('rejoin-executed:' + ready.name);
        if (last && last.id === ticket.id) return this._decision('WAITING', 'H42_REJOIN_ALREADY_DISPATCHED');
        if (!this._write('rejoin-executed:' + ready.name, { id: ticket.id, atMs: now }))
          return this._decision('BLOCKED', 'H42_REJOIN_EXECUTION_MARKER_FAILED');
        const change = this._changeServerFunction();
        if (!change) return this._decision('BLOCKED', 'H42_REJOIN_API_UNAVAILABLE');
        try {
          change(ticket.target.region, ticket.target.identifier);
          this.metrics.splitRejoinNavigations++;
          return this._decision('SWITCHING', 'H42_REJOIN_SERVER_CHANGE_DISPATCHED', { target: ticket.target });
        } catch (error) {
          return this._decision('BLOCKED', 'H42_REJOIN_CHANGE_THROW', { error: clean(error && error.message || error, 160) });
        }
      }
      // A previously confirmed H38 relocation has priority over H42
      // recovery. Do not reverse an in-flight coordinated server change.
      const normalHop = this._read('proposal');
      if (normalHop && normalHop.state === 'COMMITTED'
          && now < normalHop.expiresAtMs)
        return null; // Hand control to the existing H38 commit handler.

      const online = safeNames(ready.online);
      if (online.length !== 4 || !online.includes(ready.name)) return null;
      if (ready.ctype !== 'merchant') return null;
      const peers = online.map(name => this._splitRejoinPeer(name, online, now));
      if (peers.some(peer => !peer)) return null;
      if (peers.filter(peer => peer.ctype === 'merchant').length !== 1
          || peers.filter(peer => FARMER.has(peer.ctype)).length !== 3) return null;
      const groups = new Map();
      for (const peer of peers) {
        const id = peer.server.region + ':' + peer.server.identifier;
        const group = groups.get(id) || { server: peer.server, members: [] };
        group.members.push(peer.name);
        groups.set(id, group);
      }
      if (groups.size === 1) return null;
      // A 2:2 split is ambiguous: no forced server moves.
      const majority = [...groups.values()].find(group => group.members.length === 3);
      if (!majority || !this._standardPveServer(majority.server)) return null;
      const old = this._read('rejoin-last');
      if (old && Number.isFinite(old.atMs)
          && now - old.atMs < this.config.splitRejoinCooldownMs) {
        return this._decision('WAITING', 'H42_REJOIN_RETRY_COOLDOWN');
      }
      const proposed = {
        version: 1, id: 'h42-' + ready.name + '-' + now,
        state: 'COMMITTED', author: ready.name, names: online,
        target: majority.server, sources: Object.fromEntries(peers.map(peer => [peer.name, peer.server])),
        atMs: now, expiresAtMs: now + this.config.splitRejoinTicketMs
      };
      if (!this._write('rejoin', proposed)
          || !this._write('rejoin-last', { atMs: now, id: proposed.id }))
        return this._decision('BLOCKED', 'H42_REJOIN_SSD_WRITE_FAILED');
      this.metrics.splitRejoinProposals++;
      return this._decision('COMMITTED', 'H42_REJOIN_MAJORITY_SELECTED',
        { target: majority.server, movingNames: online.filter(name => !majority.members.includes(name)) });
    }
    rejoinActive() {
      return this._splitRejoinActive(this._read('rejoin'));
    }
    handoffActive() {
      if (this.rejoinActive()) return true;
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
      this._refreshGameServerCatalog();
      const now = Date.now(), ready = this._readiness();
      if (!ready.name || !ready.server) return this._decision('WAITING', 'H38_NO_CHARACTER_OR_SERVER');
      if (!this._write('peer:' + ready.name, ready)) return this._decision('WAITING', 'H38_SHARED_STORAGE_UNAVAILABLE');

      // H42 must run before H38 congestion planning. It does not require
      // Full Autonomy to have already formed the party on one realm.
      const rejoin = this._splitRejoin(ready, now);
      if (rejoin) return rejoin;

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
    stop() {
      this.moduleActive = false;
      this.catalogRequestId++;
      this.catalogPending = false;
      return this.status();
    }
    configure(options = {}) {
      if (options.enabled != null) this.config.enabled = options.enabled === true;
      return this.status();
    }
    status() {
      return { moduleActive: this.moduleActive, enabled: this.config.enabled,
        lastDecision: clone(this.lastDecision), congestionSinceMs: this.congestedSinceMs,
        catalog: {
          updatedAtMs: this.catalogUpdatedAtMs,
          pending: this.catalogPending,
          error: this.catalogError,
          verifiedPveServers: clone(this.config.targetServers)
        },
        config: clone(this.config), metrics: clone(this.metrics) };
    }
  }

  ns.ServerHopController = ServerHopController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
