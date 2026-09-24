---
issue: 298
issue_title: "Concurrent subagent siblings collide on one registry key — a finishing sibling unregisters the shared entry and blocks the others' ask forwarding"
---

# Retro: #298 — Concurrent subagent siblings collide on one registry key

## Stage: Planning (2026-06-01T15:58:57Z)

### Session summary

Produced a cross-package implementation plan (`docs/plans/0298-key-subagent-registry-by-session-id.md`) to re-key `SubagentSessionRegistry` on the child session id instead of the session directory, fixing the sibling-collision bug where one finishing child's `disposed` evicts the shared entry for all siblings.
The plan spans `@gotgenes/pi-subagents` (producer event payloads) and `@gotgenes/pi-permission-system` (consumer registry + detection + forwarding) plus docs.

### Observations

- Confirmed `#296` (process-global registry storage via `globalThis`) is already landed and closed — the collision is **live now**, not latent, so the fix is `fix:`-typed and forwarding is currently active.
- Two `ask_user` decisions resolved the only ambiguities: (1) **replace** `sessionDir` with `sessionId` on the `session-created`/`disposed` payloads rather than adding alongside (avoids a vestigial field), and (2) **remove** the never-read `agentName` from `SubagentSessionInfo` and the `session-created` payload as part of this fix.
- Key structural insight: the two packages are **type-decoupled** (event contract is a runtime channel name + independently-declared duck-typed payloads, no cross-import under jiti) but **runtime-coupled** — so producer/consumer changes can land in separate commits with green tests, but must ship together to avoid a forwarding-break window.
  This shaped the TDD ordering (consumer steps 1–2, producer step 3, docs step 4).
- The pi-subagents payload change is a **breaking** event-contract change (`fix!` + `BREAKING CHANGE:` footer) since `session-created`/`disposed` are public lifecycle events; `spawning`/`completed` are deliberately left untouched (`completed` still legitimately carries `sessionDir`/`agentName`).
- Rejected alternatives (per the issue, reaffirmed in the plan): refcounting the shared directory key (masks the dir-as-identity conflation) and giving each child a unique directory (alters on-disk layout and resume).
- Verified `sessionManager.getSessionId()` exists on both producer (`types.ts`) and consumer (`polling.ts` already uses `ctx.sessionManager.getSessionId()`), so no new SDK surface is required — only adding `getSessionId` to the producer's `SessionManagerLike` IO interface and the test `createSessionManager` mock.
- Flagged a risk to verify during implementation: whether `SubagentSessionInfo` is on the package's public type surface (would make the `agentName` removal externally breaking).

## Stage: Implementation — TDD (2026-06-01T16:18:03Z)

### Session summary

Completed all 4 TDD cycles: 2 consumer-side `pi-permission-system` commits (registry + lifecycle subscriber re-keyed by session id, then detection + forwarding resolution re-keyed), 1 producer-side `pi-subagents` breaking commit (event payload shape change), and 1 docs commit.
Test count increased by 2 (two new sibling-collision regression tests in `subagent-lifecycle-events.test.ts` and `subagent-registry.test.ts`).
Pre-completion reviewer returned **PASS**.

### Observations

- Risk resolved: `SubagentSessionInfo` is not re-exported from `packages/pi-permission-system/src/index.ts` — the `agentName` removal is not externally breaking for that package.
- Steps 1 and 2 stayed cleanly independent: the registry-key change (step 1) and the detection/forwarding lookup change (step 2) touched different source files and committed separately with green tests at each step.
- The `polling.ts` change was smaller than planned: removing the `sessionDir` local variable also eliminated the `ctx.sessionManager.getSessionDir()` call in `waitForForwardedPermissionApproval` entirely — `requesterSessionId` was already computed and served as the `sessionId` argument.
- `isSubagentExecutionContext` required a `try/catch` around `getSessionId()` because the SDK's `ExtensionContext` interface does not expose `getSessionId` as a typed member.
  The same defensive pattern was already present in the `getSessionId(ctx)` helper in `polling.ts`.
- `SubagentSessionMeta` keeps both `sessionId` and `sessionDir`/`agentName` — `completed` still legitimately needs the latter two as transcript location and UI/telemetry identity.
  This is the intentional dual-field design from the plan.
- The `createSessionManager` mock in `subagent-session-io.ts` was extended with `getSessionId: vi.fn().mockReturnValue("child-session-id")`; this propagated to all factory-using tests without per-test overrides.

## Stage: Final Retrospective (2026-06-01T16:32:11Z)

### Session summary

A single continuous session carried issue #298 through all four stages — plan, TDD, ship, retro — producing 5 implementation commits across two packages and two releases (`pi-permission-system` v8.3.2, `pi-subagents` v14.0.0).
The run had zero plan deviations, zero rework, and a first-dispatch `PASS` from the pre-completion reviewer.
Friction was limited to three single-retry tool slips, none of which caused a re-plan or a follow-up commit.

### Observations

#### What went well

- The planning-stage structural insight — that the two packages are **type-decoupled** (event contract is a runtime channel name plus independently-declared duck-typed payloads, no shared TS types) but **runtime-coupled** — correctly predicted that TDD steps 1, 2, and 3 could each land as a separate commit with a green suite at every step.
  Implementation matched the prediction exactly: each step's per-package suite was green before commit, and `pnpm run check` never broke across package boundaries.
  This is the novel win — the cross-package contract analysis done in planning paid off directly in the commit structure with no surprises.
- The two `ask_user` decisions in planning (replace-vs-add `sessionDir`/`sessionId`; remove vestigial `agentName`) front-loaded the only two real ambiguities, so the plan and all four TDD cycles flowed from them with no mid-implementation second-guessing.
- Verification was incremental, not end-loaded: per-file `vitest` after every red and green, full per-package suite after each step, and full `check`/`lint`/`test`/`fallow dead-code` at the end.

#### What caused friction (agent side)

- `instruction-violation` (self-unidentified) — the planning stage repeatedly used `cd packages/<pkg> && grep ...` despite `AGENTS.md` saying to run package-scoped commands from the root.
  One such command (message 19) chained `cd packages/pi-permission-system && ... ls ../../docs/retro/`, whose `../../` escaped the repo and tripped the external-directory permission gate.
  Impact: one denied command, re-run within repo-relative paths at message 20; no rework.
  The TDD and ship stages did not repeat the pattern (they used repo-root-relative paths and `pnpm --filter`), so this was planning-stage-local.
- `missing-context` — the `colgrep` skill load (requested by the plan-issue prompt "before code exploration") failed at message 4 because the agent guessed `.pi/skills/colgrep/SKILL.md` instead of the path given in the system prompt's skill list (`packages/pi-colgrep/skills/colgrep/SKILL.md`), then proceeded without retrying.
  Impact: none — exact symbol names (`sessionDir`, `getSessionId`, `SubagentSessionInfo`) made `grep` sufficient, but the requested skill was silently never loaded.
- `other` (tool slip) — the first attempt to append TDD stage notes (message 95) failed an `Edit` `oldText` match; recovered with one re-read + re-edit (messages 96–97).
  Impact: one wasted tool call.

#### What caused friction (user side)

- None.
  User involvement was limited to two `Continue.` nudges during TDD (messages 41, 45) — mechanical continuation, not strategic redirection — which is the expected shape for a clean plan-driven run.

### Diagnostic details

- **Model-performance correlation** — stage models: planning `anthropic/claude-opus-4-8` (judgment-heavy design + `ask_user` framing), TDD `anthropic/claude-sonnet-4-6` (mechanical red-green-commit), ship `opencode-go/deepseek-v4-flash`, retro `anthropic/claude-opus-4-8`.
  The ship stage ran a flash-class model on work with real merge-authority judgment gates (read the full collapsed release-please PR body to detect unrelated sibling bumps; confirm the major-version bump is correctly derived from the `BREAKING CHANGE:` footer; stop if multiple release PRs exist).
  It executed correctly here (read `gh pr view 300 --json body` to 200 lines, validated both bumps, merged cleanly), so no rework resulted — but the assignment is a latent mismatch worth noting.
  `.pi/prompts/ship-issue.md` has no `model:` frontmatter directive, so the ship model is whatever the session is set to, not a pinned choice.
- **Escalation-delay tracking** — no `rabbit-hole` friction; the three slips each resolved within one retry (no sequence exceeded 1 repeated attempt on the same error).
- **Unused-tool detection** — `colgrep` was available and explicitly requested by the prompt but never loaded (wrong-path guess, not retried); for this exact-symbol search `grep` was adequate, so no investigation suffered.
- **Feedback-loop gap analysis** — no gap.
  Verification ran after every change, not only at the end; the per-step green-suite discipline is exemplary and directly enabled the clean per-commit structure.

### Changes made

1. Added this `Final Retrospective` stage entry to `docs/retro/0298-key-subagent-registry-by-session-id.md`.
   No `AGENTS.md` or `.pi/prompts/` edits — the two agent-side slips (`cd packages/<pkg> &&` and the `colgrep` path guess) are existing-rule slips, not missing rules.
2. Ship-stage model observation left as documentation only.
   User decision: no change — because work proceeds one issue at a time, an unreleased sibling bump riding along in a later release PR is acceptable, so the soft sibling-bump gate carries low real risk even under a flash-class ship model.
