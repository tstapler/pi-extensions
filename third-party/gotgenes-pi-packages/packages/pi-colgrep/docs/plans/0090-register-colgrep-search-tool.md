---
issue: 90
issue_title: "Register `colgrep` search tool"
---

# Register colgrep search tool

## Problem Statement

The Pi agent has a built-in `grep` tool for exact pattern matching, but no way to perform semantic or intent-based code search.
[ColGrep](https://github.com/lightonai/next-plaid#colgrep) is a fully local semantic code search CLI built on ColBERT embeddings and tree-sitter parsing.
This plan registers a `colgrep` tool that exposes ColGrep's capabilities to the agent as a complement to `grep`.

## Goals

- Register a `colgrep` tool with the parameter schema specified in the issue.
- Execute the colgrep CLI via `pi.exec()` with `--json` for structured output.
- Parse JSON hits into a concise text format: `relative/path.ts:startLine-endLine [score=0.xxx]`.
- Truncate output using Pi's standard `truncateHead` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`.
- Write full output to a temp file when truncated.
- Implement TUI rendering (`renderCall`, `renderResult`) for the tool.
- On `session_start`, check colgrep availability and warn if absent.
- Include `promptSnippet` and `promptGuidelines` on the tool definition.

## Non-Goals

- Automatic reindexing on session start or file mutations (issue #91).
- Skill/prompt guidance for when to use colgrep vs grep (issue #92).
- Removing or deactivating the built-in `grep` — `colgrep` is a complement.

## Background

### Package state

Issue #89 (closed) scaffolded `packages/pi-colgrep` with a no-op `extension.ts` entry point, monorepo wiring, and CI integration.
There are no tests yet — vitest infrastructure must be added as part of this work.

### Pi SDK patterns

Tool registration uses `pi.registerTool()` with a TypeBox parameter schema, an `execute()` callback, and optional `renderCall`/`renderResult` for TUI rendering.
The `pi.exec(command, args, options)` API runs subprocesses and returns `{ stdout, stderr, code, killed }`.

Pi exports truncation utilities (`truncateHead`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `formatSize`) for capping tool output.
The built-in bash tool writes full output to a temp file when truncated and reports the path via `details.fullOutputPath`.

### Sibling package conventions

| Concern           | Convention                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tool files        | One file per tool in `src/tools/`, exporting a `register*()` function                                                            |
| Business logic    | Separate modules in `src/lib/` — no SDK imports in library code                                                                  |
| Result helpers    | `ok(text)` / `err(text)` wrappers for `AgentToolResult`                                                                          |
| Process execution | Accept an `exec` function as a dependency, not `pi.exec()` directly                                                              |
| Test directory    | `test/` (pi-autoformat, pi-subagents) or `tests/` (pi-github-tools)                                                              |
| TUI rendering     | `Text` from `@earendil-works/pi-tui`; `renderCall` returns a styled one-liner, `renderResult` supports collapsed/expanded states |

### ColGrep CLI

ColGrep's `--json` flag produces a JSON array of hits.
Each hit has this shape (relevant fields only):

```typescript
interface ColGrepJsonHit {
  unit: {
    name: string;
    qualified_name: string;
    file: string;       // absolute path
    line: number;       // 1-based start line
    end_line: number;   // 1-based end line
    language: string;
    unit_type: string;  // "function" | "class" | "rawcode" | …
    signature: string;
  };
  score: number;        // 0.0–1.0
}
```

### Dependency considerations

The tool definition needs `typebox` for the parameter schema (used by pi-github-tools as `"typebox": "^1.1.38"`).
TUI rendering needs `Text` from `@earendil-works/pi-tui` (used by pi-subagents as a peer + dev dependency).
Both must be added to `package.json`.

## Design Overview

### Architecture

The design follows pi-github-tools' delegation pattern: a thin tool registration layer delegates to pure library functions for argument construction, process execution, and output formatting.
SDK types stay out of library code; the `exec` function is injected as a narrow interface.

```text
extension.ts
  ├── registers tool  →  tools/colgrep.ts  →  lib/search.ts (orchestration)
  │                                          ├── lib/args.ts   (pure: build CLI args)
  │                                          └── lib/format.ts (pure: parse JSON, format hits)
  └── session_start   →  lib/availability.ts (check colgrep --version)
```

### Execution flow

```typescript
// tools/colgrep.ts — execute() pseudocode
const available = getAvailability();
if (!available) return err("colgrep is not installed. …");

const result = await runSearch(exec, params, cwd, signal);
if (result.error) return err(result.error);

const truncation = truncateHead(result.output);
if (truncation.truncated) {
  const tempPath = await writeTempFile(result.output);
  return ok(truncation.content + `\nFull output: ${tempPath}`);
}
return ok(result.output);
```

### Exec dependency injection

Library code accepts a narrow `Exec` type matching `pi.exec()`, keeping SDK imports out of `lib/`:

```typescript
type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;
```

### Parameter validation

At least one of `query` or `regex` is required.
The `execute()` callback validates this before invoking `runSearch()` and returns `err()` with a clear message if neither is provided.

### Graceful degradation

Tool registration happens synchronously in the extension function — it cannot be deferred until `session_start`.
The approach is:

1. Always register the tool.
2. On `session_start`, run `colgrep --version` via `pi.exec()` and cache the result.
3. Show a warning via `ctx.ui.notify("colgrep is not installed…", "warning")` if unavailable.
4. In `execute()`, check the cached availability state and return `err()` with install instructions if unavailable.

The availability state is stored in a module-level `AvailabilityState` object that `session_start` writes and `execute()` reads.

### Output format

Each hit is formatted as:

```text
relative/path.ts:startLine-endLine [score=0.016]
```

Absolute paths from colgrep JSON are converted to relative paths against the search directory (or cwd).
Scores are formatted to 3 decimal places.

When there are no results: `"No matches found"`.

### Truncation and temp files

Full formatted output is passed through `truncateHead()`.
When truncated, the full output is written to a temp file via `node:fs/promises` and the path is appended to the truncated result text, mirroring the bash tool's pattern.

### TUI rendering

`renderCall` shows a one-liner:

```text
▸ colgrep "semantic query" -e /regex/ in path (k=15)
```

`renderResult` collapsed shows the hit count; expanded shows the full result text:

```text
✓ 12 hits
```

The tool details type carries rendering metadata:

```typescript
interface ColGrepToolDetails {
  hitCount: number;
  command: string;
  truncated: boolean;
  fullOutputPath?: string;
}
```

### Prompt integration

The tool definition includes:

- `promptSnippet`: one-liner describing what colgrep does.
- `promptGuidelines`: 2–3 rules for effective usage (prefer `colgrep` for intent-based search, use `grep` for exact patterns, increase `-k` for broader exploration).

Detailed skill content is deferred to issue #92.

## Module-Level Changes

### New files

1. `src/tool-result.ts` — `ok(text)` / `err(text)` helpers for `AgentToolResult`, matching pi-github-tools.
2. `src/lib/exec.ts` — narrow `Exec` type definition used by all library modules.
3. `src/lib/args.ts` — `buildSearchArgs(params): string[]` — pure function that maps tool parameters to colgrep CLI flags; always includes `--json`.
4. `src/lib/format.ts` — `formatHit(hit, searchDir): string` and `formatResults(jsonOutput, searchDir): string` — pure JSON parsing and formatting.
5. `src/lib/availability.ts` — `checkAvailability(exec): Promise<AvailabilityResult>` and `AvailabilityState` holder for the cached result.
6. `src/lib/search.ts` — `runSearch(exec, params, cwd, signal): Promise<SearchResult>` — orchestrates arg building, exec, parsing, and formatting.
7. `src/tools/colgrep.ts` — `registerColGrep(pi, deps)` — tool definition with schema, execute, renderCall, renderResult.
8. `test/lib/args.test.ts` — unit tests for arg building.
9. `test/lib/format.test.ts` — unit tests for JSON parsing and hit formatting.
10. `test/lib/availability.test.ts` — unit tests for availability checking with mocked exec.
11. `test/lib/search.test.ts` — unit tests for search orchestration with mocked exec.
12. `test/tools/colgrep.test.ts` — unit tests for tool execute flow (availability gate, truncation, temp file, error handling).
13. `vitest.config.ts` — vitest configuration matching pi-autoformat's pattern.

### Modified files

1. `src/extension.ts` — import and call `registerColGrep(pi, deps)`, register `session_start` handler that calls `checkAvailability()` and caches the result.
2. `package.json` — add `typebox`, `@earendil-works/pi-tui` (peer + dev), `vitest` (dev), and `test`/`test:watch` scripts.

## Test Impact Analysis

This is entirely new code — there are no existing tests.
All tests are new unit tests covering the library modules and tool execute flow.

1. `args.test.ts` tests pure argument construction — various parameter combinations, the `--json` invariant, and the at-least-one-of-query-or-regex constraint.
2. `format.test.ts` tests pure formatting — single hit, multiple hits, empty array, path relativization, score formatting.
3. `availability.test.ts` tests the exec-based version check with mocked exec — available, not available, and exec failure cases.
4. `search.test.ts` tests the orchestration flow with mocked exec — successful search, empty results, non-zero exit code, and stderr handling.
5. `colgrep.test.ts` tests the tool's execute callback with mocked dependencies — availability gate, truncation + temp file creation, parameter validation, and error propagation.

## TDD Order

### Cycle 1 — test infrastructure

Add vitest config and test scripts to `package.json`.
No production code.

- Commit: `chore: add vitest test infrastructure for pi-colgrep (#90)`

### Cycle 2 — exec type + tool-result helpers

Add the narrow `Exec` type definition in `src/lib/exec.ts`.
Add `ok()`/`err()` helpers in `src/tool-result.ts`.
These are small, foundational pieces used by everything that follows.

- Commit: `feat: add exec type and tool-result helpers (#90)`

### Cycle 3 — argument builder

1. RED: `test/lib/args.test.ts` — test `buildSearchArgs()` for query-only, regex-only, both, all optional params, and the `--json` invariant.
2. GREEN: `src/lib/args.ts` — implement `buildSearchArgs()`.

- Commit: `feat: add colgrep CLI argument builder (#90)`

### Cycle 4 — result formatting

1. RED: `test/lib/format.test.ts` — test `formatHit()` for path relativization, score formatting, line range; test `formatResults()` for JSON parsing, multiple hits, empty results, and malformed JSON.
2. GREEN: `src/lib/format.ts` — implement `formatHit()` and `formatResults()`.

- Commit: `feat: add colgrep result formatting (#90)`

### Cycle 5 — availability check

1. RED: `test/lib/availability.test.ts` — test `checkAvailability()` with mocked exec for available (exit 0), not available (exit non-zero), and exec failure; test that `createAvailabilityState()` caches the result.
2. GREEN: `src/lib/availability.ts` — implement `checkAvailability()` and `AvailabilityState`.

- Commit: `feat: add colgrep availability check (#90)`

### Cycle 6 — search orchestration

1. RED: `test/lib/search.test.ts` — test `runSearch()` with mocked exec for successful search, empty results, non-zero exit code, and stderr reporting.
2. GREEN: `src/lib/search.ts` — implement `runSearch()` composing `buildSearchArgs()`, exec, and `formatResults()`.

- Commit: `feat: add colgrep search execution (#90)`

### Cycle 7 — tool definition and rendering

1. RED: `test/tools/colgrep.test.ts` — test the tool's `execute()` callback for: availability gate returns error when unavailable, parameter validation rejects missing query+regex, successful search returns `ok()`, truncation writes temp file and appends path, non-zero exit returns `err()`.
2. GREEN: `src/tools/colgrep.ts` — implement `registerColGrep()` with schema, execute, renderCall, renderResult.

- Commit: `feat: register colgrep search tool (#90)`

### Cycle 8 — extension wiring

Update `src/extension.ts` to:

1. Create the availability state.
2. Call `registerColGrep(pi, { exec, availability, cwd })`.
3. Register a `session_start` handler that runs the availability check, caches the result, and notifies the user if colgrep is absent.

Update `package.json` to add `typebox` and `@earendil-works/pi-tui` dependencies.
Run `pnpm install` to update the lockfile.
Verify `pnpm -C packages/pi-colgrep run check`, `lint`, and `test` all pass.

- Commit: `feat: wire colgrep tool and availability check into extension (#90)`

## Risks and Mitigations

| Risk                                                                               | Mitigation                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ColGrep's `--json` output shape may differ across versions or be undocumented      | Pin to the observed shape from colgrep 1.2.0; add defensive parsing in `formatResults()` that skips malformed hits rather than throwing.    |
| `pi.exec()` may not be available during extension init (only after session starts) | Tool registration is synchronous and doesn't call exec; the availability check runs in the `session_start` handler where exec is available. |
| Large codebases produce many hits, exceeding output limits                         | Truncation via `truncateHead()` caps output; full results saved to temp file; colgrep's own `-k` flag limits hits at the source.            |
| `@earendil-works/pi-tui` peer dependency version may diverge from SDK version      | Use the same version as pi-subagents (`>=0.75.0` peer, `0.75.4` dev) for consistency.                                                       |
| `context` (`-n`) flag may be a no-op when combined with `--json`                   | Accept and pass the parameter regardless; if ColGrep's JSON mode ignores it, no harm done. Document in Open Questions.                      |
| Test mocking for `pi.exec()` requires careful interface alignment                  | Use the narrow `Exec` type throughout; tests inject plain async functions, no SDK dependency in test code.                                  |

## Open Questions

- Does ColGrep's `--json` mode respect the `-n` (context lines) flag, or is it ignored?
  If ignored, the `context` parameter still does no harm but may confuse users.
  Defer investigation until implementation — verify empirically and document.
- Should the formatted output include the code unit's `signature` field alongside the location and score?
  The issue specifies the concise `path:start-end [score]` format; if the agent needs more context, it can use `read`.
  Revisit if user feedback suggests the concise format is insufficient.
