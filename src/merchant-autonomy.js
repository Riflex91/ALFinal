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

  function distance(a, b) {
    if (!a || !b) return null;
    const ax = finite(a.x), ay = finite(a.y), bx = finite(b.x), by = finite(b.y);
    if (ax == null || ay == null || bx == null || by == null) return null;
    return Math.hypot(ax - bx, ay - by);
  }

  function pointInPolygon(point, polygon) {
    if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
    const x = finite(point.x), y = finite(point.y);
    if (x == null || y == null) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = finite(polygon[i] && polygon[i][0]), yi = finite(polygon[i] && polygon[i][1]);
      const xj = finite(polygon[j] && polygon[j][0]), yj = finite(polygon[j] && polygon[j][1]);
      if (xi == null || yi == null || xj == null || yj == null) continue;
      const cross = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi);
      if (cross) inside = !inside;
    }
    return inside;
  }

  function errorReason(value, fallback) {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message || value.response;
      if (raw) return cleanText(raw, 300);
    }
    return cleanText(value || fallback || 'MERCHANT_AUTONOMY_UNKNOWN', 300);
  }

  class MerchantAutonomyController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.classSkills = options.classSkills || null;
      this.merchant = options.merchant || null;
      this.trade = options.trade || null;
      this.economy = options.economy || null;
      this.exchangeCraft = options.exchangeCraft || null;
      this.partyLogistics = options.partyLogistics || null;
      this.merchantStand = options.merchantStand || null;
      this.market = options.market || null;
      this.gearProgression = options.gearProgression || null;
      this.storage = options.storage || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : () => true;

      this.moduleActive = false;
      this.autoManage = false;
      this.scope = null;
      this.pending = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.merritSession = null;
      this.lastMerritReceipt = this._loadState('merrit:last', null);
      this.lastMerritStatus = null;
      this.merritStatusListener = null;
      this.merritStatusSocket = null;
      this.merritEventListener = null;
      this.merritEventCharacter = null;
      this.joinedGiveaways = new Set(this._loadState('giveaways:joined', []));
      this.lastPontyScanAtMs = 0;
      this.pontyListings = [];
      this.childWork = null;
      this.gatherRestore = null;
      this.lastGatherAttemptAtMs = { fishing: 0, mining: 0 };
      this.lastGatherResult = null;
      this.lastWishlistAtMs = 0;
      this.lastGiveawayProbeAtMs = 0;

      this.config = {
        tickMs: Math.max(500, Math.min(5000, Number(options.tickMs) || 1000)),
        merritSettleMs: 120000,
        merritHourMs: 3600000,
        merritHandoff: 32,
        merritAnchorTolerance: 4,
        merritArrivalRadius: 3,
        merritNpcClearance: 40,
        merritStandClearance: 10,
        merritFrontWidth: 10,
        merritFrontClearance: 15,
        movementTimeoutMs: Math.max(15000, Math.min(10 * 60 * 1000, Number(options.movementTimeoutMs) || 120000)),
        actionTimeoutMs: Math.max(3000, Math.min(60000, Number(options.actionTimeoutMs) || 15000)),
        gatheringTimeoutMs: Math.max(10000, Math.min(60000, Number(options.gatheringTimeoutMs) || 25000)),
        gatheringReserveSlots: Math.max(1, Math.min(10, Number(options.gatheringReserveSlots) || 2)),
        gatheringToolMaxPrice: Math.max(2000, Math.min(1000000, Number(options.gatheringToolMaxPrice) || 10000)),
        wishlistGoldReserve: Math.max(0, Math.floor(Number(options.wishlistGoldReserve) || 100000)),
        wishlistFallbackPrice: Math.max(1, Math.floor(Number(options.wishlistFallbackPrice) || 20)),
        wishlistCooldownMs: Math.max(10000, Math.min(3600000, Number(options.wishlistCooldownMs) || 120000)),
        giveawayProbeMs: Math.max(2000, Math.min(300000, Number(options.giveawayProbeMs) || 15000)),
        pontyProbeMs: Math.max(15000, Math.min(3600000, Number(options.pontyProbeMs) || 90000)),
        pontyMaxSpend: Math.max(10000, Math.floor(Number(options.pontyMaxSpend) || 1000000)),
        pontyGoldReserve: Math.max(0, Math.floor(Number(options.pontyGoldReserve) || 250000)),
        pontyBudgetRatio: Math.max(0.01, Math.min(0.50, Number(options.pontyBudgetRatio) || 0.10)),
        pontyBargainRatio: Math.max(0.10, Math.min(0.95, Number(options.pontyBargainRatio) || 0.65))
      };

      this.metrics = {
        ticks: 0,
        merritTrips: 0,
        merritSettles: 0,
        merritParcels: 0,
        merritShells: 0,
        gatheringAttempts: 0,
        gatheringFound: 0,
        gatheringNone: 0,
        gatheringRejected: 0,
        toolAcquisitions: 0,
        merchantSkills: 0,
        wishlistsCreated: 0,
        giveawaysJoined: 0,
        pontyScans: 0,
        pontyBuys: 0,
        pontySpend: 0,
        safetyBlocks: 0,
        unknown: 0
      };
    }

    _stateKey(suffix) {
      return 'albot:merchant-autonomy:v1:' + String(suffix || '');
    }

    _loadState(suffix, fallback) {
      if (!this.storage) return fallback;
      let raw = null;
      try {
        raw = typeof this.storage.getShared === 'function'
          ? this.storage.getShared(this._stateKey(suffix))
          : typeof this.storage.get === 'function'
            ? this.storage.get(this._stateKey(suffix))
            : null;
        if (raw == null || raw === '') return fallback;
        return typeof raw === 'string' ? JSON.parse(raw) : clone(raw);
      } catch (_) {
        return fallback;
      }
    }

    _saveState(suffix, value) {
      if (!this.storage) return false;
      const raw = JSON.stringify(value);
      try {
        if (typeof this.storage.setShared === 'function'
            && this.storage.setShared(this._stateKey(suffix), raw) !== false) return true;
      } catch (_) {}
      try {
        return typeof this.storage.set === 'function'
          ? this.storage.set(this._stateKey(suffix), raw) !== false
          : false;
      } catch (_) {
        return false;
      }
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

    _read(name) {
      for (const candidate of this._roots()) {
        try { if (candidate && candidate[name] != null) return candidate[name]; } catch (_) {}
      }
      return null;
    }

    _rawCharacter() {
      return this._read('character');
    }

    _gameData() {
      const value = this._read('G');
      return value && typeof value === 'object' ? value : {};
    }

    _socket() {
      return this._read('socket');
    }

    _snapshot() {
      try { return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _inventorySnapshot() {
      try { return this.game && typeof this.game.inventorySnapshot === 'function' ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _isMerchant() {
      const snap = this._snapshot();
      return !!(snap && snap.available && snap.character
        && String(snap.character.ctype || '').toLowerCase() === 'merchant'
        && snap.character.rip !== true);
    }

    _skillEnabled(skillId) {
      return !this.classSkills || typeof this.classSkills.isSkillEnabled !== 'function'
        || this.classSkills.isSkillEnabled(skillId, 'merchant') === true;
    }

    _skillReady(skillId) {
      if (!this._skillEnabled(skillId)) return null;
      try {
        const ready = this.game && typeof this.game.skillReadiness === 'function'
          ? this.game.skillReadiness(skillId)
          : null;
        return ready && ready.available && ready.allowed ? ready : null;
      } catch (_) {
        return null;
      }
    }

    _conditionActive(skillId) {
      const character = this._rawCharacter();
      const conditions = character && character.s || {};
      const row = conditions && conditions[skillId];
      if (!row) return false;
      const ms = finite(row.ms);
      return ms == null || ms > 0;
    }

    _inventoryCount(name, level = null) {
      const inv = this._inventorySnapshot();
      if (!inv || inv.available === false) return null;
      return (inv.items || []).reduce((sum, row) => {
        if (!row || String(row.name || '') !== String(name)) return sum;
        if (level != null && Number(row.level || 0) !== Number(level || 0)) return sum;
        return sum + Math.max(1, Math.floor(Number(row.quantity) || 1));
      }, 0);
    }

    _inventoryRow(name, level = null) {
      const inv = this._inventorySnapshot();
      if (!inv || inv.available === false) return null;
      return (inv.items || []).find(row =>
        row && String(row.name || '') === String(name)
        && (level == null || Number(row.level || 0) === Number(level || 0))
        && row.locked !== true && row.giveaway !== true && !row.expiresAt) || null;
    }

    _gold() {
      const snap = this._snapshot();
      return snap && snap.character ? finite(snap.character.gold) : null;
    }

    _attachListeners() {
      this._detachListeners();
      const character = this._rawCharacter();
      if (character && typeof character.on === 'function') {
        try {
          this.merritEventListener = character.on('merrit', data => this._recordMerritReceipt(data, 'CHARACTER_EVENT'));
          this.merritEventCharacter = character;
        } catch (_) {}
      }
      const socket = this._socket();
      if (socket && typeof socket.on === 'function') {
        const handler = data => this._recordMerritStatus(data);
        try {
          socket.on('merrit_status', handler);
          this.merritStatusListener = handler;
          this.merritStatusSocket = socket;
        } catch (_) {}
      }
    }

    _detachListeners() {
      if (this.merritEventCharacter && this.merritEventListener != null
          && typeof this.merritEventCharacter.remove === 'function') {
        try { this.merritEventCharacter.remove(this.merritEventListener); } catch (_) {}
      }
      if (this.merritStatusSocket && this.merritStatusListener) {
        try {
          const off = this.merritStatusSocket.off || this.merritStatusSocket.removeListener;
          if (typeof off === 'function') off.call(this.merritStatusSocket, 'merrit_status', this.merritStatusListener);
        } catch (_) {}
      }
      this.merritEventCharacter = null;
      this.merritEventListener = null;
      this.merritStatusSocket = null;
      this.merritStatusListener = null;
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      this._attachListeners();
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('merchant-autonomy-observer', () => this._maintenanceTick(), this.config.tickMs, { immediate: true });
      }
      return this.status();
    }

    stop(reason = 'MERCHANT_AUTONOMY_MODULE_STOP') {
      this.autoManage = false;
      this.moduleActive = false;
      this._detachListeners();
      this._cancelOwnedMovement(reason);
      this.pending = null;
      this.childWork = null;
      this.merritSession = null;
      this.scope = null;
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 200) };
      return this.status();
    }

    configure(options = {}) {
      if (options.autoManage != null) this.autoManage = options.autoManage === true;
      return this.status();
    }

    resetSafety(reason = 'MERCHANT_AUTONOMY_EXPLICIT_RESET') {
      this.suspendedReason = null;
      this.pending = null;
      this.childWork = null;
      this.merritSession = null;
      this._cancelOwnedMovement(reason);
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 200) };
      return this.status();
    }

    _recordMerritStatus(data) {
      if (!data || typeof data !== 'object') return;
      this.lastMerritStatus = {
        atMs: Date.now(),
        serverNow: finite(data.server_now),
        nextAt: finite(data.next_at),
        last: data.last ? clone(data.last) : null,
        accountLast: data.account_last ? clone(data.account_last) : null,
        reasons: Array.isArray(data.reasons) ? clone(data.reasons) : []
      };
      const latest = data.account_last || data.last;
      if (latest && finite(latest.at) != null) {
        const receipt = {
          at: new Date(Number(latest.at)).toISOString(),
          atMs: Number(latest.at),
          shells: Math.max(0, Math.floor(Number(latest.shells) || 0)),
          source: 'MERRIT_STATUS'
        };
        if (!this.lastMerritReceipt || Number(receipt.atMs) > Number(this.lastMerritReceipt.atMs || 0)) {
          this.lastMerritReceipt = receipt;
          this._saveState('merrit:last', receipt);
        }
      }
    }

    _recordMerritReceipt(data, source) {
      const now = Date.now();
      const receipt = {
        at: nowIso(),
        atMs: now,
        item: cleanText(data && data.item || 'marketparcel', 120) || 'marketparcel',
        quantity: Math.max(1, Math.floor(Number(data && data.quantity) || 1)),
        shells: Math.max(0, Math.floor(Number(data && data.shells) || 0)),
        source: cleanText(source || 'OBSERVED', 80)
      };
      this.lastMerritReceipt = receipt;
      this._saveState('merrit:last', receipt);
      this.metrics.merritParcels += receipt.quantity;
      this.metrics.merritShells += receipt.shells;
      this.merritSession = null;
      this.lastAction = { at: receipt.at, type: 'MERRIT_PARCEL_CONFIRMED', receipt: clone(receipt) };
      return receipt;
    }

    _merritCooldownUntil() {
      let until = 0;
      const receiptAt = finite(this.lastMerritReceipt && this.lastMerritReceipt.atMs);
      if (receiptAt != null) until = Math.max(until, receiptAt + this.config.merritHourMs);
      const status = this.lastMerritStatus;
      if (status) {
        const latest = status.accountLast || status.last;
        const latestAt = finite(latest && latest.at);
        if (latestAt != null) until = Math.max(until, latestAt + this.config.merritHourMs);
        const cooldown = (status.reasons || []).find(row => row && row.code === 'cooldown');
        const remaining = finite(cooldown && cooldown.remaining_ms);
        if (remaining != null) {
          const base = finite(status.serverNow) || Date.now();
          until = Math.max(until, base + remaining);
        }
      }
      return until || null;
    }

    _merritConfig() {
      const G = this._gameData();
      const npc = G.npcs && G.npcs.citizen22 || {};
      const market = npc.market || {};
      return {
        areas: Array.isArray(market.areas) && market.areas.length
          ? market.areas.map(row => row.map(Number))
          : [[-240, -120, 240, 144], [-88, 144, 88, 360]],
        handoff: Math.max(1, finite(market.handoff) || this.config.merritHandoff),
        settleMs: Math.max(1000, finite(market.settle_ms) || this.config.merritSettleMs),
        hourMs: Math.max(60000, finite(market.hour_ms) || this.config.merritHourMs),
        anchorTolerance: Math.max(1, finite(market.anchor_tolerance) || this.config.merritAnchorTolerance),
        npcClearance: Math.max(1, finite(market.npc_clearance) || this.config.merritNpcClearance),
        standClearance: Math.max(1, finite(market.stand_clearance) || this.config.merritStandClearance),
        frontWidth: Math.max(1, finite(market.front_width) || this.config.merritFrontWidth),
        frontClearance: Math.max(1, finite(market.front_clearance) || this.config.merritFrontClearance)
      };
    }

    _currentPoint() {
      const snap = this._snapshot();
      const raw = this._rawCharacter();
      const c = snap && snap.character;
      return c ? { map: c.map, in: raw && raw.in || c.map, x: c.x, y: c.y } : null;
    }

    _merritInArea(point, config = null) {
      const p = point || this._currentPoint();
      const cfg = config || this._merritConfig();
      if (!p || String(p.map || '') !== 'main') return false;
      if (p.in != null && String(p.in) !== 'main') return false;
      return cfg.areas.some(area =>
        Array.isArray(area) && area.length >= 4
        && finite(p.x) != null && finite(p.y) != null
        && Number(p.x) >= Number(area[0]) && Number(p.x) <= Number(area[2])
        && Number(p.y) >= Number(area[1]) && Number(p.y) <= Number(area[3]));
    }

    _rawEntities() {
      const out = [];
      for (const candidate of this._roots()) {
        for (const key of ['entities', 'players']) {
          try {
            const source = candidate && candidate[key];
            if (source && typeof source === 'object') {
              for (const value of Object.values(source)) if (value && typeof value === 'object' && !out.includes(value)) out.push(value);
            }
          } catch (_) {}
        }
      }
      return out;
    }

    _merritEntity() {
      const current = this._currentPoint();
      if (!current) return null;
      for (const entity of this._rawEntities()) {
        const id = cleanText(entity.id || entity.npc_id || '', 120).toLowerCase();
        const name = cleanText(entity.name || '', 120).toLowerCase();
        const role = cleanText(entity.role || '', 120).toLowerCase();
        if (id !== 'citizen22' && name !== 'merrit' && role !== 'market_patron') continue;
        const x = finite(entity.real_x != null ? entity.real_x : entity.x);
        const y = finite(entity.real_y != null ? entity.real_y : entity.y);
        if (x == null || y == null) continue;
        const map = entity.map || current.map;
        return {
          id: entity.id || entity.npc_id || 'citizen22',
          name: entity.name || 'Merrit',
          map,
          x,
          y,
          distance: String(map) === String(current.map) ? Math.hypot(Number(current.x) - x, Number(current.y) - y) : Infinity
        };
      }
      return null;
    }

    _fixedNpcs() {
      const G = this._gameData();
      const map = G.maps && G.maps.main || {};
      const result = [];
      for (const row of Array.isArray(map.npcs) ? map.npcs : []) {
        const id = cleanText(row && row.id || '', 120);
        if (!id || id === 'citizen22') continue;
        const def = G.npcs && G.npcs[id] || {};
        if (def.movable || def.loop) continue;
        const pos = row && row.position;
        if (!Array.isArray(pos) || finite(pos[0]) == null || finite(pos[1]) == null) continue;
        result.push({ id, name: def.name || id, x: Number(pos[0]), y: Number(pos[1]) });
      }
      return result;
    }

    _openStandPlayers() {
      const me = this._rawCharacter();
      const myName = cleanText(me && me.name || '', 120);
      const rows = [];
      for (const entity of this._rawEntities()) {
        const name = cleanText(entity.name || entity.id || '', 120);
        if (!name || name === myName || entity.npc) continue;
        const stand = !!(entity.stand || entity.p && entity.p.stand);
        if (!stand) continue;
        const x = finite(entity.real_x != null ? entity.real_x : entity.x);
        const y = finite(entity.real_y != null ? entity.real_y : entity.y);
        const map = entity.map || 'main';
        if (x == null || y == null || String(map) !== 'main') continue;
        rows.push({ name, x, y });
      }
      return rows;
    }

    _merritBlockers(point, config = null) {
      const cfg = config || this._merritConfig();
      const reasons = [];
      for (const npc of this._fixedNpcs()) {
        const d = Math.hypot(Number(point.x) - npc.x, Number(point.y) - npc.y);
        if (d <= cfg.npcClearance) reasons.push({ code: 'npc', name: npc.name, distance: d });
      }
      for (const other of this._openStandPlayers()) {
        const dx = Number(point.x) - other.x;
        const dy = Number(point.y) - other.y;
        const d = Math.hypot(dx, dy);
        if (d <= cfg.standClearance) reasons.push({ code: 'stand_close', name: other.name, distance: d });
        else if (Math.abs(dx) <= cfg.frontWidth && Math.abs(dy) <= cfg.frontClearance) {
          reasons.push({ code: 'stand_front', name: other.name, distance: d });
        }
      }
      return reasons;
    }

    _merritSpot() {
      const cfg = this._merritConfig();
      const current = this._currentPoint();
      if (this._merritInArea(current, cfg) && !this._merritBlockers(current, cfg).length) {
        return { map: 'main', x: Number(current.x), y: Number(current.y), source: 'CURRENT_VALID' };
      }
      const candidates = [];
      for (const area of cfg.areas) {
        const x0 = Number(area[0]), y0 = Number(area[1]), x1 = Number(area[2]), y1 = Number(area[3]);
        candidates.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
        for (let x = x0 + 24; x <= x1 - 24; x += 24) {
          for (let y = y0 + 24; y <= y1 - 24; y += 24) candidates.push({ x, y });
        }
      }
      candidates.sort((a, b) => {
        const da = current && finite(current.x) != null && finite(current.y) != null
          ? Math.hypot(a.x - Number(current.x), a.y - Number(current.y))
          : Math.hypot(a.x, a.y);
        const db = current && finite(current.x) != null && finite(current.y) != null
          ? Math.hypot(b.x - Number(current.x), b.y - Number(current.y))
          : Math.hypot(b.x, b.y);
        return da - db;
      });
      const chosen = candidates.find(point => !this._merritBlockers(point, cfg).length);
      return chosen ? { map: 'main', x: chosen.x, y: chosen.y, source: 'GRID_SAFE' } : null;
    }

    _standOpen() {
      const character = this._rawCharacter();
      return !!(character && (character.stand === true || character.stand && character.stand !== false
        || character.p && character.p.stand));
    }

    _tradeSlots() {
      const character = this._rawCharacter();
      return character && character.slots && typeof character.slots === 'object' ? character.slots : {};
    }

    _validStandListing() {
      const G = this._gameData();
      const gold = this._gold();
      for (const [slot, item] of Object.entries(this._tradeSlots())) {
        if (!/^trade\d+$/.test(slot) || !item || !G.items || !G.items[item.name]) continue;
        if (item.name === 'placeholder' || item.l || item.acl || item.v || item.giveaway !== undefined) continue;
        const price = finite(item.price);
        if (price == null || price <= 0 || Number(item.q == null ? 1 : item.q) <= 0) continue;
        if (item.b && (gold == null || gold < price)) continue;
        return { slot, item: clone(item) };
      }
      return null;
    }

    _emptyTradeSlot() {
      const slots = this._tradeSlots();
      for (let i = 1; i <= 16; i += 1) {
        const key = 'trade' + i;
        if (!slots[key]) return key;
      }
      return null;
    }

    _wishlistExists(name, level = 0) {
      return Object.entries(this._tradeSlots()).some(([slot, item]) =>
        /^trade\d+$/.test(slot) && item && item.b === true
        && String(item.name || '') === String(name)
        && Number(item.level || 0) === Number(level || 0)
        && finite(item.price) != null && finite(item.price) > 0);
    }

    _standItemSlot() {
      const row = this._inventoryRow('stand0');
      return row ? Number(row.slot) : null;
    }

    _wishlistSpec(options = {}) {
      const G = this._gameData();
      const gold = this._gold();
      if (gold == null) return null;
      const wanted = [];
      for (const tool of ['rod', 'pickaxe']) {
        if (!this._skillEnabled(tool === 'rod' ? 'fishing' : 'mining')) continue;
        const have = this._inventoryCount(tool);
        const raw = this._rawCharacter();
        const equipped = raw && raw.slots && raw.slots.mainhand && raw.slots.mainhand.name === tool;
        if ((have == null || have < 1) && !equipped && !this._wishlistExists(tool, 0)) wanted.push(tool);
      }
      let material = null;
      try {
        const plan = this.economy && typeof this.economy.plan === 'function' ? this.economy.plan() : null;
        if (plan && plan.selected && plan.selected.kind === 'MATERIAL_ACQUIRE') material = plan.selected.itemName || null;
      } catch (_) {}
      if (material && !this._wishlistExists(material, 0)) wanted.push(material);
      if (options.merritFallback === true && !wanted.length && !this._wishlistExists('hpot0', 0)) wanted.push('hpot0');
      const name = wanted[0];
      if (!name) return null;
      const def = G.items && G.items[name] || {};
      const base = Math.max(1, finite(def.g) || (name === 'hpot0' ? this.config.wishlistFallbackPrice : 1));
      const price = name === 'hpot0'
        ? Math.max(1, Math.min(base, this.config.wishlistFallbackPrice))
        : Math.max(1, Math.min(this.config.gatheringToolMaxPrice, Math.ceil(base * 1.25)));
      if (gold - price < this.config.wishlistGoldReserve) return null;
      const slot = this._emptyTradeSlot();
      if (!slot) return null;
      return { slot, name, level: 0, quantity: 1, price, purpose: options.merritFallback ? 'MERRIT_QUALIFICATION' : 'AUTONOMY_DEMAND' };
    }

    _movementStatus() {
      try { return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null; }
      catch (_) { return null; }
    }

    _cancelOwnedMovement(reason) {
      const status = this._movementStatus();
      if (status && status.activeOrder && String(status.activeOrder.owner || '').startsWith('merchant-autonomy')) {
        try { this.movement.cancel(cleanText(reason, 160) || 'MERCHANT_AUTONOMY_CANCEL'); } catch (_) {}
      }
    }

    _travelTask(destination, purpose, options = {}) {
      const current = this._currentPoint();
      if (!destination) return { state: 'BLOCKED', reason: 'MERCHANT_AUTONOMY_DESTINATION_UNAVAILABLE' };
      const d = current && String(current.map) === String(destination.map)
        ? distance(current, destination)
        : Infinity;
      const radius = Math.max(2, finite(options.arrivalRadius) || 12);
      if (d != null && d <= radius) return { state: 'ARRIVED', destination: clone(destination), distance: d };
      const movement = this._movementStatus();
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '').startsWith('merchant-autonomy')) {
          return { state: 'TRAVELING', destination: clone(destination), order: clone(movement.activeOrder) };
        }
        return { state: 'WAITING', reason: 'MERCHANT_AUTONOMY_MOVEMENT_OWNED_BY_OTHER' };
      }
      if (this._standOpen()) {
        return {
          state: 'READY',
          task: {
            kind: 'CLOSE_STAND',
            reason: purpose + '_TRAVEL_REQUIRES_CLOSED_STAND',
            priorityClass: options.priorityClass || 'BACKGROUND',
            exclusive: options.exclusive === true,
            destination: clone(destination)
          }
        };
      }
      return {
        state: 'READY',
        task: {
          kind: 'TRAVEL',
          purpose,
          destination: clone(destination),
          arrivalRadius: radius,
          priorityClass: options.priorityClass || 'BACKGROUND',
          exclusive: options.exclusive === true
        }
      };
    }

    _gatherZones(kind) {
      const G = this._gameData();
      const current = this._currentPoint();
      const rows = [];
      for (const [mapName, map] of Object.entries(G.maps || {})) {
        for (const zone of Array.isArray(map && map.zones) ? map.zones : []) {
          if (!zone || String(zone.type || '') !== String(kind) || !Array.isArray(zone.polygon)) continue;
          const polygon = zone.polygon;
          let point = null;
          if (current && String(current.map) === String(mapName) && pointInPolygon(current, polygon)) {
            point = { x: Number(current.x), y: Number(current.y) };
          }
          const xs = polygon.map(row => finite(row && row[0])).filter(Number.isFinite);
          const ys = polygon.map(row => finite(row && row[1])).filter(Number.isFinite);
          if (!point && xs.length && ys.length) {
            const candidates = [
              { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length },
              { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
            ];
            const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
            for (let gx = 1; gx <= 5; gx += 1) {
              for (let gy = 1; gy <= 5; gy += 1) {
                candidates.push({ x: x0 + (x1 - x0) * gx / 6, y: y0 + (y1 - y0) * gy / 6 });
              }
            }
            point = candidates.find(candidate => pointInPolygon(candidate, polygon)) || null;
          }
          if (!point) continue;
          rows.push({
            kind,
            map: mapName,
            x: point.x,
            y: point.y,
            safe: map && map.safe === true,
            current: !!(current && String(current.map) === String(mapName) && pointInPolygon(current, polygon))
          });
        }
      }
      rows.sort((a, b) =>
        Number(b.current) - Number(a.current)
        || Number(b.safe) - Number(a.safe)
        || (a.map === 'main' ? -1 : 0) - (b.map === 'main' ? -1 : 0));
      return rows;
    }

    _equippedMainhand() {
      const character = this._rawCharacter();
      const item = character && character.slots && character.slots.mainhand;
      return item ? clone(item) : null;
    }

    _threateningMonster() {
      const snap = this._snapshot();
      const c = snap && snap.character;
      if (!c) return null;
      try {
        const monsters = this.game && typeof this.game.visibleMonsters === 'function'
          ? this.game.visibleMonsters({ aliveOnly: true })
          : [];
        return (monsters || []).find(row => {
          const target = cleanText(row && (row.targetId || row.target) || '', 120);
          return target && (target === String(c.name) || target === String(this._rawCharacter() && this._rawCharacter().id || ''));
        }) || null;
      } catch (_) {
        return null;
      }
    }

    _merchantSkillTask() {
      const snap = this._snapshot();
      const c = snap && snap.character;
      if (!c) return null;
      const threat = this._threateningMonster();
      if (threat) {
        const hpRatio = finite(c.hp) != null && finite(c.maxHp) != null && Number(c.maxHp) > 0 ? Number(c.hp) / Number(c.maxHp) : 1;
        if (hpRatio <= 0.60 && !this._conditionActive('mcourage') && this._skillReady('mcourage')) {
          return {
            kind: 'MERCHANT_SKILL',
            skillId: 'mcourage',
            reason: 'MERCHANT_UNDER_THREAT_LOW_HP',
            priorityClass: 'SAFETY',
            exclusive: true
          };
        }
        if (!this._conditionActive('mfrenzy') && this._skillReady('mfrenzy')) {
          return {
            kind: 'MERCHANT_SKILL',
            skillId: 'mfrenzy',
            reason: 'MERCHANT_UNDER_THREAT',
            priorityClass: 'SAFETY',
            exclusive: true
          };
        }
      }

      let economyPlan = null;
      let economyStatus = null;
      try {
        economyStatus = this.economy && typeof this.economy.status === 'function' ? this.economy.status() : null;
        if (economyStatus && !economyStatus.currentAction && economyStatus.autonomyEnabled !== true
            && this.economy && typeof this.economy.plan === 'function') economyPlan = this.economy.plan();
      } catch (_) {}
      const selected = economyPlan && economyPlan.selected;
      if (!selected) return null;
      let candidates = [];
      if (selected.kind === 'UPGRADE' || selected.kind === 'COMPOUND') {
        candidates = ['massproductionpp', 'massproduction'];
      } else if (selected.kind === 'EXCHANGE') {
        candidates = ['massexchangepp', 'massexchange'];
      }
      for (const skillId of candidates) {
        if (this._conditionActive(skillId)) return null;
        if (this._skillReady(skillId)) {
          return {
            kind: 'MERCHANT_SKILL',
            skillId,
            reason: 'MERCHANT_PREBUFF_' + String(selected.kind),
            priorityClass: 'ECONOMY_PREBUFF',
            exclusive: true,
            economyKind: selected.kind
          };
        }
      }
      return null;
    }

    _merritTask() {
      const cooldownUntil = this._merritCooldownUntil();
      if (cooldownUntil && cooldownUntil > Date.now()) {
        this.merritSession = null;
        return null;
      }
      const inv = this._inventorySnapshot();
      if (!inv || inv.available === false || Number(inv.freeSlots) < 1) return null;

      if (this.merritSession) {
        const parcels = this._inventoryCount('marketparcel');
        if (parcels != null && finite(this.merritSession.baselineParcels) != null
            && parcels > Number(this.merritSession.baselineParcels)) {
          this._recordMerritReceipt({ item: 'marketparcel', quantity: parcels - Number(this.merritSession.baselineParcels), shells: 0 }, 'INVENTORY_DELTA');
          return null;
        }
      }

      const spot = this.merritSession && this.merritSession.anchor || this._merritSpot();
      if (!spot) {
        return {
          kind: 'MERRIT_BLOCKED',
          reason: 'MERRIT_NO_VALID_MARKET_POSITION',
          priorityClass: 'MERRIT',
          exclusive: false
        };
      }

      const current = this._currentPoint();
      const cfg = this._merritConfig();
      const atSpot = current && String(current.map) === 'main' && distance(current, spot) != null
        && distance(current, spot) <= cfg.anchorTolerance;

      if (!atSpot) {
        const travel = this._travelTask(spot, 'MERRIT', {
          arrivalRadius: this.config.merritArrivalRadius,
          priorityClass: 'MERRIT',
          exclusive: true
        });
        if (travel.state === 'READY') return { ...travel.task, priorityClass: 'MERRIT', exclusive: true };
        return {
          kind: travel.state === 'TRAVELING' ? 'MERRIT_TRAVELING' : 'MERRIT_WAITING_MOVEMENT',
          reason: travel.reason || travel.state,
          destination: clone(spot),
          priorityClass: 'MERRIT',
          exclusive: true
        };
      }

      if (this._merritBlockers(current, cfg).length) {
        this.merritSession = null;
        return {
          kind: 'MERRIT_REPOSITION',
          reason: 'MERRIT_POSITION_BLOCKED',
          priorityClass: 'MERRIT',
          exclusive: true
        };
      }

      if (!this._standOpen()) {
        const standSlot = this._standItemSlot();
        if (standSlot == null) {
          return {
            kind: 'MERRIT_NEEDS_STAND',
            reason: 'MERRIT_STAND_ITEM_MISSING',
            priorityClass: 'MERRIT',
            exclusive: true
          };
        }
        return {
          kind: 'OPEN_STAND',
          inventorySlot: standSlot,
          reason: 'MERRIT_OPEN_STAND',
          priorityClass: 'MERRIT',
          exclusive: true
        };
      }

      if (!this._validStandListing()) {
        const spec = this._wishlistSpec({ merritFallback: true });
        if (!spec) {
          return {
            kind: 'MERRIT_NEEDS_LISTING',
            reason: 'MERRIT_NO_VALID_LISTING_OR_SAFE_WISHLIST',
            priorityClass: 'MERRIT',
            exclusive: true
          };
        }
        return {
          kind: 'WISHLIST',
          wishlist: spec,
          reason: 'MERRIT_CREATE_QUALIFYING_WISHLIST',
          priorityClass: 'MERRIT',
          exclusive: true
        };
      }

      const snap = this._snapshot();
      if (snap && snap.character && snap.character.moving) {
        this.merritSession = null;
        return {
          kind: 'MERRIT_HOLD',
          reason: 'MERRIT_WAIT_FOR_STOP',
          priorityClass: 'MERRIT',
          exclusive: true
        };
      }

      if (!this.merritSession) {
        this.merritSession = {
          startedAt: nowIso(),
          sinceMs: Date.now(),
          anchor: { map: 'main', in: 'main', x: Number(current.x), y: Number(current.y) },
          baselineParcels: this._inventoryCount('marketparcel')
        };
        this.metrics.merritSettles += 1;
      }
      const moved = distance(current, this.merritSession.anchor);
      if (moved == null || moved > cfg.anchorTolerance) {
        this.merritSession = null;
        return {
          kind: 'MERRIT_REPOSITION',
          reason: 'MERRIT_ANCHOR_CHANGED',
          priorityClass: 'MERRIT',
          exclusive: true
        };
      }
      const age = Math.max(0, Date.now() - Number(this.merritSession.sinceMs));
      const remaining = Math.max(0, cfg.settleMs - age);
      const merrit = this._merritEntity();
      return {
        kind: remaining > 0 ? 'MERRIT_SETTLE' : 'MERRIT_WAIT',
        reason: remaining > 0 ? 'MERRIT_TWO_MINUTE_SETTLE' : 'MERRIT_WAIT_FOR_HANDOFF',
        settleRemainingMs: remaining,
        merritDistance: merrit && finite(merrit.distance),
        withinHandoff: !!(merrit && finite(merrit.distance) != null && Number(merrit.distance) <= cfg.handoff),
        handoffRange: cfg.handoff,
        priorityClass: 'MERRIT',
        exclusive: true
      };
    }

    _giveawayTask() {
      if (Date.now() - this.lastGiveawayProbeAtMs < this.config.giveawayProbeMs) return null;
      this.lastGiveawayProbeAtMs = Date.now();
      let market = null;
      try { market = this.game && typeof this.game.marketSnapshot === 'function' ? this.game.marketSnapshot() : null; }
      catch (_) {}
      if (!market || market.available === false) return null;
      const me = this._snapshot();
      const myName = me && me.character && me.character.name;
      const row = (market.listings || []).find(item =>
        item && item.giveaway
        && item.rid
        && item.playerName
        && String(item.playerName) !== String(myName || '')
        && !this.joinedGiveaways.has(String(item.rid)));
      if (!row) return null;
      return {
        kind: 'JOIN_GIVEAWAY',
        playerName: row.playerName,
        tradeSlot: row.slot,
        rid: String(row.rid),
        itemName: row.name || null,
        reason: 'VISIBLE_GIVEAWAY_AVAILABLE',
        priorityClass: 'BACKGROUND',
        exclusive: false
      };
    }

    _pontyLocation() {
      try { return this.game && typeof this.game.npcLocation === 'function' ? this.game.npcLocation('secondhands') : null; }
      catch (_) { return null; }
    }

    _itemValue(item) {
      for (const candidate of this._roots()) {
        for (const name of ['calculate_item_value', 'item_value']) {
          try {
            if (candidate && typeof candidate[name] === 'function') {
              const value = Number(candidate[name](item));
              if (Number.isFinite(value) && value >= 0) return value;
            }
          } catch (_) {}
        }
      }
      const G = this._gameData();
      const def = G.items && G.items[item && item.name] || {};
      return Math.max(0, finite(def.g) || 0);
    }

    _pontyCost(item) {
      const G = this._gameData();
      const def = G.items && G.items[item && item.name] || {};
      const mult = G.multipliers || {};
      const factor = def.cash
        ? finite(mult.secondhands_cash_mult)
        : finite(mult.secondhands_mult);
      const base = this._itemValue(item);
      if (factor == null || base == null) return null;
      return Math.max(0, base * factor * Math.max(1, Math.floor(Number(item && item.q) || 1)));
    }

    _pontyCandidate(items) {
      const gold = this._gold();
      const inv = this._inventorySnapshot();
      if (gold == null || !inv || inv.available === false || Number(inv.freeSlots) < 1) return null;
      const dynamicBudget = Math.max(0, Math.floor((gold - this.config.pontyGoldReserve) * this.config.pontyBudgetRatio));
      const maxSpend = Math.min(this.config.pontyMaxSpend, dynamicBudget);
      if (maxSpend <= 0) return null;
      const candidates = [];
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || !item.name || !item.rid) continue;
        const cost = this._pontyCost(item);
        if (cost == null || cost <= 0 || cost > maxSpend || gold - cost < this.config.pontyGoldReserve) continue;
        let progression = null;
        try {
          progression = this.gearProgression && typeof this.gearProgression.evaluateItem === 'function'
            ? this.gearProgression.evaluateItem(item, {})
            : null;
        } catch (_) {}
        const progressionUseful = !!(progression && progression.checked === true
          && ['GEAR', 'UPGRADE', 'COMPOUND', 'ACCUMULATE'].includes(String(progression.action || '').toUpperCase()));
        let band = null;
        try {
          band = this.market && typeof this.market.priceBand === 'function'
            ? this.market.priceBand(item.name, { level: Math.max(0, Number(item.level) || 0) })
            : null;
        } catch (_) {}
        const reference = finite(band && band.recommendedAsk);
        const bargain = reference != null
          && ['LIVE_VISIBLE', 'ALDATA_SAMPLE'].includes(String(band.confidence || ''))
          && cost <= reference * this.config.pontyBargainRatio;
        if (!progressionUseful && !bargain) continue;
        candidates.push({
          item: clone(item),
          cost,
          progressionUseful,
          bargain,
          reference,
          ratio: reference && reference > 0 ? cost / reference : 1
        });
      }
      candidates.sort((a, b) =>
        Number(b.progressionUseful) - Number(a.progressionUseful)
        || a.ratio - b.ratio
        || a.cost - b.cost);
      return candidates[0] || null;
    }

    _pontyTask() {
      if (this.pontyListings.length) {
        const selected = this._pontyCandidate(this.pontyListings);
        this.pontyListings = [];
        if (selected) {
          return {
            kind: 'PONTY_BUY',
            listing: selected.item,
            cost: selected.cost,
            progressionUseful: selected.progressionUseful,
            bargain: selected.bargain,
            reason: selected.progressionUseful ? 'PONTY_PROGRESSION_ITEM' : 'PONTY_STRONG_BARGAIN',
            priorityClass: 'BACKGROUND',
            exclusive: true
          };
        }
      }
      if (Date.now() - this.lastPontyScanAtMs < this.config.pontyProbeMs) return null;
      const location = this._pontyLocation();
      if (!location) return null;
      const current = this._currentPoint();
      const near = current && String(current.map) === String(location.map)
        && distance(current, location) != null && distance(current, location) <= 220;
      if (!near) {
        const travel = this._travelTask(location, 'PONTY', {
          arrivalRadius: 180,
          priorityClass: 'BACKGROUND',
          exclusive: true
        });
        if (travel.state === 'READY') return travel.task;
        return travel.state === 'TRAVELING'
          ? { kind: 'PONTY_TRAVELING', reason: 'PONTY_TRAVEL_ACTIVE', priorityClass: 'BACKGROUND', exclusive: true }
          : null;
      }
      return {
        kind: 'PONTY_SCAN',
        reason: 'PONTY_SCAN_DUE',
        priorityClass: 'BACKGROUND',
        exclusive: true
      };
    }

    _gatherRestoreTask() {
      if (!this.gatherRestore) return null;
      const main = this._equippedMainhand();
      if (main && String(main.name || '') === String(this.gatherRestore.name || '')
          && Number(main.level || 0) === Number(this.gatherRestore.level || 0)) {
        this.gatherRestore = null;
        return null;
      }
      const row = this._inventoryRow(this.gatherRestore.name, this.gatherRestore.level || 0);
      if (!row) {
        this.gatherRestore = null;
        return null;
      }
      return {
        kind: 'RESTORE_MAINHAND',
        inventorySlot: Number(row.slot),
        itemName: row.name,
        level: Number(row.level || 0),
        reason: 'RESTORE_PRE_GATHER_MAINHAND',
        priorityClass: 'BACKGROUND',
        exclusive: true
      };
    }

    _gatherTask() {
      const restore = this._gatherRestoreTask();
      if (restore) return restore;

      const snap = this._snapshot();
      const c = snap && snap.character;
      const inv = this._inventorySnapshot();
      if (!c || Number(c.level || 0) < 16 || !inv || inv.available === false
          || Number(inv.freeSlots) < this.config.gatheringReserveSlots
          || Number(c.mp || 0) < 120 || c.moving) return null;

      const kinds = ['fishing', 'mining']
        .filter(kind => this._skillEnabled(kind))
        .sort((a, b) => Number(this.lastGatherAttemptAtMs[a] || 0) - Number(this.lastGatherAttemptAtMs[b] || 0));

      for (const kind of kinds) {
        const tool = kind === 'fishing' ? 'rod' : 'pickaxe';
        const main = this._equippedMainhand();
        const toolDef = main && this._gameData().items && this._gameData().items[main.name] || {};
        const toolEquipped = !!(main && String(toolDef.wtype || '') === tool);
        const toolRow = this._inventoryRow(tool);
        if (!toolEquipped && !toolRow) {
          return {
            kind: 'ACQUIRE_TOOL',
            tool,
            gatherKind: kind,
            reason: 'GATHER_TOOL_MISSING',
            priorityClass: 'BACKGROUND',
            exclusive: true
          };
        }
        if (!toolEquipped && toolRow) {
          return {
            kind: 'EQUIP_TOOL',
            inventorySlot: Number(toolRow.slot),
            tool,
            gatherKind: kind,
            previousMainhand: main ? { name: main.name, level: Number(main.level || 0) } : null,
            reason: 'GATHER_EQUIP_TOOL',
            priorityClass: 'BACKGROUND',
            exclusive: true
          };
        }

        const readiness = this._skillReady(kind);
        if (!readiness) continue;
        const zones = this._gatherZones(kind);
        if (!zones.length) continue;
        const zone = zones[0];
        if (!zone.current) {
          const travel = this._travelTask(zone, 'GATHER_' + kind.toUpperCase(), {
            arrivalRadius: 8,
            priorityClass: 'BACKGROUND',
            exclusive: true
          });
          if (travel.state === 'READY') return { ...travel.task, gatherKind: kind, tool };
          if (travel.state === 'TRAVELING') {
            return {
              kind: 'GATHER_TRAVELING',
              gatherKind: kind,
              reason: 'GATHER_TRAVEL_ACTIVE',
              priorityClass: 'BACKGROUND',
              exclusive: true
            };
          }
          continue;
        }
        return {
          kind: 'GATHER',
          gatherKind: kind,
          tool,
          reason: 'GATHER_ATTEMPT_READY',
          priorityClass: 'BACKGROUND',
          exclusive: true
        };
      }
      return null;
    }

    _backgroundWishlistTask() {
      if (Date.now() - this.lastWishlistAtMs < this.config.wishlistCooldownMs) return null;
      const spec = this._wishlistSpec({ merritFallback: false });
      if (!spec) return null;
      if (!this._standOpen()) {
        const standSlot = this._standItemSlot();
        if (standSlot == null) return null;
        return {
          kind: 'OPEN_STAND',
          inventorySlot: standSlot,
          reason: 'WISHLIST_OPEN_STAND',
          priorityClass: 'BACKGROUND',
          exclusive: true
        };
      }
      return {
        kind: 'WISHLIST',
        wishlist: spec,
        reason: 'AUTONOMY_USEFUL_BUY_ORDER',
        priorityClass: 'BACKGROUND',
        exclusive: true
      };
    }

    _childBusy() {
      if (!this.childWork) return null;
      const controller = this.childWork.controller === 'trade' ? this.trade : this.exchangeCraft;
      let status = null;
      try { status = controller && typeof controller.status === 'function' ? controller.status() : null; } catch (_) {}
      if (!status) {
        this.childWork = null;
        return null;
      }
      if (status.suspendedReason) {
        this.suspendedReason = 'MERCHANT_AUTONOMY_CHILD_SUSPENDED:' + cleanText(status.suspendedReason, 220);
        this.childWork = null;
        return null;
      }
      if (status.pending || status.request || status.currentAction) return clone(this.childWork);
      const tool = this.childWork.tool;
      if (tool && (this._inventoryRow(tool) || this._equippedMainhand() && this._equippedMainhand().name === tool)) {
        this.metrics.toolAcquisitions += 1;
      }
      this.childWork = null;
      return null;
    }

    plan(options = {}) {
      const backgroundAllowed = options.backgroundAllowed === true;
      if (!this.moduleActive || !this.autoManage) {
        return this.lastPlan = { state: 'IDLE', reason: 'MERCHANT_AUTONOMY_DISABLED', selected: null };
      }
      if (this.suspendedReason) {
        return this.lastPlan = { state: 'SUSPENDED', reason: this.suspendedReason, selected: null };
      }
      if (!this._isMerchant()) {
        return this.lastPlan = { state: 'IDLE', reason: 'MERCHANT_AUTONOMY_LOCAL_NOT_MERCHANT', selected: null };
      }
      if (this.pending) {
        return this.lastPlan = {
          state: 'PENDING',
          reason: 'MERCHANT_AUTONOMY_ACTION_PENDING',
          selected: clone(this.pending),
          exclusive: this.pending.exclusive === true
        };
      }
      const child = this._childBusy();
      if (this.suspendedReason) return this.lastPlan = { state: 'SUSPENDED', reason: this.suspendedReason, selected: null };
      if (child) {
        return this.lastPlan = {
          state: 'CHILD_ACTIVE',
          reason: 'MERCHANT_AUTONOMY_CHILD_ACTIVE',
          selected: child,
          exclusive: true
        };
      }

      const skill = this._merchantSkillTask();
      if (skill && skill.priorityClass === 'SAFETY') {
        return this.lastPlan = { state: 'READY', reason: skill.reason, selected: skill, exclusive: true };
      }
      const merrit = this._merritTask();
      if (merrit && merrit.kind !== 'MERRIT_BLOCKED') {
        return this.lastPlan = { state: 'READY', reason: merrit.reason, selected: merrit, exclusive: merrit.exclusive === true };
      }
      if (skill && skill.priorityClass === 'ECONOMY_PREBUFF') {
        return this.lastPlan = { state: 'READY', reason: skill.reason, selected: skill, exclusive: true };
      }
      if (!backgroundAllowed) {
        return this.lastPlan = {
          state: 'IDLE',
          reason: merrit && merrit.reason || 'MERCHANT_AUTONOMY_BACKGROUND_NOT_GRANTED',
          selected: null
        };
      }

      const tasks = [
        this._giveawayTask(),
        this._pontyTask(),
        this._backgroundWishlistTask(),
        this._gatherTask()
      ];
      const selected = tasks.find(Boolean) || null;
      return this.lastPlan = selected
        ? { state: 'READY', reason: selected.reason, selected, exclusive: selected.exclusive === true }
        : { state: 'IDLE', reason: 'MERCHANT_AUTONOMY_NO_BACKGROUND_WORK', selected: null };
    }

    _knownRejection(reason) {
      const text = cleanText(reason || '', 300).toLowerCase();
      return ['cooldown', 'not_ready', 'not_there', 'no_space', 'inventory', 'invalid', 'gone', 'already', 'too_far', 'failed']
        .some(token => text.includes(token));
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
        this.pending.error = errorReason(error, 'MERCHANT_AUTONOMY_ACTION_REJECTED');
      }).catch(() => {});
    }

    _suspendUnknown(reason, pending) {
      this.metrics.unknown += 1;
      this.pending = null;
      this.suspendedReason = cleanText(reason || 'MERCHANT_AUTONOMY_UNKNOWN', 300);
      this.lastAction = {
        at: nowIso(),
        type: 'UNKNOWN',
        kind: pending && pending.kind || null,
        reason: this.suspendedReason
      };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _wishlistObserved(pending) {
      const spec = pending.wishlist;
      const item = this._tradeSlots()[spec && spec.slot];
      return !!(item && item.b === true
        && String(item.name || '') === String(spec.name || '')
        && Number(item.level || 0) === Number(spec.level || 0)
        && Number(item.price || 0) === Number(spec.price || 0));
    }

    _equipObserved(pending) {
      const main = this._equippedMainhand();
      return !!(main && String(main.name || '') === String(pending.itemName || '')
        && Number(main.level || 0) === Number(pending.level || 0));
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return null;
      const now = Date.now();

      if (pending.kind === 'OPEN_STAND' && this._standOpen()) {
        this.pending = null;
        this.lastAction = { at: nowIso(), type: 'OPEN_STAND_CONFIRMED' };
        return { state: 'CONFIRMED', kind: pending.kind };
      }
      if (pending.kind === 'CLOSE_STAND' && !this._standOpen()) {
        this.pending = null;
        this.merritSession = null;
        this.lastAction = { at: nowIso(), type: 'CLOSE_STAND_CONFIRMED' };
        return { state: 'CONFIRMED', kind: pending.kind };
      }
      if (pending.kind === 'WISHLIST' && this._wishlistObserved(pending)) {
        this.pending = null;
        this.lastWishlistAtMs = now;
        this.metrics.wishlistsCreated += 1;
        this.lastAction = { at: nowIso(), type: 'WISHLIST_CONFIRMED', wishlist: clone(pending.wishlist) };
        return { state: 'CONFIRMED', kind: pending.kind };
      }
      if ((pending.kind === 'EQUIP_TOOL' || pending.kind === 'RESTORE_MAINHAND') && this._equipObserved(pending)) {
        this.pending = null;
        if (pending.kind === 'EQUIP_TOOL' && pending.previousMainhand) this.gatherRestore = clone(pending.previousMainhand);
        if (pending.kind === 'RESTORE_MAINHAND') this.gatherRestore = null;
        this.lastAction = { at: nowIso(), type: pending.kind + '_CONFIRMED', itemName: pending.itemName };
        return { state: 'CONFIRMED', kind: pending.kind };
      }

      if (pending.settlement === 'REJECTED' || pending.response && pending.response.failed === true) {
        const reason = errorReason(pending.error || pending.response, 'MERCHANT_AUTONOMY_ACTION_REJECTED');
        if (pending.kind === 'JOIN_GIVEAWAY') {
          this.joinedGiveaways.add(String(pending.rid));
          this._saveState('giveaways:joined', [...this.joinedGiveaways].slice(-200));
          this.pending = null;
          this.lastAction = { at: nowIso(), type: 'GIVEAWAY_JOIN_SKIPPED', reason, rid: pending.rid };
          return { state: 'REJECTED', kind: pending.kind, reason };
        }
        if (pending.kind === 'PONTY_SCAN' || pending.kind === 'GATHER' || this._knownRejection(reason)) {
          this.pending = null;
          if (pending.kind === 'GATHER') {
            this.metrics.gatheringRejected += 1;
            this.lastGatherAttemptAtMs[pending.gatherKind] = now;
          }
          if (pending.kind === 'PONTY_SCAN') this.lastPontyScanAtMs = now;
          this.lastAction = { at: nowIso(), type: pending.kind + '_REJECTED', reason };
          return { state: 'REJECTED', kind: pending.kind, reason };
        }
        return this._suspendUnknown(reason, pending);
      }

      if (pending.kind === 'GATHER' && ['RESOLVED', 'RETURNED'].includes(pending.settlement)) {
        const response = pending.response || {};
        this.pending = null;
        this.lastGatherAttemptAtMs[pending.gatherKind] = now;
        this.lastGatherResult = {
          at: nowIso(),
          kind: pending.gatherKind,
          found: response.found === true || String(response.response || '').endsWith('_success'),
          response: cleanText(response.response || '', 120) || null
        };
        if (this.lastGatherResult.found) this.metrics.gatheringFound += 1;
        else this.metrics.gatheringNone += 1;
        this.lastAction = { at: nowIso(), type: 'GATHER_CONFIRMED', result: clone(this.lastGatherResult) };
        return { state: 'CONFIRMED', kind: pending.kind, result: clone(this.lastGatherResult) };
      }

      if (pending.kind === 'MERCHANT_SKILL' && ['RESOLVED', 'RETURNED'].includes(pending.settlement)) {
        if (this._conditionActive(pending.skillId) || !(pending.response && pending.response.failed === true)) {
          this.pending = null;
          this.metrics.merchantSkills += 1;
          this.lastAction = { at: nowIso(), type: 'MERCHANT_SKILL_CONFIRMED', skillId: pending.skillId };
          return { state: 'CONFIRMED', kind: pending.kind };
        }
      }

      if (pending.kind === 'JOIN_GIVEAWAY' && ['RESOLVED', 'RETURNED'].includes(pending.settlement)) {
        this.joinedGiveaways.add(String(pending.rid));
        this._saveState('giveaways:joined', [...this.joinedGiveaways].slice(-200));
        this.pending = null;
        this.metrics.giveawaysJoined += 1;
        this.lastAction = { at: nowIso(), type: 'GIVEAWAY_JOIN_CONFIRMED', rid: pending.rid, playerName: pending.playerName };
        return { state: 'CONFIRMED', kind: pending.kind };
      }

      if (pending.kind === 'PONTY_SCAN' && ['RESOLVED', 'RETURNED'].includes(pending.settlement)) {
        const response = pending.response || {};
        this.pontyListings = Array.isArray(response.items) ? clone(response.items) : [];
        this.lastPontyScanAtMs = now;
        this.pending = null;
        this.metrics.pontyScans += 1;
        this.lastAction = { at: nowIso(), type: 'PONTY_SCAN_CONFIRMED', listings: this.pontyListings.length };
        return { state: 'CONFIRMED', kind: pending.kind };
      }

      if (pending.kind === 'PONTY_BUY') {
        const after = this._inventoryCount(pending.itemName, pending.level);
        const gold = this._gold();
        if (after != null && after > Number(pending.beforeQuantity || 0)
            && gold != null && gold < Number(pending.beforeGold || gold + 1)) {
          this.pending = null;
          this.metrics.pontyBuys += 1;
          this.metrics.pontySpend += Math.max(0, Number(pending.beforeGold) - Number(gold));
          this.lastAction = { at: nowIso(), type: 'PONTY_BUY_CONFIRMED', itemName: pending.itemName, rid: pending.rid };
          return { state: 'CONFIRMED', kind: pending.kind };
        }
      }

      if (now >= Number(pending.deadlineAtMs || 0)) {
        if (['JOIN_GIVEAWAY', 'PONTY_SCAN', 'GATHER'].includes(pending.kind)) {
          if (pending.kind === 'JOIN_GIVEAWAY') this.joinedGiveaways.add(String(pending.rid));
          this.pending = null;
          this.lastAction = { at: nowIso(), type: pending.kind + '_TIMEOUT_NO_RETRY' };
          return { state: 'REJECTED', reason: pending.kind + '_TIMEOUT_NO_RETRY' };
        }
        return this._suspendUnknown('MERCHANT_AUTONOMY_' + pending.kind + '_OUTCOME_UNKNOWN', pending);
      }
      return { state: 'PENDING', kind: pending.kind };
    }

    _dispatch(kind, action, args, details = {}) {
      let result = null;
      try { result = this.actions && typeof this.actions.dispatch === 'function' ? this.actions.dispatch(action, args) : null; }
      catch (error) { return { state: 'BLOCKED', reason: errorReason(error, 'MERCHANT_AUTONOMY_DISPATCH_ERROR') }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (kind === 'JOIN_GIVEAWAY' && result && result.state === 'UNKNOWN') {
          if (details.rid) this.joinedGiveaways.add(String(details.rid));
          return { state: 'REJECTED', reason: 'GIVEAWAY_JOIN_UNKNOWN_NO_RETRY' };
        }
        if (result && result.state === 'UNKNOWN') return this._suspendUnknown('MERCHANT_AUTONOMY_' + kind + '_DISPATCH_UNKNOWN', details);
        return { state: 'BLOCKED', reason: result && result.state || 'MERCHANT_AUTONOMY_ACTION_NOT_DISPATCHED' };
      }
      const now = Date.now();
      const pending = {
        id: 'merchant-autonomy-' + (++this.sequence),
        kind,
        ...clone(details),
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + (kind === 'GATHER' ? this.config.gatheringTimeoutMs : this.config.actionTimeoutMs),
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this._watch(result.value, pending);
      this.lastAction = { at: pending.dispatchedAt, type: kind + '_DISPATCHED', action, details: clone(details) };
      return { state: 'DISPATCHED', pending: clone(pending) };
    }

    _acquireTool(task) {
      const tool = task.tool;
      if (this.exchangeCraft && typeof this.exchangeCraft.queueCraft === 'function') {
        try {
          const craft = this.exchangeCraft.queueCraft(tool);
          if (craft && craft.accepted === true) {
            this.childWork = { kind: 'TOOL_CRAFT', controller: 'exchangeCraft', tool, gatherKind: task.gatherKind };
            return { state: 'CHILD_ACTIVE', child: clone(this.childWork) };
          }
        } catch (_) {}
      }
      if (this.trade && typeof this.trade.queueAcquire === 'function') {
        try {
          const acquire = this.trade.queueAcquire(tool, 1, { maxUnitPrice: this.config.gatheringToolMaxPrice });
          if (acquire && acquire.accepted === true) {
            this.childWork = { kind: 'TOOL_ACQUIRE', controller: 'trade', tool, gatherKind: task.gatherKind };
            return { state: 'CHILD_ACTIVE', child: clone(this.childWork) };
          }
        } catch (_) {}
      }
      const spec = this._wishlistSpec({ merritFallback: false });
      if (spec && spec.name === tool) {
        if (!this._standOpen()) {
          const standSlot = this._standItemSlot();
          if (standSlot != null) {
            return this._dispatch('OPEN_STAND', 'open_stand', [standSlot], {
              inventorySlot: standSlot,
              exclusive: true
            });
          }
        } else {
          return this._dispatch('WISHLIST', 'wishlist', [spec.slot, spec.name, spec.price, spec.level, spec.quantity], {
            wishlist: spec,
            exclusive: true
          });
        }
      }
      this.metrics.safetyBlocks += 1;
      return { state: 'BLOCKED', reason: 'GATHER_TOOL_ACQUISITION_UNAVAILABLE' };
    }

    _execute(task) {
      if (!task) return { state: 'IDLE' };
      if (['MERRIT_SETTLE', 'MERRIT_WAIT', 'MERRIT_HOLD', 'MERRIT_TRAVELING', 'MERRIT_WAITING_MOVEMENT', 'GATHER_TRAVELING', 'PONTY_TRAVELING'].includes(task.kind)) {
        return { state: 'WAITING', reason: task.reason, selected: clone(task) };
      }
      if (task.kind === 'MERRIT_REPOSITION') {
        this.merritSession = null;
        return { state: 'WAITING', reason: task.reason, selected: clone(task) };
      }
      if (task.kind === 'MERRIT_NEEDS_STAND') {
        if (this.trade && typeof this.trade.queueAcquire === 'function') {
          const G = this._gameData();
          const price = Math.max(1, finite(G.items && G.items.stand0 && G.items.stand0.g) || 10000);
          try {
            const acquire = this.trade.queueAcquire('stand0', 1, { maxUnitPrice: Math.ceil(price * 1.25) });
            if (acquire && acquire.accepted === true) {
              this.childWork = { kind: 'STAND_ACQUIRE', controller: 'trade', tool: 'stand0' };
              return { state: 'CHILD_ACTIVE', child: clone(this.childWork) };
            }
          } catch (_) {}
        }
        return { state: 'BLOCKED', reason: task.reason };
      }
      if (task.kind === 'MERRIT_NEEDS_LISTING') return { state: 'BLOCKED', reason: task.reason };
      if (task.kind === 'CLOSE_STAND') {
        return this._dispatch('CLOSE_STAND', 'close_stand', [], {
          exclusive: task.exclusive === true,
          destination: task.destination || null
        });
      }
      if (task.kind === 'OPEN_STAND') {
        return this._dispatch('OPEN_STAND', 'open_stand', [task.inventorySlot], {
          inventorySlot: task.inventorySlot,
          exclusive: task.exclusive === true
        });
      }
      if (task.kind === 'TRAVEL') {
        if (!this.movement || typeof this.movement.smartMove !== 'function') return { state: 'BLOCKED', reason: 'MERCHANT_AUTONOMY_MOVEMENT_UNAVAILABLE' };
        let moved = null;
        try {
          moved = this.movement.smartMove(task.destination, {
            owner: 'merchant-autonomy:' + cleanText(task.purpose || 'work', 60).toLowerCase(),
            arrivalRadius: task.arrivalRadius || 8,
            transient: task.priorityClass !== 'MERRIT'
          });
        } catch (error) {
          moved = { accepted: false, reason: errorReason(error, 'MERCHANT_AUTONOMY_MOVE_ERROR') };
        }
        if (!moved || moved.accepted !== true) return { state: 'BLOCKED', reason: moved && moved.reason || 'MERCHANT_AUTONOMY_MOVE_REJECTED' };
        if (String(task.purpose || '').startsWith('MERRIT')) this.metrics.merritTrips += 1;
        return { state: 'TRAVELING', order: clone(moved.order || null), destination: clone(task.destination) };
      }
      if (task.kind === 'WISHLIST') {
        const spec = task.wishlist;
        return this._dispatch('WISHLIST', 'wishlist', [spec.slot, spec.name, spec.price, spec.level, spec.quantity], {
          wishlist: spec,
          exclusive: task.exclusive === true
        });
      }
      if (task.kind === 'JOIN_GIVEAWAY') {
        return this._dispatch('JOIN_GIVEAWAY', 'join_giveaway', [task.playerName, task.tradeSlot, task.rid], {
          playerName: task.playerName,
          tradeSlot: task.tradeSlot,
          rid: task.rid,
          itemName: task.itemName,
          exclusive: false
        });
      }
      if (task.kind === 'PONTY_SCAN') {
        this.lastPontyScanAtMs = Date.now();
        return this._dispatch('PONTY_SCAN', 'get_secondhands', [10000], { exclusive: true });
      }
      if (task.kind === 'PONTY_BUY') {
        const listing = task.listing;
        const beforeQuantity = this._inventoryCount(listing.name, Math.max(0, Number(listing.level) || 0));
        const beforeGold = this._gold();
        if (beforeQuantity == null || beforeGold == null || beforeGold - Number(task.cost) < this.config.pontyGoldReserve) {
          return { state: 'BLOCKED', reason: 'PONTY_BUY_REVALIDATION_FAILED' };
        }
        return this._dispatch('PONTY_BUY', 'buy_secondhand', [String(listing.rid), 10000], {
          rid: String(listing.rid),
          itemName: listing.name,
          level: Math.max(0, Number(listing.level) || 0),
          cost: Number(task.cost),
          beforeQuantity,
          beforeGold,
          exclusive: true
        });
      }
      if (task.kind === 'EQUIP_TOOL') {
        return this._dispatch('EQUIP_TOOL', 'equip', [task.inventorySlot, 'mainhand'], {
          itemName: task.tool,
          level: 0,
          previousMainhand: task.previousMainhand || null,
          gatherKind: task.gatherKind,
          exclusive: true
        });
      }
      if (task.kind === 'RESTORE_MAINHAND') {
        return this._dispatch('RESTORE_MAINHAND', 'equip', [task.inventorySlot, 'mainhand'], {
          itemName: task.itemName,
          level: task.level || 0,
          exclusive: true
        });
      }
      if (task.kind === 'ACQUIRE_TOOL') return this._acquireTool(task);
      if (task.kind === 'GATHER') {
        this.lastGatherAttemptAtMs[task.gatherKind] = Date.now();
        this.metrics.gatheringAttempts += 1;
        return this._dispatch('GATHER', 'use_skill', [task.gatherKind], {
          gatherKind: task.gatherKind,
          tool: task.tool,
          exclusive: true
        });
      }
      if (task.kind === 'MERCHANT_SKILL') {
        return this._dispatch('MERCHANT_SKILL', 'use_skill', [task.skillId], {
          skillId: task.skillId,
          economyKind: task.economyKind || null,
          exclusive: true
        });
      }
      return { state: 'IDLE', reason: task.reason || 'MERCHANT_AUTONOMY_NO_ACTION' };
    }

    _maintenanceTick() {
      this._observePending();
      this._childBusy();
      if (this.merritSession) {
        const parcels = this._inventoryCount('marketparcel');
        if (parcels != null && finite(this.merritSession.baselineParcels) != null
            && parcels > Number(this.merritSession.baselineParcels)) {
          this._recordMerritReceipt({ item: 'marketparcel', quantity: parcels - Number(this.merritSession.baselineParcels), shells: 0 }, 'INVENTORY_DELTA');
        }
      }
      return this.status();
    }

    tick(options = {}) {
      this.metrics.ticks += 1;
      const observed = this._observePending();
      if (observed && this.suspendedReason) return observed;
      if (this.pending) return { state: 'PENDING', pending: clone(this.pending) };
      if (!this.moduleActive || !this.autoManage) return { state: 'IDLE', reason: 'MERCHANT_AUTONOMY_DISABLED' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (this.canAct('merchant-autonomy') !== true) return { state: 'BLOCKED', reason: 'MERCHANT_AUTONOMY_RUNTIME_ACTION_BLOCKED' };
      const plan = this.plan(options);
      if (!plan || plan.state !== 'READY' || !plan.selected) return plan;
      return { ...this._execute(plan.selected), plan: clone(plan) };
    }

    status() {
      const cooldownUntil = this._merritCooldownUntil();
      const selected = this.lastPlan && this.lastPlan.selected || null;
      const activeExclusive = !!(this.pending && this.pending.exclusive === true)
        || !!this.childWork
        || !!this.merritSession
        || !!(selected && selected.exclusive === true
          && ['MERRIT_SETTLE', 'MERRIT_WAIT', 'MERRIT_TRAVELING', 'GATHER_TRAVELING', 'PONTY_TRAVELING'].includes(selected.kind));
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autoManage: this.autoManage,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        exclusive: activeExclusive,
        pending: clone(this.pending),
        childWork: clone(this.childWork),
        merrit: {
          session: clone(this.merritSession),
          cooldownUntilMs: cooldownUntil,
          cooldownRemainingMs: cooldownUntil ? Math.max(0, cooldownUntil - Date.now()) : 0,
          lastReceipt: clone(this.lastMerritReceipt),
          lastStatus: clone(this.lastMerritStatus),
          entity: clone(this._merritEntity())
        },
        gathering: {
          lastAttemptAtMs: clone(this.lastGatherAttemptAtMs),
          lastResult: clone(this.lastGatherResult),
          restore: clone(this.gatherRestore)
        },
        ponty: {
          lastScanAtMs: this.lastPontyScanAtMs,
          cachedListings: this.pontyListings.length
        },
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics),
        policies: {
          giveawayCreationDisabled: true,
          pontyRequiresProgressionOrStrongBargain: true,
          merritSettleOwnsMerchantMovement: true,
          gatheringUsesLiveZonesAndSkillReadiness: true
        }
      };
    }
  }

  ns.MerchantAutonomyController = MerchantAutonomyController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
