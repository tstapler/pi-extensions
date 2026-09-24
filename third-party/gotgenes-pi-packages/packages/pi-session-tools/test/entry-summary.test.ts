import { describe, expect, it } from "vitest";
import { formatSummaryText, summarizeEntries } from "#src/entry-summary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMessage(content = "hi") {
  return {
    type: "message",
    message: { role: "user", content },
  };
}

function assistantMessage(toolCallCount = 0) {
  const textPart = { type: "text", text: "response" };
  const toolCalls = Array.from({ length: toolCallCount }, (_, i) => ({
    type: "toolCall",
    id: `tc${i}`,
    name: "SomeTool",
    arguments: {},
  }));
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [textPart, ...toolCalls],
      provider: "anthropic",
      model: "claude-sonnet",
    },
  };
}

function compactionEntry() {
  return { type: "compaction", tokensBefore: 5000 };
}

function modelChangeEntry() {
  return {
    type: "model_change",
    provider: "anthropic",
    modelId: "claude-opus",
  };
}

function thinkingLevelEntry() {
  return { type: "thinking_level_change", thinkingLevel: "high" };
}

// ---------------------------------------------------------------------------
// summarizeEntries
// ---------------------------------------------------------------------------

describe("summarizeEntries", () => {
  it("returns zeros for an empty array", () => {
    expect(summarizeEntries([])).toEqual({
      totalEntries: 0,
      messages: 0,
      toolCalls: 0,
      compactions: 0,
      modelChanges: 0,
    });
  });

  it("counts totalEntries as the length of the array", () => {
    const entries = [userMessage(), compactionEntry(), modelChangeEntry()];
    expect(summarizeEntries(entries).totalEntries).toBe(3);
  });

  it("counts user and assistant messages", () => {
    const entries = [userMessage(), assistantMessage(0), userMessage()];
    expect(summarizeEntries(entries).messages).toBe(3);
  });

  it("does not count toolResult or bashExecution messages", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "x",
          toolName: "T",
          isError: false,
        },
      },
      {
        type: "message",
        message: { role: "bashExecution", command: "ls", exitCode: 0 },
      },
    ];
    expect(summarizeEntries(entries).messages).toBe(0);
  });

  it("counts toolCall parts within assistant message content", () => {
    const entries = [assistantMessage(3)];
    expect(summarizeEntries(entries).toolCalls).toBe(3);
  });

  it("does not count text parts as tool calls", () => {
    const entries = [assistantMessage(0)];
    expect(summarizeEntries(entries).toolCalls).toBe(0);
  });

  it("accumulates tool calls across multiple assistant messages", () => {
    const entries = [assistantMessage(2), assistantMessage(1)];
    expect(summarizeEntries(entries).toolCalls).toBe(3);
  });

  it("does not count tool calls in user messages", () => {
    // User content can be arrays too; they should not be counted
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "toolCall", id: "x", name: "T", arguments: {} }],
        },
      },
    ];
    expect(summarizeEntries(entries).toolCalls).toBe(0);
  });

  it("counts compaction entries", () => {
    const entries = [compactionEntry(), compactionEntry()];
    expect(summarizeEntries(entries).compactions).toBe(2);
  });

  it("counts model_change entries when no assistant message is present (filtered-stream guard)", () => {
    const entries = [
      modelChangeEntry(),
      modelChangeEntry(),
      modelChangeEntry(),
    ];
    expect(summarizeEntries(entries).modelChanges).toBe(3);
  });

  it("counts only effective model changes — ones followed by an assistant turn", () => {
    const entries = [modelChangeEntry(), assistantMessage(0)];
    expect(summarizeEntries(entries).modelChanges).toBe(1);
  });

  it("excludes a trailing model_change with no following assistant turn from the count", () => {
    const entries = [assistantMessage(0), modelChangeEntry()];
    expect(summarizeEntries(entries).modelChanges).toBe(0);
  });

  it("counts only the last of several consecutive model_change entries that precede a turn", () => {
    const entries = [
      modelChangeEntry(),
      modelChangeEntry(),
      modelChangeEntry(),
      assistantMessage(0),
    ];
    expect(summarizeEntries(entries).modelChanges).toBe(1);
  });

  it("ignores unrelated entry types", () => {
    const entries = [thinkingLevelEntry()];
    const summary = summarizeEntries(entries);
    expect(summary).toEqual({
      totalEntries: 1,
      messages: 0,
      toolCalls: 0,
      compactions: 0,
      modelChanges: 0,
    });
  });

  it("handles a realistic mixed session", () => {
    const entries = [
      userMessage(),
      assistantMessage(2),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc0",
          toolName: "Read",
          isError: false,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "Bash",
          isError: false,
        },
      },
      userMessage(),
      assistantMessage(1),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc2",
          toolName: "Write",
          isError: false,
        },
      },
      compactionEntry(),
      modelChangeEntry(),
    ];
    expect(summarizeEntries(entries)).toEqual({
      totalEntries: 9,
      messages: 4, // 2 user + 2 assistant
      toolCalls: 3, // 2 + 1
      compactions: 1,
      modelChanges: 0, // trailing model_change has no following assistant turn — phantom
    });
  });
});

// ---------------------------------------------------------------------------
// formatSummaryText
// ---------------------------------------------------------------------------

describe("formatSummaryText", () => {
  it("returns '0 entries' for an all-zero summary", () => {
    expect(
      formatSummaryText({
        totalEntries: 0,
        messages: 0,
        toolCalls: 0,
        compactions: 0,
        modelChanges: 0,
      }),
    ).toBe("0 entries");
  });

  it("uses singular 'entry' when totalEntries is 1", () => {
    expect(
      formatSummaryText({
        totalEntries: 1,
        messages: 1,
        toolCalls: 0,
        compactions: 0,
        modelChanges: 0,
      }),
    ).toBe("1 entry — 1 message");
  });

  it("uses plural 'entries' when totalEntries is 2", () => {
    expect(
      formatSummaryText({
        totalEntries: 2,
        messages: 2,
        toolCalls: 0,
        compactions: 0,
        modelChanges: 0,
      }),
    ).toBe("2 entries — 2 messages");
  });

  it("omits zero-count breakdown categories", () => {
    expect(
      formatSummaryText({
        totalEntries: 3,
        messages: 3,
        toolCalls: 0,
        compactions: 0,
        modelChanges: 0,
      }),
    ).toBe("3 entries — 3 messages");
  });

  it("includes all non-zero breakdown categories", () => {
    expect(
      formatSummaryText({
        totalEntries: 142,
        messages: 120,
        toolCalls: 18,
        compactions: 2,
        modelChanges: 2,
      }),
    ).toBe(
      "142 entries — 120 messages, 18 tool calls, 2 compactions, 2 model changes",
    );
  });

  it("uses singular 'message' for count 1", () => {
    expect(
      formatSummaryText({
        totalEntries: 1,
        messages: 1,
        toolCalls: 0,
        compactions: 0,
        modelChanges: 0,
      }),
    ).toBe("1 entry — 1 message");
  });

  it("uses singular 'tool call' for count 1", () => {
    expect(
      formatSummaryText({
        totalEntries: 2,
        messages: 1,
        toolCalls: 1,
        compactions: 0,
        modelChanges: 0,
      }),
    ).toBe("2 entries — 1 message, 1 tool call");
  });

  it("uses singular 'compaction' for count 1", () => {
    expect(
      formatSummaryText({
        totalEntries: 2,
        messages: 1,
        toolCalls: 0,
        compactions: 1,
        modelChanges: 0,
      }),
    ).toBe("2 entries — 1 message, 1 compaction");
  });

  it("uses singular 'model change' for count 1", () => {
    expect(
      formatSummaryText({
        totalEntries: 2,
        messages: 1,
        toolCalls: 0,
        compactions: 0,
        modelChanges: 1,
      }),
    ).toBe("2 entries — 1 message, 1 model change");
  });

  it("handles a session with only structural events and no messages", () => {
    expect(
      formatSummaryText({
        totalEntries: 3,
        messages: 0,
        toolCalls: 0,
        compactions: 2,
        modelChanges: 1,
      }),
    ).toBe("3 entries — 2 compactions, 1 model change");
  });

  it("emits no em-dash when all breakdown categories are zero", () => {
    const text = formatSummaryText({
      totalEntries: 5,
      messages: 0,
      toolCalls: 0,
      compactions: 0,
      modelChanges: 0,
    });
    expect(text).toBe("5 entries");
  });
});
