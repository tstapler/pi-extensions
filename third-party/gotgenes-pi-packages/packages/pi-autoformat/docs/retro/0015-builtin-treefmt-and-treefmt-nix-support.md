---
issue: 15
issue_title: "Built-in `treefmt` and `treefmt-nix` project formatter support"
---

# Retro: #15 — Built-in `treefmt` and `treefmt-nix` project formatter support

## Final Retrospective (2026-05-02T03:50:00Z)

### Session summary

Took issue #15 from `/plan-issue` through `/tdd-plan` and `/ship-issue` end-to-end.
Added two opt-in built-in formatters (`treefmt`, `treefmt-nix`), a wildcard `"*"` chain key, per-session config-root discovery cache, skip-pattern parsing, and a `treefmt-nix`-over-`treefmt` precedence rule inside `fallback` groups.
Eleven `feat:` commits plus a `docs:` commit landed cleanly; release-please rolled them into `v2.4.0` with no human-in-the-loop debugging.

### Observations

#### What went well

- The plan/TDD/ship flow ran end-to-end with zero rework or user intervention.
  271 tests passed; type-check clean; release-please picked everything up.
- Refactoring `executeChainGroup` into `executeChainGroupWithPartition` and delegating preserved the existing `BatchRun[]` API, so all 16 prior executor tests stayed green while new partition-aware behavior was added.
  Existing tests stayed unchanged.
- The async `discoverRoot` precedence check inside the `fallback` resolver — `treefmt-nix` wins over `treefmt` only when both PATH-probe true **and** resolve to the same root — landed first try with two focused tests (same-root override; different-root preserves user order).
- `walkUp` + `DiscoveryCache` design (per-session memoization, sentinel for "no match") landed first try and the cache reuse test exercises it cleanly.

#### What caused friction (agent side)

- `other` (self-identified, post-hoc) — Two `void 0;` lines were inserted into tests (`test/builtin-formatters.test.ts:74`, `test/formatter-executor.test.ts:299`) as an `Edit`-tool workaround: when inserting tests near visually similar text, I padded `oldText` with a fake marker line instead of widening `oldText` with more surrounding context.
  Impact: 2 lines of dead code shipped to `main`; cleanup deferred to this retro commit.
- `other` (lint-caught at end of TDD) — `wildcardConfig` const left over in `test/prompt-autoformatter.test.ts` after I switched the wildcard test from a fake-formatter-shadow approach to monkey-patching the real built-in registry mid-edit.
  Biome flagged the unused-binding warning during `pnpm run lint`; removed during the lint-fixup amend.
  Impact: one extra edit cycle, amended into the most recent feat commit per the prompt's rule.
- `missing-context` (step 5) — `treefmtConfigPath` initially used `existsSync` to choose between `treefmt.toml` and `.treefmt.toml`, which broke a unit test that passed `/repo` as the root without creating any files on disk.
  Adjusted to default to the canonical `treefmt.toml` when neither file exists.
  Impact: one extra red→green cycle within step 5, no rework.
- `instruction-violation` (self-identified, mild) — Plan suggested separate `test:` then `feat:` commits per TDD step.
  I bundled each step's test + implementation into one `feat:` commit, citing AGENTS.md's "small reviewable commits" preference.
  Noted as a deviation in the summary; not flagged by the user.
  Impact: none; arguably the right call given AGENTS.md, but the prompt itself already says "`test:` for test-only commits (rare; usually folded into the feat)" — so this matches the prompt's own hint.

#### What caused friction (user side)

- None worth flagging — the user ran the three slash-command prompts and let them complete.
  This is a sign the prompts are doing the right thing, not a friction point.

### Changes made

1. Removed leftover `void 0;` cruft from `test/builtin-formatters.test.ts` (line 74) and `test/formatter-executor.test.ts` (line 299).
2. Added a one-line rule to the `## Testing` section of `AGENTS.md`: "Do not insert no-op statements (`void 0;`, unused locals) in tests just to make an `Edit` tool's `oldText` unique — widen `oldText` with surrounding context instead."
3. Wrote this retro file at `docs/retro/0015-builtin-treefmt-and-treefmt-nix-support.md`.

### Cross-session pattern

The pattern from #13 holds: when the plan is detailed enough to enumerate types, edge cases, and TDD ordering, the TDD execution is essentially mechanical and lands without rework.
The friction sources are now small enough to be agent-tooling artifacts (`Edit` no-op markers, in-flight refactor cruft) rather than design or strategy gaps.
