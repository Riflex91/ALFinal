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

  const DEFAULT_PRIORITIES = Object.freeze({
    BANK_MOUNT: 110,
    BANK_DEPOSIT: 100,
    GEAR_EQUIP: 90,
    MARKET_SELL: 75,
    EXCHANGE: 70,
    CRAFT: 65,
    UPGRADE: 55,
    COMPOUND: 50,
    NPC_SELL: 40
  });

  const DEFAULT_KINDS = Object.freeze({
    BANK_MOUNT: true,
    BANK_DEPOSIT: true,
    GEAR_EQUIP: true,
    MARKET_SELL: true,
    EXCHANGE: true,
    CRAFT: true,
    UPGRADE: true,
    COMPOUND: true,
    NPC_SELL: true
  });

  class EconomyController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.movement = options.movement || null;
      this.combat = options.combat || null;
      this.inventory = options.inventory || null;
      this.merchant = options.merchant || null;
      this.bank = options.bank || null;
      this.trade = options.trade || null;
      this.gear = options.gear || null;
      this.upgrade = options.upgrade || null;
      this.exchangeCraft = options.exchangeCraft || null;
      this.canAct = typeof options.canAct === 'function' ? options.canAct : null;

      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.scope = null;
      this.suspendedReason = null;
      this.currentAction = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.rejectionBackoff = new Map();

      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 1000)),
        actionCooldownMs: Math.max(0, Math.min(60000, Number(options.actionCooldownMs) || 1500)),
        rejectionBackoffMs: Math.max(1000, Math.min(300000, Number(options.rejectionBackoffMs) || 15000)),
        actionTimeoutMs: Math.max(5000, Math.min(300000, Number(options.actionTimeoutMs) || 120000)),
        maxActionsPerSession: Math.max(1, Math.min(100, Math.floor(Number(options.maxActionsPerSession) || 12))),
        minMarketPremiumRatio: Math.max(1, Math.min(10, finite(options.minMarketPremiumRatio) == null ? 1 : finite(options.minMarketPremiumRatio))),
        priorities: { ...DEFAULT_PRIORITIES, ...(options.priorities || {}) },
        allowKinds: { ...DEFAULT_KINDS, ...(options.allowKinds || {}) }
      };

      this.metrics = {
        ticks: 0,
        plans: 0,
        proposals: 0,
        conflictBlocks: 0,
        combatBlocks: 0,
        movementBlocks: 0,
        actionsQueued: 0,
        actionsConfirmed: 0,
        actionsRejected: 0,
        actionsUnknown: 0,
        rejectionBackoffs: 0,
        sessionBudgetBlocks: 0,
        byKind: {}
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H17_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      this.autonomyEnabled = false;
      this.currentAction = null;
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.rejectionBackoff.clear();
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('economy-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H17_MODULE_STOP') {
      this.moduleActive = false;
      this.autonomyEnabled = false;
      this.scope = null;
      this.currentAction = null;
      this.cooldownUntilMs = null;
      this.rejectionBackoff.clear();
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H17_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.currentAction) return { accepted: false, reason: 'H17_ACTION_ACTIVE' };
      if (this.canAct && this.canAct('economy') !== true) return { accepted: false, reason: 'H17_RUNTIME_ACTION_BLOCKED' };
      if (options.maxActions != null) {
        this.config.maxActionsPerSession = Math.max(1, Math.min(100, Math.floor(Number(options.maxActions) || 1)));
      }
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.autonomyEnabled = true;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STARTED', maxActions: this.config.maxActionsPerSession };
      return { accepted: true, status: this.status() };
    }

    stopAutonomy(reason = 'H17_AUTONOMY_STOP') {
      this.autonomyEnabled = false;
      this.lastAction = { at: nowIso(), type: 'AUTONOMY_STOPPED', reason: cleanText(reason, 240) };
      return this.status();
    }

    resetSafety(reason = 'H17_EXPLICIT_RESET') {
      if (this.currentAction) {
        this.lastAction = { at: nowIso(), type: 'RESET_BLOCKED', reason: 'H17_ACTION_ACTIVE' };
        return { ...this.status(), reset: false, reason: 'H17_ACTION_ACTIVE' };
      }
      this.suspendedReason = null;
      this.autonomyEnabled = false;
      this.actionsThisSession = 0;
      this.cooldownUntilMs = null;
      this.rejectionBackoff.clear();
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    policy(value = null) {
      if (value == null) return clone(this.config);
      if (!value || typeof value !== 'object') throw new Error('H17_POLICY_MUST_BE_OBJECT');
      if (value.maxActionsPerSession != null) this.config.maxActionsPerSession = Math.max(1, Math.min(100, Math.floor(Number(value.maxActionsPerSession) || 1)));
      if (value.actionCooldownMs != null) this.config.actionCooldownMs = Math.max(0, Math.min(60000, Math.floor(Number(value.actionCooldownMs) || 0)));
      if (value.rejectionBackoffMs != null) this.config.rejectionBackoffMs = Math.max(1000, Math.min(300000, Math.floor(Number(value.rejectionBackoffMs) || 1000)));
      if (value.actionTimeoutMs != null) this.config.actionTimeoutMs = Math.max(5000, Math.min(300000, Math.floor(Number(value.actionTimeoutMs) || 5000)));
      if (value.minMarketPremiumRatio != null) this.config.minMarketPremiumRatio = Math.max(1, Math.min(10, Number(value.minMarketPremiumRatio) || 1));
      if (value.priorities && typeof value.priorities === 'object') {
        for (const [kind, priority] of Object.entries(value.priorities)) {
          if (!Object.prototype.hasOwnProperty.call(DEFAULT_PRIORITIES, kind)) continue;
          this.config.priorities[kind] = Math.max(0, Math.min(1000, Math.floor(Number(priority) || 0)));
        }
      }
      if (value.allowKinds && typeof value.allowKinds === 'object') {
        for (const [kind, allowed] of Object.entries(value.allowKinds)) {
          if (!Object.prototype.hasOwnProperty.call(DEFAULT_KINDS, kind)) continue;
          this.config.allowKinds[kind] = allowed === true;
        }
      }
      return clone(this.config);
    }

    _snapshot() {
      try { return this.game && this.game.snapshot ? this.game.snapshot() : null; }
      catch (_) { return null; }
    }

    _movementStatus() {
      try { return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null; }
      catch (_) { return null; }
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || (status.state && !['IDLE', 'STOPPED'].includes(String(status.state)))));
      } catch (_) {
        return false;
      }
    }

    _callPlan(controller) {
      try { return controller && typeof controller.plan === 'function' ? controller.plan() : null; }
      catch (error) { return { state: 'BLOCKED', reason: cleanText(error && error.message || error, 240) }; }
    }

    _status(controller) {
      try { return controller && typeof controller.status === 'function' ? controller.status() : null; }
      catch (_) { return null; }
    }

    _lastActionSignature(status) {
      const row = status && status.lastAction;
      if (!row) return null;
      return [row.at || '', row.type || '', row.reason || ''].join('|');
    }

    _childRows() {
      return [
        { name: 'merchant', controller: this.merchant },
        { name: 'bank', controller: this.bank },
        { name: 'trade', controller: this.trade },
        { name: 'gear', controller: this.gear },
        { name: 'upgrade', controller: this.upgrade },
        { name: 'exchangeCraft', controller: this.exchangeCraft }
      ];
    }

    _childSnapshot() {
      const output = {};
      for (const row of this._childRows()) output[row.name] = this._status(row.controller);
      return output;
    }

    _childBusy(child) {
      return !!(child && (child.pending || child.request || child.delivery));
    }

    _proposal(kind, module, details = {}) {
      if (this.config.allowKinds[kind] !== true) return null;
      const id = 'h17-proposal-' + kind + '-' + cleanText(details.key || details.itemName || details.slot || '', 120);
      const blockedUntil = Number(this.rejectionBackoff.get(id) || 0);
      if (blockedUntil > Date.now()) return null;
      if (blockedUntil) this.rejectionBackoff.delete(id);
      return {
        id,
        kind,
        module,
        priority: Number(this.config.priorities[kind] || 0),
        risk: Math.max(0, finite(details.risk) || 0),
        ...clone(details)
      };
    }

    _marketSellProposal(row) {
      if (!row || !row.name || !this.trade || typeof this.trade.marketAnalysis !== 'function') return null;
      let analysis = null;
      try { analysis = this.trade.marketAnalysis(row.name, { level: Math.max(0, Number(row.level) || 0) }); } catch (_) {}
      const bid = analysis && analysis.bestBid || null;
      const price = finite(bid && bid.price);
      const definition = this.game && typeof this.game.itemDefinition === 'function' ? this.game.itemDefinition(row.name) : null;
      const npcPrice = finite(definition && definition.g);
      if (!bid || !bid.rid || price == null || price <= 0 || npcPrice == null || npcPrice < 0) return null;
      const minimum = npcPrice * this.config.minMarketPremiumRatio;
      if (price < minimum) return null;
      const quantity = Math.min(
        Math.max(1, Math.floor(Number(row.quantity) || 1)),
        Math.max(1, Math.floor(Number(bid.quantity) || 1))
      );
      return this._proposal('MARKET_SELL', 'trade', {
        key: row.name + ':' + row.slot,
        itemName: row.name,
        inventorySlot: Number(row.slot),
        quantity,
        playerName: bid.playerName,
        tradeSlot: bid.slot,
        minUnitPrice: minimum,
        unitPrice: price,
        risk: 0
      });
    }

    _npcSellProposal(row) {
      if (!row || !row.name) return null;
      let location = null;
      try { location = this.game && typeof this.game.npcLocation === 'function' ? this.game.npcLocation('fancypots') : null; } catch (_) {}
      if (!location) return null;
      return this._proposal('NPC_SELL', 'trade', {
        key: row.name + ':' + row.slot,
        itemName: row.name,
        inventorySlot: Number(row.slot),
        quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
        risk: 0
      });
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const children = this._childSnapshot();
      const movement = this._movementStatus();
      const proposals = [];
      const blockers = [];

      if (this.suspendedReason) {
        const plan = { state: 'SUSPENDED', reason: this.suspendedReason, selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (!snap || !snap.available || !snap.character) {
        const plan = { state: 'BLOCKED', reason: 'H17_CHARACTER_UNAVAILABLE', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (snap.character.rip === true) {
        const plan = { state: 'BLOCKED', reason: 'H17_CHARACTER_DEAD', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (String(snap.character.ctype || '').toLowerCase() !== 'merchant') {
        const plan = { state: 'BLOCKED', reason: 'H17_REQUIRES_MERCHANT', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (this.canAct && this.canAct('economy') !== true) {
        const plan = { state: 'BLOCKED', reason: 'H17_RUNTIME_ACTION_BLOCKED', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }
      if (this._combatActive()) {
        this.metrics.combatBlocks += 1;
        const plan = { state: 'BLOCKED', reason: 'H17_COMBAT_ACTIVE', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      for (const [name, status] of Object.entries(children)) {
        if (status && status.suspended) blockers.push({ module: name, reason: status.suspendedReason || status.reason || 'SUSPENDED' });
      }
      if (blockers.length) {
        const plan = { state: 'BLOCKED', reason: 'H17_CHILD_SUSPENDED', selected: null, proposals, blockers, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      if (!this.currentAction && movement && movement.activeOrder) {
        this.metrics.movementBlocks += 1;
        const plan = {
          state: 'WAITING',
          reason: 'H17_MOVEMENT_OWNED',
          selected: null,
          proposals,
          blockers: [{ module: 'movement', reason: 'ACTIVE_ORDER', owner: movement.activeOrder.owner || null }],
          children
        };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      const busyChildren = Object.entries(children)
        .filter(([, status]) => this._childBusy(status))
        .map(([module, status]) => ({ module, reason: 'BUSY', lastAction: status && status.lastAction || null }));
      if (!this.currentAction && busyChildren.length) {
        this.metrics.conflictBlocks += 1;
        const plan = { state: 'WAITING', reason: 'H17_CHILD_BUSY', selected: null, proposals, blockers: busyChildren, children };
        this.lastPlan = clone(plan);
        return clone(plan);
      }

      const merchantPlan = this._callPlan(this.merchant);
      const bankPlan = this._callPlan(this.bank);
      const tradePlan = this._callPlan(this.trade);
      const gearPlan = this._callPlan(this.gear);
      const upgradePlan = this._callPlan(this.upgrade);
      const exchangePlan = this._callPlan(this.exchangeCraft);

      const pressure = merchantPlan && merchantPlan.pressure && merchantPlan.pressure.state || 'NORMAL';
      const bankRows = bankPlan && bankPlan.safeDepositRows || [];
      if (['HIGH', 'CRITICAL'].includes(String(pressure)) && bankRows.length) {
        if (bankPlan && bankPlan.state === 'NEEDS_BANK') {
          const proposal = this._proposal('BANK_MOUNT', 'bank', { key: 'bank', pressure, risk: 0 });
          if (proposal) proposals.push(proposal);
        } else if (bankPlan && bankPlan.state === 'READY') {
          const row = bankRows[0];
          const proposal = this._proposal('BANK_DEPOSIT', 'bank', {
            key: row.name + ':' + row.slot,
            itemName: row.name,
            inventorySlot: Number(row.slot),
            quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
            pressure,
            risk: 0
          });
          if (proposal) proposals.push(proposal);
        }
      }

      const improvement = gearPlan && gearPlan.local && (gearPlan.local.improvements || [])[0] || null;
      if (improvement && improvement.bestInventory) {
        const proposal = this._proposal('GEAR_EQUIP', 'gear', {
          key: improvement.slot,
          slot: improvement.slot,
          inventorySlot: Number(improvement.bestInventory.inventorySlot),
          itemName: improvement.bestInventory.item && improvement.bestInventory.item.name || null,
          delta: finite(improvement.delta) || 0,
          risk: Math.max(0, finite(improvement.bestInventory.item && improvement.bestInventory.item.definition && improvement.bestInventory.item.definition.g) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const safeExchange = exchangePlan && (exchangePlan.exchangeCandidates || []).find(row => row && row.safe === true) || null;
      if (safeExchange) {
        const proposal = this._proposal('EXCHANGE', 'exchangeCraft', {
          key: safeExchange.itemName + ':' + safeExchange.inventorySlot,
          itemName: safeExchange.itemName,
          inventorySlot: Number(safeExchange.inventorySlot),
          quantity: Math.max(1, Math.floor(Number(safeExchange.requiredQuantity) || 1)),
          risk: Math.max(0, finite(safeExchange.valueAtRisk) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const safeCraft = exchangePlan && (exchangePlan.craftCandidates || []).find(row => row && row.safe === true) || null;
      if (safeCraft) {
        const proposal = this._proposal('CRAFT', 'exchangeCraft', {
          key: safeCraft.itemName,
          itemName: safeCraft.itemName,
          risk: Math.max(0, finite(safeCraft.inputValueAtRisk) || 0),
          goldCost: Math.max(0, finite(safeCraft.cost) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const upgradeCandidate = upgradePlan && (upgradePlan.upgradeCandidates || [])[0] || null;
      if (upgradeCandidate) {
        const proposal = this._proposal('UPGRADE', 'upgrade', {
          key: String(upgradeCandidate.itemSlot),
          inventorySlot: Number(upgradeCandidate.itemSlot),
          itemName: upgradeCandidate.itemName || upgradeCandidate.name || null,
          fromLevel: Number(upgradeCandidate.fromLevel || 0),
          risk: Math.max(0, finite(upgradeCandidate.budget && upgradeCandidate.budget.itemValueAtRisk) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const compoundCandidate = upgradePlan && (upgradePlan.compoundCandidates || [])[0] || null;
      if (compoundCandidate) {
        const proposal = this._proposal('COMPOUND', 'upgrade', {
          key: (compoundCandidate.itemSlots || []).join(','),
          inventorySlots: clone(compoundCandidate.itemSlots || []),
          itemName: compoundCandidate.itemName || compoundCandidate.name || null,
          fromLevel: Number(compoundCandidate.fromLevel || 0),
          risk: Math.max(0, finite(compoundCandidate.budget && compoundCandidate.budget.itemValueAtRisk) || 0)
        });
        if (proposal) proposals.push(proposal);
      }

      const sellRow = tradePlan && (tradePlan.safeSellRows || [])[0] || null;
      if (sellRow) {
        const market = this._marketSellProposal(sellRow);
        const npc = this._npcSellProposal(sellRow);
        if (market) proposals.push(market);
        else if (npc) proposals.push(npc);
      }

      proposals.sort((a, b) =>
        Number(b.priority || 0) - Number(a.priority || 0)
        || Number(a.risk || 0) - Number(b.risk || 0)
        || String(a.kind).localeCompare(String(b.kind))
        || String(a.id).localeCompare(String(b.id)));

      this.metrics.proposals += proposals.length;
      const selected = proposals[0] || null;
      const plan = {
        state: selected ? 'READY' : 'IDLE',
        reason: selected ? 'H17_PLAN_READY' : 'H17_NO_SAFE_ECONOMY_ACTION',
        character: {
          name: snap.character.name,
          ctype: snap.character.ctype,
          map: snap.character.map,
          gold: snap.character.gold
        },
        autonomyEnabled: this.autonomyEnabled,
        actionsThisSession: this.actionsThisSession,
        maxActionsPerSession: this.config.maxActionsPerSession,
        pressure,
        selected: selected ? clone(selected) : null,
        proposals: clone(proposals),
        blockers: clone(blockers),
        children: clone(children)
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _childController(module) {
      return {
        bank: this.bank,
        trade: this.trade,
        gear: this.gear,
        upgrade: this.upgrade,
        exchangeCraft: this.exchangeCraft
      }[module] || null;
    }

    _queueProposal(proposal) {
      if (!proposal) return { accepted: false, reason: 'H17_PROPOSAL_REQUIRED' };
      let result = null;
      if (proposal.kind === 'BANK_MOUNT') result = this.bank && this.bank.queueMount ? this.bank.queueMount() : null;
      else if (proposal.kind === 'BANK_DEPOSIT') result = this.bank && this.bank.queueDeposit
        ? this.bank.queueDeposit(proposal.itemName, { inventorySlot: proposal.inventorySlot }) : null;
      else if (proposal.kind === 'GEAR_EQUIP') result = this.gear && this.gear.queueEquip
        ? this.gear.queueEquip(proposal.inventorySlot, proposal.slot) : null;
      else if (proposal.kind === 'MARKET_SELL') result = this.trade && this.trade.queueMarketSell
        ? this.trade.queueMarketSell(proposal.playerName, proposal.tradeSlot, proposal.quantity, { minUnitPrice: proposal.minUnitPrice }) : null;
      else if (proposal.kind === 'NPC_SELL') result = this.trade && this.trade.queueNpcSell
        ? this.trade.queueNpcSell(proposal.inventorySlot, proposal.quantity) : null;
      else if (proposal.kind === 'UPGRADE') result = this.upgrade && this.upgrade.queueUpgrade
        ? this.upgrade.queueUpgrade(proposal.inventorySlot) : null;
      else if (proposal.kind === 'COMPOUND') result = this.upgrade && this.upgrade.queueCompound
        ? this.upgrade.queueCompound(proposal.inventorySlots) : null;
      else if (proposal.kind === 'EXCHANGE') result = this.exchangeCraft && this.exchangeCraft.queueExchange
        ? this.exchangeCraft.queueExchange(proposal.inventorySlot) : null;
      else if (proposal.kind === 'CRAFT') result = this.exchangeCraft && this.exchangeCraft.queueCraft
        ? this.exchangeCraft.queueCraft(proposal.itemName) : null;
      else return { accepted: false, reason: 'H17_PROPOSAL_KIND_UNSUPPORTED' };

      if (!result) return { accepted: false, reason: 'H17_CHILD_QUEUE_UNAVAILABLE' };
      if (result.accepted !== true) return clone(result);

      if (proposal.kind === 'BANK_MOUNT' && result.alreadyMounted === true) {
        this.actionsThisSession += 1;
        this.metrics.actionsQueued += 1;
        this.metrics.actionsConfirmed += 1;
        this.metrics.byKind[proposal.kind] = Number(this.metrics.byKind[proposal.kind] || 0) + 1;
        this.cooldownUntilMs = Date.now() + this.config.actionCooldownMs;
        this.lastAction = {
          at: nowIso(),
          type: 'ACTION_CONFIRMED',
          action: {
            id: 'h17-action-' + (++this.sequence),
            kind: proposal.kind,
            module: proposal.module,
            proposal: clone(proposal)
          },
          details: { immediate: true, child: clone(result) }
        };
        return { accepted: true, immediate: true, result: clone(this.lastAction) };
      }

      const child = this._status(this._childController(proposal.module));
      const now = Date.now();
      this.currentAction = {
        id: 'h17-action-' + (++this.sequence),
        kind: proposal.kind,
        module: proposal.module,
        proposal: clone(proposal),
        queuedAt: nowIso(),
        queuedAtMs: now,
        deadlineAtMs: now + this.config.actionTimeoutMs,
        beforeLastAction: this._lastActionSignature(child)
      };
      this.actionsThisSession += 1;
      this.metrics.actionsQueued += 1;
      this.metrics.byKind[proposal.kind] = Number(this.metrics.byKind[proposal.kind] || 0) + 1;
      this.lastAction = { at: nowIso(), type: 'ACTION_QUEUED', action: clone(this.currentAction) };
      return { accepted: true, action: clone(this.currentAction), child: clone(result) };
    }

    queueSelected() {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.currentAction) return { accepted: false, reason: 'H17_ACTION_ACTIVE' };
      if (this.canAct && this.canAct('economy') !== true) return { accepted: false, reason: 'H17_RUNTIME_ACTION_BLOCKED' };
      if (this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.metrics.sessionBudgetBlocks += 1;
        return { accepted: false, reason: 'H17_SESSION_ACTION_BUDGET_EXHAUSTED' };
      }
      const plan = this.plan();
      if (!plan || plan.state !== 'READY' || !plan.selected) {
        return { accepted: false, reason: plan && plan.reason || 'H17_PLAN_UNAVAILABLE' };
      }
      return this._queueProposal(plan.selected);
    }

    _finishCurrent(outcome, details = {}) {
      const current = this.currentAction;
      this.currentAction = null;
      this.cooldownUntilMs = Date.now() + this.config.actionCooldownMs;
      if (outcome === 'CONFIRMED') this.metrics.actionsConfirmed += 1;
      else if (outcome === 'REJECTED') this.metrics.actionsRejected += 1;
      else this.metrics.actionsUnknown += 1;
      this.lastAction = {
        at: nowIso(),
        type: 'ACTION_' + outcome,
        action: current ? clone(current) : null,
        details: clone(details)
      };
      return clone(this.lastAction);
    }

    _observeCurrent() {
      const current = this.currentAction;
      if (!current) return { state: 'IDLE' };
      const child = this._status(this._childController(current.module));
      if (!child) {
        this.suspendedReason = 'H17_CHILD_STATUS_UNAVAILABLE';
        this._finishCurrent('UNKNOWN', { module: current.module });
        return { state: 'SUSPENDED', reason: this.suspendedReason };
      }
      if (child.suspended) {
        this.suspendedReason = 'H17_CHILD_SUSPENDED:' + cleanText(child.suspendedReason || current.module, 160);
        this._finishCurrent('UNKNOWN', { module: current.module, reason: child.suspendedReason || null });
        return { state: 'SUSPENDED', reason: this.suspendedReason };
      }
      if (this._childBusy(child)) return { state: 'WAITING', action: clone(current) };

      const after = this._lastActionSignature(child);
      if (after && after !== current.beforeLastAction) {
        const type = String(child.lastAction && child.lastAction.type || '');
        if (type.includes('UNKNOWN')) {
          this.suspendedReason = 'H17_CHILD_UNKNOWN:' + current.module;
          this._finishCurrent('UNKNOWN', { childLastAction: clone(child.lastAction) });
          return { state: 'SUSPENDED', reason: this.suspendedReason };
        }
        if (type.includes('CONFIRMED') || type.includes('SUCCEEDED') || type === 'BANK_ALREADY_MOUNTED' || type === 'BANK_MOUNTED') {
          return { state: 'CONFIRMED', result: this._finishCurrent('CONFIRMED', { childLastAction: clone(child.lastAction) }) };
        }
        if (type.includes('REJECTED') || type.includes('FAILED') || type.includes('CANCELLED')) {
          return { state: 'REJECTED', result: this._finishCurrent('REJECTED', { childLastAction: clone(child.lastAction) }) };
        }
      }

      if (Date.now() >= current.deadlineAtMs) {
        this.suspendedReason = 'H17_CHILD_COMPLETION_UNOBSERVABLE';
        this._finishCurrent('UNKNOWN', { module: current.module });
        return { state: 'SUSPENDED', reason: this.suspendedReason };
      }
      return { state: 'WAITING', action: clone(current) };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'IDLE', reason: 'H17_MODULE_INACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.currentAction) {
        const observed = this._observeCurrent();
        if (observed.state === 'WAITING' || observed.state === 'SUSPENDED') return observed;
      }

      const plan = this.plan();
      if (!this.autonomyEnabled) return { state: 'OBSERVE', plan };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason, plan };
      if (this.cooldownUntilMs && Date.now() < this.cooldownUntilMs) {
        return { state: 'COOLDOWN', untilMs: this.cooldownUntilMs, plan };
      }
      if (this.actionsThisSession >= this.config.maxActionsPerSession) {
        this.metrics.sessionBudgetBlocks += 1;
        this.autonomyEnabled = false;
        this.lastAction = { at: nowIso(), type: 'SESSION_BUDGET_REACHED', actions: this.actionsThisSession };
        return { state: 'COMPLETE', reason: 'H17_SESSION_ACTION_BUDGET_REACHED', plan };
      }
      if (!plan || plan.state !== 'READY' || !plan.selected) {
        return { state: plan && plan.state || 'IDLE', reason: plan && plan.reason || 'H17_NO_SAFE_ECONOMY_ACTION', plan };
      }
      const queued = this._queueProposal(plan.selected);
      if (!queued || queued.accepted !== true) {
        this.metrics.actionsRejected += 1;
        this.metrics.rejectionBackoffs += 1;
        this.cooldownUntilMs = Date.now() + this.config.actionCooldownMs;
        this.rejectionBackoff.set(plan.selected.id, Date.now() + this.config.rejectionBackoffMs);
        this.lastAction = {
          at: nowIso(),
          type: 'ACTION_QUEUE_REJECTED',
          proposal: clone(plan.selected),
          reason: queued && queued.reason || 'H17_CHILD_QUEUE_REJECTED'
        };
        return {
          state: 'REJECTED',
          reason: this.lastAction.reason,
          cooldownUntilMs: this.cooldownUntilMs,
          plan,
          result: clone(queued)
        };
      }
      return { state: 'QUEUED', plan, result: queued };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        autonomyEnabled: this.autonomyEnabled,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        currentAction: clone(this.currentAction),
        actionsThisSession: this.actionsThisSession,
        cooldownUntilMs: this.cooldownUntilMs,
        rejectionBackoff: Array.from(this.rejectionBackoff.entries()).map(([proposalId, untilMs]) => ({ proposalId, untilMs })),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.EconomyController = EconomyController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
