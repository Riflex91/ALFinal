# Codex audit request: Bot V6 module wiring

Base main: `309f13cbc98e1a6da27aba90bf477c63e63bd293`

This PR intentionally changes **documentation only**. Its purpose is to give Codex a stable open PR on which to perform a repository-wide wiring/executability audit of Bot V6.

## Audit scope

Please inspect the complete repository, not only this markdown diff, and verify that every production module is instantiated, dependency-injected, registered, started/stopped, exposed where intended, included in the generated bundle, and reachable through the intended higher-level controllers.

Production module chain currently includes:

- runtime-health
- movement
- class-skills
- party
- combat
- adaptive-farming
- farm-intelligence
- loot-inventory
- merchant
- bank
- trade
- gear
- upgrade-compound
- exchange-craft
- economy
- party-logistics
- character-lifecycle
- account-strategy
- full-autonomy

Public API sections include:

`scheduler`, `modules`, `goals`, `game`, `movement`, `combat`, `classSkills`, `party`, `partyLogistics`, `lifecycle`, `accountStrategy`, `fullAutonomy`, `farming`, `farmIntelligence`, `inventory`, `merchant`, `bank`, `trade`, `gear`, `upgrade`, `exchangeCraft`, `economy`, `liveTests`, `knowledge`, `roster`, `actions`, `dev`, `ui`.

The build includes all production sources through `src/entry.js`, and `dist/al-bot.js` is committed.

## Questions Codex should answer

1. Are constructor dependencies correct and complete for every controller/service?
2. Are any dependencies wired in the wrong direction, missing, assigned too late, or left nullable when callers assume otherwise?
3. Does `_registerCoreModules()` start/stop/status every runtime module correctly?
4. Can every public API method reach a valid initialized implementation?
5. Do Full Autonomy, Account Strategy, Farm Intelligence, Combat/Farming, Merchant/Economy, Party Logistics, and H19 Lifecycle compose without mutually blocking normal work?
6. Are movement/action ownership and Economy-vs-Party-Logistics arbitration coherent?
7. Are cross-window lifecycle/profile transport and party recovery wired to the correct local runtime objects?
8. Does autostart from `src/entry.js` correctly start runtime then arm Full Live FARM without bypassing Emergency Stop or UNKNOWN/Safety rules?
9. Does `scripts/build.mjs` order dependencies safely and does the committed bundle contain the same effective wiring?
10. Do tests materially exercise these connections, and where are important integration gaps?
11. Identify concrete runtime paths where a feature can appear ACTIVE/HEALTHY yet never execute its intended action.
12. Flag dead APIs, unreachable functionality, circular ownership, stale state propagation, scheduler leaks, or controllers that can be permanently starved.
13. Pay special attention to all four-character Full Live behavior: Warrior, Priest, Ranger, Merchant; selected combat group rotation; standby members; Merchant Economy/Logistics; party leader/coordinator; lifecycle recovery.
14. Confirm that H19 terminal/self-stop/UNKNOWN protections cannot be silently bypassed by Full Live.

## Expected review output

Please report findings as concrete review comments with file/line references where possible. Prioritize correctness and executability over style. For every finding, explain the runtime consequence and the smallest safe fix. If no issue is found in a subsystem, explicitly say which wiring path was checked.

Do not modify historical evidence files merely to make assertions pass.
