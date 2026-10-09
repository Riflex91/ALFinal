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
    ranger: ['DPS', 'AOE', 'RANGED'],
    mage: ['DPS', 'AOE', 'RANGED', 'SUPPORT'],
    rogue: ['DPS', 'MELEE'],
    paladin: ['TANK', 'HEAL', 'SUPPORT', 'DPS', 'MELEE'],
    merchant: ['ECONOMY', 'LOGISTICS']
  });

  function defaultGearRole(ctype) {
    const type = String(ctype || '').toLowerCase();
    if (type === 'merchant') return 'economy';
    if (type === 'warrior' || type === 'paladin') return 'tank';
    if (type === 'priest') return 'healer';
    if (type === 'mage') return 'aoe';
    if (type === 'ranger' || type === 'rogue') return 'dps';
    return null;
  }

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
      this.storage = options.storage || null;
      this.hostState = options.hostState || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.trainingMs = 0;
      this.lastTrainingTickMs = null;
      this.lastProfiles = [];
      this.lastProfilesAtMs = null;
      this.lastPeerRegistryAtMs = null;
      this.profileWrites = new Map();
      this.gearRegistry = new Map();
      this.gearRegistrySource = new Map();
      this.lastProgression = null;
      this.lastTaskPlan = null;
      this.profileCacheKey = cleanText(options.profileCacheKey || 'albot:h28:account-profile-cache:v1', 200);
      this.wealthCacheKey = cleanText(options.wealthCacheKey || 'albot:h28:account-wealth-cache:v1', 200);
      this.config = {
        targetCorridor: clamp(options.targetCorridor == null ? 0.08 : options.targetCorridor, 0, 0.5),
        maxProfileAgeMs: Math.max(1500, Math.min(30000, Number(options.maxProfileAgeMs) || 9000)),
        maxCandidates: Math.max(4, Math.min(32, Math.floor(Number(options.maxCandidates) || 16))),
        // Profile views are advisory; lifecycle/action gates still read live data.
        profileReadCacheMs: options.now ? 0 : Math.max(100, Math.min(1000, Number(options.profileReadCacheMs) || 250)),
        profilePersistIntervalMs: Math.max(1000, Math.min(60000, Number(options.profilePersistIntervalMs) || 10000))
      };
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      this.heartbeat = typeof context.heartbeat === 'function' ? context.heartbeat : null;
      try { this.persistLocalProfile(); } catch (_) {}
      return this.status();
    }

    stop() {
      try { this.persistLocalProfile(); } catch (_) {}
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

    _cachedProfiles() {
      const row = this._storageRead(this.profileCacheKey, {});
      return row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    }

    _profileCacheEntryKey(name) {
      const normalized = cleanText(name || '', 120);
      return normalized ? this.profileCacheKey + ':' + encodeURIComponent(normalized) : null;
    }

    _profileHasEquipment(profile) {
      return !!(profile && profile.equipment && typeof profile.equipment === 'object'
        && Object.values(profile.equipment).some(item => item && item.name));
    }

    _betterProfile(current, candidate) {
      if (!current) return candidate ? clone(candidate) : null;
      if (!candidate) return clone(current);
      const currentHasEquipment = this._profileHasEquipment(current);
      const candidateHasEquipment = this._profileHasEquipment(candidate);
      if (candidateHasEquipment && !currentHasEquipment) return clone(candidate);
      if (currentHasEquipment && !candidateHasEquipment) {
        const merged = { ...clone(candidate), ...clone(current) };
        if (finite(candidate.gold) != null && finite(current.gold) == null) merged.gold = finite(candidate.gold);
        return merged;
      }
      const currentAt = finite(current.observedAtMs) || finite(current.cachedAtMs) || 0;
      const candidateAt = finite(candidate.observedAtMs) || finite(candidate.cachedAtMs) || 0;
      return candidateAt >= currentAt ? { ...clone(current), ...clone(candidate) } : { ...clone(candidate), ...clone(current) };
    }

    _cachedProfile(name) {
      const normalized = cleanText(name || '', 120);
      if (!normalized) return null;

      const inMemory = this.gearRegistry.get(normalized) || null;
      const key = this._profileCacheEntryKey(normalized);
      const direct = key ? this._storageRead(key, null) : null;
      const legacy = this._cachedProfiles();
      const stored = this._betterProfile(
        direct && typeof direct === 'object' && !Array.isArray(direct) ? direct : null,
        legacy[normalized] && typeof legacy[normalized] === 'object' && !Array.isArray(legacy[normalized]) ? legacy[normalized] : null
      );
      const localCached = this._betterProfile(inMemory, stored);
      if (localCached) {
        this.gearRegistry.set(normalized, clone(localCached));
        if (!inMemory || (stored && this._profileHasEquipment(stored) && !this._profileHasEquipment(inMemory))) {
          this.gearRegistrySource.set(normalized, 'BOT_SHARED_CACHE');
        }
        return clone(localCached);
      }

      // SSD/host state is optional fallback only. A host row must never shadow
      // fresher bot-native cross-character state.
      try {
        const hosted = this.hostState && typeof this.hostState.profile === 'function'
          ? this.hostState.profile(normalized)
          : null;
        if (hosted && typeof hosted === 'object' && !Array.isArray(hosted)) {
          this.gearRegistry.set(normalized, clone(hosted));
          this.gearRegistrySource.set(normalized, 'HOST_FALLBACK');
          return clone(hosted);
        }
      } catch (_) {}
      return null;
    }

    _rememberProfile(profile, source = 'BOT_NATIVE') {
      if (!profile || !profile.name) return false;
      const normalized = this._normalizeProfile(profile);
      if (!normalized) return false;
      if (!normalized.equipment && finite(normalized.gold) == null) return false;
      const key = this._profileCacheEntryKey(normalized.name);
      if (!key) return false;

      const existing = this.gearRegistry.get(normalized.name) || null;
      const merged = this._betterProfile(existing, normalized);
      const row = {
        ...clone(merged || normalized),
        cachedAtMs: this.now()
      };
      this.gearRegistry.set(normalized.name, clone(row));
      this.gearRegistrySource.set(normalized.name, cleanText(source || 'BOT_NATIVE', 80) || 'BOT_NATIVE');

      // Do not serialise, write and queue an identical gear/gold snapshot on
      // every read of profiles(). In the live Merchant this caused hundreds of
      // thousands of redundant host queue operations in minutes.
      const fingerprint = JSON.stringify({
        ctype: row.ctype, level: row.level, gold: row.gold, map: row.map,
        gearRole: row.gearRole, gearScore: row.gearScore, rip: row.rip,
        equipment: row.equipment
      });
      const previous = this.profileWrites.get(normalized.name);
      const changed = !previous || previous.fingerprint !== fingerprint;
      const now = this.now();
      if (!changed && now - Number(previous.atMs || 0) < this.config.profilePersistIntervalMs) {
        return true;
      }
      // Store before optional mirroring so missing/unreachable SSD host cannot
      // cause per-tick JSON writes. The bot-native cache remains authoritative.
      const written = this._storageWrite(key, row);
      if (written) {
        this.profileWrites.set(normalized.name, { fingerprint, atMs: now });
        try {
          if (this.hostState && typeof this.hostState.persistProfile === 'function') {
            this.hostState.persistProfile(row);
          }
        } catch (_) {}
      }
      return written;
    }

    _ingestCrossWindowRegistry() {
      if (!this.crossWindow || typeof this.crossWindow.status !== 'function') return 0;
      const now = this.now();
      if (this.lastPeerRegistryAtMs != null && now >= this.lastPeerRegistryAtMs
          && now - this.lastPeerRegistryAtMs < 1000) return 0;
      this.lastPeerRegistryAtMs = now;
      let state = null;
      try { state = this.crossWindow.status(); } catch (_) { return 0; }
      const freshNames = new Set((state && Array.isArray(state.freshPeers) ? state.freshPeers : [])
        .map(peer => cleanText(peer && peer.name || '', 120)).filter(Boolean));
      const peers = state && Array.isArray(state.peers) ? state.peers : [];
      let ingested = 0;
      for (const peer of peers) {
        if (!peer || !peer.name || !peer.profile) continue;
        const source = freshNames.has(String(peer.name)) ? 'CROSS_WINDOW_FRESH' : 'CROSS_WINDOW_LAST_KNOWN';
        if (this._rememberProfile({ ...peer.profile, name: peer.name }, source)) ingested += 1;
      }
      return ingested;
    }

    _cachedBankGold() {
      try {
        const hosted = this.hostState && typeof this.hostState.wealth === 'function'
          ? this.hostState.wealth()
          : null;
        const hostedValue = finite(hosted && hosted.bankGold);
        if (hostedValue != null) return Math.max(0, hostedValue);
      } catch (_) {}
      const row = this._storageRead(this.wealthCacheKey, null);
      const value = finite(row && row.bankGold);
      return value == null ? null : Math.max(0, value);
    }

    _rememberBankGold(bankGold) {
      const value = finite(bankGold);
      if (value == null || value < 0) return false;
      const row = {
        schemaVersion: 1,
        bankGold: value,
        observedAtMs: this.now()
      };
      try {
        if (this.hostState && typeof this.hostState.persistWealth === 'function') {
          this.hostState.persistWealth(row);
        }
      } catch (_) {}
      return this._storageWrite(this.wealthCacheKey, row);
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
      return Object.keys(out).length ? out : null;
    }

    localProfile() {
      let snapshot = null;
      try { snapshot = this.game && this.game.snapshot ? this.game.snapshot() : null; } catch (_) {}
      const character = snapshot && snapshot.character;
      if (!character || !character.name) return null;
      const ctype = cleanText(character.ctype || '', 40).toLowerCase();
      const equipment = this._localEquipment(character);
      return {
        schemaVersion: 1,
        name: cleanText(character.name, 120),
        ctype,
        gearRole: defaultGearRole(ctype),
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
        x: character.x == null ? null : finite(character.x),
        y: character.y == null ? null : finite(character.y),
        gold: finite(character.gold),
        gearScore: this._localGearScore(character),
        equipment,
        equipmentKnown: this._profileHasEquipment({ equipment }),
        trainingMs: Math.max(0, Math.floor(this.trainingMs)),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: this.now()
      };
    }

    persistLocalProfile() {
      const profile = this.localProfile();
      if (!profile) return null;
      this._rememberProfile(profile, 'LOCAL_CHARACTER');
      return clone(profile);
    }

    _fallbackProfile(row) {
      if (!row || !row.name) return null;
      const ctype = cleanText(row.ctype || row.type || '', 40).toLowerCase();
      return {
        schemaVersion: 1,
        name: cleanText(row.name, 120),
        ctype,
        gearRole: defaultGearRole(ctype),
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
        gold: finite(row.gold),
        gearScore: 0,
        equipment: null,
        equipmentKnown: false,
        trainingMs: 0,
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: null,
        fallback: true,
        online: row.online === true
      };
    }

    profiles() {
      const now = this.now();
      // Cached output is for planning only, never command authorization. The
      // cross-window lifecycle validates live peer freshness independently.
      if (this.lastProfilesAtMs != null && now >= this.lastProfilesAtMs
          && now - this.lastProfilesAtMs < this.config.profileReadCacheMs) {
        return clone(this.lastProfiles);
      }
      // V3-style account registry: consume all peer gear snapshots transported
      // by H19, not only peers that are still fresh at this exact tick.
      this._ingestCrossWindowRegistry();

      let roster = null;
      try { roster = this.roster && this.roster.refresh ? this.roster.refresh() : this.roster && this.roster.status ? this.roster.status() : null; } catch (_) {}
      const account = roster && Array.isArray(roster.accountCharacters) ? roster.accountCharacters : [];
      const online = new Set(roster && Array.isArray(roster.onlineCharacterNames) ? roster.onlineCharacterNames.map(String) : []);
      const byName = new Map();

      for (const row of account) {
        const fallback = this._fallbackProfile(row);
        if (!fallback) continue;
        const cachedRaw = this._cachedProfile(fallback.name);
        const cached = cachedRaw && this._normalizeProfile(cachedRaw);
        const selected = cached ? {
          ...fallback,
          ...cached,
          online: false,
          running: false,
          peerFresh: false,
          local: false,
          cached: true
        } : fallback;
        byName.set(fallback.name, selected);
        if (!cached && !this.gearRegistry.has(fallback.name)) {
          this.gearRegistry.set(fallback.name, clone(fallback));
          this.gearRegistrySource.set(fallback.name, 'ACCOUNT_ROSTER');
        }
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
        this._rememberProfile(profile, 'CROSS_WINDOW_FRESH');
      }

      const local = this.persistLocalProfile();
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
        online: online.has(String(row.name))
      })).sort((a, b) => a.name.localeCompare(b.name));
      this.lastProfiles = clone(rows);
      this.lastProfilesAtMs = now;
      return clone(rows);
    }

    _normalizeProfile(raw) {
      if (!raw || !raw.name) return null;
      const ctype = cleanText(raw.ctype || '', 40).toLowerCase();
      const rawEquipment = raw.equipment && typeof raw.equipment === 'object' ? clone(raw.equipment) : null;
      const equipmentKnown = this._profileHasEquipment({ equipment: rawEquipment });
      const equipment = equipmentKnown ? rawEquipment : null;
      return {
        schemaVersion: 1,
        name: cleanText(raw.name, 120),
        ctype,
        gearRole: cleanText(raw.gearRole || raw.combatRole || raw.farmRole || raw.localRole || raw.role || '', 40).toLowerCase()
          || defaultGearRole(ctype),
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
        gold: finite(raw.gold),
        gearScore: Math.max(0, finite(raw.gearScore) || 0),
        equipment,
        equipmentKnown,
        trainingMs: Math.max(0, finite(raw.trainingMs) || 0),
        capabilities: clone(ROLE_CAPABILITIES[ctype] || []),
        observedAtMs: finite(raw.observedAtMs)
      };
    }

    accountWealth() {
      const profiles = this.profiles();
      let characterGold = 0;
      const missingCharacterGold = [];
      for (const profile of profiles) {
        const gold = finite(profile && profile.gold);
        if (gold == null) missingCharacterGold.push(profile && profile.name || 'UNKNOWN');
        else characterGold += Math.max(0, gold);
      }

      let bankGold = null;
      let bankSource = 'UNKNOWN';
      try {
        const bank = this.game && typeof this.game.bankSnapshot === 'function' ? this.game.bankSnapshot() : null;
        if (bank && bank.available !== false && finite(bank.gold) != null) {
          bankGold = Math.max(0, finite(bank.gold));
          bankSource = 'LIVE_BANK';
          this._rememberBankGold(bankGold);
        }
      } catch (_) {}
      if (bankGold == null) {
        bankGold = this._cachedBankGold();
        if (bankGold != null) bankSource = 'PERSISTED_BANK';
      }

      const known = missingCharacterGold.length === 0 && bankGold != null && profiles.length > 0;
      const partialGold = characterGold + Math.max(0, bankGold || 0);
      return {
        schemaVersion: 1,
        known,
        totalGold: known ? partialGold : null,
        partialGold,
        characterGold,
        bankGold,
        bankSource,
        characterCount: profiles.length,
        missingCharacterGold
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

    gearRegistryStatus() {
      const rows = [...this.gearRegistry.entries()].map(([name, profile]) => ({
        name,
        ctype: profile && profile.ctype || null,
        level: finite(profile && profile.level),
        equipmentKnown: this._profileHasEquipment(profile),
        equipmentSlots: profile && profile.equipment && typeof profile.equipment === 'object'
          ? Object.values(profile.equipment).filter(item => item && item.name).length
          : 0,
        observedAtMs: finite(profile && profile.observedAtMs),
        cachedAtMs: finite(profile && profile.cachedAtMs),
        source: this.gearRegistrySource.get(name) || 'UNKNOWN'
      })).sort((a, b) => a.name.localeCompare(b.name));
      return {
        schemaVersion: 1,
        count: rows.length,
        equipmentKnownCount: rows.filter(row => row.equipmentKnown).length,
        rows
      };
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        localTrainingMs: Math.max(0, Math.floor(this.trainingMs)),
        profiles: clone(this.lastProfiles),
        gearRegistry: this.gearRegistryStatus(),
        progression: clone(this.lastProgression),
        taskPlan: clone(this.lastTaskPlan),
        config: clone(this.config)
      };
    }
  }

  ns.AccountStrategyController = AccountStrategyController;
  ns.ACCOUNT_ROLE_CAPABILITIES = ROLE_CAPABILITIES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
