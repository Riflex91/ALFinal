# H19 – Character Lifecycle & Recovery Live-Test

Stand: 2026-09-27

## Ziel

H19 ergänzt den Bot um kontrollierte Character-Lifecycle- und Recovery-Pfade:

- Character Start/Stop;
- Death → Respawn;
- Disconnect-/Restart-Recovery über ein gespeichertes Desired-Active-Set;
- Party-Recovery mit gespeichertem eigenen Party-Leader;
- Reconciliation laufender Lifecycle-Aktionen über Runtime-/Bundle-Restarts.

Runtime/Bundle:

`0.19.0-h19`

Package:

`0.19.0`

## Safety-Modell

- keine hartcodierten Charakternamen;
- Account-Ownership wird ausschließlich aus live verfügbarem `get_characters`-Roster abgeleitet;
- aktiver Character-Status wird ausschließlich aus live verfügbarem `get_active_characters` plus lokalem Character abgeleitet;
- Start/Stop/Respawn/Party-Writes laufen ausschließlich über ActionBoundary;
- GLOBAL STOP / Runtime Action Gate bleibt autoritativ;
- Remote Start/Stop nur für account-eigene, nichtlokale Characters;
- Start wird blockiert, wenn das Ziel bereits aktiv ist;
- Stop wird blockiert, wenn das Ziel bereits gestoppt ist;
- Respawn ist ausschließlich lokal und nur bei `rip=true` zulässig;
- eine irreversible Aktion wird **vor Dispatch** persistent als pending gespeichert;
- nach Bundle-/Runtime-Restart wird ein pending Auftrag nur reconciled und niemals blind erneut dispatcht;
- Bestätigung braucht Live-Evidence plus abgeschlossene Settlement;
- Sync-UNKNOWN, Promise-Rejection ohne Live-Outcome oder unbestätigter Timeout suspendiert H19;
- bekannte automatische Rejects stoppen die Autonomie, statt sofort neu zu versuchen;
- bounded Session-Budget;
- Autonomie standardmäßig AUS.

## Disconnect / Restart Recovery

`captureDesiredActive()` speichert nur aktuell live beobachtete, eigene Characters als Desired-Set.

Wenn Recovery explizit gestartet wurde:

- fehlende Desired-Characters dürfen bounded über `start_character(name)` gestartet werden;
- Bestätigung erfolgt erst, wenn das Ziel im aktiven Live-Roster erscheint und die Dispatch-Settlement beendet ist;
- ein alter pending Start/Stop wird nach Reload anhand des Live-Rosters reconciled;
- keine erneute Mutation ohne neue explizite Recovery-Session.

## Party Recovery

Beim Erfassen des Desired-Sets wird ein aktuell live beobachteter **eigener** Party-Leader mitgespeichert.

Automatische Party-Recovery ist nur zulässig, wenn dieser Leader eindeutig vorhanden ist:

- lokaler Desired-Leader lädt fehlende aktive Desired-Mitglieder mit `send_party_invite` ein;
- Non-Leader fordert den gespeicherten Desired-Leader mit `send_party_request` an;
- `on_party_invite` / `on_party_request` dienen nur als Beobachtungshooks;
- die Hooks dispatchen **nicht direkt**, sondern legen nur ein H19-Signal vor;
- Accept läuft später im normalen H19-Tick über ActionBoundary;
- Invite/Request/Accept gilt erst als bestätigt, wenn der Live-Party-Snapshot beide Characters in derselben Party zeigt;
- Signale ohne gespeicherten passenden Leader werden ignoriert;
- nicht eigene Charaktere werden ignoriert;
- fremde Party-Mitglieder oder abweichende aktive Party-Leader blockieren Recovery fail-closed;
- kein automatisches `leave_party`, kein erzwungenes Umorganisieren fremder/abweichender Party-Topologien.

Verifizierte CODE-APIs:

- `send_party_invite(name)`
- `send_party_request(name)`
- `accept_party_invite(name)`
- `accept_party_request(name)`

## Öffentliche Oberfläche

Runtime-Modul:

`character-lifecycle`

API:

- `ALBot.lifecycle.status()`
- `ALBot.lifecycle.plan()`
- `ALBot.lifecycle.tick()`
- `ALBot.lifecycle.policy(...)`
- `ALBot.lifecycle.captureActive()`
- `ALBot.lifecycle.startCharacter(name)`
- `ALBot.lifecycle.stopCharacter(name)`
- `ALBot.lifecycle.respawn()`
- `ALBot.lifecycle.cancel(...)`
- `ALBot.lifecycle.start(...)`
- `ALBot.lifecycle.stop(...)`
- `ALBot.lifecycle.reset(...)`

Control Center:

- eigener Lifecycle-Tab;
- Desired Active / Desired Party Leader;
- Start/Stop/Respawn;
- bounded Recovery Start/Stop;
- Party Invite/Request/Accept-Metriken;
- Signal-/Konfliktstatus;
- Reconciliation-/UNKNOWN-/Suspension-Status.

## Automatische Regressionen

H19 deckt insbesondere ab:

- Ownership und Local-vs-Remote-Gates;
- Start-Evidence erst nach Settlement + aktivem Live-Roster;
- Stop-Evidence erst nach Settlement + Abwesenheit im aktiven Live-Roster;
- Respawn-Evidence erst nach Settlement + `rip=false`;
- Promise-Rejection ohne Blind-Retry;
- synchrones UNKNOWN mit erhaltener Ownership;
- pending Start über Modul-/Bundle-Restart ohne Redispatch;
- Desired-Active Disconnect-Recovery;
- Session-Budget;
- Party-Leader-Capture;
- Leader Invite;
- Non-Leader Party Request;
- Accept eines beobachteten Invite nur vom gespeicherten eigenen Desired-Leader;
- keine Party-Recovery ohne eindeutigen Leader;
- Foreign-Party-Block;
- automatischer bekannter Reject stoppt Autonomie;
- Runtime/API/UI/ActionBoundary/Build/Bundle-Wiring.

## Technischer Pre-Live-Stand

PR #28: `H19: Add bounded character lifecycle recovery`

Technischer Code-Head vor finaler Doku-/Bundle-Finalisierung:

`9d35c98966a627595ab872e1322b5b8f1e8bdd54`

Exact-Head-CI #522:

- **272 tests**
- **272 pass**
- 0 fail
- 0 cancelled
- 0 skipped
- 0 todo
- completed / success

Die zuvor beim ersten H19-CI #505 sichtbaren neun Fehler waren ausschließlich stale H8–H17-Wiring-Erwartungen auf `0.18.0-h18`; keine H19-Funktionsregression. Diese Erwartungen wurden auf den aktuellen Runtime-/Bundle-Stand fortgeschrieben.

## Erster echter Live-Gate

Suite:

`h19-character-lifecycle` Version 1

Der erste Live-Gate ist absichtlich klein und destruktiv nur in einem kontrollierten Sinn: Er verlangt einen **bereits toten lokalen Character** und führt genau einen echten Respawn aus.

Schritte:

1. **preflight**
   - lokaler Character vorhanden;
   - `rip=true`;
   - H19-Modul ACTIVE;
   - Account- und Active-Roster live verfügbar;
   - `respawn` API verfügbar;
   - keine H19-Suspension;
   - keine aktive H19-Aktion.

2. **death-recovery**
   - genau einen Respawn vormerken;
   - bounded Autonomie mit max. 1 Aktion;
   - genau 1 Dispatch;
   - genau 1 Confirm;
   - 0 UNKNOWN;
   - PASS erst bei `rip=false`.

3. **stability**
   - fünf Sekunden;
   - Autonomie AUS;
   - keine aktive Aktion;
   - kein Retry;
   - kein neues UNKNOWN.

4. **cleanup**
   - Autonomie AUS;
   - `currentAction=null`;
   - Queue leer;
   - keine Suspension.

## Noch offene H19-Live-Evidence

Der v1-Live-Test bestätigt zunächst Death/Respawn und die grundlegende Restart-safe Ownership.

Remote Start/Stop sowie Party-Recovery sind implementiert und automatisiert regressionsgetestet, werden aber **nicht blind im ersten Live-Gate mutiert**. Diese Pfade erhalten erst dann echte Live-Evidence, wenn ein gezielter bounded Test ohne unbeabsichtigte Runner-/Party-Nebenwirkungen vorbereitet ist.

H19 ist bis zur erforderlichen echten Live-Evidence **nicht abgeschlossen**.


## Safety-Hardening nach dem ersten Pre-Live-Gate

Stand: 2026-09-27

Nach dem ersten technischen H19-Gate wurden zwei zusätzliche Safety-Kanten geschlossen, ohne die grundlegende Lifecycle-Architektur zu lockern.

### Desired Active und Desired Party sind getrennt

H19 speichert Party-Intent jetzt separat:

- `desiredActiveNames` = eigene Characters, die aktiv bleiben bzw. nach Disconnect/Restart wieder gestartet werden dürfen;
- `desiredPartyMemberNames` = eigene Characters, die beim Capture tatsächlich Mitglied der beobachteten Party waren;
- `desiredPartyLeader` = eigener Leader dieser erfassten Party.

Damit gilt ausdrücklich:

- ein eigener Character wird **nicht** allein deshalb in die Party gezogen, weil er aktiv ist;
- Party Invite/Request/Accept darf nur die separat erfasste Desired-Party-Topologie rekonstruieren;
- der Desired-Leader muss selbst im Desired-Party-Set liegen;
- fremde oder abweichende Party-Topologien bleiben fail-closed blockiert.

Das Control Center zeigt Desired Active, Desired Party Members und Desired Party Leader separat an.

### UNKNOWN bleibt einmalige Ownership

Für synchrones `UNKNOWN` mit bereits möglichem Dispatch gilt jetzt zusätzlich:

- der zugehörige Queue-Eintrag wird entfernt, sobald H19 die in-flight Ownership hält;
- die persistierte `currentAction` bleibt autoritativ;
- ein späteres Safety-Reset kann dadurch denselben Queue-Auftrag nicht blind erneut senden;
- derselbe unklare Auftrag erhöht `actionsUnknown` höchstens einmal, auch wenn Timeout-/Scheduler-Beobachtung später erneut denselben Zustand sieht;
- spätere eindeutige Live-Evidence darf den erhaltenen Pending-Auftrag weiterhin reconciliieren; die Suspension bleibt bis zum expliziten Safety-Reset bestehen.

### Regressionen

Zusätzlich abgedeckt:

- aktive eigene Characters außerhalb der erfassten Party werden nicht automatisch eingeladen;
- Leader-Recovery verwendet nur zuvor erfasste Desired-Party-Mitglieder;
- synchrones UNKNOWN entfernt den doppelten Queue-Pfad;
- wiederholte Beobachtung desselben UNKNOWN erhöht den UNKNOWN-Zähler nicht erneut.

Technischer grüner Zwischenstand vor der finalen UI-/Doku-/Workflow-Bereinigung:

- Head `de1d3bdecbd7de1013c1dda2546d81e3c794edf0`;
- Exact-Head-CI #527: **273 tests / 273 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**;
- `dist/al-bot.js` enthielt auf diesem Head bereits `desiredPartyMemberNames` und die idempotente `unknownRecorded`-Safety.

Der endgültige Merge-Gate wird erst nach Wiederherstellung des read-only Test-Workflows auf dem dann aktuellen Head gewertet.


## Live-Versuch 1 – Respawn-Cooldown erkannt

Stand: 2026-09-27

Der erste echte H19-Live-Lauf auf `My_Warrior` lief mit Runtime `0.19.0-h19` und bestätigte den Preflight korrekt, scheiterte aber im Schritt `death-recovery`.

Beobachtete Evidence:

- lokaler Character: Warrior, `rip=true`;
- Preflight: PASS;
- genau 1 Respawn-Dispatch;
- Adventure Land antwortete mit `cant_respawn`;
- 0 Respawn-Confirmations;
- Character blieb `rip=true`;
- der damalige H19-Stand klassifizierte die abgelehnte Promise fälschlich als `H19_DISPATCH_REJECTED_WITHOUT_LIVE_OUTCOME` und erhöhte damit `actionsUnknown` auf 1;
- Stability/Cleanup-Schritte wurden nach dem Fail nicht mehr ausgeführt; der LiveTestRunner stellte die Runtime anschließend automatisch zurück.

Root Cause:

Adventure Land besitzt einen serverseitigen **12-Sekunden-Respawn-Cooldown**. Der erste H19-Live-Test dispatchte deutlich früher und erhielt deshalb den bekannten temporären Server-Reject `cant_respawn`.

Hotfix-Verhalten:

- H19 wartet vor dem ersten `respawn()` mindestens 13 Sekunden ab der ersten lokal beobachteten `rip=true`-Evidence;
- während dieser Grace wird **kein** Game-Write erzeugt;
- der Queue-/Auto-Recovery-Auftrag bleibt bounded erhalten und wird erst nach Readiness dispatcht;
- `cant_respawn` wird zusätzlich fail-closed als **bekannter Reject** behandelt;
- dieser Reject erhöht `actionsRejected` / `respawnCooldownRejects`, aber **nicht** `actionsUnknown`;
- nach `cant_respawn` stoppt die Autonomie und H19 führt keinen Blind-Retry aus;
- der Live-Test meldet einen erneuten `cant_respawn` direkt als `H19_RESPAWN_COOLDOWN_REJECTED` statt in einen Timeout/UNKNOWN zu laufen.

Dieser Lauf ist **keine H19-PASS-Evidence**. Nach Merge des Hotfixes ist ein neuer echter Death→Respawn-Live-Test erforderlich.


## Live-Versuch 2 – restaurierte UNKNOWN-Aktion blockiert Preflight

Stand: 2026-09-27

Der zweite echte H19-Live-Versuch verwendete bereits den Respawn-Cooldown-Hotfix, erreichte den eigentlichen Respawn-Test aber nicht. Der Live-Test brach noch im Prepare-Schritt mit `H19_ACTIVE_ACTION_BEFORE_LIVE_TEST` ab.

Beobachtete Evidence:

- Runtime: `0.19.0-h19`;
- kein neuer Game-Write: 0 dispatched / 0 confirmed / 0 rejected / 0 unknown;
- aus persistentem H19-Storage wurde die UNKNOWN-Respawn-Aktion des ersten Live-Versuchs restauriert;
- restaurierte Aktion: `RESPAWN`, `restored=true`, `unknownRecorded=true`, lokale Figur weiterhin `rip=true`;
- H19 suspendierte beim Reconcile mit `H19_RESPAWN_UNVERIFIED_TIMEOUT`;
- alle eigentlichen Suite-Schritte wurden sicherheitshalber übersprungen;
- Cleanup/Runtime-Restore war erfolgreich.

Root Cause:

Der erste Live-Versuch hatte die damals als UNKNOWN behandelte Respawn-Aktion absichtlich persistent gehalten. Nach dem Hotfix wurde dieser Ownership-Eintrag korrekt restauriert und blockierte den zweiten Live-Test. Das ist sicherheitsgerecht, verhindert aber einen ausdrücklich vom Operator gestarteten neuen H19-Retry.

Hotfix-Verhalten:

- ein neuer H19-Live-Test darf ausschließlich eine **restaurierte, bereits UNKNOWN-markierte RESPawn-Aktion derselben lokalen weiterhin toten Figur** explizit acknowledge'n;
- der neue Test-Start gilt dabei als Operator-Acknowledge für genau diesen alten Live-Test-Retry;
- alle anderen aktiven/in-flight Lifecycle-Aktionen blockieren weiterhin mit `H19_ACTIVE_ACTION_BEFORE_LIVE_TEST`;
- nach dem Acknowledge wird Safety explizit zurückgesetzt; erst anschließend darf die neue Suite ihren eigenen bounded Respawn-Auftrag anlegen;
- es gibt weiterhin keinen automatischen Blind-Retry außerhalb des explizit gestarteten H19-Live-Tests.

Auch dieser Lauf ist **keine H19-PASS-Evidence**. Nach Merge dieses Fixes ist ein weiterer echter Death→Respawn-Live-Test erforderlich.


## Live-Versuch 3 – Death→Respawn PASS

Stand: 2026-09-27

Der dritte echte H19-Live-Lauf auf `My_Warrior` mit Runtime `0.19.0-h19` hat den bounded Death→Respawn-Gate vollständig bestanden.

Gesamtergebnis:

- Suite: `h19-character-lifecycle` v1;
- Status: **PASSED**;
- Reason: `ALL_STEPS_PASSED`;
- Start: `2026-09-27T16:48:00.469Z`;
- Ende: `2026-09-27T16:48:18.352Z`;
- Runtime wurde für den Test automatisch gestartet und danach sauber wiederhergestellt;
- Cleanup: `attempted=true`, `ok=true`, kein Cleanup-Fehler.

Schritt-Evidence:

1. **preflight – PASSED**
   - lokaler Character: `My_Warrior` / Warrior;
   - `rip=true`;
   - Respawn-Readiness meldete zunächst noch `11898 ms` Rest-Wartezeit bis zum bounded Grace-Gate.

2. **death-recovery – PASSED**
   - der Respawn-Cooldown wurde abgewartet;
   - exakt `1` Respawn dispatcht;
   - exakt `1` Respawn bestätigt;
   - `respawnsConfirmed=1`;
   - `unknown=0`.

3. **stability – PASSED**
   - fünf Sekunden ohne zusätzlichen Respawn-Retry;
   - insgesamt weiterhin exakt `1` Dispatch / `1` Confirm;
   - `actionsUnknown=0`.

4. **cleanup – PASSED**
   - `autonomyEnabled=false`;
   - `currentAction=null`;
   - Queue leer;
   - `suspended=false`.

Finaler Lifecycle-Stand nach Restore:

- `actionsDispatched=1`;
- `actionsConfirmed=1`;
- `actionsRejected=0`;
- `actionsUnknown=0`;
- `respawnsConfirmed=1`;
- `respawnCooldownBlocks=15`;
- `respawnCooldownRejects=0`;
- lokaler Character wieder lebend: `rip=false`;
- keine aktive Lifecycle-Aktion und keine Suspension.

Damit ist **H19 Death Recovery live bestätigt**. Dieser PASS ersetzt nicht die noch offene Live-Evidence für Remote Character Start/Stop, Disconnect/Restart-Recovery und Party-Recovery. H19 bleibt bis zu diesen gezielten bounded Gates offen.


## H19 v2 – Remote Start/Stop & Restart Recovery

Stand: 2026-09-27

Nach erfolgreicher Death→Respawn-Evidence ist der nächste bounded H19-Live-Gate die Suite `h19-remote-recovery` v1.

Ziel:

- einen account-eigenen, nichtlokalen, aktuell aktiven Character kontrolliert stoppen;
- die Abwesenheit aus dem Live-Active-Roster eindeutig bestätigen;
- den zuvor erfassten Desired-Active-Zustand verwenden;
- genau einen automatischen `start_character`-Recovery-Versuch zulassen;
- die erneute Live-Roster-Präsenz bestätigen;
- anschließend fünf Sekunden ohne Retry, Reject oder UNKNOWN beobachten;
- die vorherige H19-Policy wiederherstellen.

### Safe Target Selection

Preflight wählt ausschließlich einen Character, der:

- account-eigen ist;
- nicht der lokale Character ist;
- aktuell in `activeCharacterNames` steht;
- **nicht** der aktuell beobachtete Party-Leader ist.

Wenn mehrere Kandidaten existieren, werden Characters außerhalb der aktuellen Party bevorzugt. Namen sind vollständig dynamisch; es gibt keine hardcodierten Character-Namen.

Fehlt ein sicherer aktiver Remote-Kandidat, schlägt Preflight fail-closed mit `H19_REMOTE_SAFE_ACTIVE_TARGET_UNAVAILABLE` fehl und es erfolgt keine Mutation.

### Schritte

1. **preflight**
   - lokaler Character lebt;
   - H19-Modul ACTIVE;
   - Account- und Active-Roster live verfügbar;
   - `stop_character` und `start_character` verfügbar;
   - keine Suspension, keine aktive H19-Aktion, Queue leer;
   - Desired Active wird **vor** dem Stop aus dem aktuellen Live-Zustand erfasst.

2. **remote-stop**
   - genau einen `STOP` für den ausgewählten Remote-Character queueen;
   - Bestätigung erst nach Settlement + echter Abwesenheit aus dem Live-Active-Roster;
   - erwartet: 1 Dispatch / 1 Confirm / 1 Stop-Confirm / 0 Reject / 0 UNKNOWN.

3. **restart-recovery**
   - H19-Autonomie mit `maxActions=1` starten;
   - Desired Active erkennt den fehlenden eigenen Character;
   - genau einen `START` dispatchen;
   - Bestätigung erst nach Settlement + erneuter Live-Roster-Präsenz;
   - erwartet kumuliert: 2 Dispatches / 2 Confirms / 1 Stop-Confirm / 1 Start-Confirm / 0 Reject / 0 UNKNOWN.

4. **stability**
   - Autonomie AUS;
   - fünf Sekunden keine weitere Lifecycle-Mutation;
   - Ziel bleibt aktiv;
   - keine Rejects/UNKNOWNs.

5. **cleanup**
   - ursprüngliche H19-Policy wiederherstellen;
   - Ziel muss aktiv sein;
   - Autonomie AUS, keine aktive Aktion, Queue leer, keine Suspension.

### Cleanup-Safety

Wenn ein Fehler **nach bestätigtem Stop, aber bevor überhaupt ein Start dispatcht wurde** auftritt, darf Cleanup genau einen ersten Restore-Start versuchen. Dieser Pfad ist nur erlaubt, wenn gleichzeitig:

- Ziel live eindeutig als inaktiv beobachtet wird;
- keine aktive H19-Aktion existiert;
- H19 nicht suspendiert ist;
- seit Baseline exakt 1 Lifecycle-Dispatch stattgefunden hat – der bestätigte Stop;
- 0 Rejects und 0 UNKNOWNs hinzugekommen sind.

Sobald ein Start bereits dispatcht wurde, ein Reject vorliegt, eine Aktion UNKNOWN ist oder H19 suspendiert wurde, führt Cleanup **keinen Blind-Retry** aus.

Die bestehende Death→Respawn-Suite bleibt verfügbar, ist nach erfolgreicher Evidence aber nicht mehr der empfohlene H19-Test. `h19-remote-recovery` wird zum nächsten Recommended Live-Test.


### H19 v2 Review-Hardening – Rerun- und Cancel-Cleanup

Stand: 2026-09-27

Vor dem finalen v2-Gate wurden zwei zusätzliche Cleanup-Safety-Punkte geschlossen:

- `targetName`, `baseline` und `originalPolicy` werden zu Beginn jedes neuen Suite-Prepare vollständig zurückgesetzt. Ein früh scheiternder Folgelauf kann dadurch niemals Policy-State eines vorherigen Runs restaurieren.
- Der Cleanup-Restore verwendet keinen normalen LiveTestRunner-`waitFor` mehr. Dieser respektiert absichtlich den Cancel-Latch und wäre deshalb nach einem Nutzer-Cancel ungeeignet.
- Stattdessen besitzt v2 einen eigenen cancel-unabhängigen, zeitlich begrenzten Cleanup-Poller ausschließlich für den einmaligen sicheren Restore eines **bereits bestätigt gestoppten** Remote-Characters, wenn noch kein Start dispatcht wurde.
- Ein Cleanup-Start wird weiterhin blockiert, sobald ein Start bereits dispatcht wurde, ein Reject/UNKNOWN vorliegt, H19 suspendiert ist oder der Roster-Zustand nicht eindeutig ist.
- Restore-Fehler werden nicht mehr verschluckt. Ein nicht erfolgreich wiederhergestellter Remote-Character macht den Cleanup sichtbar fehlerhaft.

Exact-Head-CI #560 bestätigte den gehärteten Source-/Test-Stand vollständig grün.


## Live-Versuch 4 – Remote-Recovery Preflight: Account-Online vs. Runner-Active

Stand: 2026-09-27

Der erste echte Lauf von `h19-remote-recovery` wurde parallel auf zwei eigenen laufenden Characters diagnostiziert. Beide Läufe scheiterten **vor jeder Mutation** im Preflight mit `H19_REMOTE_SAFE_ACTIVE_TARGET_UNAVAILABLE`.

Live-Evidence:

- Runtime: `0.19.0-h19`;
- Suite: `h19-remote-recovery` v1;
- auf dem Merchant meldete der accountweite Character-Roster `My_Merchant`, `My_Priest`, `My_Ranger1` und `My_Warrior` als `online=true`, während `activeCharacterNames` nur `My_Merchant` enthielt;
- auf dem Warrior meldete derselbe accountweite Roster dieselben vier Characters als `online=true`, während `activeCharacterNames` nur `My_Warrior` enthielt;
- `remote-stop`, `restart-recovery`, `stability` und der explizite Suite-`cleanup` wurden nach dem Preflight-Fail nicht mutierend ausgeführt bzw. übersprungen;
- Lifecycle-Metriken blieben bei 0 Dispatches / 0 Confirms / 0 Rejects / 0 UNKNOWNs;
- Runner-Cleanup war erfolgreich.

Schlussfolgerung aus Live Truth:

`get_active_characters()` darf in dieser Laufzeit nicht als accountweite Online-Wahrheit für Remote Character Start/Stop interpretiert werden. Für H19 werden deshalb zwei getrennte Roster-Sichten geführt:

- `onlineCharacterNames`: accountweite Online-Evidence aus `get_characters().online` plus Local Character;
- `activeCharacterNames` / `runnerActiveCharacterNames`: bisherige lokale Runner-/Worker-Sicht aus `get_active_characters()` plus Local Character.

Remote Lifecycle, Desired Active sowie der Remote-Recovery-Live-Gate verwenden ausschließlich die accountweite Online-Evidence. Die bestehende Runner-Active-Sicht bleibt separat erhalten und wird nicht semantisch umdefiniert.

Dieser Lauf ist **keine H19-PASS-Evidence**. Nach Source-/Test-/Bundle-Synchronisierung, grünem finalem Gate und Merge ist genau ein neuer echter `h19-remote-recovery`-Lauf erforderlich.


## Live-Versuch 5 – Remote-Stop: Account-Online ist nicht gleich Runner-kontrollierbar

Stand: 2026-09-27

Der erste echte Lauf nach der Account-Online-Korrektur erreichte den Remote-Stop. Auf `My_Warrior` wurde `My_Merchant` accountweit als `online=true` erkannt, während die Runner-Active-Sicht weiterhin nur `My_Warrior` enthielt.

Beobachtetes Verhalten:

- Preflight wählte `My_Merchant` als Remote-Ziel;
- genau ein `stop_character("My_Merchant")` wurde dispatcht;
- Adventure Land lieferte keinen synchronen Fehler;
- `My_Merchant` blieb jedoch während des gesamten Outcome-Fensters accountweit online;
- H19 bestätigte deshalb keinen Stop und ging fail-closed auf `H19_STOP_UNVERIFIED_TIMEOUT`;
- Ergebnis: 1 Dispatch / 0 Confirms / 0 Rejects / 1 UNKNOWN / 0 Stop-Confirms;
- Restart-Recovery und Stability wurden nicht mutierend fortgesetzt; kein Blind-Retry.

Die Adventure-Land-Laufzeit trennt damit zwei Wahrheiten:

- `onlineCharacterNames`: accountweite Online-Wahrheit aus `get_characters().online`;
- `runnerActiveCharacterNames`: Character, die im aktuellen Browser-/Runner-Kontext durch `get_active_characters()` kontrolliert werden.

`stop_character(name)` kann nur einen vom aktuellen Runner geführten Remote-Character zuverlässig stoppen. Ein separat geöffnetes Adventure-Land-Fenster kann accountweit online sein, ohne in diesem Runner stoppbar zu sein.

Korrektur:

- Remote-`START` verwendet weiterhin accountweite Online-Wahrheit: ein eigener Character darf nur gestartet werden, wenn er accountweit offline ist.
- Remote-`STOP` verlangt zusätzlich Runner-Kontrollierbarkeit: Ziel muss accountweit online **und** in `runnerActiveCharacterNames` vorhanden sein.
- Fehlt die Runner-Active-Sicht, wird der Stop mit `H19_RUNNER_ACTIVE_STATE_UNAVAILABLE` fail-closed abgewiesen.
- Ist ein eigener Remote-Character accountweit online, aber nicht runner-kontrollierbar, wird er mit `H19_REMOTE_TARGET_NOT_RUNNER_CONTROLLABLE` vor jedem Dispatch abgewiesen.
- Der `h19-remote-recovery`-Preflight wählt nur Ziele aus der Schnittmenge account-online ∩ runner-active und meldet andernfalls `H19_REMOTE_CONTROLLABLE_TARGET_UNAVAILABLE`.

Dieser Lauf ist weiterhin **keine H19-PASS-Evidence**. Für den nächsten echten Remote-Recovery-Live-Test muss mindestens ein Remote-Character vom Test-Runner selbst per `start_character(...)` als Child-Character gestartet worden sein.


## Cross-Window-Korrektur – getrennte Browserfenster nach V3/V4/V5

Stand: 2026-09-27

Die Auswertung der frueheren Bot-Generationen zeigt, dass `get_active_characters()` nur fuer denselben Runner-/Child-Kontext als direkte Steuerungsgrenze verwendet werden darf. Fuer separat geoeffnete Adventure-Land-Fenster nutzten die bewaehrten Generationen einen Character-to-Character-Kanal:

- V3: `command_character` nur fuer im selben Runner beobachtete Character; andernfalls adressierter `send_cm`-Fallback mit gemeinsamem `on_cm`-Router.
- V4: expliziter `send_cm`-/`on_cm`-Lebensnachweis mit Vertrauensliste; Transport-Evidence ist nicht gleich fachliches Settlement.
- V5: Heartbeat/Liveness, Session-Bindung, TTL, Dedupe sowie ACK/SETTLEMENT und fail-closed Restart-Semantik.

H19 uebernimmt diese Semantik nativ fuer ALFinal:

- `src/cross-window-lifecycle.js` installiert einen schmalen H19-CM-Kanal ausserhalb des normalen Runtime-Schedulers.
- Der Kanal bleibt auch dann aktiv, wenn die lokale ALFinal-Runtime durch einen bestaetigten Remote-STOP gestoppt wurde.
- Heartbeats tragen Character, H19-Session, Serverbindung, Runtime-`running`, `runEpoch` und Emergency-Stop-Zustand.
- Ein Remote-Ziel in einem getrennten Fenster wird nur bei frischem, account-eigenem Heartbeat als `cross-window-runtime` steuerbar betrachtet.
- `STOP_RUNTIME` und `START_RUNTIME` werden auf dem Ziel selbst ausgefuehrt; der Zielbot antwortet mit ACK und terminalem SETTLEMENT.
- Die Command-Bindung enthaelt die beobachtete Ziel-Session. Ein Reload/Sessionwechsel fenced alte Commands.
- Separat geoeffnete Character bleiben waehrend eines Runtime-STOP accountweit online; die H19-Bestaetigung prueft deshalb das CM-Settlement plus den frischen Runtime-Heartbeat statt Online-Abwesenheit.
- Child-Character verwenden weiterhin den nativen `start_character`-/`stop_character`-Pfad.
- Ein zuvor als getrennte Runtime erfasstes Desired-Active-Ziel faellt bei verlorenem Heartbeat nicht blind auf Child-`start_character` zurueck.

Der Live-Test `h19-remote-recovery` Version 2 bevorzugt nun ein frisches getrenntes Fenster als Testziel und verwendet nur dann den Child-Pfad, wenn kein geeigneter Cross-Window-Peer vorhanden ist.

Vor dem naechsten echten Live-Test muessen alle beteiligten getrennten Adventure-Land-Fenster denselben neuen ALFinal-Build geladen haben und einige Sekunden fuer gegenseitige Heartbeats laufen.
