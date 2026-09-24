---
issue: 630
issue_title: "pi-permission-model-judge can't review typo paths inside bash commands (pathOf ignores accessIntent)"
---

# Review typo paths embedded in bash commands

## Release Recommendation

**Release:** ship independently

This package has no architecture roadmap and no release-batch membership.
The change is a standalone bug fix that completes the #625 → #626 → #628 → #630 dogfooding sequence (auth → observability → reply-format → bash-surfaced paths); ship it on its own.

## Problem Statement

The deny-first typo reviewer never reaches the model for a typo path that appears inside a `bash` command — it defers at the "no path" short-circuit before pattern-matching.
`createTypoReviewer` (`src/typo-reviewer.ts`) resolves the candidate path with `pathOf(details) = details.path ?? details.value`.
For a file tool (`read`/`edit`/`write`), the raising gate populates `details.path`, so the reviewer works.
But a `bash` external-directory ask carries `details.path: undefined` — the external path lives in `details.accessIntent.matchValues` (the raising gate sets `command` and `accessIntent`, never `path`; `bash-external-directory.ts`).
So `pathOf` returns `undefined`, the reviewer logs `no-path` and defers, and a doubled-package typo path inside `cat …/pi-permission-system/packages/pi-permission-system/README.md` reaches the human unreviewed — confirmed during #625's dogfood.

The fix widens candidate extraction to also consult `details.accessIntent.matchValues`, so a `bash`-surfaced typo path is pattern-matched and, on a match, sent to the model exactly like a file-tool path.

## Goals

- A typo path that appears in a `bash` command's referenced external paths is reviewed by the judge the same way a file-tool path is: matched against `typoPatterns` and, on a match, sent to the model.
- Preserve the single-path decision trail from #626 — the `model_judge.decision` record still carries exactly one `path` value (the alias that matched the pattern).
- Keep every existing behavior green: file-tool asks (`details.path` set) and forwarded asks (`details.value` set) match as before; every uncertain outcome still defers (more prompting, never less — ADR 0007 invariant 2); the slice still emits no `allow`.

This is **not** a breaking change.
The judge is opt-in (it reviews nothing until `typoPatterns` is configured and `model-judge` is named in pi-permission-system's `authorizerChain`), and pi-permission-system caps the link to `deny`/`defer` on `external_directory`.
Widening which asks reach the model only extends the intended bug-fix behavior to a surface it already should have covered; it changes no default, config shape, or public API.
Commit the behavioral change as `fix(pi-permission-model-judge):`.

## Non-Goals

- No change to the raising gates in `@gotgenes/pi-permission-system` — the fix is entirely inside this package's reviewer.
  The gate's worst-path selection is relied upon, not modified (see Background).
- No multi-path review loop.
  The `bash-external-directory` gate already reduces a multi-path command to the single **worst** uncovered path before it escalates (see Background), so the reviewer never sees more than one path's alias set — the issue's "review the worst/boundary path, or review each" question is resolved upstream, not here.
- No change to the `bash-path` surface (`surface: "path"`) — the reviewer only reviews `external_directory`, and that is unchanged.
- No change to the `model_judge.decision` / `model_judge.short_circuit` event field shapes, the config schema, `typoPatterns` compilation, or the #625 auth path.

## Background

Relevant modules:

- `src/typo-reviewer.ts` — the chain link.
  Its `pathOf(details)` (`details.path ?? details.value ?? undefined`) is the sole place the candidate path is derived, at line ~94.
  The decision flow: surface must be `external_directory` → candidate path present → path matches a `typoPattern` → model confirms.
- `src/typo-patterns.ts` — `matchTypoPattern(path, compiled)` returns the source string of the first pattern matching a single `path`, or `undefined`.
  Unchanged: the fix calls it once per candidate.
- `PromptPermissionDetails` (from `@gotgenes/pi-permission-system`, `src/authority/permission-prompter.ts`) — the details bag.
  `path?: string`, `value?: string | null`, and `accessIntent?: ForwardedAccessFacts`.
- `ForwardedAccessFacts` (`pi-permission-system` `src/authority/permission-forwarding.ts`) — `{ surface: string; matchValues: string[]; boundaryValue: string | null }`.
  For a path surface, `matchValues` is `AccessPath.matchValues()` (absolute ∪ cwd-relative ∪ canonical) — the alias set of **one** path.

**Why the reviewer sees only one path (the "which candidate" question, resolved).**
`describeBashExternalDirectoryGate` (`pi-permission-system` `src/handlers/gates/bash-external-directory.ts`) enumerates every external path in the command, drops the ones already allowed, selects the single **worst uncovered** entry (`worstEntry`), and sets `accessIntent: accessFactsFromPath("external_directory", worstEntry.path)`.
So a command referencing several external paths still escalates as **one** ask whose `accessIntent.matchValues` are the aliases of that single worst path.
The reviewer therefore does not need to iterate multiple distinct paths — it needs to read the alias set of the one path the gate already chose.
This is the key trace that dissolves the issue Notes' open decision.

Constraint from AGENTS.md (`package-pi-permission-system` skill): an `AccessPath` never crosses onto the wire — `accessIntent` carries strings only (ADR-0002).
The reviewer consumes those strings directly; it must not reconstruct an `AccessPath`.

## Design Overview

Replace the single-value `pathOf` with a candidate-list extractor and match the typo pattern against each candidate, recording the first alias that matches.

### Candidate extraction

```ts
/** Candidate paths to test against the typo patterns, most authoritative first. */
function candidatePathsOf(details: PromptPermissionDetails): string[] {
  const seen = new Set<string>();
  // accessIntent.matchValues is the gate's authoritative path alias set —
  // present for both file-tool and bash external_directory asks (#597).
  for (const value of details.accessIntent?.matchValues ?? []) seen.add(value);
  // Fallbacks for a details bag without accessIntent (older forwarded request
  // or a hand-built local ask): the raw file-tool path, then the display value.
  if (details.path !== undefined) seen.add(details.path);
  if (details.value != null) seen.add(details.value);
  return [...seen];
}
```

Ordering rationale: `matchValues` first because it is the gate-authoritative path set for both surfaces.
`details.value` is last because a forwarded **bash** ask's display `value` is the *command string*, not a path — trying it before the real path aliases would risk recording a command where a path belongs.
The `Set` dedupes the common case where a file-tool ask carries both `path` and an `accessIntent` whose `matchValues` include that same path.

### Match loop

```ts
const candidates = candidatePathsOf(details);
if (candidates.length === 0) {
  log.debug(SHORT_CIRCUIT_EVENT, { requestId, reason: "no-path" });
  return { kind: "defer" };
}
const compiled = compiledFor(config, log);
let matched: { path: string; matchedPattern: string } | undefined;
for (const candidate of candidates) {
  const pattern = matchTypoPattern(candidate, compiled);
  if (pattern !== undefined) {
    matched = { path: candidate, matchedPattern: pattern };
    break;
  }
}
if (matched === undefined) {
  log.debug(SHORT_CIRCUIT_EVENT, {
    requestId,
    path: candidates[0],
    reason: "pattern-miss",
  });
  return { kind: "defer" };
}
const { path, matchedPattern } = matched;
// …unchanged from here: build DecisionBase, resolve model, reviewPath, record…
```

The first-match-wins loop records the **specific alias** that matched the pattern as the single `path` in the `model_judge.decision` record and hands that same string to `reviewPath` — so the model reviews, and the trail records, the exact form that tripped the typo pattern.
The single-path trail contract from #626 is preserved (one `path`, one `matchedPattern`).

### Edge cases

- **No candidates** (`path`, `value`, and `accessIntent.matchValues` all absent/empty) → `no-path` short-circuit, unchanged log shape `{ requestId, reason: "no-path" }`.
- **Candidates present, none match** → `pattern-miss` short-circuit; log the primary candidate (`candidates[0]`) as the representative `path`, unchanged log shape `{ requestId, path, reason: "pattern-miss" }`.
  For a file-tool ask `candidates[0]` is the raw path (identical to today); for a bash ask it is `matchValues[0]` (the absolute alias) — a sensible representative.
- **`boundaryValue: null`** (a literal-only path, e.g. a win32 non-mount POSIX absolute) — irrelevant here: the fix reads `matchValues`, never `boundaryValue`, so a null boundary does not remove candidates.
- **A `typoPattern` matches multiple aliases** — the loop stops at the first, deterministic by the `matchValues` ordering (absolute first).

### Interaction pattern

The reviewer already consumes `details` (Tell-Don't-Ask over the injected `AuthorizerLog` seam) and never reaches through `accessIntent` into an `AccessPath`; `candidatePathsOf` reads flat string fields only (`matchValues: string[]`), so it introduces no new Law-of-Demeter reach and no dependency on `pi-permission-system` internals beyond the already-imported `PromptPermissionDetails` type.

## Module-Level Changes

- `packages/pi-permission-model-judge/src/typo-reviewer.ts`
  - Remove `pathOf` (sole caller is this file; grep confirms no other `src`/`test` reference).
  - Add `candidatePathsOf(details): string[]`.
  - Rework the `authorize` body: derive `candidates`, keep the `no-path` short-circuit on an empty list, run the first-match loop, keep the `pattern-miss` short-circuit logging `candidates[0]`, then thread the matched `path` / `matchedPattern` into the unchanged model-resolution and recording block.
- `packages/pi-permission-model-judge/test/typo-reviewer.test.ts`
  - Add tests (see TDD Order).
  - Existing tests stay unchanged and green: the `no-path`, `pattern-miss`, `consults the model`, and `reads the surface from accessIntent` cases all still hold under `candidatePathsOf` (verified against the current fixtures — `makeDetails` defaults `path: TYPO_PATH`, and the `accessIntent` test's `matchValues: [TYPO_PATH]` dedupes with `path`).
- `packages/pi-permission-model-judge/README.md`
  - "How it works" step 2 ("A candidate path is present") and the "Why" example imply file-tool paths; add one sentence noting a typo path referenced **inside a `bash` command** is reviewed the same way (its external path is read from the ask's access facts).
- `packages/pi-permission-model-judge/docs/configuration.md`
  - The "candidate path" language is already surface-generic; add one clause to the intro or the `typoPatterns` section stating the candidate path may come from a file tool's path *or* a `bash` command's referenced external path.

No architecture doc exists for this package (no `docs/architecture/`), so there is no roadmap step-mark or module tree to update.
No config schema, example config, or JSON schema change — the fix reads an existing details field.

## Test Impact Analysis

1. **New tests enabled.**
   The candidate-list extraction is directly unit-testable: a `PromptPermissionDetails` with `path: undefined` and `accessIntent.matchValues: [<typo path>]` now drives a model call and a `deny`, which was previously impossible to express (the reviewer defered at `no-path`).
2. **Newly redundant tests.**
   None removed — the existing `no-path` and `pattern-miss` tests still exercise the (unchanged) short-circuit shapes and remain valid characterization of the empty-candidate and no-match branches.
3. **Tests that must stay.**
   `consults the model on a matched path` (file-tool `path` candidate), `reads the surface from accessIntent` (surface derivation), and the auth/observability tests all pin behavior the fix must not regress; keep them as-is.

## Invariants at risk

- **#626 single-path decision trail** — pinned by `consults the model on a matched path, returns its verdict, and records the decision`, which asserts the exact `model_judge.decision` record with one `path`.
  The fix records one matched alias, preserving this; the new bash test asserts the same single-`path` record shape.
- **ADR 0007 invariant 2 (more prompting, never less; no `allow`)** — pinned by the defer-path tests (`auth-failed`, `model-unresolved`, non-deny verdict).
  Widening candidates only sends *more* asks to the model, never fewer, and the slice still returns only `deny`/`defer`.
- **Non-`external_directory` surface not logged** — pinned by `defers a non-external_directory surface without logging`.
  Untouched: the surface gate runs before candidate extraction.

## TDD Order

1. **`test:` + `fix:` — bash-surfaced typo path reaches the model (one commit).**
   Red: add a test — an `external_directory` ask with `path: undefined`, `value: undefined`, and `accessIntent: { surface: "external_directory", matchValues: [TYPO_PATH], boundaryValue: TYPO_PATH }` — asserting the reviewer calls `complete` once, returns the `deny` verdict, and records a `model_judge.decision` with `path: TYPO_PATH` and the matched pattern.
   Green: replace `pathOf` with `candidatePathsOf` and the first-match loop in `authorize`.
   Commit: `fix(pi-permission-model-judge): review typo paths embedded in bash commands (#630)`. (Test and fix land together — the new test exercises code that does not yet exist, and the fix is the minimal change that makes it pass while keeping all prior tests green.)

2. **`test:` — characterize the candidate-list edges.**
   Add tests that pass under step 1's implementation: (a) an `accessIntent.matchValues` whose second alias (not the first) matches the pattern records that matched alias as `path` (first-match-wins across the alias set); (b) a bash ask whose `matchValues` match no pattern logs `pattern-miss` with `path: matchValues[0]` (the representative primary candidate); (c) an ask with `path`, `value`, and `matchValues` all absent still logs `no-path` and defers.
   Commit: `test(pi-permission-model-judge): cover bash-path candidate extraction edges`.

3. **`docs:` — document bash-command coverage.**
   Update `README.md` ("How it works" step 2 / the "Why" framing) and `docs/configuration.md` (the `typoPatterns` / candidate-path description) to state a typo path inside a `bash` command's referenced external paths is reviewed like a file-tool path.
   Commit: `docs(pi-permission-model-judge): note bash-command paths are reviewed`.

## Risks and Mitigations

- **Risk:** matching against the whole `matchValues` alias set (absolute ∪ cwd-relative ∪ canonical) reaches the model on more asks than the raw as-typed path would.
  **Mitigation:** this is the safe direction (more prompting, never less — ADR 0007 invariant 2); the cost gate is still `typoPatterns`, and a broader alias set only increases the chance a genuine typo is caught.
  No `allow` is ever emitted.
- **Risk:** a forwarded bash ask's `details.value` is a command string, not a path; matching a pattern against it could record a command where a path belongs.
  **Mitigation:** `value` is the last candidate, after the authoritative `matchValues`, so on any real bash ask the path aliases match (and are recorded) first; `value` is only a last-resort fallback for a details bag with no `accessIntent`.
- **Risk:** silently dropping an existing test's expectation (the atomic-edit / false-green trap).
  **Mitigation:** run `pnpm --filter @gotgenes/pi-permission-model-judge run test` after step 1 and confirm all prior cases stay green, not only the new one.

## Open Questions

None.
The single design decision the issue flagged (which of several bash paths to review) is resolved by the upstream gate's worst-path selection, documented in Background.
