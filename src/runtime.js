(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  class ALBotRuntime {
    constructor(options = {}) {
      this.version = options.version || '0.1.0-h1';
      this.root = options.root || root;
      this.startedAt = null;
      this.running = false;
      this.bus = new ns.EventBus();
      this.storage = new ns.StorageAdapter(this.root);
      this.logger = new ns.Logger({ bus: this.bus, limit: 300 });
      this.stopLatch = new ns.EmergencyStop({ storage: this.storage, logger: this.logger, bus: this.bus });
      this.modules = new ns.ModuleRegistry({ logger: this.logger });
      this.goals = new ns.GoalService({ storage: this.storage, logger: this.logger });
      this.knowledge = new ns.KnowledgeService({ logger: this.logger });
      this.roster = new ns.CharacterRosterService({ root: this.root, logger: this.logger });
      this.ui = null;
      this.lastError = null;
      this._installErrorCapture();
      this.logger.info('AL Bot Runtime erstellt', { version: this.version, stopLatched: this.stopLatch.status().latched });
    }

    _installErrorCapture() {
      if (!this.root || typeof this.root.addEventListener !== 'function') return;
      this._errorHandler = (event) => {
        const error = event && event.error;
        this.lastError = {
          at: new Date().toISOString(),
          type: 'error',
          message: String(error && error.message || event && event.message || 'Unknown error'),
          stack: error && error.stack || null
        };
        this.logger.error('Unbehandelter JavaScript-Fehler', this.lastError);
      };
      this._rejectionHandler = (event) => {
        const reason = event && event.reason;
        this.lastError = {
          at: new Date().toISOString(),
          type: 'unhandledrejection',
          message: String(reason && reason.message || reason || 'Unhandled rejection'),
          stack: reason && reason.stack || null
        };
        this.logger.error('Unhandled Promise Rejection', this.lastError);
      };
      this.root.addEventListener('error', this._errorHandler);
      this.root.addEventListener('unhandledrejection', this._rejectionHandler);
    }

    async start() {
      if (this.stopLatch.status().latched) throw new Error('ALBOT_START_BLOCKED_BY_EMERGENCY_STOP');
      if (this.running) return this.status();
      this.roster.refresh();
      await this.modules.startAll({ runtime: this });
      this.running = true;
      this.startedAt = new Date().toISOString();
      this.logger.info('AL Bot gestartet');
      this.bus.emit('runtime', this.status());
      return this.status();
    }

    async stop(reason = 'MANUAL_STOP') {
      await this.modules.stopAll(reason);
      this.running = false;
      this.logger.warn('AL Bot gestoppt', { reason });
      this.bus.emit('runtime', this.status());
      return this.status();
    }

    async emergencyStop(reason = 'MANUAL_EMERGENCY_STOP') {
      const stop = this.stopLatch.latch(reason);
      await this.stop('EMERGENCY_STOP');
      this.bus.emit('emergency-stop', stop);
      return this.status();
    }

    resetEmergencyStop() {
      this.stopLatch.reset();
      return this.status();
    }

    actionAllowed(action = 'action') {
      if (!this.running) return false;
      if (this.stopLatch.status().latched) return false;
      return true;
    }

    assertActionAllowed(action = 'action') {
      if (!this.running) throw new Error('ALBOT_RUNTIME_NOT_RUNNING:' + action);
      return this.stopLatch.assertAllowed(action);
    }

    status() {
      let roster;
      try { roster = this.roster.status(); } catch (_) { roster = null; }
      return {
        product: 'AL Bot',
        version: this.version,
        running: this.running,
        startedAt: this.startedAt,
        emergencyStop: this.stopLatch.status(),
        modules: this.modules.list(),
        knowledge: this.knowledge.status(),
        roster,
        goals: this.goals.list(),
        strategicPriorities: this.goals.getPriorities(),
        lastError: ns.helpers.clone(this.lastError)
      };
    }

    diagnostics() {
      const local = this.root && (this.root.character || this.root.parent && this.root.parent.character) || null;
      return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runtime: this.status(),
        character: local ? {
          name: local.name || null,
          ctype: local.ctype || local.type || null,
          map: local.map || null,
          hp: local.hp ?? null,
          maxHp: local.max_hp ?? null,
          mp: local.mp ?? null,
          maxMp: local.max_mp ?? null,
          gold: local.gold ?? null,
          x: local.x ?? null,
          y: local.y ?? null,
          target: local.target || local.target_id || null
        } : null,
        logs: this.logger.list(120),
        userAgent: this.root && this.root.navigator && this.root.navigator.userAgent || null
      };
    }

    selfTest() {
      const checks = [];
      const push = (name, ok, details) => checks.push({ name, ok: !!ok, details: details || null });
      const roster = this.roster.refresh();
      push('runtime-created', !!this.version, { version: this.version });
      push('emergency-stop-api', typeof this.emergencyStop === 'function' && typeof this.resetEmergencyStop === 'function');
      push('goal-service', Array.isArray(this.goals.list()));
      push('knowledge-service', !!this.knowledge.status());
      push('dynamic-roster-no-hardcoded-names', roster.hardcodedNamesRequired === false, { source: roster.source, farmers: roster.farmers.map(x => ({ name: x.name, ctype: x.ctype })) });
      push('module-registry', Array.isArray(this.modules.list()));
      return { passed: checks.every(c => c.ok), at: new Date().toISOString(), checks };
    }

    destroy() {
      try { if (this.ui && typeof this.ui.destroy === 'function') this.ui.destroy(); } catch (_) {}
      if (this.root && typeof this.root.removeEventListener === 'function') {
        if (this._errorHandler) this.root.removeEventListener('error', this._errorHandler);
        if (this._rejectionHandler) this.root.removeEventListener('unhandledrejection', this._rejectionHandler);
      }
      this.bus.clear();
    }
  }

  ns.ALBotRuntime = ALBotRuntime;
})(typeof globalThis !== 'undefined' ? globalThis : this);
