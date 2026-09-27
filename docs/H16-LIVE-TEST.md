# H16 – Exchange & Craft Live-Test

Stand: 2026-09-27

H16 erweitert den gemergten H15-Stand um Exchange, Crafting, Produktionsgraph und explizite Materialbeschaffung.

## Implementierter Scope

- eigener `ExchangeCraftController`
- Exchange und Craft ausschließlich über die zentrale ActionBoundary
- Exchange-Mengen aus Live-`G.items[*].e`
- Craft-Rezepte aus Live-`G.craft`
- Quest-/Event-Exchange und Quest-/Event-Craft standardmäßig fail-closed
- explizites Opt-in für Quest-/Event-Aktionen
- protected Items (`locked`, `gift`, `giveaway`, expiring) aus Automatisierung ausgeschlossen
- Craft-Quellslotwahl entspricht Adventure Lands `auto_craft`: erster passender Stack mit ausreichender Menge
- Quellslots und Definitionen unmittelbar vor Dispatch erneut validiert
- Exchange-Value-at-Risk-Budget
- Craft-Goldkosten-Budget
- Craft-Input-Value-at-Risk-Budget
- Goldreserve
- Session-Attempt-Budget
- Combat-Block
- Movement-Ownership `exchange-craft-h16`
- Outcome-Bestätigung ausschließlich über beobachtete Live-Deltas
- UNKNOWN -> Suspension ohne Blind-Retry
- rekursiver Produktionsgraph mit Cycle-/Depth-Guard
- Produktionsplanung nutzt lokales Inventar und optional gemounteten Bankbestand
- fehlende Materialien zeigen Bank-, NPC- und Marktquellen
- explizite Materialbeschaffung delegiert an H12 Bank oder H13 Handel
- gemeinsamer autonomer Economy-Konfliktlöser bleibt H17
- Headless API `ALBot.exchangeCraft.*`
- Control-Center-Tab **Exchange & Craft**
- Ein-Klick-Suite `h16-exchange-craft`

## Ergebnis-Wahrheit

Promise-/API-Erfolg allein ist kein bestätigtes Ergebnis.

### Exchange bestätigt

Erforderlich:

- die erwartete Exchange-Quellmenge sinkt live um mindestens `G.items[item].e`;
- Item-Name und Level werden exakt beobachtet.

### Craft bestätigt

Erforderlich:

- Output-Menge steigt live um mindestens 1;
- jede Recipe-Zutat sinkt live um die geforderte Menge;
- bei Recipe-Goldkosten sinkt Character-Gold mindestens um diese Kosten.

### UNKNOWN

Wenn innerhalb des bounded Outcome-Timeouts keine belastbare Live-Evidence entsteht:

- passende UNKNOWN-Metrik steigt;
- H16 suspendiert;
- Request/Pending wird verworfen;
- kein automatischer Retry.

## Produktionsgraph

`productionPlan(itemName, quantity)`:

- verbraucht zuerst vorhandenen lokalen Bestand;
- berücksichtigt optional gemounteten Bankbestand;
- expandiert fehlende craftbare Zwischenprodukte rekursiv;
- begrenzt Tiefe;
- blockiert Zyklen;
- blockiert Quest-/Event-Rezepte ohne explizites Opt-in;
- liefert geordnete Craft-Stufen;
- meldet fehlende Leaf-Materialien mit vorhandenen Bank-, NPC- und Marktquellen.

Die eigentliche gemeinsame autonome Auswahl zwischen Bank, Markt und anderen Economy-Modulen folgt in H17.

## Ein-Klick-Live-Test

Suite:

`h16-exchange-craft`

Die Suite startet eine zuvor gestoppte Runtime automatisch und stellt den vorherigen Runtime-Zustand am Ende wieder her.

### Temporäre Live-Test-Policy

- maximal 2 echte H16-Aktionen (Craft + Exchange);
- Exchange-Value-at-Risk maximal 20.000 Gold;
- Craft-Goldkosten maximal 10.000 Gold;
- Craft-Input-Value-at-Risk maximal 20.000 Gold;
- Goldreserve 10.000 Gold;
- fehlende direkte Craft-Materialien dürfen nur beschafft werden, wenn höchstens 2 Leaf-Materialien fehlen;
- Materialbeschaffung maximal 10.000 Gold gesamt;
- nur Level-0-Materialien im automatischen Beschaffungsfallback;
- Beschaffung im Live-Test explizit über H13 Trade (`allowBank:false`);
- Quest-/Event-Aktionen deaktiviert;
- Produktionsgraph-Tiefe maximal 6.

### Kandidatenwahl

Bevorzugt wird:

`CRAFT_TO_EXCHANGE_CHAIN`

Dabei wird ein niedrig riskantes Item gecraftet, dessen Output anschließend direkt exchangebar ist.

Falls keine solche direkte Kette vorhanden ist, ist zulässig:

`CRAFT_AND_EXCHANGE_COVERAGE`

Dabei werden ein bereits lokal ausführbarer niedrig riskanter Craft und ein davon itemseitig disjunkter niedrig riskanter Exchange in derselben Suite getestet.

Wenn kein lokaler Craft bereit ist, kann v2 verwenden:

`ACQUIRE_CRAFT_AND_EXCHANGE_COVERAGE`

Dafür gilt zusätzlich:
- direkte Recipe-Stufe, keine verschachtelte Produktionskette;
- höchstens 2 fehlende Leaf-Materialien;
- nur Level 0;
- jedes fehlende Material braucht eine live sichtbare NPC-Quelle oder einen ausreichend großen sichtbaren Market-Ask;
- Materialbeschaffung zusammen höchstens 10.000 Gold;
- Craft-Input-Risiko weiterhin höchstens 20.000 Gold;
- Materialkäufe laufen über H16 → H13 mit explizitem Max-Unit-Price;
- H13-UNKNOWN bleibt ein harter FAIL.

Fehlt ein sicherer Exchange-Kandidat:

`H16_NEEDS_LOW_RISK_EXCHANGE_CANDIDATE`

Fehlt trotz Beschaffungsfallback ein sicherer Craft-Pfad:

`H16_NEEDS_LOW_RISK_CRAFT_OR_ACQUIRABLE_MATERIALS`

In beiden Fällen erfolgt **keine weitere Mutation**.

## Schritte

1. **Preflight**
   - Character verfügbar und lebendig;
   - H16-Modul ACTIVE;
   - `auto_craft`- und `exchange`-API verfügbar;
   - sichere Kandidaten innerhalb der Live-Test-Budgets;
   - keine Quest-/Event-Aktion.

2. **Planning**
   - lokaler Produktionsplan ist entweder `READY` oder exakt `NEEDS_MATERIALS` für den begrenzten Fallback;
   - keine geschützten Rezepte;
   - Materialbudget und Live-Test-Policy aktiv.

3. **Materials**
   - nur falls nötig;
   - fehlende Materialien einzeln via H16 → H13 beschaffen;
   - explizites `maxUnitPrice`;
   - kein H13-UNKNOWN;
   - danach muss der Produktionsplan `READY` sein.

4. **Craft**
   - exakt eine echte Craft-Aktion;
   - Erfolg nur durch Output-/Input-/Gold-Live-Deltas.

5. **Exchange**
   - exakt eine echte Exchange-Aktion;
   - Erfolg nur durch Quellmengen-Live-Delta.

6. **Stability**
   - fünf Sekunden;
   - exakt zwei H16-Session-Versuche;
   - Exchange-UNKNOWN-Delta 0;
   - Craft-UNKNOWN-Delta 0;
   - Material-Trade-UNKNOWN-Delta 0;
   - keine H16- oder H13-Suspension;
   - kein Pending;
   - kein Request.

7. **Cleanup**
   - kein H16/H13 Pending oder Request;
   - temporäre Policy wird im Suite-Cleanup wiederhergestellt;
   - vorheriger Runtime-Zustand wird wiederhergestellt.

## Erwartete PASS-Evidence

- Runtime `0.16.0-h16`
- Suite `h16-exchange-craft`
- `PASSED / ALL_STEPS_PASSED`
- Preflight PASSED
- Planning PASSED
- Materials PASSED
- Craft PASSED
- Exchange PASSED
- Stability PASSED
- Cleanup PASSED
- bei nötiger Beschaffung: eindeutig bestätigte H13-Acquisition(s) innerhalb des 10.000-Gold-Gesamtbudgets
- `craftsConfirmed=1` Delta
- `exchangesConfirmed=1` Delta
- Exchange-, Craft- und Material-Trade-UNKNOWN-Deltas 0
- genau zwei H16-Session-Versuche
- keine Suspension
- kein Pending/Request
- bei zuvor gestoppter Runtime anschließend wieder STOPPED und Scheduler `totalResources=0`.

H16 darf erst nach grünem Exact-Head-CI, sauberem Review-Gate und echtem Adventure-Land-Live-PASS gemergt werden.


## Pre-Live CI / Review Evidence

H16-Hardening vor dem echten Adventure-Land-Live-Test:

- PR: `#17 – H16: Exchange & Craft`
- technischer Head vor dieser Evidence-Dokumentation: `a8384e031efbbf0441234928f8e7ddc704ff3031`
- Exact-Head-CI Run `#342`: **completed / success**
- `npm test`: **209/209 PASS, 0 FAIL, 0 SKIP**
- `dist/al-bot.js` enthält exakt den aktuellen `src/exchange-craft.js`-Block
- `dist/al-bot.js` enthält exakt den aktuellen `src/ui.js`-Block
- Bundle-Banner: `AL Bot 0.16.0-h16`
- Build-Pipeline enthält `src/exchange-craft.js`
- alle bisherigen PR-Review-Threads resolved
- kein `CHANGES_REQUESTED`
- Branch `behind_by=0`
- PR `mergeable=true`

Im Review und eigenen Safety-Review gefunden und behoben:

1. ein erfolgreich dispatchter Write mit anschließend abgelehntem Promise durfte nicht als bekannte Ablehnung behandelt werden – wird jetzt als UNKNOWN suspendiert, solange keine autoritative Live-Evidence vorliegt;
2. Movement muss vor Exchange/Craft als eigener H16-Order **COMPLETED / ARRIVAL_VERIFIED** sein – CANCELLED/STUCK/UNKNOWN/FAILED_SAFE führt nicht zum Dispatch;
3. Exchange-Outcome-Evidence bewahrt den tatsächlichen Item-Level statt implizit Level 0 anzunehmen;
4. Quest-/Event-Kandidaten sind im Control Center sichtbar, aber weiterhin nur nach explizitem Opt-in ausführbar;
5. der Cross-Realm-Regressionstest wurde auf wertbasierte Serialisierung umgestellt;
6. der Combat-Test bestätigt nun korrekt, dass der Block bereits vor jedem Movement-Start erfolgt.

Zusätzliche Regressionen decken Promise-UNKNOWN, Movement-Terminalzustände, leveled Exchange-Evidence und die vollständige H16-Wiring-Kette ab.

Nach diesem Evidence-Commit ist erneut ein Exact-Head-CI erforderlich. Erst wenn auch dieser neue Head `completed/success`, `behind_by=0`, review-clean und mergeable ist, darf der echte H16-Live-Test freigegeben werden.


## Live-Versuch 1 – sauberer Preflight-Abbruch

Zeitpunkt: 2026-09-27T10:18:01Z

Der erste echte H16-Live-Versuch wurde **vor jeder H16-Mutation** beendet:

- Runtime `0.16.0-h16`;
- Suite `h16-exchange-craft`;
- Ergebnis `FAILED`;
- Reason `H16_NEEDS_LOW_RISK_CRAFT_AND_EXCHANGE_CANDIDATES`;
- nur Preflight lief und FAILte;
- Planning/Craft/Exchange/Stability/Cleanup-Schritte wurden nicht ausgeführt;
- Suite-Cleanup wurde trotzdem ausgeführt und meldete `ok=true`;
- H16 `attemptsThisSession=0`;
- `exchangesDispatched=0`;
- `craftsDispatched=0`;
- beide H16-UNKNOWN-Zähler 0;
- `movementRequests=0`;
- keine H16-Suspension;
- Runtime war vor dem Test STOPPED, wurde automatisch gestartet und danach wieder STOPPED;
- Scheduler danach `totalResources=0`, `created=12`, `cancelled=12`, `callbackErrors=0`.

Live-Inventar-/Plan-Evidence:
- 1 sicherer Exchange-Kandidat vorhanden;
- Kandidat: `anniversarygift`, Menge 153, Exchange-Menge 1, Value-at-Risk 100 Gold;
- 134 Craft-Kandidaten geprüft;
- 0 davon lokal sicher ausführbar;
- 106 mit `H16_CRAFT_MATERIAL_MISSING`;
- 28 mit `H16_QUEST_EVENT_REQUIRES_EXPLICIT_OPT_IN`.

Interpretation:
Der Fail-Closed-Pfad hat korrekt funktioniert. Die Lücke lag nicht in Safety oder Outcome-Erkennung, sondern darin, dass der Live-Test Materialbeschaffung als H16-Scope noch nicht aktiv in den Testablauf einbezogen hatte.

Daraufhin wurde Suite-Version 2 implementiert:
- begrenzter Materialbeschaffungsfallback;
- maximal zwei fehlende Level-0-Leaf-Materialien;
- maximal 10.000 Gold Materialbeschaffung;
- live sichtbare NPC- oder Market-Quelle zwingend;
- H16 delegiert explizit an H13;
- Bank wird im Testpfad mit `allowBank:false` umgangen;
- H13-UNKNOWN/Suspension ist ein harter Test-Fail;
- erst nach bestätigter Beschaffung darf Craft folgen.
