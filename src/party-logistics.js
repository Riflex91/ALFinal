(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const EQUIPMENT_TYPES = new Set([
    'weapon','shield','helmet','hat','gloves','shoes','pants','chest','armor','cape',
    'ring','earring','amulet','orb','belt','offhand','source','quiver'
  ]);

  function finite(value) {
    if (value == null) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  class PartyLogisticsController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.party = options.party || null;
      this.movement = options.movement || null;
      this.combat = options.combat || null;
      this.inventory = options.inventory || null;
      this.merchant = options.merchant || null;
      this.bank = options.bank || null;
      this.trade = options.trade || null;
      this.gear = options.gear || null;
      this.upgrade = options.upgrade || null;
      this.exchangeCraft = options.exchangeCraft || null;
      this.economy = options.economy || null;
      this.gearProgression = options.gearProgression || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : null;

      this.moduleActive = false;
      this.scope = null;
      this.autonomyEnabled = false;
      this.suspendedReason = null;
      this.queue = [];
      this.currentAction = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.actionsThisSession = 0;

      this.config = {
        tickMs: Math.max(250, Math.min(5000, Math.floor(finite(options.tickMs) == null ? 750 : finite(options.tickMs)))),
        transferRange: Math.max(80, Math.min(600, finite(options.transferRange) == null ? 320 : finite(options.transferRange))),
        regroupDistance: Math.max(100, Math.min(5000, finite(options.regroupDistance) == null ? 700 : finite(options.regroupDistance))),
        regroupArrivalRadius: Math.max(20, Math.min(180, finite(options.regroupArrivalRadius) == null ? 80 : finite(options.regroupArrivalRadius))),
        outcomeTimeoutMs: Math.max(2000, Math.min(60000, Math.floor(finite(options.outcomeTimeoutMs) == null ? 8000 : finite(options.outcomeTimeoutMs)))),
        movementTimeoutMs: Math.max(3000, Math.min(120000, Math.floor(finite(options.movementTimeoutMs) == null ? 60000 : finite(options.movementTimeoutMs)))),
        maxActionsPerSession: Math.max(1, Math.min(50, Math.floor(finite(options.maxActionsPerSession) == null ? 6 : finite(options.maxActionsPerSession)))),
        maxQueue: Math.max(1, Math.min(50, Math.floor(finite(options.maxQueue) == null ? 12 : finite(options.maxQueue)))),
        goldReserve: Math.max(0, Math.floor(finite(options.goldReserve) == null ? 100000 : finite(options.goldReserve))),
        allowRegroup: options.allowRegroup !== false
      };

      this.metrics = {
        ticks: 0,
        plans: 0,
        suppliesQueued: 0,
        suppliesDispatched: 0,
        suppliesConfirmed: 0,
        suppliesRejected: 0,
        suppliesUnknown: 0,
        gearQueued: 0,
        gearDispatched: 0,
        gearConfirmed: 0,
        gearRejected: 0,
        gearUnknown: 0,
        goldQueued: 0,
        goldDispatched: 0,
        goldConfirmed: 0,
        goldRejected: 0,
        goldUnknown: 0,
        regroupPlanned: 0,
        regroupRequests: 0,
        regroupsConfirmed: 0,
        regroupsRejected: 0,
        regroupsUnknown: 0,
        movementBlocks: 0,
        foreignPartyBlocks: 0,
        combatBlocks: 0,
        ownershipBlocks: 0,
        sessionBudgetBlocks: 0,
        actionsQueued: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H18_ALREADY_ACTIVE' };
      const resumedInFlight = !!(this.currentAction && ['SUPPLY','GEAR','GOLD'].includes(String(this.currentAction.kind || '')));
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.autonomyEnabled = false;
      if (!resumedInFlight) {
        this.suspendedReason = null;
        this.currentAction = null;
        this.actionsThisSession = 0;
      }
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('party-logistics-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true, resumedInFlight };
    }

    stop(reason = 'H18_MODULE_STOP') {
      const preserveInFlight = !!(this.currentAction && ['SUPPLY','GEAR','GOLD'].includes(String(this.currentAction.kind || '')));
      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.scope = null;
      if (!preserveInFlight) {
        this._cancelOwnedMovement(reason);
        this.currentAction = null;
      }
      this.lastAction = {
        at: nowIso(),
        type: preserveInFlight ? 'STOP_WITH_INFLIGHT_PRESERVED' : 'STOP',
        reason: cleanText(reason, 240),
        currentAction: preserveInFlight ? clone(this.currentAction) : null
      };
      return { stopped: true, inFlightPreserved: preserveInFlight };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.currentAction) return { accepted: false, reason: 'H18_ACTION_ACTIVE' };
      if (this.canAct && this.canAct('party-logistics') !== true) return { accepted: false, reason: 'H18_RUNTIME_ACTION_BLOCKED' };
      if (options.maxActions != null) {
        this.config.maxActionsPerSession = Math.max(1, Math.min(50, Math.floor(Number(options.maxActions) || 1)));
      }
      this.actionsThisSession = 0;
      this.autonomyEnabled = true;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STARTED', maxActions: this.config.maxActionsPerSession };
      return { accepted: true, status: this.status() };
    }

    stopAutonomy(reason = 'H18_AUTONOMY_STOP') {
      this.autonomyEnabled = false;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STOPPED', reason: cleanText(reason, 240) };
      return this.status();
    }

    resetSafety(reason = 'H18_EXPLICIT_RESET') {
      if (this.currentAction) return { ...this.status(), reset: false, reason: 'H18_ACTION_ACTIVE' };
      this.suspendedReason = null;
      this.autonomyEnabled = false;
      this.actionsThisSession = 0;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return { ...this.status(), reset: true };
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H18_POLICY_MUST_BE_OBJECT');
      const number = (key, min, max, integer = false) => {
        if (value[key] == null) return;
        const parsed = finite(value[key]);
        if (parsed == null) throw new Error('H18_POLICY_' + key.toUpperCase() + '_INVALID');
        this.config[key] = Math.max(min, Math.min(max, integer ? Math.floor(parsed) : parsed));
      };
      number('transferRange', 80, 600);
      number('regroupDistance', 100, 5000);
      number('regroupArrivalRadius', 20, 180);
      number('outcomeTimeoutMs', 2000, 60000, true);
      number('movementTimeoutMs', 3000, 120000, true);
      number('maxActionsPerSession', 1, 50, true);
      number('maxQueue', 1, 50, true);
      number('goldReserve', 0, Number.MAX_SAFE_INTEGER, true);
      if (value.allowRegroup != null) this.config.allowRegroup = value.allowRegroup === true;
      return clone(this.config);
    }

    _snapshot() {
      try { return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _inventory() {
      try { return this.game && typeof this.game.inventorySnapshot === 'function' ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _partySnapshot() {
      try { return this.party && typeof this.party.snapshot === 'function' ? this.party.snapshot() : null; }
      catch (_) { return null; }
    }

    _movementStatus() {
      try { return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null; }
      catch (_) { return null; }
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _ownedTarget(name, snapshot = null) {
      const wanted = cleanText(name || '', 120);
      const party = snapshot || this._partySnapshot();
      if (!wanted || !party || !Array.isArray(party.ownedMembers)) return null;
      return party.ownedMembers.find(member => String(member.name || '') === wanted && !member.local) || null;
    }

    _safeSupplyRow(row) {
      if (!row || !row.name || row.locked || row.giveaway || row.gift || row.expiresAt) return false;
      if (Math.max(0, Number(row.level) || 0) > 0) return false;
      const definition = row.definition;
      if (!definition || typeof definition !== 'object') return false;
      const type = cleanText(definition.type || '', 80).toLowerCase();
      if (!type) return false;
      if (definition.quest === true || definition.cash === true || definition.upgrade === true || definition.compound === true) return false;
      if (EQUIPMENT_TYPES.has(type)) return false;
      return true;
    }

    supplyCatalog() {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return [];
      return (inventory.items || [])
        .filter(row => this._safeSupplyRow(row))
        .map(row => ({
          slot: Number(row.slot),
          name: String(row.name),
          quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
          type: cleanText(row.definition && row.definition.type || '', 80) || null,
          utility: ['pot','elixir','food','scroll','uscroll','cscroll','booster'].includes(cleanText(row.definition && row.definition.type || '', 80).toLowerCase())
        }))
        .sort((a, b) => Number(b.utility) - Number(a.utility) || String(a.name).localeCompare(String(b.name)) || a.slot - b.slot);
    }

    _findSupplyRow(itemName, minQuantity = 1) {
      const wanted = cleanText(itemName || '', 160);
      const required = Math.max(1, Math.floor(Number(minQuantity) || 1));
      if (!wanted) return null;
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || [])
        .filter(row => String(row.name || '') === wanted
          && this._safeSupplyRow(row)
          && Math.max(1, Math.floor(Number(row.quantity) || 1)) >= required)
        .sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0))[0] || null;
    }

    _supplyRowAt(slot, itemName) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return null;
      return (inventory.items || []).find(row =>
        Number(row.slot) === Number(slot)
        && String(row.name || '') === String(itemName || '')
        && this._safeSupplyRow(row)) || null;
    }

    _gearDeliveryRow(slot, targetName) {
      const inventory = this._inventory();
      if (!inventory || inventory.available === false) return null;
      const row = (inventory.items || []).find(item => Number(item.slot) === Number(slot)) || null;
      if (!row || !row.name || row.locked || row.giveaway || row.gift || row.expiresAt) return null;
      if (!this.gearProgression || typeof this.gearProgression.deliveryAuthorization !== 'function') return null;
      let authorization = null;
      try { authorization = this.gearProgression.deliveryAuthorization(row, targetName); } catch (_) {}
      return authorization && authorization.allowed === true ? { row, authorization } : null;
    }

    _externalBusy() {
      const rows = [
        ['inventory', this.inventory],
        ['merchant', this.merchant],
        ['bank', this.bank],
        ['trade', this.trade],
        ['gear', this.gear],
        ['upgrade', this.upgrade],
        ['exchangeCraft', this.exchangeCraft]
      ];
      const blockers = [];
      for (const [name, controller] of rows) {
        let status = null;
        try { status = controller && typeof controller.status === 'function' ? controller.status() : null; } catch (_) {}
        if (status && (status.pending || status.request || status.delivery || status.pendingLoot || status.currentAction)) {
          blockers.push({ module: name, reason: 'BUSY' });
        }
        if (status && status.suspended) blockers.push({ module: name, reason: status.suspendedReason || 'SUSPENDED' });
      }
      let economy = null;
      try { economy = this.economy && typeof this.economy.status === 'function' ? this.economy.status() : null; } catch (_) {}
      const economyDelegatingHere = economy && economy.currentAction
        && String(economy.currentAction.module || '') === 'partyLogistics';
      if (economy && !economyDelegatingHere && (economy.currentAction || economy.autonomyEnabled)) {
        blockers.push({ module: 'economy', reason: economy.currentAction ? 'BUSY' : 'AUTONOMY_ACTIVE' });
      }
      return blockers;
    }

    queueSupply(targetName, itemName, quantity = 1) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H18_QUEUE_FULL' };
      const party = this._partySnapshot();
      if (!party || !party.coordinationEnabled) return { accepted: false, reason: 'H18_OWNED_PARTY_REQUIRED' };
      const target = this._ownedTarget(targetName, party);
      if (!target) return { accepted: false, reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER' };
      const rawQuantity = finite(quantity);
      if (rawQuantity == null || rawQuantity <= 0 || !Number.isInteger(rawQuantity)) {
        return { accepted: false, reason: 'H18_SUPPLY_QUANTITY_INVALID' };
      }
      const wanted = rawQuantity;
      const anyRow = this._findSupplyRow(itemName, 1);
      if (!anyRow) return { accepted: false, reason: 'H18_SUPPLY_ITEM_NOT_SAFE_OR_AVAILABLE' };
      const row = this._findSupplyRow(itemName, wanted);
      if (!row) return { accepted: false, reason: 'H18_SUPPLY_QUANTITY_UNAVAILABLE' };
      const available = Math.max(1, Math.floor(Number(row.quantity) || 1));
      const request = {
        id: 'h18-request-' + (++this.sequence),
        kind: 'SUPPLY',
        targetName: String(target.name),
        itemName: String(row.name),
        quantity: wanted,
        createdAt: nowIso()
      };
      this.queue.push(request);
      this.metrics.suppliesQueued += 1;
      this.lastAction = { at: nowIso(), type: 'SUPPLY_QUEUED', request: clone(request) };
      return { accepted: true, request: clone(request) };
    }

    queueGearDelivery(targetName, inventorySlot) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H18_QUEUE_FULL' };
      const party = this._partySnapshot();
      if (!party || !party.coordinationEnabled) return { accepted: false, reason: 'H18_OWNED_PARTY_REQUIRED' };
      const target = this._ownedTarget(targetName, party);
      if (!target) return { accepted: false, reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER' };
      const authorized = this._gearDeliveryRow(inventorySlot, target.name);
      if (!authorized) return { accepted: false, reason: 'H18_GEAR_DELIVERY_NOT_AUTHORIZED' };
      const row = authorized.row;
      const request = {
        id: 'h18-request-' + (++this.sequence),
        kind: 'GEAR',
        targetName: String(target.name),
        itemName: String(row.name),
        inventorySlot: Number(row.slot),
        fingerprint: authorized.authorization.reservation && authorized.authorization.reservation.fingerprint || null,
        quantity: 1,
        createdAt: nowIso()
      };
      this.queue.push(request);
      this.metrics.gearQueued += 1;
      this.lastAction = { at: nowIso(), type: 'GEAR_QUEUED', request: clone(request) };
      return { accepted: true, request: clone(request) };
    }

    queueGold(targetName, amount) {
      if (!this.moduleActive) return { accepted: false, reason: 'H18_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.queue.length >= this.config.maxQueue) return { accepted: false, reason: 'H18_QUEUE_FULL' };
      const party = this._partySnapshot();
      if (!party || !party.coordinationEnabled) return { accepted: false, reason: 'H18_OWNED_PARTY_REQUIRED' };
      const target = this._ownedTarget(targetName, party);
      if (!target) return { accepted: false, reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER' };
      const rawAmount = finite(amount);
      if (rawAmount == null || rawAmount <= 0 || !Number.isInteger(rawAmount)) {
        return { accepted: false, reason: 'H18_GOLD_AMOUNT_INVALID' };
      }
      const wanted = rawAmount;
      const snap = this._snapshot();
      const gold = snap && snap.character ? finite(snap.character.gold) : null;
      if (gold == null || gold - wanted < this.config.goldReserve) return { accepted: false, reason: 'H18_GOLD_RESERVE_BLOCKED' };
      const request = {
        id: 'h18-request-' + (++this.sequence),
        kind: 'GOLD',
        targetName: String(target.name),
        amount: wanted,
        createdAt: nowIso()
      };
      this.queue.push(request);
      this.metrics.goldQueued += 1;
      this.lastAction = { at: nowIso(), type: 'GOLD_QUEUED', request: clone(request) };
      return { accepted: true, request: clone(request) };
    }

    cancelQueue(reason = 'H18_QUEUE_CANCELLED') {
      if (this.currentAction) return { cancelled: false, reason: 'H18_ACTION_ACTIVE' };
      const count = this.queue.length;
      this.queue = [];
      this.lastAction = { at: nowIso(), type: 'QUEUE_CANCELLED', reason: cleanText(reason, 240), count };
      return { cancelled: count > 0, count };
    }

    _distance(a, b) {
      if (!a || !b || !a.map || !b.map || String(a.map) !== String(b.map)) return null;
      const ax = finite(a.x), ay = finite(a.y), bx = finite(b.x), by = finite(b.y);
      if ([ax, ay, bx, by].some(value => value == null)) return null;
      return Math.hypot(ax - bx, ay - by);
    }

    _regroupCandidate(party, snap) {
      if (!this.config.allowRegroup || !party || !party.coordinationEnabled || !snap || !snap.character) return null;
      const local = (party.ownedMembers || []).find(member => member.local);
      if (!local || local.rip) return null;
      const others = (party.ownedMembers || [])
        .filter(member => !member.local && !member.rip && member.visible && member.map && finite(member.x) != null && finite(member.y) != null);
      if (!others.length) return null;
      const leader = others.find(member => String(member.name) === String(party.leader || ''));
      const anchor = leader || others.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))[0];
      const distance = this._distance(snap.character, anchor);
      if (String(snap.character.map || '') === String(anchor.map || '') && distance != null && distance <= this.config.regroupDistance) return null;
      return {
        kind: 'REGROUP',
        targetName: anchor.name,
        destination: { map: anchor.map, x: anchor.x, y: anchor.y },
        distance
      };
    }

    _requestPlan(request, party, snap) {
      const target = request && this._ownedTarget(request.targetName, party);
      if (!target) return { state: 'BLOCKED', reason: 'H18_TARGET_NOT_OWNED_PARTY_MEMBER', selected: null };
      if (target.rip) return { state: 'WAITING', reason: 'H18_TARGET_DEAD', selected: null };
      if (!target.visible || !target.map || finite(target.x) == null || finite(target.y) == null) {
        return { state: 'WAITING', reason: 'H18_TARGET_NOT_VISIBLE', selected: null };
      }
      const distance = this._distance(snap.character, target);
      if (String(snap.character.map || '') !== String(target.map || '') || distance == null || distance > this.config.transferRange) {
        return {
          state: 'READY',
          reason: 'H18_APPROACH_REQUIRED',
          selected: {
            kind: 'APPROACH',
            requestId: request.id,
            targetName: target.name,
            destination: { map: target.map, x: target.x, y: target.y },
            distance
          }
        };
      }

      if (request.kind === 'SUPPLY') {
        const row = this._findSupplyRow(request.itemName, request.quantity);
        if (!row) return { state: 'BLOCKED', reason: 'H18_SUPPLY_ITEM_NOT_SAFE_OR_AVAILABLE', selected: null };
        const available = Math.max(1, Math.floor(Number(row.quantity) || 1));
        if (available < request.quantity) return { state: 'BLOCKED', reason: 'H18_SUPPLY_QUANTITY_UNAVAILABLE', selected: null };
        if (!this.actions || typeof this.actions.available !== 'function' || !this.actions.available('send_item')) {
          return { state: 'BLOCKED', reason: 'H18_SEND_ITEM_UNAVAILABLE', selected: null };
        }
        return {
          state: 'READY',
          reason: 'H18_SUPPLY_READY',
          selected: {
            kind: 'SUPPLY',
            requestId: request.id,
            targetName: target.name,
            itemName: request.itemName,
            quantity: request.quantity,
            slot: Number(row.slot),
            beforeQuantity: available
          }
        };
      }

      if (request.kind === 'GEAR') {
        const authorized = this._gearDeliveryRow(request.inventorySlot, request.targetName);
        if (!authorized) return { state: 'BLOCKED', reason: 'H18_GEAR_DELIVERY_NOT_AUTHORIZED', selected: null };
        const row = authorized.row;
        if (!this.actions || typeof this.actions.available !== 'function' || !this.actions.available('send_item')) {
          return { state: 'BLOCKED', reason: 'H18_SEND_ITEM_UNAVAILABLE', selected: null };
        }
        return {
          state: 'READY',
          reason: 'H18_GEAR_DELIVERY_READY',
          selected: {
            kind: 'GEAR',
            requestId: request.id,
            targetName: target.name,
            itemName: row.name,
            quantity: 1,
            slot: Number(row.slot),
            fingerprint: request.fingerprint || authorized.authorization.reservation && authorized.authorization.reservation.fingerprint || null,
            beforeQuantity: Math.max(1, Math.floor(Number(row.quantity) || 1))
          }
        };
      }

      if (request.kind === 'GOLD') {
        if (!this.actions || typeof this.actions.available !== 'function' || !this.actions.available('send_gold')) {
          return { state: 'BLOCKED', reason: 'H18_SEND_GOLD_UNAVAILABLE', selected: null };
        }
        const gold = finite(snap.character.gold);
        if (gold == null || gold - request.amount < this.config.goldReserve) {
          return { state: 'BLOCKED', reason: 'H18_GOLD_RESERVE_BLOCKED', selected: null };
        }
        return {
          state: 'READY',
          reason: 'H18_GOLD_READY',
          selected: {
            kind: 'GOLD',
            requestId: request.id,
            targetName: target.name,
            amount: request.amount,
            beforeGold: gold
          }
        };
      }

      return { state: 'BLOCKED', reason: 'H18_REQUEST_KIND_INVALID', selected: null };
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const party = this._partySnapshot();
      const movement = this._movementStatus();

      const base = {
        autonomyEnabled: this.autonomyEnabled,
        actionsThisSession: this.actionsThisSession,
        maxActionsPerSession: this.config.maxActionsPerSession,
        queue: clone(this.queue),
        party: clone(party)
      };

      if (this.suspendedReason) {
        return this.lastPlan = { ...base, state: 'SUSPENDED', reason: this.suspendedReason, selected: null };
      }
      if (!snap || !snap.available || !snap.character) {
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_CHARACTER_UNAVAILABLE', selected: null };
      }
      if (snap.character.rip === true) {
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_CHARACTER_DEAD', selected: null };
      }
      if (this.canAct && this.canAct('party-logistics') !== true) {
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_RUNTIME_ACTION_BLOCKED', selected: null };
      }
      if (!party || !party.coordinationEnabled) {
        if (party && Array.isArray(party.foreignMemberNames) && party.foreignMemberNames.length) this.metrics.foreignPartyBlocks += 1;
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_OWNED_PARTY_REQUIRED', selected: null };
      }
      if (this._combatActive()) {
        this.metrics.combatBlocks += 1;
        return this.lastPlan = { ...base, state: 'BLOCKED', reason: 'H18_COMBAT_ACTIVE', selected: null };
      }
      const externalBlockers = this._externalBusy();
      if (externalBlockers.length) {
        this.metrics.ownershipBlocks += 1;
        return this.lastPlan = { ...base, state: 'WAITING', reason: 'H18_EXTERNAL_OWNERSHIP_BUSY', selected: null, blockers: externalBlockers };
      }
      if (this.currentAction) {
        return this.lastPlan = { ...base, state: 'ACTIVE', reason: 'H18_ACTION_ACTIVE', selected: clone(this.currentAction) };
      }
      if (movement && movement.activeOrder) {
        const owner = String(movement.activeOrder.owner || '');
        if (owner === 'party-logistics-h18') {
          return this.lastPlan = { ...base, state: 'WAITING', reason: 'H18_MOVEMENT_OWNED', selected: null };
        }
        this.metrics.movementBlocks += 1;
        return this.lastPlan = { ...base, state: 'WAITING', reason: 'H18_MOVEMENT_BUSY', selected: null };
      }

      const request = this.queue[0] || null;
      if (request) {
        const requestPlan = this._requestPlan(request, party, snap);
        return this.lastPlan = { ...base, ...requestPlan };
      }

      const regroup = this._regroupCandidate(party, snap);
      if (regroup) {
        this.metrics.regroupPlanned += 1;
        return this.lastPlan = { ...base, state: 'READY', reason: 'H18_REGROUP_READY', selected: regroup };
      }

      return this.lastPlan = { ...base, state: 'IDLE', reason: 'H18_NO_LOGISTICS_WORK', selected: null };
    }

    _watch(value, action) {
      if (!value || typeof value.then !== 'function') {
        action.settlement = 'RETURNED';
        action.response = value == null ? null : clone(value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'RESOLVED';
        this.currentAction.response = response == null ? null : clone(response);
      }, error => {
        if (!this.currentAction || this.currentAction.id !== action.id) return;
        this.currentAction.settlement = 'REJECTED';
        this.currentAction.error = cleanText(error && (error.reason || error.message) || error || 'H18_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dequeueRequest(requestId) {
      if (!requestId) return;
      if (this.queue[0] && String(this.queue[0].id) === String(requestId)) this.queue.shift();
      else this.queue = this.queue.filter(row => String(row.id) !== String(requestId));
    }

    _finishCurrent(outcome, details = {}) {
      const current = this.currentAction;
      this.currentAction = null;
      if (outcome === 'CONFIRMED') {
        this.actionsThisSession += current && current.kind !== 'APPROACH' ? 1 : 0;
        if (current && current.kind === 'SUPPLY') this.metrics.suppliesConfirmed += 1;
        if (current && current.kind === 'GEAR') {
          this.metrics.gearConfirmed += 1;
          try {
            if (this.gearProgression && typeof this.gearProgression.completeGearDelivery === 'function') {
              this.gearProgression.completeGearDelivery(current.fingerprint || '', current.targetName);
            }
          } catch (_) {}
        }
        if (current && current.kind === 'GOLD') this.metrics.goldConfirmed += 1;
        if (current && current.kind === 'REGROUP') this.metrics.regroupsConfirmed += 1;
        if (current && ['SUPPLY','GEAR','GOLD'].includes(current.kind)) this._dequeueRequest(current.requestId);
      } else if (outcome === 'REJECTED') {
        if (current && current.kind === 'SUPPLY') this.metrics.suppliesRejected += 1;
        if (current && current.kind === 'GEAR') this.metrics.gearRejected += 1;
        if (current && current.kind === 'GOLD') this.metrics.goldRejected += 1;
        if (current && current.kind === 'REGROUP') this.metrics.regroupsRejected += 1;
        if (current && ['SUPPLY','GEAR','GOLD'].includes(current.kind)) this._dequeueRequest(current.requestId);
      } else {
        if (current && current.kind === 'SUPPLY') this.metrics.suppliesUnknown += 1;
        if (current && current.kind === 'GEAR') this.metrics.gearUnknown += 1;
        if (current && current.kind === 'GOLD') this.metrics.goldUnknown += 1;
        if (current && ['REGROUP','APPROACH'].includes(current.kind)) this.metrics.regroupsUnknown += 1;
      }
      this.lastAction = {
        at: nowIso(),
        type: 'ACTION_' + outcome,
        action: current ? clone(current) : null,
        details: clone(details)
      };
      return clone(this.lastAction);
    }

    _suspend(reason, details = {}) {
      this.suspendedReason = cleanText(reason || 'H18_UNKNOWN', 300) || 'H18_UNKNOWN';
      const result = this._finishCurrent('UNKNOWN', details);
      this.autonomyEnabled = false;
      this._cancelOwnedMovement(this.suspendedReason);
      return { state: 'SUSPENDED', reason: this.suspendedReason, result };
    }

    _observeMovement(current) {
      const movement = this._movementStatus();
      if (movement && movement.activeOrder
          && String(movement.activeOrder.id || '') === String(current.orderId || '')
          && String(movement.activeOrder.owner || '') === 'party-logistics-h18') {
        return { state: 'WAITING', action: clone(current) };
      }
      const last = movement && movement.lastOrder || null;
      if (last && String(last.id || '') === String(current.orderId || '')
          && String(last.owner || '') === 'party-logistics-h18') {
        const state = String(last.state || '');
        if (state === 'COMPLETED') {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', { movement: clone(last) }) };
        }
        if (['CANCELLED','REJECTED'].includes(state)) {
          return { state: 'REJECTED', result: this._finishCurrent('REJECTED', { movement: clone(last) }) };
        }
        if (['STUCK','UNKNOWN','FAILED_SAFE'].includes(state)) {
          return this._suspend('H18_MOVEMENT_' + state, { movement: clone(last) });
        }
      }
      if (Date.now() >= current.deadlineAtMs) return this._suspend('H18_MOVEMENT_TIMEOUT', { orderId: current.orderId });
      return { state: 'WAITING', action: clone(current) };
    }

    _observeCurrent() {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };
      if (current.kind === 'APPROACH' || current.kind === 'REGROUP') return this._observeMovement(current);

      if (current.settlement === 'REJECTED') {
        return this._suspend('H18_DISPATCH_REJECTED_WITHOUT_OUTCOME', { error: current.error || null });
      }
      if (current.response && current.response.failed === true) {
        return { state: 'REJECTED', result: this._finishCurrent('REJECTED', { response: clone(current.response) }) };
      }

      const settlementFinished = current.settlement !== 'PENDING';
      if (current.kind === 'SUPPLY' || current.kind === 'GEAR') {
        const row = current.kind === 'GEAR'
          ? (this._inventory() && (this._inventory().items || []).find(item => Number(item.slot) === Number(current.slot) && String(item.name || '') === String(current.itemName || '')))
          : this._supplyRowAt(current.slot, current.itemName);
        const after = row ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0;
        if (settlementFinished && current.beforeQuantity - after >= current.quantity) {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', {
            evidence: 'SENDER_INVENTORY_DELTA',
            beforeQuantity: current.beforeQuantity,
            afterQuantity: after
          }) };
        }
      }
      if (current.kind === 'GOLD') {
        const snap = this._snapshot();
        const afterGold = snap && snap.character ? finite(snap.character.gold) : null;
        if (settlementFinished && afterGold != null && current.beforeGold - afterGold >= current.amount) {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', {
            evidence: 'SENDER_GOLD_DELTA',
            beforeGold: current.beforeGold,
            afterGold
          }) };
        }
      }

      if (Date.now() >= current.deadlineAtMs) return this._suspend('H18_' + current.kind + '_UNVERIFIED_TIMEOUT');
      return { state: 'WAITING', action: clone(current) };
    }

    _startMovement(selected) {
      if (!selected || !selected.destination || !this.movement || typeof this.movement.smartMove !== 'function') {
        return { accepted: false, reason: 'H18_MOVEMENT_UNAVAILABLE' };
      }
      let moved = null;
      try {
        moved = this.movement.smartMove(selected.destination, {
          owner: 'party-logistics-h18',
          arrivalRadius: this.config.regroupArrivalRadius
        });
      } catch (error) {
        return { accepted: false, reason: cleanText(error && error.message || error, 300) };
      }
      if (!moved || moved.accepted !== true || !moved.order || !moved.order.id) {
        this.metrics.movementBlocks += 1;
        return { accepted: false, reason: moved && moved.reason || 'H18_MOVEMENT_REJECTED' };
      }
      const now = Date.now();
      const current = {
        id: 'h18-action-' + (++this.sequence),
        kind: selected.kind,
        requestId: selected.requestId || null,
        targetName: selected.targetName || null,
        orderId: moved.order.id,
        startedAt: nowIso(),
        startedAtMs: now,
        deadlineAtMs: now + this.config.movementTimeoutMs
      };
      this.currentAction = current;
      this.metrics.regroupRequests += 1;
      this.lastAction = { at: current.startedAt, type: selected.kind + '_STARTED', action: clone(current) };
      return { accepted: true, action: clone(current), movement: clone(moved) };
    }

    _dispatchSelected(selected) {
      if (!selected || !this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H18_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let actionName;
      let args;
      if (selected.kind === 'SUPPLY' || selected.kind === 'GEAR') {
        actionName = 'send_item';
        args = [selected.targetName, selected.slot, selected.quantity];
      } else if (selected.kind === 'GOLD') {
        actionName = 'send_gold';
        args = [selected.targetName, selected.amount];
      } else {
        return { accepted: false, reason: 'H18_SELECTED_KIND_UNSUPPORTED' };
      }

      let dispatch;
      try { dispatch = this.actions.dispatch(actionName, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        if (dispatch && dispatch.state === 'UNKNOWN') {
          this.currentAction = {
            id: 'h18-action-' + (++this.sequence),
            kind: selected.kind,
            requestId: selected.requestId || null,
            targetName: selected.targetName || null
          };
          return this._suspend('H18_' + selected.kind + '_DISPATCH_UNKNOWN', { error: dispatch.error || null });
        }
        return { accepted: false, reason: dispatch && dispatch.state || 'H18_ACTION_REJECTED' };
      }

      const now = Date.now();
      const current = {
        id: 'h18-action-' + (++this.sequence),
        kind: selected.kind,
        requestId: selected.requestId || null,
        targetName: selected.targetName,
        itemName: selected.itemName || null,
        quantity: selected.quantity || null,
        slot: selected.slot == null ? null : Number(selected.slot),
        amount: selected.amount || null,
        beforeQuantity: selected.beforeQuantity == null ? null : Number(selected.beforeQuantity),
        fingerprint: selected.fingerprint || null,
        beforeGold: selected.beforeGold == null ? null : Number(selected.beforeGold),
        dispatchedAt: nowIso(),
        dispatchedAtMs: now,
        deadlineAtMs: now + this.config.outcomeTimeoutMs,
        settlement: 'PENDING',
        response: null,
        error: null
      };
      this.currentAction = current;
      if (selected.kind === 'SUPPLY') this.metrics.suppliesDispatched += 1;
      if (selected.kind === 'GEAR') this.metrics.gearDispatched += 1;
      if (selected.kind === 'GOLD') this.metrics.goldDispatched += 1;
      this.lastAction = { at: current.dispatchedAt, type: selected.kind + '_DISPATCHED', action: clone(current) };
      this._watch(dispatch.value, current);
      return { accepted: true, action: clone(current) };
    }

    _cancelOwnedMovement(reason) {
      try {
        const status = this._movementStatus();
        if (status && status.activeOrder && String(status.activeOrder.owner || '') === 'party-logistics-h18'
            && this.movement && typeof this.movement.cancel === 'function') {
          this.movement.cancel(cleanText(reason, 180) || 'H18_CANCEL');
        }
      } catch (_) {}
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'IDLE', reason: 'H18_MODULE_INACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.currentAction) {
        const observed = this._observeCurrent();
        if (observed.state !== 'IDLE') return observed;
      }

      const plan = this.plan();
      let delegatedGear = false;
      if (!this.autonomyEnabled && this.queue[0] && String(this.queue[0].kind || '') === 'GEAR') {
        try {
          const economy = this.economy && typeof this.economy.status === 'function' ? this.economy.status() : null;
          delegatedGear = !!(economy
            && economy.currentAction
            && String(economy.currentAction.module || '') === 'partyLogistics'
            && String(economy.currentAction.kind || '') === 'GEAR_DELIVER');
        } catch (_) {}
      }
      if (!this.autonomyEnabled && !delegatedGear) return { state: 'OBSERVE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.metrics.sessionBudgetBlocks += 1;
        this.autonomyEnabled = false;
        this.lastAction = { at: nowIso(), type: 'SESSION_BUDGET_REACHED', actions: this.actionsThisSession };
        return { state: 'COMPLETE', reason: 'H18_SESSION_ACTION_BUDGET_REACHED', plan };
      }
      if (!plan || plan.state !== 'READY' || !plan.selected) {
        return { state: plan && plan.state || 'IDLE', reason: plan && plan.reason || 'H18_NO_LOGISTICS_WORK', plan };
      }

      let result;
      if (plan.selected.kind === 'APPROACH' || plan.selected.kind === 'REGROUP') {
        result = this._startMovement(plan.selected);
      } else {
        result = this._dispatchSelected(plan.selected);
      }

      if (!result || result.accepted !== true) {
        if (result && result.state === 'SUSPENDED') return result;
        const selected = plan.selected || {};
        if (selected.kind === 'SUPPLY') this.metrics.suppliesRejected += 1;
        if (selected.kind === 'GEAR') this.metrics.gearRejected += 1;
        if (selected.kind === 'GOLD') this.metrics.goldRejected += 1;
        if (selected.kind === 'REGROUP') this.metrics.regroupsRejected += 1;
        if (selected.requestId && ['SUPPLY','GEAR','GOLD'].includes(selected.kind)) this._dequeueRequest(selected.requestId);
        this.lastAction = {
          at: nowIso(),
          type: 'ACTION_QUEUE_REJECTED',
          selected: clone(selected),
          reason: result && result.reason || 'H18_ACTION_REJECTED'
        };
        return { state: 'REJECTED', reason: this.lastAction.reason, plan, result: clone(result) };
      }

      if (plan.selected.kind !== 'APPROACH') this.metrics.actionsQueued = Number(this.metrics.actionsQueued || 0) + 1;
      return { state: 'QUEUED', plan, result };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        queue: clone(this.queue),
        currentAction: clone(this.currentAction),
        actionsThisSession: this.actionsThisSession,
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics),
        supplyCatalog: this.supplyCatalog()
      };
    }
  }

  ns.PartyLogisticsController = PartyLogisticsController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
