# AL Bot – Chat-Handoff / aktueller Projektstand

Stand: 2026-09-26  
Aktives Repository: `Riflex91/ALFinal`

## Zweck dieses Dokuments

Dieses Dokument ist der Einstiegspunkt für einen neuen Chat oder parallelen Arbeitskontext. Vor Implementierungsarbeiten müssen zusätzlich gelesen werden:

1. `README.md`
2. `docs/PROJECT-CHARTER.md`
3. `docs/ROADMAP.md`

Diese Dokumente bilden den aktuell verbindlichen Projektkontext.

## Aktueller Status

### Freigegeben und entschieden
- Produktname: **AL Bot**
- internes „V6“ ist nur eine Entwicklungsbezeichnung
- `Riflex91/ALFinal` ist das aktive Zielrepo
- Zuverlässigkeit ist oberste Priorität
- modularer Core
- Headless-Fähigkeit von Anfang an
- mitwachsende Haupt-GUI / Control Center
- globaler roter STOP
- Windows-Bridge-Knowledge-Anbindung
- Last-Known-Good Knowledge Cache
- Live-Spielwahrheit schlägt persistiertes Wissen bei zeitkritischen Aktionen
- direkte Live-Test-Häppchen statt langer V5-Gate-Ketten
- Prioritäten-/Goal-System als Kernbestandteil
- Roadmap H1–H29
- H1 enthält bereits das Grundgerüst für Prioritäten, Headless, Knowledge und Control Center

### Noch nicht begonnen
- eigentliche AL-Bot-Implementierung
- Gameplay-Code
- Runtime-Core-Code
- GUI-Code
- KnowledgeProvider-Code

### Nächster Schritt
**H1 / PR1 – AL Bot Foundation & Control Center**

H1 soll laut Roadmap enthalten:
- AL Bot Core
- Haupt-GUI / Control Center
- globaler STOP
- Logging
- Clipboard-Diagnose
- Modul-Registry
- Konfigurationssystem
- Headless-fähige Control API
- KnowledgeService-Schnittstelle
- Knowledge-Status in GUI
- Prioritäten-/Goal-Datenmodell
- Prioritäten-GUI-Grundgerüst

Danach folgt der erste echte Live-Test im Spiel.

## Verbindlicher Entwicklungsstil

### Zuverlässigkeit vor Funktionsmenge
Keine Funktion gilt als gut, wenn sie den Runtime-Core instabil macht.

### Modular statt monolithisch
Neue Bereiche müssen über klare Schnittstellen angebunden werden.

### GUI ist nur ein Client
Der Bot-Core darf nicht davon abhängen, dass die Haupt-GUI sichtbar ist.

### Headless-Grenzen von Anfang an
Kein zentraler Runtime-Service darf unnötig an Browser-DOM/UI gekoppelt werden.

### Zentraler STOP
Jedes später hinzukommende Modul muss in den globalen STOP-Lifecycle integrierbar sein.

### Knowledge nur abstrahiert
Gameplay-Module greifen nicht direkt auf Windows-Bridge-Dateien, GitHub-Rohdaten oder Knowledge-Rohsnapshots zu. Sie nutzen den read-only `KnowledgeService`.

## Prioritäten-/Goal-System – fest beschlossen

Es gibt zwei Ebenen:

1. **Konkrete Goals**
   - z.B. „Farme 200 XYZ“
   - „Besorge bessere Rüstung“
   - „Level Ranger auf 80“
   - „Verdiene 50 Millionen Gold“

2. **Strategische Grundprioritäten**
   - Leveln
   - Gold
   - Gear
   - Itemfarming
   - Events
   - Quests
   - Merchant/Economy

Prioritätshierarchie:

```text
1. NOTFALL / SAFETY / STOP
2. manueller konkreter Auftrag
3. zeitkritische Aufgabe / Eventregel
4. strategische Prioritäten
5. normale Hintergrundarbeit
```

Goals müssen:
- Fortschritt besitzen;
- pausierbar sein;
- bearbeitet/abgebrochen werden können;
- klare Abschlussbedingungen besitzen;
- einen Scope besitzen;
- ihren Blockierungsgrund diagnostizierbar machen.

Später darf der Strategic Brain mehrere Goals kombinieren.

## Windows Bridge / Knowledge – fest beschlossen

Ziel:

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

Die Bridge darf ausfallen, ohne dass der Core automatisch zusammenbricht.

Aktuelle Spielwahrheit bleibt maßgeblich für aktuelle:
- Positionen;
- HP/MP;
- Entities;
- Cooldowns;
- Inventar;
- aktuelle Target-/Combat-Situation.

## Testmodell

Nicht wieder als Pflichtprozess einführen:

```text
Shadow → Evidence → Authorization → One-shot → 5m → 15m
```

Stattdessen:

```text
Implementierung
→ schnelle automatische Tests
→ Live-Test im Spiel
→ bestanden / Fehlerbericht
→ nächstes Häppchen oder Korrektur
```

Bei riskanten realen Economy-Aktionen wird der erste Live-Test klein gehalten.

## Diagnose-Workflow für den User

Wenn etwas schiefgeht:

1. roten STOP drücken;
2. „Fehlerbericht kopieren“;
3. Bericht in ChatGPT einfügen;
4. kurze sichtbare Beobachtung ergänzen.

Der User soll nicht manuell mehrere Logs zusammensuchen müssen.

## Erwarteter H1-Live-Test

Nach H1 soll der User prüfen können:
- Control Center erscheint;
- Start/Stop funktionieren;
- globaler STOP reagiert;
- STOP kann bewusst zurückgesetzt werden;
- Fehlerbericht ist kopierbar;
- Knowledge-Status ist sichtbar;
- Prioritätenbereich ist sichtbar;
- ein Test-Goal kann angelegt/pausiert/abgebrochen werden;
- GUI funktioniert ohne Gameplay-Automation.

## Alte Repositories

`Riflex91/Riflex91-Repo` und V2–V5 dürfen für Architekturideen, Adventure-Land-Wissen und bewährte Mechanismen gelesen werden.

Sie sind aber **nicht** das Zielrepo des finalen Bots.

Keine alten V5-Gate-Strukturen ungeprüft in AL Bot übernehmen.

Sinnvolle alte Schutzmuster dürfen übernommen werden, insbesondere:
- irreversible Economy-Transaktionen;
- keine blinden Retries nach unbekanntem Ergebnis;
- Reservierungen;
- Restart Reconciliation;
- Anti-Pingpong;
- Progress-/Stuck-Watchdogs;
- zentrale Item-/Economy-Entscheidungen;
- Telemetrie/Diagnostik;
- Content Discovery/Drift.

## Arbeitsanweisung an den nächsten Chat

Vor jedem größeren Schritt:
1. aktuellen `main` lesen;
2. dieses Handoff und die beiden verbindlichen Projektdokumente lesen;
3. neuere Repo-Entscheidungen haben Vorrang vor diesem Snapshot;
4. bei H1/PR1 fortfahren, wenn kein neuerer Stand existiert;
5. keine Architekturvereinbarung stillschweigend aufweichen;
6. keine langen V5-Testketten wieder zum Pflichtprozess machen;
7. jeden Funktionsblock so schneiden, dass der User ihn klar im echten Spiel prüfen kann;
8. Stabilität, STOP-Fähigkeit, Modularität und Headless-Kompatibilität bei jeder Erweiterung erhalten.

## Momentaufnahme

Zum Zeitpunkt dieses Handoffs wurde ausschließlich Projektdokumentation erstellt. **Noch kein AL-Bot-Code wurde implementiert.**
