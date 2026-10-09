/*
 * ALFinal browser-side SSD migration witness.
 * Read-only DevTools utility. It does not call ALBot, click any control,
 * mutate a character, call localStorage.setItem/removeItem, or transmit data.
 * Run separately in each owned Adventure Land window to verify its context.
 */
(async () => {
  'use strict';
  const report = {
    schemaVersion: 1,
    readOnly: true,
    liveMutationPerformed: false,
    cutoverAuthorized: false,
    snapshotTime: new Date().toISOString(),
    verified: false,
    issue: null,
    storageKeyCount: 0,
    stop: { found: false, latched: null, valid: false },
    h19: { pendingCount: 0, unknownCount: 0, policyCount: 0 },
    h25: { handoffCount: 0 },
    fingerprints: []
  };
  const MAX_KEYS = 2000;
  const MAX_VALUE_CHARS = 3 * 1024 * 1024;
  const encoder = new TextEncoder();
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
  async function digest(value) {
    if (!cryptoApi || !cryptoApi.subtle) throw new Error('HASH_UNAVAILABLE');
    const buffer = await cryptoApi.subtle.digest('SHA-256', encoder.encode(value));
    return Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, '0')).join('');
  }
  try {
    if (typeof window === 'undefined' || !window.localStorage) throw new Error('BROWSER_STORAGE_UNAVAILABLE');
    const storage = window.localStorage;
    const count = storage.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_KEYS) throw new Error('BROWSER_STORAGE_KEY_LIMIT');
    report.storageKeyCount = count;
    for (let index = 0; index < count; index += 1) {
      const key = storage.key(index);
      if (typeof key !== 'string') throw new Error('BROWSER_STORAGE_ENUMERATION_FAILED');
      const kind = key === 'albot:emergency-stop:v1' ? 'stop'
        : key.startsWith('albot:h19:pending:') ? 'h19-pending'
          : key.startsWith('albot:h19:policy:') ? 'h19-policy'
            : key.startsWith('albot:h25:') ? 'h25-handoff' : null;
      if (!kind) continue;
      const value = storage.getItem(key);
      if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) {
        throw new Error('BROWSER_SAFETY_RECORD_UNREADABLE');
      }
      // This hash allows before/after comparison without revealing the key
      // (which may contain character names), pending target, or stored value.
      const contentHash = await digest(kind + ':' + key + '\n' + value);
      report.fingerprints.push({ group: kind, sha256: contentHash, bytes: encoder.encode(value).byteLength });
      if (kind === 'stop') {
        const row = JSON.parse(value);
        if (!row || typeof row.latched !== 'boolean') throw new Error('BROWSER_STOP_RECORD_INVALID');
        report.stop = { found: true, latched: row.latched, valid: true };
      }
      if (kind === 'h19-pending') {
        const row = JSON.parse(value);
        if (!row || typeof row !== 'object' || typeof row.id !== 'string'
            || typeof row.kind !== 'string') throw new Error('BROWSER_PENDING_RECORD_INVALID');
        report.h19.pendingCount += 1;
        if (row.unknownRecorded === true) report.h19.unknownCount += 1;
      }
      if (kind === 'h19-policy') report.h19.policyCount += 1;
      if (kind === 'h25-handoff') report.h25.handoffCount += 1;
    }
    report.fingerprints.sort((a, b) =>
      a.group.localeCompare(b.group) || a.sha256.localeCompare(b.sha256));
    report.verified = true;
  } catch (error) {
    // Fail closed and never emit half-complete hashes as success evidence.
    report.verified = false;
    report.issue = 'BROWSER_SAFETY_EVIDENCE_UNVERIFIED';
    report.fingerprints = [];
    report.stop = { found: false, latched: null, valid: false };
  }
  // No raw localStorage keys/values, character IDs, or runtime tokens printed.
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
