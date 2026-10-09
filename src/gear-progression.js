(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const CLASS_WEIGHTS = Object.freeze({
    warrior: { attack: 1.0, armor: 1.25, resistance: 0.85, hp: 0.04, str: 0.8, dex: 0.2, int: 0.1, crit: 0.3, evasion: 0.2, speed: 0.15 },
    paladin: { attack: 0.9, armor: 1.15, resistance: 1.15, hp: 0.05, str: 0.65, int: 0.45, crit: 0.2, speed: 0.1 },
    ranger: { attack: 1.1, armor: 0.55, resistance: 0.55, hp: 0.025, dex: 0.9, crit: 0.45, speed: 0.2, range: 0.12, frequency: 0.4 },
    rogue: { attack: 1.15, armor: 0.5, resistance: 0.45, hp: 0.02, dex: 0.95, crit: 0.55, evasion: 0.35, speed: 0.25, frequency: 0.45 },
    mage: { attack: 1.1, armor: 0.35, resistance: 0.75, hp: 0.02, mp: 0.025, int: 1.0, crit: 0.25, speed: 0.1, range: 0.1 },
    priest: { attack: 0.75, armor: 0.45, resistance: 1.0, hp: 0.04, mp: 0.03, int: 0.9, speed: 0.1, range: 0.08 },
    merchant: { attack: 0.3, armor: 0.7, resistance: 0.7, hp: 0.04, str: 0.15, dex: 0.15, int: 0.15, speed: 10.0 }
  });

  const DEFAULT_WEIGHTS = Object.freeze({
    attack: 1, armor: 0.7, resistance: 0.7, hp: 0.03, mp: 0.015,
    str: 0.35, dex: 0.35, int: 0.35, vit: 0.4, crit: 0.25,
    evasion: 0.2, speed: 0.15, range: 0.08, frequency: 0.3
  });

  const ROLE_WEIGHT_MULTIPLIERS = Object.freeze({
    tank: Object.freeze({ armor: 1.30, resistance: 1.30, hp: 1.25, vit: 1.20, evasion: 1.10, attack: 0.90 }),
    healer: Object.freeze({ mp: 1.25, int: 1.15, resistance: 1.15, hp: 1.10, attack: 0.90 }),
    support: Object.freeze({ mp: 1.20, int: 1.10, resistance: 1.15, hp: 1.10, speed: 1.05 }),
    aoe: Object.freeze({ attack: 1.15, frequency: 1.20, range: 1.10, mp: 1.10, crit: 1.05 }),
    boss: Object.freeze({ attack: 1.15, crit: 1.20, frequency: 1.15, armor: 1.08, resistance: 1.08, hp: 1.08 }),
    dps: Object.freeze({ attack: 1.15, crit: 1.15, frequency: 1.15, dex: 1.08, int: 1.08, str: 1.08 }),
    economy: Object.freeze({ speed: 1.20, hp: 1.10, resistance: 1.10 })
  });

  const DEFAULT_UPGRADE_CHANCES = Object.freeze({
    0: Object.freeze({ 1: 0.9999999, 2: 0.98, 3: 0.95, 4: 0.7, 5: 0.6, 6: 0.4, 7: 0.25, 8: 0.15, 9: 0.07, 10: 0.024, 11: 0.14, 12: 0.11 }),
    1: Object.freeze({ 1: 0.99998, 2: 0.97, 3: 0.94, 4: 0.68, 5: 0.58, 6: 0.38, 7: 0.24, 8: 0.14, 9: 0.066, 10: 0.018, 11: 0.13, 12: 0.10 }),
    2: Object.freeze({ 1: 0.97, 2: 0.94, 3: 0.92, 4: 0.64, 5: 0.52, 6: 0.32, 7: 0.232, 8: 0.13, 9: 0.062, 10: 0.015, 11: 0.12, 12: 0.09 })
  });

  const DEFAULT_COMPOUND_CHANCES = Object.freeze({
    0: Object.freeze({ 1: 0.99, 2: 0.75, 3: 0.40, 4: 0.25, 5: 0.20, 6: 0.10, 7: 0.08, 8: 0.05, 9: 0.05, 10: 0.05 }),
    1: Object.freeze({ 1: 0.90, 2: 0.70, 3: 0.40, 4: 0.20, 5: 0.15, 6: 0.08, 7: 0.05, 8: 0.05, 9: 0.05, 10: 0.03 }),
    2: Object.freeze({ 1: 0.80, 2: 0.60, 3: 0.32, 4: 0.16, 5: 0.10, 6: 0.05, 7: 0.03, 8: 0.03, 9: 0.03, 10: 0.02 })
  });

  function finite(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function roleProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const direct = [
      profile.gearRole, profile.combatRole, profile.farmRole, profile.localRole, profile.role
    ].map(value => String(value == null ? '' : value).trim().toLowerCase()).find(Boolean);
    const task = profile.currentTask || profile.task || profile.assignment || null;
    const taskText = String(task && typeof task === 'object'
      ? task.type || task.kind || task.role || task.mode || ''
      : task || '').trim().toLowerCase();
    for (const value of [direct, taskText].filter(Boolean)) {
      if (value.includes('tank')) return 'tank';
      if (value.includes('heal')) return 'healer';
      if (value.includes('support')) return 'support';
      if (value.includes('aoe') || value.includes('area')) return 'aoe';
      if (value.includes('boss') || value.includes('single')) return 'boss';
      if (value.includes('dps') || value.includes('damage') || value.includes('combat-farm')) return 'dps';
      if (value.includes('econom') || value.includes('merchant')) return 'economy';
    }
    return null;
  }

  function contextualWeights(baseWeights, profile) {
    const out = { ...(baseWeights || {}) };
    const role = roleProfile(profile);
    const multipliers = role && ROLE_WEIGHT_MULTIPLIERS[role];
    if (!multipliers) return { weights: out, roleProfile: role };
    for (const [key, multiplier] of Object.entries(multipliers)) {
      if (finite(out[key]) == null) continue;
      out[key] *= multiplier;
    }
    return { weights: out, roleProfile: role };
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

  function levelOf(item) {
    return Math.max(0, Math.floor(finite(item && item.level, 0)));
  }

  function identityKey(item) {
    return [
      cleanText(item && item.name || '', 160),
      String(levelOf(item)),
      cleanText(item && (item.statType != null ? item.statType : item.stat_type) || '', 80),
      stableProperty(item && (item.property != null ? item.property : item.p))
    ].join('|');
  }

  function candidateSlots(meta) {
    if (!meta || typeof meta !== 'object') return [];
    const type = String(meta.type || '').toLowerCase();
    const map = {
      helmet: ['helmet'], coat: ['coat'], chest: ['coat'], pants: ['pants'], gloves: ['gloves'],
      shoes: ['shoes'], cape: ['cape'], belt: ['belt'], amulet: ['amulet'], orb: ['orb'],
      ring: ['ring1', 'ring2'], earring: ['earring1', 'earring2']
    };
    if (map[type]) return map[type];
    if (type === 'weapon' || type === 'tool') return ['mainhand', 'offhand'];
    if (['shield', 'source', 'quiver', 'misc_offhand'].includes(type)) return ['offhand'];
    return [];
  }

  function effectiveStats(meta, level) {
    if (!meta || typeof meta !== 'object') return {};
    const out = {};
    const skip = new Set([
      'g', 'gold', 'cash', 'level', 'type', 'wtype', 'name', 'skin', 'description',
      'class', 'grades', 'upgrade', 'compound', 'e', 'quest', 'event', 'soulbound'
    ]);
    for (const [key, value] of Object.entries(meta)) {
      if (skip.has(key)) continue;
      const n = finite(value);
      if (n != null) out[key] = n;
    }
    const progression = meta.upgrade && typeof meta.upgrade === 'object'
      ? meta.upgrade
      : meta.compound && typeof meta.compound === 'object'
        ? meta.compound
        : {};
    for (const [key, value] of Object.entries(progression)) {
      const n = finite(value);
      if (n == null) continue;
      out[key] = finite(out[key], 0) + n * Math.max(0, level);
    }
    return out;
  }

  function scoreItem(meta, level, ctype, profile = null) {
    const baseWeights = CLASS_WEIGHTS[String(ctype || '').toLowerCase()] || DEFAULT_WEIGHTS;
    const { weights, roleProfile: resolvedRole } = contextualWeights(baseWeights, profile);
    const stats = effectiveStats(meta, level);
    let total = 0;
    let survival = 0;
    for (const [key, value] of Object.entries(stats)) {
      const weight = finite(weights[key], finite(DEFAULT_WEIGHTS[key], 0));
      total += value * weight;
      if (['armor', 'resistance', 'hp', 'vit', 'evasion', 'reflection'].includes(key)) {
        survival += value * Math.max(0, weight);
      }
    }
    return { total, survival, stats, roleProfile: resolvedRole };
  }

  function scoreImprovement(current, target, minImprovementRatio, profile = null) {
    const currentTotal = finite(current && current.total, 0);
    const targetTotal = finite(target && target.total, 0);
    const improvement = targetTotal - currentTotal;
    const survivalImprovement = finite(target && target.survival, 0) - finite(current && current.survival, 0);
    const currentSpeed = finite(current && current.stats && current.stats.speed, 0);
    const targetSpeed = finite(target && target.stats && target.stats.speed, 0);
    const speedImprovement = targetSpeed - currentSpeed;
    const threshold = currentTotal <= 0
      ? 0.001
      : Math.max(0.001, Math.abs(currentTotal) * Math.max(0, finite(minImprovementRatio, 0)));
    const merchant = String(profile && profile.ctype || '').toLowerCase() === 'merchant';
    if (merchant && speedImprovement < 0) {
      return {
        meaningful: false,
        reason: 'MERCHANT_SPEED_LOSS_REJECTED',
        improvement,
        survivalImprovement,
        speedImprovement,
        threshold
      };
    }
    if (merchant && speedImprovement > 0) {
      return {
        meaningful: improvement > threshold,
        reason: improvement > threshold ? 'MERCHANT_SPEED_WEIGHTED_IMPROVEMENT' : 'MERCHANT_SPEED_NET_REGRESSION_REJECTED',
        improvement,
        survivalImprovement,
        speedImprovement,
        threshold
      };
    }
    return {
      meaningful: improvement > threshold,
      reason: improvement > threshold ? 'WEIGHTED_GEAR_IMPROVEMENT' : 'INSUFFICIENT_GEAR_IMPROVEMENT',
      improvement,
      survivalImprovement,
      speedImprovement,
      threshold
    };
  }

  function gradeForLevel(meta, level) {
    const grades = Array.isArray(meta && meta.grades) ? meta.grades : [9, 10, 11, 12];
    const current = Math.max(0, Math.floor(finite(level, 0)));
    for (let index = Math.min(3, grades.length - 1); index >= 0; index -= 1) {
      const threshold = finite(grades[index]);
      if (threshold != null && current >= threshold) return index + 1;
    }
    return 0;
  }

  function progressionProbability(gameData, meta, nextLevel, compound) {
    const bucket = Math.max(0, Math.min(2, Math.floor(finite(meta && meta.igrade, 0))));
    const live = gameData && (compound ? gameData.compounds : gameData.upgrades);
    const table = live && typeof live === 'object'
      ? live
      : compound ? DEFAULT_COMPOUND_CHANCES : DEFAULT_UPGRADE_CHANCES;
    const row = table && (table[bucket] || table[String(bucket)]);
    const raw = row && (row[nextLevel] != null ? row[nextLevel] : row[String(nextLevel)]);
    const chance = finite(raw);
    return chance != null && chance >= 0 && chance <= 1 ? chance : null;
  }

  function scrollName(meta, level, compound) {
    return (compound ? 'cscroll' : 'scroll') + Math.max(0, Math.min(3, gradeForLevel(meta, level)));
  }

  function npcSellValue(gameData, itemOrName, explicitLevel = null, quantity = 1) {
    const item = typeof itemOrName === 'string'
      ? { name: itemOrName, level: explicitLevel == null ? 0 : explicitLevel }
      : itemOrName || {};
    const name = String(item.name || '');
    const def = gameData && gameData.items && gameData.items[name];
    if (!def || typeof def !== 'object') return null;
    if (item.gift) return 1;
    const base = finite(def.g);
    if (base == null || base < 0) return null;
    let value = def.cash ? base : base * 0.6;
    const markup = finite(def.markup);
    if (markup != null && markup > 0) value /= markup;
    const level = Math.max(0, Math.floor(explicitLevel == null ? levelOf(item) : finite(explicitLevel, 0)));

    if (def.compound && level > 0) {
      const grades = Array.isArray(def.grades) ? def.grades : [11, 12];
      let grade = 0;
      for (let i = 1; i <= level; i += 1) {
        if (i > finite(grades[1], 12)) grade = 2;
        else if (i > finite(grades[0], 11)) grade = 1;
        value *= def.cash ? 1.5 : 3.2;
        if (String(def.type || '') !== 'booster') {
          const scroll = gameData.items && gameData.items['cscroll' + grade];
          value += finite(scroll && scroll.g, 0) / 2.4;
        } else {
          value *= 0.75;
        }
      }
    }

    if (def.upgrade && level > 0) {
      const grades = Array.isArray(def.grades) ? def.grades : [11, 12];
      let grade = 0;
      let scrollContribution = 0;
      for (let i = 1; i <= level; i += 1) {
        if (i > finite(grades[1], 12)) grade = 2;
        else if (i > finite(grades[0], 11)) grade = 1;
        const scroll = gameData.items && gameData.items['scroll' + grade];
        scrollContribution += finite(scroll && scroll.g, 0) / 2;
        if (i >= 7) {
          value *= 3;
          scrollContribution *= 1.32;
        } else if (i === 6) {
          value *= 2.4;
        } else if (i >= 4) {
          value *= 2;
        }
        if (i === 9) {
          value *= 2.64;
          value += 400000;
        }
        if (i === 10) value *= 5;
        if (i === 12) value *= 0.8;
      }
      value += scrollContribution;
    }

    if (item.expiresAt || item.expires) value /= 8;
    return Math.round(value * Math.max(1, Math.floor(finite(quantity != null ? quantity : item.quantity, 1))));
  }

  class FutureGearEconomyEvaluator {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.gear = options.gear || null;
      this.market = options.market || null;
      this.storage = options.storage || null;
      this.getProfiles = typeof options.getProfiles === 'function' ? options.getProfiles : () => [];
      this.getAccountWealth = typeof options.getAccountWealth === 'function' ? options.getAccountWealth : () => ({ known: false, totalGold: null });
      this.deliveryKey = cleanText(options.deliveryKey || 'albot:h28:offline-gear-deliveries:v1', 220);
      this.riskMode = null;
      this.lastRiskState = null;
      this.config = {
        minImprovementRatio: Math.max(0.001, Math.min(1, finite(options.minImprovementRatio, 0.05))),
        maxProbeLevel: Math.max(1, Math.min(12, Math.floor(finite(options.maxProbeLevel, 12)))),
        farmerUpgradeMaxLevel: Math.max(1, Math.min(12, Math.floor(finite(options.farmerUpgradeMaxLevel, 7)))),
        economicUpgradeMaxLevel: Math.max(1, Math.min(12, Math.floor(finite(options.economicUpgradeMaxLevel, 7)))),
        economicCompoundMaxLevel: Math.max(1, Math.min(12, Math.floor(finite(options.economicCompoundMaxLevel, 10)))),
        conservativeEnterGold: Math.max(0, finite(options.conservativeEnterGold, 150000000)),
        conservativeExitGold: Math.max(0, finite(options.conservativeExitGold, 170000000)),
        conservativeMinChance: Math.max(0, Math.min(1, finite(options.conservativeMinChance, 0.80))),
        noRiskItemValueGold: Math.max(0, finite(options.noRiskItemValueGold, 50000000))
      };
      this.lastPlan = null;
      this.lastBySlot = new Map();
      this.metrics = {
        plans: 0,
        itemsEvaluated: 0,
        checked: 0,
        protected: 0,
        sellSafe: 0,
        upgradeRecommended: 0,
        compoundRecommended: 0,
        accumulateRecommended: 0,
        incomplete: 0
      };
    }

    _roots() {
      const out = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!out.includes(current)) out.push(current);
        let next = null;
        try {
          if (current.parent && current.parent !== current) next = current.parent;
          else if (current.top && current.top !== current) next = current.top;
        } catch (_) {}
        if (!next || out.includes(next)) break;
        current = next;
      }
      return out;
    }

    _gameData() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && candidate.G && typeof candidate.G === 'object') return candidate.G;
        } catch (_) {}
      }
      return {};
    }

    _rawItem(name) {
      const G = this._gameData();
      const row = G && G.items && G.items[String(name || '')];
      return row && typeof row === 'object' ? row : null;
    }

    _profiles() {
      let rows = [];
      try { rows = this.getProfiles() || []; } catch (_) {}
      return (Array.isArray(rows) ? rows : [])
        .filter(row => row && row.name && row.ctype && row.rip !== true)
        .map(row => clone(row));
    }

    _profileEquipment(profile) {
      if (!profile || !profile.equipment || typeof profile.equipment !== 'object') return null;
      if (profile.equipmentKnown === false) return null;
      // An explicitly observed empty equipment map is known empty, not
      // UNKNOWN. Account/merchant risk checks still require fresh evidence.
      return profile.equipmentKnown === true
        ? profile.equipment
        : (Object.values(profile.equipment).some(item => item && item.name)
          ? profile.equipment : null);
    }

    _classProfile(ctype) {
      try { return this.game && this.game.classEquipmentProfile ? this.game.classEquipmentProfile(ctype) : null; }
      catch (_) { return null; }
    }

    _compatible(meta, profile) {
      if (!meta || !profile) return false;
      const ctype = String(profile.ctype || '').toLowerCase();
      const classes = Array.isArray(meta.class) ? meta.class : meta.class ? [meta.class] : [];
      if (classes.length && !classes.map(value => String(value).toLowerCase()).includes(ctype)) return false;
      const required = finite(meta.level, 0);
      const observed = finite(profile.level);
      if (required > 0 && observed == null) return null;
      return required <= finite(observed, 0);
    }

    _slotCompatible(meta, profile, slot) {
      const base = this._compatible(meta, profile);
      if (base !== true) return base;
      const type = String(meta.type || '').toLowerCase();
      const wtype = String(meta.wtype || '').toLowerCase();
      const rules = this._classProfile(profile.ctype);

      if (slot === 'mainhand') {
        if (type !== 'weapon' && type !== 'tool') return false;
        if (!rules) return null;
        const oneHand = !!wtype && Array.isArray(rules.mainhand) && rules.mainhand.includes(wtype);
        const twoHand = !!wtype && Array.isArray(rules.doublehand) && rules.doublehand.includes(wtype);
        if (!oneHand && !twoHand) return false;
        const equipment = this._profileEquipment(profile);
        if (twoHand && equipment && equipment.offhand) return false;
        return true;
      }

      if (slot === 'offhand') {
        if (!rules) return null;
        const equipment = this._profileEquipment(profile);
        const main = equipment && equipment.mainhand;
        const mainMeta = main && this._rawItem(main.name);
        const mainWtype = String(mainMeta && mainMeta.wtype || '').toLowerCase();
        if (mainWtype && Array.isArray(rules.doublehand) && rules.doublehand.includes(mainWtype)) return false;
        if (type === 'weapon' || type === 'tool') {
          return !!(wtype && Array.isArray(rules.offhand) && rules.offhand.includes(wtype));
        }
        if (!['shield', 'source', 'quiver', 'misc_offhand'].includes(type)) return false;
        return Array.isArray(rules.offhand) && rules.offhand.includes(type);
      }

      if (type === 'ring') return slot === 'ring1' || slot === 'ring2';
      if (type === 'earring') return slot === 'earring1' || slot === 'earring2';
      return type === slot || (type === 'chest' && slot === 'coat');
    }

    _currentScore(profile, slot) {
      const equipment = this._profileEquipment(profile);
      if (!equipment) return { known: false, score: null, item: null };
      const item = equipment[slot] || null;
      if (!item || !item.name) return { known: true, score: { total: 0, survival: 0, stats: {} }, item: null };
      const meta = this._rawItem(item.name);
      if (!meta) return { known: false, score: null, item: clone(item) };
      return { known: true, score: scoreItem(meta, levelOf(item), profile.ctype, profile), item: clone(item) };
    }

    _curve(meta, observedLevel, currentScore, profile) {
      const family = meta && meta.compound ? 'COMPOUND' : meta && meta.upgrade ? 'UPGRADE' : null;
      const compound = family === 'COMPOUND';
      const maxLevel = family === 'UPGRADE' && String(profile.ctype || '').toLowerCase() !== 'merchant'
        ? Math.min(this.config.maxProbeLevel, this.config.farmerUpgradeMaxLevel)
        : compound
          ? Math.min(this.config.maxProbeLevel, this.config.economicCompoundMaxLevel)
          : this.config.maxProbeLevel;
      const limit = family ? Math.max(observedLevel, maxLevel) : observedLevel;
      const G = this._gameData();
      const rows = [];
      let cumulative = 1;
      for (let level = observedLevel; level <= limit; level += 1) {
        let stepChance = level === observedLevel ? 1 : null;
        if (level > observedLevel) {
          stepChance = progressionProbability(G, meta, level, compound);
          cumulative = cumulative == null || stepChance == null ? null : cumulative * stepChance;
        }
        const score = scoreItem(meta, level, profile.ctype, profile);
        const delta = scoreImprovement(currentScore, score, this.config.minImprovementRatio, profile);
        const rawUtility = Math.max(0, delta.improvement) + Math.max(0, delta.survivalImprovement) * 0.2;
        const riskAdjustedUtility = level === observedLevel
          ? rawUtility
          : cumulative == null ? null : rawUtility * cumulative;
        rows.push({
          level,
          family,
          meaningful: delta.meaningful === true,
          score,
          delta,
          stepChance,
          cumulativeSuccessChance: cumulative,
          rawUtility,
          riskAdjustedUtility
        });
      }
      return rows;
    }

    _bestFutureFor(meta, item, profile) {
      const slots = candidateSlots(meta);
      if (!slots.length) return { checked: true, best: null };
      const compatible = this._compatible(meta, profile);
      if (compatible === null) return { checked: false, reason: 'PROFILE_LEVEL_UNKNOWN', best: null };
      if (compatible === false) return { checked: true, best: null };
      const equipment = this._profileEquipment(profile);
      if (!equipment) return { checked: false, reason: 'PROFILE_EQUIPMENT_UNKNOWN', best: null };

      let best = null;
      for (const slot of slots) {
        const slotAllowed = this._slotCompatible(meta, profile, slot);
        if (slotAllowed === null) return { checked: false, reason: 'PROFILE_EQUIPMENT_RULES_UNKNOWN', best: null };
        if (!slotAllowed) continue;
        const current = this._currentScore(profile, slot);
        if (!current.known) return { checked: false, reason: 'CURRENT_GEAR_DEFINITION_UNKNOWN', best: null };
        const curve = this._curve(meta, levelOf(item), current.score, profile);
        const meaningful = curve.filter(row => row.meaningful === true);
        if (!meaningful.length) continue;
        meaningful.sort((a, b) =>
          finite(b.riskAdjustedUtility, -Infinity) - finite(a.riskAdjustedUtility, -Infinity)
          || b.delta.improvement - a.delta.improvement
          || a.level - b.level
        );
        const selected = meaningful[0];
        const candidate = {
          targetCharacter: profile.name,
          targetCtype: profile.ctype,
          targetSlot: slot,
          targetOnline: profile.online === true,
          roleProfile: roleProfile(profile),
          currentItem: current.item,
          currentScore: finite(current.score && current.score.total, 0),
          observedLevel: levelOf(item),
          observedMeaningful: !!(curve.find(row => row.level === levelOf(item)) && curve.find(row => row.level === levelOf(item)).meaningful),
          observedImprovement: finite(curve.find(row => row.level === levelOf(item)) && curve.find(row => row.level === levelOf(item)).delta && curve.find(row => row.level === levelOf(item)).delta.improvement, 0),
          observedSurvivalImprovement: finite(curve.find(row => row.level === levelOf(item)) && curve.find(row => row.level === levelOf(item)).delta && curve.find(row => row.level === levelOf(item)).delta.survivalImprovement, 0),
          targetLevel: selected.level,
          nextMutationLevel: selected.level > levelOf(item) ? levelOf(item) + 1 : levelOf(item),
          improvement: selected.delta.improvement,
          survivalImprovement: selected.delta.survivalImprovement,
          cumulativeSuccessChance: selected.cumulativeSuccessChance,
          riskAdjustedUtility: selected.riskAdjustedUtility,
          firstMeaningfulLevel: meaningful.slice().sort((a, b) => a.level - b.level)[0].level,
          curve: curve.map(row => ({
            level: row.level,
            meaningful: row.meaningful,
            stepChance: row.stepChance,
            cumulativeSuccessChance: row.cumulativeSuccessChance,
            improvement: row.delta.improvement,
            survivalImprovement: row.delta.survivalImprovement,
            riskAdjustedUtility: row.riskAdjustedUtility
          }))
        };
        const candidateFarmer = String(candidate.targetCtype || '').toLowerCase() !== 'merchant';
        const bestFarmer = best && String(best.targetCtype || '').toLowerCase() !== 'merchant';
        if (!best
            || (candidateFarmer && !bestFarmer)
            || (candidateFarmer === bestFarmer
              && (finite(candidate.riskAdjustedUtility, -Infinity) > finite(best.riskAdjustedUtility, -Infinity)
                || (finite(candidate.riskAdjustedUtility, -Infinity) === finite(best.riskAdjustedUtility, -Infinity)
                  && candidate.improvement > best.improvement)))) {
          best = candidate;
        }
      }
      return { checked: true, best };
    }

    _scrollCost(meta, level, compound) {
      const G = this._gameData();
      const name = scrollName(meta, level, compound);
      const def = G && G.items && G.items[name];
      const cost = finite(def && def.g);
      return { name, cost: cost != null && cost >= 0 ? cost : null };
    }

    _marketBid(itemName, level) {
      if (!this.market || typeof this.market.marketAnalysis !== 'function') return null;
      let analysis = null;
      try { analysis = this.market.marketAnalysis(itemName, { level: Math.max(0, Math.floor(finite(level, 0))) }); } catch (_) {}
      const bid = analysis && analysis.bestBid || null;
      const price = finite(bid && bid.price);
      if (!bid || price == null || price <= 0) return null;
      return {
        unitPrice: price,
        quantity: Math.max(1, Math.floor(finite(bid.quantity, 1))),
        playerName: bid.playerName || null,
        slot: bid.slot || null,
        rid: bid.rid || null
      };
    }

    _saleValue(itemOrName, explicitLevel = null, quantity = 1) {
      const item = typeof itemOrName === 'string' ? { name: itemOrName } : itemOrName || {};
      const name = String(item.name || '');
      const level = Math.max(0, Math.floor(explicitLevel == null ? levelOf(item) : finite(explicitLevel, 0)));
      const count = Math.max(0, Math.floor(finite(quantity, 1)));
      if (!name || count <= 0) return { modeled: !!name, gold: 0, npcGold: 0, marketGold: 0, source: 'NONE', marketBid: null };
      const npcUnit = npcSellValue(this._gameData(), name, level, 1);
      const bid = this._marketBid(name, level);
      if (npcUnit == null && !bid) return { modeled: false, gold: null, npcGold: null, marketGold: null, source: 'UNKNOWN', marketBid: null };
      const safeNpc = Math.max(0, finite(npcUnit, 0));
      const marketUnits = bid && bid.unitPrice > safeNpc ? Math.min(count, bid.quantity) : 0;
      const marketGold = marketUnits * (bid ? bid.unitPrice : 0);
      const npcGold = (count - marketUnits) * safeNpc;
      const gold = marketGold + npcGold;
      return {
        modeled: true,
        gold,
        npcGold: safeNpc * count,
        marketGold,
        source: marketUnits > 0 ? (marketUnits === count ? 'MARKET_BID' : 'MARKET_PLUS_NPC') : 'NPC',
        marketBid: bid ? clone(bid) : null
      };
    }

    _accountRiskState() {
      let wealth = null;
      try { wealth = this.getAccountWealth() || null; } catch (_) {}
      const known = !!(wealth && wealth.known === true && finite(wealth.totalGold) != null);
      const totalGold = known ? Math.max(0, finite(wealth.totalGold, 0)) : null;
      if (!known) {
        this.riskMode = 'CONSERVATIVE';
      } else if (this.riskMode === 'CONSERVATIVE') {
        if (totalGold >= this.config.conservativeExitGold) this.riskMode = 'NORMAL';
      } else if (this.riskMode === 'NORMAL') {
        if (totalGold < this.config.conservativeEnterGold) this.riskMode = 'CONSERVATIVE';
      } else {
        this.riskMode = totalGold < this.config.conservativeEnterGold ? 'CONSERVATIVE' : 'NORMAL';
      }
      this.lastRiskState = {
        mode: this.riskMode,
        wealthKnown: known,
        totalGold,
        enterBelowGold: this.config.conservativeEnterGold,
        exitAtGold: this.config.conservativeExitGold,
        conservativeMinChance: this.config.conservativeMinChance,
        wealth: wealth ? clone(wealth) : null
      };
      return clone(this.lastRiskState);
    }

    _noRiskClassification(item, meta) {
      const rarity = String(meta && (meta.rarity || meta.quality || meta.tier) || '').trim().toLowerCase();
      const rare = !!(meta && (meta.rare === true || meta.unique === true || meta.exclusive === true || meta.legacy === true))
        || ['rare', 'epic', 'legendary', 'mythic', 'unique', 'artifact', 'relic'].includes(rarity);
      const sale = this._saleValue(item, levelOf(item), 1);
      const valuable = sale.modeled === true && finite(sale.gold) != null && sale.gold >= this.config.noRiskItemValueGold;
      return {
        noRisk: rare || valuable,
        reason: rare ? 'EXTREME_RARITY' : valuable ? 'EXTREME_VALUE' : null,
        rarity: rarity || null,
        liquidationGold: finite(sale.gold),
        thresholdGold: this.config.noRiskItemValueGold,
        sale
      };
    }

    mutationRiskPolicy(kind, item, meta = null, evaluation = null, targetLevel = null, chanceOverride = null, options = {}) {
      const definition = meta || this._rawItem(item && item.name);
      const chance = finite(chanceOverride);
      const risk = this._accountRiskState();
      const noRisk = this._noRiskClassification(item, definition);
      const deterministic = chance != null && chance >= 1;
      if (noRisk.noRisk && !deterministic) {
        return {
          allowed: false,
          reason: 'NO_RISK_ITEM_MUTATION_BLOCKED',
          mode: risk.mode,
          chance,
          minChance: 1,
          noRisk,
          wealth: risk,
          kind: String(kind || '').toUpperCase(),
          targetLevel: targetLevel == null ? null : Math.max(0, Math.floor(finite(targetLevel, 0))),
          itemCount: Math.max(1, Math.floor(finite(options.itemCount, 1)))
        };
      }
      if (risk.mode === 'CONSERVATIVE' && (chance == null || chance < this.config.conservativeMinChance)) {
        return {
          allowed: false,
          reason: chance == null ? 'CONSERVATIVE_CHANCE_UNKNOWN' : 'CONSERVATIVE_CHANCE_BELOW_80_PERCENT',
          mode: risk.mode,
          chance,
          minChance: this.config.conservativeMinChance,
          noRisk,
          wealth: risk,
          kind: String(kind || '').toUpperCase(),
          targetLevel: targetLevel == null ? null : Math.max(0, Math.floor(finite(targetLevel, 0))),
          itemCount: Math.max(1, Math.floor(finite(options.itemCount, 1)))
        };
      }
      return {
        allowed: true,
        reason: noRisk.noRisk && deterministic ? 'NO_RISK_DETERMINISTIC_MUTATION' : 'ACCOUNT_RISK_POLICY_ACCEPTED',
        mode: risk.mode,
        chance,
        minChance: risk.mode === 'CONSERVATIVE' ? this.config.conservativeMinChance : null,
        noRisk,
        wealth: risk,
        kind: String(kind || '').toUpperCase(),
        targetLevel: targetLevel == null ? null : Math.max(0, Math.floor(finite(targetLevel, 0))),
        itemCount: Math.max(1, Math.floor(finite(options.itemCount, 1)))
      };
    }

    _upgradeEconomics(item, meta) {
      const G = this._gameData();
      const currentLevel = levelOf(item);
      const maxLevel = Math.max(currentLevel, Math.min(12, this.config.economicUpgradeMaxLevel));
      const values = new Map();
      const direct = new Map();
      for (let level = currentLevel; level <= maxLevel; level += 1) {
        const sell = this._saleValue(item.name, level, 1);
        direct.set(level, sell);
        values.set(level, { expectedGold: sell.gold, targetLevel: level, action: 'SELL', chance: null, scroll: null, scrollCost: 0, sale: clone(sell) });
      }
      for (let level = maxLevel - 1; level >= currentLevel; level -= 1) {
        const nextLevel = level + 1;
        const chance = progressionProbability(G, meta, nextLevel, false);
        const scroll = this._scrollCost(meta, level, false);
        const next = values.get(nextLevel);
        const sale = direct.get(level);
        if (chance == null || scroll.cost == null || next == null || !sale || sale.gold == null) continue;
        const policy = this.mutationRiskPolicy('UPGRADE', { ...item, level }, meta, null, nextLevel, chance, { itemCount: 1 });
        if (!policy.allowed) continue;
        const expected = chance * next.expectedGold - scroll.cost;
        if (expected > sale.gold) values.set(level, {
          expectedGold: expected,
          targetLevel: next.targetLevel,
          action: 'UPGRADE',
          chance,
          scroll: scroll.name,
          scrollCost: scroll.cost,
          sale: clone(sale),
          riskPolicy: clone(policy)
        });
      }
      const choice = values.get(currentLevel) || {};
      const directSale = direct.get(currentLevel) || {};
      const directSellGold = finite(directSale.gold);
      return {
        modeled: directSellGold != null,
        family: 'UPGRADE',
        action: choice.action || 'SELL',
        currentLevel,
        targetLevel: choice.targetLevel == null ? currentLevel : choice.targetLevel,
        expectedGold: finite(choice.expectedGold, directSellGold),
        directSellGold,
        directSale: clone(directSale),
        expectedGain: finite(choice.expectedGold, directSellGold) - finite(directSellGold, 0),
        nextChance: choice.chance == null ? null : choice.chance,
        scroll: choice.scroll || null,
        scrollCost: finite(choice.scrollCost, 0),
        riskPolicy: choice.riskPolicy ? clone(choice.riskPolicy) : null
      };
    }

    _binomialProbability(n, k, p) {
      if (k < 0 || k > n) return 0;
      let choose = 1;
      for (let i = 1; i <= k; i += 1) choose = choose * (n - (k - i)) / i;
      return choose * Math.pow(p, k) * Math.pow(1 - p, n - k);
    }

    _compoundOptimalValue(item, meta, level, count, maxLevel, memo = new Map()) {
      const safeCount = Math.max(0, Math.floor(finite(count, 0)));
      const key = String(level) + ':' + String(safeCount);
      if (memo.has(key)) return memo.get(key);
      const sale = this._saleValue(item.name, level, safeCount);
      const direct = finite(sale.gold, 0);
      let best = {
        expectedGold: direct,
        action: 'SELL',
        targetLevel: level,
        nextChance: null,
        scroll: null,
        scrollCost: 0,
        directSale: clone(sale)
      };
      if (safeCount < 3 || level >= maxLevel) {
        memo.set(key, best);
        return best;
      }

      const nextLevel = level + 1;
      const chance = progressionProbability(this._gameData(), meta, nextLevel, true);
      const scroll = this._scrollCost(meta, level, true);
      const policy = this.mutationRiskPolicy('COMPOUND', { ...item, level }, meta, null, nextLevel, chance, { itemCount: 3 });
      if (chance == null || scroll.cost == null || !policy.allowed) {
        best.riskPolicy = clone(policy);
        memo.set(key, best);
        return best;
      }

      const groups = Math.floor(safeCount / 3);
      const remainder = safeCount % 3;
      const remainderValue = finite(this._saleValue(item.name, level, remainder).gold, 0);
      let expected = remainderValue - groups * scroll.cost;
      let deepest = nextLevel;
      for (let successes = 0; successes <= groups; successes += 1) {
        const probability = this._binomialProbability(groups, successes, chance);
        if (probability <= 0) continue;
        const future = this._compoundOptimalValue(item, meta, nextLevel, successes, maxLevel, memo);
        expected += probability * finite(future.expectedGold, 0);
        deepest = Math.max(deepest, future.targetLevel || nextLevel);
      }
      if (expected > direct) {
        best = {
          expectedGold: expected,
          action: 'COMPOUND',
          targetLevel: deepest,
          nextChance: chance,
          scroll: scroll.name,
          scrollCost: scroll.cost,
          directSale: clone(sale),
          groups,
          riskPolicy: clone(policy)
        };
      }
      memo.set(key, best);
      return best;
    }

    _compoundEconomics(item, meta, sameCount) {
      const currentLevel = levelOf(item);
      const maxLevel = Math.max(currentLevel, Math.min(12, this.config.economicCompoundMaxLevel));
      const actualCount = Math.max(0, Math.floor(finite(sameCount, 0)));
      const planCount = Math.max(3, actualCount);
      const directActual = this._saleValue(item.name, currentLevel, Math.max(1, actualCount));
      const optimized = this._compoundOptimalValue(item, meta, currentLevel, planCount, maxLevel);
      const profitable = optimized.action === 'COMPOUND' && optimized.expectedGold > finite(optimized.directSale && optimized.directSale.gold, 0);
      const action = profitable ? (actualCount >= 3 ? 'COMPOUND' : 'ACCUMULATE') : 'SELL';
      return {
        modeled: directActual.modeled === true,
        family: 'COMPOUND',
        action,
        currentLevel,
        targetLevel: profitable ? optimized.targetLevel : currentLevel,
        expectedGold: profitable ? optimized.expectedGold : directActual.gold,
        directSellGold: directActual.gold,
        directSale: clone(directActual),
        expectedGain: profitable ? optimized.expectedGold - finite(optimized.directSale && optimized.directSale.gold, 0) : 0,
        nextChance: optimized.nextChance == null ? null : optimized.nextChance,
        scroll: optimized.scroll || null,
        scrollCost: finite(optimized.scrollCost, 0),
        sameCount: actualCount,
        modeledCount: planCount,
        groups: optimized.groups || 0,
        multiStep: profitable && optimized.targetLevel > currentLevel + 1,
        riskPolicy: optimized.riskPolicy ? clone(optimized.riskPolicy) : null
      };
    }

    _economicDecision(item, meta, sameCount) {
      if (meta && meta.compound) return this._compoundEconomics(item, meta, sameCount);
      if (meta && meta.upgrade) return this._upgradeEconomics(item, meta);
      const direct = this._saleValue(item, levelOf(item), 1);
      return {
        modeled: direct.modeled === true,
        family: 'NONE',
        action: 'SELL',
        currentLevel: levelOf(item),
        targetLevel: levelOf(item),
        expectedGold: direct.gold,
        directSellGold: direct.gold,
        directSale: clone(direct),
        expectedGain: 0
      };
    }

    _hardProtection(item, meta) {
      if (!item || !item.name) return 'ITEM_INVALID';
      if (item.locked === true) return 'ITEM_LOCKED';
      if (item.giveaway === true) return 'ITEM_GIVEAWAY';
      if (item.expiresAt) return 'ITEM_EXPIRING';
      if (!meta) return 'ITEM_DEFINITION_UNKNOWN';
      if (meta.quest === true || String(meta.type || '').toLowerCase() === 'quest') return 'QUEST_ITEM';
      if (meta.event === true
          || meta.cash === true || finite(meta.cash, 0) > 0
          || meta.cash_item === true
          || meta.soulbound === true || meta.soul_bound === true
          || meta.exchange === true || finite(meta.e, 0) > 0) {
        return 'SPECIAL_ITEM_PROTECTED';
      }
      return null;
    }

    evaluateItem(item, context = {}) {
      const meta = this._rawItem(item && item.name);
      const hard = this._hardProtection(item, meta);
      const sameCount = Math.max(0, Math.floor(finite(context.sameCount, 0)));
      if (hard) {
        return {
          checked: hard !== 'ITEM_DEFINITION_UNKNOWN',
          protected: true,
          sellSafe: false,
          reason: hard,
          action: 'KEEP',
          item: item && item.name || null,
          observedLevel: levelOf(item),
          sameCount,
          futureGear: null,
          economic: null,
          checkedCharacterCount: 0,
          expectedCharacterCount: 0
        };
      }

      const profiles = Array.isArray(context.profiles) ? context.profiles : this._profiles();
      let checkedCharacterCount = 0;
      let incompleteReason = null;
      let protection = null;
      for (const profile of profiles) {
        const result = this._bestFutureFor(meta, item, profile);
        if (result.checked !== true) {
          incompleteReason = incompleteReason || result.reason || 'PROFILE_EVALUATION_INCOMPLETE';
          continue;
        }
        checkedCharacterCount += 1;
        const candidate = result.best;
        if (!candidate) continue;
        const candidateFarmer = String(candidate.targetCtype || '').toLowerCase() !== 'merchant';
        const protectionFarmer = protection && String(protection.targetCtype || '').toLowerCase() !== 'merchant';
        if (!protection
            || (candidateFarmer && !protectionFarmer)
            || (candidateFarmer === protectionFarmer
              && (finite(candidate.riskAdjustedUtility, -Infinity) > finite(protection.riskAdjustedUtility, -Infinity)
                || (finite(candidate.riskAdjustedUtility, -Infinity) === finite(protection.riskAdjustedUtility, -Infinity)
                  && candidate.improvement > protection.improvement)))) {
          protection = candidate;
        }
      }

      const checked = profiles.length > 0 && checkedCharacterCount === profiles.length && incompleteReason == null;
      if (!checked) {
        return {
          checked: false,
          protected: true,
          sellSafe: false,
          reason: incompleteReason || 'FUTURE_GEAR_EVALUATION_REQUIRED',
          action: 'KEEP',
          item: item.name,
          observedLevel: levelOf(item),
          sameCount,
          futureGear: protection ? clone(protection) : null,
          economic: null,
          checkedCharacterCount,
          expectedCharacterCount: profiles.length
        };
      }

      if (protection) {
        const family = meta.compound ? 'COMPOUND' : meta.upgrade ? 'UPGRADE' : 'GEAR';
        const needsMutation = protection.targetLevel > levelOf(item);
        let action = needsMutation && family === 'COMPOUND' && sameCount < 3
          ? 'ACCUMULATE'
          : needsMutation ? family : 'GEAR';
        let mutationPolicy = null;
        if (needsMutation) {
          const nextLevel = Math.max(levelOf(item) + 1, finite(protection.nextMutationLevel, levelOf(item) + 1));
          const nextStep = (protection.curve || []).find(row => Math.max(0, Number(row && row.level) || 0) === nextLevel);
          const chance = finite(nextStep && nextStep.stepChance);
          mutationPolicy = this.mutationRiskPolicy(family, item, meta, protection, nextLevel, chance, {
            itemCount: family === 'COMPOUND' ? 3 : 1
          });
          if (!mutationPolicy.allowed) action = 'HOLD';
        } else if (action === 'GEAR') {
          // Reservations are needed for H18 even when the target is online.
          // The old offline-only condition made every online Gear delivery
          // impossible despite complete, validated equipment evidence.
          this._rememberGearReservation(item, protection);
        }
        return {
          checked: true,
          protected: true,
          sellSafe: false,
          reason: action === 'HOLD'
            ? mutationPolicy && mutationPolicy.reason || 'GEAR_MUTATION_RISK_HOLD'
            : protection.targetLevel > levelOf(item)
              ? 'FUTURE_GEAR_UPGRADE_POTENTIAL'
              : protection.targetOnline === true
                ? 'CURRENT_GEAR_UPGRADE_POTENTIAL'
                : 'OFFLINE_TARGET_GEAR_READY',
          action,
          item: item.name,
          observedLevel: levelOf(item),
          sameCount,
          futureGear: clone(protection),
          economic: null,
          mutationPolicy: mutationPolicy ? clone(mutationPolicy) : null,
          checkedCharacterCount,
          expectedCharacterCount: profiles.length
        };
      }

      const economic = this._economicDecision(item, meta, sameCount);
      const action = economic && economic.action || 'KEEP';
      return {
        checked: true,
        protected: action !== 'SELL',
        sellSafe: action === 'SELL',
        reason: action === 'SELL' ? 'FUTURE_GEAR_EVALUATED_SAFE' : 'ECONOMIC_PROGRESSION_PREFERRED',
        action,
        item: item.name,
        observedLevel: levelOf(item),
        sameCount,
        futureGear: null,
        economic: clone(economic),
        checkedCharacterCount,
        expectedCharacterCount: profiles.length
      };
    }

    _storageRead(key, fallback = null) {
      if (!this.storage || !key) return fallback;
      try {
        const shared = typeof this.storage.getShared === 'function' ? this.storage.getShared(key) : null;
        const raw = shared == null && typeof this.storage.get === 'function' ? this.storage.get(key) : shared;
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch (_) {
        return fallback;
      }
    }

    _storageWrite(key, value) {
      if (!this.storage || !key) return false;
      const raw = JSON.stringify(value);
      try {
        if (typeof this.storage.setShared === 'function' && this.storage.setShared(key, raw) !== false) return true;
      } catch (_) {}
      try {
        return typeof this.storage.set === 'function' ? this.storage.set(key, raw) !== false : false;
      } catch (_) {
        return false;
      }
    }

    _deliveryReservations() {
      const rows = this._storageRead(this.deliveryKey, []);
      return Array.isArray(rows) ? rows.filter(row => row && row.fingerprint && row.targetCharacter) : [];
    }

    _saveDeliveryReservations(rows) {
      return this._storageWrite(this.deliveryKey, (Array.isArray(rows) ? rows : []).slice(-100));
    }

    _rememberGearReservation(item, protection) {
      if (!item || !item.name || !protection || !protection.targetCharacter) return false;
      const fingerprint = identityKey(item);
      const rows = this._deliveryReservations();
      const next = rows.filter(row => !(row.fingerprint === fingerprint && row.targetCharacter === protection.targetCharacter));
      next.push({
        schemaVersion: 1,
        fingerprint,
        itemName: item.name,
        level: levelOf(item),
        statType: item.statType != null ? item.statType : item.stat_type || null,
        property: item.property == null ? (item.p == null ? null : clone(item.p)) : clone(item.property),
        targetCharacter: protection.targetCharacter,
        targetSlot: protection.targetSlot || null,
        targetCtype: protection.targetCtype || null,
        createdAt: new Date().toISOString()
      });
      return this._saveDeliveryReservations(next);
    }

    pendingGearReservations() {
      const profiles = new Map(this._profiles().map(row => [String(row.name), row]));
      return this._deliveryReservations().map(row => ({
        ...clone(row),
        targetOnline: profiles.get(String(row.targetCharacter)) && profiles.get(String(row.targetCharacter)).online === true
      }));
    }

    reservationForItem(item, targetCharacter = null) {
      if (!item || !item.name) return null;
      const fingerprint = identityKey(item);
      return this.pendingGearReservations().find(row =>
        row.fingerprint === fingerprint
        && (!targetCharacter || String(row.targetCharacter) === String(targetCharacter))) || null;
    }

    completeGearDelivery(itemOrFingerprint, targetCharacter) {
      const fingerprint = typeof itemOrFingerprint === 'string' ? itemOrFingerprint : identityKey(itemOrFingerprint);
      const target = String(targetCharacter || '');
      const rows = this._deliveryReservations();
      const next = rows.filter(row => !(row.fingerprint === fingerprint && String(row.targetCharacter) === target));
      this._saveDeliveryReservations(next);
      return rows.length !== next.length;
    }

    cancelGearReservation(fingerprint, targetCharacter) {
      return this.completeGearDelivery(String(fingerprint || ''), targetCharacter);
    }

    deliveryAuthorization(item, targetCharacter) {
      if (!item || !item.name || !targetCharacter) return { allowed: false, reason: 'GEAR_DELIVERY_ARGUMENT_INVALID' };
      const reservation = this.reservationForItem(item, targetCharacter);
      if (!reservation) return { allowed: false, reason: 'GEAR_DELIVERY_RESERVATION_MISSING' };
      const evaluation = this.evaluateItem(item, { profiles: this._profiles(), sameCount: 1 });
      const protection = evaluation && evaluation.futureGear;
      const allowed = !!(evaluation
        && evaluation.checked === true
        && evaluation.action === 'GEAR'
        && protection
        && String(protection.targetCharacter) === String(targetCharacter));
      return {
        allowed,
        reason: allowed ? 'GEAR_DELIVERY_AUTHORIZED' : 'GEAR_DELIVERY_NO_LONGER_VALID',
        reservation: clone(reservation),
        evaluation: evaluation ? clone(evaluation) : null
      };
    }

    evaluateInventory(inventory = null) {
      this.metrics.plans += 1;
      const snapshot = inventory || (this.game && this.game.inventorySnapshot ? this.game.inventorySnapshot() : null);
      if (!snapshot || snapshot.available === false) {
        this.lastPlan = { state: 'BLOCKED', reason: 'FUTURE_GEAR_INVENTORY_UNAVAILABLE', evaluations: [] };
        this.lastBySlot.clear();
        return clone(this.lastPlan);
      }
      const profiles = this._profiles();
      const counts = new Map();
      for (const item of snapshot.items || []) {
        const key = identityKey(item);
        counts.set(key, (counts.get(key) || 0) + Math.max(1, Math.floor(finite(item.quantity, 1))));
      }
      const evaluations = [];
      this.lastBySlot.clear();
      for (const item of snapshot.items || []) {
        const evaluation = this.evaluateItem(item, {
          profiles,
          sameCount: counts.get(identityKey(item)) || 0
        });
        const row = { slot: Number(item.slot), fingerprint: identityKey(item), ...evaluation };
        evaluations.push(row);
        this.lastBySlot.set(Number(item.slot), row);
        this.metrics.itemsEvaluated += 1;
        if (row.checked) this.metrics.checked += 1; else this.metrics.incomplete += 1;
        if (row.protected) this.metrics.protected += 1;
        if (row.sellSafe) this.metrics.sellSafe += 1;
        if (row.action === 'UPGRADE') this.metrics.upgradeRecommended += 1;
        if (row.action === 'COMPOUND') this.metrics.compoundRecommended += 1;
        if (row.action === 'ACCUMULATE') this.metrics.accumulateRecommended += 1;
      }
      this.lastPlan = {
        state: 'READY',
        reason: 'FUTURE_GEAR_EVALUATION_READY',
        evaluatedAt: new Date().toISOString(),
        profiles: profiles.map(row => ({
          name: row.name,
          ctype: row.ctype,
          level: row.level == null ? null : row.level,
          equipmentKnown: !!this._profileEquipment(row),
          local: row.local === true,
          peerFresh: row.peerFresh === true,
          roleProfile: roleProfile(row),
          online: row.online === true,
          cached: row.cached === true
        })),
        riskState: this._accountRiskState(),
        pendingGearReservations: this.pendingGearReservations(),
        evaluations
      };
      return clone(this.lastPlan);
    }

    evaluationFor(itemOrSlot, inventory = null) {
      const slot = typeof itemOrSlot === 'object' ? Number(itemOrSlot && itemOrSlot.slot) : Number(itemOrSlot);
      if (inventory) this.evaluateInventory(inventory);
      const row = this.lastBySlot.get(slot);
      if (!row) return null;
      if (typeof itemOrSlot === 'object' && identityKey(itemOrSlot) !== row.fingerprint) return null;
      return clone(row);
    }

    futureProtectionFor(character, index, name, level) {
      const row = this.lastBySlot.get(Number(index));
      if (!row || row.item !== String(name || '') || row.observedLevel !== Math.max(0, Math.floor(finite(level, 0)))) return null;
      if (!row.futureGear) return null;
      if (character && row.futureGear.targetCharacter && String(character) === String(row.futureGear.targetCharacter)) return clone(row.futureGear);
      return clone(row.futureGear);
    }

    futureSellSafetyFor(character, index, name, level) {
      const row = this.lastBySlot.get(Number(index));
      if (!row || row.item !== String(name || '') || row.observedLevel !== Math.max(0, Math.floor(finite(level, 0)))) return null;
      return {
        checked: row.checked === true,
        protected: row.protected === true,
        sellSafe: row.sellSafe === true,
        action: row.action,
        reason: row.reason,
        protection: row.futureGear ? clone(row.futureGear) : null,
        economic: row.economic ? clone(row.economic) : null,
        checkedCharacterCount: row.checkedCharacterCount,
        expectedCharacterCount: row.expectedCharacterCount
      };
    }

    status() {
      return {
        schemaVersion: 1,
        mode: 'v3-future-gear-economy-v1',
        actionAuthority: false,
        destructiveActionsEnabled: false,
        failClosedUntilPartyGearEvaluated: true,
        processedGearSellRequiresExplicitFutureSafety: true,
        fullFutureProgressionCurve: true,
        riskAdjustedTargetSelection: true,
        roleAwareGearScoring: true,
        merchantSpeedPriority: 'WEIGHTED_PRIMARY_WITH_NET_REGRESSION_GUARD',
        accountWideProfilesIncludingOffline: true,
        offlineGearReservationEnabled: true,
        economicsModel: 'MARKET_OR_NPC_EXPECTED_VALUE_V2_MULTI_STEP_COMPOUND',
        riskState: this._accountRiskState(),
        pendingGearReservations: this.pendingGearReservations(),
        config: clone(this.config),
        lastPlan: clone(this.lastPlan),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.FutureGearEconomyEvaluator = FutureGearEconomyEvaluator;
  ns.FUTURE_GEAR_CLASS_WEIGHTS = CLASS_WEIGHTS;
  // Share ALFinal's class/role scoring with the v3 production-planner port.
  ns.gearPlanning = Object.freeze({ scoreItem, scoreImprovement, candidateSlots });
})(typeof globalThis !== 'undefined' ? globalThis : this);
