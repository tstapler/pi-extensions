/**
 * Builds the working-directory instruction block appended to the system prompt.
 *
 * Pi already states the resolved CWD: its system prompt ends with a
 * `Current working directory: <path>` footer, and that line survives downstream
 * shaping (e.g. pi-anthropic-auth, which only rewrites the preamble span). What
 * Pi ships nowhere — default or shaped — is any *instruction* against
 * `cd`-prefixing the CWD; the footer is a bare statement of fact, not a rule.
 *
 * This block adds that missing prohibition. It repeats the literal resolved path
 * only to make the forbidden `cd <path> &&` example concrete, not because the
 * path is otherwise unavailable to the agent.
 */

/** Marker used to detect and avoid double-appending the block. */
export const WORKING_DIRECTORY_HEADING = "# Working Directory";

/** Opening words of the block's sentence, ahead of the literal path. */
const SENTENCE_PREFIX = "Shell commands already execute in";

/** Lines spanned by a block: the heading, a blank line, and the sentence. */
const BLOCK_LINE_COUNT = 3;

/**
 * Build the instruction block for a given resolved working directory.
 *
 * @param cwd - The resolved current working directory (e.g. `ctx.cwd`).
 * @returns A markdown block naming the literal path and forbidding `cd`-into-cwd.
 */
export function buildWorkingDirectoryPrompt(cwd: string): string {
  return [
    WORKING_DIRECTORY_HEADING,
    "",
    `${SENTENCE_PREFIX} \`${cwd}\`. ` +
      "Never prefix a command with `cd` into the current working directory — " +
      `neither \`cd ${cwd} &&\` nor \`cd $(pwd) &&\`. ` +
      "Just run the command directly.",
  ].join("\n");
}

/**
 * Ensure the system prompt carries the working-directory block for `cwd`.
 *
 * Idempotent: a prompt that already names this directory is returned unchanged,
 * so chained `before_agent_start` handlers do not stack duplicates.
 *
 * A block naming a *different* directory is rewritten in place rather than
 * deferred to. A subagent inherits its parent's system prompt verbatim, so a
 * child session sees a block built for the parent's cwd; skipping on the bare
 * heading left that child instructed to treat the parent's path as its own
 * (#640). Rewriting in place keeps the block's position stable across turns.
 *
 * A block under the same heading that this module did not write belongs to
 * another handler and is left alone.
 *
 * @param systemPrompt - The fully assembled system prompt.
 * @param cwd - The resolved current working directory.
 * @returns The system prompt with the working-directory block present.
 */
export function ensureWorkingDirectoryPrompt(
  systemPrompt: string,
  cwd: string,
): string {
  const block = buildWorkingDirectoryPrompt(cwd);
  if (systemPrompt.includes(block)) {
    return systemPrompt;
  }

  const lines = systemPrompt.split("\n");
  const staleAt = findOurBlock(lines);
  if (staleAt !== undefined) {
    lines.splice(staleAt, BLOCK_LINE_COUNT, ...block.split("\n"));
    return lines.join("\n");
  }

  if (systemPrompt.includes(WORKING_DIRECTORY_HEADING)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${block}`;
}

/**
 * Locate a block this module wrote, by its heading and its sentence opener.
 *
 * Matching the sentence too keeps another handler's section under the same
 * heading from being overwritten.
 *
 * @returns The index of the heading line, or `undefined` when absent.
 */
function findOurBlock(lines: string[]): number | undefined {
  const heading = lines.indexOf(WORKING_DIRECTORY_HEADING);
  if (heading === -1) {
    return undefined;
  }
  return lines[heading + 2]?.startsWith(SENTENCE_PREFIX) ? heading : undefined;
}
