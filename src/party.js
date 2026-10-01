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

  function roleForClass(ctype, hasWarrior) {
    const value = String(ctype || '').toLowerCase();
    if (value === 'warrior') return 'TANK';
    if (value === 'priest') return 'HEALER';
    if (value === 'paladin') return hasWarrior ? 'SUPPORT' : 'TANK';
    if (['ranger', 'mage', 'rogue'].includes(value)) return 'DPS';
    if (value === 'merchant') return 'LOGISTICS';
    return 'UNKNOWN';
  }

  function errorReason(value, fallback = 'PARTY_ACTION_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 240);
    }
    const text = cleanText(value, 240);
    return text || fallback;
  }

  class PartyCoordinator {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.roster = options.roster;
      this.classSkills = options.classSkills || null;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();
      this.config = {
        tickMs: Math.max(100, Math.min(2000, Number(options.tickMs) || 250)),
        focusHoldMs: Math.max(250, Math.min(10000, Number(options.focusHoldMs) || 1200)),
        focusPingPongWindowMs: Math.max(1000, Math.min(30000, Number(options.focusPingPongWindowMs) || 6000)),
        healHpRatio: Math.max(0.25, Math.min(0.95, Number(options.healHpRatio) || 0.70)),
        partyHealHpRatio: Math.max(0.25, Math.min(0.95, Number(options.partyHealHpRatio) || 0.68)),
        partyHealMinMembers: Math.max(2, Math.min(8, Number(options.partyHealMinMembers) || 2)),
        supportBackoffMs: Math.max(1000, Math.min(30000, Number(options.supportBackoffMs) || 4000))
      };

      this.active = false;
      this.scope = null;
      this.heartbeat = null;
      this.lastSnapshot = null;
      this.focusTargetId = null;
      this.focusSource = null;
      this.focusSinceMs = 0;
      this.pendingFocusId = null;
      this.pendingFocusSinceMs = 0;
      this.focusHistory = [];
      this.pendingSupport = null;
      this.supportGeneration = 0;
      this.supportSuspended = false;
      this.supportSuspendedReason = null;
      this.supportBackoffUntil = 0;
      this.lastSupport = null;
      this.lastDecision = null;
      this.metrics = {
        ticks: 0,
        partySnapshots: 0,
        focusUpdates: 0,
        focusChanges: 0,
        focusPingPongs: 0,
        assistTargetsObserved: 0,
        healsDispatched: 0,
        partyHealsDispatched: 0,
        revivesDispatched: 0,
        energizesDispatched: 0,
        reflectionsDispatched: 0,
        speedBuffsDispatched: 0,
        supportConfirmed: 0,
        supportRejected: 0,
        supportUnknown: 0,
        foreignPartyBlocks: 0,
        noPartyTicks: 0
      };
    }

    start(context) {
      this.active = true;
      this.focusHistory = [];
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      if (!this.scope) throw new Error('PARTY_SCOPE_REQUIRED');
      this.scope.interval('party-loop', () => this._tick(), this.config.tickMs, { immediate: true });
      return this.status();
    }

    stop(reason = 'PARTY_MODULE_STOP') {
      this.active = false;
      this.supportGeneration += 1;
      this.pendingSupport = null;
      this.scope = null;
      this.heartbeat = null;
      this.lastDecision = {
        at: new Date().toISOString(),
        type: 'STOP',
        reason: cleanText(reason, 200)
      };
      return this.status();
    }

    _ownedNames() {
      const status = this.roster && this.roster.status ? this.roster.status() : null;
      const rows = status && Array.isArray(status.characters) ? status.characters : [];
      return new Set(rows.map(row => String(row && row.name || '')).filter(Boolean));
    }

    _decorateParty(snapshot) {
      const owned = this._ownedNames();
      const members = (snapshot && snapshot.members || []).map(member => ({
        ...member,
        owned: owned.has(String(member.name || ''))
      }));
      const hasWarrior = members.some(member => member.owned && String(member.ctype || '').toLowerCase() === 'warrior');
      for (const member of members) member.role = roleForClass(member.ctype, hasWarrior);
      const foreign = members.filter(member => !member.owned).map(member => member.name);
      const ownedMembers = members.filter(member => member.owned);
      const local = members.find(member => member.local) || null;
      return {
        ...(snapshot || {}),
        members,
        ownedMembers,
        foreignMemberNames: foreign,
        ownedMemberNames: ownedMembers.map(member => member.name),
        coordinationEnabled: ownedMembers.length >= 2 && foreign.length === 0,
        localRole: local ? local.role : null
      };
    }

    snapshot() {
      const raw = this.game && this.game.partySnapshot ? this.game.partySnapshot() : null;
      return this._decorateParty(raw || {
        schemaVersion: 1,
        available: false,
        partyId: null,
        leader: null,
        memberNames: [],
        members: [],
        size: 0
      });
    }

    _visibleMonsterIds() {
      const monsters = this.game && this.game.visibleMonsters ? this.game.visibleMonsters() : [];
      return new Set(monsters.map(row => String(row.id)));
    }

    _proposedFocus(snapshot) {
      if (!snapshot || !snapshot.coordinationEnabled) return null;
      const visibleMonsters = this._visibleMonsterIds();
      const alive = snapshot.ownedMembers.filter(member => !member.rip && member.targetId && visibleMonsters.has(String(member.targetId)));
      if (!alive.length) return null;

      const tank = alive.find(member => member.role === 'TANK');
      if (tank) return { id: String(tank.targetId), source: 'tank:' + tank.name };

      const leader = alive.find(member => String(member.name) === String(snapshot.leader || ''));
      if (leader) return { id: String(leader.targetId), source: 'leader:' + leader.name };

      const counts = new Map();
      for (const member of alive) {
        const key = String(member.targetId);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      let best = null;
      for (const [id, count] of counts.entries()) {
        if (!best || count > best.count || (count === best.count && id < best.id)) best = { id, count };
      }
      return best ? { id: best.id, source: 'majority:' + best.count } : null;
    }

    _recordFocusTarget(targetId, source, atMs = this.now()) {
      const id = targetId == null ? null : String(targetId);
      if (!id) return false;
      const cutoff = atMs - this.config.focusPingPongWindowMs;
      this.focusHistory = this.focusHistory.filter(row => row && row.atMs >= cutoff);

      const last = this.focusHistory.length ? this.focusHistory[this.focusHistory.length - 1] : null;
      if (last && last.targetId === id) return false;

      let pingPong = false;
      if (last && last.targetId !== id) {
        for (let i = this.focusHistory.length - 2; i >= 0; i -= 1) {
          if (this.focusHistory[i].targetId === id) {
            pingPong = true;
            break;
          }
        }
      }

      this.focusHistory.push({
        targetId: id,
        source: cleanText(source || '', 160) || null,
        atMs
      });
      if (this.focusHistory.length > 24) this.focusHistory.splice(0, this.focusHistory.length - 24);

      if (pingPong) {
        this.metrics.focusPingPongs += 1;
        if (this.logger) this.logger.warn('Party Focus Pingpong erkannt', {
          targetId: id,
          previousTargetId: last && last.targetId || null,
          windowMs: this.config.focusPingPongWindowMs
        });
      }
      return pingPong;
    }

    _updateFocus(snapshot) {
      const proposed = this._proposedFocus(snapshot);
      const now = this.now();

      if (!proposed) {
        this.pendingFocusId = null;
        this.pendingFocusSinceMs = 0;
        if (this.focusTargetId && !this._visibleMonsterIds().has(String(this.focusTargetId))) {
          this.focusTargetId = null;
          this.focusSource = null;
          this.focusSinceMs = 0;
          this.metrics.focusChanges += 1;
        }
        return;
      }

      this.metrics.assistTargetsObserved += 1;
      if (String(proposed.id) === String(this.focusTargetId || '')) {
        this.pendingFocusId = null;
        this.pendingFocusSinceMs = 0;
        this.focusSource = proposed.source;
        return;
      }

      if (String(proposed.id) !== String(this.pendingFocusId || '')) {
        this.pendingFocusId = proposed.id;
        this.pendingFocusSinceMs = now;
        if (!this.focusTargetId) this.pendingFocusSinceMs = now - this.config.focusHoldMs;
      }

      if (now - this.pendingFocusSinceMs < this.config.focusHoldMs) return;
      this._recordFocusTarget(proposed.id, proposed.source, now);
      this.focusTargetId = proposed.id;
      this.focusSource = proposed.source;
      this.focusSinceMs = now;
      this.pendingFocusId = null;
      this.pendingFocusSinceMs = 0;
      this.metrics.focusUpdates += 1;
      this.metrics.focusChanges += 1;
      if (this.logger) this.logger.info('Party Focus aktualisiert', {
        targetId: this.focusTargetId,
        source: this.focusSource
      });
    }

    preferredTargetId() {
      return this.focusTargetId;
    }

    isOwnedPartyMember(name) {
      if (name == null) return false;
      const snapshot = this.lastSnapshot || this.snapshot();
      return !!(snapshot && Array.isArray(snapshot.ownedMemberNames)
        && snapshot.ownedMemberNames.includes(String(name)));
    }

    _supportReadiness(skillId, member, allowDead = false) {
      if (this.classSkills && typeof this.classSkills.isSkillEnabled === 'function'
          && this.classSkills.isSkillEnabled(skillId) !== true) return null;
      if (!this.game || typeof this.game.skillReadiness !== 'function') return null;
      return this.game.skillReadiness(skillId, member && member.name || null, { allowDeadTarget: allowDead });
    }

    _chooseSupport(snapshot) {
      if (!snapshot || !snapshot.coordinationEnabled) return null;
      const local = snapshot.ownedMembers.find(member => member.local);
      if (!local) return null;
      if (this.supportSuspended || this.pendingSupport || this.now() < this.supportBackoffUntil) return null;

      const ctype = String(local.ctype || '').toLowerCase();

      if (ctype === 'priest') {
        const downed = snapshot.ownedMembers
          .filter(member => !member.local && member.rip && member.visible)
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (downed.length) {
          const target = downed[0];
          const readiness = this._supportReadiness('revive', target, true);
          if (readiness && readiness.allowed) {
            return { kind: 'revive', action: 'use_skill', args: ['revive', target.name], target, readiness };
          }
        }

        const injured = snapshot.ownedMembers
          .filter(member => !member.rip && member.visible && member.hpRatio != null && member.hpRatio < 0.999)
          .sort((a, b) => a.hpRatio - b.hpRatio);
        const partyHealTargets = injured.filter(member => member.hpRatio <= this.config.partyHealHpRatio);
        if (partyHealTargets.length >= this.config.partyHealMinMembers) {
          const readiness = this._supportReadiness('partyheal', null, false);
          if (readiness && readiness.allowed) {
            return { kind: 'partyheal', action: 'use_skill', args: ['partyheal'], target: null, readiness };
          }
        }

        const target = injured.find(member => member.hpRatio <= this.config.healHpRatio);
        if (target) {
          const readiness = this._supportReadiness('heal', target, false);
          if (readiness && readiness.allowed && this.actions.available('heal')) {
            const raw = this.game.playerReference(target.name);
            if (raw) return { kind: 'heal', action: 'heal', args: [raw], target, readiness };
          }
        }
        return null;
      }

      if (ctype === 'mage') {
        const localMp = finite(local.mp);
        const localMaxMp = finite(local.maxMp);
        const reserve = localMaxMp != null ? Math.ceil(localMaxMp * 0.45) : null;
        const transferable = localMp != null && reserve != null ? Math.max(0, localMp - reserve) : 0;

        if (transferable > 0) {
          const energyTarget = snapshot.ownedMembers
            .filter(member => !member.local && !member.rip && member.visible
              && finite(member.mp) != null && finite(member.maxMp) != null && finite(member.maxMp) > 0
              && finite(member.mp) / finite(member.maxMp) < 0.35)
            .sort((a, b) => (finite(a.mp) / finite(a.maxMp)) - (finite(b.mp) / finite(b.maxMp)))[0] || null;
          if (energyTarget) {
            const readiness = this._supportReadiness('energize', energyTarget, false);
            const amount = Math.min(200, Math.max(1, Math.floor(transferable)));
            if (readiness && readiness.allowed && readiness.activeCondition !== true && amount > 0) {
              return {
                kind: 'energize',
                action: 'use_skill',
                args: ['energize', energyTarget.name, amount],
                target: energyTarget,
                amount,
                readiness
              };
            }
          }
        }

        if (localMp != null && localMaxMp != null && localMaxMp > 0 && localMp / localMaxMp >= 0.65) {
          const tank = snapshot.ownedMembers
            .filter(member => !member.local && !member.rip && member.visible
              && member.role === 'TANK' && member.targetId)
            .sort((a, b) => (a.hpRatio == null ? 1 : a.hpRatio) - (b.hpRatio == null ? 1 : b.hpRatio))[0] || null;
          if (tank) {
            const readiness = this._supportReadiness('reflection', tank, false);
            if (readiness && readiness.allowed && readiness.activeCondition !== true) {
              return { kind: 'reflection', action: 'use_skill', args: ['reflection', tank.name], target: tank, readiness };
            }
          }
        }
        return null;
      }

      if (ctype === 'rogue') {
        const localMp = finite(local.mp);
        const localMaxMp = finite(local.maxMp);
        if (localMp == null || localMaxMp == null || localMaxMp <= 0 || localMp / localMaxMp < 0.60) return null;
        const targets = snapshot.ownedMembers
          .filter(member => !member.rip && member.visible)
          .sort((a, b) => {
            if (a.local !== b.local) return a.local ? 1 : -1;
            return String(a.name).localeCompare(String(b.name));
          });
        // Apply rspeed once per eligible owned member; live condition
        // readiness prevents recasting on members that are already buffed.
        for (const target of targets) {
          const readiness = this._supportReadiness('rspeed', target, false);
          if (readiness && readiness.allowed && readiness.activeCondition !== true) {
            return { kind: 'rspeed', action: 'use_skill', args: ['rspeed', target.name], target, readiness };
          }
        }
      }

      return null;
    }

    _settleSupport(pending, state, response) {
      if (!pending || !this.pendingSupport || this.pendingSupport.id !== pending.id) return;
      if (state === 'CONFIRMED') {
        this.metrics.supportConfirmed += 1;
        this.lastSupport = {
          at: new Date().toISOString(),
          id: pending.id,
          kind: pending.kind,
          target: pending.targetName,
          state,
          response: response == null ? null : clone(response)
        };
      } else if (state === 'REJECTED') {
        this.metrics.supportRejected += 1;
        this.supportBackoffUntil = this.now() + this.config.supportBackoffMs;
        this.lastSupport = {
          at: new Date().toISOString(),
          id: pending.id,
          kind: pending.kind,
          target: pending.targetName,
          state,
          error: errorReason(response, 'PARTY_SUPPORT_REJECTED')
        };
      } else {
        this.metrics.supportUnknown += 1;
        this.supportSuspended = true;
        this.supportSuspendedReason = errorReason(response, 'PARTY_SUPPORT_UNKNOWN');
        this.lastSupport = {
          at: new Date().toISOString(),
          id: pending.id,
          kind: pending.kind,
          target: pending.targetName,
          state: 'UNKNOWN',
          error: this.supportSuspendedReason
        };
      }
      this.pendingSupport = null;
    }

    _watchSupport(dispatch, pending, generation) {
      const value = dispatch && dispatch.value;
      if (!value || typeof value.then !== 'function') {
        if (value && typeof value === 'object' && value.failed === true) this._settleSupport(pending, 'REJECTED', value);
        else if (value && typeof value === 'object' && (value.success === true || value.response || value.place || value.heal != null)) this._settleSupport(pending, 'CONFIRMED', value);
        else this._settleSupport(pending, 'UNKNOWN', value);
        return;
      }
      Promise.resolve(value).then(response => {
        if (generation !== this.supportGeneration) return;
        if (!this.pendingSupport || this.pendingSupport.id !== pending.id) return;
        if (response && typeof response === 'object' && response.failed === true) this._settleSupport(pending, 'REJECTED', response);
        else this._settleSupport(pending, 'CONFIRMED', response);
      }, error => {
        if (generation !== this.supportGeneration) return;
        if (!this.pendingSupport || this.pendingSupport.id !== pending.id) return;
        const reason = errorReason(error, 'PARTY_SUPPORT_PROMISE_REJECTED');
        const known = /cooldown|no_mp|too_far|range|not_found|cant_use|cannot_use|level|requirements|weapon|slot|consume|immune|disabled/i.test(reason);
        this._settleSupport(pending, known ? 'REJECTED' : 'UNKNOWN', error);
      }).catch(() => {});
    }

    _dispatchSupport(decision) {
      let dispatch;
      try {
        dispatch = this.actions.dispatch(decision.action, decision.args);
      } catch (error) {
        this.lastDecision = { at: new Date().toISOString(), type: 'SUPPORT_BLOCKED', error: errorReason(error) };
        return;
      }
      if (!dispatch || dispatch.state !== 'DISPATCHED') {
        const state = dispatch && dispatch.state || null;
        if (state === 'UNKNOWN') {
          if (decision.kind === 'heal') this.metrics.healsDispatched += 1;
          if (decision.kind === 'partyheal') this.metrics.partyHealsDispatched += 1;
          if (decision.kind === 'revive') this.metrics.revivesDispatched += 1;
          if (decision.kind === 'energize') this.metrics.energizesDispatched += 1;
          if (decision.kind === 'reflection') this.metrics.reflectionsDispatched += 1;
          if (decision.kind === 'rspeed') this.metrics.speedBuffsDispatched += 1;

          const pending = {
            id: dispatch.id,
            kind: decision.kind,
            targetName: decision.target && decision.target.name || null,
            dispatchedAt: dispatch.at || new Date().toISOString()
          };
          this.pendingSupport = pending;
          this.lastDecision = {
            at: new Date().toISOString(),
            type: 'SUPPORT_UNKNOWN',
            kind: pending.kind,
            target: pending.targetName
          };
          this._settleSupport(pending, 'UNKNOWN', dispatch.error || dispatch);
          return;
        }
        this.lastDecision = { at: new Date().toISOString(), type: 'SUPPORT_NOT_DISPATCHED', state };
        return;
      }

      if (decision.kind === 'heal') this.metrics.healsDispatched += 1;
      if (decision.kind === 'partyheal') this.metrics.partyHealsDispatched += 1;
      if (decision.kind === 'revive') this.metrics.revivesDispatched += 1;
      if (decision.kind === 'energize') this.metrics.energizesDispatched += 1;
      if (decision.kind === 'reflection') this.metrics.reflectionsDispatched += 1;
      if (decision.kind === 'rspeed') this.metrics.speedBuffsDispatched += 1;

      const pending = {
        id: dispatch.id,
        kind: decision.kind,
        targetName: decision.target && decision.target.name || null,
        dispatchedAt: new Date().toISOString()
      };
      this.pendingSupport = pending;
      this.lastDecision = {
        at: new Date().toISOString(),
        type: 'SUPPORT_DISPATCHED',
        kind: pending.kind,
        target: pending.targetName
      };
      const generation = this.supportGeneration;
      this._watchSupport(dispatch, pending, generation);
    }

    _tick() {
      if (!this.active) return;
      this.metrics.ticks += 1;
      const snapshot = this.snapshot();
      this.lastSnapshot = snapshot;
      this.metrics.partySnapshots += 1;

      if (this.heartbeat) {
        this.heartbeat({
          phase: snapshot.coordinationEnabled ? 'party-coordination' : 'party-observe',
          size: snapshot.size,
          owned: snapshot.ownedMemberNames.length,
          focusTargetId: this.focusTargetId
        });
      }

      if (!snapshot.available || snapshot.size < 2) {
        this.metrics.noPartyTicks += 1;
        this.focusTargetId = null;
        this.focusSource = null;
        return;
      }
      if (snapshot.foreignMemberNames.length) {
        this.metrics.foreignPartyBlocks += 1;
        this.focusTargetId = null;
        this.focusSource = null;
        this.lastDecision = {
          at: new Date().toISOString(),
          type: 'FOREIGN_PARTY_BLOCK',
          members: snapshot.foreignMemberNames.slice()
        };
        return;
      }

      this._updateFocus(snapshot);
      const support = this._chooseSupport(snapshot);
      if (support) this._dispatchSupport(support);
    }

    status() {
      const snapshot = this.lastSnapshot || this.snapshot();
      const localClass = snapshot && snapshot.ownedMembers && snapshot.ownedMembers.find(member => member.local);
      const partyBuffSkills = [];
      if (localClass && this.game && typeof this.game.skillDefinition === 'function') {
        const candidates = ['warcry', 'darkblessing', 'partyheal', 'energize', 'reflection', 'rspeed'];
        for (const id of candidates) {
          const definition = this.game.skillDefinition(id);
          if (definition && definition.classes.includes(String(localClass.ctype || '').toLowerCase()) && (definition.party || definition.multi || id !== 'partyheal')) {
            partyBuffSkills.push(id);
          }
        }
      }
      return {
        schemaVersion: 1,
        active: this.active,
        party: clone(snapshot),
        focus: {
          targetId: this.focusTargetId,
          source: this.focusSource,
          sinceMs: this.focusSinceMs || null,
          pendingTargetId: this.pendingFocusId,
          recentHistory: clone(this.focusHistory)
        },
        support: {
          pending: clone(this.pendingSupport),
          suspended: this.supportSuspended,
          suspendedReason: this.supportSuspendedReason,
          last: clone(this.lastSupport),
          backoffUntilMs: this.supportBackoffUntil || null
        },
        partyBuffSkills,
        lastDecision: clone(this.lastDecision),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.PartyCoordinator = PartyCoordinator;
})(typeof globalThis !== 'undefined' ? globalThis : this);
