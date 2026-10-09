import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Read-only diagnostic. This is NOT an authorization to change writer ownership.
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROFILES = 64;
const MAX_MARKER_BYTES = 4096;

function readRegularFile(target, limit) {
  let info;
  try { info = fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) {
    throw new Error('UNSAFE_FILE_OR_SIZE');
  }
  return fs.readFileSync(target);
}

function directoryState(target) {
  try {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory()) return 'UNSAFE';
    return 'PRESENT';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'MISSING';
    return 'UNREADABLE';
  }
}

function readMarker(target, allowed, blockers, prefix) {
  try {
    const raw = readRegularFile(target, MAX_MARKER_BYTES);
    if (raw === null) { blockers.push(prefix + '_MISSING'); return null; }
    const marker = JSON.parse(raw.toString('utf8'));
    if (marker?.schemaVersion !== 1 || !allowed.includes(marker?.owner)) {
      blockers.push(prefix + '_INVALID');
      return null;
    }
    return marker;
  } catch (_) {
    blockers.push(prefix + '_UNREADABLE_OR_UNSAFE');
    return null;
  }
}

function summarizeAccountFiles(root, blockers) {
  const dir = path.join(root, 'account-profiles');
  const state = directoryState(dir);
  const wealthPath = path.join(root, 'account-wealth.json');
  let profileCount = 0;
  const digests = [];
  if (state === 'PRESENT') {
    try {
      const filenames = fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort();
      if (filenames.length > MAX_PROFILES) blockers.push('PROFILE_COUNT_EXCEEDS_LIMIT');
      for (const filename of filenames.slice(0, MAX_PROFILES + 1)) {
        if (!/^[a-zA-Z0-9._-]{1,100}\.json$/.test(filename)) throw new Error('INVALID_FILENAME');
        const contents = readRegularFile(path.join(dir, filename), MAX_FILE_BYTES);
        if (!contents) throw new Error('PROFILE_MISSING');
        const record = JSON.parse(contents.toString('utf8'));
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || record.name !== filename.slice(0, -5)) throw new Error('INVALID_PROFILE');
        profileCount++;
        digests.push(crypto.createHash('sha256').update(contents).digest('hex'));
      }
    } catch (_) {
      blockers.push('ACCOUNT_PROFILES_UNREADABLE_OR_INVALID');
    }
  } else if (state === 'UNSAFE' || state === 'UNREADABLE') {
    blockers.push('ACCOUNT_PROFILES_DIRECTORY_UNSAFE');
  }
  let wealth = false;
  try {
    const contents = readRegularFile(wealthPath, MAX_FILE_BYTES);
    if (contents) {
      const row = JSON.parse(contents.toString('utf8'));
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('INVALID_WEALTH');
      wealth = true;
      digests.push(crypto.createHash('sha256').update(contents).digest('hex'));
    }
  } catch (_) {
    blockers.push('ACCOUNT_WEALTH_UNREADABLE_OR_INVALID');
  }
  return {
    profileDirectory: state, profileCount, wealthPresent: wealth,
    // Fingerprint can be compared before/after a future authorized cutover.
    // No account names, wealth amounts or raw values are printed.
    fingerprintSha256: crypto.createHash('sha256').update(digests.join('|')).digest('hex')
  };
}

export function inspectWriterPreflight(options = {}) {
  const stateRoot = path.resolve(options.stateRoot || 'D:/ALBot/state');
  const telemetryRoot = path.resolve(options.telemetryRoot || 'D:/ALBot/telemetry');
  const blockers = [];
  const rootState = directoryState(stateRoot);
  if (rootState !== 'PRESENT') blockers.push('STATE_DIRECTORY_' + rootState);
  const owner = readMarker(path.join(stateRoot, 'writer-owner.json'),
    ['node', 'bridge'], blockers, 'WRITER_OWNER');

  let lease = null;
  const leasePath = path.join(stateRoot, 'writer-lease.json');
  try {
    const raw = readRegularFile(leasePath, MAX_MARKER_BYTES);
    if (raw) {
      lease = JSON.parse(raw.toString('utf8'));
      if (lease.schemaVersion !== 1 || !['node', 'bridge'].includes(lease.owner)
          || typeof lease.token !== 'string' || !lease.token) {
        blockers.push('WRITER_LEASE_INVALID');
      } else {
        blockers.push('WRITER_LEASE_PRESENT_ACTIVE_OR_STALE');
        if (owner && lease.owner !== owner.owner) blockers.push('WRITER_OWNER_LEASE_CONFLICT');
      }
    }
  } catch (_) {
    blockers.push('WRITER_LEASE_UNREADABLE_OR_UNSAFE');
  }
  const account = summarizeAccountFiles(stateRoot, blockers);
  const telemetry = {
    root: directoryState(telemetryRoot),
    raw: directoryState(path.join(telemetryRoot, 'raw')),
    daily: directoryState(path.join(telemetryRoot, 'daily'))
  };
  if (Object.values(telemetry).some(x => x === 'UNSAFE' || x === 'UNREADABLE')) {
    blockers.push('TELEMETRY_PATH_UNSAFE');
  }
  return {
    schemaVersion: 1, readOnly: true, cutoverAuthorized: false,
    assessment: blockers.length ? 'BLOCKED' : 'MANUAL_VERIFICATION_REQUIRED',
    owner: owner?.owner || null, leasePresent: lease !== null,
    account, telemetry, blockers,
    nextGate: 'EXPLICIT_NODE_SHUTDOWN_BACKUP_SINGLE_WRITER_PROOF_AND_MANUAL_AUTHORIZATION_REQUIRED',
    note: 'Absence of a lease or an open TCP port never proves that an uninstrumented writer is stopped.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = inspectWriterPreflight({
      stateRoot: process.argv[2], telemetryRoot: process.argv[3]
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.blockers.length ? 2 : 1;
  } catch (error) {
    console.error('SSD_PREFLIGHT_UNVERIFIED:', String(error?.message || error));
    process.exitCode = 2;
  }
}
