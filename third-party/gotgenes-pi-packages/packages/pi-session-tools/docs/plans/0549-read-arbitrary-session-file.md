---
issue: 549
issue_title: "pi-session-tools: read an arbitrary session file by path"
---

# Read an arbitrary session file by path

## Release Recommendation

**Release:** ship independently

`pi-session-tools` has no `docs/architecture/` roadmap and this issue is not a member of any release batch, so it ships on its own.
The change adds two self-contained tools plus a supporting module; it is additive and independently useful.

## Problem Statement

`read_session` reads only the current session (`ctx.sessionManager.getEntries()`, no path) and `read_parent_session` reaches only a *parent* session via the subagent `tasks/` directory convention.
Neither can read a **sibling** session.

This gap surfaced in the parallel-worktree ship flow (Refs #546).
The final `/retro` now runs in the **root** session after `/land-worktree`, but the implementation happened in a separate **peer worktree** session.
That peer transcript is a sibling of the root session, so neither session tool can reach it — the root retro falls back to stage breadcrumbs plus raw `Read`/`Bash` on the peer `.jsonl`.

The peer transcript survives worktree teardown (sessions live under `~/.pi/agent/sessions/<encoded-cwd>/`), so the data is on disk — just not in the clean transcript + summary format `read_session` produces.
The interim mitigation (Refs #546) records the peer session path in the `/ship-worktree` breadcrumb and points `/retro` at it, but the retro still gets raw JSONL rather than the rendered transcript.

## Goals

- Add a `read_session_file` tool that reads an arbitrary session file **by path** and renders it through the same pipeline as `read_session` — the numbered `formatTranscript` plus the `summarizeEntries` summary, including the effective-model-change reporting from #546.
- Add a `list_session_files` discovery tool that, given a required `cwd`, encodes it to its `--<dashed-cwd>--` session directory and returns the directory plus the `.jsonl` files in it, newest first, so a caller does not hand-roll the encoding.
- Reuse the existing entry-reader, filter/limit, `formatTranscript`, and `summarizeEntries` logic without duplicating it a third time.
- Adopt the new tools at their one real consumer: replace the raw `Read`/`Bash` peer-transcript guidance in `.pi/prompts/retro.md` (and the breadcrumb note in `.pi/prompts/ship-worktree.md`) with the rendered `read_session_file` path.

This change is **not breaking**.
It adds two new tools and a new module; no existing tool signature, output shape, or default changes.
The `SessionToolDetails` union gains a new `listing` variant, but no existing variant is removed or altered.
The suggested commit types are `refactor:` (one internal extraction) and `feat:` (the new capability).

## Non-Goals

- **No path allowlist / sandbox.**
  Per the operator's decision, `read_session_file` accepts any readable path and returns a clear status message when the file is missing.
  The agent already has `Read`/`Bash` on any file, so a `~/.pi/agent/sessions/` allowlist would add friction without a real security boundary.
- **No `cwd` default on `list_session_files`.**
  `cwd` is a required argument; the sibling-session use case always targets a different directory than the current session, and defaulting to `process.cwd()` would silently return the current session's own directory.
- **No change to `read_session` / `read_parent_session` behavior or output.**
  They are refactored to call a shared result builder, but their `content` and `details` stay byte-for-byte identical (pinned by existing tests).
- **No change to `set_session_name` / `get_session_name`, the `types`/`limit` semantics, or the `formatTranscript` / `summarizeEntries` output.**

## Background

Relevant modules (all in `packages/pi-session-tools/`):

- `src/index.ts` — registers the four tools.
  `read_session` and `read_parent_session` each inline the same block: filter by `types`, slice by `limit`, `summarizeEntries`, `formatTranscript`, wrap in a `{ kind: "transcript" }` result.
  `read_parent_session` additionally derives the parent file and returns a `{ kind: "status" }` result on the two failure paths.
  The `SessionToolDetails` union is `{ kind: "transcript" } | { kind: "status" }`; `formatCallText` / `formatResultText` render the compact TUI rows.
- `src/parent-session.ts` — `deriveParentSessionFile(sessionFile)` (parent-via-`tasks/` convention) and `readParentSessionEntries(file)`.
  Despite its name, `readParentSessionEntries` is already a **generic** JSONL session-file reader: it reads a path, splits lines, skips the `type: "session"` header, tolerates malformed lines, and returns `undefined` if the file is missing.
  It is imported only by `index.ts`.
- `src/format-transcript.ts` — `formatTranscript(entries)` and the shared `collectEffectiveModelChangeIndices` helper (#546); exports the `TranscriptEntry` supertype (`{ type: string }`).
- `src/entry-summary.ts` — `summarizeEntries(entries)` → `SessionSummary`, plus `formatSummaryText`.

Session-directory encoding (from the interim `/ship-worktree` `sed` one-liner and the on-disk layout): a cwd maps to a directory named `--<cwd with leading slash stripped and every `/` replaced by `-`>--`.
For example `/Users/chris/development/pi/pi-packages` → `--Users-chris-development-pi-pi-packages--`, stored under `~/.pi/agent/sessions/`.
The scheme is lossy (a literal `-` in a path is indistinguishable from a `/`), but this plan must **match** Pi's existing encoding, not improve it.

AGENTS.md constraints that apply:

- pnpm only; no dependency changes, so no lockfile churn.
- Conventional Commits; do not edit `CHANGELOG.md` (release-please owns it).
- The `files` allowlist ships `src` recursively, so the new `src/session-file.ts` ships without a `package.json` edit.
- Run `pnpm fallow dead-code` before pushing — the moved/renamed reader keeps a live consumer, so it should not flag.

## Design Overview

### New module: `src/session-file.ts`

The generic reader is renamed and moved here (out of the parent-specific `parent-session.ts`), joined by the new path helpers.
Keeping "read/locate a session file by path or cwd" in one cohesive module leaves `parent-session.ts` owning only the parent-derivation convention.

```typescript
export interface ParsedEntry {
  type: string;
  [key: string]: unknown;
}

/** Read + parse JSONL session entries from a file, skipping the `type: "session"` header. Returns undefined if the file does not exist. */
export function readSessionFileEntries(file: string): ParsedEntry[] | undefined;

/** Encode a cwd to Pi's session-directory name: strip the leading `/`, replace every `/` with `-`, wrap in `--…--`. */
export function encodeCwdToSessionDirName(cwd: string): string;

/**
 * Derive the sessions root from the current session file.
 * Finds the current cwd's encoded segment (`/--…--/`) in `currentSessionFile` and returns the prefix before it.
 * Falls back to `join(homedir(), ".pi", "agent", "sessions")` when the segment is absent or the file is undefined.
 */
export function deriveSessionsRoot(
  currentSessionFile: string | undefined,
  currentCwd: string,
): string;

/** List absolute `.jsonl` paths in a directory, newest first (by mtime, tie-broken by name). Returns [] if the directory is missing. */
export function listSessionFiles(directory: string): string[];
```

`readSessionFileEntries` is a verbatim move of the current `readParentSessionEntries` body (rename only).
`encodeCwdToSessionDirName` and `deriveSessionsRoot` are pure and trivially testable.
`deriveSessionsRoot` uses `process.cwd()`'s encoding to locate the sessions root from the **current** session file, so it works for both a normal session (`<root>/--enc--/<ts>.jsonl`) and a subagent (`<root>/--enc--/<name>/tasks/<child>.jsonl`) — the encoded segment is a prefix in both — and never hard-codes the config-dir location.
`listSessionFiles` does `readdirSync` + `statSync`, filtering to `.jsonl`; a missing directory yields `[]` (not an error), so an unknown cwd reports "no sessions" cleanly.

### Shared result builder (internal, `index.ts`)

The filter → limit → summarize → format block is currently inlined in two tools and would be a third time.
All three want identical semantics (no differing guards or lifecycle), so extract one helper:

```typescript
function buildTranscriptResult(
  allEntries: TranscriptEntry[],
  params: { types?: string[]; limit?: number },
): { content: [{ type: "text"; text: string }]; details: SessionToolDetails } {
  let entries = allEntries;
  if (params.types) {
    const allowed = new Set(params.types);
    entries = entries.filter((e) => allowed.has(e.type));
  }
  if (params.limit != null) entries = entries.slice(-params.limit);
  const summary = summarizeEntries(entries);
  return {
    content: [{ type: "text", text: formatTranscript(entries) }],
    details: { kind: "transcript", summary },
  };
}
```

`read_session`, `read_parent_session`, and `read_session_file` all call it for the success path; `read_parent_session` keeps its own `{ kind: "status" }` short-circuits.

### `read_session_file` tool

Parameters `{ path: string, types?: string[], limit?: number }`.

```typescript
async execute(_id, params, _s, _u, _ctx) {
  const allEntries = readSessionFileEntries(params.path);
  if (!allEntries) {
    return {
      content: [{ type: "text", text: `Session file not found: ${params.path}` }],
      details: { kind: "status", message: `Session file not found: ${params.path}` },
    };
  }
  return buildTranscriptResult(allEntries, params);
}
```

It needs no `ctx` (the path is absolute), matching the operator's "accept any readable path" decision.

### `list_session_files` tool

Parameter `{ cwd: string }` (required).
It composes the pure helpers with the current session file from `ctx`:

```typescript
async execute(_id, params, _s, _u, ctx) {
  const root = deriveSessionsRoot(ctx.sessionManager.getSessionFile(), process.cwd());
  const directory = join(root, encodeCwdToSessionDirName(params.cwd));
  const files = listSessionFiles(directory);
  return {
    content: [{ type: "text", text: renderListing(directory, files) }],
    details: { kind: "listing", directory, count: files.length },
  };
}
```

`renderListing` produces a `text` body: a `Session directory: <dir>` line, then either `<N> session file(s), newest first:` with one absolute path per indented line, or `No session files found.` when empty.
The returned `files` are absolute paths ready to feed straight into `read_session_file`.

### `SessionToolDetails` and renderers

Extend the union with the listing variant (no existing variant changes):

```typescript
type SessionToolDetails =
  | { kind: "transcript"; summary: SessionSummary }
  | { kind: "status"; message: string }
  | { kind: "listing"; directory: string; count: number };
```

`formatResultText` gains a `kind === "listing"` collapsed branch (e.g. `✓ 3 session files in <dir>`); the expanded view already prints the tool's `content` text, so it needs no listing-specific expansion.
`formatCallText` gains an optional `path` hint (for `read_session_file`) and a `cwd` hint (for `list_session_files`) alongside the existing `types`/`limit` hints.

### Consumer call-site sketch (Tell-Don't-Ask / LoD check)

The root `/retro`, given the peer worktree path from the ship breadcrumb:

```typescript
list_session_files({ cwd: "/Users/chris/development/pi/pi-packages-worktrees/issue-546" });
// → details.directory + content lists ".../--…issue-546--/2026-…Z_.jsonl" newest first
read_session_file({ path: "<newest path>", types: ["message", "model_change"] });
// → rendered transcript + summary, identical format to read_session
```

`list_session_files` reads exactly one field off `ctx` (`sessionManager.getSessionFile()`) — the same LoD depth as the existing tools — and delegates all logic to pure, value-returning helpers.
No helper mutates an argument or reaches through another; each takes inputs and returns a value.

## Module-Level Changes

- **NEW** `packages/pi-session-tools/src/session-file.ts` — `ParsedEntry`, `readSessionFileEntries` (moved + renamed from `parent-session.ts`), `encodeCwdToSessionDirName`, `deriveSessionsRoot`, `listSessionFiles`.
- **CHANGED** `packages/pi-session-tools/src/parent-session.ts` — remove `readParentSessionEntries` and `ParsedEntry` (moved to `session-file.ts`); keep `deriveParentSessionFile` and its docblock.
- **CHANGED** `packages/pi-session-tools/src/index.ts`:
  - Import `readSessionFileEntries` (for `read_parent_session`), plus `encodeCwdToSessionDirName`, `deriveSessionsRoot`, `listSessionFiles` from `./session-file.js`.
  - Extract `buildTranscriptResult`; refactor `read_session` and `read_parent_session` to call it (output unchanged).
  - Register `read_session_file` and `list_session_files`.
  - Extend `SessionToolDetails` with the `listing` variant; add the listing branch to `formatResultText` and `path`/`cwd` hints to `formatCallText`.
  - Update the header docblock's tool list.
- **NEW** `packages/pi-session-tools/test/session-file.test.ts` — unit tests for all four `session-file.ts` exports.
- **NEW** `packages/pi-session-tools/test/read-session-file.test.ts` — tool-level tests (success transcript, file-not-found status, `types`/`limit` filtering, `details`).
- **NEW** `packages/pi-session-tools/test/list-session-files.test.ts` — tool-level tests (listing text + `details`, empty directory).
- **CHANGED** `packages/pi-session-tools/README.md` — add `read_session_file` and `list_session_files` sections and their `## Tools` entries.
- **CHANGED** `.pi/prompts/retro.md` — replace the interim raw `Read`/`Bash` peer-transcript guidance (Refs #546) with `read_session_file` (and `list_session_files` when only the peer cwd is known).
- **CHANGED** `.pi/prompts/ship-worktree.md` — reframe the breadcrumb note so the recorded peer path is read via `read_session_file` at retro time rather than raw JSONL.

Grep confirms `readParentSessionEntries` has exactly one call site (`index.ts`) and is directly referenced in no test — `read-parent-session.test.ts` exercises it only through the tool via a `node:fs` module mock, so the rename does not touch that file.
`parent-session.test.ts` tests only `deriveParentSessionFile`, so it is unaffected by the move.
There is no `package-pi-session-tools` skill and no `docs/architecture/` for this package, so no internal-doc symbol updates are required beyond the README and the two `.pi/prompts/` consumers.

## Test Impact Analysis

1. **New tests the change enables.**
   Splitting the reader and path logic into `session-file.ts` makes four pure/near-pure functions unit-testable in isolation: `readSessionFileEntries` (previously only covered transitively through the parent tool), `encodeCwdToSessionDirName`, `deriveSessionsRoot` (segment-found and homedir-fallback branches), and `listSessionFiles` (newest-first order, `.jsonl` filter, missing-directory `[]`).
   `buildTranscriptResult` is exercised by three tool test suites.
2. **Tests that become redundant.**
   None.
   The existing `read-session` / `read-parent-session` tool tests continue to pin the transcript-content and `details` invariants — the extraction must keep them green, so they are the safety net for the refactor, not redundant with the new lower-level tests.
3. **Tests that must stay as-is.**
   Every `content[0].text` and `details` assertion in `read-session.test.ts` / `read-parent-session.test.ts`, and the `types: ["model_change"]` filter test — they guarantee `buildTranscriptResult` reproduces the current output exactly and that #546's effective-model-change behavior still flows through.
   `parent-session.test.ts` stays unchanged (only `deriveParentSessionFile` remains there).

## Invariants at risk

The `buildTranscriptResult` extraction touches the surface refined by three prior plans; each invariant stays pinned by an existing test that must remain green through the refactor:

- **Transcript-content invariant** (`0251-transcript-formatted-output.md`, refined by `0411`): the read tools return the full `formatTranscript(entries)` as `content`.
  Pinned by the `content[0].text` assertions in `read-session.test.ts` / `read-parent-session.test.ts`.
- **Summary-shape invariant** (`0411-compact-session-output-rendering.md`): `SessionSummary` keeps its five numeric fields and the `{ kind: "transcript"; summary }` details shape.
  Pinned by the `details` assertions in both tool suites.
  Adding the `listing` variant to the union does not alter the `transcript` variant.
- **Effective-model-change invariant** (`0546-effective-model-change-reporting.md`): `modelChanges` counts only effective switches and phantom `[model change]` lines are suppressed.
  Pinned by `entry-summary.test.ts` / `format-transcript.test.ts` and the `read-session` details fixture — all reached through `buildTranscriptResult` unchanged.

## TDD Order

1. **`refactor`: extract `buildTranscriptResult`.**
   No new test.
   Green safety net: the existing `read-session` / `read-parent-session` suites.
   Extract the shared filter/limit/summarize/format block in `index.ts` and route both existing tools through it; confirm every existing assertion still passes and `pnpm run check` is clean.
   Commit: `refactor(pi-session-tools): extract shared transcript result builder`.
2. **`feat`: `session-file.ts` module (reader move + path helpers).**
   Red: add `test/session-file.test.ts` covering `readSessionFileEntries`, `encodeCwdToSessionDirName`, `deriveSessionsRoot` (both branches), and `listSessionFiles`.
   Green: create `src/session-file.ts` (move + rename the reader with `ParsedEntry`, add the three path helpers); remove the moved exports from `src/parent-session.ts`; update the `read_parent_session` import in `src/index.ts`.
   The export removal breaks the `index.ts` import at the type level, so the move, the new helpers, and the call-site update land in this one step.
   Run `pnpm run check`.
   Commit: `feat(pi-session-tools): add session-file locating and reading helpers (#549)`.
3. **`feat`: `read_session_file` tool.**
   Red: add `test/read-session-file.test.ts` (success transcript, file-not-found status, `types`/`limit` filtering, `details`), mocking `node:fs` like the sibling suites.
   Green: register `read_session_file` in `index.ts` using `readSessionFileEntries` + `buildTranscriptResult`; add the `path` hint to `formatCallText`.
   Commit: `feat(pi-session-tools): add read_session_file tool (#549)`.
4. **`feat`: `list_session_files` tool.**
   Red: add `test/list-session-files.test.ts` (listing text + `details` newest-first; empty directory → `count: 0`).
   Green: extend `SessionToolDetails` with the `listing` variant; register `list_session_files`; add the listing branch to `formatResultText` and the `cwd` hint to `formatCallText`.
   Commit: `feat(pi-session-tools): add list_session_files discovery tool (#549)`.
5. **`docs`: README.**
   Add the `read_session_file` and `list_session_files` sections and `## Tools` entries.
   Commit: `docs(pi-session-tools): document read_session_file and list_session_files (#549)`.
6. **`docs`: adopt the tools in the worktree prompts.**
   Replace the interim raw `Read`/`Bash` peer-transcript guidance in `.pi/prompts/retro.md` and reframe the breadcrumb note in `.pi/prompts/ship-worktree.md` to use `read_session_file` (Refs #546).
   These files are outside the package, so they do not affect the release; commit them separately.
   Commit: `docs: read peer worktree transcript via read_session_file (#549)`.

## Risks and Mitigations

- **Sessions root wrongly derived under a relocated config dir.**
  `deriveSessionsRoot` locates the root from the current session file via the current cwd's encoded segment, so it tracks a relocated `~/.pi/agent` automatically; the `homedir()` default is only a fallback for the segment-absent case.
  Both branches are unit-tested.
- **Refactor silently changing existing output.**
  `buildTranscriptResult` performs the identical operations in the identical order; the unchanged `read-session` / `read-parent-session` assertions are the regression net (step 1 lands before any behavior is added).
- **Newest-first ordering wrong for a resumed session.**
  Sorting by `mtime` (not the filename timestamp) reflects last activity, which is what "the peer's latest session" means; pinned by a `listSessionFiles` ordering test with mocked `statSync` mtimes.
- **Encoding drift from Pi's scheme.**
  `encodeCwdToSessionDirName` reproduces the exact `--…--` slash-to-dash scheme observed on disk and in the interim `sed` one-liner; a unit test pins a representative cwd.

## Open Questions

None.
The three design choices the issue raised are resolved: a separate `read_session_file` tool (not a `read_session` param); accept any readable path (no allowlist); and include a discovery helper now as a separate `list_session_files` tool taking a required `cwd`.
