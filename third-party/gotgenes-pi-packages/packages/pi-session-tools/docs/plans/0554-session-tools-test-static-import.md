---
issue: 554
issue_title: "pi-session-tools: first test in read-session*/read-parent-session/list-session-files test files intermittently exceeds 5s testTimeout"
---

# Move `#src/index` import out of the per-test timed region

## Release Recommendation

**Release:** ship independently

This issue is not part of any architecture-roadmap batch, so it ships on its own schedule.
The change is test-only (a `test:` commit), which is a `hidden` changelog type — it will not cut a release by itself, and auto-batches into the next `feat:`/`fix:`/unhidden-`docs:` release rather than triggering one.

## Problem Statement

CI intermittently fails with vitest `Test timed out in 5000ms`, always on the **first `it()` block** of one of four tool test files in `packages/pi-session-tools`:

- `test/read-session.test.ts`
- `test/read-session-file.test.ts`
- `test/read-parent-session.test.ts`
- `test/list-session-files.test.ts` (same pattern, has not failed yet but rides the same edge)

Each `it()` block opens with `const { default: sessionTools } = await import("#src/index");`.
`src/index.ts` transitively imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`.
Because vitest isolates each test file into its own module registry, the transform+resolve cost of that import is paid fresh on the **first** call in each file — and that cost is measured at 78–98% of the default 5000ms `testTimeout` even on non-degraded runs.
Any additional contention (parallel `pnpm -r run test`, a slow runner, a GC pause) tips it over.
The 2026-07-07 19:21 UTC failure reproduced on a fully-operational platform, ruling out an Actions incident as the sole cause.

The tests are racing a per-test timer against a module-resolution cost that has nothing to do with the behavior under test.

## Goals

- Remove the `#src/index` import from the per-test timed region in all four tool test files so its transform/resolve cost is paid once during vitest's collection phase, outside `testTimeout`.
- Preserve every existing test's behavior and assertions exactly, including the per-test `node:fs` mock reconfiguration.
- Verify empirically that a static top-level `import sessionTools from "#src/index"` still receives the hoisted `vi.mock("node:fs", …)` mock before rolling the change across all files.

## Non-Goals

- Do **not** add a `testTimeout` override to `vitest.config.ts` or any file — the primary fix removes the cost from the timed region entirely, so a timeout bump is unnecessary (see Risks for the fallback).
- Do **not** touch `src/` — this is a test-file-only change; no production behavior changes.
- Do **not** convert `test/session-file.test.ts`, `test/parent-session.test.ts`, `test/entry-summary.test.ts`, or `test/format-transcript.test.ts`.
  They import individual `#src/*` modules (or none) that pull only node built-ins, not the heavy `@earendil-works/*` packages, so they do not ride the timeout edge.
  `session-file.test.ts` uses per-test `await import("#src/session-file")` but that module imports only `node:fs`/`node:os`/`node:path`; it is out of scope.

## Background

Relevant files:

- `packages/pi-session-tools/src/index.ts` — default-exports `sessionTools(pi: ExtensionAPI): void`, a pure factory with no module-level mutable state.
  It imports `@earendil-works/pi-ai` (`Type`), `@earendil-works/pi-coding-agent` (`defineTool`, `keyHint`, types), and `@earendil-works/pi-tui` (`Text`) — the transitive cost the tests pay.
- `packages/pi-session-tools/test/read-session.test.ts` — no `vi.mock`; the tool reads from an injected `sessionManager`, so a static import is trivially safe here.
- `packages/pi-session-tools/test/read-session-file.test.ts`, `test/read-parent-session.test.ts`, `test/list-session-files.test.ts` — each declares `vi.hoisted(() => vi.fn(...))` stubs and a `vi.mock("node:fs", …)` factory, then reconfigures the stubs per test with `.mockReturnValue(...)`/`.mockImplementation(...)`.

Vitest hoists `vi.mock()` and `vi.hoisted()` above all imports at transform time, regardless of where they appear in the source.
A static `import sessionTools from "#src/index"` therefore evaluates **after** the mock is registered, so `src/index.ts`'s transitive `node:fs` import still receives the mock.
The per-test `.mockReturnValue(...)` reconfiguration is unaffected: the stubs are singleton `vi.fn()` instances that `src/index.ts` calls at `execute()` time (runtime), not at import time.
This is the standard vitest pattern — the current dynamic-import-per-test form is a jest-era habit that vitest's hoisting makes unnecessary.

`captureTools(sessionTools)` re-runs the factory in each test, building a fresh tool `Map`, so sharing a single imported `sessionTools` reference across tests introduces no shared state.

Constraint from AGENTS.md / testing skill: vitest uses esbuild and does not typecheck, so run `pnpm run check` (`tsc --noEmit`) for any type-touching change, and run the full package suite (not just the edited file) before committing.

## Design Overview

For each of the four files, replace the repeated per-test dynamic import with a single static top-level value import, then delete every `const { default: sessionTools } = await import("#src/index");` line inside the `it()` bodies.

Top of each file (added alongside the existing imports):

```typescript
import sessionTools from "#src/index";
```

The mocked files keep their `vi.hoisted(...)` stubs and `vi.mock("node:fs", …)` block exactly as-is — vitest hoists them above the new static import, so the mock still applies.
Inside each `it()`, the body goes from:

```typescript
const { default: sessionTools } = await import("#src/index");
const tools = captureTools(sessionTools);
```

to simply:

```typescript
const tools = captureTools(sessionTools);
```

Every remaining line (mock reconfiguration, `execute(...)` calls, assertions) is untouched.
The `it()` callbacks stay `async` — they still `await tool.execute(...)`.

Edge cases:

- `list-session-files.test.ts` has tests that `await import("node:os")` / `await import("node:path")` for building expected paths, and one that uses `vi.spyOn(process, "cwd")`.
  These are unrelated to the `#src/index` import and stay as-is.
- `read-session.test.ts` has no `node:fs` mock; the static import is unconditionally correct there.

## Module-Level Changes

- `packages/pi-session-tools/test/read-session-file.test.ts` — add top-level `import sessionTools from "#src/index";`; remove the six per-test `const { default: sessionTools } = await import("#src/index");` lines.
- `packages/pi-session-tools/test/read-parent-session.test.ts` — same: add the static import; remove the eight per-test dynamic-import lines.
- `packages/pi-session-tools/test/list-session-files.test.ts` — same: add the static import; remove the five per-test dynamic-import lines (leave the `node:os`/`node:path` dynamic imports and the `process.cwd` spy).
- `packages/pi-session-tools/test/read-session.test.ts` — same: add the static import; remove the seven per-test dynamic-import lines.

No `src/`, README, architecture, skill, or config files reference this import pattern — it is an internal test idiom, so no doc updates are required.
Grep confirmed only these four test files import `#src/index`.

## Test Impact Analysis

This is a mechanical test-refactor, not a production-code extraction, so the analysis is narrow:

1. **New tests enabled** — none; no new behavior is introduced.
2. **Redundant tests** — none removed; every existing `it()` is preserved verbatim minus its dynamic-import line.
3. **Tests that must stay as-is** — all of them.
   The assertions, mock reconfigurations, and `execute(...)` calls are the behavior under test and remain unchanged.
   The change only moves *where* `sessionTools` is bound (module scope vs. per-test), not *what* is exercised.

The suite passing after the change is itself the proof that the hoisted `node:fs` mock still applies to the statically-imported module.

## Invariants at risk

The behavioral invariant is that each tool test observes the mocked `node:fs` (never the real filesystem) and its per-test `.mockReturnValue(...)` configuration.
This is pinned by the existing assertions in the three mocked files — e.g. `read_session_file` returning `"Session file not found: …"` when `mockExistsSync` returns `false`, and returning a transcript when it returns `true` with `mockReadFileSync` content.
If a static import ever bypassed the mock, these tests would read the real filesystem and fail.
No new test is needed; the current suite is the guard, which is exactly why Step 1 converts a mocked file first and runs it in isolation.

## TDD Order

This is a refactor with no behavior change, so each step is: apply the mechanical edit, run the suite green, commit.
The "test" is the existing suite continuing to pass (proving the mock still applies and no timing regression).
All commits are `test:`.

1. **Verify the hoisting assumption on one mocked file.**
   Convert `test/read-session-file.test.ts` to a static top-level `import sessionTools from "#src/index"`, removing the per-test dynamic imports.
   Run `pnpm --filter @gotgenes/pi-session-tools exec vitest run test/read-session-file.test.ts` and confirm all tests pass — this proves the hoisted `vi.mock("node:fs", …)` still applies to the statically-imported module.
   Run `pnpm run check`.
   Commit: `test(pi-session-tools): hoist index import out of read_session_file test bodies (#554)`.
2. **Roll the change across the remaining three files.**
   Convert `test/read-parent-session.test.ts`, `test/list-session-files.test.ts`, and `test/read-session.test.ts` the same way.
   Run the full package suite `pnpm --filter @gotgenes/pi-session-tools exec vitest run` and `pnpm run check`.
   Commit: `test(pi-session-tools): hoist index import out of remaining session-tool test bodies (#554)`.

Steps could be squashed into one, but Step 1 isolates the empirical verification (the one genuinely uncertain assumption) before the mechanical rollout.

## Risks and Mitigations

- **Risk: the static import does not receive the `node:fs` mock** (the assumption is wrong).
  Mitigation: Step 1 verifies this on a mocked file in isolation before any rollout; if the mocked file's tests fail, stop and reconsider.
  This is unlikely — hoisting static imports below `vi.mock` is vitest's documented, default behavior.
- **Risk: the transform cost merely shifts to collection and CI still times out.**
  Mitigation: `testTimeout` wraps only the test-body execution, not collection/transform, so the cost leaves the timed region entirely.
  If, contrary to expectation, CI still flakes, the documented fallback is a scoped `testTimeout` bump for these files or a `beforeAll` hook — but this is a Non-Goal unless the primary fix proves insufficient in CI.
- **Risk: dropping an edit in the multi-file Step 2 batch leaves a stale dynamic import.**
  Mitigation: after Step 2, `grep -rn 'await import("#src/index")' test/` must return nothing; the full suite must be green.

## Open Questions

None.
The fix path is unambiguous and the only uncertain assumption (mock hoisting under a static import) is verified empirically in Step 1.
