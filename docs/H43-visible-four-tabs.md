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
