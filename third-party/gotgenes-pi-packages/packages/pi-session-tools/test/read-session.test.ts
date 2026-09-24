import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import sessionTools from "#src/index";

// We'll test the tool's execute function directly. Since the extension registers
// tools via pi.registerTool, we capture the registered tool definitions.

function captureTools(factory: (pi: ExtensionAPI) => void) {
  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const pi = {
    registerTool: vi.fn(
      (tool: {
        name: string;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) => {
        tools.set(tool.name, tool);
      },
    ),
  } as unknown as ExtensionAPI;
  factory(pi);
  return tools;
}

function makeCtx(entries: unknown[], sessionFile?: string): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

describe("read_session tool", () => {
  it("returns session entries as transcript", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session");
    expect(tool).toBeDefined();

    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "hi", timestamp: 1 },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello back" }],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
    ];

    const ctx = makeCtx(entries);
    const result = await tool!.execute("tc1", {}, undefined, undefined, ctx);
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe(
      "1. user\nhi\n\n---\n\n2. assistant [anthropic/claude-sonnet-4-20250514]\nhello back",
    );
  });

  it("filters entries by type before formatting", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session")!;

    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "first", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "2",
        parentId: "1",
        timestamp: "t2",
        summary: "compacted",
        firstKeptEntryId: "1",
        tokensBefore: 5000,
      },
      {
        type: "message",
        id: "3",
        parentId: "2",
        timestamp: "t3",
        message: { role: "user", content: "second", timestamp: 2 },
      },
    ];

    const ctx = makeCtx(entries);
    const result = await tool.execute(
      "tc1",
      { types: ["compaction"] },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe("[compaction] Context compacted (5000 tokens before)");
  });

  it("limits to the most recent N entries before formatting", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session")!;

    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "first", timestamp: 1 },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t2",
        message: { role: "user", content: "second", timestamp: 2 },
      },
      {
        type: "message",
        id: "3",
        parentId: "2",
        timestamp: "t3",
        message: { role: "user", content: "third", timestamp: 3 },
      },
    ];

    const ctx = makeCtx(entries);
    const result = await tool.execute(
      "tc1",
      { limit: 2 },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    // Last two entries; turn counter is relative to the formatted slice
    expect(text).toContain("second");
    expect(text).toContain("third");
    expect(text).not.toContain("first");
  });

  it("combines type filter and limit before formatting", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session")!;

    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "one", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "2",
        parentId: "1",
        timestamp: "t2",
        summary: "x",
        firstKeptEntryId: "1",
        tokensBefore: 1000,
      },
      {
        type: "message",
        id: "3",
        parentId: "2",
        timestamp: "t3",
        message: { role: "user", content: "two", timestamp: 2 },
      },
      {
        type: "message",
        id: "4",
        parentId: "3",
        timestamp: "t4",
        message: { role: "user", content: "three", timestamp: 3 },
      },
    ];

    const ctx = makeCtx(entries);
    const result = await tool.execute(
      "tc1",
      { types: ["message"], limit: 1 },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("three");
    expect(text).not.toContain("one");
    expect(text).not.toContain("two");
  });

  it("returns empty string when no entries match the filter", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session")!;

    const ctx = makeCtx([
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
    ]);
    const result = await tool.execute(
      "tc1",
      { types: ["compaction"] },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe("");
  });

  describe("details", () => {
    it("returns transcript details with summary counts", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_session")!;

      const entries = [
        {
          type: "message",
          message: { role: "user", content: "hello" },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "toolCall", id: "tc1", name: "Read", arguments: {} },
            ],
            provider: "anthropic",
            model: "claude-sonnet",
          },
        },
        { type: "compaction", tokensBefore: 1000 },
        { type: "model_change", provider: "anthropic", modelId: "claude-opus" },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "switched" }],
            provider: "anthropic",
            model: "claude-opus",
          },
        },
      ];

      const ctx = makeCtx(entries);
      const result = (await tool.execute(
        "tc1",
        {},
        undefined,
        undefined,
        ctx,
      )) as {
        details: { kind: string; summary: Record<string, number> };
      };

      expect(result.details).toEqual({
        kind: "transcript",
        summary: {
          totalEntries: 5,
          messages: 3,
          toolCalls: 1,
          compactions: 1,
          modelChanges: 1,
        },
      });
    });

    it("returns transcript details with zero counts when filter produces no entries", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_session")!;

      const ctx = makeCtx([
        { type: "message", message: { role: "user", content: "hello" } },
      ]);
      const result = (await tool.execute(
        "tc1",
        { types: ["compaction"] },
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; summary: { totalEntries: number } } };

      expect(result.details.kind).toBe("transcript");
      expect(result.details.summary.totalEntries).toBe(0);
    });
  }); // describe("details")
});
