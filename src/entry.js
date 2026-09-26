(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.ALBotRuntime) throw new Error('ALBOT_RUNTIME_MISSING');

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
  let sharedState = null;
  try {
    sharedState = sharedHost.__ALBOT_SHARED_RUNTIME__ && typeof sharedHost.__ALBOT_SHARED_RUNTIME__ === 'object'
      ? sharedHost.__ALBOT_SHARED_RUNTIME__
      : null;
  } catch (_) {}

  const localPrevious = root.ALBot && root.ALBot.__runtime || null;
  const previous = localPrevious || sharedState && sharedState.runtime || null;
  const previousBootCount = Number(sharedState && sharedState.bootCount)
    || Number(previous && previous.bootCount)
    || Number(sharedHost && sharedHost.__ALBOT_BOOT_COUNT__)
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
  try { sharedHost.__ALBOT_BOOT_COUNT__ = bootCount; } catch (_) {}

  const runtime = new ns.ALBotRuntime({
    root,
    version: '0.9.0-h9',
    bootCount,
    replacedPrevious: !!previous
  });

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
      farmSpots: options => runtime.game.farmSpotCatalog(options || {}),
      inventory: () => runtime.game.inventorySnapshot(),
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
      preview: targetId => runtime.classSkills.preview(targetId)
    },

    party: {
      status: () => runtime.party.status(),
      snapshot: () => runtime.party.snapshot(),
      focusTarget: () => runtime.party.preferredTargetId()
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
      rules: rules => rules == null ? runtime.inventory.ruleSnapshot() : runtime.inventory.setRules(rules)
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

  Object.freeze(api.scheduler);
  Object.freeze(api.modules);
  Object.freeze(api.game);
  Object.freeze(api.movement);
  Object.freeze(api.combat);
  Object.freeze(api.classSkills);
  Object.freeze(api.party);
  Object.freeze(api.farming);
  Object.freeze(api.farmIntelligence);
  Object.freeze(api.inventory);
  Object.freeze(api.liveTests);
  Object.freeze(api.knowledge);
  Object.freeze(api.roster);
  Object.freeze(api.actions);
  Object.freeze(api.dev);
  Object.freeze(api.ui);

  root.ALBot = api;
  try {
    sharedHost.__ALBOT_SHARED_RUNTIME__ = {
      runtime,
      bootCount,
      runnerRoot: root,
      loadedAt: runtime.loadedAt
    };
  } catch (_) {}

  runtime.logger.info('AL Bot H9 geladen', {
    version: api.version,
    bootCount,
    hotReload: !!previous,
    sharedHost: sharedHost !== root
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
