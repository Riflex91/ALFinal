# AL Bot – Entwicklungsroadmap und Live-Test-Häppchen

Stand: 2026-09-27

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

**🟩 BESTANDEN – 2026-09-26**
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


Live-Ergebnis:
- Rogue/DPS, Warrior/TANK und Priest/HEALER live vollständig PASSED
- Merchant/LOGISTICS final observer-only `PASSED / ALL_STEPS_PASSED`
- Merchant ohne Combat-Start: `combatState = NOT_STARTED`, keine Attack-Dispatches
- `attackUnknown = 0`
- `focusPingPongs = 0`
- Cleanup vollständig, Runtime STOPPED, Scheduler danach 0 Ressourcen
- synchrones Support-UNKNOWN zusätzlich per Regressionstest fail-closed abgesichert

---

## H8 – AoE & adaptives Farming

**🟩 BESTANDEN – 2026-09-26**
- eigener `AdaptiveFarmingController`
- Pack-/Pull-Planung ausschließlich aus H5-`safeCandidates`
- dynamische Pack-Kapazität nach Klasse und HP-Reserve
- zusätzliches aggregiertes Monster-Angriffsbudget
- gleiche Monsterart innerhalb eines geplanten Packs
- Warrior: `cleave`, `stomp`
- Ranger: `3shot`, `5shot`
- Mage: `cburst`
- Rogue: `fanofknives`
- live Skill-Readiness statt fest angenommener Verfügbarkeit
- untargeted AoE fail-closed bei unsicherer Wirkzone
- H6-Pending/Support/Defensive bleibt vor H8 priorisiert
- bekannte Ablehnung -> Backoff
- UNKNOWN -> H8-Suspension ohne Blind-Retry
- Retreat/Single-Target-Fallback bei sinkender Sicherheitsreserve
- eigener Farming-Tab im Control Center
- Headless API `ALBot.farming.*`
- `docs/H8-LIVE-TEST.md`

**🟧 LIVE-TEST**
- Ein-Klick-Test über **Test starten**
- live-bereiten H8-AoE-Skill automatisch erkennen
- ausreichend großes H5-sicheres Pack gleicher Monsterart erkennen
- H8-Packplan innerhalb Kapazität/Risikobudget
- mindestens ein serverbestätigter AoE-Skill
- 5-Sekunden-Fenster ohne H8 UNKNOWN, H5 Attack-UNKNOWN oder H7 Focus-Pingpong
- Cleanup + Diagnosekopie automatisch
- Runtime danach wieder STOPPED, Scheduler 0 Ressourcen

Live-Ergebnis:
- Ein-Klick-Suite vollständig `PASSED / ALL_STEPS_PASSED`
- Ranger Level 60 mit live-bereitem `3shot`
- 6 sichere sichtbare Goo-Kandidaten im Preflight
- AoE-Plan: 3 Targets, Kapazität 5, aggregierter Attack-Wert 25
- 1 AoE dispatched, 1 serverbestätigt, 0 rejected, 0 UNKNOWN
- `attackUnknown = 0`
- `focusPingPongs = 0`
- Cleanup vollständig: Farming/Combat/Movement inaktiv
- Runtime STOPPED, Scheduler danach 0 Ressourcen

---

## H9 – Farm Intelligence

**🟩 BESTANDEN – 2026-09-26**
- eigener `FarmIntelligenceController`
- H5-sichere sichtbare Monstercluster als primäre Live-Kandidaten
- aktuelle Spawnpunkte aus live `G.maps`
- Kampfwerte aus live `G.monsters`, Gold aus `G.monster_gold`/`G.drops.gold`, Drops aus `G.drops.monsters`
- `evasion`/`avoidance` + Character-`damage_type` fließen in Trefferwahrscheinlichkeit und Kandidatenfilter ein
- physische Farmer schließen near-unhittable Ziele unter 25 % erwarteter Trefferchance vor Targeting/Farmwahl aus
- erklärbares Scoring:
  - XP-Effizienz
  - Gold-Effizienz
  - Drop-Signal
  - sichere Mob-Dichte
  - Reisezeit
  - Respawn-Signal
  - sichtbare Konkurrenz
  - Sicherheitskonfidenz
- H4 Smart Move für Spot-Reisen
- H8 Adaptive Farming für Combat/Farming-Ausführung
- delegierte H9→H8→H5→H4-Movement-Ownership wird korrekt erkannt
- keine direkten H9-Gameplay-Dispatches
- Ownership-Schutz für H4/H8
- Movement UNKNOWN/FAILED_SAFE -> Suspension ohne Blind-Retry
- Mindest-Hold + Switch-Cooldown + Score-Margin
- A→B→A Anti-Pingpong
- Beobachtungsbasis für Depletion/Respawn
- eigener Farm-Intelligence-Tab
- Headless API `ALBot.farmIntelligence.*`
- `docs/H9-LIVE-TEST.md`

**🟩 LIVE-TEST BESTANDEN**
- Ein-Klick-Suite: `PASSED / ALL_STEPS_PASSED`
- Preflight, Autonomous Start, Confirmed Farming, Adaptive Entscheidung, Stability und Cleanup jeweils PASSED
- initiale Auswahl: Goo-Spawn; spätere Live-Auswahl: Squigtoad
- mindestens ein echter H5-Basisangriff bestätigt
- adaptive Beobachtung: 63 Entscheidungen, 22 Holds, 2 Switches, 3 Travel Orders
- 6 Anti-Pingpong-Blocks ohne A→B→A-Verstoß
- H8 `aoeUnknown=0`
- H5 `attackUnknown=0`
- H7 `focusPingPongs=0`
- H9 `ownershipBlocks=0`
- H9 `movementUnknown=0`
- Cleanup vollständig: H9/H8/H5/H4 inaktiv
- Runtime STOPPED, Scheduler 0 Ressourcen

### 🟩 Meilenstein 1
Nach H9 existiert ein echter autonomer Farming-Bot.

---

## H10 – Loot & Inventar

**🟩 BESTANDEN – 2026-09-27**
- eigener `LootInventoryController`
- Live-Inventar aus `character.items` + Empty-Slot-Signal aus `character.esize`
- Live-Chests aus `get_chests()` / `chests`
- Loot ausschließlich über zentrale ActionBoundary
- 2 freie Slots als konservative Standardreserve
- Itemklassifizierung: `PROTECT / RESERVE / KEEP / BANK / EXCHANGE / SELL`
- locked, Giveaway, auslaufende, gelevelte, Gear-/Upgrade-/Compound- und Questitems geschützt
- normalisiertes `definition.quest === true` wird ebenfalls als Questschutz berücksichtigt
- aktive `COLLECT_ITEM`-Goals reservieren passende Items dynamisch
- unbekannter Wert defaultet zu `BANK`, niemals automatisch zu `SELL`
- `SELL` nur explizit per Regel freigebbar
- `nothing_to_loot` / `safety` als bekannte Skips
- Loot-`UNKNOWN` -> Suspension ohne Blind-Retry
- niemals settlender Loot-Promise -> bounded Outcome-Timeout -> `UNKNOWN` + Suspension
- expliziter Safety-Reset erforderlich
- Headless API `ALBot.inventory.*`
- eigener Control-Center-Tab **Loot & Inventar**
- keine destruktiven Sell/Bank/Exchange-Dispatches in H10
- `docs/H10-LIVE-TEST.md`

**🟩 LIVE-TEST BESTANDEN**
- Ein-Klick-Suite `h10-loot-inventory`: `PASSED / ALL_STEPS_PASSED`
- Preflight: 42 Slots, 4 benutzt, 38 frei, 4 geschützte Items
- H9 startete selbstständig sichere Goo-Farming-Probe
- bestätigter realer Loot: `lootDispatched=1`, `lootConfirmed=1`, `attacksConfirmed=1`
- Protection Delta: `checkedProtectedItems=4` und PASSED
- Stabilitätsfenster: `lootConfirmed=2`, `lootUnknown=0`, 38 freie Slots
- Cleanup: kein Pending Loot; H9/H8/H5/H4 inaktiv
- Runtime wieder STOPPED, Scheduler 0 Ressourcen
- nach dem Live-Test zwei P2-Review-Härtungen regressionsgetestet; Exact-Head-CI Run #210 `completed / success`
- beide P2-Review-Threads resolved

---

## H11 – Merchant-Grundbetrieb

**🟩 BESTANDEN – 2026-09-27**
- eigener `MerchantController`
- dynamische Rollen aus dem zentralen Account-Roster:
  - `MERCHANT`
  - `FARMER`
  - Observer/Unavailable fail-closed
- Farmer→eigener Merchant bei H10-Inventardruck
- kontrollierte Merchant→eigener-Farmer-Delivery
- Item-Transfers ausschließlich über zentrale ActionBoundary `send_item`
- Transferbestätigung ausschließlich über beobachtetes lokales Inventardelta
- temporär nicht verfügbares Inventar gilt niemals als Transfererfolg
- bounded Transfer-Outcome-Timeout -> UNKNOWN + Suspension ohne Blind-Retry
- MLuck-Service für sichtbare eigene Farmer
- gesunder MLuck wird nicht gespammt
- auslaufender MLuck gilt erst nach beobachtbarer Erneuerung als bestätigt
- bounded MLuck-Outcome-Timeout -> UNKNOWN + Suspension ohne Blind-Retry
- Service-Prioritäten:
  - explizite kontrollierte Delivery
  - Inventory-Pressure-Handoff
  - MLuck
  - Idle
- H4 Movement für Servicewege
- Service-Switch-Cooldown + A→B→A Anti-Pingpong
- fremde Targets blockiert
- Gear, Quest-/Goal-Reserve, locked, leveled, Upgrade-/Compound-Items blockiert
- kein `send_gold`
- keine Bank-/Sell-/Exchange-/Markt-Aktionen
- Headless API `ALBot.merchant.*`
- eigener Control-Center-Tab **Merchant**
- H11-Ein-Klick-Suite `h11-merchant`
- `docs/H11-LIVE-TEST.md`

**🟩 PRE-LIVE CI**
- Run #227 auf Head `593bfe3a961b326b534d1b449a6c248842f780b4`: `completed / success`
- 134/134 Tests grün
- fünf Review-Funde abgearbeitet und Threads resolved
- nach Dokumentationscommits ist erneut Exact-Head-CI erforderlich

**🟩 LIVE-TEST BESTANDEN**
- Suite `h11-merchant`: `PASSED / ALL_STEPS_PASSED`
- Merchant `My_Merchant`, eigener sichtbarer Farmer `My_Priest`
- exakt 1 `hpot0` geliefert; Sender-Inventar `6000 -> 5999`
- `transfersConfirmed=1`, `transfersUnknown=0`
- MLuck bereits gesund, daher kein unnötiger Cast
- `mluckUnknown=0`, `pingPongBlocks=0`
- Cleanup ohne Pending, Delivery oder H11-Movement
- Runtime wieder STOPPED, Scheduler `totalResources=0`
- finale Evidence: `docs/H11-LIVE-TEST.md`

H11 wurde nach bestandenem Live-Test und sauberem Exact-Head-Gate als PR #11 gemergt. Merge-Commit: `0b8b45089ae47ea352e05115074142a427d7ff79`.

---

## H12 – Bank

**🟩 BESTANDEN – 2026-09-27**

**BAU**
- Live-Bank-Snapshot aus `character.bank`
- verifizierte Pack→Bank-Map-Zuordnung; unbekannte Zuordnung fail-closed
- Bank-Suche
- sichere Item-Deposits via ActionBoundary `bank_store`
- sichere Item-Withdraws via ActionBoundary `bank_retrieve`
- Gold Deposit/Withdraw via `bank_deposit` / `bank_withdraw`, nur bei beobachtbaren Goldständen
- automatische Deposits nur für H10-Disposition `BANK`
- Reservierungen und Workspace-Pack
- Inventory/Bank Reconciliation
- H4-Bankfahrt mit Owner `bank-h12`
- bounded UNKNOWN + Suspension, kein Blind-Retry
- Headless API `ALBot.bank.*`
- Control-Center-Tab **Bank**
- H12-Ein-Klick-Suite `h12-bank`
- `docs/H12-LIVE-TEST.md`

**🟩 PRE-LIVE CI**
- Run #235: 144/144 Tests grün
- H1–H11 Regressionen grün
- zusätzlicher Pack→Map-Fail-Closed-Patch eingebaut
- `dist/al-bot.js` source-synchron auf `0.12.0-h12`
- nach finalen Bundle-/Dokumentationscommits erneut Exact-Head-CI

**🟩 LIVE-TEST BESTANDEN**
- Suite `h12-bank`: `PASSED / ALL_STEPS_PASSED`
- Merchant `My_Merchant`
- `slice_honey` x155 aus Inventarslot 3 in `items0/0` eingelagert
- derselbe Stack vollständig zurück in Slot 3 geholt
- `depositsConfirmed=1`, `withdrawalsConfirmed=1`
- `depositsUnknown=0`, `withdrawalsUnknown=0`, `movementUnknown=0`
- `reconciliationEntries=43`, `reconciliationFailures=0`, `itemRestored=true`
- Cleanup ohne Pending/Request/H12-Movement
- Runtime wieder STOPPED, Scheduler `totalResources=0`
- finale Evidence in `docs/H12-LIVE-TEST.md`

Vor Merge: neuen Exact-Head-CI und vollständigen Merge-Gate erneut prüfen.
---

## H13 – Handel

**🟩 BESTANDEN – 2026-09-27**

H13 basiert nach bestandenem und gemergtem H12 direkt auf dem aktuellen `main`.

**BAU**
- NPC Buy via ActionBoundary `buy_with_gold`
- NPC Sell via ActionBoundary `sell`
- Player Market Buy/Sell via `trade_buy` / `trade_sell`
- Live-NPC-Shopquellen aus `G.npcs` + `find_npc`
- sichtbare Player-Listings aus Live-Trade-Slots
- Ask/Bid-Trennung (`b=true` = Buy-Order)
- verpflichtende Maximalpreise für Käufe
- verpflichtende Mindestpreise für Player-Market-Verkäufe
- Listing-`rid` + Preis + Menge direkt vor Dispatch erneut geprüft
- CODE-Wrapper/native Trade-Signaturen werden über ActionBoundary normalisiert
- Goldreserve
- automatische Sell-Auswahl ausschließlich H10-Disposition `SELL`
- Acquisition wählt nur eine Quelle, die die komplette angeforderte Menge innerhalb des Preislimits liefern kann
- H4-NPC-Fahrt mit Owner `trade-h13`
- Inventory-/Gold-Delta-Bestätigung
- bounded UNKNOWN + Suspension, kein Blind-Retry
- Headless API `ALBot.trade.*`
- Control-Center-Tab **Handel**
- H13-Ein-Klick-Suite `h13-trade`
- `docs/H13-LIVE-TEST.md`

**🟩 PRE-LIVE CI**
- vorheriger gestapelter H13-Head: Run #256, 160/160 Tests grün
- alle Codex-Review-Funde behoben und resolved
- neuer H13-v2-Branch wird auf aktuellem H12-Merge-`main` erneut Exact-Head-CI geprüft
- `dist/al-bot.js` source-synchron auf `0.13.0-h13`

**🟩 LIVE-TEST BESTANDEN**
- Suite `h13-trade`: `PASSED / ALL_STEPS_PASSED`
- Merchant `My_Merchant`
- 1 x `hpot0` zum Live-NPC-Preis 20 Gold gekauft
- Inventar: `5999 -> 6000`
- Gold: `14195004 -> 14194984`
- `npcBuysConfirmed=1`
- Player-Market read-only: 51 Asks, 1 Bid
- `marketBuysDispatched=0`, `marketSellsDispatched=0`
- alle H13-UNKNOWN-Deltas 0
- Cleanup ohne Pending/Request/H13-Movement
- Runtime wieder STOPPED, Scheduler `totalResources=0`
- Post-Live Hardening: globaler Spread nur bei gleichem Item+Level; Goldreserve vor Buy-Dispatch erneut geprüft; NPC-/Market-Sell-Safety und exakte Bid-Variante unmittelbar vor Dispatch erneut geprüft
- finale Evidence in `docs/H13-LIVE-TEST.md`

H13 wurde nach bestandenem Live-Test, Post-Live-Hardening und sauberem Exact-Head-Gate als PR #14 gemergt.
Merge-Commit: `5238d4af8bfb99e6f6fe04d13029b80f77a9f420`.
---

## H14 – Gear

**🟩 BESTANDEN – 2026-09-27**

**BAU**
- Live-Equipment-Snapshot aus Character-/Player-Slots
- Equipment-Definitionen und Klassenprofile aus Live-`G`
- klassenabhängiges Gear-Ranking
- sichere lokale Equip-/Unequip-Swaps via ActionBoundary
- Zielslot-Revalidation unmittelbar vor Equip
- Combat-Block
- Zwei-Hand-/Offhand-Konflikte fail-closed
- locked/gift/giveaway/expiring Gear aus Automation ausgeschlossen
- Farmer-vor-Merchant-Gruppenpriorität
- Merchant-only Remote-Proposals mit transfer-sicherem Gear
- Gear Goals: `ACHIEVED`, `READY_TO_EQUIP`, `READY_TO_DELIVER`, `NEEDS_ACQUISITION`
- explizite Merchant→eigener-Farmer-Gear-Delivery
- Replacement-Planung
- Upgrade-/Compound-Kandidaten read-only für H15
- beobachtete Equipment-/Inventar-Deltas als Bestätigung
- bounded UNKNOWN + Suspension, kein Blind-Retry
- Headless API `ALBot.gear.*`
- Control-Center-Tab **Gear**
- H14-Ein-Klick-Suite `h14-gear`
- `docs/H14-LIVE-TEST.md`

**🟩 PRE-LIVE CI**
- Run #276: 179 Tests, 178 PASS, 1 echter Safety-Fund
- Fund behoben: locked Gear wird nicht mehr automatisch geplant/ausgerüstet
- Review P2 behoben: eindeutige Inventarzuweisung über austauschbare Slots wie `ring1/ring2`
- Run #287: 181/181 PASS, 0 FAIL, 0 SKIP, Workflow completed/success
- beide Review-Threads resolved
- `dist/al-bot.js` source-synchron auf `0.14.0-h14`
- nach diesem Dokucommit erneut Exact-Head-CI erforderlich

**🟩 LIVE-TEST BESTANDEN**
- Suite `h14-gear`: **PASSED / ALL_STEPS_PASSED**
- Runtime `0.14.0-h14`
- Merchant `My_Merchant`, Zielslot `shoes`
- echte Verbesserung: `wshoes +5` → `shoes1 +3`, Score-Delta `+14.73`
- Equip real bestätigt und Original danach exakt zurückgerüstet
- `equipsConfirmed=2`
- Farmer-Priorität `100` vor Merchant-Priorität `10`
- Equip-/Unequip-/Delivery-UNKNOWN jeweils `0`
- keine Suspension
- Cleanup ohne Pending/Request; vorherige Goals restauriert
- Runtime wieder STOPPED, Scheduler `totalResources=0`

H14 ist live bestanden. Vor Merge bleiben nur neuer Exact-Head-CI und der vollständige frische Merge-Gate-Check.

---

## H15 – Upgrade & Compound

**✅ IMPLEMENTIERT · LIVE BESTANDEN · FINALER MERGE-CI OFFEN**

**BAU**
- eigener `UpgradeCompoundController`
- Upgrade-/Compound-Writes ausschließlich über ActionBoundary
- Live-Inventar-Revalidation unmittelbar vor Dispatch
- protected Items aus Automation ausgeschlossen
- Grade-basierte Scrollwahl: `scroll0/1/2` und `cscroll0/1/2`
- Offering-Policy `DISABLED / OPTIONAL / REQUIRED`
- Level-, Itemwert-, Consumable- und Session-Attempt-Budgets
- logischer Workspace mit reservierten Slots
- exakt drei identische Items pro Compound
- Combat-Block
- beobachtete Inventar-/Consumable-Deltas als Ergebnis-Wahrheit
- bekannte Outcomes `SUCCEEDED / FAILED`
- bounded UNKNOWN + Suspension ohne Blind-Retry
- Headless API `ALBot.upgrade.*`
- Control-Center-Tab **Upgrade & Compound**
- H15-Ein-Klick-Suite `h15-upgrade-compound`
- `docs/H15-LIVE-TEST.md`
- H15-Regressionen für Safety, Budget, Offering, Source-Drift und Outcome-Prüfung
- Review-Hardening: Offering-Level 0, Quest/Cash-Schutz und Compound-Gesamtrisiko
- CI Run #323: 194/194 PASS, 0 FAIL, 0 SKIP, completed/success
- alle bisherigen Review-Threads resolved
- Bundle exakt source-synchron auf `0.15.0-h15`
- nach den finalen Evidence-Dokucommits erneut Exact-Head-CI erforderlich

**🟧 LIVE-TEST NOCH AUSSTEHEND**
- genau eine echte niedrig riskante Upgrade- oder Compound-Aktion
- temporäres Live-Test-Risikobudget: Itemwert ≤ 25.000 Gold, Consumables ≤ 10.000 Gold
- maximal ein Versuch
- Offering im Live-Test deaktiviert
- serverseitiges `SUCCEEDED` oder bekanntes `FAILED` ist zulässiges Ergebnis
- UNKNOWN ist immer FAIL
- 5-Sekunden-Stabilität ohne Retry/Suspension
- Cleanup + Runtime Auto-Restore

Falls kein geeigneter Kandidat vorhanden ist:
`H15_NEEDS_LOW_RISK_UPGRADE_OR_COMPOUND_CANDIDATE`

Dann wird nichts verändert.

Finale Live-Evidence:
- Suite `h15-upgrade-compound`: **PASSED / ALL_STEPS_PASSED**
- echte Aktion: `gloves +0 → +1`
- Outcome: `UPGRADE_SUCCEEDED`
- Evidence: `INVENTORY_LEVEL_DELTA`
- genau 1 Versuch
- beide UNKNOWN-Deltas 0
- keine Suspension
- Cleanup ohne Pending/Request
- Runtime Auto-Restore erfolgreich, Scheduler danach `totalResources=0`

H15-Live-Gate ist bestanden. Nach den Evidence-Dokucommits ist nur noch der neue Exact-Head-CI plus vollständiger Merge-Gate-Check erforderlich.

---

## H16 – Exchange & Craft

**🟦 IMPLEMENTIERT · CI/REVIEW IN ARBEIT · LIVE-TEST OFFEN**

**BAU**
- eigener `ExchangeCraftController`
- Exchange-/Craft-Writes ausschließlich über ActionBoundary
- Exchange-Mengen aus Live-`G.items[*].e`
- Craft-Rezepte aus Live-`G.craft`
- Quest-/Event Exchange und Craft standardmäßig fail-closed; nur explizites Opt-in
- protected Items aus Automation ausgeschlossen
- Craft-Quellslotwahl passend zu Adventure Lands `auto_craft`
- unmittelbare Source-/Definition-Revalidation vor Dispatch
- Exchange-Value-at-Risk-, Craft-Gold-, Craft-Input- und Session-Budgets
- Goldreserve und Combat-Block
- Live-Deltas als Ergebnis-Wahrheit
- bounded UNKNOWN + Suspension ohne Blind-Retry
- rekursiver Produktionsgraph mit Cycle-/Depth-Guard
- lokales Inventar + optional gemounteter Bankbestand in Produktionsplanung
- fehlende Materialien mit Bank-/NPC-/Marktquellen
- explizite Materialbeschaffung via H12 Bank oder H13 Handel
- gemeinsamer autonomer Economy-Konfliktlöser bewusst erst H17
- Headless API `ALBot.exchangeCraft.*`
- Control-Center-Tab **Exchange & Craft**
- H16-Regressionen und `docs/H16-LIVE-TEST.md`

**🟧 LIVE-TEST NOCH AUSSTEHEND**
- Suite `h16-exchange-craft`
- bevorzugt echte `CRAFT_TO_EXCHANGE_CHAIN`
- sonst sichere `CRAFT_AND_EXCHANGE_COVERAGE`
- maximal zwei echte H16-Aktionen
- niedrige temporäre Risiko-/Kostenbudgets
- keine Quest-/Event-Aktion im automatischen Live-Test
- Craft und Exchange jeweils über Live-Deltas bestätigen
- beide UNKNOWN-Deltas 0
- 5-Sekunden-Stabilität ohne Retry/Suspension
- Cleanup + Runtime Auto-Restore

Fehlen sichere Craft-/Exchange-Kandidaten:
`H16_NEEDS_LOW_RISK_CRAFT_AND_EXCHANGE_CANDIDATES`

Dann wird nichts verändert.

H16 wird erst nach grünem Exact-Head-CI, sauberem Review-Gate und echtem Adventure-Land-Live-PASS gemergt.

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
