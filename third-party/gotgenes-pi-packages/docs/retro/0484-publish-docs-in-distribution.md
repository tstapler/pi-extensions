---
issue: 484
issue_title: "Bad URL in docs"
---

# Retro: #484 — Bad URL in docs

## Stage: Planning (2026-07-03T00:15:00Z)

### Session summary

Planned the fix for a third-party report that `@gotgenes/pi-permission-system`'s `docs/configuration.md` 404s on jsdelivr/pi.dev.
Root cause: the package's `files` allowlist omits `docs/`, so no documentation ships to npm and every README `docs/...` link (and the logo) breaks on the CDN.
The operator broadened scope to a repo-wide convention — ship user-facing docs, never ship internal working docs — so the plan is cross-package (`docs/plans/0484-...`).

### Observations

- **Third-party issue, two `ask_user` gates.**
  Author `johnsyin-nextbe` ≠ operator, so I confirmed direction/scope rather than implementing the issue body verbatim.
  First `ask_user` settled scope (cross-package convention) + inclusion mechanism (selective allowlist).
  The operator then steered toward a denylist mid-plan.
- **Inclusion vs. exclusion asymmetry drove the final design.**
  A denylist (`.npmignore`) cannot *add* files an allowlist omits, so `pi-permission-system`'s missing docs must be fixed by editing its `files` array.
  Over-publishing (internal `docs/plans`/`docs/retro` leaking) is best fixed with a `.npmignore` denylist.
  The plan uses each mechanism where it is effective rather than forcing one everywhere.
- **Deliberately kept scope to docs.**
  Introducing `files` allowlists to the four no-files packages would have incidentally dropped `test/`/`tsconfig`/dev config (scope creep) and risked dropping a runtime file.
  Chose targeted `.npmignore` (`docs/plans`, `docs/retro`) instead — lowest risk, docs-only.
- **`pi-colgrep` and `pi-github-tools` already conform** (allowlist omits `docs`, no user docs) — no change; verification-only.
- **Verification is `pnpm pack` tarball diffs**, not Vitest — this is a `/build-plan`, no test cycles.
- **Release:** ship independently — `pi-permission-system` cuts a `fix:` patch; the other packages' `build:`/`docs:` commits are hidden and batch.
- **Filed follow-up #523** for the separate over-publishing of non-runtime dev files (`test/`, `tsconfig.json`, `vitest.config.ts`, `AGENTS.md`, `.pi/`), explicitly out of scope here.
- **Open risk to watch in build:** whether `.npmignore` prunes inside `pi-subagents`'s `files`-allowlisted `docs` dir; plan documents a fallback (narrow the `docs` entry) arbitrated by the pack diff.

## Stage: Implementation — Build (2026-07-03T01:05:00Z)

### Session summary

Executed all 7 plan steps as 7 commits: fixed `pi-permission-system`'s `files` allowlist to publish user-facing docs (the reported bug), added `.npmignore`/narrowed-allowlist exclusions for internal `docs/plans`/`docs/retro` across `pi-subagents`, `pi-autoformat`, `pi-nocd`, `pi-session-tools`, `pi-subagents-worktrees`, and documented the convention in root `AGENTS.md`.
Every step was verified with a `pnpm pack` + `tar tzf` tarball diff rather than Vitest, per the plan's build-only design.
A final cross-package sweep confirmed zero `docs/plans`/`docs/retro` files in any of the 8 packages' tarballs.

### Observations

- **The plan's flagged risk materialized exactly as anticipated.**
  `.npmignore` does **not** prune files inside a directory a `files` allowlist already includes — verified empirically on `pi-subagents` (245 `plans`/`retro` files still shipped after adding the denylist).
  Applied the plan's own documented fallback: narrowed the `files` `docs` entry to `"docs/*.md", "docs/architecture", "docs/decisions"` instead, folded into the same commit per the deviation-handling instructions.
  Confirmed by contrast that `.npmignore` works correctly for packages with **no** `files` allowlist (`pi-autoformat` first, then the rest) — the two mechanisms really are asymmetric as designed.
- **AGENTS.md convention updated to state the caveat explicitly**, not just the two mechanisms, so a future package author hits documented guidance instead of rediscovering the same empirical surprise.
- **No `src/`/`test/` changes** — this was a pure packaging-metadata change (`package.json` `files` fields, `.npmignore` files, one `AGENTS.md` section).
  `pnpm run check`/`lint`/`test`/`fallow dead-code` all pass; test/dead-code are unaffected by the diff as expected.
- **Pre-completion reviewer: PASS.**
  No findings; reviewer independently re-verified all 8 packages' tarball contents and confirmed follow-up #523 is correctly filed and referenced.
- All 7 steps completed in this session; nothing deferred to a future build session.

## Stage: Final Retrospective (2026-07-03T01:20:57Z)

### Session summary

Shipped #484 across all four workflow stages (plan → build → ship → retro): the `pi-permission-system` `files`-allowlist fix cut `pi-permission-system-v18.1.1`, and the repo-wide docs-in-distribution convention landed as `build:`/`docs:` commits that batch into each sibling package's next release.
Execution was clean end-to-end — no rework, no failed CI, no reopened work — with the plan's one flagged risk resolving mechanically via its own documented fallback.

### Observations

#### What went well

1. **Plan foresight converted a mid-build surprise into a checklist item.**
   The plan's `Risks and Mitigations` pre-identified that an `.npmignore` denylist might not prune inside `pi-subagents`'s `files`-allowlisted `docs` dir, and named the fallback (narrow the `files` entry).
   In the build the risk materialized exactly — 245 `plans`/`retro` files still shipped after the denylist — and the fallback applied without any re-planning or stall.
   This is the standout: a `Risks` entry with a concrete mitigation turned a would-be dead end into a one-line pivot.
2. **Incremental verification cadence.**
   `pnpm run lint` plus a `pnpm pack` + `tar tzf` tarball diff ran after every one of the 7 build steps, and a final cross-package sweep confirmed zero internal-doc files in all 8 tarballs — the feedback loop was per-step, not deferred to the end.
3. **Ship-stage `UNSTABLE` handled correctly.**
   The release-please PR reported `merge_state: UNSTABLE` with a `check` still `IN_PROGRESS` (a non-empty rollup), so I waited for it to complete rather than falling back to `gh pr merge` — exactly the distinction the ship prompt draws between the no-checks `GITHUB_TOKEN` case and a running check.

#### What caused friction (agent side)

1. `other` (tool-call syntax) — in the build stage, the first `pi-permission-system` `package.json` edit was emitted twice as a malformed `Edit` call (`oldText: "  "` with no `newText`), rejected by validation both times before the third, correct attempt.
   Impact: 2 wasted tool calls, self-identified, no file rework.
2. `other` (tool-call syntax) — in the retro stage, a `git pull` step was emitted as a garbled block (literal `court` and `<invoke>` text instead of a valid tool call), which the user flagged ("I'm not sure what happened there").
   Impact: one wasted round-trip and brief user confusion, user-caught, no rework.
   Both are model output glitches, not process gaps — no `AGENTS.md`/prompt rule would prevent them.

#### What caused friction (user side)

1. None material.
   The mid-plan steer toward a denylist ("If you believe a deny-list is more effective, we should use that") was well-timed collaborative refinement, not friction — it produced the final asymmetric two-mechanism design.
   A minor opportunity: the first `ask_user`'s mechanism options framed allowlist-vs-`.npmignore` as either/or, when the landing design used both (allowlist to *include* the missing docs, denylist to *exclude* internal docs); surfacing the hybrid as an explicit option could have reached the same place one turn sooner.

### Diagnostic details

- **Model-performance correlation** — the sole subagent dispatch (`pre-completion-reviewer`) ran on `anthropic/claude-sonnet-5`, appropriate for judgment-heavy packaging review; it independently re-verified all 8 packages' tarball contents and the #523 follow-up filing.
  No mismatch.
- **Feedback-loop gap analysis** — no gap: verification ran incrementally after each build step (see What went well #2), not batched at session end.
- **Escalation-delay tracking** — the malformed `Edit` was 2 consecutive failed calls before recovery, under the 5-call threshold; no subagent escalation warranted.

### Changes made

1. `AGENTS.md` — split the long (~50-word) "Docs-in-distribution convention" sentence into a tighter rule + caveat: the explicit-`files`-paths rule, then the `.npmignore`-can't-prune-inside-an-allowlist caveat (`Refs #484`), then the no-allowlist denylist case as its own line.
   No semantic change; scannability only.
