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
- Suite v5 Preflight-Diagnostik: strukturierte Reject-Zähler + Top-5-Fast-Matches vor fail-closed Abbruch

**🟦 IMPLEMENTIERT · LIVE V1 FAIL-CLOSED · V2 TECHNISCH/REVIEW GRÜN · FINALER DOKU-CI OFFEN · LIVE V2 OFFEN**

PR #19 / Suite v5 Diagnose-Hardening, technischer Gate-Stand vom 2026-09-27:
- technischer Head `c923147b9d3eda0d132b63d441c25c29aea525d7`
- CI #393: **216/216 PASS**
- frischer Codex-Review auf exakt diesem technischen Head: **keine major issues**
- alle Review-Threads resolved
- zusätzliche Diagnose für lokale READY-Pairing-Blocker sowie nicht betretbaren Material-Fallback
- keine Safety-Lockerung, kein neuer Mutation-Pfad
- nach den anschließenden Dokucommits ist erneut Exact-Head-CI + vollständiger Merge-Gate erforderlich

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
- Safety-Hardening: rejected dispatched promises -> UNKNOWN-Suspension
- verifizierte NPC-Ankunft erforderlich: nur `COMPLETED / ARRIVAL_VERIFIED`
- Quest-/Event-Kandidaten im UI nur via explizitem Opt-in
- leveled Exchange-Evidence
- CI Run #342: 209/209 PASS, 0 FAIL, 0 SKIP, completed/success
- alle bisherigen Review-Threads resolved
- Bundle exakt source-synchron auf `0.16.0-h16`
- nach den finalen Evidence-Dokucommits erneut Exact-Head-CI erforderlich

**🟧 LIVE-TEST NOCH AUSSTEHEND**
- Suite `h16-exchange-craft`
- bevorzugt echte `CRAFT_TO_EXCHANGE_CHAIN`
- sonst sichere `CRAFT_AND_EXCHANGE_COVERAGE`
- v2 zusätzlich `ACQUIRE_CRAFT_AND_EXCHANGE_COVERAGE`
- maximal zwei echte H16-Aktionen (Craft + Exchange)
- bei Bedarf höchstens zwei fehlende Level-0-Leaf-Materialien via H16 → H13
- Materialbeschaffung insgesamt maximal 1.000.000 Gold
- Bank im Live-Test-Fallback explizit deaktiviert (`allowBank:false`)
- temporäre Live-Test-Grenzen: Exchange-Risiko ≤ 2.000.000 Gold, Craft-Input-Risiko ≤ 2.000.000 Gold, Craft-Kosten ≤ 1.000.000 Gold
- keine Quest-/Event-Aktion im automatischen Live-Test
- Craft und Exchange jeweils über Live-Deltas bestätigen
- Exchange-, Craft- und Material-Trade-UNKNOWN-Deltas 0
- 5-Sekunden-Stabilität ohne Retry/Suspension
- Cleanup + Runtime Auto-Restore

Live-Versuch 1:
- sauberer Preflight-Abbruch ohne Mutation;
- 1 sicherer Exchange-Kandidat (`anniversarygift`, Risiko 100 Gold);
- 0 lokal sichere Crafts;
- 106 Craft-Rezepte mit fehlenden Materialien;
- 28 Quest/Event-Rezepte;
- 0 Dispatches, 0 UNKNOWN, 0 Movement;
- Runtime/Scheduler sauber restauriert.

v2 behebt genau diese Testlücke durch begrenzte Materialbeschaffung. Fehlt weiterhin ein sicherer Pfad, wird erneut fail-closed ohne weitere Mutation beendet.

v2 finaler technischer Pre-Live-Stand:
- technischer Head `9e007bc6bfdf872ebf91ecd9f8dbf7f7c2140428`;
- CI Run #362: **213/213 PASS, 0 FAIL, 0 SKIP, completed/success**;
- Bundle exakt source-synchron auf `0.16.0-h16`;
- Craft→Exchange prüft Output-Risiko bereits im Preflight;
- H16-UNKNOWN-Suspension wird durch Test-Cleanup nicht automatisch aufgehoben;
- v2 Material-Fallback ist regressionsseitig abgedeckt;
- frischer Codex-v2-Review ausgewertet;
- P1 Gesamt-Goldbudget vor Materialmutation behoben;
- P2 recoverable Bank-Stacks werden weitergesucht, non-recoverable Rejects bleiben fail-closed;
- alle Review-Threads resolved, kein `CHANGES_REQUESTED`;
- finaler Doku-Exact-Head-CI noch erforderlich.
- Review Round 2: Gesamt-Golddeckung vor Materialkäufen ergänzt;
- Review Round 2: recoverable Bank-Stacks werden weiter durchsucht, globale Bankfehler blockieren Trade-Fallback;
- neuer technischer Head `9e007bc6bfdf872ebf91ecd9f8dbf7f7c2140428`;
- CI Run #362: **213/213 PASS, 0 FAIL, 0 SKIP, completed/success**;
- beide neuen Review-Threads resolved;
- finaler Codex-Review auf diesem Fix-Head angefordert.

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

### H16 Suite v6 – Bank-Material-Discovery (PR #20)

Stand 2026-09-27:

- v5-Live-Diagnostik isolierte den Hauptblocker auf fehlende live nutzbare Materialquellen statt auf zu niedrige Gold-/Risk-Caps;
- Suite v6 ergänzt read-only Bank-Discovery vor dem Material-Fallback;
- Bankmaterial wird nur verwendet, wenn Map, Item-Safety, H12-Reservierungen, craftbare Einzelstack-Größe und Inventar-Slot-Kapazität passen;
- Nicht-Merchants behalten lokale H16-Craft-/Exchange-Pfade ohne Bankpflicht;
- BANK delegiert über H12, NPC/MARKET über H13;
- keine Safety-Limits wurden erhöht;
- technischer Head `c96b01d50dcd91f93ad76f3b56c145e0c336b077`;
- Exact-Head-CI #417: **222/222 PASS, 0 FAIL, 0 SKIP**;
- Bundle source-synchron;
- PR #20 beim technischen Check `behind_by=0`, `mergeable=true`;
- alle bekannten Review-Funde behoben und Threads resolved;
- frischer Codex-Review auf dem aktuellen technischen Head derzeit durch ausgeschöpftes Codex-Code-Review-Kontingent blockiert.

**Gate bleibt geschlossen:** kein Merge, bevor ein frischer Codex-Review auf dem dann aktuellen finalen Head clean ist und danach der vollständige Merge-Gate erneut frisch geprüft wurde.

### PR #20 Gate-Policy-Update

Ab 2026-09-27 ist ein frischer Codex-Code-Review für PR #20 keine verpflichtende Merge-Voraussetzung mehr. Der zuvor dokumentierte Codex-Quota-Blocker ist damit aufgehoben.

Weiterhin zwingend: aktueller Head, `behind_by=0`, vollständig grüne relevante CI, keine pending/failing Checks, keine offenen Review-Threads, kein `CHANGES_REQUESTED`, `mergeable=true`, Merge ausschließlich per `merge` mit exaktem `expected_head_sha`, danach `main` verifizieren.

### H16 abgeschlossen – echter v6-Live-PASS

Stand 2026-09-27:

- PR #20 ist auf `main` gemergt;
- echter `h16-exchange-craft`-Live-Test Suite v6: **PASSED / ALL_STEPS_PASSED**;
- read-only Bank-Discovery erfolgreich;
- Materialquelle BANK real genutzt: 10× `whiteegg` via H12-Withdraw;
- Produktionsgraph danach `READY`;
- echter Craft `cake`: 1 dispatched / 1 confirmed;
- echter Exchange `anniversarygift`: 1 dispatched / 1 confirmed;
- Exchange/Craft/Trade UNKNOWN jeweils 0;
- keine H16/H13-Suspension;
- Cleanup erfolgreich;
- keine Safety-Caps angehoben.

**H16 – Exchange & Craft: abgeschlossen.**

Nächster Entwicklungsblock: **H17 – Economy Autonomy**.

### H17 – Economy Autonomy technischer Pre-Live-Gate

Stand 2026-09-27, PR #22 `H17: Add bounded economy autonomy planner`.

Implementiert:

- gemeinsamer read-only Planner für Bank, Trade/Market, Gear, Upgrade, Compound, Exchange und Craft;
- deterministische Prioritäts-/Konfliktauflösung;
- Autonomie standardmäßig AUS und nur explizit startbar;
- genau eine delegierte Child-Aktion gleichzeitig;
- keine direkten Adventure-Land-Writes aus H17;
- Delegation ausschließlich an bestehende sichere H12–H16-Pfade;
- STOP/Runtime, Combat, Movement-Ownership, Inventory-`pendingLoot`, Child-Busy/Suspension und Session-Budget als harte Gates;
- Child UNKNOWN suspendiert H17 ohne Blind-Retry;
- BLOCKED/REJECTED/FAILED/CANCELLED als terminale Rejects;
- nach CONFIRMED/REJECTED keine zweite Aktion im selben Tick;
- proposal-spezifischer Reject-Backoff;
- H17 Headless-API und Control-Center-Tab;
- bounded Live-Suite `h17-economy-autonomy` v1 mit maximal drei Aktionen und deaktivierten Gear-/Upgrade-/Compound-Mutationen.

Technischer Head vor finaler Doku:

- `4f8c6fb3733dcf83006611242c74a4ebbc813a99`
- CI #465: **237/237 PASS, 0 FAIL, 0 CANCELLED, 0 SKIP**
- beim technischen Check `behind_by=0`, `mergeable=true`
- vier konkrete Review-Funde behoben und Threads resolved
- kein `CHANGES_REQUESTED`
- Bundle source-synchron
- Runtime/Bundle `0.17.0-h17`, Package `0.17.0`
- historische globale Versions-/Recommended-/Scheduler-Assertions auf H17 fortgeschrieben.

Nächster Gate-Schritt: finaler Doku-Head durch Exact-Head-CI und vollständigen Merge-Gate. Danach genau **einen** echten `h17-economy-autonomy`-Live-Test auf dem Merchant.


### H17 abgeschlossen – echter Live-PASS nach Settlement-Race-Fix

Stand 2026-09-27:

- PR #22 `H17: Add bounded economy autonomy planner` ist auf `main` gemergt;
- erster echter H17-Live-Lauf hat fail-safe einen Exchange-`in_progress`-Race aufgedeckt;
- gezielter Fix über PR #23 `H17: Hold exchange ownership until dispatch settles`;
- PR #23 Exact-Head-CI #470: **PASS**;
- PR #23 per `merge` gemergt, Merge-Commit `e8baa9f0719c752625333deb53efc6bf9431e8a1`;
- H16 hält Exchange-/Craft-Ownership nun bis Live-Evidence **und** abgeschlossener Dispatch-Settlement;
- zweiter echter `h17-economy-autonomy`-Live-Test: **PASSED / ALL_STEPS_PASSED**;
- Preflight `READY / H17_PLAN_READY`;
- 3 Economy-Aktionen queued / 3 confirmed / 0 rejected / 0 UNKNOWN;
- alle drei bestätigten Aktionen waren `EXCHANGE`;
- H16 Exchange: 3 dispatched / 3 confirmed / 0 rejected / 0 UNKNOWN;
- Stability: PASS, Child-UNKNOWN-Delta 0;
- Cleanup: PASS, Autonomie AUS, `currentAction=null`, keine Suspension;
- Runtime Auto-Restore erfolgreich;
- keine Safety-Limits gelockert.

**H17 – Economy Autonomy: abgeschlossen.**

Damit ist **Meilenstein 2 – Farming plus vollständige Merchant-/Economy-Basis** erreicht.

Nächster Entwicklungsblock: **H18 – Party-Logistik**.


### H18 – Party-Logistik technischer Pre-Live-Gate

Stand 2026-09-27, PR #25 `H18: Add bounded party logistics`.

Implementiert:

- eigener `PartyLogisticsController`;
- Supply-Verteilung nur an eigene Party-Mitglieder;
- Potions/Scrolls/Elixiere sowie konservativ sichere Level-0-Supplies;
- unbekannte Item-Definitionen fail-closed;
- Gold-Verteilung mit konfigurierbarer Sender-Goldreserve;
- exakte Sender-Slot-/Gold-Deltas plus abgeschlossene Dispatch-Settlement als Outcome-Evidence;
- mehrere gleichnamige Item-Stacks sicher behandelt;
- irreversible Supply-/Gold-Aktionen bleiben über Modulstop erhalten und werden nach Restart reconciled;
- Regroup/Approach ausschließlich über H4 Movement Owner `party-logistics-h18`;
- fremde Party und Combat blockieren H18;
- H10 Loot, H11 Merchant und H17 Economy respektieren H18-Ownership;
- H18 wartet auf laufende H10–H17-Mutationspfade;
- bounded Session-Budget;
- UNKNOWN suspendiert ohne Blind-Retry;
- Headless API `ALBot.partyLogistics`;
- H18-Steuerung im bestehenden Party-Tab;
- Live-Suite `h18-party-logistics` v1 mit Preflight, optionalem Regroup, exakt einem echten Supply-Transfer, Stability und Cleanup;
- Runtime/Bundle `0.18.0-h18`, Package `0.18.0`.

Technische Evidence vor finalen Dokucommits:

- Safety-Head `10ba7540545d49ff7d5100c469533092fdc65bf1`;
- CI #490: **256/256 PASS, 0 FAIL, 0 CANCELLED, 0 SKIP**;
- fünf konkrete Review-Funde behoben;
- alle fünf Review-Threads resolved;
- zusätzlicher Cross-Module-Ownership-Hardening;
- `dist/al-bot.js` anschließend source-synchron aktualisiert;
- beim letzten Write `behind_by=0`.

Nächster Schritt:

- finalen Doku-Head durch Exact-Head-CI laufen lassen;
- vollständiges Merge-Gate frisch prüfen;
- PR #25 ausschließlich per `merge` mit exaktem aktuellem `expected_head_sha` mergen;
- `main` verifizieren;
- danach genau einen echten `h18-party-logistics`-Live-Test durchführen.

**H18 bleibt bis zum echten Adventure-Land-Live-PASS offen.**


### H18 Post-Merge-Korrektur – Bundle-Finalisierung über PR #26

Stand 2026-09-27:

- PR #25 `H18: Add bounded party logistics` wurde bereits nach `main` gemergt;
- Merge-Commit: `c6bfb7b0248d3c005a4dbceac643d90db6d2924a`;
- gemergter Head: `8ecf822bfa476485c9e29c49bc27cccfc3219a26`;
- Exact-Head-CI #496: **256/256 PASS, 0 FAIL, 0 CANCELLED, 0 SKIP**;
- fünf konkrete Review-Funde behoben und Threads resolved;
- der Merge erfolgte durch parallele Repo-Arbeit noch vor dem finalen tracked-`dist`-Sync und vor dem Entfernen der temporären CI-Bundle-Export-Schritte.

Post-Merge-PR #26 `H18: Finalize bundle and pre-live evidence`:

- synchronisiert `dist/al-bot.js` exakt aus dem erfolgreichen #496-Build;
- stellt den normalen Test-Workflow ohne temporären Artifact-/Base64-Export wieder her;
- korrigiert die Evidence append-only;
- verändert keine Gameplay- oder Safety-Grenzen.

**H18 ist technisch implementiert, aber bis PR #26 gemergt und `h18-party-logistics` live bestanden ist weiterhin offen.**


### H18 abgeschlossen – echter Party-Logistics-Live-PASS

Stand 2026-09-27:

- PR #25 und Post-Merge-Finalisierung PR #26 sind auf `main`;
- Runtime/Bundle `0.18.0-h18`, Package `0.18.0`;
- drei unabhängige echte `h18-party-logistics`-Läufe auf eigenen Combat-Charakteren: **PASSED / ALL_STEPS_PASSED**;
- Ranger-Lauf hat den echten Regroup-Pfad ausgeführt: 1 Regroup bestätigt / 0 UNKNOWN;
- Ranger-Supply: `mpot0`, 1 dispatched / 1 confirmed / 0 rejected / 0 UNKNOWN;
- Priest-Supply: `hpot0`, 1 dispatched / 1 confirmed / 0 rejected / 0 UNKNOWN;
- Warrior: zusätzlicher unabhängiger Supply-PASS;
- Stability und Cleanup in allen drei H18-Läufen erfolgreich;
- Autonomie danach AUS, keine aktive Aktion, Queue leer, keine Suspension;
- kein Blind-Retry, keine H18-UNKNOWN-Evidence;
- ein separater Merchant-Runner lief noch auf H17 und wurde per GUI STOP abgebrochen; dieser Lauf ist keine H18-Fehlevidence.

**H18 – Party-Logistik: abgeschlossen.**

Nächster Entwicklungsblock: **H19 – Character Lifecycle & Recovery**.


### H19 – Character Lifecycle & Recovery technischer Pre-Live-Gate

Stand 2026-09-27, PR #28 `H19: Add bounded character lifecycle recovery`.

Implementiert:

- eigener `CharacterLifecycleController`;
- Account-Ownership über live `get_characters`;
- aktiver Character-Status über live `get_active_characters` + Local Character;
- Start/Stop/Respawn ausschließlich über ActionBoundary;
- persistente Pending-Ownership vor irreversiblem Dispatch;
- Reload-/Restart-Reconciliation ohne Blind-Redispatch;
- Desired-Active-Set für Disconnect-/Restart-Recovery;
- bounded Start fehlender eigener Desired-Characters;
- eigener gespeicherter Desired-Party-Leader;
- Leader-Invite / Non-Leader-Request / Accept nur über eindeutige eigene Desired-Topologie;
- `on_party_invite` / `on_party_request` sind reine Beobachtungshooks; Dispatch erfolgt erst im H19-Tick;
- Foreign-Party- und abweichender-Leader-Block fail-closed;
- kein automatisches `leave_party`;
- Death-Recovery über genau einen lokalen Respawn;
- Sync-UNKNOWN und unbestätigte Promise-/Timeout-Zustände suspendieren ohne Blind-Retry;
- bekannte automatische Rejects stoppen die Recovery-Session;
- Session-Budget;
- H19 Headless-API und eigener Lifecycle-Tab;
- Runtime/Bundle `0.19.0-h19`, Package `0.19.0`;
- Live-Suite `h19-character-lifecycle` v1 für echten Death→Respawn-Pfad.

Technischer Code-Head vor finaler Doku-/Bundle-Finalisierung:

- `9d35c98966a627595ab872e1322b5b8f1e8bdd54`;
- Exact-Head-CI #522: **272/272 PASS, 0 FAIL, 0 CANCELLED, 0 SKIP**;
- erster H19-CI #505 hatte ausschließlich stale H8–H17-Wiring-Erwartungen auf H18; keine H19-Funktionsregression;
- Party-Recovery-Safety danach zusätzlich auf eindeutigen gespeicherten Leader gehärtet;
- `docs/H19-LIVE-TEST.md` beschreibt Safety und den ersten bounded Live-Gate.

Nächster Gate-Schritt:

- finalen source-synchronen `dist/al-bot.js` erzeugen;
- normalen read-only Workflow wiederherstellen;
- finalen Doku-/Bundle-Head durch Exact-Head-CI laufen lassen;
- `behind_by=0`, keine pending/failing Checks, keine offenen Review-Threads, kein `CHANGES_REQUESTED`, `mergeable=true` frisch prüfen;
- PR #28 ausschließlich per `merge` mit exaktem aktuellem `expected_head_sha` mergen;
- `main` danach verifizieren;
- erst dann den echten H19-Live-Test durchführen.

**H19 bleibt bis zur erforderlichen echten Adventure-Land-Live-Evidence offen.**


### H19 Safety-Hardening vor finalem Merge-Gate

Stand 2026-09-27:

Nach dem ersten technischen H19-Pre-Live-Gate wurden zwei zusätzliche Safety-Grenzen ergänzt:

- Desired Active und Desired Party Membership sind getrennte Zustände;
- `desiredPartyMemberNames` enthält nur eigene Characters, die beim Capture tatsächlich in der beobachteten Party waren;
- aktive eigene Characters außerhalb dieser Party werden nicht automatisch eingeladen;
- `desiredPartyLeader` muss Teil des erfassten Desired-Party-Sets sein;
- Party-Recovery rekonstruiert ausschließlich diese gespeicherte eigene Party-Topologie;
- synchrones `UNKNOWN` entfernt den bereits dispatch-gefährdeten Queue-Eintrag, behält aber die persistierte in-flight Ownership;
- derselbe unklare Auftrag erhöht `actionsUnknown` nur einmal und kann nach Reload weiterhin über Live-Evidence reconciled werden;
- Control Center zeigt Desired Active, Desired Party Members und Desired Party Leader separat.

Grüner technischer Zwischenstand vor der letzten UI-/Doku-/Workflow-Bereinigung:

- Head `de1d3bdecbd7de1013c1dda2546d81e3c794edf0`;
- CI #527: **273/273 PASS, 0 FAIL, 0 CANCELLED, 0 SKIP**;
- `dist/al-bot.js` auf diesem Stand bereits source-synchron.

Der verbindliche Merge-Gate bleibt der danach aktuelle Head mit read-only Testworkflow, `behind_by=0`, vollständig grüner Exact-Head-CI, keinen offenen Review-Threads, keinem `CHANGES_REQUESTED` und `mergeable=true`.


### H19 Death-Recovery Live-Gate bestanden

Stand 2026-09-27, Runtime `0.19.0-h19`.

Der dritte echte Lauf der Suite `h19-character-lifecycle` v1 ist mit **PASSED / ALL_STEPS_PASSED** abgeschlossen.

Live-Evidence:

- Preflight auf totem lokalen Warrior: PASS;
- Respawn-Grace korrekt abgewartet;
- exakt 1 Respawn dispatcht;
- exakt 1 Respawn bestätigt;
- 0 Rejects;
- 0 UNKNOWN;
- 15 bounded Cooldown-Blocks vor Readiness;
- 0 `cant_respawn`-Rejects;
- Stability fünf Sekunden ohne Retry/UNKNOWN: PASS;
- Cleanup: Autonomie AUS, `currentAction=null`, Queue leer, keine Suspension;
- lokaler Character danach wieder `rip=false`.

Damit ist **Death Recovery live bestätigt**.

H19 bleibt offen für die noch erforderlichen gezielten bounded Live-Gates:

- Remote Character Start/Stop;
- Disconnect-/Restart-Recovery über Desired Active;
- Party-Recovery über die gespeicherte eigene Desired-Party-Topologie.

Der nächste H19-Live-Gate soll diese Pfade kontrolliert prüfen, ohne unbeabsichtigte Runner-/Party-Nebenwirkungen.


### H19 v2 – Remote Start/Stop & Restart-Recovery Pre-Live-Gate

Stand 2026-09-27.

Nach dem erfolgreichen Death→Respawn-Live-Gate ist als nächster H19-Live-Pfad `h19-remote-recovery` vorbereitet.

Der Gate prüft bounded:

- dynamische Auswahl eines account-eigenen, nichtlokalen, aktuell aktiven Remote-Characters;
- aktuellen Party-Leader ausdrücklich nicht als Stop-Ziel verwenden;
- Characters außerhalb der aktuellen Party bevorzugen;
- Desired Active **vor** der Mutation erfassen;
- genau einen bestätigten Remote-Stop;
- danach genau einen automatischen Desired-Active-Start;
- Stop und Start jeweils nur durch Settlement + Live-Roster-Delta bestätigen;
- kumuliert 2 Dispatches / 2 Confirms / 0 Rejects / 0 UNKNOWNs;
- fünf Sekunden Stabilität ohne Retry;
- ursprüngliche H19-Policy im Cleanup wiederherstellen.

Cleanup darf nur dann einen einmaligen ersten Restore-Start auslösen, wenn der Stop bestätigt wurde und **noch kein Start dispatcht wurde**. Nach Reject, UNKNOWN, Suspension oder bereits dispatchtem Start gibt es keinen Cleanup-Retry.

Nach erfolgreicher v2-Evidence sind Remote Character Start/Stop sowie Disconnect-/Restart-Recovery live bestätigt. Party-Recovery bleibt anschließend als letzter gezielter H19-Live-Gate offen.


### H19 v2 Live-Truth-Korrektur – accountweiter Online-Status

Stand 2026-09-27.

Der erste echte `h19-remote-recovery`-Preflight hat eine falsche Roster-Annahme sichtbar gemacht, bevor irgendeine Game-Mutation ausgeführt wurde:

- `get_characters().online` meldete auf zwei unabhängigen laufenden Clients vier eigene Characters online;
- `get_active_characters()` / `activeCharacterNames` enthielt jeweils nur den lokalen Character;
- beide Läufe stoppten fail-closed mit `H19_REMOTE_SAFE_ACTIVE_TARGET_UNAVAILABLE`;
- 0 Lifecycle-Dispatches, 0 Rejects, 0 UNKNOWNs.

Korrektur:

- Roster trennt nun accountweite `onlineCharacterNames` von lokaler `activeCharacterNames` / `runnerActiveCharacterNames`;
- H19 Remote Start/Stop, Desired Active, Recovery-Reconciliation und v2-Live-Gate verwenden accountweite Online-Evidence;
- die lokale Runner-Active-Sicht bleibt für andere Semantiken unverändert erhalten;
- Regression deckt explizit den Live-Fall „Remote accountweit online, aber nicht in der lokalen Runner-Active-Sicht“ ab.

Die bisherigen FAIL-Evidence bleibt append-only dokumentiert. H19 Remote Start/Stop + Restart-Recovery ist weiterhin **nicht live bestätigt**, bis der korrigierte Gate nach finalem Merge einmal vollständig PASSED ist.
