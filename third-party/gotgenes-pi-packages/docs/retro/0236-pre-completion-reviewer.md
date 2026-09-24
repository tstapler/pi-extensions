---
issue: 236
issue_title: "Add pre-completion reviewer subagent"
---

# Retro: #236 — Add pre-completion reviewer subagent

## Stage: Planning (2026-05-26T20:00:00Z)

### Session summary

Planned the pre-completion reviewer subagent — three markdown deliverables (agent definition, dispatch skill, template updates) with no code changes.
Studied the repone reference implementation at `~/tinyigsoftware/repone/.opencode/agents/pre-completion-reviewer.md` and its `pre-completion` skill to adapt the pattern for Pi's agent/skill system.
Clarified three design decisions with the user: always-dispatch (no ask), report-to-user on FAIL (no auto-fix loop), and `claude-sonnet-4-6-20260526` as the model.

### Observations

- The repone reviewer has 10 judgment sections; the plan scopes down to 7 by dropping app-specific sections (OTel, polish gaps, lifecycle completeness, AWS SSO).
- Repone's `dod_preflight` tool bundles deterministic checks into a single tool call; this plan runs the same checks as raw bash commands since no custom tool infrastructure exists in this repo.
- The plan inserts the reviewer between "After the last step" (final checks) and "Summarize" in both templates — the skill keeps the template insertion minimal (one line: "Load the `pre-completion` skill and follow the dispatch protocol").
- This is a `/build-plan` execution (all markdown, no TDD cycles).
- The `AGENTS.md` available-skills list auto-discovers from `.pi/skills/` but documenting the new skill explicitly helps discoverability.

## Stage: Implementation — Build (2026-05-26T22:40:00Z)

### Session summary

Delivered all 5 plan steps in 6 commits: agent definition, dispatch skill, `tdd-plan` and `build-plan` template integrations, `AGENTS.md` documentation, and a fixup for an incorrect test command.
The pre-completion reviewer ran on its own output and caught a real defect before shipping — `pnpm vitest run` exits non-zero at the repo root; replaced with `pnpm run test` across the agent definition and `AGENTS.md`.
All deterministic checks pass and the reviewer returned PASS on the second dispatch.

### Observations

- **Reviewer caught a real bug on first use:** `pnpm vitest run` was used throughout the plan, issue ACs, and agent definition, but `vitest` is not a root dependency in this monorepo.
  The correct command is `pnpm run test` (`pnpm -r run test`).
  This is the kind of deviation a fresh-context subagent catches that an in-context agent might overlook.
- The reviewer required two dispatches — first returning FAIL for the `pnpm vitest run` issue, then PASS after the fix.
  The "report to user, then fix and re-dispatch" flow from the `pre-completion` skill worked as designed.
- Pre-completion reviewer verdict: **PASS** (second dispatch).

## Stage: Final Retrospective (2026-05-27T13:30:00Z)

### Session summary

Shipped the pre-completion reviewer (issue closed, `pi-subagents-v9.0.1` released) and ran a retrospective spanning all three stages: planning, build, and ship.
The reviewer validated itself on its first invocation by catching a latent `pnpm vitest run` command failure, leading to a fix in 4 additional locations across the template files.

### Observations

#### What went well

- **Fresh-context reviewer proved its value immediately.**
  The pre-completion reviewer caught `pnpm vitest run` failing at the repo root — a bug present in the issue ACs, the plan, and the agent definition.
  None of the three prior sessions (planning, build, ship) noticed it because `vitest` works from within package directories.
  This is the exact class of error a fresh-context subagent is designed to catch.
- **Skill-based dispatch pattern kept template changes minimal.**
  Both `tdd-plan.md` and `build-plan.md` gained only 2 lines each (load skill + one-line section).
  All protocol details live in `.pi/skills/pre-completion/SKILL.md`, following Tell-Don't-Ask.
- **Repone adaptation was well-scoped.**
  The planning session studied the repone reference directly (`~/tinyigsoftware/repone/.opencode/agents/pre-completion-reviewer.md`) and scoped down from 10 judgment sections to 7, explicitly deferring app-specific sections in Non-Goals.

#### What caused friction (agent side)

- `missing-context` — The agent used `pnpm vitest run` (copied from existing templates and issue ACs) without verifying whether it works at the repo root.
  `vitest` is not a root dependency; only `pnpm run test` (`pnpm -r run test`) works from the root.
  Impact: 1 extra commit (`17bea72b`), 1 extra reviewer dispatch (~5 minutes), and discovery that the same bug exists in `tdd-plan.md`, `build-plan.md`, and `retro.md`.
- `missing-context` — The planning agent tried to fetch the repone repo via `fetch_content` on the GitHub URL, which failed because the repo is private.
  Impact: 1 wasted tool call; the user redirected to `~/tinyigsoftware/repone` in 1 message.

#### What caused friction (user side)

- The repone repo's local path (`~/tinyigsoftware/repone`) was not mentioned in the issue body.
  The agent could not discover this path on its own — it had to ask.
  Low-friction: the user responded immediately.

### Diagnostic details

- **Model-performance correlation** — The pre-completion reviewer subagent ran on `claude-sonnet-4-6-20260526` as designed.
  The ship-issue stage ran on `deepseek-v4-flash` (mechanical push/CI/merge work — appropriate for the task).
  The retro stage ran on `claude-opus-4-6` (judgment-heavy synthesis — appropriate).
  No mismatches.
- **Feedback-loop gap analysis** — `pnpm run lint` ran after every step during implementation (5 clean runs).
  Good incremental verification pattern.
  The `pnpm vitest run` failure was caught by the reviewer at the end, not during incremental steps — but this is expected since the implementation steps only wrote markdown files (no test runs needed).

### Changes made

1. `.pi/prompts/tdd-plan.md` — replaced `pnpm vitest run` with `pnpm run test` in "Verify green baseline" (line 59) and "After the last TDD step" (line 92).
2. `.pi/prompts/build-plan.md` — replaced `pnpm vitest run` with `pnpm run test` in "After the last step" (line 92).
3. `.pi/prompts/retro.md` — replaced `pnpm vitest run` with `pnpm run test` in "Feedback-loop gap analysis" diagnostic lens (line 95).
