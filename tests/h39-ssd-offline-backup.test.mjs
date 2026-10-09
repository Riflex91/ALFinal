import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOfflineCutoverBackup } from '../scripts/ssd-cutover-backup.mjs';

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-offline-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const telemetryRoot = path.join(root, 'telemetry');
  const raw = path.join(telemetryRoot, 'raw', '2026-10-09', '12');
  const daily = path.join(telemetryRoot, 'daily', '2026-10-09');
  fs.mkdirSync(path.join(stateRoot, 'account-profiles'), { recursive: true });
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(daily, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"node"}');
  fs.writeFileSync(path.join(stateRoot, 'account-profiles', 'My_Mage.json'),
    '{"name":"My_Mage","observedAtMs":200,"gold":100}');
  fs.writeFileSync(path.join(stateRoot, 'account-wealth.json'), '{"gold":100}');
  fs.writeFileSync(path.join(raw, 'My_Mage.ndjson'),
    '{"atMs":1791547200000,"character":{"name":"My_Mage"}}\n');
  fs.writeFileSync(path.join(daily, 'My_Mage.json'),
    '{"schemaVersion":1,"day":"2026-10-09","character":"My_Mage","samples":1}');
  const destinationRoot = path.join(root, 'backup-new');
  return {
    root, stateRoot, telemetryRoot, destinationRoot,
    options: { stateRoot, telemetryRoot, destinationRoot, confirmedStopped: true }
  };
}

test('copy-only snapshot copies exact account and telemetry bytes but never authorizes cutover', t => {
  const f = makeFixture(t);
  const input = fs.readFileSync(path.join(f.stateRoot, 'account-profiles', 'My_Mage.json'));
  const result = createOfflineCutoverBackup(f.options);
  assert.equal(result.backupComplete, true);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.fileCount, 4);
  assert.ok(/^[a-f0-9]{64}$/.test(result.manifestSha256));
  assert.equal(fs.existsSync(path.join(f.destinationRoot, 'INCOMPLETE')), false);
  assert.equal(fs.existsSync(path.join(f.destinationRoot, 'account', 'writer-owner.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.stateRoot, 'account-profiles', 'My_Mage.json')), input);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.destinationRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.scope, 'account-and-telemetry-only');
  assert.equal(manifest.cutoverAuthorized, false);
  assert.equal(manifest.files.length, 4);
  for (const item of manifest.files) {
    const copied = path.join(f.destinationRoot, ...item.path.split('/'));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(copied)).digest('hex'), item.sha256);
  }
  assert.throws(() => createOfflineCutoverBackup(f.options), /BACKUP_DESTINATION_EXISTS/);
});

test('offline backup rejects omitted operator shutdown confirmation without touching destination', t => {
  const f = makeFixture(t);
  assert.throws(() => createOfflineCutoverBackup({ ...f.options, confirmedStopped: false }),
    /BACKUP_OPERATOR_STOP_CONFIRMATION_REQUIRED/);
  assert.equal(fs.existsSync(f.destinationRoot), false);
});

test('active or stale Node writer lease blocks backup creation', t => {
  const f = makeFixture(t);
  fs.writeFileSync(path.join(f.stateRoot, 'writer-lease.json'),
    '{"schemaVersion":1,"owner":"node","token":"possibly-active"}');
  assert.throws(() => createOfflineCutoverBackup(f.options), /BACKUP_PREFLIGHT_NOT_CLEAN/);
  assert.equal(fs.existsSync(f.destinationRoot), false);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'writer-lease.json')), true);
});

test('unexpected telemetry files and destination overlap are rejected', t => {
  const f = makeFixture(t);
  assert.throws(() => createOfflineCutoverBackup({
    ...f.options, destinationRoot: path.join(f.stateRoot, 'backup')
  }), /BACKUP_DESTINATION_OVERLAPS_SOURCE/);
  fs.writeFileSync(path.join(f.telemetryRoot, 'raw', '2026-10-09', '12', 'unexpected.exe'), 'x');
  assert.throws(() => createOfflineCutoverBackup(f.options), /BACKUP_UNEXPECTED_RAW_FILE/);
  assert.equal(fs.existsSync(f.destinationRoot), false);
});

test('a modified source during copy leaves an INCOMPLETE backup and never issues manifest', t => {
  const f = makeFixture(t);
  const originalCopy = fs.copyFileSync;
  let tampered = false;
  fs.copyFileSync = (...args) => {
    originalCopy(...args);
    if (!tampered) {
      tampered = true;
      fs.appendFileSync(args[0], '\nchanged-mid-copy');
    }
  };
  try {
    assert.throws(() => createOfflineCutoverBackup(f.options), /BACKUP_SOURCE_CHANGED_DURING_COPY/);
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.equal(tampered, true);
  assert.equal(fs.existsSync(path.join(f.destinationRoot, 'INCOMPLETE')), true);
  assert.equal(fs.existsSync(path.join(f.destinationRoot, 'manifest.json')), false);
});
