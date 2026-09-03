# @tstapler/pi-claude-hooks

Reserved for a clean-room Claude Code command-hook adapter.

This package is intentionally private and has no Pi extension entry point yet.
It must not execute hooks until tests cover:

- event mapping for session start/end, compaction, tool calls, prompt submit,
  tool failures, and agent completion;
- regex matcher validation and deterministic timeout/cancellation;
- bounded stdin/stdout/stderr and terminal-control sanitization;
- environment allowlisting with no credential copying;
- deny/rewrite semantics for pre-tool hooks;
- project trust and global-versus-project precedence;
- recursion prevention and fail-closed malformed output;
- exact coexistence rules with the global permission system.

`PermissionRequest` will not be emulated. Permission decisions belong to the
reviewed permission-system fork.
