---
issue: 13
issue_title: "Add `fallback` step type to formatter chains"
---

# Retro: #13 — Add `fallback` step type to formatter chains

## Final Retrospective (2026-05-02T00:22:50Z)

### Session summary

Took issue #13 from `/plan-issue` through `/tdd-plan` and `/ship-issue` end-to-end.
Added a `fallback` chain step type with `PATH`-only fallthrough, per-flush probe caching, and reporting that names which alternative actually ran.
Eleven TDD commits landed cleanly into release `v2.1.0` via release-please.
Mid-session the user introduced a new "sync with remote first" rule for all flow prompts; that work was committed independently and the TDD flow resumed without rework.

### Observations

#### What went well

- The plan/TDD/ship flow worked end-to-end against a non-trivial change with no human-in-the-loop debugging.
  Eleven feat commits + acceptance test + docs landed in a single sitting and release-please picked them all up into `v2.1.0` automatically.
- TDD discipline caught a real bug at step 10 of the plan: the acceptance test surfaced that `flushPrompt` was emitting groups with empty `runs[]` when all fallback alternatives were missing, contradicting the plan's "group is a no-op" wording.
  Fixed in the same commit.
- Running `pnpm exec tsc --noEmit` mid-flow caught a vacuous test in step 8 — `commandProbe` was passed via the constructor's options but TS flagged it as an unknown property.
  Without the typecheck the test would have passed for the wrong reason.

#### What caused friction (agent side)

- `instruction-violation` (self-identified, end-of-flow) — `pnpm run lint:fix` reformatted some test files; that cleanup landed inside the `docs:` commit instead of being amended onto the most recent feat commit.
  The existing rule in `.pi/prompts/tdd-plan.md` says to amend onto the prior feat commit when not yet pushed; I had not pushed.
  Impact: noisier final commit (`docs: document fallback chain steps...` touches 9 files instead of 2), but no rework.
- `rabbit-hole` — markdown table column alignment with em-dashes (`—`) failed `MD060` repeatedly because em-dash width-vs-byte math was off.
  Took three table-edit attempts to land a passing layout.
  Should have switched to ASCII hyphen on the first failure.
  Impact: ~1 minute, no rework.
- `missing-context` (self-identified, step 8) — wrote a `commandProbe` test against `PromptAutoformatter` constructor options before extending `PromptAutoformatterOptions` to declare the field.
  Test passed vacuously (unknown property silently ignored at runtime).
  Caught by `pnpm exec tsc --noEmit`, fixed in same commit.
  Impact: ~5 minutes to wire the option through, same commit.
- `missing-context` (self-identified, plan-author side) — plan TDD step 10 said put the e2e test in `test/acceptance.test.ts`, but that file is gated on the real `pi` CLI.
  Created `test/fallback-acceptance.test.ts` instead and noted the deviation in the commit body.
  Impact: marginal — correct outcome, ~30 seconds of judgment to deviate.
- `wrong-abstraction` — when changing `executeChainGroup`'s input shape in step 7, I rewrote `test/formatter-executor.test.ts` wholesale via `Write` instead of surgical edits.
  All tests still covered the same surface but the diff is harder to review.
  Impact: cosmetic.

#### What caused friction (user side)

- The "sync with remote first" rule (`git pull --ff-only` at the top of every flow prompt) was retrofitted mid-TDD.
  Catching it then was good — the user noticed before I'd made anything irreversible — but had the rule existed before this session it would have eliminated one full conversational interruption.
  Treat as a "rule earned through observation, not friction" rather than user-side friction.

### Novel wins

- The `/plan-issue` → `/tdd-plan` → `/ship-issue` chain produced a clean `v2.1.0` release with no manual intervention beyond the TDD execution itself.
  This is the first session where release-please's commit grouping handled a 9-feat-commit feature cleanly into one minor bump.
- Mid-flow prompt evolution worked: the user paused execution to update flow templates, I committed those updates as their own change, and TDD resumed without state corruption.

### Insight from retro discussion

Proposal B (a human-readable "use ASCII `-` in markdown tables" rule for `AGENTS.md`) was rejected with the observation: markdownlint already caught the violation — that's *why* the build failed three times — so the right behavioral lesson is "linter says column width is wrong → stop iterating on whitespace, switch to ASCII," not "add a project rule papering over a tool that already works."
Adding rules for things the existing toolchain already detects is redundant when the project's premise is auto-formatting.
Kept the retro file's record of the rabbit-hole as the lesson; no `AGENTS.md` change.

### Changes made

1. `.pi/prompts/tdd-plan.md` — appended one clause to the lint-fixup rule: "The fixup must NOT land in a `docs:` commit."
   Closes the gap that produced this session's noisy `3bbc846` docs commit.
2. `docs/retro/0013-fallback-chain-step-type.md` — this file.
