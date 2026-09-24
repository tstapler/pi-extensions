---
issue: 586
issue_title: "Mid-batch issues orphan: /ship-issue defers close, batch-tail ship never closes them"
---

# Decouple issue close from release batching in `/ship-issue`

## Release Recommendation

**Release:** ship independently

This is a repo-root workflow change to `.pi/prompts/ship-issue.md`, not part of any package's architecture roadmap, so it carries no `Release:` batch tag.
It touches only a prompt template under `.pi/prompts/` — a path attributed to no package — so the commit cuts no release on its own regardless.

## Problem Statement

A mid-batch issue can be shipped and released yet left permanently open, because neither its own `/ship-issue` nor the eventual batch-tail ship ever closes it.
`/ship-issue` step 4b couples the issue **close** to the release **batch decision**: when the recorded decision is defer/batch, it stops early, leaving the issue open and skipping steps 5–6 on the assumption the batch-tail ship will close it later.
But the batch-tail ship's stacked-issue scan (step 5) only walks `<pkg-tag>..HEAD`, and a mid-batch sibling's commits were released under an **earlier** tag — below `<pkg-tag>` — so they are invisible to that range scan.
The issue orphans (concrete instance: #580, released in `pi-permission-system-v20.5.0`, closed manually three issues later during the #573 retro).

## Goals

- Decouple the issue **close** from the release **batch decision** in `/ship-issue`: an issue closes on its own ship regardless of whether the release is deferred.
- A mid-batch defer skips only the release (step 6), not the close (step 5).
- Bring `/ship-issue` into parity with `/land-worktree`, which already implements this decoupled close/release contract.
- Keep the close comment accurate when the release is deferred (cite the implementing SHA, not a not-yet-released version).

## Non-Goals

- Fix 2 (batch-tail enumerates and closes siblings) — rejected by the operator in favor of Fix 1; not pursued.
- Changes to `/land-worktree` — it already decouples close from release (its step 5 always closes; step 6 is titled "Release (decoupled and serialized)").
- Changes to the release-batching decision itself (the `mid-batch — defer` ask in the "Release coordination" section stays as-is — only the *close* is decoupled from it).
- Any change to `AGENTS.md` — its release-batching note (line 73) describes only the *release* decision ("asking only when it is `mid-batch — defer`, otherwise releasing now"), which remains accurate; the close is not mentioned there.

## Background

- `.pi/prompts/ship-issue.md` is the trunk (linear-`main`) ship flow.
  Its "Release coordination" preamble records a release decision up front; step 4b applies it; steps 5–6 close the issue and merge the release-please PR.
- The coupling lives in exactly one place — `.pi/prompts/ship-issue.md` line 70:
  > If that decision was to defer/batch: stop here — the push and CI are done; leave the issue open and skip steps 5–6.
- `.pi/prompts/land-worktree.md` is the precedent for the target contract.
  Its step 5 ("Close the issue") always closes via `issue_close`; its step 6 ("Release (decoupled and serialized)") separately reads the `**Release:**` marker and skips only the release on defer.
  Both flows' close comments already cite `"Implemented in <sha>"`, never a released version — so Fix 1's stated downside ("close comment can no longer cite a released version") does not actually apply.
- The `pkg:pi-permission-system` label on the issue reflects where the concrete instance (#580) occurred, not where the code changes; the change is a repo-root prompt edit, so the plan lives in `docs/plans/`.

## Design Overview

Adopt Fix 1: make the defer/batch decision skip only the **release** (step 6), never the **close** (step 5).
Closing an issue records that its work shipped to `main`; releasing is a separate, batched decision — exactly the split `/land-worktree` already encodes.

The behavioral change, expressed as control flow:

```text
Before (coupled):
  step 4b: decision == defer  ->  STOP (skip step 5 close AND step 6 release)   # issue orphans
  step 4b: decision == release ->  step 5 (close) -> step 6 (release)

After (decoupled):
  step 4b: any decision       ->  step 5 (close)      # always closes
  step 4b: decision == defer  ->  ...then SKIP step 6 (release deferred to batch tail)
  step 4b: decision == release ->  ...then step 6 (release now)
```

Consequences:

- Each mid-batch issue is closed by its own `/ship-issue`, so the batch-tail ship never needs to reach back below `<pkg-tag>` to find it.
  The root cause (invisible-to-range-scan siblings) dissolves — there is nothing left for the tail to close.
- The step 5 stacked-issue scan (`<pkg-tag>..HEAD`) still exists but now targets only genuinely stacked work that never had a ship of its own (a stacked refactor/enabler); it is no longer relied on to sweep up mid-batch siblings.
- On a deferred ship, the close comment gains one clarifying line: the fix is on `main` and will be released with the batch, so the comment does not cite a not-yet-existing version.

Edge cases:

- Release decision "release now" (independent or batch-tail): unchanged — close in step 5, release in step 6.
- Release decision "defer": now closes in step 5, skips step 6.
- No plan / no `**Release:**` marker: defaults to "release now" (unchanged) — closes and releases.
- Stacked non-mid-batch work in range: still swept by the step 5 scan (unchanged).

## Module-Level Changes

Single file: `.pi/prompts/ship-issue.md`.

1. **Step 4b — rewrite the defer branch (line ~70).**
   Replace "stop here … leave the issue open and skip steps 5–6" with: continue to step 5 and close the issue regardless of the decision; on defer, note the deferral and skip only step 6.
   Reference `/land-worktree`'s decoupled contract for parity.
2. **Step 5 — add a deferred-release note to the close-comment bullet list.**
   When the release was deferred (mid-batch), the comment notes the fix is on `main` and releases with the batch — do not cite a released version.
3. **Step 5 — clarify the stacked-issue scan.**
   Add a parenthetical that a mid-batch sibling shipped on its own `/ship-issue` is now already closed by that ship, so this scan is for stacked work that never had a ship of its own.
4. **Step 6 — add a skip-on-defer lead sentence.**
   State that step 6 is skipped entirely when step 4b recorded a defer/batch decision (the release lands later with the batch tail).

Greps performed to confirm this is the only touch point:

- `grep -rn "leave the issue open\|skip steps 5\|defers close"` across `AGENTS.md`, `.pi/skills/`, `.pi/prompts/` → only `.pi/prompts/ship-issue.md:70`.
- `AGENTS.md` release-batching prose (lines 67, 73, 118) describes the *release* decision and the worktree flow, not the trunk close/defer coupling → no edit needed.
- `.pi/prompts/land-worktree.md` already decoupled → no edit needed.

## Test Impact Analysis

Not applicable — prompt templates carry no unit tests.
Verification is by inspection: after the edit, trace each release-decision branch (release-now / defer / no-plan) through steps 4b→5→6 and confirm the close always fires and only the release is conditional.
No `pnpm run test` surface changes.

## Invariants at risk

- **`/ship-issue` still stops on CI failure without closing or releasing** (step 4, "If CI fails, the issue stays open").
  The edit touches only step 4b onward; the step 4 CI gate is untouched.
  Confirm by inspection that the close now living unconditionally in step 5 is still downstream of the step 4 `success` gate.
- **The `mid-batch — defer` release ask (Release coordination section) is unchanged** — the operator is still asked whether to defer or release; only the *close* stops depending on that answer.

## Implementation Order (build — no test cycles)

Docs-only change; execute via `/build-plan`.
Single commit:

1. Edit `.pi/prompts/ship-issue.md` steps 4b, 5, and 6 per Module-Level Changes.
   Lint with `pnpm exec rumdl check .pi/prompts/ship-issue.md`.
   Commit: `docs: decouple issue close from release batching in /ship-issue (#586)`.

The commit is a `docs:` change under `.pi/prompts/` (attributed to no package), so it cuts no release on its own — consistent with the Release Recommendation.

## Risks and Mitigations

- **Risk:** a deferred-then-closed issue looks "done" while its release is still pending, confusing a reader who expects closed == released.
  **Mitigation:** the step 5 close comment gains an explicit "on `main`, releases with the batch" note (change 2), and the final report already flags the deferral.
  This matches `/land-worktree`'s long-standing behavior, so it is not a new contract for the repo as a whole.
- **Risk:** the batch-tail ship's step 5 scan is now redundant for mid-batch siblings and could be misread as still responsible for them.
  **Mitigation:** change 3 adds a parenthetical narrowing the scan's purpose to genuinely stacked work.

## Open Questions

None.
The direction (Fix 1) was confirmed by the operator during planning; no follow-up issues were identified.
