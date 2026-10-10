# AL Bot

**Repository:** `Riflex91/ALFinal`

AL Bot ist die finale, neu aufgebaute Adventure-Land-Bot-Codebasis. Intern darf die Entwicklungsgeneration als „V6“ bezeichnet werden. **Im Produkt, in der GUI, im normalen Code und in der Projektdokumentation heißt das System jedoch nur `AL Bot`.**

## Verbindliche Projektziele

1. **Zuverlässigkeit hat oberste Priorität.**
2. **Modulare Architektur**, damit Funktionen später ergänzt, ersetzt oder geändert werden können.
3. **Headless-Fähigkeit von Anfang an** – die GUI darf niemals Voraussetzung für den Bot-Core sein.
4. Eine **mitwachsende Haupt-GUI / Control Center** wird bereits im Fundament angelegt.
5. Ein **Prioritäten- und Goal-System** ist Kernbestandteil der Architektur.
6. Der Bot kann die von der bestehenden **Windows Bridge** bereitgestellte Adventure-Land-Wissensdatenbank über eine klar getrennte, read-only Knowledge-Schicht nutzen.
7. Entwicklung erfolgt in **kleinen, direkt im echten Spiel testbaren Häppchen**.
8. Die langen V5-Testketten `Shadow → Evidence → Authorization → One-shot → 5m → 15m` sind **kein Pflichtprozess** für AL Bot.
9. Stattdessen besitzt der Bot von Anfang an einen permanent sichtbaren **roten globalen STOP-Button**.

## Verbindliche Dokumente

- [Projektarchitektur und Grundsätze](docs/PROJECT-CHARTER.md)
- [Entwicklungsroadmap und Live-Test-Häppchen](docs/ROADMAP.md)
- [Chat-Handoff / aktueller Stand](docs/CHAT-HANDOFF.md)
- [v3-Produktionsplaner: APIs und Ausführungsgrenzen](docs/V3-PRODUCTION-PLANNER.md)

## Aktueller Stand

Der bisherige Stable-Stand ist `0.26.69-h26`; der reparierte Release-Kandidat ist `0.26.80-h26`. Er enthält Combat, Party, Farming, Inventory, Merchant/Economy, Lifecycle/Recovery, Account-Strategie, Full Autonomy, Merchant-Hintergrundarbeit, Safe Updater und autonome Beobachtung. Der hier vorbereitete Kandidat ergänzt den read-only v3-Produktionsplaner; er ist noch nicht live abgenommen oder als Stable veröffentlicht.

**Wichtig:** Dieses README ist nur eine Zusammenfassung und darf niemals als alleinige Quelle für den Implementierungsstand verwendet werden. Vor einer Capability-/Gap-Analyse müssen der aktuelle Zielbranch, offene relevante PRs, scripts/build.mjs, src/runtime.js, src/entry.js, die betroffenen Controller sowie Tests/Live-Evidence geprüft werden. Verbindliche Arbeitsregeln stehen zusätzlich in AGENTS.md.

Der Planer ergänzt Beschaffungsgraphen und Gear-Empfehlungen. Ein Import des vollständigen v3-Produktionscontrollers oder eine automatische Aktivierung neuer Farm-/Mutations-/Lieferketten ist damit nicht verbunden.


## SSD-Telemetrie (Windows)

Die Gameplay-Module und das SSD-Telemetrie-Ziel sind voneinander unabhängig. Der Browser-Client sendet Telemetrie über `http://127.0.0.1:17391/v1/telemetry`; der bestehende Host-Recorder schreibt Rohdaten nach `D:\\ALBot\\telemetry\\raw` und Tageszusammenfassungen nach `D:\\ALBot\\telemetry\\daily`.

**Wichtig:** GitHub kann einen Prozess auf dem lokalen Windows-PC nicht starten. Der Dienst muss einmal lokal eingerichtet werden; der D:-Datenträger und Node.js müssen verfügbar sein. Dazu das Repository lokal bereitstellen und `host/INSTALL-SSD-TELEMETRY.ps1` in PowerShell ausführen. Der Installer prüft das SSD-Laufwerk, registriert einen Task beim Windows-Login und bestätigt den `/health`-Endpunkt. Es gibt **keinen** stillen Fallback auf C: oder Browser-Telemetrie. Bei fehlender SSD wird der Host-Start abgebrochen, das Gameplay bleibt unverändert.

Die Spielclients aktualisieren sich über die vorhandene H22-Automatik, sobald `main/release/al-bot-release.json` eine höhere, unveränderlich gepinnte Freigabe mit passendem SHA-256 enthält und die jeweiligen Update-Sicherheitsprüfungen erfolgreich sind. Ein GitHub-Commit allein aktualisiert keinen bereits laufenden Browser.

## H37 – Spielbetrieb bei nicht verfügbarer Charakterrotation

Wenn der Merchant eine andere Teamzusammensetzung optimiert, aber H19 die Rotation sicherheitsbedingt ablehnt, behält er eine bereits online befindliche gültige Gruppe aus drei Farmern plus Merchant bei. Er veröffentlicht diese Auswahl an die anderen Fenster, sodass Farming, Party und Merchant-Zusammenarbeit weiterlaufen können. Ein auszuwechselnder Farmer wartet auf die Merchant-Koordination, statt die gesamte Full Autonomy mit `FULL_AUTONOMY_ROTATION_UNAVAILABLE` zu blockieren. Offene, unbekannte oder suspendierte H19-Aktionen werden nicht umgangen; die Rotationsfähigkeit bleibt separat zu reparieren.

## H38 – Farming-Kohäsion, Werkzeug-Materialien, Serverwechsel

- H9 bleibt mindestens 120 Sekunden am sicheren Farmspot, bevor es einen normalen besseren Spot akzeptiert; es wartet nach einem gewöhnlichen Wechsel mindestens 90 Sekunden. Kurze Gruppenabstände bis zum Doppelten des harten Schwellenwerts unterbrechen längere Leader-Reisen erst nach neun Sekunden. Extrem große Abstände und Kampf-/H19-Sicherheitsfälle behalten ihren sofortigen Schutz.
- H33/H38: Wenn `rod` oder `pickaxe` fehlen, veröffentlicht der Merchant im Beobachter-Tick einen begrenzten `merchant-tool-crafting`-Materialbedarf über gemeinsamen Browser-Speicher. Das funktioniert auch, wenn die aktive H17-Economy gerade eine Exchange-Aktion besitzt. Dieser Vorgang *plant* Farming und verdrängt niemals laufende Economy-Aktionen. H9 verwendet den Auftrag nur für sichere Monsterkandidaten.
- H39: Bei mindestens zwei Minuten dauerhaftem **nachgewiesenem** Spawnmangel in Kombination mit mindestens drei Konkurrenzspielern darf der Merchant zwischen **allen vom Live-Spiel bestätigten PvE-Servern in Europa (EU) und Amerika (US)** wechseln. Die Spiel-API `get_servers()` liefert die aktuelle Serverliste; nur Einträge mit eindeutiger PvE-Klassifizierung werden berücksichtigt. Jeder Server, dessen Name an beliebiger Stelle **`pvp`** enthält (ohne Groß-/Kleinschreibung), ist selbst bei widersprüchlicher PvE-Kennzeichnung gesperrt. Zusätzlich bleiben explizit als PvP/Hardcore markierte, unbekannte oder nicht EU/US-Server ausgeschlossen. Eine dynamische Round-Robin-Auswahl berücksichtigt auch später hinzugekommene, bestätigte Server. Ohne frische verifizierte Liste erfolgt **kein** automatischer Wechsel. Vier aktive eigene Profile und vier frische Vorab-ACKs sind nötig, bevor der Merchant einen gemeinsamen Zeitpunkt festlegt. Der Cooldown beträgt 90 Minuten. Die tatsächliche `change_server(region, identifier)`-API muss in allen Browserfenstern existieren.
- Dieser Wechsel ist ein **Best-effort-Quorum-Protokoll**, keine atomare Transaktion des Spielservers: Ein Browser kann eine bestätigte Navigation immer noch ablehnen. Die H38-Handoff-Sperre verhindert während des koordinierten Wechselzeitfensters H19-Ersatzrotationen, aber garantiert keine atomare Migration. Bei fehlender API, Shared Storage, Teamvollständigkeit, H19-Freigabe oder sicherem Bewegungs-/Kampfzustand bleibt der Bot auf seinem Server.
- Öffentliche Statusabfrage: `ALBot.serverHop.status()`; für automatische Migration `enabled: true` (Standard). Konfiguration ändert keine H19-Sperren.

Die SSD-Telemetrie und der H22-Safe-Updater bleiben unverändert.


## H41: SSD-only bot-owned state (staged; requires host installation before promotion)

The bot's **persistent own state** is stored on the Windows SSD under `D:\\ALBot`:
- `D:\\ALBot\\state\\kv`: H19 cross-window coordination, H25 handoffs, emergency-stop markers, account configuration, party and Merchant material farm demands, H22 update state, and other `albot:` keys.
- `D:\\ALBot\\state\\account-profiles` and `account-wealth.json`: durable account profiles and wealth, via the already existing host-state writer.
- `D:\\ALBot\\telemetry\\raw` and `daily`: telemetry history.

The new storage adapter uses a **synchronous localhost HTTP API** on `127.0.0.1:17391` compatible with existing H19 and material demand contracts. It **never silently falls back to browser localStorage in real browser mode**. If the host is unavailable, its storage or disk path is not on `D:\\ALBot`, or a write fails, game-action dispatch is blocked. Browsers may require localhost permission.

The Windows service must be installed **before the H41 client bundle is promoted to Stable**. Run `host/INSTALL-SSD-TELEMETRY.ps1` on the Windows host from a local checkout containing both `telemetry-recorder.mjs` and `ssd-kv-store.mjs`. The installer stops and updates only the pre-existing `ALBot-SSD-Telemetry` scheduled task; checks the SSD paths, service health, and KV write/read/delete; and restarts automatically at Windows logon. Node.js and the `D:` volume are required. No API credentials are stored on disk by this installer.

**Rollout boundary:** A GitHub merge does not start any Windows service. Until the user's host passes SSD-KV verification, PR #119 must not be promoted: the old bot continues on the previous Stable instead of stopping all four characters. Existing browser-localStorage values are *not automatically copied to SSD* by this PR (stale H19 execution state must not be blindly replayed). A separate reviewed, one-time migration is needed if old goals/configurations must be preserved.

H41 also binds the GearController to the initialized H19 transport and prioritizes an already healthy 3-Farmer+Merchant online quartet so the Merchant can invite My_Ranger1 and resume safe gear/material coordination without unnecessary H25 swaps.


## H42 – Automatische Party-Wiedervereinigung bei Server-Split

Wenn Merchant und drei Farmer auf unterschiedlichen Servern starten, veröffentlicht jedes eigene Browserfenster alle 1,5 Sekunden seinen aktuellen Server und die H19-Sicherheitsbereitschaft auf der SSD (`D:\\ALBot\\state\\kv`). Der Merchant prüft frische Zustände **aller vier** online befindlichen und nachweislich eigenen Charaktere. Bei einer eindeutigen **3:1-Verteilung** wählt er den bereits besetzten Mehrheit-Server als Ziel und veröffentlicht einen zeitlich begrenzten SSD-Wiedervereinigungsauftrag. **Nur der einzelne abweichende Charakter** wechselt – im beobachteten Fall fährt `My_Merchant` von EU I zu den drei Farmern auf EU II.

Diese Wiedervereinigung benötigt weder eine bereits bestehende Party noch eine H38-Konkurrenzmeldung. Solange ein Wiedervereinigungsauftrag aktiv ist, unterbindet Full Autonomy H19-Neustarts, bis alle vier Charaktere nachweislich auf dem Zielserver angekommen sind. Anschließend beginnt der normale H19-Party-Aufbau. Ausgenommen sind PvP-/Hardcore-Server, unklare 2:2-Verteilungen, fehlende/frische SSD-Peers, unbekannte H19-Ausgänge, laufende Kampf- oder Bewegungsaktionen sowie ein bereits bestätigter normaler H38-Serverwechsel. Ein fehlgeschlagener Wechsel wird **nicht** blind wiederholt; die Wiedervereinigung hat einen 5-Minuten-Cooldown. Da der Serverwechsel eine Browser-Navigation ist, bleiben echte Live-Bestätigungen erforderlich.

Status: `ALBot.serverHop.status().lastDecision` (z. B. `H42_REJOIN_MAJORITY_SELECTED`, `H42_REJOIN_SERVER_CHANGE_DISPATCHED` oder `H42_REJOIN_COMPLETE`). Die SSD-Speicherung bleibt verpflichtend.
