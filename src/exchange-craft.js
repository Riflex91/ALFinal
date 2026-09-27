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

  function nowIso() {
    return new Date().toISOString();
  }

  function stableProperty(value) {
    if (value == null) return '';
    try {
      if (typeof value !== 'object') return String(value);
      const ordered = {};
      for (const key of Object.keys(value).sort()) ordered[key] = value[key];
      return JSON.stringify(ordered);
    } catch (_) {
      return String(value);
    }
  }

  class ExchangeCraftController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.bank = options.bank || null;
      this.trade = options.trade || null;
      this.combat = options.combat || null;
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.attemptsThisSession = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, finite(options.tickMs) == null ? 750 : finite(options.tickMs))),
        outcomeTimeoutMs: Math.max(1500, Math.min(60000, finite(options.outcomeTimeoutMs) == null ? 15000 : finite(options.outcomeTimeoutMs))),
        movementTimeoutMs: Math.max(3000, Math.min(120000, finite(options.movementTimeoutMs) == null ? 60000 : finite(options.movementTimeoutMs))),
        maxAttemptsPerSession: Math.max(1, Math.min(100, Math.floor(finite(options.maxAttemptsPerSession) == null ? 12 : finite(options.maxAttemptsPerSession)))),
        maxExchangeValueAtRisk: Math.max(0, finite(options.maxExchangeValueAtRisk) == null ? 100000 : finite(options.maxExchangeValueAtRisk)),
        maxCraftGoldCost: Math.max(0, finite(options.maxCraftGoldCost) == null ? 250000 : finite(options.maxCraftGoldCost)),
        maxCraftInputValueAtRisk: Math.max(0, finite(options.maxCraftInputValueAtRisk) == null ? 250000 : finite(options.maxCraftInputValueAtRisk)),
        goldReserve: Math.max(0, Math.floor(finite(options.goldReserve) == null ? 10000 : finite(options.goldReserve))),
        maxProductionDepth: Math.max(1, Math.min(12, Math.floor(finite(options.maxProductionDepth) == null ? 6 : finite(options.maxProductionDepth)))),
        allowQuestEvent: options.allowQuestEvent === true
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        productionPlans: 0,
        exchangeCandidates: 0,
        craftCandidates: 0,
        exchangesDispatched: 0,
        exchangesConfirmed: 0,
        exchangesRejected: 0,
        exchangesUnknown: 0,
        craftsDispatched: 0,
        craftsConfirmed: 0,
        craftsRejected: 0,
        craftsUnknown: 0,
        movementRequests: 0,
        movementBlocks: 0,
        budgetBlocks: 0,
        safetyBlocks: 0,
        materialDelegations: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H16_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('exchange-craft-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H16_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H16_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.attemptsThisSession = 0;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H16_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H16_POLICY_MUST_BE_OBJECT');
      const number = (key, min, max, integer = false) => {
        if (value[key] == null) return;
        const parsed = finite(value[key]);
        if (parsed == null) throw new Error('H16_POLICY_' + key.toUpperCase() + '_INVALID');
        this.config[key] = Math.max(min, Math.min(max, integer ? Math.floor(parsed) : parsed));
      };
      number('maxAttemptsPerSession', 1, 100, true);
      number('maxExchangeValueAtRisk', 0, Number.MAX_SAFE_INTEGER);
      number('maxCraftGoldCost', 0, Number.MAX_SAFE_INTEGER);
      number('maxCraftInputValueAtRisk', 0, Number.MAX_SAFE_INTEGER);
      number('goldReserve', 0, Number.MAX_SAFE_INTEGER, true);
      number('maxProductionDepth', 1, 12, true);
      if (value.allowQuestEvent != null) this.config.allowQuestEvent = value.allowQuestEvent === true;
      return clone(this.config);
    }

    _snapshot() {
      try { return this.game && this.game.snapshot ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _inventory() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _bankSnapshot() {
      try { return this.game && this.game.bankSnapshot ? this.game.bankSnapshot() : null; }
      catch (_) { return null; }
    }

    _definition(name) {
      try { return this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null; }
      catch (_) { return null; }
    }

    _recipe(name) {
      try { return this.game && this.game.craftDefinition ? this.game.craftDefinition(name) : null; }
      catch (_) { return null; }
    }

    _recipes() {
      try { return this.game && this.game.craftCatalog ? this.game.craftCatalog() : []; }
      catch (_) { return []; }
    }

    _combatActive() {
      try {
        const status = this.combat && this.combat.status ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _localReady() {
      const snap = this._snapshot();
      if (!snap || !snap.available || !snap.character) return { ok: false, reason: 'H16_CHARACTER_UNAVAILABLE' };
      if (snap.character.rip === true) return { ok: false, reason: 'H16_CHARACTER_DEAD' };
      if (this._combatActive()) return { ok: false, reason: 'H16_COMBAT_ACTIVE' };
      return { ok: true, snapshot: snap };
    }

    _safeItem(row) {
      return !!(row && row.name && row.locked !== true && row.giveaway !== true && row.gift !== true && !row.expiresAt);
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return [
        String(row.name),
        String(Math.max(0, Number(row.level) || 0)),
        cleanText(row.statType != null ? row.statType : row.stat_type || '', 80),
        stableProperty(row.property != null ? row.property : row.p)
      ].join('|');
    }

    _quantity(inventory, name, level = 0) {
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || []).reduce((sum, row) =>
        String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)
          ? sum + Math.max(1, Math.floor(Number(row.quantity) || 1))
          : sum, 0);
    }

    _bankQuantity(bank, name, level = 0) {
      if (!bank || bank.available === false) return 0;
      let total = 0;
      for (const pack of bank.packs || []) {
        for (const row of pack.items || []) {
          if (String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)) {
            total += Math.max(1, Math.floor(Number(row.quantity) || 1));
          }
        }
      }
      return total;
    }

    _rowAt(inventory, slot) {
      return inventory && (inventory.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _itemValue(name, level = 0) {
      const definition = this._definition(name);
      const base = definition && finite(definition.g);
      if (base == null) return null;
      return Math.round(Math.max(0, base) * Math.pow(1.75, Math.max(0, Number(level) || 0)));
    }

    _questEvent(definition, recipe = null) {
      return !!(definition && definition.quest === true || recipe && recipe.quest);
    }

    exchangeCandidates(options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return [];
      const allowQuestEvent = options.allowQuestEvent === true || this.config.allowQuestEvent;
      const out = [];
      for (const row of inventory.items || []) {
        if (!this._safeItem(row)) continue;
        const definition = this._definition(row.name);
        const required = definition && finite(definition.e);
        if (!definition || required == null || required <= 0 || !Number.isInteger(required)) continue;
        if (definition.cash === true) continue;
        const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
        if (quantity < required) continue;
        const unitValue = this._itemValue(row.name, row.level);
        const valueAtRisk = unitValue == null ? null : unitValue * required;
        const questEvent = this._questEvent(definition);
        const budgetOk = valueAtRisk != null && valueAtRisk <= this.config.maxExchangeValueAtRisk;
        out.push({
          kind: 'EXCHANGE',
          item: clone(row),
          inventorySlot: Number(row.slot),
          itemName: row.name,
          level: Math.max(0, Number(row.level) || 0),
          fingerprint: this._fingerprint(row),
          requiredQuantity: required,
          availableQuantity: quantity,
          valueAtRisk,
          questEvent,
          requiresExplicitQuestEvent: questEvent && !allowQuestEvent,
          safe: budgetOk && (!questEvent || allowQuestEvent),
          reason: valueAtRisk == null
            ? 'H16_EXCHANGE_VALUE_UNAVAILABLE'
            : !budgetOk
              ? 'H16_EXCHANGE_VALUE_OVER_BUDGET'
              : questEvent && !allowQuestEvent
                ? 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN'
                : 'H16_EXCHANGE_READY'
        });
      }
      out.sort((a, b) =>
        (a.safe === b.safe ? 0 : a.safe ? -1 : 1)
        || Number(a.valueAtRisk == null ? Number.MAX_SAFE_INTEGER : a.valueAtRisk)
          - Number(b.valueAtRisk == null ? Number.MAX_SAFE_INTEGER : b.valueAtRisk)
        || a.inventorySlot - b.inventorySlot);
      return out;
    }

    _craftSource(recipe, inventory, options = {}) {
      if (!recipe || !Array.isArray(recipe.items) || !recipe.items.length) return { ok: false, reason: 'H16_CRAFT_RECIPE_INVALID' };
      const allowQuestEvent = options.allowQuestEvent === true || this.config.allowQuestEvent;
      if (recipe.quest && !allowQuestEvent) return { ok: false, reason: 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN' };
      const sources = [];
      let inputValueAtRisk = 0;
      for (const ingredient of recipe.items) {
        const required = Math.max(1, Math.floor(Number(ingredient.quantity) || 1));
        const level = Math.max(0, Number(ingredient.level) || 0);
        const matching = (inventory.items || [])
          .filter(row => String(row.name) === String(ingredient.name)
            && Math.max(0, Number(row.level) || 0) === level
            && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= required)
          .sort((a, b) => Number(a.slot) - Number(b.slot));
        const first = matching[0];
        if (!first) return { ok: false, reason: 'H16_CRAFT_MATERIAL_MISSING', ingredient: clone(ingredient) };
        if (!this._safeItem(first)) return { ok: false, reason: 'H16_CRAFT_AUTO_SOURCE_PROTECTED', ingredient: clone(ingredient), slot: first.slot };
        const unitValue = this._itemValue(ingredient.name, level);
        if (unitValue == null) return { ok: false, reason: 'H16_CRAFT_INPUT_VALUE_UNAVAILABLE', ingredient: clone(ingredient) };
        inputValueAtRisk += unitValue * required;
        sources.push({
          slot: Number(first.slot),
          name: first.name,
          level,
          requiredQuantity: required,
          fingerprint: this._fingerprint(first)
        });
      }
      const cost = Math.max(0, finite(recipe.cost) || 0);
      if (cost > this.config.maxCraftGoldCost) return { ok: false, reason: 'H16_CRAFT_GOLD_COST_OVER_BUDGET', cost, inputValueAtRisk };
      if (inputValueAtRisk > this.config.maxCraftInputValueAtRisk) {
        return { ok: false, reason: 'H16_CRAFT_INPUT_VALUE_OVER_BUDGET', cost, inputValueAtRisk };
      }
      const snap = this._snapshot();
      const gold = snap && snap.character && finite(snap.character.gold);
      if (gold == null || gold - cost < this.config.goldReserve) {
        return { ok: false, reason: 'H16_CRAFT_GOLD_RESERVE_BLOCKED', cost, gold, reserve: this.config.goldReserve };
      }
      return { ok: true, sources, cost, inputValueAtRisk };
    }

    craftCandidates(options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return [];
      const out = [];
      for (const recipe of this._recipes()) {
        const source = this._craftSource(recipe, inventory, options);
        const definition = this._definition(recipe.name);
        out.push({
          kind: 'CRAFT',
          itemName: recipe.name,
          recipe: clone(recipe),
          definition: clone(definition),
          questEvent: !!recipe.quest,
          safe: source.ok === true,
          reason: source.reason || 'H16_CRAFT_READY',
          sources: source.sources || [],
          cost: source.cost == null ? Math.max(0, finite(recipe.cost) || 0) : source.cost,
          inputValueAtRisk: source.inputValueAtRisk == null ? null : source.inputValueAtRisk,
          exchangeableOutput: !!(definition && finite(definition.e) != null && finite(definition.e) > 0)
        });
      }
      out.sort((a, b) =>
        (a.safe === b.safe ? 0 : a.safe ? -1 : 1)
        || Number(a.cost || 0) - Number(b.cost || 0)
        || String(a.itemName).localeCompare(String(b.itemName)));
      return out;
    }

    _stockMap(options = {}) {
      const map = new Map();
      const add = (name, level, quantity) => {
        const key = String(name) + '|' + Math.max(0, Number(level) || 0);
        map.set(key, (map.get(key) || 0) + Math.max(0, Math.floor(Number(quantity) || 0)));
      };
      const inventory = this._inventory();
      if (inventory && inventory.available !== false) {
        for (const row of inventory.items || []) add(row.name, row.level, Math.max(1, Number(row.quantity) || 1));
      }
      if (options.includeBank !== false) {
        const bank = this._bankSnapshot();
        if (bank && bank.available !== false) {
          for (const pack of bank.packs || []) {
            for (const row of pack.items || []) add(row.name, row.level, Math.max(1, Number(row.quantity) || 1));
          }
        }
      }
      return map;
    }

    _bankMaterialRows(name, level = 0) {
      const bank = this._bankSnapshot();
      if (!bank || bank.available === false) return [];
      let reservations = {};
      try {
        const status = this.bank && typeof this.bank.status === 'function' ? this.bank.status() : null;
        reservations = status && status.reservations && typeof status.reservations === 'object'
          ? status.reservations
          : {};
      } catch (_) {}
      const wantedLevel = Math.max(0, Number(level) || 0);
      const rows = [];
      for (const pack of bank.packs || []) {
        for (const row of pack.items || []) {
          if (String(row.name) !== String(name)
              || Math.max(0, Number(row.level) || 0) !== wantedLevel) continue;
          rows.push({
            pack: pack.name,
            map: pack.map || null,
            slot: row.slot,
            quantity: Math.max(1, Number(row.quantity) || 1),
            fingerprint: this._fingerprint(row),
            safe: this._safeItem(row),
            locked: row.locked === true,
            giveaway: row.giveaway === true,
            gift: row.gift === true,
            expiresAt: row.expiresAt == null ? null : row.expiresAt
          });
        }
      }
      const reservedQuantity = Math.max(0, Math.floor(Number(reservations[name]) || 0));
      const totals = new Map();
      for (const row of rows) {
        const key = String(row.fingerprint || '');
        totals.set(key, (totals.get(key) || 0) + row.quantity);
      }
      return rows.map(row => {
        const fingerprintQuantity = totals.get(String(row.fingerprint || '')) || 0;
        const remainingAfterWholeStack = Math.max(0, fingerprintQuantity - row.quantity);
        const mountedMapMatch = !!(row.map && bank.map && String(row.map) === String(bank.map));
        return {
          ...row,
          reservedQuantity,
          fingerprintQuantity,
          remainingAfterWholeStack,
          mountedMapMatch,
          withdrawable: row.safe === true
            && mountedMapMatch
            && remainingAfterWholeStack >= reservedQuantity
        };
      });
    }

    _materialSource(name, level, quantity) {
      const bankRows = this._bankMaterialRows(name, level);
      let npcSources = [];
      try { npcSources = this.game && this.game.npcShopSources ? this.game.npcShopSources(name) || [] : []; } catch (_) {}
      let market = null;
      try { market = this.trade && this.trade.marketAnalysis ? this.trade.marketAnalysis(name, { level }) : null; } catch (_) {}
      return {
        itemName: name,
        level,
        quantity,
        bankRows: clone(bankRows),
        npcSources: clone(npcSources),
        npcPrice: finite(this._definition(name) && this._definition(name).g),
        bestMarketAsk: market && market.bestAsk ? clone(market.bestAsk) : null
      };
    }

    productionPlan(itemName, quantity = 1, options = {}) {
      this.metrics.productionPlans += 1;
      const targetName = cleanText(itemName || '', 160);
      const targetQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
      if (!targetName) return { state: 'BLOCKED', reason: 'H16_PRODUCTION_TARGET_REQUIRED' };
      const stock = this._stockMap(options);
      const stages = [];
      const missing = new Map();
      const protectedRecipes = [];
      let totalCraftGold = 0;
      const maxDepth = this.config.maxProductionDepth;
      const allowQuestEvent = options.allowQuestEvent === true || this.config.allowQuestEvent;

      const consume = (name, level, needed) => {
        const key = String(name) + '|' + Math.max(0, Number(level) || 0);
        const available = stock.get(key) || 0;
        const used = Math.min(available, needed);
        if (used > 0) stock.set(key, available - used);
        return needed - used;
      };

      const ensure = (name, level, needed, depth, path, allowStock = true) => {
        let remaining = allowStock ? consume(name, level, needed) : needed;
        if (remaining <= 0) return;
        if (depth > maxDepth || path.includes(name) || level > 0) {
          const key = String(name) + '|' + Math.max(0, Number(level) || 0);
          missing.set(key, (missing.get(key) || 0) + remaining);
          return;
        }
        const recipe = this._recipe(name);
        if (!recipe) {
          const key = String(name) + '|' + Math.max(0, Number(level) || 0);
          missing.set(key, (missing.get(key) || 0) + remaining);
          return;
        }
        if (recipe.quest && !allowQuestEvent) {
          protectedRecipes.push({ name, quest: recipe.quest, quantity: remaining });
          return;
        }
        const runs = remaining;
        for (const ingredient of recipe.items || []) {
          ensure(
            ingredient.name,
            Math.max(0, Number(ingredient.level) || 0),
            Math.max(1, Math.floor(Number(ingredient.quantity) || 1)) * runs,
            depth + 1,
            path.concat([name]),
            true
          );
        }
        const cost = Math.max(0, finite(recipe.cost) || 0) * runs;
        totalCraftGold += cost;
        stages.push({
          itemName: name,
          runs,
          cost,
          quest: recipe.quest || null,
          ingredients: clone(recipe.items || [])
        });
      };

      ensure(targetName, 0, targetQuantity, 0, [], false);
      const missingRows = Array.from(missing.entries()).map(([key, q]) => {
        const split = key.lastIndexOf('|');
        const name = key.slice(0, split);
        const level = Number(key.slice(split + 1)) || 0;
        return this._materialSource(name, level, q);
      });

      const snapshot = this._snapshot();
      const liveGold = snapshot && snapshot.character ? finite(snapshot.character.gold) : null;
      const craftCostOverBudget = totalCraftGold > this.config.maxCraftGoldCost * Math.max(1, targetQuantity);
      const goldUnavailable = liveGold == null;
      const goldReserveBlocked = liveGold != null && liveGold - totalCraftGold < this.config.goldReserve;
      const state = protectedRecipes.length
        ? 'BLOCKED'
        : missingRows.length
          ? 'NEEDS_MATERIALS'
          : craftCostOverBudget || goldUnavailable || goldReserveBlocked
            ? 'BLOCKED'
            : 'READY';
      const reason = protectedRecipes.length
        ? 'H16_PRODUCTION_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN'
        : missingRows.length
          ? 'H16_PRODUCTION_NEEDS_MATERIALS'
          : craftCostOverBudget
            ? 'H16_PRODUCTION_COST_OVER_BUDGET'
            : goldUnavailable
              ? 'H16_PRODUCTION_GOLD_UNAVAILABLE'
              : goldReserveBlocked
                ? 'H16_PRODUCTION_GOLD_RESERVE_BLOCKED'
                : 'H16_PRODUCTION_READY';

      return {
        state,
        reason,
        target: { itemName: targetName, quantity: targetQuantity },
        includeBank: options.includeBank !== false,
        allowQuestEvent,
        maxDepth,
        stages,
        missing: missingRows,
        protectedRecipes,
        totalCraftGold,
        gold: liveGold,
        goldReserve: this.config.goldReserve
      };
    }

    plan() {
      this.metrics.plans += 1;
      const exchangeCandidates = this.exchangeCandidates();
      const craftCandidates = this.craftCandidates();
      this.metrics.exchangeCandidates = exchangeCandidates.length;
      this.metrics.craftCandidates = craftCandidates.length;
      this.lastPlan = {
        state: 'READY',
        reason: 'H16_PLAN_READY',
        exchangeCandidates,
        craftCandidates,
        requestActive: !!this.request,
        pendingActive: !!this.pending,
        policy: clone(this.config)
      };
      return clone(this.lastPlan);
    }

    _queue(request) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H16_BUSY' };
      if (this.attemptsThisSession >= this.config.maxAttemptsPerSession) {
        this.metrics.budgetBlocks += 1;
        return { accepted: false, reason: 'H16_SESSION_ATTEMPT_BUDGET_EXHAUSTED' };
      }
      this.request = {
        id: 'h16-request-' + (++this.sequence),
        createdAt: nowIso(),
        travelRequested: false,
        travelStartedAtMs: null,
        ...clone(request)
      };
      this.lastAction = { at: nowIso(), type: request.kind + '_QUEUED', requestId: this.request.id };
      return { accepted: true, request: clone(this.request) };
    }

    queueExchange(inventorySlot, options = {}) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { accepted: false, reason: 'H16_INVENTORY_UNAVAILABLE' };
      const slot = finite(inventorySlot);
      if (slot == null) return { accepted: false, reason: 'H16_EXCHANGE_SLOT_REQUIRED' };
      const candidate = this.exchangeCandidates({ allowQuestEvent: options.allowQuestEvent === true })
        .find(row => Number(row.inventorySlot) === Number(slot));
      if (!candidate) return { accepted: false, reason: 'H16_EXCHANGE_CANDIDATE_UNAVAILABLE' };
      if (!candidate.safe) {
        if (String(candidate.reason).includes('BUDGET') || String(candidate.reason).includes('VALUE')) this.metrics.budgetBlocks += 1;
        else this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: candidate.reason };
      }
      const destination = this.game && this.game.npcLocation ? this.game.npcLocation('exchange') : null;
      if (!destination) return { accepted: false, reason: 'H16_EXCHANGE_NPC_LOCATION_UNAVAILABLE' };
      return this._queue({
        kind: 'EXCHANGE',
        inventorySlot: candidate.inventorySlot,
        itemName: candidate.itemName,
        level: candidate.level,
        fingerprint: candidate.fingerprint,
        requiredQuantity: candidate.requiredQuantity,
        valueAtRisk: candidate.valueAtRisk,
        questEvent: candidate.questEvent,
        allowQuestEvent: options.allowQuestEvent === true,
        destination: clone(destination)
      });
    }

    queueCraft(itemName, options = {}) {
      const name = cleanText(itemName || '', 160);
      const inventory = this._inventory();
      if (!name || !inventory || inventory.available === false) return { accepted: false, reason: 'H16_CRAFT_TARGET_UNAVAILABLE' };
      const recipe = this._recipe(name);
      if (!recipe) return { accepted: false, reason: 'H16_CRAFT_RECIPE_UNAVAILABLE' };
      const source = this._craftSource(recipe, inventory, { allowQuestEvent: options.allowQuestEvent === true });
      if (!source.ok) {
        if (String(source.reason).includes('BUDGET') || String(source.reason).includes('VALUE') || String(source.reason).includes('GOLD')) this.metrics.budgetBlocks += 1;
        else this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: source.reason, details: clone(source) };
      }
      const destination = this.game && this.game.npcLocation ? this.game.npcLocation('craftsman') : null;
      if (!destination) return { accepted: false, reason: 'H16_CRAFT_NPC_LOCATION_UNAVAILABLE' };
      return this._queue({
        kind: 'CRAFT',
        itemName: name,
        recipe: clone(recipe),
        sources: clone(source.sources),
        cost: source.cost,
        inputValueAtRisk: source.inputValueAtRisk,
        questEvent: !!recipe.quest,
        allowQuestEvent: options.allowQuestEvent === true,
        destination: clone(destination)
      });
    }

    queueBest(kind = null) {
      const plan = this.plan();
      const wanted = kind == null ? null : String(kind).toUpperCase();
      if (wanted === 'EXCHANGE') {
        const candidate = (plan.exchangeCandidates || []).find(row => row.safe);
        return candidate ? this.queueExchange(candidate.inventorySlot) : { accepted: false, reason: 'H16_NO_SAFE_EXCHANGE_CANDIDATE' };
      }
      if (wanted === 'CRAFT') {
        const candidate = (plan.craftCandidates || []).find(row => row.safe);
        return candidate ? this.queueCraft(candidate.itemName) : { accepted: false, reason: 'H16_NO_SAFE_CRAFT_CANDIDATE' };
      }
      const craft = (plan.craftCandidates || []).find(row => row.safe);
      if (craft) return this.queueCraft(craft.itemName);
      const exchange = (plan.exchangeCandidates || []).find(row => row.safe);
      return exchange ? this.queueExchange(exchange.inventorySlot) : { accepted: false, reason: 'H16_NO_SAFE_CANDIDATE' };
    }

    queueMaterialAcquire(itemName, quantity = 1, options = {}) {
      const name = cleanText(itemName || '', 160);
      const rawQuantity = finite(quantity);
      if (!name) return { accepted: false, reason: 'H16_MATERIAL_NAME_REQUIRED' };
      if (rawQuantity == null || rawQuantity <= 0 || !Number.isInteger(rawQuantity)) {
        return { accepted: false, reason: 'H16_MATERIAL_QUANTITY_INVALID' };
      }
      const q = rawQuantity;

      let lastRecoverableBankReject = null;
      if (options.allowBank !== false && this.bank && typeof this.bank.queueWithdraw === 'function') {
        const recoverableBankReasons = new Set([
          'H12_WITHDRAW_WRONG_OR_UNKNOWN_BANK_MAP',
          'H12_BANK_RESERVATION_BLOCKED',
          'H12_WITHDRAW_ITEM_NOT_FOUND'
        ]);
        const bankRows = this._bankMaterialRows(name, options.level || 0)
          .filter(row => row.withdrawable === true && row.quantity >= q);
        for (const row of bankRows) {
          const result = this.bank.queueWithdraw(row.pack, row.slot);
          if (result && result.accepted) {
            this.metrics.materialDelegations += 1;
            return {
              ...clone(result),
              delegatedTo: 'bank',
              source: { pack: row.pack, map: row.map || null, slot: row.slot }
            };
          }
          const reason = result && result.reason || 'H16_BANK_WITHDRAW_REJECTED';
          if (!recoverableBankReasons.has(String(reason))) {
            return {
              ...clone(result || { accepted: false, reason }),
              delegatedTo: 'bank',
              source: { pack: row.pack, map: row.map || null, slot: row.slot }
            };
          }
          lastRecoverableBankReject = {
            ...clone(result || { accepted: false, reason }),
            delegatedTo: 'bank',
            source: { pack: row.pack, map: row.map || null, slot: row.slot }
          };
        }
      }

      if (this.trade && typeof this.trade.queueAcquire === 'function') {
        const maxUnitPrice = finite(options.maxUnitPrice);
        if (maxUnitPrice == null || maxUnitPrice <= 0) {
          return { accepted: false, reason: 'H16_MAX_UNIT_PRICE_REQUIRED_FOR_TRADE_ACQUISITION' };
        }
        const result = this.trade.queueAcquire(name, q, { maxUnitPrice, level: options.level || 0 });
        if (result && result.accepted) this.metrics.materialDelegations += 1;
        return { ...clone(result), delegatedTo: 'trade' };
      }

      if (lastRecoverableBankReject) return lastRecoverableBankReject;
      return { accepted: false, reason: 'H16_MATERIAL_ACQUISITION_UNAVAILABLE' };
    }

    _cancelOwnedMovement(reason) {
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'exchange-craft-h16') {
          this.movement.cancel(cleanText(reason, 180) || 'H16_CANCEL');
        }
      } catch (_) {}
    }

    _ensureTravel(request) {
      let movement = null;
      try { movement = this.movement && this.movement.status ? this.movement.status() : null; } catch (_) {}
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '') === 'exchange-craft-h16'
            && (!request.travelOrderId || String(movement.activeOrder.id) === String(request.travelOrderId))) {
          return { ready: false, waiting: true };
        }
        this.metrics.movementBlocks += 1;
        return { ready: false, waiting: true, reason: 'H16_MOVEMENT_OWNED_BY_OTHER' };
      }
      if (request.travelRequested) {
        const last = movement && movement.lastOrder || null;
        if (last && String(last.id || '') === String(request.travelOrderId || '')
            && String(last.owner || '') === 'exchange-craft-h16') {
          if (last.state === 'COMPLETED') return { ready: true };
          if (['CANCELLED', 'STUCK', 'UNKNOWN', 'FAILED_SAFE'].includes(String(last.state || ''))) {
            return this._suspend(request.kind, 'H16_MOVEMENT_' + String(last.state || 'UNKNOWN'));
          }
        }
        if (Date.now() - request.travelStartedAtMs > this.config.movementTimeoutMs) {
          return this._suspend(request.kind, 'H16_MOVEMENT_TIMEOUT');
        }
        return { ready: false, waiting: true, reason: 'H16_WAITING_FOR_ARRIVAL_EVIDENCE' };
      }
      if (!request.destination) return this._suspend(request.kind, 'H16_DESTINATION_UNAVAILABLE');
      if (!this.movement || typeof this.movement.smartMove !== 'function') {
        return this._suspend(request.kind, 'H16_MOVEMENT_UNAVAILABLE');
      }
      const moved = this.movement.smartMove(request.destination, { owner: 'exchange-craft-h16' });
      if (!moved || moved.accepted !== true || !moved.order || !moved.order.id) {
        this.metrics.movementBlocks += 1;
        return this._suspend(request.kind, moved && moved.reason || 'H16_MOVEMENT_REJECTED');
      }
      request.travelRequested = true;
      request.travelStartedAtMs = Date.now();
      request.travelOrderId = moved.order.id;
      this.metrics.movementRequests += 1;
      this.lastAction = { at: nowIso(), type: request.kind + '_MOVE_REQUESTED', destination: request.destination, orderId: request.travelOrderId };
      return { ready: false, waiting: true };
    }

    _metric(kind, suffix) {
      const prefix = kind === 'CRAFT' ? 'crafts' : 'exchanges';
      const key = prefix + suffix;
      if (Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.suspendedReason = cleanText(reason || ('H16_' + kind + '_UNKNOWN'), 300);
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(this.suspendedReason);
      this.lastAction = { at: nowIso(), type: kind + '_UNKNOWN', reason: this.suspendedReason };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _watch(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        pending.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.pending || this.pending.id !== pending.id) return;
        this.pending.settlement = 'RESOLVED';
        this.pending.response = response == null ? null : clone(response);
      }, error => {
        if (!this.pending || this.pending.id !== pending.id) return;
        this.pending.settlement = 'REJECTED';
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H16_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dispatch(request, inventory) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') return { accepted: false, reason: 'H16_ACTION_BOUNDARY_UNAVAILABLE' };
      let action = null;
      let args = null;
      const beforeGold = this._snapshot() && this._snapshot().character ? finite(this._snapshot().character.gold) : null;
      const pendingBase = {
        kind: request.kind,
        itemName: request.itemName,
        beforeGold
      };
      if (request.kind === 'EXCHANGE') {
        action = 'exchange';
        args = [request.inventorySlot];
        pendingBase.inventorySlot = request.inventorySlot;
        pendingBase.level = request.level;
        pendingBase.requiredQuantity = request.requiredQuantity;
        pendingBase.beforeSourceQuantity = this._quantity(inventory, request.itemName, request.level);
        pendingBase.valueAtRisk = request.valueAtRisk;
      } else if (request.kind === 'CRAFT') {
        action = 'auto_craft';
        args = [request.itemName];
        pendingBase.recipe = clone(request.recipe);
        pendingBase.sources = clone(request.sources);
        pendingBase.cost = request.cost;
        pendingBase.inputValueAtRisk = request.inputValueAtRisk;
        pendingBase.beforeOutputQuantity = this._quantity(inventory, request.itemName, 0);
        pendingBase.beforeIngredients = (request.recipe.items || []).map(ingredient => ({
          name: ingredient.name,
          level: Math.max(0, Number(ingredient.level) || 0),
          requiredQuantity: Math.max(1, Math.floor(Number(ingredient.quantity) || 1)),
          quantity: this._quantity(inventory, ingredient.name, ingredient.level || 0)
        }));
      } else {
        return { accepted: false, reason: 'H16_REQUEST_KIND_INVALID' };
      }

      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(request.kind, result.error && result.error.message || 'H16_DISPATCH_UNKNOWN');
        this._metric(request.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H16_ACTION_REJECTED' };
      }

      const now = Date.now();
      const pending = {
        id: 'h16-pending-' + (++this.sequence),
        ...pendingBase,
        requestId: request.id,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this.attemptsThisSession += 1;
      this._metric(request.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: request.kind + '_DISPATCHED', requestId: request.id };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _knownReject(pending, reason) {
      this.pending = null;
      this.request = null;
      this._metric(pending.kind, 'Rejected');
      this.lastAction = { at: nowIso(), type: pending.kind + '_REJECTED', reason: cleanText(reason || 'H16_ACTION_REJECTED', 300) };
      return true;
    }

    _confirmed(pending, details = {}) {
      this.pending = null;
      this.request = null;
      this._metric(pending.kind, 'Confirmed');
      this.lastAction = { at: nowIso(), type: pending.kind + '_CONFIRMED', ...clone(details) };
      return true;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) {
        if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H16_INVENTORY_UNAVAILABLE_DURING_OUTCOME');
        return false;
      }

      if (pending.kind === 'EXCHANGE') {
        const after = this._quantity(inventory, pending.itemName, pending.level || 0);
        if (after != null && pending.beforeSourceQuantity != null && after <= pending.beforeSourceQuantity - pending.requiredQuantity) {
          return this._confirmed(pending, {
            itemName: pending.itemName,
            evidence: 'EXCHANGE_SOURCE_QUANTITY_DELTA',
            reward: pending.response && pending.response.reward || null
          });
        }
      }

      if (pending.kind === 'CRAFT') {
        const output = this._quantity(inventory, pending.itemName, 0);
        const outputIncreased = output != null && pending.beforeOutputQuantity != null && output >= pending.beforeOutputQuantity + 1;
        const ingredientsConsumed = (pending.beforeIngredients || []).every(before => {
          const after = this._quantity(inventory, before.name, before.level);
          return after != null && before.quantity != null && after <= before.quantity - before.requiredQuantity;
        });
        const snap = this._snapshot();
        const gold = snap && snap.character ? finite(snap.character.gold) : null;
        const goldOk = Number(pending.cost || 0) <= 0
          || (gold != null && pending.beforeGold != null && gold <= pending.beforeGold - Number(pending.cost || 0));
        if (outputIncreased && ingredientsConsumed && goldOk) {
          return this._confirmed(pending, { itemName: pending.itemName, evidence: 'CRAFT_OUTPUT_AND_INPUT_DELTAS' });
        }
      }

      if (pending.response && (pending.response.failed === true || pending.response.success === false)) {
        return this._knownReject(pending, pending.response.reason || 'H16_ACTION_REJECTED');
      }
      if (pending.settlement === 'REJECTED') {
        return this._suspend(pending.kind, pending.error || 'H16_ACTION_REJECTED_WITHOUT_LIVE_OUTCOME');
      }
      if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H16_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      return false;
    }

    _revalidateExchange(request, inventory) {
      const row = this._rowAt(inventory, request.inventorySlot);
      if (!row || this._fingerprint(row) !== request.fingerprint) return { ok: false, reason: 'H16_EXCHANGE_SOURCE_CHANGED' };
      if (!this._safeItem(row)) return { ok: false, reason: 'H16_EXCHANGE_SOURCE_PROTECTED' };
      const definition = this._definition(row.name);
      const required = definition && finite(definition.e);
      if (required == null || required !== request.requiredQuantity) return { ok: false, reason: 'H16_EXCHANGE_DEFINITION_CHANGED' };
      if (Math.max(1, Number(row.quantity) || 1) < required) return { ok: false, reason: 'H16_EXCHANGE_QUANTITY_CHANGED' };
      if (definition.cash === true) return { ok: false, reason: 'H16_EXCHANGE_CASH_ITEM_BLOCKED' };
      if (this._questEvent(definition) && !(request.allowQuestEvent || this.config.allowQuestEvent)) {
        return { ok: false, reason: 'H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN' };
      }
      const value = this._itemValue(row.name, row.level);
      const risk = value == null ? null : value * required;
      if (risk == null || risk > this.config.maxExchangeValueAtRisk) return { ok: false, reason: 'H16_EXCHANGE_VALUE_OVER_BUDGET' };
      return { ok: true };
    }

    _revalidateCraft(request, inventory) {
      const recipe = this._recipe(request.itemName);
      if (!recipe || JSON.stringify(recipe.items || []) !== JSON.stringify(request.recipe.items || [])) {
        return { ok: false, reason: 'H16_CRAFT_RECIPE_CHANGED' };
      }
      const source = this._craftSource(recipe, inventory, { allowQuestEvent: request.allowQuestEvent === true });
      if (!source.ok) return { ok: false, reason: source.reason };
      const expected = (request.sources || []).map(row => row.slot).join(',');
      const current = (source.sources || []).map(row => row.slot).join(',');
      if (expected !== current) return { ok: false, reason: 'H16_CRAFT_AUTO_SOURCE_CHANGED' };
      return { ok: true };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H16_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();

      const gate = this._localReady();
      if (!gate.ok) {
        this.request = null;
        this._cancelOwnedMovement(gate.reason || 'H16_SAFETY_GATE_BLOCKED');
        this.metrics.safetyBlocks += 1;
        return { state: 'BLOCKED', reason: gate.reason };
      }
      if (this.attemptsThisSession >= this.config.maxAttemptsPerSession) {
        this.request = null;
        this.metrics.budgetBlocks += 1;
        return { state: 'BLOCKED', reason: 'H16_SESSION_ATTEMPT_BUDGET_EXHAUSTED' };
      }

      const travel = this._ensureTravel(request);
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (!travel || travel.ready !== true) return { state: 'WAITING_TRAVEL', reason: travel && travel.reason || 'H16_TRAVEL' };

      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return { state: 'BLOCKED', reason: 'H16_INVENTORY_UNAVAILABLE' };
      const valid = request.kind === 'EXCHANGE'
        ? this._revalidateExchange(request, inventory)
        : request.kind === 'CRAFT'
          ? this._revalidateCraft(request, inventory)
          : { ok: false, reason: 'H16_REQUEST_KIND_INVALID' };
      if (!valid.ok) {
        this.request = null;
        this.metrics.safetyBlocks += 1;
        this.lastAction = { at: nowIso(), type: request.kind + '_BLOCKED', reason: valid.reason };
        return { state: 'BLOCKED', reason: valid.reason };
      }
      return this._dispatch(request, inventory);
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        attemptsThisSession: this.attemptsThisSession,
        pending: clone(this.pending),
        request: clone(this.request),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.ExchangeCraftController = ExchangeCraftController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
