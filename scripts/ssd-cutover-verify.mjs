import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Standalone read-only verification, independent of the original source.
// Successful verification never permits changing the writer owner.
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 30_000;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const SAFE_NAME = '[a-zA-Z0-9._-]{1,100}';
const ACCOUNT_PROFILE = new RegExp('^account/account-profiles/' + SAFE_NAME + '\\.json$');
const TELEMETRY_RAW = new RegExp('^telemetry/raw/\\d{4}-\\d{2}-\\d{2}/(?:[01]\\d|2[0-3])/' + SAFE_NAME + '\\.ndjson$');
const TELEMETRY_DAILY = new RegExp('^telemetry/daily/\\d{4}-\\d{2}-\\d{2}/' + SAFE_NAME + '\\.json$');

function safeLogicalPath(value) {
  return typeof value === 'string'
    && (value === 'account/account-wealth.json'
      || ACCOUNT_PROFILE.test(value)
      || TELEMETRY_RAW.test(value)
      || TELEMETRY_DAILY.test(value))
    && !value.split('/').includes('..')
    && !value.split('/').includes('.');
}

function regularFile(filename, maxSize) {
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxSize) {
    throw new Error('BACKUP_VERIFY_UNSAFE_FILE');
  }
  return st;
}

function hashFile(filename) {
  const h = crypto.createHash('sha256');
  const file = fs.openSync(filename, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let count;
    while ((count = fs.readSync(file, chunk, 0, chunk.length, null)) > 0) {
      h.update(chunk.subarray(0, count));
    }
  } finally { fs.closeSync(file); }
  return h.digest('hex');
}

function allPaths(root) {
  const collected = [];
  function visit(directory, prefix = '') {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('BACKUP_VERIFY_UNSAFE_DIRECTORY');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const location = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('BACKUP_VERIFY_SYMLINK');
      if (entry.isDirectory()) {
        visit(location, relative);
      } else if (entry.isFile()) {
        collected.push(relative);
        if (collected.length > MAX_FILES + 1) throw new Error('BACKUP_VERIFY_TOO_MANY_FILES');
      } else {
        throw new Error('BACKUP_VERIFY_UNEXPECTED_ENTRY');
      }
    }
  }
  visit(root);
  return collected.sort();
}

export function verifyOfflineCutoverBackup(backupRoot) {
  if (!backupRoot) throw new Error('BACKUP_VERIFY_PATH_REQUIRED');
  const root = path.resolve(backupRoot);
  const marker = path.join(root, 'INCOMPLETE');
  if (fs.existsSync(marker)) throw new Error('BACKUP_VERIFY_INCOMPLETE');
  const manifestFile = path.join(root, 'manifest.json');
  const stat = regularFile(manifestFile, MAX_MANIFEST_BYTES);
  if (!stat.size) throw new Error('BACKUP_VERIFY_MANIFEST_EMPTY');
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.schemaVersion !== 1
      || manifest?.scope !== 'account-and-telemetry-only'
      || manifest?.cutoverAuthorized !== false
      || manifest?.originalOwner !== 'node'
      || !Array.isArray(manifest.files)
      || !Number.isSafeInteger(manifest.fileCount)
      || manifest.files.length !== manifest.fileCount
      || manifest.fileCount > MAX_FILES) {
    throw new Error('BACKUP_VERIFY_MANIFEST_INVALID');
  }
  let total = 0;
  const expected = new Set(['manifest.json']);
  for (const item of manifest.files) {
    if (!item || !safeLogicalPath(item.path)
        || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || !/^[a-f0-9]{64}$/.test(String(item.sha256 || ''))
        || expected.has(item.path)) {
      throw new Error('BACKUP_VERIFY_ENTRY_INVALID');
    }
    expected.add(item.path);
    total += item.bytes;
    if (total > MAX_BYTES) throw new Error('BACKUP_VERIFY_LIMIT_EXCEEDED');

    let current = root;
    const parts = item.path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      current = path.join(current, parts[i]);
      const sub = fs.lstatSync(current);
      if (!sub.isDirectory() || sub.isSymbolicLink()) {
        throw new Error('BACKUP_VERIFY_UNSAFE_DIRECTORY');
      }
    }
    const file = path.join(current, parts.at(-1));
    const found = regularFile(file, 128 * 1024 * 1024);
    if (found.size !== item.bytes || hashFile(file) !== item.sha256) {
      throw new Error('BACKUP_VERIFY_CHECKSUM_MISMATCH');
    }
  }
  if (manifest.totalBytes !== total) throw new Error('BACKUP_VERIFY_TOTAL_MISMATCH');
  const actual = allPaths(root);
  if (actual.length !== expected.size || actual.some(file => !expected.has(file))) {
    throw new Error('BACKUP_VERIFY_UNEXPECTED_FILE');
  }
  return {
    verified: true, cutoverAuthorized: false,
    fileCount: manifest.fileCount, totalBytes: total,
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    nextGate: 'ISOLATED_RESTORE_TEST_AND_MANUAL_SINGLE_WRITER_CUTOVER_REVIEW_REQUIRED'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(verifyOfflineCutoverBackup(process.argv[2]), null, 2));
  } catch (error) {
    console.error('SSD_CUTOVER_BACKUP_VERIFY_BLOCKED:', String(error?.message || error));
    process.exitCode = 2;
  }
}
