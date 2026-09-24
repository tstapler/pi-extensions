---
issue: 606
issue_title: "/finish-phase: add a bounded architecture-doc hygiene step to prevent regrowth"
---

# Retro: #606 — /finish-phase: add a bounded architecture-doc hygiene step to prevent regrowth

## Stage: Planning (2025-06-13T00:00:00Z)

### Session summary

Planned a bounded, change-scoped doc-hygiene step for the `/finish-phase` prompt (`.pi/prompts/finish-phase.md`) that prevents the architecture-doc regrowth [#601]/[#605] paid down in bulk.
The plan inserts a new `## Step 4: Bounded doc hygiene` (renumbering Archive → 5, Verify → 6) covering three directives — no duplicate `### Phase N` prose on archive, strip provenance from touched module-tree entries, re-frame delivered `Target:` prose — and corrects Step 4's now-stale parenthetical that still tells the agent pi-permission-system uses `### Phase N (complete)` prose subsections (deleted by [#601]).
Scope is a single prompt file: docs/config, no code, no tests — so `/build-plan` is the next stage, not `/tdd-plan`.

### Observations

- Operator-authored, unambiguous issue → skipped the `ask-user` gate.
  The proposed change lists three concrete hygiene items and explicitly decided (with @gotgenes) that `/finish-phase` is the home, so the design fork was narrow.
- Design decision: implement the issue's three items as **one** bounded hygiene step (all three grouped) rather than distributing them into existing Steps 3/4, to match the issue's "add a bounded hygiene step" framing and keep it reviewable.
  Item 1 (no duplicate prose) is stated in the hygiene step but governs the *next* step's archive write; the Archive step gets a cross-reference plus the stale-parenthetical fix.
- Verified the stale parenthetical is a real bug: after [#601] pi-permission-system's `Refactoring history` is intro-plus-table with the `### Phase N (complete)` prose removed, yet Step 4 still instructs the agent to write that prose.
- Kept scope tight: package-skill / shared-convention generalization is [#607]'s job (filed separately, still open); this plan references the existing per-package skill rule and notes [#607] as the future shared-convention home.
- Confirmed no external references key on `/finish-phase`'s internal step numbers (`plan-improvements.md`, `retro.md`, `ship-issue.md`, `improvement-discovery` SKILL all name the *job*, not a step number), so the renumber is internal and safe.
- Release: ship independently — the prompt file is repo-root tooling, in no tarball and no roadmap; lands as a `docs:` commit with no release coordination.

## Stage: Implementation — Build (2025-06-13T00:30:00Z)

### Session summary

Executed the single-step build plan against `.pi/prompts/finish-phase.md`: inserted the new `## Step 4: Bounded doc hygiene (change-scoped)` covering all three hygiene directives, renumbered Archive → Step 5 and Verify → Step 6, and corrected Step 5's stale parenthetical (pi-permission-system no longer uses `### Phase N (complete)` prose subsections post-#601).
One commit (`276cc259`); docs/config only, no `src/`/`test/`/`.ts` touched, so no test suite or type check applied.
Pre-completion reviewer returned PASS.

### Observations

- Design followed the plan exactly — the two coordinated edits (insert hygiene step + correct Archive parenthetical) with the trailing renumber; no scope deviation.
- Two minor authoring cleanups during implementation: removed a duplicate "Do not impose a new format." line the first edit left behind, and converted the `[#601]`/`[#605]` bracketed refs to bare `#601`/`#605` to match the prompt file's existing bare-`#N` convention (the file carries no reference-link definitions).
- Verified step numbering runs 1→6 with no gaps and the Step 4 ↔ Step 5 forward/back cross-references resolve; the `## Improvement roadmap — Phase N (complete)` gate string `plan-improvements.md` greps is untouched and explicitly protected by directive 1.
- Pre-completion reviewer: PASS — all four deterministic checks green; no WARN findings.

## Stage: Final Retrospective (2025-06-13T01:00:00Z)

### Session summary

Shipped #606 end-to-end in one continuous session (plan → build → ship → retro): a single-file edit to `.pi/prompts/finish-phase.md` adding a bounded doc-hygiene step, renumbering the trailing two steps, and correcting a stale parenthetical.
CI passed, the issue closed, and no release was cut because the unreleased range holds only non-releasing/excluded-path commits (auto-batches to the next releasing commit).
Execution was clean throughout — the only friction was a handful of trivial, self-caught authoring slips with no rework beyond a follow-up `Edit`.

### Observations

#### What went well

- Planning-stage verification turned a pure "prevent regrowth" scope into also fixing an *already-stale* instruction: reading the current pi-permission-system `Refactoring history` confirmed the Step 4 parenthetical still told the agent to write `### Phase N (complete)` prose that [#601] had deleted.
  Catching that before writing the plan meant the shipped change corrected a live bug rather than layering new guidance on top of stale guidance.
- Correct release reasoning at ship time: recognized the whole `pi-subagents-v18.0.3..HEAD` range is `refactor:`/`test:`/`docs:`(excluded-path or no-package) commits, so release-please cuts nothing now — skipped the release-please merge step deliberately instead of waiting on a phantom PR.

#### What caused friction (agent side)

- `other` — the first build-stage `Edit` on the Archive step left a duplicate "Do not impose a new format." line (the `newText` repeated the sentence).
  Caught immediately on re-read; one follow-up `Edit` removed it.
  Impact: one extra edit, no rework.
- `other` — a malformed `Edit` tool call went out against a bogus path (`pi-permission-system-NOPE.md` with placeholder text) and was denied by the permission gate before the real edit.
  Impact: one denied tool call, immediately corrected; no rework.
- `missing-context` — wrote the two issue refs as reference-links (`[#601]`/`[#605]`) in the prompt first, then converted them to bare `#N` to match the file's existing convention (the prompt carries no link definitions).
  Self-caught; `rumdl` passed either way.
  Impact: one extra edit, no rework.
- `other` (environmental) — `gh api user --jq .login` returned HTML instead of JSON (transient), failing the author-identity check; one retry with a `head -c` fallback confirmed the operator identity.
  Impact: one extra tool call.

#### What caused friction (user side)

- None — the issue was operator-authored, unambiguous, and well-scoped; no mid-session redirects were needed.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatched (`pre-completion-reviewer` on `anthropic/claude-sonnet-5`) for the end-of-build quality gate; judgment-heavy review work, appropriately modelled.
  No mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` points; the longest same-error sequence was the single `gh api user` retry.
  Nothing approached the 5-call threshold.
- **Unused-tool detection** — no `missing-context`/`rabbit-hole` points warranted a subagent or search that went undispatched.
- **Feedback-loop gap analysis** — for a docs-only change, `pnpm run lint`/`rumdl check` ran after the single edit (correct incremental cadence), and the pre-completion reviewer re-ran all four deterministic gates.
  No verification-deferred gap.

### Changes made

1. `docs/retro/0606-finish-phase-doc-hygiene-step.md` — appended this Final Retrospective stage entry.
   No prompt or `AGENTS.md` changes proposed: the session's friction was trivial and self-caught, not meeting the evidence bar for a workflow rule (operator confirmed retro-only).

[#601]: https://github.com/gotgenes/pi-packages/issues/601
[#605]: https://github.com/gotgenes/pi-packages/issues/605
[#607]: https://github.com/gotgenes/pi-packages/issues/607
