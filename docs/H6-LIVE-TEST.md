# H6 – Ein-Klick-Live-Test: Klassenlogik

## Ziel

H6 erweitert den in H5 live bestätigten Combat-Core um **klassenspezifische Skill-Entscheidungen** für:

- Warrior
- Ranger
- Mage
- Priest
- Rogue
- Paladin

Der Live-Test bleibt ein Ein-Klick-Ablauf.

Der User drückt nur:

**Test starten**

Danach führt AL Bot alle Schritte automatisch aus, zeigt den Fortschritt sichtbar an und kopiert nach Abschluss den vollständigen Diagnosebericht in die Zwischenablage.

## Erwartete Version

`0.6.0-h6`

## Abgrenzung

H6 testet bewusst nur die Logik eines einzelnen aktiven Charakters.

Noch **nicht** Bestandteil:
- Party-Healing / Party-Assist / Focus Fire → H7
- Mehrziel-/AoE-Entscheidungen → H8
- autonome Farmspot-Wahl → H9

Dadurch bleibt H6 klein und eindeutig testbar.

## Live-Wahrheit

Skill-Entscheidungen dürfen nicht nur auf hartcodierten Tabellen beruhen.

AL Bot liest für den aktuell eingeloggten Charakter:
- `G.skills[skill]`;
- erlaubte Klasse;
- erforderliches Level;
- MP-Kosten;
- aktuelle MP;
- `is_on_cooldown(skill)`;
- `can_use(skill)`;
- `is_in_range(target, skill)`;
- Shared-Cooldown-/Range-Metadaten aus der aktuellen Skilldefinition;
- aktive Conditions wie `character.s[skill]`.

Statische H6-Profile bestimmen nur **wann ein bekannter Skill sinnvoll sein könnte**. Ob er jetzt tatsächlich eingesetzt werden darf, entscheidet die Live-Readiness.

## Klassenprofile in H6

### Warrior
- `hardshell` bei niedrigem HP, sofern live verfügbar
- `charge` zum sinnvollen Distanzschließen
- `taunt` für kontrollierten Engage/Aggro-Reclaim
- `warcry` nur bei längerem Kampf und ausreichender MP-Reserve

AoE-Skills wie Cleave/Stomp bleiben H8.

### Ranger
- `huntersmark` bei längerem Kampf
- `supershot` nur wenn kein offensichtlicher teurer Overkill entsteht

3shot/5shot bleiben H8.

### Mage
- `burst` als kontrollierter Single-Target-Damage-Skill

CBurst/AoE-Planung bleibt H8; Energize/Party-Support folgt H7.

### Priest
- `curse` für ausreichend langlebige Ziele
- `darkblessing` bei längerem Kampf und ausreichender MP-Reserve

Heal/Party Heal/Absorb/Revive werden mit Party-Kontext in H7 ausgebaut.

### Rogue
- `invis` als defensive Notfalloption
- `mentalburst` / `quickpunch` nur bei sinnvoller Damage-Nutzung

Fan of Knives bleibt H8.

### Paladin
- `selfheal` bei HP-Schwelle
- `smash` nur bei sinnvoller Single-Target-Nutzung

Komplexere neue Ally-/Aura-Mechaniken werden nicht geraten und folgen erst nach eigener Live-Semantikprüfung.

## Safety / Anti-Spam

- maximal ein offener Class-Skill-Command gleichzeitig;
- globaler Mindestabstand zwischen Skill-Versuchen;
- pro Skill/Target zusätzliche Recast-Sperre;
- MP-Reserve;
- Cooldown-/Range-/Level-/Class-Prüfung unmittelbar vor Dispatch;
- bekannte serverseitige Ablehnung erzeugt Backoff statt Spam;
- unklarer Netzwerk-/Timeout-Ausgang wird `UNKNOWN`;
- nach Class-Skill-`UNKNOWN` werden weitere Class-Skills für die laufende Combat-Session suspendiert;
- der bewährte H5-Basiscombat darf weiterarbeiten;
- kein Blind-Retry eines unklaren Skills;
- globaler roter STOP bleibt jederzeit vorrangig.

## Automatische H6-Testfolge

### 1. Preflight

Automatisch prüfen:
- Character vorhanden und lebendig;
- aktuelle Klasse ist eine der sechs H6-Klassen;
- Class-Skill-Modul ist ACTIVE;
- `use_skill` ist verfügbar;
- mindestens ein H6-Skill der Klasse existiert in den aktuellen Live-`G.skills`;
- ein konservativ sicherer sichtbarer Gegner ist vorhanden;
- für diesen Gegner existiert aktuell eine sinnvolle Class-Skill-Entscheidung;
- HP und Monster-Attack erlauben den kontrollierten Test.

### 2. Combat starten

AL Bot:
- startet eine H6-Combat-Session;
- wählt selbst einen sicheren Gegner;
- bestätigt das Target aus dem Live-Spielzustand.

Keine manuelle Target-Auswahl erforderlich.

### 3. Class Skill

Der Test wartet auf mindestens einen **serverbestätigten klassenspezifischen Skill**.

Ein lokaler Funktionsaufruf allein reicht nicht.

Bei unklarem Outcome:
- H6 setzt Class Skills auf `UNKNOWN/suspended`;
- kein Blind-Retry;
- Test schlägt fail-safe fehl.

### 4. Anti-Spam-Fenster

Fünf Sekunden automatisch beobachten:
- kein Class-Skill-`UNKNOWN`;
- kein neuer H5-Attack-`UNKNOWN`;
- Dispatch/Confirm/Reject-Zähler bleiben konsistent;
- maximal 12 Class-Skill-Dispatches im Fenster;
- Cooldown- und Anti-Spam-Skips bleiben sichtbar diagnostizierbar.

### 5. Cleanup

Automatisch:
- Combat stoppen;
- Class-Skill-Pending muss leer sein;
- Class-Skill-Session-Ownership muss freigegeben sein;
- Combat-Movement muss freigegeben sein;
- wenn die Runtime nur für den Test gestartet wurde, wird sie wieder in den vorherigen STOPPED-Zustand versetzt.

## Abschluss

Erwartete GUI-Ausgabe:

`TEST BEENDET – BESTANDEN`

Alle fünf Schritte müssen `PASSED` sein.

Danach wird der Diagnosebericht automatisch in die Zwischenablage kopiert.

Falls der Browser Clipboard-Schreiben blockiert, zeigt die GUI dies sichtbar an; dann einmal **Fehlerbericht kopieren** drücken.

## Bedienung

Nach Laden des H6-Bundles:

**nur einmal „Test starten“ drücken.**

Nicht nötig:
- vorher Start drücken;
- Monster auswählen;
- Combat manuell starten;
- Skills manuell drücken;
- einzelne Testschritte wiederholen.

Bei Fehler den automatisch kopierten Bericht direkt in ChatGPT einfügen.


---

## Live-Ergebnis 2026-09-26

**BESTANDEN**

Der H6-Ein-Klick-Live-Test wurde im echten Adventure-Land-Client erfolgreich abgeschlossen.

Live bestätigt:
- Version `0.6.0-h6`;
- aktuelle Klasse wurde als Ranger erkannt;
- Live-`G.skills` für `huntersmark` und `supershot` wurden korrekt gelesen;
- `preflight` = PASSED;
- `start-combat` = PASSED;
- `class-skill` = PASSED;
- `anti-spam-window` = PASSED;
- `cleanup` = PASSED;
- Endstatus = `PASSED / ALL_STEPS_PASSED`;
- mindestens ein klassenspezifischer Skill wurde serverbestätigt eingesetzt;
- Hunter's Mark wurde als Support-Skill bestätigt;
- Supershot wurde als Damage-Skill bestätigt;
- Class-Skill-Metrik: dispatched = 2, confirmed = 2, rejected = 0, unknown = 0;
- kein Class-Skill-UNKNOWN;
- kein H5-Attack-UNKNOWN;
- Anti-Spam-/Recast-Verhalten blieb aktiv und diagnostizierbar;
- eine Range-Annäherung lief kontrolliert über H4 Movement;
- Combat-Cleanup setzte Combat inaktiv;
- Class-Skill-Pending wurde geleert;
- Class-Skill-Session-Ownership wurde freigegeben;
- Movement wurde freigegeben;
- die für den Test automatisch gestartete Runtime wurde anschließend wieder auf STOPPED zurückgesetzt;
- Scheduler nach Abschluss = 0 Ressourcen.

H6 ist damit live vollständig bestanden.
