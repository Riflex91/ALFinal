# AL Bot – Chat-Handoff / aktueller Projektstand

Stand: 2026-09-26  
Aktives Repository: `Riflex91/ALFinal`

## Pflichtlektüre für einen neuen Chat

Vor Änderungen lesen:

1. `README.md`
2. `docs/PROJECT-CHARTER.md`
3. `docs/ROADMAP.md`
4. dieses Dokument
5. für Roster-Fragen: `docs/CHARACTER-DISCOVERY.md`

Neuere Repo-Entscheidungen haben Vorrang vor älteren Handoff-Angaben.

## Verbindliche Projektregeln

- Produktname: **AL Bot**.
- „V6“ ist nur eine interne Entwicklungsgeneration.
- Zuverlässigkeit hat oberste Priorität.
- modularer Core statt monolithischem Bot.
- Headless-Fähigkeit von Anfang an.
- GUI ist nur ein Client des Core.
- mitwachsendes Control Center.
- globaler roter STOP als Notbremse.
- keine hartcodierten Farmer-/Charakternamen.
- Windows-Bridge-Wissen nur über den read-only `KnowledgeService`.
- Live-Spielzustand schlägt persistiertes Wissen bei zeitkritischen Aktionen.
- direkte kleine Live-Test-Häppchen statt verpflichtender V5-Ketten wie
  `Shadow → Evidence → Authorization → One-shot → 5m → 15m`.
- vor GitHub-Writes Branch gegen aktuellen `main` prüfen; auf stale Branches nicht weiterschreiben.
- PRs automatisch mergen, sobald Implementierung vollständig, CI grün, Live-Test bestanden und alle Merge-Sicherheitschecks erfüllt sind. Keine separate Merge-Freigabe mehr erforderlich, außer der User untersagt den Merge ausdrücklich.

## H1 – abgeschlossen und gemerged

**PR #1 – AL Bot Foundation & Control Center** wurde am 2026-09-26 nach bestandenem Live-Test gemerged.

Merge-Commit:
`4f251a6a15cb94f0e5c5db511c02f013e39251a8`

Bestätigt im echten Adventure-Land-Client:
- Control Center erscheint in der richtigen Adventure-Land-Hauptebene.
- Größe/Resize funktionieren.
- Drag funktioniert.
- Minimieren/Ausklappen funktioniert.
- roter STOP bleibt sichtbar.
- dynamische Character-/Farmer-Erkennung ohne hartcodierte Namen.
- Prioritäten-/Goal-GUI funktioniert.
- Goals können angelegt, pausiert, fortgesetzt, abgebrochen und gelöscht werden.
- Leveling-Standard ist `NORMAL`.
- Clipboard-Diagnose und Selftest-Grundlage funktionieren.

H1-Core enthält:
- Runtime-Grundrahmen;
- Control Center;
- persistenter STOP;
- Goals/Prioritäten;
- KnowledgeService-Schnittstelle;
- dynamische Roster-Erkennung;
- Headless-fähige Control API;
- automatische Smoke-Tests.

## H2 – abgeschlossen und gemerged

**PR #2 – H2: Runtime stability and centralized scheduler** wurde am 2026-09-26 nach bestandenem Live-Test gemerged.

Merge-Commit:
`d90b3bf6294c447499f2e88ee0948b1c5374f964`

Im echten Adventure-Land-Client bestätigt:
- wiederholtes Start/Stop ohne Ressourcen-Leak;
- Scheduler-Ressourcen werden vollständig bereinigt;
- Runtime-Probe `passed: true`;
- Modul-Restarts erzeugen keine doppelten Timer;
- Emergency STOP räumt Scheduler sofort leer;
- Hot Reload funktioniert auch über getrennte Adventure-Land-Runner-Kontexte;
- gemeinsamer same-origin Host dient als Hot-Reload-Anker.

## H3 – abgeschlossen und gemerged

Aktiver Entwicklungsbranch:
`chatgpt/h3-game-adapter-knowledge`

PR:
**#3 – H3: Game adapter and Windows Bridge knowledge**

Ziel: read-only **Game Adapter & Knowledge**, weiterhin ohne Gameplay-Automation.

Bereits umgesetzt:
- normalisierter Adventure-Land-Game-Adapter für Character, Klasse, Level, Map, HP/MP, Position, Gold/XP und Target;
- Target-Auflösung aus Live-Entities inklusive Distanz;
- Server-/Entity-/GameData-Metadaten;
- bestehende dynamische Roster-Erkennung bleibt zentrale Account-/Farmer-Sicht;
- `WindowsBridgeKnowledgeProvider` als read-only Provider;
- bevorzugter same-origin Bridge-Handoff, falls vorhanden;
- fester GitHub-Mirror-Fallback auf `Riflex91/Riflex91-Repo/main/v5/wissensbasis/live/snapshot/**`;
- Validierung von Manifest, `BEREIT`-Status, Generation, Live-Fakten und Snapshot-SHA256;
- persistenter Last-Known-Good Cache;
- `WAITING_FOR_BRIDGE`, wenn noch kein Bridge-Snapshot existiert;
- Knowledge-Ausfall stoppt den Runtime-Core nicht;
- Knowledge-Tab und Live-Game-Anzeige im Control Center;
- automatische H1/H2/H3-Suite grün;
- `docs/H3-LIVE-TEST.md`.

Live-Test im echten Adventure-Land-Client: **BESTANDEN**.

Bestätigt:
- normalisierte Character-/Map-/HP-/MP-/Positionsdaten;
- Positionsanzeige mit zwei Nachkommastellen;
- dynamisches Roster;
- read-only KnowledgeProvider und korrektes `WAITING_FOR_BRIDGE` ohne Runtime-Ausfall;
- Target-Auflösung über die echte Adventure-Land-Quelle `parent.ctarget` mit erfolgreicher Live-Auflösung eines Monsters;
- H1/H2/H3-Regressionen grün.

PR #3 wurde am 2026-09-26 nach bestandenem Live-Test gemerged.

Merge-Commit:
`241947f27f4471849dd1da340a312e8818361d51`

## H4 – live bestanden, automatischer Merge freigegeben

Aktiver Entwicklungsbranch:
`chatgpt/h4-movement`

Ziel: **kontrollierte Bewegung** als erste produktive Gameplay-Write-Schicht.

Bereits im H4-Branch umgesetzt:
- zentrale `GameActionBoundary` für Adventure-Land-Writes;
- `move(x,y)` und `smart_move` nur hinter Runtime-/STOP-Gate;
- genau ein aktiver Movement-Owner;
- beobachtete Arrival-Postcondition statt Vertrauen auf `smart_move`-Return;
- lokale Bewegung mit `can_move_to`-Preflight;
- Target-Annäherung;
- Cancel;
- Retarget;
- Stuck-Erkennung;
- `UNKNOWN` ohne Blind-Retry;
- Anti-Pingpong-/Rapid-Switch-Schutz;
- Safe Point + Safe Return;
- best-effort Movement-Cleanup bei Stop/Hot Reload/Emergency STOP;
- Movement-Tab im Control Center;
- H4-Automatiktests;
- `docs/H4-LIVE-TEST.md`.

Live-Test im echten Adventure-Land-Client: **BESTANDEN**.

Bestätigt:
- lokales Move mit `ARRIVAL_VERIFIED`;
- Smart Move mit beobachteter Arrival-Evidence;
- Retarget mit sauberem Cancel des alten Auftrags und nur einem Movement-Owner;
- manuelles Cancel ohne Retry;
- Safe Point / Safe Return;
- Target-Annäherung ohne Attack;
- Movement-Ressourcen fallen nach Abschluss auf 0 zurück;
- Emergency STOP während laufendem Smart Move setzt Runtime auf stopped, Scheduler auf 0 Ressourcen und beendet den Auftrag als `CANCELLED / EMERGENCY_STOP`;
- best-effort Cleanup über `stop('smart')` und `use_skill('stop')`;
- keine Callback-/Overlap-Fehler;
- H1–H4 Regressionen grün.

User hat ab H4 eine dauerhafte Auto-Merge-Regel festgelegt: Nach vollständig bestandenem Schritt und allen Sicherheitschecks automatisch mergen.

## H2 Architekturregel für spätere Module

Spätere Gameplay-Module sollen eigene Timer/Listener nicht unkontrolliert direkt verwalten.

Ein Modul bekommt einen eigenen Resource-Scope:

```text
Module
  │
  ▼
ResourceScope
  ├─ interval
  ├─ timeout
  ├─ event
  └─ cleanup
        │
        ▼
Central Scheduler
```

Bei:
- normalem Stop,
- Modul-Restart,
- Crash,
- Emergency STOP,
- Hot Reload

werden die registrierten Ressourcen zentral entfernt.

Ein fehlerhaftes Scheduler-Callback eines Moduls soll nur dieses Modul in `ERROR` setzen und dessen Ressourcen entfernen. Der restliche Runtime-Core läuft weiter.

Der Watchdog markiert zunächst nur `STALE`; automatische Self-Healing-Aktionen folgen später in H23.

## Prioritäten-/Goal-System

Zwei Ebenen:

1. konkrete Goals, z.B. `Farme 200 XYZ`, `Level Ranger auf 80`, `Bessere Rüstung besorgen`;
2. strategische Grundprioritäten wie Leveln, Gold, Gear, Items, Events, Quests, Economy.

Hierarchie:

```text
1. Safety / STOP
2. konkreter manueller Auftrag
3. zeitkritische Aufgabe / Eventregel
4. strategische Prioritäten
5. Hintergrundarbeit
```

Goals brauchen klaren Scope, Fortschritt, Status und Abschlussbedingung.

## Dynamische Character-/Farmer-Erkennung

Keine hartcodierten Namen.

Bevorzugte Quellen:
- `get_characters()` für Account-Charaktere/Klassen;
- `get_active_characters()` für aktive Runner;
- lokaler `character` als sichere Mindestinformation.

Combat-Klassen werden als Farmer erkannt, `merchant` als Merchant.

Spätere Party-/Combat-/Logistics-Module müssen die zentrale Roster-Schicht verwenden.

## Windows Bridge / Knowledge

Zielarchitektur:

```text
Gameplay-Module
      │
      ▼
KnowledgeService
      │
      ▼
KnowledgeProvider
  ├─ Windows Bridge
  └─ Last-Known-Good Cache
```

Die Bridge ist keine harte Runtime-Abhängigkeit. H3 baut den echten Windows-Bridge-Provider und den Game Adapter aus.

## Diagnose-Workflow

Bei Fehler:
1. roten STOP drücken;
2. **Fehlerbericht kopieren**;
3. Bericht in ChatGPT einfügen;
4. kurze sichtbare Beobachtung ergänzen.

## Nächster Schritt

PR #4 nach vollständigen Merge-Checks mit Methode `merge` automatisch mergen. Danach **H5 – Combat** auf einem frischen Branch vom neuen `main` starten. Für kommende Schritte gilt dieselbe Auto-Merge-Regel.
