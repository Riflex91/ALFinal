import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

function fail(message) {
  throw new Error('V6_TRANSPORT_GUARD:' + message);
}

const bridge = read('src/windows-bridge.js');
const entry = read('src/entry.js');
const build = read('scripts/build.mjs');

for (const required of [
  "const GENERATION = 6",
  "const PROTOCOL = 'albot-v6-bridge-v1'",
  "gameplayActionAuthority: false",
  "acceptsLegacyGenerations: false",
  "noGenericRemoteEvaluate: true",
  "noEmbeddedCloudSecrets: true",
  "legacyV3V4V5TransportRejected: true"
]) {
  if (!bridge.includes(required)) fail('missing required marker: ' + required);
}

for (const forbidden of [
  'AIO_V3',
  'AIO_V4',
  'AIO_CHATGPT_SIGNAL_CONTROL',
  'x-aio-v3',
  'aio-v3:cloud-control',
  'bot-debug-ingest',
  'bot-chatgpt-signal-control',
  'supabase.co',
  'workers.dev'
]) {
  if (bridge.includes(forbidden)) fail('legacy/direct transport marker in V6 bridge: ' + forbidden);
}

if (/\bfetch\s*\(/.test(bridge)) fail('V6 browser bridge must not perform direct cloud HTTP fetches');
if (!entry.includes('bridge: bridge ? {')) fail('ALBot.bridge public API missing');
if (!entry.includes('new ns.WindowsBridgeTransportAdapter')) fail('V6 bridge adapter not installed');
if (!build.includes("'src/windows-bridge.js'")) fail('V6 bridge source missing from generated bundle');

console.log('V6 transport guard passed.');
