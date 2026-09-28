(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  class HostTelemetryClient {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.runtime = options.runtime || null;
      this.endpoint = cleanText(options.endpoint || 'http://127.0.0.1:17391/v1/telemetry', 300);
      this.moduleActive = false;
      this.scope = null;
      this.enabled = options.enabled !== false;
      this.queue = [];
      this.lastSuccessAt = null;
      this.lastError = null;
      this.backoffUntilMs = 0;
      this.config = {
        sampleMs: Math.max(1000, Math.min(60000, Number(options.sampleMs) || 5000)),
        flushMs: Math.max(1000, Math.min(60000, Number(options.flushMs) || 5000)),
        maxQueue: Math.max(20, Math.min(1000, Number(options.maxQueue) || 240))
      };
      this.metrics = { samples: 0, batchesSent: 0, recordsSent: 0, failures: 0, dropped: 0 };
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('telemetry-sample', () => this.sample(), this.config.sampleMs, { immediate: true });
        this.scope.interval('telemetry-flush', () => this.flush(), this.config.flushMs, { immediate: false });
      }
      return this.status();
    }

    stop() {
      this.moduleActive = false;
      this.scope = null;
      return this.status();
    }

    configure(options = {}) {
      if (options.enabled != null) this.enabled = options.enabled === true;
      if (options.endpoint != null) this.endpoint = cleanText(options.endpoint, 300);
      return this.status();
    }

    _read(name) {
      try {
        const controller = this.runtime && this.runtime[name];
        return controller && typeof controller.status === 'function' ? controller.status() : null;
      } catch (_) { return null; }
    }

    sample() {
      if (!this.moduleActive || !this.enabled || !this.runtime) return null;
      let game = null;
      try { game = this.runtime.game.snapshot(); } catch (_) {}
      const character = game && game.character || null;
      const full = this._read('fullAutonomy');
      const encounter = this._read('encounters');
      const combat = this._read('combat');
      const farming = this._read('farmIntelligence');
      const economy = this._read('economy');
      const observer = this._read('observer');
      const scheduler = this.runtime.scheduler && this.runtime.scheduler.status ? this.runtime.scheduler.status() : null;
      const row = {
        schemaVersion: 1,
        at: new Date().toISOString(),
        atMs: Date.now(),
        runtime: {
          version: this.runtime.version,
          runEpoch: this.runtime.runEpoch,
          running: this.runtime.running === true
        },
        character: character ? {
          name: character.name || null,
          ctype: character.ctype || null,
          level: character.level || null,
          map: character.map || null,
          x: character.x == null ? null : Number(character.x),
          y: character.y == null ? null : Number(character.y),
          hp: character.hp == null ? null : Number(character.hp),
          maxHp: character.maxHp == null ? null : Number(character.maxHp),
          mp: character.mp == null ? null : Number(character.mp),
          maxMp: character.maxMp == null ? null : Number(character.maxMp),
          gold: character.gold == null ? null : Number(character.gold),
          rip: character.rip === true
        } : null,
        fullAutonomy: full ? {
          enabled: full.enabled === true,
          taskType: full.lastDecision && full.lastDecision.taskType || full.config && full.config.taskType || null,
          state: full.lastDecision && full.lastDecision.state || null,
          reason: full.lastDecision && full.lastDecision.reason || null
        } : null,
        encounter: encounter ? {
          autonomyEnabled: encounter.autonomyEnabled === true,
          selected: encounter.lastPlan && encounter.lastPlan.selected && encounter.lastPlan.selected.id || null,
          taskType: encounter.lastPlan && encounter.lastPlan.taskType || null,
          phase: encounter.lastPlan && encounter.lastPlan.phase || null,
          state: encounter.lastPlan && encounter.lastPlan.state || null
        } : null,
        combat: combat ? {
          active: combat.active === true,
          state: combat.session && combat.session.state || null,
          targetType: combat.session && combat.session.targetType || null,
          attacksConfirmed: combat.metrics && combat.metrics.attacksConfirmed || 0,
          attackUnknown: combat.metrics && combat.metrics.attackUnknown || 0
        } : null,
        farming: farming ? {
          active: farming.active === true,
          selection: farming.currentSelection && farming.currentSelection.mtype || null,
          score: farming.currentSelection && farming.currentSelection.score || null
        } : null,
        economy: economy ? {
          autonomyEnabled: economy.autonomyEnabled === true,
          currentAction: economy.currentAction && economy.currentAction.kind || null,
          confirmed: economy.metrics && economy.metrics.actionsConfirmed || 0,
          unknown: economy.metrics && economy.metrics.actionsUnknown || 0
        } : null,
        health: observer && observer.summary ? clone(observer.summary) : null,
        scheduler: scheduler ? { enabled: scheduler.enabled === true, totalResources: scheduler.totalResources } : null
      };
      this.queue.push(row);
      this.metrics.samples += 1;
      while (this.queue.length > this.config.maxQueue) {
        this.queue.shift();
        this.metrics.dropped += 1;
      }
      return clone(row);
    }

    async flush() {
      if (!this.moduleActive || !this.enabled || !this.queue.length) return { accepted: false, reason: 'TELEMETRY_NOTHING_TO_FLUSH' };
      if (Date.now() < this.backoffUntilMs) return { accepted: false, reason: 'TELEMETRY_BACKOFF' };
      const fetchFn = this.root && typeof this.root.fetch === 'function' ? this.root.fetch.bind(this.root) : null;
      if (!fetchFn) return { accepted: false, reason: 'TELEMETRY_FETCH_UNAVAILABLE' };
      const batch = this.queue.slice(0, 40);
      try {
        const response = await fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ schemaVersion: 1, records: batch }),
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response || response.ok !== true) throw new Error('TELEMETRY_HTTP_' + String(response && response.status || 'FAILED'));
        this.queue.splice(0, batch.length);
        this.metrics.batchesSent += 1;
        this.metrics.recordsSent += batch.length;
        this.lastSuccessAt = new Date().toISOString();
        this.lastError = null;
        this.backoffUntilMs = 0;
        return { accepted: true, sent: batch.length };
      } catch (error) {
        this.metrics.failures += 1;
        this.lastError = { at: new Date().toISOString(), reason: cleanText(error && error.message || error, 240) };
        this.backoffUntilMs = Date.now() + 60000;
        return { accepted: false, reason: this.lastError.reason };
      }
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        enabled: this.enabled,
        endpoint: this.endpoint,
        queueLength: this.queue.length,
        lastSuccessAt: this.lastSuccessAt,
        lastError: clone(this.lastError),
        backoffUntilMs: this.backoffUntilMs,
        metrics: clone(this.metrics),
        hostStorageContract: {
          defaultRoot: 'D:/ALBot/telemetry',
          shortTerm: 'raw NDJSON',
          longTerm: 'daily JSON summaries'
        }
      };
    }
  }

  ns.HostTelemetryClient = HostTelemetryClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
