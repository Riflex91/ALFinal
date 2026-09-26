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

  function safeBoolean(value) {
    return value === true;
  }

  class AdventureLandGameAdapter {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.lastSnapshot = null;
    }

    _roots() {
      const rows = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!rows.includes(current)) rows.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return rows;
    }

    _read(name) {
      for (const candidate of this._roots()) {
        try {
          if (candidate && candidate[name] != null) return candidate[name];
        } catch (_) {}
      }
      return null;
    }

    _resolveFunction(name) {
      for (const candidate of this._roots()) {
        try {
          if (candidate && typeof candidate[name] === 'function') {
            return { owner: candidate, fn: candidate[name] };
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && typeof candidate.parent[name] === 'function') {
            return { owner: candidate.parent, fn: candidate.parent[name] };
          }
        } catch (_) {}
      }
      return null;
    }

    _character() {
      return this._read('character');
    }

    _entitySources() {
      const sources = [];
      const add = value => {
        if (value && typeof value === 'object' && !sources.includes(value)) sources.push(value);
      };
      for (const candidate of this._roots()) {
        try { add(candidate && candidate.entities); } catch (_) {}
        try { add(candidate && candidate.parent && candidate.parent.entities); } catch (_) {}
      }
      return sources;
    }

    _entityEntries() {
      const rows = [];
      const seen = new Set();
      for (const source of this._entitySources()) {
        for (const [key, entity] of Object.entries(source)) {
          if (!entity || typeof entity !== 'object') continue;
          const stableId = String(entity.id != null ? entity.id : key);
          if (seen.has(stableId)) continue;
          seen.add(stableId);
          rows.push({ key: String(key), entity, stableId });
        }
      }
      return rows;
    }

    _entities() {
      const merged = {};
      for (const row of this._entityEntries()) merged[row.stableId] = row.entity;
      return merged;
    }

    _gameData() {
      const value = this._read('G');
      return value && typeof value === 'object' ? value : {};
    }

    _position(value) {
      if (!value) return { x: null, y: null };
      return {
        x: finite(value.real_x != null ? value.real_x : value.x),
        y: finite(value.real_y != null ? value.real_y : value.y)
      };
    }

    _targetId(character) {
      if (!character) return null;
      const value = character.target != null ? character.target : character.target_id;
      return value == null || value === '' ? null : String(value);
    }

    _currentTarget() {
      for (const candidate of this._roots()) {
        try {
          if (candidate && candidate.ctarget && !candidate.ctarget.dead) {
            return { source: 'ctarget', entity: candidate.ctarget };
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && candidate.parent.ctarget && !candidate.parent.ctarget.dead) {
            return { source: 'parent.ctarget', entity: candidate.parent.ctarget };
          }
        } catch (_) {}
      }
      return null;
    }

    _entityByIdOrName(id) {
      if (id == null) return null;
      const wanted = String(id);
      for (const row of this._entityEntries()) {
        const key = row.key;
        const entity = row.entity;
        if (String(key) === wanted
          || String(row.stableId) === wanted
          || String(entity.id || '') === wanted
          || String(entity.name || '') === wanted) {
          return { key: String(key), entity };
        }
      }
      return null;
    }

    _normalizeEntity(match, characterMap) {
      if (!match) return null;
      const entity = match.entity || match;
      const fallbackId = match.key != null ? String(match.key) : null;
      const pos = this._position(entity);
      return {
        id: entity.id == null ? fallbackId : String(entity.id),
        name: entity.name == null ? null : cleanText(entity.name, 120),
        type: entity.type == null ? null : cleanText(entity.type, 80),
        ctype: entity.ctype == null ? null : cleanText(entity.ctype, 80),
        mtype: entity.mtype == null ? null : cleanText(entity.mtype, 120),
        player: safeBoolean(entity.player),
        npc: safeBoolean(entity.npc) || entity.type === 'npc',
        map: entity.map || characterMap || null,
        x: pos.x,
        y: pos.y,
        hp: finite(entity.hp),
        maxHp: finite(entity.max_hp),
        mp: finite(entity.mp),
        maxMp: finite(entity.max_mp),
        level: finite(entity.level),
        xp: finite(entity.xp),
        attack: finite(entity.attack),
        range: finite(entity.range),
        frequency: finite(entity.frequency),
        visible: entity.visible !== false,
        party: entity.party == null ? null : cleanText(entity.party, 120),
        targetId: entity.target == null ? null : String(entity.target),
        dead: safeBoolean(entity.dead) || safeBoolean(entity.rip)
      };
    }

    playerReference(name, options = {}) {
      if (name == null) return null;
      const wanted = String(name);
      const character = this._character();
      if (character && (String(character.name || '') === wanted || String(character.id || '') === wanted)) {
        if (options.allowDead === true || (!character.rip && !character.dead)) return character;
      }
      const match = this._entityByIdOrName(wanted);
      if (!match || !match.entity) return null;
      const entity = match.entity;
      const isPlayer = entity.type === 'character' || entity.player === true || entity.ctype != null;
      if (!isPlayer) return null;
      if (options.allowDead !== true && (entity.dead || entity.rip || entity.visible === false)) return null;
      return entity;
    }

    partySnapshot() {
      const character = this._character();
      let rawParty = {};
      let rawList = [];
      const getParty = this._resolveFunction('get_party');
      try {
        if (getParty) rawParty = getParty.fn.call(getParty.owner) || {};
      } catch (_) {}
      if (!rawParty || typeof rawParty !== 'object' || Array.isArray(rawParty)) rawParty = {};
      for (const candidate of this._roots()) {
        try {
          if (candidate && Array.isArray(candidate.party_list)) {
            rawList = candidate.party_list.slice();
            break;
          }
        } catch (_) {}
        try {
          if (candidate && candidate.parent && Array.isArray(candidate.parent.party_list)) {
            rawList = candidate.parent.party_list.slice();
            break;
          }
        } catch (_) {}
      }

      const names = [];
      const addName = value => {
        const name = cleanText(value || '', 120);
        if (name && !names.includes(name)) names.push(name);
      };
      rawList.forEach(addName);
      Object.keys(rawParty).forEach(addName);
      if (character && character.party) addName(character.name);

      const members = names.map(name => {
        const partyRow = rawParty[name] && typeof rawParty[name] === 'object' ? rawParty[name] : {};
        const live = this.playerReference(name, { allowDead: true });
        const source = live || partyRow;
        const pos = this._position(source);
        const local = !!(character && String(character.name || '') === name);
        const hp = finite(live && live.hp != null ? live.hp : partyRow.hp);
        const maxHp = finite(live && live.max_hp != null ? live.max_hp : partyRow.max_hp);
        const mp = finite(live && live.mp != null ? live.mp : partyRow.mp);
        const maxMp = finite(live && live.max_mp != null ? live.max_mp : partyRow.max_mp);
        return {
          name,
          local,
          visible: local || !!live,
          ctype: cleanText((live && live.ctype) || partyRow.ctype || partyRow.type || '', 80) || null,
          level: finite((live && live.level) != null ? live.level : partyRow.level),
          map: (live && live.map) || partyRow.map || (local && character && character.map) || null,
          x: pos.x,
          y: pos.y,
          hp,
          maxHp,
          hpRatio: hp != null && maxHp != null && maxHp > 0 ? hp / maxHp : null,
          mp,
          maxMp,
          rip: safeBoolean((live && live.rip) || partyRow.rip || (live && live.dead)),
          targetId: ((live && live.target) != null ? live.target : partyRow.target) == null
            ? null
            : String((live && live.target) != null ? live.target : partyRow.target)
        };
      });

      return {
        schemaVersion: 1,
        available: names.length > 0,
        partyId: character && character.party ? String(character.party) : null,
        leader: rawList.length ? cleanText(rawList[0], 120) : (names[0] || null),
        memberNames: names,
        members,
        size: members.length,
        rawListAvailable: rawList.length > 0,
        rawPartyAvailable: Object.keys(rawParty).length > 0
      };
    }

    entityReference(id) {
      const match = this._entityByIdOrName(id);
      if (match && match.entity && match.entity.visible !== false && !match.entity.dead && !match.entity.rip) {
        return match.entity;
      }
      const current = this._currentTarget();
      if (current && current.entity) {
        const currentId = current.entity.id == null ? null : String(current.entity.id);
        if (id == null || currentId === String(id)) return current.entity;
      }
      return null;
    }

    visibleMonsters(options = {}) {
      const character = this._character();
      if (!character || !character.name) return [];
      const charPos = this._position(character);
      const type = cleanText(options.type || options.mtype || '', 120) || null;
      const rows = [];
      for (const row of this._entityEntries()) {
        const entity = row.entity;
        if (!entity || entity.visible === false || entity.dead === true || entity.rip === true) continue;
        if (!(entity.type === 'monster' || entity.mtype)) continue;
        if (type && String(entity.mtype || '') !== type) continue;
        if (entity.map && character.map && String(entity.map) !== String(character.map)) continue;
        const normalized = this._normalizeEntity({ key: row.key, entity }, character.map || null);
        if (!normalized || normalized.dead || normalized.visible === false) continue;
        if (charPos.x != null && charPos.y != null && normalized.x != null && normalized.y != null) {
          normalized.distance = Math.hypot(charPos.x - normalized.x, charPos.y - normalized.y);
        } else {
          normalized.distance = null;
        }
        rows.push(normalized);
      }
      rows.sort((a, b) => {
        const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
        const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
        return ad - bd;
      });
      return clone(rows);
    }

    visiblePlayers(options = {}) {
      const character = this._character();
      if (!character || !character.name) return [];
      const charPos = this._position(character);
      const radius = finite(options.radius);
      const rows = [];
      for (const row of this._entityEntries()) {
        const entity = row.entity;
        if (!entity || entity.visible === false || entity.dead === true || entity.rip === true) continue;
        const isPlayer = entity.type === 'character' || entity.player === true || entity.ctype != null;
        if (!isPlayer) continue;
        const entityName = entity.name == null ? null : String(entity.name);
        const entityId = entity.id == null ? String(row.key) : String(entity.id);
        if (entityName === String(character.name || '') || entityId === String(character.id || '')) continue;
        if (entity.map && character.map && String(entity.map) !== String(character.map)) continue;
        const normalized = this._normalizeEntity({ key: row.key, entity }, character.map || null);
        if (!normalized || normalized.dead || normalized.visible === false) continue;
        if (charPos.x != null && charPos.y != null && normalized.x != null && normalized.y != null) {
          normalized.distance = Math.hypot(charPos.x - normalized.x, charPos.y - normalized.y);
        } else {
          normalized.distance = null;
        }
        if (radius != null && (normalized.distance == null || normalized.distance > radius)) continue;
        rows.push(normalized);
      }
      rows.sort((a, b) => {
        const ad = a.distance == null ? Number.POSITIVE_INFINITY : a.distance;
        const bd = b.distance == null ? Number.POSITIVE_INFINITY : b.distance;
        return ad - bd;
      });
      return clone(rows);
    }

    monsterDefinition(mtype) {
      const id = cleanText(mtype || '', 120);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.monsters && G.monsters[id];
      if (!raw || typeof raw !== 'object') return null;
      const liveDropTable = G && G.drops && G.drops.monsters && G.drops.monsters[id];
      const dropsRaw = Array.isArray(raw.drops) && raw.drops.length
        ? raw.drops
        : (Array.isArray(liveDropTable) ? liveDropTable : []);
      const drops = [];
      let dropSignal = 0;
      for (const row of dropsRaw) {
        let chance = null;
        let item = null;
        let quantity = 1;
        if (Array.isArray(row)) {
          chance = finite(row[0]);
          item = row[1] == null ? null : cleanText(row[1], 160);
          const rawQuantity = finite(row[2]);
          if (rawQuantity != null && rawQuantity > 0) quantity = rawQuantity;
        } else if (row && typeof row === 'object') {
          chance = finite(row.chance != null ? row.chance : row.probability);
          item = cleanText(row.item || row.name || row.id || '', 160) || null;
          const rawQuantity = finite(row.quantity != null ? row.quantity : row.count);
          if (rawQuantity != null && rawQuantity > 0) quantity = rawQuantity;
        }
        if (chance != null && chance > 0) dropSignal += Math.min(1, chance) * quantity;
        if (item || chance != null) drops.push({ item, chance, quantity });
      }

      const rawGold = finite(raw.gold);
      const monsterGold = G && G.monster_gold && finite(G.monster_gold[id]);
      const goldRules = G && G.drops && G.drops.gold || {};
      const goldBase = finite(goldRules.base);
      const goldRandom = finite(goldRules.random);
      const gold = rawGold != null
        ? rawGold
        : (monsterGold != null
          ? 1 + monsterGold * ((goldBase || 0) + (goldRandom || 0) / 2)
          : null);

      return {
        id,
        name: raw.name == null ? id : cleanText(raw.name, 160),
        hp: finite(raw.hp),
        attack: finite(raw.attack),
        xp: finite(raw.xp),
        gold,
        speed: finite(raw.speed),
        range: finite(raw.range),
        frequency: finite(raw.frequency),
        respawn: finite(raw.respawn),
        damageType: raw.damage_type == null ? null : cleanText(raw.damage_type, 60).toLowerCase(),
        armor: finite(raw.armor),
        resistance: finite(raw.resistance),
        evasion: finite(raw.evasion),
        avoidance: finite(raw.avoidance),
        reflection: finite(raw.reflection),
        drops,
        dropSignal,
        boss: safeBoolean(raw.boss),
        cooperative: safeBoolean(raw.cooperative)
      };
    }

    _boundaryCenter(value) {
      if (Array.isArray(value)) {
        if (value.length >= 4 && value.slice(0, 4).every(item => finite(item) != null)) {
          return {
            x: (Number(value[0]) + Number(value[2])) / 2,
            y: (Number(value[1]) + Number(value[3])) / 2
          };
        }
        if (value.length === 2 && value.every(item => finite(item) != null)) {
          return { x: Number(value[0]), y: Number(value[1]) };
        }
        const centers = value.map(item => this._boundaryCenter(item)).filter(Boolean);
        if (!centers.length) return null;
        return {
          x: centers.reduce((sum, row) => sum + row.x, 0) / centers.length,
          y: centers.reduce((sum, row) => sum + row.y, 0) / centers.length
        };
      }
      if (!value || typeof value !== 'object') return null;
      const x = finite(value.x);
      const y = finite(value.y);
      if (x != null && y != null) return { x, y };
      const x1 = finite(value.x1);
      const y1 = finite(value.y1);
      const x2 = finite(value.x2);
      const y2 = finite(value.y2);
      if ([x1, y1, x2, y2].every(item => item != null)) {
        return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      }
      if (value.boundary != null) return this._boundaryCenter(value.boundary);
      if (value.boundaries != null) return this._boundaryCenter(value.boundaries);
      return null;
    }

    farmSpotCatalog(options = {}) {
      const G = this._gameData();
      const character = this._character();
      const requestedMap = cleanText(options.map || '', 120) || null;
      const currentOnly = options.currentOnly !== false;
      const currentMap = requestedMap || (character && character.map) || null;
      const maps = G && G.maps && typeof G.maps === 'object' ? G.maps : {};
      const rows = [];
      for (const [mapId, mapRaw] of Object.entries(maps)) {
        if (!mapRaw || typeof mapRaw !== 'object') continue;
        if (currentOnly && currentMap && String(mapId) !== String(currentMap)) continue;
        if (requestedMap && String(mapId) !== String(requestedMap)) continue;
        const spawnsRaw = Array.isArray(mapRaw.monsters)
          ? mapRaw.monsters
          : (mapRaw.monsters && typeof mapRaw.monsters === 'object' ? Object.values(mapRaw.monsters) : []);
        for (let index = 0; index < spawnsRaw.length; index += 1) {
          const spawn = spawnsRaw[index];
          if (!spawn || typeof spawn !== 'object') continue;
          const mtype = cleanText(spawn.type || spawn.mtype || spawn.monster || spawn.id || '', 120);
          if (!mtype) continue;
          const center = this._boundaryCenter(
            spawn.boundary != null ? spawn.boundary
              : spawn.boundaries != null ? spawn.boundaries
                : spawn.position != null ? spawn.position
                  : spawn.positions
          );
          if (!center) continue;
          const definition = this.monsterDefinition(mtype);
          rows.push({
            key: String(mapId) + ':' + mtype + ':' + String(index),
            map: String(mapId),
            mtype,
            x: center.x,
            y: center.y,
            count: finite(spawn.count),
            respawn: finite(spawn.respawn != null ? spawn.respawn : definition && definition.respawn),
            definition
          });
        }
      }
      return clone(rows);
    }

    skillDefinition(skillId) {
      const id = cleanText(skillId || '', 120);
      if (!id) return null;
      const G = this._gameData();
      const raw = G && G.skills && G.skills[id];
      if (!raw || typeof raw !== 'object') return null;
      const classesRaw = Array.isArray(raw.class) ? raw.class : (raw.class ? [raw.class] : []);
      return {
        id,
        name: raw.name == null ? id : cleanText(raw.name, 160),
        classes: classesRaw.map(value => cleanText(value, 60).toLowerCase()).filter(Boolean),
        level: finite(raw.level),
        mp: finite(raw.mp),
        cooldown: finite(raw.cooldown),
        range: finite(raw.range),
        rangeMultiplier: finite(raw.range_multiplier),
        rangeBonus: finite(raw.range_bonus),
        damageMultiplier: finite(raw.damage_multiplier),
        maxTargets: finite(raw.max_targets),
        share: raw.share == null ? null : cleanText(raw.share, 120),
        target: raw.target == null ? null : safeBoolean(raw.target),
        multi: safeBoolean(raw.multi),
        list: safeBoolean(raw.list),
        party: safeBoolean(raw.party),
        heal: safeBoolean(raw.heal),
        hostile: safeBoolean(raw.hostile)
      };
    }

    skillReadiness(skillId, targetId = null, options = {}) {
      const definition = this.skillDefinition(skillId);
      const character = this._character();
      const normalized = this.snapshot();
      if (!definition || !character || !normalized.available || !normalized.character) {
        return {
          available: false,
          allowed: false,
          skillId: cleanText(skillId || '', 120) || null,
          definition,
          reasons: ['SKILL_OR_CHARACTER_UNAVAILABLE'],
          cooldown: null,
          canUse: null,
          inRange: targetId == null ? true : null,
          activeCondition: false
        };
      }

      const reasons = [];
      const c = normalized.character;
      if (definition.classes.length && !definition.classes.includes(String(c.ctype || '').toLowerCase())) {
        reasons.push('SKILL_CLASS_MISMATCH');
      }
      if (definition.level != null && c.level != null && c.level < definition.level) reasons.push('SKILL_LEVEL_TOO_LOW');
      if (definition.mp != null && c.mp != null && c.mp < definition.mp) reasons.push('SKILL_MP_TOO_LOW');

      const cooldownFn = this._resolveFunction('is_on_cooldown');
      let cooldown = null;
      try { if (cooldownFn) cooldown = cooldownFn.fn.call(cooldownFn.owner, definition.id) === true; } catch (_) {}
      if (cooldown === true) reasons.push('SKILL_COOLDOWN');

      const canUseFn = this._resolveFunction('can_use');
      let canUse = null;
      try { if (canUseFn) canUse = canUseFn.fn.call(canUseFn.owner, definition.id) === true; } catch (_) {}
      if (canUse === false) reasons.push('SKILL_CAN_USE_FALSE');

      let inRange = targetId == null;
      if (targetId != null) {
        const rawTarget = options.allowDeadTarget === true
          ? this.playerReference(targetId, { allowDead: true })
          : this.entityReference(targetId);
        if (!rawTarget) {
          inRange = false;
          reasons.push('SKILL_TARGET_UNAVAILABLE');
        } else {
          const inRangeFn = this._resolveFunction('is_in_range');
          let observed = null;
          try { if (inRangeFn) observed = inRangeFn.fn.call(inRangeFn.owner, rawTarget, definition.id) === true; } catch (_) {}
          if (observed == null) {
            const cp = this._position(character);
            const tp = this._position(rawTarget);
            let allowedRange = definition.range;
            if (allowedRange == null && c.range != null) {
              allowedRange = c.range * (definition.rangeMultiplier == null ? 1 : definition.rangeMultiplier)
                + (definition.rangeBonus == null ? 0 : definition.rangeBonus);
            }
            observed = cp.x != null && cp.y != null && tp.x != null && tp.y != null && allowedRange != null
              ? Math.hypot(cp.x - tp.x, cp.y - tp.y) <= allowedRange
              : false;
          }
          inRange = observed;
          if (!inRange) reasons.push('SKILL_OUT_OF_RANGE');
        }
      }

      let activeCondition = false;
      try {
        activeCondition = !!(character.s && character.s[definition.id]);
      } catch (_) {}

      return {
        available: true,
        allowed: reasons.length === 0,
        skillId: definition.id,
        definition,
        reasons,
        cooldown,
        canUse,
        inRange,
        activeCondition
      };
    }

    combatReadiness(targetId) {
      const character = this._character();
      const raw = this.entityReference(targetId);
      if (!character || !raw) {
        return {
          available: false,
          targetAvailable: !!raw,
          canAttack: false,
          inRange: false,
          cooldown: null,
          source: 'unavailable'
        };
      }

      const canAttackFn = this._resolveFunction('can_attack');
      const inRangeFn = this._resolveFunction('is_in_range');
      const cooldownFn = this._resolveFunction('is_on_cooldown');

      let canAttack = null;
      let inRange = null;
      let cooldown = null;

      try { if (canAttackFn) canAttack = canAttackFn.fn.call(canAttackFn.owner, raw) === true; } catch (_) {}
      try { if (inRangeFn) inRange = inRangeFn.fn.call(inRangeFn.owner, raw, 'attack') === true; } catch (_) {}
      try { if (cooldownFn) cooldown = cooldownFn.fn.call(cooldownFn.owner, 'attack') === true; } catch (_) {}

      if (inRange == null) {
        const cp = this._position(character);
        const tp = this._position(raw);
        const range = finite(character.range);
        if (cp.x != null && cp.y != null && tp.x != null && tp.y != null && range != null) {
          inRange = Math.hypot(cp.x - tp.x, cp.y - tp.y) <= range;
        } else {
          inRange = false;
        }
      }
      if (cooldown == null) cooldown = false;
      if (canAttack == null) {
        canAttack = !safeBoolean(character.rip) && inRange && !cooldown;
      }

      return {
        available: true,
        targetAvailable: true,
        canAttack,
        inRange,
        cooldown,
        source: canAttackFn || inRangeFn || cooldownFn ? 'adventure-land-api' : 'adapter-fallback'
      };
    }

    _server() {
      const region = this._read('server_region');
      const identifier = this._read('server_identifier');
      const server = this._read('server');
      return {
        region: region == null ? null : cleanText(region, 60),
        identifier: identifier == null ? null : cleanText(identifier, 60),
        name: server && server.name ? cleanText(server.name, 120) : null
      };
    }

    snapshot() {
      const character = this._character();
      if (!character || !character.name) {
        const unavailable = {
          schemaVersion: 1,
          observedAt: new Date().toISOString(),
          available: false,
          reason: 'CHARACTER_UNAVAILABLE',
          character: null,
          target: null,
          server: this._server(),
          world: { entityCount: 0, monsterCount: 0, playerCount: 0, npcCount: 0 },
          gameData: { available: !!this._read('G'), monstersKnown: 0, mapsKnown: 0 }
        };
        this.lastSnapshot = unavailable;
        return clone(unavailable);
      }

      const pos = this._position(character);
      const targetId = this._targetId(character);
      const directTarget = this._currentTarget();
      const targetRaw = directTarget || this._entityByIdOrName(targetId);
      const target = this._normalizeEntity(targetRaw, character.map || null);
      if (target && pos.x != null && pos.y != null && target.x != null && target.y != null) {
        target.distance = Math.hypot(pos.x - target.x, pos.y - target.y);
      } else if (target) {
        target.distance = null;
      }

      const entityEntries = this._entityEntries();
      const entities = entityEntries.map(row => row.entity);
      let monsterCount = 0;
      let playerCount = 0;
      let npcCount = 0;
      for (const entity of entities) {
        if (entity.player === true) playerCount += 1;
        else if (entity.npc === true || entity.type === 'npc') npcCount += 1;
        else if (entity.mtype || entity.type === 'monster') monsterCount += 1;
      }

      const G = this._gameData();
      const snapshot = {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        available: true,
        reason: null,
        character: {
          name: cleanText(character.name, 120),
          ctype: cleanText(character.ctype || character.type || '', 60).toLowerCase() || null,
          level: finite(character.level),
          map: character.map || null,
          x: pos.x,
          y: pos.y,
          hp: finite(character.hp),
          maxHp: finite(character.max_hp),
          mp: finite(character.mp),
          maxMp: finite(character.max_mp),
          gold: finite(character.gold),
          xp: finite(character.xp),
          attack: finite(character.attack),
          range: finite(character.range),
          speed: finite(character.speed),
          frequency: finite(character.frequency),
          damageType: character.damage_type == null ? null : cleanText(character.damage_type, 60).toLowerCase(),
          moving: safeBoolean(character.moving),
          rip: safeBoolean(character.rip),
          targetId
        },
        target,
        targetResolution: {
          requestedId: targetId,
          resolved: !!target,
          resolvedFrom: directTarget ? directTarget.source : (target ? 'entities' : null),
          entitySourceCount: this._entitySources().length,
          mergedEntityCount: entityEntries.length
        },
        server: this._server(),
        world: {
          entityCount: entities.length,
          monsterCount,
          playerCount,
          npcCount
        },
        gameData: {
          available: !!this._read('G'),
          monstersKnown: G.monsters && typeof G.monsters === 'object' ? Object.keys(G.monsters).length : 0,
          mapsKnown: G.maps && typeof G.maps === 'object' ? Object.keys(G.maps).length : 0,
          itemsKnown: G.items && typeof G.items === 'object' ? Object.keys(G.items).length : 0,
          skillsKnown: G.skills && typeof G.skills === 'object' ? Object.keys(G.skills).length : 0
        }
      };

      this.lastSnapshot = snapshot;
      return clone(snapshot);
    }

    status() {
      return this.snapshot();
    }
  }

  ns.AdventureLandGameAdapter = AdventureLandGameAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
