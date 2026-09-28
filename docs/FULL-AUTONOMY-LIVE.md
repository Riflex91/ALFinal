# V6 Full Live – Vier-Character Beobachtung

Stand: 2026-09-27

## Ziel

Dieser Lauf ist kein isolierter H20-Test. Er soll den aktuellen ALFinal/V6-Stand auf vier eigenen Adventure-Land-Characters unter normalem Spielbetrieb beobachten.

Der Runtime-Start aktiviert alle registrierten Module. Der Full-Live-Orchestrator schaltet mutierende Autonomie jedoch rollen- und ownership-gerecht frei, damit nicht mehrere Controller dieselbe Bewegung, Economy-Aktion oder Lifecycle-Recovery gleichzeitig besitzen.

## Rollen und Gruppenvertrag

Full Live arbeitet immer mit genau vier aktiven Characters:

- exakt drei vom Optimizer fuer die aktuelle Aktivitaet ausgewaehlte Combat-Farmer;
- exakt ein Merchant fuer Economy / Logistics.

Die drei Farmer sind nicht auf Warrior, Priest und Ranger fest verdrahtet. Der Optimizer bewertet alle geeigneten Combat-Characters des Accounts nach Aktivitaet, Faehigkeiten, beobachteter Staerke und Catch-up-Bedarf. Dadurch koennen zum Beispiel Warrior, Priest, Ranger, Mage, Rogue oder Paladin je nach Aufgabe in die Dreiergruppe rotieren.

Die Namen und die konkrete Klassenkombination sind nicht hartcodiert. Die Runtime verwendet den accountweiten Roster und frische Character-Profile.

## Startvoraussetzungen

Vor dem Start:

1. jedes bereits laufende Fenster hat exakt denselben aktuellen ALFinal-Build geladen;
2. kein Fenster hat einen gelatchten globalen STOP;
3. bestehende UNKNOWN-/Safety-Suspensions werden nicht automatisch aufgehoben;
4. einige Sekunden fuer gegenseitige H19-CM-Heartbeats abwarten.

Full Live plant immer ein Desired-Quartett aus drei Farmern plus einem Merchant. Sind davon noch nicht alle vier online, darf Full Live im Zustand `WARMING` starten und H19 stellt das gewaehlte Quartett bounded her. Mehr als vier gleichzeitig online gemeldete Account-Characters werden fail-closed blockiert.

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
- die FARM-Ausfuehrungsgruppe besteht immer aus exakt drei Combat-Farmern;
- die Auswahl bewertet aktuelle Staerke, Progression/Catch-up und die fuer die Aktivitaet nuetzlichen Faehigkeiten;
- ein deutlich zurueckliegender Combat-Character kann gezielt als Catch-up-Farmer in die Dreiergruppe rotieren, damit die Account-Characters langfristig ungefaehr im selben Staerke-Korridor bleiben;
- die Namen und die konkrete Klassenkombination sind nicht fest vorgegeben;
- die drei ausgewaehlten Farmer reisen und kaempfen koordiniert; ihr Leader besitzt Farmrichtung und neue Pulls, Followers spiegeln das Gruppenziel und regroupen bei echter Trennung;
- nicht ausgewaehlte Combat-Characters gehoeren nicht als aktiver Standby-Farmer zur Vierergruppe; sie koennen bei einer spaeteren Strategieentscheidung sicher eingewechselt werden;
- BOSS/EVENT/SPECIAL bleiben ebenfalls Dreier-Combat-Gruppen, koennen aber strengere Capability-Anforderungen wie Tank, Healer und DPS verlangen;
- Merchant ist immer der vierte aktive Character und fuehrt Economy-/Logistik-Autonomie aus;
- Party Logistics darf auf dem Merchant Economy bounded abloesen, wenn echte Logistikarbeit vorliegt;
- Lifecycle Recovery haelt das aktuell vom Optimizer gewaehlte Desired-Quartett und rotiert bei einer neuen Auswahl stop-before-start;
- nur der dynamisch gewaehlte Lifecycle-Koordinator fuehrt accountweite Remote-Recovery aus;
- bei einer Farmer-Rotation wird zuerst ein nicht mehr gewuenschter aktiver Farmer gestoppt und erst danach der Ersatz gestartet, damit das Vier-Character-Limit erhalten bleibt;
- Nicht-Koordinatoren fuehren keine konkurrierende accountweite Lifecycle-Autonomie aus.

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
