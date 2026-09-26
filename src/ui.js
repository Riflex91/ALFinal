(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function formatPosition(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : '-';
  }

  class ControlCenter {
    constructor(runtime) {
      this.runtime = runtime;
      this.root = runtime.root;
      this.uiRoot = this._resolveUiRoot(this.root);
      this.doc = this.uiRoot && this.uiRoot.document ? this.uiRoot.document : this.root.document;
      this.host = null;
      this.interval = null;
      this.activeTab = 'overview';
      this.minimized = false;
      this.devResult = null;
      this.navigationResult = null;
      this.combatResult = null;
      this.liveTestClipboard = null;
      this._offLog = null;
      this._dragCleanup = null;
    }

    _resolveUiRoot(start) {
      let current = start;
      let best = null;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        try {
          if (current.document && current.document.body) best = current;
        } catch (_) {
          break;
        }
        let parentWindow = null;
        try {
          parentWindow = current.parent && current.parent !== current ? current.parent : null;
          if (parentWindow) void parentWindow.document;
        } catch (_) {
          parentWindow = null;
        }
        if (!parentWindow) break;
        current = parentWindow;
      }
      return best || start;
    }

    mount() {
      if (!this.doc || !this.doc.body) return false;
      this.destroy();
      const host = this.doc.createElement('div');
      host.id = 'albot-control-center';
      host.innerHTML = this._shell();
      this.doc.body.appendChild(host);
      this.host = host;
      this._bind();
      this.render();
      const timerRoot = this.uiRoot && typeof this.uiRoot.setInterval === 'function' ? this.uiRoot : this.root;
      this.intervalRoot = timerRoot;
      this.interval = timerRoot.setInterval(() => this._tick(), 1000);
      this._offLog = this.runtime.bus.on('log', () => this.renderLogs());
      return true;
    }

    _shell() {
      return `<style>
#albot-control-center{position:fixed;right:18px;top:18px;width:min(700px,calc(100vw - 36px));height:min(780px,calc(100vh - 36px));min-width:min(480px,calc(100vw - 36px));min-height:min(380px,calc(100vh - 36px));max-width:calc(100vw - 8px);max-height:calc(100vh - 8px);z-index:2147483647;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:12px/1.35 Arial,sans-serif;overflow:hidden;resize:both;display:flex;flex-direction:column}
#albot-control-center *{box-sizing:border-box}#albot-control-center button,#albot-control-center input,#albot-control-center select{font:inherit}
#albot-control-center.albot-minimized{height:auto!important;min-height:0!important;resize:none}
#albot-control-center.albot-minimized .albot-tabs,#albot-control-center.albot-minimized .albot-body,#albot-control-center.albot-minimized .albot-footer{display:none}
.albot-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0b1220;border-bottom:1px solid #374151;cursor:move;user-select:none;flex:none}.albot-title{font-weight:800;font-size:15px;flex:1}.albot-state{font-size:11px;padding:3px 7px;border-radius:999px;background:#374151}.albot-window-btn{background:#374151;color:#fff;border:0;border-radius:7px;padding:6px 9px;font-weight:800;cursor:pointer;line-height:1}.albot-window-btn:hover{background:#4b5563}.albot-stop{background:#b91c1c;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer}.albot-stop:hover{background:#dc2626}
.albot-tabs{display:flex;gap:2px;padding:6px;background:#0f172a;border-bottom:1px solid #374151;overflow:auto;flex:none}.albot-tab{background:#1f2937;color:#d1d5db;border:0;border-radius:6px;padding:6px 9px;cursor:pointer;white-space:nowrap}.albot-tab.active{background:#4b5563;color:white}
.albot-body{padding:10px;overflow:auto;flex:1;min-height:0}.albot-panel{display:none}.albot-panel.active{display:block}.albot-card{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:8px;margin-bottom:8px}.albot-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.albot-k{color:#9ca3af}.albot-v{font-weight:700;word-break:break-word}.albot-row{display:flex;gap:6px;align-items:center;margin:6px 0}.albot-row>*{min-width:0}.albot-row input,.albot-row select{flex:1;background:#111827;color:#e5e7eb;border:1px solid #4b5563;border-radius:6px;padding:6px}.albot-btn{background:#374151;color:#fff;border:0;border-radius:6px;padding:6px 9px;cursor:pointer}.albot-btn:hover{background:#4b5563}.albot-btn:disabled{opacity:.45;cursor:not-allowed}.albot-btn.warn{background:#92400e}.albot-btn.danger{background:#991b1b}.albot-stop-warning{margin-bottom:8px;padding:10px;border:1px solid #ef4444;border-radius:8px;background:#451a1a;color:#fecaca;font-weight:700}.albot-goal{border-left:3px solid #6b7280;padding-left:8px;margin:8px 0}.albot-goal-head{display:flex;align-items:center;gap:8px}.albot-goal-title{flex:1;min-width:0}.albot-goal-delete{width:22px;height:22px;padding:0;border:1px solid #ef4444;border-radius:50%;background:#7f1d1d;color:#fff;font-weight:900;line-height:18px;cursor:pointer;flex:none}.albot-goal-delete:hover{background:#dc2626}.albot-small{font-size:11px;color:#9ca3af}.albot-log{white-space:pre-wrap;background:#030712;border-radius:6px;padding:8px;max-height:250px;overflow:auto;font-family:Consolas,monospace}.albot-ok{color:#86efac}.albot-bad{color:#fca5a5}.albot-muted{color:#9ca3af}.albot-priority-grid{display:grid;grid-template-columns:1fr 120px;gap:6px;align-items:center}.albot-footer{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #374151;background:#0b1220;flex:none}
</style>
<div class="albot-head" id="albot-drag-handle"><div class="albot-title">AL BOT</div><span id="albot-state" class="albot-state">STOPPED</span><button id="albot-minimize" class="albot-window-btn" title="Fenster minimieren" aria-label="Fenster minimieren">—</button><button id="albot-emergency" class="albot-stop">STOP</button></div>
<div class="albot-tabs">
<button class="albot-tab active" data-tab="overview">Übersicht</button><button class="albot-tab" data-tab="priorities">Prioritäten</button><button class="albot-tab" data-tab="navigation">Bewegung</button><button class="albot-tab" data-tab="combat">Combat</button><button class="albot-tab" data-tab="party">Party</button><button class="albot-tab" data-tab="live-test">Live-Test</button><button class="albot-tab" data-tab="knowledge">Knowledge</button><button class="albot-tab" data-tab="logs">Logs</button><button class="albot-tab" data-tab="dev">Entwicklung</button>
</div>
<div class="albot-body">
<section id="albot-panel-overview" class="albot-panel active"></section>
<section id="albot-panel-priorities" class="albot-panel"></section>
<section id="albot-panel-navigation" class="albot-panel"></section>
<section id="albot-panel-combat" class="albot-panel"></section>
<section id="albot-panel-party" class="albot-panel"></section>
<section id="albot-panel-live-test" class="albot-panel"></section>
<section id="albot-panel-knowledge" class="albot-panel"></section>
<section id="albot-panel-logs" class="albot-panel"></section>
<section id="albot-panel-dev" class="albot-panel"></section>
</div>
<div class="albot-footer"><button id="albot-test-start-main" class="albot-btn">Test starten</button><button id="albot-start" class="albot-btn">Start</button><button id="albot-reset-stop-main" class="albot-btn danger" style="display:none">STOP zurücksetzen</button><button id="albot-stop-normal" class="albot-btn warn">Stop</button><button id="albot-copy" class="albot-btn">Fehlerbericht kopieren</button><button id="albot-hide" class="albot-btn">Ausblenden</button></div>`;
    }

    _bind() {
      this.host.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => { this.activeTab = btn.dataset.tab; this._selectTab(); this.render(); }));
      this.host.querySelector('#albot-emergency').addEventListener('click', async () => { await this.runtime.emergencyStop('GUI_EMERGENCY_STOP'); this.render(); });
      this.host.querySelector('#albot-minimize').addEventListener('click', (event) => { event.stopPropagation(); this.toggleMinimized(); });
      this._installDrag();
      this.host.querySelector('#albot-test-start-main').addEventListener('click', () => this.runRecommendedLiveTest());
      this.host.querySelector('#albot-start').addEventListener('click', async () => { try { await this.runtime.start(); } catch (e) { this.runtime.logger.error('Start fehlgeschlagen', { error: e.message }); } this.render(); });
      this.host.querySelector('#albot-reset-stop-main').addEventListener('click', () => { this.runtime.resetEmergencyStop(); this.render(); });
      this.host.querySelector('#albot-stop-normal').addEventListener('click', async () => { await this.runtime.stop('GUI_MODULE_STOP'); this.render(); });
      this.host.querySelector('#albot-copy').addEventListener('click', () => this.copyDiagnostics());
      this.host.querySelector('#albot-hide').addEventListener('click', () => { this.host.style.display = 'none'; });
    }

    _installDrag() {
      const handle = this.host && this.host.querySelector('#albot-drag-handle');
      if (!handle || !this.uiRoot || typeof this.uiRoot.addEventListener !== 'function') return;

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;

      const move = (event) => {
        if (!dragging || !this.host) return;
        const viewportW = Math.max(1, Number(this.uiRoot.innerWidth) || Number(this.doc.documentElement && this.doc.documentElement.clientWidth) || 1);
        const viewportH = Math.max(1, Number(this.uiRoot.innerHeight) || Number(this.doc.documentElement && this.doc.documentElement.clientHeight) || 1);
        const rect = this.host.getBoundingClientRect();
        const maxLeft = Math.max(0, viewportW - Math.min(rect.width, viewportW));
        const maxTop = Math.max(0, viewportH - Math.min(rect.height, viewportH));
        const left = Math.max(0, Math.min(maxLeft, startLeft + event.clientX - startX));
        const top = Math.max(0, Math.min(maxTop, startTop + event.clientY - startY));
        this.host.style.left = left + 'px';
        this.host.style.top = top + 'px';
        this.host.style.right = 'auto';
      };

      const up = () => {
        if (!dragging) return;
        dragging = false;
        if (this.doc && this.doc.body) this.doc.body.style.userSelect = '';
      };

      const down = (event) => {
        if (event.button !== 0 || !this.host) return;
        if (event.target && event.target.closest && event.target.closest('button,input,select,textarea,a')) return;
        const rect = this.host.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        this.host.style.left = rect.left + 'px';
        this.host.style.top = rect.top + 'px';
        this.host.style.right = 'auto';
        if (this.doc && this.doc.body) this.doc.body.style.userSelect = 'none';
        event.preventDefault();
      };

      handle.addEventListener('mousedown', down);
      this.uiRoot.addEventListener('mousemove', move);
      this.uiRoot.addEventListener('mouseup', up);
      this._dragCleanup = () => {
        handle.removeEventListener('mousedown', down);
        this.uiRoot.removeEventListener('mousemove', move);
        this.uiRoot.removeEventListener('mouseup', up);
        if (this.doc && this.doc.body) this.doc.body.style.userSelect = '';
      };
    }

    toggleMinimized(force) {
      if (!this.host) return false;
      this.minimized = typeof force === 'boolean' ? force : !this.minimized;
      this.host.classList.toggle('albot-minimized', this.minimized);
      const button = this.host.querySelector('#albot-minimize');
      if (button) {
        button.textContent = this.minimized ? '□' : '—';
        button.title = this.minimized ? 'Fenster ausklappen' : 'Fenster minimieren';
        button.setAttribute('aria-label', button.title);
      }
      return this.minimized;
    }

    _selectTab() {
      this.host.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === this.activeTab));
      this.host.querySelectorAll('.albot-panel').forEach(panel => panel.classList.toggle('active', panel.id === 'albot-panel-' + this.activeTab));
    }

    _updateHeader(status) {
      const state = this.host.querySelector('#albot-state');
      state.textContent = status.emergencyStop.latched ? 'EMERGENCY STOP' : status.running ? 'RUNNING' : 'STOPPED';
      state.className = 'albot-state ' + (status.emergencyStop.latched ? 'albot-bad' : status.running ? 'albot-ok' : '');
      const startButton = this.host.querySelector('#albot-start');
      const testButton = this.host.querySelector('#albot-test-start-main');
      const resetButton = this.host.querySelector('#albot-reset-stop-main');
      if (startButton) {
        startButton.disabled = status.emergencyStop.latched === true;
        startButton.title = status.emergencyStop.latched ? 'Start ist blockiert, bis der globale STOP manuell zurückgesetzt wurde.' : '';
      }
      if (testButton) {
        const liveTests = status.liveTests || {};
        testButton.disabled = status.emergencyStop.latched === true || liveTests.running === true || !liveTests.recommended;
        testButton.title = status.emergencyStop.latched
          ? 'Live-Test ist blockiert, bis der globale STOP manuell zurückgesetzt wurde.'
          : liveTests.running
            ? 'Live-Test läuft bereits.'
            : !liveTests.recommended
              ? 'Noch keine empfohlene Live-Testsuite registriert.'
              : 'Empfohlenen Live-Test automatisch ausführen.';
      }
      if (resetButton) resetButton.style.display = status.emergencyStop.latched ? '' : 'none';
    }

    _tick() {
      if (!this.host) return;
      this.runtime.roster.refresh();
      const status = this.runtime.status();
      this._updateHeader(status);
      if (this.activeTab === 'overview') this.renderOverview(status);
      if (this.activeTab === 'navigation') {
        const panel = this.host.querySelector('#albot-panel-navigation');
        const focused = panel && this.doc && this.doc.activeElement && panel.contains(this.doc.activeElement);
        if (!focused) this.renderNavigation(status);
      }
      if (this.activeTab === 'combat') {
        const panel = this.host.querySelector('#albot-panel-combat');
        const focused = panel && this.doc && this.doc.activeElement && panel.contains(this.doc.activeElement);
        if (!focused) this.renderCombat(status);
      }
      if (this.activeTab === 'party') this.renderParty(status);
      if (this.activeTab === 'live-test') this.renderLiveTest(status);
      if (this.activeTab === 'knowledge') this.renderKnowledge(status);
      if (this.activeTab === 'logs') this.renderLogs();
      if (this.activeTab === 'dev') this.renderDev(status);
    }

    render() {
      if (!this.host) return;
      this.runtime.roster.refresh();
      const status = this.runtime.status();
      this._updateHeader(status);
      this.renderOverview(status);
      this.renderPriorities(status);
      this.renderNavigation(status);
      this.renderCombat(status);
      this.renderParty(status);
      this.renderLiveTest(status);
      this.renderKnowledge(status);
      this.renderLogs();
      this.renderDev(status);
    }

    renderOverview(status) {
      const panel = this.host.querySelector('#albot-panel-overview');
      const roster = status.roster || { farmers: [], characters: [] };
      const knowledge = status.knowledge || {};
      const game = status.game || { available: false, character: null, target: null };
      const gameCharacter = game.character || {};
      const scheduler = status.scheduler || { enabled: false, totalResources: 0, generation: 0 };
      panel.innerHTML = `${status.emergencyStop.latched ? '<div class="albot-stop-warning">GLOBALER STOP IST AKTIV. Start ist absichtlich blockiert. Zum Fortfahren unten auf „STOP zurücksetzen“ klicken.</div>' : ''}<div class="albot-card"><b>System</b><div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Version</span><div class="albot-v">${esc(status.version)}</div></div>
<div><span class="albot-k">Runtime</span><div class="albot-v">${status.running ? 'RUNNING' : 'STOPPED'}</div></div>
<div><span class="albot-k">STOP</span><div class="albot-v">${status.emergencyStop.latched ? 'AKTIV' : 'bereit'}</div></div>
<div><span class="albot-k">Knowledge</span><div class="albot-v">${knowledge.provider ? esc(knowledge.provider.state || 'IDLE') : 'nicht konfiguriert'}${knowledge.lastKnownGood ? ' · LKG Gen. '+esc(knowledge.lastKnownGood.generation) : ''}</div></div>
<div><span class="albot-k">Scheduler</span><div class="albot-v">${scheduler.enabled ? 'ACTIVE' : 'STOPPED'} · ${esc(scheduler.totalResources)} Ressourcen</div></div>
<div><span class="albot-k">Scheduler Starts</span><div class="albot-v">${esc(scheduler.generation)}</div></div>
<div><span class="albot-k">Boot / Reload</span><div class="albot-v">#${esc(status.bootCount || 1)}${status.replacedPrevious ? ' · Hot Reload' : ''}</div></div>
<div><span class="albot-k">Runtime Starts</span><div class="albot-v">${esc(status.runEpoch || 0)}</div></div>
</div></div>
<div class="albot-card"><b>Live Game Adapter</b><div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Character</span><div class="albot-v">${game.available ? esc(gameCharacter.name || '-')+' ('+esc(gameCharacter.ctype || '-')+')' : 'nicht verfügbar'}</div></div>
<div><span class="albot-k">Map</span><div class="albot-v">${esc(gameCharacter.map || '-')}</div></div>
<div><span class="albot-k">HP / MP</span><div class="albot-v">${esc(gameCharacter.hp)} / ${esc(gameCharacter.maxHp)} · ${esc(gameCharacter.mp)} / ${esc(gameCharacter.maxMp)}</div></div>
<div><span class="albot-k">Position</span><div class="albot-v">x=${esc(formatPosition(gameCharacter.x))} · y=${esc(formatPosition(gameCharacter.y))}</div></div>
<div><span class="albot-k">Target</span><div class="albot-v">${game.target ? esc(game.target.name || game.target.id || '-') : 'keins'}</div></div>
<div><span class="albot-k">Entities</span><div class="albot-v">${esc(game.world && game.world.entityCount != null ? game.world.entityCount : 0)}</div></div>
</div></div>
<div class="albot-card"><b>Dynamisch erkannte Charaktere</b><div class="albot-small">Quelle: ${esc(roster.source || 'unbekannt')} · keine hartcodierten Namen</div>
<div style="margin-top:6px"><span class="albot-k">Farmer:</span> <span class="albot-v">${roster.farmers && roster.farmers.length ? roster.farmers.map(x => esc(x.name)+' ('+esc(x.ctype)+')').join(', ') : 'keine erkannt'}</span></div>
<div><span class="albot-k">Merchant:</span> <span class="albot-v">${roster.merchant ? esc(roster.merchant.name) : 'nicht erkannt'}</span></div>
<div><span class="albot-k">Aktiv gesamt:</span> <span class="albot-v">${roster.characters ? roster.characters.length : 0}</span></div></div>
<div class="albot-card"><b>Module</b><div class="albot-small">${status.modules.length ? status.modules.map(m => esc(m.id)+': '+esc(m.state)+' / '+esc(m.health || 'UNKNOWN')+' · Ressourcen '+esc(m.resources == null ? 0 : m.resources)).join('<br>') : 'Noch keine Module installiert.'}</div></div>`;
    }

    renderPriorities(status) {
      const panel = this.host.querySelector('#albot-panel-priorities');
      const goals = status.goals || [];
      const p = status.strategicPriorities || {};
      panel.innerHTML = `<div class="albot-card"><b>Neues Ziel</b>
<div class="albot-row"><select id="albot-goal-type"><option value="COLLECT_ITEM">Item sammeln</option><option value="LEVEL">Aufleveln</option><option value="GEAR">Bessere Rüstung/Gear</option><option value="GOLD">Gold verdienen</option><option value="CUSTOM">Sonstiges</option></select><input id="albot-goal-target" placeholder="Ziel / Item / Beschreibung"></div>
<div class="albot-row"><input id="albot-goal-amount" type="number" min="1" placeholder="Menge / Zielwert"><select id="albot-goal-scope"><option value="FARMERS">Erkannte Farmer</option><option value="PARTY">Party</option><option value="ACCOUNT">Account</option><option value="MERCHANT">Merchant</option></select><select id="albot-goal-priority"><option>HIGH</option><option selected>NORMAL</option><option>LOW</option><option>CRITICAL</option></select></div>
<div class="albot-row"><button id="albot-add-goal" class="albot-btn">+ Ziel anlegen</button></div></div>
<div class="albot-card"><b>Aktive Ziele</b>${goals.length ? goals.map(g => `<div class="albot-goal"><div class="albot-goal-head"><div class="albot-goal-title"><b>${esc(g.priority)}</b> · ${esc(g.type)} · ${esc(g.target || '(ohne Text)')}</div><button class="albot-goal-delete" data-goal-delete="${esc(g.id)}" title="Ziel löschen" aria-label="Ziel löschen">×</button></div><div class="albot-small">Scope: ${esc(g.scope)} · Status: ${esc(g.status)}${g.amount != null ? ' · Fortschritt: '+esc(g.progress)+' / '+esc(g.amount) : ''}</div><div class="albot-row"><button class="albot-btn" data-goal-action="${g.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED'}" data-goal-id="${esc(g.id)}">${g.status === 'PAUSED' ? 'Fortsetzen' : 'Pause'}</button><button class="albot-btn danger" data-goal-action="CANCELLED" data-goal-id="${esc(g.id)}">Abbrechen</button></div></div>`).join('') : '<div class="albot-small">Noch keine Ziele.</div>'}</div>
<div class="albot-card"><b>Grundprioritäten</b><div class="albot-priority-grid">${Object.entries(p).map(([k,v]) => `<label>${esc(k)}</label><select data-priority-name="${esc(k)}">${['LOW','NORMAL','HIGH','CRITICAL'].map(x => `<option ${x===v?'selected':''}>${x}</option>`).join('')}</select>`).join('')}</div></div>`;
      const add = panel.querySelector('#albot-add-goal');
      if (add) add.onclick = () => {
        try {
          this.runtime.goals.add({ type: panel.querySelector('#albot-goal-type').value, target: panel.querySelector('#albot-goal-target').value, amount: panel.querySelector('#albot-goal-amount').value, scope: panel.querySelector('#albot-goal-scope').value, priority: panel.querySelector('#albot-goal-priority').value });
          this.render();
        } catch (e) { this.runtime.logger.error('Goal konnte nicht angelegt werden', { error: e.message }); this.render(); }
      };
      panel.querySelectorAll('[data-goal-action]').forEach(btn => btn.onclick = () => { try { this.runtime.goals.setStatus(btn.dataset.goalId, btn.dataset.goalAction); } catch (e) { this.runtime.logger.error('Goal-Status fehlgeschlagen', { error: e.message }); } this.render(); });
      panel.querySelectorAll('[data-goal-delete]').forEach(btn => btn.onclick = () => { try { this.runtime.goals.remove(btn.dataset.goalDelete); } catch (e) { this.runtime.logger.error('Goal konnte nicht gelöscht werden', { error: e.message }); } this.render(); });
      panel.querySelectorAll('[data-priority-name]').forEach(sel => sel.onchange = () => { try { this.runtime.goals.setPriority(sel.dataset.priorityName, sel.value); } catch (e) { this.runtime.logger.error('Priorität konnte nicht geändert werden', { error: e.message }); } this.render(); });
    }

    renderNavigation(status) {
      const panel = this.host.querySelector('#albot-panel-navigation');
      if (!panel) return;
      const movement = status.movement || {};
      const game = status.game || {};
      const character = game.character || {};
      const active = movement.activeOrder || null;
      const last = movement.lastOrder || null;
      const safe = movement.safePoint || null;
      const resultText = this.navigationResult ? JSON.stringify(this.navigationResult, null, 2) : 'Noch keine manuelle H4-Bewegungsaktion.';

      panel.innerHTML = `<div class="albot-card"><b>H4 Bewegung</b>
<div class="albot-small">Alle Aktionen laufen über die zentrale Action-Grenze. Arrival wird aus der beobachteten Position bestätigt; ein Return von smart_move allein gilt nicht als Ankunft.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Modul</span><div class="albot-v">${movement.enabled ? 'ACTIVE' : 'STOPPED'}</div></div>
<div><span class="albot-k">Zustand</span><div class="albot-v">${esc(movement.state || 'IDLE')}</div></div>
<div><span class="albot-k">Map</span><div class="albot-v">${esc(character.map || '-')}</div></div>
<div><span class="albot-k">Position</span><div class="albot-v">x=${esc(formatPosition(character.x))} · y=${esc(formatPosition(character.y))}</div></div>
<div><span class="albot-k">Aktiver Auftrag</span><div class="albot-v">${active ? esc(active.kind)+' · '+esc(active.id) : 'keiner'}</div></div>
<div><span class="albot-k">Safe Point</span><div class="albot-v">${safe ? esc(safe.map)+' · '+esc(formatPosition(safe.x))+', '+esc(formatPosition(safe.y)) : 'nicht gesetzt'}</div></div>
</div></div>

<div class="albot-card"><b>Kontrollierter Zielpunkt</b>
<div class="albot-row"><input id="albot-nav-map" value="${esc(character.map || '')}" placeholder="Map"><input id="albot-nav-x" type="number" step="0.01" placeholder="x"><input id="albot-nav-y" type="number" step="0.01" placeholder="y"></div>
<div class="albot-row"><button id="albot-nav-local" class="albot-btn">Lokal bewegen</button><button id="albot-nav-smart" class="albot-btn">Smart Move</button><button id="albot-nav-retarget" class="albot-btn">Retarget</button><button id="albot-nav-cancel" class="albot-btn danger">Bewegung abbrechen</button></div>
</div>

<div class="albot-card"><b>Zielannäherung & Safe Return</b>
<div class="albot-row"><input id="albot-nav-distance" type="number" min="0" step="1" placeholder="Abstand zum ausgewählten Target"><button id="albot-nav-approach" class="albot-btn">Target annähern</button></div>
<div class="albot-row"><button id="albot-nav-safe-capture" class="albot-btn">Safe Point hier setzen</button><button id="albot-nav-safe-return" class="albot-btn">Zum Safe Point zurück</button></div>
</div>

<div class="albot-card"><b>Letzter Status</b>
<div class="albot-small">${last ? 'Letzter Auftrag: '+esc(last.state)+' · '+esc(last.reason || '-') : 'Noch kein abgeschlossener Auftrag.'}</div>
<div class="albot-log" style="margin-top:8px;max-height:220px">${esc(resultText)}</div>
</div>`;

      const readDestination = () => {
        const map = panel.querySelector('#albot-nav-map').value.trim();
        const xRaw = panel.querySelector('#albot-nav-x').value;
        const yRaw = panel.querySelector('#albot-nav-y').value;
        const x = xRaw === '' ? null : Number(xRaw);
        const y = yRaw === '' ? null : Number(yRaw);
        return { map: map || character.map || null, x, y };
      };
      const run = fn => {
        try { this.navigationResult = fn(); }
        catch (error) { this.navigationResult = { accepted: false, reason: String(error && error.message || error) }; }
        this.renderNavigation(this.runtime.status());
      };

      panel.querySelector('#albot-nav-local').onclick = () => {
        const destination = readDestination();
        run(() => this.runtime.movement.moveLocal(destination.x, destination.y, { owner: 'gui-h4-local' }));
      };
      panel.querySelector('#albot-nav-smart').onclick = () => {
        const destination = readDestination();
        run(() => this.runtime.movement.smartMove(destination, { owner: 'gui-h4-smart' }));
      };
      panel.querySelector('#albot-nav-retarget').onclick = () => {
        const destination = readDestination();
        run(() => this.runtime.movement.retarget(destination, { owner: 'gui-h4-retarget' }));
      };
      panel.querySelector('#albot-nav-cancel').onclick = () => run(() => this.runtime.movement.cancel('GUI_MOVEMENT_CANCEL'));
      panel.querySelector('#albot-nav-approach').onclick = () => {
        const raw = panel.querySelector('#albot-nav-distance').value;
        run(() => this.runtime.movement.approachCurrentTarget({
          owner: 'gui-h4-target-approach',
          distance: raw === '' ? undefined : Number(raw)
        }));
      };
      panel.querySelector('#albot-nav-safe-capture').onclick = () => run(() => this.runtime.movement.captureSafePoint('GUI'));
      panel.querySelector('#albot-nav-safe-return').onclick = () => run(() => this.runtime.movement.safeReturn({ owner: 'gui-h4-safe-return' }));
    }

    renderCombat(status) {
      const panel = this.host.querySelector('#albot-panel-combat');
      if (!panel) return;
      const combat = status.combat || {};
      const session = combat.session || null;
      const metrics = combat.metrics || {};
      const classSkills = status.classSkills || {};
      const skillMetrics = classSkills.metrics || {};
      const pendingSkill = classSkills.pending || null;
      const liveSkills = Array.isArray(classSkills.liveSkills) ? classSkills.liveSkills.filter(row => row.available).map(row => row.id) : [];
      const pending = combat.pendingAttack || null;
      const candidates = Array.isArray(combat.safeCandidates) ? combat.safeCandidates : [];
      const resultText = this.combatResult ? JSON.stringify(this.combatResult, null, 2) : 'Noch keine manuelle H6-Combat-Session.';

      panel.innerHTML = `<div class="albot-card"><b>H5/H6 Combat & Klassenlogik</b>
<div class="albot-small">H5 stellt Targeting, Movement und Basisangriff bereit. H6 ergänzt klassenspezifische Skills mit Live-Readiness, MP-Reserve, Cooldown-Prüfung und Anti-Spam. Party- und AoE-Logik folgen erst in H7/H8.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Modul</span><div class="albot-v">${combat.moduleActive ? 'ACTIVE' : 'STOPPED'}</div></div>
<div><span class="albot-k">Combat</span><div class="albot-v">${esc(combat.state || 'IDLE')}</div></div>
<div><span class="albot-k">Target</span><div class="albot-v">${session && session.targetId ? esc(session.targetType || session.targetId) : 'keins'}</div></div>
<div><span class="albot-k">Attack Outcome</span><div class="albot-v">${pending ? esc(pending.commandSettlement || 'PENDING') : 'kein offener Angriff'}</div></div>
<div><span class="albot-k">Angriffe bestätigt</span><div class="albot-v">${esc(metrics.attacksConfirmed || 0)}</div></div>
<div><span class="albot-k">UNKNOWN</span><div class="albot-v">${esc(metrics.attackUnknown || 0)}</div></div>
<div><span class="albot-k">Approaches</span><div class="albot-v">${esc(metrics.approaches || 0)}</div></div>
<div><span class="albot-k">Retreats</span><div class="albot-v">${esc(metrics.retreats || 0)}</div></div>
</div></div>

<div class="albot-card"><b>H6 Klassen-Skills</b>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Klasse</span><div class="albot-v">${esc(classSkills.currentClass || '-')}</div></div>
<div><span class="albot-k">Live Skills</span><div class="albot-v">${liveSkills.length ? liveSkills.map(esc).join(', ') : 'keine'}</div></div>
<div><span class="albot-k">Pending</span><div class="albot-v">${pendingSkill ? esc(pendingSkill.skillId) : 'keiner'}</div></div>
<div><span class="albot-k">Bestätigt</span><div class="albot-v">${esc(skillMetrics.confirmed || 0)}</div></div>
<div><span class="albot-k">Abgelehnt</span><div class="albot-v">${esc(skillMetrics.rejected || 0)}</div></div>
<div><span class="albot-k">UNKNOWN</span><div class="albot-v">${esc(skillMetrics.unknown || 0)}</div></div>
<div><span class="albot-k">Anti-Spam Skips</span><div class="albot-v">${esc(skillMetrics.spamSkips || 0)}</div></div>
<div><span class="albot-k">Suspendiert</span><div class="albot-v">${classSkills.suspended ? 'JA · '+esc(classSkills.suspendedReason || '-') : 'NEIN'}</div></div>
</div>
<div class="albot-small" style="margin-top:8px">Letzter Skill: ${classSkills.lastUse ? esc(classSkills.lastUse.skillId)+' · '+esc(classSkills.lastUse.state)+' · '+esc(classSkills.lastUse.reason || '-') : 'noch keiner'}</div>
</div>

<div class="albot-card"><b>Manuelle H6-Session</b>
<div class="albot-row"><input id="albot-combat-type" placeholder="Monster-Typ optional, z.B. goo"><input id="albot-combat-maxattack" type="number" min="0" step="1" placeholder="Max. Monster-Angriff optional"></div>
<div class="albot-row"><label class="albot-small"><input id="albot-combat-kiting" type="checkbox"> Kiting-Grundlage aktivieren</label></div>
<div class="albot-row"><button id="albot-combat-start" class="albot-btn" ${combat.active ? 'disabled' : ''}>Combat starten</button><button id="albot-combat-stop" class="albot-btn warn" ${combat.active ? '' : 'disabled'}>Combat stoppen</button></div>
<div class="albot-small">Sichere sichtbare Kandidaten: ${candidates.length ? candidates.map(row => esc(row.mtype || row.name || row.id)+' ('+esc(row.distance == null ? '?' : Math.round(row.distance))+')').join(', ') : 'keine'}</div>
</div>

<div class="albot-card"><b>Letztes Ergebnis</b><div class="albot-log">${esc(resultText)}</div></div>`;

      const run = fn => {
        try { this.combatResult = fn(); }
        catch (error) { this.combatResult = { accepted: false, reason: String(error && error.message || error) }; }
        this.renderCombat(this.runtime.status());
      };

      const start = panel.querySelector('#albot-combat-start');
      if (start) start.onclick = () => {
        const type = panel.querySelector('#albot-combat-type').value.trim();
        const maxRaw = panel.querySelector('#albot-combat-maxattack').value;
        const kiting = panel.querySelector('#albot-combat-kiting').checked;
        run(() => this.runtime.combat.startSession({
          owner: 'gui-h6-combat',
          monsterType: type || undefined,
          maxAttack: maxRaw === '' ? undefined : Number(maxRaw),
          kiting
        }));
      };
      const stop = panel.querySelector('#albot-combat-stop');
      if (stop) stop.onclick = () => run(() => this.runtime.combat.stopSession('GUI_COMBAT_STOP'));
    }

    renderParty(status) {
      const panel = this.host.querySelector('#albot-panel-party');
      if (!panel) return;
      const partyStatus = status.party || {};
      const party = partyStatus.party || {};
      const focus = partyStatus.focus || {};
      const support = partyStatus.support || {};
      const metrics = partyStatus.metrics || {};
      const members = Array.isArray(party.members) ? party.members : [];
      panel.innerHTML = `<div class="albot-card"><b>H7 Party</b>
<div class="albot-small">Koordination ist nur aktiv, wenn mindestens zwei eigene Party-Mitglieder erkannt wurden und kein fremdes Mitglied enthalten ist. Focus Fire basiert auf frischen sichtbaren Targets; Healing/Revive laufen nur über bestätigte Live-Readiness.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Party</span><div class="albot-v">${party.available ? esc(party.size)+' Mitglieder' : 'keine'}</div></div>
<div><span class="albot-k">Koordination</span><div class="albot-v">${party.coordinationEnabled ? 'AKTIV' : 'BLOCKIERT / SOLO'}</div></div>
<div><span class="albot-k">Leader</span><div class="albot-v">${esc(party.leader || '-')}</div></div>
<div><span class="albot-k">Lokale Rolle</span><div class="albot-v">${esc(party.localRole || '-')}</div></div>
<div><span class="albot-k">Focus Target</span><div class="albot-v">${esc(focus.targetId || '-')}</div></div>
<div><span class="albot-k">Focus Quelle</span><div class="albot-v">${esc(focus.source || '-')}</div></div>
<div><span class="albot-k">Support</span><div class="albot-v">${support.suspended ? 'SUSPENDIERT' : support.pending ? 'PENDING' : 'bereit'}</div></div>
<div><span class="albot-k">Support bestätigt</span><div class="albot-v">${esc(metrics.supportConfirmed || 0)}</div></div>
</div></div>
<div class="albot-card"><b>Party-Mitglieder & Rollen</b>
${members.length ? members.map(member => '<div class="albot-small"><b>'+esc(member.name)+'</b> · '+esc(member.ctype || '?')+' · '+esc(member.role || 'UNKNOWN')+' · '+(member.owned ? 'OWNED' : 'FOREIGN')+' · '+(member.rip ? 'DOWN' : member.hpRatio == null ? 'HP ?' : 'HP '+esc(Math.round(member.hpRatio*100))+'%')+' · Target '+esc(member.targetId || '-')+'</div>').join('') : '<div class="albot-small">Keine Party-Mitglieder erkannt.</div>'}
</div>
<div class="albot-card"><b>Support / Recovery</b>
<div class="albot-small">Party-Buffs/Auras aus Live-Skills: ${partyStatus.partyBuffSkills && partyStatus.partyBuffSkills.length ? partyStatus.partyBuffSkills.map(esc).join(', ') : 'keine für lokale Klasse erkannt'}</div>
<div class="albot-small">Heal Dispatches: ${esc(metrics.healsDispatched || 0)} · Party Heal: ${esc(metrics.partyHealsDispatched || 0)} · Revive: ${esc(metrics.revivesDispatched || 0)} · UNKNOWN: ${esc(metrics.supportUnknown || 0)}</div>
${party.foreignMemberNames && party.foreignMemberNames.length ? '<div class="albot-small albot-bad">Fremde Party-Mitglieder blockieren automatische Koordination: '+party.foreignMemberNames.map(esc).join(', ')+'</div>' : ''}
${support.suspended ? '<div class="albot-small albot-bad">Support suspendiert: '+esc(support.suspendedReason || '-')+'</div>' : ''}
</div>`;
    }

    async runRecommendedLiveTest() {
      const state = this.runtime.status();
      if (state.emergencyStop && state.emergencyStop.latched) {
        this.runtime.logger.warn('Live-Test durch globalen STOP blockiert');
        this.activeTab = 'live-test';
        this._selectTab();
        this.renderLiveTest(state);
        return null;
      }
      this.activeTab = 'live-test';
      this._selectTab();
      this.liveTestClipboard = { pending: true, copied: false, error: null };
      this.render();
      let result = null;
      try {
        result = await this.runtime.liveTests.startRecommended();
      } catch (error) {
        this.runtime.logger.error('Live-Test konnte nicht gestartet werden', { error: String(error && error.message || error) });
      }
      const copy = await this.copyDiagnostics();
      this.liveTestClipboard = { pending: false, copied: copy.copied === true, error: copy.error || null };
      this.render();
      return result;
    }

    renderLiveTest(status) {
      const panel = this.host.querySelector('#albot-panel-live-test');
      if (!panel) return;
      const tests = status.liveTests || {};
      const recommended = tests.recommended || null;
      const run = tests.current || tests.lastRun || null;
      const running = tests.running === true;
      const state = run ? run.state : 'BEREIT';
      const stateClass = state === 'PASSED' ? 'albot-ok' : (state === 'FAILED' || state === 'CANCELLED' ? 'albot-bad' : '');
      const clipboard = this.liveTestClipboard;
      const clipboardText = clipboard == null
        ? 'Nach Testende wird der vollständige Fehlerbericht automatisch in die Zwischenablage kopiert.'
        : clipboard.copied
          ? 'Test beendet · Fehlerbericht automatisch in die Zwischenablage kopiert.'
          : clipboard.pending
            ? 'Test läuft · Bericht wird nach Abschluss automatisch kopiert.'
            : 'Test beendet · automatische Zwischenablage-Kopie fehlgeschlagen: ' + esc(clipboard.error || 'unbekannt');

      const steps = run && Array.isArray(run.steps) ? run.steps : recommended && Array.isArray(recommended.steps)
        ? recommended.steps.map(step => ({ ...step, state: 'PENDING' }))
        : [];

      panel.innerHTML = `<div class="albot-card"><b>Ein-Klick-Live-Test</b>
<div class="albot-small">Ab H5 laufen Live-Tests automatisch als definierte Schrittfolge. Du musst nur „Test starten“ drücken. Bei einem Fehler wird fail-safe abgebrochen; der globale rote STOP bleibt jederzeit verfügbar.</div>
<div class="albot-grid" style="margin-top:8px">
<div><span class="albot-k">Testsuite</span><div class="albot-v">${recommended ? esc(recommended.title) : 'noch nicht registriert'}</div></div>
<div><span class="albot-k">Status</span><div class="albot-v ${stateClass}">${esc(state)}</div></div>
<div><span class="albot-k">Aktueller Schritt</span><div class="albot-v">${run && run.currentStepId ? esc(run.currentStepId) : '-'}</div></div>
<div><span class="albot-k">Runtime</span><div class="albot-v">${status.running ? 'RUNNING' : 'STOPPED'}</div></div>
</div>
<div class="albot-row"><button id="albot-live-test-start" class="albot-btn" ${running || !recommended ? 'disabled' : ''}>Test starten</button>${running ? '<span class="albot-small">Test läuft automatisch …</span>' : ''}</div>
<div class="albot-small ${clipboard && clipboard.copied ? 'albot-ok' : clipboard && !clipboard.pending ? 'albot-bad' : ''}">${clipboardText}</div>
</div>

<div class="albot-card"><b>Testschritte</b>
${steps.length ? steps.map((step, index) => {
  const stepClass = step.state === 'PASSED' ? 'albot-ok' : (step.state === 'FAILED' || step.state === 'CANCELLED' ? 'albot-bad' : 'albot-muted');
  const details = step.error ? ' · '+esc(step.error.message || step.error) : step.result != null ? ' · '+esc(JSON.stringify(step.result)) : '';
  return '<div class="'+stepClass+'">'+esc(index + 1)+'. '+esc(step.title || step.id)+' — '+esc(step.state || 'PENDING')+details+'</div>';
}).join('') : '<div class="albot-small">Für den aktuellen Entwicklungsstand ist noch keine Live-Testsuite registriert.</div>'}
</div>

${run ? `<div class="albot-card"><b>Letztes Testergebnis</b>
<div class="${stateClass}"><b>${state === 'PASSED' ? 'TEST BEENDET – BESTANDEN' : state === 'RUNNING' ? 'TEST LÄUFT' : 'TEST BEENDET – '+esc(state)}</b></div>
<div class="albot-small">Grund: ${esc(run.reason || '-')}</div>
<div class="albot-small">Start: ${esc(run.startedAt || '-')} · Ende: ${esc(run.finishedAt || '-')}</div>
</div>` : ''}`;

      const start = panel.querySelector('#albot-live-test-start');
      if (start) start.onclick = () => this.runRecommendedLiveTest();
    }

    renderKnowledge(status) {
      const panel = this.host.querySelector('#albot-panel-knowledge');
      if (!panel) return;
      const knowledge = status.knowledge || {};
      const provider = knowledge.provider || {};
      const lkg = knowledge.lastKnownGood || null;
      const error = knowledge.lastRefreshError || provider.lastError || null;
      panel.innerHTML = `<div class="albot-card"><b>Windows Bridge Knowledge</b>
<div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Provider</span><div class="albot-v">${esc(provider.name || 'nicht konfiguriert')}</div></div>
<div><span class="albot-k">Status</span><div class="albot-v">${esc(provider.state || 'IDLE')}</div></div>
<div><span class="albot-k">Modus</span><div class="albot-v">${esc(provider.mode || '-')}</div></div>
<div><span class="albot-k">Read-only</span><div class="albot-v">${provider.readOnly === true ? 'JA' : 'unbekannt'}</div></div>
<div><span class="albot-k">Bridge-Handoff</span><div class="albot-v">${provider.handoffAvailable ? 'verfügbar' : 'nicht verfügbar'}</div></div>
<div><span class="albot-k">Mirror</span><div class="albot-v">${esc(provider.repository || '-')} · ${esc(provider.ref || '-')}</div></div>
</div>
<div class="albot-row"><button id="albot-knowledge-refresh" class="albot-btn">Knowledge aktualisieren</button></div>
${error ? '<div class="albot-small albot-bad">Letzter Refresh: '+esc(error)+'</div>' : '<div class="albot-small">Kein Knowledge-Fehler gemeldet.</div>'}
</div>
<div class="albot-card"><b>Last Known Good</b>
${lkg ? `<div class="albot-grid" style="margin-top:6px">
<div><span class="albot-k">Generation</span><div class="albot-v">${esc(lkg.generation)}</div></div>
<div><span class="albot-k">Quelle</span><div class="albot-v">${esc(lkg.source || '-')}</div></div>
<div><span class="albot-k">Fakten</span><div class="albot-v">${esc(lkg.factCount == null ? 0 : lkg.factCount)}</div></div>
<div><span class="albot-k">Alter</span><div class="albot-v">${lkg.ageMs == null ? '-' : esc(Math.round(lkg.ageMs / 1000))+' s'}</div></div>
</div><div class="albot-small" style="margin-top:6px">Snapshot: ${esc(lkg.snapshotSha256 || '-')}</div>` : '<div class="albot-small">Noch kein validierter Snapshot gespeichert. Das ist zulässig, solange die Bridge bzw. ihr GitHub-Spiegel noch keinen Snapshot bereitstellt.</div>'}
</div>`;

      const refresh = panel.querySelector('#albot-knowledge-refresh');
      if (refresh) refresh.onclick = async () => {
        refresh.disabled = true;
        refresh.textContent = 'Aktualisiere ...';
        await this.runtime.knowledge.refresh();
        this.renderKnowledge(this.runtime.status());
      };
    }

    renderLogs() {
      if (!this.host) return;
      const panel = this.host.querySelector('#albot-panel-logs');
      const lines = this.runtime.logger.list(100).map(x => `[${x.at}] ${x.level} ${x.message}${x.data == null ? '' : ' '+JSON.stringify(x.data)}`).join('\n');
      panel.innerHTML = `<div class="albot-card"><b>Logs</b><div class="albot-log">${esc(lines || 'Noch keine Logs.')}</div></div>`;
    }

    renderDev(status) {
      const panel = this.host.querySelector('#albot-panel-dev');
      const scheduler = status.scheduler || {};
      const resultText = this.devResult ? JSON.stringify(this.devResult, null, 2) : 'H7 Party · ' + status.version;
      panel.innerHTML = `<div class="albot-card"><b>Entwicklung</b>
<div class="albot-row"><button id="albot-selftest" class="albot-btn">Selftest</button><button id="albot-stability-test" class="albot-btn">H2 Runtime-Test</button><button id="albot-reset-stop" class="albot-btn danger">STOP zurücksetzen</button><button id="albot-show" class="albot-btn">GUI anzeigen</button></div>
<div class="albot-small">Scheduler: ${scheduler.enabled ? 'ACTIVE' : 'STOPPED'} · Ressourcen: ${esc(scheduler.totalResources || 0)} · Generation: ${esc(scheduler.generation || 0)} · Boot: #${esc(status.bootCount || 1)}</div>
<div id="albot-selftest-result" class="albot-log" style="margin-top:8px;max-height:220px">${esc(resultText)}</div></div>`;
      panel.querySelector('#albot-selftest').onclick = () => {
        this.devResult = this.runtime.selfTest();
        this.renderDev(this.runtime.status());
      };
      panel.querySelector('#albot-stability-test').onclick = async () => {
        this.devResult = { running: true, message: 'H2 Runtime-Test läuft ...' };
        this.renderDev(this.runtime.status());
        this.devResult = await this.runtime.runStabilityProbe();
        this.renderDev(this.runtime.status());
      };
      panel.querySelector('#albot-reset-stop').onclick = () => { this.runtime.resetEmergencyStop(); this.render(); };
      panel.querySelector('#albot-show').onclick = () => { this.host.style.display = 'block'; };
    }

    async copyDiagnostics() {
      const text = JSON.stringify(this.runtime.diagnostics(), null, 2);
      try {
        const nav = this.uiRoot && this.uiRoot.navigator || this.root.navigator;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          await nav.clipboard.writeText(text);
        } else {
          const area = this.doc.createElement('textarea'); area.value = text; area.style.position='fixed'; area.style.opacity='0'; this.doc.body.appendChild(area); area.select(); this.doc.execCommand('copy'); area.remove();
        }
        this.runtime.logger.info('Fehlerbericht in Zwischenablage kopiert');
        this.renderLogs();
        return { copied: true, text, error: null };
      } catch (e) {
        this.runtime.logger.error('Clipboard-Kopie fehlgeschlagen', { error: e.message });
        this.renderLogs();
        return { copied: false, text, error: String(e && e.message || e) };
      }
    }

    show() { if (this.host) this.host.style.display = 'block'; }
    hide() { if (this.host) this.host.style.display = 'none'; }
    destroy() {
      if (this.interval != null) { try { (this.intervalRoot || this.root).clearInterval(this.interval); } catch (_) {} this.interval = null; }
      if (this._offLog) { try { this._offLog(); } catch (_) {} this._offLog = null; }
      if (this._dragCleanup) { try { this._dragCleanup(); } catch (_) {} this._dragCleanup = null; }
      const old = this.doc && this.doc.getElementById('albot-control-center');
      if (old) old.remove();
      this.host = null;
    }
  }

  ns.ControlCenter = ControlCenter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
