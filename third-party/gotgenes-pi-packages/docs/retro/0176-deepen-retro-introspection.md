---
issue: 176
issue_title: "Deepen retrospective introspection with model attribution and diagnostic lenses"
---

# Retro: #176 — Deepen retrospective introspection with model attribution and diagnostic lenses

## Stage: Planning (2026-05-25T20:00:00Z)

### Session summary

Produced a 12-step TDD plan spanning pi-subagents (model attribution in `getAgentConversation` and `formatAssistantMessage`), pi-session-tools (two new introspection tools: `read_session` and `read_parent_session`), and the `/retro` prompt (diagnostic lenses).
Confirmed with the user that all four acceptance criteria should be included and that attribution should apply to both the text export and the UI conversation viewer.

### Observations

- The `AssistantMessage` type from `@earendil-works/pi-ai` already carries `provider` and `model` — the attribution change is a pure formatting addition with no SDK gaps to work around.
- `getAgentConversation()` has no existing tests (noted in retro #172), so the TDD plan starts by adding them — a prerequisite win.
- The `formatAssistantMessage()` signature change is backward-compatible (optional parameter), so existing tests and callers continue to work without modification.
- Parent session discovery relies on the `tasks/` directory convention from `deriveSubagentSessionDir()`.
  This is a convention-based approach — not an explicit API — so the plan includes validation and informative error messaging.
- `loadEntriesFromFile()` is exported from `@earendil-works/pi-coding-agent` despite being documented as "exported for testing" — worth monitoring for SDK stability.
- pi-session-tools currently has no tests at all; the new tools will establish the test infrastructure for this package.

## Stage: Implementation — TDD (2026-05-25T22:15:00Z)

### Session summary

Completed all 12 TDD steps across both packages and prompt/docs.
Added 26 new tests (11 for `getAgentConversation`, 5 for `formatAssistantMessage` attribution, 5 for `read_session`, 5 for `read_parent_session`) bringing pi-subagents from 913 to 929 tests and establishing pi-session-tools' first test suite with 15 tests.
All four acceptance criteria are implemented.

### Observations

- The plan's step ordering worked well — pi-subagents attribution (steps 1–4) was self-contained, then pi-session-tools (steps 5–10) was independent.
- pi-session-tools had no test infrastructure at all — needed to add `vitest` to `devDependencies`, create `vitest.config.ts`, add `#src`/`#test` path aliases to `tsconfig.json`, and add test scripts to `package.json`.
  The tsconfig path aliases were missing from the initial setup and caught by `pnpm run check` after all TDD steps completed.
- Chose to parse JSONL directly in `readParentSessionEntries()` rather than importing `loadEntriesFromFile()` from the SDK.
  This avoids the dependency on a function documented as "exported for testing" and keeps the parsing trivial (one `JSON.parse` per line).
- The `formatMessage()` dispatcher already received the full message object as `{ role: string; [key: string]: unknown }`, so extracting `provider`/`model` required only safe `as string | undefined` casts — no signature changes to the dispatcher.
- No deviations from the plan.
  All files listed in Module-Level Changes were touched as described.

## Stage: Final Retrospective (2026-05-25T22:30:00Z)

### Session summary

Completed the full lifecycle for issue #176 across three sessions (planning, TDD, ship+retro).
All four acceptance criteria shipped as pi-session-tools v0.4.0 and pi-subagents v7.4.0.
Two retro-driven process improvements landed.

### Observations

#### What went well

- The 12-step TDD plan required zero deviations during implementation — every file listed in Module-Level Changes was touched exactly as described.
- Cross-package split (pi-subagents attribution first, then pi-session-tools introspection) was effective — no ordering dependencies between packages.
- Choosing to parse JSONL directly in `readParentSessionEntries()` rather than importing `loadEntriesFromFile()` from the SDK avoided a fragile dependency on a function documented as "exported for testing."

#### What caused friction (agent side)

1. `missing-context` — Adding `vitest` to `packages/pi-session-tools/package.json` ran `pnpm install` locally (updating `pnpm-lock.yaml` in the working tree) but the lockfile change was never staged or committed during the TDD phase.
   CI caught it with `--frozen-lockfile` during shipping, requiring commit `ff1c159` and a second push-and-wait cycle.
   Impact: one wasted CI cycle (~3 minutes).
2. `missing-context` — The `tsconfig.json` for pi-session-tools needed `#src/*` / `#test/*` path aliases for `pnpm run check` to pass, but this was only discovered at the final verification phase (after all 12 TDD steps), not immediately after step 5 (test infrastructure setup).
   Impact: required a separate fix commit `8655a58`; no rework but added friction.

#### What caused friction (user side)

- No user-side friction observed.
  The user's involvement was limited to scoping decisions in planning (`ask_user` for scope and attribution format) and mechanical approval during retro.

### Diagnostic details

- **Model-performance correlation** — Session started on `claude-opus-4-6`, briefly switched to `claude-sonnet-4-6` and `deepseek-v4-flash` during the planning phase, then returned to `claude-opus-4-6` for TDD implementation.
  No subagents were dispatched.
  The model was appropriate for the work — cross-package implementation with design judgment.
- **Feedback-loop gap analysis** — `pnpm run check` was run per-package only after all 12 TDD steps completed, not after step 5 (test infrastructure setup for pi-session-tools).
  Running it earlier would have caught the tsconfig path alias gap immediately.

### Changes made

1. `.pi/prompts/tdd-plan.md` — Added lockfile check step (step 5) to "After the last TDD step" section.
2. `.pi/skills/testing/SKILL.md` — Added rule: run `pnpm run check` immediately after adding test infrastructure to a previously-untested package.
