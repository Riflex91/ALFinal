# H1 – Live-Test: Foundation & Control Center

## Ziel

H1 enthält noch keine Gameplay-Automation. Der Test prüft ausschließlich das Fundament.

## Laden

Die PR-Version soll direkt als `dist/al-bot.js` geladen werden. Für den Live-Test wird der exakte PR-Commit verwendet, damit der getestete Stand unveränderlich ist.

## Prüfschritte

1. AL Bot laden.
2. Control Center erscheint deutlich größer und kann unten rechts in der Größe verändert werden.
3. Control Center an der Kopfzeile per Drag verschieben.
4. Minimieren-Button testen: Fenster klappt bis auf die Kopfzeile ein; STOP bleibt sichtbar.
5. Minimieren-Button erneut drücken: Fenster klappt vollständig wieder auf.
6. Unter **Übersicht** werden aktuell laufende eigene Charaktere dynamisch erkannt.
   - Keine Charakternamen sind im Bot hartcodiert.
   - Aktive Combat-Klassen erscheinen als Farmer.
   - Ein aktiver Merchant wird separat angezeigt.
7. **Prioritäten** öffnen.
8. Test-Goal anlegen, z.B. `COLLECT_ITEM / seashell / 200 / FARMERS / HIGH`.
9. Goal pausieren, fortsetzen und abbrechen.
10. Das kleine rote **×** am Goal testen: Ziel muss vollständig aus der Liste verschwinden.
11. Prüfen, dass **Leveling** standardmäßig auf **NORMAL** steht.
12. Eine Grundpriorität ändern.
13. **Selftest** ausführen.
14. **Fehlerbericht kopieren** testen.
15. **Start** drücken.
16. Den roten **STOP** drücken.
17. Prüfen, dass Runtime auf STOPPED und Emergency STOP auf AKTIV steht.
18. Seite/Code neu laden: STOP muss weiterhin gelatcht bleiben.
19. **STOP zurücksetzen** drücken und Start erneut testen.

## Bestanden

H1 gilt als bestanden, wenn:
- GUI stabil erscheint, ausreichend groß, resizable, verschiebbar und minimierbar ist;
- dynamische Farmer-Erkennung keine Namen voraussetzt;
- Goals/Prioritäten gespeichert und bedienbar sind;
- Diagnose kopierbar ist;
- STOP zuverlässig latched und nur manuell zurückgesetzt wird;
- keine Gameplay-Aktion ausgeführt wird.

Bei Fehlern: roten STOP drücken, **Fehlerbericht kopieren**, Bericht plus kurze Beobachtung an ChatGPT senden.
