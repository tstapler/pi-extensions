import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { DiscoveryCache } from "./builtin-formatters";
import {
  type CommandProbe,
  createCachedCommandProbe,
  defaultCommandProbe,
} from "./command-probe";
import type { FormatScope } from "./format-scope";
import {
  type BatchRun,
  type CommandRunner,
  executeChainGroupWithPartition,
} from "./formatter-executor";
import type { ChainStep } from "./formatter-registry";
import {
  type FormatterConfig,
  groupFilesByChain,
  resolveChainSteps,
  WILDCARD_CHAIN_KEY,
} from "./formatter-registry";
import {
  type MutationSourceHandler,
  TouchedFilesQueue,
} from "./touched-files-queue";

export type ChainGroupResult = {
  chain: ChainStep[];
  files: string[];
  runs: BatchRun[];
  changedFiles: string[];
};

export type PromptAutoformatterResult = {
  groups: ChainGroupResult[];
};

export type PromptAutoformatterOptions = {
  scope?: FormatScope;
  mutationHandlers?: MutationSourceHandler[];
  /**
   * Probe used to test whether a fallback alternative's command is on PATH.
   * Wrapped in a per-flush cache so the same command is probed at most once
   * per flush across all chain groups. Defaults to the synchronous PATH walker.
   */
  commandProbe?: CommandProbe;
};

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

export class PromptAutoformatter {
  private readonly queue: TouchedFilesQueue;
  private readonly commandProbe: CommandProbe;
  /** Session-scoped cache for built-in config-root discovery. */
  private readonly discoveryCache: DiscoveryCache = new Map();

  constructor(
    private readonly cwd: string,
    private readonly config: FormatterConfig,
    private readonly runner: CommandRunner,
    options?: PromptAutoformatterOptions,
  ) {
    this.queue = new TouchedFilesQueue({
      cwd,
      scope: options?.scope,
      handlers: options?.mutationHandlers,
    });
    this.commandProbe = options?.commandProbe ?? defaultCommandProbe;
  }

  recordToolResult(toolName: string, payload: unknown, output = ""): void {
    this.queue.recordToolResult(toolName, payload, output);
  }

  addTouchedPath(filePath: string): void {
    this.queue.addPath(filePath);
  }

  async flushPrompt(): Promise<PromptAutoformatterResult> {
    const touchedFiles = this.queue.flush();
    const fileGroups = groupFilesByChain(touchedFiles, this.config);
    const groupResults: ChainGroupResult[] = [];

    // One probe cache per flush, shared across all chain groups so the same
    // fallback command is probed at most once even when many extensions share
    // the same fallback step.
    const cachedProbe = createCachedCommandProbe(this.commandProbe);
    const wildcardChainSteps = this.config.chains?.[WILDCARD_CHAIN_KEY];
    const hasWildcard =
      Array.isArray(wildcardChainSteps) && wildcardChainSteps.length > 0;
    const wildcardHandled = new Set<string>();

    for (let i = 0; i < fileGroups.length; i += 1) {
      const group = fileGroups[i];
      // groupFilesByChain emits the wildcard group first when chains["*"] is
      // configured, so the index is sufficient.
      const isWildcard = hasWildcard && i === 0;

      // For per-extension groups, drop any files claimed by the wildcard pass.
      const inputFiles = isWildcard
        ? group.files
        : group.files.filter((f) => !wildcardHandled.has(f));
      if (inputFiles.length === 0) {
        continue;
      }

      const resolved = resolveChainSteps(group.chain, this.config);
      if (resolved.length === 0) {
        continue;
      }

      // Snapshot file content hashes before formatting.
      const preHashes = new Map<string, string>();
      for (const file of inputFiles) {
        const hash = await hashFile(file);
        if (hash !== undefined) {
          preHashes.set(file, hash);
        }
      }

      const { runs, unhandled } = await executeChainGroupWithPartition(
        { chain: resolved, files: inputFiles },
        this.runner,
        {
          cwd: this.cwd,
          commandProbe: cachedProbe,
          builtinContext: { cache: this.discoveryCache },
        },
      );

      if (isWildcard) {
        // Files not in the unhandled tail were claimed by a built-in step;
        // remove them from the per-extension pass.
        const unhandledSet = new Set(unhandled);
        for (const file of inputFiles) {
          if (!unhandledSet.has(file)) {
            wildcardHandled.add(file);
          }
        }
      }

      if (runs.length === 0) {
        // E.g. a chain consisting of a single fallback group whose
        // alternatives are all absent from PATH, or a built-in that skipped
        // the entire batch. Drop the group so it does not show up as a
        // phantom "formatted nothing" entry downstream.
        continue;
      }

      // Determine which files were actually changed by comparing post-format
      // hashes to the pre-format snapshots.
      const changedFiles: string[] = [];
      for (const file of inputFiles) {
        const afterHash = await hashFile(file);
        if (afterHash === undefined) {
          // File was deleted by the formatter — exclude.
          continue;
        }
        const beforeHash = preHashes.get(file);
        if (beforeHash !== afterHash) {
          changedFiles.push(file);
        }
      }

      groupResults.push({
        chain: group.chain,
        files: [...inputFiles],
        runs,
        changedFiles,
      });
    }

    return { groups: groupResults };
  }
}
