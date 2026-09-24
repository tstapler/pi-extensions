---
issue: 101
issue_title: "Native permission-system awareness for in-process subagents"
---

# Permission-system awareness for in-process subagents

## Problem Statement

pi-subagents and pi-permission-system communicate today through a single indirect mechanism: Patch 3 injects `<active_agent name="..."/>` into child system prompts, and pi-permission-system parses that tag to resolve per-agent policies.
But pi-subagents never explicitly signals "this is a child session" — the permission system in the child relies on filesystem heuristics or environment variables designed for process-based subagent extensions.
In-process children don't set those env vars, so detection works only when the session directory happens to nest under the subagent sessions root.

pi-permission-system already has a `SubagentSessionRegistry` (plan 0221) with `registerSubagentSession`/`unregisterSubagentSession` methods on its `PermissionsService`.
The integration hook exists but no in-process subagent extension calls it yet.

## Goals

- pi-subagents registers every child session with pi-permission-system's `SubagentSessionRegistry` before `bindExtensions()` fires, and unregisters after the session completes.
- In-process child sessions are detected deterministically via the registry — no filesystem or env-var heuristics required.
- `ask`-state permissions in child sessions forward to the parent session's UI through the existing permission-forwarding mechanism.
- The integration is optional — pi-subagents remains fully functional when pi-permission-system is not installed.

## Non-Goals

- **Pre-filtering tools in pi-subagents** — pi-permission-system's `before_agent_start` handler already filters tools in the child session; pi-subagents delegates to it.
- **New config surfaces** — no new agent-config fields or permission policies; the existing per-agent frontmatter overrides are sufficient.
- **Process-based subagent support** — those extensions use env vars and are already handled by pi-permission-system.
- **Replacing Patch 3** — the `<active_agent>` tag remains the agent-name signaling mechanism; the registry provides child-session detection and forwarding target resolution, not name resolution.

## Background

### Prerequisites (all implemented)

- Issue #98 — `AgentRecord` state machine extraction (closed).
- Issue #99 — `ParentSnapshot` replaces live `ctx` capture (closed).
- Issue #100 — Session-event subscription replaces callback threading (closed).
- Plan 0221 — `SubagentSessionRegistry` in pi-permission-system (implemented).

### Existing integration points

1. **`PermissionsService` (Symbol.for accessor)** — pi-permission-system publishes a service object to `globalThis` via `Symbol.for("@gotgenes/pi-permission-system:service")`.
   Any extension can call `getPermissionsService()` without an import dependency.
2. **`SubagentSessionRegistry`** — `PermissionsService.registerSubagentSession(sessionKey, info)` and `unregisterSubagentSession(sessionKey)`.
   The `sessionKey` is the session directory path (unique per session, available to both producer and consumer).
3. **`isSubagentExecutionContext()`** — checks the registry first, then env vars, then filesystem path.
   Once registered, in-process children are detected on the first check.
4. **`resolvePermissionForwardingTargetSessionId()`** — for registered sessions, reads `parentSessionId` from the registry entry to find the forwarding target.
5. **`before_agent_start` handler** — filters tools based on per-agent permission policies.
   Uses `getActiveAgentNameFromSystemPrompt()` to resolve the agent name from the `<active_agent>` tag.
6. **Patch 3 (active_agent tag)** — pi-subagents injects `<active_agent name="${config.name}"/>` into every child system prompt via `buildAgentPrompt()`.

### How the flow will work after this change

1. pi-subagents creates a child session and derives `sessionDir`.
2. pi-subagents calls `getPermissionsService()?.registerSubagentSession(sessionDir, { agentName, parentSessionId })`.
3. pi-subagents calls `session.bindExtensions({})`.
4. pi-permission-system initializes in the child session.
5. `isSubagentExecutionContext()` checks the registry → finds the session → returns `true`.
6. `before_agent_start` handler fires → resolves agent name from system prompt → applies per-agent policies → filters denied tools.
7. If an `ask`-state permission triggers during the run, `resolvePermissionForwardingTargetSessionId()` uses the registry to find the parent session → forwards the prompt to the parent UI.
8. After the run completes (or errors), pi-subagents calls `unregisterSubagentSession(sessionDir)`.

## Design Overview

### Cross-extension access pattern

pi-subagents accesses `PermissionsService` without an import dependency, using the established `Symbol.for()` accessor pattern:

```typescript
const PERMISSION_SERVICE_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:service",
);

interface PermissionsServiceConsumer {
  registerSubagentSession(
    sessionKey: string,
    info: { parentSessionId?: string; agentName: string },
  ): void;
  unregisterSubagentSession(sessionKey: string): void;
}
```

The `PermissionsServiceConsumer` interface follows ISP — it declares only the two methods pi-subagents needs, not the full `PermissionsService` surface.

### Registration lifecycle

Registration and unregistration bracket the child session's lifecycle in `runAgent()`:

```typescript
// After deriving sessionDir, before bindExtensions()
registerChildSession(sessionDir, {
  agentName: type,
  parentSessionId: options.context.parentSession?.parentSessionId,
});

try {
  await session.bindExtensions({});
  // ... tool filtering, onSessionCreated, prompt ...
  await session.prompt(effectivePrompt);
} finally {
  // ... existing cleanup ...
  unregisterChildSession(sessionDir);
}
```

Key ordering constraints:

- **Register before `bindExtensions()`** — pi-permission-system initializes during `bindExtensions()` and calls `isSubagentExecutionContext()`.
  The session must be in the registry before that check fires.
- **Unregister in `finally`** — ensures cleanup on both success and error paths.
  An orphaned registry entry is harmless (the map is process-scoped and the key is unique) but keeping it clean avoids confusion.

### Graceful degradation

When pi-permission-system is not installed, `getPermissionsService()` returns `undefined` and `registerChildSession`/`unregisterChildSession` are no-ops.
No try/catch needed — the `?.` operator handles the absent service.

### `ask`-state forwarding

No new code is needed for `ask`-state forwarding.
The existing `permission-forwarding` mechanism in pi-permission-system already:

1. Detects subagent context via `isSubagentExecutionContext()` (which will now hit the registry).
2. Resolves the forwarding target via `resolvePermissionForwardingTargetSessionId()` (which reads `parentSessionId` from the registry entry).
3. Writes a forwarding request file and polls for the parent's response.

The parent session's `ForwardingManager` already picks up and displays these requests in the UI.

## Module-Level Changes

### pi-subagents

1. **New: `src/lifecycle/permission-bridge.ts`**
   - `PermissionsServiceConsumer` interface (ISP-narrow, 2 methods).
   - `getPermissionsService(): PermissionsServiceConsumer | undefined` — `Symbol.for()` accessor.
   - `registerChildSession(sessionKey, info)` — calls `getPermissionsService()?.registerSubagentSession(...)`.
   - `unregisterChildSession(sessionKey)` — calls `getPermissionsService()?.unregisterSubagentSession(...)`.

2. **Modified: `src/lifecycle/agent-runner.ts`**
   - Import `registerChildSession` and `unregisterChildSession` from `permission-bridge.ts`.
   - Call `registerChildSession(sessionDir, { agentName: type, parentSessionId })` after `sessionDir` is derived, before `bindExtensions()`.
   - Wrap the `bindExtensions()` → `session.prompt()` span in a try/finally that calls `unregisterChildSession(sessionDir)`.

### pi-permission-system

No changes required.
The `SubagentSessionRegistry`, `isSubagentExecutionContext()`, and `resolvePermissionForwardingTargetSessionId()` are already wired and tested.

## Test Impact Analysis

1. **New unit tests** — `permission-bridge.ts` is a thin accessor module.
   Tests verify:
   - `registerChildSession` calls `registerSubagentSession` on the service when it exists.
   - `registerChildSession` is a no-op when the service is absent (returns `undefined`).
   - `unregisterChildSession` calls `unregisterSubagentSession` when the service exists.
   - `unregisterChildSession` is a no-op when the service is absent.

2. **New integration tests** — `agent-runner.test.ts` gains tests verifying:
   - `registerChildSession` is called before `bindExtensions()`.
   - `unregisterChildSession` is called after the run completes.
   - `unregisterChildSession` is called even when `session.prompt()` throws.
   - The registration includes the correct `agentName` and `parentSessionId`.

3. **Existing tests** — No existing tests become redundant.
   Existing `agent-runner.test.ts` tests continue to exercise tool filtering, extension binding order, and session creation.

## TDD Order

1. **Red/green: `permission-bridge.ts` unit tests**
   - Test `registerChildSession` delegates to `PermissionsService` when present.
   - Test `registerChildSession` is a no-op when absent.
   - Test `unregisterChildSession` delegates when present, no-op when absent.
   - Commit: `test: add permission-bridge unit tests (#101)`

2. **Green: implement `permission-bridge.ts`**
   - `PermissionsServiceConsumer` interface.
   - `getPermissionsService()` via `Symbol.for()`.
   - `registerChildSession()` and `unregisterChildSession()` helpers.
   - Commit: `feat: add permission bridge for cross-extension registration (#101)`

3. **Red/green: `agent-runner.ts` integration tests**
   - Test registration is called before `bindExtensions()` (invocation order assertion).
   - Test unregistration is called after successful run.
   - Test unregistration is called after `session.prompt()` throws.
   - Test correct `agentName` and `parentSessionId` are passed.
   - Commit: `test: add agent-runner permission registration tests (#101)`

4. **Green: integrate into `agent-runner.ts`**
   - Import bridge functions.
   - Add `registerChildSession` call after `sessionDir` derivation, before `bindExtensions()`.
   - Wrap `bindExtensions()` → `session.prompt()` in try/finally with `unregisterChildSession`.
   - Commit: `feat: register child sessions with permission system (#101)`

5. **Docs: update architecture docs**
   - Update `packages/pi-subagents/docs/architecture/architecture.md` if it lists module dependencies — add the permission-bridge dependency.
   - Commit: `docs: document permission-bridge in architecture (#101)`

## Risks and Mitigations

| Risk                                                                                             | Mitigation                                                                                                      |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `bindExtensions()` throws before `onSessionCreated` fires — session is registered but never used | `finally` block unregisters; orphaned entries are harmless (unique keys, process-scoped map)                    |
| `getPermissionsService()` returns a stale or incompatible object                                 | ISP-narrow interface reduces surface; the two methods are stable since plan 0221                                |
| Registration order race with concurrent background agents                                        | `sessionDir` is unique per session; `Map` operations are synchronous; no race possible                          |
| System prompt not yet available when `before_agent_start` fires                                  | `systemPromptOverride` is set on the resource loader before `bindExtensions()` — confirmed in `agent-runner.ts` |

## Open Questions

- **Forwarding UX** — when a child session's `ask` prompt is forwarded to the parent, the parent UI shows a generic "Subagent requested permission" dialog.
  Should the dialog mention which agent type triggered it?
  This is already handled by `formatForwardedPermissionPrompt()` which includes `requesterAgentName` — no change needed here, but UX polish is a follow-up if the formatting is unclear.
