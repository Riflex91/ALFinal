(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.Scheduler) throw new Error('ALBOT_SCHEDULER_MISSING');

  class ALBotRuntime {
    constructor(options = {}) {
      this.version = options.version || '0.7.0-h7';
      this.root = options.root || root;
      this.bootCount = Math.max(1, Number(options.bootCount) || 1);
      this.replacedPrevious = options.replacedPrevious === true;
      this.loadedAt = new Date().toISOString();
      this.startedAt = null;
      this.running = false;
      this.runEpoch = 0;
      this.bus = new ns.EventBus();
      this.storage = new ns.StorageAdapter(this.root);
      this.logger = new ns.Logger({ bus: this.bus, limit: 400 });
      this.stopLatch = new ns.EmergencyStop({ storage: this.storage, logger: this.logger, bus: this.bus });
      this.scheduler = new ns.Scheduler({ root: this.root, logger: this.logger, bus: this.bus });
      this.modules = new ns.ModuleRegistry({ logger: this.logger, scheduler: this.scheduler });
      this.scheduler.setErrorHandler(details => this.modules.handleResourceError(details));
      this.goals = new ns.GoalService({ storage: this.storage, logger: this.logger });
      this.game = new ns.AdventureLandGameAdapter({ root: this.root, logger: this.logger });
      this.actions = new ns.GameActionBoundary({
        root: this.root,
        logger: this.logger,
        assertAllowed: action => this.assertActionAllowed(action)
      });
      this.movement = new ns.MovementController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions
      });
      this.classSkills = new ns.ClassSkillController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions
      });
      this.combat = new ns.CombatController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        movement: this.movement,
        classSkills: this.classSkills
      });
      this.knowledge = new ns.KnowledgeService({ logger: this.logger, storage: this.storage });
      this.knowledgeProvider = new ns.WindowsBridgeKnowledgeProvider({ root: this.root, logger: this.logger });
      this.knowledge.setProvider(this.knowledgeProvider);
      this.roster = new ns.CharacterRosterService({ root: this.root, logger: this.logger });
      this.party = new ns.PartyCoordinator({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        roster: this.roster
      });
      this.combat.party = this.party;
      this.liveTests = new ns.LiveTestRunner({
        runtime: this,
        logger: this.logger,
        bus: this.bus
      });
      this.ui = null;
      this.lastError = null;
      this._destroyed = false;
      this._registerCoreModules();
      this._registerLiveTests();
      this._installErrorCapture();
      this.logger.info('AL Bot Runtime erstellt', {
        version: this.version,
        bootCount: this.bootCount,
        replacedPrevious: this.replacedPrevious,
        stopLatched: this.stopLatch.status().latched
      });
    }

    _registerCoreModules() {
      this.modules.register({
        id: 'runtime-health',
        title: 'Runtime Health',
        version: '0.7.0',
        watchdogMs: 4000,
        start: context => {
          context.scope.interval('heartbeat', () => {
            context.heartbeat({
              at: new Date().toISOString(),
              running: this.running,
              runEpoch: this.runEpoch
            });
            try { this.roster.refresh(); } catch (_) {}
          }, 1000, { immediate: true });
        },
        stop: () => {},
        status: () => ({
          purpose: 'runtime-heartbeat',
          runEpoch: this.runEpoch
        })
      });

      this.modules.register({
        id: 'movement',
        title: 'Movement',
        version: '0.7.0',
        start: context => this.movement.start(context),
        stop: reason => this.movement.stop(reason),
        status: () => this.movement.status()
      });

      this.modules.register({
        id: 'class-skills',
        title: 'Class Skills',
        version: '0.7.0',
        start: () => this.classSkills.start(),
        stop: reason => this.classSkills.stop(reason),
        status: () => this.classSkills.status()
      });

      this.modules.register({
        id: 'party',
        title: 'Party',
        version: '0.7.0',
        start: context => this.party.start(context),
        stop: reason => this.party.stop(reason),
        status: () => this.party.status()
      });

      this.modules.register({
        id: 'combat',
        title: 'Combat',
        version: '0.7.0',
        start: context => this.combat.start(context),
        stop: reason => this.combat.stop(reason),
        status: () => this.combat.status()
      });
    }

    _registerLiveTests() {
      let baseline = null;
      let livePlan = null;
      let h6Baseline = null;
      let h6Plan = null;
      let h7Baseline = null;
      let h7Plan = null;
      this.liveTests.register({
        id: 'h5-combat',
        title: 'H5 – Einfacher Kampf',
        description: 'Ein-Klick-Live-Test für Targeting, Range, Cooldown, bestätigte Angriffe, Cleanup und Fail-Safe.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.combat.stopSession('H5_LIVE_TEST_RESET'); } catch (_) {}
          livePlan = null;
          const metrics = runtime.combat.status().metrics;
          baseline = {
            targetsAcquired: metrics.targetsAcquired,
            attacksDispatched: metrics.attacksDispatched,
            attacksConfirmed: metrics.attacksConfirmed,
            attackUnknown: metrics.attackUnknown,
            killsObserved: metrics.killsObserved
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.combat.stopSession('H5_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Combat-Sicherheit und sichtbares Ziel prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              assert(runtime.actions.available('attack'), 'ATTACK_API_UNAVAILABLE');
              assert(runtime.actions.available('change_target'), 'CHANGE_TARGET_API_UNAVAILABLE');
              const combatModule = runtime.modules.describe('combat');
              assert(combatModule && combatModule.state === 'ACTIVE', 'COMBAT_MODULE_NOT_ACTIVE');
              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');

              const attackBudget = Math.max(5, Math.min(maxHp * 0.08, currentHp * 0.08));
              const candidates = runtime.combat.safeCandidates({
                maxAcquireDistance: 450,
                maxAttack: attackBudget
              });
              assert(candidates.length > 0, 'NO_SAFE_VISIBLE_MONSTER_FOR_CURRENT_HP');
              const target = candidates[0];
              const targetAttack = Number(target.attack);
              assert(Number.isFinite(targetAttack) && targetAttack >= 0, 'TARGET_ATTACK_UNAVAILABLE');

              const absoluteRetreatHp = Math.max(100, targetAttack * 20);
              const minimumStartHp = Math.max(150, targetAttack * 25);
              assert(currentHp >= minimumStartHp,
                'HP_TOO_LOW_FOR_SAFE_H5_TEST:' + Math.round(currentHp) + '<' + Math.round(minimumStartHp));

              const retreatHpRatio = Math.max(0.05, Math.min(0.35, absoluteRetreatHp / maxHp));
              const resumeHpRatio = Math.max(
                retreatHpRatio + 0.05,
                Math.min(0.65, retreatHpRatio * 1.75)
              );

              livePlan = {
                monsterType: target.mtype || null,
                maxAttack: attackBudget,
                retreatHpRatio,
                resumeHpRatio,
                targetId: target.id,
                targetAttack,
                startingHp: currentHp,
                maxHp
              };

              return {
                character: game.character.name,
                hp: currentHp,
                maxHp,
                target: target.name || target.mtype || target.id,
                mtype: target.mtype,
                distance: target.distance,
                attack: target.attack,
                attackBudget,
                retreatHp: Math.round(maxHp * retreatHpRatio),
                retreatHpRatio
              };
            }
          },
          {
            id: 'start-combat',
            title: 'Autonome Combat-Session starten und Target bestätigen',
            timeoutMs: 10000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(livePlan, 'H5_LIVE_TEST_PLAN_MISSING');
              const result = runtime.combat.startSession({
                owner: 'live-test-h5',
                monsterType: livePlan.monsterType || undefined,
                maxAcquireDistance: 450,
                maxAttack: livePlan.maxAttack,
                retreatHpRatio: livePlan.retreatHpRatio,
                resumeHpRatio: livePlan.resumeHpRatio,
                minMpRatio: 0,
                kiting: false
              });
              assert(result && result.accepted === true, result && result.reason || 'COMBAT_SESSION_START_FAILED');
              const status = await waitFor(() => {
                const current = runtime.combat.status();
                if (current.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(current.lastSession.state)) {
                  throw new Error(current.lastSession.reason || current.lastSession.state);
                }
                return current.session && current.session.targetId ? current : null;
              }, { timeoutMs: 8000, pollMs: 100, label: 'target-acquisition' });
              return {
                sessionId: status.session.id,
                targetId: status.session.targetId,
                targetType: status.session.targetType
              };
            }
          },
          {
            id: 'confirmed-attack',
            title: 'Mindestens einen Angriff durch Live-Evidence bestätigen',
            timeoutMs: 35000,
            run: async ({ runtime, assert, waitFor }) => {
              const result = await waitFor(() => {
                const current = runtime.combat.status();
                if (current.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(current.lastSession.state)) {
                  throw new Error(current.lastSession.reason || current.lastSession.state);
                }
                const confirmed = current.metrics.attacksConfirmed - baseline.attacksConfirmed;
                const killed = current.metrics.killsObserved - baseline.killsObserved;
                return confirmed > 0 || killed > 0 ? current : null;
              }, { timeoutMs: 30000, pollMs: 125, label: 'confirmed-attack' });
              assert(result.metrics.attackUnknown === baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_TEST');
              return {
                targetsAcquired: result.metrics.targetsAcquired - baseline.targetsAcquired,
                attacksDispatched: result.metrics.attacksDispatched - baseline.attacksDispatched,
                attacksConfirmed: result.metrics.attacksConfirmed - baseline.attacksConfirmed,
                killsObserved: result.metrics.killsObserved - baseline.killsObserved
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Combat fünf Sekunden ohne UNKNOWN/Fail-Safe beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const current = runtime.combat.status();
              assert(current.metrics.attackUnknown === baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_STABILITY_WINDOW');
              assert(!(current.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(current.lastSession.state)), current.lastSession && current.lastSession.reason || 'COMBAT_FAILED');
              return {
                active: current.active,
                state: current.state,
                attacksConfirmed: current.metrics.attacksConfirmed - baseline.attacksConfirmed,
                killsObserved: current.metrics.killsObserved - baseline.killsObserved,
                approaches: current.metrics.approaches
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Combat sauber stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.combat.stopSession('H5_LIVE_TEST_COMPLETE');
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              assert(combat.active === false, 'COMBAT_STILL_ACTIVE_AFTER_STOP');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')), 'COMBAT_MOVEMENT_STILL_ACTIVE');
              return {
                combatActive: combat.active,
                movementActive: movement.active,
                lastSession: combat.lastSession && {
                  state: combat.lastSession.state,
                  reason: combat.lastSession.reason,
                  counters: combat.lastSession.counters
                }
              };
            }
          }
        ]
      });

      this.liveTests.register({
        id: 'h6-class-logic',
        title: 'H6 – Klassenlogik',
        description: 'Ein-Klick-Live-Test für klassenspezifische Skills, Cooldown-/MP-Planung, Defensive/Support und Anti-Spam.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.combat.stopSession('H6_LIVE_TEST_RESET'); } catch (_) {}
          h6Plan = null;
          const skillMetrics = runtime.classSkills.status().metrics;
          const combatMetrics = runtime.combat.status().metrics;
          h6Baseline = {
            dispatched: skillMetrics.dispatched,
            confirmed: skillMetrics.confirmed,
            rejected: skillMetrics.rejected,
            unknown: skillMetrics.unknown,
            spamSkips: skillMetrics.spamSkips,
            cooldownSkips: skillMetrics.cooldownSkips,
            attackUnknown: combatMetrics.attackUnknown
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.combat.stopSession('H6_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Klasse, Live-Skills und sicheren Gegner prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              assert(runtime.actions.available('use_skill'), 'USE_SKILL_API_UNAVAILABLE');

              const classModule = runtime.modules.describe('class-skills');
              assert(classModule && classModule.state === 'ACTIVE', 'CLASS_SKILL_MODULE_NOT_ACTIVE');

              const ctype = String(game.character.ctype || '').toLowerCase();
              const supported = runtime.classSkills.supportedSkills(ctype);
              assert(supported.length > 0, 'CLASS_NOT_SUPPORTED_BY_H6:' + ctype);
              const liveSkills = runtime.classSkills.liveSkillSummary(ctype).filter(row => row.available);
              assert(liveSkills.length > 0, 'NO_SUPPORTED_LIVE_SKILL_FOR_CLASS:' + ctype);

              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');

              const attackBudget = Math.max(5, Math.min(maxHp * 0.08, currentHp * 0.08));
              const candidates = runtime.combat.safeCandidates({
                maxAcquireDistance: 450,
                maxAttack: attackBudget
              });
              assert(candidates.length > 0, 'NO_SAFE_VISIBLE_MONSTER_FOR_H6');

              let chosen = null;
              let preview = null;
              for (const candidate of candidates) {
                const decision = runtime.classSkills.preview(candidate.id);
                if (decision) {
                  chosen = candidate;
                  preview = decision;
                  break;
                }
              }
              assert(chosen && preview, 'NO_SAFE_CLASS_SKILL_OPPORTUNITY:' + ctype);

              const targetAttack = Number(chosen.attack);
              assert(Number.isFinite(targetAttack) && targetAttack >= 0, 'TARGET_ATTACK_UNAVAILABLE');
              const absoluteRetreatHp = Math.max(100, targetAttack * 20);
              const minimumStartHp = Math.max(150, targetAttack * 25);
              assert(currentHp >= minimumStartHp,
                'HP_TOO_LOW_FOR_SAFE_H6_TEST:' + Math.round(currentHp) + '<' + Math.round(minimumStartHp));

              const retreatHpRatio = Math.max(0.05, Math.min(0.35, absoluteRetreatHp / maxHp));
              const resumeHpRatio = Math.max(
                retreatHpRatio + 0.05,
                Math.min(0.65, retreatHpRatio * 1.75)
              );

              h6Plan = {
                characterClass: ctype,
                monsterType: chosen.mtype || null,
                maxAttack: attackBudget,
                retreatHpRatio,
                resumeHpRatio,
                previewSkillId: preview.skillId,
                previewReason: preview.reason
              };

              return {
                character: game.character.name,
                characterClass: ctype,
                supportedSkills: supported,
                liveSkills: liveSkills.map(row => row.id),
                previewSkillId: preview.skillId,
                previewReason: preview.reason,
                target: chosen.name || chosen.mtype || chosen.id,
                distance: chosen.distance,
                attack: chosen.attack,
                retreatHp: Math.round(maxHp * retreatHpRatio)
              };
            }
          },
          {
            id: 'start-combat',
            title: 'Combat mit H6-Klassenlogik starten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h6Plan, 'H6_LIVE_TEST_PLAN_MISSING');
              const result = runtime.combat.startSession({
                owner: 'live-test-h6',
                monsterType: h6Plan.monsterType || undefined,
                maxAcquireDistance: 450,
                maxAttack: h6Plan.maxAttack,
                retreatHpRatio: h6Plan.retreatHpRatio,
                resumeHpRatio: h6Plan.resumeHpRatio,
                minMpRatio: 0,
                kiting: false
              });
              assert(result && result.accepted === true, result && result.reason || 'H6_COMBAT_SESSION_START_FAILED');
              const status = await waitFor(() => {
                const combat = runtime.combat.status();
                if (combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)) {
                  throw new Error(combat.lastSession.reason || combat.lastSession.state);
                }
                return combat.session && combat.session.targetId ? combat : null;
              }, { timeoutMs: 8000, pollMs: 100, label: 'h6-target-acquisition' });
              return {
                sessionId: status.session.id,
                targetId: status.session.targetId,
                targetType: status.session.targetType
              };
            }
          },
          {
            id: 'class-skill',
            title: 'Mindestens einen klassenspezifischen Skill serverbestätigt einsetzen',
            timeoutMs: 20000,
            run: async ({ runtime, assert, waitFor }) => {
              const status = await waitFor(() => {
                const skills = runtime.classSkills.status();
                if (skills.metrics.unknown > h6Baseline.unknown) {
                  throw new Error(skills.suspendedReason || 'CLASS_SKILL_UNKNOWN');
                }
                return skills.metrics.confirmed > h6Baseline.confirmed ? skills : null;
              }, { timeoutMs: 15000, pollMs: 100, label: 'confirmed-class-skill' });

              assert(status.lastUse && status.lastUse.state === 'CONFIRMED', 'CLASS_SKILL_NOT_CONFIRMED');
              return {
                skillId: status.lastUse.skillId,
                kind: status.lastUse.kind,
                reason: status.lastUse.reason,
                damage: status.lastUse.damage,
                lethal: status.lastUse.lethal,
                dispatched: status.metrics.dispatched - h6Baseline.dispatched,
                confirmed: status.metrics.confirmed - h6Baseline.confirmed
              };
            }
          },
          {
            id: 'anti-spam-window',
            title: 'Klassenlogik fünf Sekunden ohne Skill-Spam/UNKNOWN beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const skills = runtime.classSkills.status();
              const combat = runtime.combat.status();

              assert(skills.metrics.unknown === h6Baseline.unknown, 'CLASS_SKILL_UNKNOWN_DURING_STABILITY_WINDOW');
              assert(combat.metrics.attackUnknown === h6Baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_H6_STABILITY_WINDOW');
              assert(!(combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)),
                combat.lastSession && combat.lastSession.reason || 'COMBAT_FAILED_DURING_H6');

              const dispatched = skills.metrics.dispatched - h6Baseline.dispatched;
              const confirmed = skills.metrics.confirmed - h6Baseline.confirmed;
              const rejected = skills.metrics.rejected - h6Baseline.rejected;
              const pending = skills.pending ? 1 : 0;
              assert(dispatched <= confirmed + rejected + pending, 'CLASS_SKILL_DISPATCH_ACCOUNTING_INVALID');
              assert(dispatched <= 12, 'CLASS_SKILL_SPAM_GUARD_EXCEEDED:' + dispatched);

              return {
                class: skills.currentClass,
                dispatched,
                confirmed,
                rejected,
                pending,
                spamSkips: skills.metrics.spamSkips - h6Baseline.spamSkips,
                cooldownSkips: skills.metrics.cooldownSkips - h6Baseline.cooldownSkips,
                suspended: skills.suspended
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Klassenlogik und Combat sauber freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.combat.stopSession('H6_LIVE_TEST_COMPLETE');
              const combat = runtime.combat.status();
              const skills = runtime.classSkills.status();
              const movement = runtime.movement.status();

              assert(combat.active === false, 'H6_COMBAT_STILL_ACTIVE_AFTER_STOP');
              assert(skills.pending == null, 'H6_CLASS_SKILL_STILL_PENDING_AFTER_STOP');
              assert(skills.sessionId == null, 'H6_CLASS_SKILL_SESSION_STILL_OWNED');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')),
                'H6_COMBAT_MOVEMENT_STILL_ACTIVE');

              return {
                combatActive: combat.active,
                classSkillPending: !!skills.pending,
                classSkillSessionId: skills.sessionId,
                movementActive: movement.active,
                skillMetrics: {
                  dispatched: skills.metrics.dispatched - h6Baseline.dispatched,
                  confirmed: skills.metrics.confirmed - h6Baseline.confirmed,
                  rejected: skills.metrics.rejected - h6Baseline.rejected,
                  unknown: skills.metrics.unknown - h6Baseline.unknown
                }
              };
            }
          }
        ]
      });

      this.liveTests.register({
        id: 'h7-party',
        title: 'H7 – Party',
        description: 'Ein-Klick-Live-Test für dynamische Party-Erkennung, Rollen, Focus Fire, Assist, Support-Sicht und Cleanup.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.combat.stopSession('H7_LIVE_TEST_RESET'); } catch (_) {}
          h7Plan = null;
          const party = runtime.party.status();
          const combat = runtime.combat.status();
          h7Baseline = {
            focusChanges: party.metrics.focusChanges,
            focusPingPongs: party.metrics.focusPingPongs,
            supportUnknown: party.metrics.supportUnknown,
            supportConfirmed: party.metrics.supportConfirmed,
            attackUnknown: combat.metrics.attackUnknown,
            attacksConfirmed: combat.metrics.attacksConfirmed
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.combat.stopSession('H7_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Eigene aktive Party, Rollen und sicheren Gegner prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const partyModule = runtime.modules.describe('party');
              assert(partyModule && partyModule.state === 'ACTIVE', 'PARTY_MODULE_NOT_ACTIVE');
              const party = runtime.party.snapshot();
              assert(party.available && party.size >= 2, 'H7_NEEDS_ACTIVE_PARTY_OF_AT_LEAST_2');
              assert(party.foreignMemberNames.length === 0,
                'H7_FOREIGN_PARTY_MEMBER_BLOCK:' + party.foreignMemberNames.join(','));
              assert(party.coordinationEnabled === true, 'H7_PARTY_COORDINATION_NOT_READY');
              assert(party.ownedMembers.filter(member => !member.rip).length >= 2, 'H7_NEEDS_2_LIVING_OWNED_PARTY_MEMBERS');

              const game = runtime.game.snapshot();
              assert(game && game.available && game.character && !game.character.rip, 'CHARACTER_UNAVAILABLE');
              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');

              const attackBudget = Math.max(5, Math.min(maxHp * 0.08, currentHp * 0.08));
              const candidates = runtime.combat.safeCandidates({ maxAcquireDistance: 450, maxAttack: attackBudget });
              assert(candidates.length > 0, 'NO_SAFE_VISIBLE_MONSTER_FOR_H7');
              const chosen = candidates[0];
              const targetAttack = Number(chosen.attack);
              assert(Number.isFinite(targetAttack) && targetAttack >= 0, 'TARGET_ATTACK_UNAVAILABLE');
              const absoluteRetreatHp = Math.max(100, targetAttack * 20);
              const minimumStartHp = Math.max(150, targetAttack * 25);
              assert(currentHp >= minimumStartHp,
                'HP_TOO_LOW_FOR_SAFE_H7_TEST:' + Math.round(currentHp) + '<' + Math.round(minimumStartHp));

              const retreatHpRatio = Math.max(0.05, Math.min(0.35, absoluteRetreatHp / maxHp));
              const resumeHpRatio = Math.max(retreatHpRatio + 0.05, Math.min(0.65, retreatHpRatio * 1.75));
              h7Plan = {
                monsterType: chosen.mtype || null,
                maxAttack: attackBudget,
                retreatHpRatio,
                resumeHpRatio
              };

              return {
                local: game.character.name,
                localRole: party.localRole,
                leader: party.leader,
                partySize: party.size,
                ownedMembers: party.ownedMembers.map(member => ({
                  name: member.name,
                  ctype: member.ctype,
                  role: member.role,
                  visible: member.visible,
                  rip: member.rip
                })),
                target: chosen.name || chosen.mtype || chosen.id,
                targetId: chosen.id
              };
            }
          },
          {
            id: 'focus-fire',
            title: 'Combat starten und Party-Focus/Assist konvergieren lassen',
            timeoutMs: 15000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h7Plan, 'H7_LIVE_TEST_PLAN_MISSING');
              const result = runtime.combat.startSession({
                owner: 'live-test-h7',
                monsterType: h7Plan.monsterType || undefined,
                maxAcquireDistance: 450,
                maxAttack: h7Plan.maxAttack,
                retreatHpRatio: h7Plan.retreatHpRatio,
                resumeHpRatio: h7Plan.resumeHpRatio,
                minMpRatio: 0,
                kiting: false,
                partyAssist: true
              });
              assert(result && result.accepted === true, result && result.reason || 'H7_COMBAT_SESSION_START_FAILED');

              const converged = await waitFor(() => {
                const party = runtime.party.status();
                const combat = runtime.combat.status();
                if (party.support.suspended) throw new Error(party.support.suspendedReason || 'PARTY_SUPPORT_UNKNOWN');
                if (combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)) {
                  throw new Error(combat.lastSession.reason || combat.lastSession.state);
                }
                if (!party.focus.targetId || !combat.session || !combat.session.targetId) return null;
                return String(party.focus.targetId) === String(combat.session.targetId)
                  ? { party, combat }
                  : null;
              }, { timeoutMs: 12000, pollMs: 125, label: 'party-focus-convergence' });

              return {
                focusTargetId: converged.party.focus.targetId,
                focusSource: converged.party.focus.source,
                combatTargetId: converged.combat.session.targetId,
                combatState: converged.combat.state
              };
            }
          },
          {
            id: 'party-health',
            title: 'Party-Health, Healing- und Recovery-Basis prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const party = runtime.party.status();
              assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST');
              assert(party.metrics.supportUnknown === h7Baseline.supportUnknown, 'PARTY_SUPPORT_UNKNOWN_DURING_TEST');
              const downed = party.party.ownedMembers.filter(member => member.rip).map(member => member.name);
              const injured = party.party.ownedMembers
                .filter(member => !member.rip && member.hpRatio != null && member.hpRatio < 0.999)
                .map(member => ({ name: member.name, hpRatio: member.hpRatio }));
              return {
                localRole: party.party.localRole,
                injured,
                downed,
                partyBuffSkills: party.partyBuffSkills,
                supportConfirmed: party.metrics.supportConfirmed - h7Baseline.supportConfirmed,
                supportPending: !!party.support.pending
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Fünf Sekunden Focus-Fire ohne UNKNOWN/Pingpong beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const party = runtime.party.status();
              const combat = runtime.combat.status();
              assert(party.metrics.supportUnknown === h7Baseline.supportUnknown, 'PARTY_SUPPORT_UNKNOWN_DURING_STABILITY_WINDOW');
              assert(combat.metrics.attackUnknown === h7Baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_H7_STABILITY_WINDOW');
              assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST_DURING_STABILITY_WINDOW');
              const focusChanges = party.metrics.focusChanges - h7Baseline.focusChanges;
              const focusPingPongs = party.metrics.focusPingPongs - h7Baseline.focusPingPongs;
              assert(focusPingPongs === 0, 'PARTY_FOCUS_PINGPONG_DETECTED:' + focusPingPongs);
              return {
                focusTargetId: party.focus.targetId,
                focusSource: party.focus.source,
                focusChanges,
                focusPingPongs,
                attacksConfirmed: combat.metrics.attacksConfirmed - h7Baseline.attacksConfirmed,
                supportConfirmed: party.metrics.supportConfirmed - h7Baseline.supportConfirmed,
                supportUnknown: party.metrics.supportUnknown - h7Baseline.supportUnknown
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Party-Combat sauber stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.combat.stopSession('H7_LIVE_TEST_COMPLETE');
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              const party = runtime.party.status();
              assert(combat.active === false, 'H7_COMBAT_STILL_ACTIVE_AFTER_STOP');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')),
                'H7_COMBAT_MOVEMENT_STILL_ACTIVE');
              assert(party.support.pending == null, 'H7_PARTY_SUPPORT_STILL_PENDING');
              return {
                combatActive: combat.active,
                movementActive: movement.active,
                supportPending: !!party.support.pending,
                focusTargetId: party.focus.targetId,
                partySize: party.party.size
              };
            }
          }
        ]
      });
    }

    _installErrorCapture() {
      if (!this.root || typeof this.root.addEventListener !== 'function') return;
      this._errorHandler = event => {
        const error = event && event.error;
        this.lastError = {
          at: new Date().toISOString(),
          type: 'error',
          message: String(error && error.message || event && event.message || 'Unknown error'),
          stack: error && error.stack || null
        };
        this.logger.error('Unbehandelter JavaScript-Fehler', this.lastError);
      };
      this._rejectionHandler = event => {
        const reason = event && event.reason;
        this.lastError = {
          at: new Date().toISOString(),
          type: 'unhandledrejection',
          message: String(reason && reason.message || reason || 'Unhandled rejection'),
          stack: reason && reason.stack || null
        };
        this.logger.error('Unhandled Promise Rejection', this.lastError);
      };
      this.root.addEventListener('error', this._errorHandler);
      this.root.addEventListener('unhandledrejection', this._rejectionHandler);
    }

    _removeErrorCapture() {
      if (!this.root || typeof this.root.removeEventListener !== 'function') return;
      if (this._errorHandler) this.root.removeEventListener('error', this._errorHandler);
      if (this._rejectionHandler) this.root.removeEventListener('unhandledrejection', this._rejectionHandler);
      this._errorHandler = null;
      this._rejectionHandler = null;
    }

    _runtimeContext() {
      return { runtime: this };
    }

    async start() {
      if (this._destroyed) throw new Error('ALBOT_RUNTIME_DESTROYED');
      if (this.stopLatch.status().latched) throw new Error('ALBOT_START_BLOCKED_BY_EMERGENCY_STOP');
      if (this.running) return this.status();

      this.running = true;
      this.runEpoch += 1;
      this.startedAt = new Date().toISOString();
      this.scheduler.start();
      try { this.roster.refresh(); } catch (_) {}

      await this.modules.startAll(this._runtimeContext());
      this.scheduler.interval('runtime', 'module-watchdog', () => {
        this.modules.checkWatchdogs();
      }, 1000, { immediate: true });

      this.logger.info('AL Bot gestartet', {
        runEpoch: this.runEpoch,
        schedulerGeneration: this.scheduler.status().generation
      });
      this.bus.emit('runtime', this.status());
      return this.status();
    }

    async stop(reason = 'MANUAL_STOP') {
      if (this._destroyed) return this.status();
      this.running = false;
      await this.modules.stopAll(reason);
      this.scheduler.stop(reason);
      this.logger.warn('AL Bot gestoppt', { reason, runEpoch: this.runEpoch });
      this.bus.emit('runtime', this.status());
      return this.status();
    }

    async emergencyStop(reason = 'MANUAL_EMERGENCY_STOP') {
      const stop = this.stopLatch.latch(reason);
      this.running = false;
      try { this.liveTests.cancel('EMERGENCY_STOP'); } catch (_) {}

      // Die Notbremse stoppt zuerst zentral alle Timer/Listener. Modul-Stop-Hooks
      // laufen danach nur noch zur fachlichen Bereinigung.
      this.scheduler.stop('EMERGENCY_STOP');
      await this.modules.stopAll('EMERGENCY_STOP');

      this.bus.emit('emergency-stop', stop);
      return this.status();
    }

    resetEmergencyStop() {
      this.stopLatch.reset();
      return this.status();
    }

    async restartModule(id, reason = 'MANUAL_MODULE_RESTART') {
      if (!this.running || !this.scheduler.status().enabled) throw new Error('ALBOT_RUNTIME_NOT_RUNNING');
      const result = await this.modules.restartOne(id, this._runtimeContext(), reason);
      this.bus.emit('module', result);
      return result;
    }

    async startModule(id) {
      if (!this.running || !this.scheduler.status().enabled) throw new Error('ALBOT_RUNTIME_NOT_RUNNING');
      const result = await this.modules.startOne(id, this._runtimeContext());
      this.bus.emit('module', result);
      return result;
    }

    async stopModule(id, reason = 'MANUAL_MODULE_STOP') {
      const result = await this.modules.stopOne(id, reason);
      this.bus.emit('module', result);
      return result;
    }

    actionAllowed(action = 'action') {
      if (!this.running) return false;
      if (!this.scheduler.status().enabled) return false;
      if (this.stopLatch.status().latched) return false;
      return true;
    }

    assertActionAllowed(action = 'action') {
      if (!this.running || !this.scheduler.status().enabled) throw new Error('ALBOT_RUNTIME_NOT_RUNNING:' + action);
      return this.stopLatch.assertAllowed(action);
    }

    status() {
      let roster;
      try { roster = this.roster.status(); } catch (_) { roster = null; }
      return {
        product: 'AL Bot',
        version: this.version,
        running: this.running,
        loadedAt: this.loadedAt,
        startedAt: this.startedAt,
        runEpoch: this.runEpoch,
        bootCount: this.bootCount,
        replacedPrevious: this.replacedPrevious,
        emergencyStop: this.stopLatch.status(),
        scheduler: this.scheduler.status(),
        modules: this.modules.list(),
        game: this.game.status(),
        actions: this.actions.status(),
        movement: this.movement.status(),
        classSkills: this.classSkills.status(),
        party: this.party.status(),
        combat: this.combat.status(),
        liveTests: this.liveTests.status(),
        knowledge: this.knowledge.status(),
        roster,
        goals: this.goals.list(),
        strategicPriorities: this.goals.getPriorities(),
        lastError: ns.helpers.clone(this.lastError)
      };
    }

    diagnostics() {
      const game = this.game.snapshot();
      return {
        schemaVersion: 3,
        createdAt: new Date().toISOString(),
        runtime: this.status(),
        game,
        character: game && game.character ? ns.helpers.clone(game.character) : null,
        actionBoundary: this.actions.status(),
        movement: this.movement.status(),
        classSkills: this.classSkills.status(),
        party: this.party.status(),
        combat: this.combat.status(),
        liveTests: this.liveTests.status(),
        knowledgeSnapshot: this.knowledge.snapshot(),
        logs: this.logger.list(160),
        userAgent: this.root && this.root.navigator && this.root.navigator.userAgent || null
      };
    }

    selfTest() {
      const checks = [];
      const push = (name, ok, details) => checks.push({ name, ok: !!ok, details: details || null });
      const roster = this.roster.refresh();
      const scheduler = this.scheduler.status();
      push('runtime-created', !!this.version, { version: this.version });
      push('emergency-stop-api', typeof this.emergencyStop === 'function' && typeof this.resetEmergencyStop === 'function');
      push('goal-service', Array.isArray(this.goals.list()));
      push('game-adapter', !!this.game.status() && typeof this.game.snapshot === 'function', this.game.status());
      push('action-boundary', !!this.actions.status() && this.actions.status().supportedActions.includes('move') && this.actions.status().supportedActions.includes('smart_move'), this.actions.status());
      push('movement-controller', !!this.movement.status() && typeof this.movement.moveLocal === 'function' && typeof this.movement.smartMove === 'function', this.movement.status());
      push('class-skill-controller', !!this.classSkills.status() && typeof this.classSkills.maybeUse === 'function', this.classSkills.status());
      push('party-coordinator', !!this.party.status() && typeof this.party.preferredTargetId === 'function', this.party.status());
      push('combat-controller', !!this.combat.status() && typeof this.combat.startSession === 'function' && typeof this.combat.stopSession === 'function', this.combat.status());
      push('live-test-runner', !!this.liveTests.status() && typeof this.liveTests.startRecommended === 'function', this.liveTests.status());
      push('knowledge-service', !!this.knowledge.status());
      push('windows-bridge-provider-readonly', this.knowledge.status().provider && this.knowledge.status().provider.readOnly === true, this.knowledge.status().provider);
      push('dynamic-roster-no-hardcoded-names', roster.hardcodedNamesRequired === false, {
        source: roster.source,
        farmers: roster.farmers.map(x => ({ name: x.name, ctype: x.ctype }))
      });
      push('central-scheduler', !!scheduler && typeof scheduler.totalResources === 'number', scheduler);
      push('module-lifecycle', typeof this.modules.startOne === 'function' && typeof this.modules.restartOne === 'function' && typeof this.modules.stopOne === 'function');
      push('hot-reload-cleanup', typeof this.prepareHotReload === 'function');
      return { passed: checks.every(c => c.ok), at: new Date().toISOString(), checks };
    }

    async runStabilityProbe() {
      if (!this.running || !this.scheduler.status().enabled) {
        return { passed: false, reason: 'RUNTIME_NOT_RUNNING', at: new Date().toISOString() };
      }

      const id = 'h2-runtime-probe';
      if (this.modules.has(id)) {
        try { await this.modules.stopOne(id, 'PROBE_RESET'); } catch (_) {}
        try { this.modules.unregister(id, 'PROBE_RESET'); } catch (_) {}
      }

      let beats = 0;
      this.modules.register({
        id,
        title: 'H2 Runtime Probe',
        version: '1.0.0',
        watchdogMs: 1000,
        start: context => {
          context.scope.interval('probe-heartbeat', () => {
            beats += 1;
            context.heartbeat({ beats });
          }, 50, { immediate: true });
        },
        stop: () => {},
        status: () => ({ beats })
      });

      const resourceCounts = [];
      await this.modules.startOne(id, this._runtimeContext());
      resourceCounts.push(this.scheduler.ownerStatus('module:' + id).resources.length);

      for (let i = 0; i < 3; i += 1) {
        await this.modules.restartOne(id, this._runtimeContext(), 'H2_PROBE_RESTART_' + (i + 1));
        resourceCounts.push(this.scheduler.ownerStatus('module:' + id).resources.length);
      }

      await this.modules.stopOne(id, 'H2_PROBE_DONE');
      const resourcesAfterStop = this.scheduler.ownerStatus('module:' + id).resources.length;
      const moduleAfterStop = this.modules.describe(id);
      this.modules.unregister(id, 'H2_PROBE_DONE');

      const passed = resourceCounts.every(count => count === 1)
        && resourcesAfterStop === 0
        && moduleAfterStop
        && moduleAfterStop.state === 'STOPPED';

      const result = {
        passed,
        at: new Date().toISOString(),
        restartResourceCounts: resourceCounts,
        resourcesAfterStop,
        beats,
        scheduler: this.scheduler.status()
      };
      this.logger.info('H2 Runtime-Stabilitätstest abgeschlossen', result);
      return result;
    }

    prepareHotReload(reason = 'HOT_RELOAD') {
      if (this._destroyed) return;
      this.running = false;
      try { this.liveTests.cancel(reason); } catch (_) {}

      // Zuerst alle zentral verwalteten Ressourcen synchron stoppen. Dadurch kann
      // ein neu geladenes Bundle niemals alte Timer/Listener weiterlaufen lassen.
      this.scheduler.stop(reason);
      this.modules.forceCleanup(reason);

      try { if (this.ui && typeof this.ui.destroy === 'function') this.ui.destroy(); } catch (_) {}
      this.ui = null;
      this._removeErrorCapture();
      this.bus.clear();
      this._destroyed = true;
    }

    destroy() {
      this.prepareHotReload('DESTROY');
    }
  }

  ns.ALBotRuntime = ALBotRuntime;
})(typeof globalThis !== 'undefined' ? globalThis : this);
