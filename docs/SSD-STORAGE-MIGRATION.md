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

## One-time non-destructive browser data backup

After the **new Windows host** is installed and running, open DevTools on the
Adventure Land page and run the reviewed source from
`scripts/migrate-browser-storage-to-ssd.js`.

The script copies only ALFinal-owned `albot:` keys (except transient H25
handoffs), V3 `aio-v3-content-drift-v1` keys, and the
`cstore_AIO_V3_WORLD_MODEL` entry. It checks for existing SSD records and
requires readback equality after each new write. Existing different values
are reported as conflicts and **never overwritten**. It prints only sizes,
groups and outcomes, not raw keys or values.

**This is a backup, not a cutover.** It removes zero browser keys; the
remaining V3/ALFinal runtime consumers must be migrated and validated before
any deletion. Do not run the script until `/health` reports `durableStore`.

## Windows Bridge process ownership proof

The local host's `/health` includes `processId`, the **actual Node.js
process PID**. The optional native Windows Bridge host manager must compare
this PID with the child process it just launched, in addition to checking
`ok` and the `durableStore` capability. A healthy response from a
different, already-running host is not proof of ownership and must not
authorize an update, takeover, or success state. The PID is not a secret and
does not grant extra API privileges.

## Native Windows Bridge SSD endpoint (revised integration)

The persistent browser SSD client and non-destructive backup helper now use
`http://127.0.0.1:17392`, implemented **natively in Windows Bridge** (draft
`Riflex91/Riflex91-Repo#995`). The native Bridge writes the same durable-kv
file layout beneath `D:/ALBot/state/durable-kv`. It requires explicit opt-in,
and its absence is a hard block for H25 handoffs: never fall back to browser
localStorage or an unconfirmed write.

For the transition period, the existing Node.js process on port `17391` may
continue serving telemetry and account state. That host process is **not**
required for the SSD API. The older proposed Node host-manager/updater PR
`Riflex91/Riflex91-Repo#994` is superseded for SSD persistence and should
not be merged as-is.

The obsolete ALFinal Node-side storage endpoint and host release workflow are
still present in this candidate for now, but the browser SSD client and the
backup helper do not call them. The remaining host/telemetry release
responsibility and full account/STOP migration require separate review.
