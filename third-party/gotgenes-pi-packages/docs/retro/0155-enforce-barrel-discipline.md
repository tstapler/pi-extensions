---
issue: 155
issue_title: "Enforce barrel file discipline across packages"
---

# Retro: #155 — Enforce barrel file discipline across packages

## Final Retrospective (2026-05-23T12:00:00Z)

### Session summary

Removed 10 dead barrel re-exports across `pi-permission-system` (5) and `pi-subagents` (5) so `pnpm fallow dead-code` reports zero barrel-discipline violations.
The plan-build-ship pipeline completed with zero rework, zero deviations, and zero CI failures.
Released as `pi-subagents@6.14.1`.

### Observations

#### What went well

- Fallow-driven workflow proved its value: detect → plan → fix → verify with fallow was clean and mechanical.
- The `ask_user` for plan placement (one plan vs. two for a cross-package issue) was appropriate — the `/plan-issue` template assumes a single `PKG`, and the user's preference avoided unnecessary duplication.

#### What caused friction (agent side)

- `missing-context` — During the planning phase, used `grep` exclusively for all 10+ symbol investigations.
  For exact symbol matching (`shouldExposeTool`, `isPermissionState`, etc.), grep was the right choice.
  But for the exploration phase — understanding barrel conventions across sibling packages, identifying which modules are internal vs. public — `colgrep`'s semantic search could have oriented faster.
  The user asked about this after the plan commit.
  Impact: added friction but no rework; the grep results were correct and exhaustive.

#### What caused friction (user side)

- The colgrep feedback came as a post-hoc question rather than a mid-plan redirect.
  Earlier intervention (e.g., "use colgrep for the convention-discovery step") would have saved a round-trip, though the impact was minimal since the results were correct either way.

### Changes made

1. Added colgrep nudge to `AGENTS.md` Code Style section for codebase exploration.
2. Updated `.pi/prompts/plan-issue.md` step 7 to mention `colgrep or grep` for convention discovery.
3. Moved plan and retro from `packages/pi-permission-system/docs/` to top-level `docs/` for cross-package placement.
4. Added cross-package plan/retro guidance to `AGENTS.md`, `.pi/prompts/plan-issue.md`, `.pi/prompts/build-plan.md`, `.pi/prompts/tdd-plan.md`, and `.pi/prompts/retro.md`.
