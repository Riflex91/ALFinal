(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const GEAR_SLOTS = Object.freeze([
    'helmet', 'coat', 'pants', 'gloves', 'shoes', 'cape', 'belt',
    'amulet', 'orb', 'ring1', 'ring2', 'earring1', 'earring2',
    'mainhand', 'offhand'
  ]);

  const PRIMARY_STAT = Object.freeze({
    warrior: 'str',
    paladin: 'str',
    ranger: 'dex',
    rogue: 'dex',
    mage: 'int',
    priest: 'int',
    merchant: 'int'
  });

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
      const keys = Object.keys(value).sort();
      const ordered = {};
      for (const key of keys) ordered[key] = value[key];
      return JSON.stringify(ordered);
    } catch (_) {
      return String(value);
    }
  }

  class GearController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.actions = options.actions || null;
      this.inventory = options.inventory || null;
      this.roster = options.roster || null;
      this.combat = options.combat || null;
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.sequence = 0;
      this.goals = [];
      this.config = {
        tickMs: Math.max(250, Math.min(5000, Number(options.tickMs) || 750)),
        outcomeTimeoutMs: Math.max(1000, Math.min(60000, Number(options.outcomeTimeoutMs) || 6000)),
        improvementEpsilon: Math.max(0, Number(options.improvementEpsilon) || 0.01)
      };
      this.metrics = {
        ticks: 0,
        plans: 0,
        localImprovements: 0,
        groupProposals: 0,
        equipsDispatched: 0,
        equipsConfirmed: 0,
        equipsRejected: 0,
        equipsUnknown: 0,
        unequipsDispatched: 0,
        unequipsConfirmed: 0,
        unequipsRejected: 0,
        unequipsUnknown: 0,
        deliveriesDispatched: 0,
        deliveriesConfirmed: 0,
        deliveriesRejected: 0,
        deliveriesUnknown: 0,
        safetyBlocks: 0,
        twoHandBlocks: 0,
        combatBlocks: 0,
        goalEvaluations: 0
      };
    }

    start(context = {}) {
      if (this.moduleActive) return { started: false, reason: 'H14_ALREADY_ACTIVE' };
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.suspendedReason = null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('gear-tick', () => this.tick(), this.config.tickMs, { immediate: true });
      }
      return { started: true };
    }

    stop(reason = 'H14_MODULE_STOP') {
      this.moduleActive = false;
      this.scope = null;
      this.pending = null;
      this.request = null;
      this.lastAction = { at: nowIso(), type: 'STOP', reason: cleanText(reason, 240) };
      return { stopped: true };
    }

    resetSafety(reason = 'H14_EXPLICIT_RESET') {
      this.pending = null;
      this.request = null;
      this.suspendedReason = null;
      this.lastAction = { at: nowIso(), type: 'RESET', reason: cleanText(reason, 240) };
      return this.status();
    }

    cancelRequest(reason = 'H14_REQUEST_CANCELLED') {
      this.pending = null;
      this.request = null;
      this.lastAction = { at: nowIso(), type: 'REQUEST_CANCELLED', reason: cleanText(reason, 240) };
      return this.status();
    }

    setGoals(rows = []) {
      if (!Array.isArray(rows)) throw new Error('H14_GOALS_MUST_BE_ARRAY');
      const next = [];
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const targetName = cleanText(raw.targetName || raw.characterName || '', 120);
        const slot = cleanText(raw.slot || '', 40);
        const itemName = cleanText(raw.itemName || raw.name || '', 160);
        const minLevel = Math.max(0, Math.floor(finite(raw.minLevel) || 0));
        const priority = Math.max(0, Math.floor(finite(raw.priority) || 0));
        if (!targetName || !GEAR_SLOTS.includes(slot)) continue;
        if (!itemName && minLevel <= 0) continue;
        next.push({
          id: cleanText(raw.id || ('gear-goal-' + (next.length + 1)), 120),
          targetName,
          slot,
          itemName: itemName || null,
          minLevel,
          priority
        });
      }
      this.goals = next;
      return clone(this.goals);
    }

    goalSnapshot() {
      return clone(this.goals);
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _inventorySnapshot() {
      try { return this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null; }
      catch (_) { return null; }
    }

    _equipmentSnapshot(name = null) {
      try { return this.game && this.game.equipmentSnapshot ? this.game.equipmentSnapshot(name) : null; }
      catch (_) { return null; }
    }

    _roster() {
      try {
        if (!this.roster) return null;
        if (typeof this.roster.refresh === 'function') return this.roster.refresh();
        if (typeof this.roster.status === 'function') return this.roster.status();
      } catch (_) {}
      return null;
    }

    _combatActive() {
      try {
        const status = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
        return !!(status && (status.active || status.state && !['IDLE', 'STOPPED'].includes(String(status.state))));
      } catch (_) {
        return false;
      }
    }

    _equipmentDefinition(name) {
      try { return this.game && this.game.equipmentDefinition ? this.game.equipmentDefinition(name) : null; }
      catch (_) { return null; }
    }

    _classProfile(ctype) {
      try { return this.game && this.game.classEquipmentProfile ? this.game.classEquipmentProfile(ctype) : null; }
      catch (_) { return null; }
    }

    _normalizedItem(row) {
      if (!row || !row.name) return null;
      const definition = this._equipmentDefinition(row.name);
      if (!definition) return null;
      return { ...row, definition };
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
      if (!snapshot || snapshot.available === false || !fingerprint) return null;
      return (snapshot.items || []).reduce((sum, row) =>
        sum + (this._fingerprint(row) === fingerprint ? Math.max(1, Math.floor(Number(row.quantity) || 1)) : 0), 0);
    }

    _primary(ctype) {
      return PRIMARY_STAT[String(ctype || '').toLowerCase()] || null;
    }

    score(row, ctype) {
      const item = this._normalizedItem(row);
      if (!item || !item.definition) return Number.NEGATIVE_INFINITY;
      const definition = item.definition;
      const level = Math.max(0, Number(item.level) || 0);
      const primary = this._primary(ctype);
      const weights = {
        attack: 8,
        armor: 2,
        resistance: 2,
        hp: 1.2,
        mp: 1,
        speed: 1.5,
        range: 2,
        str: primary === 'str' ? 6 : 1,
        dex: primary === 'dex' ? 6 : 1,
        int: primary === 'int' ? 6 : 1,
        vit: 2,
        stat: 6
      };
      let score = 0;
      for (const [stat, weight] of Object.entries(weights)) {
        const base = finite(definition.stats && definition.stats[stat]) || 0;
        const growth = finite(definition.upgradeGrowth && definition.upgradeGrowth[stat]) || 0;
        score += (base + growth * level) * weight;
      }
      if (primary && cleanText(item.statType || '', 80).toLowerCase() === primary) score += 25;
      score += level * 0.01;
      return Number(score.toFixed(4));
    }

    _canEquip(row, slot, ctype) {
      const item = this._normalizedItem(row);
      if (!item || !item.definition || !GEAR_SLOTS.includes(slot)) return { ok: false, reason: 'H14_NOT_EQUIPMENT' };
      const def = item.definition;
      const type = String(def.type || '').toLowerCase();
      const profile = this._classProfile(ctype);
      if ((def.classes || []).length && !def.classes.includes(String(ctype || '').toLowerCase())) {
        return { ok: false, reason: 'H14_CLASS_RESTRICTED' };
      }

      if (type === 'ring') return { ok: slot === 'ring1' || slot === 'ring2', reason: 'H14_RING_SLOT' };
      if (type === 'earring') return { ok: slot === 'earring1' || slot === 'earring2', reason: 'H14_EARRING_SLOT' };

      if (['shield', 'source', 'quiver', 'misc_offhand'].includes(type)) {
        const ok = slot === 'offhand' && !!(profile && profile.offhand && profile.offhand.includes(type));
        return { ok, reason: ok ? null : 'H14_OFFHAND_NOT_ALLOWED', handMode: 'offhand' };
      }

      if (['weapon', 'tool'].includes(type)) {
        const wtype = String(def.wtype || type).toLowerCase();
        if (slot === 'offhand') {
          const ok = !!(profile && profile.offhand && profile.offhand.includes(wtype));
          return { ok, reason: ok ? null : 'H14_OFFHAND_WEAPON_NOT_ALLOWED', handMode: 'offhand' };
        }
        if (slot !== 'mainhand') return { ok: false, reason: 'H14_WEAPON_REQUIRES_HAND' };
        const doublehand = !!(profile && profile.doublehand && profile.doublehand.includes(wtype));
        const mainhand = !!(profile && profile.mainhand && profile.mainhand.includes(wtype));
        return {
          ok: doublehand || mainhand,
          reason: doublehand || mainhand ? null : 'H14_MAINHAND_WEAPON_NOT_ALLOWED',
          handMode: doublehand ? 'doublehand' : 'mainhand'
        };
      }

      return { ok: type === slot, reason: type === slot ? null : 'H14_SLOT_TYPE_MISMATCH' };
    }

    _handConflict(row, slot, equipment, ctype) {
      const allowed = this._canEquip(row, slot, ctype);
      if (!allowed.ok) return { blocked: true, reason: allowed.reason };
      if (slot === 'mainhand' && allowed.handMode === 'doublehand' && equipment && equipment.slots && equipment.slots.offhand) {
        return { blocked: true, reason: 'H14_TWO_HAND_WOULD_DISPLACE_OFFHAND' };
      }
      if (slot === 'offhand' && equipment && equipment.slots && equipment.slots.mainhand) {
        const main = equipment.slots.mainhand;
        const mainAllowed = this._canEquip(main, 'mainhand', ctype);
        if (mainAllowed.ok && mainAllowed.handMode === 'doublehand') {
          return { blocked: true, reason: 'H14_OFFHAND_BLOCKED_BY_TWO_HAND' };
        }
      }
      return { blocked: false, reason: null };
    }

    _inventoryGear() {
      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) return [];
      return (inventory.items || [])
        .map(row => this._normalizedItem(row))
        .filter(Boolean);
    }

    _slotPlan(slot, ctype, equipment, inventoryRows, usedInventorySlots = null) {
      const current = equipment && equipment.slots ? equipment.slots[slot] || null : null;
      const currentScore = current ? this.score(current, ctype) : Number.NEGATIVE_INFINITY;
      const candidates = [];
      for (const row of inventoryRows) {
        if (usedInventorySlots && usedInventorySlots.has(Number(row.slot))) continue;
        const allowed = this._canEquip(row, slot, ctype);
        if (!allowed.ok) continue;
        const score = this.score(row, ctype);
        if (!Number.isFinite(score)) continue;
        candidates.push({
          inventorySlot: Number(row.slot),
          item: clone(row),
          score,
          fingerprint: this._fingerprint(row),
          handMode: allowed.handMode || null
        });
      }
      candidates.sort((a, b) => b.score - a.score || a.inventorySlot - b.inventorySlot);
      const best = candidates[0] || null;
      const delta = best ? best.score - currentScore : null;
      const conflict = best ? this._handConflict(best.item, slot, equipment, ctype) : { blocked: false, reason: null };
      return {
        slot,
        current: current ? clone(current) : null,
        currentScore: Number.isFinite(currentScore) ? currentScore : null,
        bestInventory: best ? clone(best) : null,
        improvement: !!(best && (current == null || delta > this.config.improvementEpsilon)),
        delta: best && Number.isFinite(delta) ? Number(delta.toFixed(4)) : null,
        safeSwitch: !!(best && !conflict.blocked),
        blockReason: conflict.blocked ? conflict.reason : null,
        candidates: candidates.map(row => ({
          inventorySlot: row.inventorySlot,
          item: clone(row.item),
          score: row.score,
          fingerprint: row.fingerprint,
          handMode: row.handMode
        }))
      };
    }

    _localPlan(inventoryRows) {
      const snap = this._snapshot();
      const local = snap && snap.character;
      const equipment = local && local.name ? this._equipmentSnapshot(local.name) : null;
      if (!local || !equipment || equipment.available === false) {
        return {
          state: 'BLOCKED',
          reason: 'H14_LOCAL_EQUIPMENT_UNAVAILABLE',
          character: local ? clone(local) : null,
          equipment: equipment ? clone(equipment) : null,
          slots: [],
          improvements: [],
          replacements: [],
          upgradeCandidates: []
        };
      }
      const ctype = local.ctype;
      const slots = GEAR_SLOTS.map(slot => this._slotPlan(slot, ctype, equipment, inventoryRows));
      const improvements = slots
        .filter(row => row.improvement && row.safeSwitch)
        .sort((a, b) => (b.delta || 0) - (a.delta || 0));
      const replacements = slots.map(row => ({
        slot: row.slot,
        current: clone(row.current),
        currentScore: row.currentScore,
        bestInventory: clone(row.bestInventory),
        bestInventoryScore: row.bestInventory ? row.bestInventory.score : null,
        delta: row.delta,
        improvement: row.improvement,
        safeSwitch: row.safeSwitch,
        blockReason: row.blockReason
      }));
      const upgradeCandidates = [];
      const pushUpgrade = (row, source, slot) => {
        const item = this._normalizedItem(row);
        if (!item || !item.definition) return;
        if (!item.definition.upgradeable && !item.definition.compoundable) return;
        upgradeCandidates.push({
          source,
          slot: slot == null ? null : slot,
          inventorySlot: source === 'inventory' ? Number(item.slot) : null,
          item: clone(item),
          score: this.score(item, ctype),
          level: Math.max(0, Number(item.level) || 0),
          upgradeable: !!item.definition.upgradeable,
          compoundable: !!item.definition.compoundable
        });
      };
      for (const row of inventoryRows) pushUpgrade(row, 'inventory', null);
      for (const [slot, row] of Object.entries(equipment.slots || {})) pushUpgrade(row, 'equipped', slot);
      upgradeCandidates.sort((a, b) => b.score - a.score || b.level - a.level);
      return {
        state: 'READY',
        reason: 'H14_LOCAL_GEAR_READY',
        character: clone(local),
        equipment: clone(equipment),
        slots,
        improvements,
        replacements,
        upgradeCandidates
      };
    }

    _priorityTargets(roster) {
      if (!roster) return [];
      const rows = [];
      for (const farmer of roster.farmers || []) {
        rows.push({ name: farmer.name, ctype: farmer.ctype, role: 'FARMER', priority: 100 });
      }
      if (roster.merchant) {
        rows.push({ name: roster.merchant.name, ctype: roster.merchant.ctype, role: 'MERCHANT', priority: 10 });
      }
      rows.sort((a, b) => b.priority - a.priority || String(a.name).localeCompare(String(b.name)));
      return rows;
    }

    _groupPlan(inventoryRows, roster, localName) {
      const targets = this._priorityTargets(roster);
      const usedInventorySlots = new Set();
      const proposals = [];
      const targetRows = [];
      for (const target of targets) {
        const equipment = this._equipmentSnapshot(target.name);
        const visible = !!(equipment && equipment.available !== false);
        targetRows.push({ ...target, visible, equipment: visible ? clone(equipment) : null });
        if (!visible || target.name === localName) continue;

        const candidateRows = [];
        for (const slot of GEAR_SLOTS) {
          const slotPlan = this._slotPlan(slot, target.ctype, equipment, inventoryRows, usedInventorySlots);
          if (!slotPlan.improvement || !slotPlan.bestInventory) continue;
          candidateRows.push({
            targetName: target.name,
            targetCtype: target.ctype,
            role: target.role,
            priority: target.priority,
            slot,
            inventorySlot: slotPlan.bestInventory.inventorySlot,
            item: clone(slotPlan.bestInventory.item),
            fingerprint: slotPlan.bestInventory.fingerprint,
            score: slotPlan.bestInventory.score,
            currentScore: slotPlan.currentScore,
            delta: slotPlan.delta
          });
        }
        candidateRows.sort((a, b) => (b.delta || 0) - (a.delta || 0));
        for (const proposal of candidateRows) {
          if (usedInventorySlots.has(proposal.inventorySlot)) continue;
          usedInventorySlots.add(proposal.inventorySlot);
          proposals.push(proposal);
        }
      }
      proposals.sort((a, b) => b.priority - a.priority || (b.delta || 0) - (a.delta || 0));
      return { targets: targetRows, proposals };
    }

    _goalPlan(roster, inventoryRows) {
      const results = [];
      const local = this._snapshot();
      const localName = local && local.character && local.character.name;
      for (const goal of this.goals) {
        this.metrics.goalEvaluations += 1;
        const target = (this._priorityTargets(roster)).find(row => row.name === goal.targetName) || null;
        const equipment = this._equipmentSnapshot(goal.targetName);
        const equipped = equipment && equipment.available !== false ? equipment.slots[goal.slot] || null : null;
        const achieved = !!(equipped
          && (!goal.itemName || String(equipped.name) === String(goal.itemName))
          && Math.max(0, Number(equipped.level) || 0) >= goal.minLevel);
        let inventoryMatch = null;
        if (!achieved && goal.targetName === localName) {
          inventoryMatch = inventoryRows.find(row =>
            (!goal.itemName || String(row.name) === String(goal.itemName))
            && Math.max(0, Number(row.level) || 0) >= goal.minLevel
            && this._canEquip(row, goal.slot, target && target.ctype || equipment && equipment.character && equipment.character.ctype).ok) || null;
        }
        results.push({
          ...clone(goal),
          role: target && target.role || null,
          targetPriority: target && target.priority || 0,
          visible: !!(equipment && equipment.available !== false),
          equipped: equipped ? clone(equipped) : null,
          achieved,
          localInventoryMatch: inventoryMatch ? clone(inventoryMatch) : null,
          state: achieved ? 'ACHIEVED' : inventoryMatch ? 'READY_TO_EQUIP' : 'NEEDS_ACQUISITION'
        });
      }
      results.sort((a, b) => b.targetPriority - a.targetPriority || b.priority - a.priority || String(a.id).localeCompare(String(b.id)));
      return results;
    }

    plan() {
      this.metrics.plans += 1;
      const snap = this._snapshot();
      const inventory = this._inventorySnapshot();
      const roster = this._roster();
      if (!snap || !snap.available || !snap.character) {
        const blocked = { state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE' };
        this.lastPlan = blocked;
        return clone(blocked);
      }
      if (!inventory || inventory.available === false) {
        const blocked = { state: 'BLOCKED', reason: 'H14_INVENTORY_UNAVAILABLE' };
        this.lastPlan = blocked;
        return clone(blocked);
      }
      const inventoryRows = this._inventoryGear();
      const local = this._localPlan(inventoryRows);
      const group = this._groupPlan(inventoryRows, roster, snap.character.name);
      const goals = this._goalPlan(roster, inventoryRows);
      this.metrics.localImprovements = local.improvements ? local.improvements.length : 0;
      this.metrics.groupProposals = group.proposals.length;
      const plan = {
        state: local.state === 'READY' ? 'READY' : local.state,
        reason: local.state === 'READY' ? 'H14_GEAR_READY' : local.reason,
        local,
        group,
        goals,
        farmerPriority: 100,
        merchantPriority: 10
      };
      this.lastPlan = clone(plan);
      return clone(plan);
    }

    _localWriteAllowed() {
      if (this._combatActive()) {
        this.metrics.combatBlocks += 1;
        return { ok: false, reason: 'H14_COMBAT_ACTIVE' };
      }
      const snap = this._snapshot();
      if (!snap || !snap.available || !snap.character || snap.character.rip) {
        return { ok: false, reason: 'H14_CHARACTER_UNAVAILABLE_OR_DEAD' };
      }
      return { ok: true };
    }

    queueEquip(inventorySlot, targetSlot) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H14_BUSY' };
      const gate = this._localWriteAllowed();
      if (!gate.ok) return { accepted: false, reason: gate.reason };
      const slot = Number(inventorySlot);
      const target = cleanText(targetSlot || '', 40);
      if (!Number.isInteger(slot) || slot < 0 || !GEAR_SLOTS.includes(target)) {
        return { accepted: false, reason: 'H14_EQUIP_ARGUMENT_INVALID' };
      }
      const snap = this._snapshot();
      const inventory = this._inventorySnapshot();
      const equipment = this._equipmentSnapshot(snap.character.name);
      const row = inventory && (inventory.items || []).find(item => Number(item.slot) === slot);
      if (!row) return { accepted: false, reason: 'H14_EQUIP_ITEM_NOT_FOUND' };
      const normalized = this._normalizedItem(row);
      const allowed = this._canEquip(normalized, target, snap.character.ctype);
      if (!allowed.ok) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: allowed.reason };
      }
      const conflict = this._handConflict(normalized, target, equipment, snap.character.ctype);
      if (conflict.blocked) {
        if (String(conflict.reason).includes('TWO_HAND')) this.metrics.twoHandBlocks += 1;
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: conflict.reason };
      }
      const current = equipment && equipment.slots ? equipment.slots[target] || null : null;
      const candidateFingerprint = this._fingerprint(normalized);
      if (current && this._fingerprint(current) === candidateFingerprint) {
        return { accepted: false, reason: 'H14_ALREADY_EQUIPPED' };
      }
      this.request = {
        id: 'gear-request-' + (++this.sequence),
        kind: 'EQUIP',
        inventorySlot: slot,
        targetSlot: target,
        candidateFingerprint,
        candidate: clone(normalized),
        currentFingerprint: this._fingerprint(current),
        current: current ? clone(current) : null,
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueBestLocal(slot = null) {
      const plan = this.plan();
      if (plan.state !== 'READY') return { accepted: false, reason: plan.reason };
      const wanted = slot == null ? null : cleanText(slot, 40);
      const proposal = (plan.local.improvements || []).find(row => !wanted || row.slot === wanted);
      if (!proposal || !proposal.bestInventory) return { accepted: false, reason: 'H14_NO_SAFE_LOCAL_IMPROVEMENT' };
      return this.queueEquip(proposal.bestInventory.inventorySlot, proposal.slot);
    }

    queueUnequip(targetSlot) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H14_BUSY' };
      const gate = this._localWriteAllowed();
      if (!gate.ok) return { accepted: false, reason: gate.reason };
      const target = cleanText(targetSlot || '', 40);
      if (!GEAR_SLOTS.includes(target)) return { accepted: false, reason: 'H14_UNEQUIP_ARGUMENT_INVALID' };
      const snap = this._snapshot();
      const equipment = this._equipmentSnapshot(snap.character.name);
      const inventory = this._inventorySnapshot();
      const current = equipment && equipment.slots ? equipment.slots[target] || null : null;
      if (!current) return { accepted: false, reason: 'H14_SLOT_ALREADY_EMPTY' };
      if (!inventory || inventory.available === false || Number(inventory.freeSlots) <= 0) {
        return { accepted: false, reason: 'H14_UNEQUIP_NEEDS_FREE_SLOT' };
      }
      this.request = {
        id: 'gear-request-' + (++this.sequence),
        kind: 'UNEQUIP',
        targetSlot: target,
        currentFingerprint: this._fingerprint(current),
        current: clone(current),
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    queueDelivery(targetName, inventorySlot) {
      if (this.suspendedReason) return { accepted: false, reason: this.suspendedReason };
      if (this.request || this.pending) return { accepted: false, reason: 'H14_BUSY' };
      const snap = this._snapshot();
      if (!snap || !snap.character || String(snap.character.ctype || '').toLowerCase() !== 'merchant') {
        return { accepted: false, reason: 'H14_DELIVERY_REQUIRES_MERCHANT' };
      }
      const target = cleanText(targetName || '', 120);
      const slot = Number(inventorySlot);
      if (!target || !Number.isInteger(slot) || slot < 0) return { accepted: false, reason: 'H14_DELIVERY_ARGUMENT_INVALID' };
      const roster = this._roster();
      const farmer = roster && (roster.farmers || []).find(row => String(row.name) === target);
      if (!farmer) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H14_DELIVERY_TARGET_NOT_OWN_FARMER' };
      }
      const targetEquipment = this._equipmentSnapshot(target);
      if (!targetEquipment || targetEquipment.available === false) return { accepted: false, reason: 'H14_DELIVERY_TARGET_NOT_VISIBLE' };
      const inventory = this._inventorySnapshot();
      const row = inventory && (inventory.items || []).find(item => Number(item.slot) === slot);
      if (!row) return { accepted: false, reason: 'H14_DELIVERY_ITEM_NOT_FOUND' };
      if (row.locked || row.giveaway || row.gift || row.expiresAt) {
        this.metrics.safetyBlocks += 1;
        return { accepted: false, reason: 'H14_DELIVERY_ITEM_NOT_TRANSFER_SAFE' };
      }
      const normalized = this._normalizedItem(row);
      if (!normalized) return { accepted: false, reason: 'H14_DELIVERY_ITEM_NOT_GEAR' };

      let best = null;
      for (const gearSlot of GEAR_SLOTS) {
        const allowed = this._canEquip(normalized, gearSlot, farmer.ctype);
        if (!allowed.ok) continue;
        const current = targetEquipment.slots && targetEquipment.slots[gearSlot] || null;
        const currentScore = current ? this.score(current, farmer.ctype) : Number.NEGATIVE_INFINITY;
        const score = this.score(normalized, farmer.ctype);
        const delta = score - currentScore;
        if (!(current == null || delta > this.config.improvementEpsilon)) continue;
        if (!best || delta > best.delta) best = { slot: gearSlot, current, currentScore, score, delta };
      }
      if (!best) return { accepted: false, reason: 'H14_DELIVERY_NOT_AN_IMPROVEMENT' };
      this.request = {
        id: 'gear-request-' + (++this.sequence),
        kind: 'DELIVERY',
        targetName: target,
        targetCtype: farmer.ctype,
        inventorySlot: slot,
        candidateFingerprint: this._fingerprint(normalized),
        candidate: clone(normalized),
        targetSlot: best.slot,
        scoreDelta: Number(best.delta.toFixed(4)),
        createdAt: nowIso()
      };
      return { accepted: true, request: clone(this.request) };
    }

    _metric(kind, suffix) {
      const prefix = { EQUIP: 'equips', UNEQUIP: 'unequips', DELIVERY: 'deliveries' }[kind];
      const key = prefix ? prefix + suffix : null;
      if (key && Object.prototype.hasOwnProperty.call(this.metrics, key)) this.metrics[key] += 1;
    }

    _suspend(kind, reason) {
      this._metric(kind, 'Unknown');
      this.pending = null;
      this.request = null;
      this.suspendedReason = cleanText(reason || 'H14_UNKNOWN', 240) || 'H14_UNKNOWN';
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
        this.pending.error = cleanText(error && (error.reason || error.message) || error || 'H14_ACTION_REJECTED', 500);
      }).catch(() => {});
    }

    _dispatch(action, args, pendingBase) {
      if (!this.actions || typeof this.actions.dispatch !== 'function') {
        return { accepted: false, reason: 'H14_ACTION_BOUNDARY_UNAVAILABLE' };
      }
      let result;
      try { result = this.actions.dispatch(action, args); }
      catch (error) { return { accepted: false, reason: cleanText(error && error.message || error, 300) }; }
      if (!result || result.state !== 'DISPATCHED') {
        if (result && result.state === 'UNKNOWN') return this._suspend(pendingBase.kind, result.error && result.error.message || 'H14_DISPATCH_UNKNOWN');
        this._metric(pendingBase.kind, 'Rejected');
        this.request = null;
        return { accepted: false, reason: result && result.state || 'H14_ACTION_REJECTED' };
      }
      const now = Date.now();
      const pending = {
        id: 'gear-pending-' + (++this.sequence),
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
      if (!inventory || inventory.available === false) return false;
      const snap = this._snapshot();
      const localName = snap && snap.character && snap.character.name;
      const equipment = localName ? this._equipmentSnapshot(localName) : null;

      if (pending.kind === 'EQUIP') {
        if (!equipment || equipment.available === false) return false;
        const equipped = equipment.slots && equipment.slots[pending.targetSlot] || null;
        if (!equipped || this._fingerprint(equipped) !== pending.candidateFingerprint) return false;
        const candidateAfter = this._quantity(inventory, pending.candidateFingerprint);
        if (candidateAfter == null || candidateAfter > pending.beforeCandidateQuantity - 1) return false;
        if (pending.currentFingerprint) {
          const oldAfter = this._quantity(inventory, pending.currentFingerprint);
          if (oldAfter == null || oldAfter < pending.beforeCurrentQuantity + 1) return false;
        }
        return true;
      }

      if (pending.kind === 'UNEQUIP') {
        if (!equipment || equipment.available === false) return false;
        const equipped = equipment.slots && equipment.slots[pending.targetSlot] || null;
        if (equipped) return false;
        const after = this._quantity(inventory, pending.currentFingerprint);
        return after != null && after >= pending.beforeCurrentQuantity + 1;
      }

      if (pending.kind === 'DELIVERY') {
        const after = this._quantity(inventory, pending.candidateFingerprint);
        return after != null && after <= pending.beforeCandidateQuantity - 1;
      }
      return false;
    }

    _observePending() {
      const pending = this.pending;
      if (!pending) return false;
      if (pending.settlement === 'REJECTED') return this._suspend(pending.kind, pending.error || 'H14_ACTION_REJECTED');
      if (pending.response && pending.response.failed === true) {
        this.pending = null;
        this.request = null;
        this._metric(pending.kind, 'Rejected');
        this.lastAction = {
          at: nowIso(),
          type: pending.kind + '_REJECTED',
          reason: cleanText(pending.response.reason || 'H14_ACTION_REJECTED', 240)
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
          targetSlot: pending.targetSlot || null,
          targetName: pending.targetName || null,
          fingerprint: pending.candidateFingerprint || pending.currentFingerprint || null
        };
        return true;
      }
      if (Date.now() >= pending.deadlineAtMs) return this._suspend(pending.kind, 'H14_' + pending.kind + '_UNVERIFIED_TIMEOUT');
      return false;
    }

    _revalidateDelivery(request, inventory) {
      const snap = this._snapshot();
      if (!snap || !snap.character || String(snap.character.ctype || '').toLowerCase() !== 'merchant') {
        return { ok: false, reason: 'H14_DELIVERY_REQUIRES_MERCHANT' };
      }
      const roster = this._roster();
      const farmer = roster && (roster.farmers || []).find(row => String(row.name) === String(request.targetName));
      if (!farmer) return { ok: false, reason: 'H14_DELIVERY_TARGET_NOT_OWN_FARMER' };
      const row = (inventory.items || []).find(item => Number(item.slot) === Number(request.inventorySlot));
      if (!row || this._fingerprint(row) !== request.candidateFingerprint) return { ok: false, reason: 'H14_DELIVERY_SOURCE_CHANGED' };
      if (row.locked || row.giveaway || row.gift || row.expiresAt) return { ok: false, reason: 'H14_DELIVERY_ITEM_NOT_TRANSFER_SAFE' };
      const targetEquipment = this._equipmentSnapshot(request.targetName);
      if (!targetEquipment || targetEquipment.available === false) return { ok: false, reason: 'H14_DELIVERY_TARGET_NOT_VISIBLE' };
      const current = targetEquipment.slots && targetEquipment.slots[request.targetSlot] || null;
      const currentScore = current ? this.score(current, farmer.ctype) : Number.NEGATIVE_INFINITY;
      const candidateScore = this.score(row, farmer.ctype);
      if (!(current == null || candidateScore - currentScore > this.config.improvementEpsilon)) {
        return { ok: false, reason: 'H14_DELIVERY_NO_LONGER_IMPROVEMENT' };
      }
      return { ok: true, row, farmer };
    }

    tick() {
      this.metrics.ticks += 1;
      if (!this.moduleActive) return { state: 'STOPPED', reason: 'H14_MODULE_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };

      if (this.pending) {
        this._observePending();
        if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
        return this.pending ? { state: 'PENDING', pending: clone(this.pending) } : { state: 'READY' };
      }

      const request = this.request;
      if (!request) return this.plan();

      const inventory = this._inventorySnapshot();
      if (!inventory || inventory.available === false) return { state: 'BLOCKED', reason: 'H14_INVENTORY_UNAVAILABLE' };

      if (request.kind === 'EQUIP') {
        const gate = this._localWriteAllowed();
        if (!gate.ok) {
          this.request = null;
          return { state: 'BLOCKED', reason: gate.reason };
        }
        const snap = this._snapshot();
        const equipment = this._equipmentSnapshot(snap.character.name);
        const row = (inventory.items || []).find(item => Number(item.slot) === Number(request.inventorySlot));
        if (!row || this._fingerprint(row) !== request.candidateFingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H14_EQUIP_SOURCE_CHANGED' };
        }
        const allowed = this._canEquip(row, request.targetSlot, snap.character.ctype);
        const conflict = this._handConflict(row, request.targetSlot, equipment, snap.character.ctype);
        if (!allowed.ok || conflict.blocked) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          if (conflict.blocked && String(conflict.reason).includes('TWO_HAND')) this.metrics.twoHandBlocks += 1;
          return { state: 'BLOCKED', reason: conflict.blocked ? conflict.reason : allowed.reason };
        }
        const current = equipment.slots && equipment.slots[request.targetSlot] || null;
        const beforeCandidateQuantity = this._quantity(inventory, request.candidateFingerprint);
        const beforeCurrentQuantity = request.currentFingerprint ? this._quantity(inventory, request.currentFingerprint) : 0;
        return this._dispatch('equip', [request.inventorySlot, request.targetSlot], {
          kind: request.kind,
          targetSlot: request.targetSlot,
          candidateFingerprint: request.candidateFingerprint,
          currentFingerprint: this._fingerprint(current),
          beforeCandidateQuantity,
          beforeCurrentQuantity: beforeCurrentQuantity == null ? 0 : beforeCurrentQuantity
        });
      }

      if (request.kind === 'UNEQUIP') {
        const gate = this._localWriteAllowed();
        if (!gate.ok) {
          this.request = null;
          return { state: 'BLOCKED', reason: gate.reason };
        }
        const snap = this._snapshot();
        const equipment = this._equipmentSnapshot(snap.character.name);
        const current = equipment.slots && equipment.slots[request.targetSlot] || null;
        if (!current || this._fingerprint(current) !== request.currentFingerprint) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H14_UNEQUIP_SOURCE_CHANGED' };
        }
        if (Number(inventory.freeSlots) <= 0) {
          this.request = null;
          return { state: 'BLOCKED', reason: 'H14_UNEQUIP_NEEDS_FREE_SLOT' };
        }
        const beforeCurrentQuantity = this._quantity(inventory, request.currentFingerprint);
        return this._dispatch('unequip', [request.targetSlot], {
          kind: request.kind,
          targetSlot: request.targetSlot,
          currentFingerprint: request.currentFingerprint,
          beforeCurrentQuantity: beforeCurrentQuantity == null ? 0 : beforeCurrentQuantity
        });
      }

      if (request.kind === 'DELIVERY') {
        const valid = this._revalidateDelivery(request, inventory);
        if (!valid.ok) {
          this.request = null;
          this.metrics.safetyBlocks += 1;
          return { state: 'BLOCKED', reason: valid.reason };
        }
        const beforeCandidateQuantity = this._quantity(inventory, request.candidateFingerprint);
        return this._dispatch('send_item', [request.targetName, request.inventorySlot, 1], {
          kind: request.kind,
          targetName: request.targetName,
          targetSlot: request.targetSlot,
          candidateFingerprint: request.candidateFingerprint,
          beforeCandidateQuantity
        });
      }

      this.request = null;
      return { state: 'BLOCKED', reason: 'H14_REQUEST_UNKNOWN' };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        request: clone(this.request),
        goals: clone(this.goals),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.GearController = GearController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
