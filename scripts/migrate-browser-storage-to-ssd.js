// Run once in Adventure Land DevTools AFTER the upgraded Windows host is
// running. Copies owned bot keys to SSD and verifies them; NEVER deletes data.
(async () => {
  'use strict';
  const prefix = 'http://127.0.0.1:17392/v1/storage?key=';
  const allowed = key => key.startsWith('albot:')
    || key === 'aio-v3-content-drift-v1'
    || key.startsWith('aio-v3-content-drift-v1:')
    || key === 'cstore_AIO_V3_WORLD_MODEL';
  const skip = key => key.startsWith('albot:h25:autonomy-handoff:');
  const seen = new WeakSet();
  let store = null;
  function find(w, depth = 0) {
    if (!w || seen.has(w) || depth > 6 || store) return;
    seen.add(w);
    try {
      const bot = w.ALBot;
      if (bot && bot.__runtime && bot.__runtime.storage) {
        const shared = bot.__runtime.storage._sharedLs?.();
        if (shared) { store = shared; return; }
      }
      w.document.querySelectorAll('iframe').forEach(el => {
        try { find(el.contentWindow, depth + 1); } catch (_) {}
      });
    } catch (_) {}
  }
  find(window);
  if (!store) throw new Error('ALBOT_BROWSER_STORAGE_NOT_FOUND');
  const response = await fetch('http://127.0.0.1:17392/health',
    { cache: 'no-store', credentials: 'omit' });
  if (!response.ok || !(await response.json()).durableStore) {
    throw new Error('SSD_HOST_UPGRADE_REQUIRED');
  }
  const rows = [];
  const entries = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (typeof key === 'string' && allowed(key) && !skip(key)) {
      const value = store.getItem(key);
      if (typeof value === 'string') entries.push({ key, value });
    }
  }
  for (const { key, value } of entries) {
    const url = prefix + encodeURIComponent(key);
    try {
      const before = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!before.ok) throw new Error('SSD_READ_HTTP_' + before.status);
      const existing = await before.json();
      if (!existing.ok) throw new Error('SSD_READ_REJECTED');
      let state = 'SKIPPED_EXISTING';
      if (existing.found) {
        if (existing.value !== value) state = 'CONFLICT_REVIEW_REQUIRED';
        else state = 'VERIFIED_EXISTING';
      } else {
        const put = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ key, value }),
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!put.ok || !(await put.json()).ok) {
          throw new Error('SSD_WRITE_HTTP_' + put.status);
        }
        const verify = await fetch(url, { cache: 'no-store', credentials: 'omit' });
        if (!verify.ok) throw new Error('SSD_VERIFY_HTTP_' + verify.status);
        const check = await verify.json();
        if (!check.ok || !check.found || check.value !== value) {
          throw new Error('SSD_VERIFY_MISMATCH');
        }
        state = 'COPIED_AND_VERIFIED';
      }
      rows.push({ group: key.startsWith('albot:') ? 'ALFinal' : 'AIO-V3',
        kib: Math.round(value.length * 2 / 1024), state });
    } catch (error) {
      rows.push({ group: key.startsWith('albot:') ? 'ALFinal' : 'AIO-V3',
        kib: Math.round(value.length * 2 / 1024),
        state: String(error && error.message || error).slice(0, 120) });
    }
  }
  const report = {
    scannedKeys: store.length,
    selectedKeys: entries.length,
    copied: rows.filter(row => row.state === 'COPIED_AND_VERIFIED').length,
    verifiedExisting: rows.filter(row => row.state === 'VERIFIED_EXISTING').length,
    conflicts: rows.filter(row => row.state === 'CONFLICT_REVIEW_REQUIRED').length,
    failures: rows.filter(row => !['COPIED_AND_VERIFIED','VERIFIED_EXISTING',
      'CONFLICT_REVIEW_REQUIRED'].includes(row.state)).length,
    browserKeysDeleted: 0,
    rows
  };
  console.log('ALBOT SSD BACKUP REPORT:');
  console.table(rows);
  console.log({ ...report, rows: undefined });
  window.__ALBOT_SSD_BACKUP_REPORT__ = report;
})();
