import { describe, expect, it } from "vitest";
import {
  buildWorkingDirectoryPrompt,
  ensureWorkingDirectoryPrompt,
  WORKING_DIRECTORY_HEADING,
} from "#src/working-directory-prompt.js";

describe("buildWorkingDirectoryPrompt", () => {
  it("names the literal resolved working directory", () => {
    const cwd = "/Users/chris/development/pi/pi-packages";
    const block = buildWorkingDirectoryPrompt(cwd);
    expect(block).toContain(`\`${cwd}\``);
  });

  it("forbids cd-prefixing the literal cwd", () => {
    const cwd = "/srv/project";
    const block = buildWorkingDirectoryPrompt(cwd);
    expect(block).toContain(`cd ${cwd} &&`);
  });

  it("forbids the generic cd $(pwd) prefix", () => {
    const block = buildWorkingDirectoryPrompt("/srv/project");
    expect(block).toContain("cd $(pwd) &&");
  });

  it("starts with the heading marker", () => {
    const block = buildWorkingDirectoryPrompt("/srv/project");
    expect(block.startsWith(WORKING_DIRECTORY_HEADING)).toBe(true);
  });
});

describe("ensureWorkingDirectoryPrompt", () => {
  it("appends the block to an existing system prompt", () => {
    const result = ensureWorkingDirectoryPrompt(
      "You are a helpful assistant.",
      "/srv/project",
    );
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain(WORKING_DIRECTORY_HEADING);
    expect(result).toContain("`/srv/project`");
  });

  it("separates the base prompt from the block with a blank line", () => {
    const result = ensureWorkingDirectoryPrompt("Base.", "/srv/project");
    expect(result).toContain(`Base.\n\n${WORKING_DIRECTORY_HEADING}`);
  });

  it("is idempotent when the block is already present", () => {
    const once = ensureWorkingDirectoryPrompt("Base.", "/srv/project");
    const twice = ensureWorkingDirectoryPrompt(once, "/srv/project");
    expect(twice).toBe(once);
  });

  // Issue #640: a subagent inherits its parent's system prompt verbatim, so a
  // child sees a block naming the parent's directory. Deferring to it left the
  // child with an instruction pointing at the wrong path.
  describe("inherited block naming another directory", () => {
    it("rewrites the block to name the current working directory", () => {
      const inherited = ensureWorkingDirectoryPrompt("Base.", "/repo");

      const result = ensureWorkingDirectoryPrompt(inherited, "/repo/worktree");

      expect(result).toBe(
        `Base.\n\n${buildWorkingDirectoryPrompt("/repo/worktree")}`,
      );
    });

    it("rewrites in place rather than appending a second block", () => {
      const inherited = `${ensureWorkingDirectoryPrompt("Base.", "/repo")}\n\nTrailing content.`;

      const result = ensureWorkingDirectoryPrompt(inherited, "/repo/worktree");

      expect(result).toBe(
        `Base.\n\n${buildWorkingDirectoryPrompt("/repo/worktree")}\n\nTrailing content.`,
      );
    });

    it("is stable under repeat application", () => {
      const inherited = ensureWorkingDirectoryPrompt("Base.", "/repo");

      const once = ensureWorkingDirectoryPrompt(inherited, "/repo/worktree");
      const twice = ensureWorkingDirectoryPrompt(once, "/repo/worktree");

      expect(twice).toBe(once);
    });

    it("leaves a foreign block under the same heading untouched", () => {
      const foreign = `Base.\n\n${WORKING_DIRECTORY_HEADING}\n\nSomeone else's rules about directories.`;

      const result = ensureWorkingDirectoryPrompt(foreign, "/srv/project");

      expect(result).toBe(foreign);
    });
  });
});
