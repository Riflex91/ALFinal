# H14 – Gear Live-Test

Stand: 2026-09-27

H14 erweitert den live bestätigten H13-Stand um Gear-Ranking, Gear Goals, Farmer-Priorität, sichere lokale Swaps und explizite Merchant→Farmer-Gear-Delivery.

## Scope

Implementiert:

- Live-Equipment-Snapshot aus `character.slots` bzw. sichtbaren Player-Slots
- Item-/Equipment-Definitionen aus Live-`G.items`
- Klassenprofile aus Live-`G.classes`
- lokale Gear-Bewertung pro Charakterklasse
- Replacement-Planung
- Upgrade-/Compound-Kandidaten als read-only Planung für H15
- Farmer-vor-Merchant-Gruppenpriorität
- Gear Goals
- lokale Equip-/Unequip-Writes ausschließlich über ActionBoundary
- explizite Merchant→eigener-Farmer-Gear-Delivery über `send_item`
- Combat-Block
- Zwei-Hand-/Offhand-Konflikt-Schutz
- protected inventory gear (locked/gift/giveaway/expiring) aus Automation ausgeschlossen
- Bestätigung nur über beobachtete Equipment-/Inventar-Deltas
- bounded UNKNOWN + Suspension ohne Blind-Retry
- Headless API `ALBot.gear.*`
- eigener Control-Center-Tab **Gear**
- Ein-Klick-Suite `h14-gear`

Nicht Teil von H14:

- Upgrade-/Compound-Writes
- Scroll-/Offering-Auswahl
- automatisches Beschaffen fehlender Gear-Goals
- automatisches Player-Market-Gear-Shopping
- automatische Stand-/Listing-Logik.

Diese Punkte bleiben H15+ vorbehalten.

## Safety-Regeln

### Lokale Equip-Swaps

Ein Equip wird nur geplant/ausgeführt, wenn:

- lokaler Charakter lebt;
- Combat nicht aktiv ist;
- Inventar beobachtbar ist;
- Kandidat im erwarteten Inventarslot liegt;
- Kandidat klassen-/slotkompatibel ist;
- Kandidat nicht locked/gift/giveaway/expiring ist;
- Zielslot seit Queueing unverändert ist;
- kein Zwei-Hand-Kandidat ein belegtes Offhand implizit verdrängen würde.

Promise-Erfolg allein bestätigt keinen Swap.

PASS erfordert:

- erwarteter Kandidaten-Fingerprint im Zielslot;
- Kandidatenmenge im Inventar sinkt;
- bei Replacement: ursprüngliches Item erscheint wieder im Inventar.

### Unequip

Unequip ist nur mit freiem Inventarslot erlaubt.

Bestätigung erfordert:

- Zielslot ist leer;
- ursprünglicher Item-Fingerprint ist im Inventar hinzugekommen.

### Merchant→Farmer Gear Delivery

Delivery ist immer explizit und nur erlaubt, wenn:

- lokaler Charakter Merchant ist;
- Ziel dynamisch als eigener Farmer erkannt wird;
- Ziel sichtbar ist;
- Quellitem transfer-sicher ist;
- Item für den Farmer klassenkompatibel ist;
- Item eine echte Verbesserung für einen konkreten Zielslot darstellt.

Direkt vor Dispatch werden Ziel, Quelle, Safety und Verbesserung erneut geprüft.

### Gruppenpriorität

Read-only Allokationsplanung:

- Farmer-Priorität: `100`
- Merchant-Priorität: `10`

Farmer werden im Plan vor dem Merchant behandelt.

Remote-Gear-Proposals werden nur vom Merchant erzeugt und nur mit transfer-sicheren Items.

### Gear Goals

Goal-Zustände:

- `ACHIEVED`
- `READY_TO_EQUIP`
- `READY_TO_DELIVER`
- `NEEDS_ACQUISITION`

H14 führt fehlende Acquisition nicht selbst aus.

### UNKNOWN

Bei synchronem UNKNOWN, nie settelndem Promise oder nicht bestätigtem Live-Delta:

- entsprechende UNKNOWN-Metrik;
- H14-Suspension;
- Request/Pending wird verworfen;
- kein Blind-Retry.

## Ein-Klick-Live-Test

Suite:

`h14-gear`

Die Suite startet eine zuvor gestoppte Runtime automatisch und stellt den vorherigen Runtime-Zustand am Ende wieder her.

Der reale Swap ist reversibel.

### Voraussetzung

Auf dem getesteten Charakter muss mindestens ein kompatibles Inventar-Gear existieren, das gegen einen bereits belegten Gear-Slot getauscht werden kann.

Bevorzugt wird eine echte Verbesserung. Falls keine Verbesserung verfügbar ist, darf für den technischen Roundtrip ein anderer kompatibler, sicherer Kandidat verwendet werden.

Falls kein reversibler Kandidat vorhanden ist, endet der Preflight klar mit:

`H14_NEEDS_REVERSIBLE_COMPATIBLE_INVENTORY_GEAR`

Es wird in diesem Fall kein Gear verändert.

## Testschritte

### 1. Preflight

Prüft:

- Charakter verfügbar und lebendig;
- H14-Modul ACTIVE;
- `equip` und `unequip` verfügbar;
- Equipment-Snapshot verfügbar;
- Farmer-Priorität > Merchant-Priorität;
- reversibler kompatibler Swap-Kandidat vorhanden.

Gespeichert werden:

- Zielslot;
- ursprünglicher Item-Fingerprint;
- Kandidaten-Fingerprint;
- ursprüngliche und neue Scores;
- Kandidaten-Inventarslot;
- Modus `IMPROVEMENT` oder `REVERSIBLE_COMPARISON`.

### 2. Planning

Prüft:

- Gear Goal für den Testkandidaten ist `READY_TO_EQUIP` oder bereits `ACHIEVED`;
- Klassen-/Slotkompatibilität;
- bei echtem Improvement: positiver Score-Delta;
- Farmer stehen in der Gruppenreihenfolge vor Merchant;
- Replacement- und Upgrade-Kandidaten sind verfügbar/read-only.

### 3. Equip Swap

Der Kandidat wird über ActionBoundary real ausgerüstet.

PASS erfordert:

- `equipsConfirmed` steigt;
- Kandidaten-Fingerprint im Zielslot beobachtet;
- ursprüngliches Item im Inventar beobachtet;
- kein Equip-UNKNOWN.

### 4. Restore

Das ursprüngliche Item wird aus dem Inventar wieder in denselben Zielslot gerüstet.

PASS erfordert:

- `equipsConfirmed` insgesamt mindestens +2;
- ursprünglicher Fingerprint wieder im Zielslot;
- Testkandidat wieder im Inventar.

Damit ist der reale Test netto reversibel.

### 5. Stability

Fünf Sekunden Beobachtung.

PASS erfordert:

- keine Suspension;
- Equip-UNKNOWN-Delta = 0;
- Unequip-UNKNOWN-Delta = 0;
- Delivery-UNKNOWN-Delta = 0;
- ursprüngliches Gear bleibt im Zielslot.

### 6. Cleanup

PASS erfordert:

- kein H14-Pending;
- kein H14-Request;
- ursprüngliches Gear weiterhin restauriert;
- vorherige Gear Goals wiederhergestellt.

Danach stellt die Live-Test-Engine den vorherigen Runtime-Zustand wieder her.

## Erwartete PASS-Evidence

- Suite `h14-gear`
- `PASSED / ALL_STEPS_PASSED`
- Preflight PASSED
- Planning PASSED
- Equip Swap PASSED
- Restore PASSED
- Stability PASSED
- Cleanup PASSED
- `equipsConfirmed >= baseline + 2`
- alle H14 UNKNOWN-Deltas = 0
- keine Suspension
- ursprünglicher Item-Fingerprint nach Restore wieder im ursprünglichen Zielslot
- Testkandidat wieder im Inventar
- kein Pending/Request nach Cleanup
- bei ursprünglich gestoppter Runtime: Runtime wieder STOPPED und Scheduler `totalResources=0`.

## Pre-Live CI

Erster H14-Code-/Bundle-Lauf:

- Run #276: 179 Tests, 178 PASS, 1 FAIL
- echter Fund: locked Gear wurde noch als automatische lokale Verbesserung gerankt
- behoben: protected inventory gear wird aus automatischer Planung und Equip-Dispatch ausgeschlossen.

Danach:

- Run #279: `npm test` selbst 180/180 PASS, 0 FAIL, 0 SKIP
- GitHub markierte den Workflow nach erfolgreichem Testjob trotzdem als `cancelled`; dieser Lauf zählt nicht als Gate.
- Review P1: protected gear aus lokaler Automation ausschließen – behoben.
- Review P2: eindeutige Inventarzuweisung für austauschbare Slots wie `ring1/ring2` – behoben.
- zusätzliche Regression für zwei unterschiedliche Ring-Kandidaten eingebaut.
- Run #287: **181/181 PASS, 0 FAIL, 0 SKIP, Workflow completed/success**
- beide Review-Threads resolved
- `dist/al-bot.js` auf denselben H14-Source-Stand synchronisiert.

Nach diesem Dokumentationscommit ist noch ein neuer Exact-Head-CI erforderlich. Der H14-Live-Test wird erst freigegeben, wenn auch dieser aktuelle Head `completed/success`, `behind_by=0`, review-clean und mergeable ist.

H14 wird erst nach grünem Exact-Head-CI, sauberem Review-Gate und echtem Adventure-Land-Live-Test gemergt.


## Live-Evidence – 2026-09-27

Echter Adventure-Land-Live-Test auf dem H14-Testbuild:

- Diagnose erstellt: `2026-09-27T08:56:35.153Z`
- Runtime: `0.14.0-h14`
- Suite: `h14-gear`
- Gesamtergebnis: **PASSED / ALL_STEPS_PASSED**
- Runtime vor Test: STOPPED (`runtimeWasRunning=false`)
- Runtime für den Test automatisch gestartet und danach automatisch wieder gestoppt

Preflight:
- Character: `My_Merchant` / `merchant`
- Zielslot: `shoes`
- Modus: `IMPROVEMENT`
- Original: `wshoes +5`, Score `59.2375`
- Kandidat: Inventarslot `10`, `shoes1 +3`, Score `73.9675`
- Score-Delta: `+14.73`
- Farmer-Priorität: `100`
- Merchant-Priorität: `10`
- Preflight: **PASSED**

Planning:
- temporäres Gear Goal: `READY_TO_EQUIP`
- echte Verbesserung bestätigt
- Gruppenreihenfolge: Farmer vor Merchant
- `groupProposals=4`
- `upgradeCandidates=23`
- Planning: **PASSED**

Echter Swap:
- Kandidat real in `shoes` ausgerüstet
- `equipsConfirmed=1` nach Equip
- ursprüngliches `wshoes +5` im Inventar beobachtet
- Equip Swap: **PASSED**

Restore:
- ursprüngliches `wshoes +5` exakt wieder in `shoes` ausgerüstet
- Testkandidat `shoes1 +3` wieder im Inventarslot `10`
- `equipsConfirmed=2`
- Restore: **PASSED**

Stability:
- `equipUnknown=0`
- `unequipUnknown=0`
- `deliveryUnknown=0`
- Original-Gear blieb restauriert
- keine H14-Suspension
- Stability: **PASSED**

Cleanup:
- kein Pending
- kein Request
- Original weiterhin restauriert
- vorherige Gear Goals wiederhergestellt
- Cleanup: **PASSED**
- Live-Test-Cleanup `attempted=true`, `ok=true`

Runtime-Restore:
- Runtime nach Suite wieder STOPPED
- Scheduler `totalResources=0`
- keine Emergency-STOP-Latch

**H14 Live-Gate ist damit bestanden.** Vor Merge bleiben ausschließlich neuer Exact-Head-CI und der vollständige frische Merge-Gate-Check erforderlich.
