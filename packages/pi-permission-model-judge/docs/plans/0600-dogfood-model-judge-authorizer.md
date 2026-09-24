---
issue: 600
issue_title: "pi-permission-model-judge: dogfood package for the deny-first typo-path Authorizer"
---

# pi-permission-model-judge — the deny-first typo-path Authorizer dogfood package

## Release Recommendation

**Release:** ship independently

This is Phase 12 Track B Step 6 of the pi-permission-system roadmap, tagged `Release: independent` there: a brand-new package with its own release component, landing after Step 5 ([#599], the `registerAuthorizer` seam, already shipped).
It carries no shared code change with the batch-"authorizer-chain" tail (Step 5), so it releases on its own first `feat:` commit.

## Problem Statement

The `registerAuthorizer` seam shipped in [#599] is a live-authority extensibility point with no consumer.
The [#267] history guard warns that an inbound registration surface nobody consumes goes vacant, and ADR [docs/decisions/0007-model-judge-authorizer-chain-adr.md] makes a first-party consumer slice 1's acceptance criterion — a design safeguard, not a demo.

This plan adds `@gotgenes/pi-permission-model-judge`, a first-party monorepo package that registers a `"model-judge"` link on `permissions:ready` and implements the deny-first typo-path reviewer.
The concrete use case: models frequently invoke tools against a malformed path (e.g. a doubled `…/pi-permission-system/packages/pi-permission-system/…` segment where the first segment should be `pi-packages`), which lands as an `external_directory` ask a human hand-denies one by one.
A light model should review such an ask, deny it with a teaching reason (wrong path; correct location) when it matches a configured typo pattern, and defer everything else — so the invoking model self-corrects and the operator stops hand-denying.

## Goals

- New `packages/pi-permission-model-judge/` package that registers `"model-judge"` on the published `PermissionsService` in a `permissions:ready` handler.
- A deny-first reviewer with verdicts `deny | defer` only (no `allow` in this slice, per ADR 0007's capability gradient).
- Config-driven typo pre-filter: operator-declared `typoPatterns` (regex strings) gate which `external_directory` paths reach the model; the model confirms the typo and writes the teaching reason.
- The reviewer scopes to `external_directory` asks only; every other surface defers cheaply without a model call.
- Model calls via `@earendil-works/pi-ai` `complete`, with provider / model / instructions / timeout / patterns in the package's own zod-validated `config.json` (config split per ADR 0007 §5: chain policy lives in pi-permission-system, model mechanism lives here).
- Fail-safe throughout: a missing model, invalid config, timeout, parse failure, or uncertain model verdict all resolve to `defer` (more prompting, never less).
- Full monorepo wiring per `AGENTS.md`.

## Non-Goals

- The allow-capable opaque-bash adjudicator (ADR 0007 slice 2 / use case 2) — deferred to [#620]; this package emits no `allow` verdict.
- Any change to `@gotgenes/pi-permission-system` source — the seam, the delegation envelope, and the `authorizerChain` config already shipped in [#599].
  This package is a pure downstream consumer.
- Any change to `@gotgenes/pi-subagents` source — despite the `pkg:pi-subagents` label, no subagents code changes (the label reflects the shared `@earendil-works/pi-ai` feasibility probe, not a code touch).
- A configurable `reviewSurfaces` list — this slice hardcodes `external_directory`; generalizing the reviewed-surface set is a future concern (Open Questions).
- A published cross-extension API surface — this package is a leaf consumer; it exports nothing for other extensions, ships source (no `dist` type bundle, no rollup).

## Background

Relevant existing surfaces this package consumes from `@gotgenes/pi-permission-system` (all already shipped, verified in the working tree):

- `getPermissionsService(): PermissionsService | undefined` (`src/service.ts`) — reads a process-global `Symbol.for("@gotgenes/pi-permission-system:service")` slot.
  Because the slot is process-global by spec, a second module copy (this package resolves the sibling from the registry under `linkWorkspacePackages: false`) reads the same slot the loaded extension published — the Symbol.for design is exactly what makes a separate-copy consumer work.
- `registerAuthorizer(name, authorize): () => void` on `PermissionsService` — mirrors `registerToolAccessExtractor`; throw-on-duplicate, returns a disposer.
- `PERMISSIONS_READY_CHANNEL = "permissions:ready"` — emitted at `session_start` after the service is published; register here so registration is robust to load order and survives `/reload`.
- Types `Authorizer`, `AuthorizerVerdict`, `PromptPermissionDetails`, `PermissionQuery` — the link's contract.

The chain wiring that consumes a registered link (context for why the verdicts behave as they do):

- `AuthorizerSelection.escalate` (`src/authority/authorizer-selection.ts`) resolves the operator's `authorizerChain` config **per ask**, in config order, skipping an unregistered name fail-safe, and wraps each link in the bounded-delegation envelope.
- `encloseInDelegationEnvelope` (`src/authority/delegation-envelope.ts`) caps a link's `allow` on an excluded surface (`external_directory` / `path`) to `defer`; it never tightens a `deny` or `defer`.
  So a `deny` on `external_directory` — exactly this reviewer's output — passes through unchanged.
- `composeAuthorizerChain` (`src/authority/authorizer-chain.ts`) maps a `deny` verdict to `createDeniedPermissionDecision(verdict.reason)`, so the optional teaching `reason` flows into the denied decision and reaches the invoking model.

Model-call surface (verified against `@earendil-works/pi-ai` 0.79.1 and the pi-subagents precedent):

- `complete<TApi>(model, context, options?): Promise<AssistantMessage>` (`stream.d.ts`) — `context: { systemPrompt?, messages, tools? }`; the result's `content` is `(TextContent | ThinkingContent | ToolCall)[]`.
- The model instance comes from the session `ExtensionContext.modelRegistry` (`ModelRegistry.find(provider, modelId)`), the same registry pi-subagents resolves against.
- `@earendil-works/pi-ai` is a **peerDependency** in the sibling packages (pi-subagents pins `>=0.75.0` peer + a `0.79.1` dev pin); this package follows that pattern.

Constraints from `AGENTS.md` that apply:

- Docs-in-distribution: `files` allowlist (no `.npmignore`), ship runtime code + user docs, exclude `test/` and dev config and internal docs.
- Monorepo wiring: `release-please-config.json` component + `docs/plans`/`docs/retro` exclude-paths; `.release-please-manifest.json` at `0.0.0`; `.pi/settings.json` load path + npm disable entry; root `README.md` packages table.
- `pnpm fallow dead-code` locally before pushing a new package — `devDependencies` copied from a sibling often carry unused entries.

## Design Overview

### Decision flow

The registered link's `authorize(details, query)` implements this decision, top to bottom, deferring at the first miss:

1. **Surface gate.**
   Read the surface as `details.accessIntent?.surface ?? details.surface` (the same precedence the delegation envelope uses).
   If it is not `external_directory` → `{ kind: "defer" }`.
   No model call.
2. **Path extraction.**
   Read the candidate path as `details.path ?? details.value ?? undefined` (defensive — the exact field an `external_directory` ask populates is verified at implementation time against a real descriptor; read both).
   Absent → `{ kind: "defer" }`.
3. **Pattern pre-filter.**
   If no compiled `typoPatterns` regex matches the path → `{ kind: "defer" }`.
   No model call — this is the cost gate.
4. **Model confirmation.**
   Call the model with the path + operator `instructions`, bounded by `timeoutMs`.
   Parse the reply into a verdict: a confirmed typo → `{ kind: "deny", reason }`; not a typo, or any failure (no resolvable model, timeout, unparseable reply, uncertain) → `{ kind: "defer" }`.

The `query: PermissionQuery` parameter is accepted (the callback signature requires it) but unused in this slice — the deny-first reviewer decides from the path pattern and the model, not from an engine re-query.
Slice 2 ([#620]) is the consumer that needs it.

### Config shape (zod source of truth)

Per the operator's decision, config validation uses zod as the single source of truth (mirroring pi-permission-system's ADR 0004), with a hand-rolled layered loader (no `@gotgenes/pi-subagents/settings` dependency).

```typescript
// src/config-schema.ts — the zod source of truth
export const modelJudgeConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  instructions: z.string().min(1),
  typoPatterns: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().default(5000),
});

export type ModelJudgeConfig = z.infer<typeof modelJudgeConfigSchema>;
```

- An empty or absent `typoPatterns` means the reviewer defers everything — installing the package and naming it in `authorizerChain` without configuring patterns is a safe no-op (nothing is auto-denied).
- `provider` / `model` name the model to resolve against `ctx.modelRegistry`.
- `instructions` carries the operator's prose describing what a typo path is and the correct-location teaching signal; it becomes the model's system prompt.

### Layered loader

`loadModelJudgeConfig({ cwd, agentDir })` reads two JSON files, project overriding global, following the `extensions/<id>/config.json` convention:

- Global: `<agentDir>/extensions/pi-permission-model-judge/config.json`
- Project: `<cwd>/.pi/extensions/pi-permission-model-judge/config.json`

Each layer is `JSON.parse`d defensively (a malformed file is skipped with a logged warning, not fatal — fail-safe), the two raw objects are shallow-merged (project wins; `typoPatterns` replaces wholesale), and the merged object is validated once with `modelJudgeConfigSchema.safeParse`.
On a validation failure the loader returns `{ config: undefined, issues }` and the extension registers no link (or a link that always defers) — a config error degrades to no auto-deny, never to a wrong deny.

### Model review

```typescript
// src/model-review.ts — call site sketch
async function reviewPath(deps: {
  path: string;
  config: ModelJudgeConfig;
  model: Model<any>;
  complete: CompleteFn; // injected; default = complete from @earendil-works/pi-ai
  signal: AbortSignal; // from an AbortController armed with timeoutMs
}): Promise<AuthorizerVerdict> {
  const context: Context = {
    systemPrompt: deps.config.instructions,
    messages: [{ role: "user", content: renderReviewPrompt(deps.path), timestamp: Date.now() }],
  };
  const reply = await deps.complete(deps.model, context, { signal: deps.signal });
  return parseVerdict(reply); // { verdict: "deny", reason } | { verdict: "defer" }; fail-safe defer
}
```

- The model is instructed to reply with strict JSON — `{"verdict":"deny","reason":"…"}` or `{"verdict":"defer"}` — and `parseVerdict` extracts the assistant text, `JSON.parse`es it, and maps it to an `AuthorizerVerdict`.
  Any parse failure, unexpected shape, a `deny` with no reason substituted by a generic teaching reason, a thrown/aborted `complete`, or an unresolved model → `{ kind: "defer" }`.
- The timeout is a caller-owned `AbortController` armed to `timeoutMs`; on timeout the aborted `complete` rejects and the reviewer defers.

### Model resolution

`resolveJudgeModel(registry, provider, model): Model<any> | undefined` calls `registry.find(provider, model)` against the session `ExtensionContext.modelRegistry` captured at the extension's own `session_start`.
An unresolved model logs a warning and the reviewer defers (fail-safe).
The registry reference is captured in the extension closure at `session_start` and read lazily at `authorize` time — the link is never invoked until a real ask, well after every extension's `session_start`, so lazy capture is safe.

### Extension wiring

```typescript
// src/extension.ts — factory sketch
export function createModelJudgeExtension(pi: ExtensionAPI, deps: Dependencies = {}): void {
  let session: { config?: ModelJudgeConfig; registry?: ModelRegistry } = {};
  let dispose: (() => void) | undefined;

  pi.on("session_start", (_e, ctx) => {
    const { config } = deps.loadConfig(ctx.cwd);
    session = { config, registry: ctx.modelRegistry };
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
    const service = getPermissionsService();
    if (!service || !session.config) return; // no seam / no config → register nothing (fail-safe)
    const authorize = createTypoReviewer({ getSession: () => session, complete: deps.complete });
    dispose = service.registerAuthorizer("model-judge", authorize);
  });

  pi.on("session_shutdown", () => { dispose?.(); dispose = undefined; });
}
```

- The factory takes an optional `Dependencies` bag (`loadConfig`, `complete`) so tests inject fakes — mirroring the `AutoformatExtensionDependencies` pattern; production defaults are the real loader and the real `complete`.
- The event-bus handler receives only `data` (no `ctx`), so `modelRegistry` is captured from the `session_start` `ctx`, not the ready event.

## Module-Level Changes

New package `packages/pi-permission-model-judge/`:

- `src/config-schema.ts` — added: `modelJudgeConfigSchema` (zod), `ModelJudgeConfig` type (`z.infer`), `buildModelJudgeJsonSchema()` (`z.toJSONSchema`).
- `src/config-loader.ts` — added: `loadModelJudgeConfig`, `getGlobalConfigPath`, `getProjectConfigPath`; layered read + shallow merge + `safeParse`; returns `{ config, issues }`.
- `src/typo-patterns.ts` — added: `compileTypoPatterns(strings): RegExp[]` (invalid regex skipped with a logged issue), `matchesAnyTypoPattern(path, patterns): boolean`.
- `src/model-resolver.ts` — added: `resolveJudgeModel(registry, provider, model)`; a minimal `ModelRegistry` structural type (`find`) so no pi-subagents import.
- `src/model-review.ts` — added: `reviewPath`, `renderReviewPrompt`, `parseVerdict`, the injectable `CompleteFn` type.
- `src/typo-reviewer.ts` — added: `createTypoReviewer(deps): Authorizer["authorize"]`; the surface gate + path extraction + pattern pre-filter + model delegation + fail-safe defers.
- `src/extension.ts` — added: `createModelJudgeExtension(pi, deps?)`; session_start config load + registry capture, permissions:ready registration, session_shutdown disposal.
- `src/index.ts` — added: default export `modelJudgeExtension(pi)` delegating to `createModelJudgeExtension`.
- `scripts/generate-schema.ts` — added: regenerates `schemas/model-judge.schema.json` from the zod source; run via `pnpm run gen:schema`.
- `schemas/model-judge.schema.json` — added: generated JSON schema (for editor `$schema` support).
- `config/config.example.json` — added: example config with a sample `typoPatterns` entry and a `$schema` reference.
- `package.json` — added: name `@gotgenes/pi-permission-model-judge`, version `0.0.0`, `type: module`, `pi.extensions: ["./src/index.ts"]`, `imports` (`#src/*` / `#test/*`), `files` allowlist (`src`, `schemas`, `config/config.example.json`, `docs/*.md`, `README.md`, `CHANGELOG.md`, `LICENSE`), scripts (`check`, `test`, `gen:schema`, `lint`, `lint:md`), `dependencies` (`zod` `^4.4.3`), `peerDependencies` (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@gotgenes/pi-permission-system`), `devDependencies` (biome, pi-ai + pi-coding-agent pins, a `@gotgenes/pi-permission-system` pin at the published version that includes the seam, `@types/node`, rumdl, typescript, vitest, zod).
- `tsconfig.json`, `vitest.config.ts` — added: extend `../../tsconfig.base.json`; the `#src`/`#test` alias config (mirroring pi-autoformat).
- `README.md` — added: what the package does, the config split, the `authorizerChain` opt-in, config reference, the fail-safe posture.
- `docs/configuration.md` — added: full config-field reference (provider, model, instructions, typoPatterns, timeoutMs) with the example.
- `LICENSE`, `AGENTS.md` — added: LICENSE copied from a sibling; a short `AGENTS.md` pointer.

Monorepo wiring (root):

- `release-please-config.json` — added: `packages/pi-permission-model-judge` component; `packages/pi-permission-model-judge/docs/plans` and `.../docs/retro` to `exclude-paths`.
- `.release-please-manifest.json` — added: `packages/pi-permission-model-judge` at `0.0.0`.
- `.pi/settings.json` — added: `../packages/pi-permission-model-judge` load path; the `{ "source": "npm:@gotgenes/pi-permission-model-judge", "extensions": [], "skills": [] }` disable entry.
- `README.md` (root) — added: the package to the Packages table; to the no-dedicated-skill note (this package ships no `package-*` skill).

Nothing in `packages/pi-permission-system/` or `packages/pi-subagents/` changes.
The pi-permission-system roadmap step-mark for Step 6 is owned by that package's architecture doc; this plan does **not** mark it complete — that is a pi-permission-system doc-update concern, and this package's landing does not edit a sibling's docs. (Recorded as an Open Question so the roadmap `✅` is not silently dropped.)

## Test Impact Analysis

This is a new package, not an extraction or refactor.

1. **New tests enabled.**
   Every unit is new and unit-testable behind injected seams: config-schema/loader (validation, layering, malformed-JSON tolerance, defaults), typo-pattern compile/match (including an invalid-regex skip), model-review (fake `complete` — deny+reason, defer, timeout→defer, parse-failure→defer, unresolved-model→defer), typo-reviewer (surface gate defers non-`external_directory`; absent path defers; no-pattern-match defers without a model call; matched path calls the model), and extension wiring (a fake `pi` + a fake published `PermissionsService` in the Symbol.for slot: asserts `registerAuthorizer("model-judge", …)` is called on `permissions:ready`, and the disposer runs on `session_shutdown`).
2. **Redundant existing tests.**
   None — no prior tests exist for this package.
3. **Tests that must stay.**
   N/A.

## Invariants at risk

None in this package (it is new).
The seam it consumes carries invariants pinned by **pi-permission-system's** tests, which this plan does not touch:

- The delegation envelope never tightens a `deny`/`defer` and passes an `external_directory` `deny` through — pinned by `delegation-envelope` tests in pi-permission-system.
- `composeAuthorizerChain` maps a `deny` verdict to a denied decision carrying `reason` — pinned by `authorizer-chain` tests there.

This package relies on those invariants but must not (and does not) change them.
A risk to guard is the field an `external_directory` ask populates (`path` vs `value` vs `accessIntent`): the reviewer reads defensively and a wiring test asserts the reviewer sees the path a realistic descriptor carries.

## TDD Order

Each cycle is red → green → commit.
Scaffolding (package.json, tsconfig, vitest.config) lands with the first tested unit so the suite can run.

1. **Package scaffold + config schema/loader** (`test:` then `feat:`).
   Red: `test/config-loader.test.ts` — zod defaults, project-overrides-global layering, malformed-JSON tolerance, invalid-config → `{ config: undefined, issues }`.
   Green: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config-schema.ts`, `src/config-loader.ts`.
   Commit: `feat(pi-permission-model-judge): zod config schema and layered loader`.
2. **Typo-pattern matching** (`feat:`).
   Red: `test/typo-patterns.test.ts` — match/no-match, invalid-regex skipped, empty-patterns matches nothing.
   Green: `src/typo-patterns.ts`.
   Commit: `feat(pi-permission-model-judge): typo-pattern compilation and matching`.
3. **Model review** (`feat:`).
   Red: `test/model-review.test.ts` (fake `complete`) — deny+reason, defer, timeout→defer, parse-failure→defer, deny-without-reason→generic reason.
   Green: `src/model-review.ts`, `src/model-resolver.ts`.
   Commit: `feat(pi-permission-model-judge): model confirmation of typo paths`.
4. **Typo reviewer** (`feat:`).
   Red: `test/typo-reviewer.test.ts` (fake session + fake `complete`) — non-`external_directory` defers without a model call; absent path defers; no-pattern-match defers without a model call; matched path calls the model and returns its verdict; unresolved model defers.
   Green: `src/typo-reviewer.ts`.
   Commit: `feat(pi-permission-model-judge): deny-first external_directory reviewer`.
5. **Extension wiring** (`feat:`).
   Red: `test/extension.test.ts` (fake `pi` + fake published `PermissionsService`) — `permissions:ready` registers `"model-judge"`; no service or no config registers nothing; `session_shutdown` disposes.
   Green: `src/extension.ts`, `src/index.ts`.
   Commit: `feat(pi-permission-model-judge): register the model-judge link on permissions:ready`.
6. **Generated JSON schema + example** (`feat:`).
   Red: `test/config-schema.test.ts` — parity between `schemas/model-judge.schema.json` and `buildModelJudgeJsonSchema()`; `config/config.example.json` validates against the schema.
   Green: `scripts/generate-schema.ts`, `schemas/model-judge.schema.json`, `config/config.example.json`, `gen:schema` script.
   Commit: `feat(pi-permission-model-judge): ship generated config JSON schema and example`.
7. **User docs** (`docs:`).
   `README.md`, `docs/configuration.md`, `AGENTS.md`, `LICENSE`.
   Commit: `docs(pi-permission-model-judge): package README and configuration reference`.
8. **Monorepo wiring** (`build:`).
   `release-please-config.json` (component + exclude-paths), `.release-please-manifest.json`, `.pi/settings.json` (load path + npm disable entry), root `README.md` packages table.
   Run `pnpm fallow dead-code` and a `pnpm pack` allowlist inspection before committing.
   Commit: `build(pi-permission-model-judge): wire the package into the monorepo`.

## Risks and Mitigations

- **Seam not yet published.**
  This package peer/dev-depends on a `@gotgenes/pi-permission-system` version that includes `registerAuthorizer` ([#599]).
  Under `linkWorkspacePackages: false` the dev pin resolves from the registry, so the seam must be in a published version.
  Mitigation: at implementation time verify `npm view @gotgenes/pi-permission-system` (currently `20.9.0`) exports `registerAuthorizer`, and pin the devDependency to that version; if unpublished, land this package's release after pi-permission-system's.
- **Two module copies of pi-permission-system.**
  Pi loads the workspace extension; this package imports a registry copy for the accessor.
  Mitigation: the accessor reads a process-global `Symbol.for()` slot, so both copies see the same published service — this is the design intent, covered by a wiring test that publishes into the slot from a fake and asserts the link registers.
- **A model call on every ask would degrade prompt latency.**
  Mitigation: the surface gate and the pattern pre-filter both short-circuit to `defer` before any model call; only a matched `external_directory` path incurs a round-trip.
- **A wrong deny blocks a legitimate access.**
  Mitigation: a deny is recoverable (the agent self-corrects on the teaching reason), and the whole reviewer is opt-in (the operator must name `"model-judge"` in `authorizerChain` and configure `typoPatterns`); ships off by default.
- **devDependencies copied from a sibling carry unused entries.**
  Mitigation: run `pnpm fallow dead-code` locally before pushing (CI gates on it), and prune the copied bag.
- **Config-file provenance drift.**
  The `extensions/<id>/config.json` path and the model-mechanism-here / policy-there split must match the ADR.
  Mitigation: `docs/configuration.md` and the example are the single documented surface; the zod schema is the validation source of truth.

## Open Questions

- **Plan/retro home for a brand-new package.**
  This plan and its retro live in `packages/pi-permission-model-judge/docs/{plans,retro}/` — the package owns its history — even though the roadmap step lives in pi-permission-system's architecture doc.
  The wiring step adds both paths to `exclude-paths` so these `docs:` commits never cut a release.
- **The pi-permission-system roadmap `✅` for Step 6.**
  Marking Phase 12 Step 6 complete (heading + Mermaid node + `Landed:` note) is a pi-permission-system doc edit, not a change this package makes.
  Confirm at ship time whether to fold that one-line roadmap mark into this issue's landing (a small cross-package doc touch) or track it as a pi-permission-system follow-up; do not silently drop it.
- **`reviewSurfaces` generalization.**
  Slice 1 hardcodes `external_directory`.
  If a later use case needs the reviewer on other surfaces, add a `reviewSurfaces: string[]` config field then — not now.
- **Structured model output.**
  This slice parses strict-JSON assistant text with a fail-safe defer.
  If reliability warrants it, a future revision could use pi-ai's typebox tool/structured-output surface; deferred as a mechanism-tuning concern.

[#267]: https://github.com/gotgenes/pi-packages/issues/267
[#599]: https://github.com/gotgenes/pi-packages/issues/599
[#620]: https://github.com/gotgenes/pi-packages/issues/620
[docs/decisions/0007-model-judge-authorizer-chain-adr.md]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/decisions/0007-model-judge-authorizer-chain-adr.md
