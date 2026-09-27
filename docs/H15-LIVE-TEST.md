# H15 – Upgrade & Compound Live-Test

Stand: 2026-09-27

H15 erweitert den live bestätigten H14-Stand um echte Upgrade-/Compound-Writes mit konservativer Risiko- und Kostenbegrenzung.

## Scope

Implementiert:

- eigener `UpgradeCompoundController`
- Upgrade und Compound ausschließlich über die zentrale ActionBoundary
- Live-Inventar als Source of Truth
- Revalidation aller Item-, Scroll- und Offering-Slots unmittelbar vor Dispatch
- protected Items (`locked`, `gift`, `giveaway`, expiring) aus Automation ausgeschlossen
- Grade-basierte Scrollwahl aus Live-`G.items[*].grades`
- Upgrade-Scrolls `scroll0/1/2`
- Compound-Scrolls `cscroll0/1/2`
- Offering-Policy: `DISABLED`, `OPTIONAL`, `REQUIRED`
- konfigurierbare Level-, Itemwert-, Consumable- und Session-Attempt-Budgets
- logischer Workspace mit reservierten Inventarslots
- höchstens ein Request/Pending gleichzeitig
- Combat-Block
- Outcome-Bestätigung nur über beobachtete Inventar-/Consumable-Deltas
- bekannte Ergebnisse: `SUCCEEDED` oder `FAILED`
- UNKNOWN -> Suspension, kein Blind-Retry
- Headless API `ALBot.upgrade.*`
- Control-Center-Tab **Upgrade & Compound**
- Ein-Klick-Suite `h15-upgrade-compound`

Nicht Teil von H15:

- automatisches Beschaffen fehlender Scrolls/Offerings
- Crafting oder Exchange
- autonomer Economy-Planner
- beliebig hohe Risiko-/Level-Automation
- automatische Wiederholung nach Fehler/UNKNOWN.

Diese Punkte bleiben H16/H17 oder einer expliziten späteren Policy vorbehalten.

## Safety-Regeln

Ein Upgrade/Compound wird nur ausgeführt, wenn:

- Runtime und H15-Modul aktiv sind;
- Character verfügbar und lebendig ist;
- Combat nicht aktiv ist;
- Quellitems noch exakt denselben Fingerprint besitzen;
- Quellitems automation-safe sind;
- Compound exakt drei identische Itemvarianten auf demselben Level verwendet;
- der erwartete Scroll noch im erwarteten Slot liegt;
- ein ggf. verlangtes Offering noch im erwarteten Slot liegt;
- Ziellevel das konfigurierte Maximum nicht überschreitet;
- geschätzter Itemwert-at-risk im Budget liegt;
- Consumable-Kosten im Budget liegen;
- das Session-Attempt-Budget noch frei ist.

Inventory-Indizes können sich nach Mutationen ändern. Deshalb wird unmittelbar vor jedem Write erneut aus dem Live-Inventar validiert.

## Ergebnis-Wahrheit

Promise-/API-Erfolg allein zählt nicht als H15-Erfolg.

### Upgrade

`SUCCEEDED` erfordert:

- Upgrade-Scroll wurde live verbraucht;
- ggf. Offering wurde live verbraucht;
- dieselbe Itemidentität wird auf `level + 1` live beobachtet.

`FAILED` ist ein bekanntes Ergebnis, wenn:

- Consumables live verbraucht wurden;
- nach kurzer Settle-Grace kein `level + 1`-Delta beobachtet wird.

### Compound

`SUCCEEDED` erfordert:

- Compound-Scroll wurde live verbraucht;
- ggf. Offering wurde live verbraucht;
- dieselbe Itemidentität wird auf `level + 1` live beobachtet.

Ein serverseitig verarbeitetes, aber nicht erfolgreiches Compound wird als `FAILED` klassifiziert.

### UNKNOWN

Wenn kein belastbares Live-Outcome innerhalb des bounded Timeouts beobachtet wird:

- entsprechende UNKNOWN-Metrik steigt;
- H15 suspendiert;
- Request/Pending wird verworfen;
- kein automatischer Retry.

## Ein-Klick-Live-Test

Suite:

`h15-upgrade-compound`

Die Suite startet eine zuvor gestoppte Runtime automatisch und stellt den vorherigen Runtime-Zustand am Ende wieder her.

### Wichtig: reale Mutation

Der H15-Live-Test ist anders als der reversible H14-Gear-Test **nicht vollständig rückgängig zu machen**.

Er führt genau **eine** echte, niedrig riskante Upgrade- oder Compound-Aktion aus. Dabei kann ein Scroll verbraucht werden und die gewählte Testaktion kann spielmechanisch fehlschlagen.

Die Suite begrenzt deshalb temporär:

- Session-Versuche auf `1`;
- Upgrade-Ziellevel auf höchstens `+3`;
- Compound-Ziellevel auf höchstens `+1`;
- geschätzten Itemwert-at-risk auf `25,000` Gold;
- Consumable-Kosten auf `10,000` Gold;
- Offering auf `DISABLED`.

Falls kein Kandidat innerhalb dieser Grenzen existiert:

`H15_NEEDS_LOW_RISK_UPGRADE_OR_COMPOUND_CANDIDATE`

Dann wird nichts verändert.

## Testschritte

### 1. Preflight

Prüft:

- Character verfügbar und lebendig;
- H15-Modul ACTIVE;
- mindestens ein niedrig riskanter Kandidat;
- passende Adventure-Land-API `upgrade` oder `compound` verfügbar;
- Item-/Scroll-/Offering-Slots;
- Itemwert-at-risk und Consumable-Kosten.

### 2. Planning

Prüft:

- H15-Plan READY;
- Session-Attempt-Budget exakt `1`;
- Live-Test-Budgets aktiv;
- Offering für den Test deaktiviert;
- Workspace/Slotreservierung beobachtbar.

### 3. Real Action

Führt exakt eine echte Aktion aus.

PASS akzeptiert beide bekannten Spielausgänge:

- `UPGRADE_SUCCEEDED` / `COMPOUND_SUCCEEDED`
- `UPGRADE_FAILED` / `COMPOUND_FAILED`

Entscheidend ist, dass das Ergebnis über Live-Deltas eindeutig klassifiziert wurde.

UNKNOWN ist immer FAIL.

### 4. Stability

Fünf Sekunden:

- keine H15-Suspension;
- Upgrade-UNKNOWN-Delta = 0;
- Compound-UNKNOWN-Delta = 0;
- exakt ein Session-Versuch;
- kein Pending;
- kein Request.

### 5. Cleanup

PASS:

- kein Pending;
- kein Request;
- temporäre Live-Test-Policy wird im Suite-Cleanup wieder auf den vorherigen Wert zurückgesetzt;
- vorheriger Runtime-Zustand wird wiederhergestellt.

## Erwartete PASS-Evidence

- Suite `h15-upgrade-compound`
- Runtime `0.15.0-h15`
- `PASSED / ALL_STEPS_PASSED`
- Preflight PASSED
- Planning PASSED
- Real Action PASSED
- Stability PASSED
- Cleanup PASSED
- genau ein echter H15-Dispatch
- Outcome eindeutig `*_SUCCEEDED` oder `*_FAILED`
- Upgrade UNKNOWN delta = 0
- Compound UNKNOWN delta = 0
- keine Suspension
- kein Pending/Request
- bei ursprünglich gestoppter Runtime: Runtime wieder STOPPED und Scheduler `totalResources=0`.

H15 darf erst nach grünem Exact-Head-CI, sauberem Review-Gate und echtem Adventure-Land-Live-PASS gemergt werden.
