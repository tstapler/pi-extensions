---
issue: 4
issue_title: "Post-v1: investigate shell-driven mutation coverage"
---

# Plan: Shell-Driven Mutation Coverage (Issue #4)

## Problem Statement

The v1 extension only tracks files mutated through Pi's built-in `write` and `edit` tools.
Files modified by `bash` invocations — including codegen, codemods, `sed -i`, `mv`, downloaded scaffolds, and project-specific scripts — are invisible to the touched-files queue and therefore are not formatted.

The original Issue #4 describes this as "one of the biggest remaining coverage gaps" for users who rely on shell commands that modify files.

## Goals

- Detect a useful subset of file mutations performed by shell commands.
- Funnel any detected files through the existing prompt-end batching pipeline, reusing the formatter resolution and reporting paths.
- Keep behavior explicit, opt-in, and predictable — no repository-wide scans.
- Preserve the v1 safety properties: prompt-end timing remains the default, formatter failures stay non-blocking.

## Non-Goals

- Tracking arbitrary side effects of complex shell pipelines.
- Filesystem watchers or whole-repo rescans after each `bash` call.
- Running formatters inside the shell tool's lifetime (still prompt-end).
- Strict-mode failure semantics (covered by Issue #6).

## Background

Relevant existing pieces:

- `src/touched-files-queue.ts` — set-based dedupe of touched paths, currently hard-coded to the `write`/`edit` mutation tools.
- `src/extension.ts` — registers the `tool_result` handler that feeds the queue and triggers the prompt-end flush via `agent_end`.
- `src/prompt-autoformatter.ts` and `src/formatter-executor.ts` — already agnostic to where touched files came from.

This means the extension architecture is mostly compatible with new mutation sources; the work is mostly in *detection* and *configuration*.

## Design Overview

We will add an opt-in shell mutation detector that participates in the same `tool_result` event flow used today.

The detector is structured as a chain of strategies, each emitting candidate paths from a shell tool result.
Strategies are intentionally narrow and explicit so users can reason about which commands are covered.

### Strategy 1: Argument parsing for known mutating commands (default on)

For a small whitelist of commands with well-known mutation flags, parse the shell input string and extract target file arguments.
Initial whitelist:

- `sed -i …`
- `mv … <dest>` (single-target form only)
- `cp … <dest>` (single-target form only)
- `touch <files…>`
- `> <file>` and `>> <file>` redirections at the top of a simple command
- `tee <file>` / `tee -a <file>`

Rules:

- Only act when the parser recognizes the *whole* command shape; bail on pipelines, command substitutions, or unknown flags.
- Resolve paths relative to `ctx.cwd`.
- Drop paths that do not exist post-execution (the file may have been deleted by `mv` away, etc.).
- Out-of-scope filtering is handled centrally by the queue (see *Format Scope* below).

This covers the common deterministic cases without a generic shell parser.

### Strategy 2: Pre/post directory snapshot for explicit globs (opt-in)

Per-project config can declare *snapshot scopes* — globs whose mtimes are sampled before and after each shell tool call.
Files whose mtime advanced are treated as touched.

```jsonc
{
  "shellMutationDetection": {
    "enabled": true,
    "snapshotGlobs": ["src/**/*.ts", "docs/**/*.md"]
  }
}
```

Rules:

- Snapshot only matched paths, not the whole repo.
- Cap the number of snapshotted entries (e.g., 5,000) and warn on overflow.
- Skip strategy entirely when no globs are configured, even if `enabled`.
- Use `node:fs` `stat` only; never read file contents during snapshotting.
- Skip directories in `.gitignore` and `node_modules` by default.

This is the explicit, low-noise alternative to whole-repo heuristics called out in the issue's constraints.

### Strategy 3: User-declared shell wrappers (opt-in)

Allow users to configure shell command prefixes that are known to print the files they touched on stdout, one per line:

```jsonc
{
  "shellMutationDetection": {
    "wrappers": [
      { "prefix": "pnpm codegen", "outputFormat": "lines" }
    ]
  }
}
```

When a `bash` tool result matches a configured prefix, parse stdout for paths and enqueue them.
This gives users a precise escape hatch without us having to model every codegen tool.

## Format Scope (Out-of-CWD Handling)

The v1 `TouchedFilesQueue` normalizes paths but does **not** filter out-of-cwd targets.
Tightening this is necessary for the shell strategies (arg parsing and wrappers can produce arbitrary paths) and is also a latent v1 gap worth closing uniformly.

### Default boundary: repo root, fall back to cwd

At session start, resolve the format scope once:

1. Run `git rev-parse --show-toplevel` from `ctx.cwd`.
2. If it succeeds, use that path as the scope root.
3. If it fails (not a Git repo, Git missing), fall back to `ctx.cwd`.

This solves the monorepo case where Pi is launched inside a subpackage but the agent legitimately edits sibling packages, while staying conservative in non-Git contexts.
Git is used only as a *boundary discovery* mechanism here — a much weaker coupling than the deferred `git status` detection strategy.

### Configuration

```jsonc
{
  "formatScope": "repoRoot"   // "repoRoot" | "cwd" | string[]
}
```

- `"repoRoot"` (default): repo-root with cwd fallback, as above.
- `"cwd"`: strict cwd subtree.
- `string[]`: explicit allowlist of roots, each resolved relative to `ctx.cwd` at load time.

### Identification rules

For every candidate path, regardless of mutation source:

1. Resolve to absolute via `path.resolve(cwd, candidate)`.
2. `fs.realpath` both the candidate and each scope root, when the candidate exists.
   Skip realpath if the candidate does not exist (e.g., a deleted target after `mv`); fall back to the normalized absolute form.
3. Compute `path.relative(scopeRoot, resolvedCandidate)`.
   In-scope iff the result is non-empty, does not start with `..`, and is not absolute.
4. Use case-insensitive comparison on `darwin` and `win32`; case-sensitive elsewhere.
5. If multiple scope roots are configured (the `string[]` form), the candidate is in-scope if it falls under any of them.

Realpath on both sides is what makes this correct in the presence of symlinks:

- A `pnpm` workspace dep symlinked into `node_modules` resolves *out* of the scope root and is correctly filtered.
- A `vendor/lib` symlink pointing to an absolute path that realpaths *into* a configured scope root is correctly included.

### Out-of-scope handling

Drop silently from the queue.
Out-of-scope paths are common and benign (`mv` to `/tmp/`, scratch edits in `~/`), so user-visible warnings would be noise.
Optionally emit a debug-level log entry; do not surface in the prompt-end summary.

### Applied uniformly

The scope check runs in `TouchedFilesQueue` itself, after path normalization.
All mutation sources — `write`, `edit`, shell argument parsing, wrappers, snapshot tracker — funnel through the same filter.
Each strategy's rules can stop restating "drop paths outside cwd" since the queue enforces it centrally.

### Migration note

This tightens behavior for the existing `write`/`edit` paths: previously they would format any path the agent supplied.
The new default of `repoRoot` (with cwd fallback) is almost certainly the behavior users already expect, but it is technically a change.
Call it out in the changelog.
Users who relied on the old behavior can configure `formatScope` to a broader allowlist; we deliberately do not provide a "no scope check" escape hatch.

## Shell Detection Configuration

New top-level config block under the existing extension-owned config files:

```jsonc
{
  "shellMutationDetection": {
    "enabled": false,
    "argumentParsing": true,
    "snapshotGlobs": [],
    "wrappers": []
  }
}
```

Precedence: project overrides global (existing behavior).

Defaults are intentionally conservative — feature is fully opt-in.
Once a user enables it, `argumentParsing` defaults to true because it has a tight, auditable surface.

Aligned updates required (per AGENTS.md):

- `schemas/pi-autoformat.schema.json`
- `docs/configuration.md`
- `README.md`
- TypeScript config loader (`src/config-loader.ts`, `src/formatter-config.ts`)

## Code Changes

1. **Config**
   - Extend `AutoformatConfig` with `shellMutationDetection`.
   - Validate types and unknown keys in `config-loader.ts`.

2. **New module: `src/shell-mutation-detector.ts`**
   - Pure functions: `parseKnownCommand(input)`, `matchWrapper(input, output, wrappers)`.
   - Class `SnapshotTracker` for strategy 2, with `before()` / `after()`.
   - No I/O at module load; injectable `fs`/`glob` for tests.

3. **Touched-files queue**
   - Generalize `MUTATION_TOOLS` into a registry of mutation-source handlers.
   - Add a `bash` handler that delegates to the detector.
   - Keep dedupe and `cwd`-relative normalization centralized.

4. **Extension wiring**
   - `tool_result` handler: if the tool is `bash` and detection is enabled, run argument parsing and wrapper matching against the result payload.
   - Wrap the shell tool with `before/after` snapshot calls when `snapshotGlobs` is non-empty.
     This requires a `tool_start` hook (or equivalent) — confirm the Pi extension API exposes one; if not, defer strategy 2 to a follow-up.

5. **Reporting**
   - No new reporting surface.
     Files surface through the existing prompt-end summary path.

## Testing

Per AGENTS.md, add focused tests:

- `shell-mutation-detector` argument parsing
  - `sed -i 's/a/b/' foo.txt` → `["foo.txt"]`
  - `sed -i.bak …` → `["foo.txt"]` (and ignores the `.bak`)
  - `mv a.txt b.txt` → `["b.txt"]`
  - pipelines / command substitutions → `[]`
  - paths outside the format scope → `[]` (covered by the queue's scope check)
- snapshot tracker
  - mtime advances → reported
  - mtime unchanged → ignored
  - cap exceeded → warning emitted, partial result returned
- wrapper matching
  - prefix match with line output → list of files
  - prefix mismatch → empty
- queue integration
  - `bash` tool result feeds into prompt-end flush alongside `write`/`edit`
  - dedupe across sources works
- format scope
  - `repoRoot`: in-repo paths kept, out-of-repo paths dropped
  - `repoRoot` with no Git: falls back to cwd subtree
  - `cwd`: sibling-package paths dropped
  - `string[]`: candidate matches any configured root
  - symlinked workspace dep (realpaths outside scope) is dropped
  - symlink whose realpath lands inside scope is kept
  - case-insensitive match honored on darwin/win32
- config loader
  - defaults are off
  - project override of `snapshotGlobs` replaces, does not merge with global (consistent with current array-override behavior — confirm and document)

## Rollout

1. Land `formatScope` config + uniform scope filtering in the queue (independent of detection — closes the v1 gap on its own).
2. Land config plumbing + schema/docs updates for shell detection with detection disabled.
3. Land argument-parsing strategy behind the new config flag.
4. Land wrapper strategy.
5. Land snapshot strategy if a `tool_start` (or pre-tool) hook exists; else open a follow-up issue.
6. Update `docs/plans/0001-initial-implementation-plan.md` and the README to describe the new opt-in coverage, the format scope behavior, and the explicit constraints.

## Open Questions

- Does the Pi extension API expose a pre-tool hook usable for snapshotting?
  If not, strategy 2 is deferred.
- Should wrappers support a JSON output format in addition to line format?
  Likely yes, but not in the first cut.

## Explicitly Deferred: `git status --porcelain` Detection

Using `git status --porcelain` (with a pre-call snapshot diff) was considered as a fourth strategy.
It offers near-complete coverage with no per-command modeling, honors `.gitignore` for free, and is fast.

It is **not** included at this stage because:

- It is implicit repo-wide behavior, which Issue #4 explicitly warns against.
- It produces false positives from concurrent activity (IDE saves, watchers, dev servers writing into tracked paths).
- It interacts awkwardly with pre-existing dirty working trees and requires careful snapshot/diff logic to subtract unrelated in-progress edits.
- Untracked files are ambiguous — sweeping them in catches scratch files, logs, and downloaded artifacts.
- It silently does nothing in non-Git directories, which Pi runs in more often than expected.
- It loses per-command attribution, hurting debuggability and foreclosing future per-command policy.

The explicit strategies above match the issue's stated philosophy that "explicit, low-noise designs are preferable to implicit heuristics."
We can revisit `git status` later if real-world usage shows meaningful gaps the three explicit strategies cannot close, ideally as a scoped, opt-in tertiary strategy rather than a default.

## Checkpoints / Commits

Following Conventional Commits:

- `feat: add formatScope config with repo-root default and cwd fallback`
- `feat(config): add shellMutationDetection schema and loader support`
- `feat: parse known mutating shell commands into touched files`
- `feat: support user-declared shell wrappers for touched-file output`
- `feat: snapshot configured globs around bash tool calls` *(conditional)*
- `docs: document shell mutation coverage and its constraints`
- `test: cover shell mutation detector strategies and queue integration`
