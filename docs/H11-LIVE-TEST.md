# H11 – Merchant-Grundbetrieb

## Ziel

H11 ergänzt den bis H10 bestätigten Farming-/Loot-Core um eine konservative Merchant-Service-Schicht.

H11 darf:

- eigene Farmer anhand des dynamischen Account-Rosters erkennen;
- bei Inventardruck sichere Items vom Farmer an den eigenen Merchant übergeben;
- kontrollierte Item-Deliveries vom Merchant an eigene Farmer ausführen;
- MLuck auf sichtbaren eigenen Farmern sicherstellen;
- für Service-Wege ausschließlich H4 Movement verwenden;
- Serviceziele mit Cooldown und Anti-Pingpong stabil halten.

H11 darf **nicht**:

- Gold übertragen;
- verkaufen;
- Bankaktionen ausführen;
- Exchange ausführen;
- Marktaktionen ausführen;
- fremde Spieler als Logistics-Ziel verwenden;
- Gear, Quest-/Goal-Reserve, gelockte, gelevelte oder Upgrade-/Compound-Items transferieren;
- nach UNKNOWN blind wiederholen.

## Architektur

- Runtime-Modul: `merchant`
- Controller: `MerchantController`
- Public API: `ALBot.merchant.*`
- GUI-Tab: **Merchant**
- Item-Write: ausschließlich `send_item` über die zentrale `ActionBoundary`
- Bewegung: ausschließlich über H4 `MovementController`
- Inventarwahrheit/Klassifizierung: H10
- Roster-/Ownership-Wahrheit: zentraler dynamischer `CharacterRosterService`
- MLuck-Bestätigung: beobachtbare Live-Condition des Zielspielers

## Fail-Safe-Regeln

### Transfers

Ein Transfer gilt erst als bestätigt, wenn am lokalen Sender ein passendes Inventardelta beobachtet wird.

Ein temporär nicht verfügbares Inventar ist **keine** Bestätigung.

Wenn der Transfer innerhalb der bounded Outcome-Deadline nicht verifiziert werden kann:

- `H11_TRANSFER_UNVERIFIED_TIMEOUT`
- H11 wird suspendiert;
- kein Blind-Retry;
- expliziter Safety-Reset erforderlich.

### MLuck

Wenn vor dem Cast noch kein MLuck aktiv war, muss anschließend ein aktiver MLuck-Effekt beobachtet werden.

Wenn bereits ein auslaufender MLuck-Effekt aktiv war, reicht `active=true` nicht aus. Die Erneuerung muss beobachtbar sein, z. B.:

- deutlich höhere Restlaufzeit;
- oder geänderte Quelle.

Ohne verifizierbare Erneuerung:

- `H11_MLUCK_UNVERIFIED_TIMEOUT`
- H11 wird suspendiert;
- kein Blind-Retry.

## Ein-Klick-Live-Test

Suite:

`h11-merchant`

Der Nutzer muss nur **Test starten** drücken.

### Voraussetzungen

Der Test muss auf dem eigenen Merchant-Charakter laufen.

Zusätzlich müssen zum Testzeitpunkt:

- mindestens ein eigener Farmer sichtbar sein;
- Merchant und Farmer live erreichbar sein;
- mindestens ein sicher transferierbares Item im Merchant-Inventar liegen;
- `send_item` verfügbar sein;
- `mluck` als Live-Skill verfügbar sein.

Der Test bevorzugt für die kontrollierte Delivery ein Utility-/Consumable-Item. Falls keines vorhanden ist, kann ein anderes nach H10/H11 sicher transferierbares Item verwendet werden.

### Reale Zustandsänderung

Die Suite sendet **genau eine Einheit** eines sicheren Items vom Merchant an einen eigenen sichtbaren Farmer.

Das Item wird nicht automatisch zurückgesendet.

Es werden keine destruktiven Economy-Aktionen ausgeführt.

## Testschritte

### 1. Preflight

Prüft:

- lokaler Charakter ist Merchant;
- Merchant stammt aus dem dynamischen eigenen Roster;
- Merchant-Modul ist ACTIVE;
- eigener sichtbarer Farmer existiert;
- `send_item` und `use_skill` sind verfügbar;
- mindestens ein sicher transferierbares Item existiert;
- MLuck ist live definiert.

### 2. Delivery

- wählt einen eigenen sichtbaren Farmer;
- queued genau 1 sichere Item-Einheit;
- H11 nähert sich bei Bedarf über H4;
- transferiert über ActionBoundary `send_item`;
- bestätigt den Transfer ausschließlich über das lokale Inventardelta;
- UNKNOWN oder unverifizierter Timeout suspendiert fail-safe.

### 3. MLuck

- prüft MLuck des eigenen Farmers;
- gesunder MLuck wird nicht gespammt;
- fehlender oder auslaufender MLuck wird erneuert;
- bei Refresh muss eine echte Zustandsänderung beobachtet werden;
- UNKNOWN oder unverifizierter Timeout suspendiert fail-safe.

### 4. Stability

Beobachtet 5 Sekunden:

- kein Transfer-UNKNOWN;
- kein MLuck-UNKNOWN;
- kein Service-Pingpong;
- keine Suspension.

### 5. Cleanup

Prüft:

- kein Pending H11-Write;
- keine offene Delivery;
- keine H11-eigene Movement-Order.

Der Live-Test stellt den vorherigen Runtime-Zustand danach automatisch wieder her.

## PASS-Kriterien

Für eine H11-Abnahme erwarten wir:

- Suite `PASSED`;
- Reason `ALL_STEPS_PASSED`;
- Delivery PASSED;
- mindestens ein bestätigter Transfer;
- lokales Inventardelta bestätigt;
- MLuck PASSED oder bereits live gesund;
- `transfersUnknown=0` im Testdelta;
- `mluckUnknown=0` im Testdelta;
- `pingPongBlocks=0` im Stability-Delta;
- Cleanup PASSED;
- keine H11-Pending-Aktion;
- keine H11-Movement-Order;
- Auto-Restore erfolgreich.

## Aktueller Pre-Live-Stand

Version:

`AL Bot 0.11.0-h11`

Branch:

`chatgpt/h11-merchant-grundbetrieb`

PR:

`#11 – H11: Merchant-Grundbetrieb`

Pre-Live CI:

- Run #227
- exact head `593bfe3a961b326b534d1b449a6c248842f780b4`
- `completed / success`
- 134 Tests
- 134 pass
- 0 fail
- 0 skipped

Review-Härtung:

- unavailable inventory darf keinen Transfer bestätigen;
- auslaufendes MLuck benötigt beobachtbare Erneuerung;
- alte Version-Assertions korrigiert;
- VM-Testobjekte korrekt verglichen;
- Service-Chaining nach Delivery im Test korrekt berücksichtigt;
- alle fünf Review-Threads resolved.

Nach Dokumentationsänderungen muss der **neue exakte Head** erneut grüne CI besitzen, bevor der Live-Test freigegeben wird.
