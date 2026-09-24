---
issue: 12
issue_title: "Remove unused `extensions` field from formatter definitions"
---

# Plan: Remove Unused `extensions` Field From Formatter Definitions (Issue #12)

## Problem Statement

`FormatterDefinition.extensions` is required by the type, populated in built-in defaults, validated by the config loader, declared in the JSON schema, and shown in docs — but no code in the dispatch path reads it.
Dispatch is purely chain-driven (`config.chains?.[extension]`).
The field is dead weight and a maintenance trap: users updating `chains` can leave per-formatter `extensions` metadata stale with no feedback.
Removing it sharpens the conceptual model: `formatters` answers **how** to invoke a tool, `chains` answers **when** and **in what order**.

This is a **breaking change** to the public config and TypeScript types.

## Goals

- Drop `extensions` from `FormatterDefinition` (TypeScript type, schema, defaults, docs, README).
- Have the config loader silently drop a stray `extensions` key on a user-provided formatter, with one non-fatal config-issue notice per occurrence so stale metadata is visible without breaking existing configs.
- Keep dispatch behavior unchanged — `chains` already drives everything.
- Keep schema, loader, defaults, and docs aligned (per AGENTS.md).

This is a **breaking change** for users who write code against the exported `FormatterDefinition` type.
Runtime config files that still carry `extensions` continue to load.

## Non-Goals

- Adding per-formatter `when` predicates (referenced in the issue as future work — leave attachment point clean, do not implement).
- Adding chain-level `fallback` steps (#13).
- Auto-rewriting users' on-disk config files.
- Changing dispatch, batching, or chain resolution.

## Background

Relevant modules:

- `src/formatter-registry.ts` — declares `FormatterDefinition` (with required `extensions`); `groupFilesByChain` and `resolveChain` never read `extensions`.
- `src/formatter-config.ts` — built-in defaults set `extensions` on `prettier` and `markdownlint-cli2`; the same extensions are also enumerated in `chains`, so `chains` is the single source of truth at runtime.
- `src/config-loader.ts` — `validateFormatterDefinition` requires both `command` and `extensions`, calls `validateExtensionArray`, and returns the validated `extensions` on the resolved definition.
- `schemas/pi-autoformat.schema.json` — `formatterDefinition.extensions` is declared (not in `required`, but documented).
- `docs/configuration.md` and `README.md` — example configs and the formatter-definition reference both list `extensions`.
- Tests across `test/config-loader.test.ts`, `test/formatter-registry.test.ts`, `test/formatter-config.test.ts` construct definitions with `extensions`.

## Design Overview

### Type shape

```typescript
// before
export type FormatterDefinition = {
  command: string[];
  extensions: string[];
  environment?: Record<string, string>;
  disabled?: boolean;
};

// after
export type FormatterDefinition = {
  command: string[];
  environment?: Record<string, string>;
  disabled?: boolean;
};
```

### Config-loader migration

`validateFormatterDefinition` currently treats `extensions` as a required, validated property and rejects unknown keys.
After the change:

- `extensions` is **not** in `FormatterDefinition` and is **not** required.
- If a user config still includes `extensions` on a formatter, the loader emits a single non-fatal config issue (`formatters.<name>.extensions` → "Deprecated.
  Remove this field; dispatch is driven by `chains`.
  The value is ignored.") and discards the value.
  This is consistent with the existing config-issue plumbing — surfacing the trap without breaking startup.
- Any other unknown formatter key continues to raise the existing "Unknown formatter property." issue.

### Schema

- Remove the `extensions` property from `$defs.formatterDefinition.properties`.
- Schema stays `additionalProperties: false`.
  Editor validators will flag stale `extensions` keys as unknown — that is the desired UX for editor users; the runtime loader still tolerates them with a deprecation notice for already-deployed configs.

### Defaults

`DEFAULT_FORMATTER_CONFIG.formatters.prettier` and `markdownlint-cli2` lose their `extensions` arrays.
The `chains` map is unchanged and remains the single source of truth.

### Docs

- `docs/configuration.md` and `README.md`: drop `extensions` from JSON examples and from the `FormatterDefinition` reference.
- Add a short note in `docs/configuration.md` explaining that legacy `extensions` keys are accepted but ignored, and recommending removal.

### Edge cases

- A formatter that currently has only `command` + `extensions` and no chain entry: previously already a no-op at dispatch (chain-driven); behavior unchanged.
- An empty user-supplied `extensions: []`: previously failed validation (`minItems: 1`).
  After: still surfaces the deprecation notice and is dropped — does not fail.

## Module-Level Changes

- `src/formatter-registry.ts`
  - Remove `extensions: string[]` from `FormatterDefinition`.
- `src/formatter-config.ts`
  - Remove `extensions` arrays from the two built-in formatter defaults.
- `src/config-loader.ts`
  - Remove `validateExtensionArray` (no other callers) **only if unused** after the change; otherwise leave in place.
  - In `validateFormatterDefinition`:
    - Drop `extensions` from the required-fields gate.
    - Replace the `key === "extensions"` branch with a single deprecation notice and skip storing the value.
    - Stop returning `extensions` on the resolved definition.
- `schemas/pi-autoformat.schema.json`
  - Remove the `extensions` property from `$defs.formatterDefinition.properties`.
- `docs/configuration.md`, `README.md`
  - Strip `extensions` from examples and field reference; add deprecation note.
- `test/config-loader.test.ts`, `test/formatter-registry.test.ts`, `test/formatter-config.test.ts`, and any other test that constructs a `FormatterDefinition`
  - Drop `extensions` from constructed definitions.
  - Add new coverage (see TDD Order).

## TDD Order

1. **red** — Add a `config-loader.test.ts` case: a user formatter with `extensions: [".ts"]` loads successfully, the resolved definition has no `extensions` key, and a single config issue is recorded for `formatters.<name>.extensions` describing the deprecation.
   commit: `test: cover deprecated extensions field on formatter`
2. **green** — Update `validateFormatterDefinition` to drop `extensions` from the required gate, emit the deprecation notice, and stop populating the field.
   Remove `validateExtensionArray` if it has no remaining callers. commit: `feat!: drop extensions field from formatter definitions`
3. **red→green** — Update `formatter-registry.ts` type, `formatter-config.ts` defaults, and any existing tests that constructed `extensions`.
   Tests should still pass (or be updated to no longer reference `extensions`).
   Add a `formatter-config.test.ts` assertion that `DEFAULT_FORMATTER_CONFIG.formatters.prettier` has no `extensions` key. commit: `feat!: remove extensions from FormatterDefinition type and defaults`
4. **red→green** — Update `schemas/pi-autoformat.schema.json` to remove the `extensions` property and add a schema-shape test (or extend an existing one) that verifies the schema no longer declares it.
   commit: `feat!: drop extensions from pi-autoformat JSON schema`
5. **docs** — Update `docs/configuration.md` and `README.md`: strip `extensions` from examples and reference; add a deprecation note pointing users at `chains`.
   commit: `docs: remove formatter extensions field and note deprecation`

Each cycle leaves the repo in a green state.

## Risks and Mitigations

- **Risk:** Existing user configs on disk still contain `extensions`.
  **Mitigation:** Loader accepts and ignores them with a single deprecation notice per formatter; no startup failure.
- **Risk:** Editor validation flags `extensions` as an unknown property under `additionalProperties: false`.
  **Mitigation:** This is the intended signal — the runtime tolerates it.
  Document the removal in `docs/configuration.md`.
- **Risk:** Downstream code imports `FormatterDefinition` and constructs values with `extensions`.
  **Mitigation:** Marked as breaking (`feat!:`).
  Release-please will bump major; CHANGELOG will call out the removal.
- **Risk:** Tests across multiple files reference `extensions`.
  **Mitigation:** TDD cycle 3 sweeps all tests in one commit; CI catches stragglers.

## Open Questions

- Should the deprecation notice be a one-time aggregate ("config still uses `extensions` on N formatters") instead of one-per-formatter?
  Defer until we see real configs in the wild; per-formatter is more actionable.
- Should we provide a one-shot codemod (`pi-autoformat migrate`) to strip `extensions` from on-disk configs?
  Defer; the deprecation notice is sufficient for now.
