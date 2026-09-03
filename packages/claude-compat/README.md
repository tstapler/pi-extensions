# @tstapler/pi-claude-compat

Clean-room compatibility tools for Claude Code-oriented skills running in Pi.

Implemented:

- `AskUserQuestion`, including custom answers and repeated multi-select
- `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet`
- `TodoWrite` and `TodoRead`, backed by the same canonical task state
- `Grep`, `Glob`, and `LS`, with bounded model-visible output
- task reconstruction when resuming or branching a Pi session

Not implemented here:

- Plan mode: use the reviewed plan-mode fork.
- Web search/fetch: use the reviewed web-access and browser forks.
- Agent delegation: use the reviewed subagent fork directly until its typed
  service API has a tested compatibility adapter.
- Permission decisions: the reviewed permission-system fork is authoritative.

`AskUserQuestion` fails closed in non-interactive mode instead of fabricating a
human answer. The filesystem aliases do not provide a sandbox and must be
governed by the global permission extension.
