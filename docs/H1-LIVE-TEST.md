# H1 – Live-Test: Foundation & Control Center

## Ziel

H1 enthält noch keine Gameplay-Automation. Der Test prüft ausschließlich das Fundament.

## Laden

Die PR-Version soll direkt als `dist/al-bot.js` geladen werden. Für den Live-Test wird der exakte PR-Commit verwendet, damit der getestete Stand unveränderlich ist.

## Prüfschritte

1. AL Bot laden.
2. Control Center erscheint.
3. Unter **Übersicht** werden aktuell laufende eigene Charaktere dynamisch erkannt.
   - Keine Charakternamen sind im Bot hartcodiert.
   - Aktive Combat-Klassen erscheinen als Farmer.
   - Ein aktiver Merchant wird separat angezeigt.
4. **Prioritäten** öffnen.
5. Test-Goal anlegen, z.B. `COLLECT_ITEM / seashell / 200 / FARMERS / HIGH`.
6. Goal pausieren, fortsetzen und abbrechen.
7. Eine Grundpriorität ändern.
8. **Selftest** ausführen.
9. **Fehlerbericht kopieren** testen.
10. **Start** drücken.
11. Den roten **STOP** drücken.
12. Prüfen, dass Runtime auf STOPPED und Emergency STOP auf AKTIV steht.
13. Seite/Code neu laden: STOP muss weiterhin gelatcht bleiben.
14. **STOP zurücksetzen** drücken und Start erneut testen.

## Bestanden

H1 gilt als bestanden, wenn:
- GUI stabil erscheint;
- dynamische Farmer-Erkennung keine Namen voraussetzt;
- Goals/Prioritäten gespeichert und bedienbar sind;
- Diagnose kopierbar ist;
- STOP zuverlässig latched und nur manuell zurückgesetzt wird;
- keine Gameplay-Aktion ausgeführt wird.

Bei Fehlern: roten STOP drücken, **Fehlerbericht kopieren**, Bericht plus kurze Beobachtung an ChatGPT senden.
