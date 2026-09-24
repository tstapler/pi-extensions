/**
 * Helper to create AgentToolResult-compatible objects.
 *
 * Pi's AgentToolResult expects `content` as an array of TextContent objects
 * and a `details` field. This helper wraps a plain string into that shape.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError: boolean;
}

export function ok(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: false,
  };
}

export function err(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  };
}
