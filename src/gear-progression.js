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

  function scoreItem(meta, level, ctype) {
    const weights = CLASS_WEIGHTS[String(ctype || '').toLowerCase()] || DEFAULT_WEIGHTS;
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
    return { total, survival, stats };
  }

  function scoreImprovement(current, target, minImprovementRatio) {
    const currentTotal = finite(current && current.total, 0);
    const targetTotal = finite(target && target.total, 0);
    const improvement = targetTotal - currentTotal;
    const survivalImprovement = finite(target && target.survival, 0) - finite(current && current.survival, 0);
    const threshold = currentTotal <= 0
      ? 0.001
      : Math.max(0.001, Math.abs(currentTotal) * Math.max(0, finite(minImprovementRatio, 0)));
    return {
      meaningful: improvement > threshold,
      improvement,
      survivalImprovement,
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
      this.getProfiles = typeof options.getProfiles === 'function' ? options.getProfiles : () => [];
      this.config = {
        minImprovementRatio: Math.max(0.001, Math.min(1, finite(options.minImprovementRatio, 0.05))),
        maxProbeLevel: Math.max(1, Math.min(12, Math.floor(finite(options.maxProbeLevel, 12)))),
        farmerUpgradeMaxLevel: Math.max(1, Math.min(12, Math.floor(finite(options.farmerUpgradeMaxLevel, 7)))),
        economicUpgradeMaxLevel: Math.max(1, Math.min(12, Math.floor(finite(options.economicUpgradeMaxLevel, 7)))),
        economicCompoundMaxLevel: Math.max(1, Math.min(12, Math.floor(finite(options.economicCompoundMaxLevel, 10))))
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
        .filter(row => row && row.name && row.ctype && row.rip !== true && (row.online !== false || row.local === true))
        .map(row => clone(row));
    }

    _profileEquipment(profile) {
      if (!profile || !profile.equipment || typeof profile.equipment !== 'object') return null;
      return profile.equipment;
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
      return { known: true, score: scoreItem(meta, levelOf(item), profile.ctype), item: clone(item) };
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
        const score = scoreItem(meta, level, profile.ctype);
        const delta = scoreImprovement(currentScore, score, this.config.minImprovementRatio);
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
          currentItem: current.item,
          observedLevel: levelOf(item),
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

    _upgradeEconomics(item, meta) {
      const G = this._gameData();
      const currentLevel = levelOf(item);
      const maxLevel = Math.max(currentLevel, Math.min(12, this.config.economicUpgradeMaxLevel));
      const values = new Map();
      const direct = new Map();
      for (let level = currentLevel; level <= maxLevel; level += 1) {
        const sell = npcSellValue(G, item.name, level, 1);
        direct.set(level, sell);
        values.set(level, { expectedGold: sell, targetLevel: level, action: 'SELL', chance: null, scroll: null, scrollCost: 0 });
      }
      for (let level = maxLevel - 1; level >= currentLevel; level -= 1) {
        const nextLevel = level + 1;
        const chance = progressionProbability(G, meta, nextLevel, false);
        const scroll = this._scrollCost(meta, level, false);
        const next = values.get(nextLevel);
        const sale = direct.get(level);
        if (chance == null || scroll.cost == null || next == null || sale == null) continue;
        const expected = chance * next.expectedGold - scroll.cost;
        if (expected > sale) values.set(level, {
          expectedGold: expected,
          targetLevel: next.targetLevel,
          action: 'UPGRADE',
          chance,
          scroll: scroll.name,
          scrollCost: scroll.cost
        });
      }
      const choice = values.get(currentLevel) || {};
      const directSellGold = direct.get(currentLevel);
      return {
        modeled: directSellGold != null,
        family: 'UPGRADE',
        action: choice.action || 'SELL',
        currentLevel,
        targetLevel: choice.targetLevel == null ? currentLevel : choice.targetLevel,
        expectedGold: finite(choice.expectedGold, directSellGold),
        directSellGold,
        expectedGain: finite(choice.expectedGold, directSellGold) - finite(directSellGold, 0),
        nextChance: choice.chance == null ? null : choice.chance,
        scroll: choice.scroll || null,
        scrollCost: finite(choice.scrollCost, 0)
      };
    }

    _compoundEconomics(item, meta, sameCount) {
      const G = this._gameData();
      const currentLevel = levelOf(item);
      const directOne = npcSellValue(G, item.name, currentLevel, 1);
      const maxLevel = Math.max(currentLevel, Math.min(12, this.config.economicCompoundMaxLevel));
      if (currentLevel >= maxLevel || directOne == null) {
        return { modeled: directOne != null, family: 'COMPOUND', action: 'SELL', currentLevel, targetLevel: currentLevel, directSellGold: directOne, expectedGold: directOne, expectedGain: 0, sameCount };
      }
      const nextLevel = currentLevel + 1;
      const chance = progressionProbability(G, meta, nextLevel, true);
      const scroll = this._scrollCost(meta, currentLevel, true);
      const nextSell = npcSellValue(G, item.name, nextLevel, 1);
      if (chance == null || scroll.cost == null || nextSell == null) {
        return { modeled: false, family: 'COMPOUND', action: 'KEEP', currentLevel, targetLevel: currentLevel, directSellGold: directOne, expectedGold: directOne, expectedGain: 0, sameCount };
      }
      const directSet = directOne * 3;
      const expected = chance * nextSell - scroll.cost;
      const profitable = expected > directSet;
      return {
        modeled: true,
        family: 'COMPOUND',
        action: profitable ? (sameCount >= 3 ? 'COMPOUND' : 'ACCUMULATE') : 'SELL',
        currentLevel,
        targetLevel: profitable ? nextLevel : currentLevel,
        expectedGold: profitable ? expected : directSet,
        directSellGold: directSet,
        expectedGain: expected - directSet,
        nextChance: chance,
        scroll: scroll.name,
        scrollCost: scroll.cost,
        sameCount
      };
    }

    _economicDecision(item, meta, sameCount) {
      if (meta && meta.compound) return this._compoundEconomics(item, meta, sameCount);
      if (meta && meta.upgrade) return this._upgradeEconomics(item, meta);
      const directSellGold = npcSellValue(this._gameData(), item, levelOf(item), 1);
      return {
        modeled: directSellGold != null,
        family: 'NONE',
        action: 'SELL',
        currentLevel: levelOf(item),
        targetLevel: levelOf(item),
        expectedGold: directSellGold,
        directSellGold,
        expectedGain: 0
      };
    }

    _hardProtection(item, meta) {
      if (!item || !item.name) return 'ITEM_INVALID';
      if (item.locked === true) return 'ITEM_LOCKED';
      if (item.giveaway === true) return 'ITEM_GIVEAWAY';
      if (item.gift === true) return 'ITEM_GIFT';
      if (item.expiresAt) return 'ITEM_EXPIRING';
      if (!meta) return 'ITEM_DEFINITION_UNKNOWN';
      if (meta.quest === true || String(meta.type || '').toLowerCase() === 'quest') return 'QUEST_ITEM';
      if (meta.event === true
          || meta.cash === true || finite(meta.cash, 0) > 0
          || meta.cash_item === true
          || meta.soulbound === true || meta.soul_bound === true
          || meta.exchange === true || meta.e != null) {
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
        const action = needsMutation && family === 'COMPOUND' && sameCount < 3
          ? 'ACCUMULATE'
          : needsMutation ? family : 'GEAR';
        return {
          checked: true,
          protected: true,
          sellSafe: false,
          reason: protection.targetLevel > levelOf(item) ? 'FUTURE_GEAR_UPGRADE_POTENTIAL' : 'CURRENT_GEAR_UPGRADE_POTENTIAL',
          action,
          item: item.name,
          observedLevel: levelOf(item),
          sameCount,
          futureGear: clone(protection),
          economic: null,
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
          peerFresh: row.peerFresh === true
        })),
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
        economicsModel: 'NPC_SELL_EXPECTED_VALUE_V1',
        config: clone(this.config),
        lastPlan: clone(this.lastPlan),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.FutureGearEconomyEvaluator = FutureGearEconomyEvaluator;
  ns.FUTURE_GEAR_CLASS_WEIGHTS = CLASS_WEIGHTS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
