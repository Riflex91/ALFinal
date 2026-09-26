# H9 – Ein-Klick-Live-Test: Farm Intelligence

## Ziel

H9 macht aus H8 einen nachvollziehbaren autonomen Farming-Loop.

H9 entscheidet **wo und was** gefarmt werden soll. H8 bleibt für die eigentliche sichere Pack-/Combat-Ausführung zuständig, H4 für Bewegung.

H9 führt keine direkten Gameplay-Aktionen an H4/H8 vorbei aus.

## Entscheidungsgrundlage

H9 bewertet aktuelle Farmkandidaten aus zwei Live-Quellen:

1. H5-sichere sichtbare Monstercluster der aktuellen Map;
2. Spawnpunkte der aktuellen Map aus dem live geladenen Adventure-Land-`G.maps`.

Monster-Kampfwerte stammen aus dem live geladenen `G.monsters`. Basisgold wird aus `G.monster_gold` plus den live geladenen `G.drops.gold`-Regeln abgeleitet; Monster-Drops kommen aus `G.drops.monsters`.

Bewertet werden:

- XP-Effizienz;
- Gold-Effizienz;
- Drop-Signal;
- sichere sichtbare Mob-Dichte;
- geschätzte Reisezeit;
- Respawn-Signal;
- sichtbare Konkurrenz;
- Sicherheitskonfidenz.

Der Gesamt-Score ist im Control Center und in Diagnostics aufgeschlüsselt.

## Live-Wahrheit vor Heuristik

Sichtbare H5-sichere Monster haben höhere Sicherheitskonfidenz als ein nur aus `G.maps` bekannter Spawn.

Ein bekannter Spawn darf H9 zur Reise veranlassen. H8-Combat startet dort aber erst, wenn die lokale Live-Situation erneut sicher bewertet wurde.

Unbekannte Remote-Spieler/Konkurrenz werden nicht als beobachtete Live-Wahrheit ausgegeben.

### Trefferwahrscheinlichkeit / Monstermechaniken

H9 und H5 lesen die Live-Monsterwerte `evasion` und `avoidance` aus `G.monsters` sowie den tatsächlichen `damage_type` des Charakters.

- Physische Klassen berücksichtigen Monster-Evasion.
- Magische Klassen werden nicht allein wegen physischer Evasion ausgeschlossen.
- `avoidance` reduziert die erwartete Trefferwahrscheinlichkeit unabhängig vom physischen Evasion-Sonderfall.
- Kandidaten unter der konservativen Mindest-Trefferwahrscheinlichkeit von 25 % werden vor Targeting und Farming-Auswahl ausgeschlossen.
- Bei verbleibenden Kandidaten reduziert die erwartete Trefferwahrscheinlichkeit den geschätzten DPS und damit XP-/Gold-Effizienz.

Damit kann z. B. ein Monster mit `evasion: 99` nicht mehr wegen hoher nomineller XP einen physischen Farmer anlocken.

## Anti-Pingpong

H9 wechselt nicht bei jedem kleinen Score-Unterschied.

Es gelten:

- Mindest-Hold-Zeit;
- Switch-Cooldown;
- erforderlicher relativer Score-Vorteil;
- A→B→A-Schutz innerhalb eines Pingpong-Fensters.

Wenn die bisherige Auswahl weiterhin gültig ist, muss ein neues Ziel den konfigurierten Vorteil erreichen.

Verschwindet der bisherige sichere Cluster vollständig, darf H9 sofort neu planen.

## Ownership / Safety

H9:

- stiehlt keine fremde H8-Farming-Session;
- stiehlt keine fremde H4-Movement-Order;
- erkennt H5-Approach/Kite/Retreat-Movement als delegierte Ownership, solange die zugehörige H8-Session H9 gehört;
- stoppt nur eigene H8/H4-Ownership;
- tritt nach Session-Start ein fremdes Party-Mitglied bei, stoppt H9 seine eigene H8/H4-Arbeit sofort und suspendiert;
- erscheint während H9 eine fremde aktive H4-Movement-Order, suspendiert H9 statt dagegen anzulaufen;
- suspendiert bei H4-`UNKNOWN` oder `FAILED_SAFE`;
- führt danach keinen Blind-Retry aus;
- respektiert H8/H5/Party-Safety vollständig;
- wird vom globalen STOP über die normale Modul-/Scheduler-Kette beendet.

## Ein-Klick-Live-Test

Der User drückt nur **Test starten**.

### 1. Preflight

Automatisch geprüft:

- Farm-Intelligence-Modul ACTIVE;
- lebender Combat-Charakter;
- kein Merchant;
- keine fremden Party-Mitglieder;
- mindestens ein sichtbarer H5-sicherer Cluster als Live-Sicherheitsbeweis;
- mindestens zwei aktuelle Farmkandidaten;
- H9 darf trotzdem einen nicht sichtbaren, bekannten `G.maps`-Spawn als besseren Gesamt-Score wählen;
- H9 erzeugt einen erklärbaren Score mit Safety-, XP-, Gold-, Drop-, Dichte-, Reise-, Respawn- und Konkurrenzanteilen.

### 2. Autonomous Start

H9 startet seine Autonomie.

Erwartung:

- H9 wählt selbst ein Farmziel;
- liegt das Ziel entfernt, übernimmt H4 die Reise vollständig;
- die Suite wartet auch auf reale Smart-Move-Reisezeit statt einen sichtbaren Startcluster zu erzwingen;
- H8-Session wird am gewählten Ziel mit Owner `farm-intelligence-h9` gestartet;
- keine manuelle Target-/Monsterwahl nötig.

### 3. Confirmed Farming

Mindestens eine echte Farming-Aktion muss live bestätigt werden:

- entweder H8-AoE bestätigt;
- oder H5-Basisangriff bestätigt.

Neue H8-/H5-`UNKNOWN` führen zum Fail.

### 4. Adaptive Entscheidung / Switch

Die Suite beobachtet mehrere echte H9-Entscheidungszyklen unter Live-Bedingungen.

Ein Farmspot-Wechsel ist **kein künstliches Muss**: Bleibt der aktuelle Spot nach Score und Hold-Regeln weiterhin die beste Wahl, ist stabiles Halten korrekt. Wird ein anderer Kandidat besser und die Switch-Regeln erlauben den Wechsel, darf H9 natürlich wechseln.

Geprüft werden:

- mehrere fortlaufende H9-Entscheidungen;
- weiterhin mindestens zwei Farmkandidaten;
- ein echter Wechsel wird erfasst, falls die Live-Lage ihn auslöst;
- die komplette H9-History bleibt frei von A→B→A-Pingpong.

Der deterministische Switch-, Depletion- und Anti-Pingpong-Pfad ist zusätzlich durch H9-Regressionstests abgedeckt.

### 5. Stability

Fünf Sekunden nach der adaptiven Beobachtung:

- H9 nicht suspendiert;
- kein neues H8-AoE-`UNKNOWN`;
- kein neues H5-Attack-`UNKNOWN`;
- kein neues H7-Focus-Pingpong;
- kein Ownership-Konflikt.

### 6. Cleanup

H9 stoppt seine eigene Autonomie.

Erwartung:

- H9 inaktiv;
- keine H9-eigene H8-Farming-Session;
- keine H9-eigene H4-Movement-Order;
- Combat inaktiv;
- automatisch gestartete Runtime danach wieder STOPPED;
- Scheduler danach 0 Ressourcen.

## Erwartete Version

`0.9.0-h9`


## Live-Ergebnis 2026-09-26

H9 wurde mit AL Bot `0.9.0-h9` im echten Adventure-Land-Livebetrieb vollständig bestanden.

Ergebnis der Ein-Klick-Suite `h9-farm-intelligence`:

- Gesamtstatus: `PASSED / ALL_STEPS_PASSED`;
- Preflight PASSED;
- Autonomous Start PASSED;
- Confirmed Farming PASSED;
- Adaptive Entscheidung / Switch PASSED;
- Stability Window PASSED;
- Cleanup PASSED;
- initiale Auswahl: bekannter Goo-Spawn;
- spätere Live-Auswahl: Squigtoad;
- echte H5-Farming-Evidence: mindestens ein bestätigter Basisangriff;
- adaptive Beobachtung: 63 Entscheidungen, 22 Holds, 2 echte Switches, 3 Travel Orders;
- Anti-Pingpong aktiv: 6 Blocks, kein A→B→A-Verstoß;
- H8 AoE UNKNOWN: 0;
- H5 Attack UNKNOWN: 0;
- H7 Focus-Pingpong: 0;
- H9 Ownership Blocks: 0;
- H9 Movement UNKNOWN: 0;
- Cleanup vollständig: H9/H8/H5/H4 inaktiv;
- Runtime danach STOPPED;
- Scheduler danach 0 Ressourcen.

Der zuvor live gefundene Froggie-Fall wurde vor diesem finalen Pass geschlossen: physische Farmer filtern Monster unter 25 % erwarteter Trefferwahrscheinlichkeit anhand von `evasion`/`avoidance` aus. Der finale Live-Bericht enthält keine Frog-/Froggie-Auswahl und bestätigt damit den korrigierten Pfad unter realen Bedingungen.
