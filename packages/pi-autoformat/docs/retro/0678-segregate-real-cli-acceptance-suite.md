---
issue: 678
issue_title: "pi-autoformat: real-CLI acceptance tests still flake at the 30 s RPC timeout"
---

# Retro: #678 — Segregate the real-CLI acceptance suite

## Stage: Planning (2026-07-28T23:31:13Z)

### Session summary

Planned the fix for the recurring real-`pi`-CLI acceptance flake that [#618]'s 30 s timeout raise failed to remove.
Measured the baseline before asking anything, which reframed the issue: the two acceptance files are 97% of the package's suite time and the long pole of the entire root run, and the 30 s budget gives the slower test only 2.5× headroom over its 12.1 s idle baseline.
The operator chose direction B (take the real-CLI tests off the default root path) implemented via Vitest `projects`, with a dedicated CI step and the root `test` script left as a full-workspace run.

### Observations

- Planning-time measurement changed the framing twice.
  First, excluding the two files drops the package suite from 20.3 s to 0.59 s and the root suite from 21.6 s to ~12 s — so segregation makes the root run *faster*, not merely more reliable, which was not obvious from the issue.
  Second, 12 CPU spinners slowed the acceptance tests by only ~15%, so the trigger is the concurrent module-import storm (`pi-permission-system` reports `import 40.55s` across 130 files), not CPU contention.
  An in-package fix therefore could not have worked.
- A measurement refuted something I had put in the `ask_user` preview as a benefit.
  I claimed `fileParallelism: false` would buy meaningful headroom on the acceptance project; measured back-to-back it costs ~6.5 s wall and buys ~1 s per test on a 10-core box.
  Kept it anyway for the 2–4 vCPU CI runner case, but recorded the local numbers in the plan so it is not mistaken for an unmeasured assumption.
- The operator bounced the first answer with two good questions ("when *would* we run them, and how do we avoid CI timeouts?") plus a new idea (targeted per-package suites).
  Grounding that idea was decisive: `pnpm --filter '...[origin/main]'` correctly selects one package on a dirty tree, but reports `No projects matched the filters` on a clean tree synced with `origin/main` — exactly the state at `/tdd-plan`'s green-baseline step, where it would pass vacuously.
  That verified trap is why the root `test` script stays a full-workspace run.
- Spiked both load-bearing mechanics against `vitest@4.1.8` and reverted them: inline `projects` inherit the root `resolve.alias` (the `#src`/`#test` imports pass under `--project unit`), and `vitest.config.ts` can import a sibling TS module, which lets one exported `ACCEPTANCE_FILES` constant feed both the config and a test.
- Found that Vitest 4.1.8's `retry` accepts `{ count, delay, condition: RegExp }`, which dissolves [#618]'s stated reason for rejecting retry-once ("adds control flow").
  Offered it as a real option; not chosen, but worth remembering as a lever that no longer costs what it used to.
- The design's one genuine hazard is a future real-CLI test file not added to `ACCEPTANCE_FILES`, silently rejoining the default path.
  Pinned with `test/project-partition.test.ts`, which derives the expected set by scanning for `runRpcSession(` rather than maintaining a second list.
  Verified the predicate is exact today: only the two acceptance files match, and `test/helpers/rpc.test.ts` imports just the two timeout resolvers.
- Rejected a config-shape assertion (reading `vitest.config.ts` back to check its globs) as coupling a test to Vite's config union types for a lower-value failure mode.
- Deliberately kept `test/fallback-acceptance.test.ts` in the unit project despite its name — it spawns no CLI.
  This is why the file list is explicit rather than a glob: `test/*acceptance*.test.ts` would have captured it.
- [#618]'s budget-ordering invariant lives in `test/helpers/rpc.test.ts`, which lands in the unit project and keeps running by default.
  Flagged in Invariants at risk because a careless partition would have moved the timeout tests into the segregated project alongside the code they describe.
- Scope stayed single-package despite the issue carrying both `pkg:pi-autoformat` and `pkg:pi-subagents` labels.
  Verified `pi-subagents` spawns no real CLI (only an `execSync` in `test/session/env.test.ts`); the label reflects where the flake was *observed*, not what changes.
- Release: ship independently — no `docs/architecture/` roadmap exists for this package.
  The `test:` and `ci:` commits are hidden changelog types; the `docs(pi-autoformat):` commit carries the release.

## Stage: Implementation — TDD (2026-07-29T00:07:57Z)

### Session summary

Landed all four planned TDD steps plus one follow-up correction: the `ACCEPTANCE_FILES` source of truth and its partition guard, the `unit`/`acceptance` Vitest project split, the dedicated CI step, and the docs.
Test count went from 19 files / 306 tests to 20 files / 308 tests under `test:all`, split 18 / 306 for the default `unit` project and 2 / 2 for `acceptance`.
Root `pnpm run test` dropped from 21.6 s to 16.2 s, and `pi-autoformat` is no longer the long pole.

### Observations

- The red step caught a real defect in the plan's sketched predicate: `test/project-partition.test.ts` matched *itself*, because the guard names the marker string `runRpcSession(` in a constant.
  Fixed by exempting the guard file explicitly rather than switching to an import-shaped regex — a call-site substring cannot be broken by reformatting, whereas a regex that under-matches would leave a real-CLI file in the `unit` project with the guard still green (a false green is the one failure mode a guard must not have).
- The plan predicted root `pnpm run test` would fall to ~12 s; the measured result is 16.2 s.
  The prediction assumed `pi-permission-system`'s 11.6 s would simply become the long pole, but it takes 12.8 s once it is no longer competing with `pi-autoformat`, and pnpm's per-package startup across nine packages adds the rest.
  Treated as a prediction refinement rather than a missed target: the Goals are about determinism by construction, not a speed number, and no design decision hung on the figure.
  Recording it here because the plan's predicted-effect table still reads "~12 s".
- Verified the guard is not vacuous by adding a throwaway test file that calls `runRpcSession(...)` and confirming the guard fails and names it.
  The first attempt at this probe was a false negative of my own making — I wrote `void runRpcSession;`, which contains no call and correctly did not trip the predicate.
  Worth remembering: when probing a guard, make the probe match the guard's actual contract, or you "verify" nothing.
- The `tidy-first-assessor` returned "no preparatory tidying warranted" and was right — every modified file was either brand new or under 20 lines.
  It also independently confirmed the grep predicate was safe against the current import layout, which is the question I had flagged for it.
- Pre-completion reviewer: **PASS**, with two WARNs.
  The first (the plan's stale "~12 s") is addressed by this retro entry.
  The second was a genuine catch: my code comment claimed the call-site predicate "cannot silently under-match," which is false for an aliased import (`runRpcSession as run`).
  Landed `7a570dd6` to state the gap and its remedy instead of promising a guarantee the code does not provide.
- The docs commit also corrected two pre-existing stale claims in the sections it was already rewriting: `pnpm run typecheck` (no such script — it is `pnpm run check`) and a "no workflow changes needed" bullet that the new CI step supersedes.
- The CI step's real verification is deferred to ship time by design.
  It is the one part of this change that cannot be confirmed locally, and a mistake there would silently drop real-CLI coverage entirely — confirm at `/ship-issue` that the `Real-CLI acceptance tests (pi-autoformat)` step appears and reports 2 passing tests.

## Stage: Final Retrospective (2026-07-29T01:08:04Z)

### Session summary

Ran Planning, TDD, and Ship for #678 in one continuous session, landing `pi-autoformat` 5.1.8.
The change took the two real-`pi`-CLI acceptance tests off the default `pnpm test` path via a Vitest `unit`/`acceptance` project split, with a partition guard, a dedicated CI step, and docs — six commits, no rework, and a clean PASS from the pre-completion reviewer.
The session's defining feature was that measurement, not reasoning, drove every significant decision; its defining flaw was one place where I let an *un*measured number wear the same clothes.

### Observations

#### What went well

- Measuring before asking did not just inform the choice — it changed what the options *meant*.
  The baseline sweep showed the two acceptance files were 97% of the package's suite time (20.3 s of 20.9 s) and the long pole of the entire root run.
  Without that, "take them off the default path" reads as trading coverage for reliability; with it, the same option also makes the root suite 25% faster.
  It also killed a plausible-sounding theory: 12 CPU spinners slowed the tests only ~15%, so the trigger is the concurrent module-import storm (`pi-permission-system` reports `import 40.55s` across 130 files), not CPU contention — which is why [#618]'s in-package timeout fix could never have worked.
- The TDD red step caught a defect in the **plan**, not in the code.
  `test/project-partition.test.ts` matched itself, because a guard that names its own marker string (`runRpcSession(`) is inside the set it scans.
  This is TDD acting as design feedback rather than regression protection, and it is the strongest argument for writing the guard before wiring the split.
- A prior retro's fix demonstrably held.
  [#618]'s retro recorded an `instruction-violation` at ship step 6.4 — reaching for `ci_find`/`ci_watch` on an `UNSTABLE` release PR instead of re-polling `statusCheckRollup`.
  This time I read the rollup, distinguished a genuinely `IN_PROGRESS` check from the empty-rollup `GITHUB_TOKEN` case, waited with `gh pr checks --watch`, and merged.
  Worth recording that the loop closed.
- The `pre-completion-reviewer` earned its dispatch on judgment rather than checklist.
  It caught that my code comment promised a guarantee the code does not provide (see below) — a correctness claim, not a style nit.
- Grounding the operator's own new idea beat arguing about it.
  When they raised targeted per-package test suites, I ran `pnpm --filter '...[origin/main]'` both ways and found it selects nothing on a clean tree synced with `origin/main` — exactly the state at `/tdd-plan`'s green-baseline step, where it would pass vacuously.
  A verified two-line demonstration settled a question that prose could not.

#### What caused friction (agent side)

- `missing-context` (self-identified) — I put a fabricated number with false precision into an `ask_user` option preview.
  The "Vitest projects" option listed as a benefit: "`fileParallelism: false` also removes the in-package overlap between the two spawns for free (18.0 s wall → ~18.5 s serial, since they currently overlap only slightly)."
  I had not measured that.
  When I did measure it later in planning, serializing cost ~6.5 s of wall time and bought ~1 s of per-test headroom — the opposite of "for free."
  Impact: no rework, and I documented the refutation honestly in the plan and kept the setting for a different, stated reason (2–4 vCPU CI runners).
  But the operator chose among options partly on a stated benefit that did not exist, which is the one failure mode a decision-support artifact must not have.
- `missing-context` (self-identified) — the same root cause produced the plan's "~12 s" root-suite prediction against a measured 16.2 s actual.
  I measured the baseline (21.6 s) and the package suite without the two files (0.59 s), then *inferred* the post-change root total from "`pi-permission-system`'s 11.6 s becomes the long pole" instead of running the root suite with the files excluded — a measurement I could have taken in under a minute with the tools already in hand.
  Impact: no rework; caught and reported at implementation time, and recorded in the TDD stage note because the plan's table still reads "~12 s."
- `other` (self-identified) — my first probe of the partition guard's non-vacuity was itself a false negative.
  I wrote `void runRpcSession;`, which contains no call, so the guard correctly did not fire — briefly looking like evidence the guard was broken.
  Impact: one extra tool call, no rework.
  The trap is subtle because a near-miss probe produces a *confident wrong conclusion* about the guard in either direction.

#### What caused friction (user side)

- None — and one intervention was unusually valuable.
  The operator declined to rubber-stamp the first `ask_user`, answering with "I'm not totally confident in my answer.
  Maybe it is some combination.
  Or maybe it is targeted test suites" and two concrete questions (when would we run them; how do we avoid CI timeouts).
  That surfaced an option I had not offered and forced the mechanism into the open.
- Opportunity: those two questions were answerable from my own option set and should not have needed asking.
  My option B preview stated the *outcome* ("only the dedicated CI step gates extension-load regressions") without the *mechanism* (a dedicated step runs alone, which is precisely the contention that causes the flake).
  When an option's viability rests on a mechanism, the mechanism belongs in the option.

### Diagnostic details

- **Model-performance correlation** — the session hopped models (`sonnet-5` → `deepseek-v4-flash` → `fable-5` → `haiku-4-5` → `opus-5` → `sonnet-5` → `opus-5`); the ship stage ran entirely on `claude-sonnet-5` and the retro on `claude-opus-5`.
  Both subagents ran on their frontmatter-configured `anthropic/claude-sonnet-5`, which matched task weight — the reviewer's catch (an overstated correctness guarantee in a comment) is judgment work a weaker model plausibly misses.
  No mismatch observed in either direction.
- **Escalation-delay tracking** — no rabbit-holes.
  The longest same-error sequence was two tool calls (the guard-probe false negative, corrected on the next call).
- **Unused-tool detection** — `colgrep` went unused this session, correctly: every search was for an exact symbol or script name (`runRpcSession`, `pnpm test`, `fileParallelism`), which is `grep`'s domain per the `colgrep` skill's decision table.
  No friction point had an undispatched subagent that would have helped.
- **Feedback-loop gap analysis** — no gap.
  Verification ran per TDD step (`vitest run <file>` plus `check`), root `lint` before each commit, and the full gate set at the end.
  The root `pnpm run test` was also run mid-cycle at step 2 to verify a timing claim rather than deferred to the end.

### Changes made

1. `.pi/prompts/plan-issue.md` — added a number-provenance rule to the `Decide` section: every number in an `ask_user` option or the plan's predicted-effect table must be labeled measured or estimated, and measured when the command runs in under a minute.
   Prompted by the fabricated "18.0 s → ~18.5 s" benefit in this session's first `ask_user` and the inferred "~12 s" prediction against a measured 16.2 s.
2. `.pi/skills/testing/SKILL.md` — added a rule under § Test assertions that a non-vacuity probe must match the guard's exact predicate, since a near-miss probe leaves the guard silent and reads as proof it is broken.

Considered and rejected: a rule requiring the *mechanism* (not just the outcome) in `ask_user` options, as duplicative of the existing Refs #635 rule; a `/tdd-plan` step to re-measure the plan's predicted numbers, as over-correction for a self-caught issue that caused no rework; codifying the Vitest `retry: { condition }` finding, which belongs in this retro as a discoverable lever rather than a standing rule.

[#618]: https://github.com/gotgenes/pi-packages/issues/618
