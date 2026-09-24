---
issue: 678
issue_title: "pi-autoformat: real-CLI acceptance tests still flake at the 30 s RPC timeout"
---

# Segregate the real-CLI acceptance suite from the default test run

## Release Recommendation

**Release:** ship independently

`pi-autoformat` has no `docs/architecture/` roadmap, so this issue belongs to no release batch and ships on its own cadence.
The substantive changes are `test:`- and `ci:`-scoped, both `hidden` changelog types that cut no release on their own.
The `docs(pi-autoformat):` update to the shipped `docs/testing.md` and `README.md` is the unhidden type that carries the release, with the suite split batched alongside.
There is no runtime behavior change — `src/` is untouched.

## Problem Statement

The two real-`pi`-CLI acceptance tests (`test/acceptance.test.ts`, `test/acceptance-event-bus.test.ts`) still time out under the concurrent root `pnpm run test`, now at the 30 s default that [#618] raised them to.
[#618] diagnosed the cause correctly — cross-package process contention under `pnpm -r`, where every package's vitest runs at once — but fixed only the symptom by raising a number.
Its own retro was explicit that the fix was unproven, and this issue is that proof arriving in the negative.

This is the third pass over the same surface, and the lineage matters.
[#67] raised only the Vitest per-test budget and explicitly deferred the harness timeout; [#618] raised the harness timeout from 10 s to 30 s and explicitly deferred removing the contention.
Each step bought headroom against a load level that then grew past it, which is the pattern this plan breaks.

The cost is not the flake itself but the standing tax it imposes.
A red baseline in a package the session never touches forces every `/tdd-plan` in every package to distinguish "pre-existing failure I must fix first" from "load flake, re-run" before it can begin work.

Raising the timeout again is an unbounded ladder: a bigger workspace or a busier machine reaches the new ceiling too.
This plan removes the contention rather than out-waiting it, by taking the real-CLI spawns off the default root test path entirely.

## Goals

- Make the default `pnpm run test` (root and package) deterministic with respect to real-`pi`-CLI process contention, by construction rather than by timeout headroom.
- Keep real-CLI acceptance coverage gating every PR and every push to `main`, in a CI step that runs with nothing else concurrent.
- Keep the full suite runnable in one command locally.
- Make it structurally hard to add a new real-CLI test that silently lands back on the default path.

This change is **not** breaking: no runtime code, config schema, or published behavior changes.
It alters what `pnpm test` runs inside this package's development workflow only.

## Non-Goals

- Raising `DEFAULT_RPC_TIMEOUT_MS` again — the ladder this issue rejects.
  The 30 s default and the `PI_AUTOFORMAT_RPC_TIMEOUT_MS` override from [#618] both stay exactly as they are.
- Retrying the RPC spawn on timeout ([#618] direction B).
  Considered and measured below; not chosen, because segregation removes the failure mode instead of absorbing it.
- Serializing the workspace test run (`pnpm -r --workspace-concurrency=1`).
  Measured at +6 s on the root suite and rejected in favor of the option that also makes the root suite faster.
- Change-targeted root test selection (`pnpm --filter '...[origin/main]' run test`).
  Verified to select nothing on a clean tree synced with `origin/main`, which is exactly the state at `/tdd-plan`'s green-baseline step; the root `test` script stays a full-workspace run.
- Any change to `src/`, the config schema, or `test/fallback-acceptance.test.ts` (named "acceptance" but spawning no CLI, so it stays in the default run).
- Any change to the root `package.json` `test` script or to `/tdd-plan` and `/ship-issue`'s use of it.

## Background

### Existing surface

- `test/helpers/rpc.ts` — `runRpcSession()` spawns the real `pi` binary in `--mode rpc`; `resolveRpcTimeoutMs()` and `rpcVitestTimeoutMs()` (from [#618]) derive the harness and Vitest budgets from `PI_AUTOFORMAT_RPC_TIMEOUT_MS`, defaulting to 30 s and 35 s.
- `test/acceptance.test.ts`, `test/acceptance-event-bus.test.ts` — the only two files that call `runRpcSession(`, verified by grep.
- `test/helpers/rpc.test.ts` — unit tests for the two resolvers, including the budget-ordering invariant; spawns nothing.
- `test/fallback-acceptance.test.ts` — an "acceptance" anchor that does not spawn the CLI.
- `packages/pi-autoformat/vitest.config.ts` — 14 lines: `#src`/`#test` aliases, `include: ["test/**/*.test.ts"]`, a coverage reporter.
- `.github/workflows/ci.yml` — a single `check` job whose `Test` step runs `pnpm -r run test`, i.e. all nine packages' vitest processes at once.

### Measured baseline

Taken at planning time on a 10-core machine, otherwise idle.

| Measurement                                           | Value          |
| ----------------------------------------------------- | -------------- |
| `acceptance.test.ts`, single spawn                    | 6.3 s          |
| `acceptance-event-bus.test.ts`, single spawn          | 12.1 s         |
| `pi-autoformat` suite, all 19 files                   | 20.3 s         |
| `pi-autoformat` suite, excluding the 2 real-CLI files | 0.59 s         |
| Root `pnpm run test` (`pnpm -r`, concurrent)          | 21.6 s         |
| Root `pnpm -r --workspace-concurrency=1 run test`     | 27.6 s         |
| Both acceptance tests under 12 CPU spinners           | 7.3 s / 14.3 s |

Three conclusions follow, and they reframe the issue.

1. The two real-CLI files are **97% of this package's suite time** (20.3 s of 20.9 s), and `pi-autoformat` is the long pole of the entire root run — every other package finishes by 11.6 s.
   Removing them from the default path makes the root suite faster, not merely more reliable.
2. The 30 s budget gives the event-bus test only **2.5× headroom over its idle baseline** of 12.1 s.
   That is a thin ceiling, not a generous one, which is why raising it bought so little.
3. Pure CPU contention is **not** the trigger: 12 spinning processes cost only ~15%.
   The trigger is the concurrent module-import storm — `pi-permission-system` alone reports `import 40.55s` across 130 files, starting in the same window as the `pi` spawns.
   This is why an in-package fix cannot help and why the contention must be removed rather than tolerated.

### Verified design mechanics

Both load-bearing mechanics were spiked at planning time against `vitest@4.1.8` and then reverted.

- Vitest `test.projects` with inline project configs **inherits the root-level `resolve.alias`** — the 17 non-acceptance files include several importing `#src/` and `#test/`, and all passed under `--project unit`.
- `vitest.config.ts` can **import a sibling TypeScript module**, so the acceptance file list can live in one place and be consumed by both the config and a test.
- `vitest run` with no `--project` flag runs both projects: 19 files, 306 tests, matching today's totals.

One measurement changed a design assumption.
`fileParallelism: false` on the acceptance project was expected to buy meaningful headroom by keeping the two spawns from contending with each other.
Measured back-to-back on this 10-core machine, it does not:

| Mode                              | Wall          | `acceptance.test.ts` | `acceptance-event-bus.test.ts` |
| --------------------------------- | ------------- | -------------------- | ------------------------------ |
| Parallel (default)                | 14.1 / 14.7 s | 7.6 / 7.8 s          | 14.0 / 14.5 s                  |
| Serial (`fileParallelism: false`) | 21.1 / 20.8 s | 6.9 / 7.0 s          | 13.9 / 13.5 s                  |

Serializing costs ~6.5 s of wall time and buys roughly 1 s of per-test headroom, because two spawns on ten cores barely contend.
The plan keeps `fileParallelism: false` anyway, for a reason the local numbers cannot show: a GitHub-hosted runner has 2–4 vCPU, where two concurrent `pi` spawns *do* contend directly.
Since the acceptance step is dedicated and off the critical path, ~6.5 s is a fair price for making the step's timing independent of core count.
This tradeoff is recorded here so it is not mistaken for an unmeasured assumption.

### Constraints from AGENTS.md

- `vitest.config.ts` is not in the `package.json` `files` allowlist, so none of the config changes reach the published tarball.
- `docs` is an unhidden changelog type and `test`/`ci` are hidden (`release-please-config.json`), so the docs commit is what carries the release.
- Do not use `npm`/`npx`; all commands are `pnpm`, run from the repo root with `--filter`.

## Design Overview

The suite splits into two named Vitest projects sharing one config, with the file list owned by a single exported constant.

### The shared file list

```typescript
// packages/pi-autoformat/test/acceptance-files.ts

/**
 * The test files that spawn the real `pi` CLI. They are segregated from
 * the default `unit` project because their process spawns contend with
 * the other packages' vitest processes under `pnpm -r run test` (#678).
 *
 * `test/project-partition.test.ts` pins this list against the files that
 * actually call `runRpcSession`, so a new real-CLI test cannot silently
 * rejoin the default run.
 */
export const ACCEPTANCE_FILES = [
  "test/acceptance.test.ts",
  "test/acceptance-event-bus.test.ts",
] as const;
```

The list is explicit rather than a glob.
A glob such as `test/*acceptance*.test.ts` would wrongly capture `test/fallback-acceptance.test.ts`, which spawns nothing and belongs in the default run.

### The two projects

```typescript
// packages/pi-autoformat/vitest.config.ts
import { ACCEPTANCE_FILES } from "./test/acceptance-files";

const acceptanceFiles = [...ACCEPTANCE_FILES];

export default defineConfig({
  resolve: { alias: { "#src": ..., "#test": ... } },
  test: {
    coverage: { reporter: ["text", "html"] },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: acceptanceFiles,
        },
      },
      {
        test: {
          name: "acceptance",
          include: acceptanceFiles,
          fileParallelism: false,
        },
      },
    ],
  },
});
```

The `unit` project's `include` stays the current whole-tree glob and subtracts the acceptance list, so every test file is claimed by exactly one project and a new non-acceptance file needs no config edit.
The relative import (`./test/acceptance-files`) is deliberate: the `#test` alias is defined *by* this file and is not available to it.

### The scripts

```jsonc
// packages/pi-autoformat/package.json
"test":            "vitest run --project unit",
"test:acceptance": "vitest run --project acceptance",
"test:all":        "vitest run",
```

`test` keeps its name and its role as the fast default, so root `pnpm -r run test` and every existing habit keep working — they simply stop spawning real processes.
`test:all` is the one-command full run the Goals call for.

### The CI step

```yaml
# .github/workflows/ci.yml, in the existing `check` job, after `Test`
- name: Real-CLI acceptance tests (pi-autoformat)
  run: pnpm --filter @gotgenes/pi-autoformat run test:acceptance
```

This directly answers the issue's "how can we avoid the timeouts in CI with this?".
Today the acceptance spawns run inside `pnpm -r run test`, concurrent with eight other packages' vitest processes — precisely the contention that causes the flake.
As a dedicated step they run after that step completes, with nothing else on the runner, so the 30 s budget applies to a quiet machine.
The `PI_AUTOFORMAT_RPC_TIMEOUT_MS` knob [#618] built remains the escape hatch if a runner ever proves too slow, tunable in the workflow without a code change.

### The partition invariant

The design's one real hazard is a future real-CLI test file that is not added to `ACCEPTANCE_FILES`: it would land in the `unit` project and re-introduce the exact flake this issue closes.
A test pins it, deriving truth from the source rather than from a second hand-maintained list.

```typescript
// packages/pi-autoformat/test/project-partition.test.ts (sketch)
const testFiles = readdirSync(TEST_DIR, { recursive: true })
  .filter((entry) => entry.endsWith(".test.ts"));
const realCliFiles = testFiles.filter((file) =>
  readFileSync(join(TEST_DIR, file), "utf-8").includes("runRpcSession("),
);
expect(new Set(realCliFiles)).toEqual(new Set(ACCEPTANCE_FILES));
```

Grep confirms the predicate is exact today: `runRpcSession(` appears in precisely the two acceptance files.
`test/helpers/rpc.test.ts` imports only `resolveRpcTimeoutMs` and `rpcVitestTimeoutMs`, so it does not match, and `test/helpers/rpc.ts` is not a `*.test.ts`.

The test also asserts each listed path exists on disk, so a rename that empties the acceptance project fails loudly instead of silently running zero real-CLI tests.

A config-shape assertion (reading `vitest.config.ts` back and checking the projects' globs) was considered and rejected: it couples a test to Vite's config union types for a lower-value failure mode — someone editing the config to bypass the shared constant — while the grep-based partition test catches the failure mode that actually recurs.

### Predicted effect

| Measurement                                          | Before                        | After                                                |
| ---------------------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| `pi-autoformat` `pnpm test`                          | 20.3 s, 19 files              | ~0.7 s, 18 files                                     |
| Root `pnpm run test`                                 | 21.6 s                        | ~12 s (`pi-permission-system` becomes the long pole) |
| Real-CLI contention on the default path              | present                       | impossible by construction                           |
| Real-CLI coverage per PR / push                      | in the concurrent `Test` step | in a dedicated, uncontended CI step                  |
| `pnpm --filter @gotgenes/pi-autoformat run test:all` | n/a                           | 20 files, full coverage                              |

File counts are 18 / 20 rather than 17 / 19 because this plan adds `test/project-partition.test.ts` to the unit project.

## Module-Level Changes

1. `packages/pi-autoformat/test/acceptance-files.ts` (new)
   - Exports `ACCEPTANCE_FILES`, the single source of truth consumed by `vitest.config.ts` and `test/project-partition.test.ts`.
2. `packages/pi-autoformat/test/project-partition.test.ts` (new)
   - Asserts the files calling `runRpcSession(` are exactly `ACCEPTANCE_FILES`, and that every listed path exists.
3. `packages/pi-autoformat/vitest.config.ts`
   - Imports `ACCEPTANCE_FILES`; replaces the flat `include` with a `projects` array declaring `unit` (whole tree minus the acceptance list) and `acceptance` (the list, `fileParallelism: false`).
   - `resolve.alias` and `coverage` stay at the root level, where both projects inherit them (verified).
4. `packages/pi-autoformat/package.json`
   - `test` becomes `vitest run --project unit`; adds `test:acceptance` and `test:all`.
   - `test:watch` stays `vitest` (watch mode over both projects is the right default for interactive work).
5. `.github/workflows/ci.yml`
   - Adds a `Real-CLI acceptance tests (pi-autoformat)` step to the existing `check` job, after `Test`.
6. `packages/pi-autoformat/docs/testing.md`
   - The opening "Run everything with `pnpm test`" is now false and must change; add a "Running the suites" subsection covering `test`, `test:acceptance`, `test:all`, and the CI step.
   - The "Acceptance tests" section gains the segregation rationale and the partition invariant.
   - The "Timeouts" subsection keeps the [#618] content but reframes it: the budget is no longer the primary defense against contention, it is the backstop, and `PI_AUTOFORMAT_RPC_TIMEOUT_MS` is now the CI tuning lever.
   - The LLM-gated section's "out of scope for default `pnpm test`" phrasing needs a consistency pass now that a second suite is also out of the default path.
7. `packages/pi-autoformat/README.md`
   - The `## Development` block's `pnpm test` and the following sentence describing the suite layout.
8. `.pi/skills/package-pi-autoformat/SKILL.md`
   - The `## Testing` section gains a line recording that `pnpm test` no longer covers the real CLI and that `test:acceptance` does — a future session's green baseline depends on knowing this.

Grep results backing the file list: `runRpcSession` appears only in `test/helpers/rpc.ts`, the two acceptance files, and `docs/` prose; `pnpm test` appears in `docs/testing.md` (lines 12, 101) and `README.md` (line 127); no `.pi/prompts/` template and no other package's skill references this package's acceptance suite.
`test:acceptance` and `test:all` are new names with no existing references anywhere.

## Test Impact Analysis

1. **New tests enabled.**
   `test/project-partition.test.ts` is newly possible because the acceptance file list becomes a first-class exported value rather than an implicit property of a glob.
   It pins an invariant that has never had a test: which files are allowed to spawn real processes.
2. **Redundant tests.**
   None.
   All 306 existing tests keep running; only their partitioning across two invocations changes.
   `test:all` reproduces today's exact totals.
3. **Must stay as-is.**
   `test/helpers/rpc.test.ts` stays in the `unit` project and is unchanged — it spawns nothing, and it carries [#618]'s budget-ordering invariant, which must keep running on every default invocation.
   Both acceptance `it()` blocks are unchanged: same assertions, same harness, same timeouts.
   `test/fallback-acceptance.test.ts` stays in the `unit` project despite its name.

## Invariants at risk

- **[#618]'s budget-ordering invariant** — `rpcVitestTimeoutMs(env) > resolveRpcTimeoutMs(env)`, so the harness's descriptive error (with captured stdout/stderr) surfaces before Vitest's generic kill.
  Pinned by `test/helpers/rpc.test.ts`, which lands in the `unit` project and therefore still runs on every default `pnpm test`.
  Verified: 30 s harness / 35 s Vitest before and after; this plan changes neither constant.
  This is the invariant most at risk of silent loss, since a careless partition could have moved the timeout tests into the segregated project alongside the code they describe.
- **Total coverage** — every test that runs today must still run somewhere.
  Measured before: 19 files, 306 tests under `vitest run`.
  Predicted after: 20 files, 306 + 2 tests under `test:all`, split 18 / 2 across the projects.
  The TDD steps verify the split sums back to the whole rather than asserting the unit count alone.
- **Real-CLI coverage on every PR and push** — today it rides `pnpm -r run test` in the `check` job.
  After this change it must be the dedicated step; if that step were omitted, the suite would silently never run in CI.
  Step 3's verification is therefore a CI observation, not a local one.

## TDD Order

1. **Red → Green — pin the real-CLI file list.**
   - Surface: `test/project-partition.test.ts` (new) against `test/acceptance-files.ts` (new).
   - Red: create `acceptance-files.ts` exporting an empty `ACCEPTANCE_FILES`; the partition test fails because the two files calling `runRpcSession(` are not listed.
   - Green: populate the list with the two paths.
   - Verify: `pnpm --filter @gotgenes/pi-autoformat exec vitest run test/project-partition.test.ts`, then `pnpm --filter @gotgenes/pi-autoformat run check`.
   - Commit: `test(pi-autoformat): pin the real-CLI acceptance file list (#678)`
2. **Green (wiring) — split into `unit` and `acceptance` projects.**
   - Surface: `vitest.config.ts`, `package.json`.
   - This step has no red: it is a configuration split whose effect is observable as file counts, and the invariant it could violate is already pinned by step 1.
   - Change: add the `projects` array importing `ACCEPTANCE_FILES`; repoint `test` to `--project unit`; add `test:acceptance` and `test:all`.
   - Verify, asserting the split sums back to the whole: `run test` → 18 files; `run test:acceptance` → 2 files, 2 tests; `run test:all` → 20 files, 308 tests.
     Then `pnpm run test` at the root and confirm the total drops to roughly 12 s.
   - Commit: `test(pi-autoformat): split unit and real-CLI acceptance vitest projects (#678)`
3. **CI — give the acceptance suite its own uncontended step.**
   - Surface: `.github/workflows/ci.yml`.
   - Change: add the `Real-CLI acceptance tests (pi-autoformat)` step to the `check` job after `Test`.
   - Verify: local YAML lint only; the real verification is the CI run at ship time, where the step must appear, pass, and report 2 tests.
     Confirm it at `/ship-issue`'s CI check rather than assuming it.
   - Commit: `ci: run pi-autoformat real-CLI acceptance suite in its own step (#678)`
4. **Docs — describe the split.**
   - Surface: `docs/testing.md`, `README.md`, `.pi/skills/package-pi-autoformat/SKILL.md`.
   - Change: the seven doc points listed in Module-Level Changes items 6–8.
   - Verify: `pnpm exec rumdl check packages/pi-autoformat/docs/testing.md packages/pi-autoformat/README.md`, and re-read the "Acceptance tests" parent section end to end after inserting the new subsection, so the insertion does not reparent the fixture or EventBus subsections that follow it.
   - Commit: `docs(pi-autoformat): document the unit/acceptance suite split (#678)`

## Risks and Mitigations

| Risk                                                                                                             | Mitigation                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The default run loses real-CLI coverage, so a broken extension entrypoint passes locally and fails only in CI.   | This is the accepted cost of the chosen direction, bounded three ways: the dedicated CI step gates every PR and push, `test:all` is one command, and the partition test guarantees the segregated set stays exactly the real-CLI files.                           |
| A future real-CLI test is added without listing it, silently rejoining the default path and restoring the flake. | `test/project-partition.test.ts` derives the expected set by grepping for `runRpcSession(` and fails on any mismatch, so the omission reds immediately rather than resurfacing as a flake months later.                                                           |
| The acceptance step flakes on a 2–4 vCPU GitHub runner, which is slower than the machine measured here.          | The step runs alone with nothing concurrent — the opposite of today's conditions — and `fileParallelism: false` removes the last intra-step contention. `PI_AUTOFORMAT_RPC_TIMEOUT_MS` remains available to raise the budget in the workflow with no code change. |
| The CI step is added but silently never runs (wrong job, wrong filter), losing the coverage the plan promises.   | Step 3's verification is explicitly deferred to the real CI run at ship time, where the step must appear and report 2 passing tests; it is called out in Invariants at risk so it is checked rather than assumed.                                                 |
| A contributor runs `pnpm test`, sees 18 files, and concludes the acceptance suite was deleted.                   | The suite split is documented in `docs/testing.md`, `README.md`, and the package skill, and the files remain visible in `test/` under their existing names.                                                                                                       |
| `--project` is a Vitest 3+/4 feature and could regress on a version bump.                                        | Verified against `vitest@4.1.8`, the catalog-pinned `^4.1.8`; a major bump would surface in the step-2 verification counts.                                                                                                                                       |

## Open Questions

None.
The three design decisions the issue left open — the segregation mechanism, the CI placement, and whether to adopt change-targeted selection — were settled during planning in favor of Vitest projects, a dedicated step in the existing `check` job, and keeping the root `test` script a full-workspace run.

[#67]: https://github.com/gotgenes/pi-packages/issues/67
[#618]: https://github.com/gotgenes/pi-packages/issues/618
