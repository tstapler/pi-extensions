---
issue: 625
issue_title: "pi-permission-model-judge never authenticates its model call, so it defers every path to the human"
---

# Authenticate the model-judge review call

## Release Recommendation

**Release:** ship independently

This is a standalone bug fix for `pi-permission-model-judge` — the extension is not part of a package roadmap release batch, and no architecture-roadmap step references issue [#625].
It restores the reviewer's core behavior (denying matched typo paths), so it should ship as soon as it lands.

## Problem Statement

The deny-first typo reviewer has never denied anything.
Every candidate path — even one matching a configured `typoPattern` — falls through to a human prompt, because the model call fails auth on every invocation and the reviewer fail-safes to `defer`.

`reviewPath` (`src/model-review.ts`) calls the injected `complete` with only a `signal` — no `apiKey`, no `headers`.
But `@earendil-works/pi-ai`'s `complete` does not resolve auth itself; it only falls back to an environment API key (`ANTHROPIC_API_KEY`).
The core agent resolves auth explicitly before every call via `modelRegistry.getApiKeyAndHeaders(model)`; the judge skips that step.
Under OAuth (`pi-anthropic-auth`) the access token lives in the registry's auth storage, not in the environment — so the request goes out unauthenticated, Anthropic returns 401, `complete` throws, and `reviewPath` catches it and returns `{ kind: "defer" }`.
Systematic and silent: the judge would fail identically for any user without an env key.

A secondary defect blocks the reviewer end to end: the dropped-prefix typo pattern requires a trailing slash (`pi-[^/]+/`), so a path that ends at the package segment (`/Users/chris/development/pi/pi-permission-system`) never matches.
Anchoring the segment with `(/|$)` (`pi-[^/]+(/|$)`) closes this.

## Goals

- Resolve auth in the reviewer the same way the core agent does, so a path matching a `typoPattern` reaches the model authenticated and a `deny` verdict rejects it before it reaches a human.
- Preserve the fail-safe invariant: an unresolved model, an auth-resolution failure, a timeout, a thrown call, or any non-`deny` reply all yield `defer` (ADR 0007 invariant 2 — more prompting, never less).
- Ship a corrected dropped-prefix typo pattern (`pi-[^/]+(/|$)`) in the example config and configuration docs, alongside the doubled-package pattern, so both typo classes work end to end.
- Verify both defects: unit tests for the auth path, plus a manual dogfood note confirming a live OAuth deny reaches the agent.

## Non-Goals

- No change to the verdict range or the fail-safe semantics — the reviewer still only emits `deny | defer`, never `allow`.
- No change to `pi-anthropic-auth`; that extension behaves correctly and applies OAuth shaping automatically once the token is present in `options.apiKey`.
- No change to the config schema (`typoPatterns` stays `string[]`) or the loader.
- No new slice-2 behavior (engine re-query); `query` remains unused here.

## Background

The reviewer is a two-module decision:

- `src/typo-reviewer.ts` — `createTypoReviewer` orchestrates the deny-first chain: config present → surface is `external_directory` → path present → path matches a compiled `typoPattern` → resolve the model via `getRegistry()?.find(...)` → call `reviewPath`.
  It holds the registry and the `warn` sink.
- `src/model-review.ts` — `reviewPath` builds the context, calls the injected `complete` bounded by `timeoutMs`, and maps the reply to a verdict.
  It holds the `CompleteFn` and `ModelRegistryLike` type declarations.

The registry is captured at `session_start` (`ctx.modelRegistry`) in `src/extension.ts` and read live via `getRegistry()`.
The real `ctx.modelRegistry` is a `ModelRegistry` instance exposing both `find(provider, modelId)` and `getApiKeyAndHeaders(model): Promise<ResolvedRequestAuth>`, where:

```typescript
type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };
```

`ResolvedRequestAuth` is **not** re-exported from `@earendil-works/pi-coding-agent`'s index (only the `ModelRegistry` class is), so the narrow projection redeclares a minimal local copy — consistent with `ModelRegistryLike` already being a local ISP projection.

`StreamOptions` (the base of `complete`'s options) carries `apiKey?: string` and `headers?: Record<string, string>`, so widening the injected `CompleteFn`'s options to include them matches the production `complete` signature.

Constraint from AGENTS.md / code-design: keep the registry interaction in one layer (Law of Demeter — do not hand the registry down to `reviewPath`).
Model resolution (`find`) already lives in `typo-reviewer.ts`; auth resolution (`getApiKeyAndHeaders`) belongs there too, symmetrically.
`reviewPath` receives the already-resolved `apiKey`/`headers` and stays a focused "do the authenticated call" unit.

## Design Overview

### Auth resolution placement

Resolve auth in `createTypoReviewer`, immediately after the model resolves, and pass the resolved credentials into `reviewPath`:

```typescript
const registry = deps.getRegistry();
const model = registry?.find(config.provider, config.model);
if (!registry || !model) {
  deps.warn?.(
    `model "${config.provider}/${config.model}" did not resolve; deferring`,
  );
  return { kind: "defer" };
}
const auth = await registry.getApiKeyAndHeaders(model);
if (!auth.ok) {
  deps.warn?.(
    `auth for "${config.provider}/${config.model}" did not resolve (${auth.error}); deferring`,
  );
  return { kind: "defer" };
}
return reviewPath({
  path,
  config,
  model,
  complete: deps.complete,
  apiKey: auth.apiKey,
  headers: auth.headers,
});
```

`if (!registry || !model)` narrows `registry` to defined for the `getApiKeyAndHeaders` call, so no non-null assertion is needed.
`getApiKeyAndHeaders` is async; the `authorize` callback is already `async`, so awaiting it adds no new signature.

`reviewPath` merges the credentials with its own abort `signal`:

```typescript
const reply = await inputs.complete(inputs.model, context, {
  signal: controller.signal,
  apiKey: inputs.apiKey,
  headers: inputs.headers,
});
```

`reviewPath` remains registry-free and warn-free — it never learns how auth was resolved.
This keeps the Tell-Don't-Ask boundary: `typo-reviewer` asks the registry for both the model and its auth, then tells `reviewPath` to run the call with them.

### Type changes (`src/model-review.ts`)

```typescript
export type CompleteFn = (
  model: Model<any>,
  context: Context,
  options?: {
    signal?: AbortSignal;
    apiKey?: string;
    headers?: Record<string, string>;
  },
) => Promise<AssistantMessage>;

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  getApiKeyAndHeaders(model: Model<any>): Promise<ResolvedRequestAuth>;
}

export interface ReviewPathInputs {
  path: string;
  config: ModelJudgeConfig;
  model: Model<any>;
  complete: CompleteFn;
  apiKey?: string;
  headers?: Record<string, string>;
}
```

The added `apiKey`/`headers` on `ReviewPathInputs` and on `CompleteFn`'s options are optional, so the existing `model-review.test.ts` calls that omit them still compile — the auth-forwarding is exercised by a new test.

### Secondary defect — corrected dropped-prefix pattern

The operator chose to feature both typo classes in the shipped artifacts (corrected).
The dropped-prefix pattern catches a path that drops `pi-packages/packages/` and points straight at a package dir, while exempting `pi-packages` itself (negative lookahead) and the sibling Pi monorepo at `~/development/pi/pi` (`pi-[^/]+` requires a segment after `pi-`):

```text
development/pi/(?!pi-packages/)pi-[^/]+(/|$)
```

Because a second pattern is featured, the example config's `instructions` must also describe the dropped-`pi-packages/packages/` typo so the model can `deny` it (today the instructions describe only the doubled-package typo).

Edge cases (verify in the pattern-matching cycle):

- `/Users/chris/development/pi/pi-permission-system` → match (bare package path, the defect the anchor fixes).
- `/Users/chris/development/pi/pi-permission-system/packages/...` → match.
- `/Users/chris/development/pi/pi-packages/packages/pi-permission-system/...` → no match (correct path, `pi-packages` exempted).
- `/Users/chris/development/pi/pi/...` → no match (sibling monorepo, `pi-[^/]+` needs a trailing segment).

## Module-Level Changes

- `src/model-review.ts` — changed: widen `CompleteFn` options to include `apiKey?`/`headers?`; add the `ResolvedRequestAuth` type; add `getApiKeyAndHeaders` to `ModelRegistryLike`; add `apiKey?`/`headers?` to `ReviewPathInputs`; forward both into the `complete` options in `reviewPath`.
- `src/typo-reviewer.ts` — changed: after resolving the model, call `registry.getApiKeyAndHeaders(model)`; on `!ok`, `warn` and `defer`; on `ok`, pass `apiKey`/`headers` into `reviewPath`.
  Guard with `if (!registry || !model)` so `registry` narrows for the auth call.
- `test/model-review.test.ts` — changed: add a test asserting `reviewPath` forwards `apiKey`/`headers` into the `complete` options (alongside `signal`).
  Existing tests unchanged (the new inputs are optional).
- `test/typo-reviewer.test.ts` — changed: `makeRegistry` gains a `getApiKeyAndHeaders` stub (default `{ ok: true, apiKey: "sk-test", headers: {} }`); add a test that the resolved `apiKey`/`headers` reach the completion, and a test that an `{ ok: false, error }` result warns and defers without calling `complete`.
- `test/extension.test.ts` — changed: `ctxWithRegistry()`'s fake `modelRegistry` gains `getApiKeyAndHeaders` (returning `{ ok: true, ... }`), so the existing "denies a matched typo path" end-to-end test still reaches the model.
- `config/config.example.json` — changed: add the corrected dropped-prefix pattern `development/pi/(?!pi-packages/)pi-[^/]+(/|$)` as a second `typoPatterns` entry; extend `instructions` to describe the dropped-`pi-packages/packages/` typo class.
- `docs/configuration.md` — changed: document the corrected dropped-prefix pattern in the `typoPatterns` section, alongside the doubled-package pattern; update the example JSON to show both entries.
- `README.md` — changed: update the `typoPatterns` example (line ~54) to match the two-pattern example config.
- `docs/retro/0600-dogfood-model-judge-authorizer.md` — changed: correct the stale buggy pattern `development/pi/(?!pi-packages/)pi-[^/]+/` → `development/pi/(?!pi-packages/)pi-[^/]+(/|$)` for accuracy (internal, ship-excluded).

No architecture doc, complexity table, or roadmap step-mark exists for this package, so there is no `✅` step-mark to land.

## Test Impact Analysis

This is a bug fix, not an extraction, so the analysis is about which existing tests break and what new coverage the fix requires:

1. New coverage enabled:
   - `reviewPath` forwarding `apiKey`/`headers` into `complete` — a unit assertion on the `complete` mock's third argument.
   - `createTypoReviewer` resolving auth and threading it into the completion (deny path) — asserts the model is consulted with credentials.
   - `createTypoReviewer` deferring with a warning when `getApiKeyAndHeaders` returns `{ ok: false }` — a new fail-safe branch.
2. Tests that must change (fixtures, not intent):
   - `typo-reviewer.test.ts` `makeRegistry` and `extension.test.ts` `ctxWithRegistry` must add `getApiKeyAndHeaders` — the model-consulting tests call it at runtime now; without the stub they would throw and (fail-safe) defer, false-reddening the deny assertions.
3. Tests that stay as-is:
   - The `model-review.test.ts` verdict-mapping and timeout tests genuinely exercise the reply→verdict layer and the abort path; the optional new inputs do not change them.
   - The `typo-reviewer.test.ts` early-defer tests (non-`external_directory` surface, no config, no path, no pattern match, unresolved model) short-circuit before the auth call and remain valid.

## Invariants at risk

The fix touches the reviewer's fail-safe decision path, which ADR 0007 pins:

- Invariant: every uncertain outcome defers (never `allow`, never a bare deny without the model).
  Pinned by the existing `typo-reviewer.test.ts` defer tests (no config, wrong surface, no path, no match, unresolved model) and `model-review.test.ts` defer tests (unparseable, unrecognized verdict, thrown call, timeout).
  The new `{ ok: false }` auth-resolution branch adds one more defer path; add a test that pins it so the invariant is not left to prose.

## TDD Order

1. `test`/`feat` — auth-forwarding in `reviewPath`.
   Red: a `model-review.test.ts` test that `reviewPath` called with `apiKey`/`headers` forwards both into the `complete` options (alongside `signal`).
   Green: widen `CompleteFn` options and `ReviewPathInputs`, add `ResolvedRequestAuth`, add `getApiKeyAndHeaders` to `ModelRegistryLike`, and forward the credentials in `reviewPath`.
   The type change and the single caller (`typo-reviewer.ts`) both compile because the new fields are optional; the caller is updated in step 2.
   Commit: `fix(pi-permission-model-judge): forward resolved auth into the review model call`.
   Run `pnpm run check` after this step — it changes the shared `CompleteFn`/`ModelRegistryLike`/`ReviewPathInputs` types.
2. `test`/`feat` — auth resolution in `createTypoReviewer`.
   Red: two `typo-reviewer.test.ts` tests — (a) a matched path resolves auth and the credentials reach the completion; (b) an `{ ok: false, error }` result warns and defers without calling `complete`.
   Update `makeRegistry` to include a `getApiKeyAndHeaders` stub in the same step (the model-consulting tests break at runtime otherwise).
   Green: resolve auth after `find`, guard with `if (!registry || !model)`, defer+warn on `!ok`, pass `apiKey`/`headers` into `reviewPath`.
   Also update `extension.test.ts` `ctxWithRegistry` to add `getApiKeyAndHeaders` in this step — the end-to-end deny test consults the model now.
   Commit: `fix(pi-permission-model-judge): resolve model auth before the review call`.
3. `docs` — feature the corrected dropped-prefix pattern.
   Update `config/config.example.json` (add the second pattern, extend `instructions`), `docs/configuration.md` (document both patterns, corrected anchor), `README.md` (two-pattern example), and correct the stale retro pattern.
   No test cycle — verify with `pnpm exec rumdl check` on the docs and `node -e` regex probes against the four edge-case paths listed in Design Overview.
   Commit: `docs(pi-permission-model-judge): feature the corrected dropped-prefix typo pattern`.

Run the full package suite (`pnpm --filter @gotgenes/pi-permission-model-judge exec vitest run`) after step 2 — the change touches shared fixtures across three test files.

## Risks and Mitigations

- Risk: the fix restores denials, so a mis-tuned `typoPattern` or over-eager `instructions` could deny a legitimate path.
  Mitigation: a deny is recoverable (the agent self-corrects on the teaching reason), the reviewer is opt-in (`authorizerChain` must name `model-judge` and the operator must configure patterns), and every uncertain outcome still defers.
- Risk: `getApiKeyAndHeaders` could be slow or hang, extending the interactive prompt latency.
  Mitigation: it runs before the `reviewPath` timeout window; the registry call is a local auth-storage read (not a network round-trip), so it is fast.
  If this proves wrong in dogfooding, fold it under the abort controller in a follow-up.
- Risk: the manual dogfood step depends on a live OAuth session and a real typo path.
  Mitigation: the unit tests fully cover the auth-forwarding and fail-safe branches deterministically; the dogfood note is confirmation, not the gate.

## Open Questions

- None blocking.
  The auth-resolution timing risk (whether to bound `getApiKeyAndHeaders` under the abort controller) is deferred until dogfooding shows it matters; no follow-up issue is filed speculatively.

[#625]: https://github.com/gotgenes/pi-packages/issues/625
