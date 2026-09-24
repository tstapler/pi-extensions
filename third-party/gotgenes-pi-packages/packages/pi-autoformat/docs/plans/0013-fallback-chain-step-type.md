---
issue: 13
issue_title: "Add `fallback` step type to formatter chains"
---

# Plan: Add `fallback` Step Type to Formatter Chains (Issue #13)

## Problem Statement

Today, `chains` entries are flat lists of formatter names — every named formatter runs in order and is expected to apply.
That works when each step does a distinct job (Prettier formats, then markdownlint-cli2 lints), but it does not handle the common case where a project standardizes on **one of several alternatives** (e.g. Biome *or* Prettier).
Users either list both (the second undoes the first or fails noisily) or pick one globally (wrong half the time).
A `fallback` step type lets a single global default chain adapt to whichever tool a given repo actually uses, with no per-project boilerplate.

## Goals

- Extend chain step shape: each step is either a string (single formatter, current behavior) or `{ "fallback": [name, ...] }`.
- Implement `PATH`-only fallthrough semantics: skip when the command is not on `PATH`; stop on first formatter that runs (success **or** non-zero exit); group is a no-op if no formatter is on `PATH`.
- Cache `PATH` probes per flush so a chain step does not re-probe the same command repeatedly.
- Surface which fallback alternative actually ran when it was not the first listed (e.g. `prettier (fallback after biome unavailable)`).
- Update schema, config loader, docs, and README in the same change (per AGENTS.md).
- Stay **fully backward compatible** with existing string-only chains.

This is a **non-breaking** change.
Existing configs and types continue to work unchanged.

## Non-Goals

- A per-formatter `when: { configExists: [...] }` predicate — explicitly deferred per the issue.
- Auto-detecting which formatter a repo "really" uses based on its config files.
- Parallel probing of fallback alternatives — sequential is fine; the list is short and the probe is cached.
- Cross-flush caching of `PATH` probes (a flush is short-lived; per-flush is enough).
- Reworking `groupFilesByChain`'s grouping key beyond what the new shape requires.

## Background

Relevant modules:

- `src/formatter-registry.ts` — declares `FormatterConfig` with `chains?: Record<string, string[]>` and exposes:
  - `groupFilesByChain(files, config)` — keys files by chain identity (joined with `\u0000`).
  - `resolveChain(chainNames, config)` — turns formatter names into `ResolvedFormatter[]`, dropping disabled / missing entries.
- `src/formatter-executor.ts` — `executeChainGroup` runs a resolved chain once per group, appending the group's files as trailing args.
  Returns one `BatchRun` per chain step.
- `src/prompt-autoformatter.ts` — orchestrates flush: queue → `groupFilesByChain` → `resolveChain` → `executeChainGroup`.
- `src/config-loader.ts` — `validateChains` uses `validateStringArray`, so today every step must be a string.
- `src/formatter-config.ts` — built-in defaults populate `chains` with string arrays only.
- `schemas/pi-autoformat.schema.json` — `chains` items are `{ "type": "string" }`.
- `src/extension.ts` — `summarizeFailures` reads `run.formatterName` / `run.files` from `BatchRun`s.

The architecture is already chain-oriented and batch-based; the work is to extend the chain *step* type and have the executor decide, per fallback group, which single formatter actually runs.

## Design Overview

### Data shapes

A chain becomes a list of *steps*.
A step is either a formatter name (string) or a fallback group.

```typescript
export type FallbackChainStep = {
  fallback: string[];
};

export type ChainStep = string | FallbackChainStep;

export type FormatterConfig = {
  formatters: Record<string, FormatterDefinition>;
  chains?: Record<string, ChainStep[]>;
};
```

Internally, after validation, we normalize every step to a discriminated form so downstream code does not branch on `typeof`:

```typescript
type NormalizedChainStep =
  | { kind: "single"; formatter: string }
  | { kind: "fallback"; formatters: string[] };
```

The string form is sugar for `{ kind: "single", formatter: name }`.
A `{ fallback: [a] }` group with one entry is *not* rewritten into a single step — it stays a fallback group of one so reporting (and `PATH` probing) is consistent.

### Grouping key

`groupFilesByChain` currently keys on the chain-name list joined by `\u0000`.
The key must remain stable and JSON-comparable for normalized steps.
Use a canonical encoding:

- single step → `"S:<name>"`
- fallback group → `"F:<a>|<b>|<c>"`

Then join steps with `\u0000`.
This keeps grouping behavior identical for string-only chains (different prefix is fine — the encoding is internal) and gives fallback groups a unique, comparable identity.

### Resolution and execution

`resolveChain(steps, config)` returns a list of *resolved steps*, where each step carries either one resolved formatter or an ordered list of resolved-formatter alternatives:

```typescript
type ResolvedSingleStep = {
  kind: "single";
  formatter: ResolvedFormatter;
};

type ResolvedFallbackStep = {
  kind: "fallback";
  alternatives: ResolvedFormatter[]; // disabled/unknown formatters dropped
};

type ResolvedChainStep = ResolvedSingleStep | ResolvedFallbackStep;
```

A fallback step whose alternatives all reduce to disabled / unknown is dropped (same posture as a single step that names a missing formatter).

`executeChainGroup` then, for each resolved step:

- **single**: behaves exactly as today.
- **fallback**: probes each alternative's `command[0]` against `PATH`, **in order**, using a cached probe.
  The first alternative that is on `PATH` runs.
  If it exits 0 → success, stop.
  If it exits non-zero → failure, stop, report (do **not** mask by trying the next alternative).
  If none of the alternatives are on `PATH` → no `BatchRun` is emitted (group is a no-op as specified).

### `PATH` probing

Implemented as a small helper that:

- accepts an absolute path verbatim (returns true if the file exists and is executable).
- otherwise walks `process.env.PATH`, checking each segment for an executable matching the command name (Windows handling is out of scope; this extension already assumes POSIX-style invocation).
- caches results in a `Map<string, boolean>` injected per flush so a chain with the same fallback group across many file groups probes once.

The probe is dependency-injectable so tests can stub it without touching the filesystem.

### Reporting

`BatchRun` gains an optional `fallbackContext` field used purely for human-readable reporting:

```typescript
export type BatchRun = {
  formatterName: string;
  command: string[];
  files: string[];
  success: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  fallbackContext?: {
    skipped: string[]; // formatter names skipped because not on PATH
  };
};
```

`extension.ts` `summarizeFailures` and the success summary path render this as `"<name> (fallback after <skipped...> unavailable)"` when `skipped` is non-empty.
When the fallback group's first alternative wins, `fallbackContext` is omitted (quiet, same as a single-formatter step).

A fallback group that ends in "all alternatives missing" emits **no** `BatchRun` — there is nothing to report at the chain-step level — but logs a single config-issue-style notice through the existing reporter so the user is not silently formatted-nothing.
This is delivered via the standard reporter, not a new channel.

### Config validation

`validateChains` becomes:

- accept either a string or a `{ fallback: string[] }` object per array entry.
- reject any other shape with a clear path-aware message.
- require `fallback` to be a non-empty array of non-empty strings.
- reject unknown sibling keys on a fallback object (`additionalProperties: false`).
- emit a non-fatal config-issue (and skip the offending step) when a fallback alternative names a formatter that is not present in `config.formatters` and is not a known built-in default.
  This catches typos cheaply.
- the same name-existence check is applied to single string steps for consistency (it is currently silently dropped at resolve time).

### Edge cases

- Empty `fallback: []` → validation error.
- Fallback containing one entry → legal, treated as a fallback-of-one (still PATH-probed; a missing tool quietly no-ops instead of trying to run and failing).
- A fallback alternative is `disabled: true` → treat as if absent (skip without probing).
- A fallback step where every alternative is disabled or unknown → resolved-step is dropped; behaves like a no-op step.
- Mixing fallback and single steps in one chain (e.g. `[{fallback: [...]}, "markdownlint-cli2"]`) → fully supported; second step always runs.
- Same fallback group declared on multiple extensions → grouping key is identical, so files share the group and the `PATH` probe runs once.

## Module-Level Changes

- `src/formatter-registry.ts`
  - Export `ChainStep`, `FallbackChainStep`, `NormalizedChainStep`, `ResolvedChainStep`, `ResolvedSingleStep`, `ResolvedFallbackStep`.
  - Update `FormatterConfig.chains` to `Record<string, ChainStep[]>`.
  - Add a `normalizeChainStep` helper used by both grouping and resolution.
  - Update `groupFilesByChain` to use the new canonical encoding for the grouping key.
  - Update `resolveChain` to return `ResolvedChainStep[]` and to drop fallback steps with no usable alternatives.
- `src/formatter-executor.ts`
  - Add `CommandProbe` type (`(command: string) => boolean | Promise<boolean>`) and a default `PATH`-walking implementation.
  - Add a per-flush cache wrapper.
  - Update `ChainGroupInput.chain` to `ResolvedChainStep[]`.
  - Update `executeChainGroup` to dispatch by step kind, applying fallback semantics for fallback steps.
  - Add `fallbackContext` to `BatchRun` (optional).
- `src/prompt-autoformatter.ts`
  - Construct one shared probe cache per `flushPrompt` call and pass it into `executeChainGroup`.
  - No external API change.
- `src/config-loader.ts`
  - Replace the current `validateStringArray`-based chain validator with a per-step validator that accepts string or `{ fallback: string[] }`.
  - Add formatter-name existence checks (non-fatal, single config-issue per offense).
- `src/formatter-config.ts`
  - Defaults stay string-only (no behavior change).
- `schemas/pi-autoformat.schema.json`
  - `chains.additionalProperties.items` becomes a `oneOf` of `string` and `{ fallback: string[] }`.
  - Document fallback semantics inline.
- `src/extension.ts`
  - Render `fallbackContext.skipped` in success and failure summaries.
  - Surface "all fallback alternatives missing" as a one-line notice.
- `README.md`
  - Add the **Choosing a chain strategy** section with the project-vs-global recommendation.
  - Add the **Fallback caveat** block next to the new feature description.
  - Update the chains example to show a fallback group.
- `docs/configuration.md`
  - Extend the `chains` section with the new step shape, semantics table, and fallback caveat.

## TDD Order

1. **Schema test for chain step shape.**
   Extend `test/schema.test.ts` with valid string-and-fallback fixtures and invalid `{}` / `{ fallback: [] }` / extra-key fixtures.
   Update `schemas/pi-autoformat.schema.json` to make them pass.
   Commit: `test: cover fallback chain step shape in schema`, then `feat: allow fallback chain steps in schema`.
2. **Config-loader: accept fallback steps.**
   In `test/config-loader.test.ts`, cover string steps still loading, fallback objects loading, malformed fallback rejected, unknown sibling keys rejected, empty fallback rejected.
   Implement in `src/config-loader.ts`.
   Commit: `test: cover fallback step validation`, then `feat: validate fallback chain steps in config loader`.
3. **Config-loader: formatter-name existence check.**
   Tests for fallback referencing an unknown formatter (non-fatal config-issue, step dropped) and same for a single string step.
   Implement.
   Commit: `test: warn on chain steps referencing unknown formatters`, then `feat: surface unknown formatter names in chains as config issues`.
4. **Registry: chain step types and grouping key.**
   In `test/formatter-registry.test.ts`, cover normalized step shapes, grouping key stability for string-only chains, distinct grouping for differing fallback orderings, identical grouping for identical fallback orderings.
   Implement type changes plus key encoding.
   Commit: `test: extend chain grouping for fallback steps`, then `feat: support fallback steps in chain grouping`.
5. **Registry: resolve chain returns resolved steps.**
   Tests for resolving a single-only chain, a fallback with mixed disabled/unknown alternatives, dropping a fallback whose alternatives all reduce away.
   Implement.
   Commit: `test: resolve fallback steps to alternatives`, then `feat: resolve fallback chain steps`.
6. **Executor: PATH probing helper.**
   New tests for a probe helper covering absolute-path executables, `PATH`-walked executables, missing commands, and cache reuse.
   Implement and inject.
   Commit: `test: cover PATH-probe helper`, then `feat: add PATH probe with per-flush cache`.
7. **Executor: fallback dispatch semantics.**
   Tests for: first alternative present (runs, no `fallbackContext`), first missing / second present (runs, `fallbackContext.skipped` populated), first present and exits non-zero (failure surfaced, second NOT tried), all missing (no `BatchRun` emitted), single steps unchanged.
   Implement in `executeChainGroup`.
   Commit: `test: cover fallback dispatch semantics`, then `feat: dispatch fallback chain steps`.
8. **Prompt autoformatter: shared probe cache.**
   Test that two file groups whose chains share a fallback group probe each command at most once per flush.
   Wire the cache through `flushPrompt`.
   Commit: `test: share PATH probe cache across chain groups in a flush`, then `feat: share PATH probe cache across flush`.
9. **Reporting: surface fallback context.**
   Tests in `test/extension.test.ts` (or wherever `summarizeFailures` is exercised) covering success render with `fallbackContext`, failure render with `fallbackContext`, and the "all fallback alternatives missing" notice.
   Implement in `src/extension.ts`.
   Commit: `test: render fallback context in summaries`, then `feat: surface fallback context in flush reporting`.
10. **Acceptance + smoke.**
    End-to-end test in `test/acceptance.test.ts`: a `.ts` chain `[{ fallback: ["biome", "prettier"] }]` with biome absent and prettier present produces a single prettier batch run with `fallbackContext.skipped = ["biome"]`.
    Commit: `test: end-to-end fallback chain run`.
11. **Docs.**
    Update `README.md` (Choosing-a-chain-strategy section + Fallback caveat + example) and `docs/configuration.md` (chain shape + semantics table).
    Commit: `docs: document fallback chain steps and project-config recommendation`.

## Risks and Mitigations

- **Risk: silent fallback hides missing project config.**
  A globally installed Biome will format with built-in defaults in a Prettier repo.
  *Mitigation:* required README **Fallback caveat** block plus the **Choosing a chain strategy** recommendation; the docs explicitly point users at project-level chains.
  No runtime mechanism added (per AGENTS.md: "Mechanism is forever; docs are reversible.").
- **Risk: PATH probing is platform-fragile.**
  *Mitigation:* dependency-inject the probe so tests stub it; default implementation walks `process.env.PATH` and `fs.access(X_OK)`-style checks.
  Match the existing extension's POSIX assumption.
- **Risk: probe overhead on every flush.**
  *Mitigation:* per-flush cache; only probe a command once even across many fallback groups.
- **Risk: grouping-key collision between old encoding and new.**
  *Mitigation:* the encoding is internal — keys are computed fresh from the in-memory config every flush, never persisted.
  No migration needed.
- **Risk: users typo a formatter name in a fallback group.**
  *Mitigation:* config loader emits a non-fatal config-issue per occurrence and drops the offending entry.
- **Risk: scope creep into a `when` predicate.**
  *Mitigation:* explicitly out of scope per the issue and re-asserted in Non-Goals.

## Open Questions

- Should the "all fallback alternatives missing" notice be one-shot per flush, or one per group?
  Tentatively: one per group, but quiet — defer until we see real noise.
- Should the success summary always mention the fallback alternative that ran, or only when it was not the first listed?
  Tentatively: only when it was not the first, matching the issue's reporting guidance.
