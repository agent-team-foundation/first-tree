# assets/breeze

Runtime assets bundled with the `first-tree` npm package for the `breeze`
product surface.

## `bin/`

Bundled copies of the bash scripts that ship alongside the Rust daemon. The
canonical source still lives in `first-tree-breeze/bin/` at the repo root
and is authoritative until Phase 2b ports these scripts to TypeScript. Do
not hand-edit the files under `bin/` — update the source in
`first-tree-breeze/bin/` and re-copy.

Scripts:

- `breeze-poll` — inbox poller used by the legacy bash workflow
- `breeze-watch` — long-running watcher loop
- `breeze-status` — status snapshot
- `breeze-status-manager` — manages per-session status entries
- `breeze-statusline-wrapper` — Claude Code statusline hook entrypoint

The `first-tree breeze` CLI dispatcher (`src/products/breeze/`) spawns these
scripts directly with `stdio: "inherit"` so TTY, colour, and interactive
features pass through unchanged.
