---
issue: 91
issue_title: "Auto-reindex on session start and file mutations"
---

# Retro: #91 — Auto-reindex on session start and file mutations

## Final Retrospective (2026-05-22T22:35:00Z)

### Session summary

Planned, implemented (9 TDD cycles), shipped, and released `pi-colgrep-v1.2.0` in a single session with no user intervention during implementation.
The reindexer module (`src/lib/reindex.ts`) is SDK-free with injected `Exec` and `onStatus` callbacks, making the 24-test unit suite straightforward with fake timers and plain mocks.
Extension wiring added `session_start` reindex, `tool_result` debounced scheduling for `write`/`edit`, `/colgrep-reindex` command, and `session_shutdown` cleanup.

### Observations

#### What went well

- The plan's 9-cycle TDD order executed without deviation — each cycle produced exactly the tests and code anticipated, with no backtracking or replanning.
- The `makeHeldExec()` pattern (a mock returning a promise whose resolution is manually controlled) proved effective for testing the in-flight queuing state machine — tests assert intermediate state (only 1 exec while in-flight), resolve the held promise, then verify drain behavior.
- The `TestPi` stub class in `test/extension.test.ts` captured event handlers and commands cleanly, letting tests drive the full extension lifecycle without SDK dependencies.

#### What caused friction (agent side)

- `missing-context` — In Cycle 7, the test file used `afterEach` without importing it.
  The first test run failed with `ReferenceError: afterEach is not defined`.
  I had imported `beforeEach` in the original file but didn't check imports before adding code that uses `afterEach`.
  Impact: one extra test run to diagnose and fix; no rework.

- `missing-context` — In Cycles 8 and 9, the `Edit` tool failed to match `oldText` in `test/extension.test.ts` because autoformatting had collapsed multi-line `pi.trigger(...)` calls into single lines after the previous commit.
  I did not re-read the file after the `[autoformat]` notification to get the canonical text before attempting the next edit.
  Both times I fell back to `cat >>` (bash append), which works but bypasses the Edit tool's exact-match safety.
  Impact: two extra tool calls per cycle (failed Edit + bash fallback); no rework in commits.

#### What caused friction (user side)

- No friction observed — the session ran autonomously from plan through release with no corrective interventions needed.
