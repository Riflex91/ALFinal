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

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe']
  }).trim();
}

function tryGit(args) {
  try {
    return git(args, { quiet: true });
  } catch (_) {
    return null;
  }
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

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function isExecutableVersionPath(relativePath) {
  const name = normalizePath(relativePath);
  if (name === 'package.json' || name === 'scripts/build.mjs') return true;
  return /^(?:src|host|bootstrap)\/.+\.(?:js|mjs|cjs|json)$/.test(name);
}

function listFilesAt(ref) {
  const output = tryGit(['ls-tree', '-r', '--name-only', ref]);
  if (!output) return [];
  return output.split('\n').map(normalizePath).filter(Boolean);
}

function readFileAt(ref, relativePath) {
  try {
    return execFileSync('git', ['show', ref + ':' + normalizePath(relativePath)], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_) {
    return null;
  }
}

function packageVersionAt(ref) {
  const source = readFileAt(ref, 'package.json');
  if (!source) return null;
  try {
    return String(JSON.parse(source).version || '') || null;
  } catch (_) {
    return null;
  }
}

function findCurrentVersionBaseline(currentVersion) {
  const history = tryGit(['rev-list', '--first-parent', '--max-count=500', 'HEAD']);
  if (!history) return null;
  for (const commit of history.split('\n').filter(Boolean)) {
    if (packageVersionAt(commit) !== currentVersion) continue;
    const parent = tryGit(['rev-parse', commit + '^']);
    const parentVersion = parent ? packageVersionAt(parent) : null;
    if (parentVersion !== currentVersion) return commit;
  }
  return null;
}

function stripJsComments(source) {
  const text = String(source || '').replace(/\r\n/g, '\n');
  let out = '';
  let state = 'code';
  let quote = '';
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';

    if (state === 'line-comment') {
      if (ch === '\n') {
        out += '\n';
        state = 'code';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out += ' ';
        state = 'code';
        i += 1;
      } else if (ch === '\n') {
        out += '\n';
      }
      continue;
    }

    if (state === 'string') {
      out += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        state = 'code';
        quote = '';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state = 'string';
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }

  return out;
}

function stableSortJson(value) {
  if (Array.isArray(value)) return value.map(stableSortJson);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableSortJson(value[key]);
  return out;
}

function semanticProjection(relativePath, source) {
  if (source == null) return null;
  const name = normalizePath(relativePath);

  if (name.endsWith('.json')) {
    try {
      const parsed = JSON.parse(source);
      if (name === 'package.json' && parsed && typeof parsed === 'object') delete parsed.version;
      return JSON.stringify(stableSortJson(parsed));
    } catch (_) {
      return String(source).replace(/\s+/g, ' ').trim();
    }
  }

  return stripJsComments(source)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function executableChangesSince(baseRef, headRef = 'HEAD') {
  if (!baseRef) {
    return [{ path: null, reason: 'VERSION_BASELINE_UNAVAILABLE' }];
  }
  const candidates = new Set([
    ...listFilesAt(baseRef).filter(isExecutableVersionPath),
    ...listFilesAt(headRef).filter(isExecutableVersionPath)
  ]);
  const changed = [];
  for (const relativePath of [...candidates].sort()) {
    const before = semanticProjection(relativePath, readFileAt(baseRef, relativePath));
    const after = semanticProjection(relativePath, readFileAt(headRef, relativePath));
    if (before !== after) changed.push({ path: relativePath, reason: before == null ? 'ADDED' : after == null ? 'DELETED' : 'SEMANTIC_CHANGE' });
  }
  return changed;
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
    if (normalizePath(relative) === 'tests/h22-bootstrap.test.mjs') continue;

    const original = readText(relative);
    const updated = original
      .split(currentRuntimeVersion).join(nextRuntimeVersion)
      .split(escapedVersion(currentRuntimeVersion)).join(escapedVersion(nextRuntimeVersion))
      .split(currentPackageVersion).join(nextPackageVersion);
    if (updated !== original) writeText(relative, updated);
  }
}

const pkg = readJson('package.json');
const currentPackageVersion = String(pkg.version || '');
const entrySource = readText('src/entry.js');
const runtimeMatch = entrySource.match(/version:\s*'(\d+\.\d+\.\d+)-(h\d+)'/);
if (!runtimeMatch) throw new Error('AUTO_VERSION_RUNTIME_SUFFIX_NOT_FOUND');
const currentRuntimeVersion = runtimeMatch[1] + '-' + runtimeMatch[2];
if (runtimeMatch[1] !== currentPackageVersion) {
  throw new Error('AUTO_VERSION_PACKAGE_RUNTIME_MISMATCH:' + currentPackageVersion + ':' + currentRuntimeVersion);
}

const versionBaseline = findCurrentVersionBaseline(currentPackageVersion);
const relevantChanges = executableChangesSince(versionBaseline, 'HEAD');
if (relevantChanges.length === 0) {
  console.log('AUTO_VERSION_SKIP_NO_EXECUTABLE_CHANGE', {
    version: currentRuntimeVersion,
    baseline: versionBaseline
  });
  process.exit(0);
}
if (versionBaseline === tryGit(['rev-parse', 'HEAD'])) {
  console.log('AUTO_VERSION_SKIP_ALREADY_VERSIONED', {
    version: currentRuntimeVersion,
    baseline: versionBaseline
  });
  process.exit(0);
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
writeText(h22Path, updateH22BootstrapTest(
  readText(h22Path),
  nextRuntimeVersion,
  nextPackageVersion,
  stableManifest
));

console.log('AUTO_VERSION_BUMPED', {
  from: currentRuntimeVersion,
  to: nextRuntimeVersion,
  baseline: versionBaseline,
  relevantChanges,
  stable: stableManifest.version
});
