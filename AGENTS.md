# Repository Agent Rules

## AL Bot development

- Do not use Codex to develop, modify, test, review, approve, or merge AL Bot production changes.
- Do not delegate bot-development work under `src/`, `bootstrap/`, `host/`, `scripts/`, `tests/`, `dist/`, or `release/` to Codex.
- Do not use Codex-generated code, reviews, or conclusions as release evidence or as an approval gate for AL Bot changes.
- Bot changes must use the explicitly selected non-Codex development workflow, repository CI, and live runtime evidence.
- Existing safety rules remain mandatory: do not weaken fail-closed behavior, do not rewrite historical evidence, and do not remove tests to make CI pass.
