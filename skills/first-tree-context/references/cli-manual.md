# CLI Manual

This repo exposes the Context Tree CLI group for tree lifecycle work.

## `first-tree tree`

Use for tree lifecycle work:

- inspect current repo state
- initialize or bind a source/workspace root to a tree
- bootstrap, verify, upgrade, and publish tree repos
- install hook wiring and maintain shipped skill payloads

Current implementation status: the tree lifecycle surface is live in this repo,
including `inspect`, `status`, `init`, `bootstrap`, `bind`, `integrate`,
`workspace sync`, `verify`, `upgrade`, `publish`, `codeowners`,
`claude-hook`, `inject`, `review`, and `tree skill ...`.
