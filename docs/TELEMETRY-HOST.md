# Local AL Bot Host

The host is intentionally local-only and dependency-free. It provides two separate
capabilities without any gameplay action authority:

- telemetry recording
- durable account state for gear/gold snapshots

## Start on Windows

From the repository root:

    npm run host:local

or:

    node host/telemetry-recorder.mjs

Keep this process running while Adventure Land / AL Bot is running. A browser page
cannot write arbitrary files directly to `D:/`; the local host is the narrow
filesystem boundary that performs those writes.

## Defaults

- bind: `127.0.0.1:17391`
- telemetry: `D:/ALBot/telemetry`
- durable account state: `D:/ALBot/state`
- character gear/profile files: `D:/ALBot/state/account-profiles/<character>.json`
- account wealth snapshot: `D:/ALBot/state/account-wealth.json`
- raw telemetry retention: 30 days
- daily telemetry summary retention: 1095 days

Gear/profile snapshots are written independently per character. AL Bot loads the
SSD state before Account Strategy starts, writes a fresh local snapshot when the
bot starts, and writes/flushed a final snapshot before normal stop, character
disconnect/rotation, browser navigation and hot reload. Browser storage remains a
fail-safe fallback only.

## Optional environment variables

- `ALBOT_STATE_ROOT`
- `ALBOT_TELEMETRY_ROOT`
- `ALBOT_TELEMETRY_HOST`
- `ALBOT_TELEMETRY_PORT`
- `ALBOT_TELEMETRY_RAW_DAYS`
- `ALBOT_TELEMETRY_DAILY_DAYS`

## Endpoints

- `GET /health`
- `POST /v1/telemetry`
- `GET /v1/state/account`
- `POST /v1/state/account`

The state and telemetry endpoints accept only the local Adventure Land browser
origin policy. They do not expose gameplay commands, arbitrary file paths or
generic remote evaluation.

If `ALBot.hostState.status().lastError` reports a connection failure, verify that
`npm run host:local` is running. AL Bot remains fail-closed for missing offline
gear data and falls back to browser storage rather than inventing state.
