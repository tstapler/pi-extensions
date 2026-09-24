---
issue: 606
issue_title: "/finish-phase: add a bounded architecture-doc hygiene step to prevent regrowth"
---

# /finish-phase: bounded architecture-doc hygiene step

## Release Recommendation

**Release:** ship independently

This change touches only a repo-root workflow prompt (`.pi/prompts/finish-phase.md`).
That file is not published in any package tarball and does not participate in any package's architecture roadmap, so it cuts no package release — it lands on `main` as a `docs:` commit with no release coordination.
There is no batch to defer to.

## Problem Statement

`/finish-phase` is the per-phase producer of the architecture-doc bloat that [#601] (pi-permission-system) and its pi-subagents sibling [#605] just paid down in bulk.
Three of its behaviors re-inflate the document every time a phase closes:

- Step 4 tells the agent to "match the established style," and its parenthetical still says pi-permission-system "uses prose `### Phase N (complete)` subsections" — the exact near-verbatim duplicate prose [#601] deleted (the `## Improvement roadmap — Phase N (complete)` summary and the `history/phase-N-*.md` file already carry that content).
- Step 3's reconciliation refreshes metrics and the layout tree but never strips the issue-provenance trails that per-change doc-update commits keep appending to module-tree entries.
- Step 3 reconciles documented `Outcome:` claims against code but does not re-frame `Target:`/pending prose that the phase's delivered outcomes have made current.

Without a hygiene discipline, every phase close re-grows the doc and the read cost `/plan-improvements` Step 1 pays (the "three 50KB reads" [#601] cites) keeps climbing.
The fix is a bounded, change-scoped hygiene step — reviewable, touching only the regions the phase already reconciles, not a full-doc sweep.

## Goals

- Add a bounded, change-scoped doc-hygiene step to `/finish-phase` covering the three regrowth sources, mirroring the tidy-first "only touch what the change touches" discipline.
- Correct Step 4's stale parenthetical so `/finish-phase` never re-emits a duplicate `### Phase N (complete)` prose paragraph under `Refactoring history` — write only the completion summary and the history-table row.
- Direct the reconciliation to strip issue-provenance trails from the module-tree entries the phase touched, keeping only refs that encode an active constraint (lint-guarded boundary, ADR string boundary, structural invariant).
- Direct the reconciliation to re-frame any `Target:`/pending prose the phase's delivered outcomes have made current state.

## Non-Goals

- No changes to package skills or a shared convention doc — lifting [#601]'s per-package "module-tree entries describe current behavior" regrowth guard into a shared convention the hygiene step can reference is [#607]'s job, filed separately.
  This plan references the existing per-package skill rule; when [#607] lands, the hygiene step's wording can point at the shared convention instead.
- No retroactive prune of the existing pi-permission-system or pi-subagents architecture docs — [#601] and [#605] already did that once; this change only prevents regrowth going forward.
- No changes to `/plan-improvements` or the `improvement-discovery` skill — the issue explicitly decided (with @gotgenes) that `/finish-phase`, not `/plan-improvements`, is the right home because it already rewrites these exact regions on a per-phase cadence and is where the duplicate prose originates.
- No change to the required `## Improvement roadmap — Phase N (complete)` summary chain — the `/plan-improvements` hard gate greps for it; the hygiene step must not touch it.
- No renumbering-driven edits to other prompts/skills — the cross-references to `/finish-phase` are conceptual (`/finish-phase`'s job, its recompute verification), never keyed to an internal step number, so inserting a step is safe.

## Background

`/finish-phase` (`.pi/prompts/finish-phase.md`, `$1` = package) closes a package's current improvement phase in five steps:

1. Step 1 — Identify the current phase (record steps, outcomes, issues).
2. Step 2 — Verify every step is closed (hard gate).
3. Step 3 — Reconcile the architecture document with delivered code (trace outcomes, update stale prose, refresh health-metrics/dependency-bag tables).
4. Step 4 — Archive the phase (write `history/phase-N-<slug>.md`, replace the detailed roadmap with a concise completion summary, update the `Refactoring history` table).
5. Step 5 — Verify (`rumdl`/lint, loss-free move checks) and commit + push.

The two packages that run this prompt currently differ in their `Refactoring history` shape, which is why the stale parenthetical matters:

- pi-permission-system (post-[#601]): `Refactoring history` is an intro paragraph plus a `| Phase | Theme | History |` table — the `### Phase N (complete)` prose subsections were deleted.
  The `## Improvement roadmap — Phase N (complete)` summary chain is retained (the `/plan-improvements` gate greps it).
  The `package-pi-permission-system` skill already carries the regrowth guard from [#601]: "Module-tree entries in `docs/architecture/architecture.md` describe **current behavior**; cite an issue only when it encodes an active constraint … never as provenance."
- pi-subagents (post-[#605]): `Refactoring history` is an intro paragraph, a `| Phase | Title | Status | History |` table, and a `### Structural refactoring issues` mapping table — no `### Phase N` prose subsections.

So neither package uses `### Phase N (complete)` prose today, yet Step 4's parenthetical still instructs the agent to produce it for pi-permission-system.
The `Target:`/pending prose the hygiene step re-frames lives in the active-phase roadmap (e.g. pi-permission-system's Phase 12 steps carry `**Target:** …` lines) and in target-direction body sections like `## The authority model` — the hygiene step re-frames only the parts a *just-delivered* phase made current, scoped to what that phase touched.

AGENTS.md constraints that apply:

- This is a prompt-template edit; a same-process re-invocation of `/finish-phase` after this change runs the pre-edit snapshot — on-disk file is authoritative (Refs #586).
  Not relevant to authoring, but worth noting for the operator who edits then re-runs.
- `markdown-conventions`: one-sentence-per-line, sequential list numbering restarting under each heading, fenced-code languages.
  The prompt file is markdown and is linted by `rumdl`.

## Design Overview

The change is confined to `.pi/prompts/finish-phase.md` — a single prompt-template file.
No code, no tests, no package docs.

Two coordinated edits:

1. Insert a new bounded hygiene step after Step 3 (Reconcile) and before the current Step 4 (Archive), renumbering Archive → Step 5 and Verify → Step 6.
   Placing it after reconciliation and before archive is deliberate: the reconcile pass has just re-touched the module tree and prose, so the hygiene sweep operates on exactly those freshly-touched regions, and its no-duplicate-prose directive governs the archive that immediately follows.
2. Correct the current Step 4 (Archive) parenthetical so it stops instructing the agent to emit `### Phase N (complete)` prose for pi-permission-system, and cross-reference the new hygiene step's no-duplicate directive.

### The new hygiene step

Titled `## Step 4: Bounded doc hygiene (change-scoped)`, it opens with the scope discipline — it operates only on the regions this phase already touched (the modules the phase changed, the target prose the phase delivered against), never a full-doc rewrite — then lists the three directives:

1. No duplicate phase prose on archive.
   When you archive in Step 5, emit only the completion summary and the `Refactoring history` history-table row — do not also write a `### Phase N` prose paragraph under `Refactoring history`.
   The `## Improvement roadmap — Phase N (complete)` summary and the `history/phase-N-*.md` file already carry that content; a third copy is the duplication [#601]/[#605] deleted.
2. Strip provenance from touched module-tree entries.
   For each module-tree entry the phase changed, reduce it to what the module is *now*; cite an issue only when the ref encodes an active constraint (a lint-guarded boundary, an ADR string boundary, a structural invariant) — never as a provenance trail ("relocated #559, dissolved #505, renamed #510…"), which belongs in git log and `history/`.
   This mirrors the `package-pi-permission-system` skill's existing regrowth guard; [#607] will generalize that rule into a shared convention this step can reference.
3. Re-frame delivered `Target:`/pending prose.
   Where the phase's delivered outcomes have made a `**Target:**`/pending passage current state, re-frame it as current — but only for prose the phase actually delivered against, and leave genuinely-open targets (later-phase directions) as targets.

The step closes by restating the bound: a phase close should not rewrite unrelated doc regions.

### Step-numbering shift

Inserting a step renumbers the two trailing steps:

```text
Step 3: Reconcile …           (unchanged)
Step 4: Bounded doc hygiene    (new)
Step 5: Archive the phase      (was Step 4)
Step 6: Verify and commit      (was Step 5)
```

No other prompt or skill references `/finish-phase`'s steps by number (verified: cross-references in `plan-improvements.md`, `retro.md`, `ship-issue.md`, and `improvement-discovery` SKILL name `/finish-phase`'s *job*, never a step number), so the shift is internal.

## Module-Level Changes

- `.pi/prompts/finish-phase.md`
  - Insert a new `## Step 4: Bounded doc hygiene (change-scoped)` section after Step 3's `### Stop versus fix` subsection and before the current `## Step 4: Archive the phase`, containing the three directives and the scope framing above.
  - Renumber `## Step 4: Archive the phase` → `## Step 5: Archive the phase` and `## Step 5: Verify and commit` → `## Step 6: Verify and commit`.
  - In the (now) Step 5 Archive instruction, correct the "match the established style" parenthetical: pi-permission-system no longer uses `### Phase N (complete)` prose subsections (both packages now use an intro-plus-table `Refactoring history`), and add a pointer to Step 4's no-duplicate-prose directive.
  - Leave every other instruction (metric recompute, loss-free move checks, commit/push, hand-off) unchanged.

No `src/`, `test/`, package-doc, or skill files change.
No exported symbol, config key, or public API is added, renamed, or removed, so no cross-file symbol grep applies.

## Test Impact Analysis

Not applicable — this is a prompt-template (workflow-tooling) edit with no code and no automated tests.
Verification is the markdown lint (`rumdl`) plus a manual read of the edited flow for internal consistency (step numbering, cross-references).

## Invariants at risk

- The `## Improvement roadmap — Phase N (complete)` summary chain must remain intact — the `/plan-improvements` hard gate greps for it (`plan-improvements.md` line 163).
  Mitigation: the hygiene step's directive 1 explicitly targets only the *duplicate `### Phase N` prose paragraph* under `Refactoring history`, never the roadmap summary; the plan's Non-Goals restate this.
- Step 4/5's loss-free archive checks (Step 6's `grep` counts of step headings, mermaid blocks, tables) must still pass after renumbering.
  Mitigation: no archive mechanics change — only the section's heading number and one parenthetical.

## Build Order

This is a docs/config change (`/build-plan`, not `/tdd-plan`) — no red→green cycles.
A single reviewable commit:

1. Edit `.pi/prompts/finish-phase.md`: insert the hygiene step, renumber the trailing two steps, correct the Archive parenthetical.
   Verify with `pnpm exec rumdl check .pi/prompts/finish-phase.md` and a read-through for step-number and cross-reference consistency.
   Commit: `docs: add bounded doc-hygiene step to /finish-phase (#606)`.

## Risks and Mitigations

- Risk: the hygiene step reads as license for a full-doc rewrite, defeating the "bounded" intent.
  Mitigation: the step opens and closes with an explicit change-scope bound ("only regions this phase already touched", "should not rewrite unrelated doc regions"), mirroring tidy-first discipline the operator invoked in the issue.
- Risk: directive 1 is misread as deleting the roadmap summary chain.
  Mitigation: directive 1 names its target precisely (the duplicate `### Phase N` prose under `Refactoring history`) and the plan/step both call out the roadmap chain as retained.
- Risk: the corrected parenthetical drifts again if a package changes its `Refactoring history` shape later.
  Mitigation: the corrected wording describes the *shared* current shape (intro-plus-table, no per-phase prose) rather than re-listing per-package specifics, so it stays accurate for both packages.

## Open Questions

None.
The direction is the operator's own and unambiguous; the companion generalization work is already carved out as [#607].

[#601]: https://github.com/gotgenes/pi-packages/issues/601
[#605]: https://github.com/gotgenes/pi-packages/issues/605
[#607]: https://github.com/gotgenes/pi-packages/issues/607
