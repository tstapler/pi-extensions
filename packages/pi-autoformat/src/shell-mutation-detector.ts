import { statSync } from "node:fs";
import path from "node:path";

export type WrapperOutputFormat = "lines";

export type WrapperConfig = {
  prefix: string;
  outputFormat?: WrapperOutputFormat;
};

export type ShellMutationDetectionConfig = {
  enabled: boolean;
  argumentParsing: boolean;
  snapshotGlobs: string[];
  wrappers: WrapperConfig[];
};

export const DEFAULT_SHELL_MUTATION_DETECTION: ShellMutationDetectionConfig = {
  enabled: false,
  argumentParsing: true,
  snapshotGlobs: [],
  wrappers: [],
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a simple shell command into raw tokens, tracking redirections.
 *
 * Bails (returns `undefined`) on any construct that breaks the
 * "single simple command" assumption: pipes, logical operators, command
 * substitution, backticks, subshells, sequencing, environment assignments
 * before the command, etc. The conservative bail keeps the parser auditable.
 */
type ParsedCommand = {
  argv: string[];
  redirects: Array<{ op: ">" | ">>"; target: string }>;
};

function isMetaChar(ch: string): boolean {
  return ch === "|" || ch === "&" || ch === ";" || ch === "(" || ch === ")";
}

function tokenizeSimpleCommand(input: string): ParsedCommand | undefined {
  const argv: string[] = [];
  const redirects: ParsedCommand["redirects"] = [];

  let i = 0;
  const n = input.length;
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let pendingRedirect: ">" | ">>" | undefined;

  const flush = (): boolean => {
    if (current.length === 0) {
      return true;
    }
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: current });
      pendingRedirect = undefined;
    } else {
      argv.push(current);
    }
    current = "";
    return true;
  };

  while (i < n) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && i + 1 < n) {
        const next = input[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i += 2;
          continue;
        }
      }
      if (ch === "$" || ch === "`") {
        return undefined; // command substitution / variable expansion in dquotes
      }
      if (ch === '"') {
        inDouble = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < n) {
      current += input[i + 1];
      i += 2;
      continue;
    }

    if (ch === "$" || ch === "`") {
      return undefined; // command substitution
    }

    if (isMetaChar(ch)) {
      return undefined; // pipeline / sequencing / subshell
    }

    if (ch === "<") {
      return undefined; // input redirect — bail conservatively
    }

    if (ch === ">") {
      flush();
      if (input[i + 1] === ">") {
        pendingRedirect = ">>";
        i += 2;
      } else {
        pendingRedirect = ">";
        i += 1;
      }
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      flush();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (inSingle || inDouble) {
    return undefined;
  }
  flush();

  if (pendingRedirect) {
    return undefined; // dangling redirect target
  }

  return { argv, redirects };
}

// ---------------------------------------------------------------------------
// Strategy 1: argument parsing for known mutating commands
// ---------------------------------------------------------------------------

function stripSedBackupExt(flag: string): string | undefined {
  // -i              -> ""
  // -i.bak          -> ".bak"   (we ignore the backup file)
  // -i ''           -> handled at argv level
  if (flag === "-i") {
    return "";
  }
  if (flag.startsWith("-i") && flag.length > 2) {
    return flag.slice(2);
  }
  return undefined;
}

function parseSed(argv: string[]): string[] | undefined {
  // Recognize: sed -i[ext] [-e SCRIPT|-f FILE|SCRIPT] FILE...
  // We only act when -i is present. We do not interpret the script.
  let i = 1;
  let sawInPlace = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith("-") || tok === "-") {
      break;
    }
    if (tok === "--") {
      i += 1;
      break;
    }
    const sed = stripSedBackupExt(tok);
    if (sed !== undefined) {
      sawInPlace = true;
      i += 1;
      // Some forms take an empty next arg as the backup suffix: `sed -i '' ...`
      if (tok === "-i" && i < argv.length && argv[i] === "") {
        i += 1;
      }
      continue;
    }
    if (tok === "-e" || tok === "-f") {
      // skip the next arg (script or script-file)
      i += 2;
      continue;
    }
    // Unknown flag → bail
    return undefined;
  }

  if (!sawInPlace) {
    return [];
  }

  // First non-flag is the script unless -e/-f provided one. We can't reliably
  // distinguish, so assume the first remaining token is the script and the
  // rest are files. This matches `sed -i 's/a/b/' foo.txt` and similar.
  if (i >= argv.length) {
    return undefined;
  }
  const files = argv.slice(i + 1);
  if (files.length === 0) {
    return undefined;
  }
  return files;
}

function parseMv(argv: string[]): string[] | undefined {
  // Conservative: only single-source single-dest form, no flags we don't know.
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("-")) {
      // Allow common safe-ish flags; bail otherwise.
      if (tok === "-f" || tok === "-v" || tok === "-n") {
        continue;
      }
      return undefined;
    }
    positional.push(tok);
  }
  if (positional.length !== 2) {
    return undefined;
  }
  return [positional[1]];
}

function parseCp(argv: string[]): string[] | undefined {
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("-")) {
      if (tok === "-f" || tok === "-v" || tok === "-p") {
        continue;
      }
      return undefined;
    }
    positional.push(tok);
  }
  if (positional.length !== 2) {
    return undefined;
  }
  return [positional[1]];
}

function parseTouch(argv: string[]): string[] | undefined {
  const files: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      files.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("-")) {
      // touch has -a, -m, -c, -r FILE, -t TIME, -d DATE — bail on anything
      // not in our minimal allowlist to keep the surface auditable.
      if (tok === "-a" || tok === "-m" || tok === "-c") {
        continue;
      }
      return undefined;
    }
    files.push(tok);
  }
  if (files.length === 0) {
    return undefined;
  }
  return files;
}

function parseTee(argv: string[]): string[] | undefined {
  const files: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      files.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("-")) {
      if (tok === "-a" || tok === "--append") {
        continue;
      }
      return undefined;
    }
    files.push(tok);
  }
  if (files.length === 0) {
    return undefined;
  }
  return files;
}

/**
 * Parse a bash command string and return any files the command is known to
 * mutate. Returns an empty array if the command shape is recognized but
 * touches no files; returns an empty array (with no error) if the command
 * shape is unknown or too complex to reason about.
 */
export function parseKnownCommand(input: string): string[] {
  const parsed = tokenizeSimpleCommand(input);
  if (!parsed) {
    return [];
  }
  const { argv, redirects } = parsed;

  const results: string[] = [];

  // Recognized command shapes contribute their argument-derived files.
  // Any unrecognized command bails out — even if a redirection is present —
  // because the command may have unmodelled side effects.
  if (argv.length > 0) {
    const cmd = argv[0];
    let parsedArgs: string[] | undefined;
    switch (cmd) {
      case "sed":
        parsedArgs = parseSed(argv);
        break;
      case "mv":
        parsedArgs = parseMv(argv);
        break;
      case "cp":
        parsedArgs = parseCp(argv);
        break;
      case "touch":
        parsedArgs = parseTouch(argv);
        break;
      case "tee":
        parsedArgs = parseTee(argv);
        break;
      case "echo":
      case "printf":
      case "cat":
        // Stdout-producing builtins are safe partners for redirections.
        parsedArgs = [];
        break;
      default:
        return [];
    }

    if (parsedArgs === undefined) {
      return [];
    }
    results.push(...parsedArgs);
  }

  for (const r of redirects) {
    results.push(r.target);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 3: user-declared shell wrappers
// ---------------------------------------------------------------------------

/**
 * If `input` starts with any configured wrapper prefix, return the file paths
 * the wrapper printed on stdout (one per line). Empty lines and lines that
 * are clearly not paths (start with `[`, contain `:` followed by space) are
 * skipped.
 */
export function matchWrapper(
  input: string,
  output: string,
  wrappers: WrapperConfig[],
): string[] {
  const trimmed = input.trimStart();
  for (const wrapper of wrappers) {
    if (!wrapper.prefix) {
      continue;
    }
    if (
      trimmed === wrapper.prefix ||
      trimmed.startsWith(`${wrapper.prefix} `) ||
      trimmed.startsWith(`${wrapper.prefix}\t`) ||
      trimmed.startsWith(`${wrapper.prefix}\n`)
    ) {
      const format = wrapper.outputFormat ?? "lines";
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- format narrows correctly but lint sees "lines" === "lines" as always true
      if (format === "lines") {
        return parseLinesOutput(output);
      }
    }
  }
  return [];
}

function parseLinesOutput(output: string): string[] {
  const out: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategy 2: pre/post snapshot of explicit globs
// ---------------------------------------------------------------------------

export type SnapshotTrackerOptions = {
  cwd: string;
  globs: string[];
  /** Resolve globs to absolute file paths. Injected for tests. */
  resolveGlobs?: (cwd: string, globs: string[]) => string[];
  /** stat function — injected for tests. */
  stat?: (absPath: string) => { mtimeMs: number } | undefined;
  /** Maximum entries to track before warning + truncating. */
  maxEntries?: number;
  /** Receives a single message string when the cap is exceeded. */
  onWarn?: (message: string) => void;
};

const DEFAULT_MAX_ENTRIES = 5000;

function defaultStat(absPath: string): { mtimeMs: number } | undefined {
  try {
    const s = statSync(absPath);
    if (!s.isFile()) {
      return undefined;
    }
    return { mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

function defaultResolveGlobs(_cwd: string, _globs: string[]): string[] {
  // Real glob resolution lives at the wiring layer (and may be deferred until
  // we add a glob library). The default is a no-op so the tracker is testable
  // in isolation via the injectable resolver.
  return [];
}

/**
 * Pre/post mtime snapshot tracker for explicit globs.
 *
 * `before()` records mtimes for all matched files. `after()` re-stats and
 * returns the absolute paths whose mtime advanced. Files that did not exist
 * before but exist after are also reported.
 */
export class SnapshotTracker {
  private readonly options: Required<
    Pick<SnapshotTrackerOptions, "cwd" | "globs">
  > &
    Required<
      Pick<SnapshotTrackerOptions, "resolveGlobs" | "stat" | "maxEntries">
    > & {
      onWarn: (message: string) => void;
    };

  private snapshot: Map<string, number> | undefined;

  constructor(options: SnapshotTrackerOptions) {
    this.options = {
      cwd: options.cwd,
      globs: options.globs,
      resolveGlobs: options.resolveGlobs ?? defaultResolveGlobs,
      stat: options.stat ?? defaultStat,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      onWarn: options.onWarn ?? (() => {}),
    };
  }

  before(): void {
    if (this.options.globs.length === 0) {
      this.snapshot = new Map();
      return;
    }
    const files = this.options.resolveGlobs(
      this.options.cwd,
      this.options.globs,
    );
    const snapshot = new Map<string, number>();
    let truncated = false;
    for (const file of files) {
      if (snapshot.size >= this.options.maxEntries) {
        truncated = true;
        break;
      }
      const abs = path.isAbsolute(file)
        ? file
        : path.resolve(this.options.cwd, file);
      const s = this.options.stat(abs);
      if (s) {
        snapshot.set(abs, s.mtimeMs);
      }
    }
    if (truncated) {
      this.options.onWarn(
        `pi-autoformat: snapshotGlobs matched more than ${this.options.maxEntries} files; tracking truncated.`,
      );
    }
    this.snapshot = snapshot;
  }

  after(): string[] {
    const before = this.snapshot;
    this.snapshot = undefined;
    if (!before) {
      return [];
    }
    if (this.options.globs.length === 0) {
      return [];
    }
    const files = this.options.resolveGlobs(
      this.options.cwd,
      this.options.globs,
    );
    const touched: string[] = [];
    let count = 0;
    for (const file of files) {
      if (count >= this.options.maxEntries) {
        break;
      }
      count += 1;
      const abs = path.isAbsolute(file)
        ? file
        : path.resolve(this.options.cwd, file);
      const s = this.options.stat(abs);
      if (!s) {
        continue;
      }
      const prior = before.get(abs);
      if (prior === undefined || s.mtimeMs > prior) {
        touched.push(abs);
      }
    }
    return touched;
  }
}
