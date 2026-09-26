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

## H4 – abgeschlossen und gemerged

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

PR #4 wurde am 2026-09-26 nach bestandenem Live-Test automatisch gemerged.

Merge-Commit:
`fcf5ac31b3d8526ffe2068ba33f6eed33f661b36`

User hat ab H4 eine dauerhafte Auto-Merge-Regel festgelegt: Nach vollständig bestandenem Schritt und allen Sicherheitschecks automatisch mergen.

## H5 – abgeschlossen und gemerged

Aktiver Entwicklungsbranch:
`chatgpt/h5-combat`

Ziel: **einfacher, bounded Combat-Core** auf Basis der H3-Live-Wahrheit und H4-Movement-Schicht.

Bereits umgesetzt:
- `attack` und `change_target` über die zentrale `GameActionBoundary`;
- frische sichtbare Monster-Sicht aus dem Game Adapter;
- Adventure-Land-`can_attack` / `is_in_range` / `is_on_cooldown` als bevorzugte Readiness-Wahrheit;
- eigener Combat-Owner und Combat-Modul;
- konservative automatische Targetwahl;
- unbekannter Monster-Attack-Wert wird fail-closed nicht automatisch gewählt;
- Range-Annäherung über H4 Movement;
- Attack-Outcome muss durch frische Gameplay-Evidence bestätigt werden;
- Promise-/Command-Erfolg allein ist kein Trefferbeweis;
- `UNKNOWN` führt nicht zu Blind-Retry;
- Low-HP Safe Retreat;
- MP-Mindestregel;
- Kiting-Grundlage;
- globaler STOP räumt Combat + Movement auf;
- Combat-Tab im Control Center;
- wiederverwendbarer `LiveTestRunner`;
- neuer **Live-Test**-Tab mit genau einem primären Button **„Test starten“**;
- H5-Live-Suite führt Preflight, Targeting, Combat, Evidence, Stabilitätsfenster und Cleanup automatisch aus;
- nach Testende wird der Diagnosebericht automatisch in die Zwischenablage kopiert; sichtbarer Fallback bei Browser-Blockade;
- `docs/H5-LIVE-TEST.md`.

Neue verbindliche Live-Test-Regel ab H5:
- der User soll keine Testschritt-Kette mehr manuell abarbeiten;
- pro Entwicklungsblock wird eine Ein-Klick-Live-Suite gebaut;
- sichtbarer Endstatus `TEST BEENDET – BESTANDEN/FAILED/CANCELLED`;
- Diagnose automatisch kopieren;
- roter STOP bleibt immer vorrangig und wird nie automatisch zurückgesetzt.

Live-Test im echten Adventure-Land-Client: **BESTANDEN**.

Bestätigt:
- Ein-Klick-Runner startet Runtime automatisch und stellt den vorherigen STOPPED-Zustand danach wieder her;
- Preflight, Targeting, bestätigter Angriff, 5-Sekunden-Stabilitätsfenster und Cleanup jeweils PASSED;
- health-aware Sicherheitsplanung mit aktuellem HP und realer Monster-Attacke;
- 3 Targets automatisch übernommen;
- 3 Angriffe bestätigt;
- 3 Kills bestätigt;
- `attackUnknown = 0`;
- 3 Range-Annäherungen über H4 Movement;
- Combat und Movement nach Cleanup inaktiv;
- Scheduler nach Abschluss 0 Ressourcen;
- autoritative Adventure-Land-`game_response`-Attack-Evidence korrekt verarbeitet;
- kein Blind-Retry nach UNKNOWN bleibt erhalten.

H5 ist damit vollständig live bestanden.

PR #5 wurde am 2026-09-26 automatisch gemerged.

Merge-Commit:
`9e35ef678eefe8c476e7d6ac1fd7d90213d33195`

## H6 – abgeschlossen und gemerged

Aktiver Entwicklungsbranch:
`chatgpt/h6-class-logic`

Ziel: **klassenspezifische Single-Character-Logik** auf dem live bestätigten H5-Combat-Core.

Bereits umgesetzt:
- Live-`G.skills` als Skilldefinitions-Wahrheit;
- Skill-Readiness über Klasse, Level, MP, Cooldown, `can_use`, Skill-Range und aktive Conditions;
- eigener `ClassSkillController`;
- unterstützte Klassen: Warrior, Ranger, Mage, Priest, Rogue, Paladin;
- Warrior: Hardshell, Charge, Taunt, Warcry;
- Ranger: Hunters Mark, Supershot;
- Mage: Burst;
- Priest: Curse, Dark Blessing;
- Rogue: Invis, Mental Burst, Quick Punch;
- Paladin: Self Heal, Smash;
- MP-Reserve und Overkill-Vermeidung;
- ein offener Skill-Command zur Zeit;
- globaler Skill-Mindestabstand plus Skill/Target-Recast-Sperren;
- bekannte Ablehnung -> Backoff;
- unklarer Skill-Ausgang -> `UNKNOWN` und Class-Skill-Suspension für die aktuelle Combat-Session, ohne Blind-Retry;
- H5-Basiscombat bleibt bei suspendierter H6-Skilllogik funktionsfähig;
- Class-Skill-Status/Diagnostics im Combat-Tab;
- Headless API `ALBot.classSkills.*`;
- H6-Ein-Klick-Live-Suite;
- `docs/H6-LIVE-TEST.md`.

Bewusste Abgrenzung:
- Party Heal/Assist/Focus Fire bleibt H7;
- AoE/3shot/5shot/Cleave/Stomp/CBurst/Fan of Knives bleibt H8;
- keine komplexe Paladin-Aura-/Ally-Link-Semantik ohne separate Live-Validierung.

H6 Live-Test:
- ein Klick auf **Test starten**;
- Preflight;
- sichere Targetwahl;
- Combat-Start;
- mindestens ein serverbestätigter Klassen-Skill;
- 5-Sekunden-Anti-Spam-/UNKNOWN-Fenster;
- Cleanup;
- Diagnose automatisch in die Zwischenablage.

Aktueller technischer Stand:
- vollständige H1–H6-CI: **GRÜN**;
- H6-Regressionen für explizite H5-Suite und Warrior `charge → taunt` bereinigt;
- echter H6-Ein-Klick-Live-Test: **BESTANDEN**.

Live bestätigt:
- Ranger mit Live-Skills `huntersmark` und `supershot`;
- Preflight, Combat-Start, Class-Skill, 5-Sekunden-Anti-Spam-Fenster und Cleanup jeweils PASSED;
- Hunter's Mark serverbestätigt als Support-Skill;
- Supershot serverbestätigt als Damage-Skill;
- Class-Skills dispatched=2, confirmed=2, rejected=0, unknown=0;
- H5 attackUnknown=0;
- Range-Annäherung über H4 Movement;
- Combat/Movement/Class-Skill-Ownership nach Cleanup vollständig freigegeben;
- Runtime nach automatisch gestartetem Test wieder STOPPED;
- Scheduler nach Abschluss 0 Ressourcen.

H6 ist damit vollständig live bestanden.

PR #6 wurde am 2026-09-26 automatisch gemerged.

Merge-Commit:
`69d620c502c4f45a03d998c44491aaf8166f4d52`

## H7 – vollständig live bestanden

Aktiver Entwicklungsbranch:
`chatgpt/h7-party`

Ziel: **Party-Koordination** über dem live bestätigten H4–H6-Core.

Bereits umgesetzt:
- normalisierter Live-Party-Snapshot aus `get_party()`, `party_list` und sichtbaren Player-Entities;
- dynamische Owned-/Foreign-Erkennung gegen die zentrale Roster-Schicht;
- fail-closed Koordination bei fremden Party-Mitgliedern;
- Rollen ohne hartcodierte Namen:
  - Warrior TANK
  - Priest HEALER
  - Paladin TANK/SUPPORT
  - Ranger/Mage/Rogue DPS
  - Merchant LOGISTICS;
- stabiler Party-Focus mit Tank → Leader → Mehrheits-Target;
- Focus-Hold gegen Target-Pingpong;
- H5 Combat bevorzugt einen weiterhin sicheren H7-Party-Focus;
- direkter Priest-Heal über zentrale ActionBoundary;
- Party Heal und Revive über `use_skill`;
- Healing-/Revive-Live-Readiness;
- höchstens ein Party-Support-Command gleichzeitig;
- bekannte Support-Ablehnung → Backoff;
- unklarer Support-Ausgang → UNKNOWN + Support-Suspension ohne Blind-Retry;
- Party-Buff-/Aura-Sicht auf Basis live vorhandener Skilldefinitionen;
- Party-Status im Control Center;
- Headless API `ALBot.party.*`;
- H7-Ein-Klick-Live-Suite;
- `docs/H7-LIVE-TEST.md`.

Bewusste Abgrenzung:
- H7 verändert Party-Mitgliedschaft noch nicht automatisch;
- H7 startet/stoppt keine anderen Charaktere; Character Lifecycle bleibt H19;
- AoE-/Pull-Logik bleibt H8;
- Party-Logistik/Supplies bleibt H18.

H7 Live-Test:
- Voraussetzung: mindestens zwei eigene lebende Charaktere befinden sich bereits in derselben Adventure-Land-Party;
- danach nur **Test starten**;
- Preflight;
- Rollen;
- Focus-Fire-Konvergenz;
- Party-Health-/Recovery-Sicht;
- 5-Sekunden-Stabilitätsfenster;
- Cleanup;
- Diagnose automatisch in Zwischenablage.

Aktueller technischer Stand:
- vollständige H1–H7-Suite: **71/71 Tests GRÜN**;
- H5/H6-Regressionen laufen explizit gegen ihre jeweilige Suite;
- Monster, die ein eigenes Party-Mitglied angreifen, gelten bei aktivem Party-Assist als legitime koordinierte Kandidaten, bleiben aber unter allen übrigen H5-Safety-Regeln;
- H7-Ein-Klick-Suite im automatischen Test grün.

Live-Evidence vom 2026-09-26:
- Priest-Lauf: **vollständig PASSED / ALL_STEPS_PASSED**;
- Warrior-Lauf: Preflight, Focus-Fire und Party-Health PASSED; Stability schlug nur wegen der alten `focusChanges <= 6`-Heuristik fehl;
- Live-Logs zeigten dabei vier unterschiedliche aufeinanderfolgende Goo-Targets bei drei bestätigten Kills, also legitime Fortschritte statt A→B→A-Pingpong;
- Merchant und Rogue waren nicht in der aktiven Zweier-Party und wurden erwartungsgemäß fail-closed mit `H7_NEEDS_ACTIVE_PARTY_OF_AT_LEAST_2` abgewiesen.

Korrektur nach Live-Evidence:
- H7 misst jetzt explizit echte A→B→A-Focus-Rückkehr innerhalb eines 6-Sekunden-Fensters;
- eindeutige Sequenzen A→B→C→D werden nicht mehr als Pingpong gewertet;
- neue Unit-Coverage prüft beides;
- erneuter Live-Test: Warrior, Priest und Rogue vollständig PASSED mit `focusPingPongs=0`;
- Merchant wurde live korrekt als `LOGISTICS` erkannt, aber der bisherige H7-Test startete fälschlich H5 Combat und Adventure Land lehnte den Attack mit `merchant` ab;
- H7 hat deshalb nun einen Observer-only-Pfad für LOGISTICS/Merchant ohne Combat-Dispatch;
- H5 Combat blockiert Merchant jetzt bereits vor dem ersten Attack mit `COMBAT_UNSUPPORTED_CLASS:merchant`;
- Regressionstest stellt sicher: Merchant-H7-Ein-Klick-Test PASSED und `attacks=0`.

Finaler Live-Stand:
- Rogue/DPS: vollständig PASSED, Focus Fire/Stability/Cleanup bestanden, `focusPingPongs=0`;
- Warrior/TANK: vollständig PASSED; mehrere legitime Target-Fortschritte ohne falsche Pingpong-Erkennung;
- Priest/HEALER: vollständig PASSED; Party-Support-/Buff-Sicht live bestätigt;
- Merchant/LOGISTICS: finaler Observer-only-Retest **PASSED / ALL_STEPS_PASSED**;
- Merchant: `observerOnly=true`, `combatState=NOT_STARTED`, keine Attack-Dispatches, `attackUnknown=0`;
- Merchant Stability PASSED, `focusPingPongs=0`, Cleanup PASSED;
- Runtime nach Test wieder STOPPED;
- Scheduler danach 0 Ressourcen.

Review-Safety-Nachbesserung:
- synchrones Support-`UNKNOWN` aus der ActionBoundary suspendiert Party-Support jetzt sofort;
- Regressionstest verhindert Blind-Retry dieses UNKNOWN-Pfads.

H7 ist vollständig live bestanden und wurde am 2026-09-26 automatisch gemerged.

Merge-Commit:
`7d8fc403238fc827812b70a4cd0707db1139eae0`

## H8 – vollständig live bestanden

Aktiver Entwicklungsbranch:
`chatgpt/h8-aoe-adaptive-farming`

PR:
`#8 – H8: AoE and adaptive farming`

Ziel: **sicheres AoE-/Multi-Target-Farming und adaptive Gegnerzahl** über dem live bestätigten H4–H7-Core.

Technisch umgesetzt:
- eigener `AdaptiveFarmingController` als separates Modul;
- H8 besitzt bei aktiver Farming-Session die darunterliegende H5-Combat-Session mit Owner `farming-h8`;
- Pack-Kandidaten stammen ausschließlich aus H5-`safeCandidates`;
- H5 Individual-Safety bleibt vollständig erhalten;
- zusätzliche H8-Pack-Safety:
  - Klassenkapazität;
  - HP-Reserve;
  - aggregiertes Monster-Angriffsbudget;
  - gleiche Monsterart;
  - konservative Distanz;
- H8-AoE-Skills:
  - Warrior `cleave` / `stomp`;
  - Ranger `3shot` / `5shot`;
  - Mage `cburst`;
  - Rogue `fanofknives`;
- Skills nur bei live vorhandener Definition + live Readiness;
- Adventure-Land-Multi-Target-Argumentformen für `3shot`, `5shot`, `fanofknives` und `cburst`;
- untargeted Warrior-AoE nur, wenn die komplette sichtbare Wirkzone H5-sicher ist;
- H6 bleibt vor H8 priorisiert;
- maximal ein Pending-H8-AoE;
- bekannte Ablehnung -> Backoff;
- UNKNOWN -> H8-Suspension ohne Blind-Retry;
- Single-Target-Fallback bei reduzierter HP-Reserve;
- Retreat-Plan bei niedrigen HP;
- Foreign-Party fail-closed;
- H8-Status in Runtime-Diagnostics;
- Farming-Tab im Control Center;
- Headless API `ALBot.farming.*`;
- H8-Ein-Klick-Live-Suite;
- `docs/H8-LIVE-TEST.md`.

Regressionen decken u.a. ab:
- Ranger 5shot-Pack;
- Health-basierten Single-Target-Fallback/Retreat;
- aggregiertes Overpull-Budget;
- Foreign-Party-Block;
- Warrior untargeted AoE gegen unsichere Nachbar-Mobs;
- synchrones UNKNOWN ohne Blind-Retry;
- bekannte Ablehnung mit Backoff;
- Combat-Ownership/Cleanup.

Finaler technischer Stand:
- vollständige H1–H8-Suite vor dem Live-Test: **87/87 Tests GRÜN**;
- PR-Review-Overpull-Fall behoben und regressionsgetestet;
- Bundle-Newline-Review-Fall behoben;
- keine offenen Review-Threads vor dem Live-Test.

Live-Evidence vom 2026-09-26:
- AL Bot `0.8.0-h8`;
- Suite `h8-adaptive-farming`: **PASSED / ALL_STEPS_PASSED**;
- Ranger Level 60;
- live `3shot` erkannt und serverbestätigt;
- Preflight: 6 sichere sichtbare Goos;
- AoE-Plan: 3 Targets, Kapazität 5, aggregierter Attack-Wert 25;
- `aoeDispatched=1`, `aoeConfirmed=1`, `aoeRejected=0`, `aoeUnknown=0`;
- H5 `attackUnknown=0`;
- H7 `focusPingPongs=0`;
- alle fünf Schritte PASSED;
- Cleanup `ok=true`;
- Farming/Combat/Movement danach inaktiv;
- Runtime danach STOPPED;
- Scheduler danach 0 Ressourcen.

H8 ist vollständig live bestanden und wurde nach grüner finaler CI automatisch gemerged.

Merge-Commit:
`ebfd442bc2f5ffdda24a9745114dbd7b39fb60ad`

## H9 – Farm Intelligence – live bestanden und gemergt

H9 ist vollständig abgeschlossen.

Finaler Branch:
`chatgpt/h9-farm-intelligence`

PR:
`#9 – H9: Farm Intelligence`

Finaler Head vor Merge:
`bc7186b019a5fa671c1fe2158d288708aaa78e9e`

Merge-Commit auf `main`:
`49f5175a7d555415e4a5a1e333d0fbe3c5200f44`

Finale CI:
- Run `#199`
- completed
- success
- 109/109 Tests grün
- `behind_by=0`
- `mergeable=true`
- keine offenen Review-Threads
- kein `CHANGES_REQUESTED`
- Merge ausschließlich mit Methode `merge` und exaktem `expected_head_sha`

Live-Evidence vom 2026-09-26:
- AL Bot `0.9.0-h9`;
- Suite `h9-farm-intelligence`: **PASSED / ALL_STEPS_PASSED**;
- alle sechs Schritte PASSED;
- Preflight initial Goo;
- Autonomous Start später auf Live-Squigtoad;
- mindestens ein bestätigter H5-Basisangriff;
- adaptive Beobachtung: 63 Entscheidungen, 22 Holds, 2 Switches, 3 Travel Orders;
- 6 Anti-Pingpong-Blocks ohne A→B→A-Verstoß;
- `aoeUnknown=0`;
- `attackUnknown=0`;
- `focusPingPongs=0`;
- `ownershipBlocks=0`;
- `movementUnknown=0`;
- Cleanup vollständig: H9/H8/H5/H4 inaktiv;
- Runtime STOPPED;
- Scheduler 0 Ressourcen.

Wichtiger finaler CI-Fix:
- Foreign-Party-Planung liefert im aktiven H9-Lauf bewusst `SUSPENDED`, nicht nur `BLOCKED`;
- Regressionstest wurde an diese Fail-Safe-Semantik angepasst;
- keine Gameplay-Semantik wurde dafür aufgeweicht.

## H10 – Loot & Inventar – live bestanden, finaler Merge-Gate läuft

Offizieller Entwicklungsbranch:
`chatgpt/h10-loot-inventory`

PR:
`#10 – H10: Loot & Inventory`

Basis:
`main` bei H9-Merge-Commit `49f5175a7d555415e4a5a1e333d0fbe3c5200f44`

Implementiert:
- AL Bot Version `0.10.0-h10`;
- eigener `LootInventoryController`;
- Live-Inventar- und Chest-Normalisierung im Game Adapter;
- `loot` als zentrale ActionBoundary-Aktion;
- konservative Dispositionen `PROTECT / RESERVE / KEEP / BANK / EXCHANGE / SELL`;
- unbekannte Items -> `BANK`, nicht `SELL`;
- locked/gelevelt/Quest/Gear/Goal-Items geschützt bzw. reserviert;
- normalisiertes `definition.quest === true` wird als Questschutz berücksichtigt;
- 2 Slots Standardreserve;
- `nothing_to_loot` / `safety` als Known Skip;
- synchrones/asynchrones Loot-UNKNOWN -> Suspension ohne Blind-Retry;
- niemals settlender Loot-Promise besitzt eine bounded Outcome-Deadline und wird danach `H10_LOOT_OUTCOME_TIMEOUT`;
- expliziter Safety-Reset;
- Runtime-Modul `loot-inventory`;
- Headless API `ALBot.inventory.*`;
- Game APIs `inventory()`, `chests()`, `itemDefinition()`;
- eigener GUI-Tab **Loot & Inventar**;
- H10-Ein-Klick-Suite `h10-loot-inventory`;
- `docs/H10-LIVE-TEST.md`;
- Regressionen einschließlich Pending-Loot-Timeout und normalisiertem Quest-Flag.

H10 führt bewusst **keine** echten Sell-/Bank-/Exchange-Aktionen aus. Diese bleiben späteren Economy-Stufen vorbehalten.

Finale Live-Evidence:
- Suite `h10-loot-inventory`: **PASSED / ALL_STEPS_PASSED**;
- Runtime `AL Bot 0.10.0-h10`;
- Preflight: 42 Slots, 4 benutzt, 38 frei, `protectedCount=4`;
- Dispositionen: KEEP=2, BANK=1, EXCHANGE=1;
- sichere H9-Goo-Probe autonom gestartet;
- Confirmed Loot: `lootDispatched=1`, `lootConfirmed=1`, `knownSkips=0`, `attacksConfirmed=1`;
- Protection Delta: **PASSED**, `checkedProtectedItems=4`;
- Stability: `lootConfirmed=2`, `lootUnknown=0`, 38 freie Slots;
- Cleanup: `pendingLoot=false`, H9/H8/H5/H4 inaktiv;
- Cleanup `ok=true`;
- Runtime danach wieder STOPPED;
- Scheduler danach `totalResources=0`.

Post-Live Review-Härtung:
- P2: hängender `loot()`-Promise kann H10 nicht mehr dauerhaft wedgen;
- P2: normalisiertes Quest-Flag wird bei der Schutzklassifizierung berücksichtigt;
- beide Fälle regressionsgetestet;
- CI Run #210 auf Head `a86e83938ca92fa2da0f5b7330433e797510bbbf`: SUCCESS;
- beide P2-Review-Threads resolved.

Die Post-Live-Fixes verändern den live bestätigten normalen Loot-Happy-Path nicht: der Timeout greift nur bei ausbleibendem Outcome, der Quest-Fix erweitert nur die konservative Schutzklassifizierung.

Aktuell:
- Live-Abnahme abgeschlossen;
- H10 in ROADMAP auf BESTANDEN gesetzt;
- Evidence-Dokumentation aktualisiert;
- durch diese Dokumentationscommits ist ein neuer Head entstanden;
- jetzt ausschließlich den **neuen exakten Head** für CI und Merge-Gate verwenden.

Nächste Aktion:
1. aktuellen PR-Head frisch lesen;
2. `main...chatgpt/h10-loot-inventory` prüfen, `behind_by=0`;
3. alle Workflow-Runs des exakten Heads müssen completed und success/skipped/neutral sein;
4. keine offenen Review-Threads;
5. kein `CHANGES_REQUESTED`;
6. Commit-Status ohne echte pending/failure-Kontexte;
7. `mergeable=true`;
8. dann PR #10 ausschließlich mit Methode `merge` und exaktem `expected_head_sha` mergen;
9. Merge auf `main` verifizieren;
10. H11 – Merchant-Grundbetrieb auf frischem Branch vom neuen `main` beginnen.

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

H10 finalen Exact-Head-CI-/Merge-Gate abschließen und PR #10 bei vollständig grünem Gate automatisch mergen. Danach **H11 – Merchant-Grundbetrieb** auf einem frischen Branch vom neuen `main` starten.
