---
issue: 1
issue_title: "Add richer TUI formatter summaries"
---

# Plan: Richer TUI Formatter Summaries (Issue #1)

## Problem Statement

Formatter activity is reported through transient `ctx.ui.notify` toasts.
Successes pop up and disappear; failures pop up and disappear.
The user has no ambient indicator that "formatters ran in the background", and a failure that the user would like to revisit later can be missed if a notification is dismissed.

The issue asks for richer, more scannable summaries — especially when several files or chains run in one flush — while keeping the surface low-key on the happy path and more prominent (but still non-urgent) on the failure path.

## Goals

- Use `ctx.ui.setStatus` to render a persistent, low-prominence summary in the footer/status bar after each prompt-end flush, so the user sees "this happened in the background" without a toast.
- On failure, keep `ctx.ui.notify(..., "warning")` so the failure catches the eye once, **and** leave an error-colored footer status so the user can come back to it later in the session.
- Make per-chain and per-file breakdowns more scannable when multiple files or chains run in a single flush.
- Preserve the existing non-interactive behavior (`console.log` / `console.warn`) unchanged.
- Preserve the existing `hideSummariesInTui` semantics: when `true`, success summaries are suppressed from the TUI; failures still surface.

This change is **not** breaking at the config layer — no new config keys, no schema change.
It does change the TUI surface used for success summaries (from notify to setStatus), which is a user-visible behavior change but not a config-breaking one.

## Non-Goals

- A `setWidget` block above the editor with a full per-file table.
  The user's framing — "enough feedback to say this happened in the background" — does not justify the screen real estate.
  We can revisit if feedback shows the footer is too thin.
- Adding a `summarySurface` config key (notify | widget | status | none).
  Premature; one good default beats a knob.
  Re-open if multiple users disagree with the chosen surface.
- Persisting summaries across sessions.
  Status is cleared on `session_shutdown` per Pi conventions.
- Restructuring `PromptAutoformatterResult` or the executor.
  This plan is purely a reporting-layer change inside `src/extension.ts`.
- Changing failure prominence beyond keeping today's `notify(warning)` plus the new persistent footer entry.
- Theme overrides or custom color names beyond the standard `success | warning | error | dim | accent` foreground colors already used by example extensions.

## Background

Relevant existing pieces:

- `src/extension.ts`
  - `defaultReportFlushResult(result, { config, ctx })` — currently the only sink for formatter summaries.
    Sends multi-line text to `ctx.ui.notify` (success or warning) on TUI, or `console.log` / `console.warn` otherwise.
  - `summarizeFailures`, `summarizeFallbackUsages`, `collectAllFiles`, `summarizeSuccessPaths`, `formatterLabel` — pure helpers that turn a `PromptAutoformatterResult` into lines.
    These are reusable as-is.
  - `reportMessage(ctx, message, type)` — routes to `notify` when `ctx.hasUI`, otherwise to `console.warn`/`console.log`.
- `src/formatter-config.ts` — `hideSummariesInTui: boolean` (default `false`).
  Currently consulted only for the success branch in `defaultReportFlushResult`.
- Pi extension API surface (from `pi-mono/packages/coding-agent/src/core/extensions/types.ts`):
  - `ctx.ui.notify(message, type?)` — transient toast.
  - `ctx.ui.setStatus(key, text | undefined)` — persistent footer/status text; pass `undefined` to clear.
  - `ctx.ui.theme.fg("success" | "warning" | "error" | "dim" | "accent", text)` — themed foreground color, used by the `status-line.ts` example extension.
  - `setWidget` and `custom` exist but are out of scope (see Non-Goals).
- Lifecycle: `session_start` → many `tool_call`/`tool_result` pairs → `agent_end` (the prompt-end flush we report on) → eventually `session_shutdown`.
  Multiple flushes happen per session in interactive use.

## Design Overview

### Reporting flow

1. Per flush, `defaultReportFlushResult` builds two views from the existing helpers:
   - **success view** — chain count, file count, fallback-usage suffix.
   - **failure view** — failed batch count and per-batch lines.
2. On TUI (`ctx.hasUI === true`):
   - If the result has zero groups, clear the status (`setStatus("autoformat", undefined)`) and return.
     A no-op flush should not leave a stale "Autoformatted 3 files" line in the footer.
   - If only successes:
     - When `hideSummariesInTui` is `true`, clear the status and return.
     - Otherwise call `setStatus("autoformat", themedSuccessLine)`.
       Do **not** call `notify`.
   - If any failures:
     - Call `setStatus("autoformat", themedFailureLine)` so the user can come back to it.
     - Call `notify(failureBlock, "warning")` once with the existing multi-line block (failed batch count + per-batch lines), so the failure catches the eye.
3. On non-TUI (`ctx.hasUI === false`):
   - Keep today's `console.log` / `console.warn` output verbatim.
   - Do not call `setStatus` (it's a no-op without a UI but adds noise to mocks).

### Status text format

Single line, themed, ASCII-only by default to stay readable in minimal terminals.
Dim parens carry low-priority detail.

```text
✓ autoformat: 3 files (biome, prettier)
✓ autoformat: 1 file (biome)
✗ autoformat: 1 batch failed (biome) — 2 ok
```

- `✓` rendered via `theme.fg("success", "✓")`; the "autoformat:" label via `theme.fg("dim", ...)`.
- `✗` rendered via `theme.fg("error", "✗")`; the failure clause via `theme.fg("error", ...)`.
- Formatter names in the success line are deduplicated and ordered by first appearance across `result.groups[].runs[].formatterName`.
- Fallback usages append `(fallback after X)` only when present, reusing `formatterLabel`.
- The line is intentionally short (~one terminal row).
  Per-file breakdown stays in the failure notify block, which already lists files per failed batch.

### Lifecycle hooks

- `session_start`: clear `setStatus("autoformat", undefined)` so a fresh session does not inherit a stale status from a previous run rendered in the same UI.
- `session_shutdown`: clear status before tearing the session down, alongside the existing `unsubscribeEventBus`.

These are small additions to existing handlers in `createAutoformatExtension`.

### Status key

Use `"autoformat"` as the `setStatus` key.
Single key per extension, reused across flushes (each call replaces the previous value).
Documented in `docs/configuration.md` as informational so users writing custom themes know it exists.

### Types

No public type changes.
Internally, introduce a small helper so the TUI/non-TUI branches share one source of truth:

```typescript
type FlushSummary = {
  groupCount: number;
  fileCount: number;
  formatterNames: string[];
  failureBatchCount: number;
  failureLines: string[];
  fallbackUsages: string[];
};

function summarizeFlush(result: PromptAutoformatterResult): FlushSummary;
```

`defaultReportFlushResult` becomes a thin dispatcher that builds a `FlushSummary` once, then renders for TUI vs non-TUI.

### Edge cases

- **Empty flush** (`result.groups.length === 0`): clear status; emit nothing on non-TUI (today's behavior).
- **All-fallback-skipped chains** are already filtered upstream (`flushPrompt` drops empty groups), so they cannot produce a phantom status line.
- **Mixed success and failure**: the status reflects failure (error-colored), success counts shown after an em dash; notify fires for failures only.
- **Theme without color** / non-color terminals: `theme.fg` is theme-aware and the example extensions rely on it; we trust it to degrade.
- **No `theme` available**: defensively, fall back to plain text if `ctx.ui.theme` is undefined (matches our existing duck-typed `ExtensionContextLike`).
- **Repeated flushes**: each call to `setStatus("autoformat", ...)` replaces the previous value, so the footer always reflects the latest flush.

## Module-Level Changes

- `src/extension.ts`
  - Extend `ExtensionContextLike.ui` to include optional `setStatus(key: string, text: string | undefined): void` and an optional `theme` shape with `fg(name: string, text: string): string`.
    Both optional so existing tests using minimal stub UIs do not need to change unless they assert on status behavior.
  - Add `summarizeFlush(result)` helper consolidating today's per-piece helpers.
  - Add `formatStatusLine(summary, { theme })` helper returning a single string.
  - Rewrite `defaultReportFlushResult` to:
    1. Compute `FlushSummary`.
    2. Branch on `ctx.hasUI`.
    3. On TUI: empty → clear; success → `setStatus`; failure → `setStatus` + `notify`.
    4. On non-TUI: existing `console.log` / `console.warn` paths, unchanged.
  - In `createAutoformatExtension`:
    - On `session_start`, after `reportConfigIssues`, call `clearAutoformatStatus(ctx)`.
    - On `session_shutdown`, before `state = undefined`, call `clearAutoformatStatus(ctx)`.
    - `clearAutoformatStatus` is a 3-line helper guarded by `ctx.hasUI` and `ctx.ui.setStatus`.
- `test/extension.test.ts`
  - New tests for the rewritten `defaultReportFlushResult` (see TDD Order).
  - Existing notify-based assertions for success summaries change to assert on `setStatus`; failure-path assertions still expect `notify(warning)` and additionally assert `setStatus` with error styling.
- `docs/configuration.md`
  - Update the `hideSummariesInTui` section to reflect the new surface ("suppresses the persistent footer status on success; failures still surface via notification + status").
- `README.md`
  - One-paragraph update to the formatter-feedback section: footer status on success, notification + status on failure.
- No changes to:
  - `src/config-loader.ts`, `src/formatter-config.ts`, `schemas/pi-autoformat.schema.json` — no config additions.
  - `src/prompt-autoformatter.ts`, `src/formatter-executor.ts` — reporting-layer-only change.

## TDD Order

1. **test: cover empty-flush status clearing**
   - In `test/extension.test.ts`, add a test that calls `defaultReportFlushResult` with `{ groups: [] }` on a TUI ctx and asserts `setStatus("autoformat", undefined)` is called and `notify` is not.
   - Commit: `test: cover empty-flush autoformat status clearing`.
2. **feat: route success summaries through setStatus**
   - Implement `summarizeFlush`, `formatStatusLine`, and the success branch of the new `defaultReportFlushResult` (TUI path) so the empty-flush test plus a new "single chain, multi-file success" test pass.
   - Assert `setStatus` is called with a string containing "autoformat" and the file count; assert `notify` is **not** called.
   - Commit: `feat: render formatter success summaries in the footer status`.
3. **feat: surface failures via setStatus and notify together**
   - Add a "one failed batch + one successful batch" test asserting both `setStatus` (error styling) and `notify(..., "warning")` are called, and the notify body still contains the per-batch failure lines.
   - Commit: `feat: keep failure notifications and add persistent failure status`.
4. **feat: honor hideSummariesInTui for the new status surface**
   - Add tests covering `hideSummariesInTui: true` for success-only (clears status, no notify) and for failure (status + notify still fire).
   - Commit: `feat: respect hideSummariesInTui for footer status`.
5. **feat: clear autoformat status on session_start and session_shutdown**
   - Add lifecycle tests that drive the extension through `session_start` and `session_shutdown` and assert `setStatus("autoformat", undefined)` is invoked at each.
   - Commit: `feat: clear autoformat status on session lifecycle boundaries`.
6. **test: preserve non-interactive console output**
   - Add or update tests that assert non-TUI flushes still go through `console.log` / `console.warn` and never call `setStatus`.
   - Commit: `test: lock in non-interactive autoformat reporting behavior`.
7. **docs: align configuration and README with the new surface**
   - Update `docs/configuration.md` (`hideSummariesInTui` section) and `README.md`.
   - Commit: `docs: describe footer-status formatter summaries`.

## Risks and Mitigations

- **Risk: status surface surprises users who relied on success toasts.**
  Mitigation: failures still toast; success toasts were already opt-out via `hideSummariesInTui`, and the issue explicitly flags small-success notifications as noise.
  Document the change in `docs/configuration.md` and `README.md` in step 7.
- **Risk: stale status from a previous flush on session reuse.**
  Mitigation: clear on `session_start` and `session_shutdown`; each new flush overwrites the same `"autoformat"` key.
- **Risk: `setStatus` not present on older Pi runtimes.**
  Mitigation: feature-detect (`typeof ctx.ui.setStatus === "function"`) before calling; fall back to today's `notify(info)` if unavailable.
  This is a small `if` branch, not a new mechanism.
- **Risk: theme color not available.**
  Mitigation: feature-detect `ctx.ui.theme?.fg`; fall back to plain `"✓ autoformat: …"` text.
- **Risk: footer line clashes with other extensions writing to the footer.**
  Mitigation: use a distinct key (`"autoformat"`); Pi's `setStatus` is keyed precisely so multiple extensions can coexist.
- **Risk: confusing behavior when `hideSummariesInTui` was understood as "no toasts".**
  Mitigation: docs update clarifies it now means "no success summary in TUI, regardless of surface".

## Open Questions

- Should we add an opt-in `setWidget` block (above editor) for users who want the per-file breakdown ambient instead of buried in a notify body?
  Defer until someone asks for it.
- Should `hideSummariesInTui` be renamed to `quietSuccess` or similar now that the surface changed?
  Defer; keep the name and update its doc.
- Should non-interactive mode also become quieter (e.g. drop success lines)?
  Out of scope; the issue is specifically about the TUI.
