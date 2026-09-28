(function (root) {
  'use strict';

  const ns = root.__ALBOT_INTERNALS__;
  if (!ns || !ns.ControlCenter) return;

  const Base = ns.ControlCenter;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  class AdvancedControlCenter extends Base {
    _shell() {
      let html = super._shell();
      html = html.replace(
        '<button class="albot-tab" data-tab="full-autonomy">Full Live</button>',
        '<button class="albot-tab" data-tab="full-autonomy">Full Live</button><button class="albot-tab" data-tab="encounters">Bosse & Events</button><button class="albot-tab" data-tab="market-intelligence">Markt</button>'
      );
      html = html.replace(
        '<section id="albot-panel-live-test" class="albot-panel"></section>',
        '<section id="albot-panel-encounters" class="albot-panel"></section><section id="albot-panel-market-intelligence" class="albot-panel"></section><section id="albot-panel-live-test" class="albot-panel"></section>'
      );
      return html;
    }

    _bind() {
      super._bind();
      const encounterPanel = this.host.querySelector('#albot-panel-encounters');
      if (encounterPanel) {
        encounterPanel.addEventListener('change', event => {
          const target = event.target;
          if (!target || !target.dataset || !target.dataset.encounterId) return;
          this.runtime.encounters.setEnabled(target.dataset.encounterKind, target.dataset.encounterId, target.checked === true);
          this.renderEncounters();
        });
        encounterPanel.addEventListener('click', event => {
          const target = event.target;
          if (!target || !target.dataset || !target.dataset.encounterAll) return;
          this.runtime.encounters.setAll(target.dataset.encounterKind, target.dataset.encounterAll === 'on');
          this.renderEncounters();
        });
      }

      const marketPanel = this.host.querySelector('#albot-panel-market-intelligence');
      if (marketPanel) {
        marketPanel.addEventListener('click', async event => {
          const target = event.target;
          if (!target || !target.dataset) return;
          if (target.dataset.marketRefresh === '1') {
            await this.runtime.marketIntelligence.refresh();
            this.renderMarketIntelligence();
          }
          if (target.dataset.standToggle === '1') {
            const current = this.runtime.merchantStand.status();
            this.runtime.merchantStand.configure({ autoManage: current.autoManage !== true });
            this.renderMarketIntelligence();
          }
        });
      }
    }

    _tick() {
      super._tick();
      if (this.activeTab === 'encounters') this.renderEncounters();
      if (this.activeTab === 'market-intelligence') this.renderMarketIntelligence();
    }

    render() {
      super.render();
      this.renderEncounters();
      this.renderMarketIntelligence();
    }

    renderEncounters() {
      if (!this.host || !this.runtime.encounters) return;
      const panel = this.host.querySelector('#albot-panel-encounters');
      if (!panel) return;
      const status = this.runtime.encounters.status();
      const catalog = status.catalog || { bosses: [], events: [] };
      const renderRows = (kind, rows) => {
        if (!rows.length) return '<div class="albot-small">Noch keine Einträge erkannt.</div>';
        return rows.map(row => '<label class="albot-row" style="align-items:flex-start">'
          + '<input type="checkbox" style="flex:0 0 auto;margin-top:2px" data-encounter-kind="' + esc(kind) + '" data-encounter-id="' + esc(row.id) + '"' + (row.enabled ? ' checked' : '') + '>'
          + '<span><b>' + esc(row.name || row.id) + '</b> <span class="' + (row.active ? 'albot-ok' : 'albot-muted') + '">' + (row.active ? 'AKTIV' : 'inaktiv') + '</span>'
          + '<div class="albot-small">' + esc(row.id) + (row.map ? ' · ' + esc(row.map) : '') + ' · ' + esc(row.source || '-') + '</div></span></label>').join('');
      };

      panel.innerHTML = '<div class="albot-card"><b>Encounter-Steuerung</b>'
        + '<div class="albot-small" style="margin-top:5px">Neue Bosse und Events sind standardmäßig eingeschaltet. Die Auswahl wird lokal gespeichert.</div>'
        + '<div class="albot-grid" style="margin-top:8px"><div><span class="albot-k">Autonomie</span><div class="albot-v">' + esc(status.autonomyEnabled ? 'AKTIV' : 'Bereit') + '</div></div>'
        + '<div><span class="albot-k">Aktueller Plan</span><div class="albot-v">' + esc(status.lastPlan && (status.lastPlan.taskType + ' / ' + (status.lastPlan.selected && status.lastPlan.selected.name || status.lastPlan.reason)) || '-') + '</div></div></div></div>'
        + '<div class="albot-card"><div class="albot-row"><b style="flex:1">Events</b><button class="albot-btn" data-encounter-kind="event" data-encounter-all="on">Alle an</button><button class="albot-btn" data-encounter-kind="event" data-encounter-all="off">Alle aus</button></div>'
        + renderRows('event', catalog.events || []) + '</div>'
        + '<div class="albot-card"><div class="albot-row"><b style="flex:1">Bosse</b><button class="albot-btn" data-encounter-kind="boss" data-encounter-all="on">Alle an</button><button class="albot-btn" data-encounter-kind="boss" data-encounter-all="off">Alle aus</button></div>'
        + renderRows('boss', catalog.bosses || []) + '</div>';
    }

    renderMarketIntelligence() {
      if (!this.host || !this.runtime.marketIntelligence || !this.runtime.merchantStand) return;
      const panel = this.host.querySelector('#albot-panel-market-intelligence');
      if (!panel) return;
      const market = this.runtime.marketIntelligence.status();
      const stand = this.runtime.merchantStand.status();
      const telemetry = this.runtime.telemetry ? this.runtime.telemetry.status() : null;
      const overview = this.runtime.marketIntelligence.overview(12);
      const rows = overview.map(row => '<tr><td>' + esc(row.itemName) + (row.level ? ' +' + esc(row.level) : '') + '</td><td>' + esc(row.sampleCount || 0) + '</td><td>' + esc(row.bestAsk && row.bestAsk.price || '-') + '</td><td>' + esc(row.bestBid && row.bestBid.price || '-') + '</td><td>' + esc(row.recommendedAsk || '-') + '</td><td>' + esc(row.confidence) + '</td></tr>').join('');

      panel.innerHTML = '<div class="albot-card"><b>Market Intelligence</b><div class="albot-grid" style="margin-top:6px">'
        + '<div><span class="albot-k">Quelle</span><div class="albot-v">ALData · read-only/advisory</div></div>'
        + '<div><span class="albot-k">Letzter Snapshot</span><div class="albot-v">' + esc(market.fetchedAt || 'noch keiner') + '</div></div>'
        + '<div><span class="albot-k">Listings</span><div class="albot-v">' + esc(market.listings) + '</div></div>'
        + '<div><span class="albot-k">Fehler</span><div class="albot-v">' + esc(market.lastError && market.lastError.reason || '-') + '</div></div></div>'
        + '<div class="albot-row"><button class="albot-btn" data-market-refresh="1">ALData jetzt aktualisieren</button></div></div>'
        + '<div class="albot-card"><b>Merchant-Stand</b><div class="albot-small">Automatische Mutationen sind absichtlich standardmäßig AUS. Es werden ausschließlich explizite H10-SELL-Items verwaltet. Bestehende eigene Listings werden bei einer ausreichend großen Preisabweichung kontrolliert UNLIST → live bestätigt → RELIST; unklare Ausgänge suspendieren den Auto-Stand.</div>'
        + '<div class="albot-row"><button class="albot-btn ' + (stand.autoManage ? 'warn' : '') + '" data-stand-toggle="1">' + (stand.autoManage ? 'Auto-Stand ausschalten' : 'Auto-Stand einschalten') + '</button><span>' + esc(stand.suspendedReason || stand.lastPlan && stand.lastPlan.reason || 'bereit') + '</span></div><div class="albot-small">Listings: ' + esc(stand.listingsThisSession || 0) + ' · Reprices: ' + esc(stand.repricesThisSession || 0) + ' · Mindestabweichung: ' + esc(Math.round(Number(stand.config && stand.config.repriceMinDeltaRatio || 0) * 100)) + '%</div></div>'
        + '<div class="albot-card"><b>Preis-Signale</b><div style="overflow:auto;margin-top:6px"><table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Item</th><th>Samples</th><th>Ask</th><th>Bid</th><th>Empfehlung</th><th>Signal</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="albot-muted">Noch keine Marktdaten.</td></tr>') + '</tbody></table></div></div>'
        + '<div class="albot-card"><b>Telemetry Host</b><div class="albot-grid" style="margin-top:6px"><div><span class="albot-k">Endpoint</span><div class="albot-v">' + esc(telemetry && telemetry.endpoint || '-') + '</div></div><div><span class="albot-k">SSD-Ziel</span><div class="albot-v">D:/ALBot/telemetry</div></div><div><span class="albot-k">Queue</span><div class="albot-v">' + esc(telemetry && telemetry.queueLength || 0) + '</div></div><div><span class="albot-k">Letzter Erfolg</span><div class="albot-v">' + esc(telemetry && telemetry.lastSuccessAt || '-') + '</div></div></div></div>';
    }
  }

  ns.ControlCenter = AdvancedControlCenter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
