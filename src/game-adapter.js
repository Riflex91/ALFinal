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
        mtype: entity.mtype == null ? null : cleanText(entity.mtype, 120),
        player: safeBoolean(entity.player),
        npc: safeBoolean(entity.npc) || entity.type === 'npc',
        map: entity.map || characterMap || null,
        x: pos.x,
        y: pos.y,
        hp: finite(entity.hp),
        maxHp: finite(entity.max_hp),
        targetId: entity.target == null ? null : String(entity.target),
        dead: safeBoolean(entity.dead) || safeBoolean(entity.rip)
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
          range: finite(character.range),
          speed: finite(character.speed),
          frequency: finite(character.frequency),
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
