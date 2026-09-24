/**
 * Maps the portable `onProgress` callback to Pi's `onUpdate` streaming mechanism.
 *
 * The `onUpdate` callback expects an `AgentToolResult`-shaped object with
 * `content` as an array of TextContent and a `details` field.
 */

/** Minimal shape compatible with Pi's `AgentToolUpdateCallback`. */
type OnUpdate = (partialResult: {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError: boolean;
}) => void;

/**
 * Create an `onProgress` callback that forwards lines to Pi's `onUpdate`.
 * Returns `undefined` when `onUpdate` is not provided (tool called without streaming).
 */
export function createProgressCallback(
  onUpdate: OnUpdate | undefined,
): ((line: string) => void) | undefined {
  if (!onUpdate) return undefined;
  return (line: string) => {
    onUpdate({
      content: [{ type: "text", text: line }],
      details: undefined,
      isError: false,
    });
  };
}
