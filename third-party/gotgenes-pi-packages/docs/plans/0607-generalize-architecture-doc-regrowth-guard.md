---
issue: 607
issue_title: "Generalize the architecture-doc module-tree regrowth guard into a shared convention"
---

# Generalize the architecture-doc module-tree regrowth guard into a shared convention

## Release Recommendation

**Release:** ship independently

This change touches only repo-root tooling: `AGENTS.md`, `.pi/prompts/finish-phase.md`, and `.pi/skills/package-pi-permission-system/SKILL.md`.
None of those files ship in any package tarball, and no package architecture roadmap references [#607] (verified: `grep -rn "607" packages/*/docs/architecture/architecture.md` finds nothing), so it participates in no batch and cuts no package release — it lands on `main` as a `docs:` commit with no release coordination.

## Problem Statement

[#601] added a local rule to `.pi/skills/package-pi-permission-system/SKILL.md`: architecture-doc module-tree entries describe **current behavior**; cite an issue only when it encodes an active constraint; provenance belongs in git log and `history/`.
The same regrowth pressure exists in every package with an architecture doc — [#605] just paid down the identical debt in pi-subagents, and any future package will re-accrete it.
A single-package skill rule leaves the others to re-grow the exact trail the bulk prunes ([#601], [#605]) cleared, and `/finish-phase`'s hygiene step ([#606]) can only reference "the `package-$1` skill's regrowth guard where the package carries one" — a per-package hook that is empty for pi-subagents.
Lift the rule into one repo-wide home so it governs every package uniformly.

## Goals

- State the module-tree regrowth guard **once**, canonically, in the repo-level `AGENTS.md`, so it governs every package's architecture doc rather than one.
- Remove the now-redundant per-package copy from `.pi/skills/package-pi-permission-system/SKILL.md` — single source of truth, zero duplication.
- Repoint `/finish-phase`'s Step 4 provenance-strip directive at the shared `AGENTS.md` convention as the standard the module tree is held to, replacing its per-package-skill reference.

## Non-Goals

- No retroactive prune of any architecture doc — [#601] and [#605] already did that once for pi-permission-system and pi-subagents; this change only fixes where the standing rule lives.
- No new full-text copy of the rule in any `package-<PKG>` skill (neither pi-subagents nor pi-permission-system) — the operator chose a single canonical home with no per-package pointer, so package skills carry the rule via `AGENTS.md` (always loaded), not a mirrored or pointer line.
  This is the deliberate rejection of the issue's "and/or mirror it into each `package-<PKG>` skill" alternative.
- No changes to `/finish-phase`'s hygiene-step mechanics ([#606] shipped those) beyond the one reference-target sentence.
- No changes to the `improvement-discovery` skill — the roadmap/`Release:`-tag conventions it owns are orthogonal to module-tree hygiene, and it is loaded only during `/plan-improvements`, absent during the per-change doc-update commits where regrowth happens.
- No edits to the historical plan/retro archives that mention the guard (`packages/*/docs/plans/0601-*.md`, `0605-*.md`, and their retros) — those are point-in-time records, not live references.

## Background

The guard's current three-way arrangement:

- `.pi/skills/package-pi-permission-system/SKILL.md` (lines 24–25) carries the full rule plus a package-specific tail tying it to [#601]'s prune:
  > Module-tree entries in `docs/architecture/architecture.md` describe **current behavior**; cite an issue only when it encodes an active constraint (a lint-guarded boundary, an ADR string boundary, a structural invariant), never as provenance — the "relocated #559, dissolved #505, renamed #510…" trail belongs in git log and `history/`.
  > Without this, the per-change doc-update commits above re-inflate the tree that #601 slimmed (Refs #601).
- `.pi/skills/package-pi-subagents/SKILL.md` carries **no** such guard (its architecture-doc guidance says only that history lives in `docs/architecture/history/`).
- `.pi/prompts/finish-phase.md` Step 4 directive 2 (lines 105–107) states the rule inline for the touched entries, then closes: "This mirrors the `package-$1` skill's regrowth guard where the package carries one." — a dangling reference for any package (pi-subagents) that lacks the skill rule.

`AGENTS.md` has no architecture-doc authoring convention today; its closest neighbor is the `### Docs-in-distribution convention` subsection under `## Monorepo Structure`, which governs the published-tarball file set (a different concern).

AGENTS.md constraints that apply:

- `AGENTS.md` is always loaded as project context (repo-root, discovered from CWD), so a rule placed there is present during **every** per-change doc-update commit and every `/finish-phase` run — exactly the moments regrowth occurs.
  This is why `AGENTS.md` (not the on-demand `improvement-discovery` skill) was chosen as the canonical home.
- Prompt-template edits: a same-process re-invocation of `/finish-phase` after this change runs the pre-edit snapshot — the on-disk file is authoritative (Refs #586).
  Not relevant to authoring, only to an operator who edits then immediately re-runs.
- `markdown-conventions`: one-sentence-per-line, reference-style `[#N]` links in long-lived docs, sequential list numbering restarting under each heading, fenced-code languages.
  `AGENTS.md`, the prompt, and the skill are all markdown linted by `rumdl` (via `pnpm run lint` and the pre-commit hook).

## Design Overview

Three coordinated edits, all in repo-root tooling files — no code, no tests, no package docs.

### 1. Add the canonical convention to `AGENTS.md`

A new `### Architecture-doc conventions` subsection under `## Monorepo Structure`, placed immediately after `### Docs-in-distribution convention` and before `## Workflow` — grouping it with the other repo-wide doc-organization convention.
It states the rule generally (not tied to any one package's prune) and names `/finish-phase` as the enforcer:

```markdown
### Architecture-doc conventions

Every package's `docs/architecture/architecture.md` module-tree entries describe **current behavior** — what each module is now.
Cite an issue in a module-tree entry **only** when the ref encodes an active constraint (a lint-guarded boundary, an ADR string boundary, a structural invariant); all other provenance belongs in git log and `docs/architecture/history/`, never in the tree (the "relocated #559, dissolved #505, renamed #510…" trail).
Without this discipline, the per-change doc-update commits that append provenance re-inflate the tree — the debt #601 and #605 paid down in bulk for pi-permission-system and pi-subagents.
`/finish-phase`'s bounded doc-hygiene step holds each phase's touched module-tree entries to this standard (Refs #601, #605, #606, #607).
```

`AGENTS.md` cites issues as bare `#N` (matching the file's existing style — it is not a `docs/architecture/` or `docs/plans/` doc, so the reference-style-link rule and MD053 do not apply here), so no `[#N]:` definitions are added to it.

### 2. Remove the per-package copy from `package-pi-permission-system`

Delete both lines (the guard and its `Without this…` tail) from `.pi/skills/package-pi-permission-system/SKILL.md`.
The preceding paragraph (roadmap-step `✅`-marking in the doc-update commit) and the following `## Implementation Priorities` heading remain adjacent and coherent — the removed lines are a self-contained pair.
The rule still reaches anyone working in that package via `AGENTS.md`.

### 3. Repoint the `/finish-phase` reference

In `.pi/prompts/finish-phase.md` Step 4 directive 2, replace the trailing sentence
> This mirrors the `package-$1` skill's regrowth guard where the package carries one.

with a pointer to the shared convention, e.g.
> This is the shared architecture-doc convention in `AGENTS.md` (`### Architecture-doc conventions`); hold every touched module-tree entry to it.

The directive's inline statement of the rule stays — the sentence only changes what it cross-references, from an empty-for-some-packages skill hook to the always-present `AGENTS.md` convention.

## Module-Level Changes

- `AGENTS.md`
  - Add a new `### Architecture-doc conventions` subsection under `## Monorepo Structure`, after `### Docs-in-distribution convention` and before `## Workflow`, with the canonical rule from Design Overview §1.
- `.pi/skills/package-pi-permission-system/SKILL.md`
  - Remove the two-line regrowth-guard paragraph (the "Module-tree entries in `docs/architecture/architecture.md` describe **current behavior**…" line and its "Without this…" follow-on), leaving the surrounding roadmap-marking paragraph and `## Implementation Priorities` heading intact.
- `.pi/prompts/finish-phase.md`
  - In Step 4 directive 2, replace the "This mirrors the `package-$1` skill's regrowth guard where the package carries one." sentence with a pointer to the `AGENTS.md` `### Architecture-doc conventions` shared convention.

No `src/`, `test/`, package-doc, or `package.json` files change.
No exported symbol, config key, event channel, or public API is added, renamed, or removed, so no cross-file symbol grep applies.
The grep for live references to the guard (`grep -rn "regrowth guard\|package-\$1 skill\|module-tree entries describe" .pi/`) finds exactly the two edit sites above; every other hit is in point-in-time plan/retro archives (Non-Goals).
`.pi/skills/package-pi-subagents/SKILL.md` is intentionally **not** touched — it never carried the guard and gets no mirror (Non-Goals).

## Test Impact Analysis

Not applicable — this is a docs/workflow-tooling edit with no code and no automated tests.
Verification is `pnpm exec rumdl check` on each edited markdown file plus a read-through for internal consistency (the `AGENTS.md` subsection reads generally, the skill removal leaves coherent surrounding prose, the `/finish-phase` pointer resolves to the new `AGENTS.md` heading).

## Invariants at risk

- `/finish-phase` Step 4 directive 2 must still state the rule inline (it is the operative instruction the agent follows); only its closing cross-reference changes.
  Mitigation: edit 3 replaces one sentence and leaves the directive body untouched.
- The `## Improvement roadmap — Phase N (complete)` summary chain and other `/finish-phase`/`/plan-improvements` gates are unrelated to this change and are not touched.

## Build Order

This is a docs/tooling change (`/build-plan`, not `/tdd-plan`) — no red→green cycles.
A single reviewable commit, since the three edits are one coherent move (canonicalize + remove duplicate + repoint reference):

1. Add the `### Architecture-doc conventions` subsection to `AGENTS.md`; remove the two-line guard from `.pi/skills/package-pi-permission-system/SKILL.md`; repoint the `/finish-phase` Step 4 directive-2 sentence at the shared convention.
   Verify with `pnpm exec rumdl check AGENTS.md .pi/skills/package-pi-permission-system/SKILL.md .pi/prompts/finish-phase.md` and a read-through.
   Commit: `docs: generalize architecture-doc module-tree regrowth guard into a shared convention (#607)`.

## Risks and Mitigations

- Risk: removing the per-package copy makes the rule less discoverable when only a package skill is loaded and `AGENTS.md` is somehow out of context.
  Mitigation: `AGENTS.md` is always loaded from the repo-root CWD, so the rule is in context for all package work; the operator explicitly chose single-source over a per-package pointer.
- Risk: the `/finish-phase` pointer names an `AGENTS.md` heading (`### Architecture-doc conventions`) that could drift if the heading is later renamed.
  Mitigation: the pointer names both the file and the heading text; a rename would surface in a `grep` for the heading, and the directive's inline rule statement remains authoritative even if the cross-reference goes stale.
- Risk: the canonical wording drifts from the `/finish-phase` inline wording over time.
  Mitigation: both derive from the same rule; the `AGENTS.md` version is the general statement and `/finish-phase` states the operative directive — minor wording divergence is acceptable because neither is a grep target for a gate.

## Open Questions

None.
The direction and the three design choices (canonical home = `AGENTS.md`; remove per-package copies with no pointer; repoint `/finish-phase` at the shared convention) were confirmed with the operator during planning.

[#601]: https://github.com/gotgenes/pi-packages/issues/601
[#605]: https://github.com/gotgenes/pi-packages/issues/605
[#606]: https://github.com/gotgenes/pi-packages/issues/606
[#607]: https://github.com/gotgenes/pi-packages/issues/607
