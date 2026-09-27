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


## Post-Merge-Korrektur – PR #26

Stand: 2026-09-27

Der tatsächliche Ablauf wich durch parallele Repo-Arbeit vom oben beschriebenen geplanten Gate ab:

- PR #25 wurde bereits per Merge-Commit `c6bfb7b0248d3c005a4dbceac643d90db6d2924a` nach `main` gemergt;
- gemergter PR-Head war `8ecf822bfa476485c9e29c49bc27cccfc3219a26`;
- Exact-Head-CI #496 auf diesem Head war vollständig **SUCCESS**;
- Testsummary: **256 tests / 256 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**;
- die fünf bekannten Review-Threads waren vor dem Merge resolved;
- H18-Source, API, Runtime, UI und Tests lagen damit technisch auf `main`;
- der Merge enthielt jedoch noch die nur zur Bundle-Übernahme verwendeten temporären CI-Schritte;
- außerdem war das getrackte `dist/al-bot.js` beim Merge noch nicht auf den aus genau diesem Head erzeugten H18-Build synchronisiert.

PR #26 `H18: Finalize bundle and pre-live evidence` korrigiert ausschließlich diesen Post-Merge-Zustand:

- `dist/al-bot.js` wird exakt aus dem erfolgreichen CI-Build von #496 übernommen;
- der normale Test-Workflow wird wiederhergestellt; temporärer Artifact-/Base64-Export wird entfernt;
- H18-Evidence wird append-only auf den tatsächlichen Merge-Ablauf korrigiert;
- keine Gameplay- oder Safety-Regel wird gelockert.

**H18 bleibt bis zum Merge von PR #26 und einem echten erfolgreichen `h18-party-logistics`-Adventure-Land-Lauf offen.**


## H18 abgeschlossen – echter Adventure-Land-Live-PASS

Stand: 2026-09-27

Nach Merge von PR #26 wurde die H18-Suite auf einer echten Vierer-Party ausgeführt. Drei H18-fähige Combat-Runner lieferten unabhängig voneinander `PASSED / ALL_STEPS_PASSED`.

### Ranger-Lauf – vollständiger Regroup + Supply-Pfad

- Runtime: `0.18.0-h18`;
- lokale Rolle: Ranger / DPS;
- Party: 4 eigene Mitglieder, keine fremden Mitglieder;
- Ziel: eigener Merchant;
- Supply: `mpot0`, Menge 1;
- Preflight: PASS;
- Regroup: PASS, `alreadyGrouped=false`;
- Distanz vor Regroup: ca. 123 Units;
- Regroup: 1 bestätigt / 0 UNKNOWN;
- Supply: 1 dispatched / 1 confirmed / 0 rejected / 0 UNKNOWN;
- Stability: PASS;
- Cleanup: PASS;
- danach Autonomie AUS, `currentAction=null`, Queue leer, keine Suspension.

Dieser Lauf deckt den verpflichtenden echten Movement-/Regroup- und Supply-Pfad gemeinsam ab.

### Priest-Lauf – Already-Grouped + Potion-Supply

- Runtime: `0.18.0-h18`;
- lokale Rolle: Priest / Healer;
- Party: 4 eigene Mitglieder;
- Ziel: eigener Merchant;
- Supply: `hpot0`, Menge 1;
- Regroup-Schritt: PASS mit `alreadyGrouped=true`;
- Supply: 1 dispatched / 1 confirmed / 0 rejected / 0 UNKNOWN;
- Stability und Cleanup: PASS;
- keine Suspension, keine UNKNOWN-Evidence.

### Warrior-Lauf – zusätzlicher unabhängiger Supply-PASS

- Runtime: `0.18.0-h18`;
- lokale Rolle: Warrior / Tank;
- Party: 4 eigene Mitglieder;
- Ziel: eigener Merchant;
- Regroup-Schritt: PASS mit `alreadyGrouped=true`;
- Supply: 1 dispatched / 1 confirmed / 0 rejected / 0 UNKNOWN;
- Stability und Cleanup: PASS;
- keine Suspension, keine UNKNOWN-Evidence.

### Separater Merchant-Dump

Ein gleichzeitig gestarteter Merchant-Runner war noch auf `0.17.0-h17` und führte deshalb nicht H18, sondern erneut `h17-economy-autonomy` aus. Dieser alte Runner wurde per `GUI_EMERGENCY_STOP` beendet und der H17-Lauf dadurch `CANCELLED / LIVE_TEST_CANCELLED`. Das ist keine H18-Fehlevidence und wird nicht als H18-Lauf gewertet.

### Abschlussbewertung

Der definierte H18-Live-Gate ist erfüllt:

- echter eigener Party-Kontext;
- echter H18-Regroup mit H4-Movement-Ownership bestätigt;
- echter Potion-Supply-Transfer bestätigt;
- Dispatch-/Outcome-Evidence sauber;
- Supply UNKNOWN = 0;
- Regroup UNKNOWN = 0;
- Stability PASS;
- Cleanup PASS;
- kein Blind-Retry;
- keine H18-Suspension;
- Runtime Auto-Restore erfolgreich.

Die Gold-Verteilung wurde im bounded H18-Live-Gate bewusst nicht mutiert; sie bleibt durch die automatischen H18-Regressions- und Safety-Tests abgedeckt.

**H18 – Party Logistics ist damit abgeschlossen.**

Nächster Entwicklungsblock: **H19 – Character Lifecycle & Recovery**.
