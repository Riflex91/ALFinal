# AL Bot – Project Charter

Stand: 2026-09-26  
Repository: `Riflex91/ALFinal`

Dieses Dokument ist verbindlicher Architektur- und Entwicklungsrahmen für AL Bot.

## 1. Name und Einordnung

- Das Produkt heißt **AL Bot**.
- Intern darf die neue Entwicklungsgeneration als „V6“ bezeichnet werden.
- Im sichtbaren Produkt, in der GUI, im normalen Code und in der Dokumentation soll nur **AL Bot** stehen.
- `Riflex91/ALFinal` ist das aktive Zielrepository.
- V2–V5 und `Riflex91/Riflex91-Repo` dienen nur als Referenz- und Wissensquelle.

## 2. Priorität 1: Zuverlässigkeit

Zuverlässigkeit hat Vorrang vor Funktionsmenge.

Der Core soll von Anfang an so gebaut werden, dass:
- einzelne Module nicht den gesamten Bot mitreißen;
- jeder größere Bereich einen klaren Lifecycle besitzt: `start`, `stop`, `restart`, `status`;
- Fehler isoliert werden;
- Timeouts, begrenzte Retries und Watchdogs vorgesehen sind;
- keine unkontrollierten Timer-/Interval-Strukturen über den Code verteilt werden;
- Timer, Jobs und Events zentral verwaltet werden;
- Hot-Reload und Stop zuverlässig alle registrierten Ressourcen bereinigen;
- Diagnose und Status jederzeit sichtbar sind;
- ein definierter sicherer Zustand existiert.

## 3. Modularität und Erweiterbarkeit

AL Bot darf kein monolithischer `bot.js` werden.

Ziel:
- kleiner stabiler Runtime-Core;
- klar abgegrenzte Module;
- definierte Services und Ports;
- gemeinsamer State-/Action-Layer;
- Combat, Navigation, Party, Merchant, Economy, Brain, Events usw. als austauschbare Module;
- Konfiguration getrennt von Verhalten;
- neue Funktionen sollen ergänzt oder ersetzt werden können, ohne den Core umzubauen.

## 4. Headless von Anfang an

Die GUI ist niemals Voraussetzung für die Bot-Funktion.

```text
GUI / Headless Host / andere Controller
                │
                ▼
          AL Bot Control API
                │
                ▼
            AL Bot Core
```

Der gleiche Core soll später laufen:
- im Adventure-Land-Browser;
- im lokalen Host-/Testbetrieb;
- im Headless-Betrieb.

Logs, Diagnose, STOP, Modulsteuerung, Prioritäten und Status benötigen deshalb APIs ohne DOM-Abhängigkeit.

## 5. Mitwachsende Haupt-GUI

Von H1/PR1 an entsteht das **AL Bot Control Center**.

Es wird später nicht ersetzt, sondern wächst mit dem Bot.

Geplante Tabs:
- Übersicht
- Prioritäten
- Combat
- Navigation
- Party
- Merchant
- Economy
- Brain
- Knowledge
- Logs
- Einstellungen
- Entwicklung

Module sollen ihre UI über eine generische Registrierung einhängen können. Der GUI-Core soll keine fachliche Modul-Logik kennen müssen.

## 6. Globaler roter STOP

Die langen V5-Pflichtketten sind **kein Standardprozess** für AL Bot:

```text
Shadow
→ Evidence
→ Authorization
→ One-shot
→ 5m
→ 15m
```

Stattdessen besitzt AL Bot von Anfang an einen permanent sichtbaren roten globalen **STOP**.

STOP soll bestmöglich:
- Scheduler anhalten;
- registrierte Timer stoppen;
- registrierte Event-Handler deaktivieren;
- laufende Module stoppen;
- neue Gameplay-Aktionen zentral verweigern;
- Bewegung bestmöglich abbrechen;
- Diagnosezustand einfrieren;
- STOP persistent merken;
- nach Reload nicht automatisch neu starten;
- erst nach manueller Aktion „STOP zurücksetzen“ wieder Arbeit erlauben.

Eine bereits an den Adventure-Land-Server gesendete Aktion kann nicht rückgängig gemacht werden. STOP muss aber alle folgenden Aktionen möglichst zentral und sofort verhindern.

## 7. Windows Bridge und Wissensdatenbank

AL Bot soll die von der bestehenden Windows Bridge bereitgestellte Adventure-Land-Wissensdatenbank nutzen können.

Zielarchitektur:

```text
AL Bot
  │
  ├── Combat
  ├── Navigation
  ├── Merchant
  ├── Economy
  ├── Party
  └── Brain
        │
        ▼
  KnowledgeService
        │
        ▼
  KnowledgeProvider
        │
        ├── Windows Bridge
        ├── Last-Known-Good Cache
        └── später ggf. weitere Provider
```

Regeln:
- Kein Gameplay-Modul liest direkt GitHub, Rohdateien oder Bridge-Interna.
- Gameplay-Module lesen persistiertes Wissen ausschließlich über den `KnowledgeService`.
- Knowledge-Zugriff ist read-only.
- Die Windows Bridge ist primäre Wissensquelle, aber keine harte Runtime-Abhängigkeit.
- Gültige Snapshots werden als Last-Known-Good gecacht.
- Fällt die Bridge aus, darf der Bot-Core nicht automatisch abstürzen oder mitten im Kampf einfrieren.
- Aktuelle Live-Spielwahrheit schlägt persistiertes Wissen bei zeitkritischen Entscheidungen.

Die bisherige Bridge ist historisch noch stark auf V5, das alte Repo und u.a. `D:\AdventureLand-V5\wissensdatenbank` ausgerichtet. Diese Kopplung soll für AL Bot später sauber entkoppelt werden.

## 8. Entwicklungsworkflow

Standard:

```text
ChatGPT entwickelt ein Häppchen / PR
        ↓
schnelle automatische Syntax-/Contract-/Smoke-Tests
        ↓
User lädt den Stand direkt in Adventure Land
        ↓
User beobachtet reales Verhalten
        ↓
"bestanden" / "läuft" / "weiter"
oder
STOP + Fehlerbericht + kurze Beobachtung
        ↓
Korrektur oder nächstes Häppchen
```

Keine verpflichtenden langen theoretischen Testketten.

Bei wertverändernden Funktionen wie Handel, Upgrade oder Compound beginnen die ersten Live-Tests trotzdem bewusst klein.

## 9. Diagnose

Das Control Center soll einen Button **„Fehlerbericht kopieren“** besitzen.

Der Bericht soll möglichst automatisch enthalten:
- AL-Bot-Version;
- PR-/Modulversion;
- Zeitstempel;
- Charakter und Map;
- HP/MP/Gold;
- Position;
- aktuelle Aufgabe;
- Target;
- letzte Aktion;
- Scheduler-Zustand;
- STOP-Zustand;
- Knowledge-Quelle, Generation, Alter und Status;
- geladene Module und deren Status;
- letzte Entscheidungen;
- letzte Logs;
- JavaScript Exceptions und Stacktraces;
- unhandled Promise Errors;
- aktive Goals und Prioritäten.

## 10. Prioritäten- und Goal-System

Das Prioritätssystem ist Kernbestandteil der Architektur und wird bereits in H1 strukturell vorgesehen.

### 10.1 Konkrete Goals

Beispiele:
- „Farme 200 XYZ“
- „Level Ranger auf 80“
- „Besorge bessere Rüstung“
- „Verdiene 50 Millionen Gold“

Ein Goal besitzt mindestens:
- ID;
- Typ;
- Priorität;
- Scope;
- Zielwert;
- Fortschritt;
- Status;
- Erstellzeit;
- Abschlussbedingung;
- Abbruchbedingung;
- Diagnose/Blockierungsgrund.

Mögliche Zustände:
- AKTIV
- PAUSIERT
- ERFÜLLT
- BLOCKIERT
- ABGEBROCHEN
- FEHLER

Jedes Goal braucht eine klare Abschlussbedingung.

Beispiel:

```text
Farme 200 XYZ
→ erfüllt, wenn Inventory + Bank >= 200
```

### 10.2 Strategische Grundprioritäten

Beispiele:
- Leveln = HOCH
- Gold verdienen = NORMAL
- Ausrüstung verbessern = HOCH
- Items farmen = NORMAL
- Events = NORMAL
- Quests = NIEDRIG
- Merchant/Economy = NORMAL

Der Strategic Brain nutzt diese Gewichtungen, wenn kein höher priorisiertes konkretes Goal die Arbeit vorgibt.

### 10.3 Prioritätshierarchie

```text
1. NOTFALL / SAFETY / globaler STOP
2. manueller konkreter Auftrag
3. zeitkritische Aufgabe / Eventregel
4. strategische Prioritäten
5. normale Hintergrundarbeit
```

Ein konkreter Auftrag wie „Farme 200 XYZ“ darf nicht ständig von einer allgemeinen XP-Optimierung verdrängt werden.

### 10.4 Scope

Goals/Prioritäten sollen gelten können für:
- Account;
- Party;
- einzelne Klasse;
- Merchant;
- einzelnen Charakter.

### 10.5 Kombinierbare Ziele

Der Planner soll später erkennen, wenn eine Aktion mehrere Ziele gleichzeitig bedient.

Beispiel: Ein Farmspot liefert das gewünschte Item, viel XP und Material für Gear. Dann darf dieser Spot entsprechend bevorzugt werden.

### 10.6 Prioritäten-GUI

Geplantes Grundbild:

```text
AL BOT > PRIORITÄTEN

AKTIVE ZIELE

1  HOCH      Farme 200x XYZ
              Fortschritt: 137 / 200
              Status: AKTIV
              [Pause] [Bearbeiten] [Abbrechen]

2  HOCH      Bessere Rüstung besorgen
              Ziel: Ranger
              Status: WARTET

3  NORMAL    Aufleveln
              Ziel: Party
              Bis: Level 80
              Status: WARTET

[ + NEUES ZIEL ]

GRUNDPRIORITÄTEN

Leveln                    HOCH
Gold verdienen            NORMAL
Ausrüstung verbessern     HOCH
Items farmen              NORMAL
Events                    NORMAL
Quests                    NIEDRIG
Merchant/Economy          NORMAL
```

Später kann eine Schnelleingabe wie „Farme erstmal 200 XYZ“ in ein strukturiertes Goal übersetzt werden. Intern bleibt das strukturierte Goal-Datenmodell maßgeblich.

## 11. Bewusst übernommene Schutzmuster aus V2–V5

Trotz des Verzichts auf die langen V5-Testketten bleiben folgende Prinzipien sinnvoll:
- Transactions für irreversible Economy-Aktionen;
- keine blinden Retries nach unbekanntem Ergebnis;
- reservierte Items schützen;
- Restart Reconciliation;
- Anti-Pingpong;
- Stuck-/Progress-Watchdogs;
- zentrale Item-/Economy-Entscheidungsmodelle;
- klare Action-/Authority-Grenzen;
- Telemetrie und Diagnose;
- Discovery/Content-Drift;
- modularer Runtime-Aufbau.
