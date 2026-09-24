---
issue: 176
issue_title: "Deepen retrospective introspection with model attribution and diagnostic lenses"
---

# Deepen retrospective introspection

## Problem Statement

Retrospectives currently capture friction labels and session summaries but lack machine-readable detail needed for cross-session analysis.
Three gaps exist: (1) `getAgentConversation()` drops the provider/model fields that every `AssistantMessage` carries, (2) pi-session-tools provides no way to read the raw session entries that survive context compaction, and (3) the `/retro` prompt has no structured diagnostic lenses for model-performance correlation, escalation-delay tracking, or unused-tool detection.

## Goals

- Add `provider/model` attribution to formatted assistant messages in both `getAgentConversation()` (text export) and `formatAssistantMessage()` (UI conversation viewer).
- Add a `read_session` tool to pi-session-tools that reads the current session's raw entries from `ctx.sessionManager`.
- Add a `read_parent_session` tool to pi-session-tools that reads the parent session's conversation when running inside a subagent.
- Add four diagnostic lenses to the `/retro` prompt template.
- Document the `### Diagnostic details` subsection in `AGENTS.md` retro file format.

## Non-Goals

- Rewriting the `/retro` prompt from scratch — only adding the diagnostic lenses section.
- Adding model attribution to the widget renderer's `buildContentLines` (separate from `formatAssistantMessage`).
- Implementing an automated retro-stage subagent that dispatches at stage boundaries — the tools enable it but the subagent itself is future work.
- Adding tests to the existing pi-session-tools `set_session_name`/`get_session_name` tools.

## Background

### `getAgentConversation()` — `packages/pi-subagents/src/lifecycle/agent-runner.ts`

Pure function that iterates `session.messages` and formats them as `[User]`, `[Assistant]`, `[Tool Calls]`, `[Tool Result]` plain text.
Called by `GetResultTool` when `verbose: true`.
Currently drops `msg.provider` and `msg.model` even though `AssistantMessage` (from `@earendil-works/pi-ai`) carries both fields.
Has no tests today (noted in retro #172).

### `formatAssistantMessage()` — `packages/pi-subagents/src/ui/message-formatters.ts`

UI formatter for the conversation viewer.
Currently renders `[Assistant]` header with no attribution.
Receives only the `content` array — the full message's `provider`/`model` fields are not passed through from `formatMessage()`.

### `AssistantMessage` shape (from `@earendil-works/pi-ai`)

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;  // e.g. "anthropic"
  model: string;       // e.g. "claude-sonnet-4-20250514"
  responseModel?: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
}
```

### pi-session-tools — `packages/pi-session-tools/src/index.ts`

Minimal extension with two tools: `set_session_name` and `get_session_name`.
Tools receive `ctx: ExtensionContext` in the `execute` callback, which provides `ctx.sessionManager: ReadonlySessionManager`.
`ReadonlySessionManager` exposes `getEntries()`, `getSessionFile()`, `getSessionId()`, `getBranch()`, `getHeader()`, etc.

### Parent session access from subagents

Subagent sessions are stored at `<parent-dir>/<parent-basename>/tasks/<subagent-session>.jsonl`.
The session header stores `parentSession?: string` (the parent session ID, not file path).
The parent session file can be reconstructed from the directory layout: navigate up from `tasks/` to find `<parent-basename>.jsonl`.
The SDK exports `loadEntriesFromFile()` and `buildSessionContext()` for reading and interpreting session files.

### `/retro` prompt — `.pi/prompts/retro.md`

Currently has friction-label categorization and bidirectional feedback but no structured diagnostic analysis of tool-call patterns, model selection, or verification timing.

## Design Overview

### 1. Model attribution in conversation formatters

Both `getAgentConversation()` and `formatAssistantMessage()` gain model attribution.
The format is `provider/model` when both are present, with graceful fallback.

For `getAgentConversation()`, the message loop already has access to the full message object.
The assistant branch changes from `[Assistant]:` to `[Assistant (anthropic/claude-sonnet-4-20250514)]:`.

For `formatAssistantMessage()`, the function signature gains optional `provider` and `model` parameters.
The `formatMessage()` dispatcher extracts these from the full message and passes them through.
The header line changes from `[Assistant]` to `[Assistant (provider/model)]` when attribution is available.

```typescript
export function formatAssistantMessage(
  content: { type: string; [key: string]: unknown }[],
  width: number,
  ctx: FormatterContext,
  attribution?: { provider?: string; model?: string },
): string[] {
  const { theme, wrapText } = ctx;
  const { textParts, toolNames } = extractAssistantContent(content);
  const label = formatAttributionLabel(attribution);
  const lines: string[] = [theme.bold(`[Assistant${label}]`)];
  // ...
}

function formatAttributionLabel(
  attr?: { provider?: string; model?: string },
): string {
  if (!attr?.provider && !attr?.model) return "";
  if (attr.provider && attr.model) return ` (${attr.provider}/${attr.model})`;
  return ` (${attr.provider ?? attr.model})`;
}
```

### 2. Session introspection tools

Two new tools in pi-session-tools:

#### `read_session`

Reads the current session's raw entries via `ctx.sessionManager.getEntries()`.
Returns a JSON array of session entries.
Accepts optional `types` parameter to filter by entry type (e.g., `["message", "compaction"]`).
Accepts optional `limit` parameter for the most recent N entries.

The tool execute function accesses `ctx` (the 5th parameter of `execute`) which carries `sessionManager: ReadonlySessionManager`.
This requires changing the extension from simple `defineTool` with `pi.registerTool` to capturing the `ctx` at tool-call time.

```typescript
// Pseudocode — read_session tool
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const entries = ctx.sessionManager.getEntries();
  const filtered = params.types
    ? entries.filter(e => params.types.includes(e.type))
    : entries;
  const limited = params.limit
    ? filtered.slice(-params.limit)
    : filtered;
  return { content: [{ type: "text", text: JSON.stringify(limited, null, 2) }] };
}
```

#### `read_parent_session`

Reads the parent session's entries when running inside a subagent.
Derives the parent session file from the directory layout convention:

```typescript
function deriveParentSessionFile(sessionFile: string): string | undefined {
  // Layout: <parent-dir>/<parent-basename>/tasks/<child>.jsonl
  const tasksDir = dirname(sessionFile);
  if (basename(tasksDir) !== "tasks") return undefined;
  const parentBase = dirname(tasksDir);
  return parentBase + ".jsonl";
}
```

Uses the SDK's exported `loadEntriesFromFile()` and `buildSessionContext()` to parse the parent file.
Returns a formatted text summary of the parent's conversation (not raw JSON — the parent session can be very large).
If not running in a subagent context (no `tasks/` directory ancestor), returns an informative error.

### 3. Diagnostic lenses in `/retro` prompt

Four structured lenses added to Step 2 of the `/retro` prompt, after the friction-label categorization:

1. **Model-performance correlation** — for each subagent dispatch (if any), note which model ran.
   Flag quality mismatches: Sonnet on judgment-heavy work, Opus on mechanical tasks.
2. **Escalation-delay tracking** — for each `rabbit-hole` friction point, count consecutive tool calls on the same error before resolution.
   Flag sequences > 5 as "should have dispatched an Explore or Plan subagent."
3. **Unused-tool detection** — for each `rabbit-hole` or `missing-context` point, check whether an available but un-dispatched tool could have helped.
4. **Feedback-loop gap analysis** — check when verification tools (`pnpm run check`, `pnpm vitest run`, `pnpm run lint`) were invoked.
   Flag runs-only-at-end patterns.

### 4. Retro file format documentation

Add a `### Diagnostic details` subsection example to the retro file format in `AGENTS.md`.
This subsection appears inside stage entries when the lenses are triggered.

## Module-Level Changes

### pi-subagents

| File                            | Change                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lifecycle/agent-runner.ts` | Update `getAgentConversation()` to include `provider/model` in `[Assistant (...)]` header                                                  |
| `src/ui/message-formatters.ts`  | Add optional `attribution` parameter to `formatAssistantMessage()` and `formatMessage()` dispatcher; add `formatAttributionLabel()` helper |

### pi-session-tools

| File                    | Change                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | Add `read_session` and `read_parent_session` tool registrations; import SDK session types                                        |
| `src/parent-session.ts` | New module: `deriveParentSessionFile()` and `readParentConversation()` — pure functions for parent session discovery and reading |

### Prompt and docs

| File                   | Change                                                               |
| ---------------------- | -------------------------------------------------------------------- |
| `.pi/prompts/retro.md` | Add diagnostic lenses section to Step 2                              |
| `AGENTS.md`            | Add `### Diagnostic details` subsection example to retro file format |

## Test Impact Analysis

### New tests enabled

1. `getAgentConversation()` — currently untested.
   Adding attribution creates a natural entry point for a test suite covering all message types plus attribution formatting.
2. `formatAssistantMessage()` with attribution — existing tests cover the no-attribution case; new tests verify the `[Assistant (provider/model)]` header rendering.
3. `formatMessage()` assistant delegation — existing test asserts output matches `formatAssistantMessage(content)`.
   Needs updating to include attribution passthrough.
4. `deriveParentSessionFile()` — pure function, easily unit-tested with path manipulation scenarios.
5. `read_session` tool — integration-style tests with mock `ctx.sessionManager`.
6. `read_parent_session` tool — tests with mock file system for parent session discovery.

### Existing tests affected

- `formatAssistantMessage` tests in `test/message-formatters.test.ts` — existing calls pass no attribution parameter, so they continue to work (optional param with default behavior).
- `formatMessage` assistant delegation test — needs update since `formatMessage` will now extract and pass attribution from the full message.
- `get-result-tool.test.ts` verbose test — unchanged; it drives `getAgentConversation` through a mock session.

### Tests that stay as-is

- All `formatUserMessage`, `formatToolResult`, `formatBashExecution`, `formatStreamingIndicator` tests — unaffected.
- `conversation-viewer.test.ts` — unchanged; viewer calls `formatMessage` which handles attribution internally.

## TDD Order

### pi-subagents — model attribution

1. `test:` Add tests for `getAgentConversation()` covering all message types (user, assistant, toolResult) and asserting `[Assistant (provider/model)]` format.
   Commit: `test: add tests for getAgentConversation with model attribution`

2. `feat:` Update `getAgentConversation()` to include `provider/model` in assistant message header.
   Commit: `feat: add model attribution to getAgentConversation`

3. `test:` Add tests for `formatAssistantMessage()` with attribution parameter: `(provider/model)`, provider-only, model-only, and no-attribution cases.
   Update `formatMessage` delegation test to verify attribution passthrough.
   Commit: `test: add attribution tests for formatAssistantMessage`

4. `feat:` Add optional `attribution` parameter to `formatAssistantMessage()`.
   Add `formatAttributionLabel()` helper.
   Update `formatMessage()` dispatcher to extract `provider`/`model` from the full message and pass them through.
   Commit: `feat: add model attribution to formatAssistantMessage`

### pi-session-tools — session introspection

5. `test:` Add tests for `read_session` tool — mock `ctx.sessionManager.getEntries()` returning sample entries; verify filtering by type and limit.
   Commit: `test: add read_session tool tests`

6. `feat:` Add `read_session` tool registration in `index.ts`.
   Commit: `feat: add read_session tool for session introspection`

7. `test:` Add tests for `deriveParentSessionFile()` — valid subagent paths, non-subagent paths, edge cases.
   Commit: `test: add deriveParentSessionFile tests`

8. `feat:` Create `src/parent-session.ts` with `deriveParentSessionFile()`.
   Commit: `feat: add deriveParentSessionFile utility`

9. `test:` Add tests for `read_parent_session` tool — mock file-reading for parent session, error case when not in subagent.
   Commit: `test: add read_parent_session tool tests`

10. `feat:` Add `read_parent_session` tool registration in `index.ts`.
    Commit: `feat: add read_parent_session tool for parent session access`

### Prompt and docs

11. `docs:` Add diagnostic lenses to `.pi/prompts/retro.md` Step 2.
    Commit: `docs: add diagnostic lenses to retro prompt`

12. `docs:` Add `### Diagnostic details` subsection example to `AGENTS.md` retro file format.
    Commit: `docs: document diagnostic details subsection in retro format`

## Risks and Mitigations

| Risk                                                                                                                             | Mitigation                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AssistantMessage` fields `provider`/`model` may not be present on all session messages (e.g., older sessions, non-LLM messages) | Use optional access with graceful fallback to empty attribution — the label helper returns `""` when both fields are undefined                                                                  |
| Parent session file path derivation depends on the `tasks/` directory convention                                                 | Validate the path exists before reading; return informative error if convention doesn't match                                                                                                   |
| `loadEntriesFromFile()` is documented as "exported for testing" in the SDK                                                       | It is included in the public exports of `@earendil-works/pi-coding-agent` — verify import path works; if it breaks in a future SDK version, the JSONL format is simple enough to parse directly |
| Diagnostic lenses in the retro prompt may produce verbose output                                                                 | Lenses are conditional — they only fire when relevant patterns are detected; the prompt instructs concise summaries                                                                             |
| `formatAssistantMessage` signature change could break external callers                                                           | The new `attribution` parameter is optional with default behavior matching current output — fully backward compatible                                                                           |

## Open Questions

1. Should `read_parent_session` return raw JSON entries or a formatted conversation summary?
   The plan proposes formatted text to keep output manageable, but raw entries would be more flexible.
   Decide during implementation based on typical parent session sizes.
2. Should the diagnostic lenses produce markdown for inclusion in the retro file, or plain-text observations that the agent converts?
   The plan proposes they produce observations that the agent formats into the retro file's `### Diagnostic details` subsection.
