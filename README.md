# pi-extensions

Tyler-controlled Pi extensions for capabilities that are small enough to own
rather than trusting an upstream compatibility bundle.

## Packages

- `@tstapler/pi-claude-compat` — Claude Code tool-name and schema compatibility
  backed by one session-persisted task store.
- `@tstapler/pi-claude-hooks` — planned clean-room command-hook compatibility;
  disabled until its event mapping and safety tests are complete.

## Principles

- No credentials or credential values in source, configuration, logs, tool
  results, or tests.
- Fail closed for malformed input and non-interactive operations that require a
  human answer.
- One canonical implementation for each capability; avoid duplicate plan,
  task, web, or agent tools.
- Every stateful tool reconstructs state from the active Pi session branch.
- Remote releases are exact-versioned. Dotfiles pin exact commits or versions.
- Third-party code is used only through reviewed Tyler-controlled forks.

## Development

```bash
npm install
npm run check
```

Load the compatibility package from a checkout:

```bash
pi -e ./packages/claude-compat/src/index.ts
```

See `SECURITY.md` for the threat model and reporting guidance.
