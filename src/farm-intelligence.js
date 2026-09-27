(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function distance(a, b) {
    if (!a || !b) return null;
    const ax = finite(a.x);
    const ay = finite(a.y);
    const bx = finite(b.x);
    const by = finite(b.y);
    if ([ax, ay, bx, by].some(value => value == null)) return null;
    return Math.hypot(ax - bx, ay - by);
  }

  class FarmIntelligenceController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.combat = options.combat;
      this.farming = options.farming;
      this.movement = options.movement;
      this.party = options.party || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        decisionIntervalMs: Math.max(500, Math.min(5000, Number(options.decisionIntervalMs) || 1000)),
        minHoldMs: Math.max(5000, Math.min(300000, Number(options.minHoldMs) || 45000)),
        switchCooldownMs: Math.max(5000, Math.min(300000, Number(options.switchCooldownMs) || 30000)),
        pingPongWindowMs: Math.max(10000, Math.min(600000, Number(options.pingPongWindowMs) || 120000)),
        switchImprovementRatio: Math.max(0.05, Math.min(1, Number(options.switchImprovementRatio) || 0.18)),
        competitionRadius: Math.max(80, Math.min(1000, Number(options.competitionRadius) || 260)),
        spotBucket: Math.max(80, Math.min(500, Number(options.spotBucket) || 180)),
        arrivalRadius: Math.max(20, Math.min(200, Number(options.arrivalRadius) || 70)),
        visibleAcquireDistance: Math.max(150, Math.min(900, Number(options.visibleAcquireDistance) || 500)),
        densityTarget: Math.max(2, Math.min(20, Number(options.densityTarget) || 6)),
        depletionGraceMs: Math.max(1000, Math.min(30000, Number(options.depletionGraceMs) || 5000)),
        minExpectedHitChance: Math.max(0.05, Math.min(0.95, Number(options.minExpectedHitChance) || 0.25)),
        groupRegroupTriggerDistance: Math.max(90, Math.min(250, Number(options.groupRegroupTriggerDistance) || 120)),
        groupRegroupStopDistance: Math.max(35, Math.min(100, Number(options.groupRegroupStopDistance) || 60)),
        groupHardRegroupDistance: Math.max(150, Math.min(350, Number(options.groupHardRegroupDistance) || 195)),
        groupRetargetDistance: Math.max(20, Math.min(100, Number(options.groupRetargetDistance) || 35)),
        groupRetargetMs: Math.max(700, Math.min(5000, Number(options.groupRetargetMs) || 1400))
      };

      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.session = null;
      this.sequence = 0;
      this.groupPolicy = { leaderName: null, memberNames: [] };
      this.groupMove = null;
      this.currentSelection = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.history = [];
      this.observations = new Map();
      this.suspendedReason = null;
      this.metrics = {
        sessions: 0,
        decisions: 0,
        candidateRows: 0,
        holds: 0,
        switches: 0,
        travelOrders: 0,
        farmingStarts: 0,
        farmingStops: 0,
        depletionEvents: 0,
        respawnsObserved: 0,
        pingPongBlocks: 0,
        ownershipBlocks: 0,
        foreignPartyBlocks: 0,
        unsafeBlocks: 0,
        movementUnknown: 0,
        groupLeaderPlans: 0,
        groupFollowerHolds: 0,
        groupRegroups: 0,
        groupRetargets: 0,
        groupHardRegroups: 0,
        combatUnknownSuspensions: 0
      };
    }

    start(context) {
      this.moduleActive = true;
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('farm-intelligence-loop', () => this.tick(), this.config.decisionIntervalMs, { immediate: true });
      }
      return this.status();
    }

    stop(reason = 'H9_MODULE_STOP') {
      this.moduleActive = false;
      this.stopAutonomy(reason);
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    startAutonomy(options = {}) {
      if (!this.moduleActive) return { accepted: false, reason: 'H9_MODULE_NOT_ACTIVE', status: this.status() };
      if (this.session && this.session.enabled) return { accepted: false, reason: 'H9_SESSION_ALREADY_ACTIVE', status: this.status() };

      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) return { accepted: false, reason: 'CHARACTER_UNAVAILABLE', status: this.status() };
      if (character.rip === true) return { accepted: false, reason: 'CHARACTER_DEAD', status: this.status() };
      if (String(character.ctype || '').toLowerCase() === 'merchant') {
        return { accepted: false, reason: 'H9_UNSUPPORTED_CLASS:merchant', status: this.status() };
      }

      const farm = this.farming && typeof this.farming.status === 'function' ? this.farming.status() : null;
      if (farm && farm.active && farm.session && String(farm.session.owner || '') !== 'farm-intelligence-h9') {
        this.metrics.ownershipBlocks += 1;
        return { accepted: false, reason: 'H9_FARMING_ALREADY_OWNED', farming: farm, status: this.status() };
      }

      const id = 'farm-intel-' + (++this.sequence);
      this.session = {
        id,
        enabled: true,
        owner: cleanText(options.owner || 'farm-intelligence-h9', 80) || 'farm-intelligence-h9',
        preferredTypes: Array.isArray(options.preferredTypes)
          ? options.preferredTypes.map(value => cleanText(value, 120)).filter(Boolean)
          : [],
        excludedTypes: Array.isArray(options.excludedTypes)
          ? options.excludedTypes.map(value => cleanText(value, 120)).filter(Boolean)
          : [],
        allowTravel: options.allowTravel !== false,
        groupLeaderName: cleanText(options.groupLeaderName || this.groupPolicy.leaderName || '', 120) || null,
        groupMemberNames: [...new Set((Array.isArray(options.groupMemberNames) ? options.groupMemberNames : this.groupPolicy.memberNames)
          .map(value => cleanText(value, 120)).filter(Boolean))].sort(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        reason: null
      };
      this.groupPolicy = {
        leaderName: this.session.groupLeaderName,
        memberNames: this.session.groupMemberNames.slice()
      };
      this.groupMove = null;
      this.currentSelection = null;
      this.lastPlan = null;
      this.lastAction = null;
      this.history = [];
      this.suspendedReason = null;
      this.metrics.sessions += 1;
      const tick = this.tick();
      return { accepted: true, session: clone(this.session), tick };
    }

    stopAutonomy(reason = 'H9_SESSION_STOP') {
      const session = this.session;
      this._stopOwnedFarming(reason);
      this._stopOwnedMovement(reason);
      if (!session) return { stopped: false, reason: 'NO_H9_SESSION' };
      session.enabled = false;
      session.reason = cleanText(reason, 240);
      session.stoppedAt = new Date().toISOString();
      const ended = clone(session);
      this.session = null;
      this.currentSelection = null;
      this.groupMove = null;
      this.suspendedReason = null;
      return { stopped: true, session: ended };
    }

    configureGroup(options = {}) {
      const leaderName = cleanText(options.groupLeaderName || '', 120) || null;
      const memberNames = [...new Set((Array.isArray(options.groupMemberNames) ? options.groupMemberNames : [])
        .map(value => cleanText(value, 120)).filter(Boolean))].sort();
      this.groupPolicy = { leaderName, memberNames };
      if (this.session && this.session.enabled) {
        this.session.groupLeaderName = leaderName;
        this.session.groupMemberNames = memberNames.slice();
      }
      return clone(this.groupPolicy);
    }

    suspendFromCombatUnknown(reason = 'ATTACK_OUTCOME_UNCONFIRMED', details = null) {
      if (!this.session || !this.session.enabled) return { suspended: false, reason: 'H9_AUTONOMY_NOT_ACTIVE' };
      this.suspendedReason = 'H9_COMBAT_UNKNOWN';
      this.metrics.combatUnknownSuspensions += 1;
      this._stopOwnedMovement('H9_COMBAT_UNKNOWN');
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'SUSPEND',
        reason: this.suspendedReason,
        combatReason: cleanText(reason, 240),
        details: details == null ? null : clone(details)
      };
      return { suspended: true, reason: this.suspendedReason };
    }

    _partyOwnedNames(characterName) {
      const names = new Set();
      if (characterName) names.add(String(characterName));
      if (!this.party || typeof this.party.status !== 'function') return names;
      const party = this.party.status();
      for (const name of party && party.party && party.party.ownedMemberNames || []) names.add(String(name));
      return names;
    }

    _safeVisible(character) {
      if (!this.combat || typeof this.combat.safeCandidates !== 'function') return [];
      return this.combat.safeCandidates({
        maxAcquireDistance: this.config.visibleAcquireDistance,
        maxAttackToHpRatio: 0.08,
        allowContested: false,
        allowUnknownAttack: false,
        partyAssist: true
      }).filter(row => row && (!row.map || !character.map || String(row.map) === String(character.map)));
    }

    _foreignPlayers(character) {
      if (!this.game || typeof this.game.visiblePlayers !== 'function') return [];
      const owned = this._partyOwnedNames(character && character.name);
      return this.game.visiblePlayers({}).filter(player => {
        const name = player && (player.name || player.id);
        return name && !owned.has(String(name));
      });
    }

    _clusterSafeVisible(character) {
      const safe = this._safeVisible(character);
      const groups = new Map();
      const bucket = this.config.spotBucket;
      for (const monster of safe) {
        const mtype = cleanText(monster.mtype || monster.name || '', 120);
        if (!mtype) continue;
        const bx = monster.x == null ? 0 : Math.round(Number(monster.x) / bucket);
        const by = monster.y == null ? 0 : Math.round(Number(monster.y) / bucket);
        const key = String(character.map || 'unknown') + ':' + mtype + ':visible:' + bx + ':' + by;
        if (!groups.has(key)) groups.set(key, { key, map: character.map || null, mtype, rows: [] });
        groups.get(key).rows.push(monster);
      }

      const players = this._foreignPlayers(character);
      return [...groups.values()].map(group => {
        const coords = group.rows.filter(row => finite(row.x) != null && finite(row.y) != null);
        const x = coords.length ? coords.reduce((sum, row) => sum + Number(row.x), 0) / coords.length : finite(character.x);
        const y = coords.length ? coords.reduce((sum, row) => sum + Number(row.y), 0) / coords.length : finite(character.y);
        const competitors = players.filter(player => {
          const d = distance({ x, y }, player);
          return d != null && d <= this.config.competitionRadius;
        }).length;
        return {
          key: group.key,
          source: 'LIVE_SAFE_CLUSTER',
          map: group.map,
          mtype: group.mtype,
          x,
          y,
          visibleSafeCount: group.rows.length,
          spawnCount: null,
          competitors,
          averageDistance: group.rows.reduce((sum, row) => sum + (finite(row.distance) || 0), 0) / Math.max(1, group.rows.length),
          aggregateAttack: group.rows.reduce((sum, row) => sum + (finite(row.attack) || 0), 0),
          definition: this.game && typeof this.game.monsterDefinition === 'function'
            ? this.game.monsterDefinition(group.mtype)
            : null
        };
      });
    }

    _catalogCandidates(character, liveRows) {
      if (!this.game || typeof this.game.farmSpotCatalog !== 'function') return [];
      const catalog = this.game.farmSpotCatalog({ map: character.map, currentOnly: true });
      const players = this._foreignPlayers(character);
      return catalog.map(spot => {
        const duplicate = liveRows.some(row => row.mtype === spot.mtype && distance(row, spot) != null && distance(row, spot) <= this.config.spotBucket * 1.25);
        if (duplicate) return null;
        const competitors = players.filter(player => {
          const d = distance(spot, player);
          return d != null && d <= this.config.competitionRadius;
        }).length;
        return {
          key: 'catalog:' + String(spot.key),
          source: 'LIVE_G_MAP_SPAWN',
          map: spot.map,
          mtype: spot.mtype,
          x: spot.x,
          y: spot.y,
          visibleSafeCount: 0,
          spawnCount: finite(spot.count),
          respawn: finite(spot.respawn),
          competitors,
          averageDistance: distance(character, spot),
          aggregateAttack: null,
          definition: spot.definition || (this.game.monsterDefinition && this.game.monsterDefinition(spot.mtype))
        };
      }).filter(Boolean);
    }

    _observeCandidates(rows) {
      const now = this.now();
      const seen = new Set();
      for (const row of rows) {
        seen.add(row.key);
        const prior = this.observations.get(row.key) || {
          key: row.key,
          mtype: row.mtype,
          map: row.map,
          lastSeenAtMs: null,
          lastCount: 0,
          depletedAtMs: null,
          observedRespawnMs: null
        };
        const count = Number(row.visibleSafeCount || 0);
        if (prior.lastCount > 0 && count === 0 && prior.depletedAtMs == null) {
          prior.depletedAtMs = now;
          this.metrics.depletionEvents += 1;
        }
        if (prior.lastCount === 0 && count > 0 && prior.depletedAtMs != null) {
          prior.observedRespawnMs = Math.max(0, now - prior.depletedAtMs);
          prior.depletedAtMs = null;
          this.metrics.respawnsObserved += 1;
        }
        if (count > 0) prior.lastSeenAtMs = now;
        prior.lastCount = count;
        this.observations.set(row.key, prior);
        row.observation = clone(prior);
      }

      if (this.currentSelection && !seen.has(this.currentSelection.key)) {
        const prior = this.observations.get(this.currentSelection.key);
        if (prior && prior.lastCount > 0) {
          prior.lastCount = 0;
          if (prior.depletedAtMs == null) {
            prior.depletedAtMs = now;
            this.metrics.depletionEvents += 1;
          }
          this.observations.set(prior.key, prior);
        }
      }
    }

    _damageType(character) {
      const live = cleanText(character && (character.damageType || character.damage_type) || '', 60).toLowerCase();
      if (live) return live;
      const ctype = cleanText(character && character.ctype || '', 60).toLowerCase();
      if (ctype === 'mage' || ctype === 'priest') return 'magical';
      if (['warrior', 'ranger', 'rogue', 'paladin'].includes(ctype)) return 'physical';
      return null;
    }

    _expectedHitChance(character, candidate) {
      const definition = candidate && candidate.definition || {};
      const damageType = this._damageType(character);
      const avoidance = Math.max(0, Math.min(100, finite(definition.avoidance) || 0));
      let chance = 1 - avoidance / 100;
      if (damageType === 'physical') {
        const evasion = Math.max(0, Math.min(100, finite(definition.evasion) || 0));
        chance *= 1 - evasion / 100;
      }
      return clamp(chance);
    }

    _rawMetrics(character, candidate) {
      const definition = candidate.definition || {};
      const attack = Math.max(1, finite(character.attack) || 1);
      const frequency = Math.max(0.1, finite(character.frequency) || 1);
      const expectedHitChance = candidate.expectedHitChance == null
        ? this._expectedHitChance(character, candidate)
        : clamp(candidate.expectedHitChance);
      const dps = attack * frequency * expectedHitChance;
      const hp = finite(definition.hp);
      const killSeconds = hp != null && hp > 0 ? Math.max(0.25, hp / dps) : null;
      const xp = Math.max(0, finite(definition.xp) || 0);
      const gold = Math.max(0, finite(definition.gold) || 0);
      const dropSignal = Math.max(0, finite(definition.dropSignal) || 0);
      const visible = Math.max(0, Number(candidate.visibleSafeCount) || 0);
      const spawn = Math.max(0, finite(candidate.spawnCount) || 0);
      const density = visible > 0 ? visible : spawn * 0.55;
      const travelDistance = distance(character, candidate);
      const speed = Math.max(1, finite(character.speed) || 1);
      const travelSeconds = travelDistance == null ? null : travelDistance / speed;
      const observedRespawn = candidate.observation && finite(candidate.observation.observedRespawnMs);
      const declaredRespawn = finite(candidate.respawn);
      const respawnSignal = observedRespawn != null
        ? 1 / (1 + observedRespawn / 30000)
        : declaredRespawn != null
          ? 1 / (1 + Math.max(0, declaredRespawn) / 30)
          : 0.5;
      return {
        xpPerSecond: killSeconds == null ? 0 : xp / killSeconds,
        goldPerSecond: killSeconds == null ? 0 : gold / killSeconds,
        dropSignal,
        expectedHitChance,
        density,
        travelSeconds: travelSeconds == null ? 999 : travelSeconds,
        respawnSignal,
        competitionSignal: 1 / (1 + Math.max(0, Number(candidate.competitors) || 0)),
        safetyConfidence: visible > 0 ? 1 : 0.55
      };
    }

    _scoreCandidates(character, candidates) {
      const rows = candidates.map(candidate => ({ ...candidate, raw: this._rawMetrics(character, candidate) }));
      const max = name => Math.max(0.000001, ...rows.map(row => Number(row.raw[name]) || 0));
      const xpMax = max('xpPerSecond');
      const goldMax = max('goldPerSecond');
      const dropMax = max('dropSignal');
      const densityMax = max('density');

      for (const row of rows) {
        const components = {
          xp: clamp(row.raw.xpPerSecond / xpMax),
          gold: clamp(row.raw.goldPerSecond / goldMax),
          drops: dropMax <= 0.000001 ? 0.5 : clamp(row.raw.dropSignal / dropMax),
          density: clamp(row.raw.density / Math.max(1, densityMax)),
          travel: 1 / (1 + Math.max(0, row.raw.travelSeconds) / 12),
          respawn: clamp(row.raw.respawnSignal),
          competition: clamp(row.raw.competitionSignal),
          safety: clamp(row.raw.safetyConfidence)
        };
        row.components = components;
        row.score = Number((100 * (
          components.xp * 0.24
          + components.gold * 0.12
          + components.drops * 0.10
          + components.density * 0.20
          + components.travel * 0.10
          + components.respawn * 0.08
          + components.competition * 0.06
          + components.safety * 0.10
        )).toFixed(2));
      }
      rows.sort((a, b) => b.score - a.score || b.visibleSafeCount - a.visibleSafeCount || String(a.key).localeCompare(String(b.key)));
      return rows;
    }

    _filteredCandidates(rows, character) {
      const preferred = new Set(this.session && this.session.preferredTypes || []);
      const excluded = new Set(this.session && this.session.excludedTypes || []);
      return rows.filter(row => {
        if (excluded.has(row.mtype)) return false;
        if (preferred.size && !preferred.has(row.mtype)) return false;
        const expectedHitChance = this._expectedHitChance(character, row);
        row.expectedHitChance = expectedHitChance;
        if (expectedHitChance < this.config.minExpectedHitChance) return false;
        return true;
      });
    }

    plan() {
      this.metrics.decisions += 1;
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) return this._rememberPlan({ state: 'BLOCKED', reason: 'CHARACTER_UNAVAILABLE', candidates: [] });
      if (character.rip === true) return this._rememberPlan({ state: 'BLOCKED', reason: 'CHARACTER_DEAD', candidates: [] });
      if (String(character.ctype || '').toLowerCase() === 'merchant') {
        return this._rememberPlan({ state: 'OBSERVER_ONLY', reason: 'LOGISTICS_ROLE_NO_FARMING', candidates: [] });
      }

      if (this.party && typeof this.party.status === 'function') {
        const party = this.party.status();
        const foreign = party && party.party && Array.isArray(party.party.foreignMemberNames)
          ? party.party.foreignMemberNames.slice()
          : [];
        if (foreign.length) {
          this.metrics.foreignPartyBlocks += 1;
          return this._rememberPlan({
            state: 'BLOCKED',
            reason: 'H9_FOREIGN_PARTY_BLOCK',
            foreign,
            candidates: []
          });
        }
      }

      const live = this._clusterSafeVisible(character);
      const catalog = this._catalogCandidates(character, live);
      let candidates = this._filteredCandidates([...live, ...catalog], character);
      this._observeCandidates(candidates);
      candidates = this._scoreCandidates(character, candidates);
      this.metrics.candidateRows += candidates.length;
      if (!candidates.length) {
        this.metrics.unsafeBlocks += 1;
        return this._rememberPlan({ state: 'NO_CANDIDATE', reason: 'H9_NO_SAFE_OR_KNOWN_CURRENT_MAP_SPOT', candidates: [] });
      }

      const now = this.now();
      let selected = candidates[0];
      let reason = 'H9_BEST_SCORE';
      let switchAllowed = true;
      const current = this.currentSelection
        ? candidates.find(row => row.key === this.currentSelection.key)
        : null;

      if (!current && this.currentSelection) {
        const observation = this.observations.get(this.currentSelection.key);
        const depletedAtMs = observation && finite(observation.depletedAtMs);
        const depletionAgeMs = depletedAtMs == null ? null : Math.max(0, now - depletedAtMs);
        if (depletionAgeMs != null && depletionAgeMs < this.config.depletionGraceMs) {
          this.metrics.holds += 1;
          return this._rememberPlan({
            state: 'WAITING_RESPAWN',
            reason: 'H9_DEPLETION_GRACE',
            selected: null,
            candidates: candidates.slice(0, 12),
            switchAllowed: false,
            currentKey: this.currentSelection.key,
            depletionAgeMs,
            depletionGraceMs: this.config.depletionGraceMs
          });
        }

        const recentPrevious = this.history.length >= 2 ? this.history[this.history.length - 2] : null;
        const returnPingPong = recentPrevious
          && recentPrevious.key === selected.key
          && now - Number(recentPrevious.atMs || 0) <= this.config.pingPongWindowMs;
        if (returnPingPong) {
          const baselineScore = Number(this.currentSelection.score || 0);
          const improvement = (Number(selected.score || 0) - baselineScore) / Math.max(1, baselineScore);
          if (improvement < this.config.switchImprovementRatio * 2) {
            const alternative = candidates.find(row => row.key !== recentPrevious.key);
            this.metrics.pingPongBlocks += 1;
            this.metrics.holds += 1;
            if (alternative) {
              selected = alternative;
              reason = 'H9_ANTI_PINGPONG_REROUTE';
            } else {
              return this._rememberPlan({
                state: 'WAITING_RESPAWN',
                reason: 'H9_ANTI_PINGPONG',
                selected: null,
                candidates: candidates.slice(0, 12),
                switchAllowed: false,
                currentKey: this.currentSelection.key
              });
            }
          }
        }
      }

      if (current && selected.key !== current.key) {
        const heldMs = Math.max(0, now - Number(this.currentSelection.selectedAtMs || 0));
        const sinceSwitch = Math.max(0, now - Number(this.currentSelection.lastSwitchAtMs || this.currentSelection.selectedAtMs || 0));
        const improvement = (selected.score - current.score) / Math.max(1, current.score);
        const recentPrevious = this.history.length >= 2 ? this.history[this.history.length - 2] : null;
        const pingPong = recentPrevious
          && recentPrevious.key === selected.key
          && now - Number(recentPrevious.atMs || 0) <= this.config.pingPongWindowMs;

        if (heldMs < this.config.minHoldMs) {
          selected = current;
          reason = 'H9_HOLD_MIN_DURATION';
          switchAllowed = false;
          this.metrics.holds += 1;
        } else if (sinceSwitch < this.config.switchCooldownMs) {
          selected = current;
          reason = 'H9_SWITCH_COOLDOWN';
          switchAllowed = false;
          this.metrics.holds += 1;
        } else if (pingPong && improvement < this.config.switchImprovementRatio * 2) {
          selected = current;
          reason = 'H9_ANTI_PINGPONG';
          switchAllowed = false;
          this.metrics.holds += 1;
          this.metrics.pingPongBlocks += 1;
        } else if (improvement < this.config.switchImprovementRatio) {
          selected = current;
          reason = 'H9_IMPROVEMENT_TOO_SMALL';
          switchAllowed = false;
          this.metrics.holds += 1;
        }
      }

      return this._rememberPlan({
        state: selected.visibleSafeCount > 0 ? 'FARM_READY' : 'TRAVEL_RECOMMENDED',
        reason,
        selected,
        candidates: candidates.slice(0, 12),
        switchAllowed,
        currentKey: this.currentSelection && this.currentSelection.key || null
      });
    }

    _rememberPlan(plan) {
      this.lastPlan = { at: new Date().toISOString(), ...clone(plan) };
      return clone(this.lastPlan);
    }

    _movementStatus() {
      return this.movement && typeof this.movement.status === 'function' ? this.movement.status() : null;
    }

    _farmingStatus() {
      return this.farming && typeof this.farming.status === 'function' ? this.farming.status() : null;
    }

    _ownedMovement(status = this._movementStatus()) {
      const order = status && status.activeOrder;
      return !!(order && String(order.owner || '').startsWith('farm-intelligence-h9'));
    }

    _delegatedCombatMovement(status = this._movementStatus(), farmStatus = this._farmingStatus()) {
      const order = status && status.activeOrder;
      if (!order || !this._ownedFarming(farmStatus)) return false;
      return String(order.owner || '').startsWith('combat-h5');
    }

    _ownedFarming(status = this._farmingStatus()) {
      const session = status && status.session;
      return !!(status && status.active && session && String(session.owner || '') === 'farm-intelligence-h9');
    }

    _stopOwnedMovement(reason) {
      const movement = this._movementStatus();
      if (!this._ownedMovement(movement)) return false;
      try { this.movement.cancel(reason); } catch (_) {}
      return true;
    }

    _stopOwnedFarming(reason) {
      const farm = this._farmingStatus();
      if (!this._ownedFarming(farm)) return false;
      try { this.farming.stopSession(reason); } catch (_) {}
      this.metrics.farmingStops += 1;
      return true;
    }

    _suspend(reason) {
      this.suspendedReason = cleanText(reason, 240) || 'H9_SUSPENDED';
      this._stopOwnedFarming(this.suspendedReason);
      this._stopOwnedMovement(this.suspendedReason);
      this.lastAction = { at: new Date().toISOString(), type: 'SUSPEND', reason: this.suspendedReason };
      return { state: 'SUSPENDED', reason: this.suspendedReason };
    }

    _samePhysicalSpot(a, b) {
      if (!a || !b) return false;
      if (a.map && b.map && String(a.map) !== String(b.map)) return false;
      if (a.mtype && b.mtype && String(a.mtype) !== String(b.mtype)) return false;
      const d = distance(a, b);
      return d != null && d <= this.config.spotBucket * 1.25;
    }

    _recordSelection(candidate, reason) {
      const now = this.now();
      const previous = this.currentSelection;
      const changed = !!(previous && !this._samePhysicalSpot(previous, candidate));
      this.currentSelection = {
        key: candidate.key,
        map: candidate.map,
        mtype: candidate.mtype,
        x: candidate.x,
        y: candidate.y,
        score: candidate.score,
        source: candidate.source,
        selectedAt: new Date().toISOString(),
        selectedAtMs: changed || !previous ? now : previous.selectedAtMs,
        lastSwitchAtMs: changed ? now : (previous && previous.lastSwitchAtMs || now),
        reason
      };
      if (changed) this.metrics.switches += 1;
      if (!previous || changed) {
        this.history.push({ key: candidate.key, mtype: candidate.mtype, score: candidate.score, atMs: now, reason });
        if (this.history.length > 12) this.history.shift();
      }
      return changed;
    }

    _groupContext(character) {
      if (!this.session || !this.session.enabled || !character || !character.name) return { enabled: false };
      const leaderName = cleanText(this.session.groupLeaderName || '', 120) || null;
      const memberNames = Array.isArray(this.session.groupMemberNames) ? this.session.groupMemberNames.map(String) : [];
      const localName = String(character.name);
      if (!leaderName || memberNames.length < 2 || !memberNames.includes(localName) || !memberNames.includes(leaderName)) {
        return { enabled: false };
      }
      let status = null;
      try { status = this.party && typeof this.party.status === 'function' ? this.party.status() : null; } catch (_) {}
      const party = status && status.party || null;
      const members = party && Array.isArray(party.ownedMembers) ? party.ownedMembers : [];
      const local = members.find(row => row && String(row.name) === localName) || null;
      const leader = members.find(row => row && String(row.name) === leaderName) || null;
      const d = local && leader ? distance(local, leader) : null;
      return {
        enabled: true,
        localName,
        leaderName,
        memberNames,
        isLeader: localName === leaderName,
        local,
        leader,
        distance: d,
        sameMap: !!(local && leader && (!local.map || !leader.map || String(local.map) === String(leader.map))),
        focusTargetId: this.party && typeof this.party.preferredTargetId === 'function' ? this.party.preferredTargetId() : null
      };
    }

    _ensureFollowerFarm(group) {
      const farm = this._farmingStatus();
      if (this._ownedFarming(farm)) return { state: 'FARMING', reason: 'H9_GROUP_FOLLOWER_FARM_ACTIVE' };
      if (farm && farm.active) {
        this.metrics.ownershipBlocks += 1;
        return this._suspend('H9_FOREIGN_FARMING_OWNERSHIP');
      }
      const started = this.farming.startSession({
        owner: 'farm-intelligence-h9',
        monsterType: null,
        partyAssist: true,
        leaderOwnedPulls: true,
        groupLeaderName: group.leaderName,
        groupMemberNames: group.memberNames,
        maxAcquireDistance: this.config.visibleAcquireDistance
      });
      if (!started || started.accepted !== true) {
        return { state: 'WAITING', reason: started && started.reason || 'H9_GROUP_FOLLOWER_FARM_START_REJECTED' };
      }
      this.metrics.farmingStarts += 1;
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'GROUP_FOLLOWER_FARM_START',
        leaderName: group.leaderName,
        groupMemberNames: group.memberNames.slice()
      };
      return { state: 'FARMING', reason: 'H9_GROUP_FOLLOWER_FARM_STARTED' };
    }

    _tickGroupFollower(character, group) {
      const movement = this._movementStatus();
      if (movement && movement.lastOrder
        && String(movement.lastOrder.owner || '').startsWith('farm-intelligence-h9')
        && ['UNKNOWN', 'FAILED_SAFE'].includes(String(movement.lastOrder.state || ''))) {
        this.metrics.movementUnknown += 1;
        return this._suspend('H9_MOVEMENT_' + String(movement.lastOrder.state));
      }
      if (!group.local || !group.leader || !group.sameMap || group.distance == null) {
        this._stopOwnedFarming('H9_GROUP_LEADER_POSITION_UNAVAILABLE');
        return { state: 'WAITING', reason: 'H9_GROUP_LEADER_POSITION_UNAVAILABLE', leaderName: group.leaderName };
      }

      const farm = this._farmingStatus();
      const combat = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
      const activeEncounter = !!(this._ownedFarming(farm) && combat && combat.active);
      const d = Number(group.distance);

      if (activeEncounter && d <= this.config.groupHardRegroupDistance) {
        this.metrics.groupFollowerHolds += 1;
        return {
          state: 'FARMING',
          reason: 'H9_GROUP_FORMATION_HOLD',
          leaderName: group.leaderName,
          distance: d,
          hardRegroupDistance: this.config.groupHardRegroupDistance
        };
      }

      const activeOwnMove = this._ownedMovement(movement);
      if (activeOwnMove) {
        const destination = movement.activeOrder && movement.activeOrder.destination || null;
        const shifted = destination && group.leader ? distance(destination, group.leader) : null;
        const moveAge = this.groupMove ? this.now() - Number(this.groupMove.atMs || 0) : 0;
        if (shifted != null && shifted >= this.config.groupRetargetDistance && moveAge >= this.config.groupRetargetMs) {
          const target = { map: group.leader.map || character.map, x: group.leader.x, y: group.leader.y };
          const retarget = this.movement.retarget(target, {
            owner: 'farm-intelligence-h9-group-regroup',
            arrivalRadius: this.config.groupRegroupStopDistance
          });
          if (retarget && retarget.accepted) {
            this.groupMove = { atMs: this.now(), destination: clone(target) };
            this.metrics.groupRetargets += 1;
          }
        }
        if (d <= this.config.groupRegroupStopDistance) {
          try { this.movement.cancel('H9_GROUP_REJOINED_FORMATION'); } catch (_) {}
          this.groupMove = null;
        } else {
          return { state: 'TRAVELLING', reason: 'H9_GROUP_REGROUP_IN_PROGRESS', leaderName: group.leaderName, distance: d };
        }
      }

      if (d >= this.config.groupRegroupTriggerDistance || activeEncounter && d > this.config.groupHardRegroupDistance) {
        if (activeEncounter && d > this.config.groupHardRegroupDistance) this.metrics.groupHardRegroups += 1;
        this._stopOwnedFarming('H9_GROUP_REGROUP');
        const afterStopMovement = this._movementStatus();
        if (afterStopMovement && afterStopMovement.activeOrder && !this._ownedMovement(afterStopMovement)) {
          this.metrics.ownershipBlocks += 1;
          return { state: 'WAITING', reason: 'H9_GROUP_REGROUP_MOVEMENT_BUSY', distance: d };
        }
        const destination = { map: group.leader.map || character.map, x: group.leader.x, y: group.leader.y };
        const move = this.movement.smartMove(destination, {
          owner: 'farm-intelligence-h9-group-regroup',
          arrivalRadius: this.config.groupRegroupStopDistance
        });
        if (!move || move.accepted !== true) {
          return { state: 'WAITING', reason: move && move.reason || 'H9_GROUP_REGROUP_REJECTED', distance: d };
        }
        this.groupMove = { atMs: this.now(), destination: clone(destination) };
        this.metrics.groupRegroups += 1;
        this.lastAction = { at: new Date().toISOString(), type: 'GROUP_REGROUP', leaderName: group.leaderName, destination, distance: d };
        return { state: 'TRAVELLING', reason: 'H9_GROUP_REGROUP_STARTED', leaderName: group.leaderName, distance: d, destination };
      }

      return this._ensureFollowerFarm(group);
    }

    _apply(plan) {
      if (!this.session || !this.session.enabled) return { state: 'IDLE', reason: 'H9_AUTONOMY_NOT_ACTIVE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      if (plan && plan.state === 'BLOCKED') {
        return this._suspend(plan.reason || 'H9_PLAN_BLOCKED');
      }
      if (!plan || !plan.selected) return { state: plan && plan.state || 'BLOCKED', reason: plan && plan.reason || 'H9_PLAN_UNAVAILABLE' };

      const game = this.game.snapshot();
      const character = game && game.character;
      if (!character) return this._suspend('CHARACTER_UNAVAILABLE');

      const movement = this._movementStatus();
      if (movement && movement.lastOrder && String(movement.lastOrder.owner || '') === 'farm-intelligence-h9'
        && ['UNKNOWN', 'FAILED_SAFE'].includes(String(movement.lastOrder.state || ''))) {
        this.metrics.movementUnknown += 1;
        return this._suspend('H9_MOVEMENT_' + String(movement.lastOrder.state));
      }
      if (this._ownedMovement(movement)) {
        return { state: 'TRAVELLING', reason: 'H9_TRAVEL_IN_PROGRESS', order: clone(movement.activeOrder) };
      }
      const farmDuringMovement = this._farmingStatus();
      if (this._delegatedCombatMovement(movement, farmDuringMovement)) {
        return {
          state: 'FARMING',
          reason: 'H9_DELEGATED_COMBAT_MOVEMENT',
          order: clone(movement.activeOrder),
          monsterType: farmDuringMovement.session && farmDuringMovement.session.monsterType || null
        };
      }
      if (movement && movement.activeOrder) {
        this.metrics.ownershipBlocks += 1;
        return this._suspend('H9_FOREIGN_MOVEMENT_OWNERSHIP');
      }

      const candidate = plan.selected;
      const changed = this._recordSelection(candidate, plan.reason);
      const d = distance(character, candidate);
      const needsTravel = candidate.map && character.map && String(candidate.map) !== String(character.map)
        || (d != null && d > this.config.arrivalRadius);

      if (needsTravel && this.session.allowTravel) {
        this._stopOwnedFarming('H9_SPOT_TRAVEL');
        const activeFarm = this._farmingStatus();
        if (activeFarm && activeFarm.active && !this._ownedFarming(activeFarm)) {
          this.metrics.ownershipBlocks += 1;
          return this._suspend('H9_FOREIGN_FARMING_OWNERSHIP');
        }
        const destination = { map: candidate.map || character.map, x: candidate.x, y: candidate.y };
        const move = this.movement.smartMove(destination, {
          owner: 'farm-intelligence-h9',
          arrivalRadius: this.config.arrivalRadius
        });
        if (!move || move.accepted !== true) {
          if (move && String(move.reason || '').includes('UNKNOWN')) {
            this.metrics.movementUnknown += 1;
            return this._suspend(move.reason);
          }
          this.lastAction = { at: new Date().toISOString(), type: 'TRAVEL_REJECTED', candidate: candidate.key, result: clone(move) };
          return { state: 'WAITING', reason: move && move.reason || 'H9_TRAVEL_REJECTED', result: clone(move) };
        }
        this.metrics.travelOrders += 1;
        this.lastAction = { at: new Date().toISOString(), type: 'TRAVEL', candidate: candidate.key, destination, changed };
        return { state: 'TRAVELLING', reason: 'H9_MOVING_TO_SELECTED_SPOT', destination, changed };
      }

      const farm = this._farmingStatus();
      if (farm && farm.active && !this._ownedFarming(farm)) {
        this.metrics.ownershipBlocks += 1;
        return this._suspend('H9_FOREIGN_FARMING_OWNERSHIP');
      }
      if (this._ownedFarming(farm)) {
        const currentType = farm.session && farm.session.monsterType || null;
        if (!changed && String(currentType || '') === String(candidate.mtype || '')) {
          this.lastAction = { at: new Date().toISOString(), type: 'HOLD_FARM', candidate: candidate.key, monsterType: candidate.mtype };
          return { state: 'FARMING', reason: 'H9_EXISTING_FARM_MATCHES', monsterType: candidate.mtype };
        }
        this._stopOwnedFarming('H9_SWITCH_FARM_TARGET');
      }

      const group = this._groupContext(character);
      if (group.enabled && group.isLeader) this.metrics.groupLeaderPlans += 1;
      const start = this.farming.startSession({
        owner: 'farm-intelligence-h9',
        monsterType: candidate.mtype,
        partyAssist: true,
        leaderOwnedPulls: group.enabled,
        groupLeaderName: group.enabled ? group.leaderName : null,
        groupMemberNames: group.enabled ? group.memberNames : [],
        maxAcquireDistance: this.config.visibleAcquireDistance
      });
      if (!start || start.accepted !== true) {
        this.lastAction = { at: new Date().toISOString(), type: 'FARM_START_REJECTED', candidate: candidate.key, result: clone(start) };
        return { state: 'WAITING', reason: start && start.reason || 'H9_FARM_START_REJECTED', result: clone(start) };
      }
      this.metrics.farmingStarts += 1;
      this.lastAction = { at: new Date().toISOString(), type: 'FARM_START', candidate: candidate.key, monsterType: candidate.mtype, changed };
      return { state: 'FARMING', reason: 'H9_SELECTED_FARM_STARTED', monsterType: candidate.mtype, changed };
    }

    tick() {
      if (this.heartbeat) {
        try {
          this.heartbeat({
            phase: 'farm-intelligence',
            active: !!(this.session && this.session.enabled),
            selection: this.currentSelection && this.currentSelection.key || null
          });
        } catch (_) {}
      }
      if (!this.moduleActive || !this.session || !this.session.enabled) return { state: 'IDLE' };
      if (this.suspendedReason) return { state: 'SUSPENDED', reason: this.suspendedReason };
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const character = game && game.character;
      if (!game || !game.available || !character) return this._suspend('CHARACTER_UNAVAILABLE');
      const group = this._groupContext(character);
      if (group.enabled && !group.isLeader) return this._tickGroupFollower(character, group);
      const plan = this.plan();
      return this._apply(plan);
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        active: !!(this.session && this.session.enabled),
        session: clone(this.session),
        suspended: !!this.suspendedReason,
        suspendedReason: this.suspendedReason,
        currentSelection: clone(this.currentSelection),
        lastPlan: clone(this.lastPlan),
        lastAction: clone(this.lastAction),
        history: clone(this.history),
        observations: [...this.observations.values()].slice(-20).map(clone),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.FarmIntelligenceController = FarmIntelligenceController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
