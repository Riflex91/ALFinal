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

## H10 Live-Test – geplanter Ein-Klick-Ablauf

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

Wenn keine Chest vorhanden ist, darf der Test einen Farmzyklus beobachten, bis ein echter Loot-Event entsteht.

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

H10 stoppt sauber:

- kein Pending Loot;
- Modul inaktiv;
- keine eigenen Scheduler-Ressourcen;
- Runtime wird bei Auto-Start wieder STOPPED.

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
