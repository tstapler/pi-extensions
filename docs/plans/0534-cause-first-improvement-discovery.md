---
issue: 534
issue_title: "Revise /plan-improvements and improvement-discovery: cause-first discovery, deferral gate, and audit gaps"
---

# Cause-first improvement discovery: reorder, deferral gate, and audit gaps

## Release Recommendation

**Release:** ship independently

This change touches only repo-root workflow tooling (`.pi/prompts/plan-improvements.md` and `.pi/skills/improvement-discovery/SKILL.md`).
Neither file is published in any package tarball and neither participates in an architecture roadmap, so the change cuts no package release — it lands on `main` as a `docs:` commit with no release coordination.
There is no batch to defer to.

## Problem Statement

A retrospective of the pi-subagents Phase 20 planning session surfaced one bias and several audit gaps in the `/plan-improvements` workflow.
The template runs fallow as Step 1, so its syntactic output frames the whole analysis and reads as the default agenda — even though the phase spine came from principle-driven reading of the architecture doc, and fallow contributed only ~4 of 9 steps.
Fallow finds symptoms by construction; causes need cause-first reading.
Alongside that anchoring bias, the workflow has concrete gaps: it never sweeps open issues, never offers a "no phase warranted" exit, never feasibility-checks outcome claims that depend on the SDK type surface, computes priority scores it never publishes, and cites estimated CRAP (unreliable when a coverage file is absent) as step motivation.
Two steps are also low-value on mature packages: Step 1 duplicates fallow commands the loaded skills already carry, and Step 5 (directory organization) is a scripted no-op once domain directories exist.

## Goals

- Reframe discovery as cause-first: read the architecture doc and form a cause hypothesis before running fallow, and demote fallow to corroboration-and-baseline.
- State explicitly that the phase spine must not be fallow-sourced-only.
- Add an open-issue sweep (`gh issue list --label "pkg:<PKG>" --state open`) cross-checked against the architecture doc's claims.
- Add a qualitative deferral gate: when discovery yields only polish, present "defer" and "lean phase" as first-class `ask_user` options — deliberately not a numeric threshold.
- Require a feasibility probe for boundary-typing steps before committing an outcome claim that depends on the SDK/type surface.
- Make the directory-organization analysis conditional (skip when domain directories exist and the root file count is small).
- Trim the duplicated fallow command block from the template.
- Add a retro hook so `/plan-improvements` persists planning observations (the only stage template currently without one).
- In `improvement-discovery`: require per-step cause attribution, add a fallow-CRAP gotcha, and publish per-step Impact/Risk/Priority scores in the Output format.

## Non-Goals

- No changes to `/finish-phase`, `/plan-issue`, or `/ship-issue` — the `Release:` tag mechanism they read is untouched.
- No changes to the `fallow` or `package-*` skills.
- No change to the `markdown-conventions` frontmatter schema — the retro hook inlines its own frontmatter in the template (the pattern `/plan-issue` already uses), so no shared-schema edit is needed.
- No new numeric threshold for the deferral decision — the priority score ranks within a phase, it does not decide whether a phase exists.

## Background

Two repo-root files drive the improvement-planning workflow:

- `.pi/prompts/plan-improvements.md` (141 lines) — the `/plan-improvements <PKG>` slash-command body.
  Its Analysis section is a 7-step sequence: (1) Run fallow, (2) Read architecture doc, (3) Trace from `index.ts`, (4) Read tests as constructibility evidence, (5) Assess directory organization, (6) Apply the smell taxonomy + score, (7) Propose the phase plan.
  It has no retro hook — the only stage template without one.
- `.pi/skills/improvement-discovery/SKILL.md` (215 lines) — the loaded skill carrying the smell taxonomy (Categories A–F), the prioritization framework (`Priority = Impact × (6 − Risk)`), grouping heuristics, and the Output format.
  Its Section 1 already carries the full fallow command block that the template's Step 1 duplicates.

Neither file ships in a package tarball; both are repo-root tooling under `.pi/`.
The `pkg:pi-subagents` label reflects the retro's origin (a pi-subagents planning session), not the change surface — no package code changes.

Relevant conventions from AGENTS.md and sibling templates:

- `/plan-issue` inlines its retro-file frontmatter and stage-entry format directly in the prompt body — the retro hook here follows the same self-contained pattern.
- `/finish-phase` archives a completed phase's roadmap to `packages/<PKG>/docs/architecture/history/phase-N-<slug>.md`; the retro hook must not collide with or duplicate that archive.
- The `Release:` tag format is defined in the `improvement-discovery` skill's Output format and read by `/plan-issue` — the per-step Output additions must preserve that line verbatim.

## Design Overview

This is a docs/tooling revision (two markdown files); there is no code, no test surface, and no TDD cycle.
The next stage is `/build-plan`.

### Template restructure (`plan-improvements.md`)

The Analysis section is resequenced to lead with cause hypothesis and demote fallow:

1. **New Step 1 — Read the architecture doc and form a cause hypothesis.**
   Absorbs the current Step 2 (read `architecture.md`, note health metrics, dependency-bag inventory, hotspots) and adds an explicit instruction: form a first-principles cause hypothesis about what structural problem the next phase should dissolve, *before* running any tool.
   The phase-number determination, `set_session_name` call, and the Phase N−1 archive hard gate stay here (they already live in the current Step 2).
2. **New Step 2 — Open-issue sweep.**
   `gh issue list --label "pkg:<PKG>" --state open`, cross-checked against the architecture doc's claims about which issues remain open — doc/tracker drift would otherwise cause re-planning filed work or missing a parked candidate.
3. **Step — Run fallow for corroboration and baseline.**
   The current Step 1 content, demoted and reframed: fallow corroborates the cause hypothesis and supplies outcome baselines (LOC, complexity, dead code), it does not set the agenda.
   The duplicated command block is trimmed to a one-line pointer to the `fallow` / `improvement-discovery` skills (which carry the exact commands); the template keeps only the "record: health score, dead code, duplication, hotspots, targets" note.
   An explicit rule is added: **the phase spine must not be fallow-sourced-only** — at least the primary cause must trace to principle-driven reading, not a syntactic finding.
4. **Trace from entry point / read tests / taxonomy** — current Steps 3, 4, 6 retained in order.
5. **Directory organization — made conditional.**
   Current Step 5 gains a guard at its head: skip the deep directory-organization analysis when domain subdirectories already exist and the `src/` root file count is small (< 10); note the skip and move on.
   The tidy-first regrouping guidance is retained for the case where the guard does not fire.
6. **Deferral gate** (new, folded into the propose/score stage).
   After scoring, if discovery surfaced no cause-level finding (Category A–C — structural fusion, coupling/boundary flaws, dead subsystems) and the candidate list is polish-only (Category B unit-size, D, E symptoms), the planner must say so and present **"defer"** and **"lean phase"** as first-class `ask_user` options.
   This reframes "max 9 steps" as a ceiling, not a target, and adds the missing "phase not warranted" exit.
   Explicitly not a numeric threshold — the priority score ranks within a phase, it does not decide whether a phase exists.
7. **Feasibility probe** (new, folded into the propose stage).
   Any step whose outcome claim depends on the SDK/type surface (e.g. "remove file-level eslint-disables once the SDK exports usable types") must be feasibility-probed — confirm the named type/export actually exists in the real surface — before the claim is committed to the plan.
   Mirrors the AGENTS.md rule that a named remediation in a migration note must be verified against the real surface.

### Retro hook (new closing step in the template)

`/plan-improvements` is phase-scoped, not issue-scoped, so its observations do not fit the issue-keyed `NNNN-<slug>.md` retro convention.
The hook writes a phase-scoped retro at `packages/<PKG>/docs/retro/phase-N-<slug>.md`, self-contained (frontmatter and stage-entry format inlined in the template, as `/plan-issue` does):

```markdown
---
package: <PKG>
phase: N
---

# Retro: <PKG> — Phase N Planning (<slug>)

## Stage: Improvement Planning (<ISO 8601 timestamp>)

### Session summary

2–3 sentences on the cause hypothesis and the phase shape chosen.

### Observations

The cause the phase dissolves, alternatives/deferrals considered, and any deferral-gate outcome (defer / lean phase / full phase).
```

The hook creates `packages/<PKG>/docs/retro/` if absent, commits the retro file with `docs(<PKG>): add Phase N planning retro notes`, and does not touch `/finish-phase` (which owns the separate `history/` archive).

### Skill changes (`improvement-discovery/SKILL.md`)

Three Output-format / rule additions, no restructure:

1. **Per-step cause attribution** — each step in the Output format names the cause it dissolves and cites the fallow signal as the *symptom*, not the motivation.
   Added as a required field alongside the existing `Smell:` / `Outcome:` / `Release:` lines.
2. **Fallow-CRAP gotcha** — a new rule near the prioritization framework: before citing a CRAP score as motivation, either run `fallow health --coverage <file>` with a real coverage file or confirm whether a test file exists for the module; treat estimated CRAP (static-reference-traced, no coverage) as a hint, not a finding.
3. **Per-step Impact/Risk/Priority scores in the Output format** — the framework already defines `Priority = Impact × (6 − Risk)`; the Output format is amended to require each step to publish its `Impact` / `Risk` / `Priority` values so the ranking is auditable in the committed roadmap at `/plan-issue` time.

### Design decision: reorder vs. demote-in-place

The issue offers two options for the fallow-anchoring fix — physically reorder the steps, or demote fallow in place with a framing note.
This plan chooses **reorder** (cause hypothesis becomes Step 1, fallow moves after the open-issue sweep): it matches the issue's "cause-first discovery" framing and makes the sequencing self-enforcing rather than relying on a caveat the planner reads and then ignores.
The `Release:`-tag Output contract and the skill cross-references are preserved either way.

## Module-Level Changes

- `.pi/prompts/plan-improvements.md`
  - Resequence the Analysis section: new Step 1 (architecture doc + cause hypothesis), new Step 2 (open-issue sweep), demoted fallow step (corroboration/baseline, command block trimmed to a skill pointer, "spine must not be fallow-sourced-only" rule), retained trace/tests/taxonomy steps, conditional directory-organization step (< 10 root files + domain dirs → skip), deferral gate (`ask_user` defer/lean-phase), feasibility probe for SDK-dependent outcomes.
  - Reframe the "max 9 steps" line as a ceiling with a "phase not warranted" exit.
  - Add a closing retro-hook step writing `packages/<PKG>/docs/retro/phase-N-<slug>.md` with inlined frontmatter (`package` / `phase`) and stage-entry format, plus its `docs(<PKG>): add Phase N planning retro notes` commit.
- `.pi/skills/improvement-discovery/SKILL.md`
  - Output format: add a per-step cause-attribution field (cause dissolved + fallow signal as symptom) and per-step `Impact` / `Risk` / `Priority` values.
  - Add a fallow-CRAP gotcha rule (verify coverage or test-file existence before citing CRAP as motivation; estimated CRAP is a hint, not a finding).

No package `src/`, `test/`, README, architecture doc, or `package-*` skill changes.
Cross-reference check confirmed the `Release:` mechanism named in `AGENTS.md` and `.pi/prompts/plan-issue.md` is untouched, so no edits propagate there.

## Test Impact Analysis

Not applicable — this is a docs/tooling change with no test surface.
Verification is manual/lint: `pnpm run lint` (rumdl) on both edited markdown files, plus a read-through confirming the resequenced steps stay internally consistent (no step references a sibling step by a now-stale number).

## Invariants at risk

- **`Release:` tag Output contract** — `/plan-issue` greps the per-step `Release:` line and the `Release batches` heading from the skill's Output format.
  The per-step Output additions (cause attribution, Impact/Risk/Priority) must not alter or displace the `Release:` line's format or the `Release batches` subsection.
  Pinned by manual review, not a test (these are prompt/skill markdown files).
- **Phase N−1 archive hard gate** — the reorder must preserve the gate currently in Step 2 (stop and require `/finish-phase` if the prior phase is unarchived); it moves into the new Step 1 intact.

## Build Order

This is a `/build-plan` (docs-only); there are no red→green cycles.
Suggested commit sequence, each leaving both files lint-clean:

1. `docs: reorder /plan-improvements discovery to cause-first with open-issue sweep (#534)` — template Steps 1–3 resequence (cause hypothesis first, open-issue sweep, demoted+trimmed fallow step, "spine not fallow-sourced-only" rule).
2. `docs: add deferral gate, feasibility probe, and conditional dir-org to /plan-improvements (#534)` — template deferral gate, feasibility probe, conditional directory-organization guard, "max 9" ceiling reframe.
3. `docs: add retro hook to /plan-improvements (#534)` — closing retro-hook step with inlined phase-scoped frontmatter and commit instruction.
4. `docs: publish cause attribution and priority scores in improvement-discovery (#534)` — skill Output-format additions (cause attribution, Impact/Risk/Priority) and the fallow-CRAP gotcha rule.

Steps are independent edits to two files and may be squashed if preferred; keeping them separate keeps each reviewable.

## Risks and Mitigations

- **Resequencing introduces a stale cross-reference** (a step citing "Step N" by a number that shifted).
  Mitigation: the template refers to steps by name, not number, in most places; the build step re-reads the full Analysis section after editing to confirm no numeric back-reference dangles.
- **Retro-hook frontmatter diverges from the issue-keyed schema and confuses future readers.**
  Mitigation: inline the schema in the template (as `/plan-issue` does) and use distinct keys (`package` / `phase`) so it is clearly a phase-scoped variant, not a malformed issue retro; no shared `markdown-conventions` edit.
- **Deferral gate over-fires and blocks legitimate lean phases.**
  Mitigation: the gate *presents* defer/lean-phase as `ask_user` options — the operator decides; it does not auto-defer.

## Open Questions

- None blocking.
  The retro-hook placement (a standalone phase-scoped retro vs. folding observations into the `/finish-phase` history archive) was resolved in favor of a standalone file to keep `/finish-phase` untouched; if a future phase wants the planning notes inside the archive, `/finish-phase` can fold the phase retro in as a separate enhancement.
