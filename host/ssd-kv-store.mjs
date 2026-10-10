import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class SSDKeyValueStore {
  constructor(options = {}) {
    this.root = path.resolve(options.root || 'D:/ALBot/state/kv');
    fs.mkdirSync(this.root, { recursive: true });
  }
  _file(key) {
    if (typeof key !== 'string' || !key.startsWith('albot:') || key.length > 512
        || !/^[\x20-\x7e]+$/.test(key)) throw new Error('SSD_KV_KEY_REJECTED');
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.root, digest.slice(0, 2), digest + '.json');
  }
  get(key) {
    const file = this._file(key);
    if (!fs.existsSync(file)) return null;
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!row || row.key !== key || typeof row.value !== 'string') throw new Error('SSD_KV_INTEGRITY_ERROR');
    return row.value;
  }
  set(key, value) {
    const file = this._file(key);
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024)
      throw new Error('SSD_KV_VALUE_INVALID');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify({ key, value, updatedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
    }
    return true;
  }
  remove(key) {
    const file = this._file(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  }
  status() { return { available: true, root: this.root, backend: 'SSD_KEY_VALUE_V1' }; }
}
