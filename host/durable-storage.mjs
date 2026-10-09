import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_STATE_ROOT = process.env.ALBOT_STATE_ROOT || 'D:/ALBot/state';
const MAX_VALUE_BYTES = 3 * 1024 * 1024;
const MAX_KEY_LENGTH = 240;

function validKey(key) {
  return typeof key === 'string'
    && key.length > 0 && key.length <= MAX_KEY_LENGTH
    && /^(?:albot:|aio-v3-content-drift-v1(?:$|:)|cstore_AIO_V3_WORLD_MODEL$)/.test(key)
    && !/[\x00-\x1f\x7f]/.test(key);
}

export class DurableKeyStore {
  constructor(options = {}) {
    this.root = path.resolve(options.root || path.join(options.stateRoot || DEFAULT_STATE_ROOT, 'durable-kv'));
    fs.mkdirSync(this.root, { recursive: true });
  }

  _path(key) {
    if (!validKey(key)) throw new Error('DURABLE_KEY_INVALID');
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    return path.join(this.root, digest.slice(0, 2), digest + '.json');
  }

  read(key) {
    const file = this._path(key);
    if (!fs.existsSync(file)) return { found: false, value: null, revision: 0 };
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!row || row.schemaVersion !== 1 || row.key !== key || typeof row.value !== 'string') {
      throw new Error('DURABLE_RECORD_INVALID');
    }
    if (row.expiresAtMs != null && Date.now() > row.expiresAtMs) {
      return { found: false, value: null, revision: row.revision || 0, expired: true };
    }
    return { found: true, value: row.value, revision: row.revision || 0, expiresAtMs: row.expiresAtMs || null };
  }

  write(key, value, options = {}) {
    const file = this._path(key);
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      throw new Error('DURABLE_VALUE_INVALID_OR_OVERSIZE');
    }
    const expiresAtMs = options.expiresAtMs == null ? null : Number(options.expiresAtMs);
    if (expiresAtMs != null && (!Number.isFinite(expiresAtMs)
        || expiresAtMs < Date.now() || expiresAtMs > Date.now() + 7 * 86400000)) {
      throw new Error('DURABLE_EXPIRY_INVALID');
    }
    const previous = this.read(key);
    if (options.expectedRevision != null && Number(options.expectedRevision) !== previous.revision) {
      throw new Error('DURABLE_REVISION_CONFLICT');
    }
    const row = {
      schemaVersion: 1, key, value, revision: previous.revision + 1,
      savedAtMs: Date.now(), expiresAtMs
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(row), 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch (_) {}
    }
    return { revision: row.revision, savedAtMs: row.savedAtMs, expiresAtMs };
  }

  remove(key) {
    const file = this._path(key);
    try { fs.unlinkSync(file); return { removed: true }; }
    catch (error) {
      if (error && error.code === 'ENOENT') return { removed: false };
      throw error;
    }
  }

  status() {
    return { schemaVersion: 1, root: this.root, maxValueBytes: MAX_VALUE_BYTES };
  }
}
