# ALFinal repository rules

These rules apply to every human or AI agent working in this repository.

## Current-state verification is mandatory

Never infer the current implementation state from README.md, docs/ROADMAP.md, docs/CHAT-HANDOFF.md, issue text, PR descriptions, branch names, or old live-test notes alone.

Before making a repository-wide capability assessment or proposing that a feature is missing, verify the current target branch directly:

1. read the current default-branch SHA and check relevant open PRs;
2. inspect package.json, scripts/build.mjs, src/runtime.js, src/entry.js, and the relevant controller source files;
3. inspect the relevant automated tests and the newest applicable live-test evidence;
4. treat executable source + current tests + merged commits as authoritative over stale prose documentation;
5. when documentation conflicts with code, explicitly call out documentation drift and update the stale summary in the same PR when it is in scope.

A capability may be called not implemented only after these checks.

## Write safety

Before every GitHub write, compare the working branch with current main. Write only when behind_by is 0. If the branch is stale, do not continue writing there; create a fresh branch from the current integration point or reconcile it first.

Never merge when the user explicitly asked that the work only be prepared for review/test.

## Runtime safety

Preserve the existing AL Bot principles: central ActionBoundary, live-game truth over cached/external data, bounded actions, explicit ownership, global STOP, UNKNOWN => fail closed, and no blind retry of irreversible actions.

External sources such as ALData are advisory. They may improve planning but never prove that a gameplay mutation is safe; live state must be revalidated immediately before mutation.
