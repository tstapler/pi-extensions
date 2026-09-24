import { describe, expect, it } from "vitest";

import {
  createFormatterConfig,
  DEFAULT_FORMATTER_CONFIG,
  type UserFormatterConfig,
} from "#src/formatter-config";

describe("createFormatterConfig", () => {
  it("includes default formatter definitions but no default chains", () => {
    const config = createFormatterConfig();

    expect(Object.keys(config.formatters)).toContain("prettier");
    expect(Object.keys(config.formatters)).toContain("markdownlint-cli2");
    expect(Object.keys(config.chains)).toHaveLength(0);
  });

  it("allows overriding builtin formatter commands", () => {
    const userConfig: UserFormatterConfig = {
      formatters: {
        prettier: {
          command: ["pnpm", "exec", "prettier", "--write"],
        },
      },
    };

    const config = createFormatterConfig(userConfig);

    expect(config.formatters.prettier.command).toEqual([
      "pnpm",
      "exec",
      "prettier",
      "--write",
    ]);
  });

  it("allows disabling builtin formatters", () => {
    const userConfig: UserFormatterConfig = {
      formatters: {
        prettier: {
          ...DEFAULT_FORMATTER_CONFIG.formatters.prettier,
          disabled: true,
        },
      },
    };

    const config = createFormatterConfig(userConfig);

    expect(config.formatters.prettier.disabled).toBe(true);
  });

  it("does not include notifyAgent in the default config", () => {
    const config = createFormatterConfig();

    expect(config).not.toHaveProperty("notifyAgent");
  });

  it("defaults formatterOutput to disabled with safe truncation caps", () => {
    const config = createFormatterConfig();

    expect(config.formatterOutput).toEqual({
      onFailure: "none",
      maxBytes: 4096,
      maxLines: 40,
    });
  });

  it("exposes formatterOutput defaults on DEFAULT_FORMATTER_CONFIG", () => {
    expect(DEFAULT_FORMATTER_CONFIG.formatterOutput).toEqual({
      onFailure: "none",
      maxBytes: 4096,
      maxLines: 40,
    });
  });

  it("merges a partial formatterOutput user object field-by-field", () => {
    const userConfig: UserFormatterConfig = {
      formatterOutput: { onFailure: "stderr" },
    };

    const config = createFormatterConfig(userConfig);

    expect(config.formatterOutput).toEqual({
      onFailure: "stderr",
      maxBytes: 4096,
      maxLines: 40,
    });
  });

  it("allows overriding individual formatterOutput caps", () => {
    const userConfig: UserFormatterConfig = {
      formatterOutput: { onFailure: "both", maxBytes: 256, maxLines: 5 },
    };

    const config = createFormatterConfig(userConfig);

    expect(config.formatterOutput).toEqual({
      onFailure: "both",
      maxBytes: 256,
      maxLines: 5,
    });
  });

  it("preserves user-declared chain order", () => {
    const userConfig: UserFormatterConfig = {
      chains: {
        ".md": ["markdownlint-cli2", "prettier"],
      },
    };

    const config = createFormatterConfig(userConfig);

    expect(config.chains[".md"]).toEqual(["markdownlint-cli2", "prettier"]);
  });
});
