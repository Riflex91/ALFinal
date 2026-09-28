# V6 Full Live – Vier-Character Beobachtung

Stand: 2026-09-27

## Ziel

Dieser Lauf ist kein isolierter H20-Test. Er soll den aktuellen ALFinal/V6-Stand auf vier eigenen Adventure-Land-Characters unter normalem Spielbetrieb beobachten.

Der Runtime-Start aktiviert alle registrierten Module. Der Full-Live-Orchestrator schaltet mutierende Autonomie jedoch rollen- und ownership-gerecht frei, damit nicht mehrere Controller dieselbe Bewegung, Economy-Aktion oder Lifecycle-Recovery gleichzeitig besitzen.

## Rollen

Fuer den aktuellen Vierer-Account werden die Rollen dynamisch aus den Klassen erkannt.

- Warrior: Tank / DPS;
- Priest: Healer / Revive / Support / DPS;
- Ranger: DPS / Ranged;
- Merchant: Economy / Logistics.

Die Namen sind nicht im Optimizer hartcodiert. Die Runtime verwendet den accountweiten Roster und frische Character-Profile.

## Startvoraussetzungen

Vor dem Start:

1. alle vier gewuenschten Characters sind online;
2. jedes Fenster hat exakt denselben aktuellen ALFinal-Build geladen;
3. kein Fenster hat einen gelatchten globalen STOP;
4. bestehende UNKNOWN-/Safety-Suspensions werden nicht automatisch aufgehoben;
5. einige Sekunden fuer gegenseitige H19-CM-Heartbeats abwarten.

Full Live erwartet standardmaessig genau vier online Characters. Bei weniger oder mehr Characters wird der Start fail-closed abgelehnt.

## Start

Im Control Center jedes Fensters den Tab **Full Live** oeffnen, Task `FARM` waehlen und **Full Live starten** druecken.

Alternativ in jedem Fenster:

```js
await ALBot.fullAutonomy.start({ taskType: 'FARM' })
```

Der erste Zustand darf kurz `WARMING` sein. Es wird erst autonom geplant, wenn fuer jeden online gemeldeten Character ein frisches Profil vorliegt.

Erwarteter stabiler Zustand:

```text
RUNNING
FULL_AUTONOMY_ROLE_PLAN_ACTIVE
```

## Was im FARM-Modus passieren soll

- alle normalen Runtime-Module sind aktiv;
- der Account-Optimizer bewertet Level, Gear, Combat-/Survivalwerte und Trainingszeit;
- ein zurueckliegender Combat-Character erhaelt Catch-up-Prioritaet;
- die FARM-Ausfuehrungsgruppe wird pro Planung dynamisch aus 1 bis 3 Combat-Characters gewaehlt;
- die Auswahl bewertet aktuelle Staerke, Progression/Catch-up, benoetigte Faehigkeiten, Rollenvielfalt und den Koordinationsaufwand zusaetzlicher Mitglieder;
- ein weiterer Character wird nur aufgenommen, wenn sein Nutzen fuer die aktuelle Aufgabe den zusaetzlichen Gruppen-Overhead rechtfertigt;
- die Namen und die konkrete Klassenkombination sind nicht fest vorgegeben;
- nur die ausgewaehlte Combat-Gruppe reist und kaempft koordiniert; ihr Leader besitzt Farmrichtung und neue Pulls, Followers spiegeln das Gruppenziel und regroupen bei echter Trennung;
- nicht ausgewaehlte Combat-Characters bleiben als sichere Standby-/Party-Mitglieder verfuegbar und koennen bei einer spaeteren Strategieentscheidung in die Ausfuehrungsgruppe wechseln;
- BOSS/EVENT/SPECIAL koennen strengere Capability-Anforderungen wie Tank, Healer und DPS verlangen;
- Merchant fuehrt Economy-Autonomie aus;
- Party Logistics darf auf dem Merchant Economy bounded abloesen, wenn echte Logistikarbeit vorliegt;
- Lifecycle Recovery haelt das beim Start gepinnte Vierer-Desired-Set;
- nur der dynamisch gewaehlte Leader koordiniert Remote-Recovery;
- Nicht-Leader starten H19 nur bei eigener Party-Abweichung fuer den bounded Rejoin-Pfad.

## Sicherheitsregeln

Full Live darf niemals automatisch:

- einen globalen STOP zuruecksetzen;
- eine UNKNOWN-Ownership bestaetigen oder verwerfen;
- eine Safety-Suspension zuruecksetzen;
- denselben unklaren irreversiblen Auftrag blind erneut senden;
- einen fremden Party-Character als eigenen behandeln;
- den Merchant als normalen Combat-DPS erzwingen.

Bei `UNKNOWN`, `SUSPENDED`, wiederholtem Party-Wechsel, Movement-Pingpong oder unerwarteter Mutation nicht blind neu starten.

## Beobachtung

Waehrend des Laufs im **Full Live**-Tab pruefen:

- Execution Group;
- Support;
- Leader / Lifecycle Coordinator;
- Catch-up Ziel;
- lokale Rolle;
- Character-Level/Gear/Training;
- letzter Full-Live-Status.

Zusaetzlich kann jederzeit gelesen werden:

```js
ALBot.fullAutonomy.status()
ALBot.accountStrategy.profiles()
ALBot.accountStrategy.progression()
ALBot.accountStrategy.optimize({ type: 'FARM' })
ALBot.status()
```

## Fehler-/Abbruchfall

Normal stoppen:

```js
ALBot.fullAutonomy.stop('LIVE_OBSERVATION_STOP')
```

Bei einem relevanten Fehler zuerst sichern:

```js
ALBot.diagnostics()
```

Danach den Diagnoseexport auswerten. Kein Blind-Rerun nach UNKNOWN oder Safety-Suspension.

Der globale rote STOP bleibt jederzeit uebergeordnet verfuegbar.
