(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.Scheduler) throw new Error('ALBOT_SCHEDULER_MISSING');

  class ALBotRuntime {
    constructor(options = {}) {
      this.version = options.version || '0.10.0-h10';
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
      this.farming = new ns.AdaptiveFarmingController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        combat: this.combat,
        party: this.party,
        classSkills: this.classSkills
      });
      this.combat.party = this.party;
      this.combat.farming = this.farming;
      this.farmIntelligence = new ns.FarmIntelligenceController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        combat: this.combat,
        farming: this.farming,
        movement: this.movement,
        party: this.party
      });
      this.inventory = new ns.LootInventoryController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        goals: this.goals
      });
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

      this.modules.register({
        id: 'adaptive-farming',
        title: 'Adaptive Farming',
        version: '0.8.0',
        start: context => this.farming.start(context),
        stop: reason => this.farming.stop(reason),
        status: () => this.farming.status()
      });

      this.modules.register({
        id: 'farm-intelligence',
        title: 'Farm Intelligence',
        version: '0.9.0',
        start: context => this.farmIntelligence.start(context),
        stop: reason => this.farmIntelligence.stop(reason),
        status: () => this.farmIntelligence.status()
      });

      this.modules.register({
        id: 'loot-inventory',
        title: 'Loot & Inventory',
        version: '0.10.0',
        start: context => this.inventory.start(context),
        stop: reason => this.inventory.stop(reason),
        status: () => this.inventory.status()
      });
    }

    _registerLiveTests() {
      let baseline = null;
      let livePlan = null;
      let h6Baseline = null;
      let h6Plan = null;
      let h7Baseline = null;
      let h7Plan = null;
      let h8Baseline = null;
      let h8Plan = null;
      let h9Baseline = null;
      let h9Plan = null;
      let h10Baseline = null;
      let h10Before = null;
      let h10StartedH9 = false;
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

              const observerOnly = party.localRole === 'LOGISTICS'
                || String(game.character.ctype || '').toLowerCase() === 'merchant';

              if (observerOnly) {
                h7Plan = { observerOnly: true };
                return {
                  local: game.character.name,
                  localRole: party.localRole,
                  leader: party.leader,
                  partySize: party.size,
                  observerOnly: true,
                  ownedMembers: party.ownedMembers.map(member => ({
                    name: member.name,
                    ctype: member.ctype,
                    role: member.role,
                    visible: member.visible,
                    rip: member.rip
                  })),
                  target: null,
                  targetId: null
                };
              }

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
                observerOnly: false,
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
                observerOnly: false,
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
            title: 'Party-Focus/Assist prüfen und bei Combat-Rollen konvergieren lassen',
            timeoutMs: 15000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h7Plan, 'H7_LIVE_TEST_PLAN_MISSING');
              if (h7Plan.observerOnly) {
                const party = runtime.party.status();
                assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST');
                return {
                  observerOnly: true,
                  reason: 'LOGISTICS_ROLE_NO_COMBAT',
                  focusTargetId: party.focus.targetId || null,
                  focusSource: party.focus.source || null,
                  combatTargetId: null,
                  combatState: 'NOT_STARTED'
                };
              }
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
              if (!(h7Plan && h7Plan.observerOnly)) {
                assert(combat.metrics.attackUnknown === h7Baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_H7_STABILITY_WINDOW');
              }
              assert(party.party.coordinationEnabled === true, 'H7_COORDINATION_LOST_DURING_STABILITY_WINDOW');
              const focusChanges = party.metrics.focusChanges - h7Baseline.focusChanges;
              const focusPingPongs = party.metrics.focusPingPongs - h7Baseline.focusPingPongs;
              assert(focusPingPongs === 0, 'PARTY_FOCUS_PINGPONG_DETECTED:' + focusPingPongs);
              return {
                observerOnly: !!(h7Plan && h7Plan.observerOnly),
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

      this.liveTests.register({
        id: 'h8-adaptive-farming',
        title: 'H8 – AoE & adaptives Farming',
        description: 'Ein-Klick-Live-Test für sichere Pack-Planung, live-bereite Klassen-AoE, adaptives Risiko, UNKNOWN-Safety und Cleanup.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.farming.stopSession('H8_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.combat.stopSession('H8_LIVE_TEST_RESET'); } catch (_) {}
          h8Plan = null;
          const farming = runtime.farming.status();
          const combat = runtime.combat.status();
          const party = runtime.party.status();
          h8Baseline = {
            aoeConfirmed: farming.metrics.aoeConfirmed,
            aoeUnknown: farming.metrics.aoeUnknown,
            attackUnknown: combat.metrics.attackUnknown,
            focusPingPongs: party.metrics.focusPingPongs
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.farming.stopSession('H8_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.combat.stopSession('H8_LIVE_TEST_CLEANUP'); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Klasse, Live-AoE und mindestens ein sicheres Pack prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const module = runtime.modules.describe('adaptive-farming');
              assert(module && module.state === 'ACTIVE', 'H8_MODULE_NOT_ACTIVE');

              const game = runtime.game.snapshot();
              assert(game && game.available && game.character && !game.character.rip, 'CHARACTER_UNAVAILABLE');
              const ctype = String(game.character.ctype || '').toLowerCase();
              assert(ctype !== 'merchant', 'H8_NEEDS_COMBAT_CLASS_NOT_MERCHANT');

              const party = runtime.party.status();
              const foreign = party.party && party.party.foreignMemberNames || [];
              assert(foreign.length === 0, 'H8_FOREIGN_PARTY_MEMBER_BLOCK:' + foreign.join(','));

              const supported = runtime.farming.supportedAoeSkills(ctype);
              assert(supported.length > 0, 'H8_CLASS_HAS_NO_AOE_POLICY:' + ctype);

              const ready = supported.map(id => ({
                id,
                definition: runtime.game.skillDefinition(id),
                readiness: runtime.game.skillReadiness(id, null)
              })).filter(row => row.definition && row.readiness && row.readiness.allowed === true);
              assert(ready.length > 0,
                'H8_NEEDS_LIVE_READY_AOE_SKILL:' + ctype + ':' + supported.join(','));

              const currentHp = Number(game.character.hp);
              const maxHp = Number(game.character.maxHp);
              assert(Number.isFinite(currentHp) && currentHp > 0, 'CHARACTER_HP_UNAVAILABLE');
              assert(Number.isFinite(maxHp) && maxHp > 0, 'CHARACTER_MAX_HP_UNAVAILABLE');
              assert(currentHp / maxHp >= runtime.farming.config.aoeHpRatio,
                'H8_HP_BELOW_AOE_THRESHOLD');

              const candidates = runtime.combat.safeCandidates({
                maxAcquireDistance: runtime.farming.config.maxAcquireDistance,
                maxAttackToHpRatio: 0.08,
                allowContested: false,
                allowUnknownAttack: false,
                partyAssist: true
              });
              assert(candidates.length >= 2, 'H8_NEEDS_AT_LEAST_2_SAFE_VISIBLE_MONSTERS');

              const groups = new Map();
              for (const monster of candidates) {
                const key = String(monster.mtype || '');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(monster);
              }
              const thresholds = { '3shot': 2, '5shot': 4, cleave: 3, stomp: 3, cburst: 2, fanofknives: 3 };
              let selected = null;
              for (const row of ready) {
                const minimum = thresholds[row.id] || 2;
                for (const [monsterType, rows] of groups.entries()) {
                  if (rows.length >= minimum) {
                    selected = { skillId: row.id, minimum, monsterType: monsterType || null, candidates: rows };
                    break;
                  }
                }
                if (selected) break;
              }
              assert(selected, 'H8_NO_SAFE_SAME_TYPE_PACK_FOR_READY_AOE');

              h8Plan = {
                ctype,
                skillId: selected.skillId,
                minimumTargets: selected.minimum,
                monsterType: selected.monsterType,
                safeVisible: selected.candidates.length
              };
              return {
                character: game.character.name,
                ctype,
                skillId: selected.skillId,
                minimumTargets: selected.minimum,
                monsterType: selected.monsterType,
                safeVisible: selected.candidates.length
              };
            }
          },
          {
            id: 'adaptive-pack',
            title: 'H8-Session starten und sicheren AoE-Packplan erreichen',
            timeoutMs: 15000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h8Plan, 'H8_LIVE_TEST_PLAN_MISSING');
              const started = runtime.farming.startSession({
                owner: 'live-test-h8',
                monsterType: h8Plan.monsterType || undefined,
                partyAssist: true,
                maxAcquireDistance: runtime.farming.config.maxAcquireDistance,
                maxAttackToHpRatio: 0.08,
                retreatHpRatio: runtime.farming.config.retreatHpRatio,
                minMpRatio: 0.08
              });
              assert(started && started.accepted === true, started && started.reason || 'H8_SESSION_START_FAILED');

              const planned = await waitFor(() => {
                const combat = runtime.combat.status();
                if (combat.lastSession && ['FAILED_SAFE', 'UNKNOWN'].includes(combat.lastSession.state)) {
                  throw new Error(combat.lastSession.reason || combat.lastSession.state);
                }
                const farming = runtime.farming.status();
                if (farming.suspended) throw new Error(farming.suspendedReason || 'H8_AOE_SUSPENDED');
                const plan = runtime.farming.plan();
                return plan && plan.state === 'AOE_READY' ? plan : null;
              }, { timeoutMs: 12000, pollMs: 150, label: 'h8-aoe-pack-plan' });

              assert(planned.aoe && planned.aoe.packSize >= h8Plan.minimumTargets,
                'H8_PACK_BELOW_SKILL_THRESHOLD');
              return {
                state: planned.state,
                skillId: planned.aoe.skillId,
                packSize: planned.aoe.packSize,
                capacity: planned.capacity,
                aggregateAttack: planned.aggregateAttack
              };
            }
          },
          {
            id: 'confirmed-aoe',
            title: 'Mindestens einen AoE-Skill serverbestätigt ausführen',
            timeoutMs: 25000,
            run: async ({ runtime, waitFor }) => {
              const confirmed = await waitFor(() => {
                const farming = runtime.farming.status();
                if (farming.suspended) throw new Error(farming.suspendedReason || 'H8_AOE_SUSPENDED');
                if (farming.metrics.aoeUnknown > h8Baseline.aoeUnknown) throw new Error('H8_AOE_UNKNOWN');
                if (farming.metrics.aoeConfirmed <= h8Baseline.aoeConfirmed) return null;
                return farming;
              }, { timeoutMs: 22000, pollMs: 150, label: 'h8-confirmed-aoe' });

              return {
                aoeConfirmed: confirmed.metrics.aoeConfirmed - h8Baseline.aoeConfirmed,
                lastUse: confirmed.lastUse
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Fünf Sekunden ohne UNKNOWN, Overpull oder Focus-Pingpong beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const farming = runtime.farming.status();
              const combat = runtime.combat.status();
              const party = runtime.party.status();
              assert(farming.suspended === false, 'H8_AOE_SUSPENDED_DURING_STABILITY');
              assert(farming.metrics.aoeUnknown === h8Baseline.aoeUnknown, 'H8_AOE_UNKNOWN_DURING_STABILITY');
              assert(combat.metrics.attackUnknown === h8Baseline.attackUnknown, 'ATTACK_UNKNOWN_DURING_H8_STABILITY');
              assert(party.metrics.focusPingPongs === h8Baseline.focusPingPongs, 'PARTY_FOCUS_PINGPONG_DURING_H8');
              const lastPlan = farming.lastPlan;
              if (lastPlan && Array.isArray(lastPlan.pack)) {
                assert(lastPlan.pack.length <= Number(lastPlan.capacity || 1), 'H8_PACK_EXCEEDS_CAPACITY');
                assert(Number(lastPlan.aggregateAttack || 0)
                  <= Number(runtime.game.snapshot().character.maxHp || 0) * farming.config.maxAggregateAttackToHpRatio + 0.001,
                  'H8_AGGREGATE_ATTACK_BUDGET_EXCEEDED');
              }
              return {
                aoeConfirmed: farming.metrics.aoeConfirmed - h8Baseline.aoeConfirmed,
                aoeUnknown: farming.metrics.aoeUnknown - h8Baseline.aoeUnknown,
                attackUnknown: combat.metrics.attackUnknown - h8Baseline.attackUnknown,
                focusPingPongs: party.metrics.focusPingPongs - h8Baseline.focusPingPongs,
                maxPackObserved: farming.metrics.maxPackObserved,
                lastPlan
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Adaptive Farming, Combat und Movement sauber freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.farming.stopSession('H8_LIVE_TEST_COMPLETE');
              const farming = runtime.farming.status();
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              assert(farming.active === false, 'H8_SESSION_STILL_ACTIVE');
              assert(farming.pending == null, 'H8_AOE_STILL_PENDING');
              assert(combat.active === false, 'H8_COMBAT_STILL_ACTIVE');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '').startsWith('combat-h5')),
                'H8_COMBAT_MOVEMENT_STILL_ACTIVE');
              return {
                farmingActive: farming.active,
                pending: !!farming.pending,
                combatActive: combat.active,
                movementActive: movement.active
              };
            }
          }
        ]
      });

      this.liveTests.register({
        id: 'h9-farm-intelligence',
        title: 'H9 – Farm Intelligence',
        description: 'Ein-Klick-Live-Test für autonome Farmzielwahl, Effizienz-Scoring, stabilen Hold, natürlichen Spotwechsel und Anti-Pingpong.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.farmIntelligence.stopAutonomy('H9_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.farming.stopSession('H9_LIVE_TEST_RESET'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9') {
              runtime.movement.cancel('H9_LIVE_TEST_RESET');
            }
          } catch (_) {}
          h9Plan = null;
          const intelligence = runtime.farmIntelligence.status();
          const farming = runtime.farming.status();
          const combat = runtime.combat.status();
          const party = runtime.party.status();
          h9Baseline = {
            decisions: intelligence.metrics.decisions,
            holds: intelligence.metrics.holds,
            switches: intelligence.metrics.switches,
            farmingStarts: intelligence.metrics.farmingStarts,
            travelOrders: intelligence.metrics.travelOrders,
            pingPongBlocks: intelligence.metrics.pingPongBlocks,
            ownershipBlocks: intelligence.metrics.ownershipBlocks,
            aoeConfirmed: farming.metrics.aoeConfirmed,
            aoeUnknown: farming.metrics.aoeUnknown,
            attacksConfirmed: combat.metrics.attacksConfirmed,
            attackUnknown: combat.metrics.attackUnknown,
            focusPingPongs: party.metrics.focusPingPongs
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.farmIntelligence.stopAutonomy('H9_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.farming.stopSession('H9_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9') {
              runtime.movement.cancel('H9_LIVE_TEST_CLEANUP');
            }
          } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Live-Farmkandidaten und erklärbares Scoring prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const module = runtime.modules.describe('farm-intelligence');
              assert(module && module.state === 'ACTIVE', 'H9_MODULE_NOT_ACTIVE');
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character && !game.character.rip, 'CHARACTER_UNAVAILABLE');
              const ctype = String(game.character.ctype || '').toLowerCase();
              assert(ctype !== 'merchant', 'H9_NEEDS_COMBAT_CLASS_NOT_MERCHANT');

              const party = runtime.party.status();
              const foreign = party.party && party.party.foreignMemberNames || [];
              assert(foreign.length === 0, 'H9_FOREIGN_PARTY_MEMBER_BLOCK:' + foreign.join(','));

              const plan = runtime.farmIntelligence.plan();
              assert(plan && plan.selected, plan && plan.reason || 'H9_NO_FARM_CANDIDATE');
              const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
              const visibleSafe = candidates.filter(row => row && row.source === 'LIVE_SAFE_CLUSTER' && Number(row.visibleSafeCount) > 0);
              assert(visibleSafe.length > 0, 'H9_LIVE_TEST_NEEDS_VISIBLE_SAFE_CLUSTER');
              assert(candidates.length >= 2, 'H9_LIVE_TEST_NEEDS_AT_LEAST_2_FARM_CANDIDATES');
              assert(Number.isFinite(Number(plan.selected.score)), 'H9_SCORE_UNAVAILABLE');
              assert(plan.selected.components && Number.isFinite(Number(plan.selected.components.safety)),
                'H9_SCORE_COMPONENTS_UNAVAILABLE');

              h9Plan = {
                initialKey: plan.selected.key,
                monsterType: plan.selected.mtype,
                source: plan.selected.source,
                score: plan.selected.score,
                travelSeconds: plan.selected.raw && Number(plan.selected.raw.travelSeconds),
                candidateCount: candidates.length,
                visibleSafeCount: visibleSafe.reduce((sum, row) => sum + Number(row.visibleSafeCount || 0), 0)
              };
              return {
                character: game.character.name,
                ctype,
                initialKey: h9Plan.initialKey,
                monsterType: h9Plan.monsterType,
                source: h9Plan.source,
                score: h9Plan.score,
                travelSeconds: h9Plan.travelSeconds,
                candidateCount: h9Plan.candidateCount,
                visibleSafeCount: h9Plan.visibleSafeCount,
                components: plan.selected.components
              };
            }
          },
          {
            id: 'autonomous-start',
            title: 'H9-Autonomie starten und gewähltes Farmziel an H8 übergeben',
            timeoutMs: 90000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(h9Plan, 'H9_LIVE_TEST_PLAN_MISSING');
              const started = runtime.farmIntelligence.startAutonomy({
                owner: 'live-test-h9',
                allowTravel: true
              });
              assert(started && started.accepted === true, started && started.reason || 'H9_SESSION_START_FAILED');

              const state = await waitFor(() => {
                const intelligence = runtime.farmIntelligence.status();
                if (intelligence.suspended) throw new Error(intelligence.suspendedReason || 'H9_SUSPENDED');
                if (!intelligence.currentSelection) return null;
                const farming = runtime.farming.status();
                return farming.active ? { intelligence, farming } : null;
              }, { timeoutMs: 85000, pollMs: 200, label: 'h9-farming-start' });

              assert(state.farming.session && String(state.farming.session.owner || '') === 'farm-intelligence-h9',
                'H9_DID_NOT_OWN_H8_SESSION');
              return {
                selectedKey: state.intelligence.currentSelection.key,
                monsterType: state.intelligence.currentSelection.mtype,
                score: state.intelligence.currentSelection.score,
                farmingStarts: state.intelligence.metrics.farmingStarts - h9Baseline.farmingStarts
              };
            }
          },
          {
            id: 'confirmed-farming',
            title: 'Mindestens eine H8-AoE- oder H5-Basisaktion live bestätigen',
            timeoutMs: 35000,
            run: async ({ runtime, waitFor }) => {
              const observed = await waitFor(() => {
                const intelligence = runtime.farmIntelligence.status();
                if (intelligence.suspended) throw new Error(intelligence.suspendedReason || 'H9_SUSPENDED');
                const farming = runtime.farming.status();
                const combat = runtime.combat.status();
                if (farming.metrics.aoeUnknown > h9Baseline.aoeUnknown) throw new Error('H9_H8_AOE_UNKNOWN');
                if (combat.metrics.attackUnknown > h9Baseline.attackUnknown) throw new Error('H9_H5_ATTACK_UNKNOWN');
                const aoe = farming.metrics.aoeConfirmed - h9Baseline.aoeConfirmed;
                const attacks = combat.metrics.attacksConfirmed - h9Baseline.attacksConfirmed;
                return aoe > 0 || attacks > 0 ? { intelligence, farming, combat, aoe, attacks } : null;
              }, { timeoutMs: 32000, pollMs: 200, label: 'h9-confirmed-farming' });

              return {
                aoeConfirmed: observed.aoe,
                attacksConfirmed: observed.attacks,
                selection: observed.intelligence.currentSelection
              };
            }
          },
          {
            id: 'adaptive-switch',
            title: 'Adaptive Farmentscheidung und Anti-Pingpong unter Live-Bedingungen prüfen',
            timeoutMs: 18000,
            run: async ({ runtime, assert, waitFor }) => {
              const observed = await waitFor(() => {
                const intelligence = runtime.farmIntelligence.status();
                if (intelligence.suspended) throw new Error(intelligence.suspendedReason || 'H9_SUSPENDED');
                const decisionDelta = intelligence.metrics.decisions - h9Baseline.decisions;
                return decisionDelta >= 5 && intelligence.currentSelection ? intelligence : null;
              }, { timeoutMs: 15000, pollMs: 500, label: 'h9-adaptive-decisions' });

              const history = Array.isArray(observed.history) ? observed.history : [];
              for (let index = 2; index < history.length; index += 1) {
                const a = history[index - 2];
                const b = history[index - 1];
                const c = history[index];
                const within = Number(c.atMs || 0) - Number(a.atMs || 0) <= observed.config.pingPongWindowMs;
                assert(!(within && a.key === c.key && a.key !== b.key), 'H9_FARM_TARGET_PINGPONG');
              }

              const candidates = observed.lastPlan && Array.isArray(observed.lastPlan.candidates)
                ? observed.lastPlan.candidates
                : [];
              assert(candidates.length >= 2, 'H9_ADAPTIVE_CANDIDATES_LOST');
              return {
                decisions: observed.metrics.decisions - h9Baseline.decisions,
                holds: observed.metrics.holds - h9Baseline.holds,
                switches: observed.metrics.switches - h9Baseline.switches,
                switchObserved: observed.metrics.switches > h9Baseline.switches,
                travelOrders: observed.metrics.travelOrders - h9Baseline.travelOrders,
                currentSelection: observed.currentSelection,
                lastPlanReason: observed.lastPlan && observed.lastPlan.reason || null,
                candidateCount: candidates.length,
                history
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Fünf Sekunden ohne UNKNOWN, Ownership-Verlust oder Focus-Pingpong beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const intelligence = runtime.farmIntelligence.status();
              const farming = runtime.farming.status();
              const combat = runtime.combat.status();
              const party = runtime.party.status();
              assert(intelligence.suspended === false, intelligence.suspendedReason || 'H9_SUSPENDED_DURING_STABILITY');
              assert(farming.metrics.aoeUnknown === h9Baseline.aoeUnknown, 'H9_AOE_UNKNOWN_DURING_STABILITY');
              assert(combat.metrics.attackUnknown === h9Baseline.attackUnknown, 'H9_ATTACK_UNKNOWN_DURING_STABILITY');
              assert(party.metrics.focusPingPongs === h9Baseline.focusPingPongs, 'H9_PARTY_FOCUS_PINGPONG');
              assert(intelligence.metrics.ownershipBlocks === h9Baseline.ownershipBlocks,
                'H9_OWNERSHIP_BLOCK_DURING_TEST');
              return {
                selection: intelligence.currentSelection,
                switches: intelligence.metrics.switches - h9Baseline.switches,
                pingPongBlocks: intelligence.metrics.pingPongBlocks - h9Baseline.pingPongBlocks,
                aoeUnknown: farming.metrics.aoeUnknown - h9Baseline.aoeUnknown,
                attackUnknown: combat.metrics.attackUnknown - h9Baseline.attackUnknown,
                focusPingPongs: party.metrics.focusPingPongs - h9Baseline.focusPingPongs
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Farm Intelligence und alle eigene H8/H4-Ownership sauber freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.farmIntelligence.stopAutonomy('H9_LIVE_TEST_COMPLETE');
              const intelligence = runtime.farmIntelligence.status();
              const farming = runtime.farming.status();
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              assert(intelligence.active === false, 'H9_SESSION_STILL_ACTIVE');
              assert(!(farming.active && farming.session && String(farming.session.owner || '') === 'farm-intelligence-h9'),
                'H9_OWNED_FARMING_STILL_ACTIVE');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9'),
                'H9_OWNED_MOVEMENT_STILL_ACTIVE');
              assert(combat.active === false, 'H9_COMBAT_STILL_ACTIVE');
              return {
                intelligenceActive: intelligence.active,
                farmingActive: farming.active,
                combatActive: combat.active,
                movementActive: movement.active
              };
            }
          }
        ]
      });

      this.liveTests.register({
        id: 'h10-loot-inventory',
        title: 'H10 – Loot & Inventar',
        description: 'Ein-Klick-Live-Test für sicheren Loot, Inventarschutz, Slot-Reserve und erklärbare Item-Dispositionen.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.farmIntelligence.stopAutonomy('H10_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.farming.stopSession('H10_LIVE_TEST_RESET'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9') {
              runtime.movement.cancel('H10_LIVE_TEST_RESET');
            }
          } catch (_) {}
          try { runtime.inventory.resetSafety('H10_LIVE_TEST_RESET'); } catch (_) {}
          h10StartedH9 = false;
          const inventory = runtime.inventory.status();
          const combat = runtime.combat.status();
          const intelligence = runtime.farmIntelligence.status();
          h10Baseline = {
            lootDispatched: inventory.metrics.lootDispatched,
            lootConfirmed: inventory.metrics.lootConfirmed,
            lootKnownRejected: inventory.metrics.lootKnownRejected,
            lootUnknown: inventory.metrics.lootUnknown,
            attacksConfirmed: combat.metrics.attacksConfirmed,
            attackUnknown: combat.metrics.attackUnknown,
            h9Decisions: intelligence.metrics.decisions
          };
          h10Before = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.farmIntelligence.stopAutonomy('H10_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.farming.stopSession('H10_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9') {
              runtime.movement.cancel('H10_LIVE_TEST_CLEANUP');
            }
          } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Live-Inventar, Schutzregeln und Loot-API prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const module = runtime.modules.describe('loot-inventory');
              assert(module && module.state === 'ACTIVE', 'H10_MODULE_NOT_ACTIVE');
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character && !game.character.rip, 'CHARACTER_UNAVAILABLE');
              assert(String(game.character.ctype || '').toLowerCase() !== 'merchant', 'H10_LIVE_TEST_NEEDS_FARMER');
              assert(runtime.actions.available('loot'), 'H10_LOOT_API_UNAVAILABLE');

              const plan = runtime.inventory.plan();
              assert(plan && plan.state === 'READY', plan && plan.reason || 'H10_INVENTORY_PLAN_UNAVAILABLE');
              assert(Number.isFinite(Number(plan.inventory.capacity)) && Number(plan.inventory.capacity) > 0,
                'H10_INVENTORY_CAPACITY_UNAVAILABLE');
              assert(Array.isArray(plan.items), 'H10_ITEMS_UNAVAILABLE');
              assert(plan.items.every(row => row && row.disposition && typeof row.protected === 'boolean'),
                'H10_ITEM_CLASSIFICATION_INCOMPLETE');

              const protectedItems = plan.items
                .filter(row => row && row.protected === true)
                .map(row => ({
                  name: row.name,
                  level: Number(row.level || 0),
                  statType: row.statType || null,
                  quantity: Number(row.quantity || 1),
                  disposition: row.disposition,
                  reason: row.reason
                }));
              h10Before = {
                capacity: Number(plan.inventory.capacity),
                usedSlots: Number(plan.inventory.usedSlots),
                freeSlots: Number(plan.inventory.freeSlots),
                protectedItems
              };
              return {
                character: game.character.name,
                ctype: game.character.ctype,
                capacity: h10Before.capacity,
                usedSlots: h10Before.usedSlots,
                freeSlots: h10Before.freeSlots,
                protectedCount: protectedItems.length,
                dispositionCounts: plan.counts,
                visibleChests: plan.chests.length,
                reserveFreeSlots: plan.reserveFreeSlots
              };
            }
          },
          {
            id: 'autonomous-farming',
            title: 'H9-Farming starten, damit echter Loot entstehen kann',
            timeoutMs: 90000,
            run: async ({ runtime, assert, waitFor }) => {
              const h9Plan = runtime.farmIntelligence.plan();
              assert(h9Plan && h9Plan.selected, h9Plan && h9Plan.reason || 'H10_NO_H9_FARM_CANDIDATE');

              const candidates = Array.isArray(h9Plan.candidates)
                ? h9Plan.candidates.filter(row => row && row.mtype)
                : [];
              const visible = candidates.filter(row => Number(row.visibleSafeCount || 0) > 0);
              const pool = visible.length ? visible : candidates;
              const probe = pool.slice().sort((a, b) => {
                const ahp = Number(a.definition && a.definition.hp);
                const bhp = Number(b.definition && b.definition.hp);
                const safeAhp = Number.isFinite(ahp) && ahp > 0 ? ahp : Number.POSITIVE_INFINITY;
                const safeBhp = Number.isFinite(bhp) && bhp > 0 ? bhp : Number.POSITIVE_INFINITY;
                if (safeAhp !== safeBhp) return safeAhp - safeBhp;
                const ad = Number(a.averageDistance);
                const bd = Number(b.averageDistance);
                const safeAd = Number.isFinite(ad) ? ad : Number.POSITIVE_INFINITY;
                const safeBd = Number.isFinite(bd) ? bd : Number.POSITIVE_INFINITY;
                return safeAd - safeBd;
              })[0] || h9Plan.selected;

              assert(probe && probe.mtype, 'H10_NO_LOOT_PROBE_CANDIDATE');
              const started = runtime.farmIntelligence.startAutonomy({
                owner: 'live-test-h10',
                preferredTypes: [probe.mtype],
                allowTravel: true
              });
              assert(started && started.accepted === true, started && started.reason || 'H10_H9_START_FAILED');
              h10StartedH9 = true;

              const active = await waitFor(() => {
                const intelligence = runtime.farmIntelligence.status();
                if (intelligence.suspended) throw new Error(intelligence.suspendedReason || 'H10_H9_SUSPENDED');
                const farming = runtime.farming.status();
                return farming.active && intelligence.currentSelection ? { intelligence, farming } : null;
              }, { timeoutMs: 85000, pollMs: 200, label: 'h10-farming-start' });

              return {
                probe: {
                  mtype: probe.mtype,
                  hp: probe.definition && probe.definition.hp,
                  visibleSafeCount: probe.visibleSafeCount,
                  averageDistance: probe.averageDistance,
                  source: probe.source
                },
                selection: active.intelligence.currentSelection,
                farmingOwner: active.farming.session && active.farming.session.owner || null
              };
            }
          },
          {
            id: 'confirmed-loot',
            title: 'Echten Farming-Loot bestätigen und Inventardelta erfassen',
            timeoutMs: 120000,
            run: async ({ runtime, assert, waitFor }) => {
              const observed = await waitFor(() => {
                const inventory = runtime.inventory.status();
                const intelligence = runtime.farmIntelligence.status();
                const combat = runtime.combat.status();
                if (inventory.suspended) throw new Error(inventory.suspendedReason || 'H10_INVENTORY_SUSPENDED');
                if (inventory.metrics.lootUnknown > h10Baseline.lootUnknown) throw new Error('H10_LOOT_UNKNOWN');
                if (combat.metrics.attackUnknown > h10Baseline.attackUnknown) throw new Error('H10_ATTACK_UNKNOWN');
                if (intelligence.suspended) throw new Error(intelligence.suspendedReason || 'H10_H9_SUSPENDED');
                const confirmed = inventory.metrics.lootConfirmed - h10Baseline.lootConfirmed;
                return confirmed > 0 ? { inventory, intelligence, combat } : null;
              }, { timeoutMs: 115000, pollMs: 250, label: 'h10-confirmed-loot' });

              const afterPlan = runtime.inventory.plan();
              assert(afterPlan && afterPlan.state === 'READY', 'H10_POST_LOOT_INVENTORY_UNAVAILABLE');
              return {
                lootDispatched: observed.inventory.metrics.lootDispatched - h10Baseline.lootDispatched,
                lootConfirmed: observed.inventory.metrics.lootConfirmed - h10Baseline.lootConfirmed,
                knownSkips: observed.inventory.metrics.lootKnownRejected - h10Baseline.lootKnownRejected,
                attacksConfirmed: observed.combat.metrics.attacksConfirmed - h10Baseline.attacksConfirmed,
                decisions: observed.intelligence.metrics.decisions - h10Baseline.h9Decisions,
                beforeUsedSlots: h10Before && h10Before.usedSlots,
                afterUsedSlots: afterPlan.inventory.usedSlots,
                afterFreeSlots: afterPlan.inventory.freeSlots,
                dispositionCounts: afterPlan.counts
              };
            }
          },
          {
            id: 'protection-delta',
            title: 'Geschützte und reservierte Items gegen Inventarverlust prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              assert(h10Before, 'H10_BEFORE_SNAPSHOT_MISSING');
              const plan = runtime.inventory.plan();
              const aggregate = new Map();
              for (const row of plan.items || []) {
                const key = String(row.name) + '|' + Number(row.level || 0) + '|' + String(row.statType || '');
                aggregate.set(key, (aggregate.get(key) || 0) + Number(row.quantity || 1));
              }
              for (const row of h10Before.protectedItems) {
                const key = String(row.name) + '|' + Number(row.level || 0) + '|' + String(row.statType || '');
                assert((aggregate.get(key) || 0) >= Number(row.quantity || 1),
                  'H10_PROTECTED_ITEM_LOST:' + row.name + ':' + row.level);
              }
              return {
                checkedProtectedItems: h10Before.protectedItems.length,
                currentUsedSlots: plan.inventory.usedSlots,
                currentFreeSlots: plan.inventory.freeSlots,
                reserveFreeSlots: plan.reserveFreeSlots
              };
            }
          },
          {
            id: 'stability-window',
            title: 'Fünf Sekunden ohne Loot-UNKNOWN oder Inventar-Safety-Verlust beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const inventory = runtime.inventory.status();
              const plan = runtime.inventory.plan();
              const combat = runtime.combat.status();
              assert(inventory.suspended === false, inventory.suspendedReason || 'H10_SUSPENDED_DURING_STABILITY');
              assert(inventory.metrics.lootUnknown === h10Baseline.lootUnknown, 'H10_LOOT_UNKNOWN_DURING_STABILITY');
              assert(combat.metrics.attackUnknown === h10Baseline.attackUnknown, 'H10_ATTACK_UNKNOWN_DURING_STABILITY');
              assert(Number(plan.inventory.freeSlots) >= 0, 'H10_NEGATIVE_FREE_SLOTS');
              return {
                lootConfirmed: inventory.metrics.lootConfirmed - h10Baseline.lootConfirmed,
                knownSkips: inventory.metrics.lootKnownRejected - h10Baseline.lootKnownRejected,
                lootUnknown: inventory.metrics.lootUnknown - h10Baseline.lootUnknown,
                freeSlots: plan.inventory.freeSlots,
                reserveFreeSlots: plan.reserveFreeSlots,
                dispositionCounts: plan.counts
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H9-Farming freigeben und H10 ohne Pending Loot hinterlassen',
            timeoutMs: 5000,
            run: async ({ runtime, assert, waitFor }) => {
              if (h10StartedH9) runtime.farmIntelligence.stopAutonomy('H10_LIVE_TEST_COMPLETE');
              try { runtime.farming.stopSession('H10_LIVE_TEST_COMPLETE'); } catch (_) {}
              const inventory = await waitFor(() => {
                const current = runtime.inventory.status();
                return current.pendingLoot == null ? current : null;
              }, { timeoutMs: 3000, pollMs: 100, label: 'h10-loot-settle' });
              const intelligence = runtime.farmIntelligence.status();
              const farming = runtime.farming.status();
              const combat = runtime.combat.status();
              const movement = runtime.movement.status();
              assert(intelligence.active === false, 'H10_H9_SESSION_STILL_ACTIVE');
              assert(farming.active === false, 'H10_H8_SESSION_STILL_ACTIVE');
              assert(combat.active === false, 'H10_COMBAT_STILL_ACTIVE');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'farm-intelligence-h9'),
                'H10_H9_MOVEMENT_STILL_ACTIVE');
              assert(inventory.pendingLoot == null, 'H10_LOOT_STILL_PENDING');
              return {
                inventoryActive: inventory.moduleActive,
                inventorySuspended: inventory.suspended,
                pendingLoot: !!inventory.pendingLoot,
                h9Active: intelligence.active,
                farmingActive: farming.active,
                combatActive: combat.active,
                movementActive: movement.active
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
        farming: this.farming.status(),
        farmIntelligence: this.farmIntelligence.status(),
        inventory: this.inventory.status(),
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
        farming: this.farming.status(),
        farmIntelligence: this.farmIntelligence.status(),
        inventory: this.inventory.status(),
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
      push('adaptive-farming-controller', !!this.farming.status() && typeof this.farming.plan === 'function' && typeof this.farming.startSession === 'function', this.farming.status());
      push('farm-intelligence-controller', !!this.farmIntelligence.status() && typeof this.farmIntelligence.plan === 'function' && typeof this.farmIntelligence.startAutonomy === 'function', this.farmIntelligence.status());
      push('loot-inventory-controller', !!this.inventory.status() && typeof this.inventory.plan === 'function' && typeof this.inventory.tick === 'function', this.inventory.status());
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
