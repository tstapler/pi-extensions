---
issue: 14
issue_title: "Batch-by-default formatter dispatch"
---

# Plan: Batch-by-Default Formatter Dispatch (Issue #14)

## Problem Statement

The current executor invokes each formatter once per touched file, substituting `$FILE` per call.
This pays N startup costs for N touched files, produces N noisy notifications, and is incompatible with batch-only tools like `treefmt`.
Effectively every common formatter (prettier, biome, ruff, black, gofmt, rustfmt, shfmt, dprint, markdownlint-cli2, etc.) accepts multiple paths in a single invocation, so per-file dispatch is a self-imposed limitation.

## Goals

- Run each formatter step **once per chain group**, with all touched files in that group appended as trailing arguments.
- Adopt a single "command + args, then file paths appended" convention that mirrors `pi-formatter`'s `appendFile` shape.
- Make `tool`-mode formatting degenerate cleanly to a single-path batch.
- Surface batch failures clearly: exit code + which files were in the batch.

This is a **breaking change**.
We are not maintaining `$FILE` substitution backcompat — see Compatibility below.

## Non-Goals

- Implementing the `fallback` step type (#13).
  This plan only ensures the new batch executor is shaped so that #13 can plug in at the group level later.
- Built-in `treefmt` support (separate issue).
  This plan unblocks it but does not add it.
- Parallel chain-group execution.
  Groups still flush sequentially.
- Reworking the touched-files queue, mutation detectors, or scope resolution.
- Per-file outcome parsing from formatter stdout/stderr.
  The result shape leaves room for it; v1 reports per-batch only.

## Background

Relevant existing pieces:

- `src/formatter-registry.ts` — resolves a chain per file, substitutes `$FILE` in each formatter command.
- `src/formatter-executor.ts` — runs a chain for a single file, command-by-command.
- `src/prompt-autoformatter.ts` — loops over touched files, resolving and executing a chain per file.
- `src/extension.ts` — `defaultReportFlushResult` summarizes per-file results from `PromptAutoformatterResult`.

The architecture is already chain-oriented; the work is to lift the unit of execution from "one file" to "one group of files that share a chain."

## Design Overview

### Dispatch model

1. After flushing the touched-files queue, group files by their chain identity (same ordered list of formatter names → same group).
   Files with no chain are dropped as today.
2. For each group, resolve the chain once (formatter name → command + env), then run each chain step once with the group's file paths appended as trailing arguments.
3. Chain steps run sequentially within a group.
   Groups themselves are processed sequentially (no concurrency change).
4. A failing step does not abort later steps in the group — same policy as today's per-file chain.

**Grouping key**: the chain's formatter-name list joined with a NUL separator (e.g. `"prettier\0markdownlint-cli2"`).
Stable, comparable, independent of file paths.

**Separation of concerns**: grouping is about files ("which files share a chain?"); resolution is about formatters ("what command does this chain expand to?").
The two operations are split into distinct functions so neither has to know about the other's inputs.

### Formatter command convention

A formatter's `command` is **configured args only**.
The executor appends the batch's file paths verbatim:

```json
"formatters": {
  "prettier": { "command": ["prettier", "--write"] },
  "markdownlint-cli2": { "command": ["markdownlint-cli2", "--fix"] }
}
```

No substitution.
No special tokens.
The schema rejects `$FILE` as invalid.

### Compatibility

This is a breaking change.
Configs containing `$FILE` are rejected at config-load time with a clear validation issue:

> Formatter `prettier`: `$FILE` is no longer supported.
> Remove it — file paths are appended automatically.
> See `docs/configuration.md`.

The formatter is treated as misconfigured (skipped) until the user updates the config.
We do not silently strip the token, because silently changing the resolved command would mask real misconfiguration (e.g. `--stdin-filepath $FILE -` becoming `--stdin-filepath -`).

Validation lives in the config loader alongside existing schema checks and surfaces through the established `reportConfigIssues` path.

### Failure handling

- Each chain-step invocation produces one `BatchRun` with: command, exit code, stdout, stderr, and the file paths it ran against.
- v1 does not parse formatter output for per-file outcomes.
  On non-zero exit, the entire batch is reported as failed and stderr is surfaced once.
  This avoids per-formatter parsers and keeps the contract narrow.
- Per-file output parsing is a follow-up; the result shape leaves room for it.

### Result shape

`PromptAutoformatterResult` becomes batch-first:

```ts
type BatchRun = {
  formatterName: string;
  command: string[];          // resolved command including appended files
  files: string[];            // files in this batch
  success: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type ChainGroupResult = {
  chain: string[];            // formatter names, in order
  files: string[];            // files in this group
  runs: BatchRun[];           // one per chain step
};

type PromptAutoformatterResult = {
  groups: ChainGroupResult[];
};
```

The extension's reporter summarizes:

- success: `Autoformatted N files across M batches` (file list when short).
- failure: per-batch lines naming the formatter, exit code, and the files it touched.

### Interaction with `tool` mode

In `tool` mode the queue is flushed after every successful mutation, so a group is naturally size 1.
The new executor still runs once, appending the single path — behavior is unchanged from the user's perspective.

## Module-Level Changes

- `src/formatter-registry.ts`
  - Remove `$FILE` substitution entirely.
  - Add `groupFilesByChain(files, config)` → `Array<{ chain: string[]; files: string[] }>`.
    Pure grouping; no formatter resolution.
  - Add `resolveChain(chainNames, config)` → `ResolvedFormatter[]`.
    Pure resolution; no file-path involvement.
    Skips disabled or missing formatters as today.
  - The legacy per-file `resolveFormatterChainForFile` is removed.
- `src/formatter-executor.ts`
  - Replace `executeFormatterChain` with `executeChainGroup({ chain, files }, runner, options)` that runs each step once with appended file paths and returns `{ runs: BatchRun[] }`.
- `src/prompt-autoformatter.ts`
  - Drive the new grouping + group-execution path.
    Return the new `groups`-based result shape.
- `src/extension.ts`
  - Update `defaultReportFlushResult` to read the new shape.
- `src/config-loader.ts`
  - Reject `$FILE` in any formatter command with a config-issue.
- `src/formatter-config.ts`
  - Drop `$FILE` from default formatter commands.
- `schemas/pi-autoformat.schema.json`
  - Update the `command` description to document "args + appended file paths."
  - Add a pattern or `not` constraint that rejects `$FILE` in `command` items.
- `docs/configuration.md`, `README.md`, `CHANGELOG.md`
  - Document the new convention, the breaking change, and the per-batch reporting behavior.

## TDD Order

Each step is a small red→green→commit cycle.

1. **Registry: chain resolution.**
   Tests for `resolveChain(names, config)` covering ordered resolution, disabled-formatter skip, missing-formatter skip, environment passthrough.
2. **Registry: file grouping.**
   Tests for `groupFilesByChain(files, config)` covering: mixed extensions → distinct groups; same extension → one group; different extensions sharing a chain → one group; files with no chain dropped; deterministic group and file ordering.
3. **Executor: batch dispatch.**
   Tests for `executeChainGroup` covering single-file batch, multi-file batch, multi-step chain (each step runs once with all files appended), step failure does not abort later steps, environment overrides propagate.
4. **Executor: command shape.**
   Tests asserting configured args come first and file paths are appended verbatim.
5. **Config loader: `$FILE` rejection.**
   Test that a formatter command containing `$FILE` produces a validation issue and the formatter is excluded from the active config.
6. **PromptAutoformatter: end-to-end.**
   Tests for the new `groups`-based result shape: mixed-extension touched set produces one group per chain; tool-mode size-1 batch still works; empty touched set yields no groups; existing chain steps run once each.
7. **Extension: reporting.**
   Tests for the updated `defaultReportFlushResult` covering success summary across multiple groups and per-batch failure lines.
8. **Defaults + schema alignment.**
   Update built-in formatter defaults and schema; acceptance/smoke tests assert defaults contain no `$FILE` and the schema rejects it.
9. **Docs + changelog.**
   Update `docs/configuration.md`, `README.md`, and `CHANGELOG.md`.

Commit at each step using Conventional Commits, e.g. `test: cover chain grouping`, `feat: group touched files by chain`, `feat!: batch-dispatch chain steps`, `feat!: drop $FILE substitution`, `docs: document batch dispatch convention`.

## Risks and Mitigations

- **Risk:** A user upgrades and finds their `$FILE`-using config rejected.
  **Mitigation:** Validation message names the formatter, says exactly what to do, and points at `docs/configuration.md`.
  CHANGELOG entry flags the breaking change.
  Major version bump.
- **Risk:** A formatter that genuinely needs one-file-per-invocation (e.g. a tool requiring `--stdin-filepath`) is now broken.
  **Mitigation:** Not present in any formatter listed in #14.
  If a real case appears, add a `batch: false` per-formatter opt-out in a follow-up.
- **Risk:** A formatter aborts on the first file with an error, silently skipping later files in the batch.
  **Mitigation:** Documented as a known limitation; per-file output parsing is a follow-up.
  Exit code is still surfaced and stderr is preserved.

## Open Questions

- Per-formatter `batch: false` escape hatch — defer until a concrete case appears.
- Whether to fail-loud (skip the formatter) or fail-fatal (refuse to load config) on `$FILE`.
  Plan goes with fail-loud-skip; revisit if it turns out to be confusing in practice.
