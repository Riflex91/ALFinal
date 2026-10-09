import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspectWriterPreflight } from './ssd-writer-preflight.mjs';

// Offline COPY ONLY. This tool cannot change writer-owner.json or enable a
// Bridge endpoint. A clean read-only preflight is not proof that every legacy
// (possibly uninstrumented) writer has been stopped.
const MAX_FILES = 30_000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RAW_FILE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_FILE_BYTES = 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^(?:[01]\d|2[0-3])$/;
const SAFE_FILE = /^[a-zA-Z0-9._-]{1,100}$/;

function verifiedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('BACKUP_UNSAFE_DIRECTORY');
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function addFile(files, source, logicalPath, limit) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
    throw new Error('BACKUP_UNSAFE_SOURCE_FILE');
  }
  if (stat.size < 0) throw new Error('BACKUP_INVALID_FILE_SIZE');
  files.push({ source, logicalPath, size: stat.size });
}

function inventory(stateRoot, telemetryRoot) {
  const files = [];
  const profiles = path.join(stateRoot, 'account-profiles');
  for (const entry of verifiedDirectory(profiles)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')
        || !SAFE_FILE.test(entry.name.slice(0, -5))) {
      throw new Error('BACKUP_UNEXPECTED_ACCOUNT_ENTRY');
    }
    addFile(files, path.join(profiles, entry.name),
      'account/account-profiles/' + entry.name, MAX_JSON_FILE_BYTES);
  }
  if (files.length > 64) throw new Error('BACKUP_TOO_MANY_ACCOUNT_PROFILES');

  const wealth = path.join(stateRoot, 'account-wealth.json');
  if (fs.existsSync(wealth)) {
    addFile(files, wealth, 'account/account-wealth.json', MAX_JSON_FILE_BYTES);
  }

  for (const category of ['raw', 'daily']) {
    const root = path.join(telemetryRoot, category);
    for (const day of verifiedDirectory(root)) {
      if (!day.isDirectory() || !DATE.test(day.name)) throw new Error('BACKUP_UNEXPECTED_TELEMETRY_DAY');
      const dayDir = path.join(root, day.name);
      if (category === 'raw') {
        for (const hour of verifiedDirectory(dayDir)) {
          if (!hour.isDirectory() || !HOUR.test(hour.name)) throw new Error('BACKUP_UNEXPECTED_TELEMETRY_HOUR');
          for (const row of verifiedDirectory(path.join(dayDir, hour.name))) {
            if (!row.isFile() || !row.name.endsWith('.ndjson')
                || !SAFE_FILE.test(row.name.slice(0, -7))) {
              throw new Error('BACKUP_UNEXPECTED_RAW_FILE');
            }
            addFile(files, path.join(dayDir, hour.name, row.name),
              'telemetry/raw/' + day.name + '/' + hour.name + '/' + row.name,
              MAX_RAW_FILE_BYTES);
          }
        }
      } else {
        for (const row of verifiedDirectory(dayDir)) {
          if (!row.isFile() || !row.name.endsWith('.json')
              || !SAFE_FILE.test(row.name.slice(0, -5))) {
            throw new Error('BACKUP_UNEXPECTED_DAILY_FILE');
          }
          addFile(files, path.join(dayDir, row.name),
            'telemetry/daily/' + day.name + '/' + row.name, MAX_JSON_FILE_BYTES);
        }
      }
    }
  }
  files.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath, 'en'));
  if (files.length > MAX_FILES || files.reduce((n, x) => n + x.size, 0) > MAX_TOTAL_BYTES) {
    throw new Error('BACKUP_LIMIT_EXCEEDED');
  }
  return files;
}

function sha256(filename) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const block = Buffer.allocUnsafe(64 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, block, 0, block.length, null)) !== 0) {
      hash.update(block.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function separated(a, b) {
  const x = path.resolve(a).toLowerCase();
  const y = path.resolve(b).toLowerCase();
  return x !== y && !x.startsWith(y + path.sep) && !y.startsWith(x + path.sep);
}

function checkOffline(stateRoot, telemetryRoot) {
  const check = inspectWriterPreflight({ stateRoot, telemetryRoot });
  if (check.owner !== 'node'
      || check.leasePresent
      || check.blockers.length
      || check.assessment !== 'MANUAL_VERIFICATION_REQUIRED') {
    throw new Error('BACKUP_PREFLIGHT_NOT_CLEAN');
  }
  return check;
}

function durableWrite(filename, contents) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function createOfflineCutoverBackup(options = {}) {
  if (options.confirmedStopped !== true) throw new Error('BACKUP_OPERATOR_STOP_CONFIRMATION_REQUIRED');
  if (!options.stateRoot || !options.telemetryRoot || !options.destinationRoot) {
    throw new Error('BACKUP_EXPLICIT_PATHS_REQUIRED');
  }
  const stateRoot = path.resolve(options.stateRoot);
  const telemetryRoot = path.resolve(options.telemetryRoot);
  const destinationRoot = path.resolve(options.destinationRoot);
  if (!separated(stateRoot, telemetryRoot)
      || !separated(destinationRoot, stateRoot)
      || !separated(destinationRoot, telemetryRoot)) {
    throw new Error('BACKUP_DESTINATION_OVERLAPS_SOURCE');
  }
  if (fs.existsSync(destinationRoot)) throw new Error('BACKUP_DESTINATION_EXISTS');
  const parent = path.dirname(destinationRoot);
  verifiedDirectory(parent); // Parent must exist and cannot be a symlink.
  const before = checkOffline(stateRoot, telemetryRoot);
  const files = inventory(stateRoot, telemetryRoot);

  // Nothing changes in account/telemetry roots. The only writes occur in a
  // fresh external destination; partial/failed backups are never deleted.
  fs.mkdirSync(destinationRoot);
  durableWrite(path.join(destinationRoot, 'INCOMPLETE'),
    'Do not use this backup unless manifest.json exists and INCOMPLETE is absent.\n');

  const manifestFiles = [];
  for (const file of files) {
    const target = path.join(destinationRoot, ...file.logicalPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sourceBefore = sha256(file.source);
    fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
    const copyHash = sha256(target);
    const sourceAfter = sha256(file.source);
    const originalSize = fs.lstatSync(file.source).size;
    if (sourceBefore !== copyHash || sourceAfter !== copyHash || originalSize !== file.size
        || fs.lstatSync(target).size !== file.size) {
      throw new Error('BACKUP_SOURCE_CHANGED_DURING_COPY');
    }
    // Manifest paths and hashes are local operator evidence; stdout contains
    // only aggregate counts and hashes, never character names or gold values.
    manifestFiles.push({ path: file.logicalPath, bytes: file.size, sha256: copyHash });
  }

  const after = checkOffline(stateRoot, telemetryRoot);
  const refreshed = inventory(stateRoot, telemetryRoot);
  if (after.account.fingerprintSha256 !== before.account.fingerprintSha256
      || JSON.stringify(files.map(x => [x.logicalPath, x.size]))
          !== JSON.stringify(refreshed.map(x => [x.logicalPath, x.size]))) {
    throw new Error('BACKUP_SOURCE_INVENTORY_CHANGED');
  }
  // Final source hash validation also detects same-size in-place mutations.
  for (const file of manifestFiles) {
    const source = file.path.startsWith('account/')
      ? path.join(stateRoot, ...file.path.slice('account/'.length).split('/'))
      : path.join(telemetryRoot, ...file.path.slice('telemetry/'.length).split('/'));
    if (sha256(source) !== file.sha256) throw new Error('BACKUP_SOURCE_CHANGED_AFTER_COPY');
  }

  const manifest = {
    schemaVersion: 1,
    scope: 'account-and-telemetry-only',
    completedAt: new Date().toISOString(),
    originalOwner: 'node',
    cutoverAuthorized: false,
    sourceAccountFingerprintSha256: before.account.fingerprintSha256,
    fileCount: manifestFiles.length,
    totalBytes: manifestFiles.reduce((sum, f) => sum + f.bytes, 0),
    files: manifestFiles
  };
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  durableWrite(path.join(destinationRoot, 'manifest.json'), serialized);
  fs.unlinkSync(path.join(destinationRoot, 'INCOMPLETE'));
  return {
    backupComplete: true, cutoverAuthorized: false,
    destinationRoot, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes,
    manifestSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    nextGate: 'MANUAL_RECONCILIATION_AND_SINGLE_WRITER_CUTOVER_REVIEW_REQUIRED'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[5] !== '--confirm-stopped') {
      throw new Error('Usage: node scripts/ssd-cutover-backup.mjs <stateRoot> <telemetryRoot> <newDestinationRoot> --confirm-stopped');
    }
    console.log(JSON.stringify(createOfflineCutoverBackup({
      stateRoot: process.argv[2], telemetryRoot: process.argv[3],
      destinationRoot: process.argv[4], confirmedStopped: true
    }), null, 2));
  } catch (error) {
    console.error('SSD_CUTOVER_BACKUP_BLOCKED:', String(error?.message || error));
    process.exitCode = 2;
  }
}
