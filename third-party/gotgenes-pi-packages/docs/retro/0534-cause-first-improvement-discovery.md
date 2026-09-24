---
issue: 534
issue_title: "Revise /plan-improvements and improvement-discovery: cause-first discovery, deferral gate, and audit gaps"
---

# Retro: #534 — Revise /plan-improvements and improvement-discovery: cause-first discovery, deferral gate, and audit gaps

## Stage: Planning (2026-07-04T14:45:44Z)

### Session summary

Planned the revision of two repo-root workflow files — `.pi/prompts/plan-improvements.md` and `.pi/skills/improvement-discovery/SKILL.md` — to fix a fallow-anchoring bias and several audit gaps surfaced by the pi-subagents Phase 20 retro.
The plan resequences discovery to cause-first (architecture doc + hypothesis before fallow), adds an open-issue sweep, a qualitative deferral gate, a feasibility probe, a conditional directory-organization step, per-step cause attribution and Impact/Risk/Priority scores, and a retro hook.
Filed the plan at `docs/plans/0534-cause-first-improvement-discovery.md` (repo-root, not package-scoped, since no package code changes despite the `pkg:pi-subagents` label).

### Observations

- The `pkg:pi-subagents` label reflects the retro's *origin*, not the change surface — the edited files are repo-root `.pi/` tooling, published in no tarball and part of no architecture roadmap, so the plan is cross-cutting and the release recommendation is "ship independently" (a `docs:` commit that cuts no package release).
- Author is the operator (`gotgenes`), so the issue's detailed checklist is the working spec.
  The one genuine scope decision — the optional retro hook the issue itself flagged — was resolved via `ask_user`: operator chose **include it** (fold into this plan, no separate follow-up issue).
- Design decision on the fallow-anchoring fix: chose **reorder** over demote-in-place, matching the "cause-first" framing and making sequencing self-enforcing.
- Retro-hook design: `/plan-improvements` is phase-scoped, not issue-scoped, so it does not fit the issue-keyed `NNNN-<slug>.md` retro convention.
  Chose a standalone phase-scoped retro at `packages/<PKG>/docs/retro/phase-N-<slug>.md` with inlined frontmatter (`package` / `phase`), following the pattern where `/plan-issue` inlines its own retro frontmatter — this keeps scope to the two files named in the issue and leaves `/finish-phase` (which owns the `history/` archive) untouched.
- No follow-up issues filed — the retro hook was folded in per the operator's answer, and cross-reference checks confirmed the `Release:` mechanism in `AGENTS.md` / `plan-issue.md` is untouched, so no edits propagate outside the two files.
- Next stage is `/build-plan` (docs-only, no TDD cycles).

## Stage: Implementation — Build (2026-07-04T15:05:00Z)

### Session summary

Executed the docs-only build plan across five commits, editing the two repo-root workflow files.
`.pi/prompts/plan-improvements.md` gained the cause-first reorder (architecture doc + cause hypothesis → open-issue sweep → demoted/trimmed fallow), the deferral gate, feasibility probe, conditional directory-org guard, "max 9" ceiling reframe, and a phase-scoped retro hook.
`.pi/skills/improvement-discovery/SKILL.md` gained per-step cause attribution, published Impact/Risk/Priority scores, and the fallow-CRAP gotcha — and its own "Analysis workflow" section was resynced to the cause-first order.

### Observations

- All nine issue-checklist items plus the operator-approved retro hook landed; no package code, tests, or TypeScript touched, so `pnpm run check`/`test`/`fallow` were N/A — verification was `rumdl` lint only.
- Step numbering in `plan-improvements.md` was fully renumbered (1–8) when the open-issue sweep was inserted; the Output section's `(Step 5)` → `(Step 6)` directory-org back-reference was updated to match, and a final grep confirmed no dangling `Step N` references.
- Deviation from the plan's Module-Level Changes: the plan scoped the skill to "Output-format / rule additions, no restructure," but the pre-completion reviewer (WARN) caught that the skill's own top-level "Analysis workflow" numbered list still described the old fallow-first order — directly contradicting this issue's fix.
  Fixed inline as a sixth commit (`1d3efa0b`) rather than deferring, since it is low-risk and central to the issue's goal.
- Pre-completion reviewer: WARN — sole substantive finding (stale skill "Analysis workflow" ordering) resolved inline; the second WARN item (no filed issue for that gap) is moot now that it is fixed.
  No FAIL findings; the `Release:` tag Output contract and Phase N−1 archive hard gate were verified preserved.

## Stage: Final Retrospective (2026-07-04T17:04:35Z)

### Session summary

Planned, built, and shipped issue #534 in a single session across three stages: a `docs:`-only revision of `.pi/prompts/plan-improvements.md` and `.pi/skills/improvement-discovery/SKILL.md` to make improvement-discovery cause-first, add a deferral gate and feasibility probe, and close audit gaps.
Eight commits landed on `main`; CI passed; the issue was closed with a curated comment; no release was cut (all commits touch `.pi/` and excluded `docs/` paths attributed to no package).
Execution was clean overall — one `ask_user` scope decision, one pre-completion-reviewer WARN fixed inline, and correct release reasoning for a repo-root change that cuts nothing.

### Observations

#### What went well

- **Correct label-vs-surface judgment.**
  The `pkg:pi-subagents` label was recognized at planning time as the retro's *origin*, not the change surface; the plan and retro were correctly filed at repo root (`docs/plans/`, `docs/retro/`) because the edited files are repo-root tooling in no package tarball.
  This classification held cleanly through all three stages.
- **The pre-completion-reviewer earned its place.**
  It caught a real contradiction the plan had explicitly scoped *out* — `improvement-discovery/SKILL.md` describes its analysis workflow in two places (the top `## Analysis workflow` list and the `Output format` section), and the plan only edited the latter, leaving the top list still saying "1.
  Run fallow" first, directly against this issue's fix.
  Fixing it inline (commit `1d3efa0b`) kept the change coherent.
- **Sound release reasoning for a no-package change.**
  Step 4b correctly established that no releasing commit exists in the unreleased range by anchoring on the last `chore: release main` commit (`8ce938f0`) rather than a misleading most-recent-by-date package tag, and by checking `exclude-paths` — concluding no release-please PR would appear (confirmed by the expected `release_pr_find` timeout).

#### What caused friction (agent side)

- `missing-context` (planning) — the plan's Module-Level Changes did not recognize that `improvement-discovery/SKILL.md` documents its workflow sequence twice; it scoped the skill to "Output-format / rule additions, no restructure" and missed the top-of-file `## Analysis workflow` list that also enumerates the fallow-first order.
  Impact: one extra unplanned build commit (`1d3efa0b`); reviewer-caught, not user-caught; no rework beyond the added commit.
- `other` (ship, prompt gap) — `ship-issue.md` steps 4b/5 assume a package-scoped plan path and a `<pkg>-v*` tag to anchor the close-comment range.
  This issue's plan is at repo root (`docs/plans/`) with no `<pkg>`, so the package-tag instruction did not apply; the range had to be improvised from the parent of the issue's first commit (`8caa7386..HEAD`) and the last `chore: release main` commit.
  Impact: several extra investigative tool calls during step 4b to reason out the release anchor; no rework, correct outcome.

#### What caused friction (user side)

- None.
  The single `ask_user` (retro-hook scope) was answered decisively and the operator's choice drove the plan; no mid-session corrections were needed.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-5` (its frontmatter default), appropriate for judgment-heavy acceptance-criteria and doc-staleness review; it surfaced the dual-workflow contradiction.
  No cost/quality mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` sequences; the step-4b release investigation (~8 tool calls) was legitimate monorepo release reasoning, not repeated calls against a single error.
- **Feedback-loop gap analysis** — `rumdl` lint ran incrementally after each build commit (via the pre-commit hook plus explicit `rumdl check`), not just at the end; no verification-timing gap.
  Package `check`/`test`/`fallow` were correctly skipped as N/A for a docs-only change.

### Changes made

1. `.pi/prompts/ship-issue.md` (step 5) — added a no-package anchor note: for a repo-root tooling change (plan under `docs/plans/`, no `<pkg>` tag), anchor the close-comment range on the parent of the issue's first commit or the last `chore: release main` commit.
2. `.pi/prompts/plan-issue.md` (Module-Level Changes) — added grep discipline: when a step resequences a documented workflow, grep the edited file itself for other passages describing the same sequence, since a prompt or skill often states its workflow twice.
3. `docs/retro/0534-cause-first-improvement-discovery.md` — this Final Retrospective stage entry.
