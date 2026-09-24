---
issue: 67
issue_title: "fix: acceptance test times out on slow CI runners"
---

# Fix Acceptance Test Timeout on Slow CI Runners

## Problem Statement

The acceptance test in `test/acceptance.test.ts` spawns the real `pi` CLI via `runRpcSession`, which carries an internal 10 s timeout.
Vitest's default test timeout is 5 s, so on loaded CI runners the test can be killed by Vitest before the harness timeout ever fires.
This produces spurious failures on unrelated PRs.

## Goals

- Eliminate flaky timeouts in the acceptance test on slow CI runners.
- Keep the Vitest timeout larger than `runRpcSession`'s internal `timeoutMs` so the harness error message (with stdout/stderr) is surfaced on genuine hangs.
- Do not increase timeouts for unit tests, which should remain fast.

## Non-Goals

- Changing `runRpcSession`'s internal `timeoutMs` default.
- Adding new acceptance tests or expanding coverage.
- Refactoring the RPC harness.

## Background

- `test/acceptance.test.ts` contains a single `it()` block that calls `runRpcSession({ cwd: workDir, commands: [...] })`.
- `runRpcSession` (in `test/helpers/rpc.ts`) defaults `timeoutMs` to `10_000`.
- `vitest.config.ts` does not set a global `testTimeout`, so Vitest falls back to its 5 s default.
- The acceptance test deliberately skips when `node_modules/.bin/pi` is missing, so the timeout issue only manifests when the binary is present and the runner is slow.

## Design Overview

Pass an explicit per-test timeout of `15_000` ms to the acceptance `it()` call.
This is the most targeted fix: unit tests keep the 5 s default, and only the one RPC-spawning test receives the longer leash.
The chosen value (`15_000`) exceeds `runRpcSession`'s `10_000` ms internal timeout by a comfortable margin, ensuring that genuine hangs are reported by the harness rather than by Vitest.

An alternative is to set `testTimeout` in `vitest.config.ts`, but that would widen the timeout for the entire package and could mask slow unit tests.
The per-test approach is preferred.

## Module-Level Changes

1. `test/acceptance.test.ts`
   - Add `15_000` as the third argument to the `it()` call.

No other files change.

## Test Impact Analysis

- No new tests are added; this is a configuration fix for an existing test.
- No existing tests become redundant.
- All existing unit tests remain unchanged and retain the default 5 s timeout.

## TDD Order

1. **Red → Green**
   - Surface: `test/acceptance.test.ts`
   - Change: add `15_000` timeout argument to the acceptance `it()` block.
   - Verify locally with `pnpm vitest run test/acceptance.test.ts`.
   - Commit message: `fix: increase acceptance test timeout to avoid CI flakiness (#67)`

## Risks and Mitigations

| Risk                                                   | Mitigation                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 15 s timeout still flakes on extremely slow runners. | The value is 1.5× the harness timeout; if CI degrades further, we can revisit, but the root cause would likely be infrastructure, not test config.                                                    |
| Future acceptance tests forget to add the timeout.     | Document the convention in this plan; if more acceptance tests are added, consider extracting a shared `itAcceptance` helper or moving to a dedicated `vitest.config.ts` in an acceptance sub-folder. |

## Open Questions

None.
