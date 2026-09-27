(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.Scheduler) throw new Error('ALBOT_SCHEDULER_MISSING');

  class ALBotRuntime {
    constructor(options = {}) {
      this.version = options.version || '0.19.0-h19';
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
      this.merchant = new ns.MerchantController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        roster: this.roster,
        movement: this.movement,
        inventory: this.inventory
      });
      this.bank = new ns.BankController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        movement: this.movement,
        inventory: this.inventory
      });
      this.trade = new ns.TradeController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        movement: this.movement,
        inventory: this.inventory
      });
      this.gear = new ns.GearController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        inventory: this.inventory,
        roster: this.roster,
        combat: this.combat
      });
      this.upgrade = new ns.UpgradeCompoundController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        combat: this.combat
      });
      this.exchangeCraft = new ns.ExchangeCraftController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        movement: this.movement,
        inventory: this.inventory,
        bank: this.bank,
        trade: this.trade,
        combat: this.combat
      });
      this.economy = new ns.EconomyController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        movement: this.movement,
        combat: this.combat,
        inventory: this.inventory,
        merchant: this.merchant,
        bank: this.bank,
        trade: this.trade,
        gear: this.gear,
        upgrade: this.upgrade,
        exchangeCraft: this.exchangeCraft,
        canAct: action => this.actionAllowed(action)
      });
      this.partyLogistics = new ns.PartyLogisticsController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        party: this.party,
        movement: this.movement,
        combat: this.combat,
        inventory: this.inventory,
        merchant: this.merchant,
        bank: this.bank,
        trade: this.trade,
        gear: this.gear,
        upgrade: this.upgrade,
        exchangeCraft: this.exchangeCraft,
        economy: this.economy,
        canAct: action => this.actionAllowed(action)
      });
      this.lifecycle = new ns.CharacterLifecycleController({
        root: this.root,
        logger: this.logger,
        game: this.game,
        actions: this.actions,
        roster: this.roster,
        party: this.party,
        storage: this.storage,
        canAct: action => this.actionAllowed(action)
      });
      this.inventory.partyLogistics = this.partyLogistics;
      this.merchant.partyLogistics = this.partyLogistics;
      this.economy.partyLogistics = this.partyLogistics;
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
      this._registerH11LiveTest();
      this._registerH12LiveTest();
      this._registerH13LiveTest();
      this._registerH14LiveTest();
      this._registerH15LiveTest();
      this._registerH16LiveTest();
      this._registerH17LiveTest();
      this._registerH18LiveTest();
      this._registerH19LiveTest();
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

      this.modules.register({
        id: 'merchant',
        title: 'Merchant',
        version: '0.11.0',
        start: context => this.merchant.start(context),
        stop: reason => this.merchant.stop(reason),
        status: () => this.merchant.status()
      });

      this.modules.register({
        id: 'bank',
        title: 'Bank',
        version: '0.12.0',
        start: context => this.bank.start(context),
        stop: reason => this.bank.stop(reason),
        status: () => this.bank.status()
      });

      this.modules.register({
        id: 'trade',
        title: 'Handel',
        version: '0.13.0',
        start: context => this.trade.start(context),
        stop: reason => this.trade.stop(reason),
        status: () => this.trade.status()
      });

      this.modules.register({
        id: 'gear',
        title: 'Gear',
        version: '0.14.0',
        start: context => this.gear.start(context),
        stop: reason => this.gear.stop(reason),
        status: () => this.gear.status()
      });

      this.modules.register({
        id: 'upgrade-compound',
        title: 'Upgrade & Compound',
        version: '0.15.0',
        start: context => this.upgrade.start(context),
        stop: reason => this.upgrade.stop(reason),
        status: () => this.upgrade.status()
      });

      this.modules.register({
        id: 'exchange-craft',
        title: 'Exchange & Craft',
        version: '0.16.0',
        start: context => this.exchangeCraft.start(context),
        stop: reason => this.exchangeCraft.stop(reason),
        status: () => this.exchangeCraft.status()
      });

      this.modules.register({
        id: 'economy',
        title: 'Economy Autonomy',
        version: '0.17.0',
        start: context => this.economy.start(context),
        stop: reason => this.economy.stop(reason),
        status: () => this.economy.status()
      });

      this.modules.register({
        id: 'party-logistics',
        title: 'Party Logistics',
        version: '0.18.0',
        start: context => this.partyLogistics.start(context),
        stop: reason => this.partyLogistics.stop(reason),
        status: () => this.partyLogistics.status()
      });

      this.modules.register({
        id: 'character-lifecycle',
        title: 'Character Lifecycle & Recovery',
        version: '0.19.0',
        start: context => this.lifecycle.start(context),
        stop: reason => this.lifecycle.stop(reason),
        status: () => this.lifecycle.status()
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

    _registerH11LiveTest() {
      let baseline = null;
      let testPlan = null;
      this.liveTests.register({
        id: 'h11-merchant',
        title: 'H11 – Merchant-Grundbetrieb',
        description: 'Ein-Klick-Live-Test für eigene Farmer, sichere Item-Delivery, MLuck-Service, Inventory Pressure und Anti-Pingpong.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.merchant.resetSafety('H11_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.merchant.cancelDelivery('H11_LIVE_TEST_RESET'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'merchant-h11') {
              runtime.movement.cancel('H11_LIVE_TEST_RESET');
            }
          } catch (_) {}
          const metrics = runtime.merchant.status().metrics;
          baseline = {
            transfersDispatched: metrics.transfersDispatched,
            transfersConfirmed: metrics.transfersConfirmed,
            transfersUnknown: metrics.transfersUnknown,
            mluckDispatched: metrics.mluckDispatched,
            mluckConfirmed: metrics.mluckConfirmed,
            mluckUnknown: metrics.mluckUnknown,
            pingPongBlocks: metrics.pingPongBlocks
          };
          testPlan = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.merchant.cancelDelivery('H11_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'merchant-h11') {
              runtime.movement.cancel('H11_LIVE_TEST_CLEANUP');
            }
          } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Merchant, eigener sichtbarer Farmer, MLuck und sichere Delivery prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(String(game.character.ctype || '').toLowerCase() === 'merchant', 'H11_LIVE_TEST_REQUIRES_MERCHANT');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const roster = runtime.roster.status();
              assert(roster && roster.merchant && String(roster.merchant.name) === String(game.character.name),
                'H11_LOCAL_MERCHANT_NOT_OWNED_ROSTER_MERCHANT');
              assert(runtime.actions.available('send_item'), 'SEND_ITEM_API_UNAVAILABLE');
              assert(runtime.actions.available('use_skill'), 'USE_SKILL_API_UNAVAILABLE');
              const merchantModule = runtime.modules.describe('merchant');
              assert(merchantModule && merchantModule.state === 'ACTIVE', 'H11_MODULE_NOT_ACTIVE');

              const plan = runtime.merchant.plan();
              assert(plan && plan.role === 'MERCHANT', 'H11_ROLE_NOT_MERCHANT');
              assert(Array.isArray(plan.visibleOwnedFarmers) && plan.visibleOwnedFarmers.length > 0,
                'H11_NEEDS_VISIBLE_OWN_FARMER');

              const inventory = runtime.inventory.plan();
              const safeRows = (inventory.items || []).filter(row => runtime.merchant._transferSafe(row, { allowUtility: true }));
              assert(safeRows.length > 0, 'H11_NEEDS_SAFE_TRANSFER_ITEM');
              const utility = safeRows.find(row => {
                const type = String(row && row.definition && row.definition.type || '').toLowerCase();
                return row.disposition === 'KEEP' && ['pot', 'elixir', 'food', 'scroll', 'booster'].includes(type);
              });
              const row = utility || safeRows[0];
              const target = plan.visibleOwnedFarmers.slice().sort((a, b) =>
                Number(a.distance == null ? Infinity : a.distance) - Number(b.distance == null ? Infinity : b.distance))[0];

              const readiness = runtime.game.skillReadiness('mluck', target.name);
              assert(readiness && readiness.available === true, 'H11_MLUCK_SKILL_UNAVAILABLE');

              testPlan = {
                targetName: target.name,
                itemName: row.name,
                slot: row.slot,
                beforeQuantity: Number(row.quantity) || 1,
                quantity: 1
              };
              return {
                merchant: game.character.name,
                target: target.name,
                distance: target.distance,
                itemName: row.name,
                itemDisposition: row.disposition,
                itemQuantity: row.quantity,
                pressure: plan.pressure,
                mluckReady: readiness.allowed,
                mluckReasons: readiness.reasons || []
              };
            }
          },
          {
            id: 'delivery',
            title: 'Genau ein sicheres Item an eigenen Farmer liefern und Delta bestätigen',
            timeoutMs: 45000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan, 'H11_LIVE_TEST_PLAN_MISSING');
              const queued = runtime.merchant.queueDelivery(testPlan.targetName, testPlan.itemName, testPlan.quantity);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H11_DELIVERY_QUEUE_FAILED');
              const confirmed = await waitFor(() => {
                const status = runtime.merchant.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H11_SUSPENDED');
                if (status.metrics.transfersUnknown > baseline.transfersUnknown) throw new Error('H11_TRANSFER_UNKNOWN');
                return status.metrics.transfersConfirmed > baseline.transfersConfirmed ? status : null;
              }, { timeoutMs: 40000, pollMs: 150, label: 'h11-delivery-confirmed' });

              const after = runtime.game.inventorySnapshot();
              const sameSlot = (after.items || []).find(row =>
                Number(row.slot) === Number(testPlan.slot) && String(row.name || '') === String(testPlan.itemName));
              const afterQuantity = sameSlot ? Number(sameSlot.quantity) || 0 : 0;
              assert(testPlan.beforeQuantity - afterQuantity >= testPlan.quantity,
                'H11_DELIVERY_LOCAL_DELTA_NOT_CONFIRMED');
              return {
                target: testPlan.targetName,
                itemName: testPlan.itemName,
                quantity: testPlan.quantity,
                transfersDispatched: confirmed.metrics.transfersDispatched - baseline.transfersDispatched,
                transfersConfirmed: confirmed.metrics.transfersConfirmed - baseline.transfersConfirmed,
                beforeQuantity: testPlan.beforeQuantity,
                afterQuantity
              };
            }
          },
          {
            id: 'mluck',
            title: 'MLuck für eigenen Farmer sicherstellen ohne Spam',
            timeoutMs: 45000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan, 'H11_LIVE_TEST_PLAN_MISSING');
              const before = runtime.game.playerCondition(testPlan.targetName, 'mluck');
              if (before && before.active
                && (before.remainingMs == null || before.remainingMs > runtime.merchant.config.mluckRefreshMs)) {
                return {
                  target: testPlan.targetName,
                  alreadyHealthy: true,
                  source: before.source,
                  remainingMs: before.remainingMs,
                  mluckDispatched: runtime.merchant.status().metrics.mluckDispatched - baseline.mluckDispatched
                };
              }
              const confirmed = await waitFor(() => {
                const status = runtime.merchant.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H11_SUSPENDED');
                if (status.metrics.mluckUnknown > baseline.mluckUnknown) throw new Error('H11_MLUCK_UNKNOWN');
                if (status.metrics.mluckConfirmed <= baseline.mluckConfirmed) return null;
                const condition = runtime.game.playerCondition(testPlan.targetName, 'mluck');
                return condition && condition.active ? { status, condition } : null;
              }, { timeoutMs: 40000, pollMs: 150, label: 'h11-mluck-confirmed' });
              return {
                target: testPlan.targetName,
                alreadyHealthy: false,
                source: confirmed.condition.source,
                remainingMs: confirmed.condition.remainingMs,
                mluckDispatched: confirmed.status.metrics.mluckDispatched - baseline.mluckDispatched,
                mluckConfirmed: confirmed.status.metrics.mluckConfirmed - baseline.mluckConfirmed
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne UNKNOWN oder Service-Pingpong beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const status = runtime.merchant.status();
              assert(status.suspended === false, status.suspendedReason || 'H11_SUSPENDED');
              assert(status.metrics.transfersUnknown === baseline.transfersUnknown, 'H11_TRANSFER_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.mluckUnknown === baseline.mluckUnknown, 'H11_MLUCK_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.pingPongBlocks === baseline.pingPongBlocks, 'H11_SERVICE_PINGPONG');
              return {
                transfersConfirmed: status.metrics.transfersConfirmed - baseline.transfersConfirmed,
                mluckConfirmed: status.metrics.mluckConfirmed - baseline.mluckConfirmed,
                transferUnknown: status.metrics.transfersUnknown - baseline.transfersUnknown,
                mluckUnknown: status.metrics.mluckUnknown - baseline.mluckUnknown,
                pingPongBlocks: status.metrics.pingPongBlocks - baseline.pingPongBlocks
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H11 Delivery und H11-eigene Bewegung vollständig freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.merchant.cancelDelivery('H11_LIVE_TEST_COMPLETE');
              const merchant = runtime.merchant.status();
              const movement = runtime.movement.status();
              assert(merchant.pending == null, 'H11_PENDING_ACTION_REMAINS');
              assert(merchant.delivery == null, 'H11_DELIVERY_REMAINS');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'merchant-h11'),
                'H11_MOVEMENT_REMAINS');
              return {
                pending: !!merchant.pending,
                delivery: !!merchant.delivery,
                movementActive: !!movement.activeOrder
              };
            }
          }
        ]
      });
    }

    _registerH12LiveTest() {
      let baseline = null;
      let testPlan = null;
      this.liveTests.register({
        id: 'h12-bank',
        title: 'H12 – Bank',
        description: 'Ein-Klick-Live-Test für sichere Bankfahrt, Deposit/Withdraw, Workspace und Inventory/Bank-Reconciliation.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.bank.resetSafety('H12_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.bank.cancelRequest('H12_LIVE_TEST_RESET'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
              runtime.movement.cancel('H12_LIVE_TEST_RESET');
            }
          } catch (_) {}
          const metrics = runtime.bank.status().metrics;
          baseline = {
            depositsConfirmed: metrics.depositsConfirmed,
            depositsUnknown: metrics.depositsUnknown,
            withdrawalsConfirmed: metrics.withdrawalsConfirmed,
            withdrawalsUnknown: metrics.withdrawalsUnknown,
            movementUnknown: metrics.movementUnknown,
            reconciliationFailures: metrics.reconciliationFailures
          };
          testPlan = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.bank.cancelRequest('H12_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12') {
              runtime.movement.cancel('H12_LIVE_TEST_CLEANUP');
            }
          } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Merchant, Bank-APIs und sicheres BANK-Item prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(String(game.character.ctype || '').toLowerCase() === 'merchant', 'H12_LIVE_TEST_REQUIRES_MERCHANT');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const bankModule = runtime.modules.describe('bank');
              assert(bankModule && bankModule.state === 'ACTIVE', 'H12_MODULE_NOT_ACTIVE');
              assert(runtime.actions.available('bank_store'), 'BANK_STORE_API_UNAVAILABLE');
              assert(runtime.actions.available('bank_retrieve'), 'BANK_RETRIEVE_API_UNAVAILABLE');
              assert(runtime.actions.available('smart_move'), 'SMART_MOVE_API_UNAVAILABLE');

              const bankPlan = runtime.bank.plan();
              const candidates = bankPlan && Array.isArray(bankPlan.safeDepositRows)
                ? bankPlan.safeDepositRows
                : [];
              assert(candidates.length > 0, 'H12_NEEDS_SAFE_BANK_ITEM');
              const row = candidates.slice().sort((a, b) => Number(a.slot) - Number(b.slot))[0];
              testPlan = {
                itemName: row.name,
                originalSlot: Number(row.slot),
                quantity: Math.max(1, Math.floor(Number(row.quantity) || 1))
              };
              const bank = runtime.game.bankSnapshot();
              return {
                merchant: game.character.name,
                map: game.character.map,
                itemName: row.name,
                itemDisposition: row.disposition,
                quantity: testPlan.quantity,
                originalSlot: testPlan.originalSlot,
                bankMounted: !!(bank && bank.available),
                bankMap: bank && bank.map || null
              };
            }
          },
          {
            id: 'deposit',
            title: 'Sicheres Item automatisch zur Bank bringen und eindeutig einlagern',
            timeoutMs: 90000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan, 'H12_LIVE_TEST_PLAN_MISSING');
              const queued = runtime.bank.queueDeposit(testPlan.itemName, { inventorySlot: testPlan.originalSlot });
              assert(queued && queued.accepted === true, queued && queued.reason || 'H12_DEPOSIT_QUEUE_FAILED');
              const confirmed = await waitFor(() => {
                const status = runtime.bank.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H12_SUSPENDED');
                if (status.metrics.depositsUnknown > baseline.depositsUnknown) throw new Error('H12_DEPOSIT_UNKNOWN');
                if (status.metrics.movementUnknown > baseline.movementUnknown) throw new Error('H12_MOVEMENT_UNKNOWN');
                if (status.metrics.depositsConfirmed <= baseline.depositsConfirmed) return null;
                return status;
              }, { timeoutMs: 85000, pollMs: 150, label: 'h12-deposit-confirmed' });

              const action = confirmed.lastAction || {};
              assert(action.pack, 'H12_DEPOSIT_PACK_EVIDENCE_MISSING');
              assert(action.bankSlot != null, 'H12_DEPOSIT_SLOT_EVIDENCE_MISSING');
              const bank = runtime.game.bankSnapshot();
              const pack = (bank.packs || []).find(row => String(row.name) === String(action.pack));
              const stored = pack && (pack.items || []).find(row => Number(row.slot) === Number(action.bankSlot));
              assert(stored && String(stored.name) === String(testPlan.itemName), 'H12_DEPOSIT_BANK_ITEM_NOT_FOUND');
              const inventory = runtime.game.inventorySnapshot();
              const original = (inventory.items || []).find(row => Number(row.slot) === testPlan.originalSlot);
              assert(!original || String(original.name) !== String(testPlan.itemName), 'H12_DEPOSIT_INVENTORY_DELTA_NOT_CONFIRMED');

              testPlan.pack = String(action.pack);
              testPlan.bankSlot = Number(action.bankSlot);
              return {
                itemName: testPlan.itemName,
                quantity: testPlan.quantity,
                originalSlot: testPlan.originalSlot,
                pack: testPlan.pack,
                bankSlot: testPlan.bankSlot,
                depositsConfirmed: confirmed.metrics.depositsConfirmed - baseline.depositsConfirmed,
                movementRequests: confirmed.metrics.movementRequests
              };
            }
          },
          {
            id: 'withdraw',
            title: 'Dasselbe Bank-Item exakt in den ursprünglichen Inventarslot zurückholen',
            timeoutMs: 45000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan && testPlan.pack && testPlan.bankSlot != null, 'H12_DEPOSIT_EVIDENCE_MISSING');
              const queued = runtime.bank.queueWithdraw(testPlan.pack, testPlan.bankSlot, {
                inventorySlot: testPlan.originalSlot
              });
              assert(queued && queued.accepted === true, queued && queued.reason || 'H12_WITHDRAW_QUEUE_FAILED');
              const confirmed = await waitFor(() => {
                const status = runtime.bank.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H12_SUSPENDED');
                if (status.metrics.withdrawalsUnknown > baseline.withdrawalsUnknown) throw new Error('H12_WITHDRAW_UNKNOWN');
                if (status.metrics.withdrawalsConfirmed <= baseline.withdrawalsConfirmed) return null;
                return status;
              }, { timeoutMs: 40000, pollMs: 150, label: 'h12-withdraw-confirmed' });

              const inventory = runtime.game.inventorySnapshot();
              const restored = (inventory.items || []).find(row => Number(row.slot) === testPlan.originalSlot);
              assert(restored && String(restored.name) === String(testPlan.itemName),
                'H12_WITHDRAW_ORIGINAL_SLOT_NOT_RESTORED');
              assert(Math.max(1, Math.floor(Number(restored.quantity) || 1)) === testPlan.quantity,
                'H12_WITHDRAW_QUANTITY_NOT_RESTORED');
              const bank = runtime.game.bankSnapshot();
              const pack = (bank.packs || []).find(row => String(row.name) === String(testPlan.pack));
              const bankRow = pack && (pack.items || []).find(row => Number(row.slot) === testPlan.bankSlot);
              assert(!bankRow || String(bankRow.name) !== String(testPlan.itemName),
                'H12_WITHDRAW_BANK_DELTA_NOT_CONFIRMED');
              return {
                itemName: testPlan.itemName,
                quantity: testPlan.quantity,
                originalSlot: testPlan.originalSlot,
                pack: testPlan.pack,
                bankSlot: testPlan.bankSlot,
                withdrawalsConfirmed: confirmed.metrics.withdrawalsConfirmed - baseline.withdrawalsConfirmed
              };
            }
          },
          {
            id: 'reconciliation',
            title: 'Fünf Sekunden Reconciliation ohne UNKNOWN oder verlorene Item-Position prüfen',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const status = runtime.bank.status();
              assert(status.suspended === false, status.suspendedReason || 'H12_SUSPENDED');
              assert(status.metrics.depositsUnknown === baseline.depositsUnknown, 'H12_DEPOSIT_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.withdrawalsUnknown === baseline.withdrawalsUnknown, 'H12_WITHDRAW_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.movementUnknown === baseline.movementUnknown, 'H12_MOVEMENT_UNKNOWN_DURING_STABILITY');
              const reconciliation = runtime.bank.reconcile();
              assert(reconciliation.available === true, reconciliation.reason || 'H12_RECONCILIATION_UNAVAILABLE');
              const inventory = runtime.game.inventorySnapshot();
              const restored = (inventory.items || []).find(row => Number(row.slot) === testPlan.originalSlot);
              assert(restored && String(restored.name) === String(testPlan.itemName), 'H12_ITEM_LOCATION_LOST');
              return {
                depositsUnknown: status.metrics.depositsUnknown - baseline.depositsUnknown,
                withdrawalsUnknown: status.metrics.withdrawalsUnknown - baseline.withdrawalsUnknown,
                movementUnknown: status.metrics.movementUnknown - baseline.movementUnknown,
                reconciliationEntries: reconciliation.ledger.length,
                itemRestored: true
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H12 Pending/Request und H12-eigene Bewegung vollständig freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.bank.cancelRequest('H12_LIVE_TEST_COMPLETE');
              const bank = runtime.bank.status();
              const movement = runtime.movement.status();
              assert(bank.pending == null, 'H12_PENDING_ACTION_REMAINS');
              assert(bank.request == null, 'H12_REQUEST_REMAINS');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12'),
                'H12_MOVEMENT_REMAINS');
              return {
                pending: !!bank.pending,
                request: !!bank.request,
                movementActive: !!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'bank-h12')
              };
            }
          }
        ]
      });
    }

    _registerH13LiveTest() {
      let baseline = null;
      let testPlan = null;
      this.liveTests.register({
        id: 'h13-trade',
        title: 'H13 – Handel',
        description: 'Ein-Klick-Live-Test für preisgedeckelten NPC-Kauf, Live-Deltas und read-only Player-Market-Analyse.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.trade.resetSafety('H13_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.trade.cancelRequest('H13_LIVE_TEST_RESET'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'trade-h13') {
              runtime.movement.cancel('H13_LIVE_TEST_RESET');
            }
          } catch (_) {}
          const metrics = runtime.trade.status().metrics;
          baseline = {
            npcBuysConfirmed: metrics.npcBuysConfirmed,
            npcBuysUnknown: metrics.npcBuysUnknown,
            npcSellsUnknown: metrics.npcSellsUnknown,
            marketBuysUnknown: metrics.marketBuysUnknown,
            marketSellsUnknown: metrics.marketSellsUnknown,
            movementUnknown: metrics.movementUnknown
          };
          testPlan = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.trade.cancelRequest('H13_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const movement = runtime.movement.status();
            if (movement.activeOrder && String(movement.activeOrder.owner || '') === 'trade-h13') {
              runtime.movement.cancel('H13_LIVE_TEST_CLEANUP');
            }
          } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Merchant, Handels-APIs, hpot0-Festpreis und NPC-Quelle prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(String(game.character.ctype || '').toLowerCase() === 'merchant', 'H13_LIVE_TEST_REQUIRES_MERCHANT');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const module = runtime.modules.describe('trade');
              assert(module && module.state === 'ACTIVE', 'H13_MODULE_NOT_ACTIVE');
              assert(runtime.actions.available('buy_with_gold'), 'BUY_WITH_GOLD_API_UNAVAILABLE');
              assert(runtime.actions.available('sell'), 'SELL_API_UNAVAILABLE');
              assert(runtime.actions.available('trade_buy'), 'TRADE_BUY_API_UNAVAILABLE');
              assert(runtime.actions.available('trade_sell'), 'TRADE_SELL_API_UNAVAILABLE');
              assert(runtime.actions.available('smart_move'), 'SMART_MOVE_API_UNAVAILABLE');

              const definition = runtime.game.itemDefinition('hpot0');
              assert(definition && Number.isFinite(Number(definition.g)) && Number(definition.g) > 0,
                'H13_HPOT0_PRICE_UNAVAILABLE');
              const sources = runtime.game.npcShopSources('hpot0');
              const source = (sources || []).find(row => row && row.location);
              assert(source, 'H13_HPOT0_NPC_SOURCE_UNAVAILABLE');

              const inventory = runtime.game.inventorySnapshot();
              assert(inventory && inventory.available !== false && Number(inventory.freeSlots) > 0,
                'H13_INVENTORY_FULL_OR_UNAVAILABLE');
              const beforeQuantity = (inventory.items || []).reduce((sum, row) =>
                sum + (String(row.name) === 'hpot0' && Number(row.level || 0) === 0 ? Number(row.quantity || 1) : 0), 0);
              const beforeGold = Number(game.character.gold);
              const unitPrice = Number(definition.g);
              assert(Number.isFinite(beforeGold) && beforeGold - unitPrice >= runtime.trade.config.goldReserve,
                'H13_LIVE_TEST_GOLD_RESERVE_BLOCKED');

              testPlan = {
                itemName: 'hpot0',
                quantity: 1,
                unitPrice,
                beforeQuantity,
                beforeGold,
                npcId: source.npcId,
                location: source.location
              };
              return {
                merchant: game.character.name,
                map: game.character.map,
                itemName: testPlan.itemName,
                quantity: 1,
                unitPrice,
                beforeQuantity,
                beforeGold,
                goldReserve: runtime.trade.config.goldReserve,
                npcId: source.npcId,
                npcLocation: source.location
              };
            }
          },
          {
            id: 'npc-buy',
            title: 'Genau ein hpot0 zum live bekannten NPC-Festpreis kaufen und Delta bestätigen',
            timeoutMs: 90000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan, 'H13_LIVE_TEST_PLAN_MISSING');
              const queued = runtime.trade.queueNpcBuy(testPlan.itemName, 1, {
                maxUnitPrice: testPlan.unitPrice
              });
              assert(queued && queued.accepted === true, queued && queued.reason || 'H13_NPC_BUY_QUEUE_FAILED');
              const confirmed = await waitFor(() => {
                const status = runtime.trade.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H13_SUSPENDED');
                if (status.metrics.npcBuysUnknown > baseline.npcBuysUnknown) throw new Error('H13_NPC_BUY_UNKNOWN');
                if (status.metrics.movementUnknown > baseline.movementUnknown) throw new Error('H13_MOVEMENT_UNKNOWN');
                return status.metrics.npcBuysConfirmed > baseline.npcBuysConfirmed ? status : null;
              }, { timeoutMs: 85000, pollMs: 150, label: 'h13-npc-buy-confirmed' });

              const inventory = runtime.game.inventorySnapshot();
              const afterQuantity = (inventory.items || []).reduce((sum, row) =>
                sum + (String(row.name) === testPlan.itemName && Number(row.level || 0) === 0 ? Number(row.quantity || 1) : 0), 0);
              const afterGame = runtime.game.snapshot();
              const afterGold = Number(afterGame && afterGame.character && afterGame.character.gold);
              assert(afterQuantity >= testPlan.beforeQuantity + 1, 'H13_NPC_BUY_INVENTORY_DELTA_NOT_CONFIRMED');
              assert(Number.isFinite(afterGold) && afterGold <= testPlan.beforeGold - testPlan.unitPrice,
                'H13_NPC_BUY_GOLD_DELTA_NOT_CONFIRMED');
              return {
                itemName: testPlan.itemName,
                quantity: 1,
                unitPrice: testPlan.unitPrice,
                beforeQuantity: testPlan.beforeQuantity,
                afterQuantity,
                beforeGold: testPlan.beforeGold,
                afterGold,
                npcBuysConfirmed: confirmed.metrics.npcBuysConfirmed - baseline.npcBuysConfirmed,
                movementRequests: confirmed.metrics.movementRequests
              };
            }
          },
          {
            id: 'market-analysis',
            title: 'Sichtbare Player-Listings read-only analysieren ohne Kauf oder Verkauf',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const before = runtime.trade.status().metrics;
              const analysis = runtime.trade.marketAnalysis(null);
              assert(analysis && analysis.available === true, analysis && analysis.reason || 'H13_MARKET_ANALYSIS_UNAVAILABLE');
              const after = runtime.trade.status().metrics;
              assert(after.marketBuysDispatched === before.marketBuysDispatched, 'H13_MARKET_ANALYSIS_DISPATCHED_BUY');
              assert(after.marketSellsDispatched === before.marketSellsDispatched, 'H13_MARKET_ANALYSIS_DISPATCHED_SELL');
              return {
                asks: analysis.asks.length,
                bids: analysis.bids.length,
                bestAsk: analysis.bestAsk,
                bestBid: analysis.bestBid,
                spread: analysis.spread
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne Trade-UNKNOWN beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const status = runtime.trade.status();
              assert(status.suspended === false, status.suspendedReason || 'H13_SUSPENDED');
              assert(status.metrics.npcBuysUnknown === baseline.npcBuysUnknown, 'H13_NPC_BUY_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.npcSellsUnknown === baseline.npcSellsUnknown, 'H13_NPC_SELL_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.marketBuysUnknown === baseline.marketBuysUnknown, 'H13_MARKET_BUY_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.marketSellsUnknown === baseline.marketSellsUnknown, 'H13_MARKET_SELL_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.movementUnknown === baseline.movementUnknown, 'H13_MOVEMENT_UNKNOWN_DURING_STABILITY');
              return {
                npcBuyUnknown: status.metrics.npcBuysUnknown - baseline.npcBuysUnknown,
                npcSellUnknown: status.metrics.npcSellsUnknown - baseline.npcSellsUnknown,
                marketBuyUnknown: status.metrics.marketBuysUnknown - baseline.marketBuysUnknown,
                marketSellUnknown: status.metrics.marketSellsUnknown - baseline.marketSellsUnknown,
                movementUnknown: status.metrics.movementUnknown - baseline.movementUnknown
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H13 Pending/Request und H13-eigene Bewegung vollständig freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.trade.cancelRequest('H13_LIVE_TEST_COMPLETE');
              const trade = runtime.trade.status();
              const movement = runtime.movement.status();
              assert(trade.pending == null, 'H13_PENDING_ACTION_REMAINS');
              assert(trade.request == null, 'H13_REQUEST_REMAINS');
              assert(!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'trade-h13'),
                'H13_MOVEMENT_REMAINS');
              return {
                pending: !!trade.pending,
                request: !!trade.request,
                movementActive: !!(movement.activeOrder && String(movement.activeOrder.owner || '') === 'trade-h13')
              };
            }
          }
        ]
      });
    }

    _registerH14LiveTest() {
      let baseline = null;
      let testPlan = null;
      let previousGoals = [];

      const fingerprint = (runtime, row) => runtime.gear._fingerprint(row);

      const tryRestore = async runtime => {
        if (!testPlan || !testPlan.originalFingerprint || !testPlan.targetSlot) return;
        const status = runtime.gear.status();
        if (status.pending || status.suspended) return;
        const equipment = runtime.game.equipmentSnapshot();
        const current = equipment && equipment.slots && equipment.slots[testPlan.targetSlot] || null;
        if (fingerprint(runtime, current) === testPlan.originalFingerprint) return;
        const inventory = runtime.game.inventorySnapshot();
        const original = inventory && (inventory.items || []).find(row =>
          fingerprint(runtime, row) === testPlan.originalFingerprint);
        if (!original) return;
        const queued = runtime.gear.queueEquip(original.slot, testPlan.targetSlot);
        if (!queued || queued.accepted !== true) return;
        for (let i = 0; i < 40; i += 1) {
          runtime.gear.tick();
          const now = runtime.game.equipmentSnapshot();
          const equipped = now && now.slots && now.slots[testPlan.targetSlot] || null;
          if (fingerprint(runtime, equipped) === testPlan.originalFingerprint) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };

      this.liveTests.register({
        id: 'h14-gear',
        title: 'H14 – Gear',
        description: 'Ein-Klick-Live-Test für Gear-Ranking, Gear Goals, Farmer-Priorität und einen reversiblen echten Equipment-Swap.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.gear.resetSafety('H14_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.gear.cancelRequest('H14_LIVE_TEST_RESET'); } catch (_) {}
          previousGoals = runtime.gear.goalSnapshot();
          runtime.gear.setGoals([]);
          const metrics = runtime.gear.status().metrics;
          baseline = {
            equipsConfirmed: metrics.equipsConfirmed,
            equipsUnknown: metrics.equipsUnknown,
            unequipsUnknown: metrics.unequipsUnknown,
            deliveriesUnknown: metrics.deliveriesUnknown
          };
          testPlan = null;
        },
        cleanup: async ({ runtime }) => {
          try { await tryRestore(runtime); } catch (_) {}
          try { runtime.gear.cancelRequest('H14_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.gear.setGoals(previousGoals); } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Live-Equipment, Gear-Ranking und reversiblen Swap-Kandidaten prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const module = runtime.modules.describe('gear');
              assert(module && module.state === 'ACTIVE', 'H14_MODULE_NOT_ACTIVE');
              assert(runtime.actions.available('equip'), 'EQUIP_API_UNAVAILABLE');
              assert(runtime.actions.available('unequip'), 'UNEQUIP_API_UNAVAILABLE');

              const equipment = runtime.game.equipmentSnapshot(game.character.name);
              assert(equipment && equipment.available !== false, 'H14_EQUIPMENT_SNAPSHOT_UNAVAILABLE');
              const plan = runtime.gear.plan();
              assert(plan && plan.state === 'READY', plan && plan.reason || 'H14_PLAN_UNAVAILABLE');
              assert(plan.farmerPriority > plan.merchantPriority, 'H14_FARMER_PRIORITY_NOT_ABOVE_MERCHANT');

              const occupiedSafeImprovement = (plan.local.improvements || []).find(row =>
                row.current && row.bestInventory && row.safeSwitch);
              const fallback = (plan.local.slots || []).find(row =>
                row.current && row.bestInventory && row.safeSwitch
                && fingerprint(runtime, row.current) !== row.bestInventory.fingerprint);
              const selected = occupiedSafeImprovement || fallback;
              assert(selected && selected.current && selected.bestInventory,
                'H14_NEEDS_REVERSIBLE_COMPATIBLE_INVENTORY_GEAR');

              const originalFingerprint = fingerprint(runtime, selected.current);
              const candidateFingerprint = selected.bestInventory.fingerprint;
              assert(originalFingerprint && candidateFingerprint && originalFingerprint !== candidateFingerprint,
                'H14_SWAP_FINGERPRINT_INVALID');

              testPlan = {
                targetSlot: selected.slot,
                candidateInventorySlot: selected.bestInventory.inventorySlot,
                candidateFingerprint,
                candidateName: selected.bestInventory.item.name,
                candidateLevel: Number(selected.bestInventory.item.level) || 0,
                candidateScore: selected.bestInventory.score,
                originalFingerprint,
                originalName: selected.current.name,
                originalLevel: Number(selected.current.level) || 0,
                originalScore: selected.currentScore,
                delta: selected.delta,
                mode: occupiedSafeImprovement ? 'IMPROVEMENT' : 'REVERSIBLE_COMPARISON'
              };

              runtime.gear.setGoals([{
                id: 'h14-live-goal',
                targetName: game.character.name,
                slot: testPlan.targetSlot,
                itemName: testPlan.candidateName,
                minLevel: testPlan.candidateLevel,
                priority: 1000
              }]);

              return {
                character: game.character.name,
                ctype: game.character.ctype,
                slot: testPlan.targetSlot,
                mode: testPlan.mode,
                original: {
                  name: testPlan.originalName,
                  level: testPlan.originalLevel,
                  score: testPlan.originalScore
                },
                candidate: {
                  inventorySlot: testPlan.candidateInventorySlot,
                  name: testPlan.candidateName,
                  level: testPlan.candidateLevel,
                  score: testPlan.candidateScore
                },
                delta: testPlan.delta,
                farmerPriority: plan.farmerPriority,
                merchantPriority: plan.merchantPriority,
                groupTargets: (plan.group && plan.group.targets || []).map(row => ({
                  name: row.name,
                  ctype: row.ctype,
                  role: row.role,
                  priority: row.priority,
                  visible: row.visible
                }))
              };
            }
          },
          {
            id: 'planning',
            title: 'Gear Goal, Klassenkompatibilität und Farmer-vor-Merchant-Planung prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              assert(testPlan, 'H14_LIVE_TEST_PLAN_MISSING');
              const plan = runtime.gear.plan();
              assert(plan && plan.state === 'READY', plan && plan.reason || 'H14_PLAN_UNAVAILABLE');
              const goal = (plan.goals || []).find(row => row.id === 'h14-live-goal');
              assert(goal, 'H14_LIVE_GOAL_MISSING');
              assert(['READY_TO_EQUIP', 'ACHIEVED'].includes(goal.state), 'H14_LIVE_GOAL_NOT_ACTIONABLE');
              const slot = (plan.local.slots || []).find(row => row.slot === testPlan.targetSlot);
              assert(slot && slot.bestInventory, 'H14_TARGET_SLOT_PLAN_MISSING');
              if (testPlan.mode === 'IMPROVEMENT') {
                assert(slot.improvement === true && Number(slot.delta) > 0, 'H14_BETTER_GEAR_NOT_DETECTED');
              }
              const targetOrder = (plan.group && plan.group.targets || []).map(row => row.role);
              const firstMerchant = targetOrder.indexOf('MERCHANT');
              const lastFarmer = targetOrder.lastIndexOf('FARMER');
              if (firstMerchant >= 0 && lastFarmer >= 0) {
                assert(lastFarmer < firstMerchant, 'H14_GROUP_PRIORITY_ORDER_INVALID');
              }
              return {
                goalState: goal.state,
                slot: testPlan.targetSlot,
                improvement: slot.improvement,
                delta: slot.delta,
                groupTargetOrder: targetOrder,
                groupProposals: plan.group && plan.group.proposals ? plan.group.proposals.length : 0,
                upgradeCandidates: plan.local.upgradeCandidates.length
              };
            }
          },
          {
            id: 'equip-swap',
            title: 'Gear-Kandidaten echt ausrüsten und Live-Deltas bestätigen',
            timeoutMs: 12000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan, 'H14_LIVE_TEST_PLAN_MISSING');
              const queued = runtime.gear.queueEquip(testPlan.candidateInventorySlot, testPlan.targetSlot);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H14_EQUIP_QUEUE_FAILED');
              const confirmed = await waitFor(() => {
                const status = runtime.gear.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H14_SUSPENDED');
                if (status.metrics.equipsUnknown > baseline.equipsUnknown) throw new Error('H14_EQUIP_UNKNOWN');
                return status.metrics.equipsConfirmed > baseline.equipsConfirmed ? status : null;
              }, { timeoutMs: 10000, pollMs: 100, label: 'h14-equip-confirmed' });

              const equipment = runtime.game.equipmentSnapshot();
              const current = equipment && equipment.slots && equipment.slots[testPlan.targetSlot] || null;
              assert(fingerprint(runtime, current) === testPlan.candidateFingerprint,
                'H14_EQUIP_TARGET_NOT_OBSERVED');

              const inventory = runtime.game.inventorySnapshot();
              const original = inventory && (inventory.items || []).find(row =>
                fingerprint(runtime, row) === testPlan.originalFingerprint);
              assert(original, 'H14_ORIGINAL_GEAR_NOT_RETURNED_TO_INVENTORY');
              testPlan.restoreInventorySlot = Number(original.slot);

              return {
                slot: testPlan.targetSlot,
                equipped: { name: current.name, level: current.level },
                originalInventorySlot: testPlan.restoreInventorySlot,
                equipsConfirmed: confirmed.metrics.equipsConfirmed - baseline.equipsConfirmed
              };
            }
          },
          {
            id: 'restore',
            title: 'Ursprüngliches Gear exakt zurückrüsten und Zustand wiederherstellen',
            timeoutMs: 12000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan && Number.isInteger(testPlan.restoreInventorySlot), 'H14_RESTORE_SLOT_MISSING');
              const queued = runtime.gear.queueEquip(testPlan.restoreInventorySlot, testPlan.targetSlot);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H14_RESTORE_QUEUE_FAILED');
              const restored = await waitFor(() => {
                const status = runtime.gear.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H14_SUSPENDED');
                if (status.metrics.equipsUnknown > baseline.equipsUnknown) throw new Error('H14_EQUIP_UNKNOWN');
                return status.metrics.equipsConfirmed >= baseline.equipsConfirmed + 2 ? status : null;
              }, { timeoutMs: 10000, pollMs: 100, label: 'h14-restore-confirmed' });

              const equipment = runtime.game.equipmentSnapshot();
              const current = equipment && equipment.slots && equipment.slots[testPlan.targetSlot] || null;
              assert(fingerprint(runtime, current) === testPlan.originalFingerprint,
                'H14_ORIGINAL_GEAR_NOT_RESTORED');

              const inventory = runtime.game.inventorySnapshot();
              const candidate = inventory && (inventory.items || []).find(row =>
                fingerprint(runtime, row) === testPlan.candidateFingerprint);
              assert(candidate, 'H14_CANDIDATE_NOT_RETURNED_TO_INVENTORY');

              return {
                slot: testPlan.targetSlot,
                restored: { name: current.name, level: current.level },
                candidateInventorySlot: candidate.slot,
                equipsConfirmed: restored.metrics.equipsConfirmed - baseline.equipsConfirmed
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne Gear-UNKNOWN oder unerwarteten Zustand beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const status = runtime.gear.status();
              assert(status.suspended === false, status.suspendedReason || 'H14_SUSPENDED');
              assert(status.metrics.equipsUnknown === baseline.equipsUnknown, 'H14_EQUIP_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.unequipsUnknown === baseline.unequipsUnknown, 'H14_UNEQUIP_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.deliveriesUnknown === baseline.deliveriesUnknown, 'H14_DELIVERY_UNKNOWN_DURING_STABILITY');
              const equipment = runtime.game.equipmentSnapshot();
              const current = equipment && equipment.slots && equipment.slots[testPlan.targetSlot] || null;
              assert(fingerprint(runtime, current) === testPlan.originalFingerprint,
                'H14_RESTORED_GEAR_DRIFTED');
              return {
                equipUnknown: status.metrics.equipsUnknown - baseline.equipsUnknown,
                unequipUnknown: status.metrics.unequipsUnknown - baseline.unequipsUnknown,
                deliveryUnknown: status.metrics.deliveriesUnknown - baseline.deliveriesUnknown,
                originalRestored: true
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H14 Pending/Request/Goal vollständig freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.gear.cancelRequest('H14_LIVE_TEST_COMPLETE');
              runtime.gear.setGoals(previousGoals);
              const gear = runtime.gear.status();
              assert(gear.pending == null, 'H14_PENDING_REMAINS');
              assert(gear.request == null, 'H14_REQUEST_REMAINS');
              const equipment = runtime.game.equipmentSnapshot();
              const current = equipment && equipment.slots && equipment.slots[testPlan.targetSlot] || null;
              assert(fingerprint(runtime, current) === testPlan.originalFingerprint,
                'H14_CLEANUP_ORIGINAL_GEAR_NOT_RESTORED');
              return {
                pending: !!gear.pending,
                request: !!gear.request,
                originalRestored: true,
                goalsRestored: gear.goals.length === previousGoals.length
              };
            }
          }
        ]
      });
    }

    _registerH15LiveTest() {
      let baseline = null;
      let testPlan = null;
      let previousPolicy = null;

      this.liveTests.register({
        id: 'h15-upgrade-compound',
        title: 'H15 – Upgrade & Compound',
        description: 'Ein-Klick-Live-Test für Scrollwahl, Risiko-/Kostenbudget und genau eine niedrig riskante echte Upgrade- oder Compound-Aktion mit Live-Outcome-Evidence.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.upgrade.resetSafety('H15_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.upgrade.cancelRequest('H15_LIVE_TEST_RESET'); } catch (_) {}
          previousPolicy = runtime.upgrade.policy();
          runtime.upgrade.policy({
            maxAttemptsPerSession: 1,
            maxUpgradeLevel: 3,
            maxCompoundLevel: 1,
            maxItemValueAtRisk: 25000,
            maxConsumableCost: 10000,
            offeringMode: 'DISABLED',
            offeringFromLevel: 99
          });
          const metrics = runtime.upgrade.status().metrics;
          baseline = {
            upgradesDispatched: metrics.upgradesDispatched,
            upgradesSucceeded: metrics.upgradesSucceeded,
            upgradesFailed: metrics.upgradesFailed,
            upgradesUnknown: metrics.upgradesUnknown,
            compoundsDispatched: metrics.compoundsDispatched,
            compoundsSucceeded: metrics.compoundsSucceeded,
            compoundsFailed: metrics.compoundsFailed,
            compoundsUnknown: metrics.compoundsUnknown
          };
          testPlan = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.upgrade.cancelRequest('H15_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.upgrade.resetSafety('H15_LIVE_TEST_CLEANUP'); } catch (_) {}
          if (previousPolicy) {
            try { runtime.upgrade.policy(previousPolicy); } catch (_) {}
          }
        },
        steps: [
          {
            id: 'preflight',
            title: 'Niedrig riskanten Upgrade-/Compound-Kandidaten und Live-APIs prüfen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const module = runtime.modules.describe('upgrade-compound');
              assert(module && module.state === 'ACTIVE', 'H15_MODULE_NOT_ACTIVE');

              const plan = runtime.upgrade.plan();
              assert(plan && plan.state === 'READY', plan && plan.reason || 'H15_PLAN_UNAVAILABLE');
              const choices = [];
              for (const row of plan.upgradeCandidates || []) {
                if (Number(row.fromLevel) <= 2 && Number(row.budget && row.budget.itemValueAtRisk) <= 25000
                    && Number(row.budget && row.budget.consumableCost) <= 10000) choices.push(row);
              }
              for (const row of plan.compoundCandidates || []) {
                if (Number(row.fromLevel) <= 0 && Number(row.budget && row.budget.itemValueAtRisk) <= 25000
                    && Number(row.budget && row.budget.consumableCost) <= 10000) choices.push(row);
              }
              choices.sort((a, b) => Number(a.budget.itemValueAtRisk) - Number(b.budget.itemValueAtRisk)
                || Number(a.budget.consumableCost) - Number(b.budget.consumableCost)
                || (a.kind === 'UPGRADE' ? -1 : 1));
              const selected = choices[0];
              assert(selected, 'H15_NEEDS_LOW_RISK_UPGRADE_OR_COMPOUND_CANDIDATE');
              assert(runtime.actions.available(selected.kind === 'COMPOUND' ? 'compound' : 'upgrade'),
                selected.kind === 'COMPOUND' ? 'COMPOUND_API_UNAVAILABLE' : 'UPGRADE_API_UNAVAILABLE');

              testPlan = {
                kind: selected.kind,
                itemName: selected.kind === 'COMPOUND' ? selected.items[0].name : selected.item.name,
                itemSlot: selected.itemSlot == null ? null : Number(selected.itemSlot),
                itemSlots: selected.itemSlots ? selected.itemSlots.map(Number) : null,
                fromLevel: Number(selected.fromLevel) || 0,
                targetLevel: Number(selected.targetLevel) || 0,
                scrollName: selected.scrollName,
                scrollSlot: Number(selected.scroll.slot),
                offeringName: selected.offering ? selected.offering.name : null,
                offeringSlot: selected.offering ? Number(selected.offering.slot) : null,
                itemValueAtRisk: Number(selected.budget.itemValueAtRisk) || 0,
                consumableCost: Number(selected.budget.consumableCost) || 0
              };

              return {
                character: game.character.name,
                ctype: game.character.ctype,
                kind: testPlan.kind,
                item: testPlan.itemName,
                fromLevel: testPlan.fromLevel,
                targetLevel: testPlan.targetLevel,
                itemSlot: testPlan.itemSlot,
                itemSlots: testPlan.itemSlots,
                scroll: testPlan.scrollName,
                scrollSlot: testPlan.scrollSlot,
                offering: testPlan.offeringName,
                itemValueAtRisk: testPlan.itemValueAtRisk,
                consumableCost: testPlan.consumableCost,
                availableUpgradeCandidates: (plan.upgradeCandidates || []).length,
                availableCompoundCandidates: (plan.compoundCandidates || []).length
              };
            }
          },
          {
            id: 'planning',
            title: 'Scroll-Grade, Workspace und H15-Budgets vor Mutation bestätigen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              assert(testPlan, 'H15_LIVE_TEST_PLAN_MISSING');
              const plan = runtime.upgrade.plan();
              assert(plan && plan.state === 'READY', plan && plan.reason || 'H15_PLAN_UNAVAILABLE');
              assert(testPlan.itemValueAtRisk <= 25000, 'H15_LIVE_ITEM_RISK_TOO_HIGH');
              assert(testPlan.consumableCost <= 10000, 'H15_LIVE_CONSUMABLE_COST_TOO_HIGH');
              const policy = runtime.upgrade.policy();
              assert(policy.maxAttemptsPerSession === 1, 'H15_LIVE_ATTEMPT_BUDGET_NOT_ONE');
              assert(policy.offeringMode === 'DISABLED', 'H15_LIVE_OFFERING_MUST_BE_DISABLED');
              return {
                kind: testPlan.kind,
                policy,
                workspace: plan.workspace,
                itemValueAtRisk: testPlan.itemValueAtRisk,
                consumableCost: testPlan.consumableCost
              };
            }
          },
          {
            id: 'real-action',
            title: 'Genau eine echte niedrig riskante H15-Aktion ausführen und Outcome beobachten',
            timeoutMs: 15000,
            run: async ({ runtime, assert, waitFor }) => {
              assert(testPlan, 'H15_LIVE_TEST_PLAN_MISSING');
              const queued = testPlan.kind === 'COMPOUND'
                ? runtime.upgrade.queueCompound(testPlan.itemSlots)
                : runtime.upgrade.queueUpgrade(testPlan.itemSlot);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H15_QUEUE_FAILED');
              const dispatched = runtime.upgrade.tick();
              assert(dispatched && dispatched.accepted === true, dispatched && dispatched.reason || 'H15_DISPATCH_FAILED');

              const outcome = await waitFor(() => {
                const status = runtime.upgrade.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H15_SUSPENDED');
                if (status.metrics.upgradesUnknown > baseline.upgradesUnknown) throw new Error('H15_UPGRADE_UNKNOWN');
                if (status.metrics.compoundsUnknown > baseline.compoundsUnknown) throw new Error('H15_COMPOUND_UNKNOWN');
                const succeeded = testPlan.kind === 'COMPOUND'
                  ? status.metrics.compoundsSucceeded > baseline.compoundsSucceeded
                  : status.metrics.upgradesSucceeded > baseline.upgradesSucceeded;
                const failed = testPlan.kind === 'COMPOUND'
                  ? status.metrics.compoundsFailed > baseline.compoundsFailed
                  : status.metrics.upgradesFailed > baseline.upgradesFailed;
                return succeeded || failed ? status : null;
              }, { timeoutMs: 12000, pollMs: 100, label: 'h15-live-outcome' });

              const lastAction = outcome.lastAction || {};
              assert([testPlan.kind + '_SUCCEEDED', testPlan.kind + '_FAILED'].includes(lastAction.type),
                'H15_OUTCOME_NOT_CLASSIFIED');
              return {
                kind: testPlan.kind,
                outcome: lastAction.type,
                evidence: lastAction.evidence || null,
                fromLevel: testPlan.fromLevel,
                targetLevel: testPlan.targetLevel,
                upgradesDispatched: outcome.metrics.upgradesDispatched - baseline.upgradesDispatched,
                upgradesSucceeded: outcome.metrics.upgradesSucceeded - baseline.upgradesSucceeded,
                upgradesFailed: outcome.metrics.upgradesFailed - baseline.upgradesFailed,
                compoundsDispatched: outcome.metrics.compoundsDispatched - baseline.compoundsDispatched,
                compoundsSucceeded: outcome.metrics.compoundsSucceeded - baseline.compoundsSucceeded,
                compoundsFailed: outcome.metrics.compoundsFailed - baseline.compoundsFailed
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne H15 UNKNOWN, Retry oder Suspension beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const status = runtime.upgrade.status();
              assert(status.suspended === false, status.suspendedReason || 'H15_SUSPENDED');
              assert(status.metrics.upgradesUnknown === baseline.upgradesUnknown, 'H15_UPGRADE_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.compoundsUnknown === baseline.compoundsUnknown, 'H15_COMPOUND_UNKNOWN_DURING_STABILITY');
              assert(status.attemptsThisSession === 1, 'H15_LIVE_ATTEMPT_COUNT_NOT_ONE');
              assert(status.pending == null, 'H15_PENDING_REMAINS_DURING_STABILITY');
              assert(status.request == null, 'H15_REQUEST_REMAINS_DURING_STABILITY');
              return {
                attempts: status.attemptsThisSession,
                upgradeUnknown: status.metrics.upgradesUnknown - baseline.upgradesUnknown,
                compoundUnknown: status.metrics.compoundsUnknown - baseline.compoundsUnknown,
                suspended: status.suspended
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H15 Request/Pending freigeben und Test-Policy zurücksetzen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.upgrade.cancelRequest('H15_LIVE_TEST_COMPLETE');
              const status = runtime.upgrade.status();
              assert(status.pending == null, 'H15_PENDING_REMAINS');
              assert(status.request == null, 'H15_REQUEST_REMAINS');
              return {
                pending: !!status.pending,
                request: !!status.request,
                outcome: status.lastAction && status.lastAction.type || null
              };
            }
          }
        ]
      });
    }

    _registerH16LiveTest() {
      let baseline = null;
      let testPlan = null;
      let previousPolicy = null;

      const inventoryQuantity = (runtime, name, level = 0) => {
        const inventory = runtime.game.inventorySnapshot();
        if (!inventory || inventory.available === false) return 0;
        return (inventory.items || []).reduce((sum, row) =>
          String(row.name) === String(name) && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(level) || 0)
            ? sum + Math.max(1, Number(row.quantity) || 1)
            : sum, 0);
      };

      const tradeUnknownTotal = status => {
        const metrics = status && status.metrics || {};
        return Number(metrics.npcBuysUnknown || 0) + Number(metrics.marketBuysUnknown || 0);
      };

      const bankUnknownTotal = status => {
        const metrics = status && status.metrics || {};
        return Number(metrics.withdrawalsUnknown || 0)
          + Number(metrics.depositsUnknown || 0)
          + Number(metrics.goldWithdrawalsUnknown || 0)
          + Number(metrics.goldDepositsUnknown || 0)
          + Number(metrics.movementUnknown || 0);
      };

      const bankWriteTotal = status => {
        const metrics = status && status.metrics || {};
        return Number(metrics.withdrawalsDispatched || 0)
          + Number(metrics.depositsDispatched || 0)
          + Number(metrics.goldWithdrawalsDispatched || 0)
          + Number(metrics.goldDepositsDispatched || 0);
      };

      const recipeInputRisk = (runtime, recipe) => {
        let total = 0;
        for (const ingredient of recipe && recipe.items || []) {
          const definition = runtime.game.itemDefinition(ingredient.name);
          const base = definition && Number(definition.g);
          if (!Number.isFinite(base) || base < 0) return null;
          const level = Math.max(0, Number(ingredient.level) || 0);
          const quantity = Math.max(1, Math.floor(Number(ingredient.quantity) || 1));
          total += Math.round(base * Math.pow(1.75, level)) * quantity;
        }
        return total;
      };

      this.liveTests.register({
        id: 'h16-exchange-craft',
        title: 'H16 – Exchange & Craft',
        description: 'Ein-Klick-Live-Test für Materialbeschaffung, eine kleine niedrig riskante Craft- und Exchange-Sequenz, Live-Outcome-Evidence und Produktionsgraph.',
        version: '6',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.exchangeCraft.resetSafety('H16_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.exchangeCraft.cancelRequest('H16_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.trade.cancelRequest('H16_LIVE_TEST_RESET'); } catch (_) {}
          try { runtime.bank.cancelRequest('H16_LIVE_TEST_RESET'); } catch (_) {}
          previousPolicy = runtime.exchangeCraft.policy();
          runtime.exchangeCraft.policy({
            maxAttemptsPerSession: 2,
            maxExchangeValueAtRisk: 2000000,
            maxCraftGoldCost: 1000000,
            maxCraftInputValueAtRisk: 2000000,
            goldReserve: 10000,
            maxProductionDepth: 6,
            allowQuestEvent: false
          });
          const metrics = runtime.exchangeCraft.status().metrics;
          const tradeStatus = runtime.trade.status();
          const bankStatus = runtime.bank.status();
          baseline = {
            exchangesDispatched: metrics.exchangesDispatched,
            exchangesConfirmed: metrics.exchangesConfirmed,
            exchangesRejected: metrics.exchangesRejected,
            exchangesUnknown: metrics.exchangesUnknown,
            craftsDispatched: metrics.craftsDispatched,
            craftsConfirmed: metrics.craftsConfirmed,
            craftsRejected: metrics.craftsRejected,
            craftsUnknown: metrics.craftsUnknown,
            tradeUnknown: tradeUnknownTotal(tradeStatus),
            bankUnknown: bankUnknownTotal(bankStatus),
            bankWrites: bankWriteTotal(bankStatus),
            materialDelegations: metrics.materialDelegations
          };
          testPlan = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.exchangeCraft.cancelRequest('H16_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.trade.cancelRequest('H16_LIVE_TEST_CLEANUP'); } catch (_) {}
          try { runtime.bank.cancelRequest('H16_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const current = runtime.exchangeCraft.status();
            if (!current.suspended) runtime.exchangeCraft.resetSafety('H16_LIVE_TEST_CLEANUP');
          } catch (_) {}
          if (previousPolicy) {
            try { runtime.exchangeCraft.policy(previousPolicy); } catch (_) {}
          }
        },
        steps: [
          {
            id: 'bank-discovery',
            title: 'Bankbestand read-only sichtbar machen',
            timeoutMs: 120000,
            run: async ({ runtime, assert, waitFor }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              if (String(game.character.ctype || '').toLowerCase() !== 'merchant') {
                return {
                  skipped: true,
                  reason: 'H16_BANK_DISCOVERY_NOT_REQUIRED_FOR_NON_MERCHANT',
                  ctype: game.character.ctype || null,
                  movementRequests: 0
                };
              }

              const beforeStatus = runtime.bank.status();
              assert(beforeStatus && beforeStatus.suspended !== true,
                beforeStatus && beforeStatus.suspendedReason || 'H12_SUSPENDED_BEFORE_H16_BANK_DISCOVERY');
              const beforeWrites = bankWriteTotal(beforeStatus);
              const beforeUnknown = bankUnknownTotal(beforeStatus);
              const existing = runtime.game.bankSnapshot();
              if (existing && existing.available !== false) {
                assert(bankWriteTotal(runtime.bank.status()) === beforeWrites, 'H16_BANK_DISCOVERY_WRITE_DETECTED');
                return {
                  alreadyMounted: true,
                  map: existing.map || null,
                  packCount: (existing.packs || []).length,
                  usedSlots: Number(existing.usedSlots || 0),
                  movementRequests: 0
                };
              }

              const movementBefore = Number(beforeStatus.metrics && beforeStatus.metrics.movementRequests || 0);
              const queued = runtime.bank.queueMount();
              assert(queued && queued.accepted === true,
                queued && queued.reason || 'H16_BANK_DISCOVERY_QUEUE_FAILED');

              const bank = await waitFor(() => {
                const tick = runtime.bank.tick();
                const current = runtime.bank.status();
                if (current.suspended) throw new Error(current.suspendedReason || 'H12_SUSPENDED_DURING_H16_BANK_DISCOVERY');
                if (bankUnknownTotal(current) > beforeUnknown) throw new Error('H16_BANK_DISCOVERY_UNKNOWN');
                if (bankWriteTotal(current) !== beforeWrites) throw new Error('H16_BANK_DISCOVERY_WRITE_DETECTED');
                const snapshot = runtime.game.bankSnapshot();
                return snapshot && snapshot.available !== false && !current.pending && !current.request
                  ? snapshot
                  : null;
              }, { timeoutMs: 110000, pollMs: 150, label: 'h16-bank-discovery' });

              const afterStatus = runtime.bank.status();
              assert(bankWriteTotal(afterStatus) === beforeWrites, 'H16_BANK_DISCOVERY_WRITE_DETECTED');
              return {
                alreadyMounted: false,
                map: bank.map || null,
                packCount: (bank.packs || []).length,
                usedSlots: Number(bank.usedSlots || 0),
                movementRequests: Number(afterStatus.metrics && afterStatus.metrics.movementRequests || 0) - movementBefore
              };
            }
          },
          {
            id: 'preflight',
            title: 'Sicheren Craft-/Exchange-Pfad inklusive beschaffbarer Materialien prüfen',
            timeoutMs: 12000,
            run: async ({ runtime, assert, note }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const module = runtime.modules.describe('exchange-craft');
              assert(module && module.state === 'ACTIVE', 'H16_MODULE_NOT_ACTIVE');
              assert(runtime.actions.available('auto_craft'), 'AUTO_CRAFT_API_UNAVAILABLE');
              assert(runtime.actions.available('exchange'), 'EXCHANGE_API_UNAVAILABLE');

              const plan = runtime.exchangeCraft.plan();
              assert(plan && plan.state === 'READY', plan && plan.reason || 'H16_PLAN_UNAVAILABLE');
              const crafts = (plan.craftCandidates || []).filter(row =>
                row.safe === true
                && row.questEvent !== true
                && Number(row.cost || 0) <= 1000000
                && Number(row.inputValueAtRisk || 0) <= 2000000);
              const exchanges = (plan.exchangeCandidates || []).filter(row =>
                row.safe === true
                && row.questEvent !== true
                && Number(row.valueAtRisk || 0) <= 2000000);

              let selectedCraft = null;
              let selectedExchange = null;
              let materials = [];
              let production = null;
              let materialAcquisitionGold = 0;
              let mode = null;
              const localCraftRejects = {};
              const fallbackRejects = {};
              const nearMatches = [];
              const bump = (bucket, reason) => {
                const key = String(reason || 'UNKNOWN');
                bucket[key] = (bucket[key] || 0) + 1;
              };
              const recordFallbackReject = (recipe, reason, details = {}, distance = 9) => {
                bump(fallbackRejects, reason);
                nearMatches.push({
                  ...details,
                  itemName: recipe && recipe.name || null,
                  reason,
                  distance,
                  craftCost: recipe ? Number(recipe.cost || 0) : null
                });
              };
              const recordLocalCraftReject = (craft, reason, details = {}, distance = 3) => {
                bump(localCraftRejects, reason);
                nearMatches.push({
                  ...details,
                  itemName: craft && craft.itemName || null,
                  reason,
                  distance,
                  craftCost: craft ? Number(craft.cost || 0) : null
                });
              };
              const buildPreflightDiagnostics = () => {
                nearMatches.sort((a, b) =>
                  Number(a.distance) - Number(b.distance)
                  || Number(a.craftCost == null ? Number.MAX_SAFE_INTEGER : a.craftCost)
                    - Number(b.craftCost == null ? Number.MAX_SAFE_INTEGER : b.craftCost)
                  || String(a.itemName || '').localeCompare(String(b.itemName || '')));
                return {
                  suiteVersion: 6,
                  selectedMode: mode,
                  totalCraftCandidates: (plan.craftCandidates || []).length,
                  safeCraftCandidates: crafts.length,
                  safeExchangeCandidates: exchanges.length,
                  localCraftRejects,
                  fallbackRejects,
                  topNearMatches: nearMatches.slice(0, 5),
                  caps: {
                    exchangeValueAtRisk: 2000000,
                    craftInputValueAtRisk: 2000000,
                    craftCost: 1000000,
                    materialAcquisition: 1000000,
                    goldReserve: 10000,
                    maxMissingLeaves: 2,
                    missingLeafLevel: 0
                  }
                };
              };

              for (const row of plan.craftCandidates || []) {
                if (row && row.safe !== true) bump(localCraftRejects, row.reason || 'H16_CRAFT_UNSAFE');
              }

              note(buildPreflightDiagnostics());
              assert(exchanges.length > 0, 'H16_NEEDS_LOW_RISK_EXCHANGE_CANDIDATE');

              for (const craft of crafts) {
                const outputDef = craft.definition || runtime.game.itemDefinition(craft.itemName);
                const required = outputDef && Number(outputDef.e);
                const outputUnitValue = outputDef && Number(outputDef.g);
                const outputRisk = Number.isFinite(outputUnitValue) && Number.isFinite(required)
                  ? outputUnitValue * required
                  : null;
                if (!Number.isFinite(required) || required <= 0 || outputDef.quest === true || outputDef.cash === true) continue;
                if (outputRisk == null || outputRisk > 2000000) continue;
                const existing = inventoryQuantity(runtime, craft.itemName, 0);
                if (existing + 1 < required) continue;
                selectedCraft = craft;
                selectedExchange = {
                  itemName: craft.itemName,
                  level: 0,
                  requiredQuantity: required,
                  valueAtRisk: outputRisk,
                  afterCraft: true
                };
                production = runtime.exchangeCraft.productionPlan(craft.itemName, 1, { includeBank: false });
                mode = 'CRAFT_TO_EXCHANGE_CHAIN';
                break;
              }

              if (!selectedCraft) {
                for (const craft of crafts) {
                  const sourceNames = new Set((craft.recipe && craft.recipe.items || []).map(row => String(row.name)));
                  const exchange = exchanges.find(row => !sourceNames.has(String(row.itemName)));
                  if (!exchange) {
                    recordLocalCraftReject(craft, 'NO_DISJOINT_EXCHANGE_CANDIDATE', {
                      inputRisk: Number(craft.inputValueAtRisk || 0),
                      sourceItems: Array.from(sourceNames).slice(0, 5),
                      availableExchangeCandidates: exchanges.length
                    }, 3);
                    continue;
                  }
                  selectedCraft = craft;
                  selectedExchange = {
                    itemName: exchange.itemName,
                    level: exchange.level,
                    requiredQuantity: exchange.requiredQuantity,
                    inventorySlot: exchange.inventorySlot,
                    fingerprint: exchange.fingerprint,
                    valueAtRisk: exchange.valueAtRisk,
                    afterCraft: false
                  };
                  production = runtime.exchangeCraft.productionPlan(craft.itemName, 1, { includeBank: false });
                  mode = 'CRAFT_AND_EXCHANGE_COVERAGE';
                  break;
                }
              }

              const tradeStatus = runtime.trade.status();
              const isMerchant = String(game.character.ctype || '').toLowerCase() === 'merchant';
              if (!selectedCraft && !isMerchant) {
                recordFallbackReject(null, 'MATERIAL_ACQUISITION_REQUIRES_MERCHANT', {
                  characterType: game.character.ctype || null
                }, 0);
              } else if (!selectedCraft && tradeStatus && tradeStatus.suspended) {
                recordFallbackReject(null, 'MATERIAL_ACQUISITION_TRADE_SUSPENDED', {
                  tradeReason: tradeStatus.reason || null
                }, 0);
              } else if (!selectedCraft) {
                const acquisitionCandidates = [];
                const catalog = runtime.game.craftCatalog();
                for (const recipe of catalog || []) {
                  if (!recipe) {
                    recordFallbackReject(null, 'RECIPE_UNAVAILABLE', {}, 12);
                    continue;
                  }
                  if (recipe.quest) {
                    recordFallbackReject(recipe, 'QUEST_EVENT_RECIPE', { quest: recipe.quest }, 12);
                    continue;
                  }
                  if (Number(recipe.cost || 0) > 1000000) {
                    recordFallbackReject(recipe, 'CRAFT_COST_OVER_CAP', { craftCost: Number(recipe.cost || 0), cap: 1000000 }, 8);
                    continue;
                  }
                  const outputDef = runtime.game.itemDefinition(recipe.name);
                  if (!outputDef) {
                    recordFallbackReject(recipe, 'OUTPUT_DEFINITION_UNAVAILABLE', {}, 11);
                    continue;
                  }
                  if (outputDef.quest === true || outputDef.cash === true) {
                    recordFallbackReject(recipe, 'OUTPUT_QUEST_OR_CASH_BLOCKED', { quest: outputDef.quest === true, cash: outputDef.cash === true }, 11);
                    continue;
                  }
                  const inputRisk = recipeInputRisk(runtime, recipe);
                  if (inputRisk == null) {
                    recordFallbackReject(recipe, 'INPUT_RISK_UNAVAILABLE', {}, 9);
                    continue;
                  }
                  if (inputRisk > 2000000) {
                    recordFallbackReject(recipe, 'INPUT_RISK_OVER_CAP', { inputRisk, cap: 2000000 }, 8);
                    continue;
                  }

                  const candidateProduction = runtime.exchangeCraft.productionPlan(recipe.name, 1, { includeBank: false });
                  if (candidateProduction && (candidateProduction.protectedRecipes || []).length) {
                    recordFallbackReject(recipe, 'PROTECTED_RECIPE_IN_PRODUCTION', {
                      productionState: candidateProduction.state || null,
                      productionReason: candidateProduction.reason || null,
                      protectedRecipes: (candidateProduction.protectedRecipes || []).slice(0, 3),
                      inputRisk
                    }, 7);
                    continue;
                  }
                  if (!candidateProduction || candidateProduction.state !== 'NEEDS_MATERIALS') {
                    recordFallbackReject(recipe, 'PRODUCTION_NOT_NEEDS_MATERIALS', {
                      productionState: candidateProduction && candidateProduction.state || null,
                      productionReason: candidateProduction && candidateProduction.reason || null,
                      inputRisk
                    }, 7);
                    continue;
                  }
                  if ((candidateProduction.stages || []).length !== 1) {
                    recordFallbackReject(recipe, 'NESTED_OR_MULTI_STAGE_RECIPE', {
                      stageCount: (candidateProduction.stages || []).length,
                      stages: (candidateProduction.stages || []).slice(0, 4).map(row => row.itemName),
                      inputRisk
                    }, 5);
                    continue;
                  }
                  const stage = candidateProduction.stages[0];
                  if (!stage || String(stage.itemName) !== String(recipe.name) || Number(stage.runs) !== 1) {
                    recordFallbackReject(recipe, 'DIRECT_STAGE_MISMATCH', {
                      stage: stage ? { itemName: stage.itemName, runs: stage.runs } : null,
                      inputRisk
                    }, 5);
                    continue;
                  }
                  const missing = candidateProduction.missing || [];
                  if (!missing.length) {
                    recordFallbackReject(recipe, 'NO_MISSING_LEAVES_AFTER_NEEDS_MATERIALS', { inputRisk }, 6);
                    continue;
                  }
                  if (missing.length > 2) {
                    recordFallbackReject(recipe, 'TOO_MANY_MISSING_LEAVES', {
                      missingCount: missing.length,
                      missing: missing.slice(0, 5).map(row => ({ itemName: row.itemName, level: row.level, quantity: row.quantity })),
                      inputRisk
                    }, 4);
                    continue;
                  }

                  const sourceNames = new Set((recipe.items || []).map(row => String(row.name)));
                  const exchange = exchanges.find(row => !sourceNames.has(String(row.itemName)));
                  if (!exchange) {
                    recordFallbackReject(recipe, 'NO_DISJOINT_EXCHANGE_CANDIDATE', {
                      missingCount: missing.length,
                      missing: missing.map(row => ({ itemName: row.itemName, level: row.level, quantity: row.quantity })),
                      inputRisk
                    }, 4);
                    continue;
                  }

                  let viable = true;
                  let viabilityReason = null;
                  let viabilityDetails = null;
                  let acquisitionGold = 0;
                  const inventoryForAcquisition = runtime.game.inventorySnapshot();
                  const availableInventorySlots = inventoryForAcquisition && inventoryForAcquisition.available !== false
                    ? Math.max(0, Math.floor(Number(inventoryForAcquisition.freeSlots) || 0))
                    : 0;
                  let plannedBankWithdrawals = 0;
                  const plannedMaterials = [];
                  for (const row of missing) {
                    const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
                    const level = Math.max(0, Number(row.level) || 0);
                    if (level !== 0) {
                      viable = false;
                      viabilityReason = 'MISSING_LEAF_LEVEL_NONZERO';
                      viabilityDetails = { missingItemName: row.itemName, level, quantity };
                      break;
                    }

                    const offers = [];
                    const recipeIngredientQuantity = (recipe.items || [])
                      .filter(ingredient =>
                        String(ingredient.name) === String(row.itemName)
                        && Math.max(0, Number(ingredient.level) || 0) === level)
                      .reduce((max, ingredient) =>
                        Math.max(max, Math.max(1, Math.floor(Number(ingredient.quantity) || 1))), quantity);
                    const minBankStackQuantity = Math.max(quantity, recipeIngredientQuantity);
                    const bankSlotAvailable = plannedBankWithdrawals < availableInventorySlots;
                    const bankRow = bankSlotAvailable
                      ? (row.bankRows || []).find(source =>
                        source
                        && source.withdrawable === true
                        && Math.max(1, Math.floor(Number(source.quantity) || 1)) >= minBankStackQuantity)
                      : null;
                    if (bankRow) {
                      offers.push({
                        source: 'BANK',
                        unitPrice: 0,
                        bankRow: {
                          pack: bankRow.pack,
                          map: bankRow.map,
                          slot: bankRow.slot,
                          quantity: bankRow.quantity
                        }
                      });
                    }

                    const npcPrice = Number(row.npcPrice);
                    const npcAvailable = Number.isFinite(npcPrice) && npcPrice > 0
                      && (row.npcSources || []).some(source => source && source.location);
                    if (npcAvailable) offers.push({ source: 'NPC', unitPrice: npcPrice });

                    const ask = row.bestMarketAsk || null;
                    const askPrice = ask && Number(ask.price);
                    const askQuantity = ask && Math.max(1, Math.floor(Number(ask.quantity) || 1));
                    if (ask && Number.isFinite(askPrice) && askPrice > 0 && askQuantity >= quantity) {
                      offers.push({ source: 'MARKET', unitPrice: askPrice });
                    }

                    offers.sort((a, b) => a.unitPrice - b.unitPrice);
                    const chosen = offers[0];
                    if (!chosen) {
                      viable = false;
                      viabilityReason = 'MISSING_LEAF_NO_BANK_NPC_OR_MARKET_SOURCE';
                      viabilityDetails = {
                        missingItemName: row.itemName,
                        level,
                        quantity,
                        bankRows: (row.bankRows || []).slice(0, 4).map(source => ({
                          pack: source.pack,
                          map: source.map || null,
                          slot: source.slot,
                          quantity: source.quantity,
                          safe: source.safe === true,
                          mountedMapMatch: source.mountedMapMatch === true,
                          reservedQuantity: Number(source.reservedQuantity || 0),
                          remainingAfterWholeStack: Number(source.remainingAfterWholeStack || 0),
                          withdrawable: source.withdrawable === true,
                          minBankStackQuantity,
                          availableInventorySlots,
                          plannedBankWithdrawals,
                          bankSlotAvailable
                        })),
                        npcPrice: Number.isFinite(npcPrice) ? npcPrice : null,
                        npcSources: (row.npcSources || []).slice(0, 4).map(source => ({
                          npcId: source.npcId,
                          hasLocation: !!(source && source.location)
                        })),
                        bestMarketAsk: ask ? { price: ask.price, quantity: ask.quantity, playerName: ask.playerName || null } : null
                      };
                      break;
                    }

                    const estimatedCost = chosen.unitPrice * quantity;
                    acquisitionGold += estimatedCost;
                    if (chosen.source === 'BANK') plannedBankWithdrawals += 1;
                    plannedMaterials.push({
                      itemName: row.itemName,
                      level,
                      quantity,
                      maxUnitPrice: chosen.source === 'BANK' ? null : chosen.unitPrice,
                      expectedSource: chosen.source,
                      bankSource: chosen.bankRow || null,
                      minBankStackQuantity: chosen.source === 'BANK' ? minBankStackQuantity : null,
                      inventorySlotReservation: chosen.source === 'BANK' ? plannedBankWithdrawals : null,
                      estimatedCost
                    });
                  }
                  if (!viable) {
                    recordFallbackReject(recipe, viabilityReason || 'MATERIAL_PATH_NOT_VIABLE', {
                      ...(viabilityDetails || {}),
                      missingCount: missing.length,
                      missing: missing.map(row => ({ itemName: row.itemName, level: row.level, quantity: row.quantity })),
                      inputRisk,
                      acquisitionGold
                    }, 2);
                    continue;
                  }
                  if (acquisitionGold > 1000000) {
                    recordFallbackReject(recipe, 'MATERIAL_ACQUISITION_OVER_CAP', {
                      acquisitionGold,
                      cap: 1000000,
                      materials: plannedMaterials,
                      inputRisk
                    }, 1);
                    continue;
                  }
                  const recipeCost = Number(recipe.cost || 0);
                  const currentGold = Number(game.character.gold);
                  const totalEstimatedGold = acquisitionGold + recipeCost;
                  if (!Number.isFinite(currentGold)
                      || currentGold - totalEstimatedGold < 10000) {
                    recordFallbackReject(recipe, 'GOLD_RESERVE_AFTER_ACQUISITION_AND_CRAFT', {
                      currentGold: Number.isFinite(currentGold) ? currentGold : null,
                      acquisitionGold,
                      recipeCost,
                      totalEstimatedGold,
                      requiredGoldWithReserve: totalEstimatedGold + 10000,
                      reserve: 10000,
                      materials: plannedMaterials,
                      inputRisk
                    }, 1);
                    continue;
                  }

                  acquisitionCandidates.push({
                    recipe,
                    production: candidateProduction,
                    inputRisk,
                    acquisitionGold,
                    materials: plannedMaterials,
                    exchange,
                    currentGold,
                    requiredGoldWithReserve: totalEstimatedGold + 10000,
                    totalEstimatedGold
                  });
                }

                acquisitionCandidates.sort((a, b) =>
                  Number(a.totalEstimatedGold) - Number(b.totalEstimatedGold)
                  || a.materials.length - b.materials.length
                  || String(a.recipe.name).localeCompare(String(b.recipe.name)));

                const chosen = acquisitionCandidates[0] || null;
                if (chosen) {
                  selectedCraft = {
                    itemName: chosen.recipe.name,
                    cost: Number(chosen.recipe.cost || 0),
                    inputValueAtRisk: chosen.inputRisk,
                    sources: [],
                    recipe: chosen.recipe
                  };
                  selectedExchange = {
                    itemName: chosen.exchange.itemName,
                    level: chosen.exchange.level,
                    requiredQuantity: chosen.exchange.requiredQuantity,
                    inventorySlot: chosen.exchange.inventorySlot,
                    fingerprint: chosen.exchange.fingerprint,
                    valueAtRisk: chosen.exchange.valueAtRisk,
                    afterCraft: false
                  };
                  production = chosen.production;
                  materials = chosen.materials;
                  materialAcquisitionGold = chosen.acquisitionGold;
                  mode = 'ACQUIRE_CRAFT_AND_EXCHANGE_COVERAGE';
                  selectedCraft.currentGold = chosen.currentGold;
                  selectedCraft.requiredGoldWithReserve = chosen.requiredGoldWithReserve;
                }
              }

              note(buildPreflightDiagnostics());

              assert(selectedCraft && selectedExchange,
                'H16_NEEDS_LOW_RISK_CRAFT_OR_ACQUIRABLE_MATERIALS');

              testPlan = {
                mode,
                craft: {
                  itemName: selectedCraft.itemName,
                  cost: selectedCraft.cost,
                  inputValueAtRisk: selectedCraft.inputValueAtRisk,
                  sources: selectedCraft.sources || [],
                  currentGold: selectedCraft.currentGold == null ? null : selectedCraft.currentGold,
                  requiredGoldWithReserve: selectedCraft.requiredGoldWithReserve == null ? null : selectedCraft.requiredGoldWithReserve
                },
                exchange: selectedExchange,
                production,
                materials,
                materialAcquisitionGold
              };

              return {
                character: game.character.name,
                ctype: game.character.ctype,
                mode,
                craft: testPlan.craft,
                exchange: testPlan.exchange,
                materials,
                materialAcquisitionGold,
                safeCraftCandidates: crafts.length,
                safeExchangeCandidates: exchanges.length
              };
            }
          },
          {
            id: 'planning',
            title: 'Produktionsgraph, Budgets und Materialbeschaffung prüfen',
            timeoutMs: 6000,
            run: async ({ runtime, assert }) => {
              assert(testPlan, 'H16_LIVE_TEST_PLAN_MISSING');
              const production = runtime.exchangeCraft.productionPlan(testPlan.craft.itemName, 1, { includeBank: false });
              if (testPlan.materials.length) {
                assert(production && production.state === 'NEEDS_MATERIALS',
                  production && production.reason || 'H16_LIVE_PRODUCTION_MATERIAL_STATE_CHANGED');
                assert((production.missing || []).length > 0, 'H16_LIVE_EXPECTED_MATERIALS_MISSING');
                assert(testPlan.materialAcquisitionGold <= 1000000, 'H16_LIVE_MATERIAL_BUDGET_EXCEEDED');
              } else {
                assert(production && production.state === 'READY',
                  production && production.reason || 'H16_LIVE_PRODUCTION_NOT_READY');
                assert((production.missing || []).length === 0, 'H16_LIVE_PRODUCTION_HAS_MISSING_MATERIALS');
              }
              assert((production.protectedRecipes || []).length === 0, 'H16_LIVE_PRODUCTION_HAS_PROTECTED_RECIPE');
              const policy = runtime.exchangeCraft.policy();
              assert(policy.maxAttemptsPerSession === 2, 'H16_LIVE_ATTEMPT_BUDGET_NOT_TWO');
              assert(policy.allowQuestEvent === false, 'H16_LIVE_QUEST_EVENT_MUST_BE_DISABLED');
              return {
                mode: testPlan.mode,
                production,
                materials: testPlan.materials,
                materialAcquisitionGold: testPlan.materialAcquisitionGold,
                policy
              };
            }
          },
          {
            id: 'materials',
            title: 'Fehlende Craft-Materialien innerhalb des Goldbudgets beschaffen',
            timeoutMs: 180000,
            run: async ({ runtime, assert, waitFor, sleep }) => {
              assert(testPlan, 'H16_LIVE_TEST_PLAN_MISSING');
              const acquired = [];
              for (const material of testPlan.materials) {
                const before = inventoryQuantity(runtime, material.itemName, material.level);
                const bankExpected = material.expectedSource === 'BANK';
                const queued = runtime.exchangeCraft.queueMaterialAcquire(material.itemName, material.quantity, {
                  level: material.level,
                  maxUnitPrice: material.maxUnitPrice,
                  allowBank: bankExpected,
                  minBankStackQuantity: material.minBankStackQuantity
                });
                assert(queued && queued.accepted === true,
                  queued && queued.reason || 'H16_MATERIAL_ACQUIRE_QUEUE_FAILED');
                assert(queued.delegatedTo === (bankExpected ? 'bank' : 'trade'),
                  bankExpected ? 'H16_MATERIAL_ACQUIRE_NOT_DELEGATED_TO_BANK' : 'H16_MATERIAL_ACQUIRE_NOT_DELEGATED_TO_TRADE');

                let delegationStatus = null;
                if (bankExpected) {
                  const bankUnknownBefore = bankUnknownTotal(runtime.bank.status());
                  delegationStatus = await waitFor(() => {
                    try { runtime.bank.tick(); } catch (_) {}
                    const current = runtime.bank.status();
                    if (current.suspended) throw new Error(current.suspendedReason || 'H12_SUSPENDED_DURING_H16_MATERIALS');
                    if (bankUnknownTotal(current) > bankUnknownBefore) throw new Error('H16_BANK_MATERIAL_ACQUIRE_UNKNOWN');
                    const after = inventoryQuantity(runtime, material.itemName, material.level);
                    return after >= before + material.quantity && !current.pending && !current.request
                      ? current
                      : null;
                  }, { timeoutMs: 80000, pollMs: 150, label: 'h16-bank-material-' + material.itemName });
                } else {
                  delegationStatus = await waitFor(() => {
                    try { runtime.trade.tick(); } catch (_) {}
                    const current = runtime.trade.status();
                    if (current.suspended) throw new Error(current.suspendedReason || 'H13_SUSPENDED_DURING_H16_MATERIALS');
                    if (tradeUnknownTotal(current) > baseline.tradeUnknown) throw new Error('H16_MATERIAL_ACQUIRE_UNKNOWN');
                    const after = inventoryQuantity(runtime, material.itemName, material.level);
                    return after >= before + material.quantity && !current.pending && !current.request
                      ? current
                      : null;
                  }, { timeoutMs: 80000, pollMs: 150, label: 'h16-material-' + material.itemName });
                }

                acquired.push({
                  itemName: material.itemName,
                  quantity: material.quantity,
                  expectedSource: material.expectedSource,
                  maxUnitPrice: material.maxUnitPrice,
                  bankSource: material.bankSource || null,
                  minBankStackQuantity: material.minBankStackQuantity == null ? null : material.minBankStackQuantity,
                  estimatedCost: material.estimatedCost,
                  delegatedTo: queued.delegatedTo,
                  delegationLastAction: delegationStatus.lastAction || null
                });
                await sleep(1800);
              }

              const production = runtime.exchangeCraft.productionPlan(testPlan.craft.itemName, 1, { includeBank: false });
              assert(production && production.state === 'READY',
                production && production.reason || 'H16_MATERIALS_DID_NOT_COMPLETE_PRODUCTION_INPUTS');
              assert((production.missing || []).length === 0, 'H16_MATERIALS_STILL_MISSING');
              return {
                acquired,
                materialDelegations: runtime.exchangeCraft.status().metrics.materialDelegations - baseline.materialDelegations,
                production
              };
            }
          },
          {
            id: 'craft',
            title: 'Eine echte niedrig riskante Craft-Aktion ausführen und bestätigen',
            timeoutMs: 90000,
            run: async ({ runtime, assert, waitFor, sleep }) => {
              assert(testPlan, 'H16_LIVE_TEST_PLAN_MISSING');
              if (!testPlan.materials.length) await sleep(1800);
              const queued = runtime.exchangeCraft.queueCraft(testPlan.craft.itemName);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H16_CRAFT_QUEUE_FAILED');

              const status = await waitFor(() => {
                runtime.exchangeCraft.tick();
                const current = runtime.exchangeCraft.status();
                if (current.suspended) throw new Error(current.suspendedReason || 'H16_SUSPENDED');
                if (current.metrics.craftsUnknown > baseline.craftsUnknown) throw new Error('H16_CRAFT_UNKNOWN');
                return current.metrics.craftsConfirmed > baseline.craftsConfirmed ? current : null;
              }, { timeoutMs: 85000, pollMs: 150, label: 'h16-craft-confirmed' });

              return {
                itemName: testPlan.craft.itemName,
                craftsDispatched: status.metrics.craftsDispatched - baseline.craftsDispatched,
                craftsConfirmed: status.metrics.craftsConfirmed - baseline.craftsConfirmed,
                evidence: status.lastAction && status.lastAction.evidence || null
              };
            }
          },
          {
            id: 'exchange',
            title: 'Eine echte niedrig riskante Exchange-Aktion ausführen und bestätigen',
            timeoutMs: 90000,
            run: async ({ runtime, assert, waitFor, sleep }) => {
              assert(testPlan, 'H16_LIVE_TEST_PLAN_MISSING');
              await sleep(1800);
              const candidates = runtime.exchangeCraft.exchangeCandidates();
              const selected = candidates.find(row =>
                row.safe === true
                && row.questEvent !== true
                && String(row.itemName) === String(testPlan.exchange.itemName)
                && Math.max(0, Number(row.level) || 0) === Math.max(0, Number(testPlan.exchange.level) || 0));
              assert(selected, testPlan.mode === 'CRAFT_TO_EXCHANGE_CHAIN'
                ? 'H16_CRAFT_OUTPUT_NOT_EXCHANGE_READY'
                : 'H16_EXCHANGE_CANDIDATE_CHANGED');

              const queued = runtime.exchangeCraft.queueExchange(selected.inventorySlot);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H16_EXCHANGE_QUEUE_FAILED');

              const status = await waitFor(() => {
                runtime.exchangeCraft.tick();
                const current = runtime.exchangeCraft.status();
                if (current.suspended) throw new Error(current.suspendedReason || 'H16_SUSPENDED');
                if (current.metrics.exchangesUnknown > baseline.exchangesUnknown) throw new Error('H16_EXCHANGE_UNKNOWN');
                return current.metrics.exchangesConfirmed > baseline.exchangesConfirmed ? current : null;
              }, { timeoutMs: 85000, pollMs: 150, label: 'h16-exchange-confirmed' });

              return {
                itemName: selected.itemName,
                requiredQuantity: selected.requiredQuantity,
                valueAtRisk: selected.valueAtRisk,
                exchangesDispatched: status.metrics.exchangesDispatched - baseline.exchangesDispatched,
                exchangesConfirmed: status.metrics.exchangesConfirmed - baseline.exchangesConfirmed,
                evidence: status.lastAction && status.lastAction.evidence || null
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne UNKNOWN, Retry oder Suspension beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              await sleep(5000);
              const status = runtime.exchangeCraft.status();
              const tradeStatus = runtime.trade.status();
              assert(status.suspended === false, status.suspendedReason || 'H16_SUSPENDED');
              assert(tradeStatus.suspended === false, tradeStatus.suspendedReason || 'H13_SUSPENDED_DURING_H16');
              assert(status.metrics.exchangesUnknown === baseline.exchangesUnknown, 'H16_EXCHANGE_UNKNOWN_DURING_STABILITY');
              assert(status.metrics.craftsUnknown === baseline.craftsUnknown, 'H16_CRAFT_UNKNOWN_DURING_STABILITY');
              assert(tradeUnknownTotal(tradeStatus) === baseline.tradeUnknown, 'H16_MATERIAL_TRADE_UNKNOWN_DURING_STABILITY');
              assert(status.attemptsThisSession === 2, 'H16_LIVE_ATTEMPT_COUNT_NOT_TWO');
              assert(status.pending == null, 'H16_PENDING_REMAINS_DURING_STABILITY');
              assert(status.request == null, 'H16_REQUEST_REMAINS_DURING_STABILITY');
              assert(tradeStatus.pending == null, 'H16_MATERIAL_TRADE_PENDING_REMAINS');
              assert(tradeStatus.request == null, 'H16_MATERIAL_TRADE_REQUEST_REMAINS');
              return {
                attempts: status.attemptsThisSession,
                exchangeUnknown: status.metrics.exchangesUnknown - baseline.exchangesUnknown,
                craftUnknown: status.metrics.craftsUnknown - baseline.craftsUnknown,
                tradeUnknown: tradeUnknownTotal(tradeStatus) - baseline.tradeUnknown,
                suspended: status.suspended,
                tradeSuspended: tradeStatus.suspended
              };
            }
          },
          {
            id: 'cleanup',
            title: 'H16/H13 Request und Pending freigeben und Test-Policy zurücksetzen',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.exchangeCraft.cancelRequest('H16_LIVE_TEST_COMPLETE');
              runtime.trade.cancelRequest('H16_LIVE_TEST_COMPLETE');
              const status = runtime.exchangeCraft.status();
              const tradeStatus = runtime.trade.status();
              assert(status.pending == null, 'H16_PENDING_REMAINS');
              assert(status.request == null, 'H16_REQUEST_REMAINS');
              assert(tradeStatus.pending == null, 'H16_MATERIAL_TRADE_PENDING_REMAINS');
              assert(tradeStatus.request == null, 'H16_MATERIAL_TRADE_REQUEST_REMAINS');
              return {
                pending: !!status.pending,
                request: !!status.request,
                tradePending: !!tradeStatus.pending,
                tradeRequest: !!tradeStatus.request,
                mode: testPlan && testPlan.mode || null
              };
            }
          }
        ]
      });
    }

    _registerH17LiveTest() {
      let baseline = null;
      let previousPolicy = null;

      const childUnknownTotal = runtime => {
        const inventory = runtime.inventory.status().metrics || {};
        const bank = runtime.bank.status().metrics || {};
        const trade = runtime.trade.status().metrics || {};
        const gear = runtime.gear.status().metrics || {};
        const upgrade = runtime.upgrade.status().metrics || {};
        const exchange = runtime.exchangeCraft.status().metrics || {};
        return Number(inventory.lootUnknown || 0)
          + Number(bank.withdrawalsUnknown || 0)
          + Number(bank.depositsUnknown || 0)
          + Number(bank.goldWithdrawalsUnknown || 0)
          + Number(bank.goldDepositsUnknown || 0)
          + Number(bank.movementUnknown || 0)
          + Number(trade.npcBuysUnknown || 0)
          + Number(trade.npcSellsUnknown || 0)
          + Number(trade.marketBuysUnknown || 0)
          + Number(trade.marketSellsUnknown || 0)
          + Number(trade.movementUnknown || 0)
          + Number(gear.equipsUnknown || 0)
          + Number(gear.unequipsUnknown || 0)
          + Number(gear.deliveriesUnknown || 0)
          + Number(upgrade.upgradesUnknown || 0)
          + Number(upgrade.compoundsUnknown || 0)
          + Number(exchange.exchangesUnknown || 0)
          + Number(exchange.craftsUnknown || 0);
      };

      const childBusy = runtime => {
        const statuses = [
          runtime.inventory.status(),
          runtime.bank.status(),
          runtime.trade.status(),
          runtime.gear.status(),
          runtime.upgrade.status(),
          runtime.exchangeCraft.status()
        ];
        return statuses.some(status => status && (status.pending || status.request || status.pendingLoot));
      };

      this.liveTests.register({
        id: 'h17-economy-autonomy',
        title: 'H17 – Economy Autonomy',
        description: 'Begrenzter Live-Test des gemeinsamen Economy-Planners mit Konfliktauflösung, maximal drei bestätigten Aktionen und ohne Gear-/Upgrade-/Compound-Mutation.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.economy.stopAutonomy('H17_LIVE_TEST_RESET'); } catch (_) {}
          const current = runtime.economy.status();
          if (current.currentAction) throw new Error('H17_ACTIVE_ACTION_BEFORE_LIVE_TEST');
          try {
            if (!current.suspended) runtime.economy.resetSafety('H17_LIVE_TEST_RESET');
          } catch (_) {}
          previousPolicy = runtime.economy.policy();
          runtime.economy.policy({
            maxActionsPerSession: 3,
            actionCooldownMs: 1500,
            actionTimeoutMs: 120000,
            minMarketPremiumRatio: 1,
            allowKinds: {
              BANK_MOUNT: true,
              BANK_DEPOSIT: true,
              GEAR_EQUIP: false,
              MARKET_SELL: true,
              EXCHANGE: true,
              CRAFT: true,
              UPGRADE: false,
              COMPOUND: false,
              NPC_SELL: true
            }
          });
          const status = runtime.economy.status();
          baseline = {
            actionsQueued: Number(status.metrics.actionsQueued || 0),
            actionsConfirmed: Number(status.metrics.actionsConfirmed || 0),
            actionsRejected: Number(status.metrics.actionsRejected || 0),
            actionsUnknown: Number(status.metrics.actionsUnknown || 0),
            childUnknown: childUnknownTotal(runtime)
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.economy.stopAutonomy('H17_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const current = runtime.economy.status();
            if (!current.suspended && !current.currentAction) runtime.economy.resetSafety('H17_LIVE_TEST_CLEANUP');
          } catch (_) {}
          if (previousPolicy) {
            try { runtime.economy.policy(previousPolicy); } catch (_) {}
          }
        },
        steps: [
          {
            id: 'preflight',
            title: 'Economy-Planner und konfliktfreien Merchant-Pfad prüfen',
            timeoutMs: 10000,
            run: async ({ runtime, assert, note }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              assert(String(game.character.ctype || '').toLowerCase() === 'merchant', 'H17_REQUIRES_MERCHANT');
              const module = runtime.modules.describe('economy');
              assert(module && module.state === 'ACTIVE', 'H17_MODULE_NOT_ACTIVE');

              const status = runtime.economy.status();
              assert(status.suspended === false, status.suspendedReason || 'H17_SUSPENDED');
              assert(status.currentAction == null, 'H17_ACTION_ACTIVE_BEFORE_PREFLIGHT');
              assert(childUnknownTotal(runtime) === baseline.childUnknown, 'H17_CHILD_UNKNOWN_BEFORE_PREFLIGHT');

              const plan = runtime.economy.plan();
              note({
                selected: plan.selected || null,
                proposals: (plan.proposals || []).slice(0, 8),
                blockers: plan.blockers || [],
                pressure: plan.pressure || null
              });
              assert(plan.state === 'READY' && plan.selected, plan.reason || 'H17_NEEDS_SAFE_ECONOMY_ACTION');
              assert(['BANK_MOUNT','BANK_DEPOSIT','MARKET_SELL','EXCHANGE','CRAFT','NPC_SELL'].includes(plan.selected.kind),
                'H17_LIVE_SELECTED_KIND_NOT_ALLOWED');
              return {
                state: plan.state,
                reason: plan.reason,
                selected: plan.selected,
                proposalCount: (plan.proposals || []).length,
                pressure: plan.pressure || null
              };
            }
          },
          {
            id: 'bounded-autonomy',
            title: 'Economy-Autonomie begrenzt arbeiten lassen',
            timeoutMs: 70000,
            run: async ({ runtime, assert, sleep, waitFor }) => {
              const started = runtime.economy.startAutonomy({ maxActions: 3 });
              assert(started && started.accepted === true, started && started.reason || 'H17_AUTONOMY_START_FAILED');

              await sleep(30000);
              runtime.economy.stopAutonomy('H17_LIVE_TEST_WINDOW_COMPLETE');

              await waitFor(() => {
                const status = runtime.economy.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H17_SUSPENDED_DURING_AUTONOMY');
                if (Number(status.metrics.actionsUnknown || 0) > baseline.actionsUnknown) throw new Error('H17_ACTION_UNKNOWN');
                if (childUnknownTotal(runtime) > baseline.childUnknown) throw new Error('H17_CHILD_UNKNOWN');
                return status.currentAction == null && !childBusy(runtime) ? status : null;
              }, { timeoutMs: 30000, pollMs: 200, label: 'h17-autonomy-settle' });

              const status = runtime.economy.status();
              const confirmed = Number(status.metrics.actionsConfirmed || 0) - baseline.actionsConfirmed;
              const queued = Number(status.metrics.actionsQueued || 0) - baseline.actionsQueued;
              const rejected = Number(status.metrics.actionsRejected || 0) - baseline.actionsRejected;
              assert(confirmed >= 1, 'H17_NO_CONFIRMED_ECONOMY_ACTION');
              assert(confirmed <= 3, 'H17_CONFIRMED_ACTION_BUDGET_EXCEEDED');
              assert(queued <= 3, 'H17_QUEUED_ACTION_BUDGET_EXCEEDED');
              assert(Number(status.metrics.actionsUnknown || 0) === baseline.actionsUnknown, 'H17_ACTION_UNKNOWN');
              assert(childUnknownTotal(runtime) === baseline.childUnknown, 'H17_CHILD_UNKNOWN');
              return {
                actionsQueued: queued,
                actionsConfirmed: confirmed,
                actionsRejected: rejected,
                actionsUnknown: Number(status.metrics.actionsUnknown || 0) - baseline.actionsUnknown,
                actionsThisSession: status.actionsThisSession,
                lastAction: status.lastAction || null
              };
            }
          },
          {
            id: 'stability',
            title: 'Zehn Sekunden ohne UNKNOWN oder neue Economy-Mutation beobachten',
            timeoutMs: 15000,
            run: async ({ runtime, assert, sleep }) => {
              const before = runtime.economy.status();
              const beforeQueued = Number(before.metrics.actionsQueued || 0);
              await sleep(10000);
              const after = runtime.economy.status();
              assert(after.autonomyEnabled === false, 'H17_AUTONOMY_RESTARTED');
              assert(after.currentAction == null, 'H17_ACTION_REMAINS_DURING_STABILITY');
              assert(after.suspended === false, after.suspendedReason || 'H17_SUSPENDED_DURING_STABILITY');
              assert(Number(after.metrics.actionsQueued || 0) === beforeQueued, 'H17_NEW_ACTION_AFTER_AUTONOMY_STOP');
              assert(Number(after.metrics.actionsUnknown || 0) === baseline.actionsUnknown, 'H17_ACTION_UNKNOWN_DURING_STABILITY');
              assert(childUnknownTotal(runtime) === baseline.childUnknown, 'H17_CHILD_UNKNOWN_DURING_STABILITY');
              assert(!childBusy(runtime), 'H17_CHILD_BUSY_DURING_STABILITY');
              return {
                actionsQueued: Number(after.metrics.actionsQueued || 0) - baseline.actionsQueued,
                actionsConfirmed: Number(after.metrics.actionsConfirmed || 0) - baseline.actionsConfirmed,
                actionsRejected: Number(after.metrics.actionsRejected || 0) - baseline.actionsRejected,
                actionsUnknown: Number(after.metrics.actionsUnknown || 0) - baseline.actionsUnknown,
                childUnknown: childUnknownTotal(runtime) - baseline.childUnknown
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Economy-Autonomie stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.economy.stopAutonomy('H17_LIVE_TEST_COMPLETE');
              const status = runtime.economy.status();
              assert(status.autonomyEnabled === false, 'H17_AUTONOMY_STILL_ENABLED');
              assert(status.currentAction == null, 'H17_CURRENT_ACTION_REMAINS');
              assert(!childBusy(runtime), 'H17_CHILD_BUSY_AFTER_TEST');
              return {
                autonomyEnabled: status.autonomyEnabled,
                currentAction: status.currentAction,
                actionsThisSession: status.actionsThisSession,
                suspended: status.suspended
              };
            }
          }
        ]
      });
    }


    _registerH18LiveTest() {
      let baseline = null;
      let previousPolicy = null;
      let liveTarget = null;
      let liveSupply = null;

      const distance = (a, b) => {
        if (!a || !b || !a.map || !b.map || String(a.map) !== String(b.map)) return null;
        const ax = Number(a.x), ay = Number(a.y), bx = Number(b.x), by = Number(b.y);
        if (![ax, ay, bx, by].every(Number.isFinite)) return null;
        return Math.hypot(ax - bx, ay - by);
      };

      this.liveTests.register({
        id: 'h18-party-logistics',
        title: 'H18 – Party Logistics',
        description: 'Begrenzter Live-Test für eigene Party, optionales Regrouping und einen bestätigten sicheren Supply-Transfer ohne UNKNOWN.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.partyLogistics.stopAutonomy('H18_LIVE_TEST_RESET'); } catch (_) {}
          const current = runtime.partyLogistics.status();
          if (current.currentAction) throw new Error('H18_ACTIVE_ACTION_BEFORE_LIVE_TEST');
          try { runtime.partyLogistics.cancelQueue('H18_LIVE_TEST_RESET'); } catch (_) {}
          try {
            if (!current.suspended) runtime.partyLogistics.resetSafety('H18_LIVE_TEST_RESET');
          } catch (_) {}
          previousPolicy = runtime.partyLogistics.policy();
          runtime.partyLogistics.policy({
            maxActionsPerSession: 2,
            transferRange: 320,
            regroupDistance: 100,
            regroupArrivalRadius: 80,
            outcomeTimeoutMs: 10000,
            movementTimeoutMs: 60000,
            allowRegroup: true
          });
          const status = runtime.partyLogistics.status();
          baseline = {
            suppliesDispatched: Number(status.metrics.suppliesDispatched || 0),
            suppliesConfirmed: Number(status.metrics.suppliesConfirmed || 0),
            suppliesRejected: Number(status.metrics.suppliesRejected || 0),
            suppliesUnknown: Number(status.metrics.suppliesUnknown || 0),
            regroupsConfirmed: Number(status.metrics.regroupsConfirmed || 0),
            regroupsUnknown: Number(status.metrics.regroupsUnknown || 0)
          };
          liveTarget = null;
          liveSupply = null;
        },
        cleanup: async ({ runtime }) => {
          try { runtime.partyLogistics.stopAutonomy('H18_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const current = runtime.partyLogistics.status();
            if (!current.currentAction) runtime.partyLogistics.cancelQueue('H18_LIVE_TEST_CLEANUP');
            if (!current.suspended && !current.currentAction) runtime.partyLogistics.resetSafety('H18_LIVE_TEST_CLEANUP');
          } catch (_) {}
          if (previousPolicy) {
            try { runtime.partyLogistics.policy(previousPolicy); } catch (_) {}
          }
        },
        steps: [
          {
            id: 'preflight',
            title: 'Eigene Party und sicheren Supply-Pfad prüfen',
            timeoutMs: 10000,
            run: async ({ runtime, assert, note }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip !== true, 'CHARACTER_DEAD');
              const module = runtime.modules.describe('party-logistics');
              assert(module && module.state === 'ACTIVE', 'H18_MODULE_NOT_ACTIVE');

              const party = runtime.party.snapshot();
              assert(party && party.coordinationEnabled === true, 'H18_NEEDS_OWNED_PARTY_WITHOUT_FOREIGN_MEMBERS');
              const candidates = (party.ownedMembers || [])
                .filter(member => !member.local && !member.rip && member.visible)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
              assert(candidates.length > 0, 'H18_NEEDS_VISIBLE_OWNED_PARTY_MEMBER');
              liveTarget = candidates[0];

              const catalog = runtime.partyLogistics.supplyCatalog();
              liveSupply = catalog.find(row => row.utility === true && Number(row.quantity || 0) >= 1)
                || catalog.find(row => Number(row.quantity || 0) >= 1)
                || null;
              assert(liveSupply, 'H18_NEEDS_SAFE_SUPPLY_ITEM');
              assert(runtime.actions.available('send_item'), 'H18_SEND_ITEM_UNAVAILABLE');

              const status = runtime.partyLogistics.status();
              assert(status.suspended === false, status.suspendedReason || 'H18_SUSPENDED');
              assert(status.currentAction == null, 'H18_ACTION_ACTIVE_BEFORE_PREFLIGHT');
              note({
                target: liveTarget,
                supply: liveSupply,
                partySize: party.size,
                local: game.character.name
              });
              return {
                target: liveTarget.name,
                supply: liveSupply,
                partySize: party.size,
                distance: distance(game.character, liveTarget)
              };
            }
          },
          {
            id: 'regroup',
            title: 'Party bei Bedarf kontrolliert regroupen',
            timeoutMs: 65000,
            run: async ({ runtime, assert, waitFor }) => {
              const game = runtime.game.snapshot();
              const party = runtime.party.snapshot();
              const target = (party.ownedMembers || []).find(member => liveTarget && member.name === liveTarget.name) || liveTarget;
              const beforeDistance = distance(game.character, target);
              if (beforeDistance != null && beforeDistance <= 100) {
                return { alreadyGrouped: true, beforeDistance, regroupsConfirmed: 0 };
              }

              const started = runtime.partyLogistics.startAutonomy({ maxActions: 1 });
              assert(started && started.accepted === true, started && started.reason || 'H18_REGROUP_START_FAILED');
              await waitFor(() => {
                const status = runtime.partyLogistics.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H18_SUSPENDED_DURING_REGROUP');
                if (Number(status.metrics.regroupsUnknown || 0) > baseline.regroupsUnknown) throw new Error('H18_REGROUP_UNKNOWN');
                return Number(status.metrics.regroupsConfirmed || 0) > baseline.regroupsConfirmed && status.currentAction == null
                  ? status
                  : null;
              }, { timeoutMs: 60000, pollMs: 200, label: 'h18-regroup' });
              runtime.partyLogistics.stopAutonomy('H18_REGROUP_COMPLETE');
              const after = runtime.partyLogistics.status();
              return {
                alreadyGrouped: false,
                beforeDistance,
                regroupsConfirmed: Number(after.metrics.regroupsConfirmed || 0) - baseline.regroupsConfirmed,
                regroupsUnknown: Number(after.metrics.regroupsUnknown || 0) - baseline.regroupsUnknown
              };
            }
          },
          {
            id: 'supply',
            title: 'Einen sicheren Supply-Transfer bestätigen',
            timeoutMs: 75000,
            run: async ({ runtime, assert, waitFor }) => {
              const queued = runtime.partyLogistics.queueSupply(liveTarget.name, liveSupply.name, 1);
              assert(queued && queued.accepted === true, queued && queued.reason || 'H18_SUPPLY_QUEUE_FAILED');
              const started = runtime.partyLogistics.startAutonomy({ maxActions: 1 });
              assert(started && started.accepted === true, started && started.reason || 'H18_SUPPLY_START_FAILED');

              await waitFor(() => {
                const status = runtime.partyLogistics.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H18_SUSPENDED_DURING_SUPPLY');
                if (Number(status.metrics.suppliesUnknown || 0) > baseline.suppliesUnknown) throw new Error('H18_SUPPLY_UNKNOWN');
                return Number(status.metrics.suppliesConfirmed || 0) > baseline.suppliesConfirmed
                  && status.currentAction == null
                  && status.queue.length === 0
                  ? status
                  : null;
              }, { timeoutMs: 70000, pollMs: 200, label: 'h18-supply' });

              runtime.partyLogistics.stopAutonomy('H18_SUPPLY_COMPLETE');
              const status = runtime.partyLogistics.status();
              const dispatched = Number(status.metrics.suppliesDispatched || 0) - baseline.suppliesDispatched;
              const confirmed = Number(status.metrics.suppliesConfirmed || 0) - baseline.suppliesConfirmed;
              const rejected = Number(status.metrics.suppliesRejected || 0) - baseline.suppliesRejected;
              const unknown = Number(status.metrics.suppliesUnknown || 0) - baseline.suppliesUnknown;
              assert(dispatched === 1, 'H18_SUPPLY_DISPATCH_COUNT_INVALID');
              assert(confirmed === 1, 'H18_SUPPLY_CONFIRM_COUNT_INVALID');
              assert(rejected === 0, 'H18_SUPPLY_REJECTED');
              assert(unknown === 0, 'H18_SUPPLY_UNKNOWN');
              return {
                target: liveTarget.name,
                itemName: liveSupply.name,
                dispatched,
                confirmed,
                rejected,
                unknown
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne Retry oder UNKNOWN beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              const before = runtime.partyLogistics.status();
              const beforeDispatch = Number(before.metrics.suppliesDispatched || 0);
              await sleep(5000);
              const after = runtime.partyLogistics.status();
              assert(after.autonomyEnabled === false, 'H18_AUTONOMY_RESTARTED');
              assert(after.currentAction == null, 'H18_ACTION_REMAINS');
              assert(after.suspended === false, after.suspendedReason || 'H18_SUSPENDED_DURING_STABILITY');
              assert(Number(after.metrics.suppliesDispatched || 0) === beforeDispatch, 'H18_SUPPLY_RETRY_AFTER_STOP');
              assert(Number(after.metrics.suppliesUnknown || 0) === baseline.suppliesUnknown, 'H18_SUPPLY_UNKNOWN_DURING_STABILITY');
              assert(Number(after.metrics.regroupsUnknown || 0) === baseline.regroupsUnknown, 'H18_REGROUP_UNKNOWN_DURING_STABILITY');
              return {
                suppliesConfirmed: Number(after.metrics.suppliesConfirmed || 0) - baseline.suppliesConfirmed,
                suppliesUnknown: Number(after.metrics.suppliesUnknown || 0) - baseline.suppliesUnknown,
                regroupsConfirmed: Number(after.metrics.regroupsConfirmed || 0) - baseline.regroupsConfirmed,
                regroupsUnknown: Number(after.metrics.regroupsUnknown || 0) - baseline.regroupsUnknown
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Party-Logistik stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.partyLogistics.stopAutonomy('H18_LIVE_TEST_COMPLETE');
              const status = runtime.partyLogistics.status();
              assert(status.autonomyEnabled === false, 'H18_AUTONOMY_STILL_ENABLED');
              assert(status.currentAction == null, 'H18_CURRENT_ACTION_REMAINS');
              assert(status.queue.length === 0, 'H18_QUEUE_REMAINS');
              assert(status.suspended === false, status.suspendedReason || 'H18_SUSPENDED_AT_CLEANUP');
              return {
                autonomyEnabled: status.autonomyEnabled,
                currentAction: status.currentAction,
                queueLength: status.queue.length,
                suspended: status.suspended
              };
            }
          }
        ]
      });
    }

    _registerH19LiveTest() {
      let baseline = null;

      this.liveTests.register({
        id: 'h19-character-lifecycle',
        title: 'H19 – Character Lifecycle & Recovery',
        description: 'Begrenzter erster H19-Live-Test für einen echten lokalen Death→Respawn-Recovery-Pfad mit bestätigter Live-Evidence und ohne Blind-Retry.',
        version: '1',
        recommended: true,
        autoStartRuntime: true,
        restoreRuntimeState: true,
        prepare: async ({ runtime }) => {
          try { runtime.lifecycle.stopAutonomy('H19_LIVE_TEST_RESET'); } catch (_) {}
          const current = runtime.lifecycle.status();
          if (current.currentAction) throw new Error('H19_ACTIVE_ACTION_BEFORE_LIVE_TEST');
          try { runtime.lifecycle.cancelQueued(); } catch (_) {}
          try {
            if (!current.currentAction) runtime.lifecycle.resetSafety('H19_LIVE_TEST_RESET');
          } catch (_) {}
          const status = runtime.lifecycle.status();
          baseline = {
            actionsDispatched: Number(status.metrics.actionsDispatched || 0),
            actionsConfirmed: Number(status.metrics.actionsConfirmed || 0),
            actionsRejected: Number(status.metrics.actionsRejected || 0),
            actionsUnknown: Number(status.metrics.actionsUnknown || 0),
            respawnsConfirmed: Number(status.metrics.respawnsConfirmed || 0),
            respawnCooldownRejects: Number(status.metrics.respawnCooldownRejects || 0)
          };
        },
        cleanup: async ({ runtime }) => {
          try { runtime.lifecycle.stopAutonomy('H19_LIVE_TEST_CLEANUP'); } catch (_) {}
          try {
            const current = runtime.lifecycle.status();
            if (!current.currentAction) runtime.lifecycle.cancelQueued();
            if (!current.suspended && !current.currentAction) runtime.lifecycle.resetSafety('H19_LIVE_TEST_CLEANUP');
          } catch (_) {}
        },
        steps: [
          {
            id: 'preflight',
            title: 'Toten lokalen Character und sicheren Respawn-Pfad prüfen',
            timeoutMs: 10000,
            run: async ({ runtime, assert, note }) => {
              const game = runtime.game.snapshot();
              assert(game && game.available && game.character, 'CHARACTER_UNAVAILABLE');
              assert(game.character.rip === true, 'H19_NEEDS_DEAD_LOCAL_CHARACTER');
              const module = runtime.modules.describe('character-lifecycle');
              assert(module && module.state === 'ACTIVE', 'H19_MODULE_NOT_ACTIVE');
              const roster = runtime.roster.refresh();
              assert(roster && roster.accountStateAvailable === true, 'H19_ACCOUNT_ROSTER_UNAVAILABLE');
              assert(roster.activeStateAvailable === true, 'H19_ACTIVE_ROSTER_UNAVAILABLE');
              assert(runtime.actions.available('respawn'), 'H19_RESPAWN_API_UNAVAILABLE');
              const status = runtime.lifecycle.status();
              assert(status.suspended === false, status.suspendedReason || 'H19_SUSPENDED');
              assert(status.currentAction == null, 'H19_ACTION_ACTIVE_BEFORE_PREFLIGHT');
              note({
                local: game.character.name,
                ctype: game.character.ctype,
                desiredActiveNames: status.policy.desiredActiveNames,
                respawnReadyAtMs: status.respawn && status.respawn.readyAtMs,
                respawnWaitMs: status.respawn && status.respawn.waitMs
              });
              return {
                local: game.character.name,
                ctype: game.character.ctype,
                rip: game.character.rip,
                activeCharacterNames: roster.activeCharacterNames,
                respawnReadyAtMs: status.respawn && status.respawn.readyAtMs,
                respawnWaitMs: status.respawn && status.respawn.waitMs
              };
            }
          },
          {
            id: 'death-recovery',
            title: 'Respawn-Cooldown abwarten und genau einen echten Respawn bestätigen',
            timeoutMs: 40000,
            run: async ({ runtime, assert, waitFor }) => {
              const queued = runtime.lifecycle.queueRespawn();
              assert(queued && queued.accepted === true, queued && queued.reason || 'H19_RESPAWN_QUEUE_FAILED');
              const started = runtime.lifecycle.startAutonomy({ maxActions: 1 });
              assert(started && started.accepted === true, started && started.reason || 'H19_RESPAWN_AUTONOMY_START_FAILED');

              await waitFor(() => {
                const status = runtime.lifecycle.status();
                if (status.suspended) throw new Error(status.suspendedReason || 'H19_SUSPENDED_DURING_RESPAWN');
                if (Number(status.metrics.actionsUnknown || 0) > baseline.actionsUnknown) throw new Error('H19_ACTION_UNKNOWN');
                if (Number(status.metrics.respawnCooldownRejects || 0) > baseline.respawnCooldownRejects) throw new Error('H19_RESPAWN_COOLDOWN_REJECTED');
                if (Number(status.metrics.actionsRejected || 0) > baseline.actionsRejected) throw new Error('H19_RESPAWN_REJECTED');
                return Number(status.metrics.respawnsConfirmed || 0) > baseline.respawnsConfirmed
                  && status.currentAction == null
                  ? status
                  : null;
              }, { timeoutMs: 35000, pollMs: 200, label: 'h19-respawn' });

              runtime.lifecycle.stopAutonomy('H19_RESPAWN_COMPLETE');
              const game = runtime.game.snapshot();
              const status = runtime.lifecycle.status();
              const dispatched = Number(status.metrics.actionsDispatched || 0) - baseline.actionsDispatched;
              const confirmed = Number(status.metrics.actionsConfirmed || 0) - baseline.actionsConfirmed;
              const unknown = Number(status.metrics.actionsUnknown || 0) - baseline.actionsUnknown;
              const respawns = Number(status.metrics.respawnsConfirmed || 0) - baseline.respawnsConfirmed;
              assert(game && game.character && game.character.rip !== true, 'H19_CHARACTER_STILL_DEAD');
              assert(dispatched === 1, 'H19_RESPAWN_DISPATCH_COUNT_INVALID');
              assert(confirmed === 1, 'H19_RESPAWN_CONFIRM_COUNT_INVALID');
              assert(respawns === 1, 'H19_RESPAWN_CONFIRMATION_MISSING');
              assert(unknown === 0, 'H19_RESPAWN_UNKNOWN');
              return {
                local: game.character.name,
                dispatched,
                confirmed,
                respawnsConfirmed: respawns,
                unknown
              };
            }
          },
          {
            id: 'stability',
            title: 'Fünf Sekunden ohne Respawn-Retry oder UNKNOWN beobachten',
            timeoutMs: 10000,
            run: async ({ runtime, assert, sleep }) => {
              const before = runtime.lifecycle.status();
              const beforeDispatch = Number(before.metrics.actionsDispatched || 0);
              await sleep(5000);
              const after = runtime.lifecycle.status();
              assert(after.autonomyEnabled === false, 'H19_AUTONOMY_RESTARTED');
              assert(after.currentAction == null, 'H19_ACTION_REMAINS');
              assert(after.suspended === false, after.suspendedReason || 'H19_SUSPENDED_DURING_STABILITY');
              assert(Number(after.metrics.actionsDispatched || 0) === beforeDispatch, 'H19_RESPAWN_RETRY_AFTER_STOP');
              assert(Number(after.metrics.actionsUnknown || 0) === baseline.actionsUnknown, 'H19_UNKNOWN_DURING_STABILITY');
              return {
                actionsDispatched: Number(after.metrics.actionsDispatched || 0) - baseline.actionsDispatched,
                actionsConfirmed: Number(after.metrics.actionsConfirmed || 0) - baseline.actionsConfirmed,
                actionsUnknown: Number(after.metrics.actionsUnknown || 0) - baseline.actionsUnknown
              };
            }
          },
          {
            id: 'cleanup',
            title: 'Lifecycle-Autonomie stoppen und Ownership freigeben',
            timeoutMs: 5000,
            run: async ({ runtime, assert }) => {
              runtime.lifecycle.stopAutonomy('H19_LIVE_TEST_COMPLETE');
              const status = runtime.lifecycle.status();
              assert(status.autonomyEnabled === false, 'H19_AUTONOMY_STILL_ENABLED');
              assert(status.currentAction == null, 'H19_CURRENT_ACTION_REMAINS');
              assert(status.queue.length === 0, 'H19_QUEUE_REMAINS');
              assert(status.suspended === false, status.suspendedReason || 'H19_SUSPENDED_AT_CLEANUP');
              return {
                autonomyEnabled: status.autonomyEnabled,
                currentAction: status.currentAction,
                queueLength: status.queue.length,
                suspended: status.suspended
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
        merchant: this.merchant.status(),
        bank: this.bank.status(),
        trade: this.trade.status(),
        gear: this.gear.status(),
        upgrade: this.upgrade.status(),
        exchangeCraft: this.exchangeCraft.status(),
        economy: this.economy.status(),
        partyLogistics: this.partyLogistics.status(),
        lifecycle: this.lifecycle.status(),
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
        merchant: this.merchant.status(),
        bank: this.bank.status(),
        trade: this.trade.status(),
        gear: this.gear.status(),
        upgrade: this.upgrade.status(),
        exchangeCraft: this.exchangeCraft.status(),
        economy: this.economy.status(),
        partyLogistics: this.partyLogistics.status(),
        lifecycle: this.lifecycle.status(),
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
      push('merchant-controller', !!this.merchant.status() && typeof this.merchant.plan === 'function', this.merchant.status());
      push('bank-controller', !!this.bank.status() && typeof this.bank.plan === 'function' && typeof this.bank.reconcile === 'function', this.bank.status());
      push('trade-controller', !!this.trade.status() && typeof this.trade.marketAnalysis === 'function' && typeof this.trade.queueAcquire === 'function', this.trade.status());
      push('gear-controller', !!this.gear.status() && typeof this.gear.plan === 'function' && typeof this.gear.queueBestLocal === 'function', this.gear.status());
      push('upgrade-compound-controller', !!this.upgrade.status() && typeof this.upgrade.plan === 'function' && typeof this.upgrade.queueBest === 'function', this.upgrade.status());
      push('exchange-craft-controller', !!this.exchangeCraft.status() && typeof this.exchangeCraft.plan === 'function' && typeof this.exchangeCraft.productionPlan === 'function', this.exchangeCraft.status());
      push('economy-controller', !!this.economy.status() && typeof this.economy.plan === 'function' && typeof this.economy.startAutonomy === 'function', this.economy.status());
      push('party-logistics-controller', !!this.partyLogistics.status() && typeof this.partyLogistics.plan === 'function' && typeof this.partyLogistics.queueSupply === 'function', this.partyLogistics.status());
      push('character-lifecycle-controller', !!this.lifecycle.status() && typeof this.lifecycle.plan === 'function' && typeof this.lifecycle.queueStart === 'function' && typeof this.lifecycle.queueRespawn === 'function', this.lifecycle.status());
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
