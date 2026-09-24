---
issue: 546
issue_title: "pi-session-tools: report models by messages handled, not raw model-change markers"
---

# Suppress phantom model-change markers in session reporting

## Release Recommendation

**Release:** ship independently

`pi-session-tools` has no `docs/architecture/` roadmap and this issue is not a member of any release batch, so it ships on its own.
The change is a self-contained correction to transcript and summary output.

## Problem Statement

`read_session` / `read_parent_session` should let a reader reliably answer which model handled which turn.
Today two signals describe model usage and the reporting leans on the wrong one.
The ground truth is each assistant message's own `provider`/`model`, which `formatAssistantMessage` already renders inline as `[provider/model]` — a model earns that label only if it produced a turn.
The competing signal is the `model_change` marker, which `formatMetadataEntry` renders unconditionally and `summarizeEntries` counts unconditionally.
Cycling the TUI model picker, or ending a session on a switch, emits a `model_change` with no assistant turn under it — a phantom switch that clutters the transcript and inflates the summary count.

The concrete consumer is the retro model-performance lens (`.pi/prompts/retro.md`), which reads the transcript to "attribute each turn to the model label it carries."
That lens works at per-turn granularity — the inline `[provider/model]` labels already give it — and needs no per-model aggregate.
Its only pain is the phantom `[model change]` lines, which is why the prompt carries a manual caveat warning the reader off trusting them.

## Goals

- Suppress a `[model change]` line in `formatTranscript` when no assistant turn follows the switch (before the next switch or end of entries), so every rendered marker reflects a switch that actually took effect.
- Count only effective switches in `SessionSummary.modelChanges`, so the collapsed TUI summary row stops over-counting phantom selections.
- Replace the manual phantom caveat in `.pi/prompts/retro.md` with a statement that phantom markers are now suppressed.
- Keep all other transcript and summary output unchanged.

This change is **not breaking**.
It refines existing human-readable output (drops phantom lines, corrects a count); no exported signature changes, no `details` field is removed (`SessionSummary.modelChanges` stays a `number`), and no config default changes.
The suggested commit type is `fix:`.

## Non-Goals

- No `summarizeModels` roll-up and no `Models:` header block.
  The issue proposed a per-model `{ turns, firstTurn, lastTurn }[]` aggregate, but the only consumer (the retro model-performance lens) attributes turns via the inline `[provider/model]` labels already present in the transcript — no current question consumes an aggregate.
  Building it would be a solution without a consumer; the operator confirmed dropping it.
- No change to the inline `[provider/model]` per-turn labels (they are the ground truth this plan relies on, left untouched).
- No change to `types`/`limit` filtering, the tool descriptions, or `set_session_name` / `get_session_name`.
- No new tool parameters.

## Background

Relevant modules (all in `packages/pi-session-tools/`):

- `src/format-transcript.ts` — `formatTranscript(entries)` renders the transcript.
  `formatMetadataEntry` renders a `model_change` entry as `[model change] → provider/modelId` unconditionally.
  The formatter already receives the full entry stream, so a phantom lookahead is local.
- `src/entry-summary.ts` — `summarizeEntries(entries)` walks entries once and returns `SessionSummary`; `modelChanges` currently increments on every `model_change` entry.
  It already imports `TranscriptEntry` from `format-transcript.ts`, so it is the single point of entry-shape reuse.
- `src/index.ts` — the four tool registrations; both read tools call `formatTranscript` for `content` and `summarizeEntries` for `details.summary`.
  No change needed here.

Entry shapes (from the existing tests and `formatMetadataEntry`):

- A `model_change` entry is `{ type: "model_change", provider, modelId }`.
- An assistant turn is `{ type: "message", message: { role: "assistant", provider, model, content } }`.

Key edge case — filtered streams.
A `types: ["model_change"]` query strips the surrounding messages, leaving only markers with no assistant turns between them.
The issue itself notes this "makes it worse."
The existing `read-parent-session.test.ts` filter test (`types: ["model_change"]`) expects the single marker to still render, so suppression must not blank a marker-only stream — see the guard in Design Overview.

AGENTS.md constraints that apply:

- pnpm only; no dependency changes here, so no lockfile churn.
- Conventional Commits; do not edit `CHANGELOG.md` (release-please owns it).
- Run `pnpm fallow dead-code` before pushing — the new exported helper has two in-package consumers, so it should not flag.

## Design Overview

### Effective-switch detection (new pure helper)

Add one exported helper to `format-transcript.ts`, shared by the formatter and the summary so both agree:

```typescript
/**
 * Return the entry indices of `model_change` markers that took effect — a
 * switch followed by at least one assistant turn before the next switch (or
 * the end of entries).
 *
 * A phantom switch (cycling the TUI picker, or ending a session on a switch)
 * never produces a turn and is excluded. Guard: when the stream contains no
 * assistant messages at all (e.g. a `types: ["model_change"]` filtered query),
 * every marker is treated as effective — there is no ground truth to validate
 * against, and suppressing all of them would hide the only signal the caller
 * asked for.
 */
export function collectEffectiveModelChangeIndices(
  entries: TranscriptEntry[],
): Set<number>;
```

Single forward pass, tracking the index of the currently pending switch:

- On a `model_change` at index `i`: set `pendingIndex = i` (a newer switch supersedes an earlier un-effected one — the earlier is phantom and simply dropped).
- On an assistant message: if a switch is pending, add `pendingIndex` to the effective set and clear it (the pending switch took effect).
- At end: a still-pending switch produced no turn — it stays out of the set (phantom).
- Guard: if the pass observed zero assistant messages, return the indices of **all** `model_change` entries instead.

Worked example (the issue's tail):

```text
index 0: model_change → deepseek-v4-flash   (pending = 0)
index 1: model_change → claude-fable-5       (0 dropped; pending = 1)
index 2: model_change → claude-opus-4-8       (1 dropped; pending = 2)
index 3: assistant [.../claude-opus-4-8]      (effective = {2}; pending cleared)
```

Only index 2 is effective — exactly the switch that ran the next turn.

### Consumer 1 — `formatTranscript`

Compute the effective set once, then gate `model_change` rendering by index (all other metadata entries render unchanged):

```typescript
const effectiveModelChanges = collectEffectiveModelChangeIndices(entries);
// ...
for (const [index, entry] of entries.entries()) {
  if (entry.type !== "message") {
    if (
      entry.type === "model_change" &&
      !effectiveModelChanges.has(index)
    ) {
      continue; // phantom switch — suppressed
    }
    const formatted = formatMetadataEntry(entry);
    if (formatted !== null) parts.push(formatted);
    continue;
  }
  // ... existing user / assistant / toolResult / bashExecution handling
}
```

The loop switches from `for (const entry of entries)` to `for (const [index, entry] of entries.entries())`; the turn-numbering logic is untouched.
`formatMetadataEntry` itself is unchanged — the suppression decision lives in the caller, which owns the entry-stream position.

### Consumer 2 — `summarizeEntries`

Replace the per-entry `modelChanges++` with the effective-set size, so the count matches the rendered markers:

```typescript
// drop the `if (entry.type === "model_change") { modelChanges++; continue; }` branch
// after the walk:
const modelChanges = collectEffectiveModelChangeIndices(entries).size;
```

`entry-summary.ts` imports `collectEffectiveModelChangeIndices` alongside the existing `TranscriptEntry` import.
The `SessionSummary` shape is unchanged — `modelChanges` is still a `number`, only its meaning tightens from "markers seen" to "switches that took effect."

Consistency note: under the guard, a `types: ["model_change"]`-only stream renders all markers in the transcript **and** counts them all in `modelChanges` (the effective set falls back to all indices), so the two stay aligned in that filtered edge case too.

### Interaction check (Law of Demeter / ISP)

`collectEffectiveModelChangeIndices` reads only `entry.type` and, for messages, `message.role` — the same narrow `TranscriptEntry` (`{ type: string }`) supertype the module already uses, cast to `Record<string, unknown>` internally like the sibling helpers.
It returns a value (a `Set<number>`), owns no state, and mutates no argument — no output-argument or reach-through smell.
Both consumers pass their own `entries` array and read back a set; neither reaches through the other.

## Module-Level Changes

- **CHANGED** `packages/pi-session-tools/src/format-transcript.ts`:
  - Add and export `collectEffectiveModelChangeIndices(entries)`.
  - In `formatTranscript`, compute the effective set and iterate with `entries.entries()`, skipping `model_change` entries whose index is not effective.
- **CHANGED** `packages/pi-session-tools/src/entry-summary.ts`:
  - Import `collectEffectiveModelChangeIndices` from `./format-transcript.js`.
  - Derive `modelChanges` from the effective-set size; remove the per-entry `model_change` counting branch.
- **CHANGED** `packages/pi-session-tools/test/format-transcript.test.ts` — add suppression cases (trailing phantom suppressed; consecutive switches keep only the effective one; marker-only stream renders all under the guard) and direct tests for `collectEffectiveModelChangeIndices`.
- **CHANGED** `packages/pi-session-tools/test/entry-summary.test.ts` — update the realistic-mixed-session expectation (trailing `model_change` → `modelChanges: 0`) and add effective-count cases; the `[mc, mc, mc]`-only case stays `3` via the guard.
- **CHANGED** `packages/pi-session-tools/test/read-session.test.ts` — the details fixture has a trailing `model_change`; add an assistant turn after it so the switch is effective and `modelChanges: 1` remains a meaningful assertion (or, equivalently, assert `0` for the trailing phantom).
- **CHANGED** `packages/pi-session-tools/README.md` — the `read_session` transcript example ends on a lone `[model change]` line (now a phantom that would be suppressed); revise the example so the switch is followed by an assistant turn, and add a one-line note that phantom switches (no following turn) are omitted.
- **CHANGED** `.pi/prompts/retro.md` — replace the model-performance-lens caveat ("A `model_change` with no assistant turn under it never ran — reading `model_change` alone over-counts transient selections") with a statement that phantom markers are now suppressed from the transcript, so every `[model change]` line reflects an effective switch.

`read-parent-session.test.ts` needs no change: its details fixture has no `model_change` (`modelChanges: 0` already), and its `types: ["model_change"]` filter test renders the single marker under the guard.
`src/index.ts` is unchanged — it already delegates to `formatTranscript` and `summarizeEntries`.
Grep confirms `modelChanges` / `model_change` appear only in these `src/` and `test/` files, the README, and `.pi/prompts/retro.md`; there is no `package-pi-session-tools` skill and no `docs/architecture/` for this package.

## Test Impact Analysis

1. **New tests the change enables.**
   `collectEffectiveModelChangeIndices` is a new pure function testable in isolation: trailing phantom, consecutive-switch supersession, interleaved switch+turn, and the zero-assistant guard.
   Previously the effective/phantom distinction was implicit in `formatTranscript`'s output only.
2. **Tests that become redundant.**
   None.
   The existing `formatTranscript` metadata tests (`formats a model_change entry`, `places metadata entries between conversation turns`) still pass unchanged — the former via the guard (lone marker, no assistant), the latter because its `model_change` is followed by an assistant turn.
3. **Tests that must stay as-is.**
   Every `content[0].text` assertion in `read-session` / `read-parent-session` (the transcript-content invariant) and the `read-parent-session` `types: ["model_change"]` filter test — they pin that a marker-only stream still renders and that non-phantom output is untouched.

## Invariants at risk

- **Transcript-content invariant (plan `0251-transcript-formatted-output.md`, refined by `0411-compact-session-output-rendering.md`).**
  `read_session` / `read_parent_session` return the full `formatTranscript(entries)` as `content`.
  This plan makes `model_change` rendering conditional; the invariant is preserved for every non-phantom entry and newly pinned by the suppression tests, while the existing `content[0].text` assertions stay green.
- **Summary-shape invariant (plan `0411`).**
  `SessionSummary` keeps all five numeric fields; only `modelChanges` semantics tighten.
  Pinned by the updated `entry-summary.test.ts` and the `read-session` details assertion.

## TDD Order

1. **`test` + `fix`: effective-switch detection and phantom suppression.**
   Red: add `collectEffectiveModelChangeIndices` cases and `formatTranscript` suppression cases to `test/format-transcript.test.ts` (trailing phantom suppressed; consecutive switches keep only the effective marker; marker-only stream renders all).
   Green: add and export `collectEffectiveModelChangeIndices` in `src/format-transcript.ts` and gate `model_change` rendering by effective index.
   The existing metadata tests must stay green.
   Commit: `fix(pi-session-tools): suppress phantom model-change lines in transcript (#546)`.
2. **`test` + `fix`: effective `modelChanges` count.**
   Red: update `test/entry-summary.test.ts` (realistic-mixed-session → `modelChanges: 0`; add effective-count cases; keep the guarded `[mc, mc, mc]` → `3`) and `test/read-session.test.ts` (add a post-switch assistant turn so the details assertion exercises the effective path).
   Green: derive `modelChanges` from `collectEffectiveModelChangeIndices(entries).size` in `summarizeEntries` and drop the per-entry counting branch.
   Run `pnpm run check` after this step (shared helper now consumed by two modules).
   Commit: `fix(pi-session-tools): count only effective model changes in summary (#546)`.
3. **`docs`: README note.**
   Revise the `read_session` transcript example so the switch is followed by an assistant turn and add the phantom-suppression note.
   Commit: `docs(pi-session-tools): note phantom model-change suppression (#546)`.
4. **`docs`: retro caveat.**
   Replace the model-performance-lens phantom caveat in `.pi/prompts/retro.md` with the suppression statement.
   This file is outside the package, so it does not affect the release; commit it separately.
   Commit: `docs: update retro model-performance lens for suppressed phantoms (#546)`.

## Risks and Mitigations

- **Filtered marker-only streams could blank out.**
  A `types: ["model_change"]` query has no assistant turns, so naive suppression would drop every marker.
  Mitigation: the zero-assistant guard renders all markers in that case; pinned by a new test and the existing `read-parent-session` filter test.
- **Transcript and summary drifting apart.**
  Two code paths interpret "effective."
  Mitigation: both call the single `collectEffectiveModelChangeIndices` helper; the guard keeps them aligned even in the filtered edge case.
- **Semantic change to `modelChanges` surprising a reader.**
  Mitigation: the field name and type are unchanged; the README and retro caveat document the new meaning, and the collapsed row simply stops over-counting.

## Open Questions

None.
