import test from 'node:test';
import assert from 'node:assert/strict';
import {
  H22HostWatchdogSupervisor,
  HOST_RESTART_ACK,
  HOST_BEACON_TYPE
} from '../host/h22-host-watchdog.mjs';

function beacon(name, now, options = {}) {
  const leaseMs = options.leaseMs || 5000;
  return {
    schemaVersion: 1,
    type: HOST_BEACON_TYPE,
    runId: options.runId || name + '-run-1',
    seq: options.seq || 1,
    at: now,
    leaseMs,
    deadlineAt: now + leaseMs,
    character: { name, ctype: options.ctype || 'ranger', map: 'main', rip: false },
    health: { state: options.healthState || 'HEALTHY', verdict: options.verdict || 'PASS', reasons: [] },
    contract: {
      externalDeadManRequired: true,
      hostOwnsRestart: true,
      authenticationOwnedByHost: true,
      actionAuthority: false,
      gameplayActionAuthority: false
    }
  };
}

test('H22 host watchdog accepts four fresh beacons and stays HEALTHY without restart authority', async () => {
  let now = 1000;
  let restarts = 0;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A', 'B', 'C', 'D'],
    startupGraceMs: 5000,
    restartProcess: async () => { restarts += 1; }
  });

  for (const name of ['A', 'B', 'C', 'D']) {
    const result = watchdog.acceptBeacon(beacon(name, now));
    assert.equal(result.accepted, true);
  }
  const status = await watchdog.tick();
  assert.equal(status.state, 'HEALTHY');
  assert.equal(status.reason, 'ALL_BEACONS_FRESH');
  assert.equal(status.restartEnabled, false);
  assert.equal(status.gameplayActionAuthority, false);
  assert.equal(restarts, 0);
});

test('H22 host watchdog rejects replayed sequence numbers within the same run', () => {
  const watchdog = new H22HostWatchdogSupervisor({ now: () => 1000, expectedCharacters: ['A'] });
  assert.equal(watchdog.acceptBeacon(beacon('A', 1000, { seq: 3 })).accepted, true);
  const replay = watchdog.acceptBeacon(beacon('A', 1000, { seq: 3 }));
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, 'BEACON_REPLAY');
  assert.equal(watchdog.status().stats.replayedBeacons, 1);

  const newRun = watchdog.acceptBeacon(beacon('A', 1000, { runId: 'A-run-2', seq: 1 }));
  assert.equal(newRun.accepted, true);
  assert.equal(newRun.newRun, true);
});

test('H22 host watchdog rejects invalid authority contracts and unexpected characters', () => {
  const watchdog = new H22HostWatchdogSupervisor({ now: () => 1000, expectedCharacters: ['A'] });
  const invalid = beacon('A', 1000);
  invalid.contract.gameplayActionAuthority = true;
  assert.equal(watchdog.acceptBeacon(invalid).reason, 'BEACON_AUTHORITY_INVALID');

  const unexpected = watchdog.acceptBeacon(beacon('B', 1000));
  assert.equal(unexpected.accepted, false);
  assert.equal(unexpected.reason, 'BEACON_CHARACTER_NOT_EXPECTED');
});

test('H22 restart authority is disabled by default and requires exact acknowledgement', async () => {
  let now = 1000;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A'],
    startupGraceMs: 5000,
    restartDelayMs: 1000,
    restartProcess: async () => true
  });
  assert.equal(watchdog.configure({ enabled: true, ack: 'wrong' }).accepted, false);
  now = 8000;
  const blocked = await watchdog.tick();
  assert.equal(blocked.state, 'RESTART_REQUIRED');
  assert.equal(blocked.reason, 'RESTART_AUTHORITY_DISABLED');

  const enabled = watchdog.configure({ enabled: true, ack: HOST_RESTART_ACK, reason: 'test' });
  assert.equal(enabled.accepted, true);
  assert.equal(enabled.restartAuthority, 'process-only');
});

test('H22 dead-man restarts only one stale character per tick and never grants gameplay authority', async () => {
  let now = 1000;
  const calls = [];
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A', 'B'],
    startupGraceMs: 5000,
    restartDelayMs: 1000,
    restartCooldownMs: 5000,
    maxRestartsPerWindow: 3,
    restartProcess: async context => {
      calls.push(context);
      return { ok: true };
    }
  });
  watchdog.configure({ enabled: true, ack: HOST_RESTART_ACK });
  watchdog.acceptBeacon(beacon('A', now, { leaseMs: 3000 }));
  watchdog.acceptBeacon(beacon('B', now, { leaseMs: 3000 }));

  now = 6001;
  const first = await watchdog.tick();
  assert.equal(first.state, 'RESTARTING');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].character, 'A');
  assert.equal(calls[0].restartAuthority, 'process-only');
  assert.equal(calls[0].gameplayActionAuthority, false);

  const afterFirst = watchdog.status();
  const a = afterFirst.characters.find(row => row.name === 'A');
  assert.equal(a.deadman.dead, false);
  assert.equal(a.deadman.state, 'STARTING');

  const second = await watchdog.tick();
  assert.equal(second.state, 'RESTARTING');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].character, 'B');
});

test('H22 restart budget opens a circuit instead of looping forever', async () => {
  let now = 1000;
  let restarts = 0;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A'],
    startupGraceMs: 5000,
    restartDelayMs: 1000,
    restartCooldownMs: 5000,
    restartWindowMs: 60000,
    maxRestartsPerWindow: 1,
    restartProcess: async () => { restarts += 1; return true; }
  });
  watchdog.configure({ enabled: true, ack: HOST_RESTART_ACK });
  watchdog.acceptBeacon(beacon('A', now, { leaseMs: 3000 }));

  now = 6001;
  assert.equal((await watchdog.tick()).state, 'RESTARTING');
  assert.equal(restarts, 1);

  now = 12050;
  const circuit = await watchdog.tick();
  assert.equal(circuit.state, 'CIRCUIT_OPEN');
  assert.equal(circuit.reason, 'RESTART_BUDGET_EXHAUSTED');
  assert.equal(restarts, 1);
});

test('H22 failed restart is surfaced and not hidden as healthy', async () => {
  let now = 1000;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A'],
    startupGraceMs: 5000,
    restartDelayMs: 1000,
    restartProcess: async () => ({ ok: false })
  });
  watchdog.configure({ enabled: true, ack: HOST_RESTART_ACK });
  now = 8000;
  const status = await watchdog.tick();
  assert.equal(status.state, 'RESTART_FAILED');
  assert.equal(status.reason, 'PROCESS_RESTART_FAILED');
  assert.equal(status.stats.restartFailures, 1);
});

test('H22 retired run IDs cannot reclaim the lease after a newer process run is accepted', () => {
  let now = 1000;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A']
  });

  assert.equal(watchdog.acceptBeacon(beacon('A', now, { runId: 'A-run-1', seq: 7 })).accepted, true);

  now = 1100;
  const replacement = watchdog.acceptBeacon(beacon('A', now, { runId: 'A-run-2', seq: 1 }));
  assert.equal(replacement.accepted, true);
  assert.equal(replacement.newRun, true);

  now = 1200;
  const delayedOldRun = watchdog.acceptBeacon(beacon('A', now, { runId: 'A-run-1', seq: 8 }));
  assert.equal(delayedOldRun.accepted, false);
  assert.equal(delayedOldRun.reason, 'BEACON_RETIRED_RUN');

  const status = watchdog.status();
  const a = status.characters.find(row => row.name === 'A');
  assert.equal(a.lastRunId, 'A-run-2');
  assert.equal(a.retiredRunCount, 1);
  assert.equal(status.stats.retiredRunRejects, 1);
  assert.equal(status.policies.retiredRunIdsRejected, true);
});

test('H22 successful restart retires the old run so delayed beacons cannot renew it', async () => {
  let now = 1000;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A'],
    startupGraceMs: 5000,
    restartDelayMs: 1000,
    restartProcess: async () => true
  });
  watchdog.configure({ enabled: true, ack: HOST_RESTART_ACK });
  assert.equal(watchdog.acceptBeacon(beacon('A', now, { runId: 'A-run-1', leaseMs: 3000 })).accepted, true);

  now = 5001;
  assert.equal((await watchdog.tick()).state, 'RESTARTING');

  now = 5100;
  const delayed = watchdog.acceptBeacon(beacon('A', now, { runId: 'A-run-1', seq: 2, leaseMs: 3000 }));
  assert.equal(delayed.accepted, false);
  assert.equal(delayed.reason, 'BEACON_RETIRED_RUN');
  assert.equal(watchdog.status().characters[0].deadman.state, 'STARTING');
});

test('H22 lease expiry is computed from host receipt time even when browser clock is far behind', async () => {
  let hostNow = 100000;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => hostNow,
    expectedCharacters: ['A'],
    restartDelayMs: 1000
  });

  const staleBrowserClockBeacon = beacon('A', 1000, {
    runId: 'A-run-1',
    seq: 1,
    leaseMs: 5000
  });
  const accepted = watchdog.acceptBeacon(staleBrowserClockBeacon);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.reportedDeadlineAt, 6000);
  assert.equal(accepted.hostDeadlineAt, 105000);

  let status = await watchdog.tick();
  assert.equal(status.state, 'HEALTHY');
  let a = status.characters.find(row => row.name === 'A');
  assert.equal(a.lastReportedDeadlineAt, 6000);
  assert.equal(a.lastDeadlineAt, 105000);

  hostNow = 104999;
  status = await watchdog.tick();
  assert.equal(status.state, 'HEALTHY');

  hostNow = 105001;
  status = await watchdog.tick();
  a = status.characters.find(row => row.name === 'A');
  assert.equal(a.deadman.dead, true);
  assert.equal(a.deadman.reason, 'BEACON_DEADLINE_MISSED');
  assert.equal(status.policies.leaseExpiryUsesHostReceiptClock, true);
});

test('H22 newly configured expected characters receive their own startup grace', async () => {
  let now = 1000;
  let restarts = 0;
  const watchdog = new H22HostWatchdogSupervisor({
    now: () => now,
    expectedCharacters: ['A'],
    startupGraceMs: 5000,
    restartDelayMs: 1000,
    restartProcess: async () => { restarts += 1; return true; }
  });
  watchdog.configure({ enabled: true, ack: HOST_RESTART_ACK });
  assert.equal(watchdog.acceptBeacon(beacon('A', now)).accepted, true);

  now = 100000;
  assert.equal(watchdog.acceptBeacon(beacon('A', now, { seq: 2 })).accepted, true);
  const reconfigured = watchdog.configure({
    expectedCharacters: ['A', 'B'],
    enabled: true,
    ack: HOST_RESTART_ACK
  });
  assert.equal(reconfigured.accepted, true);

  let status = await watchdog.tick();
  const bDuringGrace = status.characters.find(row => row.name === 'B');
  assert.equal(bDuringGrace.deadman.dead, false);
  assert.equal(bDuringGrace.deadman.state, 'STARTING');
  assert.equal(bDuringGrace.deadman.deadlineAt, 105000);
  assert.equal(restarts, 0);

  now = 104999;
  status = await watchdog.tick();
  assert.equal(status.characters.find(row => row.name === 'B').deadman.state, 'STARTING');
  assert.equal(restarts, 0);

  now = 106001;
  status = await watchdog.tick();
  assert.equal(status.state, 'RESTARTING');
  assert.equal(restarts, 1);
  assert.equal(status.policies.perCharacterStartupGrace, true);
});

test('H22 host watchdog status explicitly forbids gameplay and code-repair authority', () => {
  const watchdog = new H22HostWatchdogSupervisor({ expectedCharacters: ['A'] });
  const status = watchdog.status();
  assert.equal(status.policies.gameplayActionAuthority, false);
  assert.equal(status.policies.codeRepairAuthority, false);
  assert.equal(status.policies.chatgptRequiredForNormalOperation, false);
  assert.equal(status.rawGameplayActionAuthority, false);
});
