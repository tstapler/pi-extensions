---
issue: 263
issue_title: "Extract worktree isolation to @gotgenes/pi-subagents-worktrees"
---

# Extract worktree isolation to @gotgenes/pi-subagents-worktrees

## Status - paused, blocked on #270 (2026-05-29)

TDD execution paused partway.
Steps 2-3 (scaffold + git-plumbing lift-and-shift, `worktreeAgents` config loader) landed and are green on `main`.
Step 1 (re-exporting the seam types from pi-subagents' `service.ts`) and Step 4 (the `WorkspaceProvider` implementation) were reverted.

Reason: the worktrees package must `import { getSubagentsService, type WorkspaceProvider } from "@gotgenes/pi-subagents"`, but pi-subagents is not type-consumable from a sibling package today.
Its public entry ships raw `.ts` that uses the internal `#src/*` alias, `exports["."]` points at a non-existent `./src/service.ts` (real file: `./src/service/service.ts`), and neither consumer-side `tsconfig` `paths` (program-global, collide with pi-subagents' own `#src`) nor package.json `imports` (tsc won't resolve `.ts` targets) bridge it.
This is packaging work on pi-subagents, split out as prerequisite **#270**.

Resume #263 after #270 lands.
The consumption mechanism in "Design Overview" (importing the seam types) is contingent on #270's chosen fix; if #270 cannot make the source cleanly consumable, revisit the alternative of a local seam contract accessed via the published `Symbol.for("@gotgenes/pi-subagents:service")` global (matching how `pi-permission-system` composes).

## Problem Statement

Phase 16, Step 3 of [ADR-0002].
Git worktree isolation lives in the pi-subagents core today (`worktree.ts`, `worktree-isolation.ts`, `GitWorktreeManager`, and the `isolation: "worktree"` spawn mode), but worktrees are not intrinsic to what makes subagents useful.
They are one *workspace strategy* - "where does this child run, and what brackets the run?"

- alongside containers, throwaway tmpdirs, and remote sandboxes.
Step 2 (#262, landed) added the single generative seam - `WorkspaceProvider` / `Workspace` plus `SubagentsService.registerWorkspaceProvider` - and wired `Agent.run()` to consult a registered provider provider-first, falling back to the legacy worktree collaborator.
This issue evicts the git plumbing into a new package, `@gotgenes/pi-subagents-worktrees`, that implements the seam, and deletes the legacy path so `git` no longer appears in the core.
It supersedes #256, which placed `WorktreeIsolation` as an `Agent` collaborator in the core - the wrong layer.

## Goals

- Create a new package `@gotgenes/pi-subagents-worktrees` that registers a `WorkspaceProvider`: prepares a git worktree at run-start (born complete), tears it down after (saving the branch on changes), and owns the "Changes saved to branch ..." result wording.
- Make worktree isolation **opt-in per agent** via the new package's own config (a `worktreeAgents` list of agent-type names) - the core no longer carries an `isolation` axis.
- On worktree-creation failure for an opted-in agent (not a git repo, no commits, or `git worktree add` fails), **throw and fail the child run** with a helpful message - preserve today's strict behavior rather than silently falling back to the parent cwd.
- Register the provider **once at extension init** via `getSubagentsService()`, relying on Pi's deterministic `settings.json` load order (first-listed loads first); document the ordering constraint.
- **Breaking (core):** remove `worktree.ts`, `worktree-isolation.ts`, `GitWorktreeManager`, the `isolation: "worktree"` spawn mode, and drop `isolation` from the spawn API, `SubagentsService.SpawnOptions`, and `SubagentRecord.worktreeResult`.
- Register the new package in `.pi/settings.json` (after pi-subagents) and `release-please-config.json` (component + doc exclude-paths); peer-depend on `@gotgenes/pi-subagents`.

## Non-Goals

- Removing `isolated` / `extensions: false` / `noSkills` - deferred to #264.
  `isolated` (the no-extension-tools axis) is a *different* field from `isolation` (worktree mode); this issue removes only the latter.
- Born-complete child execution / dissolving the runner - deferred to #265.
- The `WorkspaceProvider` / `Workspace` seam itself and `Agent.run()`'s provider-first consultation - already landed in #262; this issue consumes them and deletes only the legacy fallback arm.
- Chaining or multiple providers - out of scope per #262; one provider only.
- A global "isolate every child" switch or per-agent-frontmatter (`worktree: true`) opt-in - see Open Questions; this issue ships the `worktreeAgents` list only.
- A `/agents`-style config UI or a `package-pi-subagents-worktrees` skill - see Open Questions.

## Background

Relevant existing modules in `packages/pi-subagents/`:

- `src/lifecycle/workspace.ts` - the seam (#262): `WorkspaceProvider.prepare(ctx) → Promise<Workspace | undefined>`, `Workspace { readonly cwd; dispose(outcome) → WorkspaceDisposeResult | undefined }`, plus `WorkspacePrepareContext { agentId; agentType; baseCwd; invocation? }` and `WorkspaceDisposeOutcome { status; description }`.
  This stays; the new package implements it.
- `src/lifecycle/worktree.ts` - the git plumbing: `createWorktree(cwd, agentId)`, `cleanupWorktree(cwd, info, description)`, `removeWorktree`, `pruneWorktrees`, the `WorktreeInfo` / `WorktreeCleanupResult` types, and the `WorktreeManager` / `GitWorktreeManager` wrapper.
  Lift-and-shifted into the new package; deleted from the core.
- `src/lifecycle/worktree-isolation.ts` - `WorktreeIsolation` (the run-scoped collaborator with `setup()` / `cleanup()`).
  Its strict-failure message ("Cannot run with isolation: \"worktree\" - not a git repo ...") moves into the new provider; the class is deleted.
- `src/lifecycle/agent.ts` - `Agent.run()` consults the provider provider-first, then falls back to `this.worktree?.setup()`; `completeRun`/`failRun` dispose the workspace or fall back to `this.worktree?.cleanup()` (which formats the branch addendum).
  The fallback arms are deleted (provider-only).
- `src/lifecycle/agent-manager.ts` - injects `worktrees: WorktreeManager`, constructs `WorktreeIsolation` when `options.isolation === "worktree"`, threads `getWorkspaceProvider`, and prunes worktrees in `dispose()`.
  The worktree wiring is removed; `registerWorkspaceProvider` and the provider getter stay.
- `src/service/service.ts` - the public API (`package.json` `exports` → `./src/service.ts`).
  Re-exports `WorkspaceProvider` and `getSubagentsService`/`SubagentsService`; carries `SpawnOptions.isolation` and `SubagentRecord.worktreeResult` (both removed); the file comment already notes "the worktrees package (#263) adds named re-exports when it imports them."
- `src/config/invocation-config.ts`, `src/tools/spawn-config.ts`, `src/tools/agent-tool.ts`, `src/tools/background-spawner.ts`, `src/tools/foreground-runner.ts`, `src/ui/display.ts`, `src/types.ts` - the tool-facing `isolation` axis (`IsolationMode`, `AgentConfig.isolation`, `AgentInvocation.isolation`, the `isolation` tool parameter, and the `"worktree"` invocation tag), all removed.

Reference package for the new package's shape: `packages/pi-session-tools/` (minimal extension: `package.json` with `pi.extensions`, `tsconfig.json` extending the base, `vitest.config.ts`, `LICENSE`, `README.md`, `AGENTS.md`).
Reference for config loading: `packages/pi-subagents/src/settings.ts` (global `<agentDir>/<name>.json` + project `.pi/<name>.json`, merged with project override; sanitize unknown shapes; silent-missing, warn-on-malformed).
Reference for the service-access + lifecycle pattern: `packages/pi-permission-system/src/index.ts` (extension function receives `pi`, registers handlers, disposes on `session_shutdown`).

AGENTS.md / ADR constraints that apply:

- **No vacant hooks** ([ADR-0002]): #262’s seam shipped without a consumer; this issue is that consumer.
  Releasing the core eviction (#263 core changes) without the new package would strand worktree users - the two halves must release together.
- **First intra-repo package import.**
  No `packages/*` currently imports another `@gotgenes/*` package; the new package imports types and `getSubagentsService` from `@gotgenes/pi-subagents`.
  See Risks for the workspace-protocol dependency wiring.
- **No `process.cwd()` inside library functions** - `baseCwd` arrives via `WorkspacePrepareContext.baseCwd`; the extension edge (`index.ts`) supplies `process.cwd()` / `getAgentDir()` for config loading and crash-recovery prune.
- **Registration convention** - the seam returns an unregister **function** (`() => void`), matching the codebase; store it and call on `session_shutdown`.
- **Barrel discipline** - the new package's public entry (`exports["."]`) re-exports only what an external consumer needs; do not add speculative re-exports (fallow flags them).
- When adding a new package, add its doc paths to `release-please-config.json` `exclude-paths`.

## Design Overview

### Composition

The core consults a registered `WorkspaceProvider` for every child run.
The new package decides *which* children get a worktree (via its `worktreeAgents` config) and *what brackets the run* (git worktree create/cleanup).
Install neither → children run in the parent cwd; install the package and list an agent type → that agent runs in a worktree; the core is byte-for-byte identical either way.

### New package layout

```text
packages/pi-subagents-worktrees/
├── package.json            pi.extensions → ./src/index.ts; exports["."] → ./src/index.ts
├── tsconfig.json           extends ../../tsconfig.base.json
├── vitest.config.ts        #src / #test aliases
├── LICENSE, README.md, AGENTS.md
└── src/
    ├── index.ts            extension entry: load config, register provider at init, prune, dispose
    ├── worktree.ts         git plumbing (lift-and-shift from core, verbatim)
    ├── config.ts           worktreeAgents config loader (global + project merge)
    ├── workspace-provider.ts  WorktreeWorkspaceProvider + WorktreeWorkspace
    └── debug.ts            debug log (mirrors core src/debug.ts)
```

### Provider and workspace (born complete, strict failure, owns the addendum)

The provider reads only `ctx.agentType` and `ctx.baseCwd` from the prepare context (ISP - it ignores `agentId` except as the worktree id, and ignores `invocation`):

```typescript
class WorktreeWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly cfg: WorktreesConfig) {}

  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    if (!this.cfg.worktreeAgents.includes(ctx.agentType)) return undefined; // not opted in
    const info = createWorktree(ctx.baseCwd, ctx.agentId);
    if (!info) {
      throw new Error(
        `Cannot run agent "${ctx.agentType}" with worktree isolation - ` +
          "not a git repo, no commits yet, or `git worktree add` failed. " +
          "Initialize git and commit at least once, or remove the agent from worktreeAgents.",
      );
    }
    return new WorktreeWorkspace(ctx.baseCwd, info);
  }
}

class WorktreeWorkspace implements Workspace {
  constructor(private readonly repoCwd: string, private readonly info: WorktreeInfo) {}
  get cwd(): string { return this.info.path; }           // born complete - the worktree exists
  dispose(outcome: WorkspaceDisposeOutcome): WorkspaceDisposeResult | undefined {
    const r = cleanupWorktree(this.repoCwd, this.info, outcome.description);
    if (r.hasChanges && r.branch) {
      return { resultAddendum: `\n\n---\nChanges saved to branch \`${r.branch}\`. Merge with: \`git merge ${r.branch}\`` };
    }
    return undefined;
  }
}
```

The thrown error propagates through `Agent.run()`'s existing `try/catch`, which calls `markError` → the child fails (strict semantics preserved).
On the error path the core's `failRun` calls `dispose({ status: "error", ... })` but discards the return - so the addendum is naturally suppressed on failure, matching today.

### Config - opt-in by agent type

```typescript
export interface WorktreesConfig {
  /** Agent-type names that run in a git worktree. Empty/absent → no children isolated. */
  worktreeAgents: string[];
}
```

Loader mirrors `pi-subagents/src/settings.ts`: merge global `<agentDir>/subagents-worktrees.json` under project `.pi/subagents-worktrees.json`; `sanitize()` keeps `worktreeAgents` only when it is an array of strings; missing file → `{ worktreeAgents: [] }`; malformed file → warn to stderr and fall back to empty.
`index.ts` supplies `getAgentDir()` (from `@earendil-works/pi-coding-agent`) and `process.cwd()`.

### Extension entry - register once at init

```typescript
export default function piSubagentsWorktreesExtension(pi: ExtensionAPI): void {
  const config = loadWorktreesConfig(getAgentDir(), process.cwd());
  pruneWorktrees(process.cwd());                       // best-effort crash recovery

  const svc = getSubagentsService();                   // published by pi-subagents at its init
  if (!svc) { debugLog("subagents service unavailable - worktree provider not registered"); return; }

  const unregister = svc.registerWorkspaceProvider(new WorktreeWorkspaceProvider(config));
  pi.on("session_shutdown", () => unregister());
}
```

Registration is process-global (the `AgentManager` lives across sessions), so the provider is registered once at init and unregistered on shutdown - not per session.
This depends on `@gotgenes/pi-subagents` having published its service first; Pi loads packages in `settings.json` order, so the new package is listed **after** `@gotgenes/pi-subagents` (see Module-Level Changes).
The `if (!svc) return` guard keeps the extension inert (not crashing) if pi-subagents is absent or mis-ordered.

### Core call site after eviction (provider-only)

`Agent.run()` collapses to the provider branch (the `else { this.worktree?.setup() }` arm is deleted):

```typescript
let cwd: string | undefined;
try {
  const provider = this._getWorkspaceProvider?.();
  if (provider) {
    this._workspace = await provider.prepare({ agentId: this.id, agentType: this.type, baseCwd: this._baseCwd, invocation: this.invocation });
    cwd = this._workspace?.cwd;
  }
} catch (err) { this.markError(err); this.releaseListeners(); this.observer?.onRunFinished?.(this); return; }
```

With no provider, `cwd` is `undefined` and the runner uses `options.context.cwd ?? snapshot.cwd` (the parent cwd) - identical to today's no-isolation behavior (verified: `agent-runner.ts` `effectiveCwd = options.context.cwd ?? snapshot.cwd`).
`completeRun`/`failRun` keep only the `if (this._workspace)` arm.

### Edge cases

- Agent type not in `worktreeAgents` → `prepare` returns `undefined` → child runs in parent cwd, no dispose.
- Opted-in agent, worktree creation fails → `prepare` throws → child run fails with the helpful message.
- `dispose` with no changes → returns `undefined` → result unchanged; the worktree is removed.
- `dispose({ status: "error" })` → core discards the addendum (failure path), worktree removed.
- pi-subagents not loaded / mis-ordered → `getSubagentsService()` undefined → extension no-ops with a debug log.

## Module-Level Changes

### New package (`packages/pi-subagents-worktrees/`)

| File                                | Change                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                      | **New.** `name: @gotgenes/pi-subagents-worktrees`; `type: module`; `pi.extensions: ["./src/index.ts"]`; `exports["."]: "./src/index.ts"`; `imports` `#src/*`/`#test/*`; peerDeps `@earendil-works/pi-coding-agent` + `@gotgenes/pi-subagents`; devDeps mirror pi-session-tools plus `@gotgenes/pi-subagents: "workspace:*"`; standard `scripts` (`check`/`lint`/`test`). |
| `tsconfig.json`                     | **New.** Extends `../../tsconfig.base.json` with `#src`/`#test` paths.                                                                                                                                                                                                                                                                                                   |
| `vitest.config.ts`                  | **New.** `#src`/`#test` aliases (copy pi-session-tools).                                                                                                                                                                                                                                                                                                                 |
| `src/worktree.ts`                   | **New (lift-and-shift).** `createWorktree`, `cleanupWorktree`, `removeWorktree`, `pruneWorktrees`, `WorktreeInfo`, `WorktreeCleanupResult` - verbatim from the core module; imports `debugLog` from this package's `debug.ts`.                                                                                                                                           |
| `src/config.ts`                     | **New.** `WorktreesConfig`, `loadWorktreesConfig(agentDir, cwd)`, `sanitize`, file readers (mirror `settings.ts`).                                                                                                                                                                                                                                                       |
| `src/workspace-provider.ts`         | **New.** `WorktreeWorkspaceProvider implements WorkspaceProvider` and `WorktreeWorkspace implements Workspace`; imports the seam types from `@gotgenes/pi-subagents`.                                                                                                                                                                                                    |
| `src/debug.ts`                      | **New.** Debug log (mirror `pi-subagents/src/debug.ts`).                                                                                                                                                                                                                                                                                                                 |
| `src/index.ts`                      | **New.** Extension entry (config load, prune, `getSubagentsService` + `registerWorkspaceProvider` at init, `session_shutdown` unregister).                                                                                                                                                                                                                               |
| `LICENSE`, `README.md`, `AGENTS.md` | **New.** Standard package files (README documents the `worktreeAgents` config, the install-after-pi-subagents ordering, and the strict-failure behavior).                                                                                                                                                                                                                |
| `test/worktree.test.ts`             | **New (lift-and-shift).** Migrated from the core `test/lifecycle/worktree.test.ts`.                                                                                                                                                                                                                                                                                      |
| `test/config.test.ts`               | **New.** Merge/sanitize/malformed-warn coverage.                                                                                                                                                                                                                                                                                                                         |
| `test/workspace-provider.test.ts`   | **New.** Opt-in gate, throw-on-failure, born-complete cwd, dispose addendum.                                                                                                                                                                                                                                                                                             |
| `test/index.test.ts`                | **New.** Init registers with a fake service; no-service guard; shutdown unregisters.                                                                                                                                                                                                                                                                                     |

### Core removals (`packages/pi-subagents/`)

| File                                                                                                                                                                                                                                                                                                                                                | Change                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/service/service.ts`                                                                                                                                                                                                                                                                                                                            | Add named re-exports `Workspace`, `WorkspacePrepareContext`, `WorkspaceDisposeOutcome`, `WorkspaceDisposeResult` (alongside `WorkspaceProvider`). **Remove** `SpawnOptions.isolation` and `SubagentRecord.worktreeResult`.                                                                                           |
| `src/service/service-adapter.ts`                                                                                                                                                                                                                                                                                                                    | **Remove** `isolation: options?.isolation` from the `spawn` mapping and the `worktreeResult` lines in `toSubagentRecord`.                                                                                                                                                                                            |
| `src/types.ts`                                                                                                                                                                                                                                                                                                                                      | **Remove** `IsolationMode`, `AgentConfig.isolation`, `AgentInvocation.isolation`.                                                                                                                                                                                                                                    |
| `src/config/invocation-config.ts`                                                                                                                                                                                                                                                                                                                   | **Remove** `isolation` from params and the returned object.                                                                                                                                                                                                                                                          |
| `src/tools/spawn-config.ts`                                                                                                                                                                                                                                                                                                                         | **Remove** `isolation` from `SpawnExecution`, the resolution, and `agentInvocation`.                                                                                                                                                                                                                                 |
| `src/tools/agent-tool.ts`                                                                                                                                                                                                                                                                                                                           | **Remove** the `isolation` tool parameter and the `Use isolation: "worktree" ...` description line.                                                                                                                                                                                                                  |
| `src/tools/background-spawner.ts`, `src/tools/foreground-runner.ts`                                                                                                                                                                                                                                                                                 | **Remove** `isolation: execution.isolation` from the spawn options.                                                                                                                                                                                                                                                  |
| `src/ui/display.ts`                                                                                                                                                                                                                                                                                                                                 | **Remove** the `if (invocation.isolation === "worktree") tags.push("worktree")` line.                                                                                                                                                                                                                                |
| `src/lifecycle/agent.ts`                                                                                                                                                                                                                                                                                                                            | **Remove** `WorktreeIsolation` import, `AgentInit.worktree`, the `worktree` field, the `else { this.worktree?.setup() }` fallback in `run()`, and the `else { this.worktree?.cleanup() }` arms in `completeRun`/`failRun`.                                                                                           |
| `src/lifecycle/agent-manager.ts`                                                                                                                                                                                                                                                                                                                    | **Remove** `WorktreeManager`/`WorktreeIsolation`/`GitWorktreeManager` imports, the `worktrees` option + field, `AgentSpawnConfig.isolation`, the `worktree: options.isolation === "worktree" ? ...` wiring, and the `this.worktrees.prune()` in `dispose()`. Keep `registerWorkspaceProvider` + the provider getter. |
| `src/index.ts`                                                                                                                                                                                                                                                                                                                                      | **Remove** the `GitWorktreeManager` import and the `worktrees: new GitWorktreeManager(process.cwd())` argument.                                                                                                                                                                                                      |
| `src/lifecycle/worktree.ts`, `src/lifecycle/worktree-isolation.ts`                                                                                                                                                                                                                                                                                  | **Delete.**                                                                                                                                                                                                                                                                                                          |
| `test/lifecycle/worktree.test.ts`, `test/lifecycle/worktree-isolation.test.ts`                                                                                                                                                                                                                                                                      | **Delete** (worktree.test.ts migrates to the new package).                                                                                                                                                                                                                                                           |
| `test/lifecycle/agent.test.ts`, `test/lifecycle/agent-manager.test.ts`, `test/service/service-adapter.test.ts`, `test/tools/spawn-config.test.ts`, `test/config/invocation-config.test.ts`, `test/ui/agent-config-editor.test.ts`, `test/tools/background-spawner.test.ts`, `test/tools/foreground-runner.test.ts`, `test/helpers/manager-stubs.ts` | **Update.** Drop `isolation`/worktree assertions, fixtures, and stub fields.                                                                                                                                                                                                                                         |

### Removed-symbol grep checklist (before finalizing the core eviction)

- `isolation` - every reference in `src/` and `test/` is listed above; confirm none remain except the new package.
- `IsolationMode` - imported by `agent-manager.ts`, `invocation-config.ts`, `spawn-config.ts`, `types.ts` (definition); all removed together.
- `worktree` / `Worktree` / `GitWorktreeManager` - confirm zero matches in `packages/pi-subagents/src` after deletion.
- `worktreeResult` - `service.ts` (type), `service-adapter.ts` (writer); any test asserting it.
- `record.worktree?.cleanupResult` - sole reader is `toSubagentRecord`; removed in the same step.

### Root config

| File                         | Change                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.pi/settings.json`          | Add `"../packages/pi-subagents-worktrees"` to the workspace list **after** `pi-subagents`, and `{ "source": "npm:@gotgenes/pi-subagents-worktrees", "extensions": [], "skills": [] }` after the subagents npm entry. Order is load order - worktrees must follow pi-subagents. |
| `release-please-config.json` | Add `packages/pi-subagents-worktrees` (component `pi-subagents-worktrees`) and exclude-paths `packages/pi-subagents-worktrees/docs/plans` + `.../docs/retro`.                                                                                                                  |
| `pnpm-workspace.yaml`        | No change - `packages/*` already globs the new package.                                                                                                                                                                                                                        |

### Docs

| File                                                      | Change                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-subagents/docs/architecture/architecture.md` | Mark Phase 16 Step 3 (#263) landed; remove `worktree.ts` / `worktree-isolation.ts` from the lifecycle domain listing and the module count; note `git` has left the core and the new package is the seam's first consumer. |
| `.pi/skills/package-pi-subagents/SKILL.md`                | Update the Lifecycle domain table (drop `worktree.ts` / `worktree-isolation.ts`; 9 → 7 modules) and the file/LOC totals.                                                                                                  |

No file in Module-Level Changes is also claimed as unchanged in Non-Goals (the seam module `workspace.ts` is untouched and is a Non-Goal; `agent.ts` touches only the worktree *fallback arm*, which is a Goal).

## Test Impact Analysis

1. New tests the extraction enables (previously impractical because git plumbing was buried in the core lifecycle):
   - `workspace-provider.test.ts` - the opt-in gate (`worktreeAgents` includes / excludes the agent type), throw-on-creation-failure, born-complete `cwd`, and the dispose branch addendum, all without spinning up an `Agent`/`AgentManager`.
   - `config.test.ts` - global/project merge precedence, `sanitize` dropping non-array/non-string entries, malformed-file warning.
   - `index.test.ts` - registration at init against a fake `SubagentsService`, the no-service guard, shutdown unregister.
2. Existing tests that become redundant: the core `test/lifecycle/worktree-isolation.test.ts` (the collaborator is deleted) and the AgentManager/Agent worktree-path assertions - the behavior they covered now lives in the new package's provider tests.
   `test/lifecycle/worktree.test.ts` is not redundant but *relocates* - lift-and-shift into the new package (the git plumbing is unchanged).
3. Existing tests that must stay (genuinely exercise the surviving seam, not the deleted path): the #262 provider-consumption tests in `agent.test.ts` (provider supplies cwd; dispose addendum appended; `prepare` rejects → `markError`; no-provider → parent cwd) and the `agent-manager.test.ts` `registerWorkspaceProvider` tests.
   These assert the seam the new package plugs into.

## TDD Order

Track A (build the new package) is independent of Track B (core eviction) except that Step 1 unblocks Step 4's imports.
Build A first so the eviction in B never leaves worktree behavior unavailable; ship both before any release (no-vacant-hooks pairing).

1. **Re-export seam types from the core service** - `feat`.
   Add `Workspace`, `WorkspacePrepareContext`, `WorkspaceDisposeOutcome`, `WorkspaceDisposeResult` to the `service.ts` re-export (additive, non-breaking).
   Test: extend `test/service/service.test.ts` to assert the types are importable from the package root (a type-only import compiles).
   Suggested message: `feat: re-export Workspace seam types for the worktrees package`.

2. **Scaffold the package + lift-and-shift git plumbing** - `feat`.
   Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, `README.md`, `AGENTS.md`, `src/debug.ts`, and `src/worktree.ts` (verbatim from the core, imports re-pointed).
   Migrate `test/lifecycle/worktree.test.ts` → `test/worktree.test.ts`.
   Wire the workspace dependency (`@gotgenes/pi-subagents: "workspace:*"`) and run `pnpm install`.
   Green: `pnpm --filter @gotgenes/pi-subagents-worktrees test` passes.
   Suggested message: `feat: scaffold pi-subagents-worktrees with git worktree plumbing`.

3. **Config loader** - `feat`.
   `src/config.ts` + `test/config.test.ts` (merge precedence, sanitize, malformed-warn).
   Suggested message: `feat: add worktreeAgents config loader`.

4. **WorkspaceProvider implementation** - `feat`.
   `src/workspace-provider.ts` (`WorktreeWorkspaceProvider`, `WorktreeWorkspace`) + `test/workspace-provider.test.ts` (opt-in gate, throw-on-failure, born-complete cwd, dispose addendum); imports the seam types from `@gotgenes/pi-subagents`.
   Suggested message: `feat: implement git worktree WorkspaceProvider`.

5. **Extension entry** - `feat`.
   `src/index.ts` (config load, prune, register-at-init, shutdown unregister) + `test/index.test.ts` (fake-service registration, no-service guard, shutdown).
   Suggested message: `feat: register worktree provider at extension init`.

6. **Register the package in repo config** - `build`.
   `.pi/settings.json` (after pi-subagents, both lists) and `release-please-config.json` (component + exclude-paths).
   Verify `pnpm -r run check` and the workspace resolves the new package.
   Suggested message: `build: register pi-subagents-worktrees in settings and release-please`.

7. **Evict the tool-facing `isolation` axis from the core** - `feat!`.
   Remove `isolation` from `types.ts` (`IsolationMode`, `AgentConfig`, `AgentInvocation`), `invocation-config.ts`, `spawn-config.ts`, `agent-tool.ts` (param + description), `background-spawner.ts`/`foreground-runner.ts`, `display.ts`, `service.ts` (`SpawnOptions.isolation`), and `service-adapter.ts` (the `spawn` mapping).
   `AgentSpawnConfig.isolation` stays (optional, now set by no caller) so the legacy `AgentManager` path still type-checks - it is removed in Step 8.
   Update `spawn-config.test.ts`, `invocation-config.test.ts`, `agent-config-editor.test.ts`, `background-spawner.test.ts`, `foreground-runner.test.ts`.
   This is one commit because removing a field from `SpawnExecution`/`AgentInvocation` breaks every downstream object literal immediately (excess-property + missing-field checks).
   Suggested message: `feat!: drop the isolation spawn axis from the subagents API`.
   Run `pnpm --filter @gotgenes/pi-subagents run check` after.

8. **Delete the legacy worktree path from the core** - `feat!`.
   Remove the worktree wiring from `agent.ts` (field, import, fallback arms), `agent-manager.ts` (`worktrees`/`WorktreeIsolation`/`GitWorktreeManager`, `AgentSpawnConfig.isolation`, prune), and `index.ts` (`GitWorktreeManager`); remove `SubagentRecord.worktreeResult` (`service.ts`) and the `toSubagentRecord` writer (`service-adapter.ts`); delete `worktree.ts`, `worktree-isolation.ts`, `test/lifecycle/worktree.test.ts`, `test/lifecycle/worktree-isolation.test.ts`; update `agent.test.ts`, `agent-manager.test.ts`, `service-adapter.test.ts`, `manager-stubs.ts`.
   This is one commit because the `AgentInit.worktree` removal, the `AgentManager` construction sites, and the deleted modules are type-coupled.
   Suggested message: `feat!: remove git worktree isolation from the subagents core`.
   Run `pnpm -r run check && pnpm -r run test` after.

9. **Docs** - `docs`.
   Update `architecture.md` (mark Step 3 landed, drop the two modules + counts) and the `package-pi-subagents` skill (Lifecycle domain table + totals).
   Suggested message: `docs: record worktree eviction in the phase 16 roadmap`.

## Risks and Mitigations

- **No vacant hooks / split release (headline).**
  Releasing the core eviction without the new package strands worktree users.
  Mitigation: build Track A first and ship both halves together; the new package and the `feat!` core commits land in the same PR/release.
- **First intra-repo package import.**
  The new package imports from `@gotgenes/pi-subagents`, which `exports["."]` its TS source (`./src/service.ts`).
  Mitigation: add `@gotgenes/pi-subagents: "workspace:*"` as a devDependency (so tsc/vitest resolve the source via the pnpm symlink) and a `peerDependency` version range; verify `pnpm install` links it and `pnpm -r run check` passes before relying on the import.
- **Load-order dependency.**
  Register-at-init requires pi-subagents to publish its service first.
  Mitigation: list the new package after pi-subagents in both `settings.json` arrays (documented in the package README), and guard with `if (!svc) return` so a mis-order degrades to a no-op, not a crash.
- **Silent loss of opt-in granularity.**
  Dropping `isolation: "worktree"` from the tool means a previously per-spawn flag becomes per-agent-type config.
  Mitigation: document the migration in the package README (`worktreeAgents` list); the strict-throw behavior ensures a misconfigured-but-expected isolation fails loudly rather than running unisolated.
- **Crash-recovery prune relocation.**
  The core pruned orphaned worktrees in `AgentManager.dispose()`; that leaves the core.
  Mitigation: the new package prunes (best-effort) at extension init.

## Open Questions

- Should opt-in also support a per-agent frontmatter field (`worktree: true`) or a global "isolate all" switch, rather than only the `worktreeAgents` list?
  Deferred - the list is the minimal self-contained signal available from `WorkspacePrepareContext.agentType`; revisit if users want finer control.
- Should the new package ship a `package-pi-subagents-worktrees` skill and/or a `/agents`-style config editor?
  Deferred - not required by the acceptance criteria; add when the package stabilizes.
- Should `baseCwd` eventually derive from the parent `SessionContext.cwd` rather than `process.cwd()`?
  Inherited from #262's open question; revisit during born-complete work (#265).

[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md
