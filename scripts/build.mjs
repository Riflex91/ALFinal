import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = ['src/core.js', 'src/scheduler.js', 'src/game-adapter.js', 'src/knowledge.js', 'src/action-boundary.js', 'src/movement.js', 'src/class-skills.js', 'src/resource-topoff.js', 'src/party.js', 'src/party-logistics.js', 'src/cross-window-lifecycle.js', 'src/lifecycle-recovery.js', 'src/account-strategy.js', 'src/full-autonomy.js', 'src/farming.js', 'src/combat.js', 'src/farm-intelligence.js', 'src/inventory.js', 'src/merchant.js', 'src/bank.js', 'src/trade.js', 'src/gear.js', 'src/upgrade.js', 'src/exchange-craft.js', 'src/economy.js', 'src/live-test.js', 'src/safe-auto-updater.js', 'src/runtime.js', 'src/ui.js', 'src/entry.js'];
const runtimeVersion = '0.22.0-h22';
const packageVersion = '0.22.0';
const banner = `/* AL Bot ${runtimeVersion} | generated file | do not edit dist directly */\n`;
const body = source.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n\n');
const bundle = banner + body + '\n';
const bundleBytes = Buffer.byteLength(bundle, 'utf8');
const bundleSha256 = crypto.createHash('sha256').update(bundle, 'utf8').digest('hex');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/al-bot.js'), bundle, 'utf8');
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
const manifest = {
  schemaVersion: 1,
  product: 'AL Bot',
  channel: 'stable',
  version: runtimeVersion,
  packageVersion,
  bundleUrl: 'https://raw.githubusercontent.com/Riflex91/ALFinal/main/dist/al-bot.js',
  sha256: bundleSha256,
  bytes: bundleBytes,
  sourceRef: 'main'
};
fs.writeFileSync(path.join(root, 'release/al-bot-release.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Built dist/al-bot.js from ${source.length} source files (${bundleBytes} bytes, sha256 ${bundleSha256}).`);
console.log('Built release/al-bot-release.json.');
