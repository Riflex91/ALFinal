(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function errorDetails(error) {
    return {
      name: cleanText(error && error.name || 'Error', 80),
      message: cleanText(error && error.message || error || 'Unknown error', 600),
      stack: error && error.stack ? String(error.stack).slice(0, 4000) : null
    };
  }

  class LiveTestRunner {
    constructor(options = {}) {
      this.runtime = options.runtime || null;
      this.logger = options.logger || null;
      this.bus = options.bus || null;
      this.suites = new Map();
      this.recommendedId = null;
      this.sequence = 0;
      this.current = null;
      this.lastRun = null;
      this.cancelRequested = false;
    }

    register(definition) {
      if (!definition || typeof definition !== 'object') throw new Error('LIVE_TEST_DEFINITION_REQUIRED');
      const id = cleanText(definition.id, 100);
      if (!id) throw new Error('LIVE_TEST_ID_REQUIRED');
      if (this.suites.has(id)) throw new Error('LIVE_TEST_DUPLICATE:' + id);
      const steps = Array.isArray(definition.steps) ? definition.steps : [];
      if (!steps.length) throw new Error('LIVE_TEST_STEPS_REQUIRED:' + id);
      for (const step of steps) {
        if (!step || typeof step.run !== 'function') throw new Error('LIVE_TEST_STEP_RUN_REQUIRED:' + id);
      }
      const suite = {
        id,
        title: cleanText(definition.title || id, 160),
        description: cleanText(definition.description || '', 500),
        version: cleanText(definition.version || '1', 40),
        autoStartRuntime: definition.autoStartRuntime !== false,
        restoreRuntimeState: definition.restoreRuntimeState !== false,
        prepare: typeof definition.prepare === 'function' ? definition.prepare : null,
        cleanup: typeof definition.cleanup === 'function' ? definition.cleanup : null,
        steps: steps.map((step, index) => ({
          id: cleanText(step.id || ('step-' + (index + 1)), 100),
          title: cleanText(step.title || step.id || ('Schritt ' + (index + 1)), 180),
          timeoutMs: Math.max(250, Math.min(10 * 60 * 1000, Number(step.timeoutMs) || 30000)),
          run: step.run
        }))
      };
      this.suites.set(id, suite);
      if (definition.recommended === true || !this.recommendedId) this.recommendedId = id;
      return this.describe(id);
    }

    setRecommended(id) {
      if (!this.suites.has(id)) throw new Error('LIVE_TEST_UNKNOWN:' + id);
      this.recommendedId = id;
      return this.describe(id);
    }

    list() {
      return Array.from(this.suites.values()).map(suite => ({
        id: suite.id,
        title: suite.title,
        description: suite.description,
        version: suite.version,
        recommended: suite.id === this.recommendedId,
        steps: suite.steps.map(step => ({ id: step.id, title: step.title, timeoutMs: step.timeoutMs }))
      }));
    }

    describe(id) {
      const suite = this.suites.get(id);
      if (!suite) return null;
      return this.list().find(row => row.id === id) || null;
    }

    _emit() {
      if (this.bus) {
        try { this.bus.emit('live-test', this.status()); } catch (_) {}
      }
    }

    _publicRun(run) {
      if (!run) return null;
      return clone({
        id: run.id,
        suiteId: run.suiteId,
        title: run.title,
        state: run.state,
        reason: run.reason,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        runtimeWasRunning: run.runtimeWasRunning,
        runtimeAutoStarted: run.runtimeAutoStarted,
        currentStepId: run.currentStepId,
        steps: run.steps,
        cleanup: run.cleanup
      });
    }

    _assertNotCancelled() {
      if (this.cancelRequested) throw new Error('LIVE_TEST_CANCELLED');
      if (this.runtime && this.runtime.stopLatch && this.runtime.stopLatch.status().latched) {
        throw new Error('LIVE_TEST_EMERGENCY_STOP_LATCHED');
      }
    }

    _context(run, suite) {
      const sleep = ms => new Promise((resolve, reject) => {
        const delay = Math.max(0, Number(ms) || 0);
        const timerRoot = this.runtime && this.runtime.root || root;
        const set = timerRoot && typeof timerRoot.setTimeout === 'function' ? timerRoot.setTimeout.bind(timerRoot) : setTimeout;
        set(() => {
          try {
            this._assertNotCancelled();
            resolve();
          } catch (error) {
            reject(error);
          }
        }, delay);
      });

      const waitFor = async (predicate, options = {}) => {
        const timeoutMs = Math.max(100, Math.min(10 * 60 * 1000, Number(options.timeoutMs) || 10000));
        const pollMs = Math.max(25, Math.min(2000, Number(options.pollMs) || 100));
        const started = Date.now();
        let lastValue = null;
        while (Date.now() - started <= timeoutMs) {
          this._assertNotCancelled();
          lastValue = await predicate();
          if (lastValue) return lastValue;
          await sleep(pollMs);
        }
        const label = cleanText(options.label || 'condition', 120);
        throw new Error('LIVE_TEST_WAIT_TIMEOUT:' + label);
      };

      return {
        runtime: this.runtime,
        suite: this.describe(suite.id),
        run: () => this._publicRun(run),
        assert: (condition, message = 'LIVE_TEST_ASSERTION_FAILED') => {
          if (!condition) throw new Error(cleanText(message, 300) || 'LIVE_TEST_ASSERTION_FAILED');
          return true;
        },
        assertNotCancelled: () => this._assertNotCancelled(),
        sleep,
        waitFor,
        game: () => this.runtime && this.runtime.game ? this.runtime.game.snapshot() : null,
        status: () => this.runtime ? this.runtime.status() : null,
        note: details => {
          const step = run.steps.find(row => row.id === run.currentStepId);
          if (step) step.details = clone(details);
          this._emit();
        }
      };
    }

    async _runStep(run, suite, step, context) {
      const row = run.steps.find(candidate => candidate.id === step.id);
      row.state = 'RUNNING';
      row.startedAt = new Date().toISOString();
      run.currentStepId = step.id;
      this._emit();

      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        const timerRoot = this.runtime && this.runtime.root || root;
        const set = timerRoot && typeof timerRoot.setTimeout === 'function' ? timerRoot.setTimeout.bind(timerRoot) : setTimeout;
        timer = set(() => reject(new Error('LIVE_TEST_STEP_TIMEOUT:' + step.id)), step.timeoutMs);
      });

      try {
        this._assertNotCancelled();
        const result = await Promise.race([
          Promise.resolve().then(() => step.run(context)),
          timeoutPromise
        ]);
        this._assertNotCancelled();
        row.state = 'PASSED';
        row.finishedAt = new Date().toISOString();
        row.result = result == null ? null : clone(result);
        row.error = null;
      } catch (error) {
        row.state = this.cancelRequested ? 'CANCELLED' : 'FAILED';
        row.finishedAt = new Date().toISOString();
        row.error = errorDetails(error);
        throw error;
      } finally {
        if (timer != null) {
          const timerRoot = this.runtime && this.runtime.root || root;
          const clear = timerRoot && typeof timerRoot.clearTimeout === 'function' ? timerRoot.clearTimeout.bind(timerRoot) : clearTimeout;
          try { clear(timer); } catch (_) {}
        }
        this._emit();
      }
    }

    async start(id) {
      if (this.current && this.current.state === 'RUNNING') throw new Error('LIVE_TEST_ALREADY_RUNNING');
      const suiteId = id || this.recommendedId;
      const suite = this.suites.get(suiteId);
      if (!suite) throw new Error('LIVE_TEST_UNKNOWN:' + cleanText(suiteId, 100));
      if (!this.runtime) throw new Error('LIVE_TEST_RUNTIME_MISSING');
      if (this.runtime.stopLatch.status().latched) throw new Error('LIVE_TEST_EMERGENCY_STOP_LATCHED');

      this.cancelRequested = false;
      const runtimeWasRunning = this.runtime.running === true;
      const run = {
        id: 'live-test-' + (++this.sequence),
        suiteId: suite.id,
        title: suite.title,
        state: 'RUNNING',
        reason: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        runtimeWasRunning,
        runtimeAutoStarted: false,
        currentStepId: null,
        cleanup: { attempted: false, ok: null, error: null },
        steps: suite.steps.map(step => ({
          id: step.id,
          title: step.title,
          state: 'PENDING',
          startedAt: null,
          finishedAt: null,
          details: null,
          result: null,
          error: null
        }))
      };
      this.current = run;
      this._emit();
      if (this.logger) this.logger.warn('Live-Test gestartet', { id: run.id, suite: suite.id, title: suite.title });

      const context = this._context(run, suite);
      try {
        if (!runtimeWasRunning && suite.autoStartRuntime) {
          await this.runtime.start();
          run.runtimeAutoStarted = true;
          this._emit();
        }
        this._assertNotCancelled();
        if (suite.prepare) await suite.prepare(context);

        for (const step of suite.steps) {
          await this._runStep(run, suite, step, context);
        }

        run.state = 'PASSED';
        run.reason = 'ALL_STEPS_PASSED';
      } catch (error) {
        run.state = this.cancelRequested ? 'CANCELLED' : 'FAILED';
        run.reason = cleanText(error && error.message || error || 'LIVE_TEST_FAILED', 300);
        for (const row of run.steps) {
          if (row.state === 'PENDING') row.state = 'SKIPPED';
        }
      } finally {
        run.cleanup.attempted = true;
        try {
          if (suite.cleanup) await suite.cleanup(context, run.state);
          if (run.runtimeAutoStarted && suite.restoreRuntimeState && this.runtime.running) {
            await this.runtime.stop('LIVE_TEST_AUTO_RESTORE');
          }
          run.cleanup.ok = true;
        } catch (cleanupError) {
          run.cleanup.ok = false;
          run.cleanup.error = errorDetails(cleanupError);
          if (run.state === 'PASSED') {
            run.state = 'FAILED';
            run.reason = 'LIVE_TEST_CLEANUP_FAILED:' + run.cleanup.error.message;
          }
        }

        run.finishedAt = new Date().toISOString();
        run.currentStepId = null;
        this.lastRun = this._publicRun(run);
        this.current = null;
        this._emit();
        if (this.logger) {
          const data = { id: run.id, suite: suite.id, state: run.state, reason: run.reason };
          if (run.state === 'PASSED') this.logger.info('Live-Test beendet: BESTANDEN', data);
          else this.logger.error('Live-Test beendet: ' + run.state, data);
        }
      }

      return clone(this.lastRun);
    }

    startRecommended() {
      return this.start(this.recommendedId);
    }

    cancel(reason = 'MANUAL_TEST_CANCEL') {
      if (!this.current || this.current.state !== 'RUNNING') {
        return { cancelled: false, reason: 'NO_RUNNING_LIVE_TEST' };
      }
      this.cancelRequested = true;
      this.current.reason = cleanText(reason, 200);
      this._emit();
      if (this.logger) this.logger.warn('Live-Test Abbruch angefordert', {
        id: this.current.id,
        suite: this.current.suiteId,
        reason: this.current.reason
      });
      return { cancelled: true, id: this.current.id, suiteId: this.current.suiteId };
    }

    status() {
      return {
        schemaVersion: 1,
        recommendedId: this.recommendedId,
        recommended: this.describe(this.recommendedId),
        running: !!(this.current && this.current.state === 'RUNNING'),
        current: this._publicRun(this.current),
        lastRun: clone(this.lastRun),
        suites: this.list()
      };
    }
  }

  ns.LiveTestRunner = LiveTestRunner;
})(typeof globalThis !== 'undefined' ? globalThis : this);
