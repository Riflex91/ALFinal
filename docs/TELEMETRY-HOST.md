# Local Telemetry Host

The recorder is intentionally local-only and dependency-free.

Run on the Windows PC:

    node host/telemetry-recorder.mjs

Default:
- bind: 127.0.0.1:17391
- storage: D:/ALBot/telemetry
- raw retention: 30 days
- daily summary retention: 1095 days

Optional environment variables:
- ALBOT_TELEMETRY_ROOT
- ALBOT_TELEMETRY_HOST
- ALBOT_TELEMETRY_PORT
- ALBOT_TELEMETRY_RAW_DAYS
- ALBOT_TELEMETRY_DAILY_DAYS

Endpoints:
- GET /health
- POST /v1/telemetry

The browser client queues bounded telemetry locally when the host is unavailable and backs off instead of spamming retries. The telemetry path has no gameplay action authority.
