import { describe, expect, it } from "vitest";

import type { BuiltinFormatter } from "#src/builtin-formatters";
import {
  type CommandRunner,
  executeChainGroup,
  executeChainGroupWithPartition,
} from "#src/formatter-executor";
import type {
  ResolvedChainStep,
  ResolvedFormatter,
} from "#src/formatter-registry";

const prettier: ResolvedFormatter = {
  name: "prettier",
  command: ["prettier", "--write"],
  environment: { PRETTIERD_DEFAULT_CONFIG: "./.prettierrc" },
};

const markdownlint: ResolvedFormatter = {
  name: "markdownlint",
  command: ["markdownlint-cli2", "--fix"],
};

const biome: ResolvedFormatter = {
  name: "biome",
  command: ["biome", "format", "--write"],
};

function singleStep(formatter: ResolvedFormatter): ResolvedChainStep {
  return { kind: "single", formatter };
}

function fallbackStep(alternatives: ResolvedFormatter[]): ResolvedChainStep {
  return { kind: "fallback", alternatives };
}

const chain: ResolvedChainStep[] = [
  singleStep(prettier),
  singleStep(markdownlint),
];

describe("executeChainGroup (single steps)", () => {
  it("runs each step once with all files appended as trailing args", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0 };
    };

    const runs = await executeChainGroup(
      { chain, files: ["/repo/a.md", "/repo/b.md"] },
      runner,
    );

    expect(calls).toEqual([
      {
        command: "prettier",
        args: ["--write", "/repo/a.md", "/repo/b.md"],
      },
      {
        command: "markdownlint-cli2",
        args: ["--fix", "/repo/a.md", "/repo/b.md"],
      },
    ]);
    expect(runs).toEqual([
      {
        formatterName: "prettier",
        command: ["prettier", "--write", "/repo/a.md", "/repo/b.md"],
        files: ["/repo/a.md", "/repo/b.md"],
        success: true,
        exitCode: 0,
        stdout: undefined,
        stderr: undefined,
      },
      {
        formatterName: "markdownlint",
        command: ["markdownlint-cli2", "--fix", "/repo/a.md", "/repo/b.md"],
        files: ["/repo/a.md", "/repo/b.md"],
        success: true,
        exitCode: 0,
        stdout: undefined,
        stderr: undefined,
      },
    ]);
  });

  it("works with a single-file batch", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      return { exitCode: 0 };
    };

    await executeChainGroup(
      { chain: [singleStep(prettier)], files: ["/repo/only.md"] },
      runner,
    );

    expect(calls).toEqual([["prettier", "--write", "/repo/only.md"]]);
  });

  it("continues running remaining steps after a step fails", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      if (command === "prettier") {
        return { exitCode: 2, stderr: "boom" };
      }
      return { exitCode: 0 };
    };

    const runs = await executeChainGroup(
      { chain, files: ["/repo/a.md"] },
      runner,
    );

    expect(calls).toEqual(["prettier", "markdownlint-cli2"]);
    expect(runs[0]).toMatchObject({
      formatterName: "prettier",
      success: false,
      exitCode: 2,
      stderr: "boom",
      files: ["/repo/a.md"],
    });
    expect(runs[1]).toMatchObject({
      formatterName: "markdownlint",
      success: true,
      exitCode: 0,
    });
  });

  it("propagates formatter environment overrides", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const runner: CommandRunner = async (_command, _args, options) => {
      capturedEnv = options?.env;
      return { exitCode: 0 };
    };

    await executeChainGroup(
      { chain: [singleStep(prettier)], files: ["/repo/a.md"] },
      runner,
    );

    expect(capturedEnv).toMatchObject({
      PRETTIERD_DEFAULT_CONFIG: "./.prettierrc",
    });
  });

  it("forwards cwd to the runner", async () => {
    let capturedCwd: string | undefined;
    const runner: CommandRunner = async (_command, _args, options) => {
      capturedCwd = options?.cwd;
      return { exitCode: 0 };
    };

    await executeChainGroup(
      { chain: [singleStep(prettier)], files: ["/repo/a.md"] },
      runner,
      { cwd: "/repo" },
    );

    expect(capturedCwd).toBe("/repo");
  });

  it("marks a step as failed with exit 1 when its command is empty", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("should not be called");
    };

    const runs = await executeChainGroup(
      {
        chain: [singleStep({ name: "broken", command: [] })],
        files: ["/repo/a.md"],
      },
      runner,
    );

    expect(runs[0]).toMatchObject({
      formatterName: "broken",
      success: false,
      exitCode: 1,
      files: ["/repo/a.md"],
    });
    expect(runs[0].stderr).toMatch(/empty/i);
  });

  it("returns no runs when files is empty", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("should not be called");
    };

    const runs = await executeChainGroup({ chain, files: [] }, runner);

    expect(runs).toEqual([]);
  });
});

describe("executeChainGroup (fallback steps)", () => {
  it("runs the first alternative when its command is on PATH and emits no fallbackContext", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const runs = await executeChainGroup(
      {
        chain: [fallbackStep([biome, prettier])],
        files: ["/repo/a.ts"],
      },
      runner,
      { commandProbe: (cmd) => cmd === "biome" },
    );

    expect(calls).toEqual(["biome"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      formatterName: "biome",
      success: true,
      exitCode: 0,
    });
    expect(runs[0].fallbackContext).toBeUndefined();
  });

  it("falls through when an alternative is missing and reports skipped names", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const runs = await executeChainGroup(
      {
        chain: [fallbackStep([biome, prettier])],
        files: ["/repo/a.ts"],
      },
      runner,
      { commandProbe: (cmd) => cmd === "prettier" },
    );

    expect(calls).toEqual(["prettier"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      formatterName: "prettier",
      success: true,
      exitCode: 0,
    });
    expect(runs[0].fallbackContext).toEqual({ skipped: ["biome"] });
  });

  it("does NOT fall through on a non-zero exit code", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 1, stderr: "syntax error" };
    };

    const runs = await executeChainGroup(
      {
        chain: [fallbackStep([biome, prettier])],
        files: ["/repo/a.ts"],
      },
      runner,
      { commandProbe: () => true },
    );

    expect(calls).toEqual(["biome"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      formatterName: "biome",
      success: false,
      exitCode: 1,
      stderr: "syntax error",
    });
  });

  it("emits no run when all alternatives are missing from PATH", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const runs = await executeChainGroup(
      {
        chain: [fallbackStep([biome, prettier])],
        files: ["/repo/a.ts"],
      },
      runner,
      { commandProbe: () => false },
    );

    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("runs subsequent single steps even when the fallback group is a no-op", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const runs = await executeChainGroup(
      {
        chain: [fallbackStep([biome]), singleStep(markdownlint)],
        files: ["/repo/a.md"],
      },
      runner,
      { commandProbe: (cmd) => cmd !== "biome" },
    );

    expect(calls).toEqual(["markdownlint-cli2"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.formatterName).toBe("markdownlint");
  });
});

describe("executeChainGroupWithPartition (built-in steps)", () => {
  const fakeBuiltin: BuiltinFormatter = {
    name: "treefmt",
    async discoverRoot() {
      return "/repo";
    },
    buildCommand(root, files) {
      return {
        command: [
          "treefmt",
          "--config-file",
          `${root}/treefmt.toml`,
          "--",
          ...files,
        ],
        cwd: root,
      };
    },
    partitionUnhandled(_run, files) {
      // Mark every file ending in .bin as unhandled.
      const unhandled = files.filter((f) => f.endsWith(".bin"));
      const handled = files.filter((f) => !f.endsWith(".bin"));
      return { handled, unhandled, treatAsSkip: false };
    },
  };

  const builtinFormatter: ResolvedFormatter = {
    name: "treefmt",
    command: ["treefmt"],
    builtin: fakeBuiltin,
  };

  it("invokes the discovered command and returns unhandled files", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { exitCode: 0, stderr: "no formatter for path: /repo/b.bin" };
    };

    const result = await executeChainGroupWithPartition(
      {
        chain: [{ kind: "single", formatter: builtinFormatter }],
        files: ["/repo/a.ts", "/repo/b.bin"],
      },
      runner,
    );

    expect(calls).toEqual([
      {
        command: "treefmt",
        args: [
          "--config-file",
          "/repo/treefmt.toml",
          "--",
          "/repo/a.ts",
          "/repo/b.bin",
        ],
        cwd: "/repo",
      },
    ]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.formatterName).toBe("treefmt");
    expect(result.unhandled).toEqual(["/repo/b.bin"]);
  });

  it("drops the run and treats every file as unhandled when treatAsSkip is true", async () => {
    const skipBuiltin: BuiltinFormatter = {
      ...fakeBuiltin,
      partitionUnhandled(_run, files) {
        return { handled: [], unhandled: [...files], treatAsSkip: true };
      },
    };
    const formatter: ResolvedFormatter = {
      name: "treefmt",
      command: ["treefmt"],
      builtin: skipBuiltin,
    };
    const runner: CommandRunner = async () => ({ exitCode: 0 });

    const result = await executeChainGroupWithPartition(
      {
        chain: [{ kind: "single", formatter }],
        files: ["/repo/a.ts"],
      },
      runner,
    );
    expect(result.runs).toEqual([]);
    expect(result.unhandled).toEqual(["/repo/a.ts"]);
  });

  it("records non-skip non-zero exits as failed runs", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 2,
      stderr: "real failure",
    });

    const result = await executeChainGroupWithPartition(
      {
        chain: [{ kind: "single", formatter: builtinFormatter }],
        files: ["/repo/a.ts"],
      },
      runner,
    );
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      success: false,
      exitCode: 2,
      stderr: "real failure",
    });
  });

  it("threads unhandled files into subsequent steps within the same chain", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "treefmt") {
        return { exitCode: 0, stderr: "no formatter for path: /repo/b.bin" };
      }
      return { exitCode: 0 };
    };

    await executeChainGroupWithPartition(
      {
        chain: [
          { kind: "single", formatter: builtinFormatter },
          { kind: "single", formatter: prettier },
        ],
        files: ["/repo/a.ts", "/repo/b.bin"],
      },
      runner,
    );

    // prettier should only see /repo/b.bin (the unhandled remainder).
    expect(calls[1]).toEqual({
      command: "prettier",
      args: ["--write", "/repo/b.bin"],
    });
  });

  it("prefers treefmt-nix over treefmt at the same root inside a fallback group regardless of declaration order", async () => {
    const sharedRoot = "/repo";
    const treefmtNix: ResolvedFormatter = {
      name: "treefmt-nix",
      command: ["treefmt-nix"],
      builtin: {
        name: "treefmt-nix",
        async discoverRoot() {
          return sharedRoot;
        },
        buildCommand(root, files) {
          return { command: ["nix", "fmt", "--", ...files], cwd: root };
        },
        partitionUnhandled(_run, files) {
          return { handled: [...files], unhandled: [], treatAsSkip: false };
        },
      },
    };
    const treefmtBuiltin: ResolvedFormatter = {
      name: "treefmt",
      command: ["treefmt"],
      builtin: {
        name: "treefmt",
        async discoverRoot() {
          return sharedRoot;
        },
        buildCommand(root, files) {
          return { command: ["treefmt", "--", ...files], cwd: root };
        },
        partitionUnhandled(_run, files) {
          return { handled: [...files], unhandled: [], treatAsSkip: false };
        },
      },
    };
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const result = await executeChainGroupWithPartition(
      {
        // User listed treefmt before treefmt-nix; precedence rule should
        // still pick treefmt-nix when both PATH-probe true and resolve to the
        // same root.
        chain: [
          { kind: "fallback", alternatives: [treefmtBuiltin, treefmtNix] },
        ],
        files: ["/repo/a.ts"],
      },
      runner,
      { commandProbe: () => true },
    );

    expect(calls).toEqual(["nix"]);
    expect(result.runs[0]?.formatterName).toBe("treefmt-nix");
  });

  it("keeps user order when the two built-ins resolve to different roots", async () => {
    const treefmtNix: ResolvedFormatter = {
      name: "treefmt-nix",
      command: ["treefmt-nix"],
      builtin: {
        name: "treefmt-nix",
        async discoverRoot() {
          return "/other";
        },
        buildCommand(root, files) {
          return { command: ["nix", "fmt", "--", ...files], cwd: root };
        },
        partitionUnhandled(_run, files) {
          return { handled: [...files], unhandled: [], treatAsSkip: false };
        },
      },
    };
    const treefmtBuiltin: ResolvedFormatter = {
      name: "treefmt",
      command: ["treefmt"],
      builtin: {
        name: "treefmt",
        async discoverRoot() {
          return "/repo";
        },
        buildCommand(root, files) {
          return { command: ["treefmt", "--", ...files], cwd: root };
        },
        partitionUnhandled(_run, files) {
          return { handled: [...files], unhandled: [], treatAsSkip: false };
        },
      },
    };
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    await executeChainGroupWithPartition(
      {
        chain: [
          { kind: "fallback", alternatives: [treefmtBuiltin, treefmtNix] },
        ],
        files: ["/repo/a.ts"],
      },
      runner,
      { commandProbe: () => true },
    );

    expect(calls).toEqual(["treefmt"]);
  });

  it("skips the built-in step when discoverRoot returns undefined", async () => {
    const noRootBuiltin: BuiltinFormatter = {
      ...fakeBuiltin,
      async discoverRoot() {
        return undefined;
      },
    };
    const formatter: ResolvedFormatter = {
      name: "treefmt",
      command: ["treefmt"],
      builtin: noRootBuiltin,
    };
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const result = await executeChainGroupWithPartition(
      {
        chain: [
          { kind: "single", formatter },
          { kind: "single", formatter: prettier },
        ],
        files: ["/repo/a.ts"],
      },
      runner,
    );

    expect(calls).toEqual(["prettier"]);
    expect(result.unhandled).toEqual(["/repo/a.ts"]);
  });
});
