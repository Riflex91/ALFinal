(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.ALBotRuntime) throw new Error('ALBOT_RUNTIME_MISSING');
  const cleanText = ns.helpers && ns.helpers.cleanText ? ns.helpers.cleanText : (value => String(value == null ? '' : value));

  function resolveSharedHost(start) {
    let current = start;
    let best = start;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      let parentWindow = null;
      try {
        parentWindow = current.parent && current.parent !== current ? current.parent : null;
        if (parentWindow) void parentWindow.document;
      } catch (_) {
        parentWindow = null;
      }
      if (!parentWindow) break;
      best = parentWindow;
      current = parentWindow;
    }
    return best || start;
  }

  const sharedHost = resolveSharedHost(root);

  // Every Adventure Land character runner can share the same top-level page.
  // Hot-reload ownership must therefore be runner-local: otherwise the next
  // character to load mistakes another character's runtime for its predecessor
  // and tears it down. Keep per-runner state on the shared host via a WeakMap.
  // The legacy singleton remains a discovery/compatibility pointer only.
  let sharedRegistry = null;
  let sharedState = null;
  try {
    const existingRegistry = sharedHost.__ALBOT_SHARED_RUNTIME_REGISTRY__;
    if (existingRegistry
        && typeof existingRegistry.get === 'function'
        && typeof existingRegistry.set === 'function') {
      sharedRegistry = existingRegistry;
    } else {
      sharedRegistry = new WeakMap();
      sharedHost.__ALBOT_SHARED_RUNTIME_REGISTRY__ = sharedRegistry;
    }

    sharedState = sharedRegistry.get(root) || null;
    if (!sharedState) {
      const legacy = sharedHost.__ALBOT_SHARED_RUNTIME__;
      if (legacy
          && typeof legacy === 'object'
          && legacy.runnerRoot === root) {
        sharedState = legacy;
      }
    }
  } catch (_) {
    sharedRegistry = null;
    sharedState = null;
  }

  const localPrevious = root.ALBot && root.ALBot.__runtime || null;
  const previous = localPrevious || sharedState && sharedState.runtime || null;
  const previousBootCount = Number(sharedState && sharedState.bootCount)
    || Number(previous && previous.bootCount)
    || Number(root.__ALBOT_BOOT_COUNT__)
    || 0;

  if (previous) {
    try {
      if (typeof previous.prepareHotReload === 'function') previous.prepareHotReload('BUNDLE_RELOAD');
      else if (typeof previous.destroy === 'function') previous.destroy();
    } catch (_) {}
  }

  const bootCount = previousBootCount + 1;
  root.__ALBOT_BOOT_COUNT__ = bootCount;

  const runtime = new ns.ALBotRuntime({
    root,
    version: '0.26.53-h26',
    bootCount,
    replacedPrevious: !!previous
  });

  const bridge = ns.WindowsBridgeTransportAdapter
    ? new ns.WindowsBridgeTransportAdapter({
        runtime,
        root,
        logger: runtime.logger,
        bus: runtime.bus
      })
    : null;
  runtime.bridge = bridge;

  if (root.document && root.document.body && ns.ControlCenter) {
    const ui = new ns.ControlCenter(runtime);
    runtime.ui = ui;
    ui.mount();
  }

  const api = {
    product: 'AL Bot',
    version: runtime.version,
    __runtime: runtime,

    start: () => runtime.start(),
    stop: reason => runtime.stop(reason || 'API_STOP'),
    emergencyStop: reason => runtime.emergencyStop(reason || 'API_EMERGENCY_STOP'),
    resetEmergencyStop: () => runtime.resetEmergencyStop(),
    status: () => runtime.status(),
    selfTest: () => runtime.selfTest(),
    diagnostics: () => runtime.diagnostics(),
    performance_trick: () => runtime.performanceTrick(),

    bridge: bridge ? {
      identity: () => bridge.identity(),
      status: () => bridge.status(),
      snapshot: options => bridge.snapshot(options || {}),
      events: (afterSeq, limit) => bridge.events(afterSeq, limit),
      peekTelemetry: limit => bridge.peekTelemetry(limit),
      acknowledgeTelemetry: maxSeq => bridge.ackThrough(maxSeq)
    } : null,

    scheduler: {
      status: () => runtime.scheduler.status(),
      owner: owner => runtime.scheduler.ownerStatus(owner)
    },

    modules: {
      register: definition => runtime.modules.register(definition),
      list: () => runtime.modules.list(),
      start: id => runtime.startModule(id),
      stop: (id, reason) => runtime.stopModule(id, reason || 'API_MODULE_STOP'),
      restart: (id, reason) => runtime.restartModule(id, reason || 'API_MODULE_RESTART'),
      unregister: id => runtime.modules.unregister(id, 'API_UNREGISTER')
    },

    goals: {
      add: goal => runtime.goals.add(goal),
      list: () => runtime.goals.list(),
      pause: id => runtime.goals.setStatus(id, 'PAUSED'),
      resume: id => runtime.goals.setStatus(id, 'ACTIVE'),
      cancel: id => runtime.goals.setStatus(id, 'CANCELLED'),
      remove: id => runtime.goals.remove(id),
      setProgress: (id, value) => runtime.goals.setProgress(id, value),
      priorities: () => runtime.goals.getPriorities(),
      setPriority: (name, value) => runtime.goals.setPriority(name, value)
    },

    game: {
      snapshot: () => runtime.game.snapshot(),
      status: () => runtime.game.status(),
      visibleMonsters: options => runtime.game.visibleMonsters(options || {}),
      visiblePlayers: options => runtime.game.visiblePlayers(options || {}),
      monsterDefinition: mtype => runtime.game.monsterDefinition(mtype),
      itemDefinition: name => runtime.game.itemDefinition(name),
      craftDefinition: name => runtime.game.craftDefinition(name),
      craftCatalog: () => runtime.game.craftCatalog(),
      equipmentDefinition: name => runtime.game.equipmentDefinition(name),
      equipment: name => runtime.game.equipmentSnapshot(name),
      classEquipmentProfile: ctype => runtime.game.classEquipmentProfile(ctype),
      farmSpots: options => runtime.game.farmSpotCatalog(options || {}),
      inventory: () => runtime.game.inventorySnapshot(),
      bank: () => runtime.game.bankSnapshot(),
      market: options => runtime.game.marketSnapshot(options || {}),
      npcLocation: npcId => runtime.game.npcLocation(npcId),
      npcSources: itemName => runtime.game.npcShopSources(itemName),
      chests: () => runtime.game.chestSnapshot()
    },

    movement: {
      status: () => runtime.movement.status(),
      local: (x, y, options) => runtime.movement.moveLocal(x, y, options || {}),
      smart: (destination, options) => runtime.movement.smartMove(destination, options || {}),
      approachTarget: options => runtime.movement.approachCurrentTarget(options || {}),
      retarget: (destination, options) => runtime.movement.retarget(destination, options || {}),
      cancel: reason => runtime.movement.cancel(reason || 'API_MOVEMENT_CANCEL'),
      captureSafePoint: source => runtime.movement.captureSafePoint(source || 'API'),
      safeReturn: options => runtime.movement.safeReturn(options || {})
    },

    combat: {
      status: () => runtime.combat.status(),
      start: options => runtime.combat.startSession(options || {}),
      stop: reason => runtime.combat.stopSession(reason || 'API_COMBAT_STOP'),
      candidates: options => runtime.combat.safeCandidates(options || {})
    },

    classSkills: {
      status: () => runtime.classSkills.status(),
      supported: ctype => runtime.classSkills.supportedSkills(ctype),
      live: ctype => runtime.classSkills.liveSkillSummary(ctype),
      catalog: ctype => runtime.classSkills.skillCatalog(ctype),
      enabled: (skillId, ctype) => runtime.classSkills.isSkillEnabled(skillId, ctype),
      setEnabled: (skillId, enabled, ctype) => runtime.classSkills.setSkillEnabled(skillId, enabled, ctype),
      preview: targetId => runtime.classSkills.preview(targetId)
    },

    resourceTopoff: {
      status: () => runtime.resourceTopoff.status(),
      supply: () => runtime.resourceTopoff.supply(),
      tick: () => runtime.resourceTopoff.tick(),
      reset: reason => runtime.resourceTopoff.resetSafety(reason || 'API_RESOURCE_TOPOFF_RESET')
    },

    party: {
      status: () => runtime.party.status(),
      snapshot: () => runtime.party.snapshot(),
      focusTarget: () => runtime.party.preferredTargetId()
    },

    partyLogistics: {
      status: () => runtime.partyLogistics.status(),
      plan: () => runtime.partyLogistics.plan(),
      tick: () => runtime.partyLogistics.tick(),
      policy: value => runtime.partyLogistics.policy(value),
      catalog: () => runtime.partyLogistics.supplyCatalog(),
      supply: (targetName, itemName, quantity) => runtime.partyLogistics.queueSupply(targetName, itemName, quantity),
      gold: (targetName, amount) => runtime.partyLogistics.queueGold(targetName, amount),
      cancel: reason => runtime.partyLogistics.cancelQueue(reason || 'API_H18_QUEUE_CANCEL'),
      start: options => runtime.partyLogistics.startAutonomy(options || {}),
      stop: reason => runtime.partyLogistics.stopAutonomy(reason || 'API_H18_AUTONOMY_STOP'),
      reset: reason => runtime.partyLogistics.resetSafety(reason || 'API_H18_RESET')
    },

    lifecycle: {
      status: () => runtime.lifecycle.status(),
      plan: () => runtime.lifecycle.plan(),
      tick: () => runtime.lifecycle.tick(),
      policy: value => runtime.lifecycle.setPolicy(value || {}),
      captureActive: () => runtime.lifecycle.captureDesiredActive(),
      startCharacter: name => runtime.lifecycle.queueStart(name),
      stopCharacter: name => runtime.lifecycle.queueStop(name),
      respawn: () => runtime.lifecycle.queueRespawn(),
      cancel: requestId => runtime.lifecycle.cancelQueued(requestId),
      acknowledgeUnknown: reason => runtime.lifecycle.acknowledgeUnknown(reason || 'API_H19_UNKNOWN_ACK'),
      start: options => runtime.lifecycle.startAutonomy(options || {}),
      stop: reason => runtime.lifecycle.stopAutonomy(reason || 'API_H19_AUTONOMY_STOP'),
      reset: reason => runtime.lifecycle.resetSafety(reason || 'API_H19_RESET')
    },

    accountStrategy: {
      status: () => runtime.accountStrategy.status(),
      profiles: () => runtime.accountStrategy.profiles(),
      progression: () => runtime.accountStrategy.progressionPlan(),
      optimize: task => runtime.accountStrategy.optimizeTask(task || {})
    },

    encounters: {
      status: () => runtime.encounters.status(),
      catalog: () => runtime.encounters.catalog(),
      plan: options => runtime.encounters.plan(options || {}),
      preferredTask: () => runtime.encounters.preferredTask(),
      setEnabled: (kind, id, enabled) => runtime.encounters.setEnabled(kind, id, enabled),
      setAll: (kind, enabled) => runtime.encounters.setAll(kind, enabled),
      start: options => runtime.encounters.startAutonomy(options || {}),
      stop: reason => runtime.encounters.stopAutonomy(reason || 'API_ENCOUNTER_STOP'),
      tick: () => runtime.encounters.tick(),
      reset: reason => runtime.encounters.resetSafety(reason || 'API_ENCOUNTER_RESET')
    },

    marketIntelligence: {
      status: () => runtime.marketIntelligence.status(),
      refresh: () => runtime.marketIntelligence.refresh(),
      item: (itemName, options) => runtime.marketIntelligence.item(itemName, options || {}),
      priceBand: (itemName, options) => runtime.marketIntelligence.priceBand(itemName, options || {}),
      overview: limit => runtime.marketIntelligence.overview(limit)
    },

    merchantStand: {
      status: () => runtime.merchantStand.status(),
      plan: () => runtime.merchantStand.plan(),
      tick: () => runtime.merchantStand.tick(),
      configure: options => runtime.merchantStand.configure(options || {}),
      reset: reason => runtime.merchantStand.resetSafety(reason || 'API_MERCHANT_STAND_RESET')
    },

    telemetry: {
      status: () => runtime.telemetry.status(),
      configure: options => runtime.telemetry.configure(options || {}),
      sample: () => runtime.telemetry.sample(),
      flush: () => runtime.telemetry.flush()
    },

    fullAutonomy: {
      status: () => runtime.fullAutonomy.status(),
      configure: options => runtime.fullAutonomy.configure(options || {}),
      start: async options => {
        if (!runtime.running) await runtime.start();
        return runtime.fullAutonomy.startAutonomy(options || {});
      },
      stop: reason => runtime.fullAutonomy.stopAutonomy(reason || 'API_FULL_AUTONOMY_STOP'),
      tick: () => runtime.fullAutonomy.tick()
    },

    updater: {
      status: () => runtime.safeUpdater.status(),
      configure: options => runtime.safeUpdater.configure(options || {}),
      check: () => runtime.safeUpdater.checkAndDownload(),
      tick: () => runtime.safeUpdater.cycle(),
      apply: () => runtime.safeUpdater.applyPending(),
      discard: reason => runtime.safeUpdater.discardPending(reason || 'API_UPDATE_DISCARD')
    },

    observation: {
      status: () => runtime.observer.status(),
      assessment: () => runtime.observer.status().assessment,
      beacon: () => runtime.observer.hostBeacon(),
      tick: () => runtime.observer.tick(),
      events: limit => runtime.observer.listEvents(limit),
      incidents: limit => runtime.observer.listIncidents(limit)
    },

    recovery: {
      status: () => runtime.knownRecovery.status(),
      configure: options => runtime.knownRecovery.configure(options || {}),
      plan: assessment => runtime.knownRecovery.plan(assessment || null),
      tick: assessment => runtime.knownRecovery.tick(assessment || null)
    },

    // Backwards-compatible alias for the first H22 branch iterations.
    updates: {
      status: () => runtime.safeUpdater.status(),
      configure: options => runtime.safeUpdater.configure(options || {}),
      check: () => runtime.safeUpdater.checkAndDownload(),
      apply: () => runtime.safeUpdater.applyPending(),
      cycle: () => runtime.safeUpdater.cycle(),
      discard: reason => runtime.safeUpdater.discardPending(reason || 'API_UPDATE_DISCARD')
    },

    farming: {
      status: () => runtime.farming.status(),
      start: options => runtime.farming.startSession(options || {}),
      stop: reason => runtime.farming.stopSession(reason || 'API_H8_STOP'),
      plan: () => runtime.farming.plan(),
      supportedAoeSkills: ctype => runtime.farming.supportedAoeSkills(ctype),
      liveAoeSkills: ctype => runtime.farming.liveAoeSkills(ctype)
    },

    farmIntelligence: {
      status: () => runtime.farmIntelligence.status(),
      start: options => runtime.farmIntelligence.startAutonomy(options || {}),
      stop: reason => runtime.farmIntelligence.stopAutonomy(reason || 'API_H9_STOP'),
      plan: () => runtime.farmIntelligence.plan(),
      tick: () => runtime.farmIntelligence.tick()
    },

    inventory: {
      status: () => runtime.inventory.status(),
      plan: () => runtime.inventory.plan(),
      tick: () => runtime.inventory.tick(),
      reset: reason => runtime.inventory.resetSafety(reason || 'API_H10_RESET'),
      rules: rules => rules == null ? runtime.inventory.ruleSnapshot() : runtime.inventory.setRules(rules)
    },

    merchant: {
      status: () => runtime.merchant.status(),
      plan: () => runtime.merchant.plan(),
      tick: () => runtime.merchant.tick(),
      reset: reason => runtime.merchant.resetSafety(reason || 'API_H11_RESET'),
      deliver: (targetName, itemName, quantity) => runtime.merchant.queueDelivery(targetName, itemName, quantity),
      cancelDelivery: reason => runtime.merchant.cancelDelivery(reason || 'API_H11_DELIVERY_CANCEL')
    },

    bank: {
      status: () => runtime.bank.status(),
      plan: () => runtime.bank.plan(),
      tick: () => runtime.bank.tick(),
      search: itemName => runtime.bank.search(itemName),
      reconcile: () => runtime.bank.reconcile(),
      reset: reason => runtime.bank.resetSafety(reason || 'API_H12_RESET'),
      cancel: reason => runtime.bank.cancelRequest(reason || 'API_H12_REQUEST_CANCEL'),
      reservations: value => value == null ? { ...runtime.bank.reservations } : runtime.bank.setReservations(value),
      workspace: value => value == null ? { ...runtime.bank.workspace } : runtime.bank.setWorkspace(value),
      deposit: (itemName, options) => runtime.bank.queueDeposit(itemName, options || {}),
      withdraw: (packName, bankSlot, options) => runtime.bank.queueWithdraw(packName, bankSlot, options || {}),
      depositGold: amount => runtime.bank.queueGoldDeposit(amount),
      withdrawGold: amount => runtime.bank.queueGoldWithdraw(amount)
    },

    trade: {
      status: () => runtime.trade.status(),
      plan: () => runtime.trade.plan(),
      tick: () => runtime.trade.tick(),
      reset: reason => runtime.trade.resetSafety(reason || 'API_H13_RESET'),
      cancel: reason => runtime.trade.cancelRequest(reason || 'API_H13_REQUEST_CANCEL'),
      market: (itemName, options) => runtime.trade.marketAnalysis(itemName, options || {}),
      acquire: (itemName, quantity, options) => runtime.trade.queueAcquire(itemName, quantity, options || {}),
      buyNpc: (itemName, quantity, options) => runtime.trade.queueNpcBuy(itemName, quantity, options || {}),
      sellNpc: (slot, quantity, options) => runtime.trade.queueNpcSell(slot, quantity, options || {}),
      buyMarket: (playerName, tradeSlot, quantity, options) => runtime.trade.queueMarketBuy(playerName, tradeSlot, quantity, options || {}),
      sellMarket: (playerName, tradeSlot, quantity, options) => runtime.trade.queueMarketSell(playerName, tradeSlot, quantity, options || {})
    },

    gear: {
      status: () => runtime.gear.status(),
      plan: () => runtime.gear.plan(),
      tick: () => runtime.gear.tick(),
      reset: reason => runtime.gear.resetSafety(reason || 'API_H14_RESET'),
      cancel: reason => runtime.gear.cancelRequest(reason || 'API_H14_REQUEST_CANCEL'),
      goals: value => value == null ? runtime.gear.goalSnapshot() : runtime.gear.setGoals(value),
      score: (item, ctype) => runtime.gear.score(item, ctype),
      equipBest: slot => runtime.gear.queueBestLocal(slot),
      equip: (inventorySlot, targetSlot) => runtime.gear.queueEquip(inventorySlot, targetSlot),
      unequip: targetSlot => runtime.gear.queueUnequip(targetSlot),
      deliver: (targetName, inventorySlot) => runtime.gear.queueDelivery(targetName, inventorySlot)
    },

    gearProgression: {
      status: () => runtime.gearProgression.status(),
      plan: () => runtime.gearProgression.evaluateInventory(),
      evaluation: slot => runtime.gearProgression.evaluationFor(slot),
      futureProtection: (character, slot, itemName, level) =>
        runtime.gearProgression.futureProtectionFor(character, slot, itemName, level),
      futureSellSafety: (character, slot, itemName, level) =>
        runtime.gearProgression.futureSellSafetyFor(character, slot, itemName, level)
    },

    upgrade: {
      status: () => runtime.upgrade.status(),
      plan: () => runtime.upgrade.plan(),
      tick: () => runtime.upgrade.tick(),
      reset: reason => runtime.upgrade.resetSafety(reason || 'API_H15_RESET'),
      cancel: reason => runtime.upgrade.cancelRequest(reason || 'API_H15_REQUEST_CANCEL'),
      policy: value => runtime.upgrade.policy(value),
      best: kind => runtime.upgrade.queueBest(kind),
      item: (inventorySlot, options) => runtime.upgrade.queueUpgrade(inventorySlot, options || {}),
      compound: (inventorySlots, options) => runtime.upgrade.queueCompound(inventorySlots, options || {})
    },

    exchangeCraft: {
      status: () => runtime.exchangeCraft.status(),
      plan: () => runtime.exchangeCraft.plan(),
      tick: () => runtime.exchangeCraft.tick(),
      reset: reason => runtime.exchangeCraft.resetSafety(reason || 'API_H16_RESET'),
      cancel: reason => runtime.exchangeCraft.cancelRequest(reason || 'API_H16_REQUEST_CANCEL'),
      policy: value => runtime.exchangeCraft.policy(value),
      exchanges: options => runtime.exchangeCraft.exchangeCandidates(options || {}),
      crafts: options => runtime.exchangeCraft.craftCandidates(options || {}),
      production: (itemName, quantity, options) => runtime.exchangeCraft.productionPlan(itemName, quantity, options || {}),
      best: kind => runtime.exchangeCraft.queueBest(kind),
      exchange: (inventorySlot, options) => runtime.exchangeCraft.queueExchange(inventorySlot, options || {}),
      craft: (itemName, options) => runtime.exchangeCraft.queueCraft(itemName, options || {}),
      acquire: (itemName, quantity, options) => runtime.exchangeCraft.queueMaterialAcquire(itemName, quantity, options || {})
    },

    economy: {
      status: () => runtime.economy.status(),
      plan: () => runtime.economy.plan(),
      tick: () => runtime.economy.tick(),
      policy: value => runtime.economy.policy(value),
      start: options => runtime.economy.startAutonomy(options || {}),
      stop: reason => runtime.economy.stopAutonomy(reason || 'API_H17_AUTONOMY_STOP'),
      reset: reason => runtime.economy.resetSafety(reason || 'API_H17_RESET'),
      queueSelected: () => runtime.economy.queueSelected()
    },

    liveTests: {
      status: () => runtime.liveTests.status(),
      list: () => runtime.liveTests.list(),
      start: id => runtime.liveTests.start(id),
      startRecommended: () => runtime.liveTests.startRecommended(),
      cancel: reason => runtime.liveTests.cancel(reason || 'API_LIVE_TEST_CANCEL')
    },

    knowledge: {
      setProvider: provider => runtime.knowledge.setProvider(provider),
      refresh: () => runtime.knowledge.refresh(),
      status: () => runtime.knowledge.status(),
      snapshot: () => runtime.knowledge.snapshot(),
      fact: id => runtime.knowledge.fact(id)
    },

    roster: {
      refresh: () => runtime.roster.refresh(),
      status: () => runtime.roster.status(),
      farmers: () => runtime.roster.status().farmers,
      merchant: () => runtime.roster.status().merchant
    },

    actions: {
      canAct: action => runtime.actionAllowed(action),
      assertAllowed: action => runtime.assertActionAllowed(action)
    },

    dev: {
      stabilityProbe: () => runtime.runStabilityProbe(),
      knowledgeRefresh: () => runtime.knowledge.refresh()
    },

    ui: {
      show: () => runtime.ui && runtime.ui.show(),
      hide: () => runtime.ui && runtime.ui.hide(),
      render: () => runtime.ui && runtime.ui.render()
    }
  };

  if (api.bridge) Object.freeze(api.bridge);
  Object.freeze(api.scheduler);
  Object.freeze(api.modules);
  Object.freeze(api.game);
  Object.freeze(api.movement);
  Object.freeze(api.combat);
  Object.freeze(api.classSkills);
  Object.freeze(api.resourceTopoff);
  Object.freeze(api.party);
  Object.freeze(api.partyLogistics);
  Object.freeze(api.lifecycle);
  Object.freeze(api.accountStrategy);
  Object.freeze(api.encounters);
  Object.freeze(api.marketIntelligence);
  Object.freeze(api.merchantStand);
  Object.freeze(api.telemetry);
  Object.freeze(api.fullAutonomy);
  Object.freeze(api.updater);
  Object.freeze(api.observation);
  Object.freeze(api.recovery);
  Object.freeze(api.updates);
  Object.freeze(api.farming);
  Object.freeze(api.farmIntelligence);
  Object.freeze(api.inventory);
  Object.freeze(api.merchant);
  Object.freeze(api.bank);
  Object.freeze(api.trade);
  Object.freeze(api.gear);
  Object.freeze(api.gearProgression);
  Object.freeze(api.upgrade);
  Object.freeze(api.exchangeCraft);
  Object.freeze(api.economy);
  Object.freeze(api.liveTests);
  Object.freeze(api.knowledge);
  Object.freeze(api.roster);
  Object.freeze(api.actions);
  Object.freeze(api.dev);
  Object.freeze(api.ui);

  root.ALBot = api;
  try {
    const runnerState = {
      runtime,
      bootCount,
      runnerRoot: root,
      loadedAt: runtime.loadedAt
    };
    if (sharedRegistry && typeof sharedRegistry.set === 'function') {
      sharedRegistry.set(root, runnerState);
    }
    // Compatibility/discovery pointer: it may identify the most recently loaded
    // runner, but must never grant hot-reload ownership over another runner.
    sharedHost.__ALBOT_SHARED_RUNTIME__ = runnerState;
  } catch (_) {}

  runtime.logger.info('AL Bot H23 geladen', {
    version: api.version,
    bootCount,
    hotReload: !!previous,
    sharedHost: sharedHost !== root
  });

  const autoStartLive = (() => {
    if (root && root.__ALBOT_DISABLE_AUTOSTART__ === true) return false;
    if (root && root.__ALBOT_FORCE_AUTOSTART__ === true) return true;
    const hosts = [];
    try { hosts.push(String(root && root.location && root.location.hostname || '').toLowerCase()); } catch (_) {}
    try { hosts.push(String(root && root.parent && root.parent.location && root.parent.location.hostname || '').toLowerCase()); } catch (_) {}
    return hosts.some(host => host === 'adventure.land' || host.endsWith('.adventure.land'));
  })();

  if (autoStartLive) {
    Promise.resolve().then(async () => {
      if (!runtime.running) await runtime.start();
      const started = runtime.fullAutonomy.startAutonomy({ taskType: 'FARM', waitForRoster: true });
      runtime.logger.info('Full Autonomy Autostart verarbeitet', {
        accepted: !!(started && started.accepted === true),
        reason: started && started.reason || null,
        state: started && started.tick && started.tick.state || null
      });
    }).catch(error => {
      runtime.logger.error('Full Autonomy Autostart fehlgeschlagen', {
        reason: cleanText(error && error.message || error, 300)
      });
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
