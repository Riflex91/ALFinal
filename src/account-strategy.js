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

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  const ROLE_CAPABILITIES = Object.freeze({
    warrior: ['TANK', 'DPS', 'MELEE'],
    priest: ['HEALER', 'HEAL', 'REVIVE', 'SUPPORT', 'DPS', 'RANGED'],
    ranger: ['DPS', 'RANGED'],
    mage: ['DPS', 'AOE', 'RANGED', 'SUPPORT'],
    rogue: ['DPS', 'MELEE'],
    paladin: ['TANK', 'HEAL', 'SUPPORT', 'DPS', 'MELEE'],
    merchant: ['ECONOMY', 'LOGISTICS']
  });

  const TASK_DEFAULTS = Object.freeze({
    FARM: {
      minMembers: 3, maxMembers: 3, required: ['DPS'], combatOnly: true,
      progressionWeight: 0.30, catchUpRequired: true, extraMemberCost: 0.90, offlineActivationCost: 0.08,
      capabilityWeights: { DPS: 0.06, AOE: 0.10, RANGED: 0.035, HEALER: 0.04, TANK: 0.025, SUPPORT: 0.025 }
    },
    QUEST: {
      minMembers: 3, maxMembers: 3, required: ['DPS'], combatOnly: true,
      progressionWeight: 0.16, catchUpRequired: false, extraMemberCost: 0.78, offlineActivationCost: 0.10,
      capabilityWeights: { DPS: 0.07, RANGED: 0.04, HEALER: 0.04, SUPPORT: 0.035, TANK: 0.02 }
    },
    BOSS: {
      minMembers: 3, maxMembers: 3, required: ['TANK', 'HEALER', 'DPS'], combatOnly: true,
      progressionWeight: 0.02, catchUpRequired: false, extraMemberCost: 0.10, offlineActivationCost: 0.12,
      capabilityWeights: { TANK: 0.10, HEALER: 0.10, DPS: 0.06, SUPPORT: 0.04, RANGED: 0.02 }
    },
    EVENT: {
      minMembers: 3, maxMembers: 3, required: ['TANK', 'HEALER', 'DPS'], combatOnly: true,
      progressionWeight: 0.04, catchUpRequired: false, extraMemberCost: 0.08, offlineActivationCost: 0.10,
      capabilityWeights: { AOE: 0.10, DPS: 0.06, HEALER: 0.08, TANK: 0.07, SUPPORT: 0.035 }
    },
    SPECIAL: {
      minMembers: 3, maxMembers: 3, required: ['HEALER', 'DPS'], combatOnly: true,
      progressionWeight: 0.06, catchUpRequired: false, extraMemberCost: 0.32, offlineActivationCost: 0.10,
      capabilityWeights: { HEALER: 0.09, DPS: 0.06, SUPPORT: 0.05, TANK: 0.04, RANGED: 0.025 }
    },
    ECONOMY: {
      minMembers: 1, maxMembers: 1, required: ['ECONOMY'], combatOnly: false,
      progressionWeight: 0, catchUpRequired: false, extraMemberCost: 0, offlineActivationCost: 0,
      capabilityWeights: { ECONOMY: 0.1, LOGISTICS: 0.05 }
    }
  });

  function combinations(rows, minSize, maxSize) {
    const out = [];
    const limit = Math.min(rows.length, Math.max(minSize, maxSize));
    const visit = (start, picked) => {
      if (picked.length >= minSize && picked.length <= limit) out.push(picked.slice());
      if (picked.length >= limit) return;
      for (let index = start; index < rows.length; index += 1) {
        picked.push(rows[index]);
        visit(index + 1, picked);
        picked.pop();
      }
    };
    visit(0, []);
    return out;
  }

  class AccountStrategyController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game || null;
      this.roster = options.roster || null;
      this.party = options.party || null;
      this.crossWindow = options.crossWindow || null;
      this.gear = options.gear || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.trainingMs = 0;
      this.lastTrainingTickMs = null;
      this.lastProfiles = [];
      this.lastProgression = null;
      this.lastTaskPlan = null;
      this.config = {
        targetCorridor: clamp(options.targetCorridor == null ? 0.08 : options.targetCorridor, 0, 0.5),
        maxProfileAgeMs: Math.max(1500, Math.min(30000, Number(options.maxProfileAgeMs) || 9000)),
        maxCandidates: Math.max(4, Math.min(32, Math.floor(Number(options.maxCandidates) || 16)))
      };
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      return this.status();
    }

    stop() {
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.lastTrainingTickMs = null;
      return this.status();
    }

    setCrossWindow(value) {
      this.crossWindow = value || null;
      return this.status();
    }

    recordTraining(active) {
      const now = this.now();
      if (this.lastTrainingTickMs == null) {
        this.lastTrainingTickMs = now;
        return this.trainingMs;
      }
      const delta = Math.max(0, Math.min(10000, now - this.lastTrainingTickMs));
      this.lastTrainingTickMs = now;
      if (active === true) this.trainingMs += delta;
      return this.trainingMs;
    }

    _localGearScore(character) {
      if (!character || !character.name || !this.game || !this.gear) return 0;
      let equipment = null;
      try { equipment = this.game.equipmentSnapshot(character.name); } catch (_) {}
      if (!equipment || equipment.available === false || !equipment.slots) return 0;
      let total = 0;
      for (const item of Object.values(equipment.slots)) {
        if (!item) continue;
        try {
          const value = Number(this.gear.score(item, character.ctype));
          if (Number.isFinite(value) && value > 0) total += value;
        } catch (_) {}
      }
      return Number(total.toFixed(4));
    }

    _localEquipment(character) {
      if (!character || !character.name || !this.game || typeof this.game.equipmentSnapshot !== 'function') return null;
      let equipment = null;
      try { equipment = this.game.equipmentSnapshot(character.name); } catch (_) {}
      if (!equipment || equipment.available === false || !equipment.slots) return null;
      const out = {};
      for (const [slot, row] of Object.entries(equipment.slots)) {
        if (!row || !row.name) continue;
        out[cleanText(slot, 40)] = {
          name: cleanText(row.name, 160),
          level: Math.max(0, Math.floor(finite(row.level) || 0)),
          statType: cleanText(row.statType != null ? row.statType : row.stat_type || '', 80) || null,
          property: row.property == null ? (row.p == null ? null : clone(row.p)) : clone(row.property)
        };
      }
      return out;
    }

    localProfile() {
      let snapshot = null;
      try { snapshot = this.game && this.game.snapshot ? this.game.snapshot() : null; } catch (_) {}
      const character = snapshot && snapshot.character;
      if (!character || !character.name) return null;
      const ctype = cleanText(character.ctype || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(character.name, 120),
        ctype,
        level: finite(character.level),
        hp: finite(character.hp),
        maxHp: finite(character.maxHp),
        mp: finite(character.mp),
        maxMp: finite(character.maxMp),
        attack: finite(character.attack),
        armor: finite(character.armor),
        resistance: finite(character.resistance),
        frequency: finite(character.frequency),
        speed: finite(character.speed),
        range: finite(character.range),
        rip: character.rip === true,
        map: cleanText(character.map || '', 120) || null,
        gearScore: this._localGearScore(character),
        equipment: this._localEquipment(character),
        trainingMs: Math.max(0, Math.floor(this.trainingMs)),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: this.now()
      };
    }

    _fallbackProfile(row) {
      if (!row || !row.name) return null;
      const ctype = cleanText(row.ctype || row.type || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(row.name, 120),
        ctype,
        level: finite(row.level),
        hp: null,
        maxHp: null,
        mp: null,
        maxMp: null,
        attack: null,
        armor: null,
        resistance: null,
        frequency: null,
        speed: null,
        range: null,
        rip: false,
        map: null,
        gearScore: 0,
        equipment: null,
        trainingMs: 0,
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: null,
        fallback: true,
        online: row.online === true
      };
    }

    profiles() {
      let roster = null;
      try { roster = this.roster && this.roster.refresh ? this.roster.refresh() : this.roster && this.roster.status ? this.roster.status() : null; } catch (_) {}
      const account = roster && Array.isArray(roster.accountCharacters) ? roster.accountCharacters : [];
      const online = new Set(roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String) : []);
      const byName = new Map();

      for (const row of account) {
        const fallback = this._fallbackProfile(row);
        if (fallback) byName.set(fallback.name, fallback);
      }

      let peers = [];
      try { peers = this.crossWindow && this.crossWindow.freshPeers ? this.crossWindow.freshPeers() : []; } catch (_) {}
      for (const peer of peers) {
        const raw = peer && peer.profile;
        if (!raw || !peer.name) continue;
        const profile = this._normalizeProfile({ ...raw, name: peer.name });
        if (!profile) continue;
        profile.running = peer.running === true;
        profile.fullAutonomyEnabled = peer.fullAutonomyEnabled === true;
        profile.emergencyStopLatched = peer.emergencyStopLatched === true;
        profile.sessionId = peer.sessionId || null;
        profile.peerFresh = true;
        profile.observedAtMs = finite(peer.observedAtMs) || profile.observedAtMs;
        byName.set(profile.name, profile);
      }

      const local = this.localProfile();
      if (local) {
        local.running = true;
        local.emergencyStopLatched = false;
        local.peerFresh = true;
        local.local = true;
        byName.set(local.name, local);
        online.add(local.name);
      }

      const rows = [...byName.values()].map(row => ({
        ...row,
        online: online.has(String(row.name)) || row.online === true
      })).sort((a, b) => a.name.localeCompare(b.name));
      this.lastProfiles = clone(rows);
      return clone(rows);
    }

    _normalizeProfile(raw) {
      if (!raw || !raw.name) return null;
      const ctype = cleanText(raw.ctype || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(raw.name, 120),
        ctype,
        level: finite(raw.level),
        hp: finite(raw.hp),
        maxHp: finite(raw.maxHp),
        mp: finite(raw.mp),
        maxMp: finite(raw.maxMp),
        attack: finite(raw.attack),
        armor: finite(raw.armor),
        resistance: finite(raw.resistance),
        frequency: finite(raw.frequency),
        speed: finite(raw.speed),
        range: finite(raw.range),
        rip: raw.rip === true,
        map: cleanText(raw.map || '', 120) || null,
        gearScore: Math.max(0, finite(raw.gearScore) || 0),
        equipment: raw.equipment && typeof raw.equipment === 'object' ? clone(raw.equipment) : null,
        trainingMs: Math.max(0, finite(raw.trainingMs) || 0),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: finite(raw.observedAtMs)
      };
    }

    _scoredProfiles() {
      const rows = this.profiles();
      const usable = rows.filter(row => row.rip !== true && row.emergencyStopLatched !== true);
      const maxLevel = Math.max(1, ...usable.map(row => finite(row.level) || 1));
      const maxGear = Math.max(1, ...usable.map(row => finite(row.gearScore) || 0));
      const combatRaw = row => {
        const dps = Math.max(0, finite(row.attack) || 0) * Math.max(0.1, finite(row.frequency) || 1);
        const toughness = Math.max(0, finite(row.maxHp) || 0) * 0.01
          + (Math.max(0, finite(row.armor) || 0) + Math.max(0, finite(row.resistance) || 0)) * 0.12;
        return dps + toughness + Math.max(0, finite(row.range) || 0) * 0.02 + Math.max(0, finite(row.speed) || 0) * 0.03;
      };
      const maxCombat = Math.max(1, ...usable.map(combatRaw));
      const totalTraining = usable.reduce((sum, row) => sum + Math.max(0, finite(row.trainingMs) || 0), 0);

      return rows.map(row => {
        const levelProgress = clamp((finite(row.level) || 1) / maxLevel);
        const gearProgress = clamp((finite(row.gearScore) || 0) / maxGear);
        const combatProgress = clamp(combatRaw(row) / maxCombat);
        const survival = row.maxHp && row.hp != null ? clamp(Number(row.hp) / Number(row.maxHp)) : 0.75;
        const strength = row.fallback === true
          ? clamp(levelProgress * 0.82 + survival * 0.18)
          : clamp(levelProgress * 0.42 + gearProgress * 0.23 + combatProgress * 0.27 + survival * 0.08);
        const trainingShare = totalTraining > 0 ? Math.max(0, finite(row.trainingMs) || 0) / totalTraining : 0;
        return {
          ...row,
          strength: Number(strength.toFixed(6)),
          levelProgress: Number(levelProgress.toFixed(6)),
          gearProgress: Number(gearProgress.toFixed(6)),
          combatProgress: Number(combatProgress.toFixed(6)),
          survival: Number(survival.toFixed(6)),
          trainingShare: Number(trainingShare.toFixed(6))
        };
      });
    }

    progressionPlan() {
      const combat = this._scoredProfiles().filter(row =>
        row.rip !== true
        && row.emergencyStopLatched !== true
        && row.ctype !== 'merchant'
        && row.capabilities.includes('DPS')
      );
      const strongest = combat.length ? Math.max(...combat.map(row => row.strength)) : 0;
      const ranking = combat.map(row => {
        const gap = Math.max(0, strongest - row.strength - this.config.targetCorridor);
        const trainingDeficit = Math.max(0, 1 - row.trainingShare);
        const catchUp = gap > 0 ? clamp(gap * 0.90 + trainingDeficit * 0.10) : 0;
        return { name: row.name, strength: row.strength, gap, trainingShare: row.trainingShare, catchUp, ctype: row.ctype };
      }).sort((a, b) => b.catchUp - a.catchUp || a.strength - b.strength || a.name.localeCompare(b.name));
      const result = {
        schemaVersion: 1,
        targetCorridor: this.config.targetCorridor,
        strongest,
        selectedCharacterName: ranking[0] && ranking[0].catchUp > 0 ? ranking[0].name : null,
        ranking
      };
      this.lastProgression = clone(result);
      return result;
    }

    optimizeTask(input = {}) {
      const taskType = cleanText(input.type || input.taskType || 'FARM', 40).toUpperCase();
      const defaults = TASK_DEFAULTS[taskType] || TASK_DEFAULTS.FARM;
      const minMembers = defaults.combatOnly
        ? 3
        : Math.max(1, Math.min(4, Math.floor(Number(input.minMembers) || defaults.minMembers)));
      const maxMembers = defaults.combatOnly
        ? 3
        : Math.max(minMembers, Math.min(4, Math.floor(Number(input.maxMembers) || defaults.maxMembers)));
      const required = Array.isArray(input.requiredCapabilities) && input.requiredCapabilities.length
        ? [...new Set(input.requiredCapabilities.map(value => cleanText(value, 40).toUpperCase()).filter(Boolean))]
        : defaults.required.slice();
      const progression = this.progressionPlan();
      const allowedCharacterNames = Array.isArray(input.allowedCharacterNames)
        ? new Set(input.allowedCharacterNames.map(name => cleanText(name, 120)).filter(Boolean))
        : null;
      const scored = this._scoredProfiles()
        .filter(row => row.rip !== true && row.emergencyStopLatched !== true)
        .filter(row => !allowedCharacterNames || allowedCharacterNames.has(String(row.name)))
        .filter(row => !defaults.combatOnly || row.ctype !== 'merchant')
        .slice(0, this.config.maxCandidates);

      const groups = combinations(scored, minMembers, maxMembers);
      const ranking = [];
      for (const members of groups) {
        const capabilities = new Set(members.flatMap(member => member.capabilities || []));
        if (!required.every(capability => capabilities.has(capability))) continue;
        const memberNameSet = new Set(members.map(member => String(member.name)));
        const progressionRequired = defaults.catchUpRequired === true
          && progression.selectedCharacterName
          && scored.some(row => String(row.name) === String(progression.selectedCharacterName));
        if (progressionRequired && !memberNameSet.has(String(progression.selectedCharacterName))) continue;
        const memberNames = members.map(member => member.name).sort();
        const baseStrength = members.reduce((sum, member) => sum + member.strength, 0);
        const averageStrength = members.length ? baseStrength / members.length : 0;
        const capabilityWeights = defaults.capabilityWeights || {};
        const activityBonus = [...capabilities].reduce((sum, capability) => sum + Math.max(0, Number(capabilityWeights[capability]) || 0), 0);
        const containsProgression = progression.selectedCharacterName
          ? memberNames.includes(progression.selectedCharacterName)
          : false;
        const progressionBonus = containsProgression ? defaults.progressionWeight : 0;
        const onlineReadyCount = members.filter(member => member.online && member.running === true).length;
        const readinessBonus = onlineReadyCount * 0.005;
        const offlineCount = members.length - onlineReadyCount;
        const coordinationCost = Math.max(0, members.length - 1) * Math.max(0, Number(defaults.extraMemberCost) || 0);
        const activationCost = offlineCount * Math.max(0, Number(defaults.offlineActivationCost) || 0);
        const score = baseStrength + activityBonus + progressionBonus + readinessBonus - coordinationCost - activationCost;
        ranking.push({
          taskType,
          memberNames,
          score: Number(score.toFixed(6)),
          baseStrength: Number(baseStrength.toFixed(6)),
          averageStrength: Number(averageStrength.toFixed(6)),
          progressionBonus,
          activityBonus: Number(activityBonus.toFixed(6)),
          readinessBonus: Number(readinessBonus.toFixed(6)),
          coordinationCost: Number(coordinationCost.toFixed(6)),
          activationCost: Number(activationCost.toFixed(6)),
          capabilities: [...capabilities].sort(),
          members: clone(members)
        });
      }

      ranking.sort((a, b) => b.score - a.score
        || b.baseStrength - a.baseStrength
        || a.memberNames.join(',').localeCompare(b.memberNames.join(',')));
      const selected = ranking[0] || null;
      let leaderName = null;
      if (selected) {
        const tank = selected.members.filter(row => row.capabilities.includes('TANK')).sort((a,b) => b.strength - a.strength)[0];
        const healer = selected.members.filter(row => row.capabilities.includes('HEALER')).sort((a,b) => b.strength - a.strength)[0];
        const strongest = selected.members.slice().sort((a,b) => b.strength - a.strength)[0];
        leaderName = tank && tank.name || healer && healer.name || strongest && strongest.name || null;
      }
      const merchants = this._scoredProfiles()
        .filter(row => row.rip !== true && row.emergencyStopLatched !== true && row.ctype === 'merchant')
        .filter(row => !allowedCharacterNames || allowedCharacterNames.has(String(row.name)))
        .sort((a, b) =>
          Number(b.online && b.running === true) - Number(a.online && a.running === true)
          || b.strength - a.strength
          || (finite(b.level) || 0) - (finite(a.level) || 0)
          || a.name.localeCompare(b.name));
      const supportMemberNames = merchants.length ? [merchants[0].name] : [];
      const supportReady = !defaults.combatOnly || supportMemberNames.length === 1;
      const result = {
        schemaVersion: 1,
        taskType,
        requiredCapabilities: required,
        allowedCharacterNames: allowedCharacterNames ? [...allowedCharacterNames].sort((a, b) => a.localeCompare(b)) : null,
        status: selected && supportReady
          ? 'SELECTION_READY'
          : (selected && !supportReady ? 'NO_MERCHANT_SUPPORT' : 'NO_ALLOWED_COMBINATION'),
        selected: selected ? {
          memberNames: selected.memberNames,
          score: selected.score,
          baseStrength: selected.baseStrength,
          averageStrength: selected.averageStrength,
          progressionBonus: selected.progressionBonus,
          activityBonus: selected.activityBonus,
          readinessBonus: selected.readinessBonus,
          coordinationCost: selected.coordinationCost,
          activationCost: selected.activationCost,
          capabilities: selected.capabilities
        } : null,
        leaderName,
        supportMemberNames,
        progression,
        ranking: ranking.slice(0, 16).map(row => ({
          memberNames: row.memberNames,
          score: row.score,
          baseStrength: row.baseStrength,
          averageStrength: row.averageStrength,
          progressionBonus: row.progressionBonus,
          activityBonus: row.activityBonus,
          readinessBonus: row.readinessBonus,
          coordinationCost: row.coordinationCost,
          activationCost: row.activationCost,
          capabilities: row.capabilities
        }))
      };
      this.lastTaskPlan = clone(result);
      return result;
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        localTrainingMs: Math.max(0, Math.floor(this.trainingMs)),
        profiles: clone(this.lastProfiles),
        progression: clone(this.lastProgression),
        taskPlan: clone(this.lastTaskPlan),
        config: clone(this.config)
      };
    }
  }

  ns.AccountStrategyController = AccountStrategyController;
  ns.ACCOUNT_ROLE_CAPABILITIES = ROLE_CAPABILITIES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
