import type { BuiltinFormatter } from "./builtin-formatters";
import type { CommandProbe } from "./command-probe";
import { defaultCommandProbe } from "./command-probe";
import type {
  ResolvedChainStep,
  ResolvedFormatter,
} from "./formatter-registry";

export type CommandRunResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type CommandRunnerOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunnerOptions,
) => Promise<CommandRunResult>;

export type FallbackContext = {
  skipped: string[];
};

export type BatchRun = {
  formatterName: string;
  command: string[];
  files: string[];
  success: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  fallbackContext?: FallbackContext;
};

export type ChainGroupInput = {
  chain: ResolvedChainStep[];
  files: string[];
};

export type ExecuteChainGroupOptions = {
  cwd?: string;
  commandProbe?: CommandProbe;
  /** Optional discovery context passed to built-in formatters. */
  builtinContext?: { cache?: Map<string, string | null> };
};

export type ChainGroupExecution = {
  runs: BatchRun[];
  /** Files not yet handled by any built-in step in this chain. */
  unhandled: string[];
};

async function runOrdinaryFormatter(
  formatter: ResolvedFormatter,
  files: string[],
  runner: CommandRunner,
  cwd: string | undefined,
  fallbackContext?: FallbackContext,
): Promise<BatchRun> {
  const [command, ...args] = formatter.command;

  if (!command) {
    return {
      formatterName: formatter.name,
      command: [...formatter.command],
      files: [...files],
      success: false,
      exitCode: 1,
      stderr: "Formatter command is empty",
      ...(fallbackContext ? { fallbackContext } : {}),
    };
  }

  const fullArgs = [...args, ...files];
  const runResult = await runner(command, fullArgs, {
    cwd,
    env: formatter.environment,
  });

  return {
    formatterName: formatter.name,
    command: [command, ...fullArgs],
    files: [...files],
    success: runResult.exitCode === 0,
    exitCode: runResult.exitCode,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    ...(fallbackContext ? { fallbackContext } : {}),
  };
}

type BuiltinRunResult = {
  /** undefined when the built-in is skipped entirely (no root, treatAsSkip). */
  run?: BatchRun;
  handled: string[];
  unhandled: string[];
};

async function runBuiltinFormatter(
  formatter: ResolvedFormatter,
  builtin: BuiltinFormatter,
  files: string[],
  runner: CommandRunner,
  options: ExecuteChainGroupOptions | undefined,
  fallbackContext?: FallbackContext,
): Promise<BuiltinRunResult> {
  const root = await builtin.discoverRoot(files, options?.builtinContext);
  if (!root) {
    // No applicable config; treat as a clean no-op so the entire batch falls
    // through to subsequent steps / per-extension chains.
    return { handled: [], unhandled: [...files] };
  }
  const built = builtin.buildCommand(root, files);
  const [command, ...args] = built.command;
  if (!command) {
    return { handled: [], unhandled: [...files] };
  }
  const runResult = await runner(command, args, {
    cwd: built.cwd,
    env: formatter.environment,
  });
  const run: BatchRun = {
    formatterName: formatter.name,
    command: [command, ...args],
    files: [...files],
    success: runResult.exitCode === 0,
    exitCode: runResult.exitCode,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    ...(fallbackContext ? { fallbackContext } : {}),
  };
  const partition = builtin.partitionUnhandled(run, files);
  if (partition.treatAsSkip) {
    return { handled: [], unhandled: [...files] };
  }
  return {
    run,
    handled: partition.handled,
    unhandled: partition.unhandled,
  };
}

export async function executeChainGroupWithPartition(
  group: ChainGroupInput,
  runner: CommandRunner,
  options?: ExecuteChainGroupOptions,
): Promise<ChainGroupExecution> {
  if (group.files.length === 0) {
    return { runs: [], unhandled: [] };
  }

  const probe = options?.commandProbe ?? defaultCommandProbe;
  const runs: BatchRun[] = [];
  // Working set: files that have not yet been claimed by a built-in step.
  let working: string[] = [...group.files];

  for (const step of group.chain) {
    if (working.length === 0) {
      break;
    }

    if (step.kind === "single") {
      const formatter = step.formatter;
      if (formatter.builtin) {
        const result = await runBuiltinFormatter(
          formatter,
          formatter.builtin,
          working,
          runner,
          options,
        );
        if (result.run) runs.push(result.run);
        working = result.unhandled;
        continue;
      }
      runs.push(
        await runOrdinaryFormatter(formatter, working, runner, options?.cwd),
      );
      continue;
    }

    const skipped: string[] = [];
    let chosen: ResolvedFormatter | undefined;
    for (const alternative of step.alternatives) {
      const command = alternative.command[0];
      if (command && probe(command)) {
        chosen = alternative;
        break;
      }
      skipped.push(alternative.name);
    }

    if (!chosen) {
      // All alternatives missing from PATH — group is a no-op as specified.
      continue;
    }

    // Precedence rule: when treefmt would win and treefmt-nix is also viable
    // and resolves to a config at the same root, prefer treefmt-nix.
    if (chosen.builtin?.name === "treefmt") {
      const nixAlt = step.alternatives.find(
        (a) => a.builtin?.name === "treefmt-nix" && probe(a.command[0] ?? ""),
      );
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- builtin may be absent on custom formatters
      if (nixAlt && chosen.builtin && nixAlt.builtin) {
        const treefmtRoot = await chosen.builtin.discoverRoot(
          working,
          options?.builtinContext,
        );
        const nixRoot = await nixAlt.builtin.discoverRoot(
          working,
          options?.builtinContext,
        );
        if (treefmtRoot && nixRoot && treefmtRoot === nixRoot) {
          // Bump treefmt into skipped (so the user sees fallback annotation)
          // and switch to treefmt-nix.
          skipped.push(chosen.name);
          chosen = nixAlt;
        }
      }
    }

    const fallbackContext: FallbackContext | undefined =
      skipped.length > 0 ? { skipped } : undefined;
    if (chosen.builtin) {
      const result = await runBuiltinFormatter(
        chosen,
        chosen.builtin,
        working,
        runner,
        options,
        fallbackContext,
      );
      if (result.run) runs.push(result.run);
      working = result.unhandled;
      continue;
    }
    runs.push(
      await runOrdinaryFormatter(
        chosen,
        working,
        runner,
        options?.cwd,
        fallbackContext,
      ),
    );
  }

  return { runs, unhandled: working };
}

export async function executeChainGroup(
  group: ChainGroupInput,
  runner: CommandRunner,
  options?: ExecuteChainGroupOptions,
): Promise<BatchRun[]> {
  const result = await executeChainGroupWithPartition(group, runner, options);
  return result.runs;
}
