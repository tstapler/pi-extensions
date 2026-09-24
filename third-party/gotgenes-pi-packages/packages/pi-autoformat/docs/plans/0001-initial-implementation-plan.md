---
issue_title: "Initial implementation plan (predates issue tracking)"
---

# Pi Autoformat: Initial Implementation Plan

## Problem Statement

Pi agents frequently modify files that later fail commit-time hooks because formatting was not run after editing.
This is especially painful for formatters that mutate files, such as Prettier and Markdown lint fixers.

In practice, this creates a bad workflow:

1. The agent edits files.
2. The agent believes the task is complete.
3. A commit or pre-commit hook runs later and mutates files.
4. The commit fails because files changed during commit validation.
5. The agent must recover from late, out-of-band file mutations.

This is made worse in repositories that use `prek` for pre-commit hooks, because `prek` does not automatically re-stage files after fixer commands mutate them.

The goal of this repository is to provide a Pi-native auto-formatting solution that runs *before* commit time, so agents do not need to remember formatter commands and do not get surprised by late formatting changes.

## Desired Outcome

A Pi extension that:

- automatically formats files changed by the agent
- reduces or eliminates commit failures caused only by missing formatting
- works with project-specific formatter commands
- defaults to a timing model that is safe for Pi's edit workflow
- makes formatter failures visible without blocking normal editing

## Prior Research Summary

### Pi extension capabilities relevant to this problem

Pi already exposes the mechanisms needed to implement this as an extension.

Useful extension hooks and features:

- tool lifecycle hooks such as `tool_result`
- turn/agent lifecycle hooks such as `turn_end` / `agent_end`
- built-in tool override support
- project-local extensions in `.pi/extensions/`
- per-file mutation coordination via `withFileMutationQueue()`

Important implementation observation:

- formatting immediately after every `write`/`edit` is possible
- but it can create follow-up edit failures if formatting changes the file before later exact-text edits operate on it

That makes deferred formatting after the agent finishes a prompt materially safer than immediate per-tool formatting.

### Findings from `tenzir/pi-formatter`

`pi-formatter` is close to the needed solution and validates the general approach.

What it does well:

- hooks successful `write` and `edit` tool results
- supports multiple timing modes: `tool`, `prompt`, `session`
- defaults to `prompt`, which is safer than `tool`
- keeps formatter failures non-blocking
- provides TUI summaries for formatter results

Important gaps:

- only covers Pi `write` and `edit`, not arbitrary file mutations from `bash` or custom mutating tools
- built-in formatter set is opinionated
- does not directly model "run the exact formatter chain this repository already wants"
- does not specifically support `markdownlint-cli2` out of the box

Key design takeaway:

- deferred formatting after the agent finishes a prompt is the correct default timing model for Pi

### Findings from OpenCode's built-in formatter system

OpenCode solves several problems better than `pi-formatter`.

What OpenCode does well:

- formatting is built into core mutation tools, not just an add-on hook
- it formats from `write`, `edit`, and `apply_patch`
- it supports a config-driven formatter registry
- custom formatters can define:
  - command
  - environment
  - file extensions
- multiple matching formatters can run sequentially for the same file
- built-in coverage is broad
- formatter definitions are project-oriented rather than hardcoded to a small fixed tool set

Important remaining gaps in OpenCode:

- formatting still happens immediately after individual tool calls
- that eager timing can still create stale-file drift for later edits
- it still does not automatically cover arbitrary shell-driven file mutations
- formatter failures are logged, but reporting is less explicit than `pi-formatter`

Key design takeaway:

- OpenCode's formatter registry/config model is worth borrowing
- OpenCode's immediate execution timing is *not* the best default for Pi

## Design Direction

The recommended architecture is a hybrid of the best ideas from both systems:

- use a Pi extension
- use a config-driven formatter registry inspired by OpenCode
- default formatting timing to end-of-prompt, inspired by `pi-formatter`
- optionally support end-of-session and immediate-per-tool modes
- add clearer support for repository-specific formatter commands and formatter chains

## Proposed Scope

### In scope

- project-local or globally installable Pi extension
- automatic formatting for files touched by Pi's built-in mutation tools
- configurable formatter registry
- support for custom formatter commands
- support for multiple formatters per file type in declared order
- visible summaries or warnings for formatter success/failure
- default safe timing mode for Pi agents

### Out of scope for the first version

- perfect detection of every file mutated by arbitrary shell commands
- automatic staging or commit orchestration
- replacing existing pre-commit hooks
- whole-repository formatting after every response

## Core Product Decisions

### 1. Default timing mode

Default to formatting once after the agent finishes a prompt.

Rationale:

- safer for Pi's edit workflow than formatting after every tool call
- avoids mutating a file between sibling edits in the same assistant run
- still happens early enough to prevent most commit-time failures

Optional modes can be added later:

- `tool`: format immediately after each successful mutation tool
- `prompt`: format once after agent work completes for the prompt
- `session`: accumulate touched files and format on session shutdown

### 2. Formatter model

Use a configurable formatter registry.

Each formatter entry should be able to specify at least:

- `command: string[]`
- `environment?: Record<string, string>`
- `extensions: string[]`
- `disabled?: boolean`

Likely additions beyond OpenCode:

- explicit `order` or ordered array semantics
- optional `when` or config-detection behavior for built-ins
- optional `mode` for chain behavior, e.g. `all` vs `first-success` vs `fallback`

### 3. Formatter chain behavior

Support multiple formatters for the same file type in explicit order.

This matters for repositories that want things like:

- `prettier --write`
- `markdownlint-cli2 --fix`

or other repo-specific chains.

Do not rely on object insertion order alone if avoidable.

### 4. Failure behavior

Formatter failures should not block the original edit/write result by default.

However, failures should be surfaced clearly:

- TUI summary lines when interactive
- warning text or logs when non-interactive
- clear indication of which file and formatter failed

### 5. File coverage strategy

Initial implementation should cover at least:

- `write`
- `edit`

Potential next step:

- support additional mutation tools, if present
- add optional touched-file collection for custom tools
- evaluate whether shell-driven file mutation support is practical without introducing too much complexity or noise

## Suggested Configuration Shape

Use extension-owned config files instead of Pi `settings.json` keys.

Recommended locations:

- global: `~/.pi/agent/extensions/pi-autoformat/config.json`
- project: `.pi/extensions/pi-autoformat/config.json`

Project config should override global config.

Example draft only:

```json
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-autoformat/main/schemas/pi-autoformat.schema.json",
  "formatMode": "prompt",
  "hideSummariesInTui": false,
  "formatters": {
    "prettier": {
      "command": ["prettier", "--write", "$FILE"],
      "extensions": [".js", ".ts", ".tsx", ".json", ".md"]
    },
    "markdownlint-cli2": {
      "command": ["markdownlint-cli2", "--fix", "$FILE"],
      "extensions": [".md"]
    }
  },
  "chains": {
    ".md": ["prettier", "markdownlint-cli2"],
    ".ts": ["prettier"]
  }
}
```

Notes:

- `$FILE` substitution is simple and proven
- a separate `chains` section may be clearer than relying only on formatter extension overlap
- built-in formatters can exist, but project config should be able to override them cleanly
- owning a dedicated config file makes it straightforward to publish a JSON Schema for editor validation and autocompletion

## Implementation Plan

### Phase 1: repository and extension skeleton

Status: complete.

Completed:

- created package skeleton for a Pi extension package
- defined config file locations:
  - global: `~/.pi/agent/extensions/pi-autoformat/config.json`
  - project: `.pi/extensions/pi-autoformat/config.json`
- defined config merge behavior with project overriding global
- published a JSON Schema for the config file at `schemas/pi-autoformat.schema.json`
- documented configuration in `docs/configuration.md`
- added a README describing the problem, approach, install, and config
- added `LICENSE`
- added the Pi extension entry point and package wiring

### Phase 2: touched-file collection and flush timing

Status: complete for v1 scope.

Completed:

- watchable touched-file collection primitives for `write` and `edit`
- path resolution, normalization, and prompt-local deduping
- prompt-end flush behavior in the core autoformatter
- per-file sequential execution flow

Deferred beyond v1:

- consider whether additional mutation sources should feed the touched-file queue

### Phase 3: formatter registry

Status: complete for v1 scope.

Completed:

- built-in formatter definitions
- custom formatter config parsing and validation
- formatter resolution by file
- `$FILE` substitution
- command execution with optional environment overrides
- v1 formatter command resolution documented as cwd/environment-driven with explicit command overrides for wrapper-based workflows

### Phase 4: formatter chain execution

Status: complete for v1 scope.

Completed:

- ordered execution for formatter chains
- sequential chain behavior
- per-run success/failure capture
- explicit `chains`-only execution behavior for v1

### Phase 5: reporting

Status: complete for v1 scope.

Completed:

- interactive notifications for formatter summaries
- non-interactive warning/info logging
- concise file-level failure reporting
- config-driven hiding of success summaries in interactive mode
- focused reporting coverage for interactive and non-interactive modes

Deferred beyond v1:

- richer TUI presentation beyond basic notifications
- optional exposure of full formatter stdout/stderr in summaries

### Phase 6: tests

Status: complete for v1 scope.

Completed:

- no formatter configured => no-op
- prompt-mode batching behavior
- sequential formatter chains for one file
- custom formatter command overrides
- formatter failure reporting without blocking edits
- deduping touched files within the same prompt
- path normalization and scope handling
- config loading, merge precedence, and validation issue reporting
- extension lifecycle tests for tool-result collection and flush timing
- reporting tests for interactive and non-interactive modes

### Phase 7: optional enhancements

Status update:

- session mode — implemented (flush on `session_shutdown`)
- tool mode — implemented
- support for more mutation tools — implemented via `customMutationTools` config; arbitrary tool names with dotted `pathField` / `pathFields` specs feed the touched-files queue.
- shell mutation integration strategy — implemented per [docs/plans/0004-shell-driven-mutation-coverage.md](./0004-shell-driven-mutation-coverage.md) with three opt-in strategies (argument parsing, snapshot tracking, user-declared wrappers) plus a uniform `formatScope` boundary.
- EventBus integration — implemented via `eventBusMutationChannel` (default `autoformat:touched`); peer extensions can publish `{ path }` or `{ paths }` payloads to opt their own mutations into the formatter pipeline.
- optional settings command / config editor UI — not yet started.

## Remaining Work Summary

The planned v1 work is complete.

Post-v1 follow-up work is tracked in GitHub issues for:

1. richer TUI formatter summaries
2. optional detailed formatter output in reports
3. support for additional Pi mutation tools
4. shell-driven mutation coverage investigation
5. settings/config editor UI
6. optional strict mode for formatter failures

## Risks and Mitigations

### Risk: formatting changes break later exact edits

Mitigation:

- default to prompt-end formatting, not per-tool formatting
- document that `tool` mode is less safe

### Risk: formatter chains create unexpected file churn

Mitigation:

- explicit ordering
- only format touched files
- clear reporting

### Risk: shell-driven file mutations remain uncovered

Mitigation:

- shipped opt-in shell mutation detection with three explicit strategies (see plan 0004)
- exposed `customMutationTools` for project-specific tool names
- exposed `eventBusMutationChannel` so peer extensions can contribute touched files without us modeling their tools
- all mutation sources funnel through the same `TouchedFilesQueue` and `formatScope` filter, keeping behavior auditable

### Risk: formatter failures become invisible

Mitigation:

- always capture per-file formatter results
- surface warnings in interactive and non-interactive contexts

## Open Questions

These questions have now been answered for v1:

1. Answered: built-in formatter resolution should stay simple in v1 and rely on cwd/environment plus explicit command overrides, rather than trying to auto-detect and invoke project-local tools.
2. Answered: v1 should use explicit `chains` only for formatter ordering and execution, rather than extension-overlap fallback behavior.
3. Answered: shell-driven mutation coverage is excluded from v1 and should remain a documented limitation for now.
4. Answered: formatter failures should remain visible but non-blocking in v1; no strict mode should be added yet.
5. Answered: schema URL guidance should document both default-branch and pinned-tag options.

## Recommended Next Milestone

Ship the v1 release, then continue with the deferred follow-up work tracked in GitHub issues.
