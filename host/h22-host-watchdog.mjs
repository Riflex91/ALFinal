export const HOST_RESTART_ACK = 'ALBOT_H22_HOST_RESTART';
export const HOST_WATCHDOG_SCHEMA_VERSION = 1;
export const HOST_BEACON_TYPE = 'ALBOT_H22_HOST_WATCHDOG_BEACON';

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bounded(value, max = 240) {
  const text = String(value == null ? '' : value).trim().slice(0, max);
  return text || null;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max, fallback) {
  const n = finite(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function normalizeNames(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => bounded(value, 120))
    .filter(Boolean))].sort();
}

export class H22HostWatchdogSupervisor {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.restartProcess = typeof options.restartProcess === 'function' ? options.restartProcess : null;
    this.expectedCharacters = normalizeNames(options.expectedCharacters);
    this.startupGraceMs = clamp(options.startupGraceMs, 5000, 10 * 60 * 1000, 60000);
    this.restartDelayMs = clamp(options.restartDelayMs, 1000, 10 * 60 * 1000, 10000);
    this.restartCooldownMs = clamp(options.restartCooldownMs, 5000, 60 * 60 * 1000, 60000);
    this.restartWindowMs = clamp(options.restartWindowMs, 60000, 24 * 60 * 60 * 1000, 30 * 60 * 1000);
    this.maxRestartsPerWindow = Math.max(1, Math.min(10, Math.floor(finite(options.maxRestartsPerWindow, 3))));
    this.maxClockSkewMs = clamp(options.maxClockSkewMs, 1000, 10 * 60 * 1000, 120000);
    this.historyCapacity = Math.max(20, Math.min(1000, Math.floor(finite(options.historyCapacity, 200))));

    this.restartEnabled = false;
    this.startedAt = this.now();
    this.records = new Map();
    this.restartAttempts = new Map();
    this.lastRestartAttemptAt = new Map();
    this.history = [];
    this.state = 'STARTING';
    this.reason = 'AWAITING_BEACONS';
    this.stats = {
      acceptedBeacons: 0,
      rejectedBeacons: 0,
      replayedBeacons: 0,
      restartAttempts: 0,
      restartSuccesses: 0,
      restartFailures: 0,
      restartBudgetBlocks: 0,
      cooldownBlocks: 0
    };
  }

  _record(type, data = {}) {
    const row = { at: this.now(), type, ...clone(data) };
    this.history.push(row);
    if (this.history.length > this.historyCapacity) {
      this.history.splice(0, this.history.length - this.historyCapacity);
    }
    return row;
  }

  configure(config = {}) {
    if (config.expectedCharacters != null) {
      this.expectedCharacters = normalizeNames(config.expectedCharacters);
    }
    if (config.enabled === true) {
      if (config.ack !== HOST_RESTART_ACK) {
        this.restartEnabled = false;
        this._record('RESTART_ENABLE_REJECTED', { reason: 'ACK_REQUIRED' });
        return { enabled: false, accepted: false, reason: 'ACK_REQUIRED', requiredAck: HOST_RESTART_ACK };
      }
      this.restartEnabled = true;
      this._record('RESTART_ENABLED', { reason: bounded(config.reason || 'OPERATOR_ACK', 180) });
      return {
        enabled: true,
        accepted: true,
        restartAuthority: 'process-only',
        gameplayActionAuthority: false
      };
    }
    this.restartEnabled = false;
    this._record('RESTART_DISABLED', { reason: bounded(config.reason || 'DISABLED', 180) });
    return {
      enabled: false,
      accepted: true,
      restartAuthority: 'none',
      gameplayActionAuthority: false
    };
  }

  _validateBeacon(beacon) {
    if (!beacon || typeof beacon !== 'object') return 'BEACON_REQUIRED';
    if (beacon.schemaVersion !== HOST_WATCHDOG_SCHEMA_VERSION || beacon.type !== HOST_BEACON_TYPE) {
      return 'BEACON_SCHEMA_INVALID';
    }
    const contract = beacon.contract;
    if (!contract || contract.externalDeadManRequired !== true || contract.hostOwnsRestart !== true) {
      return 'BEACON_CONTRACT_INVALID';
    }
    if (contract.authenticationOwnedByHost !== true
        || contract.actionAuthority !== false
        || contract.gameplayActionAuthority !== false) {
      return 'BEACON_AUTHORITY_INVALID';
    }
    const character = bounded(beacon.character && beacon.character.name, 120);
    const runId = bounded(beacon.runId, 240);
    const seq = finite(beacon.seq);
    const at = finite(beacon.at);
    const deadlineAt = finite(beacon.deadlineAt);
    const leaseMs = finite(beacon.leaseMs);
    if (!character) return 'BEACON_CHARACTER_REQUIRED';
    if (!runId) return 'BEACON_RUN_ID_REQUIRED';
    if (seq == null || seq < 1 || Math.floor(seq) !== seq) return 'BEACON_SEQUENCE_INVALID';
    if (at == null || deadlineAt == null || leaseMs == null) return 'BEACON_TIME_INVALID';
    if (leaseMs < 3000 || leaseMs > 5 * 60 * 1000) return 'BEACON_LEASE_INVALID';
    if (deadlineAt !== at + leaseMs) return 'BEACON_DEADLINE_INVALID';
    if (at > this.now() + this.maxClockSkewMs) return 'BEACON_CLOCK_AHEAD';
    if (this.expectedCharacters.length && !this.expectedCharacters.includes(character)) {
      return 'BEACON_CHARACTER_NOT_EXPECTED';
    }
    return null;
  }

  acceptBeacon(beacon) {
    const invalid = this._validateBeacon(beacon);
    if (invalid) {
      this.stats.rejectedBeacons += 1;
      this._record('BEACON_REJECTED', { reason: invalid, character: bounded(beacon && beacon.character && beacon.character.name, 120) });
      return { accepted: false, reason: invalid };
    }

    const character = String(beacon.character.name);
    const runId = String(beacon.runId);
    const seq = Number(beacon.seq);
    const previous = this.records.get(character) || null;
    if (previous && previous.runId === runId && seq <= previous.seq) {
      this.stats.rejectedBeacons += 1;
      this.stats.replayedBeacons += 1;
      this._record('BEACON_REJECTED', { reason: 'BEACON_REPLAY', character, runId, seq, lastSeq: previous.seq });
      return { accepted: false, reason: 'BEACON_REPLAY' };
    }

    const newRun = !!previous && previous.runId !== runId;
    this.records.set(character, {
      character,
      runId,
      seq,
      acceptedAt: this.now(),
      beacon: clone(beacon)
    });
    this.stats.acceptedBeacons += 1;
    this._record('BEACON_ACCEPTED', {
      character,
      runId,
      seq,
      newRun,
      deadlineAt: beacon.deadlineAt,
      healthState: bounded(beacon.health && beacon.health.state, 40)
    });
    return { accepted: true, character, runId, seq, newRun, deadlineAt: beacon.deadlineAt };
  }

  _names() {
    if (this.expectedCharacters.length) return this.expectedCharacters.slice();
    return [...this.records.keys()].sort();
  }

  _deadmanFor(name, now = this.now()) {
    const record = this.records.get(name);
    if (!record) {
      const incidentAt = this.startedAt + this.startupGraceMs;
      if (now <= incidentAt) {
        return { character: name, dead: false, state: 'STARTING', reason: 'AWAITING_FIRST_BEACON', deadlineAt: incidentAt };
      }
      return { character: name, dead: true, reason: 'NO_BEACON_AFTER_STARTUP_GRACE', incidentAt, overdueMs: now - incidentAt };
    }

    const deadlineAt = Number(record.beacon.deadlineAt);
    if (now <= deadlineAt) {
      return {
        character: name,
        dead: false,
        state: 'HEALTHY',
        reason: 'BEACON_FRESH',
        deadlineAt,
        runId: record.runId,
        seq: record.seq
      };
    }
    return {
      character: name,
      dead: true,
      reason: 'BEACON_DEADLINE_MISSED',
      incidentAt: deadlineAt,
      deadlineAt,
      overdueMs: now - deadlineAt,
      runId: record.runId,
      seq: record.seq
    };
  }

  _pruneRestartWindow(name, now = this.now()) {
    const rows = this.restartAttempts.get(name) || [];
    const cutoff = now - this.restartWindowMs;
    while (rows.length && rows[0] <= cutoff) rows.shift();
    this.restartAttempts.set(name, rows);
    return rows;
  }

  _restartGate(deadman, now) {
    const name = deadman.character;
    const deadForMs = Math.max(0, now - Number(deadman.incidentAt || now));
    if (deadForMs < this.restartDelayMs) {
      return { ready: false, state: 'WATCH', reason: deadman.reason, deadForMs };
    }
    if (!this.restartEnabled) {
      return { ready: false, state: 'RESTART_REQUIRED', reason: 'RESTART_AUTHORITY_DISABLED', deadForMs };
    }
    if (!this.restartProcess) {
      return { ready: false, state: 'RESTART_REQUIRED', reason: 'RESTART_CALLBACK_UNAVAILABLE', deadForMs };
    }
    const last = this.lastRestartAttemptAt.get(name);
    if (last != null && now - last < this.restartCooldownMs) {
      this.stats.cooldownBlocks += 1;
      return { ready: false, state: 'RESTART_COOLDOWN', reason: 'RESTART_COOLDOWN', deadForMs };
    }
    const attempts = this._pruneRestartWindow(name, now);
    if (attempts.length >= this.maxRestartsPerWindow) {
      this.stats.restartBudgetBlocks += 1;
      return { ready: false, state: 'CIRCUIT_OPEN', reason: 'RESTART_BUDGET_EXHAUSTED', deadForMs };
    }
    return { ready: true, state: 'RESTART_READY', reason: deadman.reason, deadForMs };
  }

  async tick() {
    const now = this.now();
    const names = this._names();
    if (!names.length) {
      const noConfiguredTargets = this.expectedCharacters.length === 0;
      this.state = noConfiguredTargets ? 'STARTING' : 'WATCH';
      this.reason = noConfiguredTargets ? 'NO_EXPECTED_CHARACTERS' : 'AWAITING_BEACONS';
      return this.status();
    }

    const deadmen = names.map(name => this._deadmanFor(name, now));
    const dead = deadmen.filter(row => row.dead)
      .sort((a, b) => Number(a.incidentAt || 0) - Number(b.incidentAt || 0) || a.character.localeCompare(b.character));

    if (!dead.length) {
      const starting = deadmen.some(row => row.state === 'STARTING');
      this.state = starting ? 'STARTING' : 'HEALTHY';
      this.reason = starting ? 'AWAITING_BEACONS' : 'ALL_BEACONS_FRESH';
      return this.status();
    }

    const gates = dead.map(row => ({ deadman: row, gate: this._restartGate(row, now) }));
    const candidate = gates.find(row => row.gate.ready);
    if (!candidate) {
      const severityRank = { CIRCUIT_OPEN: 5, RESTART_REQUIRED: 4, RESTART_COOLDOWN: 3, WATCH: 2 };
      gates.sort((a, b) => (severityRank[b.gate.state] || 0) - (severityRank[a.gate.state] || 0)
        || a.deadman.character.localeCompare(b.deadman.character));
      this.state = gates[0].gate.state;
      this.reason = gates[0].gate.reason;
      return this.status();
    }

    const name = candidate.deadman.character;
    const attempts = this._pruneRestartWindow(name, now);
    attempts.push(now);
    this.restartAttempts.set(name, attempts);
    this.lastRestartAttemptAt.set(name, now);
    this.stats.restartAttempts += 1;

    const record = this.records.get(name) || null;
    const context = {
      character: name,
      reason: candidate.deadman.reason,
      deadForMs: candidate.gate.deadForMs,
      runId: record && record.runId || null,
      lastSeq: record && record.seq || null,
      lastBeacon: clone(record && record.beacon || null),
      restartAuthority: 'process-only',
      gameplayActionAuthority: false
    };
    this._record('RESTART_ATTEMPTED', context);

    try {
      const result = await this.restartProcess(clone(context));
      if (result === false || result && result.ok === false) throw new Error('restart callback reported failure');
      this.stats.restartSuccesses += 1;
      this._record('RESTART_SUCCEEDED', { character: name, runId: context.runId });
      this.records.delete(name);
      this.state = 'RESTARTING';
      this.reason = 'PROCESS_RESTART_REQUESTED';
    } catch (error) {
      this.stats.restartFailures += 1;
      this._record('RESTART_FAILED', { character: name, reason: bounded(error && error.message || error, 256) });
      this.state = 'RESTART_FAILED';
      this.reason = 'PROCESS_RESTART_FAILED';
    }
    return this.status();
  }

  status() {
    const now = this.now();
    const names = this._names();
    const characters = names.map(name => {
      const deadman = this._deadmanFor(name, now);
      const record = this.records.get(name) || null;
      const attempts = this._pruneRestartWindow(name, now);
      return {
        name,
        deadman,
        lastRunId: record && record.runId || null,
        lastSeq: record && record.seq || null,
        lastBeaconAt: record && record.beacon && record.beacon.at || null,
        lastDeadlineAt: record && record.beacon && record.beacon.deadlineAt || null,
        health: record && record.beacon && record.beacon.health ? clone(record.beacon.health) : null,
        restartBudget: {
          used: attempts.length,
          max: this.maxRestartsPerWindow,
          windowMs: this.restartWindowMs,
          cooldownMs: this.restartCooldownMs
        }
      };
    });

    return {
      schemaVersion: HOST_WATCHDOG_SCHEMA_VERSION,
      mode: 'h22-external-multi-character-deadman',
      state: this.state,
      reason: this.reason,
      restartEnabled: this.restartEnabled,
      restartAuthority: this.restartEnabled ? 'process-only' : 'none',
      gameplayActionAuthority: false,
      rawGameplayActionAuthority: false,
      externalProcessBoundary: true,
      expectedCharacters: this.expectedCharacters.slice(),
      characters,
      policies: {
        beaconReplayRejected: true,
        oneRestartPerTick: true,
        restartCooldown: true,
        boundedRestartBudget: true,
        gameplayActionAuthority: false,
        codeRepairAuthority: false,
        chatgptRequiredForNormalOperation: false
      },
      stats: clone(this.stats)
    };
  }

  listHistory(limit = 50) {
    const n = Math.max(0, Math.min(this.history.length, Math.floor(finite(limit, 50))));
    return clone(this.history.slice(this.history.length - n));
  }
}
