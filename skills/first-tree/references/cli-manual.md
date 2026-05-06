# CLI Manual

This repo currently exposes three top-level CLI groups.

## `first-tree tree`

Use for tree lifecycle work:

- inspect current repo state
- initialize or bind a source/workspace root to a tree
- bootstrap, verify, upgrade, and publish tree repos
- install hook wiring and maintain shipped skill payloads

Current implementation status: the tree lifecycle surface is live in this repo,
including `inspect`, `status`, `init`, `bootstrap`, `bind`, `integrate`,
`workspace sync`, `verify`, `upgrade`, `publish`, `generate-codeowners`,
`install-claude-code-hook`, `inject-context`, `review`, and `tree skill ...`.

## `first-tree github scan`

Use for GitHub inbox runtime work:

- install and start the daemon
- inspect runtime state
- poll notifications
- run foreground debug commands
- route notification handling through the shipped First Tree skill set

This runtime is implemented in the current repo and now points agents at the
shipped `first-tree`, `first-tree-github-scan`, `first-tree-sync`, and
`first-tree-write` skills. For human/operator daemon work, load the shipped
`github-scan` operational skill.

## `first-tree hub`

Reserved namespace for future hosted or local Hub integration. The command
names exist, but they currently exit non-zero with a not-implemented error.
