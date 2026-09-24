---
issue: 626
issue_title: "pi-permission-model-judge records nothing, so its decisions are unobservable"
---

# Model-judge decision trail via a permission-review-log seam

## Release Recommendation

**Release:** ship independently

This issue is in no roadmap batch; neither package's architecture doc tags it.
It produces **two** independent releases in a hard publish-gated order:

1. Phase 1 — a `feat(pi-permission-system)` that adds the review-log seam to the `Authorizer` chain, cutting a pi-permission-system release and publishing it to npm.
2. Phase 2 — a `feat(pi-permission-model-judge)` that bumps the judge's dependency to that published version and consumes the seam, cutting a judge release.

Phase 2 **cannot be built** until Phase 1 is published, because the judge type-checks against the registry copy of `@gotgenes/pi-permission-system`, not the workspace source (`linkWorkspacePackages: false`).
Phase 2's judge release also carries the held [#625] auth fix already sitting unreleased on `main`, which is the whole point: the new decision trail is how we verify [#625] before it ships.

## Problem Statement

`pi-permission-model-judge` leaves no decision trail.
When its `"model-judge"` link runs on an ask, nothing is recorded about whether it matched a typo pattern, whether it reached the model, what the model said, or why it deferred.
This is what let the total-auth-failure bug ([#625], the judge deferring 100% of the time) ship and run undetected — the cause was findable only by reverse-engineering the SDK's auth path.

The package's only sink is one `console.warn` (`extension.ts`), which fires on a malformed config, an unresolved model, and bad `typoPatterns` — and is not persisted anywhere.
Everything substantive is silent: `createTypoReviewer` short-circuits (non-`external_directory` surface, missing path, pattern miss) as unlogged defers, and `reviewPath`'s five distinct defer reasons (parse failure, non-`deny` verdict, unrecognized verdict, thrown, timeout) all collapse into one silent `{ kind: "defer" }`.
There is no way to answer "did the judge run, did it reach the model, what did it decide, and why?"

The governing principle for this fix: **absence of evidence is not evidence of absence.**
A silent defer forces us to infer "it must have deferred" from an empty log.
Every branch the judge takes on an ask it is responsible for must instead emit a **positive** record, so a defer is a recorded defer with a reason — never an inferred one.

## Goals

- Add a narrow cross-extension logging seam to the pi-permission-system `Authorizer` chain: thread an `AuthorizerLog` (`{ review, debug }`) into each link's `authorize`, sourced from the session's existing `DebugReviewLogger`, so a registered link can write to the shared `pi-permission-system-permission-review.jsonl`.
  This is the operator's chosen design (issue option 1: single audit trail), not a judge-owned JSONL (option 2).
- Have the judge write a **positive, structured decision record per `external_directory` ask it evaluates past the pattern gate**: request id, surface, candidate path, matched pattern, model-call attempt, model id, latency, verdict, and a defer-reason enum — so a defer never lacks a reason on record.
- Distinguish the model-call defer reasons in `reviewPath` (`parse-failed` / `non-deny-verdict` / `timeout` / `call-failed`) instead of collapsing them to a bare defer.
- Capture the raw model reply at a **debug level** (only when pi-permission-system's `debugLog` toggle is on), per the operator's choice.
- Neither change is breaking: the pi-permission-system seam widens `Authorizer.authorize` with a third parameter (existing 2-param link callbacks stay assignable), and the judge change is internal to a leaf consumer that exports nothing.

## Non-Goals

- A judge-owned JSONL log file under its config dir (issue option 2) — rejected in favor of the shared review log.
- Logging non-`external_directory` asks — the judge defers those silently because they are not its surface; a review-log line per bash/tool ask is noise, not evidence.
- The allow-capable opaque-bash adjudicator ([#620]) — the judge remains deny-first and this plan does not touch that slice.
- Any change to the review-log file format, filename, or the `permissionReviewLog` / `debugLog` config toggles — the judge writes new `event` names through the existing logger, which already accepts an arbitrary `details` record.
- A post-envelope verdict log — the judge logs the verdict it computes; because it is deny-first (never emits `allow`), the bounded-delegation envelope never alters its verdict, so the logged verdict is the emitted verdict.
  An allow-capable link ([#620]) would need to log after the envelope; that is deferred with the slice that needs it.

## Background

Relevant pi-permission-system surfaces (all in the working tree):

- `Authorizer.authorize(details, query): Promise<AuthorizerVerdict>` (`src/authority/authorizer.ts`) — the non-terminal chain-link contract; `AuthorizerVerdict` is `allow | deny | defer`.
- `composeAuthorizerChain(links, terminal, query)` (`src/authority/authorizer-chain.ts`) — runs each link, falling through on `defer`, ending at the terminal; maps a `deny` to a denied decision carrying `reason`.
- `encloseInDelegationEnvelope(authorize)` (`src/authority/delegation-envelope.ts`) — wraps each link, capping an `allow` on an excluded surface to `defer`; forwards `details` and `query` as-is.
- `AuthorizerSelection.escalate` (`src/authority/authorizer-selection.ts`) — resolves the configured links per ask, composes them ahead of the terminal, and already holds a `DebugReviewLogger` at `this.deps.logger` (used today for the `authorizer_chain_unregistered_link` review entry).
- `DebugReviewLogger` (`src/session-logger.ts`) — `{ review(event, details?), debug(event, details?) }`; `review` writes `pi-permission-system-permission-review.jsonl` (gated by `permissionReviewLog`, default on), `debug` writes `pi-permission-system-debug.jsonl` (gated by `debugLog`).
- `PermissionsService.registerAuthorizer(name, authorize)` and the public type re-exports live in `src/service.ts` (the package's `default` export target); `Authorizer`, `AuthorizerVerdict`, `PromptPermissionDetails`, `PermissionQuery` are exported there for cross-extension consumers.

Relevant pi-permission-model-judge surfaces (`packages/pi-permission-model-judge/src/`):

- `createTypoReviewer(deps): Authorizer["authorize"]` (`typo-reviewer.ts`) — the deny-first decision: surface gate → path gate → pattern gate → model resolve → auth resolve → `reviewPath`, deferring at the first miss.
  It currently takes a `warn` sink in `deps` and calls it for unresolved-model / auth-failed / bad-pattern notices.
- `reviewPath(inputs): Promise<AuthorizerVerdict>` (`model-review.ts`) — arms an `AbortController` to `timeoutMs`, calls `complete`, and maps the reply via `parseVerdict`; any parse failure, non-`deny` reply, throw, or timeout collapses to `{ kind: "defer" }`.
- `matchesAnyTypoPattern(path, compiled): boolean` (`typo-patterns.ts`) — returns only a boolean, not which pattern matched.
- `createModelJudgeExtension(pi, deps?)` (`extension.ts`) — loads config at `session_start`, registers the link on `permissions:ready`, disposes at shutdown; keeps its own `warn` (`console.warn`) for `session_start` config issues.

Constraints from AGENTS.md / the package skill that apply:

- **Publish gate (the central constraint).**
  `linkWorkspacePackages: false` (`pnpm-workspace.yaml`): the judge resolves `@gotgenes/pi-permission-system` from the npm registry (`20.9.0` in `node_modules`), not the workspace source.
  A 3-parameter `authorize` callback is **not** assignable to the published 2-parameter `Authorizer["authorize"]` type, so the judge cannot consume the seam until pi-permission-system publishes it and the judge bumps its dependency.
- ADR 0007 (`packages/pi-permission-system/docs/decisions/0007-model-judge-authorizer-chain-adr.md`) documents the chain contract, including §3 "the query capability is injected, not imported"; the new log injection is the same pattern and belongs in the ADR.
- `docs/architecture/architecture.md` line 764 inline-copies the `Authorizer.authorize(details, query)` signature in its module tree — a signature change must update that entry (the same rule the skill states for the `rule.ts` type copies).
- Docs-in-distribution: both packages ship user docs via a `files` allowlist; the judge's `README.md` / `docs/configuration.md` describe the reviewer and must mention the new decision trail.

## Design Overview

### The pi-permission-system seam (Phase 1)

Add a public `AuthorizerLog` and widen the link contract:

```typescript
// src/service.ts — new public type (re-exported alongside Authorizer, AuthorizerVerdict)
export interface AuthorizerLog {
  review(event: string, details?: Record<string, unknown>): void;
  debug(event: string, details?: Record<string, unknown>): void;
}

// src/authority/authorizer.ts — widened contract
export interface Authorizer {
  authorize(
    details: PromptPermissionDetails,
    query: PermissionQuery,
    log: AuthorizerLog,
  ): Promise<AuthorizerVerdict>;
}
```

`AuthorizerLog` is structurally satisfied by the session's `DebugReviewLogger`, so no new logger implementation is needed — the existing session logger is passed straight through.
The injection follows the ADR 0007 §3 query-injection precedent: a capability handed to the link at `authorize` time, not imported by it.

Threading (all internal call sites — one atomic type-level change):

```typescript
// authorizer-chain.ts
export function composeAuthorizerChain(
  links: readonly Authorizer[],
  terminal: TerminalAuthorizer,
  query: PermissionQuery,
  log: AuthorizerLog,
): TerminalAuthorizer {
  // ...
  const verdict = await link.authorize(details, query, log);
  // ...
}

// delegation-envelope.ts
export function encloseInDelegationEnvelope(
  authorize: Authorizer["authorize"],
): Authorizer["authorize"] {
  return async (details, query, log) => {
    const verdict = await authorize(details, query, log);
    if (verdict.kind === "allow" && isExcludedSurface(details)) return { kind: "defer" };
    return verdict;
  };
}

// authorizer-selection.ts — escalate()
const chain = composeAuthorizerChain(
  this.resolveConfiguredLinks(),
  this.terminal,
  this.deps.getPermissionQuery(),
  this.deps.logger, // DebugReviewLogger, already held for the unregistered-link review entry
);
```

The seam is non-breaking: a link implementing `authorize` with only `(details, query)` stays assignable to the 3-parameter type (TypeScript allows a callback with fewer parameters), and every internal caller is updated in the same commit.

### The judge's decision record (Phase 2)

The judge consumes the injected `log` inside `createTypoReviewer`'s returned callback.
The log level is chosen so the review log stays signal-rich and the "absence of evidence" gap that hid [#625] is closed:

- **`log.review("model_judge.decision", …)`** — written once for every `external_directory` ask that reaches the model stage, i.e. **the pattern matched**.
  These are the substantive positions on candidate typo paths — exactly what you grep to answer "did the judge reach the model, and what did it decide?"
  Present when `permissionReviewLog` is on (default).
- **`log.debug(…)`** — the cheap short-circuits (`no-path`, `pattern-miss`) and the raw model reply.
  These are the uninteresting or verbose cases; present only when `debugLog` is on.
- **No log** for a non-`external_directory` surface — not the judge's concern.

This split still honors the principle: any **pattern-matched** ask (the dangerous [#625] class — a candidate typo that should reach the model) always has a positive review record with its outcome, so a silent 100%-defer regression is impossible to hide again.
A `pattern-miss` (not a candidate typo, correctly deferred) is the uninteresting case and lives at debug level.

Decision-record fields (`model_judge.decision`):

```typescript
{
  requestId: string;          // details.requestId — joins to the permission_request.* lines
  surface: "external_directory";
  path: string;               // the candidate path
  matchedPattern: string;     // the typoPattern source that matched
  modelCalled: boolean;       // false for model-unresolved / auth-failed
  modelId: string | null;     // `${provider}/${model}` when known
  latencyMs: number | null;   // wall-clock of the complete() call, null when no call
  verdict: "deny" | "defer";
  deferReason:                 // null on a deny
    | "model-unresolved" | "auth-failed"
    | "parse-failed" | "non-deny-verdict" | "timeout" | "call-failed"
    | null;
}
```

Judge call-site sketch (verifies the seam interaction is Tell-Don't-Ask — the judge tells the log what happened; it never reads it back):

```typescript
return async (details, query, log) => {
  const config = deps.getConfig();
  if (!config) return { kind: "defer" };
  if (surfaceOf(details) !== REVIEWED_SURFACE) return { kind: "defer" }; // silent: not our surface

  const { requestId } = details;
  const path = pathOf(details);
  if (path === undefined) {
    log.debug("model_judge.short_circuit", { requestId, reason: "no-path" });
    return { kind: "defer" };
  }
  const matched = matchTypoPattern(path, compiledFor(config, log)); // string | undefined
  if (matched === undefined) {
    log.debug("model_judge.short_circuit", { requestId, path, reason: "pattern-miss" });
    return { kind: "defer" };
  }

  const modelId = `${config.provider}/${config.model}`;
  const registry = deps.getRegistry();
  const model = registry?.find(config.provider, config.model);
  if (!registry || !model) return deferWith(log, base, "model-unresolved");

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) return deferWith(log, base, "auth-failed");

  const outcome = await reviewPath({ path, config, model, complete: deps.complete, apiKey: auth.apiKey, headers: auth.headers });
  if (outcome.rawReply !== undefined) log.debug("model_judge.model_reply", { requestId, modelId, rawReply: outcome.rawReply });
  log.review("model_judge.decision", {
    requestId, surface: REVIEWED_SURFACE, path, matchedPattern: matched,
    modelCalled: true, modelId, latencyMs: outcome.latencyMs,
    verdict: outcome.verdict.kind, deferReason: outcome.deferReason ?? null,
  });
  return outcome.verdict;
};
```

Here `deferWith(log, base, reason)` writes a `model_judge.decision` review entry (`modelCalled: false`, `latencyMs: null`) and returns `{ kind: "defer" }`, so the two model-resolution failures record positively too.
The per-ask operational notices that today call `deps.warn` (unresolved model, auth failed, invalid patterns) move to the log seam; the extension's `session_start` config-issue `warn` stays (it fires before any `authorize`, when no `log` exists).
`createTypoReviewer`'s `deps.warn` is therefore dropped.

### `reviewPath` structured outcome (Phase 2)

`reviewPath` returns a richer result so the reviewer can log latency and the distinct defer reason without re-deriving them:

```typescript
// model-review.ts
export type ModelCallDeferReason =
  | "parse-failed" | "non-deny-verdict" | "timeout" | "call-failed";

export interface ReviewOutcome {
  verdict: AuthorizerVerdict;        // deny | defer (never allow)
  deferReason?: ModelCallDeferReason; // set iff verdict is defer
  latencyMs: number;                  // wall-clock of the complete() call
  rawReply?: string;                  // assistant text, when a reply arrived
}
```

- The `catch` distinguishes `timeout` (`controller.signal.aborted`) from `call-failed` (any other throw).
  `call-failed` is the honest superset the issue's enum omits: a 401 that slips past pre-call auth resolution throws inside `complete` and lands here — precisely the [#625]-class signal.
- Verdict behavior is unchanged: every failure branch still resolves to `defer` (ADR 0007 invariant 2, "more prompting, never less"); the outcome only annotates *why*.
- `matchTypoPattern(path, compiled): string | undefined` is added to `typo-patterns.ts`, returning the matching regex's `source`; `matchesAnyTypoPattern` is re-expressed as `matchTypoPattern(...) !== undefined` (or its lone caller migrates).

## Module-Level Changes

### pi-permission-system (Phase 1)

- `src/service.ts` — added: `export interface AuthorizerLog`, re-exported alongside `Authorizer` / `AuthorizerVerdict`.
  Changed: the `registerAuthorizer` JSDoc to describe the callback as `(details, query, log) => verdict`.
- `src/authority/authorizer.ts` — changed: `Authorizer.authorize` gains the `log: AuthorizerLog` third parameter; import `AuthorizerLog` (from `#src/service`, matching the existing `PermissionQuery` import).
- `src/authority/authorizer-chain.ts` — changed: `composeAuthorizerChain` gains a `log: AuthorizerLog` parameter and passes it to `link.authorize(details, query, log)`.
- `src/authority/delegation-envelope.ts` — changed: `encloseInDelegationEnvelope`'s returned callback gains `log` and forwards it.
- `src/authority/authorizer-selection.ts` — changed: `escalate` passes `this.deps.logger` as the fourth `composeAuthorizerChain` argument.
- `test/authority/authorizer-chain.test.ts` — changed: every `composeAuthorizerChain(links, terminal, query)` call adds a fake `AuthorizerLog`; added a test asserting the log is forwarded to a link's `authorize`.
- `test/authority/delegation-envelope.test.ts` — changed: `makeLink` / envelope invocations pass a fake `log`; added a test asserting the envelope forwards `log` unchanged.
- `test/authority/authorizer-selection.test.ts` (if present; else the composition-root wiring test) — added: an assertion that `escalate` hands the session logger to the chain.
- `docs/decisions/0007-model-judge-authorizer-chain-adr.md` — changed: the non-terminal `authorize(...)` signature at line 66 gains `log: AuthorizerLog`; a short subsection (under §3) documents the review-log seam and its ADR-0007-invariant-2-preserving intent.
- `docs/architecture/architecture.md` — changed: line 764's `authorizer.ts` module-tree entry updates the copied signature to `authorize(details, query, log)` and names `AuthorizerLog`.

Nothing in the `path`, config, or gate layers changes.

### pi-permission-model-judge (Phase 2, after Phase 1 publishes)

- `package.json` — changed: bump the `@gotgenes/pi-permission-system` devDependency and peerDependency floor to the Phase 1 published version.
- `src/model-review.ts` — added: `ModelCallDeferReason`, `ReviewOutcome`; changed: `reviewPath` returns `Promise<ReviewOutcome>`, timing the call and distinguishing the four model-call defer reasons.
- `src/typo-patterns.ts` — added: `matchTypoPattern(path, compiled): string | undefined`; `matchesAnyTypoPattern` re-expressed in terms of it (or its caller migrated).
- `src/typo-reviewer.ts` — changed: the returned callback takes `(details, query, log)`, writes the `model_judge.decision` review entries and `model_judge.short_circuit` / `model_judge.model_reply` debug entries, and returns the verdict; `deps.warn` removed; the invalid-`typoPatterns` notice routes to `log.debug`.
- `src/extension.ts` — changed: stops passing `warn` into `createTypoReviewer` (its `session_start` config-issue `warn` stays).
- `test/model-review.test.ts` — changed: assertions move from the bare verdict to `outcome.verdict`; added cases pinning each `deferReason` (`parse-failed`, `non-deny-verdict`, `timeout`, `call-failed`) and `latencyMs`/`rawReply` presence.
- `test/typo-patterns.test.ts` — added: `matchTypoPattern` returns the matching pattern source, `undefined` on no match.
- `test/typo-reviewer.test.ts` — changed: the returned callback is invoked with a fake `AuthorizerLog`; added assertions that each branch emits the expected review/debug entry (surface-miss → no log; no-path/pattern-miss → debug; model-unresolved/auth-failed → review with the reason; model-called → review with verdict + latency + raw-reply debug).
- `test/extension.test.ts` — changed: drop the `warn`-into-reviewer expectation if asserted.
- `README.md`, `docs/configuration.md` — changed: document the decision trail — the `model_judge.*` events written to the shared review log, the fields, the `debugLog`-gated raw reply, and how to read it to answer "did the judge reach the model, and why did it defer?"

## Test Impact Analysis

1. **New tests enabled.**
   The `reviewPath` restructure makes each model-call defer reason independently assertable (previously all four collapsed to one `defer`, untestable apart).
   The seam makes the judge's per-branch logging assertable via a fake `AuthorizerLog` — the first tests that pin *why* the judge defers.
2. **Redundant existing tests.**
   None are removed.
   The existing `reviewPath` verdict tests are retargeted to `outcome.verdict` (lift-and-shift of the assertion, same scenarios) rather than deleted — they still pin the fail-safe-defer invariant.
3. **Tests that must stay.**
   All existing `typo-reviewer` / `model-review` / `extension` behavior tests stay: they pin the deny-first verdicts and the fail-safe defers, which this change must preserve while adding the trail.
   The pi-permission-system `authorizer-chain` / `delegation-envelope` behavior tests stay and gain the `log` argument; they continue to pin the empty-links identity, defer fall-through, deny mapping, and the allow-cap.

## Invariants at risk

This change touches surfaces earlier phases refactored; each invariant below must stay green.

- **Delegation envelope only ever tightens** (caps `allow`→`defer` on an excluded surface, never loosens a `deny`/`defer`) — pinned by `test/authority/delegation-envelope.test.ts`.
  Adding `log` forwarding must not alter any verdict; the new forwarding test asserts `log` passes through untouched.
- **`composeAuthorizerChain` identity + fall-through + deny mapping** (zero links returns the terminal instance; `defer` falls through; `deny` maps to a denied decision with `reason`) — pinned by `test/authority/authorizer-chain.test.ts`.
- **ADR 0007 invariant 2 — more prompting, never less.**
  Every judge failure branch, and every unresolved surface, still defers; the `reviewPath` outcome annotates the reason without changing the `defer` verdict — pinned by `test/model-review.test.ts` and `test/typo-reviewer.test.ts`.
- **[#625] auth-before-call fix.**
  The reviewer still resolves `getApiKeyAndHeaders` before the model call and defers on `!auth.ok`; the change records that as `auth-failed` rather than swallowing it — pinned by the existing auth test in `test/typo-reviewer.test.ts`, extended with the log assertion.

## TDD Order

Each cycle is red → green → commit.

### Phase 1 — pi-permission-system seam (ships and publishes first)

1. **Thread the review-log seam through the chain** (`feat(pi-permission-system)`).
   Red: extend `test/authority/authorizer-chain.test.ts` (a link receives the injected `log`) and `test/authority/delegation-envelope.test.ts` (the envelope forwards `log`), plus the selection/wiring assertion that `escalate` hands over the session logger.
   Green: add `AuthorizerLog` to `src/service.ts`; widen `Authorizer.authorize` (`authorizer.ts`); add the `log` parameter to `composeAuthorizerChain` and forward it; widen `encloseInDelegationEnvelope`; pass `this.deps.logger` in `AuthorizerSelection.escalate`; update every existing `composeAuthorizerChain`/envelope call and test to supply a `log`.
   This is one commit because the signature change breaks all internal call sites and their tests at the type level simultaneously.
   Commit: `feat(pi-permission-system): thread a review-log seam into the authorizer chain`.
2. **Document the seam** (`docs(pi-permission-system)`).
   Update ADR 0007 (signature at line 66 + a §3 subsection on the log injection) and `docs/architecture/architecture.md` line 764.
   Commit: `docs(pi-permission-system): document the authorizer review-log seam`.

**Publish gate.**
Ship Phase 1 (`/ship-issue` cuts and merges the pi-permission-system release; CI publishes it to npm).
Record the published version; Phase 2 depends on it.

### Phase 2 — judge consumption (built only after Phase 1 publishes)

1. **Bump the dependency** (`build(pi-permission-model-judge)`).
   Bump the `@gotgenes/pi-permission-system` devDependency and peerDependency floor to the Phase 1 version; `pnpm install`.
   This alone leaves the judge compiling (it still returns a 2-param callback), and unlocks the 3-param `Authorizer["authorize"]` type for the next steps.
   Commit: `build(pi-permission-model-judge): bump pi-permission-system to <version> for the review-log seam`.
2. **Distinguish model-call defer reasons** (`feat(pi-permission-model-judge)`).
   Red: `test/model-review.test.ts` — retarget existing verdict assertions to `outcome.verdict`; add `parse-failed` / `non-deny-verdict` / `timeout` / `call-failed` cases and `latencyMs` / `rawReply` presence.
   Green: add `ModelCallDeferReason` / `ReviewOutcome`; restructure `reviewPath` (timing + `aborted` discrimination).
   Commit: `feat(pi-permission-model-judge): distinguish model-call defer reasons in reviewPath`.
3. **Expose the matched pattern** (`feat(pi-permission-model-judge)`).
   Red: `test/typo-patterns.test.ts` — `matchTypoPattern` returns the matching source / `undefined`.
   Green: add `matchTypoPattern`; re-express `matchesAnyTypoPattern` (or migrate its caller).
   Commit: `feat(pi-permission-model-judge): return the matched typo pattern`.
4. **Record the decision trail** (`feat(pi-permission-model-judge)`).
   Red: `test/typo-reviewer.test.ts` — invoke the returned callback with a fake `AuthorizerLog`; assert per-branch entries (surface-miss → no log; no-path / pattern-miss → `log.debug`; model-unresolved / auth-failed → `log.review` with the reason; model-called → `log.review` with verdict + latency + `log.debug` raw reply); adjust `test/extension.test.ts` for the dropped `warn`.
   Green: consume `log` in `createTypoReviewer`; add `deferWith`; drop `deps.warn`; stop passing `warn` from `extension.ts`.
   Commit: `feat(pi-permission-model-judge): record the decision trail to the permission review log`.
5. **User docs** (`docs(pi-permission-model-judge)`).
   `README.md` + `docs/configuration.md`: the `model_judge.*` events, fields, `debugLog`-gated raw reply, and the read recipe.
   Commit: `docs(pi-permission-model-judge): document the decision trail`.

After Phase 2 lands, run the [#625] verification recipe (trigger via a file `read` on a doubled-package path, read the review log, confirm `model_judge.decision` shows `modelCalled: true` and a `deny`/`defer` with a concrete reason — not a silent absence), then ship [#625] together with this issue's judge release.

## Risks and Mitigations

- **Publish-gate ordering (the primary risk).**
  Phase 2 cannot type-check until Phase 1 is published and the judge's dependency bumped.
  Mitigation: the plan sequences the two phases explicitly with a publish gate; Phase 2 begins with the dependency bump.
  This likely spans two `/ship-issue` cycles (Phase 1 release, then Phase 2 release); that is expected, not an error.
- **Review-log noise.**
  A `model_judge.decision` line per pattern-matched `external_directory` ask adds volume to the shared review log.
  Mitigation: only pattern-matched asks reach `log.review`; the common `pattern-miss` / `no-path` cases stay at `debug` level (off by default).
- **Persisting model prose.**
  The raw reply could carry sensitive path context.
  Mitigation: it is written only via `log.debug`, gated by the `debugLog` toggle (off by default), per the operator's choice.
- **A dropped test-fixture stub throws at runtime.**
  The `reviewPath` return-type change and the 3-param callback both break fixtures — `makeRegistry` / `ctxWithRegistry` (judge) and the chain/envelope link fakes (pi-permission-system).
  Mitigation: each interface-widening step folds its fixture updates into the same commit so `pnpm run check` stays green at the step boundary (the [#625] retro's lesson about `getApiKeyAndHeaders` breaking the fake at type-check time).
- **Seam misread as breaking.**
  Widening `authorize` with a third parameter could look like a breaking change.
  Mitigation: a 2-param callback stays assignable to the 3-param type, and no external consumer implements `composeAuthorizerChain`; it is a `feat`, not `feat!`.

## Open Questions

- **Consolidated vs. multi-event record.**
  This plan writes one `model_judge.decision` review entry per handled ask (plus debug lines).
  If a future need arises to time the pattern gate separately from the model call, split then — not now.
- **Generalizing the seam beyond logging.**
  If a later link needs more than logging from the chain owner, the third parameter could become a context object (`{ log, … }`).
  Deferred until a second capability exists (YAGNI); the current single-purpose `AuthorizerLog` is the minimal seam.

[#620]: https://github.com/gotgenes/pi-packages/issues/620
[#625]: https://github.com/gotgenes/pi-packages/issues/625
