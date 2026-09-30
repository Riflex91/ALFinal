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

  class BankController {
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
      this.sequence = 0;
      this.lastPlan = null;
      this.lastAction = null;
      this.reservations = {};
      this.workspace = { preferredPack: null };
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 6000)),
        bankMountTimeoutMs: Math.max(3000, Math.min(120000, Number(options.bankMountTimeoutMs) || 45000))
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        searches: 0,
        movementRequests: 0,
        movementUnknown: 0,
        depositsDispatched: 0,
        depositsConfirmed: 0,
        depositsRejected: 0,
        depositsUnknown: 0,
        withdrawalsDispatched: 0,
        withdrawalsConfirmed: 0,
        withdrawalsRejected: 0,
        withdrawalsUnknown: 0,
        goldDepositsDispatched: 0,
        goldDepositsConfirmed: 0,
        goldDepositsRejected: 0,
        goldDepositsUnknown: 0,
        goldWithdrawalsDispatched: 0,
        goldWithdrawalsConfirmed: 0,
        goldWithdrawalsRejected: 0,
        goldWithdrawalsUnknown: 0,
        reconciliations: 0,
        reconciliationFailures: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H12_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('bank-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H12_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
          this.movement.cancel(cleanText(reason, 180) || 'H12_MODULE_STOP');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H12_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
          this.movement.cancel(cleanText(reason, 180) || 'H12_EXPLICIT_RESET');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H12_REQUEST_CANCELLED') {
      this.request = null;
      this.pending = null;
      try {
        const movement = this.movement && this.movement.status ? this.movement.status() : null;
        if (movement && movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
          this.movement.cancel(cleanText(reason, 180) || 'H12_REQUEST_CANCELLED');
        }
      } catch (_) {}
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    setReservations(reservations = {}) {
      const next = {};
      if (reservations && typeof reservations === 'object') {
        for (const [name, raw] of Object.entries(reservations)) {
          const itemName = cleanText(name, 160);
          const quantity = Math.max(0, Math.floor(Number(raw) || 0));
          if (itemName && quantity > 0) next[itemName] = quantity;
        }
      }
      this.reservations = next;
      return clone(this.reservations);
    }

    setWorkspace(options = {}) {
      const preferredPack = cleanText(options && options.preferredPack || '', 120) || null;
      this.workspace = { preferredPack };
      return clone(this.workspace);
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _inventoryPlan() {
      try {
        if (this.inventory && typeof this.inventory.plan === 'function') return this.inventory.plan();
      } catch (_) {}
      return null;
    }

    _inventorySnapshot() {
      try {
        if (this.game && typeof this.game.inventorySnapshot === 'function') return this.game.inventorySnapshot();
      } catch (_) {}
      return null;
    }

    _bankSnapshot() {
      try {
        if (this.game && typeof this.game.bankSnapshot === 'function') return this.game.bankSnapshot();
      } catch (_) {}
      return null;
    }

    _localMerchant() {
      const snap = this._snapshot();
      return !!(snap && snap.available && snap.character
        && String(snap.character.ctype || '').toLowerCase() === 'merchant'
        && snap.character.rip !== true);
    }

    _fingerprint(row) {
      if (!row || !row.name) return null;
      return [
        String(row.name),
        String(Math.max(0, Number(row.level) || 0)),
        cleanText(row.statType || '', 80),
        stableProperty(row.property)
      ].join('|');
    }

    _quantityInInventory(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _quantityInBank(snapshot, fingerprint) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.packs || []).reduce((sum, pack) =>
        sum + (pack.items || []).reduce((inner, row) =>
          inner + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0), 0);
    }

    _bankItem(snapshot, packName, slot) {
      if (!snapshot || snapshot.available === false) return null;
      const pack = (snapshot.packs || []).find(row => String(row.name) === String(packName));
      return pack && (pack.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _inventoryItem(snapshot, slot) {
      if (!snapshot || snapshot.available === false) return null;
      return (snapshot.items || []).find(row => Number(row.slot) === Number(slot)) || null;
    }

    _safeDepositRows() {
      const plan = this._inventoryPlan();
      if (!plan || plan.state !== 'READY') return [];
      return (plan.items || []).filter(row => {
        if (!row || !row.name || String(row.disposition || '').toUpperCase() !== 'BANK') return false;
        if (row.locked === true || row.giveaway === true || row.expiresAt) return false;
        const future = row.futureGearEvaluation || null;
        const offlineGear = !!(future
          && future.checked === true
          && future.protected === true
          && String(future.action || '').toUpperCase() === 'GEAR'
          && future.futureGear
          && future.futureGear.targetOnline === false
          && future.futureGear.targetCharacter);
        if (offlineGear) return true;
        return Math.max(0, Number(row.level) || 0) === 0
          && !(row.definition && (row.definition.quest === true || row.definition.upgrade === true || row.definition.compound === true));
      });
    }

    _ledger(inventory, bank) {
      const rows = new Map();
      const add = (row, location) => {
        const fingerprint = this._fingerprint(row);
        if (!fingerprint) return;
        if (!rows.has(fingerprint)) rows.set(fingerprint, {
          fingerprint,
          name: row.name,
          level: Math.max(0, Number(row.level) || 0),
          inventoryQuantity: 0,
          bankQuantity: 0,
          locations: []
        });
        const entry = rows.get(fingerprint);
        const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
        if (location.kind === 'inventory') entry.inventoryQuantity += quantity;
        else entry.bankQuantity += quantity;
        entry.locations.push({ ...location, quantity });
      };
      if (inventory && inventory.available !== false) {
        for (const row of inventory.items || []) add(row, { kind: 'inventory', slot: row.slot });
      }
      if (bank && bank.available !== false) {
        for (const pack of bank.packs || []) {
          for (const row of pack.items || []) add(row, { kind: 'bank', pack: pack.name, slot: row.slot });
        }
      }
      return [...rows.values()];
    }

    reconcile() {
      const inventory = this._inventorySnapshot();
      const bank = this._bankSnapshot();
      this.metrics.reconciliations += 1;
      const available = !!(inventory && inventory.available !== false && bank && bank.available !== false);
      if (!available) this.metrics.reconciliationFailures += 1;
      return {
        available,
        reason: !inventory || inventory.available === false
          ? 'H12_INVENTORY_UNAVAILABLE'
          : !bank || bank.available === false
            ? 'H12_BANK_NOT_MOUNTED'
            : null,
        inventory: clone(inventory),
        bank: clone(bank),
        ledger: available ? this._ledger(inventory, bank) : []
      };
    }

    search(itemName) {
      const wanted = cleanText(itemName || '', 160);
      this.metrics.searches += 1;
      const bank = this._bankSnapshot();
      if (!wanted || !bank || bank.available === false) return [];
      const out = [];
      for (const pack of bank.packs || []) {
        for (const row of pack.items || []) {
          if (String(row.name) === wanted) out.push(clone(row));
        }
      }
      return out;
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const bank = this._bankSnapshot();
      const inventory = this._inventorySnapshot();
      const safeDepositRows = this._safeDepositRows();
      const packs = bank && bank.available !== false ? bank.packs || [] : [];
      const plan = {
        state: !snap || !snap.available || !snap.character
          ? 'BLOCKED'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'BLOCKED'
            : bank && bank.available !== false
              ? 'READY'
              : 'NEEDS_BANK',
        reason: !snap || !snap.available || !snap.character
          ? 'CHARACTER_UNAVAILABLE'
          : String(snap.character.ctype || '').toLowerCase() !== 'merchant'
            ? 'H12_REQUIRES_MERCHANT'
            : bank && bank.available !== false
              ? 'H12_BANK_READY'
              : 'H12_BANK_NOT_MOUNTED',
        character: snap && snap.character ? {
          name: snap.character.name,
          ctype: snap.character.ctype,
          map: snap.character.map
        } : null,
        bank: bank ? {
          available: bank.available,
          reason: bank.reason,
          map: bank.map,
          gold: bank.gold,
          capacity: bank.capacity,
          usedSlots: bank.usedSlots,
          freeSlots: bank.freeSlots
        } : null,
        packs: clone(packs),
        safeDepositRows: clone(safeDepositRows),
        reservations: clone(this.reservations),
        workspace: clone(this.workspace),
        reconciliation: inventory && inventory.available !== false && bank && bank.available !== false
          ? this._ledger(inventory, bank)
          : []
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _workspaceSlot(bank, preferredPack) {
      if (!bank || bank.available === false) return null;
      const wanted = cleanText(preferredPack || this.workspace.preferredPack || '', 120);
      let packs = (bank.packs || []).slice();
      if (wanted) packs = packs.sort((a, b) => (String(a.name) === wanted ? -1 : String(b.name) === wanted ? 1 : 0));
      for (const pack of packs) {
        if (!bank.map || !pack.map || String(pack.map) !== String(bank.map)) continue;
        const occupied = new Set((pack.items || []).map(row => Number(row.slot)));
        const capacity = Math.max(0, Number(pack.capacity) || 0);
        for (let slot = 0; slot < capacity; slot += 1) {
          if (!occupied.has(slot)) return { pack: String(pack.name), slot };
        }
      }
      return null;
    }

    queueMount() {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const bank = this._bankSnapshot();
      if (bank && bank.available !== false) {
        this.lastAction = { at: nowIso(), type: 'BANK_ALREADY_MOUNTED', map: bank.map || null };
        return { accepted: true, state: 'READY', alreadyMounted: true, bank: clone(bank) };
      }
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind: 'MOUNT',
        travelRequested: false,
        bankTravelStartedAtMs: null,
        createdAt: nowIso()
      };
      this.lastAction = { at: nowIso(), type: 'MOUNT_QUEUED' };
      return { accepted: true, request: clone(this.request) };
    }

    queueDeposit(itemName, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const wanted = cleanText(itemName || '', 160);
      const slotWanted = finite(options.inventorySlot);
      const candidates = this._safeDepositRows().filter(row =>
        String(row.name) === wanted && (slotWanted == null || Number(row.slot) === slotWanted));
      const row = candidates[0];
      if (!row) return { accepted: false, reason: 'H12_DEPOSIT_ITEM_NOT_SAFE_OR_AVAILABLE' };
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind: 'DEPOSIT',
        itemName: row.name,
        fingerprint: this._fingerprint(row),
        inventorySlot: Number(row.slot),
        beforeQuantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
        preferredPack: cleanText(options.preferredPack || '', 120) || null,
        travelRequested: false,
        bankTravelStartedAtMs: null,
        createdAt: nowIso()
      };
      this.lastAction = { at: nowIso(), type: 'DEPOSIT_QUEUED', itemName: row.name, slot: row.slot };
      return { accepted: true, request: clone(this.request) };
    }

    queueWithdraw(packName, bankSlot, options = {}) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const pack = cleanText(packName || '', 120);
      const slot = finite(bankSlot);
      if (!pack || slot == null) return { accepted: false, reason: 'H12_WITHDRAW_LOCATION_REQUIRED' };
      const bank = this._bankSnapshot();
      if (!bank || bank.available === false) return { accepted: false, reason: 'H12_BANK_NOT_MOUNTED' };
      const packView = (bank.packs || []).find(entry => String(entry.name) === pack) || null;
      if (!packView || !bank.map || !packView.map || String(packView.map) !== String(bank.map)) {
        return { accepted: false, reason: 'H12_WITHDRAW_WRONG_OR_UNKNOWN_BANK_MAP' };
      }
      const row = this._bankItem(bank, pack, slot);
      if (!row) return { accepted: false, reason: 'H12_WITHDRAW_ITEM_NOT_FOUND' };
      const reserved = Math.max(0, Math.floor(Number(this.reservations[row.name]) || 0));
      const totalInBank = this._quantityInBank(bank, this._fingerprint(row));
      const stackQuantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
      const gearDelivery = String(options.purpose || '').toUpperCase() === 'GEAR_DELIVERY';
      if (!gearDelivery && totalInBank != null && totalInBank - stackQuantity < reserved) {
        return { accepted: false, reason: 'H12_BANK_RESERVATION_BLOCKED' };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H12_INVENTORY_FULL_OR_UNAVAILABLE' };
      }
      let inventorySlot = finite(options.inventorySlot);
      if (inventorySlot != null && this._inventoryItem(inventory, inventorySlot)) {
        return { accepted: false, reason: 'H12_WITHDRAW_TARGET_SLOT_OCCUPIED' };
      }
      if (inventorySlot == null) {
        const occupied = new Set((inventory.items || []).map(item => Number(item.slot)));
        for (let i = 0; i < Number(inventory.capacity || 0); i += 1) {
          if (!occupied.has(i)) { inventorySlot = i; break; }
        }
      }
      if (inventorySlot == null) return { accepted: false, reason: 'H12_INVENTORY_FULL_OR_UNAVAILABLE' };
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind: 'WITHDRAW',
        itemName: row.name,
        fingerprint: this._fingerprint(row),
        pack,
        bankSlot: slot,
        inventorySlot,
        beforeQuantity: stackQuantity,
        purpose: cleanText(options.purpose || '', 80) || null,
        createdAt: nowIso()
      };
      this.lastAction = { at: nowIso(), type: 'WITHDRAW_QUEUED', itemName: row.name, pack, bankSlot: slot };
      return { accepted: true, request: clone(this.request) };
    }

    queueGoldDeposit(amount) {
      return this._queueGold('GOLD_DEPOSIT', amount);
    }

    queueGoldWithdraw(amount) {
      return this._queueGold('GOLD_WITHDRAW', amount);
    }

    _queueGold(kind, amount) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H12_BUSY' };
      if (!this._localMerchant()) return { accepted: false, reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      const bank = this._bankSnapshot();
      const snap = this._snapshot();
      const requested = finite(amount);
      if (requested == null || requested <= 0 || !Number.isInteger(requested)) {
        return { accepted: false, reason: 'H12_GOLD_AMOUNT_INVALID' };
      }
      const value = requested;
      if (!bank || bank.available === false || finite(bank.gold) == null) {
        return { accepted: false, reason: 'H12_BANK_GOLD_UNOBSERVABLE' };
      }
      if (!snap || !snap.character || finite(snap.character.gold) == null) {
        return { accepted: false, reason: 'H12_CHARACTER_GOLD_UNOBSERVABLE' };
      }
      if (kind === 'GOLD_DEPOSIT' && Number(snap.character.gold) < value) {
        return { accepted: false, reason: 'H12_GOLD_DEPOSIT_AMOUNT_UNAVAILABLE' };
      }
      if (kind === 'GOLD_WITHDRAW' && Number(bank.gold) < value) {
        return { accepted: false, reason: 'H12_GOLD_WITHDRAW_AMOUNT_UNAVAILABLE' };
      }
      this.request = {
        id: 'bank-request-' + (++this.sequence),
        kind,
        amount: value,
        beforeBankGold: Number(bank.gold),
        beforeCharacterGold: Number(snap.character.gold),
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
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
        this.pending.error = cleanText(error && error.message || error && error.reason || error || 'H12_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _metric(kind, suffix) {
      const names = {
        DEPOSIT: 'deposits',
        WITHDRAW: 'withdrawals',
        GOLD_DEPOSIT: 'goldDeposits',
        GOLD_WITHDRAW: 'goldWithdrawals'
      };
      const key = (names[kind] || '') + suffix;
      if (Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.pending = null;
      this.request = null;
      this.suspendedReason = cleanText(reason || 'H12_UNKNOWN', 240) || 'H12_UNKNOWN';
      this.lastAction = { at: nowIso(), type: kind + '_UNKNOWN', reason: this.suspendedReason };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _observed(pending) {
      const inventory = this._inventorySnapshot();
      const bank = this._bankSnapshot();
      if (!inventory || inventory.available === false || !bank || bank.available === false) return false;

      if (pending.kind === 'DEPOSIT') {
        const invQty = this._quantityInInventory(inventory, pending.fingerprint);
        const bankQty = this._quantityInBank(bank, pending.fingerprint);
        if (invQty == null || bankQty == null) return false;
        const target = this._bankItem(bank, pending.pack, pending.bankSlot);
        return invQty <= pending.beforeInventoryQuantity - pending.quantity
          && bankQty >= pending.beforeBankQuantity + pending.quantity
          && !!target
          && this._fingerprint(target) === pending.fingerprint;
      }

      if (pending.kind === 'WITHDRAW') {
        const invQty = this._quantityInInventory(inventory, pending.fingerprint);
        const bankQty = this._quantityInBank(bank, pending.fingerprint);
        if (invQty == null || bankQty == null) return false;
        const target = this._inventoryItem(inventory, pending.inventorySlot);
        return invQty >= pending.beforeInventoryQuantity + pending.quantity
          && bankQty <= pending.beforeBankQuantity - pending.quantity
          && !!target
          && this._fingerprint(target) === pending.fingerprint;
      }

      const snap = this._snapshot();
      const bankGold = finite(bank.gold);
      const characterGold = snap && snap.character && finite(snap.character.gold);
      if (bankGold == null || characterGold == null) return false;
      if (pending.kind === 'GOLD_DEPOSIT') {
        return bankGold >= pending.beforeBankGold + pending.amount
          && characterGold <= pending.beforeCharacterGold - pending.amount;
      }
      if (pending.kind === 'GOLD_WITHDRAW') {
        return bankGold <= pending.beforeBankGold - pending.amount
          && characterGold >= pending.beforeCharacterGold + pending.amount;
      }
      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.settlement === 'REJECTED') {
        return this._suspend(pending.kind, pending.error || 'H12_ACTION_REJECTED');
      }
      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Rejected');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H12_ACTION_REJECTED', 240)
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
          itemName: pending.itemName || null,
          pack: pending.pack || null,
          bankSlot: pending.bankSlot == null ? null : pending.bankSlot,
          inventorySlot: pending.inventorySlot == null ? null : pending.inventorySlot,
          purpose: pending.purpose || null,
          amount: pending.amount || null
        };
        return true;
      }
      if (Date.now() >= pending.deadlineAtMs) {
        return this._suspend(pending.kind, 'H12_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      }
      return false;
    }

    _dispatch(action, args, pendingBase) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H12_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') {
          return this._suspend(pendingBase.kind, result.error && result.error.message || 'H12_DISPATCH_UNKNOWN');
        }
        this._metric(pendingBase.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H12_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'bank-pending-' + (++this.sequence),
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

    _ensureBankMounted(request) {
      const bank = this._bankSnapshot();
      if (bank && bank.available !== false) return { ready: true, bank };

      const now = Date.now();
      if (request.bankTravelStartedAtMs != null && now - request.bankTravelStartedAtMs >= this.config.bankMountTimeoutMs) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, 'H12_BANK_MOUNT_TIMEOUT');
      }

      let movement = null;
      try { movement = this.movement && this.movement.status ? this.movement.status() : null; } catch (_) {}
      if (movement && movement.activeOrder) {
        if (String(movement.activeOrder.owner || '') === 'bank-h12') return { ready: false, waiting: true };
        return { ready: false, waiting: true, reason: 'H12_MOVEMENT_OWNED_BY_OTHER' };
      }

      if (request.travelRequested) return { ready: false, waiting: true };

      if (!this.movement || typeof this.movement.smartMove !== 'function') {
        return this._suspend(request.kind, 'H12_MOVEMENT_UNAVAILABLE');
      }
      const moved = this.movement.smartMove('bank', { owner: 'bank-h12' });
      if (!moved || moved.accepted !== true) {
        this.metrics.movementUnknown += 1;
        return this._suspend(request.kind, moved && moved.reason || 'H12_BANK_MOVE_REJECTED');
      }
      request.travelRequested = true;
      request.bankTravelStartedAtMs = now;
      this.metrics.movementRequests += 1;
      this.lastAction = { at: nowIso(), type: 'BANK_MOVE_REQUESTED' };
      return { ready: false, waiting: true };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H12_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();

      if (!this._localMerchant()) {
        this.request = null;
        return { state: 'BLOCKED', reason: 'H12_REQUIRES_LIVE_MERCHANT' };
      }

      const mounted = this._ensureBankMounted(request);
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (!mounted || mounted.ready !== true) return { state: 'WAITING_BANK', reason: mounted && mounted.reason || 'H12_BANK_TRAVEL' };
      const bank = mounted.bank;
      if (request.kind === 'MOUNT') {
        this.request = null;
        this.lastAction = {
          at: nowIso(),
          type: 'BANK_MOUNTED',
          map: bank.map || null,
          packs: (bank.packs || []).length,
          usedSlots: Number(bank.usedSlots || 0)
        };
        return {
          state: 'READY',
          reason: 'H12_BANK_READY',
          bank: {
            map: bank.map || null,
            packs: (bank.packs || []).length,
            usedSlots: Number(bank.usedSlots || 0),
            freeSlots: Number(bank.freeSlots || 0)
          }
        };
      }
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) {
        return { state: 'BLOCKED', reason: 'H12_INVENTORY_UNAVAILABLE' };
      }

      if (request.kind === 'DEPOSIT') {
        const current = this._inventoryItem(inventory, request.inventorySlot);
        if (!current || this._fingerprint(current) !== request.fingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_DEPOSIT_SOURCE_CHANGED' };
        }
        const workspace = this._workspaceSlot(bank, request.preferredPack);
        if (!workspace) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_BANK_NO_WORKSPACE_SLOT' };
        }
        const beforeInventoryQuantity = this._quantityInInventory(inventory, request.fingerprint);
        const beforeBankQuantity = this._quantityInBank(bank, request.fingerprint);
        if (beforeInventoryQuantity == null || beforeBankQuantity == null) {
          return { state: 'BLOCKED', reason: 'H12_RECONCILIATION_UNAVAILABLE' };
        }
        const quantity = Math.max(1, Math.floor(Number(current.quantity) || 1));
        return this._dispatch('bank_store', [request.inventorySlot, workspace.pack, workspace.slot], {
          kind: 'DEPOSIT',
          itemName: current.name,
          fingerprint: request.fingerprint,
          quantity,
          inventorySlot: request.inventorySlot,
          pack: workspace.pack,
          bankSlot: workspace.slot,
          beforeInventoryQuantity,
          beforeBankQuantity
        });
      }

      if (request.kind === 'WITHDRAW') {
        const current = this._bankItem(bank, request.pack, request.bankSlot);
        if (!current || this._fingerprint(current) !== request.fingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_WITHDRAW_SOURCE_CHANGED' };
        }
        if (this._inventoryItem(inventory, request.inventorySlot)) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H12_WITHDRAW_TARGET_SLOT_OCCUPIED' };
        }
        const beforeInventoryQuantity = this._quantityInInventory(inventory, request.fingerprint);
        const beforeBankQuantity = this._quantityInBank(bank, request.fingerprint);
        if (beforeInventoryQuantity == null || beforeBankQuantity == null) {
          return { state: 'BLOCKED', reason: 'H12_RECONCILIATION_UNAVAILABLE' };
        }
        const quantity = Math.max(1, Math.floor(Number(current.quantity) || 1));
        return this._dispatch('bank_retrieve', [request.pack, request.bankSlot, request.inventorySlot], {
          kind: 'WITHDRAW',
          itemName: current.name,
          fingerprint: request.fingerprint,
          quantity,
          inventorySlot: request.inventorySlot,
          pack: request.pack,
          bankSlot: request.bankSlot,
          purpose: request.purpose || null,
          beforeInventoryQuantity,
          beforeBankQuantity
        });
      }

      if (request.kind === 'GOLD_DEPOSIT') {
        const snap = this._snapshot();
        const liveBankGold = finite(bank.gold);
        const characterGold = snap && snap.character && finite(snap.character.gold);
        if (liveBankGold == null || characterGold == null) return this._suspend(request.kind, 'H12_GOLD_OBSERVATION_LOST');
        return this._dispatch('bank_deposit', [request.amount], {
          kind: request.kind,
          amount: request.amount,
          beforeBankGold: liveBankGold,
          beforeCharacterGold: characterGold
        });
      }

      if (request.kind === 'GOLD_WITHDRAW') {
        const snap = this._snapshot();
        const liveBankGold = finite(bank.gold);
        const characterGold = snap && snap.character && finite(snap.character.gold);
        if (liveBankGold == null || characterGold == null) return this._suspend(request.kind, 'H12_GOLD_OBSERVATION_LOST');
        return this._dispatch('bank_withdraw', [request.amount], {
          kind: request.kind,
          amount: request.amount,
          beforeBankGold: liveBankGold,
          beforeCharacterGold: characterGold
        });
      }

      this.request = null;
      return { state: 'BLOCKED', reason: 'H12_REQUEST_UNKNOWN' };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        request: clone(this.request),
        workspace: clone(this.workspace),
        reservations: clone(this.reservations),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.BankController = BankController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
