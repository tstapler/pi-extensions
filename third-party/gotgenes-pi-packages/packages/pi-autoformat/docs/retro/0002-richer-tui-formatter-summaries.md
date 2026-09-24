---
issue: 1
issue_title: "Add richer TUI formatter summaries"
---

# Retro: #1 — Add richer TUI formatter summaries

## Final Retrospective (2026-05-02T01:09:19Z)

### Session summary

Planned, implemented, shipped, and released `2.2.0` for issue #1.
Replaced transient success toasts with a persistent themed `setStatus("autoformat", ...)` footer line; failures keep the warning toast and additionally leave an error-styled status that survives until the next flush.
Seven TDD commits plus a docs commit landed cleanly; CI green; release-please PR `#19` merged.

### Observations

#### What went well

- TDD execution was unusually clean — seven cycles (`4d4fb8c` → `9a10d59`), every commit green, the one minor deviation (folding step 1's minimal impl into its own test commit so `main` never carried a failing test) was noted and within the slash-command's deviation guidance.
- The lint-fixup split worked correctly: `pnpm run lint:fix` touched both source and docs files; `src/extension.ts` + `test/extension.test.ts` fixups were amended into the most recent `test:` commit and the `docs:` commit stayed docs-only, per the slash-command rule.
- `/plan-issue`'s "Decide" step did its job — first `ask_user` surfaced that the issue was exploratory, second `ask_user` (after researching the actual Pi UI surface) converged on a concrete, shippable direction in one round.

#### What caused friction (agent side)

- `instruction-violation` (user-caught) — Wrote prose paragraphs in `README.md` and `docs/configuration.md` with hard wraps inside multi-sentence paragraphs.
  `AGENTS.md` § Markdown already says "Use one sentence per line (unbroken) for better diffs."
  Required an `--amend` of the docs commit (`1df2550`) after the user pointed it out.
  Impact: one rework cycle, no commit churn beyond the amend, but the rule was visible in `AGENTS.md` and I had read it that session.
- `premature-convergence` / `missing-context` — In the first `/plan-issue` `ask_user`, I assumed `ctx.ui.notify` was the only Pi UI primitive available and offered four options all routed through notifications.
  The user redirected with "let's explore our options before we converge.
  The Pi codebase is at `~/development/pi/pi-mono`."
  Reading `pi-mono/packages/coding-agent/src/core/extensions/types.ts` revealed `setStatus`, `setWidget`, `custom`, and `theme.fg` — substantively richer surface area.
  The second `ask_user` led to the actually-shipped design.
  Impact: one extra `ask_user` round; would have produced a weaker plan if the user had not redirected.

#### What caused friction (user side)

- The pi-extension project depends on the Pi runtime API surface, but nothing in `AGENTS.md` or the project context points an agent at `pi-mono` for that surface.
  The user supplied the path mid-session as a redirection.
  Earlier mention (or a hint in `AGENTS.md`) would have eliminated the first round of shallow options.
  Framed as opportunity, not criticism: this is the kind of context that lives in one head and can be cheaply written down once.

### Changes made

1. Added this retro file at `docs/retro/0002-richer-tui-formatter-summaries.md`.
   No `AGENTS.md` or prompt changes were landed; both candidate proposals (Pi-runtime API pointer in `AGENTS.md` § Notes for Agents, and a sentence-per-line scan note in `/tdd-plan` step 3) were declined this round.
