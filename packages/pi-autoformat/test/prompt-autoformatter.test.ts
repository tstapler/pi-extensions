import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuiltinFormatter } from "#src/builtin-formatters";
import type { CommandRunner } from "#src/formatter-executor";
import type { FormatterConfig } from "#src/formatter-registry";
import { PromptAutoformatter } from "#src/prompt-autoformatter";

describe("PromptAutoformatter", () => {
  const config: FormatterConfig = {
    formatters: {
      prettier: {
        command: ["prettier", "--write"],
      },
      markdownlint: {
        command: ["markdownlint-cli2", "--fix"],
      },
    },
    chains: {
      ".md": ["prettier", "markdownlint"],
      ".ts": ["prettier"],
    },
  };

  it("is a no-op when no formatter matches touched files", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { exitCode: 0 };
    };

    const formatter = new PromptAutoformatter("/repo", config, runner);
    formatter.recordToolResult("write", { path: "assets/logo.png" });

    const result = await formatter.flushPrompt();

    expect(calls).toEqual([]);
    expect(result).toEqual({ groups: [] });
  });

  it("dedupes touched files and runs each chain step once per group", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { exitCode: 0 };
    };

    const formatter = new PromptAutoformatter("/repo", config, runner);
    formatter.recordToolResult("write", { path: "docs/readme.md" });
    formatter.recordToolResult("edit", { path: "./docs/readme.md" });

    const result = await formatter.flushPrompt();

    expect(calls).toEqual([
      "prettier --write /repo/docs/readme.md",
      "markdownlint-cli2 --fix /repo/docs/readme.md",
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual(["/repo/docs/readme.md"]);
    expect(result.groups[0].chain).toEqual(["prettier", "markdownlint"]);
  });

  it("batches multiple files that share a chain into a single invocation per step", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0 };
    };

    const formatter = new PromptAutoformatter("/repo", config, runner);
    formatter.recordToolResult("write", { path: "docs/a.md" });
    formatter.recordToolResult("write", { path: "docs/b.md" });

    const result = await formatter.flushPrompt();

    expect(calls).toEqual([
      {
        command: "prettier",
        args: ["--write", "/repo/docs/a.md", "/repo/docs/b.md"],
      },
      {
        command: "markdownlint-cli2",
        args: ["--fix", "/repo/docs/a.md", "/repo/docs/b.md"],
      },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([
      "/repo/docs/a.md",
      "/repo/docs/b.md",
    ]);
  });

  it("produces one group per distinct chain", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 0 });

    const formatter = new PromptAutoformatter("/repo", config, runner);
    formatter.recordToolResult("write", { path: "src/index.ts" });
    formatter.recordToolResult("write", { path: "docs/readme.md" });

    const result = await formatter.flushPrompt();

    expect(result.groups.map((g) => g.chain)).toEqual([
      ["prettier"],
      ["prettier", "markdownlint"],
    ]);
  });

  it("returns formatter failures per batch without throwing", async () => {
    const runner: CommandRunner = async (command) => {
      if (command === "prettier") {
        return { exitCode: 2, stderr: "parse error" };
      }
      return { exitCode: 0 };
    };

    const formatter = new PromptAutoformatter("/repo", config, runner);
    formatter.recordToolResult("write", { path: "docs/readme.md" });

    const result = await formatter.flushPrompt();
    const group = result.groups[0];

    expect(group.files).toEqual(["/repo/docs/readme.md"]);
    expect(group.runs[0]).toMatchObject({
      formatterName: "prettier",
      success: false,
      exitCode: 2,
      files: ["/repo/docs/readme.md"],
    });
    expect(group.runs[1]).toMatchObject({
      formatterName: "markdownlint",
      success: true,
      exitCode: 0,
    });
  });

  it("shares the PATH probe cache across all chain groups in a single flush", async () => {
    const fallbackConfig: FormatterConfig = {
      formatters: {
        biome: { command: ["biome", "format", "--write"] },
        prettier: { command: ["prettier", "--write"] },
      },
      chains: {
        ".ts": [{ fallback: ["biome", "prettier"] }],
        ".tsx": [{ fallback: ["biome", "prettier"] }],
        // Distinct chain so a second group is created.
        ".js": [{ fallback: ["biome", "prettier"] }, "prettier"],
      },
    };
    const runner: CommandRunner = async () => ({ exitCode: 0 });
    const probeCalls: string[] = [];
    const probe = (cmd: string): boolean => {
      probeCalls.push(cmd);
      return cmd === "prettier";
    };

    const formatter = new PromptAutoformatter("/repo", fallbackConfig, runner, {
      commandProbe: probe,
    });
    formatter.addTouchedPath("/repo/a.ts");
    formatter.addTouchedPath("/repo/b.tsx");
    formatter.addTouchedPath("/repo/c.js");

    const result = await formatter.flushPrompt();
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    // Each unique command name probed at most once across the whole flush.
    const counts = probeCalls.reduce<Record<string, number>>((acc, cmd) => {
      acc[cmd] = (acc[cmd] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts.biome).toBeLessThanOrEqual(1);
    expect(counts.prettier).toBeLessThanOrEqual(1);
  });

  describe("with a wildcard chain", () => {
    function fakeTreefmt(
      unhandledPredicate: (file: string) => boolean,
    ): BuiltinFormatter {
      return {
        name: "treefmt",
        async discoverRoot() {
          return "/repo";
        },
        buildCommand(root, files) {
          return {
            command: ["treefmt", "--", ...files],
            cwd: root,
          };
        },
        partitionUnhandled(_run, files) {
          const unhandled = files.filter(unhandledPredicate);
          const handled = files.filter((f) => !unhandledPredicate(f));
          return { handled, unhandled, treatAsSkip: false };
        },
      };
    }

    it("runs the wildcard chain first across all touched files and skips per-extension chains for handled files", async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const runner: CommandRunner = async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0 };
      };
      const builtinConfig: FormatterConfig = {
        formatters: {
          prettier: { command: ["prettier", "--write"] },
        },
        chains: {
          "*": ["treefmt"],
          ".ts": ["prettier"],
          ".bin": ["prettier"],
        },
      };
      // Patch the global treefmt built-in's hooks for this test.
      const { BUILTIN_FORMATTERS } = await import(
        "../src/builtin-formatters.js"
      );
      const original = { ...BUILTIN_FORMATTERS.treefmt };
      const fake = fakeTreefmt((f) => f.endsWith(".bin"));
      BUILTIN_FORMATTERS.treefmt.discoverRoot = fake.discoverRoot;
      BUILTIN_FORMATTERS.treefmt.buildCommand = fake.buildCommand;
      BUILTIN_FORMATTERS.treefmt.partitionUnhandled = fake.partitionUnhandled;
      try {
        const formatter = new PromptAutoformatter(
          "/repo",
          builtinConfig,
          runner,
        );
        formatter.addTouchedPath("/repo/a.ts");
        formatter.addTouchedPath("/repo/b.bin");

        const result = await formatter.flushPrompt();

        // treefmt invoked once with both files; prettier runs only on the
        // unhandled .bin file (per-ext chain backstops the wildcard skip).
        expect(calls[0]).toEqual({
          command: "treefmt",
          args: ["--", "/repo/a.ts", "/repo/b.bin"],
        });
        const prettierCalls = calls.filter((c) => c.command === "prettier");
        expect(prettierCalls).toHaveLength(1);
        expect(prettierCalls[0]?.args).toEqual(["--write", "/repo/b.bin"]);
        // Sanity: groups recorded.
        expect(result.groups[0].chain).toEqual(["treefmt"]);
      } finally {
        Object.assign(BUILTIN_FORMATTERS.treefmt, original);
      }
    });

    it("removes wildcard-handled files from per-extension groups entirely", async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const runner: CommandRunner = async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0 };
      };
      const builtinConfig: FormatterConfig = {
        formatters: {
          prettier: { command: ["prettier", "--write"] },
        },
        chains: {
          "*": ["treefmt"],
          ".ts": ["prettier"],
        },
      };
      const { BUILTIN_FORMATTERS } = await import(
        "../src/builtin-formatters.js"
      );
      const original = { ...BUILTIN_FORMATTERS.treefmt };
      // Mark every .ts file as handled.
      const fake = fakeTreefmt(() => false);
      BUILTIN_FORMATTERS.treefmt.discoverRoot = fake.discoverRoot;
      BUILTIN_FORMATTERS.treefmt.buildCommand = fake.buildCommand;
      BUILTIN_FORMATTERS.treefmt.partitionUnhandled = fake.partitionUnhandled;
      try {
        const formatter = new PromptAutoformatter(
          "/repo",
          builtinConfig,
          runner,
        );
        formatter.addTouchedPath("/repo/a.ts");
        formatter.addTouchedPath("/repo/b.ts");

        await formatter.flushPrompt();

        // treefmt runs once. prettier should NOT run because the wildcard
        // claimed all files.
        expect(calls.map((c) => c.command)).toEqual(["treefmt"]);
      } finally {
        Object.assign(BUILTIN_FORMATTERS.treefmt, original);
      }
    });
  });

  describe("changedFiles detection", () => {
    let workDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "pi-autoformat-change-"));
    });

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it("populates changedFiles when the formatter modifies file content", async () => {
      const filePath = join(workDir, "a.ts");
      writeFileSync(filePath, "const   x=1;");

      const runner: CommandRunner = async (_command, args) => {
        // Simulate a formatter that rewrites the file
        for (const arg of args) {
          if (arg.endsWith(".ts")) {
            writeFileSync(arg, "const x = 1;");
          }
        }
        return { exitCode: 0 };
      };

      const cfg: FormatterConfig = {
        formatters: { fmt: { command: ["fmt"] } },
        chains: { ".ts": ["fmt"] },
      };

      const formatter = new PromptAutoformatter(workDir, cfg, runner);
      formatter.addTouchedPath(filePath);

      const result = await formatter.flushPrompt();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].changedFiles).toEqual([filePath]);
    });

    it("leaves changedFiles empty when the formatter does not change content", async () => {
      const filePath = join(workDir, "b.ts");
      writeFileSync(filePath, "const x = 1;");

      const runner: CommandRunner = async () => {
        // Formatter is a no-op
        return { exitCode: 0 };
      };

      const cfg: FormatterConfig = {
        formatters: { fmt: { command: ["fmt"] } },
        chains: { ".ts": ["fmt"] },
      };

      const formatter = new PromptAutoformatter(workDir, cfg, runner);
      formatter.addTouchedPath(filePath);

      const result = await formatter.flushPrompt();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].changedFiles).toEqual([]);
    });

    it("excludes deleted files from changedFiles", async () => {
      const filePath = join(workDir, "c.ts");
      writeFileSync(filePath, "delete me");

      const runner: CommandRunner = async (_command, args) => {
        // Simulate formatter that deletes the file
        const { unlinkSync } = await import("node:fs");
        for (const arg of args) {
          if (arg.endsWith(".ts")) {
            unlinkSync(arg);
          }
        }
        return { exitCode: 0 };
      };

      const cfg: FormatterConfig = {
        formatters: { fmt: { command: ["fmt"] } },
        chains: { ".ts": ["fmt"] },
      };

      const formatter = new PromptAutoformatter(workDir, cfg, runner);
      formatter.addTouchedPath(filePath);

      const result = await formatter.flushPrompt();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].changedFiles).toEqual([]);
    });
  });
});
