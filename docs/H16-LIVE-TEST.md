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

Aktueller Stand: **Suite-Version 5**.

Suite:

`h16-exchange-craft`

Die Suite startet eine zuvor gestoppte Runtime automatisch und stellt den vorherigen Runtime-Zustand am Ende wieder her.

### Temporäre Live-Test-Policy

- maximal 2 echte H16-Aktionen (Craft + Exchange);
- Exchange-Value-at-Risk maximal 2.000.000 Gold;
- Craft-Goldkosten maximal 1.000.000 Gold;
- Craft-Input-Value-at-Risk maximal 2.000.000 Gold;
- Goldreserve 10.000 Gold;
- fehlende direkte Craft-Materialien dürfen nur beschafft werden, wenn höchstens 2 Leaf-Materialien fehlen;
- Materialbeschaffung maximal 1.000.000 Gold gesamt;
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
- Materialbeschaffung zusammen höchstens 1.000.000 Gold;
- Craft-Input-Risiko weiterhin höchstens 2.000.000 Gold;
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
- maximal 1.000.000 Gold Materialbeschaffung;
- live sichtbare NPC- oder Market-Quelle zwingend;
- H16 delegiert explizit an H13;
- Bank wird im Testpfad mit `allowBank:false` umgangen;
- H13-UNKNOWN/Suspension ist ein harter Test-Fail;
- erst nach bestätigter Beschaffung darf Craft folgen.


## v2 Pre-Live Technical Evidence

Finaler technischer v2-Head vor den finalen Dokucommits:

`9e007bc6bfdf872ebf91ecd9f8dbf7f7c2140428`

Evidence:

- Exact-Head-CI Run `#362`: **completed / success**
- `npm test`: **213/213 PASS, 0 FAIL, 0 SKIP**
- Branch bei Prüfung `behind_by=0`
- PR #17 `mergeable=true`
- keine offenen Review-Threads
- kein `CHANGES_REQUESTED`
- `dist/al-bot.js` enthält exakt den aktuellen `src/exchange-craft.js`-Block
- `dist/al-bot.js` enthält exakt den aktuellen `src/runtime.js`-Block
- `dist/al-bot.js` enthält exakt den aktuellen `src/ui.js`-Block
- Bundle-Banner `AL Bot 0.16.0-h16`
- Build-Pipeline enthält `src/exchange-craft.js`

v2-Hardening gegenüber Live-Versuch 1:

- `queueMaterialAcquire(..., {allowBank:false})` ermöglicht im Live-Test eindeutig belegbare H16→H13-Beschaffung;
- Regression: Bank kann für den Testpfad explizit umgangen werden;
- Produktionsplan-Evidence enthält NPC- und Market-Quellen für fehlende Leaves;
- Fallback nur für direkte Rezepte mit höchstens 2 fehlenden Level-0-Leaf-Materialien;
- gesamtes Materialbeschaffungsbudget maximal 1.000.000 Gold;
- Craft-Input-Value-at-Risk weiterhin maximal 20.000 Gold;
- Exchange-Value-at-Risk weiterhin maximal 20.000 Gold;
- Craft→Exchange prüft jetzt bereits im Preflight das Risiko des erzeugten Exchange-Outputs;
- Materialbeschaffung wird nur auf Merchant und ohne bereits suspendierten H13 gestartet;
- H13-NPC-/Market-Buy-UNKNOWN ist ein harter FAIL;
- H16-UNKNOWN-Suspension wird im Suite-Cleanup **nicht automatisch zurückgesetzt**;
- Material-, Craft- und Exchange-Wechsel erhalten Anti-Pingpong-Abstand;
- kompletter v2-Wiring-/Safety-Stand ist regressionsseitig abgedeckt.

Frischer Codex-v2-Review auf Commit `3e36f6ccaa...` meldete zwei zusätzliche Punkte, beide im finalen technischen Head behoben:

1. **P1 Gesamt-Gold vor Materialkauf**  
   Vor der ersten H13-Materialmutation muss Character-Gold `Materialbeschaffung + Craft-Kosten + 10.000 Goldreserve` vollständig decken. Andernfalls wird der Kandidat bereits im Preflight verworfen.

2. **P2 mehrere Bank-Stacks**  
   `queueMaterialAcquire` darf bei recoverable H12-Rejects (`WRONG_OR_UNKNOWN_BANK_MAP`, `BANK_RESERVATION_BLOCKED`, `WITHDRAW_ITEM_NOT_FOUND`) nicht beim ersten Stack abbrechen, sondern prüft weitere passende Bank-Stacks. Nicht-recoverable Rejects wie `H12_BUSY` stoppen weiterhin fail-closed ohne parallelen Trade-Fallback.

Beide Review-Threads sind resolved. Regressionen decken recoverable Bank-Fallback, non-recoverable Bank-Stop sowie das vollständige Goldreserve-Gate ab.

Der frische Codex-v2-Review ist ausgewertet und seine beiden neuen Threads sind resolved. Nach diesen finalen Dokucommits ist noch ein neuer Exact-Head-CI erforderlich. Der zweite echte H16-Live-Test darf erst freigegeben werden, wenn dieser Doku-Head `completed/success`, `behind_by=0`, `mergeable=true`, review-clean und ohne pending/failing Checks ist.


## v2 Review Round 2 Evidence

Frischer Codex-Review auf technischem v2-Head `3e36f6ccaa34d7359e8cf7d26e5d44af942811cc` fand zwei zusätzliche Punkte:

1. **Gesamt-Golddeckung vor Materialkäufen**
   - Vor jeder Materialmutation muss bereits im Preflight gelten:
     `currentGold >= acquisitionGold + recipe.cost + goldReserve`.
   - Damit kann der Test nicht erst Materialien kaufen und anschließend wegen fehlender Craft-/Reserve-Deckung abbrechen.
   - Die gewählte Acquisition-Planung trägt `currentGold` und `requiredGoldWithReserve` als Evidence.

2. **Mehrere Bank-Stacks korrekt durchsuchen**
   - Ein recoverably unbrauchbarer erster Bank-Stack darf spätere brauchbare Stacks nicht blockieren.
   - Recoverable Gründe:
     - `H12_WITHDRAW_WRONG_OR_UNKNOWN_BANK_MAP`
     - `H12_BANK_RESERVATION_BLOCKED`
     - `H12_WITHDRAW_ITEM_NOT_FOUND`
   - Bei globalen/nicht recoverable Fehlern wie `H12_BUSY` wird **nicht** parallel auf Trade ausgewichen.
   - Neue Regressionen decken sowohl den späteren gültigen Stack als auch den Non-Recoverable-Block ab.

Nach den Fixes:

- technischer Head: `9e007bc6bfdf872ebf91ecd9f8dbf7f7c2140428`
- Exact-Head-CI Run `#362`: **completed / success**
- `npm test`: **213/213 PASS, 0 FAIL, 0 SKIP**
- Branch `behind_by=0`
- PR #17 `mergeable=true`
- beide Review-Threads resolved
- kein `CHANGES_REQUESTED`
- Bundle wieder exakt source-synchron

Ein letzter Codex-Review wurde auf Head `9e007bc6...` angefordert. Der zweite Live-Test bleibt gesperrt, bis dieser Review abgeschlossen/clean und der nachfolgenden Doku-Head-CI ebenfalls grün ist.


## Preflight-Diagnostik v5

Nach mehreren korrekt fail-closed beendeten Live-Versuchen wird der H16-Preflight ab Suite-Version 5 nicht mehr nur mit einem Sammel-Reason beendet.

Vor einem möglichen Fail schreibt der Schritt strukturierte Diagnose-Evidence in `step.details`:

- `totalCraftCandidates`
- `safeCraftCandidates`
- `safeExchangeCandidates`
- `localCraftRejects`
- `fallbackRejects`
- `topNearMatches` (maximal 5)
- aktive Caps und Strukturgrenzen

`localCraftRejects` zählt die bereits im normalen H16-Craft-Plan verworfenen Kandidaten nach ihrem vorhandenen Reason.

`fallbackRejects` differenziert den Materialbeschaffungsfallback unter anderem in:

- `QUEST_EVENT_RECIPE`
- `CRAFT_COST_OVER_CAP`
- `OUTPUT_DEFINITION_UNAVAILABLE`
- `OUTPUT_QUEST_OR_CASH_BLOCKED`
- `INPUT_RISK_UNAVAILABLE`
- `INPUT_RISK_OVER_CAP`
- `PRODUCTION_NOT_NEEDS_MATERIALS`
- `PROTECTED_RECIPE_IN_PRODUCTION`
- `NESTED_OR_MULTI_STAGE_RECIPE`
- `DIRECT_STAGE_MISMATCH`
- `NO_MISSING_LEAVES_AFTER_NEEDS_MATERIALS`
- `TOO_MANY_MISSING_LEAVES`
- `NO_DISJOINT_EXCHANGE_CANDIDATE`
- `MISSING_LEAF_LEVEL_NONZERO`
- `MISSING_LEAF_NO_NPC_OR_MARKET_SOURCE`
- `MATERIAL_ACQUISITION_OVER_CAP`
- `GOLD_RESERVE_AFTER_ACQUISITION_AND_CRAFT`
- `MATERIAL_ACQUISITION_REQUIRES_MERCHANT`
- `MATERIAL_ACQUISITION_TRADE_SUSPENDED`

`topNearMatches` zeigt die fünf Kandidaten, die dem erlaubten Pfad am nächsten kamen, inklusive relevanter Material-, Quellen-, Risiko- und Kosteninformationen.

Wichtig: Diese Änderung erweitert **nur Diagnose/Evidence**. Sie lockert keine Safety-Regel und löst keine Mutation aus. Der Preflight bleibt fail-closed.

Bei lokal bereits `READY` bewerteten Crafts, die weder als direkte Craft→Exchange-Kette noch mit einem disjunkten Exchange-Kandidaten gepaart werden können, wird `NO_DISJOINT_EXCHANGE_CANDIDATE` zusätzlich in `localCraftRejects` und `topNearMatches` erfasst. Wenn der Material-Fallback gar nicht betreten werden kann, unterscheiden `MATERIAL_ACQUISITION_REQUIRES_MERCHANT` und `MATERIAL_ACQUISITION_TRADE_SUSPENDED` den Infrastruktur-Gate vom eigentlichen Rezept-Reject.

### PR #19 – v5 technischer Gate-Stand

Append-only Evidence vom 2026-09-27:

- technischer Head: `c923147b9d3eda0d132b63d441c25c29aea525d7`
- Exact-Head-CI Run #393: **216/216 PASS, 0 FAIL, 0 SKIP, completed/success**
- frischer Codex-Review auf exakt `c923147b9d`: **keine major issues**
- alle Review-Threads resolved
- Branch beim technischen Gate: `behind_by=0`
- `src/runtime.js` im committed `dist/al-bot.js` vollständig synchron enthalten
- keine Safety-Lockerung und kein neuer Mutation-Pfad
