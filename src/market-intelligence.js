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

  function median(values) {
    const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!rows.length) return null;
    const middle = Math.floor(rows.length / 2);
    return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
  }

  function percentile(values, p) {
    const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!rows.length) return null;
    const index = Math.max(0, Math.min(rows.length - 1, Math.round((rows.length - 1) * p)));
    return rows[index];
  }

  class ALDataMarketIntelligence {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.storage = options.storage || null;
      this.game = options.game || null;
      this.trade = options.trade || null;
      this.baseUrl = 'https://aldata.earthiverse.ca';
      this.moduleActive = false;
      this.scope = null;
      this.snapshot = null;
      this.history = {};
      this.lastError = null;
      this.config = {
        refreshMs: Math.max(60000, Math.min(3600000, Number(options.refreshMs) || 300000)),
        historyDays: Math.max(7, Math.min(365, Number(options.historyDays) || 90)),
        maxHistoryPerItem: Math.max(24, Math.min(2000, Number(options.maxHistoryPerItem) || 480)),
        externalMaxAgeMs: Math.max(3600000, Math.min(30 * 86400000, Number(options.externalMaxAgeMs) || 7 * 86400000))
      };
      this._loadHistory();
    }

    _key() { return 'albot:market-intelligence-history:v1'; }

    _loadHistory() {
      if (!this.storage || typeof this.storage.get !== 'function') return;
      try {
        const raw = this.storage.get(this._key());
        const value = raw ? JSON.parse(raw) : null;
        this.history = value && typeof value.items === 'object' ? value.items : {};
      } catch (_) { this.history = {}; }
    }

    _saveHistory() {
      if (!this.storage || typeof this.storage.set !== 'function') return;
      try { this.storage.set(this._key(), JSON.stringify({ schemaVersion: 1, items: this.history })); } catch (_) {}
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('aldata-market-refresh', () => this.refresh(), this.config.refreshMs, { immediate: true });
      }
      return this.status();
    }

    stop() {
      this.moduleActive = false;
      this.scope = null;
      return this.status();
    }

    _timestamp(raw, fallbackMs) {
      for (const key of ['lastSeen', 'last_seen', 'updatedAt', 'updated_at', 'lastUpdate', 'lastUpdated', 'date', 'timestamp']) {
        const value = raw && raw[key];
        if (value == null) continue;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 1000000000) return numeric < 100000000000 ? numeric * 1000 : numeric;
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) return parsed;
      }
      return fallbackMs;
    }

    _parseTrades(payload, fetchedAtMs) {
      const out = [];
      const owners = Array.isArray(payload) ? payload : [];
      for (const ownerRow of owners) {
        if (!ownerRow || typeof ownerRow !== 'object') continue;
        const owner = cleanText(ownerRow.owner || '', 120) || null;
        const seenAtMs = this._timestamp({ lastUpdated: ownerRow.lastUpdated }, fetchedAtMs);
        const listings = Array.isArray(ownerRow.listings) ? ownerRow.listings : [];
        for (const listing of listings) {
          if (!listing || typeof listing !== 'object') continue;
          const itemName = cleanText(listing.name || '', 160);
          if (!itemName) continue;
          const level = Math.max(0, Math.floor(finite(listing.level) || 0));
          const property = listing.p == null ? null : cleanText(listing.p, 80);
          for (const sideName of ['wts', 'wtb']) {
            const side = listing[sideName];
            if (!side || typeof side !== 'object') continue;
            const price = finite(side.price);
            if (price == null || price <= 0) continue;
            out.push({
              itemName,
              level,
              property,
              price,
              quantity: Math.max(1, Math.floor(finite(side.quantity) || 1)),
              buying: sideName === 'wtb',
              negotiable: side.priceNegotiable === true,
              owner,
              seenAtMs,
              source: 'aldata-trades'
            });
          }
        }
      }
      return out;
    }

    _localIdentity() {
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        try {
          if (current.character) {
            return {
              name: current.character.name == null ? null : String(current.character.name),
              owner: current.character.owner == null ? null : String(current.character.owner)
            };
          }
        } catch (_) {}
        try {
          if (current.parent && current.parent !== current) current = current.parent;
          else break;
        } catch (_) { break; }
      }
      return { name: null, owner: null };
    }

    _recordHistory(listings, fetchedAtMs) {
      const groups = new Map();
      for (const row of listings) {
        const key = row.itemName + '|' + String(row.level || 0);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const cutoff = fetchedAtMs - this.config.historyDays * 86400000;
      for (const [key, rows] of groups.entries()) {
        const asks = rows.filter(row => !row.buying).map(row => row.price);
        const bids = rows.filter(row => row.buying).map(row => row.price);
        const sample = {
          atMs: fetchedAtMs,
          asks: asks.length,
          bids: bids.length,
          askMedian: median(asks),
          bidMedian: median(bids),
          bestAsk: asks.length ? Math.min(...asks) : null,
          bestBid: bids.length ? Math.max(...bids) : null
        };
        const history = Array.isArray(this.history[key]) ? this.history[key] : [];
        history.push(sample);
        this.history[key] = history.filter(row => Number(row.atMs) >= cutoff).slice(-this.config.maxHistoryPerItem);
      }
      this._saveHistory();
    }

    async refresh() {
      if (!this.moduleActive) return { accepted: false, reason: 'MARKET_INTELLIGENCE_MODULE_NOT_ACTIVE' };
      const fetchFn = this.root && typeof this.root.fetch === 'function' ? this.root.fetch.bind(this.root) : null;
      if (!fetchFn) return { accepted: false, reason: 'MARKET_INTELLIGENCE_FETCH_UNAVAILABLE' };
      const fetchedAtMs = Date.now();
      try {
        const response = await fetchFn(this.baseUrl + '/trades', { method: 'GET', cache: 'no-store', credentials: 'omit' });
        if (!response || response.ok !== true) throw new Error('ALDATA_HTTP_' + String(response && response.status || 'FAILED'));
        const payload = await response.json();
        const listings = this._parseTrades(payload, fetchedAtMs);
        const deduped = [];
        const seen = new Set();
        let staleDropped = 0;
        for (const row of listings) {
          if (fetchedAtMs - Number(row.seenAtMs || 0) > this.config.externalMaxAgeMs) {
            staleDropped += 1;
            continue;
          }
          const key = [row.owner || '', row.itemName, row.level, row.property || '', row.price, row.quantity, row.buying].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(row);
        }
        this.snapshot = {
          schemaVersion: 2,
          fetchedAt: new Date(fetchedAtMs).toISOString(),
          fetchedAtMs,
          endpoint: this.baseUrl + '/trades',
          advisoryOnly: true,
          staleDropped,
          listings: deduped
        };
        this._recordHistory(deduped, fetchedAtMs);
        this.lastError = null;
        if (this.logger) this.logger.info('ALData Trades-Snapshot aktualisiert', { listings: deduped.length, staleDropped });
        return { accepted: true, listings: deduped.length, staleDropped, fetchedAt: this.snapshot.fetchedAt };
      } catch (error) {
        this.lastError = { at: new Date().toISOString(), reason: cleanText(error && error.message || error, 300) };
        if (this.logger) this.logger.warn('ALData Markt-Refresh fehlgeschlagen', this.lastError);
        return { accepted: false, reason: this.lastError.reason };
      }
    }

    _localMarket(itemName, level) {
      try {
        return this.trade && typeof this.trade.marketAnalysis === 'function'
          ? this.trade.marketAnalysis(itemName, { level })
          : null;
      } catch (_) { return null; }
    }

    item(itemName, options = {}) {
      const name = cleanText(itemName, 160);
      const level = Math.max(0, Math.floor(finite(options.level) || 0));
      if (!name) return { available: false, reason: 'MARKET_ITEM_REQUIRED' };
      const identity = this._localIdentity();
      const rows = this.snapshot && Array.isArray(this.snapshot.listings)
        ? this.snapshot.listings.filter(row => row.itemName === name
          && Number(row.level || 0) === level
          && (!identity.owner || !row.owner || String(row.owner) !== String(identity.owner))
          && (!identity.name || !row.owner || String(row.owner) !== String(identity.name)))
        : [];
      const asks = rows.filter(row => !row.buying).sort((a, b) => a.price - b.price);
      const bids = rows.filter(row => row.buying).sort((a, b) => b.price - a.price);
      const local = this._localMarket(name, level);
      const history = Array.isArray(this.history[name + '|' + level]) ? this.history[name + '|' + level] : [];
      const historicalAsks = history.map(row => row.askMedian).filter(Number.isFinite);
      return {
        available: !!this.snapshot,
        advisoryOnly: true,
        itemName: name,
        level,
        fetchedAt: this.snapshot && this.snapshot.fetchedAt || null,
        dataAgeMs: this.snapshot ? Math.max(0, Date.now() - this.snapshot.fetchedAtMs) : null,
        sampleCount: rows.length,
        bestAsk: asks[0] ? clone(asks[0]) : null,
        bestBid: bids[0] ? clone(bids[0]) : null,
        medianAsk: median(asks.map(row => row.price)),
        p25Ask: percentile(asks.map(row => row.price), 0.25),
        p75Ask: percentile(asks.map(row => row.price), 0.75),
        historicalMedianAsk: median(historicalAsks),
        localVisibleMarket: clone(local)
      };
    }

    priceBand(itemName, options = {}) {
      const level = Math.max(0, Math.floor(finite(options.level) || 0));
      const info = this.item(itemName, { level });
      const definition = this.game && typeof this.game.itemDefinition === 'function' ? this.game.itemDefinition(itemName) : null;
      const npcValue = finite(definition && definition.g);
      const floor = npcValue != null && npcValue > 0 ? Math.ceil(npcValue * 1.10) : null;
      const localAsk = finite(info.localVisibleMarket && info.localVisibleMarket.bestAsk && info.localVisibleMarket.bestAsk.price);
      const externalAsk = finite(info.bestAsk && info.bestAsk.price);
      const reference = localAsk || externalAsk || finite(info.medianAsk) || finite(info.historicalMedianAsk);
      let recommendedAsk = reference == null ? null : Math.max(1, Math.floor(reference - Math.max(1, reference * 0.002)));
      if (floor != null && recommendedAsk != null) recommendedAsk = Math.max(floor, recommendedAsk);
      return {
        ...info,
        npcValue,
        minimumSafeAsk: floor,
        recommendedAsk,
        confidence: localAsk != null ? 'LIVE_VISIBLE' : info.sampleCount >= 8 ? 'ALDATA_SAMPLE' : info.historicalMedianAsk != null ? 'HISTORY' : 'INSUFFICIENT',
        liveTruthRequiredBeforeMutation: true
      };
    }

    overview(limit = 40) {
      const rows = this.snapshot && Array.isArray(this.snapshot.listings) ? this.snapshot.listings : [];
      const counts = new Map();
      for (const row of rows) {
        const key = row.itemName + '|' + String(row.level || 0);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, Math.min(200, Number(limit) || 40)))
        .map(([key, samples]) => {
          const split = key.lastIndexOf('|');
          const itemName = key.slice(0, split);
          const level = Number(key.slice(split + 1)) || 0;
          return { ...this.priceBand(itemName, { level }), samples };
        });
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        provider: 'ALData',
        endpoint: this.baseUrl + '/trades',
        readOnly: true,
        advisoryOnly: true,
        fetchedAt: this.snapshot && this.snapshot.fetchedAt || null,
        dataAgeMs: this.snapshot ? Math.max(0, Date.now() - this.snapshot.fetchedAtMs) : null,
        listings: this.snapshot && this.snapshot.listings ? this.snapshot.listings.length : 0,
        staleDropped: this.snapshot && this.snapshot.staleDropped || 0,
        historyItems: Object.keys(this.history).length,
        lastError: clone(this.lastError),
        policies: {
          externalDataNeverProvesMutationSafety: true,
          localLiveListingRevalidatedByTradeController: true
        }
      };
    }
  }

  class MerchantStandController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.inventory = options.inventory || null;
      this.market = options.market || null;
      this.combat = options.combat || null;
      this.movement = options.movement || null;
      this.economy = options.economy || null;
      this.partyLogistics = options.partyLogistics || null;
      this.merchantAutonomy = options.merchantAutonomy || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : () => true;
      this.moduleActive = false;
      this.scope = null;
      this.autoManage = false;
      this.pending = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.config = {
        tickMs: 2000,
        maxListingsPerSession: 20,
        maxRepricesPerSession: 12,
        outcomeTimeoutMs: 7000,
        repriceMinDeltaRatio: 0.03,
        repriceMinDeltaGold: 100,
        repriceCooldownMs: 300000,
        maxRepriceStepRatio: 0.20
      };
      this.listingsThisSession = 0;
      this.repricesThisSession = 0;
      this.lastRepriceAtBySlot = new Map();
      this.autoOpenHoldUntilMs = 0;
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('merchant-stand-tick', () => this.tick(), this.config.tickMs, { immediate: false });
      }
      return this.status();
    }

    stop(reason = 'MERCHANT_STAND_MODULE_STOP') {
      this.autoManage = false;
      this.moduleActive = false;
      this.scope = null;
      this.lastAction = { at: new Date().toISOString(), type: 'STOP', reason: cleanText(reason, 180) };
      return this.status();
    }

    configure(options = {}) {
      if (options.autoManage != null) this.autoManage = options.autoManage === true;
      if (options.repriceMinDeltaRatio != null) {
        this.config.repriceMinDeltaRatio = Math.max(0.01, Math.min(0.5, Number(options.repriceMinDeltaRatio) || 0.03));
      }
      if (options.repriceCooldownMs != null) {
        this.config.repriceCooldownMs = Math.max(30000, Math.min(3600000, Number(options.repriceCooldownMs) || 300000));
      }
      return this.status();
    }

    resetSafety(reason = 'MERCHANT_STAND_EXPLICIT_RESET') {
      this.suspendedReason = null;
      this.pending = null;
      this.lastAction = { at: new Date().toISOString(), type: 'RESET', reason: cleanText(reason, 180) };
      return this.status();
    }

    _rawCharacter() {
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        try { if (current.character) return current.character; } catch (_) {}
        try {
          if (current.parent && current.parent !== current) current = current.parent;
          else break;
        } catch (_) { break; }
      }
      return null;
    }

    pauseAutoOpenForTravel(durationMs = 15000) {
      const ms = Math.max(1000, Math.min(120000, Number(durationMs) || 15000));
      this.autoOpenHoldUntilMs = Math.max(this.autoOpenHoldUntilMs, Date.now() + ms);
      return { paused: true, untilMs: this.autoOpenHoldUntilMs };
    }

    _standOpen(character) {
      return !!(character && (character.stand === true
        || character.stand != null && character.stand !== false
        || character.p && character.p.stand));
    }

    _safeSellRows() {
      const plan = this.inventory && typeof this.inventory.plan === 'function' ? this.inventory.plan() : null;
      return plan && Array.isArray(plan.items) ? plan.items.filter(row => row.disposition === 'SELL' && row.protected !== true) : [];
    }

    _explicitSellNames() {
      try {
        const rules = this.inventory && typeof this.inventory.ruleSnapshot === 'function' ? this.inventory.ruleSnapshot() : null;
        return new Set(Array.isArray(rules && rules.sellNames) ? rules.sellNames.map(String) : []);
      } catch (_) {
        return new Set();
      }
    }

    _emptyTradeSlot(character) {
      const slots = character && character.slots && typeof character.slots === 'object' ? character.slots : {};
      for (let index = 1; index <= 16; index += 1) {
        const key = 'trade' + index;
        if (!slots[key]) return { key, index };
      }
      return null;
    }

    _standItemSlot() {
      const inv = this.game && typeof this.game.inventorySnapshot === 'function' ? this.game.inventorySnapshot() : null;
      const row = inv && Array.isArray(inv.items) ? inv.items.find(item => item.name === 'stand0') : null;
      return row ? Number(row.slot) : null;
    }

    _inventorySnapshot() {
      return this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : null;
    }

    _busy() {
      const merchantWork = this.merchantAutonomy && this.merchantAutonomy.status ? this.merchantAutonomy.status() : null;
      if (merchantWork && merchantWork.exclusive === true) return 'MERCHANT_AUTONOMY_ACTIVE';
      const combat = this.combat && this.combat.status ? this.combat.status() : null;
      if (combat && combat.active) return 'COMBAT_ACTIVE';
      const movement = this.movement && this.movement.status ? this.movement.status() : null;
      if (movement && (movement.active || movement.activeOrder)) return 'MOVEMENT_ACTIVE';
      const economy = this.economy && this.economy.status ? this.economy.status() : null;
      if (economy && (economy.currentAction || economy.autonomyEnabled)) return 'ECONOMY_ACTIVE';
      const logistics = this.partyLogistics && this.partyLogistics.status ? this.partyLogistics.status() : null;
      if (logistics && (logistics.currentAction || logistics.autonomyEnabled)) return 'PARTY_LOGISTICS_ACTIVE';
      return null;
    }

    _actionableBand(band) {
      return !!(band && finite(band.recommendedAsk) != null && finite(band.recommendedAsk) > 0
        && ['LIVE_VISIBLE', 'ALDATA_SAMPLE'].includes(String(band.confidence || '')));
    }

    _sameProperty(a, b) {
      try { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
      catch (_) { return a == null && b == null; }
    }

    _safeExistingListing(slot, raw, sellNames) {
      if (!/^trade\d+$/.test(String(slot || '')) || !raw || !raw.name) return null;
      if (raw.b === true || raw.giveaway != null || raw.acl || raw.v || raw.l || raw.data != null || raw.expires != null || raw.gift) return null;
      const name = String(raw.name);
      if (!sellNames.has(name)) return null;
      const price = finite(raw.price);
      if (price == null || price <= 0 || !raw.rid) return null;
      return {
        tradeSlot: String(slot),
        tradeIndex: Math.max(1, Number(String(slot).replace('trade', '')) || 1),
        itemName: name,
        level: Math.max(0, Math.floor(finite(raw.level) || 0)),
        quantity: Math.max(1, Math.floor(finite(raw.q) || 1)),
        currentPrice: price,
        rid: String(raw.rid),
        statType: raw.stat_type == null ? null : String(raw.stat_type),
        property: raw.p == null ? null : clone(raw.p)
      };
    }

    _repriceCandidate(character) {
      if (this.repricesThisSession >= this.config.maxRepricesPerSession) return null;
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) return null;
      const sellNames = this._explicitSellNames();
      if (!sellNames.size) return null;
      const slots = character && character.slots && typeof character.slots === 'object' ? character.slots : {};
      const candidates = [];
      for (const [slot, raw] of Object.entries(slots)) {
        const listing = this._safeExistingListing(slot, raw, sellNames);
        if (!listing) continue;
        const lastAt = Number(this.lastRepriceAtBySlot.get(listing.tradeSlot) || 0);
        if (Date.now() - lastAt < this.config.repriceCooldownMs) continue;
        const band = this.market && typeof this.market.priceBand === 'function'
          ? this.market.priceBand(listing.itemName, { level: listing.level })
          : null;
        if (!this._actionableBand(band)) continue;
        const rawTarget = Math.max(1, Math.floor(Number(band.recommendedAsk)));
        const lowerStep = Math.max(1, Math.floor(listing.currentPrice * (1 - this.config.maxRepriceStepRatio)));
        const upperStep = Math.max(1, Math.ceil(listing.currentPrice * (1 + this.config.maxRepriceStepRatio)));
        const targetPrice = Math.max(lowerStep, Math.min(upperStep, rawTarget));
        const delta = Math.abs(targetPrice - listing.currentPrice);
        const threshold = Math.max(this.config.repriceMinDeltaGold, listing.currentPrice * this.config.repriceMinDeltaRatio);
        if (delta < threshold) continue;
        candidates.push({
          ...listing,
          kind: 'REPRICE',
          targetPrice,
          delta,
          deltaRatio: delta / listing.currentPrice,
          priceBand: clone(band)
        });
      }
      candidates.sort((a, b) => Number(b.deltaRatio) - Number(a.deltaRatio) || Number(b.delta) - Number(a.delta));
      return candidates[0] || null;
    }

    _findRelistInventorySlot(pending) {
      const inventory = this._inventorySnapshot();
      const items = inventory && Array.isArray(inventory.items) ? inventory.items : [];
      const matches = items.filter(item =>
        String(item.name || '') === String(pending.itemName || '')
        && Number(item.level || 0) === Number(pending.level || 0)
        && String(item.statType || '') === String(pending.statType || '')
        && this._sameProperty(item.property, pending.property)
        && Number(item.quantity || 1) >= Number(pending.quantity || 1)
        && item.locked !== true
        && item.giveaway !== true
      );
      matches.sort((a, b) => Number(a.quantity || 1) - Number(b.quantity || 1) || Number(a.slot) - Number(b.slot));
      return matches[0] || null;
    }

    _liveListing(character, tradeSlot) {
      return character && character.slots && character.slots[tradeSlot] || null;
    }

    _listingStillMatches(live, selected) {
      return !!(live
        && String(live.rid || '') === String(selected.rid || '')
        && String(live.name || '') === String(selected.itemName || '')
        && Number(live.level || 0) === Number(selected.level || 0)
        && Number(live.price || 0) === Number(selected.currentPrice || 0));
    }

    plan() {
      const character = this._rawCharacter();
      if (!character || String(character.ctype || '').toLowerCase() !== 'merchant') {
        return this.lastPlan = { state: 'BLOCKED', reason: 'MERCHANT_STAND_REQUIRES_MERCHANT', selected: null };
      }
      if (character.rip === true) return this.lastPlan = { state: 'BLOCKED', reason: 'CHARACTER_DEAD', selected: null };
      const busy = this._busy();
      if (busy) return this.lastPlan = { state: 'BLOCKED', reason: busy, selected: null };
      if (!this._standOpen(character)) {
        if (Date.now() < this.autoOpenHoldUntilMs) {
          return this.lastPlan = {
            state: 'IDLE', reason: 'MERCHANT_STAND_TRAVEL_HANDOFF_HOLD', selected: null
          };
        }
        // Do not reopen an empty stand between economy and traveling work.
        // A purposeful listing or existing trade order must justify opening.
        const listingAvailable = this._safeSellRows().some(row => {
          const band = this.market && typeof this.market.priceBand === 'function'
            ? this.market.priceBand(row.name, { level: Number(row.level) || 0 })
            : null;
          return this._actionableBand(band);
        });
        const tradeSlots = character.slots || {};
        const existingOrder = Object.entries(tradeSlots).some(([slot, item]) =>
          /^trade\d+$/.test(slot) && item && item.name
          && Number(item.price || 0) > 0);
        if (!listingAvailable && !existingOrder) {
          return this.lastPlan = {
            state: 'IDLE', reason: 'MERCHANT_STAND_NO_LISTING_NO_OPEN', selected: null
          };
        }
        const standSlot = this._standItemSlot();
        return this.lastPlan = standSlot == null
          ? { state: 'BLOCKED', reason: 'MERCHANT_STAND_ITEM_MISSING', selected: null }
          : { state: 'READY', reason: 'MERCHANT_STAND_OPEN_READY', selected: { kind: 'OPEN_STAND', inventorySlot: standSlot } };
      }

      const reprice = this._repriceCandidate(character);
      if (reprice) {
        return this.lastPlan = { state: 'READY', reason: 'MERCHANT_STAND_REPRICE_READY', selected: reprice };
      }

      const tradeSlot = this._emptyTradeSlot(character);
      if (!tradeSlot) return this.lastPlan = { state: 'IDLE', reason: 'MERCHANT_STAND_FULL', selected: null };
      for (const row of this._safeSellRows()) {
        const band = this.market && typeof this.market.priceBand === 'function'
          ? this.market.priceBand(row.name, { level: Number(row.level) || 0 })
          : null;
        if (!this._actionableBand(band)) continue;
        const price = finite(band.recommendedAsk);
        return this.lastPlan = {
          state: 'READY',
          reason: 'MERCHANT_STAND_LISTING_READY',
          selected: {
            kind: 'LIST',
            inventorySlot: Number(row.slot),
            tradeSlot: tradeSlot.key,
            tradeIndex: tradeSlot.index,
            itemName: row.name,
            level: Number(row.level) || 0,
            quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
            price,
            priceBand: clone(band)
          }
        };
      }
      return this.lastPlan = { state: 'IDLE', reason: 'NO_SAFE_SELL_LISTING_WITH_ACTIONABLE_PRICE_SIGNAL', selected: null };
    }

    _watch(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        return;
      }
      Promise.resolve(value).then(response => {
        if (this.pending && this.pending.id === pending.id) {
          pending.settlement = 'RESOLVED';
          pending.response = response == null ? null : clone(response);
        }
      }, error => {
        if (this.pending && this.pending.id === pending.id) {
          pending.settlement = 'REJECTED';
          pending.error = cleanText(error && error.message || error, 300);
        }
      }).catch(() => {});
    }

    _suspend(reason, pending = null) {
      this.suspendedReason = cleanText(reason || 'MERCHANT_STAND_SUSPENDED', 240);
      this.autoManage = false;
      this.pending = null;
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'UNKNOWN',
        kind: pending && pending.kind || null,
        reason: this.suspendedReason
      };
      return { state: 'UNKNOWN', reason: this.suspendedReason };
    }

    _beginRelist(pending) {
      const inventoryRow = this._findRelistInventorySlot(pending);
      if (!inventoryRow) return null;
      const band = this.market && typeof this.market.priceBand === 'function'
        ? this.market.priceBand(pending.itemName, { level: pending.level })
        : null;
      if (!this._actionableBand(band)) {
        return this._suspend('MERCHANT_STAND_REPRICE_SIGNAL_LOST_AFTER_UNLIST', pending);
      }
      const currentTarget = Math.max(1, Math.floor(Number(band.recommendedAsk)));
      const lower = Math.max(1, Math.floor(Number(pending.currentPrice) * (1 - this.config.maxRepriceStepRatio)));
      const upper = Math.max(1, Math.ceil(Number(pending.currentPrice) * (1 + this.config.maxRepriceStepRatio)));
      const price = Math.max(lower, Math.min(upper, currentTarget));
      let dispatched;
      try {
        dispatched = this.actions.dispatch('trade', [
          Number(inventoryRow.slot),
          Number(pending.tradeIndex),
          price,
          Number(pending.quantity)
        ]);
      } catch (error) {
        return this._suspend('MERCHANT_STAND_RELIST_DISPATCH_ERROR:' + cleanText(error && error.message || error, 180), pending);
      }
      if (!dispatched || dispatched.state !== 'DISPATCHED') {
        return this._suspend(dispatched && dispatched.state === 'UNKNOWN'
          ? 'MERCHANT_STAND_RELIST_DISPATCH_UNKNOWN'
          : 'MERCHANT_STAND_RELIST_DISPATCH_REJECTED', pending);
      }
      const next = {
        ...pending,
        id: 'merchant-stand-' + Date.now() + '-relist',
        kind: 'REPRICE_RELIST',
        inventorySlot: Number(inventoryRow.slot),
        price,
        priceBand: clone(band),
        deadlineAtMs: Date.now() + this.config.outcomeTimeoutMs,
        settlement: 'PENDING'
      };
      this.pending = next;
      this._watch(dispatched.value, next);
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'REPRICE_RELIST_DISPATCHED',
        tradeSlot: next.tradeSlot,
        itemName: next.itemName,
        fromPrice: next.currentPrice,
        toPrice: next.price
      };
      return { state: 'DISPATCHED', kind: next.kind, tradeSlot: next.tradeSlot, price: next.price };
    }

    _observePending() {
      if (!this.pending) return null;
      const character = this._rawCharacter();
      const pending = this.pending;

      if (pending.kind === 'OPEN_STAND' && this._standOpen(character)) {
        this.pending = null;
        this.lastAction = { at: new Date().toISOString(), type: 'CONFIRMED', kind: pending.kind, evidence: 'LIVE_STAND_OPEN' };
        return { state: 'CONFIRMED', kind: pending.kind };
      }

      if (pending.kind === 'LIST') {
        const live = this._liveListing(character, pending.tradeSlot);
        if (live && String(live.name || '') === String(pending.itemName) && Number(live.price) === Number(pending.price)) {
          this.pending = null;
          this.listingsThisSession += 1;
          this.lastAction = { at: new Date().toISOString(), type: 'CONFIRMED', kind: pending.kind, evidence: 'LIVE_TRADE_SLOT' };
          return { state: 'CONFIRMED', kind: pending.kind };
        }
      }

      if (pending.kind === 'REPRICE_UNLIST') {
        const live = this._liveListing(character, pending.tradeSlot);
        if (!live) {
          const relist = this._beginRelist(pending);
          if (relist) return relist;
        } else if (!this._listingStillMatches(live, pending)) {
          return this._suspend('MERCHANT_STAND_REPRICE_LISTING_CHANGED_DURING_UNLIST', pending);
        }
      }

      if (pending.kind === 'REPRICE_RELIST') {
        const live = this._liveListing(character, pending.tradeSlot);
        if (live && String(live.name || '') === String(pending.itemName)
          && Number(live.level || 0) === Number(pending.level || 0)
          && Number(live.price || 0) === Number(pending.price || 0)) {
          this.pending = null;
          this.repricesThisSession += 1;
          this.lastRepriceAtBySlot.set(pending.tradeSlot, Date.now());
          this.lastAction = {
            at: new Date().toISOString(),
            type: 'REPRICE_CONFIRMED',
            tradeSlot: pending.tradeSlot,
            itemName: pending.itemName,
            fromPrice: pending.currentPrice,
            toPrice: pending.price,
            evidence: 'LIVE_TRADE_SLOT'
          };
          return { state: 'CONFIRMED', kind: pending.kind, tradeSlot: pending.tradeSlot };
        }
      }

      if (pending.settlement === 'REJECTED') {
        if (String(pending.kind || '').startsWith('REPRICE_')) {
          return this._suspend('MERCHANT_STAND_REPRICE_REJECTED:' + cleanText(pending.error || 'UNKNOWN', 140), pending);
        }
        this.pending = null;
        this.lastAction = { at: new Date().toISOString(), type: 'REJECTED', kind: pending.kind, reason: pending.error || 'MERCHANT_STAND_REJECTED' };
        return { state: 'REJECTED', reason: this.lastAction.reason };
      }

      if (Date.now() >= pending.deadlineAtMs) {
        return this._suspend('MERCHANT_STAND_OUTCOME_UNKNOWN', pending);
      }
      return { state: 'PENDING', kind: pending.kind };
    }

    tick() {
      const observed = this._observePending();
      if (observed) return observed;
      if (!this.moduleActive || !this.autoManage) return { state: 'IDLE', reason: 'MERCHANT_STAND_AUTO_MANAGE_DISABLED' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (this.canAct('merchant-stand') !== true) return { state: 'BLOCKED', reason: 'MERCHANT_STAND_RUNTIME_ACTION_BLOCKED' };
      if (this.listingsThisSession >= this.config.maxListingsPerSession
          && this.repricesThisSession >= this.config.maxRepricesPerSession) {
        return { state: 'BLOCKED', reason: 'MERCHANT_STAND_SESSION_BUDGET' };
      }

      const plan = this.plan();
      if (!plan || plan.state !== 'READY' || !plan.selected) return plan;
      const selected = plan.selected;
      let action;
      let args;
      let pendingKind = selected.kind;
      if (selected.kind === 'OPEN_STAND') {
        action = 'open_stand';
        args = [selected.inventorySlot];
      } else if (selected.kind === 'REPRICE') {
        const character = this._rawCharacter();
        const live = this._liveListing(character, selected.tradeSlot);
        if (!this._listingStillMatches(live, selected)) {
          return this._suspend('MERCHANT_STAND_REPRICE_PRE_DISPATCH_LISTING_CHANGED', selected);
        }
        action = 'unequip';
        args = [selected.tradeSlot];
        pendingKind = 'REPRICE_UNLIST';
      } else {
        action = 'trade';
        args = [selected.inventorySlot, selected.tradeIndex, selected.price, selected.quantity];
      }

      let dispatched;
      try { dispatched = this.actions.dispatch(action, args); }
      catch (error) { return { state: 'BLOCKED', reason: cleanText(error && error.message || error, 300) }; }
      if (!dispatched || dispatched.state !== 'DISPATCHED') {
        if (selected.kind === 'REPRICE') {
          return this._suspend(dispatched && dispatched.state === 'UNKNOWN'
            ? 'MERCHANT_STAND_REPRICE_UNLIST_DISPATCH_UNKNOWN'
            : 'MERCHANT_STAND_REPRICE_UNLIST_DISPATCH_REJECTED', selected);
        }
        if (dispatched && dispatched.state === 'UNKNOWN') {
          return this._suspend('MERCHANT_STAND_DISPATCH_UNKNOWN', selected);
        }
        return { state: 'REJECTED', reason: dispatched && dispatched.error && dispatched.error.message || 'MERCHANT_STAND_DISPATCH_REJECTED' };
      }

      const pending = {
        id: 'merchant-stand-' + Date.now(),
        kind: pendingKind,
        tradeSlot: selected.tradeSlot || null,
        tradeIndex: selected.tradeIndex || null,
        itemName: selected.itemName || null,
        level: Number(selected.level || 0),
        quantity: Number(selected.quantity || 1),
        price: selected.price || selected.targetPrice || null,
        currentPrice: selected.currentPrice || null,
        targetPrice: selected.targetPrice || null,
        rid: selected.rid || null,
        statType: selected.statType || null,
        property: selected.property == null ? null : clone(selected.property),
        deadlineAtMs: Date.now() + this.config.outcomeTimeoutMs,
        settlement: 'PENDING'
      };
      this.pending = pending;
      this._watch(dispatched.value, pending);
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'DISPATCHED',
        kind: pending.kind,
        tradeSlot: pending.tradeSlot,
        itemName: pending.itemName,
        price: pending.price
      };
      return { state: 'DISPATCHED', selected: clone(selected), pending: clone(pending) };
    }

    status() {
      return {
        schemaVersion: 2,
        moduleActive: this.moduleActive,
        autoManage: this.autoManage,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        listingsThisSession: this.listingsThisSession,
        repricesThisSession: this.repricesThisSession,
        autoOpenHoldUntilMs: this.autoOpenHoldUntilMs,
        config: clone(this.config),
        policies: {
          autoManageDefaultOff: true,
          onlyExplicitH10SellItems: true,
          externalMarketDataAdvisoryOnly: true,
          existingListingsRepricedThroughValidatedUnlistRelist: true,
          repriceRequiresFreshLiveListingIdentity: true,
          unknownSuspendsWithoutBlindRetry: true
        }
      };
    }
  }

  ns.ALDataMarketIntelligence = ALDataMarketIntelligence;
  ns.MerchantStandController = MerchantStandController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
