import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type CommandProbe = (command: string) => boolean;

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous PATH probe.
 *
 * - An absolute path returns true iff it points at an executable file.
 * - A bare command name is searched along $PATH; the first executable match wins.
 *
 * Windows is intentionally out of scope; this extension assumes POSIX-style
 * invocation.
 */
export function defaultCommandProbe(command: string): boolean {
  if (command.length === 0) {
    return false;
  }
  if (isAbsolute(command)) {
    return isExecutableFile(command);
  }
  const pathEnv = process.env.PATH ?? "";
  if (pathEnv.length === 0) {
    return false;
  }
  for (const segment of pathEnv.split(delimiter)) {
    if (segment.length === 0) {
      continue;
    }
    if (isExecutableFile(join(segment, command))) {
      return true;
    }
  }
  return false;
}

/**
 * Wraps a probe in a per-instance memoization cache. Intended to be created
 * once per flush and shared across chain groups so the same command is probed
 * at most once per flush.
 */
export function createCachedCommandProbe(probe: CommandProbe): CommandProbe {
  const cache = new Map<string, boolean>();
  return (command) => {
    const cached = cache.get(command);
    if (cached !== undefined) {
      return cached;
    }
    const result = probe(command);
    cache.set(command, result);
    return result;
  };
}
