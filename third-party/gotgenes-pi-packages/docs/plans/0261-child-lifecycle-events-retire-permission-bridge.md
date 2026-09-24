---
issue: 261
issue_title: "Emit child-execution lifecycle events; retire permission-bridge"
---

# Emit child-execution lifecycle events; retire permission-bridge

## Problem Statement

Today `@gotgenes/pi-subagents` reaches *out* to a named consumer: `permission-bridge.ts` looks up `Symbol.for("@gotgenes/pi-permission-system:service")` and calls `registerSubagentSession` / `unregisterSubagentSession` directly.
That is an outbound dependency from a core that is supposed to know nothing about its consumers.
[ADR-0002] establishes that reactive concerns attach by *observing* the core's lifecycle, not by the core calling them.

This issue inverts that one coupling: the core *publishes* its child-execution lifecycle as events, and `@gotgenes/pi-permission-system` *subscribes* to register and unregister child sessions.
The bridge is deleted.

## Goals

- Emit an ordered child-execution lifecycle from the core (`spawning`, `session-created`, `completed`, `disposed`), with `session-created` firing before `bindExtensions()` and carrying the child identity the permission system needs (session directory, agent name, parent session id).
- Migrate `@gotgenes/pi-permission-system` to register/unregister child sessions by subscribing to `session-created` / `disposed`.
- Delete `permission-bridge.ts` (and its test) from the core; the core no longer imports or looks up `@gotgenes/pi-permission-system`.
- Keep permission gating for child sessions working - existing permission-system tests pass unchanged.

## Non-Goals

- Removing the inbound `registerSubagentSession` / `unregisterSubagentSession` methods from `PermissionsService`.
  Once the bridge is gone, nothing calls them in-process, but their removal (and the doc reconciliation that follows) is deferred to **#267** ("finish the inversion").
  They are retained, untouched, in this issue.
- Changing the `SubagentSessionRegistry`'s "executing now" semantics.
  The registry stays registered-before-`bindExtensions` / unregistered-in-`finally`, scoped to a single `runAgent` call.
- Registry-detected resume.
  Resume executions remain detected by the permission system's filesystem-path heuristic, exactly as today.
  Making resume registry-detected requires shifting the registry from "executing now" to "exists" (register at creation, unregister at disposal), which is entangled with dissolving the runner - deferred to **#265** (an acceptance criterion was added there).
- The `WorkspaceProvider` seam (#262), worktree extraction (#263), `isolated` removal (#264), born-complete execution (#265).
  This is Phase 16, Step 1 only.

## Background

Relevant modules:

- `packages/pi-subagents/src/lifecycle/agent-runner.ts` - `runAgent()` creates the child session, calls `registerChildSession()` before `await session.bindExtensions({})`, and calls `unregisterChildSession()` in the `finally` after `session.prompt()`.
  `RunnerDeps` (`{ io, exec, registry }`) is the runner's construction-time dependency bag; `ConcreteAgentRunner` wraps it.
- `packages/pi-subagents/src/lifecycle/permission-bridge.ts` - the module being deleted.
  `registerChildSession` / `unregisterChildSession` read the published `PermissionsService` via `Symbol.for()` and call it (no-op when absent).
- `packages/pi-subagents/src/index.ts` - wires `RunnerDeps`, owns `pi.events`, already emits `subagents:*` record-level events.
- `packages/pi-permission-system/src/index.ts` - constructs `SubagentSessionRegistry`, publishes `PermissionsService`, registers RPC handlers, and binds `session_shutdown` cleanup.
- `packages/pi-permission-system/src/subagent-registry.ts` - `SubagentSessionRegistry.register/unregister/has`.
- `packages/pi-permission-system/src/subagent-context.ts` - `isSubagentExecutionContext()` checks (1) the registry, (2) env vars, (3) the filesystem-path heuristic, in that order.

Constraints from AGENTS.md and the package skills:

- Cross-extension communication must be **event-driven, not outbound bridges** (`code-design` skill, "Cross-extension composition").
  This issue is the canonical example.
- jiti isolation (`moduleCache: false`) means module-scoped state is not shared across extensions.
  `pi.events` and `globalThis`/`Symbol.for()` are the only shared channels.
  Both packages already use `pi.events`; the channel name string is the only coupling point, so each package declares its own channel constants and lean local payload types (no shared import - the two packages must not depend on each other).
- The core must remain SDK-consumer-only at its edges; the new publisher accepts an injected `emit` callback rather than importing `pi.events` into a library module.

### The blocking investigation - resolved

The issue asks whether Pi's event model can emit an *awaited, ordered* event at the pre-`bindExtensions` instant and have the handler complete before binding proceeds.

`pi.events` is a Node `EventEmitter` (`@earendil-works/pi-coding-agent/dist/core/event-bus.js`):

```javascript
emit: (channel, data) => { emitter.emit(channel, data); },
on: (channel, handler) => {
  const safeHandler = async (data) => { try { await handler(data); } catch (err) { /* logged */ } };
  emitter.on(channel, safeHandler);
  return () => emitter.off(channel, safeHandler);
},
```

Key facts:

1. `EventEmitter.emit()` invokes every listener **synchronously, in registration order**, on the same call stack, before `emit()` returns.
2. The `on` wrapper makes each listener an `async safeHandler`.
   When `emit` calls `safeHandler(data)`, it runs synchronously up to the first `await`.
   If the underlying handler body is **synchronous** (no `await` before its work), the body runs to completion before `safeHandler` even suspends - `await handler(data)` only schedules a microtask *after* `handler` already returned.
3. `emit()` itself returns `void` and does **not** await the listeners' returned promises.

Conclusion: **no new SDK hook is required.**
The existing bus already guarantees the needed ordering, provided two conditions hold:

- The permission system's `session-created` handler does its `registry.register(...)` **synchronously** (no `await` before the write).
- The core emits `session-created` on the same synchronous call stack, immediately before `await session.bindExtensions({})`.

`emit()` returns only after the synchronous handler has registered, so the registry entry exists before `bindExtensions()` runs.
This is exactly the ordering `registerChildSession()` provides today; the delivery mechanism changes from a direct call to a synchronous event, but the timing guarantee is identical.

The "awaited" framing in the issue is therefore satisfied by **synchronous dispatch**, not by awaiting `emit()` (which is not awaitable).
The plan encodes the synchronous-handler constraint as a tested invariant (a test emits on the *real* `createEventBus()` and asserts the registry is updated the instant `emit()` returns).

## Design Overview

### Decision model

Two independently-declared channel contracts, one per package, coupled only by the channel-name strings.

Core (publisher) - `packages/pi-subagents/src/lifecycle/child-lifecycle.ts`:

```typescript
export const SUBAGENT_CHILD_SPAWNING = "subagents:child:spawning";
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
export const SUBAGENT_CHILD_COMPLETED = "subagents:child:completed";
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

export interface ChildSpawningEvent {
  agentName: string;
  parentSessionId?: string;
}

export interface ChildSessionCreatedEvent {
  /** Child session directory - the registry key. */
  sessionDir: string;
  agentName: string;
  parentSessionId?: string;
}

export interface ChildCompletedEvent {
  sessionDir: string;
  agentName: string;
  aborted: boolean;
  steered: boolean;
}

export interface ChildDisposedEvent {
  sessionDir: string;
}

/** Narrow emit seam - injected, never imports the Pi SDK. */
export type LifecycleEmit = (channel: string, data: unknown) => void;

export interface ChildLifecyclePublisher {
  spawning(event: ChildSpawningEvent): void;
  sessionCreated(event: ChildSessionCreatedEvent): void;
  completed(event: ChildCompletedEvent): void;
  disposed(event: ChildDisposedEvent): void;
}

export function createChildLifecyclePublisher(emit: LifecycleEmit): ChildLifecyclePublisher;
```

The new namespace `subagents:child:*` deliberately avoids collision with the existing record-level events (`subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:compacted`), which describe `AgentManager`/`SubagentRecord` background-agent transitions - a different abstraction level than the per-`runAgent` child-session events introduced here.

The full four-event lifecycle is emitted per [ADR-0002] (the core “publishes its lifecycle”).
Observational events are unlimited and adding one never modifies the core; `spawning` and `completed` have no subscriber yet, which is fine - the "no vacant hooks" rule constrains *provider seams* (generative), not observational events.

Consumer (subscriber) - `packages/pi-permission-system/src/subagent-lifecycle-events.ts`:

```typescript
/** Channel names re-declared locally; must match @gotgenes/pi-subagents. */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/** Lean local payloads - only the fields this handler reads (ISP). */
interface ChildSessionCreatedEvent {
  sessionDir: string;
  agentName: string;
  parentSessionId?: string;
}
interface ChildDisposedEvent {
  sessionDir: string;
}

interface LifecycleEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Subscribe; returns an unsubscribe that detaches both handlers. */
export function subscribeSubagentLifecycle(
  events: LifecycleEventBus,
  registry: SubagentSessionRegistry,
): () => void;
```

The consumer subscribes only to the two events it needs (`session-created`, `disposed`); it ignores `spawning` and `completed`.

### Call-site sketches

Core - `runAgent()` (the four emit points, replacing the two bridge calls):

```typescript
deps.lifecycle.spawning({ agentName: type, parentSessionId });          // top of runAgent
// ... assemble config, create session ...
deps.lifecycle.sessionCreated({ sessionDir, agentName: type, parentSessionId }); // pre-bind (replaces registerChildSession)
await session.bindExtensions({});                                        // registry already populated
// ... run ...
try {
  await session.prompt(effectivePrompt);
  deps.lifecycle.completed({ sessionDir, agentName: type, aborted, steered }); // success path
} finally {
  // ... existing cleanup ...
  deps.lifecycle.disposed({ sessionDir });                               // always (replaces unregisterChildSession)
}
```

`disposed` mirrors the current `unregisterChildSession` placement (the `finally`), so unregistration still fires on both success and error.
`completed` fires only when `prompt()` resolves (covers normal, soft-limit-steered, and hard-aborted runs, since `abort()` resolves the prompt); on a thrown error only `spawning` / `session-created` / `disposed` fire.

Consumer - `index.ts` wiring:

```typescript
const unsubLifecycle = subscribeSubagentLifecycle(pi.events, subagentRegistry);
// handler bodies are synchronous: (data) => registry.register(data.sessionDir, { agentName, parentSessionId })
// torn down in session_shutdown alongside the existing rpcHandles unsubscribes
```

This is Tell-Don't-Ask (the publisher tells; the registry registers) and respects the Law of Demeter (the core never reaches through a consumer's API).

### Injection of the publisher

`ChildLifecyclePublisher` is a construction-time dependency, so it joins `RunnerDeps`:

```typescript
export interface RunnerDeps {
  io: RunnerIO;
  exec: ShellExec;
  registry: AgentConfigLookup;
  lifecycle: ChildLifecyclePublisher;   // new
}
```

`index.ts` constructs it as `createChildLifecyclePublisher((channel, data) => pi.events.emit(channel, data))` - the only place `pi.events` touches the publisher, keeping `child-lifecycle.ts` SDK-free.

### Edge cases

- No permission-system installed → no subscriber → `emit()` is a harmless no-op (parity with today's "service absent" no-op).
- Concurrent background agents → each `runAgent` emits with its own unique `sessionDir`; registry keys do not collide (unchanged).
- A subscriber whose handler is async or throws → `safeHandler` logs and swallows; ordering for *our* synchronous handler is unaffected because `EventEmitter` dispatches each listener independently and synchronously.

## Module-Level Changes

`@gotgenes/pi-subagents`:

- **Add** `src/lifecycle/child-lifecycle.ts` - channel constants, payload types, `ChildLifecyclePublisher`, `createChildLifecyclePublisher`.
- **Change** `src/lifecycle/agent-runner.ts` - add `lifecycle` to `RunnerDeps`; remove the `permission-bridge` import and the `registerChildSession` / `unregisterChildSession` calls; emit the four lifecycle events at the points sketched above.
- **Change** `src/index.ts` - build the publisher with `createChildLifecyclePublisher((c, d) => pi.events.emit(c, d))` and pass it in `RunnerDeps`.
- **Remove** `src/lifecycle/permission-bridge.ts` and `test/lifecycle/permission-bridge.test.ts`.
- **Change** `test/lifecycle/agent-runner.test.ts` - drop `vi.mock("#src/lifecycle/permission-bridge")`; rewrite the "permission bridge" describe block to assert on the injected publisher mock (ordering relative to `bindExtensions`, `disposed` on success + throw, payload contents, `sessionDir` key).
- **Change** `test/helpers/runner-io.ts` - add a `createRunnerDeps(overrides?)` factory (and a `createChildLifecycleMock()`); migrate the 18 inline `{ io, exec, registry }` call sites across `agent-runner.test.ts`, `concrete-agent-runner.test.ts`, `agent-runner-extension-tools.test.ts` to it.
- **Change** `docs/architecture/architecture.md` - remove `permission-bridge.ts` from the `lifecycle/` file tree (line ~277) and the "What the core owns" bullet (lines ~355-356); add a `child-lifecycle.ts` entry and a "Lifecycle events" ownership bullet; note Step 1 (#261) is delivered in the roadmap (lines ~498-499, ~743-746).

`@gotgenes/pi-permission-system`:

- **Add** `src/subagent-lifecycle-events.ts` - local channel constants, lean payload types, `subscribeSubagentLifecycle(events, registry)`.
- **Change** `src/index.ts` - call `subscribeSubagentLifecycle(pi.events, subagentRegistry)`; add the returned unsubscribe to the `session_shutdown` cleanup (the `SessionLifecycleHandler` teardown callback that already calls `rpcHandles.unsub*` and `unpublishPermissionsService`).
- **Add** `test/subagent-lifecycle-events.test.ts` - fake-bus tests (register on `session-created`, unregister on `disposed`, unsubscribe detaches) plus a real-bus test (`createEventBus()` from the SDK) asserting the registry is populated the instant `emit()` returns.
- **Change** `docs/subagent-integration.md` - describe the native integration as event-based (pi-subagents emits `subagents:child:*`; this package subscribes), while noting the service methods remain available (their removal is tracked in #267).

Verified by grep: `permission-bridge` is imported only by `agent-runner.ts` (+ its test); no other `src/` consumer exists, so deleting the module after removing those references is safe.
`PermissionsService.registerSubagentSession` retains its `index.ts` implementation and `service.test.ts` coverage - untouched here, removed in #267.

## Test Impact Analysis

1. **New tests the change enables.**
   - Core: `child-lifecycle.ts` is independently unit-testable - each publisher method emits the expected channel + payload through a captured `emit` spy.
     This was previously impossible: registration was a free function reading a `Symbol.for()` global.
   - Consumer: `subscribeSubagentLifecycle` is independently testable against both a fake bus and the **real** `createEventBus()`, directly encoding the synchronous-dispatch invariant the investigation relies on.

2. **Tests that become redundant.**
   - `test/lifecycle/permission-bridge.test.ts` - deleted with the module; its behavior (delegate-when-present, no-op-when-absent) is subsumed by the publisher's emit-spy tests and the consumer's bus tests.

3. **Tests that must stay as-is.**
   - `packages/pi-permission-system/test/service.test.ts` register/unregister cases - the service methods are retained this issue; these stay until #267.
   - The permission-system gating / forwarding / `isSubagentExecutionContext` tests - they exercise the registry and detection layer this change does not touch.
   - The runner's turn-limit, output-capture, and config-assembly tests - unaffected by the publisher injection (they migrate to `createRunnerDeps` but assert the same behavior).

## TDD Order

1. **`feat`** - Add the child-lifecycle publisher.
   New `src/lifecycle/child-lifecycle.ts`; tests assert each method emits the right channel + payload via an `emit` spy.
   `feat: add child-execution lifecycle event publisher`
2. **`test`** - Centralize runner deps construction.
   Add `createRunnerDeps(overrides?)` (without `lifecycle` yet) to `test/helpers/runner-io.ts`; migrate the 18 inline `{ io, exec, registry }` call sites.
   Production code unchanged; full suite stays green.
   `test: centralize runner deps construction in a factory helper`
3. **`feat`** - Emit events from the runner; retire the bridge.
   Add `lifecycle: ChildLifecyclePublisher` to `RunnerDeps`; add it to `createRunnerDeps` + a `createChildLifecycleMock()`; emit `spawning` / `sessionCreated` / `completed` / `disposed` in `runAgent`; remove the `permission-bridge` import and its two calls; wire `createChildLifecyclePublisher` in `index.ts`; rewrite the runner test's "permission bridge" block to assert on the publisher mock; delete `permission-bridge.ts` and `permission-bridge.test.ts`.
   Single commit because the `RunnerDeps` change, its call sites, and the module deletion must compile together.
   Run `pnpm run check` after this commit (shared-interface change).
   `feat: emit child-execution lifecycle events and retire permission-bridge`
4. **`feat`** - Subscribe in the permission system.
   New `src/subagent-lifecycle-events.ts` with `subscribeSubagentLifecycle`; wire it in `index.ts` and tear it down in `session_shutdown`; tests against a fake bus and the real `createEventBus()` (synchronous-registration invariant).
   `feat: register subagent child sessions via lifecycle events`
5. **`docs`** - Reconcile documentation.
   Update pi-subagents `architecture.md` (file tree, ownership bullet, roadmap Step 1 status) and pi-permission-system `subagent-integration.md` (event-based native integration).
   `docs: document event-based subagent child lifecycle`

## Risks and Mitigations

- **Synchronous-handler invariant is implicit.**
  If a future edit makes the permission system's `session-created` handler `async` (awaiting before `registry.register`), registration could land *after* `bindExtensions()`, silently breaking child detection.
  Mitigation: the consumer handler stays synchronous; a real-bus test (Step 4) asserts the registry is populated the instant `emit()` returns, failing loudly if someone introduces an `await`.
  A code comment on the handler states the constraint.
- **Channel-name drift between packages.**
  The two packages declare the channel strings independently; a rename in one breaks the integration silently (no compile error).
  Mitigation: each package's tests assert the literal channel strings; cross-referencing comments in both modules; the strings are also documented in `subagent-integration.md`.
- **Release ordering between commits.**
  Between Step 3 (core emits, bridge gone) and Step 4 (consumer subscribes), the integrated runtime registration is briefly incomplete.
  Mitigation: both packages ship in this one issue/PR; each package's own test suite stays green at every commit, and the runtime behavior is whole once merged.
- **18-site test-helper migration churn (Step 2).**
  Large mechanical diff.
  Mitigation: isolated in its own `test:` commit with no production change, so review is a straight substitution; it also pays down churn for #264/#265, which touch the same tests.

## Open Questions

- **Resume determinism.**
  Resume executions remain detected via the filesystem-path heuristic, not the registry, because the registry keeps "executing now" semantics scoped to a single `runAgent`.
  Closing this requires register-at-creation / unregister-at-disposal, which is entangled with dissolving the runner - tracked as an acceptance criterion on **#265**.
- **Inbound service-method removal.**
  `registerSubagentSession` / `unregisterSubagentSession` become caller-less after this issue; their removal and the doc reconciliation are tracked in **#267**.

[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md
