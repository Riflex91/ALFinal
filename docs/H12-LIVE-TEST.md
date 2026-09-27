# H12 – Bank Live-Test

Stand: 2026-09-27

H12 erweitert den live bestätigten H10/H11-Core um kontrollierte Banknutzung.

## Scope

Implementiert:

- Live-Bank-Snapshot aus `character.bank`
- Pack-Erkennung inklusive verifizierter Pack→Bank-Map-Zuordnung
- Bank-Suche
- sichere Item-Deposits über `bank_store`
- sichere Item-Withdraws über `bank_retrieve`
- Gold-Deposit/Withdraw über `bank_deposit` / `bank_withdraw`, nur wenn beide Goldstände beobachtbar sind
- Reservierungen
- Workspace-Pack-Auswahl
- Inventory/Bank-Reconciliation
- automatische H4-Fahrt zur Bank für Deposits
- eigener H12-Control-Center-Tab
- Headless API `ALBot.bank.*`
- Ein-Klick-Suite `h12-bank`

Nicht Teil von H12:

- NPC Buy/Sell oder Player Market (H13)
- Gear-Verteilung (H14)
- Upgrade/Compound (H15)
- Exchange/Craft (H16)
- Economy-Gesamtplanner (H17)

## Safety-Regeln

Bankwrites laufen ausschließlich über die zentrale ActionBoundary:

- `bank_store`
- `bank_retrieve`
- `bank_deposit`
- `bank_withdraw`

Ein Promise-Erfolg allein bestätigt keine Bankaktion.

Bestätigung erfordert beobachtbare Live-Deltas auf beiden Seiten:

- Deposit: Inventarmenge sinkt und Bankmenge steigt; erwartete Zielposition enthält denselben Item-Fingerprint.
- Withdraw: Bankmenge sinkt und Inventarmenge steigt; der erwartete Inventarslot enthält denselben Item-Fingerprint.
- Gold: Bank- und Charaktergold müssen sich in den erwarteten Gegenrichtungen ändern.

Wenn Inventory oder Bank vorübergehend nicht beobachtbar sind, ist das **kein Erfolg**.

Ein unverifiziertes Ergebnis läuft in einen begrenzten Timeout und führt zu:

- UNKNOWN-Metrik
- H12-Suspension
- Request/Pending wird verworfen
- kein Blind-Retry.

Automatische Item-Deposits sind konservativ auf H10-Disposition `BANK` begrenzt. `KEEP`, `PROTECT`, `RESERVE` und `EXCHANGE` werden nicht automatisch eingelagert.

Workspace-Packs werden nur verwendet, wenn ihre Live-Zuordnung zur aktuell gemounteten Bank-Map bekannt und passend ist. Eine unbekannte Pack→Map-Zuordnung wird fail-closed behandelt.

Reservierungen blockieren Withdraws, wenn dadurch die konfigurierte Mindestmenge des Item-Fingerprints in der Bank unterschritten würde.

H12 öffnet keine kostenpflichtigen Bank-Packs automatisch.

## Ein-Klick-Live-Test

Suite:

`h12-bank`

Der Nutzer klickt nur **Test starten**.

Die Suite startet eine zuvor gestoppte Runtime automatisch und stellt den vorherigen Runtime-Zustand am Ende wieder her.

### Voraussetzungen

Auf dem eigenen Merchant:

- Merchant lebt;
- mindestens ein sicher als `BANK` klassifiziertes Item liegt im Inventar;
- `bank_store`, `bank_retrieve` und `smart_move` sind verfügbar;
- ein passender bereits freigeschalteter Bank-Pack besitzt mindestens einen freien Workspace-Slot.

Falls kein sicheres `BANK`-Item vorhanden ist, endet der Preflight klar mit:

`H12_NEEDS_SAFE_BANK_ITEM`

## Testschritte

### 1. Preflight

Prüft:

- lokaler Charakter ist Merchant;
- H12-Modul ist ACTIVE;
- Bank- und Movement-APIs verfügbar;
- sicheres H10-`BANK`-Item vorhanden.

Gespeichert werden:

- Item-ID
- ursprünglicher Inventarslot
- ursprüngliche Stackmenge.

### 2. Deposit

H12:

1. fährt bei Bedarf über H4 mit Owner `bank-h12` automatisch zur Bank;
2. verwendet nur einen Pack, dessen Bank-Map live verifiziert zur aktuellen Bank passt;
3. wählt einen leeren Workspace-Slot;
4. lagert den gesamten gewählten Stack kontrolliert ein;
5. bestätigt den Deposit nur über Inventory/Bank-Deltas.

Die Suite merkt sich den exakten Pack und Bank-Slot.

### 3. Withdraw

Dasselbe Item wird aus exakt diesem Pack/Slot wieder in den ursprünglichen Inventarslot zurückgeholt.

PASS erfordert:

- bestätigten Withdraw;
- ursprünglicher Inventarslot enthält wieder dasselbe Item;
- ursprüngliche Stackmenge ist wiederhergestellt;
- Workspace-Bankposition enthält dieses Item danach nicht mehr.

Damit ist der reale Test netto reversibel.

### 4. Reconciliation / Stability

Fünf Sekunden Beobachtung.

PASS erfordert:

- keine Suspension;
- keine neuen Deposit-UNKNOWNs;
- keine neuen Withdraw-UNKNOWNs;
- keine Movement-UNKNOWNs;
- Reconciliation verfügbar;
- Item weiterhin eindeutig am wiederhergestellten Inventarslot auffindbar.

### 5. Cleanup

PASS erfordert:

- kein H12-Pending;
- kein H12-Request;
- keine H12-eigene Movement-Order.

Danach stellt die Live-Test-Engine den vorherigen Runtime-Zustand wieder her.

## Erwartete PASS-Evidence

Für die finale H12-Abnahme müssen mindestens sichtbar sein:

- Suite `h12-bank`
- `PASSED / ALL_STEPS_PASSED`
- Preflight PASSED
- Deposit PASSED
- Withdraw PASSED
- Reconciliation PASSED
- Cleanup PASSED
- `depositsConfirmed > baseline`
- `withdrawalsConfirmed > baseline`
- `depositsUnknown delta = 0`
- `withdrawalsUnknown delta = 0`
- `movementUnknown delta = 0`
- keine Suspension
- Item nach dem Roundtrip wieder im ursprünglichen Inventarslot mit ursprünglicher Menge
- kein H12-Pending/Request/Movement nach Cleanup
- bei ursprünglich gestoppter Runtime: Runtime wieder STOPPED und Scheduler `totalResources=0`.

## Pre-Live CI

Früher H12-Code-Head:

- Run #235
- 144 Tests
- 144 PASS
- 0 FAIL

Nach der zusätzlichen Pack→Map-Fail-Closed-Härtung, Bundle-Synchronisierung und diesen Dokumentationscommits ist erneut ein **Exact-Head-CI** erforderlich.

H12 wird erst nach bestandenem echten Adventure-Land-Live-Test gemergt.
