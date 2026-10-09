import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOfflineCutoverBackup } from '../scripts/ssd-cutover-backup.mjs';
import { verifyOfflineCutoverBackup } from '../scripts/ssd-cutover-verify.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-verify-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const telemetryRoot = path.join(root, 'telemetry');
  const destinationRoot = path.join(root, 'backup');
  fs.mkdirSync(path.join(stateRoot, 'account-profiles'), { recursive: true });
  fs.mkdirSync(path.join(telemetryRoot, 'raw', '2026-10-09', '12'), { recursive: true });
  fs.mkdirSync(path.join(telemetryRoot, 'daily', '2026-10-09'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"node"}');
  fs.writeFileSync(path.join(stateRoot, 'account-profiles', 'Mage.json'), '{"name":"Mage"}');
  fs.writeFileSync(path.join(telemetryRoot, 'raw', '2026-10-09', '12', 'Mage.ndjson'), '{"atMs":1791547200000}\n');
  fs.writeFileSync(path.join(telemetryRoot, 'daily', '2026-10-09', 'Mage.json'),
    '{"day":"2026-10-09","character":"Mage","samples":1}');
  const created = createOfflineCutoverBackup({
    stateRoot, telemetryRoot, destinationRoot, confirmedStopped: true
  });
  return { root, stateRoot, telemetryRoot, destinationRoot, created };
}

test('independent verifier rehashes every file from manifest and denies cutover', t => {
  const f = fixture(t);
  const result = verifyOfflineCutoverBackup(f.destinationRoot);
  assert.equal(result.verified, true);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.fileCount, f.created.fileCount);
  assert.equal(result.manifestSha256, f.created.manifestSha256);
});

test('tampered backup data fails audit without writing to the sources', t => {
  const f = fixture(t);
  const source = path.join(f.stateRoot, 'account-profiles', 'Mage.json');
  const sourceBefore = fs.readFileSync(source, 'utf8');
  const backup = path.join(f.destinationRoot, 'account', 'account-profiles', 'Mage.json');
  fs.writeFileSync(backup, '{"name":"Fake"}');
  assert.throws(() => verifyOfflineCutoverBackup(f.destinationRoot), /BACKUP_VERIFY_CHECKSUM_MISMATCH/);
  assert.equal(fs.readFileSync(source, 'utf8'), sourceBefore);
});

test('incomplete marker or unexpected extra file blocks verification', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.destinationRoot, 'INCOMPLETE'), 'uncertain');
  assert.throws(() => verifyOfflineCutoverBackup(f.destinationRoot), /BACKUP_VERIFY_INCOMPLETE/);
  fs.unlinkSync(path.join(f.destinationRoot, 'INCOMPLETE'));
  fs.writeFileSync(path.join(f.destinationRoot, 'untracked.txt'), 'untrusted');
  assert.throws(() => verifyOfflineCutoverBackup(f.destinationRoot), /BACKUP_VERIFY_UNEXPECTED_FILE/);
});

test('manifest cannot traverse outside the backup root', t => {
  const f = fixture(t);
  const manifestFile = path.join(f.destinationRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files[0].path = '../../state/writer-owner.json';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => verifyOfflineCutoverBackup(f.destinationRoot), /BACKUP_VERIFY_ENTRY_INVALID/);
});

test('a forged cutover authorization flag is never accepted', t => {
  const f = fixture(t);
  const manifestFile = path.join(f.destinationRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.cutoverAuthorized = true;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => verifyOfflineCutoverBackup(f.destinationRoot), /BACKUP_VERIFY_MANIFEST_INVALID/);
});
