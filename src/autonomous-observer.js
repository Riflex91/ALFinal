(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__ = root.__ALBOT_INTERNALS__ || {};
  const clone = ns.helpers && ns.helpers.clone
    ? ns.helpers.clone
    : value => value == null ? value : JSON.parse(JSON.stringify(value));
  const cleanText = ns.helpers && ns.helpers.cleanText
    ? ns.helpers.cleanText
    : (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);

  const SECRET_KEY_PATTERN = /(authorization|password|passwd|secret|token|cookie|api[_-]?key|session[_-]?key|private[_-]?key|credential)/i;

  function finite(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function safeIso(value, fallbackMs) {
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(fallbackMs).toISOString();
  }

  function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length <= 4000 ? value : value.slice(0, 4000) + '…[truncated]';
    if (typeof value !== 'object') return cleanText(value, 500);
    if (depth >= 8) return '[max-depth]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 120).map(entry => sanitize(entry, depth + 1, seen));
    const out = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= 240) {
        out.__truncatedKeys = true;
        break;
      }
      count += 1;
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitize(entry, depth + 1, seen);
    }
    return out;
  }

  class BoundedTelemetryRing {
    constructor(limit = 600) {
      this.limit = Math.max(50, Math.min(5000, Math.floor(finite(limit, 600))));
      this.rows = [];
    }

    push(row) {
      this.rows.push(clone(row));
      if (this.rows.length > this.limit) this.rows.splice(0, this.rows.length - this.limit);
      return clone(row);
    }

    list(limit = this.limit) {
      const n = Math.max(0, Math.min(this.rows.length, Math.floor(finite(limit, this.limit))));
      return clone(this.rows.slice(this.rows.length - n));
    }

    between(startMs, endMs, limit = this.limit) {
      const rows = this.rows.filter(row => {
        const at = finite(row && row.atMs, null);
        return at != null && at >= startMs && at <= endMs;
      });
      return clone(rows.slice(-Math.max(1, Math.min(this.limit, Math.floor(finite(limit, this.limit))))));
    }

    clear() {
      this.rows.length = 0;
    }

    status() {
      return { limit: this.limit, size: this.rows.length };
    }
  }

  class AutonomousObservationCoordinator {
    constructor(options = {}) {
      if (!options.runtime) throw new Error('H22_OBSERVER_RUNTIME_REQUIRED');
      this.runtime = options.runtime;
      this.root = options.root || this.runtime.root || root;
      this.logger = options.logger || this.runtime.logger || null;
      this.bus = options.bus || this.runtime.bus || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        tickMs: Math.max(250, Math.min(10000, Math.floor(finite(options.tickMs, 1000)))),
        timerGapWarnMs: Math.max(1500, Math.floor(finite(options.timerGapWarnMs, 2500))),
        timerGapCriticalMs: Math.max(3000, Math.floor(finite(options.timerGapCriticalMs, 6000))),
        farmerWatchMs: Math.max(30000, Math.floor(finite(options.farmerWatchMs, 90000))),
        farmerCriticalMs: Math.max(60000, Math.floor(finite(options.farmerCriticalMs, 180000))),
        merchantWatchMs: Math.max(60000, Math.floor(finite(options.merchantWatchMs, 180000))),
        merchantCriticalMs: Math.max(120000, Math.floor(finite(options.merchantCriticalMs, 600000))),
        peerCriticalMs: Math.max(5000, Math.floor(finite(options.peerCriticalMs, 15000))),
        eventLimit: Math.max(100, Math.min(5000, Math.floor(finite(options.eventLimit, 900)))),
        incidentLimit: Math.max(4, Math.min(100, Math.floor(finite(options.incidentLimit, 24)))),
        incidentPreMs: Math.max(5000, Math.min(10 * 60 * 1000, Math.floor(finite(options.incidentPreMs, 60000)))),
        incidentPostMs: Math.max(1000, Math.min(2 * 60 * 1000, Math.floor(finite(options.incidentPostMs, 10000)))),
        incidentDedupeMs: Math.max(10000, Math.min(60 * 60 * 1000, Math.floor(finite(options.incidentDedupeMs, 120000)))),
        hostBeaconLeaseMs: Math.max(3000, Math.min(5 * 60 * 1000, Math.floor(finite(options.hostBeaconLeaseMs, 10000))))
      };
      if (this.config.timerGapCriticalMs < this.config.timerGapWarnMs) this.config.timerGapCriticalMs = this.config.timerGapWarnMs;
      if (this.config.farmerCriticalMs < this.config.farmerWatchMs) this.config.farmerCriticalMs = this.config.farmerWatchMs;
      if (this.config.merchantCriticalMs < this.config.merchantWatchMs) this.config.merchantCriticalMs = this.config.merchantWatchMs;

      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.sequence = 0;
      this.hostBeaconSeq = 0;
      this.lastHostBeacon = null;
      this.lastTickAtMs = null;
      this.lastAssessment = this._emptyAssessment();
      this.lastSnapshot = null;
      this.events = new BoundedTelemetryRing(this.config.eventLimit);
      this.incidents = [];
      this.openIncident = null;
      this.lastIncidentFingerprint = null;
      this.lastIncidentAtMs = null;
      this.progress = {
        farmer: { expectedSinceMs: null, lastProgressAtMs: null, token: null },
        merchant: { expectedSinceMs: null, lastProgressAtMs: null, token: null }
      };
      this.stats = {
        ticks: 0,
        events: 0,
        warnings: 0,
        errors: 0,
        stateChanges: 0,
        timerGaps: 0,
        farmerWatches: 0,
        farmerCritical: 0,
        merchantWatches: 0,
        merchantCritical: 0,
        groupWatches: 0,
        groupCritical: 0,
        incidentsOpened: 0,
        incidentsFinalized: 0,
        incidentsDeduped: 0
      };
    }

    _emptyAssessment() {
      return {
        schemaVersion: 1,
        at: new Date(this.now()).toISOString(),
        atMs: this.now(),
        state: 'HEALTHY',
        verdict: 'PASS',
        reasons: [],
        subsystems: {},
        classificationOnly: true,
        actionAuthority: false,
        gameplayActionAuthority: false,
        codeRepairAuthority: false
      };
    }

    _read(controller) {
      try {
        return controller && typeof controller.status === 'function' ? controller.status() : null;
      } catch (_) {
        return null;
      }
    }

    _record(type, severity = 'INFO', component = 'observer', reason = null, data = null) {
      const atMs = this.now();
      const row = {
        schemaVersion: 1,
        seq: ++this.sequence,
        at: new Date(atMs).toISOString(),
        atMs,
        type: cleanText(type || 'OBSERVATION', 120) || 'OBSERVATION',
        severity: cleanText(severity || 'INFO', 20).toUpperCase() || 'INFO',
        component: cleanText(component || 'observer', 120) || 'observer',
        reason: cleanText(reason || '', 300) || null,
        data: sanitize(data)
      };
      this.events.push(row);
      this.stats.events += 1;
      if (row.severity === 'WARN' || row.severity === 'WARNING') this.stats.warnings += 1;
      if (row.severity === 'ERROR' || row.severity === 'CRITICAL' || row.severity === 'FATAL') this.stats.errors += 1;
      return clone(row);
    }

    start(context = {}) {
      if (this.moduleActive) return this.status();
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;

      if (this.bus && typeof this.bus.on === 'function') {
        const offLog = this.bus.on('log', row => {
          const level = String(row && row.level || '').toUpperCase();
          if (level === 'WARN' || level === 'ERROR') {
            this._record('RUNTIME_LOG', level, 'logger', row && row.message || level, row && row.data || null);
          }
        });
        const offScheduler = this.bus.on('scheduler-error', details => {
          this._record('SCHEDULER_ERROR', 'ERROR', 'scheduler', details && details.error && details.error.message || 'SCHEDULER_CALLBACK_FAILED', details);
        });
        const offRecovery = this.bus.on('h22-known-recovery', row => {
          const severity = String(row && row.severity || 'INFO').toUpperCase();
          this._record(
            'KNOWN_RECOVERY',
            severity,
            'known-recovery',
            row && (row.reason || row.type) || 'KNOWN_RECOVERY_EVENT',
            row
          );
        });
        if (this.scope && typeof this.scope.cleanup === 'function') {
          this.scope.cleanup('observer-bus-unsubscribe', () => {
            try { offLog(); } catch (_) {}
            try { offScheduler(); } catch (_) {}
            try { offRecovery(); } catch (_) {}
          });
        }
      }

      if (!this.scope || typeof this.scope.interval !== 'function') throw new Error('H22_OBSERVER_SCOPE_REQUIRED');
      this.scope.interval('diagnostic-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      this._record('OBSERVER_STARTED', 'INFO', 'observer', 'H22_LOCAL_OBSERVATION_ACTIVE', {
        tickMs: this.config.tickMs,
        eventLimit: this.config.eventLimit
      });
      return this.status();
    }

    stop(reason = 'H22_OBSERVER_STOP') {
      if (this.openIncident) this._finalizeIncident(this.now(), 'OBSERVER_STOP');
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this._record('OBSERVER_STOPPED', 'INFO', 'observer', cleanText(reason, 240));
      return this.status();
    }

    _moduleSignals(modules, add) {
      for (const row of Array.isArray(modules) ? modules : []) {
        if (!row || row.id === 'autonomous-observer') continue;
        if (row.state === 'ERROR' || row.health === 'ERROR') {
          add('MODULE_ERROR:' + String(row.id || 'unknown'), 2, 'runtime');
        } else if (row.health === 'STALE') {
          add('MODULE_STALE:' + String(row.id || 'unknown'), 2, 'runtime');
        }
      }
    }

    _suspensionSignals(statuses, add) {
      for (const [name, status] of Object.entries(statuses)) {
        if (!status || status.suspended !== true) continue;
        const reason = cleanText(status.suspendedReason || 'SUSPENDED', 160).toUpperCase();
        const critical = /UNKNOWN|UNCONFIRMED|SAFETY|EMERGENCY|TERMINAL|FAIL/.test(reason);
        add(name.toUpperCase() + '_SUSPENDED:' + reason, critical ? 2 : 1, name);
      }
    }

    _progressToken(status, fields) {
      const metrics = status && status.metrics || {};
      return fields.reduce((sum, key) => sum + Math.max(0, finite(metrics[key], 0)), 0);
    }

    _progressHealth(slot, expected, token, now, watchMs, criticalMs, watchReason, criticalReason, add) {
      const row = this.progress[slot];
      if (!expected) {
        row.expectedSinceMs = null;
        row.lastProgressAtMs = null;
        row.token = token;
        return { expected: false, progressAgeMs: null, token };
      }

      if (row.expectedSinceMs == null) {
        row.expectedSinceMs = now;
        row.lastProgressAtMs = now;
        row.token = token;
      } else if (row.token == null || token !== row.token) {
        row.token = token;
        row.lastProgressAtMs = now;
      }

      const ageMs = Math.max(0, now - finite(row.lastProgressAtMs, row.expectedSinceMs));
      if (ageMs >= criticalMs) add(criticalReason, 2, slot);
      else if (ageMs >= watchMs) add(watchReason, 1, slot);
      return { expected: true, progressAgeMs: ageMs, token };
    }

    _groupHealth(full, transport, roster, localName, add) {
      const desired = full && Array.isArray(full.desiredCharacterNames) ? full.desiredCharacterNames.map(String) : [];
      if (!(full && full.enabled === true && desired.length === 4)) {
        return { expected: false, desired: desired.slice().sort(), remote: [] };
      }

      const online = roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String).sort() : [];
      if (online.length > 4) add('GROUP_ONLINE_LIMIT_EXCEEDED', 2, 'group');
      const missingOnline = desired.filter(name => !online.includes(name));
      if (missingOnline.length) add('GROUP_DESIRED_MEMBER_OFFLINE', 1, 'group');

      const peers = transport && Array.isArray(transport.peers) ? transport.peers : [];
      const expectedRemote = desired.filter(name => name !== String(localName || ''));
      const remote = [];
      for (const name of expectedRemote) {
        const peer = peers.find(row => row && String(row.name) === name) || null;
        if (!peer) {
          add('GROUP_PEER_UNOBSERVED:' + name, 1, 'group');
          remote.push({ name, fresh: false, ageMs: null, observationState: null });
          continue;
        }
        const ageMs = Math.max(0, finite(peer.ageMs, this.now() - finite(peer.observedAtMs, this.now())));
        if (peer.fresh !== true) add('GROUP_PEER_STALE:' + name, ageMs >= this.config.peerCriticalMs ? 2 : 1, 'group');
        const observationState = cleanText(peer.observation && peer.observation.state || '', 20).toUpperCase() || null;
        if (observationState === 'CRITICAL') add('GROUP_PEER_CRITICAL:' + name, 2, 'group');
        else if (observationState === 'DEGRADED') add('GROUP_PEER_DEGRADED:' + name, 1, 'group');
        remote.push({ name, fresh: peer.fresh === true, ageMs, observationState });
      }

      return {
        expected: true,
        desired: desired.slice().sort(),
        online,
        missingOnline,
        remote
      };
    }

    _snapshot() {
      let game = null;
      try { game = this.runtime.game && this.runtime.game.snapshot ? this.runtime.game.snapshot() : null; } catch (_) {}
      const modules = this.runtime.modules && typeof this.runtime.modules.list === 'function' ? this.runtime.modules.list() : [];
      const statuses = {
        combat: this._read(this.runtime.combat),
        farming: this._read(this.runtime.farming),
        farmIntelligence: this._read(this.runtime.farmIntelligence),
        resourceTopoff: this._read(this.runtime.resourceTopoff),
        inventory: this._read(this.runtime.inventory),
        merchant: this._read(this.runtime.merchant),
        bank: this._read(this.runtime.bank),
        trade: this._read(this.runtime.trade),
        gear: this._read(this.runtime.gear),
        upgrade: this._read(this.runtime.upgrade),
        exchangeCraft: this._read(this.runtime.exchangeCraft),
        economy: this._read(this.runtime.economy),
        partyLogistics: this._read(this.runtime.partyLogistics),
        lifecycle: this._read(this.runtime.lifecycle),
        fullAutonomy: this._read(this.runtime.fullAutonomy),
        safeUpdater: this._read(this.runtime.safeUpdater)
      };
      let transport = null;
      try { transport = this.runtime.lifecycleTransport && this.runtime.lifecycleTransport.status ? this.runtime.lifecycleTransport.status() : null; } catch (_) {}
      let roster = null;
      try { roster = this.runtime.roster && this.runtime.roster.status ? this.runtime.roster.status() : null; } catch (_) {}
      return {
        at: new Date(this.now()).toISOString(),
        atMs: this.now(),
        runtime: {
          version: this.runtime.version,
          running: this.runtime.running === true,
          runEpoch: finite(this.runtime.runEpoch, 0),
          bootCount: finite(this.runtime.bootCount, 0),
          emergencyStop: this.runtime.stopLatch && this.runtime.stopLatch.status ? this.runtime.stopLatch.status() : null,
          scheduler: this.runtime.scheduler && this.runtime.scheduler.status ? this.runtime.scheduler.status() : null
        },
        character: game && game.character ? {
          name: game.character.name || null,
          ctype: game.character.ctype || null,
          map: game.character.map || null,
          hp: finite(game.character.hp, null),
          maxHp: finite(game.character.max_hp != null ? game.character.max_hp : game.character.maxHp, null),
          mp: finite(game.character.mp, null),
          maxMp: finite(game.character.max_mp != null ? game.character.max_mp : game.character.maxMp, null),
          rip: game.character.rip === true || game.character.dead === true
        } : null,
        modules,
        statuses,
        lifecycleTransport: transport,
        roster
      };
    }

    _assess(snapshot, timerGapMs) {
      let severity = 0;
      const reasons = [];
      const reasonSet = new Set();
      const subsystemSeverity = new Map();
      const add = (reason, level, subsystem = 'runtime') => {
        const code = cleanText(reason, 220);
        if (!code) return;
        severity = Math.max(severity, level);
        subsystemSeverity.set(subsystem, Math.max(subsystemSeverity.get(subsystem) || 0, level));
        if (!reasonSet.has(code) && reasons.length < 32) {
          reasonSet.add(code);
          reasons.push(code);
        }
      };

      const runtime = snapshot.runtime || {};
      if (runtime.running !== true) add('RUNTIME_NOT_RUNNING', 2, 'runtime');
      if (runtime.scheduler && runtime.scheduler.enabled === false) add('SCHEDULER_NOT_RUNNING', 2, 'runtime');
      if (runtime.emergencyStop && runtime.emergencyStop.latched === true) add('EMERGENCY_STOP_LATCHED', 2, 'runtime');
      if (timerGapMs >= this.config.timerGapCriticalMs) add('DIAGNOSTIC_TIMER_GAP_CRITICAL', 2, 'runtime');
      else if (timerGapMs >= this.config.timerGapWarnMs) add('DIAGNOSTIC_TIMER_GAP_WARN', 1, 'runtime');

      this._moduleSignals(snapshot.modules, add);
      this._suspensionSignals(snapshot.statuses || {}, add);

      const character = snapshot.character;
      if (!character) add('CHARACTER_UNAVAILABLE', 2, 'runtime');
      else if (character.rip) add('CHARACTER_DEAD', 2, 'runtime');

      const full = snapshot.statuses && snapshot.statuses.fullAutonomy;
      if (full && full.enabled === true) {
        const decisionState = cleanText(full.lastDecision && full.lastDecision.state || '', 40).toUpperCase();
        if (decisionState === 'ERROR') add('FULL_AUTONOMY_ERROR', 2, 'runtime');
        else if (decisionState === 'BLOCKED') add('FULL_AUTONOMY_BLOCKED', 1, 'runtime');
      }

      const now = snapshot.atMs;
      const combat = snapshot.statuses && snapshot.statuses.combat || {};
      const farm = snapshot.statuses && snapshot.statuses.farmIntelligence || {};
      const isMerchant = !!(character && String(character.ctype || '').toLowerCase() === 'merchant');
      const farmerExpected = !!(full && full.enabled === true && !isMerchant && farm.active === true && farm.suspended !== true);
      const farmerToken = this._progressToken(combat, ['attacksConfirmed', 'killsObserved']);
      const farmer = this._progressHealth(
        'farmer', farmerExpected, farmerToken, now,
        this.config.farmerWatchMs, this.config.farmerCriticalMs,
        'FARMER_COMBAT_PROGRESS_WATCH', 'FARMER_NO_COMBAT_PROGRESS', add
      );

      const merchant = snapshot.statuses && snapshot.statuses.merchant || {};
      const economy = snapshot.statuses && snapshot.statuses.economy || {};
      const logistics = snapshot.statuses && snapshot.statuses.partyLogistics || {};
      const merchantExpected = !!(full && full.enabled === true && isMerchant && (
        merchant.pending || merchant.delivery || economy.currentAction || logistics.currentAction
        || Array.isArray(logistics.queue) && logistics.queue.length > 0
      ));
      const merchantToken = this._progressToken(merchant, ['transfersConfirmed', 'mluckConfirmed'])
        + Math.max(0, finite(economy.actionsThisSession, 0))
        + Math.max(0, finite(logistics.actionsThisSession, 0));
      const merchantProgress = this._progressHealth(
        'merchant', merchantExpected, merchantToken, now,
        this.config.merchantWatchMs, this.config.merchantCriticalMs,
        'MERCHANT_SERVICE_PROGRESS_WATCH', 'MERCHANT_NO_SERVICE_PROGRESS', add
      );

      const group = this._groupHealth(
        full,
        snapshot.lifecycleTransport,
        snapshot.roster,
        character && character.name,
        add
      );

      const subsystemState = name => {
        const level = subsystemSeverity.get(name) || 0;
        return level >= 2 ? 'CRITICAL' : level === 1 ? 'DEGRADED' : 'HEALTHY';
      };
      const state = severity >= 2 ? 'CRITICAL' : severity === 1 ? 'DEGRADED' : 'HEALTHY';
      return {
        schemaVersion: 1,
        at: new Date(now).toISOString(),
        atMs: now,
        state,
        verdict: state === 'CRITICAL' ? 'FAIL' : state === 'DEGRADED' ? 'WARN' : 'PASS',
        reasons,
        subsystems: {
          runtime: { state: subsystemState('runtime'), timerGapMs },
          farmer: { state: subsystemState('farmer'), ...farmer },
          merchant: { state: subsystemState('merchant'), ...merchantProgress },
          group: { state: subsystemState('group'), ...group }
        },
        classificationOnly: true,
        actionAuthority: false,
        gameplayActionAuthority: false,
        codeRepairAuthority: false
      };
    }

    _runId() {
      return [
        'h22',
        cleanText(this.runtime && this.runtime.version || 'unknown', 80) || 'unknown',
        String(Math.max(0, finite(this.runtime && this.runtime.bootCount, 0))),
        String(Math.max(0, finite(this.runtime && this.runtime.runEpoch, 0))),
        cleanText(this.runtime && this.runtime.loadedAt || '', 80) || 'unloaded'
      ].join(':');
    }

    _makeHostBeacon(snapshot, assessment, now) {
      const leaseMs = this.config.hostBeaconLeaseMs;
      const character = snapshot && snapshot.character || null;
      const openIncident = this.openIncident ? {
        id: this.openIncident.id,
        detectedAt: this.openIncident.detectedAt,
        state: this.openIncident.state,
        verdict: this.openIncident.verdict
      } : null;
      const last = this.incidents.length ? this.incidents[this.incidents.length - 1] : null;
      return {
        schemaVersion: 1,
        type: 'ALBOT_H22_HOST_WATCHDOG_BEACON',
        runId: this._runId(),
        seq: ++this.hostBeaconSeq,
        at: now,
        leaseMs,
        deadlineAt: now + leaseMs,
        release: cleanText(this.runtime && this.runtime.version || '', 80) || null,
        character: character ? {
          name: cleanText(character.name || '', 120) || null,
          ctype: cleanText(character.ctype || '', 40).toLowerCase() || null,
          map: cleanText(character.map || '', 120) || null,
          rip: character.rip === true
        } : { name: null, ctype: null, map: null, rip: false },
        runtime: {
          running: this.runtime && this.runtime.running === true,
          bootCount: Math.max(0, finite(this.runtime && this.runtime.bootCount, 0)),
          runEpoch: Math.max(0, finite(this.runtime && this.runtime.runEpoch, 0)),
          loadedAt: cleanText(this.runtime && this.runtime.loadedAt || '', 80) || null,
          observerTickAtMs: now
        },
        health: {
          state: assessment && assessment.state || 'CRITICAL',
          verdict: assessment && assessment.verdict || 'FAIL',
          reasons: clone((assessment && assessment.reasons || []).slice(0, 8)),
          observedAt: assessment && assessment.at || new Date(now).toISOString(),
          observedAtMs: assessment && assessment.atMs || now
        },
        incidents: {
          open: openIncident,
          count: this.incidents.length,
          lastFinalized: last ? {
            id: last.id,
            detectedAt: last.detectedAt,
            finalizedAt: last.finalizedAt,
            state: last.state,
            verdict: last.verdict
          } : null
        },
        contract: {
          externalDeadManRequired: true,
          hostOwnsRestart: true,
          authenticationOwnedByHost: true,
          actionAuthority: false,
          gameplayActionAuthority: false
        }
      };
    }

    hostBeacon() {
      return clone(this.lastHostBeacon);
    }

    _incidentFingerprint(assessment) {
      return (assessment && assessment.reasons || []).slice().sort().join('|') || String(assessment && assessment.state || 'UNKNOWN');
    }

    _openIncident(assessment, snapshot) {
      const now = this.now();
      const fingerprint = this._incidentFingerprint(assessment);
      if (this.lastIncidentFingerprint === fingerprint
          && this.lastIncidentAtMs != null
          && now - this.lastIncidentAtMs < this.config.incidentDedupeMs) {
        this.stats.incidentsDeduped += 1;
        return null;
      }
      const incident = {
        schemaVersion: 1,
        id: 'h22-incident-' + String(now) + '-' + String(this.sequence + 1),
        detectedAt: new Date(now).toISOString(),
        detectedAtMs: now,
        postUntilMs: now + this.config.incidentPostMs,
        state: assessment.state,
        verdict: assessment.verdict,
        fingerprint,
        reasons: clone(assessment.reasons),
        assessment: sanitize(assessment),
        snapshot: sanitize(snapshot),
        finalizedAt: null,
        finalizedAtMs: null,
        finalizeReason: null,
        events: []
      };
      this.openIncident = incident;
      this.lastIncidentFingerprint = fingerprint;
      this.lastIncidentAtMs = now;
      this.stats.incidentsOpened += 1;
      this._record('INCIDENT_OPENED', 'ERROR', 'observer', fingerprint, { incidentId: incident.id, reasons: incident.reasons });
      return clone(incident);
    }

    _finalizeIncident(now = this.now(), reason = 'POST_WINDOW_COMPLETE') {
      if (!this.openIncident) return null;
      const incident = this.openIncident;
      const start = incident.detectedAtMs - this.config.incidentPreMs;
      const end = Math.max(incident.detectedAtMs, Math.min(now, incident.postUntilMs));
      incident.events = this.events.between(start, end, this.config.eventLimit);
      incident.finalizedAtMs = now;
      incident.finalizedAt = new Date(now).toISOString();
      incident.finalizeReason = cleanText(reason, 120);
      delete incident.postUntilMs;
      this.incidents.push(sanitize(incident));
      while (this.incidents.length > this.config.incidentLimit) this.incidents.shift();
      this.openIncident = null;
      this.stats.incidentsFinalized += 1;
      return clone(incident);
    }

    tick() {
      if (!this.moduleActive) return this.lastAssessment;
      const now = this.now();
      const timerGapMs = this.lastTickAtMs == null ? 0 : Math.max(0, now - this.lastTickAtMs);
      this.lastTickAtMs = now;
      this.stats.ticks += 1;
      if (timerGapMs >= this.config.timerGapWarnMs) {
        this.stats.timerGaps += 1;
        this._record('DIAGNOSTIC_TIMER_GAP', timerGapMs >= this.config.timerGapCriticalMs ? 'ERROR' : 'WARN', 'observer', 'TIMER_GAP', { timerGapMs });
      }

      const snapshot = this._snapshot();
      const assessment = this._assess(snapshot, timerGapMs);
      const previousState = this.lastAssessment && this.lastAssessment.state || null;
      this.lastSnapshot = sanitize(snapshot);
      this.lastAssessment = assessment;

      if (assessment.subsystems.farmer && assessment.subsystems.farmer.state === 'DEGRADED') this.stats.farmerWatches += 1;
      if (assessment.subsystems.farmer && assessment.subsystems.farmer.state === 'CRITICAL') this.stats.farmerCritical += 1;
      if (assessment.subsystems.merchant && assessment.subsystems.merchant.state === 'DEGRADED') this.stats.merchantWatches += 1;
      if (assessment.subsystems.merchant && assessment.subsystems.merchant.state === 'CRITICAL') this.stats.merchantCritical += 1;
      if (assessment.subsystems.group && assessment.subsystems.group.state === 'DEGRADED') this.stats.groupWatches += 1;
      if (assessment.subsystems.group && assessment.subsystems.group.state === 'CRITICAL') this.stats.groupCritical += 1;

      if (previousState !== assessment.state) {
        this.stats.stateChanges += 1;
        this._record('HEALTH_STATE_CHANGED', assessment.state === 'CRITICAL' ? 'ERROR' : assessment.state === 'DEGRADED' ? 'WARN' : 'INFO',
          'observer', String(previousState || 'UNKNOWN') + '->' + assessment.state, {
            previousState,
            state: assessment.state,
            verdict: assessment.verdict,
            reasons: assessment.reasons
          });
      }

      if (assessment.state === 'CRITICAL' && !this.openIncident) this._openIncident(assessment, snapshot);
      if (this.openIncident && now >= this.openIncident.postUntilMs) this._finalizeIncident(now);

      this.lastHostBeacon = this._makeHostBeacon(snapshot, assessment, now);

      if (this.heartbeat) {
        try {
          this.heartbeat({
            phase: 'h22-observation',
            state: assessment.state,
            verdict: assessment.verdict,
            seq: this.sequence
          });
        } catch (_) {}
      }

      return clone(assessment);
    }

    summary() {
      const a = this.lastAssessment || this._emptyAssessment();
      return {
        schemaVersion: 1,
        observedAt: a.at,
        observedAtMs: a.atMs,
        state: a.state,
        verdict: a.verdict,
        reasons: clone((a.reasons || []).slice(0, 8)),
        seq: this.sequence,
        classificationOnly: true,
        actionAuthority: false
      };
    }

    listEvents(limit = 100) {
      return this.events.list(limit);
    }

    listIncidents(limit = this.config.incidentLimit) {
      const n = Math.max(0, Math.min(this.incidents.length, Math.floor(finite(limit, this.config.incidentLimit))));
      return clone(this.incidents.slice(this.incidents.length - n));
    }

    status() {
      const openIncident = this.openIncident ? {
        id: this.openIncident.id,
        detectedAt: this.openIncident.detectedAt,
        state: this.openIncident.state,
        verdict: this.openIncident.verdict,
        reasons: clone(this.openIncident.reasons),
        postUntilMs: this.openIncident.postUntilMs
      } : null;
      const last = this.incidents.length ? this.incidents[this.incidents.length - 1] : null;
      const lastIncident = last ? {
        id: last.id,
        detectedAt: last.detectedAt,
        finalizedAt: last.finalizedAt,
        state: last.state,
        verdict: last.verdict,
        reasons: clone(last.reasons),
        finalizeReason: last.finalizeReason,
        eventCount: Array.isArray(last.events) ? last.events.length : 0
      } : null;
      return {
        schemaVersion: 1,
        mode: 'h22-local-deterministic-observation',
        moduleActive: this.moduleActive,
        state: this.lastAssessment.state,
        verdict: this.lastAssessment.verdict,
        assessment: clone(this.lastAssessment),
        summary: this.summary(),
        hostBeacon: this.lastHostBeacon ? {
          runId: this.lastHostBeacon.runId,
          seq: this.lastHostBeacon.seq,
          at: this.lastHostBeacon.at,
          deadlineAt: this.lastHostBeacon.deadlineAt,
          leaseMs: this.lastHostBeacon.leaseMs
        } : null,
        recorder: this.events.status(),
        openIncident,
        incidents: this.incidents.length,
        lastIncident,
        lastTickAtMs: this.lastTickAtMs,
        config: clone(this.config),
        stats: clone(this.stats),
        policies: {
          deterministicLocalClassification: true,
          boundedTelemetry: true,
          incidentPreAndPostWindow: true,
          secretRedaction: true,
          externalHostDeadManCompatible: true,
          beaconRefreshOwnedByObserverTick: true,
          actionAuthority: false,
          gameplayActionAuthority: false,
          recoveryAuthority: false,
          codeRepairAuthority: false,
          chatgptRequiredForNormalOperation: false
        }
      };
    }
  }

  ns.BoundedTelemetryRing = BoundedTelemetryRing;
  ns.AutonomousObservationCoordinator = AutonomousObservationCoordinator;
  ns.observationHelpers = { sanitize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
