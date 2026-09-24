---
issue: 15
issue_title: "Built-in `treefmt` and `treefmt-nix` project formatter support"
---

# Plan: Built-in `treefmt` and `treefmt-nix` Project Formatter Support (Issue #15)

## Problem Statement

`treefmt` and `treefmt-nix` are widely used project-level formatter dispatchers.
A repository declares its entire formatter chain once in `treefmt.toml` (or in `treefmt.nix` inside a flake), and a single CLI call routes each path to the right formatter.
Today, users of these tools must redeclare every formatter in `pi-autoformat`'s `formatters` and `chains`, which duplicates and drifts from the project's source of truth.

This plan adds two opt-in built-in formatters — `treefmt` and `treefmt-nix` — that users can reference in `chains` without declaring them in `formatters`.
A new wildcard chain key (`"*"`) expresses "applies to any extension" so a single chain entry can hand the whole batch to the project-level dispatcher first, with per-extension chains backstopping any path the dispatcher does not handle.

## Goals

- Ship two built-in formatter names usable in `chains` without a `formatters` entry: `treefmt` and `treefmt-nix`.
- Discover `treefmt.toml` / `.treefmt.toml` (for `treefmt`) and `flake.nix` + `treefmt.nix` / `nix/treefmt.nix` (for `treefmt-nix`) by walking up from each touched file.
- Cache discovered config-root paths per session.
- Support a wildcard `"*"` chain key that runs first against the full batch, with files punted by the wildcard chain falling through to their per-extension chain.
- Map documented "no formatter matched this path" outputs to a clean **skip** outcome so `fallback` chain steps and per-extension fallthrough compose naturally.
- Keep all other non-zero exits visible as real failures.
- Keep this strictly opt-in: zero behavioral change unless a user references one of the built-ins or `"*"`.

## Non-Goals

- Adding general-purpose "named built-in formatters" beyond these two.
  Future built-ins can reuse the same plumbing but are out of scope here.
- Introducing arbitrary glob keys (`"*.tsx.snap"`, `"src/**"`).
  Only the literal `"*"` token is supported.
- Wrapping arbitrary `treefmt` flags through config.
  The two built-ins ship with fixed argv shapes; users who need custom flags can declare a regular `formatters` entry instead.
- Detecting which specific formatter inside `treefmt` failed.
  We treat `treefmt` as one batch step; per-formatter attribution stays inside `treefmt`'s own output.
- Parallelizing the wildcard chain and per-extension chain.
  Wildcard runs first, per-extension chains run after, on whatever files remain.

## Background

Relevant existing modules:

- `src/formatter-registry.ts` — defines `ChainStep`, `ResolvedChainStep`, `ResolvedFormatter`, `groupFilesByChain`, and `resolveChainSteps`.
  Today `groupFilesByChain` keys purely on `path.extname(filePath).toLowerCase()` and silently drops files without an extension or without a matching chain entry.
- `src/formatter-executor.ts` — `executeChainGroup` runs each `ResolvedChainStep` once over the group's full file list.
  `fallback` step currently uses a synchronous `CommandProbe` (PATH check) to choose one alternative.
- `src/prompt-autoformatter.ts` — orchestrates flush: queue → group → resolve → execute.
- `src/formatter-config.ts` — defaults and merge.
- `src/command-probe.ts` — cached PATH probe used per flush.
- `schemas/pi-autoformat.schema.json` — currently restricts chain keys to `^\..+` (extension-style only).
- `docs/configuration.md`, `README.md` — kept aligned.

The recently landed dependencies make this issue cheap:

- #12 (`extensions` field removed) — chains alone drive dispatch.
- #13 (`fallback` step) — composes naturally with the new built-ins.
- #14 (batch dispatch) — `treefmt` only makes sense with batched paths; per-file would defeat the point.

## Design Overview

### Built-in formatter shape

Built-ins are not user-declared in `formatters`.
They are referenced by name (`"treefmt"`, `"treefmt-nix"`) inside `chains`.
The registry resolver (`resolveChainSteps`) consults a built-in table when a name is not present in user/default `formatters`.
Built-ins resolve to a richer descriptor than ordinary formatters because their command depends on per-flush context (discovered config root) and their outcome partitioning depends on parsing the dispatcher's output.

```typescript
export type BuiltinFormatter = {
  name: string;
  /**
   * Discover the dispatcher's config root by walking up from each touched
   * file's directory. Returns undefined when no config applies, in which
   * case the built-in is skipped for that flush. Cached per session.
   */
  discoverRoot(files: string[]): Promise<string | undefined>;
  /** Build the argv to invoke given the discovered root and the file batch. */
  buildCommand(root: string, files: string[]): { command: string[]; cwd: string };
  /**
   * Inspect a completed BatchRun and return the subset of input files the
   * dispatcher reported as "no formatter matched". Those files fall through
   * to subsequent chain steps / per-extension chains.
   */
  partitionUnhandled(run: BatchRun, files: string[]): {
    handled: string[];
    unhandled: string[];
    /** When the entire run is a documented "skip" (e.g. nix transient error). */
    treatAsSkip: boolean;
  };
};
```

`ResolvedFormatter` gains an optional `builtin?: BuiltinFormatter` discriminator.
When set, the executor takes the built-in path; otherwise behavior is unchanged.

### Wildcard `"*"` chain key

`groupFilesByChain` is extended:

1. If `chains["*"]` exists, all touched files are first considered for the wildcard chain regardless of extension (including extensionless files).
2. The wildcard pass produces a `ChainGroupResult` with the full batch and tracks per-step **handled vs. unhandled** sets via `BuiltinFormatter.partitionUnhandled`.
3. After the wildcard pass, only files that ended up unhandled by the wildcard (every step either skipped them or never ran) flow into the existing per-extension grouping.
4. Files handled by the wildcard chain do not appear in any per-extension group.

For non-built-in formatters in a `"*"` chain, every file is considered "handled" (the same as today's per-extension chain semantics).
This keeps the wildcard generic but makes it most useful with built-ins or fallback groups containing built-ins.

### Discovery and caching

A per-session cache keyed by starting directory maps to the discovered config-root path or a "no match" sentinel.
The cache lives on the `PromptAutoformatter` instance (so it survives across flushes within a session) and is passed to built-ins via the existing options plumbing.

Walk strategy: from `path.dirname(filePath)`, walk up to the filesystem root, returning the first directory containing the relevant config file(s).
When the same directory is visited from multiple files, the cache short-circuits.

### Precedence between `treefmt` and `treefmt-nix`

When both apply at the same root, prefer `treefmt-nix`.
This precedence is enforced *only* when both names appear inside the same `fallback` group (or sequential chain) — we do not silently override user ordering elsewhere.
Mechanism: inside a `fallback` group, after PATH probing, if both `treefmt-nix` and `treefmt` are viable and resolve to configs at the same root, `treefmt-nix` wins regardless of order.

### Skip detection

Two narrowly-scoped patterns, mirroring `pi-formatter`:

- `treefmt`: stderr line matching `/no formatter for path[: ]+(?<path>\S+)/` per path → that path is unhandled.
  Exit code 0 with all paths unhandled → treat as skip.
- `treefmt-nix`: stderr containing `emitted 0 files for processing` → entire run is skip.
- Transient nix daemon / sandbox errors detected via known substrings (e.g. `error: cannot connect to socket`, `error: build of`) → entire run is skip so fallback can try the next alternative.

Anything else with a non-zero exit is a real failure and is reported normally.
The exact regex/substring set lives in one place and is unit-tested.

### Edge cases

- Wildcard chain references an undeclared, non-builtin name → loader emits a single config-issue, the entry is dropped (existing pattern).
- Wildcard chain has zero applicable files (e.g. all files were filtered by scope) → no run.
- Built-in's discovery returns no root → step skipped, all files flow to next step / per-extension chains.
- `tool` mode: batch is size 1; built-in still works (single path passed to dispatcher).
- File path is outside the discovered config root → still passed to the dispatcher; treefmt itself decides.
  We do not pre-filter by root, but discovery uses each file's own directory so multi-root repos handle naturally.

## Module-Level Changes

### `src/formatter-registry.ts`

- Extend `ResolvedFormatter` with optional `builtin?: BuiltinFormatter`.
- Update `groupFilesByChain` to accept a wildcard chain (`chains["*"]`) and produce a wildcard group ahead of per-extension groups.
- Allow files without an extension when the wildcard chain is set.
- Adjust the chain encoder so the wildcard group is keyed distinctly.

### `src/builtin-formatters.ts` (new)

- Export a `BUILTIN_FORMATTERS` registry: `Record<string, BuiltinFormatter>`.
- Implement `treefmt` and `treefmt-nix`:
  - discovery walkers
  - command builders (`treefmt --config-file <root>/treefmt.toml --` and `nix fmt --no-update-lock-file --no-write-lock-file --`)
  - output partitioners (skip-pattern matching)
- Export discovery cache type.

### `src/formatter-executor.ts`

- New `executeChainGroup` variant that, for steps containing a built-in formatter, threads the working `files` set through `partitionUnhandled` and returns the **unhandled tail** alongside `BatchRun[]`.
- Honor `treatAsSkip` (do not record the step as a failed run).
- Keep current behavior intact for non-built-in steps.
- Inside `fallback` groups, apply the `treefmt-nix` preference rule when applicable.

### `src/prompt-autoformatter.ts`

- Run the wildcard chain first against the full touched-files batch.
- Subtract the wildcard's "handled" set; pass the remainder to per-extension grouping.
- Hold a session-scoped discovery cache and pass it into the executor.

### `src/formatter-config.ts`

- No changes to defaults (built-ins are opt-in by reference).
- `chains` type continues to be `Record<string, ChainStep[]>` — `"*"` is just a key.
- Loader: validate that any string referenced in a chain is either a declared formatter or a built-in name.

### `schemas/pi-autoformat.schema.json`

- Loosen the `chains` `propertyNames` pattern to also allow the literal `"*"`: `^(\.|\*$).+|^\*$`.
- Update the `chains` description to document `"*"` and the built-in names.

### `docs/configuration.md` and `README.md`

- Document `"*"` semantics (run-first, fallthrough on skip).
- Document the two built-ins, their discovery rules, the `treefmt-nix` precedence, the canonical fallback example, and the skip-pattern policy.
- Note: built-ins do not need a `formatters` entry; declaring one with the same name shadows the built-in (loader emits a config issue if the user shadows a built-in).

### Tests

- `test/builtin-formatters.test.ts` (new): discovery walkers, command builders, output parsers.
- `test/formatter-registry.test.ts`: wildcard grouping, file-without-extension behavior, wildcard + per-extension interaction.
- `test/formatter-executor.test.ts`: built-in step with mixed handled/unhandled, `treatAsSkip` paths, `treefmt-nix` precedence inside a fallback group.
- `test/prompt-autoformatter.test.ts`: wildcard runs first, unhandled files fall through to per-extension chains, handled files do not double-format.
- `test/schema.test.ts`: `"*"` accepted as a chain key.
- `test/config-loader.test.ts`: built-in names accepted in chains without a `formatters` entry; shadow-built-in produces a config issue.

## TDD Order

Each cycle is a tight red→green→commit.
Numbering restarts at 1 under this heading.

1. **Schema accepts `"*"` chain key.**
   Surface: `test/schema.test.ts`.
   Cover: `chains: { "*": [...] }` validates; legacy patterns continue to validate.
   Commit: `test: accept "*" chain key in schema`, then `feat: allow wildcard chain key in schema`.

2. **Wildcard grouping.**
   Surface: `test/formatter-registry.test.ts`.
   Cover: `groupFilesByChain` produces a wildcard-first group when `chains["*"]` is set; extensionless files included; per-extension groups still produced.
   Commit: `test: cover wildcard chain grouping`, then `feat: group files by wildcard chain first`.

3. **Built-in resolution without a `formatters` entry.**
   Surface: `test/formatter-registry.test.ts` + new `test/builtin-formatters.test.ts`.
   Cover: `resolveChainSteps` resolves `treefmt` / `treefmt-nix` to a `ResolvedFormatter` with `builtin` set, even when `formatters` is empty.
   Commit: `test: resolve built-in formatter names without registry entry`, then `feat: register treefmt and treefmt-nix as built-in formatters`.

4. **Discovery walkers.**
   Surface: `test/builtin-formatters.test.ts` against fixture directories under `test/fixtures/`.
   Cover: walks up from a file path, finds `treefmt.toml`, `.treefmt.toml`, `flake.nix` + `treefmt.nix`, `flake.nix` + `nix/treefmt.nix`; returns `undefined` when no config; cache hits do not re-walk.
   Commit: `test: cover treefmt config discovery`, then `feat: discover treefmt and treefmt-nix config roots`.

5. **Command builders.**
   Surface: `test/builtin-formatters.test.ts`.
   Cover: `treefmt` argv shape with `--config-file`; `treefmt-nix` argv shape with `nix fmt --no-update-lock-file --no-write-lock-file --` from the flake root; `cwd` set to the discovered root.
   Commit: `test: cover treefmt command builders`, then `feat: build treefmt and treefmt-nix invocations`.

6. **Skip-pattern parsing.**
   Surface: `test/builtin-formatters.test.ts`.
   Cover: `partitionUnhandled` for `treefmt` parses "no formatter for path" lines into the unhandled set; `treefmt-nix` "emitted 0 files for processing" → `treatAsSkip`; transient nix errors → `treatAsSkip`; unknown non-zero exit → real failure (no skip).
   Commit: `test: cover built-in skip-pattern parsing`, then `feat: parse treefmt skip patterns`.

7. **Executor honors built-in partitioning.**
   Surface: `test/formatter-executor.test.ts`.
   Cover: when a step is built-in and reports unhandled files, those files flow to the next step's input; `treatAsSkip` does not record a failed run; non-skip non-zero exit *is* recorded.
   Commit: `test: thread built-in partitioning through executor`, then `feat: partition built-in batches by handled set`.

8. **`treefmt-nix` precedence inside a fallback group.**
   Surface: `test/formatter-executor.test.ts`.
   Cover: when both built-ins are PATH-available and resolve to configs at the same root, `treefmt-nix` wins regardless of declaration order.
   Commit: `test: cover treefmt-nix precedence in fallback`, then `feat: prefer treefmt-nix over treefmt at same root`.

9. **Wildcard-then-per-extension flow.**
   Surface: `test/prompt-autoformatter.test.ts`.
   Cover: wildcard chain runs first across the full batch; files marked handled by the wildcard are removed from per-extension groups; files marked unhandled flow to per-extension chains; double-formatting is avoided.
   Commit: `test: cover wildcard-then-per-extension dispatch`, then `feat: dispatch wildcard chain before per-extension chains`.

10. **Loader validation for built-in names.**
    Surface: `test/config-loader.test.ts`.
    Cover: built-in names are accepted in chains without a `formatters` declaration; declaring a `formatters` entry that shadows a built-in name surfaces a single config issue; unknown names continue to surface a config issue.
    Commit: `test: validate built-in formatter names in loader`, then `feat: accept built-in names in chains validation`.

11. **Docs alignment.**
    Surface: `docs/configuration.md`, `README.md`.
    Cover: `"*"` semantics, the canonical `fallback` example combining `treefmt` and `treefmt-nix`, discovery rules, precedence note, skip-pattern policy.
    Commit: `docs: document built-in treefmt and treefmt-nix support`.

## Risks and Mitigations

- **Risk:** Skip-pattern matching is brittle — `treefmt` output format may change.
  **Mitigation:** Patterns are centralized in one module with focused tests, easy to update.
  Anything we cannot confidently classify defaults to "real failure" (visible), not "silent skip".

- **Risk:** Wildcard chain accidentally double-formats files when a built-in handles them and a per-extension chain runs anyway.
  **Mitigation:** Wildcard-handled files are subtracted from the per-extension grouping.
  Tested explicitly.

- **Risk:** Discovery walks become a per-flush hot path on large repos with many touched files.
  **Mitigation:** Per-session cache keyed by directory; the walk for each flush is at most O(unique-dirs × depth).

- **Risk:** `treefmt-nix` precedence rule could surprise users who explicitly listed `treefmt` first.
  **Mitigation:** Precedence applies only when both resolve to the same root inside the same group; documented in `docs/configuration.md`.
  Otherwise user order wins.

- **Risk:** Users shadow a built-in by declaring `formatters: { treefmt: ... }`.
  **Mitigation:** Loader emits a config issue but accepts the user's definition (escape hatch for custom flags).
  The user's entry wins; the built-in is bypassed for that name.

- **Risk:** `nix fmt` is slow and can dominate flush time on first run.
  **Mitigation:** Out of scope for this issue; document the cost.
  Users can keep `treefmt` (non-nix) in the fallback group ahead of `treefmt-nix` when they don't need flake-pinned formatters.

## Open Questions

- Should the wildcard chain key be exactly `"*"`, or also `"**"`?
  Sticking with `"*"` for now; `"**"` can alias to it later if users find it natural.
- Should we expose the built-in registry for project extensibility (user-declared "built-in like" entries with discovery + skip patterns)?
  Defer until a second use case emerges.
- Should `treefmt --config-file` discovery prefer `.treefmt.toml` over `treefmt.toml` when both exist at the same root?
  Plan: prefer `treefmt.toml` (matches `treefmt`'s own precedence).
  Confirm during step 4.
