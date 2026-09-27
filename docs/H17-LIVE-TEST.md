# H17 – Economy Autonomy Live-Test

Stand: 2026-09-27

## Ziel

H17 führt einen gemeinsamen Economy-Planner für die bereits vorhandenen sicheren H12–H16-Pfade ein.

Der Planner bewertet und priorisiert:

- Bank Mount / Bank Deposit
- Market Sell / NPC Sell
- Gear Equip
- Upgrade
- Compound
- Exchange
- Craft

H17 führt **keine Adventure-Land-Write-Operation direkt** aus. Eine gewählte Aktion wird ausschließlich an den bestehenden Child-Controller delegiert. Dessen ActionBoundary-, UNKNOWN-, Movement-, Ownership- und Budgetregeln bleiben autoritativ.

## Safety-Hierarchie

```text
1. Global STOP / Runtime Action Gate
2. Character / Merchant Preconditions
3. Combat
4. Movement Ownership
5. Inventory / Child Ownership
6. Child Suspension
7. Economy Priority / Session Budget
8. Delegation an H12–H16
```

Wichtige H17-Regeln:

- Autonomie ist nach Modulstart standardmäßig **AUS**.
- Genau eine delegierte Child-Aktion darf gleichzeitig aktiv sein.
- H10 `pendingLoot` gilt als Inventory-Ownership und blockiert neue Economy-Arbeit.
- Child `UNKNOWN` suspendiert H17; kein Blind-Retry.
- Child `BLOCKED`, `REJECTED`, `FAILED` und `CANCELLED` sind bekannte terminale Rejects.
- Nach CONFIRMED/REJECTED wird im selben Scheduler-Tick keine zweite Aktion gestartet.
- Bekannte Queue-Rejects bekommen proposal-spezifischen Backoff.
- Session-Aktionsbudget stoppt die Autonomie deterministisch.
- Manuelles `queueSelected()` ist bei gestopptem H17-Modul blockiert.

## Live-Suite

Suite:

```text
h17-economy-autonomy
```

Version:

```text
1
```

Der Live-Test ist absichtlich begrenzt:

- maximal **3** Economy-Aktionen;
- Gear Equip im Live-Gate deaktiviert;
- Upgrade im Live-Gate deaktiviert;
- Compound im Live-Gate deaktiviert;
- erlaubt sind Bank Mount, Bank Deposit, Market Sell, NPC Sell, Exchange und Craft;
- Testfenster für Autonomie: 30 Sekunden;
- danach vollständiges Settle und 10 Sekunden Stability-Beobachtung.

## Schritte

### 1. preflight

Erwartung:

- lokaler Charakter verfügbar und nicht tot;
- lokaler Character ist Merchant;
- Economy-Modul ACTIVE;
- H17 nicht suspended;
- keine aktive H17-Aktion;
- keine neue Child-UNKNOWN-Evidence;
- Planner liefert `READY / H17_PLAN_READY`;
- gewählte Live-Aktion gehört zu den erlaubten Low-Impact-Kinds.

Der Bericht enthält:

- gewählte Aktion;
- bis zu acht Vorschläge;
- Blocker;
- Inventory Pressure.

### 2. bounded-autonomy

H17 wird explizit mit maximal drei Aktionen gestartet.

PASS erfordert:

- mindestens eine bestätigte Economy-Aktion;
- maximal drei bestätigte Aktionen;
- maximal drei queued Aktionen;
- keine H17-UNKNOWN-Zunahme;
- keine Child-UNKNOWN-Zunahme;
- nach Ende des Zeitfensters keine aktive Child-/H17-Aktion mehr.

### 3. stability

Nach gestoppter Autonomie zehn Sekunden Beobachtung.

PASS erfordert:

- Autonomie bleibt AUS;
- keine aktive H17-Aktion;
- H17 nicht suspended;
- keine neue Aktion nach Autonomy-Stop;
- keine H17-/Child-UNKNOWN-Zunahme;
- kein Child bleibt busy.

### 4. cleanup

PASS erfordert:

- Autonomie AUS;
- keine aktive H17-Aktion;
- keine Child-Aktion busy;
- Runtime-Auto-Restore funktioniert.

## Technischer Pre-Live-Stand

PR #22 – `H17: Add bounded economy autonomy planner`

Technischer Head vor finaler Dokumentation:

```text
4f8c6fb3733dcf83006611242c74a4ebbc813a99
```

Exact-Head-CI #465:

```text
237 tests
237 pass
0 fail
0 cancelled
0 skipped
0 todo
```

Zusätzlich bestätigt:

- Branch beim technischen Check `behind_by=0`;
- PR `mergeable=true`;
- vier konkrete Review-Funde behoben;
- alle vier Review-Threads resolved;
- kein `CHANGES_REQUESTED`;
- `dist/al-bot.js` source-synchron für Economy/Runtime/UI/Entry;
- Runtime/Bundle/Package auf H17 `0.17.0-h17` / `0.17.0`;
- historische globale Versions-, Recommended-Suite- und Scheduler-Resource-Assertions auf H17 fortgeschrieben;
- Codex-Review ist gemäß aktueller Projektregel kein verpflichtendes Merge-Gate.

## Nächster Live-Schritt

Nach sauberem Merge von PR #22 nach `main`:

1. aktuellen `dist/al-bot.js` aus `main` in Adventure Land laden;
2. Merchant verwenden;
3. **genau einmal** `h17-economy-autonomy` starten;
4. bei PASS vollständigen Bericht senden;
5. bei FAIL nicht blind erneut starten, sondern den vollständigen Bericht senden.

Der Live-Bericht entscheidet, ob H17 abgeschlossen ist oder ein gezielter H17-Fix folgt.
