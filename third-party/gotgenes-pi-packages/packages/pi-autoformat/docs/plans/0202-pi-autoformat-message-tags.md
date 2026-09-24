---
issue: 202
issue_title: "Use `pi-autoformat` tag in all user-visible messages"
---

# Consistent `pi-autoformat` message tags

## Problem Statement

Several user-visible strings in `extension.ts` use the shorter `autoformat` tag, while others already use the full `pi-autoformat` prefix (via `AUTOFORMAT_EXTENSION_ID`).
This creates an inconsistent user experience — the status bar says `autoformat:`, steering messages say `[autoformat]`, but `logToChat`/`reportMessage` output says `[pi-autoformat]`.

## Goals

- Update the four `autoformat`-tagged strings in `extension.ts` to use `pi-autoformat`.
- Reuse `AUTOFORMAT_EXTENSION_ID` where possible to avoid duplicating the string literal.
- Update corresponding test assertions.

## Non-Goals

- Renaming the `autoformat:touched` EventBus channel — this is an internal API, not user-visible.
- Renaming `customType: "autoformat-steering"` — this follows the same convention as `subagent-notification` in `pi-subagents` (no package prefix on custom types).
- Renaming the `Autoformatted` word in `buildLegacySuccessMessage` — this is a sentence-initial word, not a tag; the message is already wrapped by `reportMessage` which prefixes with `[pi-autoformat]`.

## Background

`AUTOFORMAT_EXTENSION_ID` is defined in `config-loader.ts` as `"pi-autoformat"` and already imported in `extension.ts`.
The `reportMessage` function already uses it for `[pi-autoformat]`-prefixed console output.

Four sites use the bare `autoformat` string instead:

1. `AUTOFORMAT_STATUS_KEY` (line 64) — the key passed to `ctx.ui.setStatus()`.
2. `formatStatusLine` label (line 442) — the themed `"autoformat:"` shown in the status bar.
3. `buildSteeringMessageContent` success prefix (line 508) — `"[autoformat] Formatted …"`.
4. `buildSteeringMessageContent` failure prefix (line 514) — `"[autoformat] Failures:"`.

## Design Overview

Replace the four bare `autoformat` occurrences with `AUTOFORMAT_EXTENSION_ID`:

1. `AUTOFORMAT_STATUS_KEY` → set to `AUTOFORMAT_EXTENSION_ID` directly.
2. `formatStatusLine` label → interpolate `AUTOFORMAT_EXTENSION_ID` with the colon suffix.
3. `buildSteeringMessageContent` prefixes → interpolate `AUTOFORMAT_EXTENSION_ID` in the bracket-tag pattern.

Using the constant rather than a new `"pi-autoformat"` literal keeps the value DRY — if the extension ID ever changes, all tags follow automatically.

## Module-Level Changes

### `src/extension.ts`

1. Change `AUTOFORMAT_STATUS_KEY` from `"autoformat"` to `AUTOFORMAT_EXTENSION_ID`.
2. Change `formatStatusLine` label from `"autoformat:"` to `` `${AUTOFORMAT_EXTENSION_ID}:` ``.
3. Change the success prefix in `buildSteeringMessageContent` from `"[autoformat]"` to `` `[${AUTOFORMAT_EXTENSION_ID}]` ``.
4. Change the failure prefix in `buildSteeringMessageContent` from `"[autoformat]"` to `` `[${AUTOFORMAT_EXTENSION_ID}]` ``.

### `test/extension.test.ts`

Update assertions that match the old `"autoformat"` status key or `"autoformat:"` / `"[autoformat]"` label:

- Lines 219–220: `setStatus` assertion → `"pi-autoformat"` and `"pi-autoformat:"`.
- Line 248: `setStatus` clear assertion → `"pi-autoformat"`.
- Lines 294–295: status key/text assertions → `"pi-autoformat"` and `"pi-autoformat:"`.
- Line 420: status key assertion → `"pi-autoformat"`.
- Line 860: `setStatus` clear assertion → `"pi-autoformat"`.
- Lines 1069, 1073: `setStatus` clear assertions → `"pi-autoformat"`.
- Line 1409: steering content assertion → `"[pi-autoformat]"`.
- Line 1629: steering content assertion → `"[pi-autoformat]"`.
- Line 1736: steering content assertion → `"[pi-autoformat]"`.

## TDD Order

1. **Red:** Update test assertions for `AUTOFORMAT_STATUS_KEY` and `formatStatusLine` to expect `"pi-autoformat"` and `"pi-autoformat:"`.
   Tests fail because the source still uses `"autoformat"`.
   Commit: `test: expect pi-autoformat in status key and status line (#202)`

2. **Green:** Update `AUTOFORMAT_STATUS_KEY` and `formatStatusLine` in `extension.ts` to use `AUTOFORMAT_EXTENSION_ID`.
   Tests pass.
   Commit: `fix: use pi-autoformat tag in status key and status line (#202)`

3. **Red:** Update test assertions for `buildSteeringMessageContent` to expect `"[pi-autoformat]"` prefixes.
   Tests fail because the source still uses `"[autoformat]"`.
   Commit: `test: expect pi-autoformat prefix in steering messages (#202)`

4. **Green:** Update `buildSteeringMessageContent` in `extension.ts` to use `AUTOFORMAT_EXTENSION_ID` in the bracket-tag pattern.
   Tests pass.
   Commit: `fix: use pi-autoformat tag in steering message prefixes (#202)`

## Risks and Mitigations

- **Downstream consumers matching on `[autoformat]`:** Any external code that pattern-matches on the old tag will break.
  Mitigation: This is an internal extension with no documented message contract; the change is low-risk.
- **Status key change breaking Pi UI:** The `setStatus` key is an opaque identifier.
  Changing it from `"autoformat"` to `"pi-autoformat"` could cause a stale status entry if Pi caches by key.
  Mitigation: The key is set and cleared within the same session lifecycle; no persistence is expected.

## Open Questions

None.
