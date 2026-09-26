(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.ALBotRuntime) throw new Error('ALBOT_RUNTIME_MISSING');

  if (root.ALBot && root.ALBot.__runtime && typeof root.ALBot.__runtime.destroy === 'function') {
    try { root.ALBot.__runtime.destroy(); } catch (_) {}
  }

  const runtime = new ns.ALBotRuntime({ root, version: '0.1.0-h1' });
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
    stop: (reason) => runtime.stop(reason || 'API_STOP'),
    emergencyStop: (reason) => runtime.emergencyStop(reason || 'API_EMERGENCY_STOP'),
    resetEmergencyStop: () => runtime.resetEmergencyStop(),
    status: () => runtime.status(),
    selfTest: () => runtime.selfTest(),
    diagnostics: () => runtime.diagnostics(),
    modules: {
      register: (definition) => runtime.modules.register(definition),
      list: () => runtime.modules.list()
    },
    goals: {
      add: (goal) => runtime.goals.add(goal),
      list: () => runtime.goals.list(),
      pause: (id) => runtime.goals.setStatus(id, 'PAUSED'),
      resume: (id) => runtime.goals.setStatus(id, 'ACTIVE'),
      cancel: (id) => runtime.goals.setStatus(id, 'CANCELLED'),
      setProgress: (id, value) => runtime.goals.setProgress(id, value),
      priorities: () => runtime.goals.getPriorities(),
      setPriority: (name, value) => runtime.goals.setPriority(name, value)
    },
    knowledge: {
      setProvider: (provider) => runtime.knowledge.setProvider(provider),
      refresh: () => runtime.knowledge.refresh(),
      status: () => runtime.knowledge.status(),
      snapshot: () => runtime.knowledge.snapshot()
    },
    roster: {
      refresh: () => runtime.roster.refresh(),
      status: () => runtime.roster.status(),
      farmers: () => runtime.roster.status().farmers,
      merchant: () => runtime.roster.status().merchant
    },
    actions: {
      canAct: (action) => runtime.actionAllowed(action),
      assertAllowed: (action) => runtime.assertActionAllowed(action)
    },
    ui: {
      show: () => runtime.ui && runtime.ui.show(),
      hide: () => runtime.ui && runtime.ui.hide(),
      render: () => runtime.ui && runtime.ui.render()
    }
  };

  Object.freeze(api.modules);
  Object.freeze(api.knowledge);
  Object.freeze(api.roster);
  Object.freeze(api.actions);
  Object.freeze(api.ui);
  root.ALBot = api;
  runtime.logger.info('AL Bot H1 geladen', { version: api.version });
})(typeof globalThis !== 'undefined' ? globalThis : this);
