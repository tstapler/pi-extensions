---
issue: 554
issue_title: "pi-session-tools: first test in read-session*/read-parent-session/list-session-files test files intermittently exceeds 5s testTimeout"
---

# Retro: #554 — pi-session-tools first test intermittently exceeds 5s testTimeout

## Stage: Planning (2026-07-07T00:00:00Z)

### Session summary

Planned a test-only fix for the intermittent 5s `testTimeout` flake in four `pi-session-tools` tool test files.
The root cause is a per-test `await import("#src/index")` inside every `it()` block; `src/index.ts` transitively pulls the heavy `@earendil-works/*` packages, and that transform/resolve cost (78–98% of the 5000ms budget) is paid inside the timed region on the first test of each isolated file.
The plan moves the import to a single static top-level `import sessionTools from "#src/index"`, shifting the cost to vitest's collection phase (outside `testTimeout`).

### Observations

- The fix hinges on vitest hoisting `vi.mock("node:fs", …)` and `vi.hoisted(...)` above a static import — verified as documented default behavior, but the plan's Step 1 converts one mocked file (`read-session-file.test.ts`) in isolation to confirm empirically before rolling across the other three.
- Scope confirmed as **single-package** despite two `pkg:*` labels (`pkg:pi-permission-system`, `pkg:pi-session-tools`).
  The `pi-permission-system` label reflects that the flaking CI runs happened to ship `pi-permission-system` changes; the actual fix is entirely in `pi-session-tools` test files.
- Only the four files importing `#src/index` ride the edge (confirmed by grep).
  `session-file.test.ts` uses per-test dynamic imports too but of `#src/session-file`, which pulls only node built-ins — left out of scope.
- Rejected the issue's fallback options (`testTimeout` bump / `beforeAll` hook) as Non-Goals; the primary fix removes the cost from the timed region entirely, so a timeout override would only mask the underlying edge.
- `test:` commits are a `hidden` changelog type, so this ships independently but will not cut a release on its own — it auto-batches into the next release.

## Stage: Implementation — TDD (2026-07-07T16:50:00Z)

### Session summary

Implemented both TDD steps from the plan: converted `read-session-file.test.ts` first (in isolation) to a static top-level `import sessionTools from "#src/index"`, verified the hoisted `vi.mock("node:fs", …)` still applies, then rolled the same mechanical change across `read-parent-session.test.ts`, `list-session-files.test.ts`, and `read-session.test.ts`.
Two `test:` commits, both `(#554)`.
Test count unchanged at 110 (8 files) before and after; no production `src/` files touched.

### Observations

- The plan's central empirical assumption held exactly as predicted: vitest hoists `vi.mock()`/`vi.hoisted()` above a static `import`, so every mock-dependent assertion in the three mocked files kept passing after the import moved to module scope.
- No deviations from the plan — both steps applied cleanly with no unanticipated test breakage, and `grep -rn 'await import("#src/index")' test/` confirmed zero stale occurrences after Step 2.
- Local timing evidence supports the fix's premise: `vitest run` for the package now reports `tests` phase in the tens of milliseconds versus `transform`/`import` phases in the hundreds of ms to low seconds — the heavy cost sits entirely outside the per-test timed window now.
- Pre-completion reviewer: **PASS**.
  All deterministic checks (`pnpm run check`, root `pnpm run lint`, `vitest run` for `pi-session-tools`, `pnpm fallow dead-code`) passed; commit messages, code design, and doc surfaces (none reference the old per-test-import idiom) all verified clean.
  No WARN findings.

## Stage: Final Retrospective (2026-07-07T17:10:00Z)

### Session summary

Shipped the test-only `testTimeout` fix across TDD and ship stages: two `test:` commits converting four `pi-session-tools` tool test files from per-`it()` `await import("#src/index")` to a single static top-level import, plus the planning/TDD retro breadcrumbs.
CI passed on `653abca2`; issue #554 closed with an implemented-in summary; no release cut (every commit since `pi-session-tools-v1.2.0` is a hidden `test:` type or an excluded-path `docs:`, so the work auto-batches).
An unusually clean, low-friction execution — the plan predicted every outcome and nothing deviated.

### Observations

#### What went well

- **Verification-first plan structure paid off.**
  The plan isolated its one genuinely-uncertain assumption (does vitest hoist `vi.mock` above a *static* import?) into TDD Step 1 as a single-file, run-in-isolation check before the mechanical rollout in Step 2.
  The assumption held on first run, so Step 2 was pure mechanism with zero risk — a good template for "one empirical unknown, then N mechanical repetitions" refactors.
- **Incremental verification cadence.**
  Checks ran at every boundary: `vitest run <file>` + `check` after Step 1, full package `vitest run` + `check` after Step 2, then root `lint` + `fallow dead-code` + lockfile check before the pre-completion dispatch.
  No end-of-session surprise — the feedback loop was tight throughout.
- **The `grep -rn 'await import("#src/index")' test/` guard** from the plan's Risks section caught nothing (exit 1, as hoped) but was the right cheap confirmation that no stale dynamic import survived the multi-file Step 2 batch.

#### What caused friction (agent side)

- `other` — In both the pre-completion context-gathering (`git describe --tags --abbrev=0` → `pi-permission-system-v20.0.0`) and the ship close-comment range (`git log <pkg-tag>..HEAD`), the monorepo's linear history surfaced unrelated commits/files from other packages' prior sessions, because the most-recent-reachable tag is cross-package and far behind this package's actual baseline.
  Impact: added friction but no rework — I manually scoped the reviewer prompt to the six #554 files and appended `-- packages/pi-session-tools/` to the `git log` to filter.
  Both corrections were self-identified and handled in-stride; no follow-up commits.

#### What caused friction (user side)

- None.
  The plan was unambiguous and operator-authored, so no mid-session clarification or correction was needed at any stage.

### Diagnostic details

- **Model-performance correlation** — One subagent dispatch: the `pre-completion-reviewer` on `anthropic/claude-sonnet-5` (its pinned frontmatter model), 23 tool uses / 100s, returned PASS.
  Appropriate pairing — a capable reasoning model on a judgment-heavy review checklist, not a mechanical task.
- **Feedback-loop gap analysis** — Exemplary; no gap.
  Verification ran incrementally after each TDD step rather than batched at the end (see "Incremental verification cadence" above).
- **Escalation-delay / unused-tool lenses** — Nothing notable; no `rabbit-hole` or `missing-context` friction points arose, so no subagent or tool went underused.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a bullet to the *vi.mock and hoisting* subsection: prefer a static top-level `import` of the module-under-test over a per-test `await import(...)`, since Vitest hoists `vi.mock()`/`vi.hoisted()` above static imports and a per-test dynamic import of a heavy-dep module races the `testTimeout` window (Refs #554).
2. `packages/pi-session-tools/docs/retro/0554-session-tools-test-static-import.md` — this Final Retrospective stage entry.

Considered but not landed: package-scoping the `pre-completion` skill's Step 1 diff baseline (cosmetic monorepo papercut, handled in-stride, no rework) — left as an observation, not a change.
