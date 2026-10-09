# ALFinal SSD persistence migration (preparation)

**Status:** preparation stage / pending live verification. This change is not a full
browser-storage migration and must not be presented as one.

## Current SSD contract
- Existing `D:/ALBot/state` and `D:/ALBot/telemetry` remain in place.
- The native Windows Bridge exposes `GET /v1/storage?key=...`,
  `POST /v1/storage?key=...` and `DELETE /v1/storage?key=...`.
- Native Bridge KV records use hashed filenames beneath `D:/ALBot/state/durable-kv`
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

After the **native Windows Bridge SSD API** is installed, explicitly enabled and running, open DevTools on the
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

## Native Windows Bridge SSD endpoint (revised integration)

The persistent browser SSD client and non-destructive backup helper now use
`http://127.0.0.1:17392`, implemented **natively in Windows Bridge** (merged as staging PR
`Riflex91/Riflex91-Repo#995`; not a Stable publication). The native Bridge writes the same durable-kv
file layout beneath `D:/ALBot/state/durable-kv`. It requires explicit opt-in,
and its absence is a hard block for H25 handoffs: never fall back to browser
localStorage or an unconfirmed write.

For the transition period, the existing Node.js process on port `17391` may
continue serving telemetry and account state. That host process is **not**
required for the SSD API. The older proposed Node host-manager/updater PR
`Riflex91/Riflex91-Repo#994` is superseded for SSD persistence and should
not be merged as-is.

The obsolete Node-side durable-kv endpoint has been removed entirely. The\nlegacy Node service remains responsible only for telemetry and account state\nuntil a verified single-writer handover. The separate Node host-release workflow has been removed
from this candidate: native SSD updates are delivered with the self-updating
Windows Bridge. Telemetry/account/STOP migration requires separate review.

## Account/telemetry ownership groundwork (not yet active in live)

The legacy `host/telemetry-recorder.mjs` now imports
`host/ssd-writer-ownership.mjs`. When this candidate is explicitly deployed,
the Node host atomically creates and verifies two files under
`D:/ALBot/state`: `writer-owner.json` (durable `node` owner) and
`writer-lease.json` (unique running-instance lease). Account and telemetry
writers, daily flush and pruning are fenced before filesystem mutation.
A second writer, stale lease, corrupt marker or `bridge` owner stops the
legacy host instead of guessing that it owns the SSD. Graceful termination
releases only a verified lease after confirmed flush; owner identity persists.

The counterpart `AlFinalNativeWriterOwnership` merged from Windows Bridge PR
`#995` uses the same marker and exclusive lease-file convention. Native
account/telemetry POST remain production-disabled and cannot be enabled by
a free TCP port alone. There is **no operator cutover procedure or rollback
automation** yet, and old uninstrumented Node versions cannot be considered
fenced. Do not alter or delete the owner/lease files manually without a
reviewed shutdown, backup and verification procedure. Existing account and
telemetry browser clients stay on port 17391 in this uninstalled candidate.

## Read-only single-writer preflight

The standalone diagnostic `scripts/ssd-writer-preflight.mjs` inspects the
persistent writer owner and lease records, validates bounded account snapshot
files and computes a privacy-preserving account fingerprint. It **does not**
modify any data or take ownership of SSD paths.

After an operator has approved inspecting the local installation, run:

```powershell
node scripts/ssd-writer-preflight.mjs "D:/ALBot/state" "D:/ALBot/telemetry"
```

It produces JSON observations and explicit blockers. Exit status 2 means
blocked or unsafe; exit status 1 means manual verification is still required.
It deliberately **never** returns permission to switch writers; a missing
lease and an unoccupied port are insufficient proof against old,
uninstrumented Node versions. Do not remove a stale lease to make the
diagnostic pass.

## H19 emergency persistence staging

H19's browser-backed pre-dispatch pending record now requires a successful
write plus exact readback. StorageAdapter may still use transient memory for
historical **non-safety** cache keys, but never for `albot:h19:` or the
Emergency STOP key. If the pending record cannot be confirmed, H19
blocks dispatch and suspends further lifecycle actions. On a session change,
an old pending action without verified live outcome is retained as UNKNOWN
rather than silently deleted and retried. Valid positive live evidence can
still reconcile a genuinely completed action.

This is **intermediate safety hardening, not SSD H19 completion**:
persistent STOP/UNKNOWN state still needs a separate verified SSD preload,
durable async acknowledgement, and evidence-backed recovery path. Never
clear browser safety keys or reset existing STOP/UNKNOWN latches during the
migration.

## Offline account/telemetry backup for a future single-writer cutover

The optional `scripts/ssd-cutover-backup.mjs` is **copy-only** and is not
part of normal ALFinal startup. It is intentionally not connected to the
Windows Bridge toggles or release automation.

**Prerequisites (manual, not automatically proven):**

1. Arrange a maintenance window. Stop the existing Node account/telemetry
   service cleanly and confirm its final flush has finished. Also disable
   watchdogs, services, scheduled tasks and any other restart path, including
   older uninstrumented Node versions. Port 17391 being free is not sufficient.
2. Confirm there is no active or stale `writer-lease.json` requiring
   reconciliation; the persistent owner must still be `node`. **Never
   delete a lease blindly.**
3. Independently back up browser-side STOP/UNKNOWN/H19 and V3 data. This
   offline tool **does not copy browser storage or the native durable-kv tree**.
4. Provide a **new, empty external destination path**; existing backup
   locations are never overwritten. Ensure sufficient free space. A separate
   physical volume is preferable.

Only after the operator has actually stopped all writers, use:

```powershell
node scripts/ssd-writer-preflight.mjs "D:/ALBot/state" "D:/ALBot/telemetry"
node scripts/ssd-cutover-backup.mjs "D:/ALBot/state" "D:/ALBot/telemetry" "E:/ALBot-backups/cutover-2026-10-09" --confirm-stopped
```

Replace the example backup path with a new, existing-parent destination.
The `--confirm-stopped` switch is a statement by the operator, **not**
proof that no uninstrumented service is running. The tool copies bounded
`account-profiles/*.json`, `account-wealth.json`, and telemetry
`raw/` and `daily/` records. It verifies SHA-256 for source before,
copy, and source after, rescans the source inventory and records a manifest.
Each copied file is flushed to disk. It will not copy unrecognized entries,
follow symlinks or write into either source tree.

Run the independent read-only backup verifier after copying and again just
before any separately approved restore test:

```powershell
node scripts/ssd-cutover-verify.mjs "E:/ALBot-backups/cutover-2026-10-09"
```

It rechecks the manifest schema and SHA-256 of each copied file, rejects
unexpected files, corruption, traversal and `INCOMPLETE`. Keep the original
manifest SHA-256 printed by the backup command **outside the backup directory**
and compare it to the verifier's result; a self-consistent backup cannot
protect against a malicious rewrite of both its data and its manifest.

**Successful output does not authorize a cutover.** It carries
`cutoverAuthorized: false`, and the manifest records
`scope: "account-and-telemetry-only"`. Verify the snapshot and test restore
in an isolated temporary environment. Interrupted or inconsistent backups
retain an `INCOMPLETE` marker, are never automatically removed and must
never be treated as recovery evidence. Hard limits (30,000 files, 4 GiB
combined, 128 MiB per raw file, 1 MiB per JSON file) fail closed if the
data set exceeds this staging tool's validated scope.

**Not implemented here:** a reviewed owner-marker transition, protection
against any old uninstrumented process, GUI activation of Bridge account or
telemetry POST, live browser endpoint switching, and a transactional rollback.
Those remain separate review and live-evidence gates. No branch in this
migration is eligible for Stable promotion on the strength of a backup alone.

## Read-only local witness (no process intervention)

An additional standalone witness collects only bounded local health status,
the existing account fingerprint, and owner/lease marker diagnostics:

```powershell
node scripts/ssd-readonly-witness.mjs "D:/ALBot/state" "D:/ALBot/telemetry"
```

It sends **only GET /health** to loopback ports 17391 and 17392, and reads
the same filesystem paths used by `ssd-writer-preflight.mjs`. It sends no
POST/DELETE, never changes the owner, never clears an old lease, does not
stop/restart Node or Windows Bridge, and does not mutate browser/game state.
Unexpected services, invalid JSON, oversized replies and timeouts are
reported as unverified without printing health-payload contents. Existing
account values and character names are not logged; account files contribute
only to counts and a comparison fingerprint.

The witness returns `cutoverAuthorized: false` and
`liveGameplayVerified: false` regardless of observed endpoints. A responsive
Windows Bridge KV server can coexist with a legacy Node account/telemetry
server; **simultaneous healthy ports do not prove two active account writers**.
Conversely, a closed port does not prove an old uninstrumented Node service
cannot be restarted. Save the witness JSON as review evidence separately,
then collect explicit browser H19/STOP/UNKNOWN/H25 observations with no
reset/deletion. No live evidence is automatically asserted by this script.

## H19 pending-clear invariants

Every H19 resolution path (confirmed, rejected, cross-window retry or
explicit UNKNOWN acknowledgement) must verify that persistent `pending`
has actually been cleared. If storage returns false, throws or silently
ignores deletion, H19 retains in-memory action ownership, suspends, and
refuses automatic redispatch. No successful acknowledgement or confirmation
may be reported for an unconfirmed persistent clear. Even if later readback
succeeds, an independently raised H19 suspension remains in force until
an authorized safety reset.

This is still browser-store staging. It does **not** replace the future SSD
preload and confirmed asynchronous STOP/UNKNOWN state transition; legacy
browser safety records must not be deleted during this stage.

## Read-only browser safety witness (one browser context at a time)

After reviewing `scripts/ssd-browser-safety-witness.js` in the exact
development checkout, use the browser developer console in **each relevant
Adventure Land window** to execute that file's entire source. This is
**inspection only**; the file is not part of `dist/al-bot.js`, and must not
be injected into production as an automatic action. No browser refresh,
STOP reset, H19 acknowledgement, runtime restart, or gameplay mutation is
required or authorized by this procedure.

It enumerates the local window's `localStorage` using only read APIs and
prints a single JSON report containing:
- whether the STOP record is valid and latched;
- counts of H19 pending, UNKNOWN-marked and policy records;
- counts of H25 handoffs;
- stable SHA-256 fingerprints and sizes of the selected safety records.

The report contains **no original keys, character names, target IDs,
stored values or account gold**. Corrupt safety entries, denied reads or
missing cryptographic hashing make `verified=false`. Its
`cutoverAuthorized` flag is **always false**. `verified=true` means only
that these records were read in this window, not that other open windows or
the local Windows services are safe.

Preserve the JSON separately and compare before/after fingerprints without
deleting any underlying browser record. Pair this evidence with
`ssd-readonly-witness.mjs` from the Windows command line and the exact
version/CI head. Review outstanding STOP/UNKNOWN records manually;
**do not perform mutating H19 live tests while they are unresolved**.

## Startup safety with unreadable browser persistence

The runtime now fails closed if its emergency STOP key is present but corrupt
or cannot be read: it starts with an in-memory
`EMERGENCY_STOP_STORAGE_UNVERIFIED` latch and does not replace the original
record with a default. H19 similarly sets
`H19_PENDING_RESTORE_UNVERIFIED` and blocks lifecycle dispatch if the
pending safety key cannot be read or parsed. Confirmed absence is distinct
from unreadability; no volatile memory fallback can prove a critical key is
absent. A missing or corrupt safety record must not be silently cleared to
make the migration proceed.
