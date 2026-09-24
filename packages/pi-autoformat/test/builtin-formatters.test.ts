import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BUILTIN_FORMATTERS,
  type DiscoveryCache,
  isBuiltinFormatterName,
} from "#src/builtin-formatters";
import {
  type FormatterConfig,
  resolveChainSteps,
} from "#src/formatter-registry";

describe("builtin formatter registry", () => {
  it("registers treefmt and treefmt-nix as built-ins", () => {
    expect(BUILTIN_FORMATTERS.treefmt).toBeDefined();
    expect(BUILTIN_FORMATTERS["treefmt-nix"]).toBeDefined();
    expect(BUILTIN_FORMATTERS.treefmt.name).toBe("treefmt");
    expect(BUILTIN_FORMATTERS["treefmt-nix"].name).toBe("treefmt-nix");
  });

  it("recognizes the canonical built-in names", () => {
    expect(isBuiltinFormatterName("treefmt")).toBe(true);
    expect(isBuiltinFormatterName("treefmt-nix")).toBe(true);
    expect(isBuiltinFormatterName("prettier")).toBe(false);
    expect(isBuiltinFormatterName("nope")).toBe(false);
  });
});

describe("resolveChainSteps with built-ins", () => {
  it("resolves treefmt without a formatters entry", () => {
    const config: FormatterConfig = { formatters: {}, chains: {} };
    const resolved = resolveChainSteps(["treefmt"], config);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.kind === "single") {
      expect(resolved[0].formatter.name).toBe("treefmt");
      expect(resolved[0].formatter.builtin).toBeDefined();
      expect(resolved[0].formatter.builtin?.name).toBe("treefmt");
    } else {
      throw new Error("expected single step");
    }
  });

  it("resolves treefmt-nix without a formatters entry", () => {
    const config: FormatterConfig = { formatters: {}, chains: {} };
    const resolved = resolveChainSteps(["treefmt-nix"], config);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.kind === "single") {
      expect(resolved[0].formatter.builtin?.name).toBe("treefmt-nix");
    }
  });

  it("resolves built-ins inside a fallback group", () => {
    const config: FormatterConfig = { formatters: {}, chains: {} };
    const resolved = resolveChainSteps(
      [{ fallback: ["treefmt-nix", "treefmt"] }],
      config,
    );
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.kind === "fallback") {
      expect(resolved[0].alternatives.map((a) => a.name)).toEqual([
        "treefmt-nix",
        "treefmt",
      ]);
      expect(resolved[0].alternatives.every((a) => a.builtin)).toBe(true);
    }
  });

  it("prefers a user-declared formatter over the built-in (shadow allowed)", () => {
    const config: FormatterConfig = {
      formatters: {
        treefmt: { command: ["treefmt", "--ci"] },
      },
      chains: {},
    };
    const resolved = resolveChainSteps(["treefmt"], config);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.kind === "single") {
      expect(resolved[0].formatter.command).toEqual(["treefmt", "--ci"]);
      expect(resolved[0].formatter.builtin).toBeUndefined();
    }
  });
});

describe("treefmt discovery", () => {
  let tmp: string;
  let repoRoot: string;
  let nestedFile: string;
  let outsideFile: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "pi-autofmt-discovery-"));
    repoRoot = path.join(tmp, "repo");
    mkdirSync(path.join(repoRoot, "src", "a"), { recursive: true });
    writeFileSync(path.join(repoRoot, "treefmt.toml"), "");
    nestedFile = path.join(repoRoot, "src", "a", "x.ts");
    writeFileSync(nestedFile, "");

    const outsideRoot = path.join(tmp, "elsewhere");
    mkdirSync(outsideRoot, { recursive: true });
    outsideFile = path.join(outsideRoot, "y.ts");
    writeFileSync(outsideFile, "");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("walks up to find treefmt.toml", async () => {
    const root = await BUILTIN_FORMATTERS.treefmt.discoverRoot([nestedFile]);
    expect(root).toBe(repoRoot);
  });

  it("finds .treefmt.toml as well", async () => {
    const dotRoot = path.join(tmp, "dot-repo");
    mkdirSync(path.join(dotRoot, "sub"), { recursive: true });
    writeFileSync(path.join(dotRoot, ".treefmt.toml"), "");
    const file = path.join(dotRoot, "sub", "a.ts");
    writeFileSync(file, "");
    const root = await BUILTIN_FORMATTERS.treefmt.discoverRoot([file]);
    expect(root).toBe(dotRoot);
  });

  it("prefers treefmt.toml when both exist at the same root", async () => {
    const both = path.join(tmp, "both");
    mkdirSync(both, { recursive: true });
    writeFileSync(path.join(both, "treefmt.toml"), "");
    writeFileSync(path.join(both, ".treefmt.toml"), "");
    const file = path.join(both, "a.ts");
    writeFileSync(file, "");
    const root = await BUILTIN_FORMATTERS.treefmt.discoverRoot([file]);
    expect(root).toBe(both);
  });

  it("returns undefined when no config is found", async () => {
    const root = await BUILTIN_FORMATTERS.treefmt.discoverRoot([outsideFile]);
    expect(root).toBeUndefined();
  });

  it("reuses the discovery cache for already-walked directories", async () => {
    const cache: DiscoveryCache = new Map();
    const root1 = await BUILTIN_FORMATTERS.treefmt.discoverRoot([nestedFile], {
      cache,
    });
    expect(root1).toBe(repoRoot);
    expect(cache.size).toBeGreaterThan(0);
    // Mutate one of the cached entries to a sentinel so we can prove the
    // second call uses the cache rather than re-walking.
    const dir = path.dirname(nestedFile);
    cache.set(dir, "/sentinel");
    const root2 = await BUILTIN_FORMATTERS.treefmt.discoverRoot([nestedFile], {
      cache,
    });
    expect(root2).toBe("/sentinel");
  });
});

describe("treefmt command builder", () => {
  it("invokes treefmt with --config-file at the discovered root", () => {
    const root = "/repo";
    const built = BUILTIN_FORMATTERS.treefmt.buildCommand(root, [
      "/repo/a.ts",
      "/repo/b.md",
    ]);
    expect(built.cwd).toBe(root);
    expect(built.command).toEqual([
      "treefmt",
      "--config-file",
      path.join(root, "treefmt.toml"),
      "--",
      "/repo/a.ts",
      "/repo/b.md",
    ]);
  });

  it("prefers treefmt.toml over .treefmt.toml when both exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-autofmt-tfb-"));
    writeFileSync(path.join(dir, "treefmt.toml"), "");
    writeFileSync(path.join(dir, ".treefmt.toml"), "");
    try {
      const built = BUILTIN_FORMATTERS.treefmt.buildCommand(dir, [
        path.join(dir, "a.ts"),
      ]);
      expect(built.command[2]).toBe(path.join(dir, "treefmt.toml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to .treefmt.toml when only the dotfile exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-autofmt-tfd-"));
    writeFileSync(path.join(dir, ".treefmt.toml"), "");
    try {
      const built = BUILTIN_FORMATTERS.treefmt.buildCommand(dir, [
        path.join(dir, "a.ts"),
      ]);
      expect(built.command[2]).toBe(path.join(dir, ".treefmt.toml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("treefmt-nix command builder", () => {
  it("invokes nix fmt with no-update/no-write flags from the flake root", () => {
    const root = "/repo";
    const built = BUILTIN_FORMATTERS["treefmt-nix"].buildCommand(root, [
      "/repo/a.ts",
    ]);
    expect(built.cwd).toBe(root);
    expect(built.command).toEqual([
      "nix",
      "fmt",
      "--no-update-lock-file",
      "--no-write-lock-file",
      "--",
      "/repo/a.ts",
    ]);
  });
});

describe("treefmt partitionUnhandled", () => {
  const builtin = BUILTIN_FORMATTERS.treefmt;

  it("marks files reported with 'no formatter for path' as unhandled", () => {
    const files = ["/repo/a.ts", "/repo/b.unknown", "/repo/c.md"];
    const stderr = [
      "treefmt: ran 3 formatters",
      "WARN no formatter for path: /repo/b.unknown",
    ].join("\n");
    const part = builtin.partitionUnhandled(
      {
        formatterName: "treefmt",
        command: ["treefmt"],
        files,
        success: true,
        exitCode: 0,
        stderr,
      },
      files,
    );
    expect(part.unhandled).toEqual(["/repo/b.unknown"]);
    expect(part.handled).toEqual(["/repo/a.ts", "/repo/c.md"]);
    expect(part.treatAsSkip).toBe(false);
  });

  it("treats exit-0 with all files unhandled as skip", () => {
    const files = ["/repo/a.bin"];
    const stderr = "WARN no formatter for path: /repo/a.bin";
    const part = builtin.partitionUnhandled(
      {
        formatterName: "treefmt",
        command: ["treefmt"],
        files,
        success: true,
        exitCode: 0,
        stderr,
      },
      files,
    );
    expect(part.treatAsSkip).toBe(true);
  });

  it("reports a non-zero exit with no skip patterns as a real failure", () => {
    const files = ["/repo/a.ts"];
    const part = builtin.partitionUnhandled(
      {
        formatterName: "treefmt",
        command: ["treefmt"],
        files,
        success: false,
        exitCode: 2,
        stderr: "syntax error in /repo/a.ts",
      },
      files,
    );
    expect(part.treatAsSkip).toBe(false);
    expect(part.handled).toEqual(files);
    expect(part.unhandled).toEqual([]);
  });
});

describe("treefmt-nix partitionUnhandled", () => {
  const builtin = BUILTIN_FORMATTERS["treefmt-nix"];

  it("treats 'emitted 0 files for processing' as skip", () => {
    const files = ["/repo/a.ts", "/repo/b.bin"];
    const part = builtin.partitionUnhandled(
      {
        formatterName: "treefmt-nix",
        command: ["nix", "fmt"],
        files,
        success: true,
        exitCode: 0,
        stderr: "emitted 0 files for processing",
      },
      files,
    );
    expect(part.treatAsSkip).toBe(true);
  });

  it("treats transient nix daemon errors as skip", () => {
    const files = ["/repo/a.ts"];
    const part = builtin.partitionUnhandled(
      {
        formatterName: "treefmt-nix",
        command: ["nix", "fmt"],
        files,
        success: false,
        exitCode: 1,
        stderr:
          "error: cannot connect to socket at /nix/var/nix/daemon-socket/socket",
      },
      files,
    );
    expect(part.treatAsSkip).toBe(true);
  });

  it("treats unrelated non-zero exits as real failures", () => {
    const files = ["/repo/a.ts"];
    const part = builtin.partitionUnhandled(
      {
        formatterName: "treefmt-nix",
        command: ["nix", "fmt"],
        files,
        success: false,
        exitCode: 2,
        stderr: "some formatter blew up",
      },
      files,
    );
    expect(part.treatAsSkip).toBe(false);
  });
});

describe("treefmt-nix discovery", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "pi-autofmt-nix-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds flake.nix + treefmt.nix at the root", async () => {
    const root = path.join(tmp, "flake-a");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "flake.nix"), "");
    writeFileSync(path.join(root, "treefmt.nix"), "");
    const file = path.join(root, "src", "a.ts");
    writeFileSync(file, "");
    const found = await BUILTIN_FORMATTERS["treefmt-nix"].discoverRoot([file]);
    expect(found).toBe(root);
  });

  it("finds flake.nix + nix/treefmt.nix at the root", async () => {
    const root = path.join(tmp, "flake-b");
    mkdirSync(path.join(root, "nix"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "flake.nix"), "");
    writeFileSync(path.join(root, "nix", "treefmt.nix"), "");
    const file = path.join(root, "src", "a.ts");
    writeFileSync(file, "");
    const found = await BUILTIN_FORMATTERS["treefmt-nix"].discoverRoot([file]);
    expect(found).toBe(root);
  });

  it("requires both flake.nix and a treefmt.nix to match", async () => {
    const root = path.join(tmp, "flake-only");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "flake.nix"), "");
    const file = path.join(root, "a.ts");
    writeFileSync(file, "");
    const found = await BUILTIN_FORMATTERS["treefmt-nix"].discoverRoot([file]);
    expect(found).toBeUndefined();
  });
});
