# H4 – Live-Test: Bewegung

## Ziel

H4 ist der erste AL-Bot-Schritt mit echten Gameplay-Writes.

Getestet werden:
- zentrale Gameplay-Action-Grenze;
- lokale Bewegung mit `move(x,y)`;
- `smart_move`;
- beobachtete Arrival-Postcondition;
- Target-Annäherung;
- Cancel;
- Retarget;
- Stuck-Erkennung;
- Anti-Pingpong;
- Safe Return;
- globaler roter STOP während laufender Bewegung.

H4 führt **keinen Kampf** aus.

## Erwartete Version

`0.4.0-h4`

## Sicherheitsregeln

- Test auf einer normalen, sicheren Map durchführen.
- Für lokale Bewegung nur nahe, sichtbar begehbare Punkte wählen.
- Keine Portale, Instanzen oder gefährliche Maps für den ersten H4-Test verwenden.
- Bei unerwartetem Verhalten sofort roten **STOP** drücken.
- Nach STOP erst nach manueller Prüfung wieder `STOP zurücksetzen`.

## 1. Startzustand

1. H4-Bundle laden.
2. Falls STOP gelatcht ist: **STOP zurücksetzen**.
3. **Start** drücken.
4. Tab **Bewegung** öffnen.

Erwartet:
- Runtime = `RUNNING`;
- Movement-Modul = `ACTIVE`;
- Movement-Zustand = `IDLE`;
- Safe Point wurde beim Runtime-Start an der aktuellen Position gespeichert;
- Scheduler besitzt im Idle weiterhin nur die H2-Basisressourcen.

## 2. Lokale Bewegung

1. Auf derselben Map einen gut sichtbaren Punkt ca. 30–80 Pixel entfernt wählen.
2. Map, x und y im Bewegungs-Tab eintragen.
3. **Lokal bewegen** drücken.

Erwartet:
- genau ein lokaler Bewegungsauftrag;
- Character läuft zum Ziel;
- während der Bewegung existiert genau ein Resource-Scope-Observer für `module:movement`;
- Abschluss nur durch beobachtete Position;
- danach Zustand wieder `IDLE`;
- letzter Auftrag = `COMPLETED / ARRIVAL_VERIFIED`;
- Movement-Observer danach wieder 0.

## 3. Smart Move

1. Einen etwas weiter entfernten, aber sicheren Punkt auf derselben Map wählen.
2. **Smart Move** drücken.

Erwartet:
- nur ein aktiver Movement-Owner;
- `smart_move`-Return allein beendet den Auftrag nicht;
- erst beobachtete Map/Position bestätigt Arrival;
- am Ende `COMPLETED / ARRIVAL_VERIFIED`.

## 4. Retarget

1. Smart Move zu einem deutlich weiter entfernten Punkt starten.
2. Mindestens etwa 1 Sekunde laufen lassen.
3. Ein zweites Ziel eintragen.
4. **Retarget** drücken.

Erwartet:
- alter Auftrag wird zuerst sauber abgebrochen;
- neuer Auftrag erhält den Movement-Owner;
- niemals zwei aktive Movement-Observer gleichzeitig;
- kein Hin-und-her zwischen alten/neuen Zielen.

Ein zu schneller Retarget darf mit `MOVEMENT_RETARGET_TOO_SOON` abgelehnt werden.

## 5. Target-Annäherung

1. Ein sichtbares Monster manuell auswählen.
2. Optional einen gewünschten Abstand eintragen.
3. **Target annähern** drücken.

Erwartet:
- AL Bot berechnet einen Annäherungspunkt;
- wenn lokal begehbar, wird lokale Bewegung verwendet;
- sonst darf Smart Move verwendet werden;
- kein Attack/Skill außer dem internen Stop-Cleanup wird ausgelöst.

## 6. Bewegung abbrechen

Während eines laufenden Smart Move:

1. **Bewegung abbrechen** drücken.

Erwartet:
- letzter Auftrag = `CANCELLED`;
- Movement-Observer = 0;
- Character hört bestmöglich auf zu laufen;
- kein automatischer Retry.

## 7. Safe Return

Der beim Runtime-Start gespeicherte Safe Point ist im Tab sichtbar.

1. Vom Safe Point wegbewegen.
2. **Zum Safe Point zurück** drücken.

Erwartet:
- gleiche Map + begehbarer Punkt: lokale Bewegung;
- sonst Smart Move;
- Safe Return darf durch normale Anti-Pingpong-Sperren nicht blockiert werden;
- Arrival wird wieder beobachtet verifiziert.

## 8. Stuck / UNKNOWN

Die automatische Suite deckt absichtlich ab:
- `smart_move` resolved, aber Position bewegt sich nicht → nach Stuck-Grenze `STUCK`;
- Promise-Rejection mit unklarem Outcome → `UNKNOWN`;
- in beiden Fällen kein blindes Wiederholen.

Ein absichtliches Live-Festfahren ist für den ersten H4-Test nicht erforderlich.

## 9. Globaler STOP während Bewegung

1. Einen längeren Smart Move starten.
2. Während der Character noch läuft, roten **STOP** drücken.

Erwartet:
- Emergency STOP wird gelatcht;
- Runtime = `STOPPED`;
- Scheduler-Ressourcen = 0;
- Movement = nicht aktiv;
- laufende Bewegung wird bestmöglich mit Adventure-Land-Stop-APIs abgebrochen;
- keine neue Bewegung wird akzeptiert, bis STOP manuell zurückgesetzt wurde.

## Bestanden

H4 gilt als live bestanden, wenn:
- lokale Bewegung korrekt ankommt;
- Smart Move nur anhand beobachteter Arrival-Evidence fertig wird;
- Retarget nur einen Movement-Owner hinterlässt;
- Target-Annäherung plausibel ist;
- Cancel funktioniert;
- Safe Return funktioniert;
- kein Pingpong sichtbar ist;
- STOP eine laufende Bewegung beendet;
- keine Movement-Observer/Timer nach Abschluss hängen bleiben;
- H1–H3 unverändert funktionieren.

Bei Abweichung:
1. roten STOP drücken;
2. **Fehlerbericht kopieren**;
3. Bericht plus sichtbare Beobachtung an ChatGPT senden.
