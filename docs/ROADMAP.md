# AL Bot – Entwicklungsroadmap und Live-Test-Häppchen

Stand: 2026-09-26

## Legende

- **🟦 BAU** – ChatGPT entwickelt intern zusammengehörige Funktionen.
- **🟧 LIVE-TEST** – User testet das Häppchen direkt im echten Adventure Land.
- **🟥 STOP** – globaler roter Not-Aus muss in jedem Stadium funktionieren.
- **🟩 BESTANDEN** – Stand gilt als funktionierend und der nächste Block beginnt.

## H1 – Foundation & Control Center

**🟦 BAU**
- AL Bot Core
- Haupt-GUI / Control Center
- globaler STOP
- Logging
- Clipboard-Diagnose
- Modul-Registry
- Konfigurationssystem
- Headless-fähige Control API
- KnowledgeService-Schnittstelle
- Knowledge-Status in der GUI
- Prioritäten-/Goal-Datenmodell
- Prioritäten-GUI-Grundgerüst
- dynamische Character-/Farmer-Erkennung ohne hartcodierte Namen

**🟧 LIVE-TEST**
- GUI erscheint
- Start/Stop funktioniert
- STOP reagiert
- Fehlerbericht lässt sich kopieren
- Prioritätenbereich ist sichtbar
- Grundaktionen der GUI funktionieren

---

## H2 – Runtime-Stabilität

**🟦 BAU**
- zentraler Scheduler
- Timer-/Event-Verwaltung
- Module Lifecycle
- Crash-Isolation
- Watchdog-Basis
- Hot Reload
- Cleanup

**🟧 LIVE-TEST**
- Bot mehrfach starten/stoppen/neuladen
- keine doppelten Timer
- keine hängenden Module
- STOP bleibt zuverlässig

---

## H3 – Game Adapter & Knowledge

**🟦 BAU**
- Adventure-Land-Adapter
- robuste Roster-Erkennung auf Basis von `get_characters()` + `get_active_characters()`
- normalisierte Character-/Game-Snapshots
- Windows-Bridge-KnowledgeProvider
- Last-Known-Good Cache

**🟧 LIVE-TEST**
- Character, Map, HP/MP, Position und Target stimmen
- eingeloggte Farmer werden ohne Namenskonfiguration korrekt erkannt
- Knowledge-Status wird korrekt angezeigt
- Bridge-Ausfall darf den Core nicht abstürzen lassen

---

## H4 – Bewegung

**🟦 BAU**
- `smart_move`
- lokale Bewegung
- Zielannäherung
- Cancel
- Retarget
- Stuck-Erkennung
- Anti-Pingpong
- safe return

**🟧 LIVE-TEST**
- mehrere Ziele kontrolliert anlaufen
- kein Hin-und-her
- STOP hält Bewegung an

---

## H5 – Einfacher Kampf

**🟩 BESTANDEN – 2026-09-26**

**🟦 BAU**
- Targeting
- Attack Loop
- Range
- Cooldowns
- HP/MP-Regeln
- einfacher Rückzug
- Kiting-Grundlage

**🟧 LIVE-TEST**
- Ein-Klick-Test über das Control Center
- Bot wählt selbst ein konservativ sicheres sichtbares Monster
- Targeting, Range, Cooldown, bestätigte Attack-Evidence und Cleanup laufen automatisch
- Ergebnis wird sichtbar abgeschlossen und Diagnose automatisch in die Zwischenablage kopiert
- anschließend einfache Monsterart stabil autonom farmen

Live-Ergebnis:
- Ein-Klick-Suite vollständig PASSED
- 3 Targets, 3 bestätigte Angriffe, 3 bestätigte Kills
- kein `UNKNOWN`
- Cleanup vollständig

---

## H6 – Klassenlogik

**🟩 BESTANDEN – 2026-09-26**

**🟦 BAU**
- Ranger-/Mage-/Warrior-/Priest-/Rogue-/Paladin-spezifische Skills
- Cooldown-/Ressourcenplanung
- Support-/Defensive Skills
- Spam-Vermeidung

**🟧 LIVE-TEST**
- Ein-Klick-Test über **Test starten**
- aktuelle Klasse und Live-`G.skills` werden automatisch erkannt
- Bot wählt selbst einen konservativ sicheren Gegner
- mindestens ein klassenspezifischer Skill muss serverbestätigt eingesetzt werden
- 5-Sekunden-Fenster prüft UNKNOWN, Cooldown-/MP-Planung und Anti-Spam
- Cleanup + Diagnosekopie automatisch
- verwendete Charaktere nutzen Skills sinnvoll
- kein unnötiger Skill-Spam

Live-Ergebnis:
- Ein-Klick-Suite vollständig PASSED
- Ranger live mit Hunter's Mark + Supershot validiert
- 2 Class-Skills dispatched, 2 bestätigt
- 0 rejected, 0 UNKNOWN
- H4-Range-Annäherung und H5-Basiscombat blieben stabil
- Cleanup vollständig, Scheduler danach 0 Ressourcen

---

## H7 – Party

**🟦 BAU – aktuell**
- Party-Erkennung aus Live-Party-State + sichtbaren Entities
- Owned-/Foreign-Validierung ohne hartcodierte Namen
- Assist
- stabiler Focus Fire mit Anti-Pingpong-Hold
- Healing
- Rollen
- Buff-/Aura-Live-Sicht
- Revive/Recovery-Basis
- Support-UNKNOWN ohne Blind-Retry

**🟧 LIVE-TEST**
- Ein-Klick-Test über **Test starten**
- mindestens zwei eigene Charaktere müssen bereits in derselben Party sein
- Rollen und Party-Zusammensetzung automatisch prüfen
- Combat und Party-Focus müssen konvergieren
- Party-Health-/Recovery-Sicht automatisch prüfen
- 5-Sekunden-Fenster auf UNKNOWN und Focus-Pingpong
- Cleanup + Diagnosekopie automatisch
- mehrere Charaktere kämpfen als koordinierte Gruppe

---

## H8 – AoE & adaptives Farming

**🟦 BAU**
- AoE
- Pull Limits
- Mob-Dichte
- Risiko
- dynamische Gegnerzahl
- Retreat
- verbessertes Kiting

**🟧 LIVE-TEST**
- größere Gruppen kontrolliert farmen
- kein Überziehen
- kein Pingpong
- sinnvoller Rückzug

---

## H9 – Farm Intelligence

**🟦 BAU**
- Monsterwahl
- XP-/Gold-/Drop-Effizienz
- Reisezeit
- Respawn
- Konkurrenz
- Farmspot-Wechsel
- Anti-Pingpong-Entscheidungen

**🟧 LIVE-TEST**
- Bot wählt und wechselt Farmziele selbstständig und nachvollziehbar

### 🟩 Meilenstein 1
Nach H9 existiert ein echter autonomer Farming-Bot.

---

## H10 – Loot & Inventar

**🟦 BAU**
- Loot
- Inventarplatz
- Itemklassifizierung
- Keep/Reserve/Sell/Bank/Exchange
- Schutz wichtiger Items

**🟧 LIVE-TEST**
- mehrere Farmzyklen beobachten
- nichts Wichtiges darf verloren gehen

---

## H11 – Merchant-Grundbetrieb

**🟦 BAU**
- Merchant Loop
- Farmer↔Merchant-Logistik
- MLuck
- Pickup/Delivery
- Inventory Pressure
- Service-Prioritäten
- Anti-Pingpong

**🟧 LIVE-TEST**
- Merchant arbeitet selbstständig mit den Farmern
- keine Aufgaben-Pingpong-Schleifen

---

## H12 – Bank

**🟦 BAU**
- Deposit/Withdraw
- Bank-Suche
- Packs
- Reservierungen
- Workspace
- Bank/Inventory Reconciliation

**🟧 LIVE-TEST**
- automatische Banknutzung
- Items bleiben nach Aktionen eindeutig auffindbar

---

## H13 – Handel

**🟦 BAU**
- NPC Buy/Sell
- Player Market Analysis
- sichere Preis-/Kauf-/Verkaufsregeln
- Acquisition

**🟧 LIVE-TEST**
- kleine kontrollierte reale Handelsaktionen

---

## H14 – Gear

**🟦 BAU**
- beste Ausrüstung pro Charakter
- Gruppenprioritäten
- Gear Goals
- Farmer vor Merchant
- Swaps
- Replacement-/Upgrade-Planung

**🟧 LIVE-TEST**
- Bot erkennt bessere Ausrüstung
- verteilt/switcht Gear korrekt

---

## H15 – Upgrade & Compound

**🟦 BAU**
- Upgrade-/Compound-Planung
- Scrollwahl
- Offering-Regeln
- Kosten-/Risikobudget
- Workspace
- Ergebnisprüfung

**🟧 LIVE-TEST**
- zunächst wenige reale Gegenstände
- Auswahl und Ergebnisverarbeitung prüfen

---

## H16 – Exchange & Craft

**🟦 BAU**
- Exchange NPCs
- Quest-/Event Exchange
- Crafting
- Produktionsgraph
- Materialbeschaffung

**🟧 LIVE-TEST**
- kleine vollständige Produktions-/Exchange-Kette automatisch durchlaufen lassen

---

## H17 – Economy Autonomy

**🟦 BAU**
- gemeinsamer Planner für Bank, Markt, Gear, Upgrade, Compound, Exchange und Craft
- Konflikt- und Prioritätsauflösung

**🟧 LIVE-TEST**
- Merchant über längeren Zeitraum autonom arbeiten lassen

### 🟩 Meilenstein 2
Nach H17 besitzt AL Bot Farming plus vollständige Merchant-/Economy-Basis.

---

## H18 – Party-Logistik

**🟦 BAU**
- Potions
- Scrolls
- Elixiere
- Items-/Gold-Verteilung
- Supplies
- Regrouping

**🟧 LIVE-TEST**
- Gruppe versorgt sich selbst
- Gruppe wird nach Unterbrechungen wieder vollständig

---

## H19 – Character Lifecycle & Recovery

**🟦 BAU**
- Character Start/Stop
- Party Recovery
- Disconnect Recovery
- Death Recovery
- Restart Recovery

**🟧 LIVE-TEST**
- Tod/Disconnect/Restart gezielt auslösen
- Bot soll selbstständig zurückfinden

---

## H20 – Boss / Event / Quest

**🟦 BAU**
- Event Detection
- Boss Planning
- Quest Targets
- Special Encounters
- temporäre Prioritätswechsel

**🟧 LIVE-TEST**
- echten Event-/Boss-/Quest-Ablauf beobachten

---

## H21 – World Discovery

**🟦 BAU**
- unbekannte Maps/NPCs/Monster/Items erkennen
- Knowledge aktualisieren
- Content Drift erkennen
- Deadlock bei unbekanntem Content verhindern

**🟧 LIVE-TEST**
- bekannte und unbekannte Inhalte besuchen
- Bot darf nicht festhängen

---

## H22 – Strategic Brain

**🟦 BAU**
- sinnvolle Teacher/Student/Learning-Konzepte aus V2/V3 übernehmen
- Outcome Measurement
- Farm-/Economy-Entscheidungen
- langfristige Optimierung
- mehrere Goals intelligent kombinieren
- strategische Prioritäten nutzen
- schneller deterministischer Combat-Core darf nicht ausgebremst werden

**🟧 LIVE-TEST**
- Bot mehrere Stunden selbst entscheiden lassen
- Entscheidungen müssen im GUI nachvollziehbar sein

---

## H23 – Supervisor / Self-Healing

**🟦 BAU**
- Progress Watchdog
- Deadlock Detection
- Stuck Recovery
- Module Restart
- Backoff
- Circuit Breaker

**🟧 LIVE-TEST**
- einzelne Fehler absichtlich erzeugen
- Bot soll sich erholen statt komplett auszufallen

---

## H24 – Dauerbetrieb / Performance

**🟦 BAU**
- Memory Leaks
- Timer Leaks
- Scheduler Load
- Log Limits
- Cleanup
- langfristiger Zustand

**🟧 LIVE-TEST**
- mehrere Stunden
- später über Nacht

---

## H25 – Finales Control Center

**🟦 BAU**
- alle gewachsenen Panels konsolidieren
- Characters
- Tasks
- Prioritäten
- Farmziel
- Merchant
- Economy
- Brain
- Knowledge
- Errors
- STOP
- Module

**🟧 LIVE-TEST**
- komplette Bedienung über das AL Bot Control Center

---

## H26 – Headless

**🟦 BAU**
- gleicher Core ohne GUI-/DOM-Abhängigkeit
- Headless Host Adapter
- Remote Status/Commands
- gleicher STOP-Mechanismus

**🟧 LIVE-TEST**
- Headless-Testbetrieb mit Browserbetrieb vergleichen

---

## H27 – Updater & Rollback

**🟦 BAU**
- sichere Updates
- Modulversionen
- Last-Known-Good
- Rollback

**🟧 LIVE-TEST**
- Update auf neue Version
- absichtlicher Rollback

---

## H28 – V2–V5 Feature Audit

**🟦 BAU**
- alle alten Funktionen systematisch gegen AL Bot vergleichen
- nur wirklich fehlende sinnvolle Features portieren

**🟧 LIVE-TEST**
- neu übernommene Funktionen gezielt prüfen

---

## H29 – Gesamtintegration / Release Candidate

**🟦 BAU**
- Konflikte zwischen Combat, Travel, Party, Merchant, Economy, Brain und Recovery auflösen

**🟧 LIVE-TEST**
- vollständiger normaler Adventure-Land-Betrieb ohne künstliches Testszenario

---

# 🏁 AL Bot Release

Nach stabilem Gesamtstand folgen nur noch kleine direkt testbare:
- Bugfixes
- Optimierungen
- neue Adventure-Land-Inhalte
- neue Features

## Entwicklungsreihenfolge

Bevorzugt:
1. H1–H9 zügig bis zu einem echten stabilen Farming-Bot.
2. H10–H17 Merchant/Economy.
3. Strategic Brain erst dann, wenn schnelle deterministische Systeme stabil arbeiten.

## Standard-Live-Testablauf ab H5

Live-Tests werden als wiederverwendbare Ein-Klick-Suites gebaut.

```text
Code
→ automatische CI/Kurztests
→ 🟧 Control Center: „Test starten“
→ Bot führt alle definierten Live-Schritte automatisch aus
→ sichtbarer Endstatus BESTANDEN / FAILED / CANCELLED
→ Diagnosebericht wird automatisch in die Zwischenablage kopiert
→ 🟩 bestanden
→ nächstes Häppchen
```

Der globale rote STOP bleibt jederzeit vorrangig. Sicherheitskritische Preconditions wie ein gelatchter STOP werden niemals automatisch aufgehoben.

Bei Fehler:

```text
Test bricht fail-safe ab
→ sichtbarer fehlgeschlagener Schritt
→ automatisch kopierten Bericht in ChatGPT einfügen
→ falls Browser Clipboard blockiert: einmal „Fehlerbericht kopieren“
→ Korrektur
→ erneut nur „Test starten“
```
