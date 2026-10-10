(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');
  const KEY = 'albot:h43:visible-quartet:v1';
  const NAMES = Object.freeze(['My_Merchant', 'My_Ranger1', 'My_Ranger2', 'My_Rogue']);
  const clean = value => String(value == null ? '' : value).trim();

  class VisibleClientMode {
    constructor(options = {}) {
      this.root = options.root || root;
      this.runtime = options.runtime || null;
      this.game = options.game || null;
      this.roster = options.roster || null;
      this.storage = options.storage || null;
      this.transport = options.transport || null;
      this.enabledSeen = false;
    }
    _ssdAvailable() {
      try {
        return !!(this.storage && this.storage.sharedAvailable()
          && typeof this.storage.getShared === 'function'
          && typeof this.storage.setShared === 'function');
      } catch (_) { return false; }
    }
    enabled() {
      if (!this._ssdAvailable()) return this.enabledSeen;
      try {
        const raw = this.storage.getShared(KEY);
        const row = raw ? JSON.parse(raw) : null;
        if (row && row.schemaVersion === 1 && row.mode === 'visible-browser-quartet'
            && row.enabled === true && Array.isArray(row.characters)
            && NAMES.every(name => row.characters.includes(name))) this.enabledSeen = true;
      } catch (_) { /* A transient SSD failure cannot re-enable child starts. */ }
      return this.enabledSeen;
    }
    localEvidence() {
      let name = null;
      try { name = clean(this.game.snapshot().character.name); } catch (_) {}
      if (!name) return { kind: 'UNKNOWN', visible: false, reason: 'H43_LOCAL_CHARACTER_UNAVAILABLE', characterName: null };
      let view = this.root;
      for (let i = 0; i < 8 && view; i += 1) {
        let parent = null;
        try {
          parent = view.parent && view.parent !== view ? view.parent : null;
          if (parent) void parent.document;
        } catch (_) { parent = null; }
        if (!parent) break;
        view = parent;
      }
      try {
        const location = view.location;
        const hostname = clean(location && location.hostname).toLowerCase();
        if (hostname !== 'adventure.land' && !hostname.endsWith('.adventure.land'))
          return { kind: 'UNKNOWN', visible: false, reason: 'H43_ORIGIN_UNVERIFIED', characterName: name };
        const match = clean(location && location.pathname).match(/^\/character\/([^/]+)\/in\/([^/]+)\/([^/]+)\/?$/i);
        if (!match) return { kind: 'UNKNOWN', visible: false, reason: 'H43_NOT_GAMEPLAY_PAGE', characterName: name };
        const pageName = decodeURIComponent(match[1]);
        if (pageName !== name) return { kind: 'CHILD_CODE_RUNNER', visible: false, reason: 'H43_RUNNER_DIFFERS_FROM_PAGE', characterName: name, pageCharacterName: pageName };
        if (clean(view.character && view.character.name) !== name)
          return { kind: 'CONNECTING', visible: false, reason: 'H43_PAGE_CHARACTER_NOT_CONNECTED', characterName: name };
        const canvas = view.document && typeof view.document.querySelector === 'function'
          ? view.document.querySelector('canvas') : null;
        if (!canvas) return { kind: 'UNVERIFIED', visible: false, reason: 'H43_RENDERER_NOT_DETECTED', characterName: name };
        return { kind: 'VISIBLE_BROWSER', visible: true, reason: 'H43_RENDERED_GAMEPLAY_OBSERVED', characterName: name };
      } catch (_) { return { kind: 'UNKNOWN', visible: false, reason: 'H43_EVIDENCE_UNAVAILABLE', characterName: name }; }
    }
    enable() {
      if (!this._ssdAvailable()) return { accepted: false, reason: 'H43_SSD_REQUIRED' };
      const local = this.localEvidence();
      if (!local.visible || local.characterName !== 'My_Merchant')
        return { accepted: false, reason: 'H43_VISIBLE_MERCHANT_REQUIRED', local };
      let roster = null;
      try { roster = this.roster.refresh(); } catch (_) {}
      const owned = new Set((roster && roster.accountCharacters || []).map(row => clean(row && row.name)));
      if (!roster || roster.accountStateAvailable !== true || !NAMES.every(name => owned.has(name)))
        return { accepted: false, reason: 'H43_FOUR_OWNED_CHARACTERS_REQUIRED' };
      const row = { schemaVersion: 1, mode: 'visible-browser-quartet', enabled: true,
        characters: [...NAMES], ownerCharacterName: 'My_Merchant', enabledAt: new Date().toISOString() };
      try {
        if (this.storage.setShared(KEY, JSON.stringify(row)) !== true)
          return { accepted: false, reason: 'H43_SSD_WRITE_FAILED' };
      } catch (_) { return { accepted: false, reason: 'H43_SSD_WRITE_FAILED' }; }
      this.enabledSeen = true;
      return { accepted: true, reason: 'H43_VISIBLE_MODE_ARMED', characters: [...NAMES] };
    }
    status() {
      const enabled = this.enabled();
      const local = this.localEvidence();
      let roster = null;
      try { roster = this.roster.refresh(); } catch (_) {}
      const online = new Set((roster && roster.onlineCharacterNames || []).map(String));
      const runners = new Set((roster && roster.runnerActiveCharacterNames || []).map(String));
      const clients = NAMES.map(name => {
        const same = local.characterName === name;
        const peer = same ? null : this.transport && typeof this.transport.freshPeer === 'function'
          ? this.transport.freshPeer(name) : null;
        return {
          name, online: online.has(name), runnerActive: runners.has(name),
          visible: same ? local.visible === true : !!(peer && peer.visibleClient === true),
          runtimeRunning: same ? !!(this.runtime && this.runtime.running) : !!(peer && peer.running),
          runtimeObserved: same || !!peer,
          kind: same ? local.kind : peer ? peer.clientKind || 'UNKNOWN' : 'UNVERIFIED',
          sessionId: peer && peer.sessionId || null
        };
      });
      return { schemaVersion: 1, mode: 'visible-browser-quartet', enabled,
        ssdAvailable: this._ssdAvailable(), local, clients,
        visibleAndRunningCount: clients.filter(row => row.visible && row.runtimeRunning).length,
        complete: enabled && clients.every(row => row.visible && row.runtimeRunning && row.online) };
    }
  }
  ns.VisibleClientMode = VisibleClientMode;
})(typeof globalThis !== 'undefined' ? globalThis : this);
