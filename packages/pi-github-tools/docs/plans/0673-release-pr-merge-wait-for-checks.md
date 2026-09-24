---
issue: 673
issue_title: "release_pr_merge fails on a still-running check instead of waiting for it"
---

# Wait Out In-Progress Checks in `release_pr_merge`

## Release Recommendation

**Release:** ship independently

`pi-github-tools` has no `docs/architecture/` roadmap, so this issue belongs to no release batch.
It is a self-contained tool-behavior improvement plus its own doc updates, and the workflow prompts that consume it are edited in the same change — nothing downstream is waiting on a sibling step.

## Problem Statement

`mergeReleasePR` reads the PR state exactly once and refuses anything that is not `MERGEABLE` + `CLEAN`.
A release-please PR opened right after a shipped commit usually still has its own `check` run in flight when `/ship-issue` reaches step 6, so the tool reports `merge_state: UNSTABLE` and returns an error for a PR that is perfectly healthy.

`UNSTABLE` is ambiguous and the two cases need opposite responses — no checks ran at all (safe to merge) versus a check still running (must wait).
Because the tool cannot tell them apart, `/ship-issue` step 6.4, `/land-worktree`, and `/ship-no-issue` each carry a prose runbook telling the agent to re-read `statusCheckRollup` by hand.
In practice that produces an arbitrary `sleep`, which under-waits or over-waits.

The wait is not hypothetical, and it is not short.
Across the last six release PRs (measured with `gh pr view <N> --json statusCheckRollup`), every one had a real `check` run:

| PR  | check started after PR creation | check duration |
| --- | ------------------------------- | -------------- |
| 685 | 5 s                             | 2 m 20 s       |
| 682 | (PR sat 5 h before the run)     | 2 m 29 s       |
| 679 | 10 s                            | 2 m 15 s       |
| 677 | 11 s                            | 2 m 12 s       |
| 672 | 7 s                             | 1 m 49 s       |
| 668 | 5 s                             | 2 m 28 s       |

All values above are measured, not estimated.
Two consequences follow.
First, the "release-please PRs have no CI runs because `GITHUB_TOKEN` does not trigger workflows" note carried by every ship prompt is no longer the common case in this repository — it is the exception.
Second, a `sleep 60` reflex under-waits by roughly a minute every time, which is why this keeps costing a retry — most recently while shipping [#662].

## Goals

- `mergeReleasePR` waits out an in-progress check instead of failing, bounded by an explicit `timeout` argument that mirrors `watchRelease`'s shape.
- The same bounded loop also covers `mergeable: UNKNOWN` / `mergeStateStatus: UNKNOWN`, the state GitHub reports while it is still computing mergeability for a freshly created PR.
- The tool emits a progress line per poll cycle so the caller can see *why* it is waiting.
- A genuinely blocked PR still fails fast, and the failure now names the specific reason — including distinguishing the empty-`statusCheckRollup` case from a failing check.
- The workflow prompts and `AGENTS.md` drop the manual `gh pr checks --watch` runbook, since the tool now owns it.
- Not breaking: no previously successful call changes outcome, and no user config edit is required on upgrade.
  The success path, the merge-method precedence, and the first line of the failure message are all unchanged.

## Non-Goals

- **Auto-merging on an empty rollup.**
  The issue proposed treating an empty `statusCheckRollup` as the `GITHUB_TOKEN` case and merging straight through.
  The operator chose to keep the refusal and make it explicit instead, so the tool never merges a PR it refuses today.
  A direct consequence: the issue's claim that "the `gh pr merge --rebase` fallback can go away entirely" does **not** hold.
  That fallback stays in the prompts for the empty-rollup case; only the *manual wait* runbook goes away.
- **Delegating to `gh pr checks --watch`.**
  Considered and rejected — see Design Overview.
- **Unifying status derivation with the CI modules.**
  This change adds a status-classification site with GitHub's GraphQL enum vocabulary (`COMPLETED`, `IN_PROGRESS`, `SUCCESS`).
  That is adjacent to [#564], which covers the six lowercase REST-vocabulary sites in `lib/ci.ts` and `lib/ci-helpers.ts`.
  Keep them separate: [#564] should absorb the new module when it lands, not the reverse.
- **Adding retry/backoff to `findReleasePR` or `closeIssue`.**
  Only `mergeReleasePR` changes.
- **Reworking `findReleasePR`'s abort handling.**
  Its blanket `catch {}` around `ghJson` reports every `gh` failure as "cancelled by user".
  That is a real wart, but fixing it is out of scope; the new loop simply does not copy it (see Design Overview).

## Background

### Current shape

`mergeReleasePR` lives in `packages/pi-github-tools/src/lib/release.ts` alongside `findReleasePR` and `watchRelease`.
It is the only one of the three with no loop:

```typescript
const pr = await ghJson<PRState>(["pr", "view", String(prNumber), "--json", "number,title,mergeable,mergeStateStatus"], signal);

if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus !== "CLEAN") {
  return { content: [...].join("\n"), isError: true };
}
```

The polling idiom already exists twice in the package — `watchRelease` (10 s interval, `timeout` default 180) and `watchRun` in `lib/ci.ts` (15 s interval, `timeout` default 300).
Both check the signal at the top of the loop, emit a progress line, check the timeout, then sleep.
This change makes `mergeReleasePR` the third instance of that shape rather than introducing new machinery.

### Rollup shape (measured)

`gh pr view <N> --json statusCheckRollup` returns a heterogeneous array.
GitHub Actions produces `CheckRun` entries; legacy third-party CI produces `StatusContext` entries.
Measured on PR 685:

```json
[
  {"__typename":"CheckRun","name":"check","status":"COMPLETED","conclusion":"SUCCESS"},
  {"__typename":"CheckRun","name":"release-please","status":"COMPLETED","conclusion":"SKIPPED"},
  {"__typename":"CheckRun","name":"publish","status":"COMPLETED","conclusion":"SKIPPED"}
]
```

Two details matter for the classification rules.
The enum values are upper-case, unlike the lower-case `status`/`conclusion` that `gh run view --json jobs` returns and that `formatProgress` already consumes.
And the `release-please` and `publish` jobs conclude `SKIPPED` on **every** release PR, so a naive "conclusion is not `SUCCESS` implies failure" rule would hard-fail every merge this tool exists to perform.

### Constraints from `AGENTS.md`

- `src/lib/` must not import from `@earendil-works/pi-coding-agent`.
  The new module is pure classification, so this holds trivially.
- The `gh` CLI is the sole external binary dependency.
- Release-please PRs merge by rebase in this repo (`defaultMergeMethod: rebase`), which the prompt edits must preserve in the surviving fallback instruction.
- The package ships a `files` allowlist with no `docs` entry, so `docs/plans/` is not published — no allowlist edit is needed.

## Design Overview

### Mechanism: poll `gh pr view`, mirroring `watchRelease`

Three mechanisms were weighed.

1. **Poll `gh pr view --json ...,statusCheckRollup` (chosen).**
   One subprocess call per cycle returns the merge state *and* the check state, so re-evaluating after the checks settle is free.
   It reuses the loop shape already present twice in the package, emits real `onProgress` lines, is bounded by an explicit `timeout`, and is testable offline by mocking `runCommand` with a JSON sequence — the same pattern as every existing lib test.
2. **`gh pr checks <N> --watch --fail-fast --interval 10` (rejected).**
   `runCommand` buffers stdout until exit, so nothing would stream to `onProgress` — the caller would see a silent two-minute hang, losing an explicit goal of the issue.
   `gh pr checks` has no timeout flag, and its exit codes conflate the two cases this issue exists to separate: `1` means both "a check failed" and "no checks reported" (verified against `gh pr checks --help`, gh 2.96.0).
   It would still need a follow-up `gh pr view` for `mergeable`/`mergeStateStatus`.
3. **Poll `gh pr checks <N> --json name,state,bucket` (rejected).**
   gh's normalized `bucket` field is attractive, but it costs two subprocess calls per decision, and `gh pr checks` exits non-zero while pending — so `gh()`, which throws on non-zero, could not be used without a new `runCommand` escape hatch in `github.ts`.

### New module: `src/lib/merge-state.ts`

Classification is a pure function over the PR's merge fields, with enough case-space (two rollup typenames, six-plus conclusion values, five-plus merge-state values) to warrant its own tests.
That matches the existing `ci-helpers.ts` precedent: a pure sibling helper module with a dedicated test file.

```typescript
/** One entry from `gh pr view --json statusCheckRollup` (CheckRun or StatusContext). */
export interface StatusCheckRollupItem {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

/** The subset of PR fields the readiness decision reads. */
export interface MergeReadiness {
  mergeable: string;
  mergeStateStatus: string;
  statusCheckRollup: StatusCheckRollupItem[];
}

export type MergeDecision =
  | { kind: "ready" }
  | { kind: "waiting-checks"; checks: CIJob[] }
  | { kind: "waiting-mergeability" }
  | { kind: "blocked"; reason: string };

export function classifyMergeState(pr: MergeReadiness): MergeDecision;
```

`MergeReadiness` is deliberately narrower than `PRState`: the decision never reads `number` or `title`, so per ISP it does not accept them.
`PRState` extends `MergeReadiness` and adds those two fields for the message formatting the caller does.

The `waiting-checks` variant carries `CIJob[]`, not raw rollup items — the normalization from GitHub's upper-case GraphQL enums to the lower-case `CIJob` vocabulary happens once, inside the module that makes the decision, so the caller can hand the result straight to the existing `formatProgress`.
That is Tell-Don't-Ask: the caller does not re-inspect the rollup to decide what to print.

Normalization rules:

| Source          | `name`    | `status`                                                    | `conclusion`                        |
| --------------- | --------- | ----------------------------------------------------------- | ----------------------------------- |
| `CheckRun`      | `name`    | `status.toLowerCase()` (`queued`/`in_progress`/`completed`) | `conclusion?.toLowerCase() ?? null` |
| `StatusContext` | `context` | `pending`/`expected` → `in_progress`, else `completed`      | `state.toLowerCase()`               |

Classification rules, in order:

1. `mergeable === "UNKNOWN"` or `mergeStateStatus === "UNKNOWN"` → `waiting-mergeability`.
   GitHub computes mergeability asynchronously; `release_pr_find` returns the instant a PR appears, so merge is often called seconds later.
2. `mergeable !== "MERGEABLE"` (i.e. `CONFLICTING`) → `blocked`, reason `mergeable is <value>`.
3. `mergeStateStatus === "CLEAN"` or `"HAS_HOOKS"` → `ready`.
   GitHub documents `HAS_HOOKS` as mergeable with passing status and pre-receive hooks.
4. `mergeStateStatus === "UNSTABLE"`:
   - empty rollup → `blocked`, reason `no checks reported (statusCheckRollup is empty)`.
   - any check not `COMPLETED` (or a `StatusContext` in `PENDING`/`EXPECTED`) → `waiting-checks`.
   - any completed check concluding `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, or `STARTUP_FAILURE` (or a `StatusContext` in `FAILURE`/`ERROR`) → `blocked`, reason `check failed: <names>`.
     `SUCCESS`, `SKIPPED`, and `NEUTRAL` are not failures.
   - all checks complete, none failing, yet still `UNSTABLE` → `waiting-checks` with an all-complete list.
     This is GitHub lagging its own `mergeStateStatus` recompute; re-polling resolves it, and the `timeout` bounds it.
5. Anything else (`DIRTY`, `BLOCKED`, `BEHIND`, `DRAFT`) → `blocked`, reason `merge state is <value>`.

### Caller: `mergeReleasePR`

```typescript
const decision = classifyMergeState(pr);
switch (decision.kind) {
  case "ready":
    return performMerge(prNumber, method, signal);
  case "blocked":
    return blockedResult(pr, decision.reason);
  case "waiting-checks":
    onProgress?.(formatProgress(decision.checks, elapsed, "checks: "));
    break;
  case "waiting-mergeability":
    onProgress?.(`waiting for GitHub to compute mergeability... (${elapsed}s)`);
    break;
}
```

One exhaustive switch at one dispatch site, with per-variant presentation dispatch — the idiomatic form the `code-design` skill names, not a scattered discriminator.
It gives `formatProgress`'s `prefix` parameter its first production caller; today only a test exercises it.

`performMerge` and `blockedResult` are private helpers placed *below* `mergeReleasePR` per the stepdown rule.
`performMerge` holds the existing merge → `git pull --ff-only` → `git rev-parse HEAD` sequence unchanged.

### Abort and error handling

The loop checks `signal?.aborted` at the top of each cycle and wraps only `sleep` in `try`/`catch`, since `sleep` rejects solely on abort.
`ghJson` failures are **not** caught — they propagate to the tool wrapper's `catch`, which returns the real `gh` error message.
This deliberately diverges from `findReleasePR`, whose blanket `catch {}` reports a genuine `gh` failure as "aborted: cancelled by user".
Preserving today's `mergeReleasePR` behavior here is both more truthful and a smaller diff; the `findReleasePR` wart is left alone (see Non-Goals).

### Result shapes

The success path is byte-identical to today.
The blocked path keeps its existing first line and field order so nothing keyed on it breaks, and appends one `reason:` line:

```text
PR #42 is not mergeable
  mergeable: MERGEABLE
  merge_state: UNSTABLE
  title: chore(main): release 1.2.0
  reason: no checks reported (statusCheckRollup is empty)
```

That `reason:` line is the prompts' new discriminator — it is what lets `/ship-issue` decide between the `gh pr merge` fallback and stopping.
The timeout path is new and also `isError: true`:

```text
timeout: PR #42 did not become mergeable within 300s
  mergeable: MERGEABLE
  merge_state: UNSTABLE
  title: chore(main): release 1.2.0
  checks: [1/3] check — in_progress
```

Abort returns `isError: true` with `aborted: cancelled by user` and the elapsed time — the merge did not happen, so it is not a success.

### Timing parameters

| Parameter         | Value | Basis                                                                                         |
| ----------------- | ----- | --------------------------------------------------------------------------------------------- |
| Poll interval     | 10 s  | Matches `watchRelease`; bounds over-wait to 10 s against a measured 1 m 49 s – 2 m 29 s check |
| `timeout` default | 300 s | Matches `watchRun`; ~2× the measured worst case (149 s)                                       |

Predicted effect on `/ship-issue` step 6: the agent's current arbitrary `sleep 60` under-waits a measured ~2 m 15 s check by roughly a minute, costing at least one wasted `release_pr_merge` retry per ship.
After this change the tool returns within 10 s of the checks settling, and the retry disappears.
The wall-clock wait itself is unchanged — it is bounded by GitHub, not by the tool.

## Module-Level Changes

Symbol and prose greps run to build this list: `mergeReleasePR`, `release_pr_merge`, `PRState`, `UNSTABLE`, `statusCheckRollup`, `gh pr merge`, `gh pr checks`, and `formatProgress` across `packages/pi-github-tools/src`, `packages/pi-github-tools/test`, `packages/pi-github-tools/docs`, `.pi/prompts/`, `.pi/skills/`, `README.md`, and `AGENTS.md`.
No `docs/architecture/` tree exists for this package, so there is no module-layout listing or health-metrics table to update.

### Added

- `packages/pi-github-tools/src/lib/merge-state.ts` — `StatusCheckRollupItem`, `MergeReadiness`, `MergeDecision`, `classifyMergeState`, and the private rollup→`CIJob` normalizer.
- `packages/pi-github-tools/test/lib/merge-state.test.ts` — classification unit tests.

### Changed

- `packages/pi-github-tools/src/lib/release.ts`
  - `PRState` extends `MergeReadiness`, adding `statusCheckRollup` to the `gh pr view --json` field list.
  - `MergeReleasePRArgs` gains `timeout?: number` and `onProgress?: (line: string) => void`.
  - `mergeReleasePR` becomes a bounded poll loop with one exhaustive dispatch on `MergeDecision`.
  - New private helpers `performMerge` and `blockedResult`, placed below `mergeReleasePR`.
  - Imports `formatProgress` and `CIJob` handling via `./merge-state`; `findRetryDelay` import is unchanged.
- `packages/pi-github-tools/src/tools/release-pr-merge.ts`
  - Adds an optional `timeout` parameter to the TypeBox schema.
  - `execute` takes `onUpdate` and passes `createProgressCallback(onUpdate)` — this is the first `release_pr_merge` use of the progress channel.
  - `description` and `promptSnippet` updated to say it waits for in-progress checks.
- `packages/pi-github-tools/test/lib/release.test.ts`
  - Every `mergeReleasePR` mock sequence must add `statusCheckRollup` to the `gh pr view` JSON and update the asserted `--json` field list — the six existing assertions on `mockRunCommand` call ordinals are all affected.
  - New tests for waiting, timeout, empty rollup, failing check, and `UNKNOWN`.
- `packages/pi-github-tools/README.md` — the `release_pr_merge` section: add the `timeout` row, describe the wait behavior, and enumerate the three failure reasons.
- `.pi/prompts/ship-issue.md` — step 6.4's `UNSTABLE` exception and the `gh pr checks --watch` instruction shrink to a sentence; the Constraints bullet referencing step 6.4 is reworded to match.
- `.pi/prompts/land-worktree.md` — the three-bullet `UNSTABLE` runbook (the `gh pr merge` fallback, the `ci_watch`-then-retry instruction) and the closing Constraints bullet.
- `.pi/prompts/ship-no-issue.md` — the step 5.3 `UNSTABLE` exception and its Constraints bullet.
- `AGENTS.md` — the "Prefer `release_pr_merge`; on its `UNSTABLE`-no-checks refusal, fall back to `gh pr merge <N> --rebase`" sentence.
  The fallback survives (the empty-rollup case still errors) but the sentence must key on the new `reason:` line rather than on `UNSTABLE` alone.

Every prompt edit keeps the surviving fallback as `--rebase`, matching `defaultMergeMethod: rebase`.
Each prompt states its `UNSTABLE` handling **twice** — once in the numbered step and once in a Constraints bullet — so both passages must be edited together in each of the three files.

### Not changed

`src/lib/ci.ts`, `src/lib/ci-helpers.ts`, `src/lib/github.ts`, `src/lib/process.ts`, and `src/lib/config.ts` are untouched.
`formatProgress` is consumed as-is; its existing `prefix` parameter needs no signature change.

## Test Impact Analysis

1. **New tests the split enables.**
   `classifyMergeState` is a pure function, so the entire case matrix — `UNKNOWN`, `CONFLICTING`, `CLEAN`, `HAS_HOOKS`, `UNSTABLE` × (empty | pending | failed | all-skipped | all-complete-but-still-unstable), `DIRTY`/`BEHIND`/`BLOCKED`/`DRAFT`, and both rollup typenames — is covered without mocking a subprocess at all.
   That matrix is impractical to express through `mergeReleasePR` alone, where each case costs a four-call `runCommand` mock sequence.
   The `SKIPPED`-is-not-a-failure rule in particular gets a direct test; today it is only implicit in the fact that releases merge at all.
2. **Tests that become redundant.**
   None are removed.
   The existing `returns error when PR is not mergeable` test (`CONFLICTING`/`BLOCKED`) still exercises the loop's blocked exit and stays as an integration-level check that the classification is actually wired in.
3. **Tests that must stay as-is in substance.**
   The three merge-method tests (`--merge` default, `--squash`, `--rebase` precedence) and the signal-threading test pin `performMerge`'s call sequence and ordinals — exactly the behavior this change must not disturb.
   They need mechanical updates (the `--json` field list and the added rollup in the mocked response) but their assertions must keep the same meaning.

## Invariants at Risk

The prior change to this file was [#5] (abort-signal threading).
Its documented invariant is that `signal` reaches every `gh`/`git` call in `mergeReleasePR`, pinned by `threads signal to gh and git calls` in `release.test.ts`.
The refactor moves those calls into `performMerge`, so the invariant is at risk of silently regressing if `signal` is not relayed.
That test must keep asserting the signal on the `gh pr view`, `gh pr merge`, and `git pull` calls, and gains an assertion that the new `sleep` calls receive it too.

The second invariant is the success-path output shape (`Merged PR #N: <title>` / `head_sha:` / `short_sha:`), consumed by `/ship-issue` step 6b to capture the merge SHA.
It is pinned by the existing `defaults to --merge` test and must stay byte-identical.

The third is the failure-path first line, `PR #N is not mergeable`, pinned by `returns error when PR is not mergeable`.
The new `reason:` line is appended, never substituted.

## TDD Order

Each step lands red and green in one commit, matching the convention in `docs/plans/0005-abort-signal-threading.md` — no red-only commit reaches `main`.

1. **`classifyMergeState` and the rollup normalizer.**
   Test surface: new `test/lib/merge-state.test.ts`.
   Covers the full classification matrix from Test Impact Analysis item 1, including both rollup typenames and the `SKIPPED`-is-not-a-failure rule.
   The module is created and its consumer wired in the very next step; do not split the wiring further, or `pnpm fallow dead-code` sees a test-only export.
   Commit: `feat(pi-github-tools): add merge-state classification for PR check rollups (#673)`
2. **Wire the classification into `mergeReleasePR` as a bounded poll loop.**
   Test surface: `test/lib/release.test.ts`.
   Adds `statusCheckRollup` to every existing merge mock and to the asserted `--json` field list, then adds tests for: `UNSTABLE` with an `IN_PROGRESS` check polls and then merges once `CLEAN`; `UNKNOWN` polls until resolved; a failing check returns blocked with the check name; an empty rollup returns blocked with the no-checks reason; the timeout path returns `timeout:` with the last progress line; abort mid-sleep returns the abort result.
   This step removes no export, but it changes `PRState`'s field list and the `gh pr view` argument array, so the existing assertions must move in the same commit.
   Commit: `feat(pi-github-tools): wait out in-progress checks in release_pr_merge (#673)`
3. **Expose `timeout` and progress streaming on the tool wrapper.**
   Test surface: none new — `tools/` wrappers are tested lightly per the package skill.
   Adds the `timeout` schema parameter, threads `onUpdate` through `createProgressCallback`, and updates `description`/`promptSnippet`.
   Commit: `feat(pi-github-tools): stream check-wait progress from release_pr_merge (#673)`
4. **Documentation and workflow prompts.**
   Updates `packages/pi-github-tools/README.md`, `.pi/prompts/ship-issue.md`, `.pi/prompts/land-worktree.md`, `.pi/prompts/ship-no-issue.md`, and `AGENTS.md`.
   Each prompt's numbered step *and* its Constraints bullet change together.
   Commit: `docs: fold the UNSTABLE check-wait runbook into release_pr_merge (#673)`

## Risks and Mitigations

| Risk                                                                                                                                                                               | Mitigation                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A `SKIPPED` or `NEUTRAL` conclusion misread as failure would block every release merge — the `release-please` and `publish` jobs conclude `SKIPPED` on every release PR (measured) | Explicit allowlist of failing conclusions, with a dedicated test asserting an all-`SKIPPED` rollup is not a failure   |
| `UNSTABLE` that never resolves (a persistently failing non-required check GitHub does not surface as a conclusion) would hang the agent                                            | Bounded by `timeout`, default 300 s; the timeout result carries the last progress line so the cause is visible        |
| Waiting on `UNKNOWN` could mask a PR that is genuinely undecidable                                                                                                                 | Same `timeout` bound; the operator explicitly conditioned the `UNKNOWN` handling on having a timeout                  |
| The `StatusContext` branch has no test fixture from this repo — every measured rollup is `CheckRun`                                                                                | Covered by synthetic unit tests in `merge-state.test.ts`; flagged in Open Questions as unverified against a live repo |
| Moving the merge calls into `performMerge` could drop the `signal` relay from [#5]                                                                                                 | Named in Invariants at Risk; the existing signal-threading test must stay green and gains a `sleep` assertion         |
| Prompt edits could drift from tool behavior, since each prompt states its `UNSTABLE` rule twice                                                                                    | Module-Level Changes lists both passages per file; the doc commit is the last step, after behavior is final           |
| The tool now blocks for minutes where it used to return instantly, which changes how a caller perceives a hang                                                                     | Progress lines stream every 10 s via `onUpdate`, and `AbortSignal` already cancels mid-sleep                          |

## Open Questions

- Whether `HAS_HOOKS` should be treated as `ready` or as blocked.
  GitHub documents it as mergeable, and this repo will never produce it, so the plan treats it as `ready` and covers it with a unit test only.
- Whether the `StatusContext` normalization is worth keeping long-term.
  It costs about five lines and prevents a legacy-status repo from being misread as "no checks reported", but it is unverified against a live repo.
  Revisit if [#564] consolidates status derivation.
- No follow-up issues are filed by this plan.
  The one adjacent piece of work, unifying status derivation across `ci.ts`, `ci-helpers.ts`, and the new `merge-state.ts`, is already tracked by [#564].

[#5]: https://github.com/gotgenes/pi-packages/issues/5
[#564]: https://github.com/gotgenes/pi-packages/issues/564
[#662]: https://github.com/gotgenes/pi-packages/issues/662
