---
issue: 251
issue_title: "Return transcript-formatted output from read_session and read_parent_session"
---

# Transcript-formatted output for session tools

## Problem Statement

`read_session` and `read_parent_session` return raw session entries via `JSON.stringify(entries, null, 2)`, dumping every field of every entry into the agent's context window.
This is massively wasteful — entries include full tool result bodies (file contents, command output), thinking content, image data, token usage stats, and tree-structure metadata that no known consumer needs.
The primary consumer (retro diagnostic lenses) needs only the conversation flow: who said what, which tools ran, and what happened structurally (compaction, model changes).

## Goals

- Replace raw JSON output with a structured transcript format that preserves conversation flow while dropping noise.
- Extract the formatter as a shared, tested module used by both `read_session` and `read_parent_session`.
- Fold tool results into their corresponding assistant tool call lines by matching `toolCallId`.
- Keep `types` and `limit` parameters working as filters before formatting.
- Update tool descriptions to reflect the new output format.

## Non-Goals

- Adding a raw mode or backward-compatible JSON output option — the session file is always available on disk for tools that need raw entries.
- Changing the `set_session_name` or `get_session_name` tools.
- Changing the `parent-session.ts` module (reading and parsing logic stays the same; only the formatting of the final output changes).

## Background

### Existing modules

- `src/index.ts` — registers all four tools; `read_session` and `read_parent_session` both call `JSON.stringify(entries, null, 2)` as their final output.
- `src/parent-session.ts` — `deriveParentSessionFile()` and `readParentSessionEntries()` for reading parent session JSONL files.
  Returns `ParsedEntry[]` with `{ type: string; [key: string]: unknown }`.

### Pi session entry model

Session entries are discriminated by `type`:

| Type                    | Key fields                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `message`               | `message: AgentMessage` (union of `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `BashExecutionMessage`, `CustomMessage`, etc.) |
| `compaction`            | `summary`, `tokensBefore`                                                                                                                |
| `model_change`          | `provider`, `modelId`                                                                                                                    |
| `thinking_level_change` | `thinkingLevel`                                                                                                                          |
| `branch_summary`        | `summary`                                                                                                                                |
| `custom`                | `customType`, `data`                                                                                                                     |
| `custom_message`        | `customType`, `content`                                                                                                                  |
| `label`                 | `targetId`, `label`                                                                                                                      |
| `session_info`          | `name`                                                                                                                                   |

### Message roles within `SessionMessageEntry`

- `user` — `content: string | (TextContent | ImageContent)[]`
- `assistant` — `content: (TextContent | ThinkingContent | ToolCall)[]`, plus `provider`, `model`, `usage`, etc.
- `toolResult` — `toolCallId`, `toolName`, `content`, `isError`
- `bashExecution` — `command`, `output`, `exitCode`, `cancelled`
- `custom` — extension-injected messages
- `compactionSummary`, `branchSummary` — internal summary messages

### Reference implementation

The `@gotgenes/opencode-session-context` plugin implements a similar transcript format for OpenCode sessions.
The format pattern is proven in production retro workflows.

### Constraints

- AGENTS.md requires keeping Pi SDK imports out of business-logic modules.
  The formatter is a pure function that operates on `ParsedEntry[]` — no SDK imports needed.
- The formatter must handle both sources: `ctx.sessionManager.getEntries()` (typed `SessionEntry[]`) and `readParentSessionEntries()` (typed `ParsedEntry[]`).
  Since `ParsedEntry` is `{ type: string; [key: string]: unknown }`, the formatter should accept this minimal type and use runtime property access.

## Design Overview

### Transcript format

```text
1. user
How do I fix the login bug?

---

2. assistant [anthropic/claude-sonnet-4-20250514]
Let me check the auth flow.
  [tool] Read — path: src/auth/login.ts → completed
  [tool] Bash — command: pnpm vitest login (exit: 1) → error
The test is failing because...

---

[compaction] Context compacted (48000 tokens before)

---

[model change] → anthropic/claude-opus-4-20250514

---

3. user
Try a different approach.
```

### Entry type formatting rules

| Entry type                                             | Format                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `message` (user)                                       | `N. user\n<text content>`                                                                  |
| `message` (assistant)                                  | `N. assistant [provider/model]\n<text content>\n  [tool] <name> — <brief args> → <status>` |
| `message` (toolResult)                                 | Folded into preceding assistant's `[tool]` line as `→ completed` or `→ error`              |
| `message` (bashExecution)                              | `[bash] <command> (exit: <code>)` folded into assistant context                            |
| `compaction`                                           | `[compaction] Context compacted (<tokens> tokens before)`                                  |
| `model_change`                                         | `[model change] → <provider>/<modelId>`                                                    |
| `thinking_level_change`                                | `[thinking] → <level>`                                                                     |
| `branch_summary`                                       | `[branch] <summary snippet>`                                                               |
| `custom` / `label` / `session_info` / `custom_message` | Omitted (internal bookkeeping)                                                             |

### Tool result folding

Tool results are separate `toolResult` message entries in Pi's session model.
The formatter correlates them back to the preceding assistant message's tool calls by matching `toolCallId` to `ToolCall.id`, appending `→ completed` or `→ error` to each tool call summary line.

- Buffer tool result entries and associate them with the most recent assistant message.
- When formatting an assistant message, look ahead in the buffered results to annotate each `[tool]` line.
- Parallel tool execution means results may arrive in a different order than the calls — match by ID, not position.
- If a tool result has no matching call (edge case), render it as a standalone `[result] <toolName> → <status>` line.

### Tool argument hints

For common tools, extract a brief argument hint:

- `Read` → `path: <value>`
- `Bash` → `command: <truncated>` (first 80 chars)
- `Edit` → `path: <value>`
- `Write` → `path: <value>`
- `Grep` → `pattern: <value>`
- Others → first key-value pair or empty

### Sequential numbering

Only user and assistant messages increment the turn counter.
Metadata entries (compaction, model change, etc.) and toolResult entries do not get numbers.

### Formatter function signature

```typescript
interface TranscriptEntry {
  type: string;
  [key: string]: unknown;
}

function formatTranscript(entries: TranscriptEntry[]): string;
```

The function accepts the full filtered-and-sliced entry array, performs the tool-result folding internally, and returns the formatted transcript string.
Both tools call this function on their final entry list instead of `JSON.stringify`.

### Consumer call site (both tools)

```typescript
// Before:
return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }], details: undefined };
// After:
return { content: [{ type: "text", text: formatTranscript(entries) }], details: undefined };
```

## Module-Level Changes

### New file: `src/format-transcript.ts`

- `formatTranscript(entries: TranscriptEntry[]): string` — main entry point.
- Internal helpers: `formatUserMessage`, `formatAssistantMessage`, `formatToolCall`, `formatMetadataEntry`, `extractToolArgHint`, `buildToolResultMap`.
- `TranscriptEntry` interface (minimal: `{ type: string; [key: string]: unknown }`).

### Modified: `src/index.ts`

- Import `formatTranscript` from `./format-transcript.js`.
- Replace `JSON.stringify(entries, null, 2)` with `formatTranscript(entries)` in both `read_session` and `read_parent_session` tool execute functions.
- Update tool descriptions for both tools to describe the transcript output format instead of "raw entries" / "JSONL entries".

### Unchanged: `src/parent-session.ts`

No changes — `readParentSessionEntries` already returns `ParsedEntry[]` which structurally satisfies `TranscriptEntry`.

## Test Impact Analysis

### New unit tests enabled

1. `test/format-transcript.test.ts` — comprehensive unit tests for the formatter in isolation:
   - User message formatting with text content.
   - Assistant message formatting with model attribution.
   - Tool call one-line summaries with argument hints.
   - Tool result folding by `toolCallId` matching.
   - Unmatched tool results rendered as standalone lines.
   - Sequential numbering skipping metadata entries.
   - Compaction, model change, thinking level change formatting.
   - Branch summary truncation.
   - Omitted entry types (`custom`, `label`, `session_info`).
   - Empty entries array.
   - Mixed entry types in correct order.
   - Bash execution message formatting.

### Existing tests that need updating

1. `test/read-session.test.ts` — currently asserts `JSON.parse(text)` to verify raw JSON output.
   Must change to assert transcript-formatted text output instead.
2. `test/read-parent-session.test.ts` — same pattern: currently parses JSON output.
   Must change to assert transcript text.
   The filtering and limiting tests can still verify behavior by checking transcript content (e.g., presence/absence of specific formatted lines).

### Existing tests that stay as-is

1. `test/parent-session.test.ts` — tests `deriveParentSessionFile` which is unchanged.

## TDD Order

### Step 1: Create `formatTranscript` with basic message formatting

1. Create `src/format-transcript.ts` with the `TranscriptEntry` interface and `formatTranscript` function.
2. Create `test/format-transcript.test.ts` with tests covering:
   - User message with string content → `1. user\n<text>`.
   - User message with `TextContent[]` → extracts text.
   - Assistant message with text content and model attribution → `1. assistant [provider/model]\n<text>`.
   - Sequential numbering across user and assistant messages.
   - Separator (`---`) between entries.
   - Empty entries array → empty string.
3. Commit: `feat: add formatTranscript with basic message formatting (#251)`

### Step 2: Add tool call summaries and tool result folding

1. Add tool call formatting to assistant messages: `[tool] <name> — <arg hint>`.
2. Add tool result folding: match `toolCallId` → append `→ completed` or `→ error`.
3. Add unmatched tool result handling: `[result] <toolName> → <status>`.
4. Add tool argument hint extraction for common tools.
5. Add tests for:
   - Assistant message with tool calls and correlated results.
   - Parallel tool calls with out-of-order results.
   - Tool result with no matching call.
   - Various tool argument hints (Read path, Bash command, Edit path, etc.).
6. Commit: `feat: add tool call summaries and tool result folding (#251)`

### Step 3: Add metadata entry formatting

1. Add formatting for compaction, model change, thinking level change, and branch summary entries.
2. Add omission of `custom`, `label`, `session_info`, `custom_message` entries.
3. Add bash execution message formatting.
4. Add tests for each metadata entry type and omitted types.
5. Commit: `feat: add metadata entry formatting to transcript (#251)`

### Step 4: Wire `formatTranscript` into both tools and update tests

1. Import `formatTranscript` in `src/index.ts`.
2. Replace `JSON.stringify(entries, null, 2)` with `formatTranscript(entries)` in `read_session`.
3. Replace `JSON.stringify(entries, null, 2)` with `formatTranscript(entries)` in `read_parent_session`.
4. Update tool descriptions to describe transcript output.
5. Update `test/read-session.test.ts`:
   - Change assertions from `JSON.parse(text)` to transcript text assertions.
   - Verify filtering and limiting still work (check formatted output for presence/absence of expected content).
6. Update `test/read-parent-session.test.ts`:
   - Same pattern: assert transcript text instead of parsed JSON.
7. Run full test suite.
8. Commit: `feat: wire transcript formatter into read_session and read_parent_session (#251)`

## Risks and Mitigations

### Risk: Consumers that parse JSON output from these tools will break

This is an intentional breaking change.
The issue explicitly states "No raw mode" — the session file on disk is available for tools that need raw entries.
No known consumer parses the JSON output; the primary consumer is retro diagnostic lenses which will benefit from the compact format.
The tool descriptions will be updated to reflect the new format.

### Risk: `ParsedEntry` index signature vs `TranscriptEntry` index signature compatibility

Both use `{ type: string; [key: string]: unknown }`, so `ParsedEntry[]` is directly assignable to `TranscriptEntry[]`.
No type issues expected.

### Risk: Property access on unknown fields (runtime safety)

The formatter accesses deeply nested properties like `entry.message.role`, `entry.message.content`, `entry.message.provider`.
Since entries come from JSONL parsing, these are runtime-typed.
The formatter uses defensive property access with optional chaining and type guards to handle malformed or unexpected shapes gracefully.

### Risk: Assistant messages without provider/model fields

Some session entries may have been written by older versions of Pi that did not include all fields.
The formatter falls back to `[unknown]` when provider/model are missing.

## Open Questions

1. Should `branch_summary` entries show a truncated snippet or the full summary text?
   Start with a truncated snippet (first 100 characters) — branch summaries can be long and the full text is rarely needed for retro analysis.
