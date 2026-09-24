import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import sessionTools from "#src/index";

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

function makeCtx(): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
}

const mockExistsSync = vi.hoisted(() =>
  vi.fn((_path: string): boolean => false),
);
const mockReadFileSync = vi.hoisted(() =>
  vi.fn((_path: string, _enc: string): string => ""),
);
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
}));

describe("read_session_file tool", () => {
  it("returns a status message when the session file does not exist", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session_file")!;
    expect(tool).toBeDefined();

    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx();
    const result = await tool.execute(
      "tc1",
      { path: "/sessions/--project--/missing.jsonl" },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe(
      "Session file not found: /sessions/--project--/missing.jsonl",
    );
  });

  it("reads and returns the session file's entries as a transcript", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session_file")!;

    mockExistsSync.mockReturnValue(true);
    const fileEntries = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        timestamp: "2026-01-01T00:00:00Z",
        cwd: "/project",
      }),
      JSON.stringify({
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      }),
    ].join("\n");
    mockReadFileSync.mockReturnValue(fileEntries);

    const ctx = makeCtx();
    const result = await tool.execute(
      "tc1",
      { path: "/sessions/--project--/2026-05-20T12-00-00Z_.jsonl" },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe(
      "1. user\nhello\n\n---\n\n2. assistant [anthropic/claude-sonnet-4-20250514]\nhi",
    );
  });

  it("supports type filtering", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session_file")!;

    mockExistsSync.mockReturnValue(true);
    const fileEntries = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        timestamp: "t0",
        cwd: "/",
      }),
      JSON.stringify({
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "hi", timestamp: 1 },
      }),
      JSON.stringify({
        type: "model_change",
        id: "2",
        parentId: "1",
        timestamp: "t2",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      }),
    ].join("\n");
    mockReadFileSync.mockReturnValue(fileEntries);

    const ctx = makeCtx();
    const result = await tool.execute(
      "tc1",
      { path: "/sessions/--project--/s.jsonl", types: ["model_change"] },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toBe(
      "[model change] \u2192 anthropic/claude-sonnet-4-20250514",
    );
  });

  it("supports limit filtering", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_session_file")!;

    mockExistsSync.mockReturnValue(true);
    const fileEntries = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        timestamp: "t0",
        cwd: "/",
      }),
      JSON.stringify({
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "first", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "t2",
        message: { role: "user", content: "second", timestamp: 2 },
      }),
    ].join("\n");
    mockReadFileSync.mockReturnValue(fileEntries);

    const ctx = makeCtx();
    const result = await tool.execute(
      "tc1",
      { path: "/sessions/--project--/s.jsonl", limit: 1 },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("second");
    expect(text).not.toContain("first");
  });

  describe("details", () => {
    it("returns status details when the session file is not found", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_session_file")!;

      mockExistsSync.mockReturnValue(false);

      const ctx = makeCtx();
      const result = (await tool.execute(
        "tc1",
        { path: "/sessions/--project--/missing.jsonl" },
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; message: string } };

      expect(result.details.kind).toBe("status");
      expect(result.details.message).toBe(
        "Session file not found: /sessions/--project--/missing.jsonl",
      );
    });

    it("returns transcript details with summary counts on success", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_session_file")!;

      mockExistsSync.mockReturnValue(true);
      const fileEntries = [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s1",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/project",
        }),
        JSON.stringify({
          type: "message",
          id: "1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        }),
        JSON.stringify({
          type: "message",
          id: "2",
          parentId: "1",
          timestamp: "2026-01-01T00:00:02Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "toolCall", id: "tc1", name: "Read", arguments: {} },
            ],
            provider: "anthropic",
            model: "claude-sonnet",
          },
        }),
      ].join("\n");
      mockReadFileSync.mockReturnValue(fileEntries);

      const ctx = makeCtx();
      const result = (await tool.execute(
        "tc1",
        { path: "/sessions/--project--/s.jsonl" },
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; summary: Record<string, number> } };

      expect(result.details).toEqual({
        kind: "transcript",
        summary: {
          totalEntries: 2,
          messages: 2,
          toolCalls: 1,
          compactions: 0,
          modelChanges: 0,
        },
      });
    });
  }); // describe("details")
});
