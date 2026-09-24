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

function makeCtx(sessionFile: string | undefined): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

// Mock node:fs to avoid real file system access
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

describe("read_parent_session tool", () => {
  it("returns error when not running in a subagent context", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_parent_session")!;
    expect(tool).toBeDefined();

    // Session file not in a tasks/ directory
    const ctx = makeCtx("/sessions/--project--/2026-05-20T12-00-00Z_.jsonl");
    const result = await tool.execute("tc1", {}, undefined, undefined, ctx);
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("not running inside a subagent");
  });

  it("returns error when session file is undefined", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_parent_session")!;

    const ctx = makeCtx(undefined);
    const result = await tool.execute("tc1", {}, undefined, undefined, ctx);
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("not running inside a subagent");
  });

  it("returns error when parent session file does not exist", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_parent_session")!;

    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx(
      "/sessions/--project--/2026-05-20T12-00-00Z_/tasks/child.jsonl",
    );
    const result = await tool.execute("tc1", {}, undefined, undefined, ctx);
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Parent session file not found");
  });

  it("reads and returns parent session entries as transcript", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_parent_session")!;

    mockExistsSync.mockReturnValue(true);
    const parentEntries = [
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
    mockReadFileSync.mockReturnValue(parentEntries);

    const ctx = makeCtx(
      "/sessions/--project--/2026-05-20T12-00-00Z_/tasks/child.jsonl",
    );
    const result = await tool.execute("tc1", {}, undefined, undefined, ctx);
    const text = (result as { content: { text: string }[] }).content[0].text;
    // Session header is stripped; user and assistant turns are formatted
    expect(text).toBe(
      "1. user\nhello\n\n---\n\n2. assistant [anthropic/claude-sonnet-4-20250514]\nhi",
    );
  });

  it("supports type filtering on parent entries before formatting", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("read_parent_session")!;

    mockExistsSync.mockReturnValue(true);
    const parentEntries = [
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
    mockReadFileSync.mockReturnValue(parentEntries);

    const ctx = makeCtx("/sessions/parent/tasks/child.jsonl");
    const result = await tool.execute(
      "tc1",
      { types: ["model_change"] },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    // Only model_change entry passes the filter
    expect(text).toBe(
      "[model change] \u2192 anthropic/claude-sonnet-4-20250514",
    );
  });

  describe("details", () => {
    it("returns status details when not in a subagent context", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_parent_session")!;

      const ctx = makeCtx("/sessions/--project--/2026-05-20T12-00-00Z_.jsonl");
      const result = (await tool.execute(
        "tc1",
        {},
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; message: string } };

      expect(result.details.kind).toBe("status");
      expect(result.details.message).toBeTruthy();
    });

    it("returns status details when parent session file is not found", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_parent_session")!;

      mockExistsSync.mockReturnValue(false);

      const ctx = makeCtx(
        "/sessions/--project--/2026-05-20T12-00-00Z_/tasks/child.jsonl",
      );
      const result = (await tool.execute(
        "tc1",
        {},
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; message: string } };

      expect(result.details.kind).toBe("status");
      expect(result.details.message).toBeTruthy();
    });

    it("returns transcript details with summary counts on success", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("read_parent_session")!;

      mockExistsSync.mockReturnValue(true);
      const parentEntries = [
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
      mockReadFileSync.mockReturnValue(parentEntries);

      const ctx = makeCtx(
        "/sessions/--project--/2026-05-20T12-00-00Z_/tasks/child.jsonl",
      );
      const result = (await tool.execute(
        "tc1",
        {},
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; summary: Record<string, number> } };

      expect(result.details).toEqual({
        kind: "transcript",
        summary: {
          totalEntries: 2, // session header filtered out
          messages: 2,
          toolCalls: 1,
          compactions: 0,
          modelChanges: 0,
        },
      });
    });
  }); // describe("details")
});
