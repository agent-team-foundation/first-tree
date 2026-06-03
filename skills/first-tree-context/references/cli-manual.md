# CLI Manual

This repo exposes the Context Tree CLI group for tree lifecycle work.

## `first-tree tree`

Use for tree lifecycle work:

- check current workspace status
- initialize a source/workspace root against a tree
- migrate legacy multi-mode layouts to W1
- verify and upgrade tree repos
- install hook wiring and maintain shipped skill payloads

Current implementation status: the tree lifecycle surface is live in this repo,
including `status`, `init`, `migrate-to-w1`, `verify`, `upgrade`, `codeowners`,
`claude-hook`, `inject`, `review`, plus the `tree skill ...` and
`tree automation ...` groups.
