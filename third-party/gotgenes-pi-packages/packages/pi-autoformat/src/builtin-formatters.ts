import { existsSync } from "node:fs";
import path from "node:path";

import type { BatchRun } from "./formatter-executor";

export type DiscoveryCache = Map<string, string | null>;

export type BuiltinPartition = {
  handled: string[];
  unhandled: string[];
  /** When true, the run is treated as a no-op skip (not a failed run). */
  treatAsSkip: boolean;
};

export type BuiltinDiscoveryContext = {
  cache?: DiscoveryCache;
};

export type BuiltinFormatter = {
  name: string;
  /**
   * Discover the dispatcher's config root by walking up from each touched
   * file's directory. Returns undefined when no config applies, in which
   * case the built-in is skipped for that flush. Cached per session via the
   * provided cache.
   */
  discoverRoot(
    files: string[],
    context?: BuiltinDiscoveryContext,
  ): Promise<string | undefined>;
  /** Build the argv to invoke given the discovered root and the file batch. */
  buildCommand(
    root: string,
    files: string[],
  ): { command: string[]; cwd: string };
  /**
   * Inspect a completed BatchRun and return the subset of input files the
   * dispatcher reported as "no formatter matched". Those files fall through
   * to subsequent chain steps / per-extension chains.
   */
  partitionUnhandled(run: BatchRun, files: string[]): BuiltinPartition;
};

/**
 * Walk up from each file's directory looking for the first directory whose
 * `match(dir)` returns true. Memoizes results in the optional cache, keyed
 * by visited directory, so repeated calls within a session avoid redundant
 * stat work.
 */
function walkUp(
  files: string[],
  match: (dir: string) => boolean,
  cache?: DiscoveryCache,
): string | undefined {
  for (const file of files) {
    let dir = path.dirname(path.resolve(file));
    const visited: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop with explicit breaks
    while (true) {
      if (cache?.has(dir)) {
        const cached = cache.get(dir) ?? null;
        for (const v of visited) {
          cache.set(v, cached);
        }
        if (cached) return cached;
        break;
      }
      visited.push(dir);
      if (match(dir)) {
        if (cache) {
          for (const v of visited) cache.set(v, dir);
        }
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        if (cache) {
          for (const v of visited) cache.set(v, null);
        }
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

function hasTreefmtConfig(dir: string): boolean {
  return (
    existsSync(path.join(dir, "treefmt.toml")) ||
    existsSync(path.join(dir, ".treefmt.toml"))
  );
}

function hasTreefmtNixConfig(dir: string): boolean {
  if (!existsSync(path.join(dir, "flake.nix"))) {
    return false;
  }
  return (
    existsSync(path.join(dir, "treefmt.nix")) ||
    existsSync(path.join(dir, "nix", "treefmt.nix"))
  );
}

function treefmtConfigPath(root: string): string {
  // treefmt itself prefers treefmt.toml over .treefmt.toml. Default to the
  // canonical name when both/neither exist so callers that haven't created
  // the file on disk still get a sensible argv.
  const canonical = path.join(root, "treefmt.toml");
  const dotted = path.join(root, ".treefmt.toml");
  if (!existsSync(canonical) && existsSync(dotted)) {
    return dotted;
  }
  return canonical;
}

const treefmt: BuiltinFormatter = {
  name: "treefmt",
  discoverRoot(files, context): Promise<string | undefined> {
    return Promise.resolve(walkUp(files, hasTreefmtConfig, context?.cache));
  },
  buildCommand(root, files) {
    return {
      command: [
        "treefmt",
        "--config-file",
        treefmtConfigPath(root),
        "--",
        ...files,
      ],
      cwd: root,
    };
  },
  partitionUnhandled(run, files) {
    const stderr = run.stderr ?? "";
    const unhandled = new Set<string>();
    // treefmt logs lines like "WARN no formatter for path: /repo/x.bin".
    const re = /no formatter for path[: ]+(\S+)/g;
    for (const match of stderr.matchAll(re)) {
      unhandled.add(match[1]);
    }
    const handled = files.filter((f) => !unhandled.has(f));
    const treatAsSkip =
      run.exitCode === 0 && unhandled.size > 0 && handled.length === 0;
    return {
      handled,
      unhandled: files.filter((f) => unhandled.has(f)),
      treatAsSkip,
    };
  },
};

const NIX_TRANSIENT_PATTERNS: readonly string[] = [
  "cannot connect to socket",
  "error: build of",
  "error: unable to start any build",
];

function looksLikeNixTransient(stderr: string): boolean {
  return NIX_TRANSIENT_PATTERNS.some((p) => stderr.includes(p));
}

const treefmtNix: BuiltinFormatter = {
  name: "treefmt-nix",
  discoverRoot(files, context): Promise<string | undefined> {
    return Promise.resolve(walkUp(files, hasTreefmtNixConfig, context?.cache));
  },
  buildCommand(root, files) {
    return {
      command: [
        "nix",
        "fmt",
        "--no-update-lock-file",
        "--no-write-lock-file",
        "--",
        ...files,
      ],
      cwd: root,
    };
  },
  partitionUnhandled(run, files) {
    const stderr = run.stderr ?? "";
    if (
      stderr.includes("emitted 0 files for processing") ||
      looksLikeNixTransient(stderr)
    ) {
      return { handled: [], unhandled: [...files], treatAsSkip: true };
    }
    return { handled: [...files], unhandled: [], treatAsSkip: false };
  },
};

export const BUILTIN_FORMATTERS: Record<string, BuiltinFormatter> = {
  treefmt,
  "treefmt-nix": treefmtNix,
};

export function isBuiltinFormatterName(name: string): boolean {
  return Object.hasOwn(BUILTIN_FORMATTERS, name);
}

export function getBuiltinFormatter(
  name: string,
): BuiltinFormatter | undefined {
  return BUILTIN_FORMATTERS[name];
}
