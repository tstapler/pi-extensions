---
issue: 586
issue_title: "Mid-batch issues orphan: /ship-issue defers close, batch-tail ship never closes them"
---

# Retro: #586 — Mid-batch issues orphan: /ship-issue defers close, batch-tail ship never closes them

## Stage: Planning (2026-07-13T00:00:00Z)

### Session summary

Planned the fix for orphaned mid-batch issues: `/ship-issue` couples the issue close to the release-batch decision (step 4b stops early on defer, skipping steps 5–6), so a mid-batch member is released but never closed.
Chose Fix 1 (decouple close from release) over Fix 2 (batch-tail closes siblings) after the operator confirmed via `ask_user`.
The plan is a single-file docs change to `.pi/prompts/ship-issue.md`; next step is `/build-plan` (no test cycles).

### Observations

- Key discovery: `.pi/prompts/land-worktree.md` **already** implements Fix 1 — its step 5 always closes the issue and its step 6 ("Release (decoupled and serialized)") separately handles the defer.
  Fix 1 brings the trunk `/ship-issue` into parity with the already-correct worktree flow.
- The issue's stated downside of Fix 1 ("close comment can no longer cite a released version") does not actually apply: both flows' close comments already cite `"Implemented in <sha>"`, never a version.
- The `pkg:pi-permission-system` label reflects only where the concrete instance (#580) occurred; the change is a repo-root prompt edit, so the plan lives in `docs/plans/`, not a package directory.
- Grep confirmed the coupling lives in exactly one line (`ship-issue.md:70`); `AGENTS.md` release-batching prose describes only the release decision and stays accurate, so no `AGENTS.md` edit is planned.
- Ships independently — a `docs:` change under `.pi/prompts/` is attributed to no package and cuts no release on its own.
- No follow-up issues identified; no open questions.

## Stage: Implementation — Build (2026-07-13T00:00:00Z)

### Session summary

Executed the plan's single step: edited `.pi/prompts/ship-issue.md` steps 4b, 5, and 6 to decouple the issue close from the release-batch decision, matching `/land-worktree`'s already-correct contract.
Step 4b now always continues to step 5 (close) regardless of the release decision, and skips only step 6 (release) on defer; step 5's close-comment bullet list and stacked-issue-scan note were updated accordingly; step 6 gained an explicit skip-on-defer lead sentence.
Single `docs:` commit, no deviations from the plan.

### Observations

- No code, tests, or `AGENTS.md` changes were needed — the plan's grep in the Planning stage correctly scoped this to one file.
- `pnpm run lint` and `pnpm exec rumdl check .pi/prompts/ship-issue.md` were clean on first pass; no auto-fix needed.
- Pre-completion reviewer verdict: **PASS**.
  Verified all four planned edits landed verbatim, confirmed no other doc references the old coupled behavior (reverse check), and confirmed both named "Invariants at risk" (the step-4 CI-failure gate and the unchanged "Release coordination" defer ask) hold by inspection.
- All steps completed; nothing remains for this issue before `/ship-issue`.

## Stage: Final Retrospective (2026-07-13T00:00:00Z)

### Session summary

Shipped #586 cleanly across three stages (plan → build → ship) in one continuous session: decoupled the issue close from the release-batch decision in `.pi/prompts/ship-issue.md` steps 4b/5/6, bringing the trunk flow into parity with `/land-worktree`'s already-correct contract.
One notable meta-event: the `/ship-issue` invocation expanded a **stale** copy of `ship-issue.md` — the pre-edit version, before this same session's commit `0265e995` — and the agent self-detected the divergence and followed the on-disk file instead.
No rework, no rabbit holes, no instruction violations; pre-completion reviewer returned PASS.

### Observations

#### What went well

- **Stale-prompt-template self-detection (novel).**
  At `/ship-issue` (turn 38), the pasted template body was the pre-edit `ship-issue.md` (old step 4b: "stop here — leave the issue open and skip steps 5–6").
  The agent noticed the mismatch, ran `grep -n "issue \*\*always\*\*"` against the on-disk file, confirmed commit `0265e995` had landed the decoupling, and followed the on-disk version — all in 2 tool calls, self-identified, zero harm.
  This is the first observed instance of a session editing the very prompt template a later same-process invocation then runs.
- **Planning found the `/land-worktree` precedent before designing.**
  Turn 6–7 read `land-worktree.md` and discovered it already implements Fix 1 (decoupled close/release), which reframed the whole change as "bring the trunk flow into parity" rather than "invent a contract" — and dissolved Fix 1's stated downside (both flows already cite `Implemented in <sha>`, never a version).
- **`ask_user` gate used correctly for a genuine fork.**
  The issue laid out two candidate fixes; the agent surfaced the Fix 1 vs Fix 2 choice with the `/land-worktree` precedent as context rather than silently picking one.

#### What caused friction (agent side)

- None material.
  The stale-template event (above) added ~2 tool calls of verification but caused no rework, and for this issue's `release now` decision the stale and fresh templates would have produced the same outcome (both close the issue) — the divergence only bites on a `mid-batch — defer` decision.

#### What caused friction (user side)

- None.
  The three stage prompts drove the flow; no correction or redirection was needed.

### Diagnostic details

- **Model-performance correlation** — planning ran on `claude-opus-4-8` (judgment-heavy: design fork, precedent discovery), build + ship on `claude-sonnet-5` (mechanical: single edit, deterministic ship steps), retro on `claude-opus-4-8`.
  The `pre-completion-reviewer` subagent (turn 32) ran under sonnet-5 for a docs-only verification — appropriate scope, no mismatch.
- **Escalation-delay / unused-tool / feedback-loop lenses** — nothing notable: no `rabbit-hole` or `missing-context` friction points; `pnpm run lint` and `rumdl` were run after the edit and again at ship pre-push, not batched to the end.

### Changes made

1. `AGENTS.md` — added a "Stale prompt-template expansion" subsection under "Tool-injected messages": a later same-process invocation of a just-edited `.pi/prompts/*.md` template can run the pre-edit copy, so treat the on-disk file as authoritative when the pasted body diverges (Refs #586).
