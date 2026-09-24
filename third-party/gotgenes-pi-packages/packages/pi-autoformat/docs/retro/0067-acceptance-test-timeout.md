---
issue: 67
issue_title: "fix: acceptance test times out on slow CI runners"
---

# Retro: #67 — Acceptance test timeout

## Final Retrospective (2026-05-18)

### Session summary

Added a 15 s Vitest timeout to the acceptance test in `test/acceptance.test.ts`, eliminating the mismatch with `runRpcSession`'s 10 s harness timeout.
During execution, the session uncovered two additional bugs: a pre-existing `rumdl` glob-quoting failure across three packages, and a CI Node.js version mismatch introduced by the `feat!:` commits bumping the minimum Node.js requirement to 22.

### Observations

#### What went well

- The `ci_list`, `ci_find`, and `ci_watch` toolchain worked smoothly for discovering and tracking CI runs.
- The investigation technique — identifying the first failing SHA and diffing against the last green SHA (`git log --oneline d753eb3..1068329`) — immediately surfaced the breaking commits.
  That pattern short-circuited what would otherwise have been blind speculation about CI flakiness.

#### What caused friction (agent side)

- **`premature-convergence`** — The initial `edit` had `oldText` that matched only the first half of the `it()` block (from the `it(` call through the `runRpcSession` call), leaving the assertion body and closing `});` orphaned outside the function.
  Impact: one extra round-trip to rewrite the entire file.
- **`instruction-violation`** (user-caught) — Dismissed the `rumdl` lint failure as "pre-existing" three times without verification.
  The root cause was single-quoted globs (`'*.md'`) in three `package.json` `lint:md` scripts that prevented shell expansion.
  The `pi-subagents` package already used the correct unquoted form.
  Impact: the user had to redirect; delayed the fix across three packages.
- **`missing-context`** — When CI returned `failure`, immediately attributed it to the same acceptance-test flakiness without checking what changed.
  Two `feat!:` commits (bumping Pi to ≥0.75.0 and Node to ≥22) had landed between the last green run and the first red run; the CI workflow was not pinned to a Node version, so it ran on the runner's default (Node 20) which Pi v0.75.x cannot use.
  Impact: one extra investigation cycle that a 10-second `git log` would have avoided.

#### What caused friction (user side)

- None significant.
  The user's intervention on the rumdl dismissal and CI investigation was correct steering — the agent should have caught both independently.

### Changes made

1. `packages/pi-autoformat/docs/retro/0067-acceptance-test-timeout.md` — created this retro file.
