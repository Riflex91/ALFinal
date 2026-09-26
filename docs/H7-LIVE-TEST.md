# H7 – Ein-Klick-Live-Test: Party

## Ziel

H7 erweitert den live bestätigten Single-Character-Combat um **Party-Koordination**:

- dynamische Party-Erkennung;
- Rollen;
- Assist / Focus Fire;
- Party-Health-Sicht;
- Priest-Healing;
- Party Heal;
- Revive-/Recovery-Basis;
- Party-Buff-/Aura-Sicht;
- fail-closed Verhalten bei fremden Party-Mitgliedern;
- sauberes Cleanup.

Der Live-Test bleibt ein Ein-Klick-Ablauf.

Der User drückt nur:

**Test starten**

## Erwartete Version

`0.7.0-h7`

## Voraussetzung

Für einen echten H7-Live-Test müssen mindestens **zwei eigene, lebende Charaktere bereits in derselben Adventure-Land-Party** sein.

H7 startet oder stoppt in diesem Schritt bewusst keine anderen Charaktere und verändert die Party-Mitgliedschaft nicht automatisch. Character-Lifecycle folgt später in H19.

**Merchant / LOGISTICS:** Ein Merchant gehört zur Party-Koordination, wird im H7-Live-Test aber bewusst nur beobachtend getestet. Adventure Land lehnt Merchant-Angriffe serverseitig ab; H7 startet deshalb auf einem LOGISTICS-Charakter keinen Combat-Loop und sendet keinen Angriff. Rollen, Party-Sicht, Focus-Stabilität und Cleanup werden trotzdem geprüft.

Sind weniger als zwei eigene Party-Mitglieder vorhanden, endet der Ein-Klick-Test sofort und verständlich mit:

`H7_NEEDS_ACTIVE_PARTY_OF_AT_LEAST_2`

Es sind keine manuellen Targets oder Combat-Aktionen erforderlich.

## Party-Wahrheit

H7 liest:
- `get_party()`;
- `party_list`, sofern live verfügbar;
- sichtbare Player-Entities;
- zentrale dynamische Account-/Roster-Erkennung.

Keine Party-Namen oder Charakter-Namen werden hartcodiert.

Automatische Koordination ist nur aktiv, wenn:
- mindestens zwei eigene Party-Mitglieder erkannt wurden;
- kein fremdes Party-Mitglied enthalten ist.

Bei einem fremden Mitglied wird automatische H7-Koordination fail-closed blockiert.

## Rollen

Deterministische Grundrollen:

- Warrior → TANK
- Priest → HEALER
- Paladin → TANK, falls kein Warrior vorhanden ist; sonst SUPPORT
- Ranger / Mage / Rogue → DPS
- Merchant → LOGISTICS

Die Rollen sind H7-Combat-Rollen und ersetzen keine späteren strategischen Rollen.

## Focus Fire / Assist

H7 leitet einen stabilen Focus Target ab.

Priorität:
1. sichtbares Target des eigenen Tanks;
2. sichtbares Target des Party-Leaders;
3. Mehrheits-Target der sichtbaren eigenen Party-Mitglieder.

Nur ein aktuell sichtbares lebendes Monster darf Focus Target werden.

Ein Focus-Wechsel erhält eine kurze Stabilitätszeit, um Target-Pingpong zu verhindern.

H5 Combat prüft den Party-Focus vor der normalen lokalen Target-Auswahl und darf auf einen stabilen sicheren Party-Focus retargeten.

Die bisherigen H5-Safety-Regeln bleiben bestehen:
- Monster-Gefahr;
- aktuelle Live-Entity;
- Range;
- Cooldown;
- kein Blind-Retry nach UNKNOWN.

## Healing / Recovery

Für einen lokalen Priest:

- einzelnes deutlich verletztes sichtbares eigenes Party-Mitglied → direkter Heal;
- mindestens zwei ausreichend verletzte Mitglieder → Party Heal, sofern live verfügbar;
- sichtbares gefallenes eigenes Party-Mitglied → Revive, sofern live verfügbar.

Jede Support-Aktion:
- läuft über die zentrale Action-Grenze;
- prüft Live-Skill-Readiness;
- hat höchstens einen Pending-Command;
- bekannte Ablehnung führt zu Backoff;
- unklarer Ausgang führt zu `UNKNOWN` und suspendiert weitere automatische Party-Support-Aktionen;
- kein Blind-Retry.

Ein nicht-Priest beobachtet Party-Health und Recovery-Bedarf, führt aber keine erfundenen Heal-Aktionen aus.

## Buffs / Auras

H7 erkennt partyrelevante Live-Skills der lokalen Klasse. Bereits in H6 sicher implementierte Klassen-Buffs wie Warcry / Dark Blessing bleiben unter der H6-Skill-Logik; H7 stellt dafür den Party-Kontext und die Diagnose bereit.

Es werden keine unbekannten oder nicht live verifizierten Aura-Semantiken geraten.

## Automatische Testfolge

### 1. Preflight
- Party-Modul ACTIVE;
- mindestens zwei eigene lebende Party-Mitglieder;
- keine fremden Party-Mitglieder;
- Rollen erkannt;
- aktueller Character lebendig;
- sicherer sichtbarer Gegner vorhanden.

### 2. Focus Fire
- auf Combat-Rollen: Combat-Session automatisch starten;
- Party-Focus ableiten;
- Combat-Target und Party-Focus müssen konvergieren;
- auf LOGISTICS/Merchant: Observer-only, kein Combat-Start und kein Angriff.

### 3. Party Health
- Party-Health-/Downed-Sicht prüfen;
- Healing-/Revive-Basis diagnostizieren;
- kein Support-UNKNOWN.

### 4. Stabilitätsfenster
Fünf Sekunden:
- kein Party-Support-UNKNOWN;
- kein H5-Attack-UNKNOWN;
- Party-Koordination bleibt aktiv;
- kein echtes Focus-Pingpong.

**Wichtig:** normale Fortschritte durch mehrere besiegte Monster dürfen den Test nicht fehlschlagen lassen. Als Pingpong zählt eine Rückkehr **A → B → A** innerhalb des konfigurierten Focus-Pingpong-Fensters; reine Sequenzen wie **A → B → C → D** sind legitime Target-Fortschritte.

### 5. Cleanup
- Combat stoppen;
- Combat-Movement freigeben;
- kein Pending-Party-Support;
- automatisch gestartete Runtime danach wieder in vorherigen STOPPED-Zustand versetzen.

## Erwartetes Ende

`TEST BEENDET – BESTANDEN`

Danach wird der vollständige Diagnosebericht automatisch in die Zwischenablage kopiert.

Falls Clipboard-Schreiben vom Browser blockiert wird, bleibt **Fehlerbericht kopieren** als Fallback.

## Bedienung

Wenn mindestens zwei eigene Charaktere bereits in derselben Party sind:

**nur einmal „Test starten“ drücken.**

## Finale Live-Evidence – 2026-09-26

H7 ist über vier echte Charakter-Rollen live validiert:

- Rogue → DPS: Suite vollständig PASSED, Focus Fire/Stability/Cleanup bestanden, `focusPingPongs = 0`.
- Warrior → TANK: mehrere normale Focus-Wechsel über aufeinanderfolgende Goo-Kills, `focusPingPongs = 0`; damit sind legitime Target-Fortschritte von echtem A → B → A-Pingpong abgegrenzt.
- Priest → HEALER: Party-Support-/Buff-Sicht live bestätigt; Stability und Cleanup bestanden.
- Merchant → LOGISTICS: finaler Retest nach Observer-only-Korrektur vollständig PASSED.

Merchant-Retest:
- `PASSED / ALL_STEPS_PASSED`;
- `localRole = LOGISTICS`;
- `observerOnly = true`;
- Party-Größe 4, alle Mitglieder als eigene Roster-Mitglieder erkannt;
- kein Combat-Start: `combatState = NOT_STARTED`;
- keine Merchant-Attacks;
- `attackUnknown = 0`;
- `focusPingPongs = 0`;
- Stability PASSED;
- Cleanup PASSED;
- Runtime danach wieder STOPPED;
- Scheduler danach `totalResources = 0`.

Zusätzlich wurde nach Review ein Safety-Regressionsfall ergänzt: Ein synchrones `UNKNOWN` aus der zentralen ActionBoundary suspendiert Party-Support nun sofort und verhindert Blind-Retry.

