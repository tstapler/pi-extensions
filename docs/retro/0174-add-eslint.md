---
issue: 174
issue_title: "Add ESLint for type-aware lint rules and import path enforcement"
---

# Retro: #174 — Add ESLint for type-aware lint rules and import path enforcement

## Stage: Planning (2026-05-23T20:00:00Z)

### Session summary

Produced a 6-step build plan for adding ESLint alongside Biome across all six packages.
The plan uses `typescript-eslint` type-aware presets with cherry-picked `strictTypeChecked` rules matching the RepOne cdk config, plus a custom inline ESLint rule for import path enforcement with auto-fix support.

### Observations

- **No third-party import plugins:** Both `eslint-plugin-no-relative-import-paths` and `eslint-plugin-paths` use legacy CommonJS config, deprecated ESLint APIs, and lack flat config support.
  A custom inline rule (~50 lines) is simpler, safer, and supports auto-fix tailored to the monorepo's uniform `#src/*` / `#test/*` convention.
- **Biome overlap avoidance:** Plan specifies using `*TypeCheckedOnly` presets if available in the flat config API, falling back to full presets with overlapping rules disabled.
  This keeps ESLint focused on what Biome can't do.
- **Existing violations are manageable:** 46 relative imports in `src/` + 5 in `test/`, ~27 `any` usages in source (mostly `pi-subagents` SDK boundary code needing `eslint-disable` comments).
- **`pi-subagents` is missing `"type": "module"`** — discovered during investigation, included as step 1.
- **This is a `/build-plan` change** (config/tooling), not a TDD change.
  The custom rule is validated by running ESLint against the codebase itself.

## Stage: Implementation — Build (2026-05-23T23:10:00Z)

### Session summary

Executed all 6 plan steps across roughly 90 source and test files.
`eslint.config.js` now enforces type-aware rules and the custom `no-parent-relative-imports` rule (with auto-fix) against all package TypeScript files.
All 6 packages have normalized `lint` scripts, the root `lint` script includes ESLint, and the `prek.toml` pre-commit hook runs `eslint --fix` on staged `.ts` files under `packages/`.

### Observations

- **`*TypeCheckedOnly` presets do exist in the flat config API** — `tseslint.configs.recommendedTypeCheckedOnly` and `stylisticTypeCheckedOnly` are available, giving clean separation from Biome with zero duplicate warnings.
- **Violation count was higher than estimated** — ~300 after dropping `js.configs.recommended`, requiring systematic file-by-file fixes across all packages.
  The bulk came from pi-subagents SDK boundary code (Pi TUI/theme types are untyped `any`), handled with file-level `eslint-disable` comments and TODO notes for upstream Pi SDK type improvements.
- **3 real bugs caught by the new rules** — floating promises in `agent-runner.ts` (`session.steer`/`session.abort` not void-wrapped), misused-promises (`onAbort` callback returning `Promise<void>` where `void` was expected), and `await-thenable` in `agent-manager.ts` (non-Promise iterable passed to `Promise.allSettled`).
- **Background agent introduced a regression** — changed `config.yoloMode === true` to `config.yoloMode` in `yolo-mode.ts`, breaking 2 tests.
  Reverted and used `Boolean(config.yoloMode)` with a targeted disable.
- **`prefer-nullish-coalescing` requires caution** — `||` → `??` is not always safe: `parentContext || undefined` in `parent-snapshot.ts` intentionally converts falsy strings to `undefined`; changing to `??` broke a test.
- **`no-invalid-void-type` with `allowInGenericTypeArguments: true` does not cover generic function calls** — `Promise.withResolvers<void>()` and `ctx.ui.custom<void>(...)` still flag even with the option enabled, requiring per-line `eslint-disable` comments.
- **CI wiring**: The root `lint` script already runs in the CI `Lint` step; adding `eslint packages/` to it is sufficient — no new CI step needed.

## Stage: Final Retrospective (2026-05-23T23:30:00Z)

### Session summary

Shipped the full ESLint integration across all 6 packages: planning, implementation (6 build steps), CI verification, issue closure, and release-please merge.
Released `pi-autoformat-v5.1.0`, `pi-colgrep-v1.4.0`, `pi-github-tools-v4.1.0`, `pi-permission-system-v7.2.0`, `pi-session-tools-v0.3.0`.

### Observations

#### What went well

- **User interjections during planning saved rework** — 4 clarifications (all packages, no legacy plugins, auto-fix desired, consistent `package.json`) prevented mid-implementation scope confusion.
- **`*TypeCheckedOnly` presets** — finding these in the flat config API delivered clean zero-overlap separation from Biome without needing to manually disable overlapping rules.
- **Real bugs caught** — 3 genuine issues (floating promises, misused-promises, await-thenable) found by the new rules justify the tooling investment.
- **Custom inline import rule** — ~50 lines, zero dependencies, auto-fixable.
  Proves that lightweight custom ESLint rules can replace third-party plugins that lag behind the ecosystem.

#### What caused friction (agent side)

- `missing-context` — Plan estimated ~27 `any` violations; actual count after enabling type-aware rules was ~300.
  The planning session checked `grep ': any'` but didn't run ESLint speculatively to get the true violation count from type-aware rules like `no-unnecessary-condition` and `unbound-method`.
  Impact: implementation session took ~3× longer than expected; required systematic triage rather than quick fixup.
- `premature-convergence` — Background agent delegated to fix lint violations made a semantic change (`config.yoloMode === true` → `config.yoloMode`) that broke 2 tests.
  The agent prompt didn't constrain it to preserve semantics; it treated the `no-unnecessary-boolean-literal-compare` rule as a mechanical fix.
  Impact: ~15 minutes debugging and reverting; introduced `Boolean(config.yoloMode)` workaround.
- `premature-convergence` — Mechanical `||` → `??` replacement in `parent-snapshot.ts` broke a test because `||` intentionally converts empty strings to `undefined`.
  The `prefer-nullish-coalescing` rule was applied without checking test expectations.
  Impact: ~10 minutes debugging; reverted to `||` with a targeted disable comment.
- `rabbit-hole` — Spent ~20 minutes fighting `eslint-disable-next-line` placement in multi-line ternary expressions and `if` conditions spanning multiple lines.
  Should have used `/* eslint-disable */` / `/* eslint-enable */` block comments from the start for multi-line expressions.
  Impact: added friction but no rework.

#### What caused friction (user side)

- The user could have mentioned the `"type": "module"` requirement for root `package.json` during planning (it was already present in individual packages but missing from root).
  This was discovered mid-implementation when ESLint emitted a module-detection warning.
  Impact: minor — one extra line added to the config commit.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added "Operator semantics" section with guidance on `||` → `??` safety.
2. `AGENTS.md` — added "Background agent guardrails" subsection under Workflow with constraints for delegated lint-fix agents.
