import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { DurableKeyStore } from './durable-storage.mjs';

const DEFAULT_ROOT = process.env.ALBOT_TELEMETRY_ROOT || 'D:/ALBot/telemetry';
const DEFAULT_STATE_ROOT = process.env.ALBOT_STATE_ROOT || 'D:/ALBot/state';
const DEFAULT_HOST = process.env.ALBOT_TELEMETRY_HOST || '127.0.0.1';
const DEFAULT_PORT = Math.max(1, Math.min(65535, Number(process.env.ALBOT_TELEMETRY_PORT) || 17391));
const RAW_RETENTION_DAYS = Math.max(1, Number(process.env.ALBOT_TELEMETRY_RAW_DAYS) || 30);
const DAILY_RETENTION_DAYS = Math.max(30, Number(process.env.ALBOT_TELEMETRY_DAILY_DAYS) || 1095);
const MAX_BODY_BYTES = 512 * 1024;

function safeName(value, fallback = 'unknown') {
  const text = String(value == null ? '' : value).trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100);
  return text || fallback;
}
function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function hourOf(ms) { return new Date(ms).toISOString().slice(11, 13); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function within(root, target) {
  const a = path.resolve(root).toLowerCase();
  const b = path.resolve(target).toLowerCase();
  return b === a || b.startsWith(a + path.sep.toLowerCase());
}

export class TelemetryStore {
  constructor(options = {}) {
    this.root = path.resolve(options.root || DEFAULT_ROOT);
    this.rawRetentionDays = Math.max(1, Number(options.rawRetentionDays) || RAW_RETENTION_DAYS);
    this.dailyRetentionDays = Math.max(30, Number(options.dailyRetentionDays) || DAILY_RETENTION_DAYS);
    this.daily = new Map();
    ensureDir(path.join(this.root, 'raw'));
    ensureDir(path.join(this.root, 'daily'));
  }

  ingest(record) {
    if (!record || typeof record !== 'object') return false;
    const atMs = Number(record.atMs) || Date.parse(record.at || '') || Date.now();
    const day = dayOf(atMs);
    const hour = hourOf(atMs);
    const character = safeName(record.character && record.character.name);
    const rawDir = path.join(this.root, 'raw', day, hour);
    ensureDir(rawDir);
    fs.appendFileSync(path.join(rawDir, character + '.ndjson'), JSON.stringify(record) + '\n', 'utf8');

    const key = day + '|' + character;
    const summary = this.daily.get(key) || {
      schemaVersion: 1,
      day,
      character,
      firstAt: new Date(atMs).toISOString(),
      lastAt: new Date(atMs).toISOString(),
      samples: 0,
      gold: { first: null, last: null, min: null, max: null },
      hp: { minRatio: null },
      maps: {},
      tasks: {},
      encounters: {},
      healthStates: {}
    };
    summary.samples += 1;
    summary.lastAt = new Date(atMs).toISOString();
    const gold = Number(record.character && record.character.gold);
    if (Number.isFinite(gold)) {
      if (summary.gold.first == null) summary.gold.first = gold;
      summary.gold.last = gold;
      summary.gold.min = summary.gold.min == null ? gold : Math.min(summary.gold.min, gold);
      summary.gold.max = summary.gold.max == null ? gold : Math.max(summary.gold.max, gold);
    }
    const hp = Number(record.character && record.character.hp);
    const maxHp = Number(record.character && record.character.maxHp);
    if (Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0) {
      const ratio = hp / maxHp;
      summary.hp.minRatio = summary.hp.minRatio == null ? ratio : Math.min(summary.hp.minRatio, ratio);
    }
    const map = safeName(record.character && record.character.map, '');
    if (map) summary.maps[map] = (summary.maps[map] || 0) + 1;
    const task = safeName(record.fullAutonomy && record.fullAutonomy.taskType, '');
    if (task) summary.tasks[task] = (summary.tasks[task] || 0) + 1;
    const encounter = safeName(record.encounter && record.encounter.selected, '');
    if (encounter) summary.encounters[encounter] = (summary.encounters[encounter] || 0) + 1;
    const health = safeName(record.health && record.health.state, '');
    if (health) summary.healthStates[health] = (summary.healthStates[health] || 0) + 1;
    this.daily.set(key, summary);
    return true;
  }

  flushDaily() {
    for (const summary of this.daily.values()) {
      const dir = path.join(this.root, 'daily', summary.day);
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, summary.character + '.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    }
    return this.daily.size;
  }

  prune() {
    const pruneDir = (base, retentionDays) => {
      if (!fs.existsSync(base)) return 0;
      const cutoff = Date.now() - retentionDays * 86400000;
      let removed = 0;
      for (const name of fs.readdirSync(base)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
        const stamp = Date.parse(name + 'T23:59:59.999Z');
        const target = path.join(base, name);
        if (Number.isFinite(stamp) && stamp < cutoff && within(this.root, target)) {
          fs.rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      }
      return removed;
    };
    return {
      raw: pruneDir(path.join(this.root, 'raw'), this.rawRetentionDays),
      daily: pruneDir(path.join(this.root, 'daily'), this.dailyRetentionDays)
    };
  }

  status() {
    return {
      schemaVersion: 1,
      root: this.root,
      rawRetentionDays: this.rawRetentionDays,
      dailyRetentionDays: this.dailyRetentionDays,
      pendingDailySummaries: this.daily.size
    };
  }
}

export class PersistentStateStore {
  constructor(options = {}) {
    this.root = path.resolve(options.stateRoot || DEFAULT_STATE_ROOT);
    this.profileRoot = path.join(this.root, 'account-profiles');
    this.wealthPath = path.join(this.root, 'account-wealth.json');
    ensureDir(this.profileRoot);
  }

  _profilePath(name) {
    return path.join(this.profileRoot, safeName(name) + '.json');
  }

  _readJson(target) {
    try {
      if (!fs.existsSync(target) || !within(this.root, target)) return null;
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  _writeJsonAtomic(target, value) {
    if (!within(this.root, target)) throw new Error('STATE_PATH_OUTSIDE_ROOT');
    ensureDir(path.dirname(target));
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
  }

  readProfiles() {
    if (!fs.existsSync(this.profileRoot)) return [];
    const rows = [];
    for (const name of fs.readdirSync(this.profileRoot)) {
      if (!name.endsWith('.json')) continue;
      const row = this._readJson(path.join(this.profileRoot, name));
      if (row && row.name) rows.push(row);
    }
    return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  writeProfile(profile) {
    if (!profile || typeof profile !== 'object' || !profile.name) return false;
    const row = JSON.parse(JSON.stringify(profile));
    row.name = safeName(row.name);
    this._writeJsonAtomic(this._profilePath(row.name), row);
    return true;
  }

  readWealth() {
    return this._readJson(this.wealthPath);
  }

  writeWealth(wealth) {
    if (!wealth || typeof wealth !== 'object') return false;
    this._writeJsonAtomic(this.wealthPath, JSON.parse(JSON.stringify(wealth)));
    return true;
  }

  readAccount() {
    return {
      schemaVersion: 1,
      root: this.root,
      profiles: this.readProfiles(),
      wealth: this.readWealth()
    };
  }

  writeAccount(payload = {}) {
    const profiles = Array.isArray(payload.profiles) ? payload.profiles.slice(0, 64) : [];
    let profilesWritten = 0;
    for (const row of profiles) if (this.writeProfile(row)) profilesWritten += 1;
    const wealthWritten = payload.wealth && typeof payload.wealth === 'object'
      ? this.writeWealth(payload.wealth)
      : false;
    return { profilesWritten, wealthWritten };
  }

  status() {
    return {
      schemaVersion: 1,
      root: this.root,
      profiles: this.readProfiles().length,
      wealthAvailable: !!this.readWealth()
    };
  }
}

export function createTelemetryServer(options = {}) {
  const store = options.store || new TelemetryStore(options);
  const stateStore = options.stateStore || new PersistentStateStore(options);
  const durableStore = options.durableStore || new DurableKeyStore({ stateRoot: stateStore.root });
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port) || DEFAULT_PORT;
  const allowOrigin = origin => !origin || origin === 'https://adventure.land' || origin === 'https://www.adventure.land'
    || /^https:\/\/[^/]+\.adventure\.land$/i.test(origin);

  const server = http.createServer((req, res) => {
    const origin = String(req.headers.origin || '');
    if (allowOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        // Host ownership check for the native Windows Bridge. This is not an
        // authentication secret and confers no gameplay/process authority.
        processId: process.pid,
        store: store.status(), stateStore: stateStore.status(),
        durableStore: durableStore.status()
      }));
    }
    if (req.method === 'GET' && req.url === '/v1/state/account') {
      if (!allowOrigin(origin)) {
        res.writeHead(403);
        return res.end('origin blocked');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stateStore.readAccount()));
    }

    const durablePath = req.url && req.url.split('?')[0] === '/v1/storage';
    const durableRequest = durablePath && ['GET', 'POST', 'DELETE'].includes(req.method);
    if (durableRequest) {
      if (!allowOrigin(origin)) {
        res.writeHead(403);
        return res.end('origin blocked');
      }
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(payload));
      };
      const key = new URL(req.url, 'http://127.0.0.1').searchParams.get('key');
      if (req.method !== 'POST') {
        try {
          const data = req.method === 'GET'
            ? durableStore.read(key)
            : durableStore.remove(key);
          return send(200, { ok: true, ...data });
        } catch (error) {
          return send(400, { ok: false, error: String(error && error.message || error) });
        }
      }
      let bytes = 0;
      let payload = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) {
          if (!res.writableEnded) send(413, { ok: false, error: 'DURABLE_PAYLOAD_TOO_LARGE' });
          req.destroy();
          return;
        }
        payload += chunk;
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          const row = JSON.parse(payload || '{}');
          if (key !== row.key) throw new Error('DURABLE_KEY_MISMATCH');
          const result = durableStore.write(row.key, row.value, row);
          send(200, { ok: true, ...result });
        } catch (error) {
          send(error && error.message === 'DURABLE_REVISION_CONFLICT' ? 409 : 400,
            { ok: false, error: String(error && error.message || error) });
        }
      });
      return;
    }

    const telemetryWrite = req.method === 'POST' && req.url === '/v1/telemetry';
    const stateWrite = req.method === 'POST' && req.url === '/v1/state/account';
    if (!telemetryWrite && !stateWrite) {
      res.writeHead(404);
      return res.end('not found');
    }
    if (!allowOrigin(origin)) {
      res.writeHead(403);
      return res.end('origin blocked');
    }
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end('payload too large');
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const payload = JSON.parse(body || '{}');
        if (stateWrite) {
          const written = stateStore.writeAccount(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ...written, state: stateStore.status() }));
        }
        const records = Array.isArray(payload.records) ? payload.records : [];
        let accepted = 0;
        for (const row of records.slice(0, 100)) if (store.ingest(row)) accepted += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
      }
    });
  });

  const flushTimer = setInterval(() => {
    try { store.flushDaily(); } catch (error) { console.error('[AL Bot telemetry] daily flush failed:', error); }
  }, 30000);
  flushTimer.unref?.();
  const pruneTimer = setInterval(() => {
    try { store.prune(); } catch (error) { console.error('[AL Bot telemetry] prune failed:', error); }
  }, 6 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  const close = async () => {
    clearInterval(flushTimer);
    clearInterval(pruneTimer);
    try { store.flushDaily(); } catch (_) {}
    await new Promise(resolve => server.close(() => resolve()));
  };

  return { server, store, stateStore, durableStore, host, port, close };
}

async function main() {
  const app = createTelemetryServer();
  app.store.prune();
  app.server.listen(app.port, app.host, () => {
    console.log('[AL Bot telemetry] listening on http://' + app.host + ':' + app.port);
    console.log('[AL Bot telemetry] storage root: ' + app.store.root);
    console.log('[AL Bot state] storage root: ' + app.stateStore.root);
    console.log('[AL Bot durable storage] root: ' + app.durableStore.root);
  });
  const shutdown = async signal => {
    console.log('[AL Bot telemetry] ' + signal + ' - flushing and stopping');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('[AL Bot telemetry] fatal:', error);
    process.exitCode = 1;
  });
}
