# H23 Foundation – Encounters, Market Intelligence & Host Telemetry

Stand: 2026-09-28

This branch is prepared for review/testing only and must remain fresh against main.

## Encounter engine

- New EncounterController.
- Boss catalog is derived from live G.monsters boss flags.
- Active bosses are derived from visible live entities.
- Events are detected from Adventure Land game event announcements plus live server state S.
- Every newly discovered boss/event is enabled by default.
- Opt-outs are persisted as a disabled set, so newly added content remains enabled automatically.
- Control Center tab Bosse & Events shows active/inactive entries and supports individual or all on/off.
- Full Live dynamically gives enabled active EVENT encounters priority over BOSS encounters and otherwise returns to the configured base task, normally FARM.
- Existing account optimizer requirements for BOSS/EVENT (TANK + HEALER + DPS) are reused.
- Encounter combat and travel reuse H4/H5/H7 safety paths and suspend on UNKNOWN without blind retry.
- The initial generic phase signal is derived from boss HP quarters. Encounter-specific mechanic profiles can be added later without replacing the core.

## Market intelligence

- New read-only ALData market provider using the documented `GET https://aldata.earthiverse.ca/trades` WTS/WTB feed.
- Owner-level `lastUpdated` is enforced with a seven-day default freshness ceiling; older external listings are ignored. External data is advisory and never proves mutation safety.
- Local visible market from H13 remains the live source for immediate listing validation.
- Price bands combine local visible asks/bids, ALData samples, NPC value floor and bounded local history.
- New Merchant Stand controller uses central ActionBoundary actions open_stand, close_stand and trade.
- Auto-stand is off by default.
- Automatic listing only considers H10 rows explicitly classified SELL.
- Existing own SELL listings can be repriced through a bounded UNLIST → live inventory evidence → RELIST state machine. The original listing rid/name/level/price is revalidated immediately before unlisting; repricing requires a free inventory slot, a material price delta, an actionable live/ALData signal, cooldown/budgets, and UNKNOWN always suspends without blind retry.

## Telemetry

Browser runtime:
- bounded 5-second snapshots;
- localhost endpoint http://127.0.0.1:17391/v1/telemetry;
- 60-second backoff if the local host is unavailable;
- no gameplay authority.

Host recorder:
- command: node host/telemetry-recorder.mjs
- binds to 127.0.0.1:17391;
- default root: D:/ALBot/telemetry;
- short-term raw records: raw/YYYY-MM-DD/HH/<character>.ndjson;
- long-term summaries: daily/YYYY-MM-DD/<character>.json;
- raw retention default: 30 days;
- daily retention default: 1095 days.

The ChatGPT environment cannot directly mount or write the user's local D:/ drive. The included host process performs those writes when run on the user's PC.

## Required gates before merge

1. feature branch is fresh against then-current main;
2. full CI passes on exact head;
3. dedicated live validation:
   - boss/event GUI toggles persist;
   - one safe visible boss or event is detected;
   - Full Live temporarily switches to the encounter task and returns to FARM after it ends;
   - ALData refresh remains read-only;
   - Merchant stand begins with auto-mutation disabled, then validates one bounded low-risk listing separately;
   - telemetry host writes raw + daily files under D:/ALBot/telemetry;
4. no open review threads / no failing or pending checks.

No merge is authorized by this branch preparation.
