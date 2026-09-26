(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  class LootInventoryController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.goals = options.goals || null;
      this.moduleActive = false;
      this.scope = null;
      this.pendingLoot = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        reserveFreeSlots: Math.max(1, Math.min(12, Number(options.reserveFreeSlots) || 2))
      };
      this.rules = {
        keepNames: new Set(),
        reserveNames: new Set(),
        sellNames: new Set(),
        bankNames: new Set(),
        exchangeNames: new Set()
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        lootDispatched: 0,
        lootConfirmed: 0,
        lootKnownRejected: 0,
        lootUnknown: 0,
        inventoryFullBlocks: 0,
        protectedItems: 0,
        reserveItems: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H10_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('loot-inventory-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H10_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pendingLoot = null;
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'STOP',
        reason: cleanText(reason, 240)
      };
      return { stopped: true };
    }

    setRules(rules = {}) {
      for (const key of Object.keys(this.rules)) {
        if (!Array.isArray(rules[key])) continue;
        this.rules[key] = new Set(rules[key].map(value => cleanText(value, 160)).filter(Boolean));
      }
      return this.ruleSnapshot();
    }

    ruleSnapshot() {
      return Object.fromEntries(Object.entries(this.rules).map(([key, value]) => [key, [...value]]));
    }

    _activeGoalTargets() {
      const names = new Set();
      if (!this.goals || typeof this.goals.list !== 'function') return names;
      let rows = [];
      try { rows = this.goals.list() || []; } catch (_) {}
      for (const goal of rows) {
        if (!goal || !['ACTIVE', 'PAUSED'].includes(String(goal.status || 'ACTIVE'))) continue;
        if (String(goal.type || '').toUpperCase() !== 'COLLECT_ITEM') continue;
        const target = cleanText(goal.target || '', 160);
        if (target) names.add(target);
      }
      return names;
    }

    _classify(item, goalTargets) {
      const definition = item && item.definition || {};
      const name = cleanText(item && item.name || '', 160);
      const level = finite(item && item.level) || 0;
      const type = cleanText(definition.type || '', 80).toLowerCase();
      const explicit = [
        ['reserveNames', 'RESERVE', 'RULE_RESERVE'],
        ['keepNames', 'KEEP', 'RULE_KEEP'],
        ['exchangeNames', 'EXCHANGE', 'RULE_EXCHANGE'],
        ['bankNames', 'BANK', 'RULE_BANK'],
        ['sellNames', 'SELL', 'RULE_SELL']
      ];
      for (const [rule, disposition, reason] of explicit) {
        if (this.rules[rule].has(name)) return { disposition, reason, protected: disposition !== 'SELL' };
      }

      if (item.locked) return { disposition: 'PROTECT', reason: 'ITEM_LOCKED', protected: true };
      if (item.giveaway) return { disposition: 'PROTECT', reason: 'ITEM_GIVEAWAY', protected: true };
      if (item.expiresAt) return { disposition: 'PROTECT', reason: 'ITEM_EXPIRING', protected: true };
      if (level > 0) return { disposition: 'PROTECT', reason: 'LEVELED_ITEM', protected: true };
      if (goalTargets.has(name)) return { disposition: 'RESERVE', reason: 'ACTIVE_COLLECTION_GOAL', protected: true };
      if (type === 'quest') return { disposition: 'RESERVE', reason: 'QUEST_ITEM', protected: true };

      const equipmentTypes = new Set([
        'weapon', 'shield', 'helmet', 'coat', 'pants', 'gloves', 'shoes',
        'cape', 'ring', 'earring', 'amulet', 'belt', 'orb', 'source', 'quiver'
      ]);
      if (equipmentTypes.has(type) || definition.upgrade || definition.compound) {
        return { disposition: 'PROTECT', reason: 'GEAR_OR_UPGRADE_ITEM', protected: true };
      }

      if (definition.e != null || definition.exchange === true) {
        return { disposition: 'EXCHANGE', reason: 'LIVE_ITEM_EXCHANGEABLE', protected: true };
      }

      if (['pot', 'elixir', 'food', 'scroll', 'booster'].includes(type)) {
        return { disposition: 'KEEP', reason: 'CONSUMABLE_OR_UTILITY', protected: true };
      }

      return { disposition: 'BANK', reason: 'SAFE_DEFAULT_UNKNOWN_VALUE', protected: true };
    }

    plan() {
      this.metrics.plans += 1;
      const inventory = this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : { available: false, reason: 'INVENTORY_ADAPTER_UNAVAILABLE', items: [] };
      const chests = this.game && typeof this.game.chestSnapshot === 'function'
        ? this.game.chestSnapshot()
        : { available: false, chests: [] };
      const goalTargets = this._activeGoalTargets();
      const items = (inventory.items || []).map(item => {
        const classification = this._classify(item, goalTargets);
        return { ...item, ...classification };
      });
      const counts = {};
      for (const row of items) counts[row.disposition] = (counts[row.disposition] || 0) + 1;
      this.metrics.protectedItems = items.filter(row => row.protected).length;
      this.metrics.reserveItems = items.filter(row => row.disposition === 'RESERVE').length;

      const freeSlots = finite(inventory.freeSlots);
      const lootable = (chests.chests || []).filter(chest => {
        const count = finite(chest.items);
        if (freeSlots == null || count == null) return false;
        return count <= Math.max(0, freeSlots - this.config.reserveFreeSlots);
      });
      const plan = {
        state: inventory.available === false ? 'BLOCKED' : 'READY',
        reason: inventory.available === false ? inventory.reason || 'INVENTORY_UNAVAILABLE' : 'H10_INVENTORY_READY',
        inventory: {
          capacity: inventory.capacity,
          usedSlots: inventory.usedSlots,
          freeSlots: inventory.freeSlots,
          reportedEmptySlots: inventory.reportedEmptySlots
        },
        items,
        counts,
        chests: clone(chests.chests || []),
        lootableChestIds: lootable.map(row => row.id),
        reserveFreeSlots: this.config.reserveFreeSlots
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _watchLoot(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        pending.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.pendingLoot || this.pendingLoot.id !== pending.id) return;
        this.pendingLoot.settlement = 'RESOLVED';
        this.pendingLoot.response = response == null ? null : clone(response);
      }, error => {
        if (!this.pendingLoot || this.pendingLoot.id !== pending.id) return;
        this.pendingLoot.settlement = 'REJECTED';
        this.pendingLoot.error = cleanText(error && error.message || error || 'H10_LOOT_REJECTED', 500);
      }).catch(() => {});
    }

    _observePendingLoot() {
      const pending = this.pendingLoot;
      if (!pending || pending.settlement === 'PENDING') return false;
      this.pendingLoot = null;

      if (pending.settlement === 'REJECTED') {
        this.metrics.lootUnknown += 1;
        this.suspendedReason = pending.error || 'H10_LOOT_UNKNOWN';
        this.lastAction = { at: new Date().toISOString(), type: 'LOOT_UNKNOWN', reason: this.suspendedReason };
        return true;
      }

      const response = pending.response;
      const responseReason = cleanText(response && response.reason || '', 240);
      if (response && response.failed === true) {
        this.metrics.lootKnownRejected += 1;
        this.lastAction = {
          at: new Date().toISOString(),
          type: 'LOOT_REJECTED',
          reason: responseReason || 'H10_LOOT_REJECTED'
        };
        return true;
      }
      if (response && (response.success === false || ['nothing_to_loot', 'safety'].includes(responseReason))) {
        this.metrics.lootKnownRejected += 1;
        this.lastAction = {
          at: new Date().toISOString(),
          type: 'LOOT_SKIPPED',
          reason: responseReason || 'H10_LOOT_SKIPPED'
        };
        return true;
      }

      this.metrics.lootConfirmed += 1;
      this.lastAction = { at: new Date().toISOString(), type: 'LOOT_CONFIRMED', chestId: pending.chestId };
      return true;
    }

    tick() {
      this.metrics.ticks += 1;
      this._observePendingLoot();
      const plan = this.plan();

      if (!this.moduleActive) return { state: 'IDLE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.pendingLoot) return { state: 'LOOT_PENDING', chestId: this.pendingLoot.chestId, plan };
      if (plan.state !== 'READY') return { state: plan.state, reason: plan.reason, plan };

      const freeSlots = finite(plan.inventory.freeSlots);
      if ((plan.chests || []).length && (freeSlots == null || freeSlots <= this.config.reserveFreeSlots)) {
        this.metrics.inventoryFullBlocks += 1;
        return { state: 'INVENTORY_PRESSURE', reason: 'H10_FREE_SLOT_RESERVE_REACHED', plan };
      }
      const chestId = plan.lootableChestIds[0];
      if (!chestId) return { state: 'READY', reason: 'H10_NOTHING_SAFE_TO_LOOT', plan };
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { state: 'BLOCKED', reason: 'H10_ACTION_BOUNDARY_UNAVAILABLE', plan };
      }

      const result = this.actions.dispatch('loot', [chestId]);
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          this.metrics.lootUnknown += 1;
          this.suspendedReason = result.error && result.error.message || 'H10_LOOT_UNKNOWN';
          return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
        }
        this.metrics.lootKnownRejected += 1;
        return { state: 'WAITING', reason: result && result.state || 'H10_LOOT_REJECTED', plan };
      }

      const pending = {
        id: 'loot-' + (++this.sequence),
        chestId: String(chestId),
        dispatchedAt: new Date().toISOString(),
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pendingLoot = pending;
      this.metrics.lootDispatched += 1;
      this.lastAction = { at: pending.dispatchedAt, type: 'LOOT_DISPATCHED', chestId: pending.chestId };
      this._watchLoot(result.value, pending);
      return { state: 'LOOT_PENDING', chestId: pending.chestId, plan };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pendingLoot: clone(this.pendingLoot),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        rules: this.ruleSnapshot(),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.LootInventoryController = LootInventoryController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
