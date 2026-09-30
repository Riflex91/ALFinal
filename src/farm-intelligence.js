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

  function maxPairDistance(members = []) {
    if (!Array.isArray(members) || members.length < 2) return 0;
    let max = 0;
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        if (!members[left] || !members[right]
            || !members[left].map || !members[right].map
            || String(members[left].map) !== String(members[right].map)) return Number.POSITIVE_INFINITY;
        const d = distance(members[left], members[right]);
        if (d == null) return Number.POSITIVE_INFINITY;
        max = Math.max(max, d);
      }
    }
    return max;
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
        groupRegroupTriggerDistance: Math.max(90, Math.min(250, Number(options.groupRegroupTriggerDistance) || 150)),
        groupRegroupStopDistance: Math.max(35, Math.min(100, Number(options.groupRegroupStopDistance) || 70)),
        groupHardRegroupDistance: Math.max(150, Math.min(350, Number(options.groupHardRegroupDistance) || 195)),
        groupRetargetDistance: Math.max(20, Math.min(100, Number(options.groupRetargetDistance) || 75)),
        groupRetargetMs: Math.max(700, Math.min(5000, Number(options.groupRetargetMs) || 2500)),
        groupFollowStep: Math.max(20, Math.min(100, Number(options.groupFollowStep) || 70)),
        groupLeaderRecoveryMaxStep: Math.max(25, Math.min(90, Number(options.groupLeaderRecoveryMaxStep) || 60)),
        groupLeaderRecoveryMinImprovement: Math.max(3, Math.min(40, Number(options.groupLeaderRecoveryMinImprovement) || 6)),
        groupMovementRetryMs: Math.max(500, Math.min(10000, Number(options.groupMovementRetryMs) || 2000))
      };

      this.moduleActive = false;
      this.scope = null;
      this.heartbeat = null;
      this.session = null;
      this.sequence = 0;
      this.groupPolicy = { leaderName: null, memberNames: [] };
      this.groupMove = null;
      this.groupMoveRetryAfterMs = null;
      this.lastTransientMovementFailureOrderId = null;
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
        groupLocalFollows: 0,
        groupRetargets: 0,
        groupHardRegroups: 0,
        groupLeaderHolds: 0,
        groupLeaderRecoveries: 0,
        groupCrossMapRegroups: 0,
        transientMovementRecoveries: 0,
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
      this.groupMoveRetryAfterMs = null;
      this.lastTransientMovementFailureOrderId = null;
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
      this.groupMoveRetryAfterMs = null;
      this.lastTransientMovementFailureOrderId = null;
      this.suspendedReason = null;
      return { stopped: true, session: ended };
    }

    configureGroup(options = {}) {
      const leaderName = cleanText(options.groupLeaderName || '', 120) || null;
      const memberNames = [...new Set((Array.isArray(options.groupMemberNames) ? options.groupMemberNames : [])
        .map(value => cleanText(value, 120)).filter(Boolean))].sort();
      const previous = this.groupPolicy || { leaderName: null, memberNames: [] };
      const previousMembers = Array.isArray(previous.memberNames) ? previous.memberNames.map(String).sort() : [];
      const changed = String(previous.leaderName || '') !== String(leaderName || '')
        || previousMembers.join('|') !== memberNames.join('|');

      this.groupPolicy = { leaderName, memberNames };
      if (this.session && this.session.enabled) {
        this.session.groupLeaderName = leaderName;
        this.session.groupMemberNames = memberNames.slice();
      }

      const farm = this._farmingStatus();
      if (changed && this._ownedFarming(farm) && this.farming && typeof this.farming.configureGroup === 'function') {
        this.farming.configureGroup({
          groupLeaderName: leaderName,
          groupMemberNames: memberNames,
          leaderOwnedPulls: true
        });
      }
      return { ...clone(this.groupPolicy), changed };
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
        // G.maps catalog rows and live-safe clusters can describe the same physical
        // spawn with different keys. Treat that representation change as continued
        // presence rather than a depletion event.
        const physicalEquivalent = rows.find(row => this._samePhysicalSpot(this.currentSelection, row)) || null;
        if (!physicalEquivalent) {
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

    _groupPlanningProfiles(character) {
      const localName = cleanText(character && character.name || '', 120);
      const memberNames = this.session && Array.isArray(this.session.groupMemberNames)
        ? [...new Set(this.session.groupMemberNames.map(value => cleanText(value, 120)).filter(Boolean))].sort()
        : [];
      if (!localName || memberNames.length < 2 || !memberNames.includes(localName)) {
        return {
          enabled: false,
          complete: true,
          memberNames: localName ? [localName] : [],
          missingMemberNames: [],
          profiles: character ? [character] : []
        };
      }

      let status = null;
      try { status = this.party && typeof this.party.status === 'function' ? this.party.status() : null; } catch (_) {}
      const party = status && status.party || null;
      const owned = party && Array.isArray(party.ownedMembers) ? party.ownedMembers : [];
      const profiles = [];
      const missingMemberNames = [];

      for (const name of memberNames) {
        const profile = String(name) === String(localName)
          ? character
          : owned.find(row => row && String(row.name) === String(name)) || null;
        if (!profile) {
          missingMemberNames.push(name);
          continue;
        }
        profiles.push(profile);
      }

      return {
        enabled: true,
        complete: missingMemberNames.length === 0 && profiles.length === memberNames.length,
        memberNames,
        missingMemberNames,
        profiles
      };
    }

    _filteredCandidates(rows, character) {
      const preferred = new Set(this.session && this.session.preferredTypes || []);
      const excluded = new Set(this.session && this.session.excludedTypes || []);
      const groupProfiles = this._groupPlanningProfiles(character);
      return rows.filter(row => {
        if (excluded.has(row.mtype)) return false;
        if (preferred.size && !preferred.has(row.mtype)) return false;
        const expectedHitChance = this._expectedHitChance(character, row);
        row.expectedHitChance = expectedHitChance;
        if (expectedHitChance < this.config.minExpectedHitChance) return false;

        if (groupProfiles.enabled) {
          row.groupHitChance = {
            complete: groupProfiles.complete,
            minimum: null,
            members: groupProfiles.profiles.map(profile => ({
              name: cleanText(profile && profile.name || '', 120) || null,
              ctype: cleanText(profile && profile.ctype || '', 60) || null,
              damageType: this._damageType(profile),
              expectedHitChance: this._expectedHitChance(profile, row)
            })),
            missingMemberNames: groupProfiles.missingMemberNames.slice()
          };
          row.groupHitChance.minimum = row.groupHitChance.members.length
            ? Math.min(...row.groupHitChance.members.map(member => member.expectedHitChance))
            : null;

          // H9 is the group-level planner while H5 enforces the same threshold
          // per character. Never elect a farm target that known followers would
          // immediately reject, and fail closed until all farmer profiles are
          // available so the leader cannot strand part of the party watching.
          if (!groupProfiles.complete) return false;
          if (row.groupHitChance.members.some(member => member.expectedHitChance < this.config.minExpectedHitChance)) {
            return false;
          }
        }
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
          || candidates.find(row => this._samePhysicalSpot(this.currentSelection, row))
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

    _groupEncounterActive(group, farmStatus = this._farmingStatus(), combatStatus = null) {
      if (!this._ownedFarming(farmStatus) || !combatStatus || combatStatus.active !== true) return false;
      if (combatStatus.pendingAttack) return true;
      const session = combatStatus.session || null;
      if (session && session.targetId != null) return true;
      const peerHasTarget = !!(group && Array.isArray(group.members)
        && group.members.some(row => row && row.targetId != null));
      if (peerHasTarget) return true;
      const state = cleanText(combatStatus.state || session && session.state || '', 80).toUpperCase();
      return state !== 'WAITING_GROUP_TARGET';
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
      const memberNames = Array.isArray(this.session.groupMemberNames)
        ? [...new Set(this.session.groupMemberNames.map(String))].sort((a, b) => a.localeCompare(b))
        : [];
      const localName = String(character.name);
      if (!leaderName || memberNames.length < 2 || !memberNames.includes(localName) || !memberNames.includes(leaderName)) {
        return { enabled: false };
      }
      let status = null;
      try { status = this.party && typeof this.party.status === 'function' ? this.party.status() : null; } catch (_) {}
      const party = status && status.party || null;
      const owned = party && Array.isArray(party.ownedMembers) ? party.ownedMembers : [];
      const members = memberNames
        .map(name => owned.find(row => row && String(row.name) === String(name)) || null);
      const complete = members.every(row => row && row.map && finite(row.x) != null && finite(row.y) != null);
      const observed = members.filter(Boolean);
      const local = observed.find(row => String(row.name) === localName) || null;
      const leader = observed.find(row => String(row.name) === leaderName) || null;
      const sameMap = complete && members.every(row => String(row.map) === String(leader && leader.map || ''));
      return {
        enabled: true,
        localName,
        leaderName,
        memberNames,
        isLeader: localName === leaderName,
        local,
        leader,
        members: observed,
        complete,
        distance: local && leader ? distance(local, leader) : null,
        maxPairDistance: complete ? maxPairDistance(members) : Number.POSITIVE_INFINITY,
        sameMap,
        focusTargetId: this.party && typeof this.party.preferredTargetId === 'function' ? this.party.preferredTargetId() : null
      };
    }

    _groupFacing(group) {
      if (!group || !group.leader) return 0;
      const focusId = group.focusTargetId == null ? null : String(group.focusTargetId);
      if (focusId && this.game && typeof this.game.visibleMonsters === 'function') {
        let monsters = [];
        try { monsters = this.game.visibleMonsters() || []; } catch (_) {}
        const target = monsters.find(row => row && String(row.id) === focusId);
        if (target && finite(target.x) != null && finite(target.y) != null) {
          return Math.atan2(Number(target.y) - Number(group.leader.y), Number(target.x) - Number(group.leader.x));
        }
      }
      if (this.currentSelection && finite(this.currentSelection.x) != null && finite(this.currentSelection.y) != null) {
        return Math.atan2(Number(this.currentSelection.y) - Number(group.leader.y), Number(this.currentSelection.x) - Number(group.leader.x));
      }
      return 0;
    }

    _formationPoint(group) {
      if (!group || !group.local || !group.leader || group.isLeader) return group && group.leader ? clone(group.leader) : null;
      const followers = group.members
        .filter(row => row && String(row.name) !== String(group.leaderName))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const ctype = String(group.local.ctype || '').toLowerCase();
      const sameClass = followers.filter(row => String(row.ctype || '').toLowerCase() === ctype);
      const classIndex = Math.max(0, sameClass.findIndex(row => String(row.name) === String(group.localName)));
      const side = classIndex % 2 === 0 ? -1 : 1;
      let forward = -25;
      let lateral = side * 28;
      if (ctype === 'warrior' || ctype === 'paladin') { forward = 32; lateral = side * 20; }
      else if (ctype === 'rogue') { forward = 10; lateral = side * 32; }
      else if (ctype === 'priest') { forward = -55; lateral = side * 16; }
      else if (ctype === 'ranger' || ctype === 'mage') { forward = -38; lateral = side * 32; }
      const facing = this._groupFacing(group);
      const fx = Math.cos(facing), fy = Math.sin(facing);
      const lx = -fy, ly = fx;
      return {
        map: group.leader.map,
        x: Number(group.leader.x) + fx * forward + lx * lateral,
        y: Number(group.leader.y) + fy * forward + ly * lateral
      };
    }

    _bestLeaderRecoveryWaypoint(group) {
      if (!group || !group.isLeader || !group.complete || !group.sameMap || !group.leader) return null;
      const followers = group.members.filter(row => row && String(row.name) !== String(group.leaderName));
      if (!followers.length || !Number.isFinite(group.maxPairDistance)
          || group.maxPairDistance <= this.config.groupRegroupTriggerDistance) return null;
      const centroid = {
        x: followers.reduce((sum, row) => sum + Number(row.x), 0) / followers.length,
        y: followers.reduce((sum, row) => sum + Number(row.y), 0) / followers.length
      };
      const farthest = followers.slice().sort((a, b) => distance(group.leader, b) - distance(group.leader, a))[0];
      const targets = [farthest, centroid];
      const candidates = [];
      for (const target of targets) {
        const base = Math.atan2(Number(target.y) - Number(group.leader.y), Number(target.x) - Number(group.leader.x));
        const required = Math.max(8, group.maxPairDistance - this.config.groupRegroupTriggerDistance + this.config.groupLeaderRecoveryMinImprovement);
        const step = Math.min(this.config.groupLeaderRecoveryMaxStep, required);
        for (const offsetDeg of [0, 15, -15, 30, -30, 45, -45, 65, -65, 90, -90]) {
          const angle = base + offsetDeg * Math.PI / 180;
          const point = {
            map: group.leader.map,
            x: Number(group.leader.x) + Math.cos(angle) * step,
            y: Number(group.leader.y) + Math.sin(angle) * step
          };
          let canMove = true;
          try {
            if (this.movement && typeof this.movement._canMoveTo === 'function') canMove = this.movement._canMoveTo(point.x, point.y) !== false;
          } catch (_) { canMove = false; }
          if (!canMove) continue;
          const projected = group.members.map(row => String(row.name) === String(group.leaderName) ? { ...row, ...point } : row);
          const nextMax = maxPairDistance(projected);
          const improvement = group.maxPairDistance - nextMax;
          if (improvement < this.config.groupLeaderRecoveryMinImprovement) continue;
          candidates.push({ ...point, step, offsetDeg, nextMax, improvement });
        }
      }
      return candidates.sort((a, b) => b.improvement - a.improvement || a.nextMax - b.nextMax || Math.abs(a.offsetDeg) - Math.abs(b.offsetDeg))[0] || null;
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
        const failedOrder = movement.lastOrder;
        const failedOrderId = String(failedOrder.id || '');
        if (failedOrder.transient === true) {
          if (!failedOrderId || this.lastTransientMovementFailureOrderId !== failedOrderId) {
            this.metrics.movementUnknown += 1;
            this.metrics.transientMovementRecoveries += 1;
            this.lastTransientMovementFailureOrderId = failedOrderId || null;
            this.groupMove = null;
            this.groupMoveRetryAfterMs = this.now() + this.config.groupMovementRetryMs;
            this.lastAction = {
              at: new Date().toISOString(),
              type: 'GROUP_REGROUP_TRANSIENT_MOVEMENT_FAILURE',
              orderId: failedOrderId || null,
              movementState: String(failedOrder.state || ''),
              movementReason: cleanText(failedOrder.reason || failedOrder.commandError || '', 240) || null,
              retryAfterMs: this.groupMoveRetryAfterMs
            };
          }
          if (this.groupMoveRetryAfterMs && this.now() < this.groupMoveRetryAfterMs) {
            return {
              state: 'WAITING',
              reason: 'H9_GROUP_REGROUP_RETRY_BACKOFF',
              leaderName: group && group.leaderName || null,
              retryAfterMs: this.groupMoveRetryAfterMs
            };
          }
        } else {
          this.metrics.movementUnknown += 1;
          return this._suspend('H9_MOVEMENT_' + String(failedOrder.state));
        }
      }
      if (!group.local || !group.leader || !group.complete) {
        this._stopOwnedFarming('H9_GROUP_LEADER_POSITION_UNAVAILABLE');
        if (this._ownedMovement(movement)) {
          try { this.movement.cancel('H9_GROUP_LEADER_POSITION_UNAVAILABLE'); } catch (_) {}
        }
        this.groupMove = null;
        return { state: 'WAITING', reason: 'H9_GROUP_LEADER_POSITION_UNAVAILABLE', leaderName: group.leaderName };
      }

      const farm = this._farmingStatus();
      const combat = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
      const activeEncounter = this._groupEncounterActive(group, farm, combat);
      const hardDistance = Number(group.maxPairDistance);

      if (!group.sameMap) {
        this._stopOwnedFarming('H9_GROUP_CROSS_MAP_REGROUP');
        const activeOwnMove = this._ownedMovement(movement);
        if (activeOwnMove) return { state: 'TRAVELLING', reason: 'H9_GROUP_CROSS_MAP_REGROUP_IN_PROGRESS', leaderName: group.leaderName };
        const destination = { map: group.leader.map, x: group.leader.x, y: group.leader.y };
        const move = this.movement.smartMove(destination, {
          owner: 'farm-intelligence-h9-group-regroup',
          arrivalRadius: this.config.groupRegroupStopDistance
        });
        if (!move || move.accepted !== true) return { state: 'WAITING', reason: move && move.reason || 'H9_GROUP_CROSS_MAP_REGROUP_REJECTED' };
        this.groupMove = { atMs: this.now(), destination: clone(destination) };
        this.groupMoveRetryAfterMs = null;
        this.metrics.groupRegroups += 1;
        this.metrics.groupCrossMapRegroups += 1;
        return { state: 'TRAVELLING', reason: 'H9_GROUP_CROSS_MAP_REGROUP_STARTED', leaderName: group.leaderName, destination };
      }

      const formation = this._formationPoint(group);
      const formationDistance = formation ? distance(group.local, formation) : group.distance;
      const leaderDistance = Number(group.distance);
      const localRegroupDistance = Math.max(
        Number.isFinite(leaderDistance) ? leaderDistance : 0,
        Number.isFinite(formationDistance) ? formationDistance : 0
      );
      if (activeEncounter && localRegroupDistance <= this.config.groupHardRegroupDistance) {
        this.metrics.groupFollowerHolds += 1;
        return {
          state: 'FARMING',
          reason: 'H9_GROUP_FORMATION_HOLD',
          leaderName: group.leaderName,
          distance: leaderDistance,
          maxPairDistance: hardDistance,
          hardRegroupDistance: this.config.groupHardRegroupDistance
        };
      }

      const activeOwnMove = this._ownedMovement(movement);
      const activeOwner = movement && movement.activeOrder && String(movement.activeOrder.owner || '');
      if (activeOwnMove) {
        if (localRegroupDistance <= this.config.groupRegroupStopDistance) {
          try { this.movement.cancel('H9_GROUP_REJOINED_FORMATION'); } catch (_) {}
          this.groupMove = null;
        } else if (activeOwner === 'farm-intelligence-h9-group-regroup') {
          const destination = movement.activeOrder && movement.activeOrder.destination || null;
          const leaderDestination = { map: group.leader.map, x: group.leader.x, y: group.leader.y };
          const shifted = destination ? distance(destination, leaderDestination) : null;
          const moveAge = this.groupMove ? this.now() - Number(this.groupMove.atMs || 0) : 0;
          if (shifted != null && shifted >= this.config.groupRetargetDistance && moveAge >= this.config.groupRetargetMs) {
            const retarget = this.movement.retarget(leaderDestination, {
              owner: 'farm-intelligence-h9-group-regroup',
              arrivalRadius: this.config.groupRegroupStopDistance,
              transient: true
            });
            if (retarget && retarget.accepted) {
              this.groupMove = { atMs: this.now(), destination: clone(leaderDestination) };
              this.metrics.groupRetargets += 1;
            }
          }
          return { state: 'TRAVELLING', reason: 'H9_GROUP_REGROUP_IN_PROGRESS', leaderName: group.leaderName, distance: leaderDistance, maxPairDistance: hardDistance };
        } else if (activeOwner === 'farm-intelligence-h9-group-follow') {
          return { state: 'TRAVELLING', reason: 'H9_GROUP_LOCAL_FOLLOW_IN_PROGRESS', leaderName: group.leaderName, distance: leaderDistance, maxPairDistance: hardDistance };
        } else {
          return { state: 'TRAVELLING', reason: 'H9_GROUP_FOLLOW_MOVEMENT_IN_PROGRESS', leaderName: group.leaderName, distance: leaderDistance, maxPairDistance: hardDistance };
        }
      }

      // V3 hybrid regroup: cheap local follow for moderate separation,
      // but a stable smart route to the live leader for genuinely large gaps.
      // The all-local strategy needed dozens of 70px moves over 500+ units and
      // kept the whole group waiting for cohesion far too long.
      // Hard separation deliberately bypasses local stepping and enters the
      // stable live-leader smart route below.
      const useSmartRegroup = localRegroupDistance >= this.config.groupHardRegroupDistance;
      if (!useSmartRegroup && formation && localRegroupDistance > this.config.groupRegroupStopDistance) {
        const cx = Number(group.local.x);
        const cy = Number(group.local.y);
        // Formation distance alone is not enough to declare a follower rejoined:
        // the live logs can satisfy the offset while the follower is still outside
        // the leader stop radius, leaving the leader waiting forever for cohesion.
        // Prefer the formation point while it still needs closing; otherwise take
        // one bounded local step toward the live leader.
        const localFollowTarget = formationDistance != null
          && formationDistance > this.config.groupRegroupStopDistance
          ? formation
          : group.leader;
        const angle = Math.atan2(Number(localFollowTarget.y) - cy, Number(localFollowTarget.x) - cx);
        // Size the step against the target we actually chose. When the
        // formation offset is already satisfied, using formationDistance here
        // would produce a zero-length step even though the live leader gap remains.
        const localFollowDistance = distance(group.local, localFollowTarget);
        const travel = Math.max(0, Number(localFollowDistance || 0) - this.config.groupRegroupStopDistance * 0.75);
        const step = Math.min(this.config.groupFollowStep, travel);
        let waypoint = null;
        for (const offsetDeg of [0, 20, -20, 35, -35, 50, -50, 70, -70, 90, -90]) {
          const a = angle + offsetDeg * Math.PI / 180;
          const point = { x: cx + Math.cos(a) * step, y: cy + Math.sin(a) * step };
          let canMove = true;
          try {
            if (this.movement && typeof this.movement._canMoveTo === 'function') canMove = this.movement._canMoveTo(point.x, point.y) !== false;
          } catch (_) { canMove = false; }
          if (canMove) {
            waypoint = point;
            break;
          }
        }
        if (waypoint && step >= 2 && this.movement && typeof this.movement.moveLocal === 'function') {
          if (formationDistance >= this.config.groupRegroupTriggerDistance
              || localRegroupDistance >= this.config.groupRegroupTriggerDistance
              || activeEncounter && localRegroupDistance > this.config.groupHardRegroupDistance) {
            if (activeEncounter && localRegroupDistance > this.config.groupHardRegroupDistance) this.metrics.groupHardRegroups += 1;
            this._stopOwnedFarming('H9_GROUP_REGROUP');
            this.metrics.groupRegroups += 1;
          }
          const move = this.movement.moveLocal(waypoint.x, waypoint.y, {
            owner: 'farm-intelligence-h9-group-follow',
            arrivalRadius: 8,
            transient: true
          });
          if (move && move.accepted === true) {
            this.groupMove = { atMs: this.now(), destination: { map: group.leader.map, x: waypoint.x, y: waypoint.y } };
            this.groupMoveRetryAfterMs = null;
            this.metrics.groupLocalFollows += 1;
            this.lastAction = {
              at: new Date().toISOString(),
              type: formationDistance >= this.config.groupRegroupTriggerDistance ? 'GROUP_LOCAL_REGROUP_STEP' : 'GROUP_LOCAL_FOLLOW',
              leaderName: group.leaderName,
              destination: { map: group.leader.map, x: waypoint.x, y: waypoint.y },
              distance: leaderDistance,
              formationDistance
            };
            return {
              state: 'TRAVELLING',
              reason: formationDistance >= this.config.groupRegroupTriggerDistance
                ? 'H9_GROUP_LOCAL_REGROUP_STARTED'
                : 'H9_GROUP_LOCAL_FOLLOW_STARTED',
              leaderName: group.leaderName,
              distance: leaderDistance,
              formationDistance,
              destination: clone(this.lastAction.destination)
            };
          }
        }
      }

      if ((formationDistance != null && formationDistance >= this.config.groupRegroupTriggerDistance)
          || localRegroupDistance >= this.config.groupRegroupTriggerDistance
          || activeEncounter && localRegroupDistance > this.config.groupHardRegroupDistance) {
        if (activeEncounter && localRegroupDistance > this.config.groupHardRegroupDistance) this.metrics.groupHardRegroups += 1;
        this._stopOwnedFarming('H9_GROUP_REGROUP');
        const afterStopMovement = this._movementStatus();
        if (afterStopMovement && afterStopMovement.activeOrder && !this._ownedMovement(afterStopMovement)) {
          this.metrics.ownershipBlocks += 1;
          return { state: 'WAITING', reason: 'H9_GROUP_REGROUP_MOVEMENT_BUSY', distance: leaderDistance };
        }
        // If no safe local step exists, navigate to the live leader rather than an
        // offset formation point that may sit inside blocked geometry.
        const destination = { map: group.leader.map, x: group.leader.x, y: group.leader.y };
        const move = this.movement.smartMove(destination, {
          owner: 'farm-intelligence-h9-group-regroup',
          arrivalRadius: this.config.groupRegroupStopDistance,
          transient: true
        });
        if (!move || move.accepted !== true) {
          return { state: 'WAITING', reason: move && move.reason || 'H9_GROUP_REGROUP_REJECTED', distance: leaderDistance };
        }
        this.groupMove = { atMs: this.now(), destination: clone(destination) };
        this.groupMoveRetryAfterMs = null;
        this.metrics.groupRegroups += 1;
        this.lastAction = {
          at: new Date().toISOString(),
          type: activeEncounter ? 'GROUP_HARD_REGROUP' : 'GROUP_REGROUP',
          leaderName: group.leaderName,
          destination,
          distance: leaderDistance,
          formationDistance,
          maxPairDistance: hardDistance
        };
        return { state: 'TRAVELLING', reason: 'H9_GROUP_REGROUP_STARTED', leaderName: group.leaderName, distance: leaderDistance, formationDistance, maxPairDistance: hardDistance, destination };
      }

      return this._ensureFollowerFarm(group);
    }

    _tickGroupLeader(character, group) {
      if (!group || !group.enabled || !group.isLeader) return null;
      const movement = this._movementStatus();
      const farm = this._farmingStatus();
      const combat = this.combat && typeof this.combat.status === 'function' ? this.combat.status() : null;
      const activeEncounter = this._groupEncounterActive(group, farm, combat);

      if (!group.complete) {
        if (!activeEncounter) {
          this._stopOwnedFarming('H9_GROUP_MEMBER_POSITION_UNAVAILABLE');
          this._stopOwnedMovement('H9_GROUP_MEMBER_POSITION_UNAVAILABLE');
        }
        this.metrics.groupLeaderHolds += 1;
        return {
          state: activeEncounter ? 'FARMING' : 'WAITING',
          reason: activeEncounter ? 'H9_GROUP_COMBAT_HOLD_UNOBSERVABLE' : 'H9_GROUP_MEMBER_POSITION_UNAVAILABLE',
          leaderName: group.leaderName
        };
      }

      if (!group.sameMap) {
        if (!activeEncounter) {
          this._stopOwnedFarming('H9_GROUP_CROSS_MAP_REGROUP_WAIT');
          this._stopOwnedMovement('H9_GROUP_CROSS_MAP_REGROUP_WAIT');
        }
        this.metrics.groupLeaderHolds += 1;
        return {
          state: activeEncounter ? 'FARMING' : 'WAITING',
          reason: activeEncounter ? 'H9_GROUP_CROSS_MAP_COMBAT_HOLD' : 'H9_GROUP_CROSS_MAP_REGROUP_WAIT',
          leaderName: group.leaderName,
          maxPairDistance: group.maxPairDistance
        };
      }

      if (group.maxPairDistance <= this.config.groupRegroupStopDistance) {
        if (movement && movement.activeOrder
            && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9-leader-regroup') {
          try { this.movement.cancel('H9_GROUP_COHESION_RECOVERED'); } catch (_) {}
        }
        return null;
      }

      if (activeEncounter) {
        this.metrics.groupLeaderHolds += 1;
        if (group.maxPairDistance > this.config.groupHardRegroupDistance) this.metrics.groupHardRegroups += 1;
        return {
          state: 'FARMING',
          reason: group.maxPairDistance > this.config.groupHardRegroupDistance
            ? 'H9_GROUP_HARD_REGROUP_PENDING_COMBAT'
            : 'H9_GROUP_FORMATION_HOLD',
          leaderName: group.leaderName,
          maxPairDistance: group.maxPairDistance,
          hardRegroupDistance: this.config.groupHardRegroupDistance
        };
      }

      const activeOrder = movement && movement.activeOrder;
      // Mild separation may be closed while the leader finishes its current farm
      // travel. Once the group exceeds the hard-regroup distance, stop advancing
      // the target and let lagging followers fully close to the stop radius.
      if (activeOrder && String(activeOrder.owner || '') === 'farm-intelligence-h9'
          && group.maxPairDistance <= this.config.groupHardRegroupDistance) {
        return {
          state: 'TRAVELLING',
          reason: 'H9_GROUP_LEADER_TRAVEL_CONTINUES',
          leaderName: group.leaderName,
          maxPairDistance: group.maxPairDistance,
          destination: clone(activeOrder.destination || null)
        };
      }
      if (activeOrder && String(activeOrder.owner || '') === 'farm-intelligence-h9'
          && group.maxPairDistance > this.config.groupHardRegroupDistance) {
        try { this.movement.cancel('H9_GROUP_HARD_COHESION_RECOVERY'); } catch (_) {}
      }

      this._stopOwnedFarming('H9_WAITING_FOR_TEAM_COHESION');
      if (activeOrder && String(activeOrder.owner || '') === 'farm-intelligence-h9-leader-regroup') {
        this.metrics.groupLeaderHolds += 1;
        return { state: 'TRAVELLING', reason: 'H9_GROUP_LEADER_RECOVERY_IN_PROGRESS', maxPairDistance: group.maxPairDistance };
      }
      if (activeOrder && String(activeOrder.owner || '') !== 'farm-intelligence-h9-leader-regroup') {
        if (this._ownedMovement(movement)) {
          try { this.movement.cancel('H9_WAITING_FOR_TEAM_COHESION'); } catch (_) {}
        } else {
          this.metrics.ownershipBlocks += 1;
          return { state: 'WAITING', reason: 'H9_GROUP_LEADER_RECOVERY_MOVEMENT_BUSY', maxPairDistance: group.maxPairDistance };
        }
      }

      const waypoint = this._bestLeaderRecoveryWaypoint(group);
      if (!waypoint) {
        this.metrics.groupLeaderHolds += 1;
        return { state: 'WAITING', reason: 'H9_WAITING_FOR_TEAM_COHESION', maxPairDistance: group.maxPairDistance };
      }
      const move = this.movement.moveLocal(waypoint.x, waypoint.y, {
        owner: 'farm-intelligence-h9-leader-regroup',
        arrivalRadius: 8,
        transient: true
      });
      if (!move || move.accepted !== true) {
        this.metrics.groupLeaderHolds += 1;
        return { state: 'WAITING', reason: move && move.reason || 'H9_GROUP_LEADER_RECOVERY_REJECTED', maxPairDistance: group.maxPairDistance };
      }
      this.metrics.groupLeaderRecoveries += 1;
      this.lastAction = {
        at: new Date().toISOString(),
        type: 'GROUP_LEADER_RECOVERY',
        leaderName: group.leaderName,
        destination: { map: waypoint.map, x: waypoint.x, y: waypoint.y },
        maxPairDistance: group.maxPairDistance,
        projectedMaxPairDistance: waypoint.nextMax,
        improvement: waypoint.improvement
      };
      return {
        state: 'TRAVELLING',
        reason: 'H9_GROUP_LEADER_RECOVERY_STARTED',
        leaderName: group.leaderName,
        maxPairDistance: group.maxPairDistance,
        projectedMaxPairDistance: waypoint.nextMax,
        destination: clone(this.lastAction.destination)
      };
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
      if (group.enabled && !group.isLeader) {
        this.metrics.decisions += 1;
        const groupDecision = this._tickGroupFollower(character, group);
        this.lastPlan = {
          at: new Date().toISOString(),
          ...clone(groupDecision),
          group: {
            leaderName: group.leaderName,
            memberNames: group.memberNames.slice(),
            complete: group.complete === true,
            sameMap: group.sameMap === true
          },
          candidates: []
        };
        return groupDecision;
      }
      if (group.enabled && group.isLeader) {
        const leaderDecision = this._tickGroupLeader(character, group);
        if (leaderDecision) {
          this.metrics.decisions += 1;
          this.lastPlan = {
            at: new Date().toISOString(),
            ...clone(leaderDecision),
            group: {
              leaderName: group.leaderName,
              memberNames: group.memberNames.slice(),
              complete: group.complete === true,
              sameMap: group.sameMap === true
            },
            candidates: []
          };
          return leaderDecision;
        }
      }
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
