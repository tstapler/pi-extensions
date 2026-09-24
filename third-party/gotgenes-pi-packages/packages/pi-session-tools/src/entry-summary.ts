/**
 * entry-summary.ts — Pure summary statistics for a session entry array.
 *
 * Provides `summarizeEntries` (counts) and `formatSummaryText` (display string)
 * as a testable layer beneath the theme-coupled rendering in `index.ts`.
 */

import {
  collectEffectiveModelChangeIndices,
  type TranscriptEntry,
} from "./format-transcript.js";

export interface SessionSummary {
  /** Total number of entries in the (already filtered/limited) array. */
  totalEntries: number;
  /** user + assistant conversation turns. */
  messages: number;
  /** `toolCall` parts inside assistant message content arrays. */
  toolCalls: number;
  /** Entries with `type: "compaction"`. */
  compactions: number;
  /** `model_change` entries followed by an assistant turn (phantom switches excluded). */
  modelChanges: number;
}

/**
 * Walk the entry array once and return counts for the display summary.
 * The entries should already be filtered and limited — this function does not
 * apply `types`/`limit` itself.
 */
export function summarizeEntries(entries: TranscriptEntry[]): SessionSummary {
  let messages = 0;
  let toolCalls = 0;
  let compactions = 0;

  for (const entry of entries) {
    if (entry.type === "compaction") {
      compactions++;
      continue;
    }
    if (entry.type === "model_change") continue;
    if (entry.type !== "message") continue;

    const e = entry as unknown as Record<string, unknown>;
    const msg = e.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const role = msg.role;
    if (role === "user") {
      messages++;
    } else if (role === "assistant") {
      messages++;
      // Count toolCall parts inside the content array.
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>).type === "toolCall"
          ) {
            toolCalls++;
          }
        }
      }
    }
  }

  return {
    totalEntries: entries.length,
    messages,
    toolCalls,
    compactions,
    modelChanges: collectEffectiveModelChangeIndices(entries).size,
  };
}

/** Pluralize a word: `"entry"/"entries"`, `"message"/"messages"`, etc. */
function plural(count: number, singular: string, pluralForm?: string): string {
  const pluralStr = pluralForm ?? `${singular}s`;
  return count === 1 ? `${count} ${singular}` : `${count} ${pluralStr}`;
}

/**
 * Build a plain (uncolored) summary string for the collapsed TUI row.
 *
 * Examples:
 *   "0 entries"
 *   "1 entry — 1 message"
 *   "142 entries — 120 messages, 18 tool calls, 2 compactions, 2 model changes"
 */
export function formatSummaryText(summary: SessionSummary): string {
  const total = plural(summary.totalEntries, "entry", "entries");

  const parts: string[] = [];
  if (summary.messages > 0) parts.push(plural(summary.messages, "message"));
  if (summary.toolCalls > 0) parts.push(plural(summary.toolCalls, "tool call"));
  if (summary.compactions > 0)
    parts.push(plural(summary.compactions, "compaction"));
  if (summary.modelChanges > 0)
    parts.push(plural(summary.modelChanges, "model change"));

  return parts.length > 0 ? `${total} \u2014 ${parts.join(", ")}` : total;
}
