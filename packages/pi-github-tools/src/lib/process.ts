/**
 * Subprocess invocation helpers built on `node:child_process`.
 *
 * Returns a uniform `{ stdout, stderr, exitCode }` shape.
 * Platform-independent — no Pi SDK imports.
 */
import { type SpawnOptions, spawn } from "node:child_process";

export interface RunCommandOptions {
  cmd: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a child process and capture its stdout, stderr, and exit code.
 *
 * Resolves on process exit regardless of exit code — callers are responsible
 * for inspecting `exitCode` and deciding whether the result is an error.
 */
export async function runCommand(
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const { cmd, args = [], cwd, env, signal } = options;

  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    };

    const child = spawn(cmd, [...args], spawnOpts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code, sigName) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      // When killed by signal, exit code can be null — surface a non-zero code.
      const exitCode = code ?? (sigName ? 128 : 1);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/** Promise-based sleep helper. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal.reason is not guaranteed to be an Error
      reject(
        signal.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
      return;
    }

    const onAbort = signal
      ? () => {
          clearTimeout(timer);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal.reason is not guaranteed to be an Error
          reject(
            signal.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        }
      : undefined;

    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (onAbort) {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
