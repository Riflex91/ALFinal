import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = ['src/core.js', 'src/scheduler.js', 'src/game-adapter.js', 'src/knowledge.js', 'src/action-boundary.js', 'src/movement.js', 'src/class-skills.js', 'src/party.js', 'src/combat.js', 'src/live-test.js', 'src/runtime.js', 'src/ui.js', 'src/entry.js'];
const banner = `/* AL Bot 0.7.0-h7 | generated file | do not edit dist directly */\n`;
const body = source.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n\n');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/al-bot.js'), banner + body + '\n', 'utf8');
console.log(`Built dist/al-bot.js from ${source.length} source files.`);
