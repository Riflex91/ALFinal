import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = ['src/core.js', 'src/scheduler.js', 'src/game-adapter.js', 'src/knowledge.js', 'src/action-boundary.js', 'src/movement.js', 'src/class-skills.js', 'src/resource-topoff.js', 'src/party.js', 'src/party-logistics.js', 'src/cross-window-lifecycle.js', 'src/lifecycle-recovery.js', 'src/host-state.js', 'src/account-strategy.js', 'src/encounters.js', 'src/full-autonomy.js', 'src/farming.js', 'src/combat.js', 'src/farm-intelligence.js', 'src/inventory.js', 'src/merchant.js', 'src/bank.js', 'src/trade.js', 'src/gear.js', 'src/gear-progression.js', 'src/upgrade.js', 'src/exchange-craft.js', 'src/economy.js', 'src/market-intelligence.js', 'src/merchant-autonomy.js', 'src/telemetry.js', 'src/live-test.js', 'src/safe-auto-updater.js', 'src/autonomous-observer.js', 'src/known-recovery.js', 'src/windows-bridge.js', 'src/runtime.js', 'src/ui.js', 'src/ui-advanced.js', 'src/entry.js'];
const runtimeVersion = '0.26.56-h26';
const packageVersion = '0.26.56';
const bootstrapPath = path.join(root, 'bootstrap/al-bot-bootstrap.js');
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
const bootstrapVersionMatch = bootstrapSource.match(/const BOOTSTRAP_VERSION = '([^']+)'/);
if (!bootstrapVersionMatch) throw new Error('Bootstrap version marker missing');
const bootstrapVersion = bootstrapVersionMatch[1];
const bootstrapBytes = Buffer.byteLength(bootstrapSource, 'utf8');
const maxBootstrapBytes = 25000;
if (bootstrapBytes > maxBootstrapBytes) {
  throw new Error(`bootstrap/al-bot-bootstrap.js exceeds ${maxBootstrapBytes} bytes (${bootstrapBytes})`);
}
const banner = `/* AL Bot ${runtimeVersion} | generated file | do not edit dist directly */\n`;
const body = source.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n\n');
const bundle = banner + body + '\n';
const bundleBytes = Buffer.byteLength(bundle, 'utf8');
const bundleSha256 = crypto.createHash('sha256').update(bundle, 'utf8').digest('hex');
const distPath = path.join(root, 'dist/al-bot.js');
const existingBundle = fs.existsSync(distPath) ? fs.readFileSync(distPath, 'utf8') : null;
if (process.env.CI === 'true' && existingBundle != null && existingBundle !== bundle) {
  throw new Error('dist/al-bot.js is out of date; run npm run build and commit the generated bundle');
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(distPath, bundle, 'utf8');
const releaseCommitSha = String(process.env.ALBOT_RELEASE_COMMIT_SHA || '').trim().toLowerCase();
const releaseMinBootstrapVersion = String(process.env.ALBOT_RELEASE_MIN_BOOTSTRAP_VERSION || bootstrapVersion).trim();
const releaseTimestamp = String(process.env.ALBOT_RELEASED_AT || '').trim();

console.log(`Built dist/al-bot.js from ${source.length} source files (${bundleBytes} bytes, sha256 ${bundleSha256}).`);
console.log(`Verified bootstrap/al-bot-bootstrap.js ${bootstrapVersion} (${bootstrapBytes} bytes, limit ${maxBootstrapBytes}).`);

if (releaseCommitSha) {
  if (!/^[a-f0-9]{40}$/.test(releaseCommitSha)) {
    throw new Error('ALBOT_RELEASE_COMMIT_SHA must be an exact 40-character commit SHA');
  }
  const releasedAt = releaseTimestamp || new Date().toISOString();
  if (!Number.isFinite(Date.parse(releasedAt))) {
    throw new Error('ALBOT_RELEASED_AT must be an ISO-compatible timestamp when supplied');
  }
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    product: 'AL Bot',
    channel: 'stable',
    version: runtimeVersion,
    packageVersion,
    commitSha: releaseCommitSha,
    bundleUrl: `https://raw.githubusercontent.com/Riflex91/ALFinal/${releaseCommitSha}/dist/al-bot.js`,
    sha256: bundleSha256,
    bytes: bundleBytes,
    sourceRef: releaseCommitSha,
    releasedAt: new Date(releasedAt).toISOString(),
    minBootstrapVersion: releaseMinBootstrapVersion
  };
  fs.writeFileSync(path.join(root, 'release/al-bot-release.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Built pinned release/al-bot-release.json for ${releaseCommitSha}.`);
} else {
  console.log('Skipped release manifest: set ALBOT_RELEASE_COMMIT_SHA only when promoting an immutable release.');
}
