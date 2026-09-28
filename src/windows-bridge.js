(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__ = root.__ALBOT_INTERNALS__ || {};
  const clone = value => {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  };
  const cleanText = (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max);

  const PRODUCT = 'AL Bot';
  const GENERATION = 6;
  const PROTOCOL = 'albot-v6-bridge-v1';
  const SNAPSHOT_TYPE = 'ALBOT_V6_DEBUG_SNAPSHOT';
  const EVENTS_TYPE = 'ALBOT_V6_DEBUG_EVENTS';
  const ACK_TYPE = 'ALBOT_V6_TELEMETRY_ACK';

  class WindowsBridgeTransportAdapter {
    constructor(options = {}) {
      this.runtime = options.runtime || null;
      this.root = options.root || root;
      this.logger = options.logger || this.runtime && this.runtime.logger || null;
      this.bus = options.bus || this.runtime && this.runtime.bus || null;
      this.limit = Math.max(100, Math.min(2000, Number(options.limit) || 1000));
      this.rows = [];
      this.lastCapturedSeq = 0;
      this.lastAcknowledgedSeq = 0;
      this.dropped = 0;
      this.createdAt = new Date().toISOString();
      this._unsubscribe = null;

      if (this.logger && typeof this.logger.list === 'function') {
        const historical = this.logger.list(Math.min(this.limit, 400));
        for (const row of Array.isArray(historical) ? historical : []) this._captureLog(row, 'HISTORY');
      }
      if (this.bus && typeof this.bus.on === 'function') {
        this._unsubscribe = this.bus.on('log', row => this._captureLog(row, 'LIVE'));
      }
    }

    identity() {
      return {
        product: PRODUCT,
        generation: GENERATION,
        bridgeProtocol: PROTOCOL,
        runtimeVersion: this.runtime && this.runtime.version || null,
        transportOnly: true,
        gameplayActionAuthority: false,
        acceptsLegacyGenerations: false
      };
    }

    _captureLog(row, source) {
      if (!row || typeof row !== 'object') return null;
      const seq = ++this.lastCapturedSeq;
      const level = cleanText(row.level || 'INFO', 20).toUpperCase();
      const event = {
        seq,
        at: row.at || new Date().toISOString(),
        severity: level === 'ERROR' ? 'error' : level === 'WARN' ? 'warning' : 'info',
        component: 'runtime',
        event: 'log',
        reason: cleanText(row.message || 'runtime-log', 500),
        data: clone(row.data),
        source
      };
      this.rows.push(event);
      if (this.rows.length > this.limit) {
        const remove = this.rows.length - this.limit;
        this.rows.splice(0, remove);
        this.dropped += remove;
      }
      return clone(event);
    }

    telemetryStatus() {
      return {
        schemaVersion: 1,
        protocol: PROTOCOL,
        queued: this.rows.length,
        limit: this.limit,
        lastCapturedSeq: this.lastCapturedSeq,
        lastAcknowledgedSeq: this.lastAcknowledgedSeq,
        dropped: this.dropped
      };
    }

    peekTelemetry(limit = 2000) {
      const bounded = Math.max(1, Math.min(2000, Number(limit) || 2000));
      return clone(this.rows.slice(0, bounded));
    }

    ackThrough(maxSeq) {
      const bounded = Math.max(0, Math.floor(Number(maxSeq) || 0));
      const before = this.rows.length;
      if (bounded > 0) {
        this.rows = this.rows.filter(row => Number(row && row.seq) > bounded);
        this.lastAcknowledgedSeq = Math.max(this.lastAcknowledgedSeq, Math.min(bounded, this.lastCapturedSeq));
      }
      return {
        schemaVersion: 1,
        type: ACK_TYPE,
        supported: true,
        acknowledged: Math.max(0, before - this.rows.length),
        remaining: this.rows.length,
        lastAcknowledgedSeq: this.lastAcknowledgedSeq,
        lastCapturedSeq: this.lastCapturedSeq,
        dropped: this.dropped
      };
    }

    snapshot(options = {}) {
      const deep = options && options.deep === true;
      let status = null;
      let diagnostics = null;
      let character = null;
      let heartbeat = null;
      try { status = this.runtime && typeof this.runtime.status === 'function' ? this.runtime.status() : null; } catch (_) {}
      try {
        const game = this.runtime && this.runtime.game && typeof this.runtime.game.snapshot === 'function'
          ? this.runtime.game.snapshot()
          : null;
        character = game && game.character ? clone(game.character) : null;
      } catch (_) {}
      try {
        heartbeat = this.runtime && this.runtime.observer && typeof this.runtime.observer.hostBeacon === 'function'
          ? this.runtime.observer.hostBeacon()
          : null;
      } catch (_) {}
      if (deep) {
        try { diagnostics = this.runtime && typeof this.runtime.diagnostics === 'function' ? this.runtime.diagnostics() : null; } catch (_) {}
      }
      return {
        schemaVersion: 1,
        type: SNAPSHOT_TYPE,
        identity: this.identity(),
        observedAt: new Date().toISOString(),
        character,
        heartbeat: clone(heartbeat),
        status: clone(status),
        diagnostics: deep ? clone(diagnostics) : null,
        telemetry: this.telemetryStatus()
      };
    }

    events(afterSeq = 0, limit = 100) {
      const requestedAfterSeq = Math.max(0, Math.floor(Number(afterSeq) || 0));
      const boundedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
      const lastCapturedSeq = this.lastCapturedSeq;
      const oldestSeq = this.rows.length ? Math.max(0, Number(this.rows[0].seq) || 0) : lastCapturedSeq;
      const effectiveAfterSeq = lastCapturedSeq > 0 && requestedAfterSeq > lastCapturedSeq
        ? 0
        : requestedAfterSeq;
      const candidates = this.rows.filter(row => Number(row && row.seq) > effectiveAfterSeq);
      const events = candidates.slice(0, boundedLimit);
      return {
        schemaVersion: 1,
        type: EVENTS_TYPE,
        requestedAfterSeq,
        effectiveAfterSeq,
        oldestAvailableSeq: oldestSeq,
        lastCapturedSeq,
        availableAfterSeq: candidates.length,
        hasMore: candidates.length > events.length,
        cursorReset: effectiveAfterSeq !== requestedAfterSeq,
        telemetry: this.telemetryStatus(),
        events: clone(events)
      };
    }

    status() {
      return {
        identity: this.identity(),
        createdAt: this.createdAt,
        readOnlyFromHostPerspective: true,
        telemetry: this.telemetryStatus(),
        policies: {
          noGameplayAuthority: true,
          noGenericRemoteEvaluate: true,
          noEmbeddedCloudSecrets: true,
          legacyV3V4V5TransportRejected: true
        }
      };
    }

    destroy() {
      if (typeof this._unsubscribe === 'function') {
        try { this._unsubscribe(); } catch (_) {}
      }
      this._unsubscribe = null;
    }
  }

  ns.WindowsBridgeTransportAdapter = WindowsBridgeTransportAdapter;
  ns.windowsBridgeTransport = Object.freeze({
    PRODUCT,
    GENERATION,
    PROTOCOL,
    SNAPSHOT_TYPE,
    EVENTS_TYPE,
    ACK_TYPE
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
