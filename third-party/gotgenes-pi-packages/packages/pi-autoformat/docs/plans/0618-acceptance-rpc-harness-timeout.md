---
issue: 618
issue_title: "pi-autoformat: real-CLI acceptance tests flake under concurrent workspace test runs"
---

# Raise the real-CLI acceptance harness timeout (env-overridable)

## Release Recommendation

**Release:** ship independently

This issue is not part of any architecture roadmap or release batch, so it ships on its own cadence.
The substantive change is `test:`-scoped (the RPC harness), which is a `hidden` changelog type and does not cut a release by itself.
The accompanying `docs(pi-autoformat):` update to the shipped `docs/testing.md` is an unhidden type that carries the release, with the harness change batched alongside.
There is no runtime behavior change — only test infrastructure and its documentation.

## Problem Statement

The two real-`pi`-CLI acceptance tests (`test/acceptance.test.ts` and `test/acceptance-event-bus.test.ts`) intermittently fail with `pi rpc session timed out after 10000ms` when the whole workspace suite runs concurrently via `pnpm run test` (`pnpm -r run test`).
A standalone `pnpm --filter @gotgenes/pi-autoformat exec vitest run` is reliably green.
The harness in `test/helpers/rpc.ts` spawns a real `pi` child process per case and rejects after a fixed `timeoutMs = 10_000`.
Under `pnpm -r run test`, every package's vitest process runs at once, so these real-process spawns contend for CPU/IO and blow the 10 s budget.
This is a recurring false red on the root suite (observed in the #596 and #597 retros), not a correctness bug — the extension works.

## Goals

- Eliminate the RPC-timeout false red on the concurrent root suite by giving the real-CLI spawns enough headroom for a loaded machine.
- Make the harness timeout overridable via an environment variable so CI (or a slow local box) can tune it without a code change.
- Preserve the invariant that the Vitest per-test timeout stays larger than the harness `timeoutMs`, so a genuine hang surfaces the harness's descriptive error (with captured stdout/stderr) rather than Vitest's generic kill.

## Non-Goals

- Retrying the RPC spawn on timeout (issue direction B) — not chosen; noted as a future lever if a raised timeout proves insufficient.
- Isolating/serializing the acceptance tests into a separate vitest pool/project (issue direction C) — the contention is cross-package (separate vitest processes under `pnpm -r`), so in-package serialization would not fully address it; deferred.
- Any change to `src/` runtime code — the extension behavior is unchanged.
- Any change to the fallback acceptance test (`test/fallback-acceptance.test.ts`), which does not spawn the real CLI.
- A workspace-level (vitest projects / root `pnpm -r` concurrency) serialization change — larger, separate effort; not filed.

## Background

- `test/helpers/rpc.ts` — `runRpcSession()` defaults `timeoutMs = 10_000`; on timeout it `SIGKILL`s the child and rejects with a message embedding stdout/stderr.
- `test/acceptance.test.ts` — one `it()` that calls `runRpcSession()` with the default harness timeout; its Vitest per-test timeout is the literal `15_000`.
- `test/acceptance-event-bus.test.ts` — one `it()` that passes an explicit `timeoutMs: 15_000` to `runRpcSession()`; its Vitest per-test timeout is the literal `20_000`.
- `test/fallback-acceptance.test.ts` — an "acceptance" anchor that does **not** use the real CLI; out of scope.
- Prior work: issue #67 raised only the Vitest per-test timeout of `acceptance.test.ts` to 15 s; it deliberately left the harness `timeoutMs` default at 10 s ("Non-Goals: Changing `runRpcSession`'s internal `timeoutMs` default").
  That is exactly the timeout firing now — #618 revisits the decision #67 deferred.
- `pnpm run test` at the repo root is `pnpm -r run test`; there is no vitest workspace, so each package's vitest runs as its own process concurrently.
- Env-var convention in this package's tests is the `PI_AUTOFORMAT_` prefix (`PI_AUTOFORMAT_RECORDER_LOG`, and the future `PI_AUTOFORMAT_LLM_TESTS` named in `docs/testing.md`), so the new knob follows it: `PI_AUTOFORMAT_RPC_TIMEOUT_MS`.
- `docs/testing.md` is shipped (the `package.json` `files` allowlist includes `docs/*.md`, and `README.md` links to it), so documenting the knob there reaches the published tarball.
- Per the `package-pi-autoformat` skill: "read `process.env` inside functions rather than capturing it as a module-level constant" — the resolver takes `env` as a parameter defaulting to `process.env`, keeping it unit-testable.

## Design Overview

Replace the hardcoded `10_000` harness default with a small resolver seam in `test/helpers/rpc.ts`, and derive each acceptance file's Vitest per-test timeout from that same resolver plus a fixed margin.
Deriving both timeouts from one source makes the "Vitest budget > harness budget" invariant structural rather than a pair of hand-tuned literals that #67 kept in sync only by eye.

```typescript
// test/helpers/rpc.ts
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const RPC_VITEST_TIMEOUT_MARGIN_MS = 5_000;

/**
 * Harness timeout for a real-`pi` RPC spawn. Reads
 * `PI_AUTOFORMAT_RPC_TIMEOUT_MS` (a positive integer, in ms); any unset,
 * non-numeric, zero, or negative value falls back to the raised default.
 */
export function resolveRpcTimeoutMs(env: NodeJS.ProcessEnv = process.env): number;

/**
 * Vitest per-test budget for an acceptance case: always the resolved
 * harness timeout plus a margin, so the harness's descriptive timeout
 * error surfaces before Vitest kills the test.
 */
export function rpcVitestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number;
```

`runRpcSession`'s default parameter becomes `timeoutMs = resolveRpcTimeoutMs()` (evaluated per call, so it honors the env at spawn time).
The acceptance `it()` calls pass `rpcVitestTimeoutMs()` as their per-test timeout argument instead of the literals `15_000` / `20_000`.
`acceptance-event-bus.test.ts` drops its explicit `timeoutMs: 15_000` argument to `runRpcSession()` so it inherits the resolved default.

Validation semantics for `resolveRpcTimeoutMs`: parse the raw env string; accept it only when it resolves to a finite integer `> 0`; otherwise fall back to `DEFAULT_RPC_TIMEOUT_MS`.
This keeps a typo (`PI_AUTOFORMAT_RPC_TIMEOUT_MS=30s`, empty string, `0`, negative) from silently producing a nonsense timeout.

Consumer call sites (verify Tell-Don't-Ask / no leaked state — both are pure reads):

```typescript
// test/acceptance.test.ts
it("loads the extension and answers an rpc get_state command", async () => {
  const { responses } = await runRpcSession({ cwd: workDir, commands: [...] });
  // ...assertions...
}, rpcVitestTimeoutMs());

// test/acceptance-event-bus.test.ts
const { exitCode } = await runRpcSession({
  cwd: workDir,
  extraExtensions: [FIXTURE_EXTENSION],
  commands: [{ id: "1", type: "prompt", message: `/emit-touched ${targetPath}` }],
  // no explicit timeoutMs — inherits resolveRpcTimeoutMs()
});
// ...
}, rpcVitestTimeoutMs());
```

Edge cases:

- Env unset → `30_000` harness, `35_000` Vitest.
- `PI_AUTOFORMAT_RPC_TIMEOUT_MS=60000` → `60_000` harness, `65_000` Vitest (invariant holds by construction).
- Invalid value → default, invariant holds.

Tradeoff: a genuine hang now takes 30 s (not 10 s) to fail, tripling worst-case feedback time on a true regression.
This is acceptable for a rarely-hanging smoke test, and the env override lets a developer lower it locally.

## Module-Level Changes

1. `test/helpers/rpc.ts`
   - Add `DEFAULT_RPC_TIMEOUT_MS = 30_000` and `RPC_VITEST_TIMEOUT_MARGIN_MS = 5_000` module constants.
   - Add exported `resolveRpcTimeoutMs(env = process.env)` and `rpcVitestTimeoutMs(env = process.env)`.
   - Change `runRpcSession`'s destructured default from `timeoutMs = 10_000` to `timeoutMs = resolveRpcTimeoutMs()`.
2. `test/helpers/rpc.test.ts` (new)
   - Unit tests for `resolveRpcTimeoutMs` (default, valid override, invalid/zero/negative/empty fallback) and `rpcVitestTimeoutMs` (default + margin, reflects override, and the ordering invariant `rpcVitestTimeoutMs(env) > resolveRpcTimeoutMs(env)`).
3. `test/acceptance.test.ts`
   - Import `rpcVitestTimeoutMs` from `./helpers/rpc`; replace the literal `15_000` per-test timeout with `rpcVitestTimeoutMs()`.
4. `test/acceptance-event-bus.test.ts`
   - Import `rpcVitestTimeoutMs`; remove the explicit `timeoutMs: 15_000` passed to `runRpcSession()`; replace the literal `20_000` per-test timeout with `rpcVitestTimeoutMs()`.
5. `docs/testing.md`
   - Add a short "Timeouts" subsection under "Acceptance tests" documenting the 30 s harness default, the `PI_AUTOFORMAT_RPC_TIMEOUT_MS` override, and the Vitest-budget-derives-from-harness invariant.

No `src/` files change.
Grep confirms the removed literals (`10_000` harness default, `15_000`/`20_000` acceptance Vitest budgets, and the explicit `timeoutMs: 15_000` event-bus argument) have no other callers; `PI_AUTOFORMAT_RPC_TIMEOUT_MS` is a new name with no existing references in `src/`, `test/`, or docs.

## Test Impact Analysis

1. New tests enabled: the timeout was previously a hardcoded literal with no seam.
   Extracting `resolveRpcTimeoutMs` / `rpcVitestTimeoutMs` as pure, `env`-parameterized functions makes env-override parsing and the ordering invariant unit-testable for the first time (`test/helpers/rpc.test.ts`).
2. Redundant tests: none — no existing test asserted the old `10_000` literal.
3. Must stay as-is: both acceptance `it()` blocks still spawn the real CLI and assert the same runtime behavior; only the source of their timeout numbers changes.

## Invariants at risk

- #67's invariant — "the Vitest per-test timeout must exceed `runRpcSession`'s harness `timeoutMs` so the harness error (with stdout/stderr) surfaces on a genuine hang" — lived only in the #67 plan prose, pinned by no test.
  This plan converts it to a structural guarantee (`rpcVitestTimeoutMs = resolveRpcTimeoutMs + margin`) and adds a unit assertion `rpcVitestTimeoutMs(env) > resolveRpcTimeoutMs(env)` (including under an env override) in `test/helpers/rpc.test.ts`, so a future edit that inverts the ordering fails loudly.

## TDD Order

1. **Red → Green** — harness resolver seam.
   - Surface: `test/helpers/rpc.test.ts` (new) against `test/helpers/rpc.ts`.
   - Red: assert `resolveRpcTimeoutMs()` returns `30_000` by default, honors a valid `PI_AUTOFORMAT_RPC_TIMEOUT_MS`, falls back on invalid/zero/negative/empty; assert `rpcVitestTimeoutMs()` is the resolved value plus the margin and is strictly greater than the resolved harness value.
   - Green: add the two constants and two exported resolvers; change `runRpcSession`'s default to `timeoutMs = resolveRpcTimeoutMs()`.
   - Verify: `pnpm --filter @gotgenes/pi-autoformat exec vitest run test/helpers/rpc.test.ts` and `pnpm --filter @gotgenes/pi-autoformat run check`.
   - Commit: `test(pi-autoformat): env-overridable RPC harness timeout (#618)`
2. **Green (wiring)** — consume the resolver in the acceptance files.
   - Surface: `test/acceptance.test.ts`, `test/acceptance-event-bus.test.ts`.
   - Change: import `rpcVitestTimeoutMs`; replace the `15_000` / `20_000` per-test literals with `rpcVitestTimeoutMs()`; drop the explicit `timeoutMs: 15_000` in the event-bus `runRpcSession()` call.
   - Verify: run both acceptance files standalone — `pnpm --filter @gotgenes/pi-autoformat exec vitest run test/acceptance.test.ts test/acceptance-event-bus.test.ts` — green.
   - Commit: `test(pi-autoformat): derive acceptance vitest budgets from harness timeout (#618)`
3. **Docs** — document the knob.
   - Surface: `docs/testing.md`.
   - Change: add the "Timeouts" subsection (30 s default, `PI_AUTOFORMAT_RPC_TIMEOUT_MS` override, budget-derivation invariant).
   - Verify: `pnpm exec rumdl check packages/pi-autoformat/docs/testing.md`.
   - Commit: `docs(pi-autoformat): document RPC harness timeout override (#618)`

## Risks and Mitigations

| Risk                                                                                                | Mitigation                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30 s still flakes under extreme concurrent load.                                                    | `PI_AUTOFORMAT_RPC_TIMEOUT_MS` lets CI raise it without a code change; retry-once (direction B) remains a documented future lever in Non-Goals.           |
| A genuine hang now takes 30 s to fail, slowing feedback on a real regression.                       | Acceptable for a rarely-hanging smoke test; a developer can lower the env var locally, and the harness still emits stdout/stderr on the eventual timeout. |
| A typo in the env var name/value silently yields a nonsense timeout.                                | `resolveRpcTimeoutMs` validates (finite integer `> 0`) and falls back to the default; the exact name is documented in `docs/testing.md` and unit-tested.  |
| The root cause — cross-package process contention under `pnpm -r` — is only mitigated, not removed. | Explicitly scoped out; a workspace-level serialization is a larger, separate effort noted in Non-Goals.                                                   |

## Open Questions

None.
