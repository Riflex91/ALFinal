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
    try { return JSON.stringify(value, Object.keys(value).sort()); }
    catch (_) { return String(value); }
  }

  class TradeController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.moduleActive = false;
      this.scope = null;
      this.suspendedReason = null;
      this.pending = null;
      this.request = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 6000)),
        npcRange: Math.max(80, Math.min(600, Number(options.npcRange) || 240)),
        movementTimeoutMs: Math.max(3000, Math.min(120000, Number(options.movementTimeoutMs) || 45000)),
        goldReserve: Math.max(0, Math.floor(Number(options.goldReserve) || 10000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        analyses: 0,
        acquisitionsPlanned: 0,
        npcBuysDispatched: 0,
        npcBuysConfirmed: 0,
        npcBuysRejected: 0,
        npcBuysUnknown: 0,
        npcSellsDispatched: 0,
        npcSellsConfirmed: 0,
        npcSellsRejected: 0,
        npcSellsUnknown: 0,
        marketBuysDispatched: 0,
        marketBuysConfirmed: 0,
        marketBuysRejected: 0,
        marketBuysUnknown: 0,
        marketSellsDispatched: 0,
        marketSellsConfirmed: 0,
        marketSellsRejected: 0,
        marketSellsUnknown: 0,
        priceBlocks: 0,
        safetyBlocks: 0,
        movementRequests: 0,
        movementUnknown: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H13_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('trade-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H13_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H13_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H13_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    _cancelOwnedMovement(reason) {
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'trade-h13') {
          this.movement.cancel(cleanText(reason, 180) || 'H13_CANCEL');
        }
      } catch (_) {}
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _inventorySnapshot() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _inventoryPlan() {
      try { return this.inventory && this.inventory.plan ? this.inventory.plan() : null; }
      catch (_) { return null; }
    }

    _marketSnapshot() {
      try { return this.game && this.game.marketSnapshot ? this.game.marketSnapshot() : null; }
      catch (_) { return null; }
    }

    _merchantReady() {
      const snap = this._snapshot();
      return !!(snap && snap.available && snap.character
        && String(snap.character.ctype || '').toLowerCase() === 'merchant'
        && snap.character.rip !== true);
    }

    _characterGold() {
      const snap = this._snapshot();
      return snap && snap.character ? finite(snap.character.gold) : null;
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

    _quantity(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _quantityByName(snapshot, name, level = 0) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)
          ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _safeSellRows() {
      const plan = this._inventoryPlan();
      if (!plan || plan.state !== 'READY') return [];
      return (plan.items || []).filter(row =>
        row && row.name
        && String(row.disposition || '').toUpperCase() === 'SELL'
        && row.locked !== true
        && row.giveaway !== true
        && row.gift !== true
        && !row.expiresAt
        && Math.max(0, Number(row.level) || 0) === 0
        && !(row.definition && (row.definition.quest === true || row.definition.upgrade === true || row.definition.compound === true))
      );
    }

    marketAnalysis(itemName = null, options = {}) {
      this.metrics.analyses += 1;
      const market = this._marketSnapshot();
      const wanted = cleanText(itemName || '', 160);
      const level = finite(options.level);
      if (!market || market.available === false) {
        return { available: false, reason: market && market.reason || 'H13_MARKET_UNAVAILABLE', asks: [], bids: [] };
      }
      const rows = (market.listings || []).filter(row => {
        if (row.giveaway) return false;
        if (wanted && String(row.name) !== wanted) return false;
        if (level != null && Number(row.level || 0) !== level) return false;
        return finite(row.price) != null && finite(row.price) > 0;
      });
      const asks = rows.filter(row => row.buying !== true).sort((a, b) => Number(a.price) - Number(b.price));
      const bids = rows.filter(row => row.buying === true).sort((a, b) => Number(b.price) - Number(a.price));
      return {
        available: true,
        itemName: wanted || null,
        level,
        asks: clone(asks),
        bids: clone(bids),
        bestAsk: asks[0] ? clone(asks[0]) : null,
        bestBid: bids[0] ? clone(bids[0]) : null,
        spread: asks[0] && bids[0] ? Number(asks[0].price) - Number(bids[0].price) : null
      };
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const inventory = this._inventorySnapshot();
      const market = this._marketSnapshot();
      const plan = {
        state: !snap || !snap.available || !snap.character
          ? 'BLOCKED'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'BLOCKED'
            : 'READY',
        reason: !snap || !snap.available || !snap.character
          ? 'CHARACTER_UNAVAILABLE'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'H13_REQUIRES_MERCHANT'
            : 'H13_READY',
        character: snap && snap.character ? {
          name: snap.character.name,
          ctype: snap.character.ctype,
          map: snap.character.map,
          gold: snap.character.gold
        } : null,
        inventory: inventory ? {
          available: inventory.available,
          freeSlots: inventory.freeSlots,
          usedSlots: inventory.usedSlots,
          capacity: inventory.capacity
        } : null,
        safeSellRows: clone(this._safeSellRows()),
        market: market ? {
          available: market.available,
          listingCount: (market.listings || []).length,
          sellerCount: (market.players || []).length
        } : null,
        goldReserve: this.config.goldReserve
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    queueNpcBuy(itemName, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const name = cleanText(itemName || '', 160);
      const q = finite(quantity);
      const maxUnitPrice = finite(options.maxUnitPrice);
      if (!name || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_BUY_QUANTITY_INVALID' };
      if (maxUnitPrice == null || maxUnitPrice <= 0) return { accepted: false, reason: 'H13_MAX_UNIT_PRICE_REQUIRED' };
      const definition = this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null;
      const unitPrice = definition && finite(definition.g);
      if (unitPrice == null || unitPrice <= 0) return { accepted: false, reason: 'H13_NPC_PRICE_UNAVAILABLE' };
      if (unitPrice > maxUnitPrice) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_NPC_PRICE_ABOVE_LIMIT', unitPrice, maxUnitPrice };
      }
      const sources = this.game && this.game.npcShopSources ? this.game.npcShopSources(name) : [];
      const source = (sources || []).find(row => row && row.location);
      if (!source) return { accepted: false, reason: 'H13_NPC_SOURCE_UNAVAILABLE' };
      const gold = this._characterGold();
      const totalCost = unitPrice * q;
      if (gold == null || gold - totalCost < this.config.goldReserve) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_GOLD_RESERVE_BLOCKED', gold, totalCost, reserve: this.config.goldReserve };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H13_INVENTORY_FULL_OR_UNAVAILABLE' };
      }
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'NPC_BUY',
        itemName: name,
        level: 0,
        quantity: q,
        unitPrice,
        maxUnitPrice,
        totalCost,
        npcId: source.npcId,
        location: clone(source.location),
        travelStartedAtMs: null,
        createdAt: nowIso()
      };
      this.metrics.acquisitionsPlanned += 1;
      return { accepted: true, request: clone(this.request) };
    }

    queueNpcSell(slot, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const wantedSlot = finite(slot);
      const q = finite(quantity);
      if (wantedSlot == null || q == null || q <= 0 || !Number.isInteger(q)) {
        return { accepted: false, reason: 'H13_SELL_ARGUMENT_INVALID' };
      }
      const row = this._safeSellRows().find(item => Number(item.slot) === wantedSlot);
      if (!row) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H13_SELL_ITEM_NOT_SAFE' };
      }
      if (q > Math.max(1, Math.floor(Number(row.quantity) || 1))) return { accepted: false, reason: 'H13_SELL_QUANTITY_UNAVAILABLE' };
      const npcId = cleanText(options.npcId || 'fancypots', 120);
      const location = this.game && this.game.npcLocation ? this.game.npcLocation(npcId) : null;
      if (!location) return { accepted: false, reason: 'H13_SELL_NPC_UNAVAILABLE' };
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'NPC_SELL',
        itemName: row.name,
        fingerprint: this._fingerprint(row),
        inventorySlot: Number(row.slot),
        quantity: q,
        npcId,
        location: clone(location),
        travelStartedAtMs: null,
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueMarketBuy(playerName, tradeSlot, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const name = cleanText(playerName || '', 120);
      const slot = cleanText(tradeSlot || '', 80);
      const q = finite(quantity);
      const maxUnitPrice = finite(options.maxUnitPrice);
      if (!name || !slot || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_MARKET_BUY_ARGUMENT_INVALID' };
      if (maxUnitPrice == null || maxUnitPrice <= 0) return { accepted: false, reason: 'H13_MAX_UNIT_PRICE_REQUIRED' };
      const analysis = this._marketSnapshot();
      const listing = analysis && (analysis.listings || []).find(row =>
        String(row.playerName) === name && String(row.slot) === slot);
      if (!listing || listing.buying === true || listing.giveaway) return { accepted: false, reason: 'H13_MARKET_ASK_NOT_AVAILABLE' };
      if (!listing.rid) return { accepted: false, reason: 'H13_MARKET_RID_UNAVAILABLE' };
      if (q > Math.max(1, Math.floor(Number(listing.quantity) || 1))) return { accepted: false, reason: 'H13_MARKET_QUANTITY_UNAVAILABLE' };
      const unitPrice = finite(listing.price);
      if (unitPrice == null || unitPrice <= 0 || unitPrice > maxUnitPrice) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_MARKET_PRICE_ABOVE_LIMIT', unitPrice, maxUnitPrice };
      }
      const gold = this._characterGold();
      const totalCost = unitPrice * q;
      if (gold == null || gold - totalCost < this.config.goldReserve) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_GOLD_RESERVE_BLOCKED', gold, totalCost, reserve: this.config.goldReserve };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H13_INVENTORY_FULL_OR_UNAVAILABLE' };
      }
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'MARKET_BUY',
        playerName: name,
        tradeSlot: slot,
        rid: String(listing.rid),
        itemName: listing.name,
        level: Number(listing.level) || 0,
        quantity: q,
        unitPrice,
        maxUnitPrice,
        totalCost,
        createdAt: nowIso()
      };
      this.metrics.acquisitionsPlanned += 1;
      return { accepted: true, request: clone(this.request) };
    }

    queueMarketSell(playerName, tradeSlot, quantity = 1, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H13_BUSY' };
      if (!this._merchantReady()) return { accepted: false, reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      const name = cleanText(playerName || '', 120);
      const slot = cleanText(tradeSlot || '', 80);
      const q = finite(quantity);
      const minUnitPrice = finite(options.minUnitPrice);
      if (!name || !slot || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_MARKET_SELL_ARGUMENT_INVALID' };
      if (minUnitPrice == null || minUnitPrice < 0) return { accepted: false, reason: 'H13_MIN_UNIT_PRICE_REQUIRED' };
      const market = this._marketSnapshot();
      const listing = market && (market.listings || []).find(row =>
        String(row.playerName) === name && String(row.slot) === slot);
      if (!listing || listing.buying !== true || listing.giveaway) return { accepted: false, reason: 'H13_MARKET_BID_NOT_AVAILABLE' };
      if (!listing.rid) return { accepted: false, reason: 'H13_MARKET_RID_UNAVAILABLE' };
      if (q > Math.max(1, Math.floor(Number(listing.quantity) || 1))) {
        return { accepted: false, reason: 'H13_MARKET_BID_QUANTITY_UNAVAILABLE' };
      }
      const unitPrice = finite(listing.price);
      if (unitPrice == null || unitPrice < minUnitPrice) {
        this.metrics.priceBlocks += 1;
        return { accepted: false, reason: 'H13_MARKET_BID_BELOW_LIMIT', unitPrice, minUnitPrice };
      }
      const sellRow = this._safeSellRows().find(row =>
        String(row.name) === String(listing.name)
        && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(listing.level) || 0)
        && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= q);
      if (!sellRow) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H13_MARKET_SELL_ITEM_NOT_SAFE_OR_AVAILABLE' };
      }
      this.request = {
        id: 'trade-request-' + (++this.sequence),
        kind: 'MARKET_SELL',
        playerName: name,
        tradeSlot: slot,
        rid: String(listing.rid),
        itemName: listing.name,
        fingerprint: this._fingerprint(sellRow),
        level: Number(listing.level) || 0,
        quantity: q,
        unitPrice,
        minUnitPrice,
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueAcquire(itemName, quantity = 1, options = {}) {
      const name = cleanText(itemName || '', 160);
      const q = finite(quantity);
      const maxUnitPrice = finite(options.maxUnitPrice);
      if (!name || q == null || q <= 0 || !Number.isInteger(q)) return { accepted: false, reason: 'H13_ACQUIRE_ARGUMENT_INVALID' };
      if (maxUnitPrice == null || maxUnitPrice <= 0) return { accepted: false, reason: 'H13_MAX_UNIT_PRICE_REQUIRED' };
      const definition = this.game && this.game.itemDefinition ? this.game.itemDefinition(name) : null;
      const npcPrice = definition && finite(definition.g);
      const sources = this.game && this.game.npcShopSources ? this.game.npcShopSources(name) : [];
      const npcAvailable = npcPrice != null && npcPrice > 0 && npcPrice <= maxUnitPrice && (sources || []).some(row => row.location);
      const analysis = this.marketAnalysis(name, { level: options.level == null ? 0 : options.level });
      const eligibleAsk = (analysis.asks || []).find(row =>
        Number(row.price) <= maxUnitPrice
        && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= q) || null;
      if (npcAvailable && (!eligibleAsk || npcPrice <= Number(eligibleAsk.price))) {
        return this.queueNpcBuy(name, q, { maxUnitPrice });
      }
      if (eligibleAsk) {
        return this.queueMarketBuy(eligibleAsk.playerName, eligibleAsk.slot, q, { maxUnitPrice });
      }
      this.metrics.priceBlocks += 1;
      return {
        accepted: false,
        reason: 'H13_NO_ACQUISITION_WITHIN_PRICE_LIMIT',
        npcPrice,
        bestAsk: clone(analysis.bestAsk),
        eligibleAsk: null
      };
    }

    _metric(kind, suffix) {
      const prefix = {
        NPC_BUY: 'npcBuys',
        NPC_SELL: 'npcSells',
        MARKET_BUY: 'marketBuys',
        MARKET_SELL: 'marketSells'
      }[kind];
      const key = prefix ? prefix + suffix : null;
      if (key && Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.pending = null;
      this.request = null;
      this.suspendedReason = cleanText(reason || 'H13_UNKNOWN', 240) || 'H13_UNKNOWN';
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
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H13_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dispatch(action, args, pendingBase) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H13_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(pendingBase.kind, result.error && result.error.message || 'H13_DISPATCH_UNKNOWN');
        this._metric(pendingBase.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H13_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'trade-pending-' + (++this.sequence),
        ...pendingBase,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this._metric(pending.kind, 'Dispatched');
      this.lastAction = { at: pending.dispatchedAt, type: pending.kind + '_DISPATCHED' };
      this._watch(result.value, pending);
      return { accepted: true, state: 'DISPATCHED', pending: clone(pending) };
    }

    _observed(pending) {
      const inventory = this._inventorySnapshot();
      const gold = this._characterGold();
      if (!inventory || inventory.available === false || gold == null) return false;

      if (pending.kind === 'NPC_BUY' || pending.kind === 'MARKET_BUY') {
        const afterQuantity = this._quantityByName(inventory, pending.itemName, pending.level || 0);
        return afterQuantity != null
          && afterQuantity >= pending.beforeQuantity + pending.quantity
          && gold <= pending.beforeGold - pending.totalCost;
      }

      if (pending.kind === 'NPC_SELL' || pending.kind === 'MARKET_SELL') {
        const afterQuantity = this._quantity(inventory, pending.fingerprint);
        return afterQuantity != null
          && afterQuantity <= pending.beforeQuantity - pending.quantity
          && gold > pending.beforeGold;
      }
      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.settlement === 'REJECTED') return this._suspend(pending.kind, pending.error || 'H13_ACTION_REJECTED');
      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Rejected');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H13_ACTION_REJECTED', 240)
        };
        return true;
      }
      if (this._observed(pending)) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Confirmed');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_CONFIRMED',
          itemName: pending.itemName,
          quantity: pending.quantity,
          unitPrice: pending.unitPrice == null ? null : pending.unitPrice,
          playerName: pending.playerName || null,
          tradeSlot: pending.tradeSlot || null
        };
        return true;
      }
      if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H13_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      return false;
    }

    _distanceTo(location) {
      const snap = this._snapshot();
      const c = snap && snap.character;
      if (!c || !location) return null;
      if (location.map && c.map && String(location.map) !== String(c.map)) return Infinity;
      const cx = finite(c.x), cy = finite(c.y), x = finite(location.x), y = finite(location.y);
      return cx == null || cy == null || x == null || y == null ? null : Math.hypot(cx - x, cy - y);
    }

    _ensureNpc(request) {
      const distance = this._distanceTo(request.location);
      if (distance != null && distance <= this.config.npcRange) return { ready: true };
      const now = Date.now();
      if (request.travelStartedAtMs != null && now - request.travelStartedAtMs >= this.config.movementTimeoutMs) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, 'H13_NPC_MOVEMENT_TIMEOUT');
      }
      let movement = null;
      try { movement = this.movement && this.movement.status ? this.movement.status() : null; } catch (_) {}
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '') === 'trade-h13') return { ready: false, waiting: true };
        return { ready: false, waiting: true, reason: 'H13_MOVEMENT_OWNED_BY_OTHER' };
      }
      if (request.travelStartedAtMs != null) return { ready: false, waiting: true };
      if (!this.movement || typeof this.movement.smartMove !== 'function') return this._suspend(request.kind, 'H13_MOVEMENT_UNAVAILABLE');
      const moved = this.movement.smartMove(request.location, { owner: 'trade-h13' });
      if (!moved || moved.accepted !== true) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, moved && moved.reason || 'H13_NPC_MOVE_REJECTED');
      }
      request.travelStartedAtMs = now;
      this.metrics.movementRequests += 1;
      this.lastAction = { at: nowIso(), type: 'NPC_MOVE_REQUESTED', npcId: request.npcId };
      return { ready: false, waiting: true };
    }

    _marketListingStillMatches(request, buying) {
      const market = this._marketSnapshot();
      if (!market || market.available === false) return null;
      return (market.listings || []).find(row =>
        String(row.playerName) === String(request.playerName)
        && String(row.slot) === String(request.tradeSlot)
        && String(row.rid || '') === String(request.rid || '')
        && row.buying === buying
        && String(row.name) === String(request.itemName)
        && Number(row.price) === Number(request.unitPrice)
      ) || null;
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H13_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();
      if (!this._merchantReady()) {
        this.request = null;
        return { state: 'BLOCKED', reason: 'H13_REQUIRES_LIVE_MERCHANT' };
      }

      if (request.kind === 'NPC_BUY' || request.kind === 'NPC_SELL') {
        const near = this._ensureNpc(request);
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        if (!near || near.ready !== true) return { state: 'WAITING_NPC', reason: near && near.reason || 'H13_NPC_TRAVEL' };
      }

      const inventory = this._inventorySnapshot();
      const beforeGold = this._characterGold();
      if (!inventory || inventory.available === false || beforeGold == null) return { state: 'BLOCKED', reason: 'H13_OBSERVATION_UNAVAILABLE' };

      if (request.kind === 'NPC_BUY') {
        const beforeQuantity = this._quantityByName(inventory, request.itemName, request.level || 0);
        if (beforeQuantity == null) return { state: 'BLOCKED', reason: 'H13_INVENTORY_OBSERVATION_UNAVAILABLE' };
        return this._dispatch('buy_with_gold', [request.itemName, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          level: request.level || 0,
          quantity: request.quantity,
          unitPrice: request.unitPrice,
          totalCost: request.totalCost,
          beforeQuantity,
          beforeGold
        });
      }

      if (request.kind === 'NPC_SELL') {
        const current = (inventory.items || []).find(row => Number(row.slot) === Number(request.inventorySlot));
        if (!current || this._fingerprint(current) !== request.fingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H13_SELL_SOURCE_CHANGED' };
        }
        const beforeQuantity = this._quantity(inventory, request.fingerprint);
        return this._dispatch('sell', [request.inventorySlot, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          fingerprint: request.fingerprint,
          quantity: request.quantity,
          beforeQuantity,
          beforeGold
        });
      }

      if (request.kind === 'MARKET_BUY') {
        const listing = this._marketListingStillMatches(request, false);
        if (!listing
          || Number(listing.price) > Number(request.maxUnitPrice)
          || Math.max(1, Math.floor(Number(listing.quantity) || 1)) < request.quantity) {
          this.request = null;
          this.metrics.priceBlocks += 1;
          return { state: 'BLOCKED', reason: 'H13_MARKET_ASK_CHANGED' };
        }
        const target = this.game && this.game.playerReference ? this.game.playerReference(request.playerName) : null;
        if (!target || !target.slots || !target.slots[request.tradeSlot]) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H13_MARKET_TARGET_UNAVAILABLE' };
        }
        const beforeQuantity = this._quantityByName(inventory, request.itemName, request.level || 0);
        return this._dispatch('trade_buy', [target, request.tradeSlot, request.rid, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          level: request.level || 0,
          playerName: request.playerName,
          tradeSlot: request.tradeSlot,
          rid: request.rid,
          quantity: request.quantity,
          unitPrice: request.unitPrice,
          totalCost: request.totalCost,
          beforeQuantity,
          beforeGold
        });
      }

      if (request.kind === 'MARKET_SELL') {
        const listing = this._marketListingStillMatches(request, true);
        if (!listing
          || Number(listing.price) < Number(request.minUnitPrice)
          || Math.max(1, Math.floor(Number(listing.quantity) || 1)) < request.quantity) {
          this.request = null;
          this.metrics.priceBlocks += 1;
          return { state: 'BLOCKED', reason: 'H13_MARKET_BID_CHANGED' };
        }
        const target = this.game && this.game.playerReference ? this.game.playerReference(request.playerName) : null;
        if (!target || !target.slots || !target.slots[request.tradeSlot]) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H13_MARKET_TARGET_UNAVAILABLE' };
        }
        const beforeQuantity = this._quantity(inventory, request.fingerprint);
        return this._dispatch('trade_sell', [target, request.tradeSlot, request.rid, request.quantity], {
          kind: request.kind,
          itemName: request.itemName,
          fingerprint: request.fingerprint,
          playerName: request.playerName,
          tradeSlot: request.tradeSlot,
          rid: request.rid,
          quantity: request.quantity,
          unitPrice: request.unitPrice,
          beforeQuantity,
          beforeGold
        });
      }

      this.request = null;
      return { state: 'BLOCKED', reason: 'H13_REQUEST_UNKNOWN' };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        request: clone(this.request),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.TradeController = TradeController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
