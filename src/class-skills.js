(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  const SUPPORTED_CLASSES = Object.freeze(['warrior', 'ranger', 'mage', 'priest', 'rogue', 'paladin']);
  const CLASS_SKILLS = Object.freeze({
    warrior: Object.freeze(['hardshell', 'charge', 'taunt', 'warcry']),
    ranger: Object.freeze(['huntersmark', 'poisonarrow', 'piercingshot', 'supershot']),
    mage: Object.freeze(['entangle', 'arcane_needle', 'burst']),
    priest: Object.freeze(['phaseout', 'curse', 'darkblessing']),
    rogue: Object.freeze(['invis', 'pcoat', 'mentalburst', 'quickstab', 'quickpunch']),
    paladin: Object.freeze(['selfheal', 'shield_slam', 'purify', 'smash'])
  });

  // Complete class-skill ownership map. A skill missing from the H6 rotation is
  // intentional only when another bounded module owns it or its semantics are
  // unsafe/context-specific for autonomous farming.
  const CLASS_SKILL_POLICY = Object.freeze({
    warrior: Object.freeze({
      h6: Object.freeze(['hardshell', 'charge', 'taunt', 'warcry']),
      h8: Object.freeze(['cleave', 'stomp']),
      passive: Object.freeze([]),
      excluded: Object.freeze({
        dash: 'MOVEMENT_OWNERSHIP_H4',
        agitate: 'UNBOUNDED_MASS_AGGRO'
      })
    }),
    ranger: Object.freeze({
      h6: Object.freeze(['huntersmark', 'poisonarrow', 'piercingshot', 'supershot']),
      h8: Object.freeze(['3shot', '5shot']),
      passive: Object.freeze([]),
      excluded: Object.freeze({
        track: 'OBSERVATION_UTILITY_NOT_COMBAT_ACTION',
        '4fingers': 'PLAYER_ONLY_HOSTILE_PVP'
      })
    }),
    mage: Object.freeze({
      h6: Object.freeze(['entangle', 'arcane_needle', 'burst']),
      h7: Object.freeze(['energize', 'reflection']),
      h8: Object.freeze(['cburst']),
      passive: Object.freeze([]),
      excluded: Object.freeze({
        blink: 'MOVEMENT_OWNERSHIP_H4',
        magiport: 'REMOTE_PLAYER_MOVEMENT_REQUIRES_EXPLICIT_INTENT',
        light: 'PVP_ANTI_STEALTH_CONTEXT_ONLY',
        alchemy: 'DESTRUCTIVE_ITEM_CONVERSION'
      })
    }),
    priest: Object.freeze({
      h6: Object.freeze(['phaseout', 'curse', 'darkblessing']),
      h7: Object.freeze(['heal', 'partyheal', 'revive']),
      passive: Object.freeze([]),
      excluded: Object.freeze({
        absorb: 'AGGRO_TRANSFER_REQUIRES_EXPLICIT_SAFETY_MODEL'
      })
    }),
    rogue: Object.freeze({
      h6: Object.freeze(['invis', 'pcoat', 'mentalburst', 'quickstab', 'quickpunch']),
      h7: Object.freeze(['rspeed']),
      h8: Object.freeze(['fanofknives']),
      passive: Object.freeze(['stack']),
      excluded: Object.freeze({
        pickpocket: 'PLAYER_PVP_THEFT',
        shadowstrike: 'RANDOM_REMOTE_ENEMY_TARGET'
      })
    }),
    paladin: Object.freeze({
      h6: Object.freeze(['selfheal', 'shield_slam', 'purify', 'smash']),
      passive: Object.freeze([]),
      excluded: Object.freeze({
        mshield: 'PERSISTENT_TOGGLE_REQUIRES_DEFENSE_POLICY',
        aether_shield: 'PERSISTENT_TOGGLE_REQUIRES_DEFENSE_POLICY',
        cleansing_light: 'ALLY_CLEANSE_REQUIRES_CONDITION_CLASSIFICATION',
        guardians_oath: 'DAMAGE_TRANSFER_REQUIRES_SURVIVABILITY_MODEL',
        beacon_of_resolve: 'GROUP_BUFF_REQUIRES_ENCOUNTER_POLICY',
        paladin_aura: 'MULTI_STATE_AURA_REQUIRES_GROUP_POLICY'
      })
    })
  });

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function ratio(value, max) {
    const current = finite(value);
    const total = finite(max);
    if (current == null || total == null || total <= 0) return null;
    return Math.max(0, Math.min(1, current / total));
  }

  function errorReason(value, fallback = 'CLASS_SKILL_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 240);
    }
    const text = cleanText(value, 240);
    return text || fallback;
  }

  class ClassSkillController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.config = {
        minGlobalIntervalMs: Math.max(150, Math.min(2000, Number(options.minGlobalIntervalMs) || 350)),
        rejectionBackoffMs: Math.max(1000, Math.min(30000, Number(options.rejectionBackoffMs) || 5000)),
        mpReserveRatio: Math.max(0, Math.min(0.8, Number(options.mpReserveRatio) || 0.20)),
        defensiveHpRatio: Math.max(0.35, Math.min(0.8, Number(options.defensiveHpRatio) || 0.50)),
        paladinHealHpRatio: Math.max(0.40, Math.min(0.9, Number(options.paladinHealHpRatio) || 0.70)),
        longFightHpFactor: Math.max(2, Math.min(20, Number(options.longFightHpFactor) || 4))
      };

      this.active = false;
      this.sessionId = null;
      this.pending = null;
      this.pendingGeneration = 0;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.lastAttemptAtMs = 0;
      this.lastDecision = null;
      this.lastUse = null;
      this.suppression = new Map();
      this.metrics = {
        decisions: 0,
        dispatched: 0,
        confirmed: 0,
        rejected: 0,
        unknown: 0,
        damageSkills: 0,
        supportSkills: 0,
        defensiveSkills: 0,
        mobilitySkills: 0,
        skillKillsConfirmed: 0,
        cooldownSkips: 0,
        mpSkips: 0,
        rangeSkips: 0,
        spamSkips: 0,
        overkillSkips: 0,
        unavailableSkips: 0,
        activeConditionSkips: 0,
        requirementSkips: 0,
        equipmentSkips: 0,
        consumableSkips: 0
      };
    }

    start() {
      this.active = true;
      return this.status();
    }

    stop(reason = 'CLASS_SKILLS_STOP') {
      this.active = false;
      this.endSession(reason);
      return this.status();
    }

    beginSession(sessionId) {
      const id = cleanText(sessionId || '', 120) || null;
      if (id && id !== this.sessionId) {
        this.sessionId = id;
        this.suspendedSessionId = null;
        this.suspendedReason = null;
        this.pendingGeneration += 1;
        this.pending = null;
      }
      return this.status();
    }

    endSession(reason = 'COMBAT_SESSION_END') {
      this.pendingGeneration += 1;
      this.pending = null;
      this.sessionId = null;
      this.suspendedSessionId = null;
      this.suspendedReason = null;
      this.lastDecision = this.lastDecision ? { ...this.lastDecision, sessionEndReason: cleanText(reason, 180) } : null;
      return this.status();
    }

    supportedSkills(ctype) {
      const key = cleanText(ctype || '', 60).toLowerCase();
      return (CLASS_SKILLS[key] || []).slice();
    }

    liveSkillSummary(ctype) {
      return this.supportedSkills(ctype).map(id => {
        const definition = this.game && typeof this.game.skillDefinition === 'function'
          ? this.game.skillDefinition(id)
          : null;
        return { id, available: !!definition, definition };
      });
    }

    _suppressionKey(skillId, targetId) {
      return String(skillId) + ':' + (targetId == null ? '*' : String(targetId));
    }

    _isSuppressed(skillId, targetId) {
      const key = this._suppressionKey(skillId, targetId);
      const until = this.suppression.get(key) || 0;
      if (until <= this.now()) {
        if (until) this.suppression.delete(key);
        return false;
      }
      return true;
    }

    _suppress(skillId, targetId, ms) {
      const duration = Math.max(0, Number(ms) || 0);
      if (!duration) return;
      this.suppression.set(this._suppressionKey(skillId, targetId), this.now() + duration);
      if (this.suppression.size > 80) {
        const now = this.now();
        for (const [key, until] of this.suppression.entries()) {
          if (until <= now) this.suppression.delete(key);
        }
      }
    }

    _skillCandidate(skillId, target, game, options = {}) {
      const targetId = options.targeted === false ? null : (target && target.id);
      if (this._isSuppressed(skillId, targetId)) {
        this.metrics.spamSkips += 1;
        return null;
      }

      const readiness = this.game.skillReadiness(skillId, targetId);
      if (!readiness || !readiness.available) {
        this.metrics.unavailableSkips += 1;
        return null;
      }
      if (readiness.activeCondition && options.skipIfActive !== false) {
        this.metrics.activeConditionSkips += 1;
        return null;
      }
      if (!readiness.allowed) {
        const reasons = readiness.reasons || [];
        if (reasons.includes('SKILL_COOLDOWN') || reasons.includes('SKILL_CAN_USE_FALSE')) this.metrics.cooldownSkips += 1;
        if (reasons.includes('SKILL_MP_TOO_LOW')) this.metrics.mpSkips += 1;
        if (reasons.includes('SKILL_OUT_OF_RANGE') || reasons.includes('SKILL_TARGET_UNAVAILABLE')) this.metrics.rangeSkips += 1;
        if (reasons.some(reason => String(reason).startsWith('SKILL_REQUIREMENT_'))) this.metrics.requirementSkips += 1;
        if (reasons.some(reason => ['SKILL_WEAPON_TYPE_MISMATCH', 'SKILL_OFFHAND_TYPE_MISMATCH', 'SKILL_SLOT_REQUIREMENT_MISSING'].includes(reason))) {
          this.metrics.equipmentSkips += 1;
        }
        if (reasons.includes('SKILL_CONSUMABLE_MISSING')) this.metrics.consumableSkips += 1;
        return null;
      }

      const character = game && game.character;
      const cost = finite(readiness.definition && readiness.definition.mp) || 0;
      const mp = finite(character && character.mp);
      const maxMp = finite(character && character.maxMp);
      const reserveRatio = options.mpReserveRatio == null ? this.config.mpReserveRatio : Number(options.mpReserveRatio);
      if (mp != null && maxMp != null && maxMp > 0 && mp - cost < maxMp * reserveRatio) {
        this.metrics.mpSkips += 1;
        return null;
      }

      return {
        id: skillId,
        targetId,
        readiness,
        args: targetId == null ? [skillId] : [skillId, String(targetId)],
        kind: options.kind || 'support',
        reason: options.reason || 'CLASS_SKILL_SELECTED',
        recastMs: Math.max(0, Number(options.recastMs) || 0),
        baselineHp: target && finite(target.hp),
        utility: Number(options.utility) || 0
      };
    }

    _choose(game, target) {
      const character = game && game.character;
      if (!character || !target) return null;
      const ctype = String(character.ctype || '').toLowerCase();
      if (!SUPPORTED_CLASSES.includes(ctype)) return null;

      const hpRatio = ratio(character.hp, character.maxHp);
      const mpRatio = ratio(character.mp, character.maxMp);
      const attack = Math.max(1, finite(character.attack) || 100);
      const targetHp = finite(target.hp);
      const distance = finite(target.distance);
      const range = Math.max(1, finite(character.range) || 40);
      const longFight = targetHp != null && targetHp >= attack * this.config.longFightHpFactor;
      let targetDefinition = null;
      try {
        targetDefinition = this.game && typeof this.game.monsterDefinition === 'function' && target && target.mtype
          ? this.game.monsterDefinition(target.mtype)
          : null;
      } catch (_) {}
      const targetArmor = finite(targetDefinition && targetDefinition.armor);
      const targetResistance = finite(targetDefinition && targetDefinition.resistance);
      const targetAttack = finite(target && target.attack);

      if (ctype === 'warrior') {
        if (hpRatio != null && hpRatio <= this.config.defensiveHpRatio) {
          const defensive = this._skillCandidate('hardshell', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'WARRIOR_LOW_HP_HARDSHELL',
            recastMs: 12000,
            utility: 300
          });
          if (defensive) return defensive;
        }
        if (distance != null && distance > Math.max(35, range * 1.4)) {
          const charge = this._skillCandidate('charge', target, game, {
            targeted: false,
            kind: 'mobility',
            reason: 'WARRIOR_CLOSE_DISTANCE_CHARGE',
            recastMs: 30000,
            utility: 220
          });
          if (charge) return charge;
        }
        if (target.targetId !== character.name) {
          const taunt = this._skillCandidate('taunt', target, game, {
            kind: 'support',
            reason: target.targetId ? 'WARRIOR_RECLAIM_AGGRO' : 'WARRIOR_CONTROLLED_ENGAGE_TAUNT',
            recastMs: 12000,
            utility: 180
          });
          if (taunt) return taunt;
        }
        if (longFight && mpRatio != null && mpRatio >= 0.65) {
          const warcry = this._skillCandidate('warcry', target, game, {
            targeted: false,
            kind: 'support',
            reason: 'WARRIOR_LONG_FIGHT_WARCRY',
            recastMs: 55000,
            utility: 120
          });
          if (warcry) return warcry;
        }
      }

      if (ctype === 'ranger') {
        if (longFight && mpRatio != null && mpRatio >= 0.50) {
          const mark = this._skillCandidate('huntersmark', target, game, {
            kind: 'support',
            reason: 'RANGER_LONG_FIGHT_HUNTERSMARK',
            recastMs: 10000,
            utility: 240
          });
          if (mark) return mark;
        }
        if (longFight && mpRatio != null && mpRatio >= 0.60) {
          const poison = this._skillCandidate('poisonarrow', target, game, {
            kind: 'damage',
            reason: 'RANGER_LONG_FIGHT_POISON_ARROW',
            recastMs: 1200,
            utility: 210
          });
          if (poison) return poison;
        }
        if (targetArmor != null && targetArmor >= 200 && targetHp != null && targetHp > attack * 1.25) {
          const piercing = this._skillCandidate('piercingshot', target, game, {
            kind: 'damage',
            reason: 'RANGER_HIGH_ARMOR_PIERCING_SHOT',
            recastMs: 300,
            utility: 200
          });
          if (piercing) return piercing;
        }
        if (targetHp != null && targetHp > Math.max(150, attack * 1.5)) {
          const shot = this._skillCandidate('supershot', target, game, {
            kind: 'damage',
            reason: 'RANGER_SUPERSHOT_SAFE_DAMAGE',
            recastMs: 25000,
            utility: 180
          });
          if (shot) return shot;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      if (ctype === 'mage') {
        const dangerousLongFight = longFight && targetAttack != null && finite(character.maxHp) != null
          && targetAttack >= Math.max(20, Number(character.maxHp) * 0.04);
        if (dangerousLongFight && mpRatio != null && mpRatio >= 0.65) {
          const entangle = this._skillCandidate('entangle', target, game, {
            kind: 'support',
            reason: 'MAGE_DANGEROUS_LONG_FIGHT_ENTANGLE',
            recastMs: 38000,
            utility: 260
          });
          if (entangle) return entangle;
        }
        if (targetResistance != null && targetResistance >= 250 && targetHp != null && targetHp > attack * 1.10) {
          const needle = this._skillCandidate('arcane_needle', target, game, {
            kind: 'damage',
            reason: 'MAGE_HIGH_RESISTANCE_ARCANE_NEEDLE',
            recastMs: 300,
            utility: 210
          });
          if (needle) return needle;
        }

        // Mana Burst consumes the current mana pool. Use it as a bounded
        // finisher only when the live MP-derived pure damage should kill the
        // target; never dump all mana merely because a fight is long.
        const burstDefinition = this.game && typeof this.game.skillDefinition === 'function'
          ? this.game.skillDefinition('burst')
          : null;
        const burstRatio = finite(burstDefinition && burstDefinition.ratio) != null
          ? finite(burstDefinition.ratio)
          : finite(burstDefinition && burstDefinition.damageMultiplier);
        const currentMp = finite(character.mp);
        const estimatedBurstDamage = currentMp != null && burstRatio != null ? currentMp * burstRatio : null;
        if (targetHp != null && estimatedBurstDamage != null
            && targetHp > Math.max(80, attack * 0.90)
            && targetHp <= estimatedBurstDamage
            && mpRatio != null && mpRatio >= 0.45) {
          const burst = this._skillCandidate('burst', target, game, {
            kind: 'damage',
            reason: 'MAGE_BURST_KILL_SECURE',
            recastMs: 5500,
            utility: 220,
            mpReserveRatio: 0
          });
          if (burst) return burst;
        } else if (targetHp != null && estimatedBurstDamage != null && targetHp < attack * 0.90) {
          this.metrics.overkillSkips += 1;
        }
      }

      if (ctype === 'priest') {
        if (hpRatio != null && hpRatio <= 0.30) {
          const phaseout = this._skillCandidate('phaseout', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'PRIEST_CRITICAL_HP_PHASEOUT',
            recastMs: 4000,
            utility: 340,
            mpReserveRatio: 0.05
          });
          if (phaseout) return phaseout;
        }
        if (longFight && mpRatio != null && mpRatio >= 0.80) {
          const blessing = this._skillCandidate('darkblessing', target, game, {
            targeted: false,
            kind: 'support',
            reason: 'PRIEST_LONG_FIGHT_DARKBLESSING',
            recastMs: 55000,
            utility: 200
          });
          if (blessing) return blessing;
        }
        if (targetHp != null && targetHp > Math.max(300, attack * 3) && mpRatio != null && mpRatio >= 0.55) {
          const curse = this._skillCandidate('curse', target, game, {
            kind: 'support',
            reason: 'PRIEST_LONG_FIGHT_CURSE',
            recastMs: 5000,
            utility: 170
          });
          if (curse) return curse;
        }
      }

      if (ctype === 'rogue') {
        if (hpRatio != null && hpRatio <= this.config.defensiveHpRatio) {
          const invis = this._skillCandidate('invis', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'ROGUE_LOW_HP_INVIS',
            recastMs: 10000,
            utility: 300
          });
          if (invis) return invis;
        }
        if (longFight && mpRatio != null && mpRatio >= 0.75) {
          const poisonCoat = this._skillCandidate('pcoat', target, game, {
            targeted: false,
            kind: 'support',
            reason: 'ROGUE_LONG_FIGHT_POISON_COAT',
            recastMs: 48000,
            utility: 230
          });
          if (poisonCoat) return poisonCoat;
        }
        if (targetHp != null && targetHp > Math.max(140, attack * 1.5)) {
          const burst = this._skillCandidate('mentalburst', target, game, {
            kind: 'damage',
            reason: 'ROGUE_MENTALBURST_SAFE_DAMAGE',
            recastMs: 850,
            utility: 190
          });
          if (burst) return burst;
        }
        if (targetHp != null && targetHp > Math.max(90, attack * 1.15)) {
          const stab = this._skillCandidate('quickstab', target, game, {
            kind: 'damage',
            reason: 'ROGUE_QUICKSTAB_WEAPON_MATCH',
            recastMs: 280,
            utility: 165
          });
          if (stab) return stab;
          const punch = this._skillCandidate('quickpunch', target, game, {
            kind: 'damage',
            reason: 'ROGUE_QUICKPUNCH_WEAPON_MATCH',
            recastMs: 280,
            utility: 150
          });
          if (punch) return punch;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      if (ctype === 'paladin') {
        if (hpRatio != null && hpRatio <= this.config.paladinHealHpRatio) {
          const heal = this._skillCandidate('selfheal', target, game, {
            targeted: false,
            kind: 'defensive',
            reason: 'PALADIN_SELFHEAL_THRESHOLD',
            recastMs: 1100,
            utility: 280,
            mpReserveRatio: 0.05
          });
          if (heal) return heal;
        }
        if (targetHp != null && targetHp > Math.max(1800, attack * 4) && mpRatio != null && mpRatio >= 0.60) {
          const slam = this._skillCandidate('shield_slam', target, game, {
            kind: 'damage',
            reason: 'PALADIN_SHIELD_SLAM_HEAVY_TARGET',
            recastMs: 650,
            utility: 230
          });
          if (slam) return slam;
        }
        if (targetHp != null && targetHp > Math.max(1200, attack * 3) && mpRatio != null && mpRatio >= 0.45) {
          const purify = this._skillCandidate('purify', target, game, {
            kind: 'damage',
            reason: 'PALADIN_PURIFY_HEAVY_TARGET',
            recastMs: 23000,
            utility: 210
          });
          if (purify) return purify;
        }
        if (targetHp != null && targetHp > Math.max(150, attack * 1.5)) {
          const smash = this._skillCandidate('smash', target, game, {
            kind: 'damage',
            reason: 'PALADIN_SMASH_SAFE_DAMAGE',
            recastMs: 350,
            utility: 170
          });
          if (smash) return smash;
        } else if (targetHp != null) {
          this.metrics.overkillSkips += 1;
        }
      }

      return null;
    }

    preview(targetId) {
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      if (!game || !game.character) return null;
      const targets = this.game && typeof this.game.visibleMonsters === 'function' ? this.game.visibleMonsters() : [];
      const target = targetId == null
        ? (game.target || targets[0] || null)
        : targets.find(row => String(row.id) === String(targetId)) || (game.target && String(game.target.id) === String(targetId) ? game.target : null);
      if (!target) return null;
      const decision = this._choose(game, target);
      return decision ? clone({
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason,
        recastMs: decision.recastMs
      }) : null;
    }

    _knownRejection(reason) {
      const value = String(reason || '').toLowerCase();
      if (!value) return false;
      if (value.includes('disconnect') || value.includes('timeout') || value.includes('network')) return false;
      return [
        'cooldown', 'no_mp', 'mp', 'too_far', 'range', 'not_found', 'not_there', 'cant_use',
        'cannot_use', 'level', 'weapon', 'requirements', 'disabled', 'stunned', 'immune', 'slot', 'consume'
      ].some(token => value.includes(token));
    }

    _settleConfirmed(pending, response) {
      if (!pending) return;
      this.metrics.confirmed += 1;
      if (pending.kind === 'damage') this.metrics.damageSkills += 1;
      else if (pending.kind === 'defensive') this.metrics.defensiveSkills += 1;
      else if (pending.kind === 'mobility') this.metrics.mobilitySkills += 1;
      else this.metrics.supportSkills += 1;

      const damage = response && typeof response === 'object' ? finite(response.damage) : null;
      const lethal = damage != null && pending.baselineHp != null && damage >= pending.baselineHp;
      if (lethal) this.metrics.skillKillsConfirmed += 1;

      this.lastUse = {
        at: new Date().toISOString(),
        sessionId: pending.sessionId,
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        state: 'CONFIRMED',
        damage,
        lethal,
        response: response == null ? null : clone(response)
      };
      this.pending = null;
      if (this.logger) this.logger.info('Klassen-Skill bestätigt', {
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        damage,
        lethal
      });
    }

    _settleRejected(pending, reason, response) {
      if (!pending) return;
      this.metrics.rejected += 1;
      this._suppress(pending.skillId, pending.targetId, this.config.rejectionBackoffMs);
      this.lastUse = {
        at: new Date().toISOString(),
        sessionId: pending.sessionId,
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        state: 'REJECTED',
        error: cleanText(reason, 240),
        response: response == null ? null : clone(response)
      };
      this.pending = null;
      if (this.logger) this.logger.warn('Klassen-Skill serverseitig abgelehnt', {
        skillId: pending.skillId,
        targetId: pending.targetId,
        error: reason
      });
    }

    _settleUnknown(pending, reason, details) {
      if (!pending) return;
      this.metrics.unknown += 1;
      this.suspendedSessionId = pending.sessionId;
      this.suspendedReason = cleanText(reason, 240);
      this.lastUse = {
        at: new Date().toISOString(),
        sessionId: pending.sessionId,
        skillId: pending.skillId,
        targetId: pending.targetId,
        kind: pending.kind,
        reason: pending.reason,
        state: 'UNKNOWN',
        error: this.suspendedReason,
        response: details == null ? null : clone(details)
      };
      this.pending = null;
      if (this.logger) this.logger.error('Klassen-Skill Outcome unklar; Skills für Combat-Session suspendiert', {
        skillId: pending.skillId,
        targetId: pending.targetId,
        error: this.suspendedReason
      });
    }

    _watch(dispatch, pending, generation) {
      const value = dispatch && dispatch.value;
      if (!value || typeof value.then !== 'function') {
        const response = value;
        if (response && typeof response === 'object' && response.failed === true) {
          this._settleRejected(pending, errorReason(response, 'SKILL_REJECTED'), response);
        } else if (response && typeof response === 'object' && (response.success === true || response.place || response.response)) {
          this._settleConfirmed(pending, response);
        } else {
          this._settleUnknown(pending, 'SKILL_RESULT_UNCONFIRMED', response);
        }
        return;
      }

      Promise.resolve(value).then(response => {
        if (generation !== this.pendingGeneration) return;
        if (!this.pending || this.pending.id !== pending.id) return;
        if (response && typeof response === 'object' && response.failed === true) {
          this._settleRejected(pending, errorReason(response, 'SKILL_REJECTED'), response);
          return;
        }
        this._settleConfirmed(pending, response);
      }, error => {
        if (generation !== this.pendingGeneration) return;
        if (!this.pending || this.pending.id !== pending.id) return;
        const reason = errorReason(error, 'SKILL_PROMISE_REJECTED');
        if (this._knownRejection(reason)) this._settleRejected(pending, reason, error);
        else this._settleUnknown(pending, reason, error);
      }).catch(() => {});
    }

    maybeUse(context = {}) {
      if (!this.active) return { handled: false, reason: 'CLASS_SKILLS_INACTIVE' };
      const session = context.session || null;
      const game = context.game || (this.game && this.game.snapshot ? this.game.snapshot() : null);
      const target = context.target || (game && game.target) || null;
      if (!session || !session.id || !game || !game.character || !target) return { handled: false, reason: 'CLASS_SKILL_CONTEXT_INCOMPLETE' };

      this.beginSession(session.id);
      if (this.suspendedSessionId === session.id) {
        return { handled: false, suspended: true, reason: this.suspendedReason || 'CLASS_SKILLS_SUSPENDED' };
      }
      if (this.pending) return { handled: true, pending: true, skillId: this.pending.skillId };

      const now = this.now();
      if (now - this.lastAttemptAtMs < this.config.minGlobalIntervalMs) {
        this.metrics.spamSkips += 1;
        return { handled: false, reason: 'CLASS_SKILL_GLOBAL_INTERVAL' };
      }

      this.metrics.decisions += 1;
      const decision = this._choose(game, target);
      this.lastDecision = decision ? {
        at: new Date().toISOString(),
        sessionId: session.id,
        characterClass: game.character.ctype,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason
      } : {
        at: new Date().toISOString(),
        sessionId: session.id,
        characterClass: game.character.ctype,
        skillId: null,
        targetId: target.id || null,
        kind: null,
        reason: 'NO_CLASS_SKILL_SELECTED'
      };
      if (!decision) return { handled: false, reason: 'NO_CLASS_SKILL_SELECTED' };

      let dispatch;
      try {
        dispatch = this.actions.dispatch('use_skill', decision.args);
      } catch (error) {
        return { handled: false, reason: errorReason(error, 'CLASS_SKILL_ACTION_BLOCKED') };
      }

      this.lastAttemptAtMs = now;
      this._suppress(decision.id, decision.targetId, decision.recastMs);

      if (!dispatch || dispatch.state === 'UNAVAILABLE') {
        this.metrics.unavailableSkips += 1;
        return { handled: false, reason: 'USE_SKILL_API_UNAVAILABLE' };
      }
      if (dispatch.state === 'UNKNOWN') {
        const pseudo = {
          id: dispatch.id || ('skill-' + now),
          sessionId: session.id,
          skillId: decision.id,
          targetId: decision.targetId,
          kind: decision.kind,
          reason: decision.reason,
          baselineHp: decision.baselineHp
        };
        this._settleUnknown(pseudo, errorReason(dispatch.error, 'SKILL_DISPATCH_UNKNOWN'), dispatch);
        return { handled: true, unknown: true, skillId: decision.id };
      }

      const pending = {
        id: dispatch.id,
        sessionId: session.id,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason,
        baselineHp: decision.baselineHp,
        dispatchedAt: new Date().toISOString(),
        dispatchedAtMs: now
      };
      this.pending = pending;
      this.metrics.dispatched += 1;
      const generation = this.pendingGeneration;
      this._watch(dispatch, pending, generation);

      if (this.logger) this.logger.info('Klassen-Skill gesendet', {
        id: dispatch.id,
        sessionId: session.id,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason
      });

      return {
        handled: true,
        pending: !!this.pending,
        skillId: decision.id,
        targetId: decision.targetId,
        kind: decision.kind,
        reason: decision.reason
      };
    }

    status() {
      const game = this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
      const ctype = game && game.character && game.character.ctype || null;
      return {
        schemaVersion: 1,
        active: this.active,
        supportedClasses: SUPPORTED_CLASSES.slice(),
        currentClass: ctype,
        supportedSkills: this.supportedSkills(ctype),
        liveSkills: this.liveSkillSummary(ctype),
        skillPolicy: ctype && CLASS_SKILL_POLICY[String(ctype).toLowerCase()]
          ? clone(CLASS_SKILL_POLICY[String(ctype).toLowerCase()])
          : null,
        sessionId: this.sessionId,
        suspended: !!(this.sessionId && this.suspendedSessionId === this.sessionId),
        suspendedReason: this.suspendedReason,
        pending: clone(this.pending),
        lastDecision: clone(this.lastDecision),
        lastUse: clone(this.lastUse),
        config: clone(this.config),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.ClassSkillController = ClassSkillController;
  ns.CLASS_SKILL_POLICY = CLASS_SKILL_POLICY;
})(typeof globalThis !== 'undefined' ? globalThis : this);
