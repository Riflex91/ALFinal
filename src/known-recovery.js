(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__ = root.__ALBOT_INTERNALS__ || {};
  const clone = ns.helpers && ns.helpers.clone
    ? ns.helpers.clone
    : value => value == null ? value : JSON.parse(JSON.stringify(value));
  const cleanText = ns.helpers && ns.helpers.cleanText
    ? ns.helpers.cleanText
    : (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);

  function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  class KnownRecoveryCoordinator {
    constructor(options = {}) {
      if (!options.runtime) throw new Error('H22_RECOVERY_RUNTIME_REQUIRED');
      this.runtime = options.runtime;
      this.observer = options.observer || this.runtime.observer || null;
      this.logger = options.logger || this.runtime.logger || null;
      this.bus = options.bus || this.runtime.bus || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        enabled: options.enabled !== false,
        tickMs: Math.max(500, Math.min(10000, Math.floor(finite(options.tickMs, 1000)))),
        cooldownMs: Math.max(5000, Math.min(60 * 60 * 1000, Math.floor(finite(options.cooldownMs, 60000)))),
        attemptWindowMs: Math.max(60000, Math.min(24 * 60 * 60 * 1000, Math.floor(finite(options.attemptWindowMs, 30 * 60 * 1000)))),
        maxAttemptsPerWindow: Math.max(1, Math.min(5, Math.floor(finite(options.maxAttemptsPerWindow, 2))))
      };

      this.allowedModules = new Set(['runtime-health']);
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.inFlight = false;
      this.lastAttemptAtMs = null;
      this.attempts = [];
      this.history = [];
      this.lastPlan = null;
      this.lastResult = null;
      this.stats = {
        ticks: 0,
        plans: 0,
        noops: 0,
        blocked: 0,
        attempts: 0,
        successes: 0,
        failures: 0,
        cooldownBlocks: 0,
        budgetBlocks: 0
      };
    }

    configure(options = {}) {
      if (options.enabled != null) this.config.enabled = options.enabled === true;
      if (options.cooldownMs != null) {
        this.config.cooldownMs = Math.max(5000, Math.min(60 * 60 * 1000, Math.floor(finite(options.cooldownMs, this.config.cooldownMs))));
      }
      if (options.attemptWindowMs != null) {
        this.config.attemptWindowMs = Math.max(60000, Math.min(24 * 60 * 60 * 1000, Math.floor(finite(options.attemptWindowMs, this.config.attemptWindowMs))));
      }
      if (options.maxAttemptsPerWindow != null) {
        this.config.maxAttemptsPerWindow = Math.max(1, Math.min(5, Math.floor(finite(options.maxAttemptsPerWindow, this.config.maxAttemptsPerWindow))));
      }
      return clone(this.config);
    }

    start(context = {}) {
      if (this.moduleActive) return this.status();
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (!this.scope || typeof this.scope.interval !== 'function') throw new Error('H22_RECOVERY_SCOPE_REQUIRED');
      this.scope.interval('known-recovery-tick', () => this.tick(), this.config.tickMs, { immediate: false });
      this._event('RECOVERY_STARTED', 'INFO', { enabled: this.config.enabled });
      return this.status();
    }

    stop(reason = 'H22_RECOVERY_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this._event('RECOVERY_STOPPED', 'INFO', { reason: cleanText(reason, 180) });
      return this.status();
    }

    _event(type, severity, data = {}) {
      const row = {
        at: new Date(this.now()).toISOString(),
        atMs: this.now(),
        type: cleanText(type, 100),
        severity: cleanText(severity || 'INFO', 20).toUpperCase(),
        ...clone(data)
      };
      this.history.push(row);
      if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
      if (this.bus && typeof this.bus.emit === 'function') {
        try { this.bus.emit('h22-known-recovery', clone(row)); } catch (_) {}
      }
      return row;
    }

    _read(controller) {
      try {
        return controller && typeof controller.status === 'function' ? controller.status() : null;
      } catch (_) {
        return null;
      }
    }

    _transactionBlockers() {
      const blockers = [];
      const add = (code, condition) => { if (condition) blockers.push(code); };
      const status = name => this._read(this.runtime && this.runtime[name]);

      const stop = this.runtime && this.runtime.stopLatch && typeof this.runtime.stopLatch.status === 'function'
        ? this.runtime.stopLatch.status()
        : null;
      add('EMERGENCY_STOP_LATCHED', stop && stop.latched === true);

      const resourceTopoff = status('resourceTopoff');
      add('RESOURCE_TOPOFF_PENDING', !!(resourceTopoff && resourceTopoff.pending));
      add('RESOURCE_TOPOFF_SUSPENDED', !!(resourceTopoff && resourceTopoff.suspended));

      const lifecycle = status('lifecycle');
      add('LIFECYCLE_CURRENT_ACTION', !!(lifecycle && lifecycle.currentAction));
      add('LIFECYCLE_QUEUE_PENDING', asArray(lifecycle && lifecycle.queue).length > 0);
      add('LIFECYCLE_SUSPENDED', !!(lifecycle && lifecycle.suspended));

      const logistics = status('partyLogistics');
      add('PARTY_LOGISTICS_CURRENT_ACTION', !!(logistics && logistics.currentAction));
      add('PARTY_LOGISTICS_QUEUE_PENDING', asArray(logistics && logistics.queue).length > 0);
      add('PARTY_LOGISTICS_SUSPENDED', !!(logistics && logistics.suspended));

      for (const name of ['bank', 'trade', 'upgrade', 'exchangeCraft', 'inventory', 'merchant', 'gear']) {
        const row = status(name);
        if (!row) continue;
        add(name.toUpperCase() + '_PENDING', !!row.pending);
        add(name.toUpperCase() + '_REQUEST_PENDING', !!row.request);
        add(name.toUpperCase() + '_DELIVERY_PENDING', !!row.delivery);
        add(name.toUpperCase() + '_CURRENT_ACTION', !!row.currentAction);
        add(name.toUpperCase() + '_SUSPENDED', row.suspended === true);
      }

      const economy = status('economy');
      add('ECONOMY_CURRENT_ACTION', !!(economy && economy.currentAction));
      add('ECONOMY_SUSPENDED', !!(economy && economy.suspended));

      const updater = status('safeUpdater');
      add('UPDATE_BUSY', !!(updater && updater.busy));

      let transport = null;
      try {
        transport = this.runtime && this.runtime.lifecycleTransport && typeof this.runtime.lifecycleTransport.status === 'function'
          ? this.runtime.lifecycleTransport.status()
          : null;
      } catch (_) {}
      add('H19_REMOTE_PENDING', asArray(transport && transport.pending).length > 0);
      add('H19_PARTY_RECOVERY_PENDING', !!(transport && transport.partyRecoveryLease));

      return blockers;
    }

    _assessment(input) {
      if (input && typeof input === 'object') return input;
      try {
        const status = this.observer && typeof this.observer.status === 'function' ? this.observer.status() : null;
        return status && status.assessment || null;
      } catch (_) {
        return null;
      }
    }

    _pruneAttempts(now = this.now()) {
      const cutoff = now - this.config.attemptWindowMs;
      while (this.attempts.length && this.attempts[0] <= cutoff) this.attempts.shift();
    }

    plan(input = null) {
      this.stats.plans += 1;
      const assessment = this._assessment(input);
      if (!this.config.enabled) {
        return this.lastPlan = { state: 'BLOCKED', reason: 'KNOWN_RECOVERY_DISABLED', action: null };
      }
      if (!this.moduleActive) {
        return this.lastPlan = { state: 'BLOCKED', reason: 'KNOWN_RECOVERY_MODULE_NOT_ACTIVE', action: null };
      }
      if (!assessment || !Array.isArray(assessment.reasons)) {
        return this.lastPlan = { state: 'BLOCKED', reason: 'KNOWN_RECOVERY_ASSESSMENT_UNAVAILABLE', action: null };
      }

      const reasons = assessment.reasons.map(value => cleanText(value, 220)).filter(Boolean);
      const known = reasons.filter(reason => /^MODULE_(?:STALE|ERROR):runtime-health$/.test(reason));
      const unknown = reasons.filter(reason => !/^MODULE_(?:STALE|ERROR):runtime-health$/.test(reason));

      if (!known.length) {
        return this.lastPlan = {
          state: 'NONE',
          reason: reasons.length ? 'NO_ALLOWLISTED_RECOVERY' : 'HEALTHY_NO_RECOVERY',
          action: null,
          assessmentState: assessment.state || null,
          reasons
        };
      }
      if (unknown.length) {
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'ADDITIONAL_HEALTH_REASONS_PRESENT',
          action: null,
          reasons,
          blockers: unknown
        };
      }

      const blockers = this._transactionBlockers();
      if (blockers.length) {
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'RECOVERY_SAFETY_GATE_BLOCKED',
          action: null,
          reasons,
          blockers
        };
      }

      const now = this.now();
      this._pruneAttempts(now);
      if (this.inFlight) {
        return this.lastPlan = { state: 'BLOCKED', reason: 'RECOVERY_ALREADY_IN_FLIGHT', action: null, reasons };
      }
      if (this.lastAttemptAtMs != null && now - this.lastAttemptAtMs < this.config.cooldownMs) {
        this.stats.cooldownBlocks += 1;
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'RECOVERY_COOLDOWN',
          action: null,
          reasons,
          retryAtMs: this.lastAttemptAtMs + this.config.cooldownMs
        };
      }
      if (this.attempts.length >= this.config.maxAttemptsPerWindow) {
        this.stats.budgetBlocks += 1;
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'RECOVERY_BUDGET_EXHAUSTED',
          action: null,
          reasons,
          attempts: this.attempts.length
        };
      }

      return this.lastPlan = {
        state: 'READY',
        reason: known[0],
        action: 'RESTART_MODULE',
        target: 'runtime-health',
        reasons
      };
    }

    async tick(input = null) {
      this.stats.ticks += 1;
      if (this.heartbeat) {
        try {
          this.heartbeat({
            phase: 'known-recovery',
            enabled: this.config.enabled,
            inFlight: this.inFlight,
            lastPlanState: this.lastPlan && this.lastPlan.state || null
          });
        } catch (_) {}
      }
      const plan = this.plan(input);
      if (plan.state !== 'READY') {
        if (plan.state === 'BLOCKED') this.stats.blocked += 1;
        else this.stats.noops += 1;
        return { executed: false, plan: clone(plan), status: this.status() };
      }

      if (!this.allowedModules.has(plan.target)) {
        this.stats.blocked += 1;
        const blocked = { ...plan, state: 'BLOCKED', reason: 'RECOVERY_TARGET_NOT_ALLOWLISTED', action: null };
        this.lastPlan = blocked;
        return { executed: false, plan: clone(blocked), status: this.status() };
      }

      const now = this.now();
      this.inFlight = true;
      this.lastAttemptAtMs = now;
      this.attempts.push(now);
      this.stats.attempts += 1;
      this._event('RECOVERY_ATTEMPTED', 'WARN', { action: plan.action, target: plan.target, reason: plan.reason });

      try {
        if (!this.runtime || typeof this.runtime.restartModule !== 'function') throw new Error('RUNTIME_RESTART_MODULE_UNAVAILABLE');
        const result = await this.runtime.restartModule(plan.target, 'H22_KNOWN_RECOVERY:' + plan.reason);
        const success = !!(result && result.state === 'ACTIVE' && result.health !== 'ERROR' && result.health !== 'STALE');
        if (!success) throw new Error('RECOVERY_RESTART_NOT_HEALTHY');

        this.stats.successes += 1;
        this.lastResult = {
          at: new Date(this.now()).toISOString(),
          success: true,
          action: plan.action,
          target: plan.target,
          reason: plan.reason,
          moduleState: result.state,
          moduleHealth: result.health
        };
        this._event('RECOVERY_SUCCEEDED', 'INFO', this.lastResult);
        return { executed: true, success: true, plan: clone(plan), result: clone(this.lastResult), status: this.status() };
      } catch (error) {
        this.stats.failures += 1;
        this.lastResult = {
          at: new Date(this.now()).toISOString(),
          success: false,
          action: plan.action,
          target: plan.target,
          reason: plan.reason,
          error: cleanText(error && error.message || error, 300)
        };
        this._event('RECOVERY_FAILED', 'ERROR', this.lastResult);
        if (this.logger && typeof this.logger.error === 'function') {
          try { this.logger.error('H22 Known Recovery fehlgeschlagen', this.lastResult); } catch (_) {}
        }
        return { executed: true, success: false, plan: clone(plan), result: clone(this.lastResult), status: this.status() };
      } finally {
        this.inFlight = false;
      }
    }

    status() {
      this._pruneAttempts(this.now());
      return {
        schemaVersion: 1,
        mode: 'h22-known-recovery-allowlist',
        moduleActive: this.moduleActive,
        enabled: this.config.enabled,
        inFlight: this.inFlight,
        allowedModules: [...this.allowedModules],
        lastPlan: clone(this.lastPlan),
        lastResult: clone(this.lastResult),
        attemptsInWindow: this.attempts.length,
        config: clone(this.config),
        stats: clone(this.stats),
        history: clone(this.history.slice(-20)),
        policies: {
          allowlistedOnly: true,
          automaticRecoveryTargets: ['runtime-health'],
          gameplayActionAuthority: false,
          rawGameplayActionAuthority: false,
          transactionalRecoveryAuthority: false,
          unknownRecoveryAuthority: false,
          emergencyOverrideAuthority: false,
          codeRepairAuthority: false,
          chatgptRequiredForNormalOperation: false
        }
      };
    }
  }

  ns.KnownRecoveryCoordinator = KnownRecoveryCoordinator;
})(typeof globalThis !== 'undefined' ? globalThis : this);
