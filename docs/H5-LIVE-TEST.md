# H5 – Ein-Klick-Live-Test: Einfacher Kampf

## Ziel

Ab H5 werden Live-Tests als **Ein-Klick-Testablauf** ausgeführt.

Der User drückt im Control Center nur:

**Live-Test → Test starten**

Danach führt AL Bot die definierte Testfolge selbst aus, zeigt jeden Schritt und dessen Status sichtbar an und versucht nach Abschluss automatisch den vollständigen Fehler-/Diagnosebericht in die Zwischenablage zu kopieren.

Der globale rote **STOP** bleibt jederzeit verfügbar und hat Vorrang vor dem Test.

## Erwartete Version

`0.5.0-h5`

## Voraussetzungen

- Character ist eingeloggt und nicht tot.
- Auf der aktuellen Map befindet sich mindestens ein **sichtbares, konservativ als sicher eingestuftes Monster** im Acquire-Radius.
- Monster mit unbekanntem Attack-Wert werden für den automatischen H5-Test fail-closed nicht gewählt.
- Monster, deren Attack oberhalb des konservativen HP-Budgets liegt, werden nicht gewählt.
- Falls der globale STOP gelatcht ist, muss er vor dem Test weiterhin bewusst manuell zurückgesetzt werden.

Es ist **keine manuelle Target-Auswahl** erforderlich.

## Automatische Testfolge

Nach Klick auf **Test starten**:

1. **Preflight**
   - Runtime wird bei Bedarf automatisch gestartet.
   - Combat-Modul muss ACTIVE sein.
   - `attack` und `change_target` müssen über die zentrale Action-Grenze verfügbar sein.
   - ein sichtbares, lebendes, ausreichend schwaches Monster wird gesucht.

2. **Targeting**
   - Combat-Session wird gestartet.
   - AL Bot wählt selbst einen sicheren Kandidaten.
   - Target wird über die Adventure-Land-Live-Entity referenziert.
   - die anschließende Live-Beobachtung muss dasselbe Target bestätigen.

3. **Range / Movement**
   - ist das Monster außerhalb der Attack-Range, verwendet Combat die H4-Movement-Schicht zur kontrollierten Annäherung.
   - fremde Movement-Owner werden nicht verdrängt.
   - Safety/STOP behält Vorrang.

4. **Attack / Cooldown**
   - Angriff wird nur gesendet, wenn die aktuelle Adventure-Land-Readiness Attack zulässt.
   - Cooldown-Wahrheit wird aus der Live-API verwendet.
   - ein Promise-/Command-Return allein gilt nicht als bestätigter Treffer.

5. **Outcome Evidence**
   - mindestens ein Angriff muss durch frische Gameplay-Evidence bestätigt werden, z.B. Ziel-HP sinkt oder das Ziel wird nach dem Angriff beobachtet tot.
   - Reject/unklarer Ausgang wird `UNKNOWN`.
   - nach `UNKNOWN` gibt es keinen Blind-Retry.

6. **Stabilitätsfenster**
   - Combat läuft weitere fünf Sekunden.
   - kein `UNKNOWN` und kein Fail-Safe darf auftreten.

7. **Cleanup**
   - Combat-Session wird beendet.
   - eigenes Combat-Movement wird freigegeben.
   - Target-Ownership wird bereinigt.
   - falls die Runtime nur für den Test automatisch gestartet wurde, wird ihr vorheriger STOPPED-Zustand wiederhergestellt.

8. **Abschluss**
   - Control Center zeigt ausdrücklich:
     - `TEST BEENDET – BESTANDEN`, oder
     - `TEST BEENDET – FAILED/CANCELLED`.
   - jeder Einzelschritt ist mit PASSED/FAILED/SKIPPED sichtbar.
   - der vollständige Diagnosebericht wird automatisch in die Zwischenablage kopiert.
   - blockiert der Browser die automatische Clipboard-Schreiboperation, zeigt die GUI dies sichtbar an; der normale Button **Fehlerbericht kopieren** bleibt als Fallback bestehen.

## H5 Safety

H5 arbeitet ausschließlich mit dem normalen Angriff. Klassenrotationen und klassenspezifische Skills folgen in H6.

Zusätzlich gelten:

- Low HP löst einen Safe-Retreat über die H4-Safe-Return-Schicht aus.
- MP kann als Mindestregel konfiguriert werden.
- Target muss in jedem Combat-Tick frisch sichtbar und lebend sein.
- Target-Ownership wird nicht aus einem historischen Raw-Target abgeleitet.
- Kiting-Grundlage ist vorhanden, im Ein-Klick-H5-Test aber zunächst deaktiviert.
- Monster mit unbekannter Gefahrenstärke werden im automatischen Test nicht gewählt.
- globaler STOP bricht Live-Test, Combat und Movement ab und leert den Scheduler.

## Was der User bei einem Fehlschlag macht

Keine einzelnen Testschritte manuell wiederholen.

1. Sichtbaren Endstatus im **Live-Test**-Tab ansehen.
2. Den automatisch kopierten Bericht direkt in ChatGPT einfügen.
3. Falls die GUI meldet, dass Clipboard automatisch blockiert wurde, einmal **Fehlerbericht kopieren** drücken und den Bericht einfügen.

Damit besteht der normale Live-Test-Workflow ab H5 aus genau **einem Test-Start-Klick**.
