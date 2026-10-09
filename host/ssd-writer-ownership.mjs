import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Shared protocol for Node and the future native Bridge writer.
// Files are intentionally NOT scavenged after a crash: unknown owner => STOP.
export const WRITER_OWNER_FILE = 'writer-owner.json';
export const WRITER_LEASE_FILE = 'writer-lease.json';

function readRecord(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > 4096) throw new Error('ALBOT_WRITER_RECORD_UNSAFE');
  const row = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!row || row.schemaVersion !== 1 || !['node', 'bridge'].includes(row.owner)) {
    throw new Error('ALBOT_WRITER_RECORD_INVALID');
  }
  return row;
}

function writeNewDurable(filename, value) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class NodeWriterOwnership {
  constructor(stateRoot) {
    this.stateRoot = path.resolve(stateRoot);
    this.ownerPath = path.join(this.stateRoot, WRITER_OWNER_FILE);
    this.leasePath = path.join(this.stateRoot, WRITER_LEASE_FILE);
    this.token = null;
  }

  acquire() {
    if (this.token) throw new Error('ALBOT_WRITER_ALREADY_ACQUIRED');
    fs.mkdirSync(this.stateRoot, { recursive: true });
    const token = randomUUID();
    // O_EXCL is cross-process atomic. A crashed process leaves a stale lease;
    // never steal or time out this lease without an operator reconciliation.
    try {
      writeNewDurable(this.leasePath, { schemaVersion: 1, owner: 'node', token, processId: process.pid });
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('ALBOT_WRITER_LEASE_HELD_OR_STALE');
      throw error;
    }
    try {
      if (!fs.existsSync(this.ownerPath)) {
        try {
          writeNewDurable(this.ownerPath, { schemaVersion: 1, owner: 'node' });
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }
      if (readRecord(this.ownerPath).owner !== 'node') {
        throw new Error('ALBOT_WRITER_CUTOVER_TO_BRIDGE');
      }
      this.token = token;
      this.assertOwned();
    } catch (error) {
      // Only release the lease we just created. Never delete a foreign lease.
      try {
        if (readRecord(this.leasePath).token === token) fs.unlinkSync(this.leasePath);
      } catch (_) { /* unresolved lease is safer than blind removal */ }
      throw error;
    }
    return this;
  }

  assertOwned() {
    if (!this.token) throw new Error('ALBOT_WRITER_LEASE_NOT_ACQUIRED');
    try {
      const lease = readRecord(this.leasePath);
      const owner = readRecord(this.ownerPath);
      if (lease.owner !== 'node' || lease.token !== this.token || owner.owner !== 'node') {
        throw new Error('ALBOT_WRITER_OWNERSHIP_LOST');
      }
    } catch (error) {
      if (error?.message === 'ALBOT_WRITER_OWNERSHIP_LOST') throw error;
      throw new Error('ALBOT_WRITER_OWNERSHIP_UNVERIFIED', { cause: error });
    }
  }

  release() {
    this.assertOwned();
    fs.unlinkSync(this.leasePath);
    this.token = null;
    // Persistent owner file is deliberately retained across restarts.
  }
}

export function acquireNodeWriterLease(stateRoot) {
  return new NodeWriterOwnership(stateRoot).acquire();
}
