/**
 * format-transcript.ts — Formats Pi session entries as a human-readable transcript.
 *
 * Preserves conversation flow (user/assistant turns, tool calls, metadata events)
 * while dropping noise (thinking content, image data, token usage, tool result bodies).
 */

/**
 * Minimal structural supertype for session entries.
 * Accepts SDK SessionEntry[] without index-signature conflicts.
 * Formatter functions cast to Record<string, unknown> internally where they
 * need to access fields beyond `type`.
 */
export interface TranscriptEntry {
  type: string;
}

interface ToolResultInfo {
  toolName: string;
  isError: boolean;
}

/**
 * Extract plain text from user message content.
 * Handles both string content and TextContent[] arrays (skipping images).
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type: string }).type === "text" &&
          typeof (c as { text: string }).text === "string",
      )
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/** Extract a brief one-line argument hint for well-known tool names. */
function extractToolArgHint(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "find":
      if (typeof args.path === "string") return `path: ${args.path}`;
      break;
    case "Bash":
      if (typeof args.command === "string") {
        return `command: ${args.command.slice(0, 80)}`;
      }
      break;
    case "Grep":
      if (typeof args.pattern === "string") return `pattern: ${args.pattern}`;
      break;
    default: {
      // Fall back to first key-value pair
      for (const [key, val] of Object.entries(args)) {
        if (typeof val === "string") return `${key}: ${val}`;
        break; // only inspect the first entry
      }
    }
  }
  return "";
}

function formatToolCallLine(
  toolCall: Record<string, unknown>,
  resultMap: Map<string, ToolResultInfo>,
): string {
  const name = typeof toolCall.name === "string" ? toolCall.name : "unknown";
  const id = typeof toolCall.id === "string" ? toolCall.id : "";
  const rawArgs = toolCall.arguments;
  const args =
    typeof rawArgs === "object" && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {};

  const hint = extractToolArgHint(name, args);
  const sep = hint ? ` \u2014 ${hint}` : "";

  const result = id ? resultMap.get(id) : undefined;
  const status = result ? (result.isError ? "error" : "completed") : "pending";

  return `  [tool] ${name}${sep} \u2192 ${status}`;
}

/** Build a map of toolCallId → result info from all toolResult message entries. */
function buildToolResultMap(
  entries: TranscriptEntry[],
): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as unknown as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    if (msg?.role !== "toolResult") continue;
    const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
    if (!toolCallId) continue;
    map.set(toolCallId, {
      toolName: typeof msg.toolName === "string" ? msg.toolName : "unknown",
      isError: msg.isError === true,
    });
  }
  return map;
}

/**
 * Return the entry indices of `model_change` markers that took effect — a
 * switch followed by at least one assistant turn before the next switch (or
 * the end of entries).
 *
 * A phantom switch (cycling the TUI picker, or ending a session on a switch)
 * never produces a turn and is excluded.
 * Guard: when the stream contains no assistant messages at all (e.g. a
 * `types: ["model_change"]` filtered query), every marker is treated as
 * effective — there is no ground truth to validate against, and suppressing
 * all of them would hide the only signal the caller asked for.
 */
export function collectEffectiveModelChangeIndices(
  entries: TranscriptEntry[],
): Set<number> {
  const effective = new Set<number>();
  const modelChangeIndices: number[] = [];
  let pendingIndex: number | null = null;
  let sawAssistantMessage = false;

  for (const [index, entry] of entries.entries()) {
    if (entry.type === "model_change") {
      modelChangeIndices.push(index);
      pendingIndex = index;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as unknown as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    if (msg?.role !== "assistant") continue;
    sawAssistantMessage = true;
    if (pendingIndex !== null) {
      effective.add(pendingIndex);
      pendingIndex = null;
    }
  }

  if (!sawAssistantMessage) return new Set(modelChangeIndices);
  return effective;
}

/** Collect all toolCallIds that appear in assistant message content arrays. */
function collectAssistantToolCallIds(entries: TranscriptEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as unknown as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "toolCall" && typeof p.id === "string") {
        ids.add(p.id);
      }
    }
  }
  return ids;
}

function formatUserMessage(
  message: Record<string, unknown>,
  num: number,
): string {
  const text = extractTextContent(message.content);
  return `${num}. user\n${text}`;
}

function formatAssistantMessage(
  message: Record<string, unknown>,
  num: number,
  resultMap: Map<string, ToolResultInfo>,
): string {
  const provider =
    typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";
  const header = `${num}. assistant [${provider}/${model}]`;

  const content = message.content;
  if (!Array.isArray(content)) return header;

  const lines: string[] = [header];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      lines.push(p.text);
    } else if (p.type === "toolCall") {
      lines.push(formatToolCallLine(p, resultMap));
    }
    // thinking content is intentionally omitted
  }
  return lines.join("\n");
}

const BRANCH_SUMMARY_SNIPPET_LENGTH = 100;

/** Format a non-message session entry (compaction, model change, etc.). */
function formatMetadataEntry(entry: TranscriptEntry): string | null {
  // Cast once to access all non-type fields through runtime guards.
  const e = entry as unknown as Record<string, unknown>;
  switch (entry.type) {
    case "compaction": {
      const tokens = typeof e.tokensBefore === "number" ? e.tokensBefore : 0;
      return `[compaction] Context compacted (${tokens} tokens before)`;
    }
    case "model_change": {
      const provider = typeof e.provider === "string" ? e.provider : "unknown";
      const modelId = typeof e.modelId === "string" ? e.modelId : "unknown";
      return `[model change] \u2192 ${provider}/${modelId}`;
    }
    case "thinking_level_change": {
      const level =
        typeof e.thinkingLevel === "string" ? e.thinkingLevel : "unknown";
      return `[thinking] \u2192 ${level}`;
    }
    case "branch_summary": {
      const summary = typeof e.summary === "string" ? e.summary : "";
      const snippet = summary.slice(0, BRANCH_SUMMARY_SNIPPET_LENGTH);
      const ellipsis =
        summary.length > BRANCH_SUMMARY_SNIPPET_LENGTH ? "..." : "";
      return `[branch] ${snippet}${ellipsis}`;
    }
    default:
      // custom, label, session_info, custom_message: omitted
      return null;
  }
}

/** Format a bashExecution message entry (command + exit code, no output). */
function formatBashMessage(message: Record<string, unknown>): string {
  const command = typeof message.command === "string" ? message.command : "";
  const exitCode =
    typeof message.exitCode === "number" ? message.exitCode : undefined;
  if (message.cancelled === true || exitCode === undefined) {
    return `  [bash] ${command} (cancelled)`;
  }
  return `  [bash] ${command} (exit: ${exitCode})`;
}

/**
 * Format a session entry array as a human-readable transcript.
 *
 * Sequential numbering counts only user and assistant conversation turns.
 * Tool results are folded into their corresponding assistant tool call lines
 * by matching toolCallId. Orphan tool results (no matching call) render
 * as standalone lines. Entries are separated by `---` dividers.
 */
export function formatTranscript(entries: TranscriptEntry[]): string {
  const resultMap = buildToolResultMap(entries);
  const assistantToolCallIds = collectAssistantToolCallIds(entries);
  const effectiveModelChanges = collectEffectiveModelChangeIndices(entries);

  const parts: string[] = [];
  let turnNum = 0;

  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message") {
      if (entry.type === "model_change" && !effectiveModelChanges.has(index)) {
        continue; // phantom switch — suppressed
      }
      const formatted = formatMetadataEntry(entry);
      if (formatted !== null) parts.push(formatted);
      continue;
    }

    const message = (entry as unknown as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    if (!message || typeof message !== "object") continue;

    const role = message.role;

    if (role === "user") {
      turnNum++;
      parts.push(formatUserMessage(message, turnNum));
    } else if (role === "assistant") {
      turnNum++;
      parts.push(formatAssistantMessage(message, turnNum, resultMap));
    } else if (role === "toolResult") {
      const toolCallId =
        typeof message.toolCallId === "string" ? message.toolCallId : "";
      // Render only orphan results (not folded into an assistant message)
      if (!assistantToolCallIds.has(toolCallId)) {
        const toolName =
          typeof message.toolName === "string" ? message.toolName : "unknown";
        const status = message.isError === true ? "error" : "completed";
        parts.push(`  [result] ${toolName} \u2192 ${status}`);
      }
    } else if (role === "bashExecution") {
      parts.push(formatBashMessage(message));
    }
    // custom, compactionSummary, branchSummary message roles: omitted
  }

  return parts.join("\n\n---\n\n");
}
