(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.gearPlanning) throw new Error('ALBOT_GEAR_PLANNING_MISSING');
  const { scoreItem, scoreImprovement, candidateSlots } = ns.gearPlanning;

  // Ported from Riflex91-Repo/v3/src/merchant/merchant-production-planner.js
  // at 43bcdee99ab12a92f7cbf8e7bcdac8f0e99983f2. Plans only; no action authority.
  function usableItem(item) {
    return !!item && !!item.name && !item.locked && !item.l && !item.special && !item.p
      && !item.property && !item.giveaway && !item.gift && !item.expiresAt && !item.expires
      && !item.statType && !item.stat_type && !item.soulbound && item.protected !== true;
  }
  function slotCompatible(meta, character, slot, G) {
    const rules = G.classes && G.classes[character.ctype];
    const type = String(meta.type || '');
    if (slot !== 'mainhand' && slot !== 'offhand') return true;
    if (!rules) return false;
    const wtype = String(meta.wtype || type);
    if (slot === 'mainhand') return !!(rules.mainhand && Object.hasOwn(rules.mainhand, wtype)
      || rules.doublehand && Object.hasOwn(rules.doublehand, wtype) && !character.gear.offhand);
    const main = character.gear && character.gear.mainhand;
    const mainType = main && G.items && G.items[main.name] && G.items[main.name].wtype;
    if (mainType && rules.doublehand && Object.hasOwn(rules.doublehand, mainType)) return false;
    return !!(rules.offhand && Object.hasOwn(rules.offhand, wtype));
  }
  function questDestination(G, quest) {
    const direct = G.quests && G.quests[quest];
    if (direct && direct.map && Number.isFinite(direct.x) && Number.isFinite(direct.y)) return clone(direct);
    for (const [mapName, map] of Object.entries(G.maps || {})) {
      for (const row of map.npcs || []) {
        const id = Array.isArray(row) ? row[0] : row.id || row.name;
        if (!id || !G.npcs || !G.npcs[id] || G.npcs[id].quest !== quest) continue;
        const pos = Array.isArray(row) ? [row[1], row[2]] : row.position || [row.x, row.y];
        if (Number.isFinite(pos[0]) && Number.isFinite(pos[1])) return { quest, npc: id, map: mapName, x: pos[0], y: pos[1] };
      }
    }
    return null;
  }
  function eventEntryActive(state, key, now) {
    const row = state && state[key];
    if (!row || row.active === false || row.live === false) return false;
    const end = row && typeof row === 'object' && (row.end || row.endsAt || row.expiresAt);
    if (end) {
      const numeric = Number(end);
      const time = Number.isFinite(numeric) ? numeric < 100000000000 ? numeric * 1000 : numeric : Date.parse(end);
      if (!Number.isFinite(time) || time <= now) return false;
    }
    return row === true || row === 1 || typeof row === 'object';
  }

const MERCHANT_PRODUCTION_PLANNER_MODE = 'v3-production-planner-alfinal-v1';

const ProductionStepKind = Object.freeze({
  BANK_RETRIEVE: 'BANK_RETRIEVE',
  BANK_STORE: 'BANK_STORE',
  BUY: 'BUY',
  CRAFT: 'CRAFT',
  EXCHANGE: 'EXCHANGE',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
  COMPOUND_REQUIRED: 'COMPOUND_REQUIRED',
  FARM_REQUIRED: 'FARM_REQUIRED'
});

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function levelOf(item) {
  return Math.max(0, Math.floor(finite(item && item.level, 0)));
}

function itemKey(name, level = 0) {
  return `${String(name || '')}|${Math.max(0, Math.floor(finite(level, 0)))}`;
}

function itemQuantity(items, name, level = 0) {
  const wanted = itemKey(name, level);
  let total = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || itemKey(item.name, item.level) !== wanted) continue;
    total += Math.max(1, Math.floor(finite(item.q, 1)));
  }
  return total;
}

function gradeForLevel(meta, level) {
  const grades = Array.isArray(meta && meta.grades) ? meta.grades : [9, 10, 11, 12];
  const current = Math.max(0, Math.floor(finite(level, 0)));
  for (let index = Math.min(3, grades.length - 1); index >= 0; index -= 1) {
    const threshold = Number(grades[index]);
    if (Number.isFinite(threshold) && current >= threshold) return index + 1;
  }
  return 0;
}

function mutationDescriptor(gameData, name, targetLevel) {
  const level = Math.max(0, Math.floor(finite(targetLevel, 0)));
  if (level <= 0) return null;
  const meta = gameData && gameData.items && gameData.items[name];
  if (!meta || typeof meta !== 'object') return null;
  const family = meta.compound ? 'COMPOUND' : meta.upgrade ? 'UPGRADE' : null;
  if (!family) return null;
  const fromLevel = level - 1;
  const grade = gradeForLevel(meta, fromLevel);
  if (grade >= 4) return null;
  const scrollName = `${family === 'COMPOUND' ? 'cscroll' : 'scroll'}${grade}`;
  const scrollMeta = gameData && gameData.items && gameData.items[scrollName];
  const scrollUnitCost = Math.max(0, Math.floor(finite(scrollMeta && (scrollMeta.g != null ? scrollMeta.g : scrollMeta.gold), 0)));
  return {
    family,
    fromLevel,
    targetLevel: level,
    inputMultiplier: family === 'COMPOUND' ? 3 : 1,
    scrollName,
    scrollUnitCost
  };
}

function recipeFor(gameData, name) {
  const raw = gameData && gameData.craft && gameData.craft[name];
  if (!raw || !Array.isArray(raw.items) || !raw.items.length) return null;
  const items = [];
  for (const row of raw.items) {
    if (!Array.isArray(row) || !row[1]) return null;
    items.push({
      quantity: Math.max(1, Math.floor(finite(row[0], 1))),
      name: String(row[1]),
      level: Math.max(0, Math.floor(finite(row[2], 0)))
    });
  }
  return {
    output: String(name),
    outputQuantity: Math.max(1, Math.floor(finite(raw.q, finite(raw.quantity, 1)))),
    cost: Math.max(0, Math.floor(finite(raw.cost != null ? raw.cost : raw.gold, 0))),
    quest: raw.quest == null ? null : String(raw.quest),
    specialOutput: raw.output && typeof raw.output === 'object' ? clone(raw.output) : null,
    items
  };
}

function compatible(meta, character) {
  if (!meta || !character) return false;
  const classes = Array.isArray(meta.class) ? meta.class : meta.class ? [meta.class] : [];
  if (classes.length && !classes.map((x) => String(x).toLowerCase()).includes(String(character.ctype || '').toLowerCase())) return false;
  const required = Math.max(0, finite(meta.level, 0));
  return required <= Math.max(0, finite(character.level, 0));
}

function currentItem(character, slot, gameData) {
  const equipped = character && character.gear && character.gear[slot];
  if (!equipped || !equipped.name) return { name: null, level: 0, score: { total: 0, survival: 0 } };
  const meta = gameData && gameData.items && gameData.items[equipped.name];
  return {
    name: String(equipped.name),
    level: levelOf(equipped),
    score: scoreItem(meta, levelOf(equipped), character.ctype, character)
  };
}

function registryCharacters(registry) {
  const status = registry && typeof registry.status === 'function' ? registry.status() : registry;
  return Array.isArray(status && status.characters) ? status.characters.filter((row) => row && row.name && row.ctype) : [];
}

function bankRows(bank) {
  const rows = [];
  if (!bank || typeof bank !== 'object') return rows;
  for (const [pack, items] of Object.entries(bank)) {
    if (!/^items\d+$/.test(String(pack)) || !Array.isArray(items)) continue;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!usableItem(item)) continue;
      rows.push({
        ...clone(item),
        pack: String(pack),
        index,
        name: String(item.name),
        level: levelOf(item),
        quantity: Math.max(1, Math.floor(finite(item.q, 1)))
      });
    }
  }
  return rows;
}

function vendorItemName(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] == null ? null : String(value[0]);
  if (value && typeof value === 'object') return value.name == null ? null : String(value.name);
  return null;
}

function vendorIndex(gameData) {
  const out = new Map();
  const npcDefs = gameData && gameData.npcs || {};
  const maps = gameData && gameData.maps || {};
  for (const [mapName, map] of Object.entries(maps)) {
    for (const row of Array.isArray(map && map.npcs) ? map.npcs : []) {
      const npcId = Array.isArray(row) ? row[0] : row && (row.id || row.name);
      if (!npcId) continue;
      const def = npcDefs[npcId] || {};
      const stock = [].concat(def.items || def.sells || []);
      let x = null; let y = null;
      if (Array.isArray(row)) {
        x = finite(row[1]); y = finite(row[2]);
      } else if (row && typeof row === 'object') {
        const pos = Array.isArray(row.position) ? row.position : null;
        x = finite(row.x, pos ? finite(pos[0]) : null);
        y = finite(row.y, pos ? finite(pos[1]) : null);
      }
      for (const value of stock) {
        const name = vendorItemName(value);
        if (!name) continue;
        if (!out.has(name)) out.set(name, []);
        out.get(name).push({ npc: String(npcId), map: String(mapName), x, y });
      }
    }
  }
  return out;
}

class MerchantProductionPlanner {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.log = options.log || null;
    this.maxDepth = Math.max(1, Math.min(12, Math.floor(finite(options.maxDepth, 7))));
    this.minImprovementRatio = Math.max(0, Math.min(1, finite(options.minImprovementRatio, 0.04)));
    this.goldReserve = Math.max(0, Math.floor(finite(options.goldReserve, 1000000)));
    this.maxBuyQuantity = Math.max(1, Math.min(10000, Math.floor(finite(options.maxBuyQuantity, 1000))));
    this.candidateScanLimit = Math.max(16, Math.min(128, Math.floor(finite(options.candidateScanLimit, 64))));
    this.explicitTargets = Array.isArray(options.targets) ? options.targets.filter(Boolean).map(String) : [];
    this.slotCompatible = options.slotCompatible || slotCompatible;
    this.maxSteps = Math.max(1, Math.min(1024, Math.floor(finite(options.maxSteps, 256))));
    this.maxQuantity = Math.max(1, Math.min(10000, Math.floor(finite(options.maxQuantity, 1000))));
    this.maxPlanningWork = Math.max(100, Math.min(100000, Math.floor(finite(options.maxPlanningWork, 10000))));
    this.maxGoldCost = Math.max(0, finite(options.maxGoldCost, 250000));
    this.sequence = 0;
    this.lastPlan = null;
    this.stats = { plans: 0, ready: 0, blocked: 0, holds: 0, candidates: 0, cyclesRejected: 0, depthRejected: 0 };
  }

  _event(event, severity = 'info', reason = null, data = {}) {
    if (this.log && typeof this.log.emit === 'function') this.log.emit({ component: 'merchant-production-planner', event, severity, reason, data });
  }

  _id() {
    this.sequence += 1;
    return `production-${this.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  _hold(reason, data = {}) {
    const plan = { schemaVersion: 1, id: this._id(), at: this.now(), state: 'HOLD', reason, actionAuthority: false, liveExecutionAllowed: false, steps: [], reservations: {}, ...clone(data) };
    this.lastPlan = plan;
    this.stats.plans += 1;
    this.stats.holds += 1;
    return clone(plan);
  }

  _candidateOutputs(gameData, registry) {
    const characters = registryCharacters(registry);
    const craft = gameData && gameData.craft || {};
    const candidates = [];
    const targetRank = new Map(this.explicitTargets.map((name, index) => [name, index]));
    for (const output of Object.keys(craft)) {
      if (this.explicitTargets.length && !targetRank.has(output)) continue;
      const recipe = recipeFor(gameData, output);
      const meta = gameData && gameData.items && gameData.items[output];
      if (!recipe || !meta) continue;
      const slots = candidateSlots(meta);
      if (!slots.length) continue;
      for (const character of characters) {
        if (!compatible(meta, character) || character.equipmentKnown === false || !character.gear || !Object.values(character.gear).some(row => row && row.name)) continue;
        const target = scoreItem(meta, 0, character.ctype, character);
        let best = null;
        for (const slot of slots) {
          if (this.slotCompatible(meta, character, slot, gameData) !== true) continue;
          const current = currentItem(character, slot, gameData);
          const delta = scoreImprovement(current.score, target, this.minImprovementRatio, character);
          if (!delta.meaningful) continue;
          const row = {
            slot,
            current,
            improvement: delta.improvement,
            survivalImprovement: delta.survivalImprovement,
            speedImprovement: delta.speedImprovement,
            improvementReason: delta.reason
          };
          const merchantTarget = String(character.ctype || '').toLowerCase() === 'merchant';
          const better = !best
            || (merchantTarget
              ? (row.speedImprovement > best.speedImprovement
                || (row.speedImprovement === best.speedImprovement && row.improvement > best.improvement)
                || (row.speedImprovement === best.speedImprovement && row.improvement === best.improvement && row.survivalImprovement > best.survivalImprovement))
              : (row.improvement > best.improvement
                || (row.improvement === best.improvement && row.survivalImprovement > best.survivalImprovement)));
          if (better) best = row;
        }
        if (!best) continue;
        candidates.push({
          output,
          recipe,
          recipient: String(character.name),
          ctype: String(character.ctype),
          slot: best.slot,
          currentItem: best.current.name,
          currentLevel: best.current.level,
          improvement: best.improvement,
          survivalImprovement: best.survivalImprovement,
          speedImprovement: best.speedImprovement,
          improvementReason: best.improvementReason,
          targetRank: targetRank.has(output) ? targetRank.get(output) : Infinity
        });
      }
    }
    candidates.sort((a, b) => {
      if (a.targetRank !== b.targetRank) return a.targetRank - b.targetRank;
      const aMerchant = String(a.ctype || '').toLowerCase() === 'merchant';
      const bMerchant = String(b.ctype || '').toLowerCase() === 'merchant';
      if (aMerchant && bMerchant && finite(a.speedImprovement, 0) !== finite(b.speedImprovement, 0)) {
        return finite(b.speedImprovement, 0) - finite(a.speedImprovement, 0);
      }
      if ((a.survivalImprovement > 0) !== (b.survivalImprovement > 0)) return a.survivalImprovement > 0 ? -1 : 1;
      return b.improvement - a.improvement || b.survivalImprovement - a.survivalImprovement || a.output.localeCompare(b.output) || a.recipient.localeCompare(b.recipient);
    });
    this.stats.candidates += candidates.length;
    return candidates;
  }

  _buildCandidate(candidate, input) {
    try { return this._buildCandidateBounded(candidate, input); }
    catch (error) {
      if (!error || error.message !== 'PRODUCTION_PLANNING_LIMIT') throw error;
      return { ready: false, candidate: clone(candidate), steps: [], executableSteps: [], reservations: {},
        blockers: [{ reason: 'PRODUCTION_PLANNING_LIMIT' }], totalGold: 0, goldReserve: this.goldReserve };
    }
  }

  _buildCandidateBounded(candidate, input) {
    const character = input.character || {};
    const gameData = input.gameData || {};
    const inventory = (Array.isArray(character.items) ? character.items : []).filter(usableItem);
    const bank = bankRows(character.bank);
    const vendors = vendorIndex(gameData);
    const localPool = new Map();
    const reservations = {};
    const steps = [];
    let work = 0;
    const consumeWork = quantity => {
      if (++work > this.maxPlanningWork || quantity > this.maxQuantity) throw new Error('PRODUCTION_PLANNING_LIMIT');
    };
    const addStep = step => {
      if (steps.length >= this.maxSteps) throw new Error('PRODUCTION_PLANNING_LIMIT');
      steps.push(step);
    };
    const blockers = [];
    let totalGold = 0;
    const catalogRows = !character.bank && input.bankCatalog && input.bankCatalog.usable === true && input.bankCatalog.snapshot && Array.isArray(input.bankCatalog.snapshot.rows)
      ? input.bankCatalog.snapshot.rows
      : [];
    if (!bank.length && catalogRows.length) {
      for (const row of catalogRows) bank.push({ ...clone(row) });
    }
    const bankPool = bank.filter(usableItem).map((row) => ({ ...row, remaining: row.quantity }));

    const estimateSource = (name, level, quantity, depth = 0, path = new Set()) => {
      const requested = Math.max(1, Math.floor(finite(quantity, 1)));
      consumeWork(requested);
      const key = itemKey(name, level);
      const owned = (localPool.get(key) || 0) + bankPool.reduce((sum, row) =>
        itemKey(row.name, row.level) === key && row.remaining === row.quantity ? sum + row.remaining : sum, 0);
      const need = Math.max(0, requested - owned);
      if (!need) return { cost: 0, strategy: 'OWNED' };
      if (depth > this.maxDepth || path.has(key)) return { cost: Infinity, strategy: 'UNAVAILABLE' };
      const itemMeta = gameData.items && gameData.items[name] || {};
      if (level > 0) {
        const mutation = mutationDescriptor(gameData, name, level);
        if (!mutation) return { cost: Infinity, strategy: 'UNAVAILABLE' };
        const nextPath = new Set(path); nextPath.add(key);
        const inputQuantity = need * mutation.inputMultiplier;
        const lower = estimateSource(name, mutation.fromLevel, inputQuantity, depth + 1, nextPath);
        if (!Number.isFinite(lower.cost)) return { cost: Infinity, strategy: 'UNAVAILABLE' };
        return {
          cost: lower.cost + mutation.scrollUnitCost * need,
          strategy: mutation.family,
          mutation,
          inputQuantity,
          lower
        };
      }
      const unitCost = Math.max(0, Math.floor(finite(itemMeta.g, 0)));
      const vendor = (vendors.get(name) || [])[0] || null;
      const vendorCost = vendor && unitCost > 0 && need <= this.maxBuyQuantity ? unitCost * need : Infinity;
      const recipe = recipeFor(gameData, name);
      let craftCost = Infinity;
      if (recipe) {
        const nextPath = new Set(path); nextPath.add(key);
        const operations = Math.max(1, Math.ceil(need / recipe.outputQuantity));
        let materialsCost = 0;
        let possible = true;
        for (const req of recipe.items) {
          const quote = estimateSource(req.name, req.level, req.quantity * operations, depth + 1, nextPath);
          if (!Number.isFinite(quote.cost)) { possible = false; break; }
          materialsCost += quote.cost;
        }
        if (possible) craftCost = materialsCost + recipe.cost * operations;
      }
      if (craftCost < vendorCost) return { cost: craftCost, strategy: 'CRAFT', recipe };
      if (Number.isFinite(vendorCost)) return { cost: vendorCost, strategy: 'BUY', vendor, unitCost };
      if (Number.isFinite(craftCost)) return { cost: craftCost, strategy: 'CRAFT', recipe };
      // Unknown leaf sources still need a recursively expanded acquisition graph.
      // Do not mislabel a craft-only intermediate as directly farmable.
      if (recipe) return { cost: Infinity, strategy: 'CRAFT', recipe };
      return { cost: Infinity, strategy: 'UNAVAILABLE' };
    };

    for (const item of inventory) {
      if (!usableItem(item)) continue;
      const key = itemKey(item.name, item.level);
      localPool.set(key, (localPool.get(key) || 0) + Math.max(1, Math.floor(finite(item.q, 1))));
    }

    // External reservations consume a shared quantity budget before planning.
    for (const [key, amount] of Object.entries(input.reservations || {})) {
      let reserved = Math.max(0, Math.floor(finite(amount, 0)));
      const local = localPool.get(key) || 0;
      const taken = Math.min(local, reserved);
      localPool.set(key, local - taken);
      reserved -= taken;
      for (const row of bankPool) {
        if (itemKey(row.name, row.level) !== key) continue;
        const bankTaken = Math.min(row.remaining, reserved);
        row.remaining -= bankTaken;
        reserved -= bankTaken;
      }
    }

    const reserveLocal = (name, level, quantity) => {
      const key = itemKey(name, level);
      const have = Math.max(0, localPool.get(key) || 0);
      const take = Math.min(have, Math.max(0, quantity));
      if (take > 0) {
        localPool.set(key, have - take);
        reservations[key] = (reservations[key] || 0) + take;
      }
      return take;
    };

    const takeBank = (name, level, quantity) => {
      let need = Math.max(0, quantity);
      let supplied = 0;
      for (const row of bankPool) {
        if (need <= 0) break;
        if (row.name !== name || row.level !== level || row.remaining <= 0) continue;
        // ALFinal withdraws whole physical stacks. A partially reserved stack
        // cannot be proposed as freely withdrawable.
        if (row.remaining !== row.quantity) continue;
        const stackQuantity = row.remaining;
        row.remaining = 0;
        supplied += stackQuantity;
        need = Math.max(0, need - stackQuantity);
        addStep({ kind: ProductionStepKind.BANK_RETRIEVE, name, level, quantity: stackQuantity, pack: row.pack, bankIndex: row.index, reason: 'MATERIAL_IN_BANK' });
      }
      return supplied;
    };

    const acquire = (name, level, quantity, depth, path) => {
      let need = Math.max(0, Math.floor(finite(quantity, 0)));
      consumeWork(need);
      if (!need) return true;
      const key = itemKey(name, level);
      if (depth > this.maxDepth) {
        this.stats.depthRejected += 1;
        blockers.push({ reason: 'MAX_RECIPE_DEPTH', name, level, quantity: need, depth });
        return false;
      }
      if (path.has(key)) {
        this.stats.cyclesRejected += 1;
        blockers.push({ reason: 'RECIPE_CYCLE', name, level, quantity: need });
        return false;
      }

      need -= reserveLocal(name, level, need);
      if (need <= 0) return true;

      const bankSupplied = takeBank(name, level, need);
      if (bankSupplied > 0) {
        const surplus = Math.max(0, bankSupplied - need);
        if (surplus) localPool.set(key, (localPool.get(key) || 0) + surplus);
        reservations[key] = (reservations[key] || 0) + Math.min(need, bankSupplied);
        need = Math.max(0, need - bankSupplied);
      }
      if (need <= 0) return true;

      if (level > 0) {
        const mutation = mutationDescriptor(gameData, name, level);
        if (!mutation) {
          blockers.push({ reason: 'LEVELED_MATERIAL_MUTATION_UNSUPPORTED', name, level, quantity: need });
          return false;
        }
        const nextPath = new Set(path); nextPath.add(key);
        const beforeSteps = steps.length;
        const inputQuantity = need * mutation.inputMultiplier;
        if (!acquire(name, mutation.fromLevel, inputQuantity, depth + 1, nextPath)) return false;

        // If lower-level acquisition scheduled BANK/BUY/CRAFT work, execute and
        // replan before reserving a mutation. That keeps mutations bound to
        // inputs that are actually present in the live Merchant inventory.
        if (steps.length > beforeSteps) return true;

        const stepKind = mutation.family === 'COMPOUND'
          ? ProductionStepKind.COMPOUND_REQUIRED
          : ProductionStepKind.UPGRADE_REQUIRED;
        addStep({
          kind: stepKind,
          name,
          level,
          fromLevel: mutation.fromLevel,
          targetLevel: mutation.targetLevel,
          quantity: need,
          inputQuantity,
          inputMultiplier: mutation.inputMultiplier,
          scrollName: mutation.scrollName,
          estimatedScrollUnitCost: mutation.scrollUnitCost,
          reason: 'LEVELED_RECIPE_MATERIAL_MUTATION_REQUIRED'
        });
        blockers.push({
          reason: 'MATERIAL_MUTATION_REQUIRED',
          mutation: mutation.family,
          name,
          level,
          fromLevel: mutation.fromLevel,
          targetLevel: mutation.targetLevel,
          quantity: need,
          inputQuantity,
          scrollName: mutation.scrollName
        });
        return false;
      }

      if (level === 0) {
        const quote = estimateSource(name, level, need, depth, path);
        if (quote.strategy === 'BUY') {
          addStep({ kind: ProductionStepKind.BUY, name, level: 0, quantity: need, unitCost: quote.unitCost, vendor: quote.vendor, estimatedPathCost: quote.cost, reason: 'LEAST_GOLD_VENDOR_SOURCE' });
          totalGold += quote.unitCost * need;
          reservations[key] = (reservations[key] || 0) + need;
          return true;
        }

        if (quote.strategy === 'CRAFT' && quote.recipe) {
          const recipe = quote.recipe;
          if ((recipe.quest || (gameData.items[name] || {}).event) && input.allowQuestEvent !== true) {
            blockers.push({ reason: 'QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN', name });
            return false;
          }
          const nextPath = new Set(path); nextPath.add(key);
          const operations = Math.max(1, Math.ceil(need / recipe.outputQuantity));
          let supplied = true;
          for (const req of recipe.items) {
            if (!acquire(req.name, req.level, req.quantity * operations, depth + 1, nextPath)) supplied = false;
          }
          if (!supplied) return false;
          for (let i = 0; i < operations; i += 1) {
            addStep({ kind: ProductionStepKind.CRAFT, name, level: 0, quantity: recipe.outputQuantity, cost: recipe.cost, recipe: clone(recipe), estimatedPathCost: quote.cost, reason: 'LEAST_GOLD_RECIPE_SOURCE' });
            totalGold += recipe.cost;
          }
          const surplus = operations * recipe.outputQuantity - need;
          if (surplus > 0) localPool.set(key, (localPool.get(key) || 0) + surplus);
          reservations[key] = (reservations[key] || 0) + need;
          return true;
        }
      }

      addStep({ kind: ProductionStepKind.FARM_REQUIRED, name, level, quantity: need, reason: level > 0 ? 'LEVELED_MATERIAL_UNAVAILABLE' : 'NO_BANK_VENDOR_OR_RECIPE_SOURCE' });
      blockers.push({ reason: 'MATERIAL_FARM_REQUIRED', name, level, quantity: need });
      return false;
    };

    const rootRuns = Math.max(1, Math.ceil(finite(candidate.quantity, 1) / candidate.recipe.outputQuantity));
    if ((candidate.recipe.quest || (gameData.items[candidate.output] || {}).event) && input.allowQuestEvent !== true) {
      blockers.push({ reason: 'QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN', name: candidate.output });
    }
    consumeWork(rootRuns * candidate.recipe.outputQuantity);
    const rootPath = new Set([itemKey(candidate.output, 0)]);
    for (const req of candidate.recipe.items) acquire(req.name, req.level, req.quantity * rootRuns, 1, rootPath);
    for (let run = 0; run < rootRuns; run += 1) {
      addStep({ kind: ProductionStepKind.CRAFT, name: candidate.output, level: 0, quantity: candidate.recipe.outputQuantity, cost: candidate.recipe.cost, recipe: clone(candidate.recipe), root: true, recipient: candidate.recipient, slot: candidate.slot, reason: 'ROOT_PRODUCTION_TARGET' });
    }
    totalGold += candidate.recipe.cost * rootRuns;

    if (totalGold > this.maxGoldCost) blockers.push({ reason: 'PRODUCTION_GOLD_COST_OVER_BUDGET', totalGold, maxGoldCost: this.maxGoldCost });
    const availableGold = Math.max(0, Math.floor(finite(character.gold, 0)));
    if (availableGold - totalGold < this.goldReserve) blockers.push({ reason: 'GOLD_RESERVE_WOULD_BE_BREACHED', availableGold, totalGold, goldReserve: this.goldReserve });
    const executableSteps = steps.filter((step) => ![
      ProductionStepKind.FARM_REQUIRED,
      ProductionStepKind.UPGRADE_REQUIRED,
      ProductionStepKind.COMPOUND_REQUIRED
    ].includes(step.kind));
    const ready = blockers.length === 0;
    return {
      ready,
      candidate: clone(candidate),
      steps,
      executableSteps,
      reservations,
      blockers,
      totalGold,
      availableGold,
      goldReserve: this.goldReserve,
      bankSource: character.bank ? 'LIVE_BANK' : catalogRows.length ? 'PERSISTED_BANK_CATALOG' : 'UNAVAILABLE',
      costStrategy: 'LEAST_GOLD_SOURCE_GRAPH_V3'
    };
  }

  planTarget(itemName, quantity = 1, input = {}) {
    const character = input.character || {};
    if (String(character.ctype || '').toLowerCase() !== 'merchant') return this._hold('MERCHANT_REQUIRED');
    if (character.rip || character.dead) return this._hold('MERCHANT_DEAD');
    if (input.inCombat || input.controlledBusy || input.economyEmergency) return this._hold('CONTROLLED_SUBSYSTEM_BUSY');
    const count = Number(quantity);
    if (!Number.isSafeInteger(count) || count < 1 || count > this.maxQuantity) return this._hold('PRODUCTION_QUANTITY_INVALID');
    if (!input.gameData || !input.gameData.items || !input.gameData.craft) return this._hold('CRAFT_DATA_UNAVAILABLE');
    const recipe = recipeFor(input.gameData || {}, itemName);
    if (!recipe) return this._hold('CRAFT_RECIPE_UNAVAILABLE');
    const built = this._buildCandidate({ output: String(itemName), quantity: count, recipe,
      recipient: input.recipient || null, slot: input.slot || null }, input);
    // A structural blocker must never leave a runnable partial graph.
    const fatal = built.blockers.some(row => !['MATERIAL_FARM_REQUIRED', 'MATERIAL_MUTATION_REQUIRED'].includes(row.reason));
    const prerequisite = built.steps.find(step => !step.root) || null;
    const nextStep = fatal || prerequisite && prerequisite.kind === ProductionStepKind.FARM_REQUIRED ? null : prerequisite;
    const plan = { schemaVersion: 1, id: this._id(), at: this.now(),
      state: built.ready ? 'READY' : 'BLOCKED', reason: built.ready ? 'PRODUCTION_CHAIN_READY' : 'PRODUCTION_NEEDS_ACQUISITION',
      actionAuthority: false, liveExecutionAllowed: false, target: built.candidate, steps: built.steps,
      nextStep: built.ready ? built.executableSteps[0] || null : nextStep,
      reservations: built.reservations, blockers: built.blockers, totalGold: built.totalGold,
      goldReserve: built.goldReserve, bankSource: built.bankSource || 'UNAVAILABLE', costStrategy: built.costStrategy || null };
    this.lastPlan = clone(plan);
    this.stats.plans += 1;
    this.stats[built.ready ? 'ready' : 'blocked'] += 1;
    return clone(plan);
  }

  planExchange(input = {}, protectedReservations = {}) {
    const character = input.character || {};
    if (String(character.ctype || character.type || '').toLowerCase() !== 'merchant') return null;
    const gameData = input.gameData || {};
    const inventory = Array.isArray(character.items) ? character.items : [];
    const bank = bankRows(character.bank);
    const catalogRows = !character.bank && input.bankCatalog && input.bankCatalog.usable === true && input.bankCatalog.snapshot && Array.isArray(input.bankCatalog.snapshot.rows)
      ? input.bankCatalog.snapshot.rows
      : [];
    const bankPool = (bank.length ? bank : catalogRows).filter(usableItem);
    const lockedExchangeItem = input.productionTaskTarget && input.productionTaskTarget.exchangeItem ? String(input.productionTaskTarget.exchangeItem) : null;
    const rawExplicitDemands = (Array.isArray(input.exchangeDemands) ? input.exchangeDemands : [])
      .filter((row) => row && row.item && (!row.expiresAt || row.expiresAt > this.now()));
    const explicitDemands = rawExplicitDemands
      .filter((row) => !row.eventKey || eventEntryActive(input.eventState || {}, row.eventKey, this.now()));
    const demandByItem = new Map(explicitDemands.map((row) => [String(row.item), row]));
    const reservedExplicitExchangeItems = new Set(rawExplicitDemands
      .filter((row) => String(row.reason || '') === 'PRODUCTION_MATERIAL' || row.eventKey)
      .map((row) => String(row.item)));

    // Anything that Adventure Land itself marks with a positive exchange
    // requirement (G.items[name].e) is legitimate autonomous cleanup work once
    // a complete exchange unit exists. Production reservations remain protected.
    const exchangeableNames = new Set();
    for (const item of inventory) if (item && item.name && levelOf(item) === 0) exchangeableNames.add(String(item.name));
    for (const row of bankPool) if (row && row.name && row.level === 0) exchangeableNames.add(String(row.name));
    for (const name of exchangeableNames) {
      if (demandByItem.has(name) || reservedExplicitExchangeItems.has(name)) continue;
      const meta = gameData.items && gameData.items[name];
      const required = Math.max(0, Math.floor(finite(meta && meta.e, 0)));
      if (!meta || required <= 0) continue;
      const reserved = Math.max(0, Math.floor(finite(protectedReservations[itemKey(name, 0)], 0)));
      const local = itemQuantity(inventory, name, 0);
      const bankAvailable = bankPool.reduce((sum, row) => sum + (row && row.name === name && row.level === 0 ? Math.max(0, Math.floor(finite(row.quantity, 0))) : 0), 0);
      if (Math.max(0, local + bankAvailable - reserved) < required) continue;
      demandByItem.set(name, {
        item: name,
        target: null,
        reason: 'AUTONOMOUS_EXCHANGEABLE_SURPLUS',
        autonomous: true,
        required,
        discoveredAt: this.now()
      });
    }

    if (lockedExchangeItem) {
      for (const name of [...demandByItem.keys()]) if (String(name) !== lockedExchangeItem) demandByItem.delete(name);
    }
    if (!demandByItem.size) return null;
    const candidates = [];

    for (let index = 0; index < inventory.length; index += 1) {
      const item = inventory[index];
      if (!usableItem(item) || levelOf(item) !== 0) continue;
      const meta = gameData.items && gameData.items[item.name];
      const demand = demandByItem.get(String(item.name));
      const required = Math.max(0, Math.floor(finite(meta && meta.e, 0)));
      if (!demand || !meta || required <= 0) continue;
      if (input.contentDrift && typeof input.contentDrift.requiresRevalidation === 'function') {
        try { if (input.contentDrift.requiresRevalidation('items', item.name)) continue; } catch (_) { continue; }
      }
      const reserved = Math.max(0, Math.floor(finite(protectedReservations[itemKey(item.name, 0)], 0)));
      const local = Math.max(1, Math.floor(finite(item.q, 1)));
      const usable = Math.max(0, local - reserved);
      const productionDemand = !!(demand && String(demand.reason || '') === 'PRODUCTION_MATERIAL');
      const demandedQuest = productionDemand && demand.quest ? String(demand.quest) : null;
      const metaQuest = meta.quest ? String(meta.quest) : null;
      if (productionDemand && demandedQuest && demandedQuest !== metaQuest) continue;
      const quest = demandedQuest || metaQuest;
      const questTarget = quest ? questDestination(gameData, quest) : null;
      if (productionDemand && quest && !questTarget) continue;
      const destination = quest || 'exchange';
      const exchangeReason = demand && demand.eventKey && quest
        ? 'EVENT_QUEST_EXCHANGE_REQUIREMENT_SATISFIED'
        : demand && demand.eventKey
          ? 'EVENT_EXCHANGE_REQUIREMENT_SATISFIED'
          : quest
            ? 'QUEST_EXCHANGE_REQUIREMENT_SATISFIED'
            : 'EXCHANGE_REQUIREMENT_SATISFIED';
      if (usable >= required) {
        candidates.push({
          name: String(item.name), index, required, available: usable,
          operations: Math.floor(usable / required), destination, quest, questDestination: clone(questTarget),
          step: {
            kind: ProductionStepKind.EXCHANGE,
            name: String(item.name),
            level: 0,
            inventoryIndex: index,
            quantity: required,
            destination,
            quest,
            questDestination: clone(questTarget),
            eventKey: demand && demand.eventKey || null,
            reason: exchangeReason
          }
        });
        continue;
      }
      const bankRow = bankPool.find((row) => row && row.name === item.name && row.level === 0 && Number(row.quantity) + usable >= required);
      if (bankRow) {
        candidates.push({
          name: String(item.name), index, required, available: usable, operations: 1, destination,
          step: { kind: ProductionStepKind.BANK_RETRIEVE, name: String(item.name), level: 0, quantity: bankRow.quantity, pack: bankRow.pack, bankIndex: bankRow.index, reason: 'EXCHANGE_MATERIAL_IN_BANK' }
        });
      }
    }

    // Also recover an exchange stack that exists only in the bank.
    for (const row of bankPool) {
      if (!row || row.level !== 0) continue;
      const meta = gameData.items && gameData.items[row.name];
      const demand = demandByItem.get(String(row.name));
      const required = Math.max(0, Math.floor(finite(meta && meta.e, 0)));
      if (!demand || !meta || required <= 0 || row.quantity < required) continue;
      const local = itemQuantity(inventory, row.name, 0);
      const reserved = Math.max(0, Math.floor(finite(protectedReservations[itemKey(row.name, 0)], 0)));
      if (Math.max(0, local - reserved) >= required) continue;
      const productionDemand = !!(demand && String(demand.reason || '') === 'PRODUCTION_MATERIAL');
      const demandedQuest = productionDemand && demand.quest ? String(demand.quest) : null;
      const metaQuest = meta.quest ? String(meta.quest) : null;
      if (productionDemand && demandedQuest && demandedQuest !== metaQuest) continue;
      const quest = demandedQuest || metaQuest;
      const questTarget = quest ? questDestination(gameData, quest) : null;
      if (productionDemand && quest && !questTarget) continue;
      const destination = quest || 'exchange';
      candidates.push({
        name: row.name, required, available: Math.max(0, local - reserved), operations: Math.floor(row.quantity / required), destination,
        quest, questDestination: clone(questTarget),
        step: {
          kind: ProductionStepKind.BANK_RETRIEVE,
          name: row.name,
          level: 0,
          quantity: row.quantity,
          pack: row.pack,
          bankIndex: row.index,
          quest,
          questDestination: clone(questTarget),
          eventKey: demand && demand.eventKey || null,
          reason: quest ? 'QUEST_EXCHANGE_MATERIAL_IN_BANK' : 'EXCHANGE_MATERIAL_IN_BANK'
        }
      });
    }

    candidates.sort((a, b) => b.operations - a.operations || a.required - b.required || a.name.localeCompare(b.name));
    const chosen = candidates[0];
    if (!chosen) return null;
    const plan = {
      schemaVersion: 1,
      id: this._id(),
      at: this.now(),
      state: 'READY',
      reason: 'NPC_EXCHANGE_READY',
      actionAuthority: false,
      liveExecutionAllowed: false,
      target: { item: chosen.name, operations: chosen.operations, required: chosen.required, destination: chosen.destination },
      steps: [chosen.step],
      nextStep: chosen.step,
      reservations: {},
      blockers: [],
      totalGold: 0,
      goldReserve: this.goldReserve,
      costStrategy: 'QUEST_EVENT_EXCHANGE_EXACT_REQUIREMENT_V3',
      exchangeDemand: clone(demandByItem.get(chosen.name) || null)
    };
    return clone(plan);
  }

  planMaterialConsolidation(input = {}) {
    const character = input.character || {};
    if (String(character.ctype || character.type || '').toLowerCase() !== 'merchant') return null;
    if (input.anniversaryActive !== true) return null;
    const gameData = input.gameData || {};
    const recipe = recipeFor(gameData, 'sixcake');
    if (!recipe || String(recipe.quest || '') !== 'anniversary_baker') return null;

    // Six cake is the canonical consolidation for the six Anniversary slices.
    // Build through the normal material graph so ingredients already stored in
    // bank are retrieved in the same production chain.
    const candidate = {
      output: 'sixcake',
      recipe,
      recipient: null,
      slot: null,
      reason: 'ANNIVERSARY_SLICE_CONSOLIDATION'
    };
    const built = this._buildCandidate(candidate, { ...input, allowQuestEvent: true });
    if (!built || !built.ready) return null;

    // Require at least one slice to be actually owned already; do not turn this
    // maintenance path into a speculative vendor/crafting acquisition tree.
    const sliceNames = new Set(['slice_strawberry','slice_citrus','slice_honey','slice_mint','slice_blueberry','slice_nightberry']);
    const inventory = Array.isArray(character.items) ? character.items : [];
    const bank = bankRows(character.bank);
    const catalogRows = !character.bank && input.bankCatalog && input.bankCatalog.usable === true && input.bankCatalog.snapshot && Array.isArray(input.bankCatalog.snapshot.rows)
      ? input.bankCatalog.snapshot.rows
      : [];
    const ownedSlices = [...inventory, ...bank, ...catalogRows].filter((row) => row && sliceNames.has(String(row.name || '')));
    if (!ownedSlices.length) return null;

    // All six ingredients must be supplied by LOCAL/BANK steps. If the graph
    // introduced BUY/recursive CRAFT acquisition, this is not cleanup anymore.
    const disallowed = built.steps.some((step) => step && [ProductionStepKind.BUY, ProductionStepKind.FARM_REQUIRED].includes(step.kind));
    if (disallowed) return null;
    const rootCraft = built.steps[built.steps.length - 1];
    if (!rootCraft || rootCraft.kind !== ProductionStepKind.CRAFT || rootCraft.name !== 'sixcake') return null;

    return {
      schemaVersion: 1,
      id: this._id(),
      at: this.now(),
      state: 'READY',
      reason: 'ANNIVERSARY_SLICE_CONSOLIDATION_READY',
      actionAuthority: false,
      liveExecutionAllowed: false,
      target: {
        output: 'sixcake',
        recipient: null,
        slot: null,
        maintenance: true,
        quest: 'anniversary_baker'
      },
      steps: built.steps,
      nextStep: built.executableSteps[0] || null,
      reservations: built.reservations,
      blockers: [],
      totalGold: built.totalGold,
      goldReserve: built.goldReserve,
      bankSource: built.bankSource,
      costStrategy: 'OWNED_MATERIAL_CONSOLIDATION_V1'
    };
  }

  plan(input = {}) {
    const character = input.character || {};
    if (String(character.ctype || character.type || '').toLowerCase() !== 'merchant') return this._hold('MERCHANT_REQUIRED');
    if (character.rip === true || character.dead === true) return this._hold('MERCHANT_DEAD');
    if (input.inCombat === true) return this._hold('MERCHANT_IN_COMBAT');
    if (input.economyEmergency === true) return this._hold('ECONOMY_EMERGENCY');
    if (input.controlledBusy === true) return this._hold('CONTROLLED_SUBSYSTEM_BUSY');
    const gameData = input.gameData || {};
    if (!gameData.craft || !gameData.items) return this._hold('CRAFT_DATA_UNAVAILABLE');

    let candidates = this._candidateOutputs(gameData, input.registry);
    const lockedOutput = input.productionTaskTarget && input.productionTaskTarget.output ? String(input.productionTaskTarget.output) : null;
    const lockedRecipient = input.productionTaskTarget && input.productionTaskTarget.recipient ? String(input.productionTaskTarget.recipient) : null;
    if (lockedOutput) {
      candidates = candidates.filter((row) => String(row.output || '') === lockedOutput && (!lockedRecipient || String(row.recipient || '') === lockedRecipient));
    }
    if (!candidates.length) return this._hold(lockedOutput ? 'LOCKED_PRODUCTION_TARGET_COMPLETE_OR_UNAVAILABLE' : 'NO_CRAFTED_GEAR_IMPROVEMENT');

    let bestBlocked = null;
    const blockedCandidates = [];
    for (const candidate of candidates.slice(0, this.candidateScanLimit)) {
      if (input.contentDrift && typeof input.contentDrift.requiresRevalidation === 'function') {
        try { if (input.contentDrift.requiresRevalidation('items', candidate.output)) continue; } catch (_) { continue; }
      }
      const built = this._buildCandidate(candidate, input);
      if (!bestBlocked) bestBlocked = built;
      if (!built.ready) {
        blockedCandidates.push(built);
        continue;
      }
      const plan = {
        schemaVersion: 1,
        id: this._id(),
        at: this.now(),
        state: 'READY',
        reason: 'PRODUCTION_CHAIN_READY',
        actionAuthority: false,
        liveExecutionAllowed: false,
        target: built.candidate,
        steps: built.steps,
        nextStep: built.executableSteps[0] || null,
        reservations: built.reservations,
        blockers: [],
        totalGold: built.totalGold,
        goldReserve: built.goldReserve,
        bankSource: built.bankSource,
        costStrategy: built.costStrategy
      };
      this.lastPlan = plan;
      this.stats.plans += 1;
      this.stats.ready += 1;
      this._event('PRODUCTION_PLAN_READY', 'info', plan.reason, { planId: plan.id, output: plan.target.output, recipient: plan.target.recipient, steps: plan.steps.length, totalGold: plan.totalGold });
      return clone(plan);
    }

    const plan = {
      schemaVersion: 1,
      id: this._id(),
      at: this.now(),
      state: 'BLOCKED',
      reason: 'NO_CURRENTLY_EXECUTABLE_PRODUCTION_CHAIN',
      actionAuthority: false,
      liveExecutionAllowed: false,
      target: bestBlocked ? bestBlocked.candidate : null,
      steps: bestBlocked ? bestBlocked.steps : [],
      nextStep: null,
      reservations: bestBlocked ? bestBlocked.reservations : {},
      blockers: bestBlocked ? bestBlocked.blockers : [{ reason: 'NO_CANDIDATE' }],
      totalGold: bestBlocked ? bestBlocked.totalGold : 0,
      goldReserve: this.goldReserve,
      blockedCandidates: blockedCandidates.slice(0, this.candidateScanLimit).map((row) => ({
        candidate: clone(row.candidate),
        steps: clone(row.steps),
        blockers: clone(row.blockers),
        reservations: clone(row.reservations),
        totalGold: row.totalGold,
        availableGold: row.availableGold,
        goldReserve: row.goldReserve,
        bankSource: row.bankSource,
        costStrategy: row.costStrategy
      }))
    };
    this.lastPlan = plan;
    this.stats.plans += 1;
    this.stats.blocked += 1;
    this._event('PRODUCTION_PLAN_BLOCKED', 'warn', plan.reason, { output: plan.target && plan.target.output || null, blockers: plan.blockers.slice(0, 8) });
    return clone(plan);
  }

  status() {
    return {
      schemaVersion: 1,
      mode: MERCHANT_PRODUCTION_PLANNER_MODE,
      actionAuthority: false,
      liveExecutionAllowed: false,
      maxDepth: this.maxDepth,
      minImprovementRatio: this.minImprovementRatio,
      goldReserve: this.goldReserve,
      maxBuyQuantity: this.maxBuyQuantity,
      candidateScanLimit: this.candidateScanLimit,
      maxSteps: this.maxSteps,
      maxQuantity: this.maxQuantity,
      maxPlanningWork: this.maxPlanningWork,
      maxGoldCost: this.maxGoldCost,
      explicitTargets: this.explicitTargets.slice(),
      costStrategy: 'LEAST_GOLD_SOURCE_GRAPH_V3',
      sourcePriority: ['LOCAL_ZERO_COST', 'BANK_ZERO_GOLD_COST', 'MIN(VENDOR_GOLD,CULLED_RECIPE_GRAPH)', 'UPGRADE_OR_COMPOUND_REQUIRED', 'QUEST_OR_EVENT_ACQUISITION', 'FARM_REQUIRED'],
      leveledRecipeMaterials: true,
      questExchangeAcquisition: true,
      eventGatedAcquisition: true,
      probabilisticFarmTime: false,
      farmTimeDecisionQuantile: null,
      farmTimeReason: 'V3_ACQUISITION_CONTROLLER_NOT_PART_OF_PLANNER_PORT',
      mutationFamilies: ['UPGRADE', 'COMPOUND'],
      autonomousExchangeableSurplus: true,
      anniversarySliceConsolidation: true,
      anniversarySliceConsolidationOutput: 'sixcake',
      lastPlan: clone(this.lastPlan),
      stats: clone(this.stats)
    };
  }
}

  ns.MerchantProductionPlanner = MerchantProductionPlanner;
  ns.ProductionStepKind = ProductionStepKind;
})(typeof globalThis !== 'undefined' ? globalThis : this);
