# Testing

`pi-autoformat` ships three layers of tests:

1. Unit tests under `test/*.test.ts` — fast, hermetic, cover individual modules (config loader, formatter executor, prompt autoformatter, shell mutation detector, etc.).
2. Acceptance tests that spawn the real `pi` CLI in `--mode rpc` — covered below.
3. (Future) LLM-gated acceptance tests — designed but not yet implemented.

## Running the suites

Vitest splits this package into two projects, so the tests that spawn the real `pi` CLI stay off the default path.

| Command                    | Runs                                                      |
| -------------------------- | --------------------------------------------------------- |
| `pnpm test`                | the `unit` project — everything except the real-CLI tests |
| `pnpm run test:acceptance` | the `acceptance` project — the real-CLI tests only        |
| `pnpm run test:all`        | both projects                                             |

The unit project finishes in about a second; the acceptance project takes roughly 25 s, nearly all of it waiting on real `pi` startups.

That split exists for reliability, not just speed.
Each real-CLI case spawns a `pi` child process, and under the workspace-wide `pnpm -r run test` at the repo root every package's vitest runs at once.
The resulting module-import storm starves those spawns until they exceed the harness timeout, producing a recurring false red in a package the session never touched (issue #678).
Raising the timeout was tried twice and bought only headroom, so the spawns now live in a project the default run does not execute.

CI still runs them on every push and pull request, in a dedicated `Real-CLI acceptance tests (pi-autoformat)` step that follows the concurrent workspace suite — alone on the runner, with nothing to contend with.

Vitest does not type-check.
For type-only changes use:

```bash
pnpm run check
```

## Acceptance tests

Files: `test/acceptance.test.ts`, `test/acceptance-event-bus.test.ts`, `test/fallback-acceptance.test.ts`.

Acceptance tests spawn the real `pi` binary in `--mode rpc` and assert behavior against actual Pi runtime events.
They catch regressions that pure unit tests cannot: extension load failures, payload-shape drift on real Pi events, and EventBus contract drift.

Only the first two spawn the CLI, and they are the two the `acceptance` project runs.
`test/fallback-acceptance.test.ts` is an acceptance-style anchor that spawns nothing, so it stays in the default `unit` project despite its name.

### Which files are segregated

`test/acceptance-files.ts` exports `ACCEPTANCE_FILES`, the single source of truth that both projects in `vitest.config.ts` consume.
The list is explicit rather than a glob precisely because of `fallback-acceptance.test.ts` — a pattern such as `*acceptance*` would capture it.

`test/project-partition.test.ts` guards that list.
It scans every `test/**/*.test.ts` for a `runRpcSession(` call and fails when that set differs from `ACCEPTANCE_FILES`.
Adding a real-CLI test without listing it therefore fails immediately, rather than resurfacing weeks later as a load flake in someone else's package.

### Resolving the `pi` binary

`@earendil-works/pi-coding-agent` is a `devDependency` of this package, and `pnpm install` produces a working `node_modules/.bin/pi`.
The shared harness in `test/helpers/rpc.ts` resolves `pi` from that path explicitly rather than relying on the global `PATH`:

```typescript
export const PI_BIN = resolve("node_modules/.bin/pi");
export const piAvailable = existsSync(PI_BIN);
```

Benefits:

- CI gets a working binary from the existing `pnpm install --frozen-lockfile` step, so the acceptance step needs no setup of its own.
- The Pi version is pinned by `pnpm-lock.yaml`, so CI and local runs use the same binary.
- Contributors who ran `pnpm install` get the acceptance suite for free; no separate global install.

### Skip semantics

`describeIfPi` is a safety net: it skips when `node_modules/.bin/pi` is missing (for example, after a partial checkout without `pnpm install`).
In normal usage every contributor who runs `pnpm run test:acceptance` or `pnpm run test:all` exercises them.

### Timeouts

Each acceptance test spawns a real `pi` child process via `runRpcSession`, which rejects with a descriptive error (including captured stdout/stderr) if the process does not close stdin within a harness timeout.
`test/helpers/rpc.ts` resolves that timeout with `resolveRpcTimeoutMs()`, which defaults to `30_000` ms. Set `PI_AUTOFORMAT_RPC_TIMEOUT_MS` (a positive integer, in ms) to override the default — for example, on a CI runner or local machine under heavier concurrent load than the default tolerates.
An unset, non-numeric, non-integer, zero, or negative value falls back to the default.

Each acceptance test's own Vitest per-test timeout is derived from the same source via `rpcVitestTimeoutMs()` (the resolved harness timeout plus a fixed margin), so it always exceeds the harness timeout.
This ordering matters: it ensures the harness's descriptive timeout error surfaces on a genuine hang, rather than Vitest's generic kill message.
Raising `PI_AUTOFORMAT_RPC_TIMEOUT_MS` raises both budgets together, preserving the invariant.

The budget is a backstop, not the defense against load.
Segregating these tests into their own project is what keeps them off a contended machine; the timeout exists to turn a genuine hang into a readable error.
If a slow CI runner ever needs more room, set `PI_AUTOFORMAT_RPC_TIMEOUT_MS` on the acceptance step in `.github/workflows/ci.yml` rather than raising the default in code.

### Test fixtures

`test/fixtures/` holds small companion extensions and helpers used by the acceptance suite:

- `event-bus-emitter.ts` — registers `/emit-touched <path...>` and forwards the paths onto the `autoformat:touched` channel via `pi.events.emit`.
- `formatter-recorder.mjs` — a stand-in "formatter" that appends `{ argv, cwd }` to the file pointed at by the `PI_AUTOFORMAT_RECORDER_LOG` env var.
  Tests configure this script as the formatter command and read the log to assert what Pi actually invoked.

### EventBus acceptance test

`test/acceptance-event-bus.test.ts` exercises the production extension's `pi.events` subscription end to end:

1. Writes a project config that wires the recorder formatter to `.ts` files and sets `formatMode: "session"` so the flush runs on session shutdown.
2. Loads `src/extension.ts` and `event-bus-emitter.ts` together via `-e` flags.
3. Sends `{ type: "prompt", message: "/emit-touched <path>" }` over RPC.
4. Closes stdin; `session_shutdown` triggers the flush.
5. Reads the recorder log and asserts the formatter ran on the emitted absolute path.

This test is the primary safeguard against EventBus payload-shape drift between this extension and Pi.

## What is *not* covered by the default suite

Several scenarios named in issue #10 are not in the default acceptance suite because Pi's RPC mode does not surface the events they depend on:

- **`bash` shell mutation.**
  Pi's RPC `bash` command stores a `BashExecutionMessage` for the next prompt's LLM context but does not emit `tool_call` or `tool_result` events.
  Our extension's snapshot tracker is wired to those events, so an RPC `bash` command does not drive the shell-mutation path.
  Coverage today: `test/shell-mutation-detector.test.ts` (unit).
- **`write` / `edit` payload-shape validation.**
  These tools are only invoked by the LLM; there is no documented non-LLM trigger.
  Coverage today: `test/extension.test.ts` (integration with a stubbed `ExtensionAPI`).
- **`customMutationTools` real `tool_result` events.**
  Same constraint as `write`/`edit`: the registered tool only fires when an LLM calls it.
  Coverage today: `test/custom-mutation-tools.test.ts` (unit).

These gaps are real but bounded.
The unit / integration tests pin the handler logic; the EventBus acceptance test pins the runtime wiring; LLM-gated tests (below) will eventually pin the tool-result payload contract.

## LLM-gated acceptance suite (future)

The natural way to drive `bash` / `write` / `edit` / `customMutationTools` end to end is to send a real `prompt` and let an LLM call the tool.
Like the real-CLI suite above, these stay out of `pnpm test` — but for different reasons:

- requires a provider API key,
- costs money,
- is non-deterministic.

When implemented, these tests will live under `test/acceptance-llm/` and skip unless `PI_AUTOFORMAT_LLM_TESTS=1` is set in the environment plus the relevant provider credential (e.g. `ANTHROPIC_API_KEY`).
They will not run in default CI; an explicit, manually triggered workflow may run them on a schedule.
