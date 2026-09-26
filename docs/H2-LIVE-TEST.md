# H2 – Live-Test: Runtime-Stabilität

## Ziel

H2 testet ausschließlich den Runtime-Unterbau. Es werden **keine Gameplay-Aktionen** ausgeführt.

Geprüft werden:
- zentraler Scheduler;
- Timer-/Event-Cleanup;
- Module Lifecycle;
- Crash-Isolation;
- Watchdog-Basis;
- Hot Reload;
- globaler STOP.

## Erwartete Anzeige

Nach dem Laden zeigt die Übersicht:
- Version `0.2.0-h2`;
- Scheduler `STOPPED`, solange der Bot nicht gestartet ist;
- Scheduler-Ressourcen `0`;
- Modul `runtime-health`.

## Live-Test

1. H2-Bundle laden.
2. Falls der globale STOP aus einem früheren Test noch gelatcht ist: bewusst über **STOP zurücksetzen** freigeben.
3. **Start** drücken.
4. In der Übersicht prüfen:
   - Runtime = `RUNNING`;
   - Scheduler = `ACTIVE`;
   - Scheduler-Ressourcen sind > 0;
   - `runtime-health` = `ACTIVE / HEALTHY`;
   - die Ressourcenanzahl von `runtime-health` ist `1`.
5. Die aktuell angezeigte Gesamtzahl der Scheduler-Ressourcen merken.
6. Unter **Entwicklung** auf **H2 Runtime-Test** drücken.
7. Ergebnis muss `"passed": true` enthalten.
8. `restartResourceCounts` muss ausschließlich `1` enthalten.
9. `resourcesAfterStop` muss `0` sein.
10. **Stop** drücken.
11. Prüfen:
    - Runtime = `STOPPED`;
    - Scheduler = `STOPPED`;
    - Scheduler-Ressourcen = `0`;
    - kein Modul bleibt in `STARTING` oder `STOPPING`.
12. Wieder **Start** drücken.
13. Prüfen, dass die Gesamtzahl der Scheduler-Ressourcen wieder genau dem gemerkten Ausgangswert entspricht und nicht wächst.
14. Während Runtime = `RUNNING` dasselbe H2-Bundle erneut laden.
15. Nach dem Reload prüfen:
    - Boot-Zähler ist erhöht;
    - Anzeige enthält `Hot Reload`;
    - neue Runtime startet `STOPPED`;
    - Scheduler-Ressourcen = `0`.
16. Wieder **Start** drücken.
17. Prüfen, dass die Scheduler-Ressourcen erneut nur dem normalen Ausgangswert entsprechen – keine Verdopplung alter Timer.
18. Den roten **STOP** drücken.
19. Prüfen:
    - Emergency STOP = aktiv;
    - Runtime = `STOPPED`;
    - Scheduler = `STOPPED`;
    - Scheduler-Ressourcen = `0`.
20. **STOP zurücksetzen**, erneut **Start**, anschließend normal **Stop**.

## Bestanden

H2 gilt als bestanden, wenn:
- wiederholtes Start/Stop keine Ressourcen anwachsen lässt;
- der H2 Runtime-Test `passed: true` meldet;
- Hot Reload keine alten Timer/Listener übrig lässt;
- kein Modul in einem Zwischenzustand hängen bleibt;
- `runtime-health` während des Betriebs `HEALTHY` bleibt;
- STOP alle Scheduler-Ressourcen sofort entfernt;
- Control Center weiterhin normal bedienbar bleibt.

Bei einer Abweichung:
1. roten STOP drücken;
2. **Fehlerbericht kopieren**;
3. Bericht plus kurze sichtbare Beobachtung an ChatGPT senden.
