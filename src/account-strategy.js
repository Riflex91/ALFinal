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
    priest: ['HEALER', 'HEAL', 'REVIVE', 'SUPPORT'],
    ranger: ['DPS', 'RANGED'],
    mage: ['DPS', 'AOE', 'RANGED', 'SUPPORT'],
    rogue: ['DPS', 'MELEE'],
    paladin: ['TANK', 'HEAL', 'SUPPORT', 'MELEE'],
    merchant: ['ECONOMY', 'LOGISTICS']
  });

  const TASK_DEFAULTS = Object.freeze({
    FARM: { minMembers: 1, maxMembers: 3, required: ['DPS'], combatOnly: true, progressionWeight: 0.20 },
    QUEST: { minMembers: 1, maxMembers: 3, required: ['DPS'], combatOnly: true, progressionWeight: 0.16 },
    BOSS: { minMembers: 3, maxMembers: 4, required: ['TANK', 'HEALER', 'DPS'], combatOnly: true, progressionWeight: 0 },
    EVENT: { minMembers: 3, maxMembers: 4, required: ['TANK', 'HEALER', 'DPS'], combatOnly: true, progressionWeight: 0 },
    SPECIAL: { minMembers: 2, maxMembers: 4, required: ['HEALER', 'DPS'], combatOnly: true, progressionWeight: 0.04 },
    ECONOMY: { minMembers: 1, maxMembers: 1, required: ['ECONOMY'], combatOnly: false, progressionWeight: 0 }
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
        maxCandidates: Math.max(4, Math.min(12, Math.floor(Number(options.maxCandidates) || 8)))
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
        trainingMs: Math.max(0, finite(raw.trainingMs) || 0),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: finite(raw.observedAtMs)
      };
    }

    _scoredProfiles() {
      const rows = this.profiles();
      const usable = rows.filter(row => row.online && row.rip !== true && row.emergencyStopLatched !== true);
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
        const strength = clamp(levelProgress * 0.42 + gearProgress * 0.23 + combatProgress * 0.27 + survival * 0.08);
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
        row.online
        && row.rip !== true
        && row.ctype !== 'merchant'
        && row.capabilities.includes('DPS')
      );
      const strongest = combat.length ? Math.max(...combat.map(row => row.strength)) : 0;
      const ranking = combat.map(row => {
        const gap = Math.max(0, strongest - row.strength - this.config.targetCorridor);
        const trainingDeficit = Math.max(0, 1 - row.trainingShare);
        const catchUp = clamp(gap * 0.72 + trainingDeficit * 0.28);
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
      const minMembers = Math.max(1, Math.min(4, Math.floor(Number(input.minMembers) || defaults.minMembers)));
      const maxMembers = Math.max(minMembers, Math.min(4, Math.floor(Number(input.maxMembers) || defaults.maxMembers)));
      const required = Array.isArray(input.requiredCapabilities) && input.requiredCapabilities.length
        ? [...new Set(input.requiredCapabilities.map(value => cleanText(value, 40).toUpperCase()).filter(Boolean))]
        : defaults.required.slice();
      const progression = this.progressionPlan();
      const scored = this._scoredProfiles()
        .filter(row => row.online && row.rip !== true && row.emergencyStopLatched !== true)
        .filter(row => !defaults.combatOnly || row.ctype !== 'merchant')
        .slice(0, this.config.maxCandidates);

      const groups = combinations(scored, minMembers, maxMembers);
      const ranking = [];
      for (const members of groups) {
        const capabilities = new Set(members.flatMap(member => member.capabilities || []));
        if (!required.every(capability => capabilities.has(capability))) continue;
        const memberNames = members.map(member => member.name).sort();
        const baseStrength = members.reduce((sum, member) => sum + member.strength, 0);
        const roleDiversity = capabilities.size / 10;
        const containsProgression = progression.selectedCharacterName
          ? memberNames.includes(progression.selectedCharacterName)
          : false;
        const progressionBonus = containsProgression ? defaults.progressionWeight : 0;
        const score = baseStrength + roleDiversity + progressionBonus;
        ranking.push({
          taskType,
          memberNames,
          score: Number(score.toFixed(6)),
          baseStrength: Number(baseStrength.toFixed(6)),
          progressionBonus,
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
      const supportMemberNames = this._scoredProfiles()
        .filter(row => row.online && row.rip !== true && row.ctype === 'merchant')
        .map(row => row.name)
        .sort();
      const result = {
        schemaVersion: 1,
        taskType,
        requiredCapabilities: required,
        status: selected ? 'SELECTION_READY' : 'NO_ALLOWED_COMBINATION',
        selected: selected ? {
          memberNames: selected.memberNames,
          score: selected.score,
          baseStrength: selected.baseStrength,
          progressionBonus: selected.progressionBonus,
          capabilities: selected.capabilities
        } : null,
        leaderName,
        supportMemberNames,
        progression,
        ranking: ranking.slice(0, 16).map(row => ({
          memberNames: row.memberNames,
          score: row.score,
          baseStrength: row.baseStrength,
          progressionBonus: row.progressionBonus,
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
