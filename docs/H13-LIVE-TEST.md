# H13 – Handel Live-Test

Stand: 2026-09-27

H13 baut auf dem H12-Bankstand auf und ergänzt kontrollierten NPC-Handel sowie sichere Analyse sichtbarer Player-Market-Listings.

## Abhängigkeit

H12 ist live bestanden und als PR #12 gemergt.

Aktiver H13-Branch:
`chatgpt/h13-handel-v2`

Basis:
H12-Merge-Commit `b68e3f2934877e001f0e5454d83117ef43f7b9e3` auf `main`.

Der frühere gestapelte Branch `chatgpt/h13-handel` wird wegen der Stale-Branch-Regel nicht weiter beschrieben.

## Scope

Implementiert:

- NPC-Kauf via `buy_with_gold`
- NPC-Verkauf via `sell`
- Player-Market-Kauf via `trade_buy`
- Player-Market-Verkauf via `trade_sell`
- alle Writes ausschließlich über ActionBoundary
- NPC-Shopquellen aus Live-`G.npcs` + `find_npc`
- sichtbare Player-Market-Listings aus Live-Player-Slots
- `b === true` wird als Buy-Order/Bid behandelt
- Ask/Bid-Analyse
- verpflichtende Maximalpreise für Käufe
- verpflichtende Mindestpreise für Player-Market-Verkäufe
- Listing-`rid` und Preis werden unmittelbar vor Player-Trade erneut geprüft
- Goldreserve
- H10-`SELL` als einzige automatische Sell-Quelle
- Acquisition-Planner: NPC-Festpreis gegen sichtbaren Ask vergleichen
- H4-NPC-Bewegung mit Owner `trade-h13`
- Inventory-/Gold-Delta-Bestätigung
- bounded UNKNOWN + Suspension ohne Blind-Retry
- Headless API `ALBot.trade.*`
- eigener Control-Center-Tab **Handel**
- Ein-Klick-Suite `h13-trade`

Nicht Teil von H13:

- automatische Stand-Eröffnung/Listings
- langfristige Arbitrage
- Gear-Verteilung
- Upgrade/Compound
- Exchange/Craft
- gemeinsamer Economy-Gesamtplanner

Diese Themen bleiben späteren Roadmap-Schritten vorbehalten.

## Safety-Vertrag

### NPC Buy

Ein NPC-Kauf wird nur geplant, wenn:

- lokaler Charakter Merchant ist;
- positive ganzzahlige Menge angegeben ist;
- explizites `maxUnitPrice` vorhanden ist;
- Live-`G.items[item].g` bekannt und <= Preislimit ist;
- eine Live-NPC-Quelle mit `find_npc`-Position existiert;
- Gold nach dem Kauf oberhalb der konfigurierten Reserve bleibt;
- Inventar beobachtbar ist.

Bestätigung erfordert gleichzeitig:

- Itemmenge im Inventar steigt mindestens um die gekaufte Menge;
- Charaktergold sinkt mindestens um den bekannten Gesamtpreis.

Promise-Erfolg allein genügt nicht.

### NPC Sell

Automatisch/über H13 verkaufbar sind nur H10-Items mit Disposition `SELL`.

Geblockt bleiben insbesondere:

- KEEP
- PROTECT
- RESERVE
- BANK
- EXCHANGE
- locked
- giveaway/gift
- expiring
- gelevelte Items
- Quest-/Upgrade-/Compound-Items.

Bestätigung erfordert:

- passende Inventarmenge sinkt;
- Charaktergold steigt.

### Player Market Buy

Ein Player-Ask wird nur gekauft, wenn:

- Listing sichtbar ist;
- `buying !== true`;
- kein Giveaway;
- `rid` vorhanden;
- Menge verfügbar;
- Preis <= explizites `maxUnitPrice`;
- Goldreserve erhalten bleibt.

Unmittelbar vor Dispatch werden erneut geprüft:

- Player
- Trade-Slot
- `rid`
- Item
- Ask/Bid-Richtung
- Preis.

Ändert sich das Listing, wird nicht gekauft.

### Player Market Sell

Ein Bid wird nur bedient, wenn:

- `buying === true`;
- Preis >= explizites `minUnitPrice`;
- `rid` unverändert;
- passendes eigenes H10-`SELL`-Item vorhanden ist.

### UNKNOWN

Bei synchronem UNKNOWN, nicht eindeutigem Promise-Ausgang oder nicht beobachtbarem Zustandsdelta:

- UNKNOWN-Metrik;
- Suspension;
- Request/Pending wird verworfen;
- kein Blind-Retry.

## Ein-Klick-Live-Test

Suite:

`h13-trade`

Der Live-Test führt **keinen Player-Market-Write** aus.

Er nutzt genau einen kleinen NPC-Kauf und analysiert den sichtbaren Player-Market danach ausschließlich read-only.

### Reale Zustandsänderung

Der Test kauft exakt:

- Item: `hpot0`
- Menge: `1`
- Quelle: live erkannter NPC-Shop, normalerweise `fancypots`
- Preislimit: exakt der aktuelle Live-`G.items.hpot0.g`-Festpreis.

Das eine gekaufte `hpot0` bleibt nach dem Test im Inventar.

### Voraussetzungen

- eigener Merchant aktiv;
- Merchant lebt;
- `buy_with_gold`, `sell`, `trade_buy`, `trade_sell` und `smart_move` verfügbar;
- Live-`hpot0`-Preis bekannt;
- NPC-Quelle für `hpot0` mit Position verfügbar;
- mindestens ein freier Inventarslot;
- Gold nach Kauf weiterhin >= H13-Goldreserve.

### 1. Preflight

Erfasst:

- Merchant
- Map
- hpot0-Livepreis
- hpot0-Ausgangsmenge
- Ausgangsgold
- Goldreserve
- NPC-ID und Position.

### 2. NPC Buy

H13 fährt bei Bedarf über H4 mit Owner `trade-h13` zum NPC.

Danach wird genau 1 hpot0 mit `maxUnitPrice = Live-Festpreis` gekauft.

PASS erfordert:

- `npcBuysConfirmed` steigt;
- hpot0-Inventarmenge steigt mindestens um 1;
- Gold sinkt mindestens um den Live-Festpreis;
- kein NPC-Buy-UNKNOWN;
- kein Movement-UNKNOWN.

### 3. Player-Market-Analyse

Read-only:

- sichtbare Asks erfassen;
- sichtbare Bids erfassen;
- Best Ask / Best Bid / Spread berechnen, soweit vorhanden.

PASS erfordert zusätzlich:

- kein `trade_buy` Dispatch;
- kein `trade_sell` Dispatch.

Damit kann der Market-Parser im echten Spiel geprüft werden, ohne fremde Player-Listings anzufassen.

### 4. Stability

Fünf Sekunden ohne:

- NPC Buy UNKNOWN
- NPC Sell UNKNOWN
- Market Buy UNKNOWN
- Market Sell UNKNOWN
- Movement UNKNOWN
- Suspension.

### 5. Cleanup

PASS erfordert:

- kein Pending;
- kein Request;
- keine H13-eigene Movement-Order.

Die Live-Test-Engine stellt danach den vorherigen Runtime-Zustand wieder her.

## Erwartete finale Evidence

- Suite `h13-trade`
- `PASSED / ALL_STEPS_PASSED`
- Preflight PASSED
- NPC Buy PASSED
- Market Analysis PASSED
- Stability PASSED
- Cleanup PASSED
- `npcBuysConfirmed > baseline`
- alle H13 UNKNOWN-Deltas = 0
- keine Suspension
- kein Player-Market-Write im Live-Test
- bei ursprünglich gestoppter Runtime: Runtime wieder STOPPED und Scheduler `totalResources=0`.

## Pre-Live CI

Code-/Bundle-Head vor dieser Dokumentation:

- GitHub Actions Run #249
- 157 Tests
- 157 PASS
- 0 FAIL
- 0 SKIPPED

Nach diesen Dokumentationscommits ist erneut Exact-Head-CI erforderlich.

H13 wird erst nach eigenem bestandenem Adventure-Land-Live-Test und anschließend erneut sauberem Exact-Head-Merge-Gate gemergt.

## Finale Live-Evidence – 2026-09-27

Der echte Adventure-Land-Ein-Klick-Test ist vollständig bestanden.

Finale Suite:
- Runtime: `AL Bot 0.13.0-h13`
- Suite: `h13-trade`
- Ergebnis: `PASSED / ALL_STEPS_PASSED`
- Start: `2026-09-27T08:13:18.294Z`
- Ende: `2026-09-27T08:13:25.586Z`
- Runtime war vor dem Test STOPPED und wurde nur für die Suite automatisch gestartet.

### Preflight – PASSED
- Merchant: `My_Merchant`
- Start-Map: `bank`
- Testitem: `hpot0`
- Menge: `1`
- Live-NPC-Stückpreis: `20` Gold
- Ausgangsmenge: `5999`
- Ausgangsgold: `14195004`
- Goldreserve: `10000`
- NPC: `fancypots`
- NPC-Position: `main (-35, -162)`

### NPC Buy – PASSED
- genau `1 x hpot0` gekauft
- `beforeQuantity=5999`
- `afterQuantity=6000`
- `beforeGold=14195004`
- `afterGold=14194984`
- `npcBuysConfirmed=1`
- `movementRequests=1`
- `npcBuysUnknown=0`
- `movementUnknown=0`

### Player-Market-Analyse – PASSED
- rein read-only
- sichtbare Asks: `51`
- sichtbare Bids: `1`
- `marketBuysDispatched=0`
- `marketSellsDispatched=0`
- der Live-Bericht zeigte dabei einen semantisch falschen globalen Spread zwischen unterschiedlichen Items; nach dem Live-Test wurde deshalb read-only gehärtet:
  - Spread wird nur noch berechnet, wenn Best Ask und Best Bid dasselbe Item und Level betreffen;
  - neue Regression deckt Cross-Item-Spread ab;
  - kein Gameplay-Write-Pfad wurde dadurch verändert.

### Stability – PASSED
- `npcBuyUnknown=0`
- `npcSellUnknown=0`
- `marketBuyUnknown=0`
- `marketSellUnknown=0`
- `movementUnknown=0`
- keine Suspension.

### Cleanup – PASSED
- `pending=false`
- `request=false`
- `movementActive=false`
- Suite-Cleanup: `attempted=true / ok=true`
- Runtime danach wieder STOPPED
- Scheduler danach `totalResources=0`
- Scheduler `callbackErrors=0`

### Abnahme
Alle H13-PASS-Kriterien sind erfüllt. H13 gilt damit live als **BESTANDEN**.

Vor dem Merge bleibt nur der neue Exact-Head-CI-/Review-/Merge-Gate nach dem read-only Spread-Hardening und diesen Evidence-Commits.
