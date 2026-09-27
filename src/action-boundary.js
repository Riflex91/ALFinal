(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const ACTIONS = Object.freeze({
    move: Object.freeze({ publicName: 'move', family: 'movement' }),
    smart_move: Object.freeze({ publicName: 'smart_move', family: 'movement' }),
    stop: Object.freeze({ publicName: 'stop', family: 'movement-cleanup' }),
    use_skill: Object.freeze({ publicName: 'use_skill', family: 'skill' }),
    attack: Object.freeze({ publicName: 'attack', family: 'combat' }),
    heal: Object.freeze({ publicName: 'heal', family: 'party-heal' }),
    change_target: Object.freeze({ publicName: 'change_target', family: 'combat-target' }),
    loot: Object.freeze({ publicName: 'loot', family: 'loot' }),
    send_item: Object.freeze({ publicName: 'send_item', family: 'merchant-logistics' }),
    bank_store: Object.freeze({ publicName: 'bank_store', family: 'bank' }),
    bank_retrieve: Object.freeze({ publicName: 'bank_retrieve', family: 'bank' }),
    bank_deposit: Object.freeze({ publicName: 'bank_deposit', family: 'bank-gold' }),
    bank_withdraw: Object.freeze({ publicName: 'bank_withdraw', family: 'bank-gold' })
  });

  function errorDetails(error) {
    return {
      name: cleanText(error && error.name || 'Error', 80),
      message: cleanText(error && error.message || error || 'Unknown error', 500),
      stack: error && error.stack ? String(error.stack).slice(0, 3000) : null
    };
  }

  class GameActionBoundary {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.assertAllowed = typeof options.assertAllowed === 'function'
        ? options.assertAllowed
        : () => true;
      this.sequence = 0;
      this.lastAction = null;
      this.metrics = {
        attempted: 0,
        dispatched: 0,
        unavailable: 0,
        blocked: 0,
        synchronousErrors: 0,
        cleanupDispatches: 0
      };
    }

    _roots() {
      const out = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!out.includes(current)) out.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return out;
    }

    _resolve(publicName) {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate[publicName] === 'function') {
            return { owner: candidate, fn: candidate[publicName] };
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && typeof candidate.parent[publicName] === 'function') {
            return { owner: candidate.parent, fn: candidate.parent[publicName] };
          }
        } catch (_) {}
      }
      return null;
    }

    available(action) {
      const def = ACTIONS[action];
      if (!def) return false;
      return !!this._resolve(def.publicName);
    }

    dispatch(action, args = [], options = {}) {
      const def = ACTIONS[action];
      if (!def) throw new Error('ALBOT_ACTION_UNKNOWN:' + cleanText(action, 80));
      if (!Array.isArray(args)) throw new Error('ALBOT_ACTION_ARGS_INVALID:' + action);

      const cleanup = options.cleanup === true;
      if (cleanup && action !== 'stop' && action !== 'use_skill' && action !== 'change_target') {
        throw new Error('ALBOT_CLEANUP_ACTION_NOT_ALLOWED:' + action);
      }
      if (cleanup && action === 'change_target' && args[0] != null) {
        throw new Error('ALBOT_CLEANUP_TARGET_MUST_CLEAR');
      }

      this.metrics.attempted += 1;
      const id = 'act-' + (++this.sequence);
      const at = new Date().toISOString();

      if (!cleanup) {
        try {
          this.assertAllowed(action);
        } catch (error) {
          this.metrics.blocked += 1;
          this.lastAction = {
            id, at, action, family: def.family, state: 'BLOCKED',
            cleanup: false, error: errorDetails(error)
          };
          throw error;
        }
      }

      const resolved = this._resolve(def.publicName);
      if (!resolved) {
        this.metrics.unavailable += 1;
        const result = {
          id, at, action, family: def.family, state: 'UNAVAILABLE',
          cleanup, dispatched: false, value: null,
          error: { name: 'Error', message: 'ALBOT_ACTION_API_UNAVAILABLE:' + def.publicName, stack: null }
        };
        this.lastAction = clone(result);
        return result;
      }

      try {
        const value = resolved.fn.apply(resolved.owner, args);
        this.metrics.dispatched += 1;
        if (cleanup) this.metrics.cleanupDispatches += 1;
        const result = {
          id, at, action, family: def.family, state: 'DISPATCHED',
          cleanup, dispatched: true, value,
          error: null
        };
        this.lastAction = {
          id, at, action, family: def.family, state: 'DISPATCHED',
          cleanup, dispatched: true, error: null
        };
        if (this.logger) this.logger.info('Game-Aktion gesendet', {
          id, action, family: def.family, cleanup
        });
        return result;
      } catch (error) {
        this.metrics.synchronousErrors += 1;
        const result = {
          id, at, action, family: def.family, state: 'UNKNOWN',
          cleanup, dispatched: true, value: null, error: errorDetails(error)
        };
        this.lastAction = clone(result);
        if (this.logger) this.logger.error('Game-Aktion endete synchron unklar', {
          id, action, family: def.family, cleanup, error: result.error
        });
        return result;
      }
    }

    status() {
      return {
        schemaVersion: 1,
        supportedActions: Object.keys(ACTIONS),
        availability: Object.fromEntries(Object.keys(ACTIONS).map(action => [action, this.available(action)])),
        metrics: clone(this.metrics),
        lastAction: clone(this.lastAction)
      };
    }
  }

  ns.GameActionBoundary = GameActionBoundary;
})(typeof globalThis !== 'undefined' ? globalThis : this);
