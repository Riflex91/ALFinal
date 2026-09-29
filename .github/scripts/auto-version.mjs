import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function writeText(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), value, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function incrementPatch(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error('AUTO_VERSION_INVALID_PACKAGE_VERSION:' + String(version || ''));
  return [Number(match[1]), Number(match[2]), Number(match[3]) + 1].join('.');
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error('AUTO_VERSION_PATTERN_MISSING:' + label + ':' + from);
  return source.split(from).join(to);
}

function escapedVersion(version) {
  return String(version).replace(/\./g, '\\.');
}

function previousPackageVersion() {
  try {
    const previous = execFileSync('git', ['show', 'HEAD^:package.json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return JSON.parse(previous).version || null;
  } catch (_) {
    return null;
  }
}

function updateH22BootstrapTest(source, nextRuntimeVersion, nextPackageVersion, stableManifest) {
  const marker = "test('H22 committed release manifest is valid before promotion and matches the candidate bundle after promotion'";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('AUTO_VERSION_H22_MARKER_MISSING');
  const end = source.indexOf('\ntest(', start + marker.length);
  const tail = end >= 0 ? end : source.length;
  let block = source.slice(start, tail);

  block = block.replace(
    /const candidateVersion = '[^']+';/,
    "const candidateVersion = '" + nextRuntimeVersion + "';"
  );
  block = block.replace(
    /const candidatePackageVersion = '[^']+';/,
    "const candidatePackageVersion = '" + nextPackageVersion + "';"
  );
  block = block.replace(
    /assert\.match\(dist, \/\^\\\/\\\* AL Bot [^/]+\/\);/,
    "assert.match(dist, /^\\/\\* AL Bot " + escapedVersion(nextRuntimeVersion) + " \\| generated file \\| do not edit dist directly \\*\\//);"
  );

  const stablePattern = /(\/\/ During candidate CI[\s\S]*?assert\.equal\(manifest\.version, ')[^']+('\);\n\s*assert\.equal\(manifest\.packageVersion, ')[^']+('\);)/;
  if (!stablePattern.test(block)) throw new Error('AUTO_VERSION_H22_STABLE_ASSERTIONS_MISSING');
  block = block.replace(
    stablePattern,
    '$1' + stableManifest.version + '$2' + stableManifest.packageVersion + '$3'
  );

  return source.slice(0, start) + block + source.slice(tail);
}

function updateVersionReferences(directory, currentPackageVersion, nextPackageVersion, currentRuntimeVersion, nextRuntimeVersion) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      updateVersionReferences(relative, currentPackageVersion, nextPackageVersion, currentRuntimeVersion, nextRuntimeVersion);
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name)) continue;
    if (relative.replaceAll('\\', '/') === 'tests/h22-bootstrap.test.mjs') continue;

    const original = readText(relative);
    let updated = original
      .split(currentRuntimeVersion).join(nextRuntimeVersion)
      .split(escapedVersion(currentRuntimeVersion)).join(escapedVersion(nextRuntimeVersion))
      .split(currentPackageVersion).join(nextPackageVersion);
    if (updated !== original) writeText(relative, updated);
  }
}

const pkg = readJson('package.json');
const currentPackageVersion = String(pkg.version || '');
const previousVersion = previousPackageVersion();

if (previousVersion && previousVersion !== currentPackageVersion) {
  console.log('AUTO_VERSION_SKIP_ALREADY_VERSIONED', {
    previousVersion,
    currentPackageVersion
  });
  process.exit(0);
}

const entrySource = readText('src/entry.js');
const runtimeMatch = entrySource.match(/version:\s*'(\d+\.\d+\.\d+)-(h\d+)'/);
if (!runtimeMatch) throw new Error('AUTO_VERSION_RUNTIME_SUFFIX_NOT_FOUND');
const currentRuntimeVersion = runtimeMatch[1] + '-' + runtimeMatch[2];
if (runtimeMatch[1] !== currentPackageVersion) {
  throw new Error('AUTO_VERSION_PACKAGE_RUNTIME_MISMATCH:' + currentPackageVersion + ':' + currentRuntimeVersion);
}

const nextPackageVersion = incrementPatch(currentPackageVersion);
const nextRuntimeVersion = nextPackageVersion + '-' + runtimeMatch[2];
const stableManifest = readJson('release/al-bot-release.json');

pkg.version = nextPackageVersion;
writeText('package.json', JSON.stringify(pkg, null, 2) + '\n');

let buildSource = readText('scripts/build.mjs');
buildSource = replaceRequired(
  buildSource,
  "const runtimeVersion = '" + currentRuntimeVersion + "';",
  "const runtimeVersion = '" + nextRuntimeVersion + "';",
  'build-runtime'
);
buildSource = replaceRequired(
  buildSource,
  "const packageVersion = '" + currentPackageVersion + "';",
  "const packageVersion = '" + nextPackageVersion + "';",
  'build-package'
);
writeText('scripts/build.mjs', buildSource);

let updatedEntry = readText('src/entry.js');
updatedEntry = replaceRequired(updatedEntry, currentRuntimeVersion, nextRuntimeVersion, 'entry-runtime');
writeText('src/entry.js', updatedEntry);

let runtimeSource = readText('src/runtime.js');
runtimeSource = replaceRequired(runtimeSource, currentRuntimeVersion, nextRuntimeVersion, 'runtime-default');
writeText('src/runtime.js', runtimeSource);

updateVersionReferences('src', currentPackageVersion, nextPackageVersion, currentRuntimeVersion, nextRuntimeVersion);
updateVersionReferences('scripts', currentPackageVersion, nextPackageVersion, currentRuntimeVersion, nextRuntimeVersion);
updateVersionReferences('tests', currentPackageVersion, nextPackageVersion, currentRuntimeVersion, nextRuntimeVersion);

const h22Path = 'tests/h22-bootstrap.test.mjs';
const h22Updated = updateH22BootstrapTest(
  readText(h22Path),
  nextRuntimeVersion,
  nextPackageVersion,
  stableManifest
);
writeText(h22Path, h22Updated);

console.log('AUTO_VERSION_BUMPED', {
  from: currentRuntimeVersion,
  to: nextRuntimeVersion,
  stable: stableManifest.version
});
