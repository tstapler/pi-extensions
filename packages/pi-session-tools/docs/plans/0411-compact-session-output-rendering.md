---
issue: 411
issue_title: "Render read_session / read_parent_session output compactly with Ctrl-O expansion"
---

# Compact, Ctrl-O-expandable rendering for the session-read tools

## Problem Statement

`read_session` and `read_parent_session` return the full formatted transcript as their tool `content` and set `details: undefined`, with no custom renderer.
Pi's default tool-result rendering prints the entire `content` text to the TUI scrollback, so on a long session the terminal fills with a wall of transcript.
The model genuinely needs the full transcript, but the terminal does not — it should show a compact one-line summary that expands with `Ctrl-O`, the way the builtin `read`/`bash`/`grep` tools behave.

## Goals

- Keep the full transcript flowing to the model unchanged via tool `content`.
- Show a compact one-line summary in the TUI by default: a total entry count plus a per-type breakdown (messages, tool calls, compactions, model changes).
- Expand to the full transcript on `Ctrl-O` (the `app.tools.expand` keybinding), with a visible expand hint on the collapsed row.
- Render the `read_parent_session` "not a subagent" / "parent file not found" cases — and the empty-filter result — as a short status line that expands to the same full message.

This change is **not breaking**: the model-facing `content` is unchanged, and `details` (previously `undefined`) is not visible to the model — only to the TUI and session persistence.

## Non-Goals

- Changing the transcript format itself, the `types`/`limit` filtering, or the tool descriptions sent to the model (the `content` output is untouched).
- Changing `set_session_name` / `get_session_name` rendering — their output is already a single short line.
- Adding any new tool parameters.

## Background

Relevant modules:

- `packages/pi-session-tools/src/index.ts` — registers all four tools via `pi.registerTool(defineTool({ ... }))`.
  Both read tools currently return `{ content: [{ type: "text", text: formatTranscript(entries) }], details: undefined }` and define no `renderResult`.
- `packages/pi-session-tools/src/format-transcript.ts` — exports `formatTranscript(entries)` and the `TranscriptEntry` structural supertype (`{ type: string }`).
  Private helpers already encode the entry-shape knowledge (which `message.role` values are turns, what a `toolCall` content part looks like, which metadata types exist).
- `packages/pi-session-tools/src/parent-session.ts` — `deriveParentSessionFile` / `readParentSessionEntries`.

Pi SDK mechanism (verified in `~/development/pi/pi`):

- `defineTool` (from `@earendil-works/pi-coding-agent`, already imported here) accepts optional `renderCall(args, theme, context)` and `renderResult(result, options, theme, context)` hooks (`src/core/extensions/types.ts`).
- `options.expanded` (`ToolRenderResultOptions`) reflects the `app.tools.expand` keybinding — `Ctrl-O` toggles it (`src/core/keybindings.ts`).
- The tool-execution component does **not** auto-add an expand hint; builtin `read` builds its own with `keyHint("app.tools.expand", "to expand")` (`src/modes/interactive/components/tool-execution.ts`, `keybinding-hints.ts`).
- `keyHint` and `keyText` are exported from `@earendil-works/pi-coding-agent`; `Text` is exported from `@earendil-works/pi-tui`; `Theme` is exported from `@earendil-works/pi-coding-agent`.

In-repo precedent: `packages/pi-colgrep/src/tools/colgrep.ts` already uses exactly this pattern — `execute` computes a count and stores it in `details`; `renderResult` reads `details` and returns a collapsed `✓ N hits` line or the full expanded output, switching on `options.expanded`.
`pi-colgrep` declares `@earendil-works/pi-tui` as both a `peerDependency` (`>=0.75.0`) and a pinned `devDependency` (`0.79.1`); `pi-subagents` and `pi-permission-system` follow the same convention.
The colgrep `renderResult`/`formatResult` glue is itself untested — only the pure content-formatting helpers in `src/lib/format.ts` are unit-tested.

AGENTS.md constraints that apply:

- pnpm only; when `package.json` deps change, run `pnpm install` and commit the updated `pnpm-lock.yaml` in the **same** commit (CI uses `--frozen-lockfile`).
- Run `pnpm fallow dead-code` locally before pushing — a newly added dependency can trip the dead-code gate.
- Conventional Commits; do not edit `CHANGELOG.md` (release-please owns it).

## Design Overview

The split mirrors the colgrep precedent: a **pure, fully tested** summary layer, and a **thin, theme-coupled** rendering layer that is exercised manually (it reaches global keybinding/theme state through `keyHint`/`keyText`, so it is not cleanly unit-testable — the same reason colgrep leaves its `renderResult` untested).

### Pure summary layer (new module `entry-summary.ts`)

```typescript
export interface SessionSummary {
  totalEntries: number;
  messages: number; // user + assistant turns
  toolCalls: number; // `toolCall` parts inside assistant messages
  compactions: number;
  modelChanges: number;
}

export function summarizeEntries(entries: TranscriptEntry[]): SessionSummary;

/** Plain, uncolored summary text, e.g. "142 entries — 120 messages, 18 tool calls, 2 compactions". */
export function formatSummaryText(summary: SessionSummary): string;
```

`summarizeEntries` walks the (already filtered/limited) entries once: `totalEntries` is `entries.length`; `messages` counts `message` entries whose `message.role` is `user` or `assistant`; `toolCalls` counts `toolCall` parts within assistant `content` arrays; `compactions` and `modelChanges` count those entry `type`s.
It imports `TranscriptEntry` from `format-transcript.ts` — the shared entry-shape type is the single point of de-duplication.
This is genuinely a different output from `formatTranscript` (counts, not text), so duplicating the small role/part traversal is correct per the code-design "structural reasons before extracting duplication" heuristic; both functions live in the same package and share `TranscriptEntry`.

`formatSummaryText` always emits the total (`"N entries"`, pluralized) and appends only the non-zero breakdown categories joined by `", "` after an em-dash:

- `0` entries → `"0 entries"`
- simple session → `"2 entries — 2 messages"`
- rich session → `"142 entries — 120 messages, 18 tool calls, 2 compactions, 2 model changes"`

Both functions are pure and unit-tested.

### Details shape

Both read tools stop returning `details: undefined` and instead return a discriminated `SessionToolDetails` (defined in `index.ts`, the SDK-consumer boundary):

```typescript
type SessionToolDetails =
  | { kind: "transcript"; summary: SessionSummary }
  | { kind: "status"; message: string };
```

- `read_session` always returns `{ kind: "transcript", summary: summarizeEntries(entries) }` (an empty filter yields `summary.totalEntries === 0`).
- `read_parent_session` returns `{ kind: "transcript", summary }` on success, and `{ kind: "status", message }` for the "not a subagent" and "parent file not found" cases.
  `content` keeps the existing full sentence for those cases; `details.message` holds a short collapsed label (e.g. `"Not running inside a subagent"`).

`SessionSummary` is plain numbers, so `details` stays JSON-serializable for session persistence.

### Thin rendering layer (in `index.ts`)

`renderResult(result, options, theme, context)` reads `result.details`:

- `kind: "transcript"`, collapsed → `✓ <formatSummaryText(summary)>` (success-colored icon, muted summary) followed by `keyHint("app.tools.expand", "to expand")`.
- `kind: "status"`, collapsed → `⚠ <details.message>` plus the same expand hint.
- expanded (either kind) → the full `content` text, line-colored with `theme.fg("toolOutput", …)`, matching colgrep's expanded branch.

A small `renderCall(args, theme, context)` renders a compact call row (`read session` / `read parent session` with a muted `types`/`limit` hint), consistent with colgrep's `renderCall`.

Both renderers follow the colgrep shape — reuse `context.lastComponent as Text` or `new Text("", 0, 0)`, call `text.setText(...)`, return it.
They contain no branching logic beyond reading `details` and `options.expanded`; all string-building lives in the tested `formatSummaryText`.

Consumer call site (TUI), confirming the Tell-Don't-Ask flow — the component asks the tool to render itself and passes the expand state inward:

```typescript
// tool-execution.ts (Pi runtime, illustrative)
const renderer = toolDefinition.renderResult;
renderer(result, { expanded: this.expanded, isPartial }, theme, ctx);
```

## Module-Level Changes

- **NEW** `packages/pi-session-tools/src/entry-summary.ts` — `SessionSummary`, `summarizeEntries`, `formatSummaryText`.
- **NEW** `packages/pi-session-tools/test/entry-summary.test.ts` — unit tests for the two pure functions.
- **CHANGED** `packages/pi-session-tools/src/index.ts`:
  - Import `Text` from `@earendil-works/pi-tui`; `Theme`, `keyHint`, `keyText` from `@earendil-works/pi-coding-agent`; `SessionSummary`/`summarizeEntries`/`formatSummaryText` from `./entry-summary.js`.
  - Define the `SessionToolDetails` union.
  - Type both read tools as `defineTool<typeof schema, SessionToolDetails>` and return populated `details` instead of `undefined`.
  - Add `renderResult` and `renderCall` to both read tools, plus private `formatResultText`/`formatCallText` helpers.
- **CHANGED** `packages/pi-session-tools/test/read-session.test.ts` — assert the `details` shape (transcript + summary counts) alongside the existing `content` assertions.
- **CHANGED** `packages/pi-session-tools/test/read-parent-session.test.ts` — assert `details` for the transcript case and the two `status` cases.
- **CHANGED** `packages/pi-session-tools/package.json` — add `@earendil-works/pi-tui` to `peerDependencies` (`>=0.75.0`) and `devDependencies` (`0.79.1`); commit the regenerated `pnpm-lock.yaml`.
- **CHANGED** `packages/pi-session-tools/README.md` — add a short note under `read_session` that the TUI shows a compact summary by default and expands to the full transcript with `Ctrl-O` (model output is unchanged).

No removed or renamed exports, so no symbol-grep sweep across `src/`, `test/`, or skills is required.
There is no `package-pi-session-tools` skill and no `docs/architecture/` layout listing for this package, so no skill or architecture-doc updates apply.

## Test Impact Analysis

1. **New tests the change enables.**
   `summarizeEntries` and `formatSummaryText` are new pure functions with their own `entry-summary.test.ts`: counting across mixed entry types, tool-call counting inside assistant content, zero-category omission, pluralization (`1 entry`/`2 entries`, `1 message`/`2 messages`, `1 tool call`/`2 tool calls`, `1 compaction`/`2 compactions`, `1 model change`/`2 model changes`), and the empty case.
2. **Tests that become redundant.**
   None.
   The existing `content`-text assertions remain the authority for the model-facing output and stay as-is.
3. **Tests that must stay as-is.**
   Every existing `read-session` / `read-parent-session` assertion on `content[0].text` — they pin the transcript invariant (model output unchanged) and must keep passing untouched.
   `renderResult`/`renderCall` are deliberately **not** unit-tested: they call `keyHint`/`keyText`, which read the global keybinding registry and theme singleton not initialized under vitest (the colgrep precedent leaves the equivalent glue untested for the same reason).
   Coverage comes from the pure `formatSummaryText`/`summarizeEntries` tests plus a manual TUI check (collapse shows the summary + expand hint; `Ctrl-O` shows the full transcript).

## Invariants at risk

- **Transcript content invariant (from plan 0251).**
  `read_session` / `read_parent_session` must return the full `formatTranscript(entries)` as `content`, with `types`/`limit` applied as pre-format filters.
  Pinned by the existing `content[0].text` assertions in `read-session.test.ts` and `read-parent-session.test.ts`.
  This plan only adds `details` and rendering; the steps below must leave those `content` assertions green.

## TDD Order

1. **`test` + `feat`: pure summary module.**
   Red: add `test/entry-summary.test.ts` covering `summarizeEntries` counts and `formatSummaryText` strings (breakdown, zero-omission, pluralization, empty).
   Green: implement `src/entry-summary.ts`.
   Commit: `feat(pi-session-tools): add session entry summary helper (#411)`.
2. **`test` + `feat`: populate `details` on both read tools.**
   Red: extend `read-session.test.ts` and `read-parent-session.test.ts` to assert `details` (`kind: "transcript"` + summary counts; `kind: "status"` + message for the two parent error cases), keeping the existing `content` assertions.
   Green: define `SessionToolDetails`, type both tools `defineTool<…, SessionToolDetails>`, and return populated `details`.
   This single file change keeps the suite green and the model output unchanged (default rendering still applies — valid intermediate state).
   Run `pnpm run check` after this step (shared-type change).
   Commit: `feat(pi-session-tools): attach summary details to session-read results (#411)`.
3. **`feat`: compact rendering glue.**
   Add `@earendil-works/pi-tui` to `package.json` (peer + dev), run `pnpm install`, and add `renderResult` + `renderCall` (with private `formatResultText`/`formatCallText` helpers) to both read tools, reading `details` and `options.expanded`.
   No new unit tests (theme/keybinding glue — see Test Impact Analysis); verify manually in the TUI.
   Commit (with `pnpm-lock.yaml`): `feat(pi-session-tools): render session-read output compactly with Ctrl-O expansion (#411)`.
4. **`docs`: README note.**
   Add the compact-rendering / `Ctrl-O` note under `read_session`.
   Commit: `docs(pi-session-tools): note compact TUI rendering for session-read tools (#411)`.

## Risks and Mitigations

- **`renderResult` is not unit-testable.**
  `keyHint`/`keyText` reach global state.
  Mitigation: keep all string-building in the tested `formatSummaryText`/`summarizeEntries`; keep the renderers as thin `details`/`expanded` switches; verify the TUI manually.
  This matches the established colgrep precedent.
- **Summary traversal drifting from `formatTranscript`.**
  Both interpret the same entry shapes.
  Mitigation: share the `TranscriptEntry` type, co-locate in the same package, and assert concrete counts in `entry-summary.test.ts`.
- **`@earendil-works/pi-tui` version skew.**
  Mitigation: pin `0.79.1` (dev) / `>=0.75.0` (peer), matching `pi-colgrep`, `pi-subagents`, and `pi-permission-system`; commit the lockfile in the same step; run `pnpm fallow dead-code` before pushing.
- **`details` serialization.**
  `SessionSummary` is plain numbers — JSON-safe for session persistence.

## Open Questions

- Whether the collapsed `read_parent_session` status row deserves a distinct icon/color from a transcript row, or the shared `⚠` is enough — defer to the manual TUI check in step 3; trivial to adjust.
