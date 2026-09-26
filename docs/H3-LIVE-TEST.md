# H3 – Live-Test: Game Adapter & Knowledge

## Ziel

H3 führt weiterhin **keine Gameplay-Automation** aus.

Geprüft werden:
- normalisierte Live-Spielwahrheit;
- dynamische Roster-Erkennung;
- read-only Windows-Bridge-KnowledgeProvider;
- validierter Last-Known-Good Cache;
- stabiles Verhalten bei fehlendem/ausgefallenem Knowledge-Provider.

## Erwartete Version

`0.3.0-h3`

## 1. Game Adapter

1. H3-Bundle laden.
2. Control Center → **Übersicht** öffnen.
3. Im Bereich **Live Game Adapter** prüfen:
   - Charactername stimmt;
   - Klasse stimmt;
   - Map stimmt;
   - HP / Max-HP stimmen;
   - MP / Max-MP stimmen;
   - Position x/y entspricht der sichtbaren aktuellen Position plausibel.
4. Ein sichtbares Monster manuell als Target auswählen.
5. Prüfen, dass **Target** im Control Center dieses Target anzeigt.
6. Target wieder entfernen; Anzeige muss auf `keins` wechseln.

Der Adapter ist in H3 read-only. Er darf keine Bewegung, keinen Angriff und keine andere Spielmutation auslösen.

## 2. Dynamisches Roster

In der Übersicht prüfen:
- eigene aktiven/online Charaktere werden erkannt;
- Combat-Klassen erscheinen als Farmer;
- Merchant wird als Merchant erkannt;
- es ist keine manuelle Namenskonfiguration erforderlich.

## 3. Knowledge Provider

1. Tab **Knowledge** öffnen.
2. Prüfen:
   - Provider = `windows-bridge`;
   - Read-only = `JA`;
   - Repository = `Riflex91/Riflex91-Repo`;
   - Branch = `main`.
3. **Knowledge aktualisieren** drücken.

Zwei Ergebnisse sind gültig:

### A – Bridge-Snapshot vorhanden

Erwartet:
- Status = `READY`;
- Modus = `HANDOFF` oder `GITHUB_MIRROR`;
- Last Known Good zeigt eine Generation;
- Snapshot-SHA256 wird angezeigt;
- Faktanzahl wird angezeigt.

### B – Bridge hat noch keinen Snapshot bereitgestellt

Erwartet:
- Status = `WAITING_FOR_BRIDGE`;
- Hinweis `BRIDGE_SNAPSHOT_NOT_AVAILABLE`;
- Runtime bleibt stabil;
- Scheduler bleibt aktiv;
- kein globaler STOP wird ausgelöst;
- kein Last Known Good wird erfunden.

Dieser Zustand ist bei einer noch leeren lokalen Live-Wissensdatenbank ausdrücklich zulässig.

## 4. Last Known Good

Falls im Test ein echter Snapshot `READY` geladen werden kann:

1. Generation und Snapshot-Hash merken.
2. Danach Bridge bzw. Knowledge-Quelle vorübergehend unerreichbar machen und erneut **Knowledge aktualisieren**.
3. Provider darf `UNAVAILABLE` melden.
4. Das vorherige Last Known Good muss weiterhin sichtbar bleiben.
5. Runtime muss weiterlaufen.

Wenn noch kein echter Snapshot existiert, wird dieser Punkt durch die automatische H3-Regression abgedeckt.

## 5. Regression

- **Start** / **Stop** funktionieren weiterhin.
- Scheduler hat während normalem Betrieb weiterhin genau die H2-Basisressourcen.
- Hot Reload funktioniert weiterhin.
- roter globaler STOP funktioniert weiterhin.
- Selftest meldet `passed: true`.
- Keine Gameplay-Aktion wird von H3 automatisch ausgeführt.

## Bestanden

H3 gilt als live bestanden, wenn:
- Character/Map/HP/MP/Position korrekt sind;
- Target korrekt erscheint und wieder verschwindet;
- Roster korrekt bleibt;
- Knowledge-Provider als read-only sichtbar ist;
- `READY` oder korrektes `WAITING_FOR_BRIDGE` angezeigt wird;
- Knowledge-Ausfall den Core nicht stoppt;
- H1/H2-Stabilität unverändert bleibt.

Bei einer Abweichung:
1. roten STOP drücken;
2. **Fehlerbericht kopieren**;
3. Bericht plus kurze sichtbare Beobachtung an ChatGPT senden.


---

## Live-Ergebnis 2026-09-26

**BESTANDEN**

Im echten Adventure-Land-Client bestätigt:

- H3-Bundle `0.3.0-h3` lädt per Hot Reload über den gemeinsamen same-origin Host.
- Character, Klasse, Level, Map, HP, MP, Gold und XP werden aus der Live-Spielwahrheit gelesen.
- Character-Position wird im Control Center mit zwei Nachkommastellen dargestellt; intern bleibt die volle Präzision erhalten.
- dynamisches Roster bleibt korrekt und benötigt keine hartcodierten Charakternamen.
- der Windows-Bridge-KnowledgeProvider ist read-only konfiguriert.
- bei noch nicht vorhandenem Bridge-Snapshot wird korrekt `WAITING_FOR_BRIDGE / BRIDGE_SNAPSHOT_NOT_AVAILABLE` gemeldet, ohne den Runtime-Core zu stoppen und ohne einen LKG-Snapshot zu erfinden.
- Target-Auflösung entspricht jetzt der echten Adventure-Land-Semantik: primäre Live-Quelle ist `parent.ctarget` entsprechend `get_targeted_monster()`; Fallbacks bleiben diagnostisch verfügbar.
- im Live-Test wurde ein `Goo` korrekt als Target aufgelöst, inklusive ID, `mtype`, Position, HP und Distanz.
- `targetResolution.resolved = true` und `resolvedFrom = parent.ctarget`.
- H1/H2-Regressionen bleiben grün.
