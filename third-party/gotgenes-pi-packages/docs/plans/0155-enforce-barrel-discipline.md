---
issue: 155
issue_title: "Enforce barrel file discipline across packages"
---

# Enforce barrel file discipline

## Problem Statement

`pnpm fallow dead-code` reports 10 unused re-exports across `pi-permission-system` (5) and `pi-subagents` (5).
In every case, barrel files re-export symbols that no consumer imports through the barrel — callers import directly from the defining module instead.
The re-exports are dead weight that inflates the public API surface and masks future dead-code detection.

## Goals

- Remove all 10 unused re-exports so `pnpm fallow dead-code` reports zero barrel-discipline violations in both packages.
- Keep every existing import site working — no consumer changes needed since nobody uses the barrels for these symbols.

## Non-Goals

- Redirect existing direct imports to go through barrels — the analysis shows these symbols are internal, not public API.
- Establish lint rules to enforce barrel discipline going forward (separate concern).

## Background

Both packages use barrel files (`index.ts` or a re-exporting module) to define a module's public API surface.
Fallow's dead-code analysis detects re-exports with zero consumers, which is exactly the signal that a barrel re-export is unnecessary.

### Affected symbols by barrel

| Package              | Barrel file                 | Dead re-exports                                                  | Why dead                                                                                            |
| -------------------- | --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| pi-permission-system | `src/handlers/index.ts`     | `shouldExposeTool`, `extractSkillNameFromInput`, `getEventInput` | Only used within their defining files; no external consumer                                         |
| pi-permission-system | `src/permission-manager.ts` | `isPermissionState`, `toRecord`                                  | All callers import from `./common` directly                                                         |
| pi-subagents         | `src/handlers/index.ts`     | `LifecycleManager`, `LifecycleRuntime`, `ToolStartRuntime`       | Handler-internal DI interfaces; tests import from defining modules                                  |
| pi-subagents         | `src/types.ts`              | `AgentRecordInit`, `AgentRecordStatus`                           | Only used within `agent-record.ts` and one test helper that imports from `agent-record.js` directly |

## Design Overview

This is a pure deletion task — no new code, no new modules, no behavioral changes.

For each dead re-export, the decision is "No, this is not part of the module's public API" because:

1. No consumer imports through the barrel.
2. The symbols are internal helpers (permission-system) or narrow DI interfaces (subagents) not intended for cross-module use.

Removing the re-exports narrows each barrel to only the symbols that consumers actually use through it.

## Module-Level Changes

### pi-permission-system

1. **`src/handlers/index.ts`** — Remove `shouldExposeTool` from the `./before-agent-start` re-export line (keep `AgentPrepHandler`).
   Remove `extractSkillNameFromInput` and `getEventInput` from the `./permission-gate-handler` re-export (keep `PermissionGateHandler`).
2. **`src/permission-manager.ts`** — Remove the `export { isPermissionState, toRecord } from "./common"` line and its associated comment block (lines 299–301).
   Also remove the now-unnecessary `import { isPermissionState } from "./common"` named import from the top if it is only used for the re-export.
   Note: `isPermissionState` is also used in `resolvePermissions()` (line 148), so the top-level import stays; only the re-export line and comment are removed.

### pi-subagents

1. **`src/handlers/index.ts`** — Remove `type LifecycleManager` and `type LifecycleRuntime` from the `./lifecycle.js` re-export line (keep `SessionLifecycleHandler`).
   Remove `type ToolStartRuntime` from the `./tool-start.js` re-export (keep `ToolStartHandler`).
2. **`src/types.ts`** — Remove the `export type { AgentRecordInit, AgentRecordStatus } from "./agent-record.js"` line.

## Test Impact Analysis

No test changes required.
All existing tests import directly from defining modules, not through the barrels being trimmed.
No new tests are needed — fallow's zero-violation output is the verification.

## TDD Order

This is a docs-only + deletion change with no new behavior to test.
Each step is a single commit verifiable by running `pnpm fallow dead-code` in the affected package.

1. **pi-permission-system barrel cleanup** — Remove the 5 dead re-exports from `src/handlers/index.ts` and `src/permission-manager.ts`.
   Verify: `pnpm tsc --noEmit` passes, `pnpm fallow dead-code` reports zero barrel violations.
   Commit: `refactor: remove dead barrel re-exports from pi-permission-system (#155)`

2. **pi-subagents barrel cleanup** — Remove the 5 dead re-exports from `src/handlers/index.ts` and `src/types.ts`.
   Verify: `pnpm tsc --noEmit` passes, `pnpm fallow dead-code` reports zero barrel violations.
   Commit: `refactor: remove dead barrel re-exports from pi-subagents (#155)`

## Risks and Mitigations

| Risk                                          | Mitigation                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A consumer we missed imports through a barrel | Grep confirmed zero barrel-path consumers for every symbol; `tsc --noEmit` will catch any missed import |
| Fallow suppression comments become stale      | No suppressions are involved — these are real unused re-exports, not suppressed ones                    |

## Open Questions

None — the analysis is exhaustive and the changes are mechanical.
