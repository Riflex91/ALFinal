import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectWriterPreflight } from './ssd-writer-preflight.mjs';

// Diagnostic only: two loopback GET /health probes plus a read-only SSD
// preflight. It NEVER sends POST/DELETE, touches browser storage, writes a
// lease/marker, starts or stops processes, or grants a writer transition.
const DEFAULT_NODE_PORT = 17391;
const DEFAULT_BRIDGE_PORT = 17392;
const MAX_RESPONSE_BYTES = 8192;

function portNumber(value, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error('SSD_WITNESS_INVALID_PORT');
  }
  return n;
}

function healthProbe(port, service, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    function finish(data) { if (!done) { done = true; resolve(data); } }
    const req = http.request({
      hostname: '127.0.0.1', family: 4, port, path: '/health',
      method: 'GET', agent: false,
      headers: { Accept: 'application/json' },
      timeout: timeoutMs
    }, response => {
      let bytes = 0;
      const parts = [];
      response.on('data', part => {
        bytes += part.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish({ service, port, state: 'OVERSIZED_RESPONSE' });
          return;
        }
        parts.push(part);
      });
      response.on('error', () => finish({ service, port, state: 'UNREADABLE_RESPONSE' }));
      response.on('end', () => {
        if (done) return;
        try {
          const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
          const correctSchema = service === 'bridge'
            ? value?.service === 'ALFinal Windows Bridge native SSD'
              && value?.durableStore?.schemaVersion === 1
            : value?.store && typeof value.store === 'object'
              && value?.stateStore && typeof value.stateStore === 'object';
          finish({
            service, port,
            state: response.statusCode === 200 && value?.ok === true && correctSchema
              ? 'RECOGNIZED_HEALTHY'
              : 'UNVERIFIED_SERVICE',
            httpStatus: Number(response.statusCode) || null,
            // Avoid account values, raw health payload and uncontrolled text.
            processId: service === 'bridge' && Number.isSafeInteger(value?.processId)
              ? value.processId : null
          });
        } catch (_) {
          finish({ service, port, state: 'INVALID_HEALTH_JSON' });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ service, port, state: 'TIMEOUT' });
    });
    req.on('error', () => finish({ service, port, state: 'UNREACHABLE_OR_UNVERIFIED' }));
    req.end();
  });
}

export async function collectReadOnlySsdWitness(options = {}) {
  const stateRoot = path.resolve(options.stateRoot || 'D:/ALBot/state');
  const telemetryRoot = path.resolve(options.telemetryRoot || 'D:/ALBot/telemetry');
  const nodePort = portNumber(options.nodePort, DEFAULT_NODE_PORT);
  const bridgePort = portNumber(options.bridgePort, DEFAULT_BRIDGE_PORT);
  if (nodePort === bridgePort) throw new Error('SSD_WITNESS_DISTINCT_PORTS_REQUIRED');
  const timeoutMs = Math.max(250, Math.min(5000, Number(options.timeoutMs) || 1500));
  // Every probe can be inconclusive. Fail closed and never infer ownership
  // or storage migration success from an HTTP response.
  const [node, bridge] = await Promise.all([
    healthProbe(nodePort, 'legacy-node', timeoutMs),
    healthProbe(bridgePort, 'bridge', timeoutMs)
  ]);
  const preflight = inspectWriterPreflight({ stateRoot, telemetryRoot });
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    readOnly: true,
    cutoverAuthorized: false,
    liveGameplayVerified: false,
    node, bridge,
    disk: preflight,
    assessment: 'EVIDENCE_ONLY_MANUAL_REVIEW_REQUIRED',
    nextGate: 'H19_STOP_UNKNOWN_H25_BROWSER_STATE_AND_INDEPENDENT_PROCESS_SHUTDOWN_VERIFICATION_REQUIRED',
    note: 'A green /health or a free port is never proof that an old uninstrumented writer cannot restart.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await collectReadOnlySsdWitness({
      stateRoot: process.argv[2], telemetryRoot: process.argv[3]
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.disk.blockers.length ? 2 : 1;
  } catch (error) {
    console.error('SSD_WITNESS_UNVERIFIED:', String(error?.message || error));
    process.exitCode = 2;
  }
}
