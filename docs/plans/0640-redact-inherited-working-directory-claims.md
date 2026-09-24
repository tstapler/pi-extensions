---
issue: 640
issue_title: "Child inherits parent's stale 'working directory' claim, defeats WorkspaceProvider/worktree isolation"
---

# Redact inherited working-directory claims from child system prompts

## Release Recommendation

**Release:** ship independently

Neither package's change belongs to an open release batch — grepping `packages/pi-subagents/docs/architecture/architecture.md` for `640` finds no roadmap step, and pi-nocd has no roadmap at all.
Two independent `fix:` commits (one per component) cut a patch release for `@gotgenes/pi-subagents` and `@gotgenes/pi-nocd` at ship time.

## Problem Statement

A subagent given an isolated workspace by a `WorkspaceProvider` (today: `@gotgenes/pi-subagents-worktrees`) receives a system prompt that states two different working directories.
`buildAgentPrompt` (`packages/pi-subagents/src/session/prompts.ts`) embeds the parent's effective system prompt verbatim as the child's cacheable prefix, and that inherited text ends with Pi's own `Current working directory: <parent path>` footer.
The child's own `# Environment` block, later in the same prompt, names the correct isolated cwd.

The reporter (`aaronkyriesenbach`, a third party) ran two opted-in background agents in parallel: the `WorkspaceProvider` mechanics worked — each child's session and tool cwd was its own worktree — but both children prefixed bash commands with `cd <parent path> &&` from their third tool call onward, walked themselves back into the shared main checkout, and committed there on top of each other with no error.

This repo has a third package in the interaction: `@gotgenes/pi-nocd` appends a `# Working Directory` block naming `ctx.cwd`, guarded by an idempotence check that returns the prompt unchanged when the heading is already present.
In a child, that heading *is* already present — inherited from the parent's prompt, naming the parent's path — so the guard suppresses the correct block and the child keeps a stale instruction that reads as authoritative.

## Goals

- A workspace-isolated child's system prompt contains exactly one `Current working directory:` claim, and it names the child's own cwd.
- The inherited parent prompt is otherwise preserved byte-for-byte, so the KV-cache prefix rationale documented in `buildAgentPrompt` still holds.
- `@gotgenes/pi-nocd` emits a `# Working Directory` block naming the *current* session's cwd even when an inherited block names another, while still deferring to a foreign block from a different handler.
- Non-breaking (`fix:` in both packages): no config key, public export, or default changes; only the assembled prompt text differs.

## Non-Goals

- No change to `@gotgenes/pi-subagents-worktrees`.
  It is the trigger, not the defect site: it holds no prompt code and no prompt seam (`workspace-provider.ts` returns a cwd plus bracketed teardown), and the stale claim is embedded by pi-subagents for *any* provider that hands back a different cwd.
- No bump of the worktrees package's `@gotgenes/pi-subagents` peer range.
  A stale prompt claim is a degradation, not an incompatibility, and the fixed version is not known until release-please cuts it.
- No change to the child's `# Environment` block — no rephrasing to Pi's `Current working directory:` wording, and no added "the inherited prompt is stale" precedence sentence.
  Operator decision: redaction only.
- No global rewrite of the parent path throughout the inherited prompt (evaluated and rejected — see Design Overview).
- No sanitizing of the inherited *conversation* (`inherit_context`), which can also contain the parent's `cd` habits — see Open Questions.
- No new `WorkspaceProvider` prompt-shaping seam.

## Background

### Where the stale claim comes from

Pi's `buildSystemPrompt` (`~/development/pi/pi/packages/coding-agent/src/core/system-prompt.ts:69`) unconditionally ends the assembled prompt with `\nCurrent working directory: ${promptCwd}`, including in the `customPrompt` branch, and normalizes the path with `cwd.replace(/\\/g, "/")`.
`AgentSession._rebuildSystemPrompt()` calls it with `cwd: this._cwd`.
`ctx.getSystemPrompt()` returns `agent.state.systemPrompt`, which after a turn has started includes any `before_agent_start` shaping — so the parent snapshot captures the footer *and* pi-nocd's block.

The child then gets that text twice over:

1. `buildParentSnapshot` (`src/lifecycle/parent-snapshot.ts`) captures `cwd` and `systemPrompt` from the parent.
2. `assembleSessionConfig` passes `ctx.parentSystemPrompt` to `io.buildAgentPrompt`, which sets `identity = parentSystemPrompt ?? genericBase` and places it first, verbatim, for KV-cache reuse.
3. `createSubagentSession` hands the assembled string to the child's `ResourceLoader` as `systemPromptOverride` and creates the child session with `cwd: cfg.effectiveCwd` — so Pi appends a *second*, correct footer naming the child's cwd as the last line.

Reproduced with `buildSystemPrompt` from the installed SDK (parent `/repo`, child `/repo-worktrees/issue-42`):

```text
Current working directory: /repo                      <- inherited, stale, mid-prompt
# Working Directory
Shell commands already execute in `/repo`. Never ...  <- inherited pi-nocd block, stale
Working directory: /repo-worktrees/issue-42           <- ours, weaker phrasing
Current working directory: /repo-worktrees/issue-42   <- Pi's, correct, last line
```

The correct footer is free — it derives from the child session's own cwd and is not passed by this package.

### Relevant modules

- `packages/pi-subagents/src/session/prompts.ts` — `buildAgentPrompt(config, cwd, env, parentSystemPrompt?)`; owns all knowledge of the assembled prompt's text format.
- `packages/pi-subagents/src/session/session-config.ts` — `AssemblerIO.buildAgentPrompt` (the injected signature) and the single production call site; already holds both `ctx.cwd` (parent) and `effectiveCwd` (child).
- `packages/pi-subagents/src/index.ts` — passes the real `buildAgentPrompt` into `assemblerIO` by reference.
- `packages/pi-nocd/src/working-directory-prompt.ts` — `WORKING_DIRECTORY_HEADING`, `buildWorkingDirectoryPrompt(cwd)`, `appendWorkingDirectoryPrompt(prompt, cwd)`.
- `packages/pi-nocd/src/index.ts` — the `before_agent_start` handler; children load the parent's extensions, so this runs in the child with the child's `ctx.cwd`.

### Constraints from AGENTS.md and the package skill

- Dependency arrows point inward: pi-subagents has zero knowledge of its consumers, so core must not special-case pi-nocd's block.
  Each package repairs its own text.
- Patch 3 (the `<active_agent name="..."/>` tag following the cacheable parent prefix) is a fork invariant the permission system depends on; `packages/pi-permission-system/src/active-agent.ts` parses it by regex, so a removed line cannot break it, but the tag's position must not move.
- pi-nocd's `working-directory-prompt.ts` is not a published API entry (the package declares `pi.extensions` and no `exports` map), so renaming its exports is not breaking.
- Architecture-doc module-tree entries describe current behavior; cite an issue only when the ref encodes an active constraint.

### Defence in depth that did not fire

`@gotgenes/pi-permission-system` has a `bash_external_directory` denial kind that would have caught `cd <parent path> &&` from an isolated child.
The reporter's stack does not include it, which is why the bypass was silent.
That is context, not a change in this plan.

## Design Overview

### pi-subagents: strip the inherited footer line

Three redaction shapes were compared against a realistic parent prompt (project context, skill locations, Pi footer, pi-nocd block):

| Option                                       | Child's cwd claims                               | Collateral                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Strip the inherited footer line              | 2, both correct                                  | none — one line removed from the inherited tail                                                                                              |
| Rewrite the footer to the child cwd          | 3, all correct (one redundant)                   | none; matches the upstream `ssh`/`gondolin` example extensions, which need the replace because Pi has no other way to state their remote cwd |
| Replace every literal parent-path occurrence | 3 correct, and pi-nocd's block repaired for free | overcorrects                                                                                                                                 |

The global option was rejected on evidence.
It rewrites `<location>…/pi-packages/.pi/npm/node_modules/…/SKILL.md` — a valid, readable path, since `.pi/npm/` is gitignored and absent from a `git worktree add` checkout — into a 404, and it collides on path prefixes: `…/pi-packages-worktrees/issue-448` becomes `…/issue-640-worktrees/issue-448`, `…/pi-packages-archive` becomes `…/issue-640-archive`.
A boundary-guarded variant kills the collisions but not the skill-path breakage.

Strip is chosen: it yields exactly one canonical footer for a child whose directory differs from its parent's, and gives a crisp testable invariant.

Amended during implementation: the strip is applied **only** when the child's cwd differs from the parent's.
Measured against a realistic parent prompt (this repo's `AGENTS.md` plus 15 skills, ~8,599 tokens), stripping unconditionally cost 342 characters (~86 tokens, 1.0%) of the byte-identical prefix a child shares with its parent — more than the 67-character footer itself, because the parent's trailing extension-appended blocks (pi-nocd's) shift offset and prefix matching cannot resume.
That loss buys nothing for a same-cwd child, whose inherited footer is already correct.
Anthropic is unaffected either way (its `cache_control` breakpoint covers the whole system block, which never matched the parent's), but implicit token-prefix caching (OpenAI, Gemini, OpenRouter) is.

The redaction is an exact whole-line filter, not a substring replace, so a footer naming a *different* directory that happens to share a prefix with the parent's path is left alone:

```typescript
/**
 * Pi's `buildSystemPrompt` ends every prompt with a `Current working directory:`
 * footer and normalizes separators the same way. Remove the inherited claim so
 * the child's own footer — appended by Pi from the child session's cwd — is the
 * only one in the assembled prompt.
 */
function withoutInheritedCwdFooter(prompt: string, parentCwd: string): string {
  const footerLine = `Current working directory: ${parentCwd.replaceAll("\\", "/")}`;
  return prompt
    .split("\n")
    .filter((line) => line !== footerLine)
    .join("\n");
}
```

Unmatched input is returned unchanged, so a shaped or absent footer degrades to today's behavior rather than throwing.

### The parent cwd reaches `buildAgentPrompt` as a value object

`buildAgentPrompt` needs the parent's cwd to know which line to remove.
The parent's prompt and the cwd that prompt claims are only meaningful together — the cwd exists in this signature solely to redact that string — so they travel as one parameter rather than as two adjacent optional strings (connascence of position, and a "both or neither" rule the compiler would not enforce):

```typescript
/** The parent session's contribution to a child prompt, plus the cwd that text claims. */
export interface InheritedPrompt {
  /** The parent agent's effective system prompt. */
  systemPrompt: string;
  /** The parent's working directory — the cwd its prompt footer names. */
  cwd: string;
}

export function buildAgentPrompt(
  config: AgentPromptConfig,
  cwd: string,
  env: EnvInfo,
  inherited?: InheritedPrompt,
): string;
```

Inside, `identity` becomes `inherited ? withoutInheritedCwdFooter(inherited.systemPrompt, inherited.cwd) : genericBase`.
That preserves today's exact edge behavior: an empty-string parent prompt still yields an empty identity (the current `parentSystemPrompt ?? genericBase` does not fall back on `""`), and an absent parent still falls back to `genericBase`.

The call site adds no new threading — `assembleSessionConfig` already holds both values:

```typescript
const systemPrompt = io.buildAgentPrompt(agentConfig, effectiveCwd, env, {
  systemPrompt: ctx.parentSystemPrompt,
  cwd: ctx.cwd,
});
```

Alternative considered and rejected: strip at capture time in `buildParentSnapshot`, which already co-locates `cwd` and `systemPrompt` and would need no signature change anywhere.
Rejected because it conflates two concerns — capturing the parent's prompt and sanitizing it for embedding in a *different* session — and it would put Pi's prompt-text format knowledge in a lifecycle module instead of `session/prompts.ts`, leaving `ParentSnapshot.systemPrompt` a silently lossy record of the parent for any future consumer.

### pi-nocd: rewrite an inherited block instead of deferring to it

`appendWorkingDirectoryPrompt` no longer describes what the function does once it can rewrite, so it is renamed `ensureWorkingDirectoryPrompt` first — a name that is already accurate for today's behavior, which makes the rename a pure preparatory tidy.

The new decision order:

1. The prompt already contains the block for *this* cwd → return unchanged (idempotent, as today).
2. The prompt contains a block of *our* shape naming a different cwd → replace it in place with the block for this cwd.
3. The prompt contains the `# Working Directory` heading but not our shape → return unchanged, deferring to the other handler exactly as today.
4. Otherwise → append.

"Our shape" is the heading line followed by a blank line and a sentence line starting with the builder's own prefix, so the detector and the builder cannot drift:

```typescript
const SENTENCE_PREFIX = "Shell commands already execute in";

function findOurBlock(lines: string[]): number | undefined {
  const heading = lines.indexOf(WORKING_DIRECTORY_HEADING);
  if (heading === -1) return undefined;
  return lines[heading + 2]?.startsWith(SENTENCE_PREFIX) ? heading : undefined;
}
```

Matching the heading as an exact line (rather than the current substring `includes`) is safe: a line-initial `# Working Directory` heading appears nowhere injectable in this repo — the only hit outside `node_modules` is pi-nocd's own README, which is not loaded as context.
Step 3 keeps the substring check so the deference case behaves exactly as it does today.

Replacement is in place (the block's three lines are swapped for the fresh three), not delete-and-append, so ordering stays stable across turns.
`before_agent_start` re-runs from the unmodified `_baseSystemPrompt` every turn, so the rewrite is recomputed deterministically rather than compounding.

## Module-Level Changes

### `packages/pi-subagents`

| File                                  | Change                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/prompts.ts`              | Add exported `InheritedPrompt`; change the 4th parameter of `buildAgentPrompt` from `parentSystemPrompt?: string` to `inherited?: InheritedPrompt`; add the private `withoutInheritedCwdFooter` helper; update the function docstring's inheritance description |
| `src/session/session-config.ts`       | Update the `AssemblerIO.buildAgentPrompt` member signature and the call in `assembleSessionConfig` to pass `{ systemPrompt: ctx.parentSystemPrompt, cwd: ctx.cwd }`                                                                                             |
| `test/session/prompts.test.ts`        | Migrate the eight parent-passing call sites to the object form; add a `describe` for the footer strip                                                                                                                                                           |
| `test/session/session-config.test.ts` | Update the two `mockImplementationOnce` bodies that read the 4th argument (lines 84 and 203 areas); add a case asserting the parent cwd is forwarded                                                                                                            |
| `docs/architecture/architecture.md`   | Module-tree entry for `prompts.ts` gains the single-cwd-claim invariant (an active structural constraint, so the `#640` ref belongs there)                                                                                                                      |
| `README.md`                           | The parent-twin paragraph (line 116) gains a clause that the inherited prompt's cwd footer is stripped                                                                                                                                                          |

`src/index.ts` needs no edit: it passes `buildAgentPrompt` by reference and structural typing carries the new signature.
`test/helpers/subagent-session-io.ts` and its test call the stub with `(..._args: unknown[])` and three arguments, so they are unaffected.

Greps run to bound the change: `buildAgentPrompt` and `parentSystemPrompt` across `src/` and `test/` (the files above), `Current working directory` across all packages' `src`/`test`/`docs` and `.pi/` (only pi-nocd's own docstrings and retro), and `active_agent` in pi-permission-system (regex parse, position-independent).

### `packages/pi-nocd`

| File                                    | Change                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/working-directory-prompt.ts`       | Rename `appendWorkingDirectoryPrompt` → `ensureWorkingDirectoryPrompt`; extract the `SENTENCE_PREFIX` constant used by both the builder and the detector; add the stale-block detection and in-place replacement; update the module and function docstrings |
| `src/index.ts`                          | Update the import and call; extend the module docstring with the inherited-block case                                                                                                                                                                       |
| `test/working-directory-prompt.test.ts` | Rename the existing `describe`/imports; add cases for rewrite, cross-cwd idempotence, foreign-heading deference, and repeat application                                                                                                                     |
| `README.md`                             | Replace the "returned unchanged" idempotence sentence under "What it injects"; extend the "How it works" table row; add a short paragraph under "Why" covering the subagent-inheritance case                                                                |

pi-nocd has no `package-pi-nocd` skill (the root `README.md` no-dedicated-skill note at line 217 already lists it, and stays correct), and no architecture or decisions docs.

### Repo

| File                                                           | Change                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/0640-redact-inherited-working-directory-claims.md` | This plan                                                                                                                                                                                                                         |
| `docs/retro/0640-redact-inherited-working-directory-claims.md` | Stage notes                                                                                                                                                                                                                       |
| `.pi/skills/package-pi-subagents/SKILL.md`                     | One sentence after the fork-patch list recording that `buildAgentPrompt` strips the inherited cwd footer — the mechanism's documented behavior is reworked, and the skill is the only place describing the assembled child prompt |

A `pkg:pi-nocd` label is created and added to the issue alongside the existing `pkg:pi-subagents` and `pkg:pi-subagents-worktrees` labels.

## Test Impact Analysis

1. **New coverage the change enables.**
   `withoutInheritedCwdFooter` is exercised through `buildAgentPrompt`, which is already a pure function under direct test — no new seam is needed.
   The new cases are: strips the exact footer line in append and replace mode; leaves the rest of the inherited prompt intact; leaves a footer naming a different directory alone (the `/repo` vs `/repo-worktrees/x` prefix case); normalizes backslashes the way Pi does; no-ops when no footer is present; and the end-to-end invariant that the assembled prompt contains no claim of the parent's cwd when the two differ.
   On the pi-nocd side, the rewrite path is new behavior with no prior coverage at all.
2. **Tests that become redundant.**
   None. pi-nocd's existing "is idempotent when the block is already present" case still holds — it passes the same cwd twice — and is joined, not replaced, by the differing-cwd case.
3. **Tests that must stay as-is.**
   The whole `active_agent tag injection` describe and the ordering assertions in `prompts.test.ts` pin Patch 3 and the identity → tag → env → instructions sequence; they change only where the call signature moves to the object form.

## Invariants at risk

- **Patch 3 — the `<active_agent name="..."/>` tag follows the cacheable parent prefix** (package skill, `docs/architecture/history/`).
  Pinned by `prompts.test.ts` → `active_agent tag injection` and `replace mode orders: identity → active_agent → env → config.systemPrompt`.
- **The parent prompt is embedded verbatim so the child shares a byte-identical cacheable prefix** (`buildAgentPrompt` docstring, Phase 16 born-complete work in [#265]).
  Removing one line breaks byte identity from that line onward, but the footer sits at the parent prompt's tail, so the cached prefix ahead of it is unaffected.
  This is currently prose only — the new "leaves the rest of the inherited prompt intact" test pins it by asserting the surrounding content survives unchanged.
- **A `WorkspaceProvider` child runs in its own cwd** ([#262], [#263]).
  Untouched by this plan; the fix makes the child's prompt agree with the mechanics that already worked.

## TDD Order

1. `refactor(pi-subagents): group the inherited prompt and its cwd into InheritedPrompt (#640)` — no behavior change: add the interface, change the `buildAgentPrompt` and `AssemblerIO` signatures, update the `session-config.ts` call, migrate the eight `prompts.test.ts` call sites and the two `session-config.test.ts` mock bodies.
   Existing assertions keep their meaning; the suite stays green throughout.
2. `fix(pi-subagents): strip the inherited parent cwd footer from child prompts (#640)` — red: the new `prompts.test.ts` describe (strip in both modes, rest of prompt intact, prefix-collision line untouched, backslash normalization, no-op when absent, single-claim invariant) plus the `session-config.test.ts` forwarding case; green: `withoutInheritedCwdFooter` and its use in `identity`.
3. `docs(pi-subagents): record the inherited cwd-footer strip (#640)` — architecture module-tree entry, README parent-twin clause, `.pi/skills/package-pi-subagents/SKILL.md` sentence.
4. `refactor(pi-nocd): rename appendWorkingDirectoryPrompt to ensureWorkingDirectoryPrompt (#640)` — no behavior change: rename the export, the `index.ts` call, and the test's imports and `describe` title.
5. `fix(pi-nocd): rewrite an inherited working-directory block to name the current cwd (#640)` — red: rewrites a block naming a different cwd, stays idempotent for the same cwd, defers to a foreign `# Working Directory` heading, still appends when absent, stable under repeat application; green: `SENTENCE_PREFIX`, `findOurBlock`, and the in-place replacement branch.
6. `docs(pi-nocd): document the inherited-block rewrite (#640)` — README idempotence sentence, "How it works" row, and the subagent paragraph under "Why".

Each step ends with `pnpm --filter @gotgenes/pi-subagents exec vitest run` or `pnpm --filter @gotgenes/pi-nocd exec vitest run` as appropriate, plus `pnpm run check`.
Step 1 changes a shared interface, so run `pnpm -r run test` there and again at the end, and `pnpm --filter @gotgenes/pi-subagents run verify:public-types` after step 2 (the surface should be unchanged — `InheritedPrompt` is internal, not part of the service entry).
Run `pnpm fallow dead-code` before pushing.

## Risks and Mitigations

| Risk                                                                                                                       | Mitigation                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi changes the footer's wording or drops it, so the strip silently stops matching                                          | The filter is a no-op on no match, degrading to today's behavior rather than throwing; Pi's own footer keeps naming the child's cwd regardless, so the child stays correct even if the stale line survives                                         |
| The exact-line filter removes a legitimately identical line from project context                                           | The line must equal `Current working directory: <parent cwd>` exactly; a `<project_instructions>` file would have to quote the operator's own absolute path verbatim on its own line, and removing it would still leave the correct claim standing |
| The `InheritedPrompt` signature change breaks a call site the greps missed                                                 | The change is compile-enforced — `tsc` fails on every stale call site; `pnpm -r run test` at step 1 covers the sibling packages                                                                                                                    |
| pi-nocd's block detector clobbers another extension's `# Working Directory` section                                        | Detection requires the builder's own sentence prefix two lines below the heading; a foreign block falls through to the unchanged-deference branch                                                                                                  |
| A child ends up with pi-nocd's inherited block corrected but positioned inside the inherited prefix rather than at the end | Accepted: the content is correct and in-place replacement keeps ordering stable across turns; the alternative (delete and re-append) churns the prompt more                                                                                        |

## Open Questions

- The inherited *conversation* (`inherit_context`) can carry the parent's own `cd <parent path> &&` bash calls, which is a second, weaker channel for the same habit.
  The reported agents were background subagents where the flag is off by default, so this is deferred until it is observed rather than filed speculatively.
- Whether pi-subagents should eventually assert precedence in its `# Environment` block for stale claims that redaction cannot reach (AGENTS.md prose naming an absolute path, third-party shapers).
  Deliberately out of scope here per the operator's redaction-only decision; revisit if a report shows a child following a non-footer claim.

[#262]: https://github.com/gotgenes/pi-packages/issues/262
[#263]: https://github.com/gotgenes/pi-packages/issues/263
[#265]: https://github.com/gotgenes/pi-packages/issues/265
