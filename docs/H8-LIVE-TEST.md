# H8 – Ein-Klick-Live-Test: AoE & adaptives Farming

## Ziel

H8 erweitert den live bestätigten H5–H7-Core um konservatives Multi-Target-Farming:

- sichere Pack-/Pull-Planung;
- dynamische Gegnerzahl;
- aggregiertes Risikobudget statt nur Einzelmonsterprüfung;
- klassenabhängige AoE-/Multi-Target-Skills;
- adaptiver Wechsel auf Single Target bei geringerer Sicherheitsreserve;
- Retreat bei niedrigen HP;
- keine Umgehung von H4 Movement, H5 Combat, H6 Klassenlogik oder H7 Party-Safety;
- kein Blind-Retry nach UNKNOWN.

Der Live-Test ist weiterhin eine Ein-Klick-Suite.

Der User drückt nur:

**Test starten**

## Erwartete Version

`0.8.0-h8`

## Unterstützte H8-AoE-Skills

Nur live vorhandene und aktuell verwendbare Skills werden berücksichtigt:

- Warrior: `cleave`, `stomp`
- Ranger: `3shot`, `5shot`
- Mage: `cburst`
- Rogue: `fanofknives`

Priest und Paladin bleiben in H8 bei ihrer bereits validierten Single-Target-/Support-Rolle, solange keine separat validierte H8-AoE-Policy vorliegt.

Merchant bleibt LOGISTICS und startet kein H8-Combat.

## Safety-Kette

H8 erzeugt keine eigene alternative Combat-Wahrheit.

Pack-Kandidaten müssen zuerst die H5-Sicherheitsfilter bestehen:

- sichtbare, lebende Live-Entity;
- richtige Map;
- konservative Distanz;
- bekannter Monster-Angriff;
- individueller Angriff unter H5-Grenze;
- kein fremd belegtes Target, außer bereits verifizierter Owned-Party-Assist.

Zusätzlich begrenzt H8:

- Pack-Kapazität nach Klasse;
- Pack-Kapazität nach aktuellem HP-Verhältnis;
- Summe der Monster-Angriffe relativ zu `maxHp`;
- gleiche Monsterart innerhalb eines geplanten Packs;
- live-bereiten Skill;
- Skill-Reichweite;
- MP/Cooldown/`can_use`;
- für untargeted AoE: die gesamte sichtbare Wirkzone muss aus H5-sicheren Kandidaten bestehen.

Wenn eine Bedingung nicht sicher belegt ist, fällt H8 auf Single Target oder BLOCKED zurück.

## Adaptive Grenzwerte

Konservative Startwerte:

- AoE erst ab ausreichend hoher HP-Reserve;
- Pull-/Pack-Erweiterung nur bei noch höherer HP-Reserve;
- harte Retreat-Grenze darunter;
- aggregierter Monster-Angriff maximal als begrenzter Anteil von `maxHp`.

Die exakten Werte sind im H8-Status/Diagnosebericht sichtbar und werden später anhand echter Live-Evidence weiter kalibriert.

## ActionBoundary / UNKNOWN

Alle H8-Skills laufen über die zentrale `GameActionBoundary`.

Es gilt:

- maximal ein Pending-AoE-Command;
- bekannte Ablehnung → Backoff;
- synchrones UNKNOWN → sofortige H8-Suspension;
- asynchron unklarer Ausgang → H8-Suspension;
- kein Blind-Retry innerhalb derselben H8-Session.

H6 behält Priorität vor H8. Ein H6-Pending-Command blockiert H8.

## Automatische Testfolge

### 1. Preflight

Die Suite prüft automatisch:

- Adaptive-Farming-Modul ACTIVE;
- Combat-Klasse, kein Merchant;
- keine fremden Party-Mitglieder;
- mindestens ein live-bereiter H8-AoE-Skill;
- HP oberhalb der AoE-Schwelle;
- mindestens ein ausreichend großes Pack aus H5-sicheren sichtbaren Monstern gleicher Art.

Wenn die lokale Klasse/Level/Ausrüstung keinen live-bereiten H8-Skill besitzt, endet der Test fail-closed mit einer verständlichen Diagnose.

### 2. Adaptive Pack

H8 startet seine eigene Farming-Session und die darunterliegende H5-Combat-Session.

Erwartung:

- `owner = farming-h8` für den Combat-Core;
- H8 erreicht `AOE_READY`;
- Pack-Größe liegt innerhalb der berechneten Kapazität;
- aggregiertes Angriffsbudget wird nicht überschritten.

### 3. Bestätigter AoE

Mindestens ein H8-AoE-Skill muss serverbestätigt ausgeführt werden.

Ein Promise-/Dispatch-Erfolg ohne bestätigtes Ergebnis genügt nicht.

### 4. Stabilitätsfenster

Fünf Sekunden:

- kein neues H8-`UNKNOWN`;
- kein neues H5-`attackUnknown`;
- keine H8-Suspension;
- kein neues H7-`focusPingPongs`;
- Pack bleibt innerhalb der Kapazität;
- aggregiertes Angriffsbudget bleibt innerhalb der Sicherheitsgrenze.

### 5. Cleanup

Die Suite stoppt H8 und dessen eigene H5-Combat-Session.

Erwartung:

- H8 inaktiv;
- kein Pending-AoE;
- Combat inaktiv;
- kein Combat-Movement übrig;
- automatisch gestartete Runtime danach wieder STOPPED;
- Scheduler danach 0 Ressourcen.

## Bedienung

Für den echten Live-Test:

1. einen Combat-Charakter verwenden, der einen H8-AoE-Skill live verwenden kann;
2. in einem Gebiet mit mehreren konservativ sicheren Monstern derselben Art stehen;
3. **nur einmal „Test starten“ drücken**;
4. den automatisch kopierten Diagnosebericht senden.

Keine manuellen Targets, Skill-Klicks oder Zwischenschritte sind erforderlich.
