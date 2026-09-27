# H18 – Party Logistics Live-Test

Stand: 2026-09-27

## Ziel

H18 ergänzt die bestehende H7-Party-Koordination um kontrollierte Logistik zwischen eigenen Party-Mitgliedern:

- Potions, Scrolls, Elixiere und andere konservativ sichere Supplies;
- explizite Item-Verteilung;
- explizite Gold-Verteilung mit Sender-Goldreserve;
- kontrolliertes Regrouping über H4 Movement;
- gemeinsame Ownership-Gates mit H10, H11 und H17.

H18 erfindet keine Remote-Inventardaten. Empfängerbedarf wird nur dann als Wahrheit behandelt, wenn er live verfügbar ist; die erste Version arbeitet deshalb mit explizit vorgemerkten Supply-/Gold-Aufträgen.

## Safety-Regeln

- nur eigene Party-Mitglieder;
- fremde Party-Mitglieder blockieren H18;
- Combat blockiert H18;
- Global STOP / Runtime Action Gate bleibt autoritativ;
- Item-Definition muss live vorhanden sein, sonst fail-closed;
- keine leveled, locked, gift/giveaway, expiring, Quest-, Cash-, Upgrade-/Compound- oder Equipment-Items;
- ungültige explizite Item-/Gold-Mengen werden abgelehnt;
- Goldtransfer nur oberhalb der konfigurierten Sender-Goldreserve;
- Sender-Inventar-/Gold-Deltas sind Outcome-Evidence;
- Transfer-Evidence beobachtet exakt den dispatchten Inventory-Slot;
- Live-Evidence bestätigt erst nach abgeschlossener Dispatch-Settlement;
- UNKNOWN suspendiert H18 ohne Blind-Retry;
- laufende irreversible Supply-/Gold-Aktionen bleiben bei Modulstop erhalten und werden nach Restart reconciled;
- Approach/Regroup nutzt ausschließlich H4 Movement mit Owner `party-logistics-h18`;
- H10 Loot und H11 Merchant-Service warten bei H18-Ownership;
- H17 Economy behandelt H18 als Child-Owner;
- H18 selbst wartet auf laufende H10–H17-Mutationspfade;
- Session-Budget begrenzt autonome Aktionen.

## Oberflächen

Runtime-Modul:

```text
party-logistics
```

Headless API:

```text
ALBot.partyLogistics
```

Runtime / Bundle:

```text
0.18.0-h18
```

Package:

```text
0.18.0
```

Control Center:

- bestehender Party-Tab enthält zusätzlich H18 Party Logistics;
- Supply und Gold explizit vormerken;
- Plan / Tick;
- bounded Autonomie starten / stoppen;
- Queue leeren;
- Safety explizit zurücksetzen;
- Status für Confirmed / UNKNOWN / Regroup sichtbar.

## Live-Suite

Suite:

```text
h18-party-logistics
```

Version:

```text
1
```

Der Live-Test ist absichtlich klein und bounded.

### 1. preflight

PASS erfordert:

- lokaler Character verfügbar und lebendig;
- Modul `party-logistics` ACTIVE;
- vollständig eigene Party ohne fremde Mitglieder;
- mindestens ein sichtbares eigenes, nichtlokales Party-Mitglied;
- mindestens ein konservativ sicheres Supply-Item;
- `send_item` live verfügbar;
- keine H18-Suspension;
- keine aktive H18-Aktion.

### 2. regroup

Wenn das gewählte eigene Party-Mitglied bereits innerhalb von 100 Units liegt:

```text
alreadyGrouped=true
```

Es wird keine künstliche Bewegung erzeugt.

Wenn die Party weiter getrennt ist:

- H18 startet bounded Autonomie mit maximal einer Aktion;
- H4 bekommt einen `party-logistics-h18`-Movement-Order;
- PASS erst nach bestätigtem Movement-Abschluss;
- Movement UNKNOWN ist harter FAIL.

### 3. supply

- genau ein sicheres Supply-Item wird mit Menge 1 an das ausgewählte eigene Party-Mitglied vorgemerkt;
- H18 startet bounded Autonomie mit maximal einer Aktion;
- genau ein `send_item` Dispatch;
- genau eine Bestätigung aus Sender-Slot-Delta + abgeschlossener Settlement;
- 0 Reject;
- 0 UNKNOWN;
- Queue danach leer.

### 4. stability

Fünf Sekunden Beobachtung:

- Autonomie bleibt AUS;
- keine aktive Aktion;
- kein Retry;
- keine neue UNKNOWN-Evidence;
- keine neue Supply-Mutation.

### 5. cleanup

PASS erfordert:

- Autonomie AUS;
- `currentAction = null`;
- Queue leer;
- keine Suspension;
- Runtime Auto-Restore erfolgreich.

## Technischer Pre-Live-Stand

PR #25 – `H18: Add bounded party logistics`

Technischer Safety-Head vor Bundle/Doku-Finalisierung:

```text
10ba7540545d49ff7d5100c469533092fdc65bf1
```

Exact-Head-CI #490:

```text
256 tests
256 pass
0 fail
0 cancelled
0 skipped
0 todo
completed / success
```

Review-Hardening:

- P1: irreversible Transfers über Modulstop erhalten und nach Restart reconciled;
- P1: fehlende Item-Definition fail-closed;
- P1: null/leere Koordinaten nicht als `0,0` interpretieren;
- P2: exakten dispatchten Inventory-Slot beobachten;
- P2: ungültige explizite Supply-Mengen ablehnen;
- zusätzlich: ungültige Goldmengen fail-closed;
- mehrere gleichnamige Stacks regressionsseitig abgedeckt;
- Movement-Reject verwirft keinen vorgemerkten Supply-Auftrag;
- H10/H11/H17/H18 Cross-Module-Ownership abgesichert;
- alle fünf Review-Threads resolved.

Bundle `dist/al-bot.js` wurde anschließend source-synchron auf H18 aktualisiert.

## Nächster Gate-Schritt

Nach diesen finalen Dokucommits:

1. neuen Exact-Head-CI vollständig grün bestätigen;
2. aktuelles `behind_by=0`;
3. keine pending/failing relevanten Checks;
4. keine offenen Review-Threads;
5. kein `CHANGES_REQUESTED`;
6. `mergeable=true`;
7. ausschließlich per `merge` mit exaktem aktuellem `expected_head_sha` mergen;
8. `main` danach frisch verifizieren.

Erst danach genau **einen** echten `h18-party-logistics`-Live-Test starten. Bei FAIL kein Blind-Rerun, sondern vollständigen Diagnosebericht auswerten.
