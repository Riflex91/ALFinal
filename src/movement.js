(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  const clone = ns.helpers.clone;
  const cleanText = ns.helpers.cleanText;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function distance(a, b) {
    if (!a || !b) return null;
    const ax = finite(a.x), ay = finite(a.y), bx = finite(b.x), by = finite(b.y);
    if (ax == null || ay == null || bx == null || by == null) return null;
    return Math.hypot(ax - bx, ay - by);
  }

  function errorReason(value, fallback = 'MOVEMENT_UNKNOWN') {
    if (value && typeof value === 'object') {
      const raw = value.reason || value.code || value.message;
      if (raw) return cleanText(raw, 180);
    }
    const text = cleanText(value, 180);
    return text || fallback;
  }

  class MovementController {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.game = options.game;
      this.actions = options.actions;
      this.now = typeof options.now === 'function' ? options.now : () => Date.now();

      this.config = {
        pollMs: Math.max(100, Math.min(1000, Number(options.pollMs) || 200)),
        localTimeoutMs: Math.max(3000, Math.min(60000, Number(options.localTimeoutMs) || 15000)),
        smartTimeoutMs: Math.max(10000, Math.min(10 * 60 * 1000, Number(options.smartTimeoutMs) || 120000)),
        stuckMs: Math.max(1500, Math.min(30000, Number(options.stuckMs) || 6000)),
        progressEpsilon: Math.max(0.5, Math.min(20, Number(options.progressEpsilon) || 2)),
        arrivalRadius: Math.max(2, Math.min(100, Number(options.arrivalRadius) || 12)),
        retargetMinAgeMs: Math.max(250, Math.min(10000, Number(options.retargetMinAgeMs) || 1000)),
        rapidSwitchMs: Math.max(250, Math.min(10000, Number(options.rapidSwitchMs) || 1500)),
        pingPongWindowMs: Math.max(1000, Math.min(30000, Number(options.pingPongWindowMs) || 6000)),
        destinationBucket: Math.max(5, Math.min(100, Number(options.destinationBucket) || 20))
      };

      this.enabled = false;
      this.scope = null;
      this.heartbeat = null;
      this.pollResourceId = null;
      this.sequence = 0;
      this.activeOrder = null;
      this.lastOrder = null;
      this.safePoint = null;
      this.destinationHistory = [];
      this.metrics = {
        localMoves: 0,
        smartMoves: 0,
        approaches: 0,
        retargets: 0,
        safeReturns: 0,
        completed: 0,
        cancelled: 0,
        stuck: 0,
        failedSafe: 0,
        unknown: 0,
        rejected: 0,
        pingPongBlocks: 0,
        rapidSwitchBlocks: 0,
        cleanupStops: 0
      };
    }

    start(context) {
      this.enabled = true;
      this.scope = context && context.scope || null;
      this.heartbeat = context && typeof context.heartbeat === 'function' ? context.heartbeat : null;
      this.captureSafePoint('RUNTIME_START');
      if (this.heartbeat) this.heartbeat({ phase: 'movement-start', active: false });
      return this.status();
    }

    stop(reason = 'MOVEMENT_MODULE_STOP') {
      this.enabled = false;
      this._cancelActive(reason, { cleanup: true });
      this.scope = null;
      this.heartbeat = null;
      return this.status();
    }

    _snapshot() {
      return this.game && typeof this.game.snapshot === 'function' ? this.game.snapshot() : null;
    }

    _character() {
      const snap = this._snapshot();
      return snap && snap.available ? snap.character : null;
    }

    _canMoveTo(x, y) {
      const wantedX = finite(x);
      const wantedY = finite(y);
      if (wantedX == null || wantedY == null) return false;
      const candidates = [];
      let current = this.root;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (!candidates.includes(current)) candidates.push(current);
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) { parentWindow = null; }
        if (!parentWindow) break;
        current = parentWindow;
      }
      for (const candidate of candidates) {
        try {
          if (candidate && typeof candidate.can_move_to === 'function') {
            return candidate.can_move_to(wantedX, wantedY) !== false;
          }
        } catch (_) {
          return false;
        }
        try {
          if (candidate && candidate.parent && typeof candidate.parent.can_move_to === 'function') {
            return candidate.parent.can_move_to(wantedX, wantedY) !== false;
          }
        } catch (_) {
          return false;
        }
      }
      return null;
    }

    _normalizeDestination(destination, currentMap) {
      if (typeof destination === 'string') {
        const map = cleanText(destination, 120);
        if (!map) throw new Error('MOVEMENT_DESTINATION_INVALID');
        return { map, x: null, y: null };
      }
      if (!destination || typeof destination !== 'object') throw new Error('MOVEMENT_DESTINATION_INVALID');
      const map = cleanText(destination.map || currentMap || '', 120) || null;
      const x = finite(destination.x);
      const y = finite(destination.y);
      if (!map && (x == null || y == null)) throw new Error('MOVEMENT_DESTINATION_INVALID');
      if ((x == null) !== (y == null)) throw new Error('MOVEMENT_DESTINATION_COORDINATES_INCOMPLETE');
      return { map, x, y };
    }

    _destinationKey(destination) {
      const bucket = this.config.destinationBucket;
      const x = destination.x == null ? '*' : Math.round(destination.x / bucket);
      const y = destination.y == null ? '*' : Math.round(destination.y / bucket);
      return String(destination.map || '*') + ':' + x + ':' + y;
    }

    _trimHistory(now = this.now()) {
      const cutoff = now - this.config.pingPongWindowMs;
      this.destinationHistory = this.destinationHistory.filter(row => row.atMs >= cutoff).slice(-8);
    }

    _antiPingPong(destination, options = {}) {
      const now = this.now();
      this._trimHistory(now);
      const key = this._destinationKey(destination);
      const last = this.destinationHistory[this.destinationHistory.length - 1] || null;

      if (last && last.key !== key && !options.retarget && now - last.atMs < this.config.rapidSwitchMs) {
        this.metrics.rapidSwitchBlocks += 1;
        return { ok: false, reason: 'MOVEMENT_RAPID_SWITCH_BLOCKED', key, previousKey: last.key };
      }

      if (last && last.key !== key) {
        const olderSame = this.destinationHistory.slice(0, -1).reverse().find(row => row.key === key);
        if (olderSame && now - olderSame.atMs < this.config.pingPongWindowMs) {
          this.metrics.pingPongBlocks += 1;
          return { ok: false, reason: 'MOVEMENT_PINGPONG_BLOCKED', key, previousKey: last.key };
        }
      }
      return { ok: true, key };
    }

    _recordDestination(key, kind) {
      const now = this.now();
      this._trimHistory(now);
      this.destinationHistory.push({ key, kind, atMs: now });
      this._trimHistory(now);
    }

    _preflight(kind, destination, options = {}) {
      if (!this.enabled) return { ok: false, reason: 'MOVEMENT_MODULE_NOT_ACTIVE' };
      if (this.activeOrder && options.allowActive !== true) return { ok: false, reason: 'MOVEMENT_BUSY' };

      const snap = this._snapshot();
      const character = snap && snap.character;
      if (!snap || !snap.available || !character) return { ok: false, reason: 'CHARACTER_UNAVAILABLE' };
      if (character.rip === true) return { ok: false, reason: 'CHARACTER_DEAD' };

      let normalized;
      try { normalized = this._normalizeDestination(destination, character.map); }
      catch (error) { return { ok: false, reason: errorReason(error, 'MOVEMENT_DESTINATION_INVALID') }; }

      if (kind === 'local') {
        if (normalized.map && character.map && String(normalized.map) !== String(character.map)) {
          return { ok: false, reason: 'LOCAL_MOVE_CROSS_MAP_REJECTED' };
        }
        if (normalized.x == null || normalized.y == null) return { ok: false, reason: 'LOCAL_MOVE_COORDINATES_REQUIRED' };
        const passable = this._canMoveTo(normalized.x, normalized.y);
        if (passable === false) return { ok: false, reason: 'LOCAL_DESTINATION_NOT_WALKABLE' };
      }

      const anti = this._antiPingPong(normalized, options);
      if (!anti.ok) return { ...anti, destination: normalized };
      return { ok: true, character, destination: normalized, key: anti.key };
    }

    _publicOrder(order) {
      if (!order) return null;
      const copy = clone(order);
      delete copy.promise;
      return copy;
    }

    _cancelPoll(reason) {
      if (this.pollResourceId && this.scope) {
        try { this.scope.cancel(this.pollResourceId, reason || 'MOVEMENT_POLL_CANCEL'); } catch (_) {}
      }
      this.pollResourceId = null;
    }

    _bestEffortStop(reason, options = {}) {
      const results = [];
      const smart = options.smart !== false;
      const local = options.local !== false;
      if (smart && this.actions) {
        try {
          const result = this.actions.dispatch('stop', ['smart'], { cleanup: true });
          results.push({ action: 'stop-smart', state: result.state });
          if (result.dispatched) this.metrics.cleanupStops += 1;
        } catch (_) {}
      }
      if (local && this.actions && this.actions.available('use_skill')) {
        try {
          const result = this.actions.dispatch('use_skill', ['stop'], { cleanup: true });
          results.push({ action: 'use-skill-stop', state: result.state });
          if (result.dispatched) this.metrics.cleanupStops += 1;
        } catch (_) {}
      }
      if (this.logger && results.length) this.logger.warn('Bewegung bestmöglich gestoppt', { reason, results });
      return results;
    }

    _finish(state, reason, options = {}) {
      const order = this.activeOrder;
      if (!order) return null;
      this._cancelPoll('MOVEMENT_' + state);

      order.state = state;
      order.reason = reason;
      order.finishedAt = new Date().toISOString();
      order.finishedAtMs = this.now();
      order.lastObserved = options.lastObserved || order.lastObserved || null;

      if (state === 'COMPLETED') this.metrics.completed += 1;
      else if (state === 'CANCELLED') this.metrics.cancelled += 1;
      else if (state === 'STUCK') this.metrics.stuck += 1;
      else if (state === 'UNKNOWN') this.metrics.unknown += 1;
      else if (state === 'FAILED_SAFE') this.metrics.failedSafe += 1;

      if (options.stop !== false && state !== 'COMPLETED') {
        this._bestEffortStop(reason, { smart: order.kind === 'smart', local: true });
      } else if (options.stopOnArrival === true && order.kind === 'smart') {
        this._bestEffortStop('ARRIVAL_VERIFIED', { smart: true, local: false });
      }

      this.lastOrder = this._publicOrder(order);
      this.activeOrder = null;
      if (this.heartbeat) this.heartbeat({ phase: 'movement-terminal', state, reason, orderId: order.id });

      if (this.logger) {
        const data = { id: order.id, kind: order.kind, state, reason, destination: order.destination };
        if (state === 'COMPLETED') this.logger.info('Bewegungsauftrag abgeschlossen', data);
        else this.logger.warn('Bewegungsauftrag beendet', data);
      }
      return this.lastOrder;
    }

    _observeOrder() {
      const order = this.activeOrder;
      if (!order) return;
      const snap = this._snapshot();
      const character = snap && snap.character;
      const now = this.now();

      if (!snap || !snap.available || !character) {
        this._finish('UNKNOWN', 'CHARACTER_OBSERVATION_LOST');
        return;
      }
      if (character.rip === true) {
        this._finish('FAILED_SAFE', 'CHARACTER_DEAD', { lastObserved: character });
        return;
      }

      const sameMap = !order.destination.map || String(character.map || '') === String(order.destination.map);
      const currentDistance = sameMap && order.destination.x != null
        ? distance(character, order.destination)
        : null;

      const observed = {
        at: new Date().toISOString(),
        atMs: now,
        map: character.map || null,
        x: finite(character.x),
        y: finite(character.y),
        moving: character.moving === true,
        distance: currentDistance
      };
      order.lastObserved = observed;

      const arrivedByPosition = sameMap
        && currentDistance != null
        && currentDistance <= order.arrivalRadius;
      const arrivedByMap = sameMap
        && order.destination.x == null
        && order.destination.y == null
        && String(character.map || '') === String(order.destination.map || '');

      if (arrivedByPosition || arrivedByMap) {
        this._finish('COMPLETED', 'ARRIVAL_VERIFIED', {
          lastObserved: observed,
          stop: false,
          stopOnArrival: true
        });
        return;
      }

      let progress = false;
      if (order.lastMap != null && String(character.map || '') !== String(order.lastMap)) progress = true;
      if (currentDistance != null && (order.bestDistance == null || currentDistance < order.bestDistance - this.config.progressEpsilon)) {
        order.bestDistance = currentDistance;
        progress = true;
      }
      if (progress) {
        order.lastProgressAtMs = now;
        order.progressEvents += 1;
      }
      order.lastMap = character.map || null;

      if (now >= order.deadlineAtMs) {
        this._finish('FAILED_SAFE', 'MOVEMENT_TIMEOUT', { lastObserved: observed });
        return;
      }

      if (now - order.lastProgressAtMs >= this.config.stuckMs) {
        this._finish('STUCK', 'MOVEMENT_STUCK_NO_PROGRESS', { lastObserved: observed });
        return;
      }

      if (this.heartbeat) this.heartbeat({
        phase: 'movement-active',
        orderId: order.id,
        kind: order.kind,
        distance: currentDistance,
        progressEvents: order.progressEvents
      });
    }

    _watchCommand(order, dispatch) {
      if (!dispatch || dispatch.state !== 'DISPATCHED') return;
      const value = dispatch.value;
      if (!value || typeof value.then !== 'function') {
        order.commandSettlement = 'RETURNED';
        return;
      }

      order.commandSettlement = 'PENDING';
      Promise.resolve(value).then(response => {
        if (!this.activeOrder || this.activeOrder.id !== order.id) return;
        order.commandResponse = response == null ? null : clone(response);
        if (response && response.failed === true) {
          order.commandSettlement = 'FAILED';
          this._finish('FAILED_SAFE', errorReason(response.reason || response, 'MOVEMENT_COMMAND_FAILED'));
          return;
        }
        order.commandSettlement = 'RESOLVED';
        // Return/resolve is not arrival evidence. Observation decides completion.
      }, error => {
        if (!this.activeOrder || this.activeOrder.id !== order.id) return;
        order.commandSettlement = 'REJECTED';
        order.commandError = errorReason(error, 'MOVEMENT_COMMAND_REJECTED');
        this._finish('UNKNOWN', order.commandError);
      }).catch(() => {});
    }

    _startOrder(kind, destination, options = {}) {
      const check = this._preflight(kind, destination, options);
      if (!check.ok) {
        this.metrics.rejected += 1;
        if (this.logger) this.logger.warn('Bewegungsauftrag abgelehnt', { kind, reason: check.reason, destination: check.destination || destination });
        return { accepted: false, reason: check.reason, status: this.status() };
      }

      const now = this.now();
      const character = check.character;
      const arrivalRadius = Math.max(2, Math.min(100, Number(options.arrivalRadius) || this.config.arrivalRadius));
      const timeoutMs = kind === 'local'
        ? Math.max(1000, Number(options.timeoutMs) || this.config.localTimeoutMs)
        : Math.max(3000, Number(options.timeoutMs) || this.config.smartTimeoutMs);

      const order = {
        id: 'move-' + (++this.sequence),
        kind,
        owner: cleanText(options.owner || 'manual', 80) || 'manual',
        state: 'STARTING',
        reason: null,
        destination: check.destination,
        destinationKey: check.key,
        arrivalRadius,
        startedAt: new Date().toISOString(),
        startedAtMs: now,
        deadlineAtMs: now + timeoutMs,
        lastProgressAtMs: now,
        progressEvents: 0,
        bestDistance: distance(character, check.destination),
        lastMap: character.map || null,
        lastObserved: {
          at: new Date().toISOString(),
          atMs: now,
          map: character.map || null,
          x: finite(character.x),
          y: finite(character.y),
          moving: character.moving === true,
          distance: distance(character, check.destination)
        },
        commandSettlement: 'NOT_SENT',
        commandResponse: null,
        commandError: null,
        retargetedFrom: options.retargetedFrom || null
      };

      this.activeOrder = order;
      this._recordDestination(check.key, kind);

      const action = kind === 'local' ? 'move' : 'smart_move';
      const args = kind === 'local'
        ? [check.destination.x, check.destination.y]
        : [check.destination.x == null
          ? check.destination.map
          : { map: check.destination.map, x: check.destination.x, y: check.destination.y }];

      let dispatch;
      try {
        dispatch = this.actions.dispatch(action, args);
      } catch (error) {
        order.commandSettlement = 'BLOCKED';
        this._finish('FAILED_SAFE', errorReason(error, 'MOVEMENT_ACTION_BLOCKED'), { stop: false });
        return { accepted: false, reason: this.lastOrder.reason, order: clone(this.lastOrder) };
      }

      if (!dispatch || dispatch.state === 'UNAVAILABLE') {
        order.commandSettlement = 'UNAVAILABLE';
        this._finish('FAILED_SAFE', 'MOVEMENT_API_UNAVAILABLE', { stop: false });
        return { accepted: false, reason: 'MOVEMENT_API_UNAVAILABLE', order: clone(this.lastOrder) };
      }
      if (dispatch.state === 'UNKNOWN') {
        order.commandSettlement = 'UNKNOWN';
        this._finish('UNKNOWN', errorReason(dispatch.error, 'MOVEMENT_DISPATCH_UNKNOWN'));
        return { accepted: false, reason: this.lastOrder.reason, order: clone(this.lastOrder) };
      }

      order.state = 'ACTIVE';
      order.commandSettlement = 'DISPATCHED';
      if (kind === 'local') this.metrics.localMoves += 1;
      else this.metrics.smartMoves += 1;

      if (!this.scope) {
        this._finish('UNKNOWN', 'MOVEMENT_SCOPE_UNAVAILABLE');
        return { accepted: false, reason: 'MOVEMENT_SCOPE_UNAVAILABLE', order: clone(this.lastOrder) };
      }

      this.pollResourceId = this.scope.interval(
        'movement-observer:' + order.id,
        () => this._observeOrder(),
        this.config.pollMs,
        { immediate: true }
      );
      this._watchCommand(order, dispatch);

      if (this.logger) this.logger.warn('Bewegungsauftrag gestartet', {
        id: order.id,
        kind,
        owner: order.owner,
        destination: order.destination,
        arrivalRadius
      });
      return { accepted: true, order: this._publicOrder(order) };
    }

    moveLocal(x, y, options = {}) {
      const character = this._character();
      return this._startOrder('local', {
        map: character && character.map || null,
        x,
        y
      }, options);
    }

    smartMove(destination, options = {}) {
      return this._startOrder('smart', destination, options);
    }

    approachCurrentTarget(options = {}) {
      const snap = this._snapshot();
      const character = snap && snap.character;
      const target = snap && snap.target;
      if (!character || !target || target.dead === true) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_TARGET_UNAVAILABLE', status: this.status() };
      }
      if (target.map && character.map && String(target.map) !== String(character.map)) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_TARGET_CROSS_MAP', status: this.status() };
      }
      const d = distance(character, target);
      if (d == null || d <= 0) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_TARGET_DISTANCE_UNAVAILABLE', status: this.status() };
      }
      const desired = Math.max(0, Math.min(d, Number(options.distance) || Math.max(10, Number(character.range) * 0.8 || 40)));
      if (d <= desired + this.config.arrivalRadius) {
        return { accepted: true, completed: true, reason: 'ALREADY_IN_APPROACH_RANGE', distance: d };
      }
      const dx = Number(target.x) - Number(character.x);
      const dy = Number(target.y) - Number(character.y);
      const x = Number(target.x) - (dx / d) * desired;
      const y = Number(target.y) - (dy / d) * desired;
      this.metrics.approaches += 1;

      const localAllowed = this._canMoveTo(x, y);
      if (localAllowed !== false) {
        return this._startOrder('local', { map: character.map, x, y }, {
          ...options,
          owner: options.owner || 'target-approach'
        });
      }
      return this._startOrder('smart', { map: character.map, x, y }, {
        ...options,
        owner: options.owner || 'target-approach'
      });
    }

    retarget(destination, options = {}) {
      const active = this.activeOrder;
      if (!active) {
        return options.local === true
          ? this.moveLocal(destination && destination.x, destination && destination.y, options)
          : this.smartMove(destination, options);
      }

      const now = this.now();
      if (now - active.startedAtMs < this.config.retargetMinAgeMs) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: 'MOVEMENT_RETARGET_TOO_SOON', status: this.status() };
      }

      let normalized;
      try {
        const character = this._character();
        normalized = this._normalizeDestination(destination, character && character.map);
      } catch (error) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: errorReason(error, 'MOVEMENT_DESTINATION_INVALID'), status: this.status() };
      }
      const key = this._destinationKey(normalized);
      if (key === active.destinationKey) {
        return { accepted: true, changed: false, reason: 'MOVEMENT_DESTINATION_UNCHANGED', order: this._publicOrder(active) };
      }

      const anti = this._antiPingPong(normalized, { retarget: true });
      if (!anti.ok) {
        this.metrics.rejected += 1;
        return { accepted: false, reason: anti.reason, status: this.status() };
      }

      const previousId = active.id;
      this._cancelActive('RETARGET', { cleanup: true });
      this.metrics.retargets += 1;
      return options.local === true
        ? this._startOrder('local', normalized, { ...options, retarget: true, retargetedFrom: previousId })
        : this._startOrder('smart', normalized, { ...options, retarget: true, retargetedFrom: previousId });
    }

    _cancelActive(reason, options = {}) {
      if (!this.activeOrder) {
        if (options.forceCleanup === true) this._bestEffortStop(reason, { smart: true, local: true });
        return { cancelled: false, reason: 'NO_ACTIVE_MOVEMENT' };
      }
      const id = this.activeOrder.id;
      const order = this._finish('CANCELLED', cleanText(reason || 'MOVEMENT_CANCELLED', 180), {
        stop: options.cleanup !== false
      });
      return { cancelled: true, orderId: id, order };
    }

    cancel(reason = 'MANUAL_CANCEL') {
      return this._cancelActive(reason, { cleanup: true });
    }

    emergencyStop(reason = 'EMERGENCY_STOP') {
      const result = this._cancelActive(reason, { cleanup: true, forceCleanup: true });
      if (!result.cancelled) this._bestEffortStop(reason, { smart: true, local: true });
      return result;
    }

    captureSafePoint(source = 'MANUAL') {
      const character = this._character();
      if (!character || !character.map || finite(character.x) == null || finite(character.y) == null) {
        return { captured: false, reason: 'CHARACTER_POSITION_UNAVAILABLE' };
      }
      this.safePoint = {
        map: character.map,
        x: finite(character.x),
        y: finite(character.y),
        capturedAt: new Date().toISOString(),
        source: cleanText(source, 80)
      };
      return { captured: true, safePoint: clone(this.safePoint) };
    }

    safeReturn(options = {}) {
      if (!this.safePoint) return { accepted: false, reason: 'SAFE_POINT_UNAVAILABLE' };
      this.metrics.safeReturns += 1;
      const character = this._character();
      if (character && String(character.map || '') === String(this.safePoint.map || '')) {
        const can = this._canMoveTo(this.safePoint.x, this.safePoint.y);
        if (can !== false) {
          return this._startOrder('local', this.safePoint, {
            ...options,
            owner: options.owner || 'safe-return'
          });
        }
      }
      return this._startOrder('smart', this.safePoint, {
        ...options,
        owner: options.owner || 'safe-return'
      });
    }

    status() {
      return {
        schemaVersion: 1,
        enabled: this.enabled,
        state: this.activeOrder ? this.activeOrder.state : 'IDLE',
        active: !!this.activeOrder,
        activeOrder: this._publicOrder(this.activeOrder),
        lastOrder: clone(this.lastOrder),
        safePoint: clone(this.safePoint),
        config: clone(this.config),
        recentDestinations: clone(this.destinationHistory.slice(-5)),
        metrics: clone(this.metrics)
      };
    }
  }

  ns.MovementController = MovementController;
})(typeof globalThis !== 'undefined' ? globalThis : this);
