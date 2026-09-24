import { describe, expect, it } from "vitest";

import {
  type FormatterConfig,
  groupFilesByChain,
  resolveChain,
  resolveChainSteps,
} from "#src/formatter-registry";

describe("groupFilesByChain", () => {
  const config: FormatterConfig = {
    formatters: {
      prettier: { command: ["prettier", "--write"] },
      markdownlint: { command: ["markdownlint-cli2", "--fix"] },
      biome: { command: ["biome", "format", "--write"] },
    },
    chains: {
      ".md": ["prettier", "markdownlint"],
      ".markdown": ["prettier", "markdownlint"],
      ".ts": ["prettier"],
      ".js": ["prettier"],
      ".rs": ["biome"],
    },
  };

  it("groups files that share a chain into one group", () => {
    const groups = groupFilesByChain(
      ["/repo/a.md", "/repo/b.md", "/repo/c.md"],
      config,
    );

    expect(groups).toEqual([
      {
        chain: ["prettier", "markdownlint"],
        files: ["/repo/a.md", "/repo/b.md", "/repo/c.md"],
      },
    ]);
  });

  it("creates separate groups for distinct chains", () => {
    const groups = groupFilesByChain(
      ["/repo/a.md", "/repo/b.ts", "/repo/c.rs"],
      config,
    );

    expect(groups).toEqual([
      { chain: ["prettier", "markdownlint"], files: ["/repo/a.md"] },
      { chain: ["prettier"], files: ["/repo/b.ts"] },
      { chain: ["biome"], files: ["/repo/c.rs"] },
    ]);
  });

  it("merges different extensions that resolve to the same chain", () => {
    const groups = groupFilesByChain(
      ["/repo/a.md", "/repo/b.markdown", "/repo/c.ts", "/repo/d.js"],
      config,
    );

    expect(groups).toEqual([
      {
        chain: ["prettier", "markdownlint"],
        files: ["/repo/a.md", "/repo/b.markdown"],
      },
      { chain: ["prettier"], files: ["/repo/c.ts", "/repo/d.js"] },
    ]);
  });

  it("drops files with no chain", () => {
    const groups = groupFilesByChain(
      ["/repo/a.md", "/repo/logo.png", "/repo/notes.txt"],
      config,
    );

    expect(groups).toEqual([
      { chain: ["prettier", "markdownlint"], files: ["/repo/a.md"] },
    ]);
  });

  it("preserves first-seen group order and within-group file order", () => {
    const groups = groupFilesByChain(
      ["/repo/x.ts", "/repo/a.md", "/repo/y.ts", "/repo/b.md"],
      config,
    );

    expect(groups).toEqual([
      { chain: ["prettier"], files: ["/repo/x.ts", "/repo/y.ts"] },
      {
        chain: ["prettier", "markdownlint"],
        files: ["/repo/a.md", "/repo/b.md"],
      },
    ]);
  });

  it("returns no groups when given no files", () => {
    expect(groupFilesByChain([], config)).toEqual([]);
  });

  describe("with a wildcard chain", () => {
    const wildcardConfig: FormatterConfig = {
      formatters: {
        prettier: { command: ["prettier", "--write"] },
        markdownlint: { command: ["markdownlint-cli2", "--fix"] },
      },
      chains: {
        "*": ["treefmt"],
        ".md": ["prettier", "markdownlint"],
        ".ts": ["prettier"],
      },
    };

    it("emits the wildcard group first with every touched file", () => {
      const groups = groupFilesByChain(
        ["/repo/a.md", "/repo/b.ts", "/repo/Makefile"],
        wildcardConfig,
      );
      expect(groups[0]).toEqual({
        chain: ["treefmt"],
        files: ["/repo/a.md", "/repo/b.ts", "/repo/Makefile"],
      });
    });

    it("keeps per-extension groups after the wildcard group", () => {
      const groups = groupFilesByChain(
        ["/repo/a.md", "/repo/b.ts"],
        wildcardConfig,
      );
      expect(groups).toEqual([
        {
          chain: ["treefmt"],
          files: ["/repo/a.md", "/repo/b.ts"],
        },
        {
          chain: ["prettier", "markdownlint"],
          files: ["/repo/a.md"],
        },
        {
          chain: ["prettier"],
          files: ["/repo/b.ts"],
        },
      ]);
    });

    it("includes extensionless files in the wildcard group only", () => {
      const groups = groupFilesByChain(
        ["/repo/Makefile", "/repo/notes"],
        wildcardConfig,
      );
      expect(groups).toEqual([
        {
          chain: ["treefmt"],
          files: ["/repo/Makefile", "/repo/notes"],
        },
      ]);
    });

    it('emits no wildcard group when chains["*"] is absent', () => {
      const groups = groupFilesByChain(["/repo/a.md"], {
        formatters: wildcardConfig.formatters,
        chains: {
          ".md": ["prettier"],
        },
      });
      expect(groups).toEqual([{ chain: ["prettier"], files: ["/repo/a.md"] }]);
    });
  });

  describe("with fallback steps", () => {
    const fallbackConfig: FormatterConfig = {
      formatters: {
        biome: { command: ["biome", "format", "--write"] },
        prettier: { command: ["prettier", "--write"] },
        "markdownlint-cli2": {
          command: ["markdownlint-cli2", "--fix"],
        },
      },
      chains: {
        ".ts": [{ fallback: ["biome", "prettier"] }],
        ".tsx": [{ fallback: ["biome", "prettier"] }],
        ".md": [{ fallback: ["biome", "prettier"] }, "markdownlint-cli2"],
      },
    };

    it("keeps the original chain step shape in the returned group", () => {
      const groups = groupFilesByChain(["/repo/a.ts"], fallbackConfig);
      expect(groups).toEqual([
        {
          chain: [{ fallback: ["biome", "prettier"] }],
          files: ["/repo/a.ts"],
        },
      ]);
    });

    it("groups identical fallback chains across extensions", () => {
      const groups = groupFilesByChain(
        ["/repo/a.ts", "/repo/b.tsx"],
        fallbackConfig,
      );
      expect(groups).toEqual([
        {
          chain: [{ fallback: ["biome", "prettier"] }],
          files: ["/repo/a.ts", "/repo/b.tsx"],
        },
      ]);
    });

    it("groups mixed string + fallback chains", () => {
      const groups = groupFilesByChain(
        ["/repo/a.ts", "/repo/b.md", "/repo/c.md"],
        fallbackConfig,
      );
      expect(groups).toHaveLength(2);
      const md = groups.find((g) => g.files.includes("/repo/b.md"));
      expect(md?.chain).toEqual([
        { fallback: ["biome", "prettier"] },
        "markdownlint-cli2",
      ]);
      expect(md?.files).toEqual(["/repo/b.md", "/repo/c.md"]);
    });

    it("separates groups whose fallback ordering differs", () => {
      const reorderedConfig: FormatterConfig = {
        formatters: fallbackConfig.formatters,
        chains: {
          ".ts": [{ fallback: ["biome", "prettier"] }],
          ".js": [{ fallback: ["prettier", "biome"] }],
        },
      };
      const groups = groupFilesByChain(
        ["/repo/a.ts", "/repo/b.js"],
        reorderedConfig,
      );
      expect(groups).toHaveLength(2);
    });
  });
});

describe("resolveChain", () => {
  const config: FormatterConfig = {
    formatters: {
      prettier: {
        command: ["prettier", "--write"],
        environment: { PRETTIERD_DEFAULT_CONFIG: "./.prettierrc" },
      },
      markdownlint: {
        command: ["markdownlint-cli2", "--fix"],
      },
      disabled: {
        command: ["never"],
        disabled: true,
      },
    },
    chains: {},
  };

  it("resolves formatters in declared order", () => {
    const resolved = resolveChain(["prettier", "markdownlint"], config);

    expect(resolved.map((entry) => entry.name)).toEqual([
      "prettier",
      "markdownlint",
    ]);
  });

  it("returns the configured command verbatim (no $FILE substitution)", () => {
    const resolved = resolveChain(["prettier"], config);

    expect(resolved[0]?.command).toEqual(["prettier", "--write"]);
  });

  it("propagates the formatter environment", () => {
    const resolved = resolveChain(["prettier"], config);

    expect(resolved[0]?.environment).toEqual({
      PRETTIERD_DEFAULT_CONFIG: "./.prettierrc",
    });
  });

  it("skips disabled formatters", () => {
    const resolved = resolveChain(
      ["prettier", "disabled", "markdownlint"],
      config,
    );

    expect(resolved.map((entry) => entry.name)).toEqual([
      "prettier",
      "markdownlint",
    ]);
  });

  it("skips unknown formatter names", () => {
    const resolved = resolveChain(["prettier", "nonexistent"], config);

    expect(resolved.map((entry) => entry.name)).toEqual(["prettier"]);
  });

  it("returns an empty array for an empty chain", () => {
    expect(resolveChain([], config)).toEqual([]);
  });
});

describe("resolveChainSteps", () => {
  const config: FormatterConfig = {
    formatters: {
      prettier: { command: ["prettier", "--write"] },
      biome: { command: ["biome", "format", "--write"] },
      "markdownlint-cli2": {
        command: ["markdownlint-cli2", "--fix"],
      },
      off: { command: ["never"], disabled: true },
    },
    chains: {},
  };

  it("resolves a single string step to kind 'single'", () => {
    const resolved = resolveChainSteps(["prettier"], config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.kind).toBe("single");
    if (resolved[0]?.kind === "single") {
      expect(resolved[0].formatter.name).toBe("prettier");
      expect(resolved[0].formatter.command).toEqual(["prettier", "--write"]);
    }
  });

  it("drops a single step that names an unknown or disabled formatter", () => {
    expect(resolveChainSteps(["nope"], config)).toEqual([]);
    expect(resolveChainSteps(["off"], config)).toEqual([]);
  });

  it("resolves a fallback step to kind 'fallback' with alternatives in order", () => {
    const resolved = resolveChainSteps(
      [{ fallback: ["biome", "prettier"] }],
      config,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.kind).toBe("fallback");
    if (resolved[0]?.kind === "fallback") {
      expect(resolved[0].alternatives.map((a) => a.name)).toEqual([
        "biome",
        "prettier",
      ]);
    }
  });

  it("drops disabled and unknown alternatives within a fallback step", () => {
    const resolved = resolveChainSteps(
      [{ fallback: ["off", "unknown", "prettier"] }],
      config,
    );
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.kind === "fallback") {
      expect(resolved[0].alternatives.map((a) => a.name)).toEqual(["prettier"]);
    }
  });

  it("drops a fallback step whose alternatives all reduce away", () => {
    expect(
      resolveChainSteps([{ fallback: ["off", "unknown"] }], config),
    ).toEqual([]);
  });

  it("resolves mixed string + fallback chains preserving order", () => {
    const resolved = resolveChainSteps(
      [{ fallback: ["biome", "prettier"] }, "markdownlint-cli2"],
      config,
    );
    expect(resolved.map((s) => s.kind)).toEqual(["fallback", "single"]);
  });
});
