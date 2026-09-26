# H10 – Loot & Inventar

## Ziel

H10 ergänzt den autonomen Farming-Core um eine konservative Loot- und Inventar-Schicht.

H10 darf Loot einsammeln und Inventar live klassifizieren. Destruktive oder zustandsverlagernde Economy-Aktionen wie echtes Verkaufen, Bank-Einlagern oder Exchange bleiben in H10 standardmäßig **nicht ausführend**. H10 liefert dafür sichere Dispositionsentscheidungen, die H11/H12/H16 später verwenden können.

## Live-Datenquellen

H10 verwendet ausschließlich aktuelle Adventure-Land-Live-Daten:

- `character.items` für Inventarslots;
- `character.esize` als zusätzliches Empty-Slot-Signal;
- `G.items` für Itemdefinitionen;
- `get_chests()` / `chests` für sichtbare Loot-Chests;
- `loot(chestId)` als Gameplay-Aktion über die zentrale ActionBoundary.

## Item-Dispositionen

H10 kennt:

- `PROTECT` – niemals automatisch zerstören/verkaufen;
- `RESERVE` – für aktive Ziele/Quests reservieren;
- `KEEP` – aktuell beim Charakter behalten;
- `BANK` – konservativer Standard für unbekannten Wert;
- `EXCHANGE` – Item ist live als exchangeable erkennbar;
- `SELL` – nur explizit per Regel freigegeben.

Sicherheitsprinzip: **Unbekannt bedeutet nicht verkaufen.**

### Automatischer Schutz

Ohne manuelle Regeln werden geschützt bzw. reserviert:

- gelockte Items;
- Giveaway-/spezielle Items;
- Items mit Ablaufdatum;
- gelevelte Items;
- Gear/upgrade-/compound-fähige Items;
- Questitems;
- Items, die Ziel eines aktiven `COLLECT_ITEM`-Goals sind;
- Utility/Consumables werden behalten;
- alle übrigen unbekannten Items landen standardmäßig bei `BANK`.

## Loot-Safety

H10 hält standardmäßig mindestens 2 freie Inventarslots als Reserve.

Eine Chest wird nur gelootet, wenn ihre bekannte Itemanzahl in die verbleibende Kapazität passt.

Loot läuft ausschließlich über:

```text
LootInventoryController
        │
        ▼
GameActionBoundary
        │
        ▼
loot(chestId)
```

Kein direkter Socket-/Game-Dispatch aus H10.

## UNKNOWN-Regel

Wenn ein Loot-Aufruf synchron oder asynchron unklar endet:

- `lootUnknown` wird erhöht;
- H10 suspendiert;
- kein Blind-Retry;
- erst ein expliziter Neustart/Reset darf wieder Loot ausführen.

Adventure-Land-Antworten wie `nothing_to_loot` oder `safety` sind dagegen bekannte Skips und werden nicht als UNKNOWN behandelt.

## H10 Live-Test – implementierter Ein-Klick-Ablauf

### 1. Preflight

Prüfen:

- Runtime aktiv;
- H10-Modul aktiv;
- Inventar verfügbar;
- `loot`-API verfügbar;
- Klassifizierungsplan erzeugbar;
- mindestens ein Item oder eine sichtbare Chest als Live-Evidence.

### 2. Protection Snapshot

Vor dem Loot wird ein vollständiger Inventar-Snapshot gespeichert:

- Slot;
- Name;
- Menge;
- Level;
- Lock;
- Disposition;
- Schutzgrund.

Wichtige Items müssen `protected=true` sein.

### 3. Safe Loot

Wenn eine passende Chest vorhanden ist:

- Slot-Reserve prüfen;
- genau eine Chest über ActionBoundary looten;
- bestätigte/known-skip Antwort abwarten;
- UNKNOWN führt sofort zum Fail/Suspend.

Wenn keine passende Chest vorhanden ist, startet die Suite H9-Farming selbstständig und wartet auf mindestens einen echten bestätigten Loot.

### 4. Inventory Delta

Nach bestätigtem Loot:

- Inventar neu lesen;
- Delta erklären;
- neue Items klassifizieren;
- keine geschützte Position darf verschwinden.

### 5. Pressure / Stability

Mehrere Farmzyklen beobachten:

- Reserve-Slots nicht unterschreiten;
- kein Loot-UNKNOWN;
- keine destruktive H10-Aktion;
- keine unerklärte Inventarverlustrate.

### 6. Cleanup

Die Suite gibt H9/H8/H5/H4 sauber frei und wartet, bis kein H10-Loot mehr pending ist. Wenn die Runtime für den Test automatisch gestartet wurde, stellt der Live-Test-Runner danach den vorherigen STOPPED-Zustand wieder her; anschließend besitzt H10 keine Scheduler-Ressourcen mehr.

## Regressionen

Die H10-Tests decken mindestens ab:

- Live-Inventarnormalisierung;
- Live-Chest-Normalisierung;
- Schutz von locked/leveled/gear/quest;
- Goal-basierte Reserve ohne hardcodierte Namen;
- unbekannte Items defaulten niemals zu SELL;
- SELL nur explizit per Regel;
- Slot-Reserve verhindert Loot;
- passende Chest wird gewählt;
- `nothing_to_loot` / `safety` sind known skips;
- Promise-Rejection -> UNKNOWN + Suspend;
- synchrones ActionBoundary UNKNOWN -> Suspend;
- keine H10-Dispatches für sell/bank/exchange.


## Finale Live-Evidence

Finaler Adventure-Land-Retest der gehärteten H10-Live-Suite:

- Runtime: `AL Bot 0.10.0-h10`
- Suite: `h10-loot-inventory`
- Ergebnis: `PASSED / ALL_STEPS_PASSED`
- Lauf: 2026-09-26T22:59:51.904Z bis 2026-09-26T23:00:01.584Z
- Runtime wurde für die Suite automatisch gestartet und danach wieder in den vorherigen STOPPED-Zustand zurückgeführt.

Preflight:
- Character `My_Warrior`, Klasse `warrior`
- Kapazität 42
- usedSlots 4
- freeSlots 38
- protectedCount 4
- Dispositionen: KEEP=2, BANK=1, EXCHANGE=1
- reserveFreeSlots 2

Autonomous Farming:
- sichere Live-Probe `goo`
- HP 100
- 4 sichtbare sichere Kandidaten
- H9 übernahm die Farming-Ownership.

Confirmed Loot:
- `lootDispatched=1`
- `lootConfirmed=1`
- `knownSkips=0`
- `attacksConfirmed=1`

Protection Delta:
- Schritt `protection-delta`: PASSED
- `checkedProtectedItems=4`
- currentUsedSlots 4
- currentFreeSlots 38
- reserveFreeSlots 2
- damit wurde die zuvor gefundene Testlücke `checkedProtectedItems=0` tatsächlich geschlossen.

Stability:
- `lootConfirmed=2`
- `knownSkips=0`
- `lootUnknown=0`
- freeSlots 38
- reserveFreeSlots 2

Cleanup:
- `pendingLoot=false`
- `h9Active=false`
- `farmingActive=false`
- `combatActive=false`
- `movementActive=false`
- Cleanup `ok=true`
- Runtime anschließend STOPPED
- Scheduler anschließend `totalResources=0`

## Post-Live Review-Härtung

Nach dem erfolgreichen Live-Test wurden zwei P2-Review-Funde behoben:

1. Ein `loot()`-Promise, der niemals settled, besitzt jetzt eine bounded Outcome-Deadline. Nach Ablauf wird der Ausgang als `H10_LOOT_OUTCOME_TIMEOUT` behandelt, `lootUnknown` erhöht und H10 suspendiert. Es erfolgt kein Blind-Retry.
2. Die Item-Klassifizierung respektiert neben `type === 'quest'` auch das normalisierte Live-Flag `definition.quest === true`.

Beide Pfade besitzen Regressionstests. Die Änderungen verändern den bereits live bestätigten normalen Loot-Happy-Path nicht: die Timeout-Härtung greift nur bei einem ausbleibenden Outcome, und der Quest-Flag-Fix erweitert ausschließlich die konservative Schutzklassifizierung.

Exact-Head-CI nach dieser Härtung:
- Head `a86e83938ca92fa2da0f5b7330433e797510bbbf`
- GitHub Actions Run #210
- `completed / success`
- beide P2-Review-Threads resolved.
