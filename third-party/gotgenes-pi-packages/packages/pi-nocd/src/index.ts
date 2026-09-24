/**
 * pi-nocd — Inject the resolved working directory into the system prompt.
 *
 * Hooks `before_agent_start` and ensures the prompt carries a block forbidding
 * `cd`-into-cwd command prefixes. Pi's prompt already states the resolved CWD (a
 * `Current working directory: <path>` footer that survives downstream shaping),
 * but ships no instruction against `cd`-prefixing it. This adds that rule to
 * defeat the habit of prefixing commands with `cd $(pwd) &&`.
 *
 * The block names a literal path, so an inherited one (a subagent receives its
 * parent's prompt verbatim) is rewritten for the current session's cwd rather
 * than left pointing at the parent's directory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureWorkingDirectoryPrompt } from "./working-directory-prompt.js";

export default function piNocd(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => ({
    systemPrompt: ensureWorkingDirectoryPrompt(event.systemPrompt, ctx.cwd),
  }));
}
