import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/candidate-version.yml', import.meta.url), 'utf8');

test('candidate version workflow owns non-main branch versioning and build synchronization', () => {
  assert.match(workflow, /name:\s*Candidate Version/);
  assert.match(workflow, /branches-ignore:\s*\n\s*- main/);
  assert.match(workflow, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /node \.github\/scripts\/auto-version\.mjs/);
  assert.match(workflow, /CI=false npm run build/);
  assert.match(workflow, /CI=true npm test/);
  assert.match(workflow, /git add package\.json scripts\/build\.mjs src tests dist\/al-bot\.js/);
  assert.match(workflow, /git push origin HEAD:"\$\{BRANCH\}"/);
});

test('candidate workflow never promotes the stable release pointer', () => {
  assert.doesNotMatch(workflow, /ALBOT_RELEASE_COMMIT_SHA/);
  assert.doesNotMatch(workflow, /git add[^\n]*release\/al-bot-release\.json/);
  assert.doesNotMatch(workflow, /git commit[^\n]*promote/i);
  assert.doesNotMatch(workflow, /HEAD:main/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /origin\/\$\{BRANCH\}/);
});
