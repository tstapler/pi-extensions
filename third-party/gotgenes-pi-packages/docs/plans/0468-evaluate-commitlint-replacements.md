---
issue: 468
issue_title: "Evaluate commitlint replacements (convco, cocogitto, committed) for commit-message linting"
---

# Evaluate commitlint replacements (convco, cocogitto, committed)

## Release Recommendation

**Release:** ship independently

This change touches only repo-root tooling (`prek.toml`, root `package.json`, `.commitlintrc.json`, a new `docs/decisions/` ADR, `README.md`, `AGENTS.md`).
It changes no package source, so release-please cuts no package version — there is nothing to batch.
The issue is not referenced in any package's architecture roadmap, so it carries no `Release:` batch tag.
The `pkg:pi-subagents` label is incongruent: the commit-message gate is monorepo-wide infra, not pi-subagents source, so this is a repo-root plan in `docs/plans/` (the same call made for the predecessor gate in [#457]).

## Problem Statement

The repo's `commit-msg` gate runs `commitlint`, which delegates parsing to `conventional-commits-parser`.
That parser's line-by-line regex loop misreads any body line containing a `#N` reference as the start of the footer, so `footer-leading-blank` rejects valid messages whenever a commit body cites an issue mid-sentence — which this repo does routinely.
The stopgap disabled only that one rule (`footer-leading-blank: [0]`, [#468]) and kept `--strict` for the rest, but it leaves the gate on a parser the operator does not trust.

This issue evaluates three single-binary, real-grammar conventional-commit checkers — [`convco`](https://github.com/convco/convco), [`cocogitto`](https://github.com/cocogitto/cocogitto), and [`committed`](https://github.com/crate-ci/committed) — against an empirical acceptance bar, then either swaps the gate to the winner or records a decision to stay on `commitlint`.

## Goals

- Stand up a reproducible evaluation harness that runs all three candidates against the two acceptance cases and the five recording criteria from the issue.
- Capture the results in a durable Architecture Decision Record under `docs/decisions/` (comparison table + recommendation).
- If a candidate passes both acceptance cases and is a clean fit for the `prek` `commit-msg` hook, execute the swap in this cycle: wire the new hook, remove `.commitlintrc.json` and the `commitlint` devDependencies, and update the docs that name `commitlint`.
- If no candidate clears the bar, record the decision to stay on `commitlint` with `footer-leading-blank` disabled, with the evidence in the ADR.
- Preserve the load-bearing requirement throughout: the gate must reject the malformed `type!(scope):` form ([#452], [#457]) while accepting `type(scope)!:` and `type!:`.

This change is **not** breaking: it swaps a local developer gate and changes no package's observable behavior, output, or defaults.

## Non-Goals

- A CI-side commit-lint job — out of scope here as it was in [#457]; the workflow commits directly to a linear `main` with no PR to lint, and release-please does the authoritative versioning parse post-merge.
  CI runs no commit linting today, and this plan does not add it.
- The `commitlint` v21.1.0 custom-parser escape hatch — per the issue, note it only as a last-resort fallback if all three candidates fail the acceptance cases; do not plan around it.
- Changelog or version generation — release-please owns that and is unaffected; the gate is purely a local grammar check.
- A scope allow-list (`scope-enum` equivalent) — scope stays free-form, matching the [#457] decision; catching scope typos is a separate concern from `!`-placement.
- Any package source, version, or release-please package-component change.

## Background

- The repo manages git hooks with [`prek`](https://prek.j178.dev) (a Rust, pre-commit-compatible framework), configured in `prek.toml`.
  The current `commit-msg` hook is a `local` repo entry: `{ id = "commitlint", entry = "pnpm exec commitlint --strict --edit", language = "system", stages = ["commit-msg"] }`.
  `prek install` installs both the `pre-commit` and `commit-msg` shims because `prek.toml` sets `default_install_hook_types = ["pre-commit", "commit-msg"]`.
- The established pattern for a Rust binary in this repo is `rumdl`: it is wired as a `prek` **remote-repo hook** (`https://github.com/rvben/rumdl-pre-commit`) for the pre-commit stage **and** carried as a root `devDependency` (`rumdl`) used by `pnpm run lint` (`rumdl check .`).
  A `commit-msg`-only tool has no `pnpm run lint` usage, so an npm-wrapper devDependency for it would have no script call site.
- The repo does not provision binary tools via `mise` today: `mise.toml` has only an `[env]` PATH block and there is no `.tool-versions` / `[tools]` section.
  Adding a `[tools]` entry would be the repo's first managed tool.
- `prek` passes Git's commit-message file as the hook's candidate filename on the `commit-msg` stage (not repository paths), and the repo uses git worktrees where `.git` is a file — so the gate must read the exact message-file path `prek` hands it, never a `.git/COMMIT_EDITMSG` fallback.
- release-please's recognized commit types (`release-please-config.json` `changelog-sections`) are exactly `feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci`.
  The replacement's allowed-type set must agree with this so the gate is never stricter than the release tooling.
- `fallow dead-code` runs in CI with `unused-dev-dependencies: error`.
  Removing the `commitlint` devDependencies is clean; introducing a new npm-wrapper devDependency without a script call site risks a flag (see Risks).
- Candidate-specific facts gathered during planning (to be confirmed empirically by the harness, not taken as final):
  - `committed` is purpose-built for linting, exposes config fields for allowed types and hard/soft line lengths, and ships a **first-party** pre-commit/prek repo (`crate-ci/committed`) that installs a prebuilt binary — the cleanest fit for the existing `rumdl` pattern.
  - `cocogitto`'s `cog verify` is designed to validate an arbitrary message string/file, which fits a `commit-msg` hook directly; it depends only on libgit2.
  - `convco check` operates on git **commit ranges/history**, and its primary documented use is a `pre-push`/`pre-receive` hook; whether it can lint a single pending message file on `commit-msg` is an open question the harness must settle (a likely friction point for this use case).

## Design Overview

### Evaluation harness

A reproducible shell harness installs all three candidates with `brew` (all three ship Homebrew bottles — `convco` 0.6.4, `cocogitto` 7.0.0, `committed` 1.1.11 as of planning) and runs four fixture messages through each, recording the exit code and stderr/stdout:

| Fixture                   | Header                                                                                       | Required verdict |
| ------------------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `case1-body-issue-ref`    | `refactor(pi-subagents): extract MenuUI to its own module` + body citing `#441` mid-sentence | pass             |
| `case2-bang-before-scope` | `feat!(pi-subagents): add a thing`                                                           | fail             |
| `case2-bang-after-scope`  | `feat(pi-subagents)!: add a thing`                                                           | pass             |
| `case2-bang-no-scope`     | `feat!: add a thing`                                                                         | pass             |

The harness asserts the exit code matches the required verdict for every (tool, fixture) pair.
A tool is **acceptance-passing** only if all four verdicts hold.
The harness also captures, per tool, the data for the five recording criteria: clean single-binary `commit-msg` operation, how allowed types / scopes / a 120-char header limit are configured, error-message clarity, maintenance health (recent releases, open-issue responsiveness), and pnpm-monorepo config ergonomics.

The harness is the evidence source for the ADR; its commands are reproduced verbatim in the ADR so the comparison can be re-run.
It is run during implementation, not committed as a long-lived script (there is no test runner at the repo root), keeping scope tight.

### Decision matrix

```text
all four verdicts hold for >= 1 candidate?
  no  -> Branch B: record "stay on commitlint" in the ADR; no hook change.
  yes -> among passing candidates, pick the best fit for a prek commit-msg hook
         (single binary, no Node, cleanest provisioning + config ergonomics)
      -> Branch A: swap the hook to that tool.
```

Tie-break for Branch A favours, in order: (1) clean single-pending-message operation on `commit-msg`, (2) a first-party prek/pre-commit repo (no extra PATH dependency), (3) config expressiveness for allowed types + a 120-char header limit, (4) error-message clarity, (5) maintenance health.

### Binary distribution (best fit per tool, decided at swap time)

`brew` is the install path for the **evaluation** (above); it is a poor fit for the **gate** itself (not present in a fresh worktree without a step, unpinned, and not guaranteed on every contributor/CI machine).
So the gate-provisioning mechanism is chosen for whichever tool wins, per the operator's "no preference — best fit per tool" answer:

| Winner      | Provisioning                                   | Rationale                                                                                                       |
| ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `committed` | `prek` remote-repo hook (`crate-ci/committed`) | First-party prebuilt binary, mirrors the `rumdl` remote-repo pattern; zero PATH deps, works in fresh worktrees. |
| `cocogitto` | `mise` `[tools]` entry (or `brew` fallback)    | No first-party prek repo; a `[tools]` entry provisions the binary on `mise install`.                            |
| `convco`    | `mise` `[tools]` entry (or `brew` fallback)    | Same as cocogitto, only if it can lint a pending message file at all.                                           |

The harness confirms the chosen mechanism installs the binary cleanly before the swap step commits to it.

### ADR home

The comparison table + recommendation live in a new `docs/decisions/0001-commit-message-linter.md` ADR (the repo-root `docs/decisions/` directory does not exist yet).
`docs/decisions` is added to `release-please-config.json` `exclude-paths` so the ADR (and any later decision record) does not trigger a release — matching the existing per-package `docs/decisions` exclusions.

### Swap mechanics (Branch A)

When a winner is chosen, the gate is replaced atomically with respect to behavior:

1. Replace the `commitlint` `local` hook in `prek.toml` with the winner's hook (a remote-repo entry for `committed`, or a `local` entry invoking the `mise`-provisioned binary for `cocogitto`/`convco`), scoped to `stages = ["commit-msg"]`.
2. Add the winner's config file (e.g. `committed.toml`, `cog.toml`, or `.versionrc`) declaring the allowed-type set (aligned with release-please) and the 120-char header limit, where the tool supports it.
3. Remove `.commitlintrc.json` and drop `@commitlint/cli` + `@commitlint/config-conventional` from root `devDependencies`; regenerate `pnpm-lock.yaml`.
4. If the winner is provisioned via `mise`, add the `[tools]` entry; if via a prek remote repo, no PATH dependency is added.
5. Update the docs that name `commitlint` (see Module-Level Changes).

If the winner cannot express a 120-char header limit or the exact allowed-type set, that limitation is recorded in the ADR and the gate keeps whatever default the tool enforces, provided both acceptance cases still hold (the load-bearing requirement is `!`-placement, not header length).

## Module-Level Changes

Branch-independent:

- `docs/decisions/0001-commit-message-linter.md` (new) — the ADR: context, the four-fixture comparison table, per-tool notes on the five criteria, the recommendation, and the verbatim reproduction commands.
- `release-please-config.json` — add `docs/decisions` to `exclude-paths` (root-level decision records must not trigger a release).

Branch A (a candidate wins — swap):

- `prek.toml` — replace the `commitlint` `local` `commit-msg` hook with the winner's hook entry.
- `<winner config>` (new, e.g. `committed.toml` / `cog.toml` / `.versionrc`) — allowed types + 120-char header limit where supported.
- `.commitlintrc.json` — removed.
- `package.json` (root) — remove `@commitlint/cli` and `@commitlint/config-conventional` from `devDependencies`.
- `pnpm-lock.yaml` — regenerated by `pnpm install`.
- `mise.toml` — add a `[tools]` entry **only** if the winner is provisioned via `mise` (cocogitto/convco); not touched for `committed`.
- `README.md` (line ~63) — the sentence "validates Conventional Commit headers via [commitlint]" is reworded to name the new tool and link it.
- `AGENTS.md` (line ~207) — "A `commit-msg` commitlint hook (wired via `prek`…)" reworded to name the new tool; keep the deterministic-`!`-placement guarantee.
- `AGENTS.md` (line ~218) — the `.commitlintrc.json` / `footer-leading-blank` sentence (which exists to explain the `#N`-in-body workaround, [#468]) is removed or rewritten, since the new parser does not have that bug and `.commitlintrc.json` no longer exists.

Branch B (no candidate wins — stay):

- No `prek.toml`, `package.json`, `.commitlintrc.json`, `README.md`, or `AGENTS.md` change.
  The ADR records the evidence and the decision to stay; the current `footer-leading-blank: [0]` stopgap remains accurate, so `AGENTS.md:218` stays as-is.

Grep performed during planning for the removed symbol `commitlint` across docs: `README.md:63`, `AGENTS.md:207`, `AGENTS.md:218` are the only prose references; the `.commitlintrc.json` filename appears only in `AGENTS.md:218` and the file itself.
No `package-*/SKILL.md` references `commitlint` (the gate is root infra, not documented in a package skill).

## Test Impact Analysis

This is a tooling/config change with no `src/` or `test/` units, so there are no unit tests to enable, simplify, or preserve.
The four-fixture harness is the test: it stands in for a unit suite by asserting exit codes for the two acceptance cases (plus the two correct-breaking forms) against each candidate.
The harness assertions are reproduced in the ADR so the result is verifiable, not asserted.

## Invariants at risk

- **`!`-placement rejection** ([#452], [#457]) — the predecessor gate's load-bearing invariant: `type!(scope):` is rejected, `type(scope)!:` and `type!:` are accepted.
  Pinned by the `case2-*` harness fixtures; the swap step does not land unless all three `case2` verdicts hold for the winner.
- **Allowed-type agreement with release-please** — the gate must not be stricter than release-please's recognized type set.
  Verified in the swap step by linting a window of real history (`HEAD~30..HEAD`) with the new tool and confirming zero false rejections.
- **`#N`-in-body acceptance** ([#468]) — the bug that motivated this issue.
  Pinned by the `case1-body-issue-ref` fixture; this is the regression the swap is meant to fix, so it must pass for the winner.

## Build Order

This is a config/docs change with no red→green unit cycles, so it proceeds as ordered build steps with explicit verify criteria and one decision gate.
The next workflow step is `/build-plan`.

1. **Stand up the harness and run all three candidates.**
   Create the four fixture messages; install all three candidates with `brew install convco cocogitto committed`; run every fixture through each tool and record exit codes plus the five-criteria data.
   Verify: every (tool, fixture) verdict is captured; at least the `case1` and `case2-*` exit codes are recorded for all three tools.
   No commit (investigation producing the ADR's evidence).

2. **Author the ADR and wire the exclude path.**
   Write `docs/decisions/0001-commit-message-linter.md` with the comparison table, per-criterion notes, the recommendation (winner or "stay"), and the verbatim reproduction commands; add `docs/decisions` to `release-please-config.json` `exclude-paths`.
   Verify: `pnpm run lint` passes (rumdl on the new ADR); `release-please-config.json` parses and contains the new exclude path.
   Commit: `docs: record commit-message linter evaluation (#468)`.

   **Decision gate** — if the ADR recommends "stay on commitlint" (Branch B), stop here: the ADR is the deliverable, no hook change.
   Otherwise proceed to step 3 (Branch A).

3. **Swap the `commit-msg` hook to the winner.**
   Replace the `commitlint` hook in `prek.toml` with the winner's entry; add the winner's config (allowed types + 120-char header limit where supported); provision the binary per the best-fit mechanism (prek remote repo for `committed`, else a `mise` `[tools]` entry); run `prek install` and confirm `.git/hooks/commit-msg` still exists.
   Verify: an attempted commit with `feat!(scope):` is rejected by the hook; `feat(scope)!:`, `feat!:`, and a body citing `#N` mid-sentence all pass; the winner reports zero errors on `HEAD~30..HEAD` of real history.
   Commit: `build: replace commitlint with <winner> for commit-message linting (#468)`.

4. **Remove commitlint and update the docs.**
   Delete `.commitlintrc.json`; remove `@commitlint/cli` + `@commitlint/config-conventional` from root `devDependencies`; run `pnpm install` to regenerate the lock; reword `README.md:63`, `AGENTS.md:207`, and `AGENTS.md:218` to name the new tool and drop the stale `.commitlintrc.json` / `footer-leading-blank` explanation.
   Verify: `pnpm run lint` passes; `pnpm fallow dead-code` reports no unused/unlisted dependency for the removal (and no new flag if a npm-wrapper devDependency was added); `git grep -n commitlint` returns only historical CHANGELOG/retro/plan references, none in live config or current docs.
   Commit: `chore: drop commitlint config and dependencies (#468)`.

Run `pnpm fallow dead-code` before the final push (CI gates on it).
If the winner is carried as an npm-wrapper devDependency with no script call site and `fallow` flags it, add it to `.fallowrc.json` `ignoreDependencies` in the same commit that introduces it.

## Risks and Mitigations

- **Risk:** `convco check` cannot lint a single pending message file on `commit-msg` (it is built for commit ranges).
  **Mitigation:** the harness explicitly tests single-message operation as recording criterion #1; if `convco` cannot do it cleanly, it is disqualified from Branch A regardless of its grammar verdicts, and the ADR records why.
- **Risk:** a candidate accepts `feat!(scope):` (lenient grammar), silently losing the load-bearing [#452]/[#457] guarantee.
  **Mitigation:** the `case2-bang-before-scope` fixture must fail for the winner; the swap step re-verifies the rejection against a real commit before committing.
- **Risk:** the winner cannot express a 120-char header limit or the exact allowed-type set.
  **Mitigation:** record the limitation in the ADR; keep the tool's default provided both acceptance cases still hold — header length is a comfort rule, not the load-bearing requirement.
- **Risk:** the new binary is unavailable in a fresh worktree or for a contributor without `brew`/`cargo`.
  **Mitigation:** prefer the prek remote-repo mechanism (prebuilt binary, like `rumdl`); if `mise` is used, the `[tools]` entry provisions it on `mise install`, and the `prepare` script's `prek install` still wires the hook.
- **Risk:** `fallow` flags a new npm-wrapper devDependency as unused (no `pnpm run lint` call site, unlike `rumdl`).
  **Mitigation:** prefer a non-npm provisioning path (prek remote repo or `mise`) so no npm devDependency is added; if one is unavoidable, add it to `.fallowrc.json` `ignoreDependencies` in the same commit.
- **Risk:** removing `commitlint` while a parallel worktree session still expects it.
  **Mitigation:** the gate is repo-root infra; partition is trivially satisfied since no package source changes — coordinate only that no peer is mid-commit against the old hook.

## Open Questions

- Should a CI commit-lint backstop be added once the local gate is on a trusted parser?
  Deferred (as in [#457]): the workflow pushes directly to a linear `main` with no PR to lint, and release-please runs post-merge.
  Revisit only if `--no-verify` bypasses recur.
- If all three candidates fail the acceptance bar, is the `commitlint` v21.1.0 custom-parser route worth adopting over the current `footer-leading-blank: [0]` stopgap?
  Out of scope here per the issue; the ADR notes it as a fallback only, and the stay-branch keeps the existing stopgap.

[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#457]: https://github.com/gotgenes/pi-packages/issues/457
[#468]: https://github.com/gotgenes/pi-packages/issues/468
