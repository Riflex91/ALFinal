(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;
  const COMBAT_CLASSES = ns.helpers.COMBAT_CLASSES;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  const EQUIPMENT_TYPES = new Set([
    'weapon', 'shield', 'helmet', 'coat', 'pants', 'gloves', 'shoes',
    'cape', 'ring', 'earring', 'amulet', 'belt', 'orb', 'source', 'quiver'
  ]);

  class MerchantController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.roster = options.roster || null;
      this.movement = options.movement || null;
      this.inventory = options.inventory || null;
      this.moduleActive = false;
      this.scope = null;
      this.suspendedReason = null;
      this.pending = null;
      this.delivery = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.backoffUntilMs = null;
      this.sequence = 0;
      this.serviceTarget = null;
      this.serviceHistory = [];
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        transferRange: Math.max(80, Math.min(1000, Number(options.transferRange) || 320)),
        transferOutcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.transferOutcomeTimeoutMs) || 5000)),
        mluckOutcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.mluckOutcomeTimeoutMs) || 5000)),
        mluckRefreshMs: Math.max(5000, Math.min(10 * 60 * 1000, Number(options.mluckRefreshMs) || 30000)),
        pressureMarginSlots: Math.max(1, Math.min(12, Number(options.pressureMarginSlots) || 2)),
        merchantReserveSlots: Math.max(1, Math.min(12, Number(options.merchantReserveSlots) || 2)),
        serviceHoldMs: Math.max(1000, Math.min(60000, Number(options.serviceHoldMs) || 8000)),
        switchCooldownMs: Math.max(500, Math.min(60000, Number(options.switchCooldownMs) || 5000)),
        pingPongWindowMs: Math.max(2000, Math.min(120000, Number(options.pingPongWindowMs) || 30000)),
        rejectionBackoffMs: Math.max(500, Math.min(60000, Number(options.rejectionBackoffMs) || 4000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        pressureHigh: 0,
        pressureCritical: 0,
        handoffsPlanned: 0,
        transfersDispatched: 0,
        transfersConfirmed: 0,
        transfersRejected: 0,
        transfersUnknown: 0,
        mluckPlanned: 0,
        mluckDispatched: 0,
        mluckConfirmed: 0,
        mluckRejected: 0,
        mluckUnknown: 0,
        movementRequests: 0,
        movementBlocks: 0,
        ownershipBlocks: 0,
        foreignTargetBlocks: 0,
        pingPongBlocks: 0,
        switchCooldownBlocks: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H11_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('merchant-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H11_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.delivery = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'merchant-h11') {
          this.movement.cancel(cleanText(reason, 180) || 'H11_MODULE_STOP');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H11_EXPLICIT_RESET') {
      this.pending = null;
      this.suspendedReason = null;
      this.backoffUntilMs = null;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _roster() {
      try {
        return this.roster && typeof this.roster.status === 'function' ? this.roster.status() : null;
      } catch (_) {
        return null;
      }
    }

    _role() {
      const snap = this._snapshot();
      const ctype = cleanText(snap && snap.character && snap.character.ctype || '', 60).toLowerCase();
      if (ctype === 'merchant') return 'MERCHANT';
      if (COMBAT_CLASSES && COMBAT_CLASSES.has(ctype)) return 'FARMER';
      return ctype ? 'OBSERVER' : 'UNAVAILABLE';
    }

    _ownedNames() {
      const roster = this._roster();
      return new Set((roster && roster.characters || []).map(row => cleanText(row && row.name || '', 120)).filter(Boolean));
    }

    _owned(name) {
      const wanted = cleanText(name || '', 120);
      if (!wanted) return false;
      return this._ownedNames().has(wanted);
    }

    _ownedFarmerNames() {
      const roster = this._roster();
      return new Set((roster && roster.farmers || []).map(row => cleanText(row && row.name || '', 120)).filter(Boolean));
    }

    _merchantName() {
      const roster = this._roster();
      return cleanText(roster && roster.merchant && roster.merchant.name || '', 120) || null;
    }

    _visibleOwnedPlayers() {
      const owned = this._ownedNames();
      const visible = this.game && typeof this.game.visiblePlayers === 'function'
        ? this.game.visiblePlayers({})
        : [];
      return (visible || []).filter(row => row && row.name && owned.has(String(row.name)));
    }

    _visibleOwnedFarmers() {
      const farmers = this._ownedFarmerNames();
      return this._visibleOwnedPlayers().filter(row => farmers.has(String(row.name)));
    }

    _inventoryPlan() {
      try {
        if (this.inventory && typeof this.inventory.plan === 'function') return this.inventory.plan();
      } catch (_) {}
      const snapshot = this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : null;
      return snapshot ? {
        state: snapshot.available === false ? 'BLOCKED' : 'READY',
        reason: snapshot.reason || null,
        inventory: snapshot,
        items: snapshot.items || [],
        reserveFreeSlots: 2
      } : null;
    }

    _pressure(plan, role) {
      const slots = plan && plan.inventory || {};
      const free = finite(slots.freeSlots);
      const reserve = role === 'MERCHANT'
        ? this.config.merchantReserveSlots
        : Math.max(1, finite(plan && plan.reserveFreeSlots) || 2);
      if (free == null) return { state: 'UNKNOWN', freeSlots: null, reserveFreeSlots: reserve };
      if (free <= reserve) return { state: 'CRITICAL', freeSlots: free, reserveFreeSlots: reserve };
      if (free <= reserve + this.config.pressureMarginSlots) {
        return { state: 'HIGH', freeSlots: free, reserveFreeSlots: reserve };
      }
      return { state: 'NORMAL', freeSlots: free, reserveFreeSlots: reserve };
    }

    _transferSafe(row, options = {}) {
      if (!row || !row.name) return false;
      if (row.locked || row.giveaway || row.gift || row.expiresAt) return false;
      if ((finite(row.level) || 0) > 0) return false;
      const definition = row.definition || {};
      const type = cleanText(definition.type || '', 80).toLowerCase();
      if (definition.quest === true || definition.upgrade === true || definition.compound === true) return false;
      if (EQUIPMENT_TYPES.has(type)) return false;
      const disposition = cleanText(row.disposition || '', 40).toUpperCase();
      if (disposition === 'BANK' || disposition === 'EXCHANGE') return true;
      if (options.allowUtility === true && disposition === 'KEEP'
        && ['pot', 'elixir', 'food', 'scroll', 'booster'].includes(type)) return true;
      return false;
    }

    _handoffCandidates(plan, options = {}) {
      return (plan && plan.items || [])
        .filter(row => this._transferSafe(row, options))
        .sort((a, b) => {
          const ad = String(a.disposition || '') === 'BANK' ? 0 : String(a.disposition || '') === 'EXCHANGE' ? 1 : 2;
          const bd = String(b.disposition || '') === 'BANK' ? 0 : String(b.disposition || '') === 'EXCHANGE' ? 1 : 2;
          if (ad !== bd) return ad - bd;
          return Number(a.slot || 0) - Number(b.slot || 0);
        });
    }

    _findVisible(name) {
      const wanted = cleanText(name || '', 120);
      return this._visibleOwnedPlayers().find(row => String(row.name) === wanted) || null;
    }

    _trimServiceHistory(now = Date.now()) {
      const cutoff = now - this.config.pingPongWindowMs;
      this.serviceHistory = this.serviceHistory.filter(row => row.atMs >= cutoff).slice(-12);
    }

    _claimTarget(name, purpose) {
      const wanted = cleanText(name || '', 120);
      if (!wanted) return { ok: false, reason: 'H11_TARGET_REQUIRED' };
      const now = Date.now();
      this._trimServiceHistory(now);
      const current = this.serviceTarget;
      if (current && current.name === wanted) {
        return { ok: true, target: clone(current), changed: false };
      }
      if (current && now - current.switchedAtMs < this.config.switchCooldownMs) {
        this.metrics.switchCooldownBlocks += 1;
        return { ok: false, reason: 'H11_SERVICE_SWITCH_COOLDOWN', current: clone(current) };
      }
      const previous = this.serviceHistory[this.serviceHistory.length - 1] || null;
      const olderSame = this.serviceHistory.slice(0, -1).reverse().find(row => row.name === wanted);
      if (previous && previous.name !== wanted && olderSame && now - olderSame.atMs < this.config.pingPongWindowMs) {
        this.metrics.pingPongBlocks += 1;
        return { ok: false, reason: 'H11_SERVICE_PINGPONG_BLOCKED', previous: previous.name };
      }
      this.serviceTarget = {
        name: wanted,
        purpose: cleanText(purpose || 'SERVICE', 80),
        sinceMs: now,
        switchedAtMs: now
      };
      this.serviceHistory.push({ name: wanted, purpose: this.serviceTarget.purpose, atMs: now });
      this._trimServiceHistory(now);
      return { ok: true, target: clone(this.serviceTarget), changed: true };
    }

    _releaseTarget(reason = 'H11_SERVICE_RELEASE') {
      if (!this.serviceTarget) return;
      this.lastAction = {
        at: nowIso(),
        type: 'SERVICE_RELEASE',
        target: this.serviceTarget.name,
        reason: cleanText(reason, 180)
      };
      this.serviceTarget = null;
    }

    _approach(target) {
      if (!target || target.distance == null || target.distance <= this.config.transferRange) {
        return { ready: true, reason: 'H11_TARGET_IN_RANGE' };
      }
      if (!this.movement || typeof this.movement.status !== 'function') {
        return { ready: false, reason: 'H11_MOVEMENT_UNAVAILABLE' };
      }
      const status = this.movement.status();
      if (status.activeOrder) {
        if (String(status.activeOrder.owner || '') === 'merchant-h11') {
          return { ready: false, reason: 'H11_SERVICE_TRAVEL_ACTIVE', order: status.activeOrder };
        }
        this.metrics.movementBlocks += 1;
        return { ready: false, reason: 'H11_MOVEMENT_BUSY' };
      }
      if (finite(target.x) == null || finite(target.y) == null) {
        return { ready: false, reason: 'H11_TARGET_POSITION_UNAVAILABLE' };
      }
      let result = null;
      try {
        result = this.movement.moveLocal(target.x, target.y, {
          owner: 'merchant-h11',
          arrivalRadius: Math.min(90, Math.max(30, this.config.transferRange * 0.35))
        });
        if (!result || result.accepted !== true) {
          result = this.movement.smartMove({ map: target.map, x: target.x, y: target.y }, {
            owner: 'merchant-h11',
            arrivalRadius: Math.min(90, Math.max(30, this.config.transferRange * 0.35))
          });
        }
      } catch (error) {
        result = { accepted: false, reason: cleanText(error && error.message || error, 240) };
      }
      if (result && result.accepted) this.metrics.movementRequests += 1;
      else this.metrics.movementBlocks += 1;
      return {
        ready: false,
        reason: result && result.accepted ? 'H11_SERVICE_TRAVEL_STARTED' : (result && result.reason || 'H11_SERVICE_TRAVEL_REJECTED'),
        movement: clone(result)
      };
    }

    _watch(value, pending) {
      if (!value || typeof value.then !== 'function') {
        pending.settlement = 'RETURNED';
        pending.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.pending || this.pending.id !== pending.id) return;
        pending.settlement = 'RESOLVED';
        pending.response = response == null ? null : clone(response);
      }, error => {
        if (!this.pending || this.pending.id !== pending.id) return;
        pending.settlement = 'REJECTED';
        pending.error = cleanText(error && error.message || error || 'H11_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _suspendUnknown(kind, reason) {
      this.pending = null;
      this.suspendedReason = cleanText(reason || 'H11_UNKNOWN', 500) || 'H11_UNKNOWN';
      if (kind === 'MLUCK') this.metrics.mluckUnknown += 1;
      else this.metrics.transfersUnknown += 1;
      this.lastAction = { at: nowIso(), type: kind + '_UNKNOWN', reason: this.suspendedReason };
      return true;
    }

    _transferObserved(pending) {
      const snapshot = this.game && typeof this.game.inventorySnapshot === 'function'
        ? this.game.inventorySnapshot()
        : null;
      if (!snapshot || snapshot.available === false) return false;
      const items = snapshot.items || [];
      const row = items.find(item => Number(item.slot) === Number(pending.slot));
      if (!row || String(row.name || '') !== String(pending.itemName || '')) return true;
      const after = finite(row.quantity) || 0;
      return pending.beforeQuantity - after >= pending.quantity;
    }

    _mluckObserved(pending) {
      if (!this.game || typeof this.game.playerCondition !== 'function') return false;
      const condition = this.game.playerCondition(pending.targetName, 'mluck');
      if (!condition || !condition.active) return false;

      const before = pending.beforeCondition || null;
      if (!before || before.active !== true) return true;

      const beforeRemaining = finite(before.remainingMs);
      const afterRemaining = finite(condition.remainingMs);
      if (beforeRemaining != null && afterRemaining != null && afterRemaining > beforeRemaining + 1000) return true;

      const beforeSource = cleanText(before.source || '', 120);
      const afterSource = cleanText(condition.source || '', 120);
      if (beforeSource && afterSource && beforeSource !== afterSource) return true;

      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      const now = Date.now();

      if (pending.settlement === 'REJECTED') {
        return this._suspendUnknown(pending.kind, pending.error || 'H11_ACTION_REJECTED');
      }

      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.backoffUntilMs = now + this.config.rejectionBackoffMs;
        if (pending.kind === 'MLUCK') this.metrics.mluckRejected += 1;
        else this.metrics.transfersRejected += 1;
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H11_ACTION_REJECTED', 240)
        };
        return true;
      }

      const confirmed = pending.kind === 'MLUCK'
        ? this._mluckObserved(pending)
        : this._transferObserved(pending);
      if (confirmed) {
        this.pending = null;
        if (pending.kind === 'MLUCK') this.metrics.mluckConfirmed += 1;
        else this.metrics.transfersConfirmed += 1;
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_CONFIRMED',
          target: pending.targetName,
          itemName: pending.itemName || null,
          quantity: pending.quantity || null
        };
        if (pending.kind === 'DELIVERY') this.delivery = null;
        return true;
      }

      if (now >= pending.deadlineAtMs) {
        const reason = pending.kind === 'MLUCK' ? 'H11_MLUCK_UNVERIFIED_TIMEOUT' : 'H11_TRANSFER_UNVERIFIED_TIMEOUT';
        return this._suspendUnknown(pending.kind, reason);
      }
      return false;
    }

    _dispatchTransfer(kind, targetName, row, quantity) {
      const target = cleanText(targetName || '', 120);
      if (!this._owned(target)) {
        this.metrics.foreignTargetBlocks += 1;
        return { accepted: false, reason: 'H11_FOREIGN_TARGET_BLOCKED' };
      }
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H11_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      const sendQuantity = Math.max(1, Math.min(Math.floor(Number(quantity) || 1), Math.floor(Number(row.quantity) || 1)));
      let result;
      try {
        result = this.actions.dispatch('send_item', [target, Number(row.slot), sendQuantity]);
      } catch (error) {
        return { accepted: false, reason: cleanText(error && error.message || error, 300) };
      }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          this._suspendUnknown(kind, result.error && result.error.message || 'H11_TRANSFER_DISPATCH_UNKNOWN');
          return { accepted: false, reason: this.suspendedReason };
        }
        this.metrics.transfersRejected += 1;
        return { accepted: false, reason: result && result.state || 'H11_TRANSFER_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'merchant-' + (++this.sequence),
        kind,
        targetName: target,
        slot: Number(row.slot),
        itemName: String(row.name),
        quantity: sendQuantity,
        beforeQuantity: Math.floor(Number(row.quantity) || 1),
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.transferOutcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this.metrics.transfersDispatched += 1;
      this.lastAction = {
        at: pending.dispatchedAt,
        type: kind + '_DISPATCHED',
        target,
        itemName: pending.itemName,
        quantity: sendQuantity
      };
      this._watch(result.value, pending);
      return { accepted: true, pending: clone(pending) };
    }

    _dispatchMluck(target) {
      if (!target || !target.name) return { accepted: false, reason: 'H11_MLUCK_TARGET_UNAVAILABLE' };
      const claim = this._claimTarget(target.name, 'MLUCK');
      if (!claim.ok) return { accepted: false, reason: claim.reason };
      const condition = this.game && typeof this.game.playerCondition === 'function'
        ? this.game.playerCondition(target.name, 'mluck')
        : null;
      if (condition && condition.active
        && (condition.remainingMs == null || condition.remainingMs > this.config.mluckRefreshMs)) {
        return { accepted: false, reason: 'H11_MLUCK_ALREADY_HEALTHY' };
      }
      const readiness = this.game && typeof this.game.skillReadiness === 'function'
        ? this.game.skillReadiness('mluck', target.name)
        : null;
      if (!readiness || readiness.available === false) return { accepted: false, reason: 'H11_MLUCK_UNAVAILABLE' };
      if (!readiness.allowed) return { accepted: false, reason: (readiness.reasons || []).join('|') || 'H11_MLUCK_NOT_READY' };
      let result;
      try {
        result = this.actions.dispatch('use_skill', ['mluck', target.name]);
      } catch (error) {
        return { accepted: false, reason: cleanText(error && error.message || error, 300) };
      }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          this._suspendUnknown('MLUCK', result.error && result.error.message || 'H11_MLUCK_DISPATCH_UNKNOWN');
          return { accepted: false, reason: this.suspendedReason };
        }
        this.metrics.mluckRejected += 1;
        return { accepted: false, reason: result && result.state || 'H11_MLUCK_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'merchant-' + (++this.sequence),
        kind: 'MLUCK',
        targetName: target.name,
        beforeCondition: condition ? clone(condition) : null,
        itemName: null,
        quantity: null,
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.mluckOutcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.pending = pending;
      this.metrics.mluckDispatched += 1;
      this.lastAction = { at: pending.dispatchedAt, type: 'MLUCK_DISPATCHED', target: target.name };
      this._watch(result.value, pending);
      return { accepted: true, pending: clone(pending) };
    }

    queueDelivery(targetName, itemName, quantity = 1) {
      const role = this._role();
      if (role !== 'MERCHANT') return { accepted: false, reason: 'H11_DELIVERY_REQUIRES_LOCAL_MERCHANT' };
      const target = cleanText(targetName || '', 120);
      if (!this._ownedFarmerNames().has(target)) {
        this.metrics.foreignTargetBlocks += 1;
        return { accepted: false, reason: 'H11_DELIVERY_TARGET_NOT_OWNED_FARMER' };
      }
      const name = cleanText(itemName || '', 160);
      const wanted = Math.max(1, Math.floor(Number(quantity) || 1));
      if (!name) return { accepted: false, reason: 'H11_DELIVERY_ITEM_REQUIRED' };
      const itemPlan = this._inventoryPlan();
      const row = (itemPlan && itemPlan.items || []).find(item =>
        String(item.name || '') === name && this._transferSafe(item, { allowUtility: true }));
      if (!row) return { accepted: false, reason: 'H11_DELIVERY_ITEM_NOT_SAFE_OR_AVAILABLE' };
      if ((Math.floor(Number(row.quantity) || 0)) < wanted) {
        return { accepted: false, reason: 'H11_DELIVERY_QUANTITY_UNAVAILABLE' };
      }
      this.delivery = {
        id: 'delivery-' + (++this.sequence),
        targetName: target,
        itemName: name,
        quantity: wanted,
        createdAt: nowIso(),
        createdAtMs: Date.now()
      };
      return { accepted: true, delivery: clone(this.delivery) };
    }

    cancelDelivery(reason = 'H11_DELIVERY_CANCELLED') {
      if (!this.delivery) return { cancelled: false, reason: 'H11_NO_DELIVERY' };
      const delivery = this.delivery;
      this.delivery = null;
      this.lastAction = {
        at: nowIso(),
        type: 'DELIVERY_CANCELLED',
        target: delivery.targetName,
        reason: cleanText(reason, 180)
      };
      return { cancelled: true, delivery: clone(delivery) };
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const role = this._role();
      const plan = this._inventoryPlan();
      const pressure = this._pressure(plan, role);
      const visibleOwned = this._visibleOwnedPlayers();
      const visibleFarmers = this._visibleOwnedFarmers();
      const merchantName = this._merchantName();
      const localName = cleanText(snap && snap.character && snap.character.name || '', 120) || null;
      const candidates = this._handoffCandidates(plan, { allowUtility: role === 'MERCHANT' });
      let service = { type: 'IDLE', reason: 'H11_NO_SERVICE_NEEDED' };

      if (!snap || !snap.available || !snap.character) {
        service = { type: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE' };
      } else if (role === 'FARMER') {
        if (pressure.state === 'CRITICAL' || pressure.state === 'HIGH') {
          const merchant = merchantName && visibleOwned.find(row => String(row.name) === merchantName);
          if (!merchantName) service = { type: 'BLOCKED', reason: 'H11_OWN_MERCHANT_UNAVAILABLE' };
          else if (!merchant) service = { type: 'WAIT', reason: 'H11_OWN_MERCHANT_NOT_VISIBLE', targetName: merchantName };
          else if (!candidates.length) service = { type: 'BLOCKED', reason: 'H11_NO_SAFE_HANDOFF_ITEM', targetName: merchantName };
          else service = {
            type: 'HANDOFF',
            reason: 'H11_INVENTORY_PRESSURE_HANDOFF',
            targetName: merchantName,
            target: merchant,
            item: candidates[0]
          };
        }
      } else if (role === 'MERCHANT') {
        if (this.delivery) {
          const target = visibleFarmers.find(row => String(row.name) === String(this.delivery.targetName));
          service = {
            type: 'DELIVERY',
            reason: target ? 'H11_EXPLICIT_DELIVERY' : 'H11_DELIVERY_TARGET_NOT_VISIBLE',
            targetName: this.delivery.targetName,
            target: target || null,
            delivery: clone(this.delivery)
          };
        } else {
          const needsMluck = visibleFarmers.filter(row => {
            const condition = this.game && typeof this.game.playerCondition === 'function'
              ? this.game.playerCondition(row.name, 'mluck')
              : null;
            return !(condition && condition.active
              && (condition.remainingMs == null || condition.remainingMs > this.config.mluckRefreshMs));
          });
          if (needsMluck.length) {
            needsMluck.sort((a, b) => {
              const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
              const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
              return ad - bd;
            });
            service = {
              type: 'MLUCK',
              reason: 'H11_MLUCK_REFRESH_NEEDED',
              targetName: needsMluck[0].name,
              target: needsMluck[0]
            };
          }
        }
      } else {
        service = { type: 'OBSERVER', reason: 'H11_ROLE_NOT_SERVICE_CAPABLE' };
      }

      const output = {
        state: this.suspendedReason ? 'SUSPENDED' : 'READY',
        reason: this.suspendedReason || 'H11_PLAN_READY',
        localName,
        role,
        pressure,
        merchantName,
        visibleOwnedPlayers: visibleOwned.map(row => ({
          name: row.name, ctype: row.ctype, map: row.map, distance: row.distance
        })),
        visibleOwnedFarmers: visibleFarmers.map(row => ({
          name: row.name, ctype: row.ctype, map: row.map, distance: row.distance
        })),
        handoffCandidates: candidates.map(row => ({
          slot: row.slot,
          name: row.name,
          quantity: row.quantity,
          disposition: row.disposition,
          reason: row.reason
        })),
        delivery: clone(this.delivery),
        service
      };
      this.lastPlan = clone(output);
      return clone(output);
    }

    tick() {
      this.metrics.ticks += 1;
      this._observePending();
      const plan = this.plan();

      if (!this.moduleActive) return { state: 'IDLE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.pending) return { state: 'PENDING', pending: clone(this.pending), plan };
      if (this.backoffUntilMs && Date.now() < this.backoffUntilMs) {
        return { state: 'BACKOFF', untilMs: this.backoffUntilMs, plan };
      }

      if (plan.pressure.state === 'CRITICAL') this.metrics.pressureCritical += 1;
      else if (plan.pressure.state === 'HIGH') this.metrics.pressureHigh += 1;

      const service = plan.service || {};
      if (service.type === 'HANDOFF') {
        this.metrics.handoffsPlanned += 1;
        const claim = this._claimTarget(service.targetName, 'HANDOFF');
        if (!claim.ok) return { state: 'WAITING', reason: claim.reason, plan };
        const approach = this._approach(service.target);
        if (!approach.ready) return { state: 'WAITING', reason: approach.reason, movement: approach.movement || null, plan };
        return { state: 'DISPATCHED', result: this._dispatchTransfer('HANDOFF', service.targetName, service.item, service.item.quantity), plan };
      }

      if (service.type === 'DELIVERY') {
        if (!service.target) return { state: 'WAITING', reason: service.reason, plan };
        const claim = this._claimTarget(service.targetName, 'DELIVERY');
        if (!claim.ok) return { state: 'WAITING', reason: claim.reason, plan };
        const approach = this._approach(service.target);
        if (!approach.ready) return { state: 'WAITING', reason: approach.reason, movement: approach.movement || null, plan };
        const itemPlan = this._inventoryPlan();
        const row = (itemPlan && itemPlan.items || []).find(item =>
          String(item.name || '') === String(service.delivery.itemName || '')
          && this._transferSafe(item, { allowUtility: true }));
        if (!row) return { state: 'BLOCKED', reason: 'H11_DELIVERY_ITEM_NOT_SAFE_OR_AVAILABLE', plan };
        const quantity = Math.min(service.delivery.quantity, Math.floor(Number(row.quantity) || 0));
        if (quantity < 1) return { state: 'BLOCKED', reason: 'H11_DELIVERY_QUANTITY_UNAVAILABLE', plan };
        return { state: 'DISPATCHED', result: this._dispatchTransfer('DELIVERY', service.targetName, row, quantity), plan };
      }

      if (service.type === 'MLUCK') {
        this.metrics.mluckPlanned += 1;
        const approach = this._approach(service.target);
        if (!approach.ready) return { state: 'WAITING', reason: approach.reason, movement: approach.movement || null, plan };
        const result = this._dispatchMluck(service.target);
        return { state: result.accepted ? 'DISPATCHED' : 'WAITING', reason: result.reason || null, result, plan };
      }

      if (service.type === 'BLOCKED') return { state: 'BLOCKED', reason: service.reason, plan };
      if (service.type === 'WAIT') return { state: 'WAITING', reason: service.reason, plan };
      return { state: 'READY', reason: service.reason || 'H11_NO_SERVICE_NEEDED', plan };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        delivery: clone(this.delivery),
        serviceTarget: clone(this.serviceTarget),
        serviceHistory: clone(this.serviceHistory.slice(-8)),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        backoffUntilMs: this.backoffUntilMs,
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.MerchantController = MerchantController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
