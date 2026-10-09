# ALFinal SSD persistence migration (preparation)

**Status:** preparation stage / pending live verification. This change is not a full
browser-storage migration and must not be presented as one.

## Current SSD contract
- Existing `D:/ALBot/state` and `D:/ALBot/telemetry` remain in place.
- The Windows host offers `GET /v1/storage?key=...`,
  `POST /v1/storage?key=...` and `DELETE /v1/storage?key=...`.
- Durable KV records use hashed filenames beneath `D:/ALBot/state/durable-kv`
  and temporary-file write, fsync, atomic rename before an HTTP success.
- Only ALBot-owned keys, AIO V3 content drift keys, and the V3 world model key
  are accepted by this storage API. Untrusted browser-origin requests are denied.
- H25 Full Autonomy browser swap first confirms its short-lived handoff on SSD,
  then disconnects and navigates the previous character in one JS turn. The
  receiving runner consumes that handoff from SSD only; it does not use
  `localStorage` fallback for H25.
- If the SSD host is unavailable, **do not disconnect or navigate**. Do not
  clear UNKNOWN or emergency-stop protection.

## Remaining work for full browser-free bot persistence
- Convert the synchronous StorageAdapter users (emergency STOP, H19 pending
  actions, policies, knowledge, gear, account caches, and updater) to a durable
  preload/confirmed-write contract; never mark a gameplay mutation dispatched
  until its required safety state is confirmed durable.
- ALFinal market intelligence now reads/writes new history snapshots via SSD,
  never browser localStorage. Legacy history still requires explicit backup
  and import before removing the browser copy.
- Move remaining ALFinal large histories to SSD with bounded retention.
- Migrate AIO V3 content drift and world-model persistence separately in
  `Riflex91/Riflex91-Repo`; its older runtime currently writes its own keys.
- Provide an explicit, reviewed **backup/export before deletion** migration
  for existing browser data. This PR performs no browser-storage deletion.
- Validate in a local host smoke test and then Adventure Land live test before
  promoting the candidate release.
