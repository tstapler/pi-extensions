---
issue: 261
issue_title: "Emit child-execution lifecycle events; retire permission-bridge"
---

# Retro: #261 — Emit child-execution lifecycle events; retire permission-bridge

## Stage: Planning (2026-05-28T00:00:00Z)

### Session summary

Produced the cross-package plan (`docs/plans/0261-child-lifecycle-events-retire-permission-bridge.md`) for Phase 16, Step 1 of [ADR-0002]: the core publishes a `subagents:child:*` lifecycle and `@gotgenes/pi-permission-system` subscribes to `session-created` / `disposed`, retiring `permission-bridge.ts`.
Resolved the issue's "blocking investigation" by reading the SDK event bus implementation, and recorded two deferral decisions in GitHub.

### Observations

- **Blocking investigation resolved without a new SDK hook.**
  `pi.events` is a Node `EventEmitter`; `emit()` dispatches listeners synchronously on the same call stack.
  The `on` wrapper makes handlers `async`, but a *synchronous* handler body completes before `emit()` returns (the `await` only suspends after the body already ran).
  So registering in a synchronous `session-created` handler, emitted immediately before `await session.bindExtensions({})`, guarantees the registry entry exists pre-bind — identical timing to today's `registerChildSession()`.
  Encoded as a tested invariant against the real `createEventBus()`.

- **Decision: emit the full four-event lifecycle** (`spawning`, `session-created`, `completed`, `disposed`), per [ADR-0002], even though only `session-created` / `disposed` have a consumer.
  Rationale: observational events are unlimited and never modify the core; the "no vacant hooks" rule constrains *provider seams*, not events.

- **Decision: defer removing the inbound `registerSubagentSession` / `unregisterSubagentSession`** from `PermissionsService` to a broader "finish the inversion" follow-up.
  Filed as **#267** (`pkg:pi-permission-system`, depends on #261).
  They are retained, caller-less, this issue.

- **Decision: keep this issue run-only**; resume executions stay detected by the permission system's filesystem-path heuristic.
  Making resume registry-detected needs the registry to shift from "executing now" to "exists" (register at creation, unregister at disposal), which is entangled with dissolving the runner.
  Added an acceptance criterion + "Registry semantics" section to **#265** capturing this so it is not lost.

- **Channel namespacing.**
  New events use `subagents:child:*` to avoid collision with the existing record-level `subagents:completed` (and siblings), which describe `AgentManager`/`SubagentRecord` background-agent transitions — a different abstraction level than per-`runAgent` child-session events.

- **Cross-package contract risk.**
  The two packages declare channel strings independently (no shared import, since neither may depend on the other under jiti).
  The channel-name string is the only coupling point; mitigated by literal-string assertions in both packages' tests and cross-referencing comments.

- **Test-migration churn flagged.**
  Adding `lifecycle` to `RunnerDeps` forces updating 18 inline `{ io, exec, registry }` call sites.
  Isolated into a standalone `test:` commit (introduce `createRunnerDeps` factory) before the interface change, to keep the `feat` commit reviewable and pay down churn for #264/#265.

## Stage: Implementation — TDD (2026-05-28T17:10:00Z)

### Session summary

Executed all 5 planned TDD cycles plus a green-baseline cleanup: added the `child-lifecycle` publisher, centralized runner-deps construction, emitted the four `subagents:child:*` events from `runAgent` while deleting `permission-bridge.ts`, and subscribed in `@gotgenes/pi-permission-system` via `subscribeSubagentLifecycle`.
Test counts: pi-subagents 1047 → 1049 (+6 `child-lifecycle`, −5 `permission-bridge`, +1 net in the runner block); pi-permission-system 1497 → 1504 (+7 `subagent-lifecycle-events`).
Full suite (3065 tests), `check`, `lint`, and `fallow dead-code` all green.

### Observations

- **Pre-existing baseline failure.**
  `pnpm run lint` failed at the start on 4 unused MD053 link references (`#256`–`#259`) in `pi-subagents` `architecture.md`, unrelated to this change.
  Fixed as a separate `docs:` cleanup commit before starting TDD cycles.
- **`createRunnerDeps` already existed.**
  The plan assumed 18 inline `{ io, exec, registry }` sites; in practice `concrete-agent-runner.test.ts` already used the factory, so only `agent-runner.test.ts` (14) and `agent-runner-extension-tools.test.ts` (4) needed migration.
  Extended the factory with `io` / `exec` / `lifecycle` overrides; typed the `io` override as the unannotated `createRunnerIO()` shape so `deps.io.<mock>` methods survive.
- **Synchronous-dispatch invariant encoded.**
  The real-bus test (`subagent-lifecycle-events.test.ts`, "populates the registry synchronously — before emit() returns") asserts the registry is updated the instant `emit()` returns, guarding the pre-`bindExtensions` ordering against a future `await` creeping into the handler.
- **ESLint pre-commit auto-fix.**
  The Step 4 commit was rewritten by the eslint hook to convert relative test imports to the `#src/` alias; re-staged and committed.
- **No deviations from the plan's design.**
  All Module-Level Changes landed as specified; architecture and integration docs updated in Step 5.
- **Pre-completion reviewer: WARN.**
  One non-blocking finding — the `package-pi-permission-system` skill's "Upcoming: event-based subagent integration" section was stale (the integration is now delivered).
  Addressed in a follow-up `docs:` commit (`6893301a`) updating it to the delivered state plus the synchronous-handler constraint and the #267 deferral note.
  All deterministic checks (`check`, `lint`, `test`, `fallow`), acceptance criteria, conventional commits, code design, test artifacts, and Mermaid diagrams passed.

## Stage: Final Retrospective (2026-05-28T18:30:00Z)

### Session summary

Shipped Phase 16, Step 1 of [ADR-0002] across three stages (plan, TDD, ship) with no rework and no failed CI: the core publishes a `subagents:child:*` lifecycle, `@gotgenes/pi-permission-system` subscribes, and `permission-bridge.ts` is gone.
Released `@gotgenes/pi-subagents` v11.4.0 and `@gotgenes/pi-permission-system` v7.4.0; closed #261; opened #267 and amended #265 for deferred work.
The session was notably clean — friction was low-impact and self-corrected.

### Observations

#### What went well

1. **Read the SDK source to resolve a "blocking investigation" instead of speculating.**
   The issue flagged an unknown — can `pi.events` emit an awaited, ordered event pre-`bindExtensions`?
   Reading `@earendil-works/pi-coding-agent/dist/core/event-bus.js` showed it is a Node `EventEmitter` (synchronous dispatch), which settled the design (no new SDK hook needed) and turned the unknown into a tested invariant.
2. **Multi-round `ask_user` dialogue converged on a better answer.**
   The resume-detection question took two rounds because the user asked "tell me more about why we'd re-register" rather than picking an option.
   That redirect surfaced the real distinction (registry "executing now" vs. "exists") and produced a cleaner outcome: defer to #265 with an added acceptance criterion, rather than over-scoping #261.
3. **Incremental verification throughout TDD.**
   `pnpm vitest run <file>` after each red/green, `pnpm run check` immediately after the shared-`RunnerDeps` interface change (step 3), and the full `check` + `lint` + `test` + `fallow` gate at the end — no end-loaded verification gap.
4. **Real-bus invariant test.**
   Testing `subscribeSubagentLifecycle` against the real `createEventBus()` (not just a fake) encodes the synchronous-dispatch ordering guarantee, so a future `await` creeping into the handler fails loudly.

#### What caused friction (agent side)

1. `missing-context` — the plan said step 2 would "add a `createRunnerDeps` factory," but the factory already existed (and `concrete-agent-runner.test.ts` already used it); the work was an *extension*, and only 2 of the assumed 3 test files needed migration.
   Impact: cosmetic plan inaccuracy, no rework — the step's intent held.
2. `missing-context` — the new pi-permission-system test imported package modules via relative paths (`../src/...`) instead of the `#src/` / `#test/` path aliases the project enforces; the eslint pre-commit hook rewrote them.
   Impact: one failed-commit-then-recommit cycle (~30 s), self-identified via the hook, no rework.

#### What caused friction (user side)

1. None material.
   The user's mid-planning clarifying question ("tell me more about why") was a strength, not friction — it redirected before a decision was locked in.
   Opportunity (framing, not criticism): the agent could have led the first resume `ask_user` with the mechanism explanation (registry semantics) before presenting options, collapsing two rounds into one.

### Diagnostic details

- **Model-performance correlation** — the one subagent dispatch (`pre-completion-reviewer`) ran on `claude-sonnet-4-6-20260526`; appropriate for read-only deterministic-check + judgment review (373 s, 19 tool calls).
  No mismatch.
- **Escalation-delay / unused-tool / feedback-loop lenses** — nothing notable: no `rabbit-hole` sequences, no repeated-error streaks, and verification was incremental (see win 3).

### Changes made

1. `.pi/skills/code-design/SKILL.md` — added a one-line rule under TypeScript conventions: import sibling modules via the `#src/` / `#test/` path aliases, not relative paths (eslint enforces and rewrites).
   Addresses agent-side friction 2.

[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md
