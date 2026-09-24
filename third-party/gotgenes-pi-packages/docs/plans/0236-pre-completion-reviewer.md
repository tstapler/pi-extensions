---
issue: 236
issue_title: "Add pre-completion reviewer subagent"
---

# Add pre-completion reviewer subagent

## Problem Statement

After `/tdd-plan` or `/build-plan` finishes implementation, there is no structured verification step before handing off to `/ship-issue`.
The templates run inline deterministic checks (typecheck, lint, tests, dead-code), but there is no fresh-context review that validates completeness against the issue's requirements, checks documentation staleness, or applies judgment-based quality gates.
A fresh-context reviewer — running as a separate subagent with no prior bias from the implementation work — can catch gaps that the implementing agent overlooks.

## Goals

- Create a custom agent definition at `.pi/agents/pre-completion-reviewer.md` that runs on Claude Sonnet 4.6 in read-only mode.
- Create a shared skill at `.pi/skills/pre-completion/SKILL.md` that encodes the dispatch protocol for both `/tdd-plan` and `/build-plan`.
- Update `/tdd-plan` and `/build-plan` templates to load the `pre-completion` skill and unconditionally dispatch the reviewer after final checks pass, before writing stage notes and recommending `/ship-issue`.
- The reviewer runs deterministic checks first, then judgment-based sections, producing a structured PASS/FAIL/WARN report.
- If the reviewer reports FAIL, the implementation agent reports findings to the user and lets them decide how to proceed.

## Non-Goals

- Automating fix-and-re-dispatch loops — the implementation agent reports FAIL findings to the user.
- Adding a `dod_preflight` tool — the reviewer runs deterministic checks directly via bash commands.
- Standardizing issue acceptance criteria format — a companion issue could add an `issue-conventions` skill later.
- Changing `/ship-issue` — it remains as-is; the reviewer gates the handoff, not the shipping flow.
- Porting repone-specific sections (OTel, polish gaps, mobile viewport, AWS SSO, E2E tests, lifecycle completeness) — these are app-specific and do not apply to this library monorepo.
- Adding new tools or TypeScript code — all deliverables are markdown files.

## Background

### Repone reference

The design is adapted from repone's `.opencode/agents/pre-completion-reviewer.md` and `.agents/skills/pre-completion/SKILL.md`.
Repone uses an OpenCode subagent with a `dod_preflight` tool for deterministic checks and a judgment checklist with 10 sections.
This implementation targets Pi's agent and skill system with a simplified checklist appropriate for a library monorepo.

### Pi custom agents

Custom agents are defined as markdown files in `.pi/agents/<name>.md`.
Frontmatter supports `description`, `tools`, `model`, and other agent configuration.
The `Agent` tool dispatches them via `subagent_type: "<name>"`.
Examples exist at `packages/pi-subagents/.pi/agents/auditor.md` and the SDK examples at `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/`.

### Pi skills

Skills are markdown files at `.pi/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`).
They are loaded on demand by agents and prompt templates.
The `AGENTS.md` available-skills list auto-discovers skills from `.pi/skills/` and extension skill directories.

### Current template flow

Both `/tdd-plan` and `/build-plan` end with:

1. Final checks (vitest, typecheck, lint, fallow dead-code).
2. Summarize (git log, behavioral change, deviations).
3. Write stage notes (retro file).
4. Stop — "The next step is `/ship-issue`."

The reviewer inserts between steps 1 and 2.

### Existing deterministic checks in templates

The templates already run `pnpm run check`, `pnpm run lint`, `pnpm vitest run`, and `pnpm fallow dead-code` as part of their "After the last step" section.
The reviewer re-runs these from a fresh context as a safety net — the implementing agent may have missed a failure or the checks may have passed in the implementation context but fail in a clean evaluation.

## Design Overview

### Three deliverables

1. **Agent definition** (`.pi/agents/pre-completion-reviewer.md`) — the subagent's system prompt with deterministic checks, judgment sections, and output format.
2. **Skill** (`.pi/skills/pre-completion/SKILL.md`) — the dispatch protocol that `/tdd-plan` and `/build-plan` follow to invoke and handle the reviewer's report.
3. **Template updates** (`.pi/prompts/tdd-plan.md` and `.pi/prompts/build-plan.md`) — load the `pre-completion` skill and insert the dispatch step.

### Agent definition design

The reviewer agent is read-only: `tools: read, grep, find, ls, bash` with bash restricted to read-only commands.
Model: `claude-sonnet-4-6-20260526`.

The agent receives: issue number, list of modified files, and the plan file path (if one exists).

#### Step 1: Deterministic checks

Run these commands and require all to pass before proceeding to judgment:

1. `pnpm run check` — typecheck.
2. `pnpm run lint` — linter.
3. `pnpm vitest run` — full test suite.
4. `pnpm fallow dead-code` — unused code gate.

If any fails, report FAIL immediately without running judgment sections.

#### Step 2: Judgment sections

Each section has an applicability gate.
Sections that do not apply are reported as SKIP with a reason.

| Section                 | Applicability                                | Checks                                                                                                |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Acceptance criteria     | Issue has ACs                                | Verify each AC against code, tests, and commits; classify as `code-verified` or `visual-check-needed` |
| Conventional commits    | Always                                       | All commits since branch point follow `type(scope): description`                                      |
| Developer documentation | Always                                       | `AGENTS.md`, skills, READMEs, architecture docs not stale relative to changes                         |
| Code design review      | `src/` files changed                         | Load `code-design` skill; review SOLID, naming, file organization                                     |
| Test artifacts          | Plan has test strategy                       | Test files match plan commitments                                                                     |
| Mermaid diagrams        | `docs/` markdown with mermaid blocks changed | Validate via `mmdc` CLI; check for known renderer pitfalls                                            |
| Dead code               | Always                                       | `pnpm fallow dead-code` exits zero (already checked in Step 1 but reported here for completeness)     |

#### Severity model

- **FAIL (blocking):** Acceptance criteria not met, conventional commit violations, deterministic check failures.
- **WARN (non-blocking):** Mermaid renderer pitfalls, documentation staleness, code design suggestions, dead-code warnings.
- **PASS:** Section verified with no issues.
- **SKIP:** Section not applicable with stated reason.

### Skill design

The `pre-completion` skill is a protocol reference loaded by the implementation agent.
It instructs the agent to:

1. Dispatch the `pre-completion-reviewer` agent via the `Agent` tool with `subagent_type: "pre-completion-reviewer"`.
2. Pass the issue number, modified files list (from `git diff --name-only $(git describe --tags --abbrev=0)..HEAD`), and plan file path.
3. Wait for the report.
4. If PASS: proceed to summarize, write stage notes, and recommend `/ship-issue`.
5. If FAIL: report the findings to the user and stop — let the user decide whether to fix and re-dispatch or proceed.
6. If WARN-only: proceed but include the warnings in the stage notes.

### Template integration

Both templates gain:

1. A new skill load instruction: "Load the `pre-completion` skill for the dispatch protocol."
2. A new section `## Pre-completion review` inserted between "After the last step" and "Summarize".
3. The "Summarize" and "Write stage notes" sections gain a line noting the reviewer's verdict.

### Consumer call-site sketch

```text
# In tdd-plan.md / build-plan.md, after final checks:

## Pre-completion review

Load the `pre-completion` skill and follow the dispatch protocol.
```

The skill handles all dispatch details — the template stays lean.

## Module-Level Changes

| File                                    | Change                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.pi/agents/pre-completion-reviewer.md` | New: agent definition with deterministic checks, judgment checklist, output format                                                                                         |
| `.pi/skills/pre-completion/SKILL.md`    | New: dispatch protocol skill with dispatch instructions, report handling, re-dispatch guidance                                                                             |
| `.pi/prompts/tdd-plan.md`               | Add `pre-completion` skill to Load skills section; add `## Pre-completion review` section between final checks and Summarize; update Summarize to include reviewer verdict |
| `.pi/prompts/build-plan.md`             | Same changes as `tdd-plan.md` adapted for build context                                                                                                                    |
| `AGENTS.md`                             | Add `pre-completion-reviewer` to available-skills list description (auto-discovered but should be documented)                                                              |

## Test Impact Analysis

No code changes — all deliverables are markdown files.
No new tests are needed.
Verification is manual: dispatch the reviewer on a real issue and confirm the report format and section applicability gates work correctly.

## TDD Order

No TDD cycles — this is a docs/config-only change.
Use `/build-plan` to execute.

### Execution steps

1. Create `.pi/agents/pre-completion-reviewer.md` with the agent definition.
   Commit: `feat: add pre-completion reviewer agent definition`

2. Create `.pi/skills/pre-completion/SKILL.md` with the dispatch protocol.
   Commit: `feat: add pre-completion dispatch skill`

3. Update `.pi/prompts/tdd-plan.md` to load the `pre-completion` skill and add the dispatch section.
   Commit: `feat: integrate pre-completion reviewer into tdd-plan template`

4. Update `.pi/prompts/build-plan.md` with the same integration.
   Commit: `feat: integrate pre-completion reviewer into build-plan template`

5. Update `AGENTS.md` available-skills list to document the new skill and agent.
   Commit: `docs: document pre-completion reviewer in AGENTS.md`

## Risks and Mitigations

| Risk                                                                                                      | Mitigation                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer subagent may time out on large changesets with many files to review                              | Keep the judgment sections focused on the diff, not the entire codebase; the agent can use `git diff --name-only` to scope its work              |
| Fresh-context reviewer lacks implementation context needed to understand why certain choices were made    | The reviewer receives the plan file path, which documents design decisions; it should read the plan before judging                               |
| Deterministic checks in the reviewer duplicate the template's own final checks                            | This is intentional — fresh-context re-verification catches cases where the implementation agent's context was stale or checks passed spuriously |
| `mmdc` may not be installed in all environments                                                           | Gate the Mermaid check on `which mmdc` succeeding; skip with WARN if not available                                                               |
| The reviewer's FAIL report may be too verbose for the user to act on                                      | The output format uses a structured per-section layout with one-line summaries and details only for failures                                     |
| Adding a mandatory subagent step increases the wall-clock time of every `/tdd-plan` and `/build-plan` run | The reviewer is lightweight (read-only, focused checklist); the quality gate is worth the time cost                                              |

## Open Questions

1. Should the `pre-completion` skill instruct the agent to push commits before dispatching the reviewer?
   Repone does this (Step 2 in their skill), but the current `/tdd-plan` and `/build-plan` templates do not push — that happens in `/ship-issue`.
   Decision: defer pushing to `/ship-issue` as today; the reviewer works on local state.
2. Should the reviewer's report be included verbatim in the retro file's stage notes, or just the verdict (PASS/FAIL/WARN)?
   Decision: include the verdict and any FAIL/WARN details in the stage notes; omit the full PASS report to keep retro files concise.
