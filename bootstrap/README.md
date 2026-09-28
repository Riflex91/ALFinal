# AL Bot Bootstrap

Adventure Land darf nicht mehr das vollständige `dist/al-bot.js` in einem Code-Slot speichern. Der permanente Code-Slot enthält ausschließlich `bootstrap/al-bot-bootstrap.js`.

## Einmalige Installation

1. Öffne in Adventure Land einen normalen Code-Slot.
2. Ersetze den Slot-Inhalt vollständig durch den Inhalt von `bootstrap/al-bot-bootstrap.js`.
3. Speichere diesen kleinen Bootstrap im Slot.
4. Starte den Slot auf jedem gewünschten Charakter wie gewohnt.

Der Bootstrap lädt beim Erststart ausschließlich:

`https://raw.githubusercontent.com/Riflex91/ALFinal/main/release/al-bot-release.json`

Danach validiert er Manifest, Bootstrap-Mindestversion, immutable Commit-Pinning, HTTPS/Host, Byteanzahl, SHA-256 und den erwarteten AL-Bot-Banner. Erst nach erfolgreicher Prüfung wird das gepinnte `dist/al-bot.js` direkt im Character-Fenster ausgeführt und per Runtime-Handshake geprüft.

## Zuständigkeiten

Der Bootstrap ist nur Loader/Transport. Er besitzt keinen Update-Timer und installiert keine laufenden Releases eigenständig, sobald `ALBot` existiert.

Der laufende `SafeAutoUpdater` entscheidet weiterhin über:

- Release-Auswahl und Downgrade-Schutz
- Event-/Boss-Schutz
- Cross-Window Prepare/Commit
- gemeinsamen `applyAtMs`
- Quarantäne und Retry
- Runtime-/Health-Handshake
- Full-Autonomy-Rearm
- Rollback auf die vorherige immutable Release-Identität

Das vollständige Bot-Bundle wird weder mit `upload_code` noch mit `save_code` noch über einen Staging-Code-Slot gespeichert.

## Diagnose

Nach dem Start müssen verfügbar sein:

`__ALBOT_BOOTSTRAP__.version`

und nach erfolgreichem Erststart:

`ALBot.version`

sowie:

`__ALBOT_BOOTSTRAP__.activeRelease()`

Die aktive Release-Identität enthält unter anderem `version`, `commitSha`, `sha256`, `bytes` und die commit-gepinnte `bundleUrl`.
