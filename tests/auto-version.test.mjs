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

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'albot-auto-version-'));
  write(root, '.github/scripts/auto-version.mjs', scriptSource);
  write(root, 'package.json', JSON.stringify({
    name: 'al-bot',
    version: '0.26.2',
    private: true,
    type: 'module'
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
  write(root, 'src/feature.js', "export const feature = 1;\n");
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
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('GitHub auto-version workflow is main-only, source-triggered and race-aware', () => {
  assert.match(workflowSource, /branches:\s*\[main\]/);
  assert.match(workflowSource, /- 'src\/\*\*'/);
  assert.match(workflowSource, /contents:\s*write/);
  assert.match(workflowSource, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(workflowSource, /git fetch origin main/);
  assert.match(workflowSource, /BASE_SHA=/);
  assert.match(workflowSource, /main advanced while versioning/);
  assert.match(workflowSource, /CI=false npm run build/);
  assert.match(workflowSource, /npm test/);
  assert.match(workflowSource, /git push origin HEAD:main/);
});

test('auto-version script bumps patch version and keeps stable manifest as H22 fallback', () => {
  const root = fixture();
  try {
    write(root, 'src/feature.js', "export const feature = 2;\n");
    git(root, ['add', 'src/feature.js']);
    git(root, ['commit', '-m', 'feature change']);

    execFileSync(process.execPath, ['.github/scripts/auto-version.mjs'], {
      cwd: root,
      encoding: 'utf8'
    });

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.26.3');

    const build = fs.readFileSync(path.join(root, 'scripts/build.mjs'), 'utf8');
    const entry = fs.readFileSync(path.join(root, 'src/entry.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(root, 'src/runtime.js'), 'utf8');
    const sample = fs.readFileSync(path.join(root, 'tests/sample.test.mjs'), 'utf8');
    const h22 = fs.readFileSync(path.join(root, 'tests/h22-bootstrap.test.mjs'), 'utf8');

    assert.match(build, /runtimeVersion = '0\.26\.3-h26'/);
    assert.match(build, /packageVersion = '0\.26\.3'/);
    assert.match(entry, /0\.26\.3-h26/);
    assert.match(runtime, /0\.26\.3-h26/);
    assert.match(sample, /0\.26\.3-h26/);
    assert.match(sample, /0\\\.26\\\.3-h26/);
    assert.match(sample, /0\.26\.3/);
    assert.match(h22, /candidateVersion = '0\.26\.3-h26'/);
    assert.match(h22, /candidatePackageVersion = '0\.26\.3'/);
    assert.match(h22, /manifest\.version, '0\.26\.2-h26'/);
    assert.match(h22, /manifest\.packageVersion, '0\.26\.2'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auto-version script does not double-bump an already versioned change', () => {
  const root = fixture();
  try {
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = '0.26.3';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    write(root, 'scripts/build.mjs', "const runtimeVersion = '0.26.3-h26';\nconst packageVersion = '0.26.3';\n");
    write(root, 'src/entry.js', "const api = { version: '0.26.3-h26' };\n");
    write(root, 'src/runtime.js', "this.version = options.version || '0.26.3-h26';\n");
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'already versioned']);

    const before = git(root, ['status', '--porcelain']);
    assert.equal(before, '');

    execFileSync(process.execPath, ['.github/scripts/auto-version.mjs'], {
      cwd: root,
      encoding: 'utf8'
    });

    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.equal(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version, '0.26.3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
