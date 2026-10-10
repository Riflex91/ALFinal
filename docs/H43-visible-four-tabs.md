# H43: Four visible Adventure Land browser game clients

Adventure Land documents start_character() as a CODE child runner, not a rendered
game client. Only New Game Window (or /window) opens an independent rendered
client. Do not launch a character twice.

## One-time safe migration

1. Keep My_Merchant's gameplay page running with the SSD service at D:\ALBot.
2. In Merchant CODE run ALBot.visibleClients.status(). The local kind must be
   VISIBLE_BROWSER. Run ALBot.visibleClients.enable() once. This writes the
   shared SSD-only mode flag and immediately blocks automatic child START,
   STOP and browser character swap/rotation in H19.
3. Stop ONE existing child runner via Adventure Land controls, wait until the
   character is offline, then open that character using New Game Window.
   Use the existing AL Bot CODE loader and the same permitted PvE realm.
4. Repeat for My_Ranger1, My_Ranger2, and My_Rogue, one at a time.
5. Check ALBot.visibleClients.status() in Merchant and personally verify four
   original graphical game windows, the current party and autonomous gameplay.

The bot cannot create/reopen Brave tabs from a CODE iframe. Its status is
observational, not proof a browser was opened by GitHub. Do not stop/rotate a
visible client to recover a missing tab. During H42 cross-server convergence,
fresh peer signals are scoped to the current server and may be briefly absent.

H22 continues verified hot updates inside each live browser CODE runner.
H38/H42 change_server() uses the existing visible game clients. The SSD flag
is deliberately one-way during migration. Loss of SSD does not re-enable
child starts for a runtime that has already seen the flag. Browser localStorage
is never used for the mode.

## Validation boundary

The H43 status reports evidence from the current game URL, live character
object, rendering canvas and fresh H19 peers. It is not a browser-management
API, and a connection screen is never counted as a successful rendered client.
A GitHub Actions success cannot confirm the user's four actual Brave tabs.
Only migrate one previously-running child at a time to avoid exceeding the
four-character account limit or displacing another visible session.

## H45 — No automatic CODE children, including before manual H43 activation

ALFinal now reserves `My_Merchant`, `My_Ranger1`, `My_Ranger2`, and
`My_Rogue` for independent browser gameplay. In any of these runtimes the
GameActionBoundary rejects `start_character` and `stop_character`, while H19
refuses new START/STOP/BROWSER_SWAP commands or character-identity navigation.
This protection applies **even when the H43 SSD flag was never enabled**.
The known account's fixed quartet also takes precedence over task optimizer
suggestions to substitute Priest/Warrior. H38/H42 server hops and H19 party
invitations remain separate permitted actions.

A visible Merchant will attempt to arm the persistent H43 SSD flag on normal
autostart, before Full Autonomy. If the game has not fully connected, the
fail-closed child start protection already applies; once connected,
`ALBot.visibleClients.enable()` remains available as an explicit retry.

**Previously running CODE children are NOT forcibly killed.** Their "CODE
aktiv" indicators will persist until the operator migrates them individually:

1. Keep the visible Merchant window and `D:\ALBot` SSD host running.
2. For each farmer in turn, STOP its **old child CODE session** using the game's
   existing character management controls. Wait until the account roster shows
   that character offline. Do not stop the Merchant or another farmer.
3. Start the same character with "New Game Window" as a proper original game
   client on the chosen EU/II PvE realm and run its existing CODE slot.
4. Repeat for the remaining farmers. **Never open the same character while its
   old CODE session is still connected**, or Adventure Land may refuse/reload
   the second session due to the account's four-online limit.
5. Confirm four active original gameplay canvases, not just four browser tabs
   or "CODE aktiv" markers. Use `ALBot.visibleClients.status()`; look for
   `protectionActive: true`, `childCodeStartsBlocked: true`, and eventually
   `complete: true`. Confirm party invitations and the four-party game UI
   independently.

Closing or refreshing browser tabs does not switch CODE children into graphical
clients. A website CODE runner cannot manufacture browser tabs that the browser
will permit/retain without explicit user interaction.
