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

  class HostPersistentStateClient {
    constructor(options = {}) {
      this.root = options.root || root;
      this.logger = options.logger || null;
      this.endpoint = cleanText(options.endpoint || 'http://127.0.0.1:17391/v1/state/account', 300);
      this.moduleActive = false;
      this.scope = null;
      this.profilesByName = new Map();
      this.wealthRow = null;
      this.pendingProfiles = new Map();
      this.pendingWealth = null;
      this.lastRefreshAt = null;
      this.lastFlushAt = null;
      this.lastError = null;
      this.backoffUntilMs = 0;
      this.config = {
        refreshMs: Math.max(2000, Math.min(60000, Number(options.refreshMs) || 5000)),
        flushMs: Math.max(2000, Math.min(60000, Number(options.flushMs) || 5000)),
        maxProfiles: Math.max(4, Math.min(64, Math.floor(Number(options.maxProfiles) || 32)))
      };
      this.metrics = {
        refreshes: 0,
        flushes: 0,
        profilesLoaded: 0,
        profilesQueued: 0,
        profilesPersisted: 0,
        failures: 0
      };
    }

    start(context = {}) {
      this.moduleActive = true;
      this.scope = context.scope || null;
      if (this.scope && typeof this.scope.interval === 'function') {
        this.scope.interval('host-state-refresh', () => { this.refresh().catch(() => {}); }, this.config.refreshMs, { immediate: true });
        this.scope.interval('host-state-flush', () => { this.flush().catch(() => {}); }, this.config.flushMs, { immediate: false });
      } else {
        this.refresh().catch(() => {});
      }
      return this.status();
    }

    stop() {
      this.moduleActive = false;
      this.scope = null;
      this.flush().catch(() => {});
      return this.status();
    }

    _fetch() {
      return this.root && typeof this.root.fetch === 'function' ? this.root.fetch.bind(this.root) : null;
    }

    _recordError(error) {
      this.metrics.failures += 1;
      this.lastError = {
        at: new Date().toISOString(),
        reason: cleanText(error && error.message || error || 'HOST_STATE_FAILED', 240)
      };
      this.backoffUntilMs = Date.now() + 15000;
      return this.lastError;
    }

    _mergeProfile(profile) {
      if (!profile || !profile.name || typeof profile !== 'object') return false;
      const name = cleanText(profile.name, 120);
      if (!name) return false;
      const incomingStamp = finite(profile.observedAtMs) || finite(profile.cachedAtMs) || 0;
      const current = this.profilesByName.get(name);
      const currentStamp = finite(current && current.observedAtMs) || finite(current && current.cachedAtMs) || 0;
      if (!current || incomingStamp >= currentStamp) this.profilesByName.set(name, clone(profile));
      return true;
    }

    async refresh() {
      if (!this.moduleActive && !this.scope) {
        // Explicit/manual refresh is still allowed before module start.
      }
      if (Date.now() < this.backoffUntilMs) return { accepted: false, reason: 'HOST_STATE_BACKOFF' };
      const fetchFn = this._fetch();
      if (!fetchFn) return { accepted: false, reason: 'HOST_STATE_FETCH_UNAVAILABLE' };
      try {
        const response = await fetchFn(this.endpoint, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response || response.ok !== true) throw new Error('HOST_STATE_HTTP_' + String(response && response.status || 'FAILED'));
        const payload = await response.json();
        const profiles = Array.isArray(payload && payload.profiles) ? payload.profiles.slice(0, this.config.maxProfiles) : [];
        let loaded = 0;
        for (const profile of profiles) if (this._mergeProfile(profile)) loaded += 1;
        if (payload && payload.wealth && typeof payload.wealth === 'object') this.wealthRow = clone(payload.wealth);
        this.metrics.refreshes += 1;
        this.metrics.profilesLoaded += loaded;
        this.lastRefreshAt = new Date().toISOString();
        this.lastError = null;
        this.backoffUntilMs = 0;
        return { accepted: true, profiles: loaded, wealth: !!this.wealthRow };
      } catch (error) {
        const row = this._recordError(error);
        return { accepted: false, reason: row.reason };
      }
    }

    profile(name) {
      const key = cleanText(name || '', 120);
      if (!key) return null;
      return clone(this.profilesByName.get(key) || null);
    }

    profiles() {
      return [...this.profilesByName.values()]
        .map(clone)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }

    persistProfile(profile) {
      if (!profile || !profile.name || typeof profile !== 'object') return false;
      const row = clone(profile);
      row.name = cleanText(row.name, 120);
      if (!row.name) return false;
      this._mergeProfile(row);
      this.pendingProfiles.set(row.name, row);
      this.metrics.profilesQueued += 1;
      return true;
    }

    wealth() {
      return clone(this.wealthRow);
    }

    persistWealth(wealth) {
      if (!wealth || typeof wealth !== 'object') return false;
      this.wealthRow = clone(wealth);
      this.pendingWealth = clone(wealth);
      return true;
    }

    async flush() {
      if (!this.pendingProfiles.size && !this.pendingWealth) return { accepted: false, reason: 'HOST_STATE_NOTHING_TO_FLUSH' };
      if (Date.now() < this.backoffUntilMs) return { accepted: false, reason: 'HOST_STATE_BACKOFF' };
      const fetchFn = this._fetch();
      if (!fetchFn) return { accepted: false, reason: 'HOST_STATE_FETCH_UNAVAILABLE' };

      const profileNames = [...this.pendingProfiles.keys()];
      const profiles = profileNames.map(name => clone(this.pendingProfiles.get(name))).filter(Boolean);
      const wealth = clone(this.pendingWealth);
      try {
        const response = await fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ schemaVersion: 1, profiles, wealth }),
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response || response.ok !== true) throw new Error('HOST_STATE_HTTP_' + String(response && response.status || 'FAILED'));
        const result = await response.json().catch(() => ({}));
        for (const name of profileNames) {
          const current = this.pendingProfiles.get(name);
          if (current && profiles.some(row => row && row.name === name
              && JSON.stringify(row) === JSON.stringify(current))) this.pendingProfiles.delete(name);
        }
        if (wealth && this.pendingWealth && JSON.stringify(wealth) === JSON.stringify(this.pendingWealth)) this.pendingWealth = null;
        this.metrics.flushes += 1;
        this.metrics.profilesPersisted += Number(result && result.profilesWritten) || profiles.length;
        this.lastFlushAt = new Date().toISOString();
        this.lastError = null;
        this.backoffUntilMs = 0;
        return { accepted: true, profiles: profiles.length, wealth: !!wealth };
      } catch (error) {
        const row = this._recordError(error);
        return { accepted: false, reason: row.reason };
      }
    }

    status() {
      return {
        schemaVersion: 1,
        moduleActive: this.moduleActive,
        endpoint: this.endpoint,
        cacheProfiles: this.profilesByName.size,
        pendingProfiles: this.pendingProfiles.size,
        pendingWealth: !!this.pendingWealth,
        lastRefreshAt: this.lastRefreshAt,
        lastFlushAt: this.lastFlushAt,
        lastError: clone(this.lastError),
        backoffUntilMs: this.backoffUntilMs,
        metrics: clone(this.metrics),
        storageContract: {
          hostOnly: true,
          defaultRoot: 'D:/ALBot/state',
          accountProfiles: 'D:/ALBot/state/account-profiles',
          wealth: 'D:/ALBot/state/account-wealth.json',
          browserStorageFallback: true,
          gameplayActionAuthority: false
        }
      };
    }
  }

  ns.HostPersistentStateClient = HostPersistentStateClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
