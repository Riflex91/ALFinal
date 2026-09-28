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
        confirmMs: Math.max(1000, Math.min(60000, Math.floor(finite(options.confirmMs, 5000)))),
        cooldownMs: Math.max(5000, Math.min(60 * 60 * 1000, Math.floor(finite(options.cooldownMs, 60000)))),
        attemptWindowMs: Math.max(60000, Math.min(24 * 60 * 60 * 1000, Math.floor(finite(options.attemptWindowMs, 30 * 60 * 1000)))),
        maxAttemptsPerWindow: Math.max(1, Math.min(5, Math.floor(finite(options.maxAttemptsPerWindow, 2))))
      };

      this.allowedModules = new Set(['runtime-health', 'account-strategy', 'autonomous-observer']);
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.inFlight = false;
      this.confirmations = new Map();
      this.attempts = new Map();
      this.lastAttemptAtMs = new Map();
      this.history = [];
      this.lastPlan = null;
      this.lastResult = null;
      this.stats = {
        ticks: 0,
        plans: 0,
        noops: 0,
        watches: 0,
        delegated: 0,
        escalations: 0,
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
      if (options.confirmMs != null) {
        this.config.confirmMs = Math.max(1000, Math.min(60000, Math.floor(finite(options.confirmMs, this.config.confirmMs))));
      }
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
      this.scope.interval('known-recovery-tick', () => {
        Promise.resolve(this.tick()).catch(error => {
          this._event('RECOVERY_TICK_FAILED', 'ERROR', {
            reason: cleanText(error && error.message || error || 'RECOVERY_TICK_FAILED', 300)
          });
        });
      }, this.config.tickMs, { immediate: false });
      this._event('RECOVERY_STARTED', 'INFO', { enabled: this.config.enabled });
      return this.status();
    }

    stop(reason = 'H22_RECOVERY_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.inFlight = false;
      this.confirmations.clear();
      this._event('RECOVERY_STOPPED', 'INFO', { reason: cleanText(reason, 180) });
      return this.status();
    }

    _event(type, severity, data = {}) {
      const atMs = this.now();
      const row = {
        at: new Date(atMs).toISOString(),
        atMs,
        type: cleanText(type, 100),
        severity: cleanText(severity || 'INFO', 20).toUpperCase(),
        ...clone(data)
      };
      this.history.push(row);
      if (this.history.length > 120) this.history.splice(0, this.history.length - 120);
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

    _runtimeBlockers() {
      const blockers = [];
      const add = (code, condition) => { if (condition) blockers.push(code); };
      const status = name => this._read(this.runtime && this.runtime[name]);

      add('RUNTIME_NOT_RUNNING', this.runtime && this.runtime.running !== true);
      const scheduler = this.runtime && this.runtime.scheduler && typeof this.runtime.scheduler.status === 'function'
        ? this.runtime.scheduler.status()
        : null;
      add('SCHEDULER_NOT_RUNNING', scheduler && scheduler.enabled === false);

      const stop = this.runtime && this.runtime.stopLatch && typeof this.runtime.stopLatch.status === 'function'
        ? this.runtime.stopLatch.status()
        : null;
      add('EMERGENCY_STOP_LATCHED', stop && stop.latched === true);

      const combat = status('combat');
      add('COMBAT_ACTIVE', !!(combat && combat.active));
      add('COMBAT_PENDING_ATTACK', !!(combat && combat.pendingAttack));

      const movement = status('movement');
      add('MOVEMENT_ACTIVE', !!(movement && (movement.active || movement.activeOrder)));

      const classSkills = status('classSkills');
      add('CLASS_SKILLS_PENDING', !!(classSkills && classSkills.pending));
      add('CLASS_SKILLS_SUSPENDED', !!(classSkills && classSkills.suspendedReason));

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
        const prefix = name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
        add(prefix + '_PENDING', !!row.pending);
        add(prefix + '_REQUEST_PENDING', !!row.request);
        add(prefix + '_DELIVERY_PENDING', !!row.delivery);
        add(prefix + '_CURRENT_ACTION', !!row.currentAction);
        add(prefix + '_SUSPENDED', row.suspended === true);
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

      const full = status('fullAutonomy');
      if (full && full.enabled === true) {
        const decisionState = cleanText(full.lastDecision && full.lastDecision.state || '', 40).toUpperCase();
        add('FULL_AUTONOMY_UNSAFE_TRANSITION', !decisionState || decisionState !== 'RUNNING');
      }

      let game = null;
      try { game = this.runtime && this.runtime.game && this.runtime.game.snapshot ? this.runtime.game.snapshot() : null; } catch (_) {}
      const character = game && game.character;
      add('CHARACTER_UNKNOWN', !character);
      add('CHARACTER_DEAD', !!(character && (character.rip === true || character.dead === true)));

      return [...new Set(blockers)];
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

    _moduleFaults() {
      let rows = [];
      try {
        rows = this.runtime && this.runtime.modules && typeof this.runtime.modules.list === 'function'
          ? this.runtime.modules.list()
          : [];
      } catch (_) {}
      return asArray(rows)
        .filter(row => row && row.id !== 'known-recovery')
        .filter(row => row.state === 'ERROR' || row.health === 'ERROR' || row.health === 'STALE')
        .map(row => ({
          id: cleanText(row.id || 'unknown', 120),
          state: cleanText(row.state || '', 40).toUpperCase() || null,
          health: cleanText(row.health || '', 40).toUpperCase() || null,
          reason: (row.state === 'ERROR' || row.health === 'ERROR' ? 'MODULE_ERROR:' : 'MODULE_STALE:') + cleanText(row.id || 'unknown', 120)
        }));
    }

    _delegation(reasons) {
      if (!reasons.length) return null;
      if (reasons.every(reason => /^GROUP_PEER_(?:STALE|UNOBSERVED|CRITICAL|DEGRADED):/.test(reason)
          || reason === 'GROUP_DESIRED_MEMBER_OFFLINE')) {
        return { owner: 'host-watchdog', reason: 'RECOVERY_DELEGATED_HOST_WATCHDOG' };
      }
      if (reasons.includes('CHARACTER_DEAD')) {
        const lifecycle = this._read(this.runtime && this.runtime.lifecycle);
        if (lifecycle && lifecycle.autonomyEnabled === true && lifecycle.suspended !== true) {
          return { owner: 'character-lifecycle', reason: 'RECOVERY_DELEGATED_H19_LIFECYCLE' };
        }
      }
      return null;
    }

    _pruneAttempts(target, now = this.now()) {
      const key = String(target || '');
      const rows = this.attempts.get(key) || [];
      const cutoff = now - this.config.attemptWindowMs;
      while (rows.length && rows[0] <= cutoff) rows.shift();
      this.attempts.set(key, rows);
      return rows;
    }

    _confirmation(candidate, now) {
      const key = candidate.reason;
      for (const existing of [...this.confirmations.keys()]) {
        if (existing !== key) this.confirmations.delete(existing);
      }
      let firstSeenAtMs = this.confirmations.get(key);
      if (firstSeenAtMs == null) {
        firstSeenAtMs = now;
        this.confirmations.set(key, firstSeenAtMs);
      }
      return {
        confirmed: now - firstSeenAtMs >= this.config.confirmMs,
        firstSeenAtMs,
        confirmAtMs: firstSeenAtMs + this.config.confirmMs,
        observedForMs: Math.max(0, now - firstSeenAtMs)
      };
    }

    plan(input = null) {
      this.stats.plans += 1;
      const assessment = this._assessment(input);
      const reasons = assessment && Array.isArray(assessment.reasons)
        ? assessment.reasons.map(value => cleanText(value, 220)).filter(Boolean)
        : [];
      const faults = this._moduleFaults();

      if (!this.config.enabled) {
        return this.lastPlan = { state: 'BLOCKED', reason: 'KNOWN_RECOVERY_DISABLED', action: null };
      }
      if (!this.moduleActive) {
        return this.lastPlan = { state: 'BLOCKED', reason: 'KNOWN_RECOVERY_MODULE_NOT_ACTIVE', action: null };
      }

      if (!faults.length) {
        this.confirmations.clear();
        if (!reasons.length) {
          return this.lastPlan = {
            state: 'NONE',
            reason: 'HEALTHY_NO_RECOVERY',
            action: null,
            assessmentState: assessment && assessment.state || null,
            reasons
          };
        }
        const delegation = this._delegation(reasons);
        if (delegation) {
          return this.lastPlan = {
            state: 'DELEGATED',
            reason: delegation.reason,
            owner: delegation.owner,
            action: null,
            reasons
          };
        }
        return this.lastPlan = {
          state: 'ESCALATE',
          reason: 'NO_SAFE_AUTOMATIC_RECOVERY',
          action: null,
          assessmentState: assessment && assessment.state || null,
          reasons
        };
      }

      const recoverable = faults.filter(row => this.allowedModules.has(row.id));
      const protectedFaults = faults.filter(row => !this.allowedModules.has(row.id));
      if (protectedFaults.length || recoverable.length !== 1) {
        this.confirmations.clear();
        return this.lastPlan = {
          state: 'ESCALATE',
          reason: protectedFaults.length ? 'MODULE_RECOVERY_NOT_ALLOWLISTED' : 'MULTIPLE_RECOVERY_FAULTS',
          action: null,
          reasons,
          faults: clone(faults),
          protectedFaults: clone(protectedFaults)
        };
      }

      const candidate = recoverable[0];
      const related = new Set(['MODULE_ERROR:' + candidate.id, 'MODULE_STALE:' + candidate.id]);
      const additionalReasons = reasons.filter(reason => !related.has(reason));
      if (additionalReasons.length) {
        this.confirmations.clear();
        return this.lastPlan = {
          state: 'ESCALATE',
          reason: 'ADDITIONAL_HEALTH_REASONS_PRESENT',
          action: null,
          target: candidate.id,
          reasons,
          blockers: additionalReasons
        };
      }

      const blockers = this._runtimeBlockers();
      if (blockers.length) {
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'RECOVERY_SAFETY_GATE_BLOCKED',
          action: null,
          target: candidate.id,
          reasons,
          blockers
        };
      }

      const now = this.now();
      const confirmation = this._confirmation(candidate, now);
      if (!confirmation.confirmed) {
        this.stats.watches += 1;
        return this.lastPlan = {
          state: 'WATCH',
          reason: 'RECOVERY_CONFIRMATION_WINDOW',
          action: null,
          target: candidate.id,
          fault: candidate.reason,
          reasons,
          ...confirmation
        };
      }

      if (this.inFlight) {
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'RECOVERY_ALREADY_IN_FLIGHT',
          action: null,
          target: candidate.id,
          reasons
        };
      }

      const lastAttempt = this.lastAttemptAtMs.get(candidate.id);
      if (lastAttempt != null && now - lastAttempt < this.config.cooldownMs) {
        this.stats.cooldownBlocks += 1;
        return this.lastPlan = {
          state: 'BLOCKED',
          reason: 'RECOVERY_COOLDOWN',
          action: null,
          target: candidate.id,
          reasons,
          retryAtMs: lastAttempt + this.config.cooldownMs
        };
      }

      const attempts = this._pruneAttempts(candidate.id, now);
      if (attempts.length >= this.config.maxAttemptsPerWindow) {
        this.stats.budgetBlocks += 1;
        return this.lastPlan = {
          state: 'ESCALATE',
          reason: 'RECOVERY_BUDGET_EXHAUSTED',
          action: null,
          target: candidate.id,
          reasons,
          attempts: attempts.length
        };
      }

      return this.lastPlan = {
        state: 'READY',
        reason: candidate.reason,
        action: 'RESTART_MODULE',
        target: candidate.id,
        reasons,
        confirmedForMs: confirmation.observedForMs
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
        else if (plan.state === 'DELEGATED') this.stats.delegated += 1;
        else if (plan.state === 'ESCALATE') this.stats.escalations += 1;
        else if (plan.state !== 'WATCH') this.stats.noops += 1;
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
      this.lastAttemptAtMs.set(plan.target, now);
      const attempts = this._pruneAttempts(plan.target, now);
      attempts.push(now);
      this.attempts.set(plan.target, attempts);
      this.stats.attempts += 1;
      this._event('RECOVERY_ATTEMPTED', 'WARN', { action: plan.action, target: plan.target, reason: plan.reason });

      try {
        if (!this.runtime || typeof this.runtime.restartModule !== 'function') throw new Error('RUNTIME_RESTART_MODULE_UNAVAILABLE');
        const result = await this.runtime.restartModule(plan.target, 'H22_KNOWN_RECOVERY:' + plan.reason);
        const success = !!(result && result.state === 'ACTIVE' && result.health !== 'ERROR' && result.health !== 'STALE');
        if (!success) throw new Error('RECOVERY_RESTART_NOT_HEALTHY');

        this.confirmations.clear();
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
      const now = this.now();
      const attemptsByTarget = {};
      for (const id of this.allowedModules) attemptsByTarget[id] = this._pruneAttempts(id, now).length;
      return {
        schemaVersion: 1,
        mode: 'h22-known-recovery-allowlist',
        moduleActive: this.moduleActive,
        enabled: this.config.enabled,
        inFlight: this.inFlight,
        allowedModules: [...this.allowedModules].sort(),
        lastPlan: clone(this.lastPlan),
        lastResult: clone(this.lastResult),
        attemptsByTarget,
        config: clone(this.config),
        stats: clone(this.stats),
        history: clone(this.history.slice(-24)),
        policies: {
          allowlistedOnly: true,
          automaticRecoveryTargets: [...this.allowedModules].sort(),
          confirmationWindowRequired: true,
          perTargetCooldownAndBudget: true,
          delegatesCharacterDeathToH19: true,
          delegatesPeerFailureToHostWatchdog: true,
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
