---
issue: 626
issue_title: "pi-permission-model-judge records nothing, so its decisions are unobservable"
---

# Retro: #626 — pi-permission-model-judge records nothing, so its decisions are unobservable

## Stage: Planning (2026-07-21T02:30:00Z)

### Session summary

Planned the model-judge decision trail as a **cross-package** change: a new `AuthorizerLog` seam threaded into the pi-permission-system `Authorizer` chain (Phase 1), consumed by `pi-permission-model-judge` to write a positive, structured decision record per `external_directory` ask it evaluates (Phase 2).
The operator chose issue option 1 (route through the shared review log, not a judge-owned JSONL) and debug-gated raw model replies.
The governing principle — "absence of evidence is not evidence of absence" — drove the design: every pattern-matched ask always gets a positive `model_judge.decision` review entry with a concrete verdict + defer-reason, so a silent 100%-defer regression like [#625] can never hide again.

### Observations

- **Hard publish gate is the central constraint.**
  `linkWorkspacePackages: false` means the judge type-checks against the **published** `@gotgenes/pi-permission-system` (20.9.0 in `node_modules`), not the workspace source.
  A 3-param `authorize` callback is not assignable to the published 2-param type, so Phase 2 cannot be built until Phase 1 publishes.
  This forces two releases in a fixed order and likely two `/ship-issue` cycles.
- **Design fork resolved via `ask_user`** — the operator picked A (shared review log) over B (own JSONL) and C (hybrid), and debug-gated raw reply.
  Discovered during exploration that option B would not have fully lost the "single audit trail" benefit (the judge's `authorize` receives `details.requestId`, so an own-log could join to the review log) — surfaced in the ask, but the operator still preferred A for a single trail.
- **Seam shape:** a third `log: AuthorizerLog` parameter on `Authorizer.authorize`, mirroring the ADR 0007 §3 `query`-injection precedent.
  `AuthorizerLog` (`{ review, debug }`) is structurally satisfied by the existing session `DebugReviewLogger`, so no new logger implementation — `AuthorizerSelection.escalate` already holds `this.deps.logger` and just passes it through.
  Non-breaking: a 2-param callback stays assignable to the 3-param type (`feat`, not `feat!`).
- **Log-level split** keeps the review log signal-rich: pattern-matched asks → `log.review` (the [#625]-class signal, on by default); `no-path` / `pattern-miss` short-circuits and the raw reply → `log.debug` (off by default).
  Non-`external_directory` asks are not logged at all (not the judge's surface; a line per bash/tool ask would be noise).
- **`reviewPath` restructure** returns a `ReviewOutcome` distinguishing four model-call defer reasons; added `call-failed` as the honest superset the issue's enum omits (a 401 that slips past pre-call auth throws inside `complete` and lands here — the [#625]-class signal).
  Verdict behavior is unchanged (all failures still defer, ADR 0007 invariant 2); the outcome only annotates why.
- **Ties to the held [#625].**
  The judge release in Phase 2 carries [#625]'s auth fix (already unreleased on `main`); the new trail is the verification mechanism the operator held [#625] for.
  The plan ends with the concrete verification recipe.
- **Doc touch points identified:** ADR 0007 line 66 signature + a §3 subsection; `architecture.md` line 764 module-tree signature copy; the judge README + `configuration.md`.
- Release: ship independently (two independent releases, publish-gated); no roadmap batch references this issue.

## Stage: Implementation — TDD Phase 1 (2026-07-21T21:35:00Z)

### Session summary

Implemented **Phase 1 only** — the pi-permission-system review-log seam — in three commits (a tidy-first fixture, the `feat` seam, and docs).
Added a public `AuthorizerLog` (`{ review, debug }`), widened `Authorizer.authorize` with a third `log` parameter, threaded it through `composeAuthorizerChain` and `encloseInDelegationEnvelope`, and supplied the session `DebugReviewLogger` from `AuthorizerSelection.escalate`.
Phase 2 (the `pi-permission-model-judge` consumer) is **not** started — it is blocked on the publish gate. pi-permission-system test count 2533 → 2535 (+2 new injection/forwarding assertions; net after the migrated fixture).

### Observations

- **Publish gate holds — Phase 2 deferred by design.**
  `linkWorkspacePackages: false` means the judge type-checks against the registry copy of `@gotgenes/pi-permission-system`; a 3-param `authorize` callback is not assignable to the published 2-param type, so Phase 2 cannot be built until Phase 1 ships and publishes and the judge's dep is bumped.
  This session correctly stops at the end of Phase 1.
- **Tidy-First (assessor dispatched):** landed one preparatory `test:` commit extracting a shared `makeAuthorizerLog()` fixture (`test/helpers/authorizer-log-fixtures.ts`) and migrating the two existing `{ review, debug }` literals in `authorizer-selection.test.ts` onto it — so the fixture is consumed immediately (no dead export, no unused import) and the feature commit's ~16 new call sites became one-line `, log` appends.
  Rejected-as-scope-creep items (migrating `permission-prompter.test.ts` `{ review }`-only literals, extracting `makeQuery`/`makeDetails`) were correctly declined.
- **Non-breaking confirmed:** `AuthorizerLog` is structurally identical to the existing internal `DebugReviewLogger`, so the session logger passes straight through with no new implementation; a 2-param link callback stays assignable to the widened type (`feat`, not `feat!`).
- **Ship caveat for `/ship-issue`:** shipping Phase 1 cuts a **pi-permission-system** release but must **not close #626** — the issue is only half done; Phase 2 (judge + the held [#625] verification) follows after the pi-permission-system publish.
- Pre-completion reviewer: **PASS** (Phase 1 scope) — all deterministic checks green, ADR/architecture docs updated, invariants preserved, no design concerns.
- Remaining work (next session, after publish): Phase 2 steps — bump the judge dep to the published pi-permission-system version, `reviewPath` structured outcome, `matchTypoPattern`, the decision-trail logging in `createTypoReviewer`, and the judge user docs; then run the [#625] verification recipe and ship both.

## Stage: Implementation — TDD Phase 2 (2026-07-21T18:00:00Z)

### Session summary

Implemented **Phase 2** — the judge consumer — in five commits (`build` dep-bump, three `feat`, one `docs`) against the published `@gotgenes/pi-permission-system@20.10.0`.
The judge now consumes the injected `AuthorizerLog`: `reviewPath` returns a structured `ReviewOutcome` distinguishing four model-call defer reasons, `matchTypoPattern` returns the matched pattern, and `createTypoReviewer` writes a positive `model_judge.decision` review entry per pattern-matched ask (plus debug-level short-circuits and raw reply). pi-permission-model-judge test count 40 → 42; full workspace suite, `check`, `lint`, and `fallow dead-code` all green.

### Observations

- **The publish-age gate was the dominant friction.**
  pnpm 11's 24h `minimumReleaseAge` blocks the freshly-published 20.10.0, and the pre-commit hooks (`biome`/`eslint`) run `pnpm exec`, which trips the gate; `prek` stashes unstaged changes, so a working-tree-only override is invisible during hooks.
  Resolution: the operator set a local `minimumReleaseAge: 0` in `pnpm-workspace.yaml` (kept **uncommitted** — the committed file adds only the `20.10.0` exclude line); gates were run manually and each commit used `--no-verify` (AGENTS.md's hook-can't-run exception).
- **`minimumReleaseAge: 0` must stay out of history.**
  The build commit staged a clean `pnpm-workspace.yaml` (via write-clean → `git add` → restore-override) so the override never entered the commit; `git status` still shows `pnpm-workspace.yaml` modified — that lingering diff is the intentional local override.
- **Deviation 1 — removed `matchesAnyTypoPattern`** (plan said "re-express").
  Once `typo-reviewer` migrated to `matchTypoPattern`, it was dead production code; removed it and its now-redundant tests (the plan's "or its lone caller migrates" clause anticipated this).
- **Deviation 2 — `matchTypoPattern` returns the operator's literal pattern, not `RegExp.source`** (plan said `.source`).
  `RegExp.source` slash-escapes (`a\/b`), so `CompiledTypoPatterns` gained a parallel `patterns: string[]` holding the pre-compile strings — a faithful "which pattern matched" log field.
- **Log-level split holds:** `model_judge.decision` (review, on by default) for every pattern-matched ask; `model_judge.short_circuit`/`model_reply`/`invalid_patterns` (debug-gated); non-`external_directory` unlogged — exactly the [#625]-class evidence guarantee.
- Pre-completion reviewer: **PASS** (Phase 2 scope).
  One non-blocking note: `deferWith` and the final `log.review` share ~9 fields; a `recordDecision` helper could DRY them — left as-is to keep scope tight (a future tidy).
- **Not yet done (ship blockers):** (1) **hold the CI push until 20.10.0 ages out** (~2026-07-22T13:15Z UTC) so CI's frozen install does not hit the release-age gate; (2) drop the uncommitted `minimumReleaseAge: 0` override before/at push; (3) run the [#625] dogfood verification recipe against the new trail, then ship #625 and close #626 together.
  (Blockers 1–2 were resolved later in the same session — see the Release-age gate stage below.)

## Stage: Release-age gate resolution (2026-07-21T18:20:00Z)

### Session summary

Replaced the fragile `minimumReleaseAge: 0` local override with a committed, correct fix so CI and local hooks install the same-day-published `@gotgenes/pi-permission-system@20.10.0` without waiting ~24h.
Committed `trustLockfile: true` to `pnpm-workspace.yaml` and removed the ineffective version-specific `@gotgenes/*` `minimumReleaseAgeExclude` entries.
The "hold the push until age-out" and "drop the override" blockers above are now moot; only the [#625] dogfood verification remains before shipping.

### Observations

- **Root cause pinned to the lockfile verification pass.**
  The `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` comes from pnpm's supply-chain *verification* pass (the `trustLockfile` pass), which re-applies `minimumReleaseAge` to every **pinned lockfile entry** — distinct from dependency *resolution*.
- **`minimumReleaseAgeExclude` does not cover that pass.**
  Verified empirically: `@gotgenes/pi-permission-system@20.10.0` was in the exclude list (valid version-specific format per the pnpm docs) yet still flagged.
  So the repo's version-specific `@gotgenes/*` excludes were no-ops for the CI/hook failure they appeared to target — removed them.
- **`trustLockfile: true` is the correct lever** (operator-approved).
  It trusts the committed, PR-reviewed lockfile and skips re-verifying pinned entries, while keeping the age delay for fresh `pnpm add`/`update`.
  Confirmed it fixes both CI's `--frozen-lockfile` install and the local `pnpm exec` hook path; the follow-up commit ran **with hooks enabled** (no `--no-verify`), validating the fix end-to-end.
- **Earlier Phase 2 commits keep their `--no-verify`** (they predate this fix); every commit from `4b06f8cd` onward can use the normal hook path.
- **Push is no longer time-gated** — `/ship-issue` can push immediately; CI will install 20.10.0 cleanly.
- Consider reporting the `minimumReleaseAgeExclude`-not-honored-by-verification-pass gap upstream to pnpm (a version-specific exclude that resolution honors but the lockfile verification pass ignores is surprising).

## Stage: Final Retrospective (2026-07-21T19:14:48Z)

### Session summary

Cross-session retro spanning the whole #626 arc: Planning, TDD Phase 1 (the `AuthorizerLog` seam in pi-permission-system), TDD Phase 2 (the judge consumer), and the release-age gate deep-dive.
The dominant theme across stages was a single external tool gate — pnpm's 24h `minimumReleaseAge` supply-chain delay on the same-day-published `@gotgenes/pi-permission-system@20.10.0` — which drove most of the Phase 2 mechanical complexity and was only correctly root-caused (to the lockfile verification pass, fixed with `trustLockfile: true`) after a user challenge prompted reading the authoritative pnpm docs.
The core deliverable (a positive, structured decision trail closing the [#625]-class "silent defer" gap) landed cleanly across 8 commits with all gates green.

### Observations

#### What went well

- **User challenge → doc-reading → root cause** (the standout win).
  The operator's skepticism ("why specific versions?
  that doesn't make sense") broke a multi-approach bypass hunt: it prompted `fetch_content` on the pnpm settings docs, which cleanly separated dependency *resolution* (honors `minimumReleaseAgeExclude`) from the lockfile *verification pass* (ignores it, governed by `trustLockfile`).
  That distinction surfaced the correct, more-targeted lever (`trustLockfile: true`) over the blunt `minimumReleaseAge: 0`, and retired an entire fragile workaround (the staged-vs-working override dance + `--no-verify` cascade).
- **Empirical validation before committing the fix.**
  Each hypothesis was tested in isolation — `--config.trustLockfile=true` against both CI's `--frozen-lockfile` install and the local `pnpm exec` hook path — then the fix commit ran **with hooks enabled**, validating end-to-end rather than trusting the flag.
- **Tidy-First fixture paid off** (Phase 1): the `makeAuthorizerLog()` extraction turned a ~16-call-site signature widening into mechanical one-line `, log` appends.
- **`ask_user` gates were well-placed** at both consequential forks: the Planning design fork (shared log vs own JSONL) and the security-posture decision (`trustLockfile` vs `minimumReleaseAge: 0` vs CI-scoped), each surfacing the trade-off for the operator instead of a unilateral pick.

#### What caused friction (agent side)

- `missing-context` (cross-session, prior branch) — the release-age gate was attacked with empirical trial-and-error (`.npmrc`, env vars, `verifyDepsBeforeRun`, `minimumReleaseAgeExclude` variants) **before** consulting pnpm's own settings documentation, and reached a wrong conclusion: that the gate could only be beaten by waiting ~24h or an uncommitted override, and that a version-specific exclude entry (committed as a no-op) helped.
  Impact: a whole `--no-verify` + staged-vs-working-override workaround was built and recorded as "ship blockers" in the Phase 2 stage notes, then dismantled once the docs revealed `trustLockfile`.
  Net: significant avoidable mechanical complexity and one round of incorrect stage-note guidance, corrected within this session.
- `rabbit-hole` (cross-session) — the same gate: the prior session cycled through four-plus bypass mechanisms on the same `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` error without stepping back to the source of truth.
  Impact: the correct fix (`trustLockfile: true`) is a single committed line; reaching it took a user nudge rather than an earlier escalation to the docs.

#### What caused friction (user side)

- The `trustLockfile` resolution hinged entirely on the operator's mid-session challenge.
  Framed as opportunity, not criticism: the same redirect ("have you read the tool's config docs for this gate?") is the kind of cue the agent should have generated itself after 3–4 failed bypass attempts on one error — the intervention was strategic, and it landed because the operator questioned an assumption ("the exclude list is doing something") the agent had accepted.

### Diagnostic details

- **Model-performance correlation** — subagent dispatches were all read-only/review tasks (`tidy-first-assessor` in Phase 1; `pre-completion-reviewer` in Phases 1 and 2) on their configured default models; no judgment-heavy work ran on a reasoning-weak model, no mismatch.
  The one research call (`fetch_content` on the pnpm docs, Gemini-backed) was appropriately scoped to authoritative-doc extraction.
- **Escalation-delay tracking** — the release-age rabbit-hole exceeded the 5-consecutive-calls threshold on one error **in the prior session**; in this session, once the assumption was questioned, resolution took a handful of targeted calls (`fetch_content` → `pnpm config` → two empirical tests → `ask_user`).
  The lesson is cross-session: escalate to the tool's docs after ~3 failed bypass attempts on the same gate.
- **Unused-tool detection** — `web_search`/`fetch_content` (and the `librarian` skill) were available throughout but not used on the pnpm gate until this session; reading `https://pnpm.io/settings` earlier would have pre-empted the entire trial-and-error arc.
- **Feedback-loop gap analysis** — no gap: Phase 2 ran `check`/`lint`/`test`/`fallow` incrementally after each TDD step, and the release-age fix was validated (frozen install + hook path) before and at commit time.

### Changes made

1. `AGENTS.md` (Monorepo Structure section) — added a note documenting the same-day-sibling `minimumReleaseAge` gate, that `minimumReleaseAgeExclude` does not fix it, and that the repo relies on `trustLockfile: true` (do not remove it; do not use `minimumReleaseAge: 0`).
   Refs #626.
2. `docs/retro/0626-model-judge-decision-trail.md` — added this Final Retrospective stage entry.
