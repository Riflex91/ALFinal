import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptSource = fs.readFileSync(path.resolve(here, '../.github/scripts/auto-version.mjs'), 'utf8');
const workflowSource = fs.readFileSync(path.resolve(here, '../.github/workflows/auto-version.yml'), 'utf8');

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, 'utf8');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commitAll(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function runAutoVersion(root) {
  return execFileSync(process.execPath, ['.github/scripts/auto-version.mjs'], {
    cwd: root,
    encoding: 'utf8'
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-auto-version-'));
  write(root, '.github/scripts/auto-version.mjs', scriptSource);
  write(root, 'package.json', JSON.stringify({
    name: 'al-bot',
    version: '0.26.2',
    private: true,
    type: 'module',
    scripts: { build: 'node scripts/build.mjs' }
  }, null, 2) + '\n');
  write(root, 'release/al-bot-release.json', JSON.stringify({
    schemaVersion: 1,
    product: 'AL Bot',
    channel: 'stable',
    version: '0.26.2-h26',
    packageVersion: '0.26.2',
    commitSha: 'a'.repeat(40),
    bundleUrl: 'https://example.invalid/al-bot.js',
    sha256: 'b'.repeat(64),
    bytes: 123,
    sourceRef: 'a'.repeat(40),
    releasedAt: '2026-09-29T16:00:00.000Z',
    minBootstrapVersion: '1.0.0'
  }, null, 2) + '\n');
  write(root, 'scripts/build.mjs', [
    "const runtimeVersion = '0.26.2-h26';",
    "const packageVersion = '0.26.2';",
    ''
  ].join('\n'));
  write(root, 'src/entry.js', "const api = { version: '0.26.2-h26' };\n");
  write(root, 'src/runtime.js', "this.version = options.version || '0.26.2-h26';\n");
  write(root, 'src/feature.js', [
    'export const feature = 1; // baseline explanation',
    'export const endpoint = "https://example.test/path"; /* old docs */',
    ''
  ].join('\n'));
  write(root, 'host/telemetry-recorder.mjs', 'export const hostProtocol = 1;\n');
  write(root, 'bootstrap/al-bot-bootstrap.js', 'const BOOTSTRAP_VERSION = "1.0.0";\n');
  write(root, 'docs/readme.md', '# Baseline\n');
  write(root, 'tests/sample.test.mjs', [
    "assert.equal(pkg.version, '0.26.2');",
    "assert.equal(ctx.ALBot.version, '0.26.2-h26');",
    "assert.match(entry, /0\\.26\\.2-h26/);",
    ''
  ].join('\n'));
  write(root, 'tests/h22-bootstrap.test.mjs', [
    "test('H22 committed release manifest is valid before promotion and matches the candidate bundle after promotion', () => {",
    "  const candidateVersion = '0.26.2-h26';",
    "  const candidatePackageVersion = '0.26.2';",
    "  assert.match(dist, /^\\/\\* AL Bot 0\\.26\\.2-h26 \\| generated file \\| do not edit dist directly \\*\\//);",
    "  if (manifest.version === candidateVersion) {",
    "    assert.equal(manifest.packageVersion, candidatePackageVersion);",
    "  } else {",
    "    // During candidate CI the stable pointer intentionally remains on the last",
    "    // verified release. Only the known previous stable release is accepted.",
    "    assert.equal(manifest.version, '0.26.1-h26');",
    "    assert.equal(manifest.packageVersion, '0.26.1');",
    "  }",
    "});",
    "",
    "test('next test', () => {});",
    ''
  ].join('\n'));

  git(root, ['init']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  commitAll(root, 'initial');
  return root;
}

function packageVersion(root) {
  return JSON.parse(read(root, 'package.json')).version;
}

test('GitHub auto-version watches executable components but excludes docs/tests/release metadata', () => {
  assert.match(workflowSource, /branches:\s*\[main\]/);
  assert.match(workflowSource, /fetch-depth:\s*0/);
  assert.match(workflowSource, /src\/\*\*\/\*\.js/);
  assert.match(workflowSource, /host\/\*\*\/\*\.mjs/);
  assert.match(workflowSource, /bootstrap\/\*\*\/\*\.js/);
  assert.match(workflowSource, /scripts\/build\.mjs/);
  assert.match(workflowSource, /package\.json/);
  assert.doesNotMatch(workflowSource, /docs\/\*\*/);
  assert.doesNotMatch(workflowSource, /tests\/\*\*/);
  assert.doesNotMatch(workflowSource, /release\/\*\*/);
  assert.match(workflowSource, /contents:\s*write/);
  assert.match(workflowSource, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(workflowSource, /main advanced while versioning/);
  assert.match(workflowSource, /CI=false npm run build/);
  assert.match(workflowSource, /npm test/);
});

test('GitHub auto-version atomically promotes only a newer verified candidate to stable', () => {
  assert.match(workflowSource, /\.github\/workflows\/auto-version\.yml/);
  assert.match(workflowSource, /\.github\/scripts\/auto-version\.mjs/);
  assert.match(workflowSource, /CANDIDATE_VERSION=/);
  assert.match(workflowSource, /STABLE_VERSION=/);
  assert.match(workflowSource, /PROMOTE_STABLE=/);
  assert.match(workflowSource, /c>0\?'true':'false'/);
  assert.doesNotMatch(workflowSource, /<<'NODE'/);
  assert.match(workflowSource, /CI=true npm test/);
  assert.match(workflowSource, /RELEASE_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(workflowSource, /ALBOT_RELEASE_COMMIT_SHA="\$RELEASE_SHA"/);
  assert.match(workflowSource, /ALBOT_RELEASED_AT="\$RELEASED_AT"/);
  assert.match(workflowSource, /node --test tests\/h22-bootstrap\.test\.mjs/);
  assert.match(workflowSource, /git diff --quiet -- dist\/al-bot\.js/);
  assert.match(workflowSource, /git add release\/al-bot-release\.json/);
  assert.match(workflowSource, /main advanced while versioning\/promoting/);
  assert.match(workflowSource, /git push origin HEAD:main/);
  assert.match(workflowSource, /github\.actor != 'github-actions\[bot\]'/);
});

test('functional bot runtime change bumps patch version and keeps stable manifest as H22 fallback', () => {
  const root = fixture();
  try {
    write(root, 'src/feature.js', 'export const feature = 2; // real behavior change\n');
    commitAll(root, 'feature change');

    const output = runAutoVersion(root);
    assert.match(output, /AUTO_VERSION_BUMPED/);
    assert.equal(packageVersion(root), '0.26.3');

    const build = read(root, 'scripts/build.mjs');
    const entry = read(root, 'src/entry.js');
    const runtime = read(root, 'src/runtime.js');
    const sample = read(root, 'tests/sample.test.mjs');
    const h22 = read(root, 'tests/h22-bootstrap.test.mjs');

    assert.match(build, /runtimeVersion = '0\.26\.3-h26'/);
    assert.match(build, /packageVersion = '0\.26\.3'/);
    assert.match(entry, /0\.26\.3-h26/);
    assert.match(runtime, /0\.26\.3-h26/);
    assert.match(sample, /0\.26\.3-h26/);
    assert.match(sample, /0\\\.26\\\.3-h26/);
    assert.match(h22, /candidateVersion = '0\.26\.3-h26'/);
    assert.match(h22, /candidatePackageVersion = '0\.26\.3'/);
    assert.ok(h22.includes("AL Bot 0\\.26\\.3-h26"));
    assert.match(h22, /manifest\.version, '0\.26\.2-h26'/);
    assert.match(h22, /manifest\.packageVersion, '0\.26\.2'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comment-only JavaScript change does not bump version, including URL strings and inline comments', () => {
  const root = fixture();
  try {
    write(root, 'src/feature.js', [
      'export const feature = 1; // changed explanation only',
      'export const endpoint = "https://example.test/path"; /* docs only */',
      ''
    ].join('\n'));
    commitAll(root, 'comment only');

    const output = runAutoVersion(root);
    assert.match(output, /AUTO_VERSION_SKIP_NO_EXECUTABLE_CHANGE/);
    assert.equal(packageVersion(root), '0.26.2');
    assert.equal(git(root, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs and test-only changes do not bump version', () => {
  const root = fixture();
  try {
    write(root, 'docs/readme.md', '# Documentation only\n');
    write(root, 'tests/notes.test.mjs', '// test-only helper change\n');
    commitAll(root, 'docs and tests only');

    const output = runAutoVersion(root);
    assert.match(output, /AUTO_VERSION_SKIP_NO_EXECUTABLE_CHANGE/);
    assert.equal(packageVersion(root), '0.26.2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host and bridge runtime code changes are version relevant', () => {
  const root = fixture();
  try {
    write(root, 'host/telemetry-recorder.mjs', 'export const hostProtocol = 2;\n');
    commitAll(root, 'host runtime change');

    const output = runAutoVersion(root);
    assert.match(output, /host\/telemetry-recorder\.mjs/);
    assert.equal(packageVersion(root), '0.26.3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap executable changes are version relevant', () => {
  const root = fixture();
  try {
    write(root, 'bootstrap/al-bot-bootstrap.js', 'const BOOTSTRAP_VERSION = "1.0.1";\n');
    commitAll(root, 'bootstrap behavior change');

    const output = runAutoVersion(root);
    assert.match(output, /bootstrap\/al-bot-bootstrap\.js/);
    assert.equal(packageVersion(root), '0.26.3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('functional package.json changes are version relevant while version field itself is ignored', () => {
  const root = fixture();
  try {
    const pkg = JSON.parse(read(root, 'package.json'));
    pkg.scripts.verify = 'node verify.mjs';
    write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    commitAll(root, 'package behavior change');

    const output = runAutoVersion(root);
    assert.match(output, /package\.json/);
    assert.equal(packageVersion(root), '0.26.3');
    assert.equal(JSON.parse(read(root, 'package.json')).scripts.verify, 'node verify.mjs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('already manually versioned executable change is not bumped a second time', () => {
  const root = fixture();
  try {
    const pkg = JSON.parse(read(root, 'package.json'));
    pkg.version = '0.26.3';
    write(root, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    write(root, 'scripts/build.mjs', "const runtimeVersion = '0.26.3-h26';\nconst packageVersion = '0.26.3';\n");
    write(root, 'src/entry.js', "const api = { version: '0.26.3-h26' };\n");
    write(root, 'src/runtime.js', "this.version = options.version || '0.26.3-h26';\n");
    write(root, 'src/feature.js', 'export const feature = 9;\n');
    commitAll(root, 'manually versioned feature');

    const output = runAutoVersion(root);
    assert.match(output, /AUTO_VERSION_SKIP_NO_EXECUTABLE_CHANGE|AUTO_VERSION_SKIP_ALREADY_VERSIONED/);
    assert.equal(packageVersion(root), '0.26.3');
    assert.equal(git(root, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
