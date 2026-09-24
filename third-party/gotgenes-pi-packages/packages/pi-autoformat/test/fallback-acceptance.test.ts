/**
 * End-to-end fallback chain test.
 *
 * Exercises the full resolution path: config loader → grouping →
 * resolveChainSteps → executeChainGroup with a stubbed PATH probe and a
 * stubbed runner. Validates the issue #13 acceptance scenario: a global
 * `[{ fallback: ["biome", "prettier"] }]` chain in a repo where biome is
 * absent and prettier is present produces a single prettier batch run
 * with fallbackContext.skipped = ["biome"].
 *
 * This is the "acceptance" anchor for the fallback feature. It does not
 * use the real Pi CLI (see acceptance.test.ts for that surface).
 */

import { describe, expect, it } from "vitest";

import { validateUserFormatterConfig } from "#src/config-loader";
import { createFormatterConfig } from "#src/formatter-config";
import type { CommandRunner } from "#src/formatter-executor";
import { PromptAutoformatter } from "#src/prompt-autoformatter";

describe("fallback chain end-to-end", () => {
  it("falls through from biome to prettier when biome is missing on PATH", async () => {
    const validated = validateUserFormatterConfig({
      formatters: {
        biome: { command: ["biome", "format", "--write"] },
        prettier: { command: ["prettier", "--write"] },
      },
      chains: {
        ".ts": [{ fallback: ["biome", "prettier"] }],
      },
    });
    expect(validated.issues).toEqual([]);

    const config = createFormatterConfig(validated.config);

    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0 };
    };

    const formatter = new PromptAutoformatter("/repo", config, runner, {
      // biome absent, prettier present.
      commandProbe: (cmd) => cmd === "prettier",
    });
    formatter.addTouchedPath("/repo/src/a.ts");
    formatter.addTouchedPath("/repo/src/b.ts");

    const result = await formatter.flushPrompt();

    expect(calls).toEqual([
      {
        command: "prettier",
        args: ["--write", "/repo/src/a.ts", "/repo/src/b.ts"],
      },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].runs).toHaveLength(1);
    expect(result.groups[0].runs[0]).toMatchObject({
      formatterName: "prettier",
      success: true,
      exitCode: 0,
      files: ["/repo/src/a.ts", "/repo/src/b.ts"],
      fallbackContext: { skipped: ["biome"] },
    });
  });

  it("emits no run when every fallback alternative is missing from PATH", async () => {
    const validated = validateUserFormatterConfig({
      formatters: {
        biome: { command: ["biome", "format", "--write"] },
        prettier: { command: ["prettier", "--write"] },
      },
      chains: {
        ".ts": [{ fallback: ["biome", "prettier"] }],
      },
    });
    const config = createFormatterConfig(validated.config);

    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0 };
    };

    const formatter = new PromptAutoformatter("/repo", config, runner, {
      commandProbe: () => false,
    });
    formatter.addTouchedPath("/repo/src/a.ts");

    const result = await formatter.flushPrompt();

    expect(calls).toEqual([]);
    // Group is dropped entirely: no runs and no group emitted.
    expect(result.groups).toEqual([]);
  });
});
