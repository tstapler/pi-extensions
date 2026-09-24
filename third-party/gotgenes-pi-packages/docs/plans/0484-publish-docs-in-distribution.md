---
issue: 484
issue_title: "Bad URL in docs"
---

# Publish user-facing docs, exclude internal working docs, across all packages

## Release Recommendation

**Release:** ship independently

This issue is a standalone packaging bug — it is not part of any architecture-roadmap release batch.
The `pi-permission-system` fix is user-visible (broken README/CDN doc links) and should cut a patch release on its own.
The other packages' changes are `build:`/`docs:` cleanups that are hidden changelog types; they land on `main` and batch into each package's next release rather than cutting one now.

## Problem Statement

A third party (`johnsyin-nextbe`) reported that browsing `@gotgenes/pi-permission-system@16.0.2/docs/configuration.md` on the jsdelivr CDN (reached from the pi.dev package browser) returns "Couldn't find the requested file /docs/configuration.md".

The root cause is that `packages/pi-permission-system/package.json` declares a `files` allowlist that omits `docs/`. npm and jsdelivr therefore publish none of the package's documentation, so every `docs/...` link in the README — configuration, session-approvals, cross-extension-api, subagent-integration, opencode-compatibility, troubleshooting, the migration guide, and even the logo image — 404s on the CDN.

The operator broadened the scope: user-facing documentation should ship with every package, and internal working docs (plans, retro history) should never bloat the published tarball.

## Goals

- Fix the reported bug: publish `pi-permission-system`'s user-facing docs so every README/CDN link resolves.
- Establish and apply a repo-wide convention: the published tarball ships user-facing docs and never ships internal working docs (`docs/plans`, `docs/retro`).
- Apply the convention to every package that currently under-publishes user docs or over-publishes internal docs.
- Document the convention in the root `AGENTS.md` so future packages follow it.

This change is **not breaking**: it alters only which files ship in the npm tarball, not any package's runtime behavior, exports, or public API.

## Non-Goals

- Do not trim non-documentation dev files (`test/`, `tsconfig.json`, `vitest.config.ts`, `AGENTS.md`, `.pi/`) that packages without a `files` allowlist currently over-publish, nor the `test` entry in `pi-permission-system`'s allowlist — that is a separate over-publishing concern tracked as follow-up #523.
- Do not change `pi-colgrep` or `pi-github-tools`: their `files` allowlists already omit `docs/` entirely and neither has user-facing docs, so they already conform.
- Do not convert packages that lack a `files` allowlist into allowlist packages — the exclusion is done with a targeted `.npmignore` denylist to avoid the risk of an allowlist accidentally dropping a runtime file.
- Do not fix `pi-subagents-worktrees`'s README link to `docs/decisions/0002-...` (a cross-package reference whose target lives in `pi-subagents`, not locally) — pre-existing and tangential.

## Background

npm decides tarball contents from the `files` allowlist when present, otherwise from everything-minus-defaults filtered by `.gitignore`/`.npmignore`.
A `.npmignore` denylist further prunes files even inside a directory that a `files` allowlist includes.

Current per-package publishing state (verified with `pnpm pack`):

| Package                  | `files` allowlist       | user docs published?        | internal docs (`plans`/`retro`) published? | action                       |
| ------------------------ | ----------------------- | --------------------------- | ------------------------------------------ | ---------------------------- |
| **pi-permission-system** | yes, omits `docs`       | ❌ none — **broken links**  | no                                         | **add user docs to `files`** |
| pi-subagents             | yes, includes `docs`    | ✅ comparison, architecture | yes (269 docs files ship)                  | `.npmignore` denylist        |
| pi-autoformat            | none → ships everything | ✅ configuration, testing   | yes                                        | `.npmignore` denylist        |
| pi-nocd                  | none → ships everything | (none)                      | yes (`retro`)                              | `.npmignore` denylist        |
| pi-session-tools         | none → ships everything | (none)                      | yes                                        | `.npmignore` denylist        |
| pi-subagents-worktrees   | none → ships everything | (none)                      | yes                                        | `.npmignore` denylist        |
| pi-colgrep               | yes, omits `docs`       | (none)                      | no                                         | no change (conforms)         |
| pi-github-tools          | yes, omits `docs`       | (none)                      | no                                         | no change (conforms)         |

`pi-permission-system`'s user-facing docs and their referents:

- Six top-level docs (`configuration.md`, `cross-extension-api.md`, `opencode-compatibility.md`, `session-approvals.md`, `subagent-integration.md`, `troubleshooting.md`) — all README-referenced.
- `docs/guides/permission-frontmatter-for-subagent-extensions.md`, `docs/migration/legacy-to-flat.md` — README-referenced.
- `docs/assets/logo.png` / `logo.svg` — the README header image.

The top-level docs cross-link only to each other and to `guides/` — none link into `architecture/`, `decisions/`, `plans/`, or `retro/`, so excluding those directories leaves no broken links.
`docs/plans` (163 files, ~2.9 MB) and `docs/retro` (157 files, ~1.3 MB) are the internal working history that must never ship.

AGENTS.md constraint: internal doc subdirectories are already excluded from **release triggering** via `exclude-paths` in `release-please-config.json`; this plan extends the same internal-vs-external split to **npm publishing**.

## Design Overview

Two complementary mechanisms, chosen per the asymmetry of the problem:

1. **Fix under-publishing with the `files` allowlist (inclusion).**
   A denylist cannot add files an allowlist omits, so `pi-permission-system`'s missing docs can only be fixed by adding entries to its `files` array.
   Add selective entries — `docs/*.md`, `docs/guides`, `docs/migration`, `docs/assets` — which publish exactly the user-facing docs and, by construction, never include `plans`/`retro`/`architecture`/`decisions`.

2. **Fix over-publishing with an `.npmignore` denylist (exclusion).**
   Every package that currently ships internal docs gets a `.npmignore` denylist excluding `docs/plans` and `docs/retro`.
   For `pi-subagents` (a `files` allowlist that includes the whole `docs` dir) the denylist prunes those two subdirectories from the included directory.
   For the four packages with no `files` field, the denylist prunes them from the default everything-ships set while leaving all runtime code and user docs untouched — the lowest-risk way to exclude internal docs without enumerating an allowlist.

The convention, stated once:

> The published tarball ships user-facing docs and never ships internal working docs.
> Ship the docs the README links to (`docs/*.md` plus referenced subdirs such as `guides`/`migration`/`assets`).
> Never ship `docs/plans` or `docs/retro`.
> A package with a `files` allowlist lists its user-doc paths explicitly; every package excludes `docs/plans`/`docs/retro` via `.npmignore`.
> Verify with `pnpm --filter <pkg> pack --pack-destination /tmp` and inspect `tar tzf`.

`.npmignore` denylist body (identical for every affected package):

```gitignore
# Internal working docs — never publish
docs/plans
docs/retro
```

## Module-Level Changes

- `packages/pi-permission-system/package.json` — add `"docs/*.md"`, `"docs/guides"`, `"docs/migration"`, `"docs/assets"` to the `files` array. (`fix:` — the reported bug.)
- `packages/pi-subagents/.npmignore` — append the two internal-docs lines to the existing file (which currently excludes `test/`, `media/`, etc. but not `docs/plans`/`docs/retro`).
- `packages/pi-autoformat/.npmignore` — new file with the two internal-docs lines.
- `packages/pi-nocd/.npmignore` — new file with the two internal-docs lines (excludes `docs/retro`; the `docs/plans` line is harmless and future-proof).
- `packages/pi-session-tools/.npmignore` — new file with the two internal-docs lines.
- `packages/pi-subagents-worktrees/.npmignore` — new file with the two internal-docs lines.
- `AGENTS.md` (root) — document the docs-in-distribution convention (see Design Overview) in the Monorepo Structure section's "adding a new package" guidance.
- No change to `packages/pi-colgrep/package.json` or `packages/pi-github-tools/package.json` — both already omit `docs` from their allowlists and have no user docs; the plan's verification step confirms their tarballs contain no `docs/`.

No `release-please-config.json` / `.release-please-manifest.json` / `.pi/settings.json` wiring changes: this touches no new package and no publish-script.

## Test Impact Analysis

Not applicable — this is a packaging-metadata change with no source code and no unit tests.
Verification is deterministic via `pnpm pack` tarball inspection (see Build Order), not the Vitest suite.
A possible future automated guard (a CI check asserting `docs/plans`/`docs/retro` never appear in any tarball) is noted in Open Questions but not built here.

## Invariants at risk

- **Every current runtime and user-facing file must still ship.**
  Pinned by each step's before/after `pnpm pack` diff: the after-set must equal the before-set minus exactly `docs/plans/**` and `docs/retro/**` (plus, for `pi-permission-system`, the after-set must additionally *gain* the user docs).
- **No internal working docs in any tarball.**
  Pinned by a final cross-package check: `pnpm pack` for every package, asserting zero `docs/plans/` and zero `docs/retro/` entries.

## Build Order

No test cycles — this is a `/build-plan`.
Each step is verified by comparing `pnpm pack` tarball contents before and after.
Helper per package: `pnpm --filter @gotgenes/<pkg> exec pnpm pack --pack-destination /tmp` then `tar tzf /tmp/gotgenes-<pkg>-*.tgz | sed 's#^package/##'`.

1. **pi-permission-system — publish user docs.**
   Add `docs/*.md`, `docs/guides`, `docs/migration`, `docs/assets` to `files`.
   Verify: tarball now contains `docs/configuration.md`, the other five top-level docs, `docs/guides/permission-frontmatter-for-subagent-extensions.md`, `docs/migration/legacy-to-flat.md`, `docs/assets/logo.png`; and contains **no** `docs/plans/`, `docs/retro/`, `docs/architecture/`, `docs/decisions/`.
   Commit: `fix(pi-permission-system): publish user-facing docs so README and CDN links resolve (#484)`.

2. **pi-subagents — exclude internal docs.**
   Append the two internal-docs lines to `packages/pi-subagents/.npmignore`.
   Verify: tarball still contains `docs/comparison-with-upstream.md`, `docs/architecture/`, `docs/decisions/`; and contains **no** `docs/plans/`, `docs/retro/`.
   Fallback if `.npmignore` does not prune inside the `docs` allowlist entry: narrow the `files` `docs` entry to `docs/*.md docs/architecture docs/decisions` and re-verify.
   Commit: `build(pi-subagents): exclude internal plans and retro from published package`.

3. **pi-autoformat — exclude internal docs.**
   New `packages/pi-autoformat/.npmignore` with the two lines.
   Verify: tarball still contains `docs/configuration.md`, `docs/testing.md`, `docs/assets/logo.png`; no `docs/plans/`, `docs/retro/`.
   Commit: `build(pi-autoformat): exclude internal plans and retro from published package`.

4. **pi-nocd — exclude internal docs.**
   New `packages/pi-nocd/.npmignore` with the two lines.
   Verify: no `docs/retro/` in tarball; `src/`, README, CHANGELOG, LICENSE still present.
   Commit: `build(pi-nocd): exclude internal retro from published package`.

5. **pi-session-tools — exclude internal docs.**
   New `packages/pi-session-tools/.npmignore` with the two lines.
   Verify: no `docs/plans/`, `docs/retro/`; runtime files still present.
   Commit: `build(pi-session-tools): exclude internal plans and retro from published package`.

6. **pi-subagents-worktrees — exclude internal docs.**
   New `packages/pi-subagents-worktrees/.npmignore` with the two lines.
   Verify: no `docs/plans/`, `docs/retro/`; runtime files still present.
   Commit: `build(pi-subagents-worktrees): exclude internal plans and retro from published package`.

7. **Document the convention.**
   Add the docs-in-distribution convention to the root `AGENTS.md` Monorepo Structure guidance.
   Verify: convention names both mechanisms (allowlist inclusion, `.npmignore` exclusion of `docs/plans`/`docs/retro`) and the `pnpm pack` verification.
   Also spot-check `pi-colgrep` and `pi-github-tools` tarballs contain no `docs/` (confirming they already conform — no code change).
   Commit: `docs: document docs-in-distribution publishing convention`.

## Risks and Mitigations

- **Risk: an `.npmignore` denylist does not prune files inside a `files`-allowlisted directory (pi-subagents).**
  Mitigation: step 2 verifies with a pack diff; the documented fallback narrows the `files` `docs` entry instead.
- **Risk: npm `files` glob (`docs/*.md`) behaves unexpectedly (e.g. matches recursively or not at all).**
  Mitigation: step 1's pack diff asserts the exact expected set — top-level docs present, nested `plans`/`retro` absent; if the glob misbehaves, fall back to listing the six doc files explicitly.
- **Risk: creating a fresh `.npmignore` changes other publish behavior.**
  Mitigation: `.npmignore` only *supplements* npm's default ignore rules; the pack diff confirms the after-set differs from before by exactly the two internal dirs.

## Open Questions

- Several packages without a `files` allowlist still publish non-documentation dev files (`test/`, `tsconfig.json`, `vitest.config.ts`, `AGENTS.md`, `.pi/`), and `pi-permission-system` still ships its entire `test/` suite (~200 files) via its allowlist.
  Trimming these is deliberately out of scope for this docs-focused change and is deferred to follow-up issue #523.
- Whether to add a CI guard asserting `docs/plans`/`docs/retro` never appear in any published tarball — deferred; not filed (speculative until the convention has settled).
