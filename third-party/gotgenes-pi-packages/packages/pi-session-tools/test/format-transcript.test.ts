import { describe, expect, it } from "vitest";
import {
  collectEffectiveModelChangeIndices,
  formatTranscript,
} from "#src/format-transcript";

function makeUserEntry(content: unknown, id = "1") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "user",
      content,
      timestamp: 1000,
    },
  };
}

function makeAssistantEntry(
  textParts: string | string[],
  provider = "anthropic",
  model = "claude-sonnet-4-20250514",
  id = "2",
) {
  const contentArr = (Array.isArray(textParts) ? textParts : [textParts]).map(
    (t) => ({ type: "text", text: t }),
  );
  return {
    type: "message",
    id,
    parentId: "1",
    timestamp: "2026-01-01T00:00:01Z",
    message: {
      role: "assistant",
      content: contentArr,
      provider,
      model,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2000,
    },
  };
}

describe("formatTranscript — tool calls and result folding", () => {
  it("formats an assistant message with a single tool call and correlated result", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that file." },
            {
              type: "toolCall",
              id: "tc-1",
              name: "Read",
              arguments: { path: "src/auth.ts" },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "Read",
          content: [{ type: "text", text: "file contents here" }],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "1. assistant [anthropic/claude-sonnet-4-20250514]\nLet me read that file.\n  [tool] Read — path: src/auth.ts → completed",
    );
  });

  it("marks a tool call as error when the result is an error", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-2",
              name: "Bash",
              arguments: { command: "pnpm vitest run" },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-2",
          toolName: "Bash",
          content: [{ type: "text", text: "FAIL" }],
          isError: true,
        },
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "1. assistant [anthropic/claude-sonnet-4-20250514]\n  [tool] Bash — command: pnpm vitest run → error",
    );
  });

  it("handles parallel tool calls with out-of-order results", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-a",
              name: "Read",
              arguments: { path: "a.ts" },
            },
            {
              type: "toolCall",
              id: "tc-b",
              name: "Read",
              arguments: { path: "b.ts" },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      // results arrive in reverse order
      {
        type: "message",
        id: "3",
        parentId: "2",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-b",
          toolName: "Read",
          content: [],
          isError: false,
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-a",
          toolName: "Read",
          content: [],
          isError: false,
        },
      },
    ];
    const result = formatTranscript(entries);
    expect(result).toBe(
      "1. assistant [anthropic/claude-sonnet-4-20250514]\n" +
        "  [tool] Read — path: a.ts → completed\n" +
        "  [tool] Read — path: b.ts → completed",
    );
  });

  it("renders orphan tool result (no matching call) as standalone line", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "missing-id",
          toolName: "Read",
          content: [],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toBe("  [result] Read → completed");
  });

  it("extracts path hint for Read tool", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "Read",
              arguments: { path: "src/index.ts" },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "Read",
          content: [],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toContain("Read — path: src/index.ts");
  });

  it("extracts command hint for Bash tool, truncated to 80 chars", () => {
    const longCmd = `pnpm vitest run ${"x".repeat(100)}`;
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "Bash",
              arguments: { command: longCmd },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "Bash",
          content: [],
          isError: false,
        },
      },
    ];
    const result = formatTranscript(entries);
    expect(result).toContain("Bash — command: pnpm vitest run ");
    // hint is capped at 80 chars
    const hint = /Bash — command: (.+?) →/.exec(result)?.[1] ?? "";
    expect(hint.length).toBeLessThanOrEqual(80);
  });

  it("extracts path hint for Edit tool", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "Edit",
              arguments: { path: "src/foo.ts", edits: [] },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "Edit",
          content: [],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toContain("Edit — path: src/foo.ts");
  });

  it("extracts pattern hint for Grep tool", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "Grep",
              arguments: { pattern: "formatTranscript", path: "src" },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "Grep",
          content: [],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toContain(
      "Grep — pattern: formatTranscript",
    );
  });

  it("falls back to first key-value for unknown tool", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "custom_tool",
              arguments: { query: "find me something" },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "custom_tool",
          content: [],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toContain(
      "custom_tool — query: find me something",
    );
  });

  it("shows no arg hint when tool arguments are empty", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "get_session_name",
              arguments: {},
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "get_session_name",
          content: [],
          isError: false,
        },
      },
    ];
    expect(formatTranscript(entries)).toContain(
      "  [tool] get_session_name → completed",
    );
  });
});

describe("formatTranscript — metadata entries", () => {
  it("formats a compaction entry", () => {
    const entries = [
      {
        type: "compaction",
        id: "1",
        parentId: null,
        timestamp: "t",
        summary: "summary text",
        firstKeptEntryId: "abc",
        tokensBefore: 48000,
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "[compaction] Context compacted (48000 tokens before)",
    );
  });

  it("formats a model_change entry", () => {
    const entries = [
      {
        type: "model_change",
        id: "1",
        parentId: null,
        timestamp: "t",
        provider: "anthropic",
        modelId: "claude-opus-4-20250514",
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "[model change] → anthropic/claude-opus-4-20250514",
    );
  });

  it("suppresses a trailing model_change with no following assistant turn", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
      {
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-opus-4-20250514",
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "1. assistant [anthropic/claude-sonnet-4-20250514]\nHi",
    );
  });

  it("keeps only the last of several consecutive model_change entries that precede an assistant turn", () => {
    const entries = [
      {
        type: "model_change",
        provider: "opencode-go",
        modelId: "deepseek-v4-flash",
      },
      {
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-fable-5",
      },
      {
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-opus-4-8",
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "[model change] → anthropic/claude-opus-4-8\n\n---\n\n1. assistant [anthropic/claude-opus-4-8]\nHi",
    );
  });

  it("renders every model_change when the stream has no assistant messages at all (filtered-stream guard)", () => {
    const entries = [
      {
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      },
      {
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-opus-4-20250514",
      },
    ];
    expect(formatTranscript(entries)).toBe(
      "[model change] → anthropic/claude-sonnet-4-20250514\n\n---\n\n[model change] → anthropic/claude-opus-4-20250514",
    );
  });

  it("formats a thinking_level_change entry", () => {
    const entries = [
      {
        type: "thinking_level_change",
        id: "1",
        parentId: null,
        timestamp: "t",
        thinkingLevel: "high",
      },
    ];
    expect(formatTranscript(entries)).toBe("[thinking] → high");
  });

  it("formats a branch_summary entry with truncated snippet", () => {
    const longSummary = "This is a very long branch summary. ".repeat(10);
    const entries = [
      {
        type: "branch_summary",
        id: "1",
        parentId: null,
        timestamp: "t",
        fromId: "x",
        summary: longSummary,
      },
    ];
    const result = formatTranscript(entries);
    expect(result).toMatch(/^\[branch\] /);
    expect(result.length).toBeLessThan(longSummary.length);
  });

  it("formats a short branch_summary without truncation", () => {
    const entries = [
      {
        type: "branch_summary",
        id: "1",
        parentId: null,
        timestamp: "t",
        fromId: "x",
        summary: "Short summary.",
      },
    ];
    expect(formatTranscript(entries)).toBe("[branch] Short summary.");
  });

  it("formats a bashExecution message", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "bashExecution",
          command: "git status",
          output: "On branch main\nnothing to commit",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1000,
        },
      },
    ];
    expect(formatTranscript(entries)).toBe("  [bash] git status (exit: 0)");
  });

  it("formats a bashExecution message with undefined exit code", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "bashExecution",
          command: "sleep 5",
          output: "",
          exitCode: undefined,
          cancelled: true,
          truncated: false,
          timestamp: 1000,
        },
      },
    ];
    expect(formatTranscript(entries)).toBe("  [bash] sleep 5 (cancelled)");
  });

  it("omits custom entries", () => {
    const entries = [
      {
        type: "custom",
        id: "1",
        parentId: null,
        timestamp: "t",
        customType: "my-ext",
        data: { key: "value" },
      },
    ];
    expect(formatTranscript(entries)).toBe("");
  });

  it("omits label entries", () => {
    const entries = [
      {
        type: "label",
        id: "1",
        parentId: null,
        timestamp: "t",
        targetId: "x",
        label: "my label",
      },
    ];
    expect(formatTranscript(entries)).toBe("");
  });

  it("omits session_info entries", () => {
    const entries = [
      {
        type: "session_info",
        id: "1",
        parentId: null,
        timestamp: "t",
        name: "My session",
      },
    ];
    expect(formatTranscript(entries)).toBe("");
  });

  it("omits custom_message entries", () => {
    const entries = [
      {
        type: "custom_message",
        id: "1",
        parentId: null,
        timestamp: "t",
        customType: "my-ext",
        content: "some content",
        display: true,
      },
    ];
    expect(formatTranscript(entries)).toBe("");
  });

  it("places metadata entries between conversation turns with separators", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: { role: "user", content: "Hello", timestamp: 1000 },
      },
      {
        type: "compaction",
        id: "2",
        parentId: "1",
        timestamp: "t",
        summary: "compacted",
        firstKeptEntryId: "1",
        tokensBefore: 10000,
      },
      {
        type: "model_change",
        id: "3",
        parentId: "2",
        timestamp: "t",
        provider: "anthropic",
        modelId: "claude-opus-4-20250514",
      },
      {
        type: "message",
        id: "4",
        parentId: "3",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          provider: "anthropic",
          model: "claude-opus-4-20250514",
        },
      },
    ];
    const result = formatTranscript(entries);
    expect(result).toBe(
      "1. user\nHello\n\n---\n\n[compaction] Context compacted (10000 tokens before)\n\n---\n\n[model change] → anthropic/claude-opus-4-20250514\n\n---\n\n2. assistant [anthropic/claude-opus-4-20250514]\nHi",
    );
  });
});

describe("formatTranscript — basic message formatting", () => {
  it("returns empty string for empty entries", () => {
    expect(formatTranscript([])).toBe("");
  });

  it("formats a user message with string content", () => {
    const entries = [makeUserEntry("How do I fix the login bug?")];
    expect(formatTranscript(entries)).toBe(
      "1. user\nHow do I fix the login bug?",
    );
  });

  it("formats a user message with TextContent array, joining text parts", () => {
    const entries = [
      makeUserEntry([
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ]),
    ];
    expect(formatTranscript(entries)).toBe("1. user\nHello world");
  });

  it("skips non-text content (images) in user message array", () => {
    const entries = [
      makeUserEntry([
        { type: "text", text: "What is in this image?" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ]),
    ];
    expect(formatTranscript(entries)).toBe("1. user\nWhat is in this image?");
  });

  it("formats an assistant message with model attribution", () => {
    const entries = [
      makeAssistantEntry(
        "Let me help you.",
        "anthropic",
        "claude-opus-4-20250514",
      ),
    ];
    expect(formatTranscript(entries)).toBe(
      "1. assistant [anthropic/claude-opus-4-20250514]\nLet me help you.",
    );
  });

  it("uses [unknown/unknown] when provider/model fields are absent", () => {
    const entry = {
      type: "message",
      id: "1",
      parentId: null,
      timestamp: "t",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    };
    expect(formatTranscript([entry])).toBe(
      "1. assistant [unknown/unknown]\nHi",
    );
  });

  it("assigns sequential turn numbers across user and assistant messages", () => {
    const entries = [
      makeUserEntry("First", "1"),
      makeAssistantEntry(
        "Second",
        "anthropic",
        "claude-sonnet-4-20250514",
        "2",
      ),
      makeUserEntry("Third", "3"),
    ];
    const result = formatTranscript(entries);
    expect(result).toContain("1. user\nFirst");
    expect(result).toContain(
      "2. assistant [anthropic/claude-sonnet-4-20250514]\nSecond",
    );
    expect(result).toContain("3. user\nThird");
  });

  it("joins entries with --- separator", () => {
    const entries = [
      makeUserEntry("Hello", "1"),
      makeAssistantEntry(
        "Hi there",
        "anthropic",
        "claude-sonnet-4-20250514",
        "2",
      ),
    ];
    expect(formatTranscript(entries)).toBe(
      "1. user\nHello\n\n---\n\n2. assistant [anthropic/claude-sonnet-4-20250514]\nHi there",
    );
  });

  it("omits thinking content from assistant message", () => {
    const entry = {
      type: "message",
      id: "1",
      parentId: null,
      timestamp: "t",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me reason...",
            thinkingSignature: "sig",
          },
          { type: "text", text: "The answer is 42." },
        ],
        provider: "anthropic",
        model: "claude-opus-4-20250514",
      },
    };
    expect(formatTranscript([entry])).toBe(
      "1. assistant [anthropic/claude-opus-4-20250514]\nThe answer is 42.",
    );
  });

  it("concatenates multiple text blocks in assistant message", () => {
    const entries = [makeAssistantEntry(["First block.", "Second block."])];
    expect(formatTranscript(entries)).toBe(
      "1. assistant [anthropic/claude-sonnet-4-20250514]\nFirst block.\nSecond block.",
    );
  });
});

describe("collectEffectiveModelChangeIndices", () => {
  function modelChange(provider = "anthropic", modelId = "claude-opus") {
    return { type: "model_change", provider, modelId };
  }

  function assistant() {
    return {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "anthropic",
        model: "claude-sonnet",
      },
    };
  }

  it("returns an empty set for an empty array", () => {
    expect(collectEffectiveModelChangeIndices([])).toEqual(new Set());
  });

  it("marks a model_change effective when an assistant turn follows it", () => {
    const entries = [modelChange(), assistant()];
    expect(collectEffectiveModelChangeIndices(entries)).toEqual(new Set([0]));
  });

  it("excludes a trailing model_change with no following assistant turn", () => {
    const entries = [assistant(), modelChange()];
    expect(collectEffectiveModelChangeIndices(entries)).toEqual(new Set());
  });

  it("keeps only the last of several consecutive model_change entries", () => {
    const entries = [modelChange(), modelChange(), modelChange(), assistant()];
    expect(collectEffectiveModelChangeIndices(entries)).toEqual(new Set([2]));
  });

  it("tracks multiple effective switches interleaved with assistant turns", () => {
    const entries = [
      assistant(),
      modelChange(),
      assistant(),
      modelChange(),
      assistant(),
    ];
    expect(collectEffectiveModelChangeIndices(entries)).toEqual(
      new Set([1, 3]),
    );
  });

  it("treats every model_change as effective when no assistant message is present (filtered-stream guard)", () => {
    const entries = [modelChange(), modelChange(), modelChange()];
    expect(collectEffectiveModelChangeIndices(entries)).toEqual(
      new Set([0, 1, 2]),
    );
  });
});
