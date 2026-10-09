import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWriterPreflight } from '../scripts/ssd-writer-preflight.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-readonly-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const telemetryRoot = path.join(root, 'telemetry');
  fs.mkdirSync(path.join(stateRoot, 'account-profiles'), { recursive: true });
  fs.mkdirSync(path.join(telemetryRoot, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(telemetryRoot, 'daily'), { recursive: true });
  return { root, stateRoot, telemetryRoot, report: () => inspectWriterPreflight({ stateRoot, telemetryRoot }) };
}

test('preflight never creates directories or authorizes ownership', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-preflight-absent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'missing');
  const telemetryRoot = path.join(root, 'missing-telemetry');
  const value = inspectWriterPreflight({ stateRoot, telemetryRoot });
  assert.equal(value.readOnly, true);
  assert.equal(value.cutoverAuthorized, false);
  assert.equal(value.assessment, 'BLOCKED');
  assert.ok(value.blockers.includes('STATE_DIRECTORY_MISSING'));
  assert.ok(value.blockers.includes('WRITER_OWNER_MISSING'));
  assert.equal(fs.existsSync(stateRoot), false);
});

test('node ownership without a lease is only evidence, never cutover permission', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"node"}');
  const file = path.join(f.stateRoot, 'account-profiles', 'My_Merchant.json');
  fs.writeFileSync(file, '{"name":"My_Merchant","gold":123}');
  fs.writeFileSync(path.join(f.stateRoot, 'account-wealth.json'), '{"gold":456}');
  const before = fs.readFileSync(file, 'utf8');
  const value = f.report();
  assert.equal(value.assessment, 'MANUAL_VERIFICATION_REQUIRED');
  assert.equal(value.cutoverAuthorized, false);
  assert.equal(value.owner, 'node');
  assert.equal(value.leasePresent, false);
  assert.equal(value.account.profileCount, 1);
  assert.equal(value.account.wealthPresent, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const displayed = JSON.stringify(value);
  assert.ok(!displayed.includes('My_Merchant'));
  assert.ok(!displayed.includes('"gold"'));
  assert.equal(f.report().account.fingerprintSha256, value.account.fingerprintSha256);
  fs.writeFileSync(file, '{"name":"My_Merchant","gold":124}');
  assert.notEqual(f.report().account.fingerprintSha256, value.account.fingerprintSha256);
});

test('legacy or stale writer lease blocks cutover checks', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"node"}');
  fs.writeFileSync(path.join(f.stateRoot, 'writer-lease.json'),
    '{"schemaVersion":1,"owner":"node","token":"possibly-stale"}');
  const value = f.report();
  assert.equal(value.assessment, 'BLOCKED');
  assert.ok(value.blockers.includes('WRITER_LEASE_PRESENT_ACTIVE_OR_STALE'));
  assert.equal(value.cutoverAuthorized, false);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'writer-lease.json')), true);
});

test('conflicting writer records are unsafe', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"bridge"}');
  fs.writeFileSync(path.join(f.stateRoot, 'writer-lease.json'),
    '{"schemaVersion":1,"owner":"node","token":"foreign"}');
  const value = f.report();
  assert.ok(value.blockers.includes('WRITER_OWNER_LEASE_CONFLICT'));
  assert.equal(value.cutoverAuthorized, false);
});

test('corrupt profile blocks preflight rather than silently dropping evidence', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stateRoot, 'writer-owner.json'), '{"schemaVersion":1,"owner":"node"}');
  fs.writeFileSync(path.join(f.stateRoot, 'account-profiles', 'My_Mage.json'), '{');
  const value = f.report();
  assert.equal(value.assessment, 'BLOCKED');
  assert.ok(value.blockers.includes('ACCOUNT_PROFILES_UNREADABLE_OR_INVALID'));
});
